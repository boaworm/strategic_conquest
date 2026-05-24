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
import gc
import os
import time
import warnings
import logging
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

from dataset_moe import ProductionDataset, NUM_UNIT_TYPES, NUM_GLOBAL
from models_moe import ProductionCNN


def _empty_cache(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.empty_cache()
    elif device.type == "mps":
        torch.mps.empty_cache()


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
    print(f"Device: {device}  Task: production expert")

    dataset = ProductionDataset(args.data_dir, file_idx=args.file_idx, use_bf16=(device.type == "cuda"))
    file_label = f"file {args.file_idx + 1}" if args.file_idx is not None else "all files"
    print(f"Loaded {len(dataset):,} production samples ({file_label})")

    use_amp    = (device.type == "cuda")
    map_height, map_width = dataset.map_height, dataset.map_width
    batch_size = args.batch_size
    if args.target_vram_usage_gb > 0:
        bytes_per_sample = 3_400_000 if use_amp else 6_800_000
        dataset_bytes    = dataset.states15.numel() * dataset.states15.element_size()
        fixed_bytes      = dataset_bytes + 2 * 1024 ** 3
        target_bytes     = int(args.target_vram_usage_gb * 1024 ** 3)

        # Batch size: activation budget, capped so we have at least min_batches per epoch
        train_n_approx = int(len(dataset) * 0.9)
        batch_size     = max(256, ((target_bytes - fixed_bytes) // bytes_per_sample) // 256 * 256)
        if args.min_batches > 0:
            batch_size = min(batch_size, max(256, (train_n_approx // args.min_batches) // 256 * 256))

        print(f"Auto batch size: {batch_size:,}  "
              f"(target {args.target_vram_usage_gb} GB, dataset {dataset_bytes / 1024**3:.1f} GB, {'bf16' if use_amp else 'fp32'})")

    # ── Tier 2: hold the whole shard resident on the device and index it there.
    # MPS exception: Metal caps any single MTLBuffer at ~recommendedMaxWorkingSetSize
    # (<50 GB on a 64 GB M1 Max), so multi-tens-of-GB shards can't be one device
    # tensor. Keep them in unified RAM and copy per batch; CUDA path unchanged.
    storage_device = torch.device("cpu") if device.type == "mps" else device
    states_all  = dataset.states15.to(storage_device)
    globals_all = torch.from_numpy(dataset.globals).to(storage_device)
    types_all   = torch.from_numpy(dataset.unit_types).to(storage_device)
    dataset.states15 = None          # free the CPU copy of the shard
    del dataset
    gc.collect()

    N = states_all.shape[0]
    val_n   = max(1, int(N * 0.1))
    train_n = N - val_n
    split   = torch.randperm(N, generator=torch.Generator().manual_seed(42))
    train_idx = split[:train_n].to(storage_device)
    val_idx   = split[train_n:].to(storage_device)
    train_batches = train_n // batch_size            # drop_last: every batch is full-size
    val_batches   = max(1, val_n // batch_size)
    if train_batches == 0:
        raise ValueError(f"batch_size {batch_size} exceeds train split {train_n}")

    model = ProductionCNN(channels=15, map_height=map_height, map_width=map_width).to(device)

    # bf16 autocast has fp32 range -- no GradScaler needed (it would force a per-step sync).
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.weight_decay,
                                 fused=(device.type == "cuda"))
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    autocast  = lambda: torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=use_amp)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    best_val_loss = float('inf')
    ckpt_path = out_dir / 'production.pt'
    should_resume = ckpt_path.exists() and (args.resume or (args.file_idx is not None and args.file_idx > 0))
    if should_resume:
        ckpt = torch.load(ckpt_path, weights_only=False, map_location=device)
        state_dict = ckpt['model_state']
        state_dict = {k.replace("_orig_mod.", ""): v for k, v in state_dict.items()}
        model.load_state_dict(state_dict)
        best_val_loss = ckpt['val_loss']
        print(f"Warm-started from checkpoint  best_val_loss={best_val_loss:.4f}")

    if device.type == "cuda":
        try:
            # default mode (reduce-overhead cudagraphs break across per-file recompiles; little gain when bandwidth-bound)
            model = torch.compile(model)
            print("Using torch.compile")
        except Exception:
            pass

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = torch.zeros((), device=device)
        t0 = time.time()

        perm = train_idx[torch.randperm(train_n, device=storage_device)]
        for b in range(train_batches):
            idx = perm[b * batch_size : (b + 1) * batch_size]
            states     = states_all.index_select(0, idx).to(device, non_blocking=True)
            globals_   = globals_all.index_select(0, idx).to(device, non_blocking=True)
            unit_types = types_all.index_select(0, idx).to(device, non_blocking=True)

            with autocast():
                out = model(states, globals_)
                loss = F.cross_entropy(out['unit_type'], unit_types)

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            if device.type == "mps":
                torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            total_loss += loss.detach()

        scheduler.step()
        train_loss = total_loss.item() / train_batches

        # Validate periodically (and on the final epoch) -- used only for model selection.
        if epoch % args.val_every != 0 and epoch != args.epochs:
            print(f"Epoch {epoch:3d}/{args.epochs}  train={train_loss:.4f}  ({time.time()-t0:.1f}s)")
            continue

        model.eval()
        val_loss = torch.zeros((), device=device)
        correct  = torch.zeros((), device=device)
        with torch.no_grad():
            for b in range(val_batches):
                idx = val_idx[b * batch_size : (b + 1) * batch_size]
                states     = states_all.index_select(0, idx).to(device, non_blocking=True)
                globals_   = globals_all.index_select(0, idx).to(device, non_blocking=True)
                unit_types = types_all.index_select(0, idx).to(device, non_blocking=True)
                with autocast():
                    out = model(states, globals_)
                val_loss += F.cross_entropy(out['unit_type'], unit_types).detach()
                correct  += (out['unit_type'].argmax(1) == unit_types).sum()

        val_loss = val_loss.item() / val_batches
        val_acc  = correct.item() / (val_batches * batch_size)
        print(f"Epoch {epoch:3d}/{args.epochs}  train={train_loss:.4f}"
              f"  val={val_loss:.4f}  acc={val_acc:.3f}  ({time.time()-t0:.1f}s)")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                'model_state': model.state_dict(),
                'config': {
                    'channels':   15,
                    'map_height': map_height,
                    'map_width':  map_width,
                    'num_global': NUM_GLOBAL,
                },
                'epoch':    epoch,
                'val_loss': val_loss,
            }, ckpt_path)

    del states_all, globals_all, types_all, train_idx, val_idx, split, optimizer
    gc.collect()
    _empty_cache(device)

    print(f"\nBest val loss: {best_val_loss:.4f}")
    best_ckpt = torch.load(out_dir / 'production.pt', weights_only=False, map_location='cpu')
    best_state = best_ckpt['model_state']
    if any(k.startswith('_orig_mod.') for k in best_state):
        best_state = {k.replace('_orig_mod.', '', 1): v for k, v in best_state.items()}
    # `model` may be a torch.compile OptimizedModule; load/export the underlying module.
    base_model = getattr(model, '_orig_mod', model)
    base_model.load_state_dict(best_state)
    export_onnx(base_model, map_height, map_width, out_dir / 'production.onnx')
    print(f"Exported: {out_dir}/production.onnx")
    del model
    gc.collect()
    _empty_cache(device)


def export_onnx(model: ProductionCNN, map_height: int, map_width: int, output_path: Path):
    model.eval().cpu()
    dummy_spatial = torch.randn(1, 15, map_height, map_width)
    dummy_global  = torch.randn(1, NUM_GLOBAL)
    logging.getLogger("torch.onnx._internal.exporter._registration").setLevel(logging.ERROR)
    program = torch.onnx.export(
        model,
        (dummy_spatial, dummy_global),
        dynamo=True,
        input_names=["input", "global_features"],
        output_names=["unit_type"],
    )
    program.save(str(output_path), external_data=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir',   required=True)
    parser.add_argument('--out-dir',    default='./checkpoints/moe')
    parser.add_argument('--epochs',     type=int,   default=50)
    parser.add_argument('--batch-size',           type=int,   default=0,    help="Fixed batch size (0 = use --target-vram-usage-gb)")
    parser.add_argument('--min-batches',          type=int,   default=20,   help="Minimum batches per epoch; caps auto batch size so pipeline stays full")
    parser.add_argument('--target-vram-usage-gb', type=float, default=0,    help="Auto-compute batch size to hit this RAM target")
    parser.add_argument('--lr',         type=float, default=1e-3)
    parser.add_argument('--weight-decay', type=float, default=0.0)
    parser.add_argument('--val-every',  type=int,   default=5,
                        help='Run validation every N epochs (always on the final epoch).')
    parser.add_argument('--file-idx',   type=int,   default=None,
                        help='Train on a single worker file (0-based). Warm-starts from existing checkpoint if > 0.')
    parser.add_argument('--num-files',  type=int,   default=None,
                        help='Train sequentially on this many files (0..N-1) in one process.')
    parser.add_argument('--resume',     action='store_true',
                        help='Warm-start from existing checkpoint even at file-idx 0.')
    args = parser.parse_args()
    if args.num_files:
        for file_idx in range(args.num_files):
            print(f"--- production file {file_idx + 1}/{args.num_files} ---")
            args.file_idx = file_idx
            train(args)
    else:
        train(args)


if __name__ == '__main__':
    main()
