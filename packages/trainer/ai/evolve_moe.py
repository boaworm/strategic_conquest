"""
Neuroevolution for NnMoEAgent — perturbs all 9 expert models simultaneously.

Each genome is a dict of 9 perturbation dicts (one per model name).
Fitness = mean city-accumulation score across games (same as single-model evolve.py).

Usage:
    python packages/trainer/ai/evolve_moe.py \
        --checkpoints packages/trainer/ai/checkpoints/moe \
        --population 50 \
        --generations 20 \
        --games-per-agent 5 \
        --map-width 30 \
        --map-height 10 \
        --output /Volumes/500G/Training/evolution_moe
"""

import argparse
import json
import os
import shutil
import sys
import time
import warnings
import logging
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

warnings.filterwarnings("ignore")
logging.getLogger("torch.onnx").setLevel(logging.ERROR)

sys.path.insert(0, str(Path(__file__).parent))
from models_moe import MovementCNN, ProductionCNN, UNIT_TYPE_NAMES, ALL_MODEL_NAMES, NUM_GLOBAL
from game_evaluator import run_games_moe_sequential


# ── Perturbation helpers ──────────────────────────────────────────────────────

def create_perturbation(state_dict: dict, rng: np.random.RandomState, scale: float) -> dict:
    pert = {}
    for name, param in state_dict.items():
        if param.dtype in (torch.float32, torch.float16, torch.float64):
            noise = rng.randn(*param.shape).astype(np.float32) * scale
            pert[name] = {'data': noise.flatten().tolist(), 'shape': list(param.shape)}
    return pert


def apply_perturbation(state_dict: dict, pert: dict) -> dict:
    modified = {}
    for name, param in state_dict.items():
        if name in pert:
            noise = torch.tensor(pert[name]['data'], dtype=param.dtype).reshape(pert[name]['shape'])
            modified[name] = param + noise
        else:
            modified[name] = param
    return modified


def create_moe_perturbations(base_states: dict, rng: np.random.RandomState, scale: float) -> dict:
    return {name: create_perturbation(base_states[name], rng, scale)
            for name in ALL_MODEL_NAMES}


# ── ONNX export (in-process) ──────────────────────────────────────────────────

def _export_model(model, output_path: Path, model_name: str, config: dict):
    model.eval().cpu()
    H, W = config['map_height'], config['map_width']

    if model_name == 'production':
        dummy_spatial = torch.randn(1, 15, H, W)
        dummy_global  = torch.randn(1, NUM_GLOBAL)
        torch.onnx.export(
            model, (dummy_spatial, dummy_global), str(output_path),
            export_params=True, opset_version=18, do_constant_folding=True,
            input_names=["input", "global_features"],
            output_names=["unit_type"],
        )
    else:
        dummy = torch.randn(1, 15, H, W)
        torch.onnx.export(
            model, dummy, str(output_path),
            export_params=True, opset_version=18, do_constant_folding=True,
            input_names=["input"],
            output_names=["action_type", "target_tile"],
        )

    # Merge external data into single file
    import onnx
    from onnx.external_data_helper import load_external_data_for_model
    proto = onnx.load(str(output_path), load_external_data=False)
    load_external_data_for_model(proto, str(output_path.parent))
    onnx.save_model(proto, str(output_path), save_as_external_data=False)


def export_moe_genome(base_states: dict, base_configs: dict, perturbations: dict, output_dir: Path):
    """Apply perturbations to all 9 models and export to output_dir/*.onnx"""
    output_dir.mkdir(parents=True, exist_ok=True)

    for name in ALL_MODEL_NAMES:
        perturbed_state = apply_perturbation(base_states[name], perturbations[name])
        config = base_configs[name]

        if name == 'production':
            model = ProductionCNN(**config)
        else:
            model = MovementCNN(**config)

        model.load_state_dict(perturbed_state)
        _export_model(model, output_dir / f'{name}.onnx', name, config)


# ── Selection / crossover / mutation ─────────────────────────────────────────

def tournament_select(population: list, k: int = 3) -> dict:
    import random
    candidates = random.sample(population, min(k, len(population)))
    return max(candidates, key=lambda g: g['fitness'])


def crossover(p1: dict, p2: dict) -> dict:
    import random
    child_perts = {}
    for model_name in ALL_MODEL_NAMES:
        cp = {}
        for layer in p1['perturbations'][model_name]:
            flat1 = np.array(p1['perturbations'][model_name][layer]['data'])
            flat2 = np.array(p2['perturbations'][model_name][layer]['data'])
            cut = random.randint(0, len(flat1) - 1)
            child_flat = np.concatenate([flat1[:cut], flat2[cut:]])
            cp[layer] = {'data': child_flat.tolist(),
                         'shape': p1['perturbations'][model_name][layer]['shape']}
        child_perts[model_name] = cp
    return {'perturbations': child_perts, 'fitness': 0.0}


def mutate(genome: dict, rate: float, strength: float, rng: np.random.RandomState) -> dict:
    for model_name in ALL_MODEL_NAMES:
        for layer in genome['perturbations'][model_name]:
            arr = np.array(genome['perturbations'][model_name][layer]['data'])
            mask = rng.random(arr.shape) < rate
            if mask.any():
                arr[mask] += rng.randn(int(mask.sum())).astype(np.float32) * strength
            genome['perturbations'][model_name][layer]['data'] = arr.tolist()
    return genome


