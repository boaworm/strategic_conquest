"""
Export perturbed model to ONNX format.

Usage:
    python evolve_export.py --checkpoint model.pt --output model.onnx --perturbations-file perturbations.json
"""

import argparse
import json
import os
import warnings
import logging

# Suppress torch/onnx warnings
warnings.filterwarnings("ignore")
logging.getLogger("torch.onnx").setLevel(logging.ERROR)
logging.getLogger("onnx").setLevel(logging.ERROR)

import torch
import onnx
from onnx.external_data_helper import load_external_data_for_model
from train import PolicyCNN


def resolve_checkpoint_path(base_path: str) -> str:
    """Resolve checkpoint path, handling relative paths from evolution."""
    if os.path.isabs(base_path):
        return base_path
    # Resolve relative to project root (parent of packages/)
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    return os.path.join(project_root, base_path)


def load_base_state_and_config(ckpt_path: str):
    """
    Load base state dict and config, resolving the full checkpoint chain.
    For evolution checkpoints, recursively follows base_checkpoint until reaching
    a training checkpoint with model_state.
    Returns: (base_state, config, total_perturbations)
    """
    ckpt = torch.load(ckpt_path, weights_only=False, map_location="cpu")

    # If this is an evolution checkpoint (has perturbations + base_checkpoint)
    if "perturbations" in ckpt and "base_checkpoint" in ckpt:
        # Recursively resolve the base checkpoint chain
        base_path = resolve_checkpoint_path(ckpt["base_checkpoint"])
        base_state, config, parent_perturbations = load_base_state_and_config(base_path)
        # Combine: child perturbations are applied on top of parent
        # For evolution, we only need the final perturbations
        perturbations = ckpt["perturbations"]
        return base_state, config, perturbations
    else:
        # This is a training checkpoint
        base_state = ckpt.get("model_state", ckpt)
        config = ckpt["config"]
        return base_state, config, {}


def main():
    parser = argparse.ArgumentParser(description="Export perturbed model to ONNX")
    parser.add_argument("--checkpoint", required=True, help="Path to checkpoint (training or evolution)")
    parser.add_argument("--output", required=True, help="Output ONNX path")
    parser.add_argument("--perturbations-file", help="Path to perturbations JSON file (for training checkpoints)")
    args = parser.parse_args()

    # Load checkpoint and resolve chain
    base_state, config, perturbations = load_base_state_and_config(args.checkpoint)

    # If using training checkpoint with external perturbations file
    if not perturbations and args.perturbations_file:
        with open(args.perturbations_file) as f:
            perturbations = json.load(f)

    # Apply perturbations
    modified = {}
    for name, param in base_state.items():
        if name in perturbations:
            pert_data = perturbations[name]["data"]
            pert_shape = perturbations[name]["shape"]
            perturbation = torch.tensor(pert_data, dtype=param.dtype).reshape(pert_shape)
            modified[name] = param + perturbation
        else:
            modified[name] = param

    # Create model and load modified state
    model = PolicyCNN(**config)
    model.load_state_dict(modified)
    model.eval()

    # Create dummy input
    dummy_input = torch.randn(1, config["channels"], config["map_height"], config["map_width"])

    # Export to ONNX
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        torch.onnx.export(
            model,
            dummy_input,
            args.output,
            export_params=True,
            opset_version=18,
            do_constant_folding=True,
            input_names=["input"],
            output_names=["action_type", "target_tile", "prod_type"],
        )

    # Reload and re-save to merge external data
    model_proto = onnx.load(args.output, load_external_data=False)
    load_external_data_for_model(model_proto, os.path.dirname(os.path.abspath(args.output)))
    onnx.save_model(model_proto, args.output, save_as_external_data=False)

    print(f"Exported to {args.output}")


if __name__ == "__main__":
    main()
