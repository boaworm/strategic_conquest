"""
Phase 3: Neuroevolution - Evolve NN weights from supervised checkpoint

Uses Evolution Strategies to fine-tune a pre-trained model by evolving
perturbations to the weights.

This implementation:
1. Exports each evolved model to ONNX
2. Starts a Python server with the model
3. Runs nn_simulator.ts to play games
4. Parses results for fitness

Usage:
    python evolve.py \
        --checkpoint ./checkpoints/best_model.pt \
        --pop 30 \
        --gens 50 \
        --games-per-agent 5 \
        --output ./evolved
"""

import argparse
import torch
import numpy as np
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
import random
import subprocess
import tempfile
import os
import signal
import time

from dataset import PolicyCNN


def load_base_checkpoint(checkpoint_path: str):
    """Load supervised training checkpoint."""
    ckpt = torch.load(checkpoint_path, weights_only=False)
    return ckpt


def create_perturbation(base_state_dict, rng, scale=0.1):
    """Create random perturbation of weights."""
    perturbations = {}
    for name, param in base_state_dict.items():
        noise = torch.randn_like(param) * scale
        perturbations[name] = noise.detach().cpu()
    return perturbations


def apply_perturbation(base_state_dict, perturbations):
    """Apply perturbations to base weights."""
    modified = {}
    for name, param in base_state_dict.items():
        if name in perturbations:
            modified[name] = param + perturbations[name]
        else:
            modified[name] = param
    return modified


def tournament_select(population, k=3):
    """Tournament selection."""
    candidates = random.sample(population, min(k, len(population)))
    return max(candidates, key=lambda g: g['fitness'])


def crossover(parent1, parent2, rng):
    """Single-point crossover on perturbations."""
    child_perturbations = {}
    for name in parent1['perturbations']:
        p1 = parent1['perturbations'][name]
        p2 = parent2['perturbations'][name]
        flat1 = p1.flatten().numpy()
        flat2 = p2.flatten().numpy()
        cut = random.randint(0, len(flat1) - 1)
        child_flat = np.concatenate([flat1[:cut], flat2[cut:]])
        child_perturbations[name] = torch.from_numpy(child_flat.reshape(p1.shape))
    return {'perturbations': child_perturbations, 'fitness': 0}


def mutate(genome, rate=0.1, strength=0.1, rng=None):
    """Gaussian mutation on perturbations."""
    for name in genome['perturbations']:
        mask = rng.random(genome['perturbations'][name].shape) < rate
        genome['perturbations'][name][mask] += torch.from_numpy(
            rng.randn(*mask.shape) * strength
        )
    return genome


def next_generation(population, elitism=2, rng=None):
    """Tournament selection + crossover + mutation."""
    population.sort(key=lambda g: g['fitness'], reverse=True)

    new_pop = []
    for p in population[:elitism]:
        new_perturbations = {}
        for name, pert in p['perturbations'].items():
            new_perturbations[name] = pert.clone()
        new_pop.append({'perturbations': new_perturbations, 'fitness': 0})

    while len(new_pop) < len(population):
        parent1 = tournament_select(population)
        parent2 = tournament_select(population)
        child = crossover(parent1, parent2, rng)
        child = mutate(child, rate=0.05, strength=0.1, rng=rng)
        new_pop.append(child)

    return new_pop


def export_to_onnx(state_dict, config, output_path: str):
    """Export model to ONNX."""
    model = PolicyCNN(**config)
    model.load_state_dict(state_dict)
    model.eval()

    dummy = torch.randn(1, 14, config['map_height'] + 2, config['map_width'])

    torch.onnx.export(
        model,
        dummy,
        output_path,
        input_names=['input'],
        output_names=['action_type', 'target_tile', 'prod_type'],
        dynamic_axes={
            'input': {0: 'batch'},
            'action_type': {0: 'batch'},
            'target_tile': {0: 'batch'},
            'prod_type': {0: 'batch'},
        },
    )


def evaluate_genome_worker(args):
    """Worker process to evaluate a single genome."""
    perturbations_serialized, base_checkpoint, config, games_per_agent, map_width, map_height, worker_id = args

    # Deserialize perturbations
    perturbations = {}
    for name, flat_data in perturbations_serialized.items():
        perturbations[name] = torch.tensor(flat_data['data'], dtype=torch.float32).reshape(flat_data['shape'])

    # Apply perturbations
    ckpt = torch.load(base_checkpoint, weights_only=False)
    base_state = ckpt['model_state']
    modified = apply_perturbation(base_state, perturbations)

    # Export to temporary ONNX file
    with tempfile.NamedTemporaryFile(suffix='.onnx', delete=False, dir=f'/tmp/nn_evolution_{worker_id}') as f:
        onnx_path = f.name

    try:
        export_to_onnx(modified, config, onnx_path)

        # Run evaluation via nn-simulator
        wins = 0
        for game in range(games_per_agent):
            result = run_single_game(onnx_path, map_width, map_height, worker_id, game)
            if result:
                wins += result

        return wins / games_per_agent

    finally:
        if os.path.exists(onnx_path):
            os.unlink(onnx_path)