def next_generation(population: list, elitism: int, rng: np.random.RandomState) -> list:
    population.sort(key=lambda g: g['fitness'], reverse=True)
    new_pop = []

    for p in population[:elitism]:
        clone_perts = {}
        for name in ALL_MODEL_NAMES:
            clone_perts[name] = {
                layer: {'data': v['data'][:], 'shape': v['shape'][:]}
                for layer, v in p['perturbations'][name].items()
            }
        new_pop.append({'perturbations': clone_perts, 'fitness': 0.0})

    while len(new_pop) < len(population):
        child = crossover(tournament_select(population), tournament_select(population))
        child = mutate(child, rate=0.05, strength=0.1, rng=rng)
        new_pop.append(child)

    return new_pop


# ── Main evolution loop ────────────────────────────────────────────────────────

def run_evolution(args):
    checkpoints_dir = Path(args.checkpoints)

    # Load all 9 base checkpoints
    print(f"Loading {len(ALL_MODEL_NAMES)} checkpoints from {checkpoints_dir}")
    base_states  = {}
    base_configs = {}
    for name in ALL_MODEL_NAMES:
        ckpt_path = checkpoints_dir / f'{name}.pt'
        if not ckpt_path.exists():
            print(f"ERROR: missing checkpoint {ckpt_path}")
            sys.exit(1)
        ckpt = torch.load(str(ckpt_path), weights_only=False, map_location='cpu')
        base_states[name]  = ckpt['model_state']
        base_configs[name] = ckpt['config']
        print(f"  {name}: {sum(p.numel() for p in base_states[name].values()):,} params")

    rng = np.random.RandomState(args.seed)

    print(f"\nInitialising population of {args.population}...")
    population = [
        {'perturbations': create_moe_perturbations(base_states, rng, args.scale), 'fitness': 0.0}
        for _ in range(args.population)
    ]

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    best_genome = None

    for gen in range(args.generations):
        print(f"\nGeneration {gen + 1}/{args.generations}")
        pop_size = len(population)
        progress_markers = {int(p * pop_size / 10) for p in range(1, 11)}

        for idx, genome in enumerate(population):
            tmp_dir = output_dir / f'tmp_gen{gen}_{idx}'
            try:
                t_export = time.time()
                export_moe_genome(base_states, base_configs, genome['perturbations'], tmp_dir)
                t_export = time.time() - t_export

                t_eval = time.time()
                results = run_games_moe_sequential(
                    str(tmp_dir), args.map_width, args.map_height,
                    args.max_turns, args.games_per_agent,
                )
                t_eval = time.time() - t_eval

                fitness = float(np.mean(results)) if results else 0.0
                population[idx]['fitness'] = fitness

                if idx < 3 or fitness > 0.3:
                    print(f"  Genome {idx:3d}: cities={fitness:.4f}  "
                          f"(export={t_export:.1f}s eval={t_eval:.1f}s)", flush=True)

            except Exception as e:
                import traceback
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Genome {idx} error: {e}\n"
                      f"{traceback.format_exc()}", flush=True)
                population[idx]['fitness'] = 0.0
            finally:
                if tmp_dir.exists():
                    shutil.rmtree(tmp_dir)

            if idx in progress_markers:
                pct = (idx + 1) * 100 // pop_size
                print(f"[{pct}%]", flush=True)

        best_genome = max(population, key=lambda g: g['fitness'])
        mean_fitness = np.mean([g['fitness'] for g in population])
        print(f"\nBest: {best_genome['fitness']:.4f}  Mean: {mean_fitness:.4f}")

        # Save checkpoint if improved
        if best_genome['fitness'] > 0.1:
            ckpt_path = output_dir / f'checkpoint_gen{gen}.json'
            with open(ckpt_path, 'w') as f:
                json.dump({'perturbations': best_genome['perturbations'],
                           'fitness': best_genome['fitness'],
                           'generation': gen}, f)
            print(f"Saved: {ckpt_path}")

        population = next_generation(population, args.elitism, rng)

    # Export champion ONNX directory
    if best_genome:
        champion_dir = output_dir / 'champion'
        export_moe_genome(base_states, base_configs, best_genome['perturbations'], champion_dir)
        with open(output_dir / 'champion.json', 'w') as f:
            json.dump({'fitness': best_genome['fitness'],
                       'perturbations': best_genome['perturbations']}, f)
        print(f"\nEvolution complete.")
        print(f"  Champion ONNX: {champion_dir}/")
        print(f"  Fitness: {best_genome['fitness']:.4f}")
        print(f"  Use with: P1_AGENT=nnMoEAgent:{champion_dir}")


def main():
    parser = argparse.ArgumentParser(description='Neuroevolution for MoE agent')
    parser.add_argument('--checkpoints',    required=True, help='Dir with 9 .pt files')
    parser.add_argument('--population',     type=int,   default=50)
    parser.add_argument('--generations',    type=int,   default=20)
    parser.add_argument('--games-per-agent',type=int,   default=5)
    parser.add_argument('--elitism',        type=int,   default=2)
    parser.add_argument('--scale',          type=float, default=0.05,
                        help='Initial perturbation scale (smaller than single-model since 9x params)')
    parser.add_argument('--seed',           type=int,   default=42)
    parser.add_argument('--map-width',      type=int,   default=30)
    parser.add_argument('--map-height',     type=int,   default=10)
    parser.add_argument('--max-turns',      type=int,   default=300)
    parser.add_argument('--output',         default='./evolved_moe')
    args = parser.parse_args()
    run_evolution(args)


if __name__ == '__main__':
    main()
