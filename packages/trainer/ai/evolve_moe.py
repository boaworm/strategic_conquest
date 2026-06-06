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
            pert[name] = rng.randn(*param.shape).astype(np.float32) * scale
    return pert


def create_moe_perturbations(base_states: dict, rng: np.random.RandomState, scale: float,
                             active_models: list = None) -> dict:
    names = active_models if active_models is not None else ALL_MODEL_NAMES
    return {name: create_perturbation(base_states[name], rng, scale)
            for name in names}


def _perts_to_json(perturbations: dict) -> dict:
    return {
        model_name: {
            layer: {'data': arr.flatten().tolist(), 'shape': list(arr.shape)}
            for layer, arr in layers.items()
        }
        for model_name, layers in perturbations.items()
    }


# ── Selection / crossover / mutation ─────────────────────────────────────────

def tournament_select(population: list, k: int = 3) -> dict:
    import random
    candidates = random.sample(population, min(k, len(population)))
    return max(candidates, key=lambda g: g['fitness'])


def crossover(p1: dict, p2: dict) -> dict:
    import random
    child_perts = {}
    for model_name in p1['perturbations']:
        cp = {}
        for layer in p1['perturbations'][model_name]:
            flat1 = p1['perturbations'][model_name][layer].ravel()
            flat2 = p2['perturbations'][model_name][layer].ravel()
            cut = random.randint(0, len(flat1) - 1)
            child_flat = np.concatenate([flat1[:cut], flat2[cut:]])
            cp[layer] = child_flat.reshape(p1['perturbations'][model_name][layer].shape)
        child_perts[model_name] = cp
    return {'perturbations': child_perts, 'fitness': 0.0}


def mutate(genome: dict, rate: float, strength: float, rng: np.random.RandomState) -> dict:
    for model_name in genome['perturbations']:
        for layer in genome['perturbations'][model_name]:
            arr = genome['perturbations'][model_name][layer]
            mask = rng.random(arr.shape) < rate
            if mask.any():
                arr[mask] += rng.randn(int(mask.sum())).astype(np.float32) * strength
    return genome


def next_generation(population: list, elitism: int, rng: np.random.RandomState,
                    mutation_rate: float = 0.05, mutation_strength: float = 0.03) -> list:
    population.sort(key=lambda g: g['fitness'], reverse=True)
    new_pop = []

    for p in population[:elitism]:
        clone_perts = {}
        for name in p['perturbations']:
            clone_perts[name] = {layer: v.copy() for layer, v in p['perturbations'][name].items()}
        new_pop.append({'perturbations': clone_perts, 'fitness': 0.0})

    while len(new_pop) < len(population):
        child = crossover(tournament_select(population), tournament_select(population))
        child = mutate(child, rate=mutation_rate, strength=mutation_strength, rng=rng)
        new_pop.append(child)

    return new_pop


# ── Main evolution loop ────────────────────────────────────────────────────────