def run_single_game(onnx_path: str, map_width: int, map_height: int, worker_id: int, game_id: int):
    """
    Run a single game using the ONNX model.

    Returns: 1 if NN wins, 0 otherwise
    """
    uds_path = f'/tmp/nn_eval_{worker_id}_{game_id}.sock'

    # Start Python server with the model
    env = os.environ.copy()
    env['NN_MODEL_PATH'] = onnx_path
    env['UDS_PATH'] = uds_path

    server_proc = subprocess.Popen(
        ['python', 'server.py'],
        env=env,
        cwd=os.path.dirname(os.path.abspath(__file__)),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Wait for server to start
    time.sleep(1)

    try:
        # Run nn-simulator
        result = subprocess.run(
            ['npm', 'run', 'nn-sim'],
            cwd='/Users/henrik/src/strategic_conquest/packages/trainer',
            env={**os.environ, 'UDS_PATH': uds_path},
            timeout=120,
            capture_output=True,
            text=True,
        )

        # Parse output for winner
        output = result.stdout + result.stderr
        if 'player1' in output.lower() and 'win' in output.lower():
            return 1
        elif 'draw' in output.lower():
            return 0.5
        return 0

    except subprocess.TimeoutExpired:
        return 0
    except Exception as e:
        print(f"Game evaluation error: {e}")
        return 0
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
        if os.path.exists(uds_path):
            os.unlink(uds_path)


def run_evolution(args):
    """Main evolution loop."""
    print(f"Loading checkpoint: {args.checkpoint}")
    ckpt = load_base_checkpoint(args.checkpoint)
    base_state_dict = ckpt['model_state']
    config = ckpt['config']

    random.seed(args.seed)
    np.random.seed(args.seed)
    rng = np.random.RandomState(args.seed)

    print(f"Initializing population of {args.pop}...")
    population = []
    for i in range(args.pop):
        perturbations = create_perturbation(base_state_dict, rng, scale=args.scale)
        perturbations_serialized = {}
        for name, param in perturbations.items():
            perturbations_serialized[name] = {
                'data': param.numpy().flatten().tolist(),
                'shape': param.shape,
            }
        population.append({
            'perturbations': perturbations_serialized,
            'fitness': 0,
        })

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Create temp directories for workers
    for i in range(args.workers):
        os.makedirs(f'/tmp/nn_evolution_{i}', exist_ok=True)

    for gen in range(args.gens):
        print(f"\nGeneration {gen + 1}/{args.gens}")

        eval_args = [
            (g['perturbations'], args.checkpoint, config, args.games_per_agent, args.map_width, args.map_height, i % args.workers)
            for i, g in enumerate(population)
        ]

        with ProcessPoolExecutor(max_workers=args.workers) as executor:
            futures = {executor.submit(evaluate_genome_worker, arg): i for i, arg in enumerate(eval_args)}
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    fitness = future.result()
                    population[idx]['fitness'] = fitness
                    print(f"  Genome {idx} fitness: {fitness:.4f}")
                except Exception as e:
                    print(f"Error evaluating genome {idx}: {e}")
                    population[idx]['fitness'] = 0

        best = max(population, key=lambda g: g['fitness'])
        print(f"\nBest fitness: {best['fitness']:.4f}")
        print(f"Mean fitness: {np.mean([g['fitness'] for g in population]):.4f}")

        if best['fitness'] > 0.5:
            checkpoint_path = output_dir / f'checkpoint_gen{gen}.pt'
            torch.save({
                'perturbations': best['perturbations'],
                'base_checkpoint': args.checkpoint,
                'generation': gen,
                'fitness': best['fitness'],
                'config': config,
            }, checkpoint_path)
            print(f"Saved checkpoint: {checkpoint_path}")

        population = next_generation(population, elitism=args.elitism, rng=rng)

    print(f"\nEvolution complete. Best checkpoint in {output_dir}")


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
    args = parser.parse_args()

    run_evolution(args)


if __name__ == '__main__':
    main()
