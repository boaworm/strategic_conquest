"""
Neuroevolution: Evolve NN weights using Evolution Strategies.

Usage:
    python packages/trainer/ai/evolve.py \
        --checkpoint packages/trainer/ai/checkpoints/adam-v2.0.pt \
        --pop 20 --gens 30 --games-per-agent 3 --workers 4 \
        --output /Volumes/500G/Training/evolution
"""

import argparse
import json
import os
import sys
import subprocess
import tempfile
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
import random

import torch
import numpy as np
import onnxruntime as ort

# Install dependencies first: pip install -r requirements.txt (from project root)
from train import PolicyCNN

# Import game evaluator directly
from game_evaluator import run_game, SimpleGame, player_view_to_tensor


def create_perturbation(base_state_dict, rng, scale=0.1):
    """Create random perturbation of weights."""
    perturbations = {}
    for name, param in base_state_dict.items():
        if param.dtype in [torch.float32, torch.float16, torch.float64]:
            noise = torch.randn_like(param) * scale
            perturbations[name] = {
                'data': noise.detach().cpu().numpy().flatten().tolist(),
                'shape': list(param.shape)
            }
    return perturbations


def tournament_select(population, k=3):
    """Tournament selection."""
    candidates = random.sample(population, min(k, len(population)))
    return max(candidates, key=lambda g: g['fitness'])


def crossover(parent1, parent2, rng):
    """Single-point crossover on perturbations."""
    child_perturbations = {}
    for name in parent1['perturbations']:
        p1 = np.array(parent1['perturbations'][name]['data']).reshape(parent1['perturbations'][name]['shape'])
        p2 = np.array(parent2['perturbations'][name]['data']).reshape(parent2['perturbations'][name]['shape'])
        flat1 = p1.flatten()
        flat2 = p2.flatten()
        cut = random.randint(0, len(flat1) - 1)
        child_flat = np.concatenate([flat1[:cut], flat2[cut:]])
        child_perturbations[name] = {
            'data': child_flat.tolist(),
            'shape': list(p1.shape)
        }
    return {'perturbations': child_perturbations, 'fitness': 0}


def mutate(genome, rate=0.05, strength=0.1, rng=None):
    """Gaussian mutation on perturbations."""
    for name in genome['perturbations']:
        arr = np.array(genome['perturbations'][name]['data'])
        mask = rng.random(arr.shape) < rate
        arr[mask] += rng.randn(*arr[mask].shape) * strength
        genome['perturbations'][name]['data'] = arr.tolist()
    return genome


def next_generation(population, elitism=2, rng=None):
    """Tournament selection + crossover + mutation."""
    population.sort(key=lambda g: g['fitness'], reverse=True)

    new_pop = []
    for p in population[:elitism]:
        new_perturbations = {}
        for name, pert in p['perturbations'].items():
            new_perturbations[name] = {'data': pert['data'][:], 'shape': pert['shape'][:]}
        new_pop.append({'perturbations': new_perturbations, 'fitness': 0})

    while len(new_pop) < len(population):
        parent1 = tournament_select(population)
        parent2 = tournament_select(population)
        child = crossover(parent1, parent2, rng)
        child = mutate(child, rate=0.05, strength=0.1, rng=rng)
        new_pop.append(child)

    return new_pop


def export_to_onnx(checkpoint_path, perturbations, output_path):
    """Export model with perturbations to ONNX."""
    # Resolve checkpoint path to absolute (relative to project root)
    if not os.path.isabs(checkpoint_path):
        checkpoint_path = os.path.abspath(os.path.join(os.getcwd(), checkpoint_path))

    # Ensure output path is absolute
    if not os.path.isabs(output_path):
        output_path = os.path.abspath(output_path)

    with tempfile.NamedTemporaryFile(suffix='.json', delete=False, mode='w') as f:
        json.dump(perturbations, f)
        perturbations_file = f.name

    try:
        # Use same Python executable as current process
        python_executable = sys.executable

        result = subprocess.run(
            [python_executable, 'evolve_export.py',
             '--checkpoint', checkpoint_path,
             '--output', output_path,
             '--perturbations-file', perturbations_file],
            cwd=Path(__file__).parent,
            capture_output=True,
            text=True,
            timeout=60
        )
        if result.returncode != 0:
            raise Exception(f"Export failed: {result.stderr}")
    except subprocess.TimeoutExpired:
        raise Exception("Export timed out")
    finally:
        os.unlink(perturbations_file)


