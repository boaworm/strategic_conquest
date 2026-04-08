"""
Train one movement expert for a given unit type.

Usage:
  python train_movement.py \
    --unit-type army \
    --data-dir /Volumes/500G/Training/moe \
    --out-dir   ./checkpoints/moe \
    --epochs 50

Saves:
  checkpoints/moe/army.pt
  checkpoints/moe/army.onnx
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

from dataset_moe import MovementDataset, MOVEMENT_ACTION_TYPES, NUM_MOVEMENT_ACTIONS
from models_moe import MovementCNN


# ── Training ──────────────────────────────────────────────────────────────────

def train(args):
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"Device: {device}  Unit type: {args.unit_type}")

    dataset = MovementDataset(args.data_dir, args.unit_type)
    print(f"Loaded {len(dataset):,} samples for '{args.unit_type}'")

    val_n   = max(1, int(len(dataset) * 0.1))
    train_n = len(dataset) - val_n
    train_ds, val_ds = random_split(dataset, [train_n, val_n],
                                    generator=torch.Generator().manual_seed(42))

    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,  num_workers=4, pin_memory=True)
    val_dl   = DataLoader(val_ds,   batch_size=args.batch_size, shuffle=False, num_workers=2, pin_memory=True)

    model = MovementCNN(
        channels=15,
        map_height=dataset.map_height,
        map_width=dataset.map_width,
    ).to(device)

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    best_val_loss = float('inf')

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        t0 = time.time()

        for states, action_types, tile_idxs in train_dl:
            states       = states.to(device)
            action_types = action_types.to(device)
            tile_idxs    = tile_idxs.to(device)

            out = model(states)

            # Action type loss
            loss_at = F.cross_entropy(out['action_type'], action_types)

            # Tile loss — only for MOVE (idx=0) and UNLOAD (idx=4) with valid tile
            move_mask = ((action_types == 0) | (action_types == 4)) & (tile_idxs >= 0)
            if move_mask.any():
                loss_tile = F.cross_entropy(out['target_tile'][move_mask], tile_idxs[move_mask])
            else:
                loss_tile = torch.tensor(0.0, device=device)

            loss = loss_at + loss_tile
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

        scheduler.step()

        # Validation
        model.eval()
        val_loss = 0.0
        correct_at = 0
        with torch.no_grad():
            for states, action_types, tile_idxs in val_dl:
                states       = states.to(device)
                action_types = action_types.to(device)
                tile_idxs    = tile_idxs.to(device)
                out = model(states)
                val_loss += F.cross_entropy(out['action_type'], action_types).item()
                correct_at += (out['action_type'].argmax(1) == action_types).sum().item()

        val_loss /= len(val_dl)
        val_acc   = correct_at / len(val_ds)
        elapsed   = time.time() - t0

        print(f"Epoch {epoch:3d}/{args.epochs}  train={total_loss/len(train_dl):.4f}"
              f"  val={val_loss:.4f}  acc={val_acc:.3f}  ({elapsed:.1f}s)")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                'model_state': model.state_dict(),
                'config': {
                    'channels': 15,
                    'map_height': dataset.map_height,
                    'map_width':  dataset.map_width,
                },
                'unit_type': args.unit_type,
                'epoch': epoch,
                'val_loss': val_loss,
            }, out_dir / f'{args.unit_type}.pt')

    print(f"\nBest val loss: {best_val_loss:.4f}")
    export_onnx(model, dataset.map_height, dataset.map_width, out_dir / f'{args.unit_type}.onnx')
    print(f"Exported: {out_dir / args.unit_type}.onnx")


def export_onnx(model: MovementCNN, map_height: int, map_width: int, output_path: Path):
    model.eval().cpu()
    dummy = torch.randn(1, 15, map_height, map_width)
    warnings.filterwarnings("ignore")
    logging.getLogger("torch.onnx").setLevel(logging.ERROR)
    torch.onnx.export(
        model, dummy, str(output_path),
        export_params=True,
        opset_version=18,
        do_constant_folding=True,
        input_names=["input"],
        output_names=["action_type", "target_tile"],
    )
    # Merge external data
    import onnx
    from onnx.external_data_helper import load_external_data_for_model
    import os
    proto = onnx.load(str(output_path), load_external_data=False)
    load_external_data_for_model(proto, str(output_path.parent))
    onnx.save_model(proto, str(output_path), save_as_external_data=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--unit-type',  required=True,
                        choices=['army','fighter','bomber','transport','destroyer','submarine','carrier','battleship'])
    parser.add_argument('--data-dir',   required=True)
    parser.add_argument('--out-dir',    default='./checkpoints/moe')
    parser.add_argument('--epochs',     type=int,   default=50)
    parser.add_argument('--batch-size', type=int,   default=512)
    parser.add_argument('--lr',         type=float, default=1e-3)
    args = parser.parse_args()
    train(args)


if __name__ == '__main__':
    main()
