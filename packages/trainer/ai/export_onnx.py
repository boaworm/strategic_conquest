"""
Export trained PyTorch model to ONNX format for TypeScript inference.

Usage:
    python export_onnx.py --checkpoint checkpoints/best_model.pt --output model.onnx
"""

import argparse
import torch
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

    # Export to ONNX
    torch.onnx.export(
        model,
        dummy_input,
        args.output,
        export_params=True,
        opset_version=14,
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

    print(f"Exported to {args.output}")
    print(f"Input shape: {config['channels']}x{config['map_height']}x{config['map_width']}")


if __name__ == "__main__":
    main()
