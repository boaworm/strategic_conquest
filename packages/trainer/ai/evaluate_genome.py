"""
Evaluate a single genome by playing games.

This script:
1. Loads base model checkpoint
2. Applies perturbations from genome
3. Exports to ONNX
4. Runs games via subprocess (nn-sim)
5. Returns win rate

Usage:
    python evaluate_genome.py --checkpoint base.pt --perturbations gen0.pkl --games 5
"""

import argparse
import torch
import subprocess
import tempfile
import os
import pickle
from pathlib import Path

from dataset import PolicyCNN


def load_genome(genome_path: str):
    """Load genome (perturbations) from file."""
    with open(genome_path, 'rb') as f:
        return pickle.load(f)


def apply_genome_to_model(base_checkpoint_path: str, perturbations: dict):
    """Apply genome perturbations to base model and return modified state dict."""
    ckpt = torch.load(base_checkpoint_path, weights_only=False)
    base_state = ckpt['model_state']
    config = ckpt['config']

    # Apply perturbations
    modified = {}
    for name, param in base_state.items():
        if name in perturbations:
            perturbation = perturbations[name]
            if isinstance(perturbation, torch.Tensor):
                perturbation = perturbation.detach().cpu()
            modified[name] = param + perturbation
        else:
            modified[name] = param

    return modified, config


def export_to_onnx(state_dict, config, output_path: str):
    """Export model to ONNX."""
    model = PolicyCNN(**config)
    model.load_state_dict(state_dict)
    model.eval()

    # Dummy input
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


def run_games(onnx_path: str, num_games: int, map_width: int, map_height: int):
    """
    Run games using the ONNX model via nn-simulator.

    Returns: (wins, total_games)
    """
    # Set environment for nn-simulator
    env = os.environ.copy()
    env['NN_MODEL_PATH'] = onnx_path
    env['MAP_WIDTH'] = str(map_width)
    env['MAP_HEIGHT'] = str(map_height)

    # Run nn-simulator (NN vs BasicAgent)
    # This is a simplification - actual implementation would need to:
    # 1. Start Python server with the model
    # 2. Run TypeScript nn-simulator connecting to it
    # 3. Parse output for win/loss

    # For now, return placeholder
    return 0, num_games


def evaluate_genome(base_checkpoint: str, perturbations: dict, games: int,
                    map_width: int, map_height: int):
    """Evaluate a single genome."""
    # Apply perturbations to model
    modified_state, config = apply_genome_to_model(base_checkpoint, perturbations)

    # Export to temporary ONNX file
    with tempfile.NamedTemporaryFile(suffix='.onnx', delete=False) as f:
        onnx_path = f.name

    try:
        export_to_onnx(modified_state, config, onnx_path)

        # Run games
        wins, total = run_games(onnx_path, games, map_width, map_height)

        return wins / total if total > 0 else 0.0

    finally:
        if os.path.exists(onnx_path):
            os.unlink(onnx_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--perturbations', required=True)
    parser.add_argument('--games', type=int, default=5)
    parser.add_argument('--map-width', type=int, default=50)
    parser.add_argument('--map-height', type=int, default=20)
    args = parser.parse_args()

    # Load genome
    perturbations = load_genome(args.perturbations)

    # Evaluate
    win_rate = evaluate_genome(
        args.checkpoint,
        perturbations,
        args.games,
        args.map_width,
        args.map_height,
    )

    print(f"Win rate: {win_rate:.4f}")


if __name__ == '__main__':
    main()
