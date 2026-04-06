"""
Export trained PyTorch model to ONNX format for TypeScript inference.

Usage:
    python export_onnx.py --checkpoint checkpoints/best_model.pt --output model.onnx
"""

import argparse
import os
import warnings
import logging

# Suppress torch/onnx warnings for cleaner output
warnings.filterwarnings("ignore")
logging.getLogger("torch.onnx").setLevel(logging.ERROR)
logging.getLogger("onnx").setLevel(logging.ERROR)

import torch
import onnx
from onnx.external_data_helper import load_external_data_for_model
from train import PolicyCNN


def main():
    parser = argparse.ArgumentParser(description="Export model to ONNX")
    parser.add_argument("--checkpoint", required=True, help="Path to best_model.pt")
    parser.add_argument("--output", default="model.onnx", help="Output ONNX file")
    args = parser.parse_args()

    # Load checkpoint
    ckpt = torch.load(args.checkpoint, map_location="cpu")
    config = ckpt["config"]

    # Create and load model
    model = PolicyCNN(
        channels=config["channels"],
        map_height=config["map_height"],
        map_width=config["map_width"],
    )
    model.load_state_dict(ckpt["model_state"])
    model.eval()

    # Create dummy input (batch_size=1, channels=14, H=22, W=50)
    dummy_input = torch.randn(1, config["channels"], config["map_height"], config["map_width"])

    # Export to ONNX (use opset 18 to avoid version conversion warnings)
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
            dynamic_axes={
                "input": {0: "batch"},
                "action_type": {0: "batch"},
                "target_tile": {0: "batch"},
                "prod_type": {0: "batch"},
            },
        )

    # Reload and re-save to merge any external data into a single inline file.
    # CoreML (and some other EPs) require inline weights; external data breaks them.
    model_proto = onnx.load(args.output, load_external_data=False)
    load_external_data_for_model(model_proto, os.path.dirname(os.path.abspath(args.output)))
    onnx.save_model(model_proto, args.output, save_as_external_data=False)

    # Remove stale external data file if present
    data_file = args.output + ".data"
    if os.path.exists(data_file):
        os.remove(data_file)

    print(f"Exported to {args.output}")
    print(f"Input shape: {config['channels']}x{config['map_height']}x{config['map_width']}")


if __name__ == "__main__":
    main()
