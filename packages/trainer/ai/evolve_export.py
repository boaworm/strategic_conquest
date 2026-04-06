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


def main():
    parser = argparse.ArgumentParser(description="Export perturbed model to ONNX")
    parser.add_argument("--checkpoint", required=True, help="Path to base checkpoint")
    parser.add_argument("--output", required=True, help="Output ONNX path")
    parser.add_argument("--perturbations-file", help="Path to perturbations JSON file (optional for evolution checkpoints)")
    args = parser.parse_args()

    # Load base checkpoint (supports both training and evolution checkpoints)
    ckpt = torch.load(args.checkpoint, weights_only=False, map_location="cpu")
    config = ckpt["config"]

    # Handle evolution checkpoint (references base checkpoint)
    if "perturbations" in ckpt and "base_checkpoint" in ckpt:
        base_ckpt = torch.load(ckpt["base_checkpoint"], weights_only=False, map_location="cpu")
        base_state = base_ckpt["model_state"]
        # Apply stored perturbations
        perturbations = ckpt["perturbations"]
    else:
        base_state = ckpt["model_state"]
        # Load perturbations from file
        if args.perturbations_file:
            with open(args.perturbations_file) as f:
                perturbations = json.load(f)
        else:
            perturbations = {}

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


if __name__ == "__main__":
    main()
