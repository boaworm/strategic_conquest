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
    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
    print(f"Device: {device}  Unit type: {args.unit_type}")

    dataset = MovementDataset(args.data_dir, args.unit_type, file_idx=args.file_idx, use_bf16=(device.type == "cuda"))
    file_label = f"file {args.file_idx + 1}" if args.file_idx is not None else "all files"
    print(f"Loaded {len(dataset):,} samples for '{args.unit_type}' ({file_label})")

    # Inverse-frequency class weights so rare actions get equal gradient weight
    counts = torch.bincount(dataset.action_types.cpu(), minlength=NUM_MOVEMENT_ACTIONS).float()
    counts = counts.clamp(min=1)
    class_weights = (counts.sum() / (NUM_MOVEMENT_ACTIONS * counts)).to(device)
    print(f"Action class weights: { {MOVEMENT_ACTION_TYPES[i]: f'{class_weights[i].item():.2f}' for i in range(NUM_MOVEMENT_ACTIONS)} }")

    batch_size = args.batch_size
    if args.target_vram_usage_gb > 0:
        # Empirical: ~3.4 MB activation memory per sample (measured on GB10 with this model)
        # Fixed overhead: dataset + CUDA context + model + ~2 GB headroom
        fixed_bytes   = dataset.states17.nbytes + 2 * 1024 ** 3
        target_bytes  = int(args.target_vram_usage_gb * 1024 ** 3)
        batch_size    = max(256, ((target_bytes - fixed_bytes) // (3_400_000)) // 256 * 256)
        print(f"Auto batch size: {batch_size:,}  (target {args.target_vram_usage_gb} GB, dataset {dataset.states17.nbytes / 1024**3:.1f} GB)")

    val_n   = max(1, int(len(dataset) * 0.1))
    train_n = len(dataset) - val_n
    train_ds, val_ds = random_split(dataset, [train_n, val_n],
                                    generator=torch.Generator().manual_seed(42))

    # MPS (Apple Silicon): no DataLoader workers (causes issues), no bfloat16, no torch.compile
    # CUDA (DGX Spark):    workers + prefetch for pipelining, bfloat16 autocast, torch.compile
    dl_workers = 4 if device.type == "cuda" else 0
    dl_kwargs  = dict(num_workers=dl_workers, persistent_workers=False, prefetch_factor=(2 if dl_workers > 0 else None))
    train_dl = DataLoader(train_ds, batch_size=batch_size, shuffle=True,  **dl_kwargs)
    val_dl   = DataLoader(val_ds,   batch_size=batch_size, shuffle=False, **dl_kwargs)

    model = MovementCNN(
        channels=17,
        map_height=dataset.map_height,
        map_width=dataset.map_width,
    ).to(device)

    if device.type == "cuda":
        try:
            model = torch.compile(model)
            print("Using torch.compile")
        except Exception:
            pass

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    use_amp  = (device.type == "cuda")
    scaler   = torch.amp.GradScaler(enabled=use_amp)
    autocast = lambda: torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=use_amp)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    best_val_loss = float('inf')
    ckpt_path = out_dir / f'{args.unit_type}.pt'
    should_resume = ckpt_path.exists() and (args.resume or (args.file_idx is not None and args.file_idx > 0))
    if should_resume:
        ckpt = torch.load(ckpt_path, weights_only=False, map_location=device)
        model.load_state_dict(ckpt['model_state'])
        best_val_loss = ckpt['val_loss']
        print(f"Warm-started from checkpoint  best_val_loss={best_val_loss:.4f}")

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = torch.zeros((), device=device)
        t0 = time.time()

        for states, action_types, tile_idxs in train_dl:
            states       = states.to(device)
            action_types = action_types.to(device)
            tile_idxs    = tile_idxs.to(device)

            with autocast():
                out = model(states)
                loss_at = F.cross_entropy(out['action_type'], action_types, weight=class_weights)
                loss_tile = F.cross_entropy(out['target_tile'], tile_idxs, ignore_index=-1)
                loss = loss_at + loss_tile

            optimizer.zero_grad()
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
            total_loss += loss.detach()

        scheduler.step()

        # Validation
        model.eval()
        val_loss = torch.zeros((), device=device)
        correct_at = torch.zeros((), device=device)
        with torch.no_grad():
            for states, action_types, tile_idxs in val_dl:
                states       = states.to(device)
                action_types = action_types.to(device)
                tile_idxs    = tile_idxs.to(device)
                with autocast():
                    out = model(states)
                val_loss += F.cross_entropy(out['action_type'], action_types).detach()
                correct_at += (out['action_type'].argmax(1) == action_types).sum()

        val_loss  = val_loss.item() / len(val_dl)
        val_acc   = correct_at.item() / len(val_ds)
        elapsed   = time.time() - t0

        print(f"Epoch {epoch:3d}/{args.epochs}  train={total_loss.item()/len(train_dl):.4f}"
              f"  val={val_loss:.4f}  acc={val_acc:.3f}  ({elapsed:.1f}s)")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                'model_state': model.state_dict(),
                'config': {
                    'channels': 17,
                    'map_height': dataset.map_height,
                    'map_width':  dataset.map_width,
                },
                'unit_type': args.unit_type,
                'epoch': epoch,
                'val_loss': val_loss,
            }, out_dir / f'{args.unit_type}.pt')

    del train_dl, val_dl

    print(f"\nBest val loss: {best_val_loss:.4f}")
    best_ckpt = torch.load(out_dir / f'{args.unit_type}.pt', weights_only=False, map_location='cpu')
    model.load_state_dict(best_ckpt['model_state'])
    export_onnx(model, dataset.map_height, dataset.map_width, out_dir / f'{args.unit_type}.onnx')
    print(f"Exported: {out_dir / args.unit_type}.onnx")


def export_onnx(model: MovementCNN, map_height: int, map_width: int, output_path: Path):
    model.eval().cpu()
    dummy = torch.randn(1, 17, map_height, map_width)
    logging.getLogger("torch.onnx._internal.exporter._registration").setLevel(logging.ERROR)
    program = torch.onnx.export(
        model, (dummy,),
        dynamo=True,
        input_names=["input"],
        output_names=["action_type", "target_tile"],
    )
    program.save(str(output_path), external_data=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--unit-type',  required=True,
                        choices=['army','fighter','missile','transport','destroyer','submarine','carrier','battleship'])
    parser.add_argument('--data-dir',   required=True)
    parser.add_argument('--out-dir',    default='./checkpoints/moe')
    parser.add_argument('--epochs',     type=int,   default=50)
    parser.add_argument('--batch-size',       type=int,   default=0,    help="Fixed batch size (0 = use --target-vram-usage-gb)")
    parser.add_argument('--target-vram-usage-gb', type=float, default=0,    help="Auto-compute batch size to hit this RAM target")
    parser.add_argument('--lr',         type=float, default=1e-3)
    parser.add_argument('--file-idx',   type=int,   default=None,
                        help='Train on a single worker file (0-based). Warm-starts from existing checkpoint if > 0.')
    parser.add_argument('--num-files',  type=int,   default=None,
                        help='Train sequentially on this many files (0..N-1) in one process.')
    parser.add_argument('--resume',     action='store_true',
                        help='Warm-start from existing checkpoint even at file-idx 0.')
    args = parser.parse_args()
    if args.num_files:
        for file_idx in range(args.num_files):
            print(f"--- {args.unit_type} file {file_idx + 1}/{args.num_files} ---")
            args.file_idx = file_idx
            train(args)
    else:
        train(args)


if __name__ == '__main__':
    main()