def evaluate_genome(args):
    """Worker process to evaluate a single genome."""
    perturbations, checkpoint_path, games_per_agent, map_width, map_height, max_turns, worker_id = args

    # Ensure tmp/ directory exists (relative to project root)
    tmp_dir = os.path.abspath('tmp')
    os.makedirs(tmp_dir, exist_ok=True)

    # Export to ONNX (use absolute path)
    onnx_path = os.path.join(tmp_dir, f'evolve_{worker_id}_{random.randint(0, 10000)}.onnx')
    try:
        export_to_onnx(checkpoint_path, perturbations, onnx_path)

        # Run games directly
        wins = 0
        draws = 0
        losses = 0

        for g in range(games_per_agent):
            result = run_game(onnx_path, map_width, map_height, max_turns)
            if result == 1:
                wins += 1
            elif result == 0.5:
                draws += 1
            else:
                losses += 1

        return wins, draws, losses

    finally:
        if os.path.exists(onnx_path):
            os.unlink(onnx_path)


def run_evolution(args):
    """Main evolution loop."""
    # Use checkpoint path as-is (already relative to project root)
    checkpoint_path = args.checkpoint

    print(f"Loading checkpoint: {checkpoint_path}")

    if not os.path.exists(checkpoint_path):
        print(f"ERROR: Checkpoint not found: {checkpoint_path}")
        sys.exit(1)

    ckpt = torch.load(checkpoint_path, weights_only=False, map_location="cpu")
    base_state_dict = ckpt['model_state']
    config = ckpt['config']

    rng = np.random.RandomState(args.seed)

    print(f"Initializing population of {args.pop}...")
    population = []
    for i in range(args.pop):
        perturbations = create_perturbation(base_state_dict, rng, scale=args.scale)
        population.append({
            'perturbations': perturbations,
            'fitness': 0,
        })

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    for gen in range(args.gens):
        print(f"\nGeneration {gen + 1}/{args.gens}")

        eval_args = [
            (g['perturbations'], checkpoint_path, args.games_per_agent,
             args.map_width, args.map_height, args.max_turns, i % args.workers)
            for i, g in enumerate(population)
        ]

        with ProcessPoolExecutor(max_workers=args.workers) as executor:
            futures = {executor.submit(evaluate_genome, arg): i for i, arg in enumerate(eval_args)}
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    wins, draws, losses = future.result()
                    fitness = (wins * 1 + draws * 0.5) / (wins + draws + losses)
                    population[idx]['fitness'] = fitness
                    print(f"  Genome {idx}: {wins}W-{draws}D-{losses}L (fitness: {fitness:.4f})")
                except Exception as e:
                    print(f"Error evaluating genome {idx}: {e}")
                    population[idx]['fitness'] = 0

        best = max(population, key=lambda g: g['fitness'])
        print(f"\nBest: {best['fitness']:.4f}, Mean: {np.mean([g['fitness'] for g in population]):.4f}")

        if best['fitness'] > 0.5:
            new_ckpt_path = str(output_dir / f'checkpoint_gen{gen}.json')
            torch.save({
                'perturbations': best['perturbations'],
                'base_checkpoint': checkpoint_path,
                'generation': gen,
                'fitness': best['fitness'],
                'config': config,
            }, new_ckpt_path)
            print(f"Saved checkpoint: {new_ckpt_path}")
            checkpoint_path = new_ckpt_path

        population = next_generation(population, elitism=args.elitism, rng=rng)

    # Save champion
    champion_path = output_dir / 'champion.json'
    torch.save({
        'perturbations': best['perturbations'],
        'base_checkpoint': checkpoint_path,
        'fitness': best['fitness'],
        'config': config,
    }, champion_path)
    print(f"\nEvolution complete. Champion: {champion_path} (fitness: {best['fitness']:.4f})")


def main():
    parser = argparse.ArgumentParser(description='Neuroevolution for NN policy')
    parser.add_argument('--checkpoint', required=True, help='Base model checkpoint')
    parser.add_argument('--pop', type=int, default=30, help='Population size')
    parser.add_argument('--gens', type=int, default=50, help='Number of generations')
    parser.add_argument('--games-per-agent', type=int, default=5, help='Games per evaluation')
    parser.add_argument('--workers', type=int, default=8, help='Parallel workers')
    parser.add_argument('--elitism', type=int, default=2, help='Elites per generation')
    parser.add_argument('--scale', type=float, default=0.1, help='Initial perturbation scale')
    parser.add_argument('--seed', type=int, default=42, help='Random seed')
    parser.add_argument('--output', default='./evolved', help='Output directory')
    parser.add_argument('--map-width', type=int, default=50, help='Map width')
    parser.add_argument('--map-height', type=int, default=20, help='Map height')
    parser.add_argument('--max-turns', type=int, default=300, help='Max turns per game')
    args = parser.parse_args()

    run_evolution(args)


if __name__ == '__main__':
    main()
