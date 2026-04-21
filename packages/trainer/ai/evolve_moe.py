"""
Neuroevolution for NnMoEAgent — perturbs all 9 expert models simultaneously.

Each genome is a dict of 9 perturbation dicts (one per model name).
Fitness = mean city-accumulation score across games (normalized to [0,1]).

Evaluation uses persistent Node.js eval_server.js processes (real game engine).
--workers N servers run in parallel via ThreadPoolExecutor.

Usage:
    python packages/trainer/ai/evolve_moe.py \
        --checkpoints packages/trainer/ai/checkpoints/moe \
        --population 100 \
        --generations 30 \
        --games-per-agent 10 \
        --workers 8 \
        --map-width 30 \
        --map-height 10 \
        --output /Volumes/500G/Training/evolution_moe
"""

import argparse
import json
import os
import shutil
import sys
import warnings
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import numpy as np
import torch

warnings.filterwarnings("ignore")
logging.getLogger("torch.onnx").setLevel(logging.ERROR)

sys.path.insert(0, str(Path(__file__).parent))
from models_moe import MovementCNN, ProductionCNN, UNIT_TYPE_NAMES, ALL_MODEL_NAMES
from moe_eval_pool import MoEEvalPool


# ── Perturbation helpers ──────────────────────────────────────────────────────

def create_perturbation(state_dict: dict, rng: np.random.RandomState, scale: float) -> dict:
    pert = {}
    for name, param in state_dict.items():
        if param.dtype in (torch.float32, torch.float16, torch.float64):
            noise = rng.randn(*param.shape).astype(np.float32) * scale
            pert[name] = {'data': noise.flatten().tolist(), 'shape': list(param.shape)}
    return pert


