"""
Train the production expert.

Usage:
  python train_production.py \
    --data-dir /Volumes/500G/Training/moe \
    --out-dir   ./checkpoints/moe \
    --epochs 50

Saves:
  checkpoints/moe/production.pt
  checkpoints/moe/production.onnx
"""

import argparse
import time
import warnings
import logging
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, random_split

from dataset_moe import ProductionDataset, NUM_UNIT_TYPES, NUM_GLOBAL
from models_moe import ProductionCNN


# ── Training ──────────────────────────────────────────────────────────────────

def train(args):
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"Device: {device}  Task: production expert")

    dataset = ProductionDataset(args.data_dir, file_idx=args.file_idx)
    file_label = f"file {args.file_idx}" if args.file_idx is not None else "all files"
    print(f"Loaded {len(dataset):,} production samples ({file_label})")

    val_n   = max(1, int(len(dataset) * 0.1))
    train_n = len(dataset) - val_n
    train_ds, val_ds = random_split(dataset, [train_n, val_n],
                                    generator=torch.Generator().manual_seed(42))

    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,  num_workers=0)
    val_dl   = DataLoader(val_ds,   batch_size=args.batch_size, shuffle=False, num_workers=0)

    model = ProductionCNN(
        channels=15,
        map_height=dataset.map_height,
        map_width=dataset.map_width,
    ).to(device)

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    best_val_loss = float('inf')
    ckpt_path = out_dir / 'production.pt'
    should_resume = ckpt_path.exists() and (args.resume or (args.file_idx is not None and args.file_idx > 0))
    if should_resume:
        ckpt = torch.load(ckpt_path, weights_only=False, map_location=device)
        model.load_state_dict(ckpt['model_state'])
        best_val_loss = ckpt['val_loss']
        print(f"Warm-started from checkpoint  best_val_loss={best_val_loss:.4f}")

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        t0 = time.time()

        for states, globals_, unit_types in train_dl:
            states     = states.to(device)
            globals_   = globals_.to(device)
            unit_types = unit_types.to(device)

            out = model(states, globals_)
            loss = F.cross_entropy(out['unit_type'], unit_types)

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        scheduler.step()

        model.eval()
        val_loss = 0.0
        correct  = 0
        with torch.no_grad():
            for states, globals_, unit_types in val_dl:
                states     = states.to(device)
                globals_   = globals_.to(device)
                unit_types = unit_types.to(device)
                out = model(states, globals_)
                val_loss += F.cross_entropy(out['unit_type'], unit_types).item()
                correct  += (out['unit_type'].argmax(1) == unit_types).sum().item()

        val_loss /= len(val_dl)
        val_acc   = correct / len(val_ds)
        elapsed   = time.time() - t0

        print(f"Epoch {epoch:3d}/{args.epochs}  train={total_loss/len(train_dl):.4f}"
              f"  val={val_loss:.4f}  acc={val_acc:.3f}  ({elapsed:.1f}s)")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                'model_state': model.state_dict(),
                'config': {
                    'channels':   15,
                    'map_height': dataset.map_height,
                    'map_width':  dataset.map_width,
                    'num_global': NUM_GLOBAL,
                },
                'epoch':    epoch,
                'val_loss': val_loss,
            }, out_dir / 'production.pt')

    print(f"\nBest val loss: {best_val_loss:.4f}")
    best_ckpt = torch.load(out_dir / 'production.pt', weights_only=False, map_location='cpu')
    model.load_state_dict(best_ckpt['model_state'])
    export_onnx(model, dataset.map_height, dataset.map_width, out_dir / 'production.onnx')
    print(f"Exported: {out_dir}/production.onnx")


def export_onnx(model: ProductionCNN, map_height: int, map_width: int, output_path: Path):
    model.eval().cpu()
    dummy_spatial = torch.randn(1, 15, map_height, map_width)
    dummy_global  = torch.randn(1, NUM_GLOBAL)
    warnings.filterwarnings("ignore")
    logging.getLogger("torch.onnx").setLevel(logging.ERROR)
    torch.onnx.export(
        model,
        (dummy_spatial, dummy_global),
        str(output_path),
        export_params=True,
        opset_version=18,
        do_constant_folding=True,
        input_names=["input", "global_features"],
        output_names=["unit_type"],
    )
    import onnx
    from onnx.external_data_helper import load_external_data_for_model
    proto = onnx.load(str(output_path), load_external_data=False)
    load_external_data_for_model(proto, str(output_path.parent))
    onnx.save_model(proto, str(output_path), save_as_external_data=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir',   required=True)
    parser.add_argument('--out-dir',    default='./checkpoints/moe')
    parser.add_argument('--epochs',     type=int,   default=50)
    parser.add_argument('--batch-size', type=int,   default=512)
    parser.add_argument('--lr',         type=float, default=1e-3)
    parser.add_argument('--file-idx',   type=int,   default=None,
                        help='Train on a single worker file (0-based). Warm-starts from existing checkpoint if > 0.')
    parser.add_argument('--resume',     action='store_true',
                        help='Warm-start from existing checkpoint even at file-idx 0.')
    args = parser.parse_args()
    train(args)


if __name__ == '__main__':
    main()
