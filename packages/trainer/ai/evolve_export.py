"""
Helper script for nn-evolve.ts: Apply perturbations to base checkpoint and export to ONNX.

This is a minimal Python script - the heavy lifting (perturbation application, ONNX export)
happens here, but the evolution loop and game evaluation are in JavaScript.

Usage:
    python ai/evolve_export.py --checkpoint best_model.pt --output model.onnx --perturbations '{"layer1": {...}}'
"""

import argparse
import json
import torch
import numpy as np
from dataset import PolicyCNN


def apply_perturbations(state_dict, perturbations, scale=1.0):
    """Apply perturbations to state dict weights."""
    modified = {}
    for name, param in state_dict.items():
        if name in perturbations:
            pert_data = perturbations[name]['data']
            pert_shape = perturbations[name]['shape']
            perturbation = torch.tensor(pert_data, dtype=param.dtype).reshape(pert_shape)
            modified[name] = param + perturbation * scale
        else:
            modified[name] = param
    return modified


def main():
    parser = argparse.ArgumentParser(description='Export perturbed model to ONNX')
    parser.add_argument('--checkpoint', required=True, help='Base PyTorch checkpoint')
    parser.add_argument('--output', required=True, help='Output ONNX path')
    parser.add_argument('--perturbations', required=True, help='JSON perturbations')
    parser.add_argument('--scale', type=float, default=1.0, help='Perturbation scale')
    args = parser.parse_args()

    # Load base checkpoint
    ckpt = torch.load(args.checkpoint, map_location='cpu', weights_only=False)
    config = ckpt['config']
    base_state = ckpt['model_state']

    # Parse perturbations
    perturbations = json.loads(args.perturbations)

    # Apply perturbations
    modified_state = apply_perturbations(base_state, perturbations, scale=args.scale)

    # Create model and load modified weights
    model = PolicyCNN(
        channels=config['channels'],
        map_height=config['map_height'],
        map_width=config['map_width'],
    )
    model.load_state_dict(modified_state)
    model.eval()

    # Create dummy input
    dummy_input = torch.randn(1, config['channels'], config['map_height'], config['map_width'])

    # Export to ONNX
    torch.onnx.export(
        model,
        dummy_input,
        args.output,
        export_params=True,
        opset_version=14,
        do_constant_folding=True,
        input_names=['input'],
        output_names=['action_type', 'target_tile', 'prod_type'],
        dynamic_axes={
            'input': {0: 'batch'},
            'action_type': {0: 'batch'},
            'target_tile': {0: 'batch'},
            'prod_type': {0: 'batch'},
        },
    )

    print(f'Exported to {args.output}')


if __name__ == '__main__':
    main()