def run_evolution(args):
    checkpoints_dir = Path(args.checkpoints)
    active_models = args.models if args.models else ALL_MODEL_NAMES

    print(f"Loading {len(ALL_MODEL_NAMES)} checkpoints from {checkpoints_dir}")
    if active_models != ALL_MODEL_NAMES:
        print(f"Evolving only: {active_models}")
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
        {'perturbations': create_moe_perturbations(base_states, rng, args.scale, active_models), 'fitness': 0.0}
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
        per_genome_timeout=args.per_genome_timeout,
        alpha=args.alpha, beta=args.beta, gamma=args.gamma,
        fitness_mode=args.fitness_mode, strike_scale=args.strike_scale,
    )

    print(f"\nSending base weights to eval servers...")
    pool.set_base(base_states, args.map_width, args.map_height)

    best_genome = None
    best_ever = None  # survives across generations independent of elitism noise

    def _clone_genome(g: dict) -> dict:
        clone = {name: {layer: v.copy() for layer, v in layers.items()}
                 for name, layers in g['perturbations'].items()}
        return {'perturbations': clone, 'fitness': g['fitness'],
                'generation': g.get('generation'), 'games': g.get('games')}

    def _eval_baseline_and_log(gen_label: str):
        """Submit an empty-perturbation 'genome' (= unperturbed base) to one worker, log result."""
        empty_perts = {name: {} for name in ALL_MODEL_NAMES}
        b64 = pool.preexport(base_states, empty_perts, base_configs)
        try:
            res = pool.evaluate_b64(b64)
        except Exception as e:
            print(f"BASELINE @ {gen_label}: ERROR {e}", flush=True)
            return
        arr = np.array(res)
        sem = arr.std(ddof=1) / np.sqrt(len(arr)) if len(arr) > 1 else 0.0
        print(f"BASELINE @ {gen_label}: mean={arr.mean():.4f}  sem={sem:.4f}  n={len(arr)}", flush=True)

    try:
        for gen in range(args.generations):
            print(f"\n{'='*60}")
            print(f"Generation {gen + 1}/{args.generations}")
            print(f"{'='*60}")

            if args.baseline_every and (gen == 0 or (gen + 1) % args.baseline_every == 0):
                _eval_baseline_and_log(f"gen {gen + 1}/{args.generations}")

            if args.halve_games_first_half:
                pool.games_per_agent = args.games_per_agent if gen >= args.generations // 2 else max(3, args.games_per_agent // 2)
            else:
                pool.games_per_agent = args.games_per_agent

            # Phase 1: pack all genomes to npz bytes in parallel
            print(f"  Packing {len(population)} genomes...", flush=True)
            def _pack_genome(genome):
                try:
                    return pool.preexport(base_states, genome['perturbations'], base_configs)
                except Exception:
                    import traceback
                    print(f"  Pack failed:\n{traceback.format_exc()}", flush=True)
                    return None
            with ThreadPoolExecutor(max_workers=args.workers) as pack_exec:
                npz_list = list(pack_exec.map(_pack_genome, population))
            for genome, npz in zip(population, npz_list):
                genome['weights_npz'] = npz
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
                except RuntimeError as e:
                    # Expected: per-genome timeout fired → sidecar killed → stdout closed.
                    # Pool already respawned a fresh sidecar; this genome gets fitness=0.
                    if "stdout closed unexpectedly" in str(e):
                        return idx, 0.0, f"timeout (>{args.per_genome_timeout:.0f}s)"
                    import traceback
                    return idx, 0.0, traceback.format_exc()
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
                        # Single-line for timeouts (common, expected); full trace for everything else.
                        if err.startswith('timeout'):
                            print(f"  [{datetime.now().strftime('%H:%M:%S')}] Genome {idx:3d}: {err}  → fitness=0", flush=True)
                        else:
                            print(f"[{datetime.now().strftime('%H:%M:%S')}] Genome {idx} error:\n{err}", flush=True)
                    elif idx < 3 or fitness > 0.3:
                        print(f"  [{datetime.now().strftime('%H:%M:%S')}] Genome {idx:3d}: fitness={fitness:.4f}", flush=True)

                    pct = completed * 100 // pop_size
                    if completed % max(1, pop_size // 10) == 0:
                        print(f"  [{pct}%] {completed}/{pop_size} genomes evaluated", flush=True)

            best_genome = max(population, key=lambda g: g['fitness'])
            mean_fitness = np.mean([g['fitness'] for g in population])
            best_ever_fit = best_ever['fitness'] if best_ever else float('-inf')
            print(f"\nBest: {best_genome['fitness']:.4f}  Mean: {mean_fitness:.4f}  BestEver: {max(best_ever_fit, best_genome['fitness']):.4f}")

            if best_genome['fitness'] > best_ever_fit:
                best_ever = _clone_genome({'perturbations': best_genome['perturbations'],
                                           'fitness': best_genome['fitness'],
                                           'generation': gen,
                                           'games': pool.games_per_agent})
                ckpt_path = output_dir / 'best_ever.json'
                with open(ckpt_path, 'w') as f:
                    json.dump({'perturbations': _perts_to_json(best_ever['perturbations']),
                               'fitness': best_ever['fitness'],
                               'generation': gen,
                               'games': pool.games_per_agent}, f)
                print(f"NEW best_ever: {best_ever['fitness']:.4f} @ gen {gen} → {ckpt_path}")

            if best_genome['fitness'] > 0.1:
                ckpt_path = output_dir / f'checkpoint_gen{gen}.json'
                with open(ckpt_path, 'w') as f:
                    json.dump({'perturbations': _perts_to_json(best_genome['perturbations']),
                               'fitness': best_genome['fitness'],
                               'generation': gen}, f)

            population = next_generation(population, args.elitism, rng,
                                         mutation_rate=args.mutation_rate,
                                         mutation_strength=args.mutation_strength)

    finally:
        pool.close()

    # Export champion ONNX directory (use best_ever, falls back to last best_genome)
    champion_source = best_ever or best_genome
    if champion_source:
        champion_dir = output_dir / 'champion'
        champion_dir.mkdir(exist_ok=True)

        # Re-export champion models to disk for use as agent
        from models_moe import MovementCNN, ProductionCNN
        from moe_eval_pool import _export_model_to_bytes
        for name in ALL_MODEL_NAMES:
            pert = champion_source['perturbations'].get(name, {})
            perturbed = {}
            for layer, param in base_states[name].items():
                if layer in pert:
                    noise = torch.from_numpy(pert[layer]).to(dtype=param.dtype)
                    perturbed[layer] = param + noise
                else:
                    perturbed[layer] = param

            config = base_configs[name]
            if name == 'production':
                model = ProductionCNN(**config)
            else:
                model = MovementCNN(**config)
            # Strip torch.compile's `_orig_mod.` prefix so keys match the bare model.
            clean = {k.removeprefix('_orig_mod.'): v for k, v in perturbed.items()}
            model.load_state_dict(clean)

            onnx_bytes = _export_model_to_bytes(model, name, config)
            onnx_path = champion_dir / f'{name}.onnx'
            onnx_path.write_bytes(onnx_bytes)

        with open(output_dir / 'champion.json', 'w') as f:
            json.dump({'fitness': champion_source['fitness'],
                       'generation': champion_source.get('generation'),
                       'games': champion_source.get('games'),
                       'checkpoints_dir': str(checkpoints_dir)}, f)

        print(f"\nEvolution complete.")
        print(f"  Champion ONNX: {champion_dir}/")
        print(f"  Fitness: {champion_source['fitness']:.4f} (from gen {champion_source.get('generation')})")
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
    parser.add_argument('--models',          nargs='+', default=None,
                        help='Limit evolution to these model names (default: all 9)')
    parser.add_argument('--per-genome-timeout', type=float, default=120.0,
                        help='Kill+respawn sidecar if a genome eval exceeds this many seconds (0 to disable)')
    parser.add_argument('--mutation-rate',     type=float, default=0.05,
                        help='Per-weight probability of being mutated each generation')
    parser.add_argument('--mutation-strength', type=float, default=0.03,
                        help='Std-dev of mutation noise (should match --scale to avoid divergence)')
    parser.add_argument('--baseline-every',    type=int, default=0,
                        help='Re-evaluate unperturbed base every N gens (and at gen 0). 0 = never. '
                             'Uses current games_per_agent for apples-to-apples comparison.')
    parser.add_argument('--halve-games-first-half', action='store_true',
                        help='Use games_per_agent/2 in first half of gens (old default behavior). '
                             'Off by default — discovered this caused noise winners to inflate best_ever in Run 3.')
    parser.add_argument('--alpha',             type=float, default=1.0,
                        help='Weight on cityScore in fitness = α·cityScore + β·strikeValue')
    parser.add_argument('--beta',              type=float, default=0.0,
                        help='Weight on strikeValue (kills − own losses, weighted by location). 0 = disabled.')
    parser.add_argument('--gamma',             type=float, default=0.0,
                        help='Strike-value location multiplier coefficient: strike × (1 + γ/max(1,dist_to_my_city)). '
                             '0 = no location bonus; 3 = adjacent-to-city kills count 4×.')
    parser.add_argument('--fitness-mode',      choices=['additive', 'multiplicative', 'bounded'], default='additive',
                        help='additive: α·cityScore + β·strikeValue (Run 5 — gameable). '
                             'multiplicative: cityScore · (1 + β·strikeValue) (Run 6 — different gaming). '
                             'bounded: cityScore + β·tanh(strikeValue / strikeScale) (Run 7+ — strike capped at ±β).')
    parser.add_argument('--strike-scale',      type=float, default=100.0,
                        help='Scale for tanh in bounded fitness mode: strike normalized as tanh(strikeValue/scale). '
                             'Larger = stronger raw strikes needed to saturate the bonus.')
    args = parser.parse_args()
    run_evolution(args)


if __name__ == '__main__':
    main()
