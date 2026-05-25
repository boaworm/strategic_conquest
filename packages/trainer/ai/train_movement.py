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

import gc
import torch
import torch.nn as nn
import torch.nn.functional as F

from dataset_moe import MovementDataset, MOVEMENT_ACTION_TYPES, NUM_MOVEMENT_ACTIONS
from models_moe import MovementCNN


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
        if device.type == "mps":
            # Dataset stays in CPU/unified RAM; batches are copied to MPS per step.
            # Budget from total system RAM rather than a VRAM ceiling.
            import os
            try:
                total_bytes = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
            except (AttributeError, ValueError):
                total_bytes = 16 * 1024 ** 3
            # Reserve: dataset + 4 GB OS/other + 2 GB model/optimizer
            fixed_bytes = dataset.states17.nbytes + 6 * 1024 ** 3
            available   = total_bytes - fixed_bytes
        else:
            fixed_bytes = dataset.states17.nbytes + 2 * 1024 ** 3
            available   = int(args.target_vram_usage_gb * 1024 ** 3) - fixed_bytes
        batch_size = max(256, (available // 3_400_000) // 256 * 256)
        print(f"Auto batch size: {batch_size:,}  (target {args.target_vram_usage_gb} GB, dataset {dataset.states17.nbytes / 1024**3:.1f} GB)")

    use_amp = (device.type == "cuda")
    map_height, map_width = dataset.map_height, dataset.map_width

    # ── Tier 2: hold the whole shard resident on the device and index it there.
    # No DataLoader, no worker processes, no per-batch host->device copy.
    # MPS exception: Metal caps any single MTLBuffer at ~recommendedMaxWorkingSetSize
    # (<50 GB on a 64 GB M1 Max), so multi-tens-of-GB shards can't be one device
    # tensor. Keep them in unified RAM and copy per batch; CUDA path unchanged.
    storage_device = torch.device("cpu") if device.type == "mps" else device
    states_all  = dataset.states17.to(storage_device)
    actions_all = dataset.action_types.to(storage_device)
    tiles_all   = dataset.tile_idxs.to(storage_device)
    dataset.states17 = None          # free the CPU copy of the shard
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

    model = MovementCNN(channels=17, map_height=map_height, map_width=map_width).to(device)

    # bf16 autocast has fp32 range -- no GradScaler needed (it would force a per-step sync).
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, fused=(device.type == "cuda"))
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    autocast  = lambda: torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=use_amp)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    best_val_loss = float('inf')
    ckpt_path = out_dir / f'{args.unit_type}.pt'
    should_resume = ckpt_path.exists() and (args.resume or (args.file_idx is not None and args.file_idx > 0))
    if should_resume:
        ckpt = torch.load(ckpt_path, weights_only=False, map_location=device)
        state = {k.replace('_orig_mod.', '', 1): v for k, v in ckpt['model_state'].items()}
        model.load_state_dict(state)
        best_val_loss = ckpt['val_loss']
        print(f"Warm-started from checkpoint  best_val_loss={best_val_loss:.4f}")

    if device.type == "cuda" and not args.profile:
        try:
            # default mode (reduce-overhead cudagraphs break across per-file recompiles; little gain when bandwidth-bound)
            model = torch.compile(model)
            print("Using torch.compile")
        except Exception:
            pass

    # Diagnostic: profile a few eager steps, dump a Chrome trace, and exit.
    # Eager (uncompiled) so every CUDA kernel is individually visible in the trace.
    isOnCuda = (device.type == "cuda")
    if args.profile:
        from torch.profiler import profile, ProfilerActivity, schedule
        prof_dir = Path(__file__).resolve().parents[3] / "tmp"
        prof_dir.mkdir(parents=True, exist_ok=True)
        trace_path = prof_dir / f"profile_{args.unit_type}.json"
        # Deliberately small batch: the per-kernel mix we want to measure is
        # ~batch-independent, whereas a big eager batch holds ~batch x activation
        # memory and would OOM. This keeps the profiler path lightweight (~40 GB).
        prof_bs = min(1024, train_n)
        wait, warmup = 5, 5
        active = max(1, min(20, train_n // prof_bs - wait - warmup))
        model.train()
        perm = train_idx[torch.randperm(train_n, device=storage_device)]
        print(f"Profiling {active} eager steps (batch {prof_bs:,})...")
        with profile(activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA],
                     schedule=schedule(wait=wait, warmup=warmup, active=active, repeat=1)) as prof:
            for b in range(wait + warmup + active):
                idx = perm[b * prof_bs : (b + 1) * prof_bs]
                states       = states_all.index_select(0, idx).to(device, non_blocking=isOnCuda)
                action_types = actions_all.index_select(0, idx).to(device, non_blocking=isOnCuda)
                tile_idxs    = tiles_all.index_select(0, idx).to(device, non_blocking=isOnCuda)
                with autocast():
                    out = model(states)
                    loss_at   = F.cross_entropy(out['action_type'], action_types, weight=class_weights)
                    loss_tile = F.cross_entropy(out['target_tile'], tile_idxs, ignore_index=-1)
                    loss = loss_at + loss_tile
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                if device.type == "mps":
                    torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
                optimizer.step()
                prof.step()
        prof.export_chrome_trace(str(trace_path))
        try:
            print(prof.key_averages().table(sort_by="self_cuda_time_total", row_limit=25))
        except Exception:
            print(prof.key_averages().table(row_limit=25))
        print(f"\nChrome trace: {trace_path}  (open in chrome://tracing or ui.perfetto.dev)")
        return

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = torch.zeros((), device=device)
        t0 = time.time()

        perm = train_idx[torch.randperm(train_n, device=storage_device)]
        for b in range(train_batches):
            idx = perm[b * batch_size : (b + 1) * batch_size]
            states       = states_all.index_select(0, idx).to(device, non_blocking=isOnCuda)
            action_types = actions_all.index_select(0, idx).to(device, non_blocking=isOnCuda)
            tile_idxs    = tiles_all.index_select(0, idx).to(device, non_blocking=isOnCuda)

            with autocast():
                out = model(states)
                loss_at = F.cross_entropy(out['action_type'], action_types, weight=class_weights)
                loss_tile = F.cross_entropy(out['target_tile'], tile_idxs, ignore_index=-1)
                loss = loss_at + loss_tile

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
        val_loss   = torch.zeros((), device=device)
        correct_at = torch.zeros((), device=device)
        with torch.no_grad():
            for b in range(val_batches):
                idx = val_idx[b * batch_size : (b + 1) * batch_size]
                states       = states_all.index_select(0, idx).to(device, non_blocking=isOnCuda)
                action_types = actions_all.index_select(0, idx).to(device, non_blocking=isOnCuda)
                with autocast():
                    out = model(states)
                val_loss   += F.cross_entropy(out['action_type'], action_types).detach()
                correct_at += (out['action_type'].argmax(1) == action_types).sum()

        val_loss = val_loss.item() / val_batches
        val_acc  = correct_at.item() / (val_batches * batch_size)
        print(f"Epoch {epoch:3d}/{args.epochs}  train={train_loss:.4f}"
              f"  val={val_loss:.4f}  acc={val_acc:.3f}  ({time.time()-t0:.1f}s)")

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            torch.save({
                'model_state': model.state_dict(),
                'config': {
                    'channels': 17,
                    'map_height': map_height,
                    'map_width':  map_width,
                },
                'unit_type': args.unit_type,
                'epoch': epoch,
                'val_loss': val_loss,
            }, ckpt_path)

    del states_all, actions_all, tiles_all, train_idx, val_idx, split, optimizer
    gc.collect()
    _empty_cache(device)

    print(f"\nBest val loss: {best_val_loss:.4f}")
    best_ckpt = torch.load(out_dir / f'{args.unit_type}.pt', weights_only=False, map_location='cpu')
    best_state = best_ckpt['model_state']
    if any(k.startswith('_orig_mod.') for k in best_state):
        best_state = {k.replace('_orig_mod.', '', 1): v for k, v in best_state.items()}
    # `model` may be a torch.compile OptimizedModule; the stripped state_dict has
    # bare keys, so load/export the underlying module to keep keys consistent.
    base_model = getattr(model, '_orig_mod', model)
    base_model.load_state_dict(best_state)
    export_onnx(base_model, map_height, map_width, out_dir / f'{args.unit_type}.onnx')
    print(f"Exported: {out_dir / args.unit_type}.onnx")
    del model
    gc.collect()
    _empty_cache(device)


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
    parser.add_argument('--val-every',  type=int,   default=5,
                        help='Run validation every N epochs (always on the final epoch).')
    parser.add_argument('--file-idx',   type=int,   default=None,
                        help='Train on a single worker file (0-based). Warm-starts from existing checkpoint if > 0.')
    parser.add_argument('--num-files',    type=int,   default=None,
                        help='Train sequentially on this many files (0..N-1) in one process.')
    parser.add_argument('--start-at-file', type=int, default=0,
                        help='Skip files before this 0-based index (default 0 = no skip).')
    parser.add_argument('--resume',     action='store_true',
                        help='Warm-start from existing checkpoint even at file-idx 0.')
    parser.add_argument('--profile',    action='store_true',
                        help='Profile ~20 eager steps, write a Chrome trace to tmp/, and exit.')
    args = parser.parse_args()
    if args.profile:
        args.file_idx = 0
        train(args)
    elif args.num_files:
        for file_idx in range(args.start_at_file, args.num_files):
            print(f"--- {args.unit_type} file {file_idx + 1}/{args.num_files} ---")
            args.file_idx = file_idx
            train(args)
    else:
        train(args)


if __name__ == '__main__':
    main()
