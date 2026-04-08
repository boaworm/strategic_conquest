"""
Neuroevolution: Evolve NN weights using Evolution Strategies.
Exports perturbed models to ONNX and evaluates via Node.js with real BasicAgent.

Usage:
    python packages/trainer/ai/evolve.py \
        --checkpoint packages/trainer/ai/checkpoints/bertil-v2.0.pt \
        --population 30 --generations 20 --games-per-agent 5 --workers 4 \
        --output ./tmp/evolution
"""

import argparse
import json
import os
import sys
import subprocess
import tempfile
import time
from datetime import datetime
from pathlib import Path
import random

import torch
import numpy as np

# Add parent directory for imports
sys.path.insert(0, str(Path(__file__).parent))
from train import PolicyCNN


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
    if not os.path.isabs(checkpoint_path):
        checkpoint_path = os.path.abspath(os.path.join(os.getcwd(), checkpoint_path))
    if not os.path.isabs(output_path):
        output_path = os.path.abspath(output_path)

    with tempfile.NamedTemporaryFile(suffix='.json', delete=False, mode='w') as f:
        json.dump(perturbations, f)
        perturbations_file = f.name

    try:
        python_executable = sys.executable
        result = subprocess.run(
            [python_executable, 'evolve_export.py',
             '--checkpoint', checkpoint_path,
             '--output', output_path,
             '--perturbations-file', perturbations_file],
            cwd=Path(__file__).parent,
            capture_output=True,
            text=True,
            timeout=120
        )
        if result.returncode != 0:
            raise Exception(f"Export failed: {result.stderr}")
    except subprocess.TimeoutExpired:
        raise Exception("Export timed out")
    finally:
        os.unlink(perturbations_file)


def evaluate_genome_sequential(base_state_dict, perturbations, config, games_per_agent, map_width, map_height, max_turns, checkpoint_path, output_dir):
    """Evaluate genome by exporting to ONNX and running via Node.js."""
    # Export perturbed model to ONNX
    onnx_path = output_dir / f'tmp_{id(perturbations)}.onnx'

    # Create temp checkpoint with perturbations
    temp_ckpt = output_dir / f'tmp_{id(perturbations)}.pt'
    torch.save({
        'perturbations': perturbations,
        'base_checkpoint': checkpoint_path,
        'config': config,
    }, temp_ckpt)

    try:
        export_to_onnx(str(temp_ckpt), perturbations, str(onnx_path))

        # Run games via Node.js
        from game_evaluator import run_games_sequential

        start = time.time()
        results = run_games_sequential(str(onnx_path), map_width, map_height, max_turns, games_per_agent)
        timing = {'games': time.time() - start, 'export': 0}

        return results, timing

    finally:
        # Cleanup
        if onnx_path.exists():
            onnx_path.unlink()
        if temp_ckpt.exists():
            temp_ckpt.unlink()


def run_evolution(args):
    """Main evolution loop."""
    checkpoint_path = args.checkpoint

    print(f"Loading checkpoint: {checkpoint_path}")

    if not os.path.exists(checkpoint_path):
        print(f"ERROR: Checkpoint not found: {checkpoint_path}")
        sys.exit(1)

    ckpt = torch.load(checkpoint_path, weights_only=False, map_location="cpu")
    base_state_dict = ckpt['model_state']
    config = ckpt['config']

    rng = np.random.RandomState(args.seed)

    print(f"Initializing population of {args.population}...")
    population = []
    for i in range(args.population):
        perturbations = create_perturbation(base_state_dict, rng, scale=args.scale)
        population.append({
            'perturbations': perturbations,
            'fitness': 0,
        })

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    for gen in range(args.generations):
        print(f"\nGeneration {gen + 1}/{args.generations}")

        # Load base model
        model = PolicyCNN(**config)
        ckpt = torch.load(checkpoint_path, weights_only=False, map_location="cpu")
        while 'perturbations' in ckpt and 'base_checkpoint' in ckpt:
            ckpt = torch.load(ckpt['base_checkpoint'], weights_only=False, map_location="cpu")
        base_state_dict = ckpt.get('model_state', ckpt)
        model.load_state_dict(base_state_dict)

        # Evaluate each genome
        pop_size = len(population)
        progress_markers = {int(p * pop_size / 10) for p in range(1, 11)}

        for idx, genome in enumerate(population):
            try:
                results, timing = evaluate_genome_sequential(
                    base_state_dict, genome['perturbations'], config,
                    args.games_per_agent, args.map_width, args.map_height,
                    args.max_turns, checkpoint_path, output_dir
                )
                fitness = float(np.mean(results)) if results else 0.0
                population[idx]['fitness'] = fitness

                if idx < 3 or fitness > 0.5:
                    print(f"  Genome {idx}: cities={fitness:.4f} (n={len(results)})", flush=True)

            except Exception as e:
                import traceback
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Error evaluating genome {idx}: {e}\n{traceback.format_exc()}", flush=True)
                population[idx]['fitness'] = 0

            if idx in progress_markers:
                pct = (idx + 1) * 100 // pop_size
                print(f"[{pct}%]", flush=True)

        best = max(population, key=lambda g: g['fitness'])
        print(f"\nBest: {best['fitness']:.4f}, Mean: {np.mean([g['fitness'] for g in population]):.4f}")

        if best['fitness'] > 0.3:
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
    parser.add_argument('--population', type=int, default=30, help='Population size')
    parser.add_argument('--generations', type=int, default=20, help='Number of generations')
    parser.add_argument('--games-per-agent', type=int, default=5, help='Games per evaluation')
    parser.add_argument('--workers', type=int, default=4, help='Parallel workers (not yet implemented)')
    parser.add_argument('--elitism', type=int, default=2, help='Elites per generation')
    parser.add_argument('--scale', type=float, default=0.1, help='Initial perturbation scale')
    parser.add_argument('--seed', type=int, default=42, help='Random seed')
    parser.add_argument('--output', default='./evolved', help='Output directory')
    parser.add_argument('--map-width', type=int, default=30, help='Map width')
    parser.add_argument('--map-height', type=int, default=10, help='Map height (playable, excludes ice caps)')
    parser.add_argument('--max-turns', type=int, default=300, help='Max turns per game')
    args = parser.parse_args()

    run_evolution(args)


if __name__ == '__main__':
    main()