def create_moe_perturbations(base_states: dict, rng: np.random.RandomState, scale: float) -> dict:
    return {name: create_perturbation(base_states[name], rng, scale)
            for name in ALL_MODEL_NAMES}


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
        n_params = sum(p.numel() for p in base_states[name].values())
        print(f"  {name}: {n_params:,} params")

    rng = np.random.RandomState(args.seed)

    print(f"\nInitialising population of {args.population}...")
    population = [
        {'perturbations': create_moe_perturbations(base_states, rng, args.scale), 'fitness': 0.0}
        for _ in range(args.population)
    ]

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\nStarting {args.workers} eval server(s)...")
    pool = MoEEvalPool(
        num_workers=args.workers,
        map_width=args.map_width,
        map_height=args.map_height,
        max_turns=args.max_turns,
        games_per_agent=args.games_per_agent,
    )

    best_genome = None

    try:
        for gen in range(args.generations):
            print(f"\n{'='*60}")
            print(f"Generation {gen + 1}/{args.generations}")
            print(f"{'='*60}")

            # Phase 1: pack all genomes to npz bytes sequentially
            print(f"  Packing {len(population)} genomes...", flush=True)
            for idx, genome in enumerate(population):
                try:
                    genome['weights_npz'] = pool.preexport(base_states, genome['perturbations'], base_configs)
                except Exception:
                    import traceback
                    print(f"  Pack failed for genome {idx}:\n{traceback.format_exc()}", flush=True)
                    genome['weights_npz'] = None
            print(f"  Pack done. Running games...", flush=True)

            # Phase 2: evaluate all genomes in parallel (send pre-built bytes to Node.js servers)
            def eval_genome(idx_genome):
                idx, genome = idx_genome
                if genome.get('weights_npz') is None:
                    return idx, 0.0, "pack failed"
                try:
                    results = pool.evaluate_b64(genome['weights_npz'])
                    fitness = float(np.mean(results)) if results else 0.0
                    return idx, fitness, None
                except Exception:
                    import traceback
                    return idx, 0.0, traceback.format_exc()

            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                futures = {
                    executor.submit(eval_genome, (idx, genome)): idx
                    for idx, genome in enumerate(population)
                }

                completed = 0
                pop_size = len(population)
                for future in as_completed(futures):
                    idx, fitness, err = future.result()
                    population[idx]['fitness'] = fitness
                    completed += 1

                    if err:
                        print(f"[{datetime.now().strftime('%H:%M:%S')}] Genome {idx} error:\n{err}", flush=True)
                    elif idx < 3 or fitness > 0.3:
                        print(f"  [{datetime.now().strftime('%H:%M:%S')}] Genome {idx:3d}: fitness={fitness:.4f}", flush=True)

                    pct = completed * 100 // pop_size
                    if completed % max(1, pop_size // 10) == 0:
                        print(f"  [{pct}%] {completed}/{pop_size} genomes evaluated", flush=True)

            best_genome = max(population, key=lambda g: g['fitness'])
            mean_fitness = np.mean([g['fitness'] for g in population])
            print(f"\nBest: {best_genome['fitness']:.4f}  Mean: {mean_fitness:.4f}")

            if best_genome['fitness'] > 0.1:
                ckpt_path = output_dir / f'checkpoint_gen{gen}.json'
                with open(ckpt_path, 'w') as f:
                    json.dump({'perturbations': best_genome['perturbations'],
                               'fitness': best_genome['fitness'],
                               'generation': gen}, f)
                print(f"Saved: {ckpt_path}")

            population = next_generation(population, args.elitism, rng)

    finally:
        pool.close()

    # Export champion ONNX directory
    if best_genome:
        champion_dir = output_dir / 'champion'
        champion_dir.mkdir(exist_ok=True)

        # Re-export champion models to disk for use as agent
        from models_moe import MovementCNN, ProductionCNN
        from moe_eval_pool import _export_model_to_bytes
        for name in ALL_MODEL_NAMES:
            pert = best_genome['perturbations'].get(name, {})
            perturbed = {}
            for layer, param in base_states[name].items():
                if layer in pert:
                    noise = torch.tensor(pert[layer]['data'], dtype=param.dtype).reshape(pert[layer]['shape'])
                    perturbed[layer] = param + noise
                else:
                    perturbed[layer] = param

            config = base_configs[name]
            if name == 'production':
                model = ProductionCNN(**config)
            else:
                model = MovementCNN(**config)
            model.load_state_dict(perturbed)

            onnx_bytes = _export_model_to_bytes(model, name, config)
            onnx_path = champion_dir / f'{name}.onnx'
            onnx_path.write_bytes(onnx_bytes)

        with open(output_dir / 'champion.json', 'w') as f:
            json.dump({'fitness': best_genome['fitness'],
                       'checkpoints_dir': str(checkpoints_dir)}, f)

        print(f"\nEvolution complete.")
        print(f"  Champion ONNX: {champion_dir}/")
        print(f"  Fitness: {best_genome['fitness']:.4f}")
        print(f"  Use with: P1_AGENT=nnMoEAgent:{champion_dir}")


def main():
    parser = argparse.ArgumentParser(description='Neuroevolution for MoE agent')
    parser.add_argument('--checkpoints',     required=True, help='Dir with 9 .pt files')
    parser.add_argument('--population',      type=int,   default=100)
    parser.add_argument('--generations',     type=int,   default=30)
    parser.add_argument('--games-per-agent', type=int,   default=10)
    parser.add_argument('--workers',         type=int,   default=4,
                        help='Number of parallel eval servers (Node.js processes)')
    parser.add_argument('--elitism',         type=int,   default=2)
    parser.add_argument('--scale',           type=float, default=0.05)
    parser.add_argument('--seed',            type=int,   default=42)
    parser.add_argument('--map-width',       type=int,   default=30)
    parser.add_argument('--map-height',      type=int,   default=10)
    parser.add_argument('--max-turns',       type=int,   default=300)
    parser.add_argument('--output',          default='./evolved_moe')
    args = parser.parse_args()
    run_evolution(args)


if __name__ == '__main__':
    main()
