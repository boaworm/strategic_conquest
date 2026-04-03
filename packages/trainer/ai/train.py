"""
Phase 2: Imitation Learning — Policy CNN Trainer

Trains a CNN to mimic BasicAgent decisions given game state tensors.

Three output heads:
  action_type  — which action to take (cross-entropy, NUM_ACTION_TYPES classes)
  target_tile  — which map tile to move to (cross-entropy, H*W classes; MOVE/UNLOAD only)
  prod_type    — which unit to produce (cross-entropy, NUM_UNIT_TYPES classes; SET_PRODUCTION only)

Usage:
  python train.py --data-dir ./data --out-dir ./checkpoints --epochs 50
"""

import argparse
import time
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, random_split

from dataset import GameDataset, ACTION_TYPES, UNIT_TYPES, NUM_ACTION_TYPES, NUM_UNIT_TYPES


# ── Model ─────────────────────────────────────────────────────────────────────

def _circular_pad(x: torch.Tensor, pad: int) -> torch.Tensor:
    """
    Pad a [B, C, H, W] tensor:
      - Circular on W (X axis) — cylindrical map wrapping
      - Zero     on H (Y axis) — map has hard north/south edges
    """
    x = F.pad(x, (pad, pad, 0, 0), mode="circular")   # wrap width
    x = F.pad(x, (0, 0, pad, pad), mode="constant", value=0)  # zero-pad height
    return x


class PolicyCNN(nn.Module):
    """
    CNN policy network.

    Backbone: 3 convolutional layers with cylindrical X-padding.
    Heads:
      action_type  — global average pool → MLP → NUM_ACTION_TYPES logits
      target_tile  — 1×1 conv over the spatial feature map → [H*W] logits
      prod_type    — global average pool → MLP → NUM_UNIT_TYPES logits
    """

    def __init__(self, channels: int, map_height: int, map_width: int):
        super().__init__()
        self.map_height = map_height
        self.map_width  = map_width

        # ── Backbone ──────────────────────────────────────────────────────────
        # All Conv2d use padding=0; we apply _circular_pad before each layer.
        self.conv1 = nn.Conv2d(channels, 64,  kernel_size=3, padding=0)
        self.conv2 = nn.Conv2d(64,       128, kernel_size=3, padding=0)
        self.conv3 = nn.Conv2d(128,      128, kernel_size=3, padding=0)
        self.bn1   = nn.BatchNorm2d(64)
        self.bn2   = nn.BatchNorm2d(128)
        self.bn3   = nn.BatchNorm2d(128)

        # ── Heads ─────────────────────────────────────────────────────────────
        # action_type and prod_type use global average pooling → small MLP
        self.action_type_head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, NUM_ACTION_TYPES),
        )

        # target_tile uses a 1×1 conv to keep spatial structure intact
        self.target_tile_head = nn.Conv2d(128, 1, kernel_size=1)

        self.prod_type_head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, NUM_UNIT_TYPES),
        )

    def _backbone(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.bn1(self.conv1(_circular_pad(x, 1))))
        x = F.relu(self.bn2(self.conv2(_circular_pad(x, 1))))
        x = F.relu(self.bn3(self.conv3(_circular_pad(x, 1))))
        return x  # [B, 128, H, W]

    def forward(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        features = self._backbone(x)
        return {
            "action_type": self.action_type_head(features),
            # Flatten [B, 1, H, W] → [B, H*W]
            "target_tile": self.target_tile_head(features).flatten(1),
            "prod_type":   self.prod_type_head(features),
        }


# ── Training loop ─────────────────────────────────────────────────────────────

def compute_loss(
    out: dict[str, torch.Tensor],
    action_type_label: torch.Tensor,
    target_tile_label: torch.Tensor,
    prod_type_label:   torch.Tensor,
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    loss_action = F.cross_entropy(out["action_type"], action_type_label)

    move_mask = target_tile_label >= 0
    if move_mask.any():
        loss_tile = F.cross_entropy(out["target_tile"][move_mask], target_tile_label[move_mask])
    else:
        loss_tile = torch.tensor(0.0, device=device)

    prod_mask = prod_type_label >= 0
    if prod_mask.any():
        loss_prod = F.cross_entropy(out["prod_type"][prod_mask], prod_type_label[prod_mask])
    else:
        loss_prod = torch.tensor(0.0, device=device)

    total = loss_action + 0.5 * loss_tile + 0.5 * loss_prod
    return total, loss_action, loss_tile, loss_prod


def run_epoch(
    model: nn.Module,
    loader: DataLoader,
    optimizer: torch.optim.Optimizer | None,
    device: torch.device,
) -> dict[str, float]:
    training = optimizer is not None
    model.train() if training else model.eval()

    total_loss = action_loss = tile_loss = prod_loss = 0.0
    correct_action = total_samples = 0

    ctx = torch.enable_grad() if training else torch.no_grad()
    with ctx:
        for batch in loader:
            state        = batch["state"].to(device)
            action_label = batch["action_type"].to(device)
            tile_label   = batch["target_tile"].to(device)
            prod_label   = batch["prod_type"].to(device)

            out = model(state)
            loss, la, lt, lp = compute_loss(out, action_label, tile_label, prod_label, device)

            if training:
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()

            n = len(state)
            total_loss    += loss.item() * n
            action_loss   += la.item()  * n
            tile_loss     += lt.item()  * n
            prod_loss     += lp.item()  * n
            correct_action += (out["action_type"].argmax(1) == action_label).sum().item()
            total_samples  += n

    return {
        "loss":        total_loss    / total_samples,
        "action_loss": action_loss   / total_samples,
        "tile_loss":   tile_loss     / total_samples,
        "prod_loss":   prod_loss     / total_samples,
        "action_acc":  correct_action / total_samples,
    }


def train(args: argparse.Namespace) -> None:
    # GPU selection: CUDA (NVIDIA) > MPS (Apple Silicon) > CPU
    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    print(f"Device: {device}")

    # ── Data ──────────────────────────────────────────────────────────────────
    dataset = GameDataset(args.data_dir)
    print(
        f"Dataset: {len(dataset):,} samples | "
        f"map {dataset.map_width}×{dataset.map_height} | "
        f"{dataset.num_channels} channels"
    )

    val_size   = max(1, int(len(dataset) * 0.1))
    train_size = len(dataset) - val_size
    train_ds, val_ds = random_split(dataset, [train_size, val_size])

    loader_kwargs = dict(batch_size=args.batch_size, num_workers=args.workers, pin_memory=False)
    train_loader = DataLoader(train_ds, shuffle=True,  **loader_kwargs)
    val_loader   = DataLoader(val_ds,   shuffle=False, **loader_kwargs)

    # ── Model ─────────────────────────────────────────────────────────────────
    model = PolicyCNN(dataset.num_channels, dataset.map_height, dataset.map_width).to(device)
    num_params = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {num_params:,}")

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    best_val_loss = float("inf")

    # ── Epoch loop ────────────────────────────────────────────────────────────
    for epoch in range(1, args.epochs + 1):
        t0 = time.time()
        tr = run_epoch(model, train_loader, optimizer, device)
        vl = run_epoch(model, val_loader,   None,      device)
        scheduler.step()

        elapsed = time.time() - t0
        print(
            f"Epoch {epoch:3d}/{args.epochs} | "
            f"loss {tr['loss']:.4f}/{vl['loss']:.4f} | "
            f"action_acc {tr['action_acc']:.3f}/{vl['action_acc']:.3f} | "
            f"act {tr['action_loss']:.3f} tile {tr['tile_loss']:.3f} prod {tr['prod_loss']:.3f} | "
            f"{elapsed:.1f}s"
        )

        if vl["loss"] < best_val_loss:
            best_val_loss = vl["loss"]
            torch.save(
                {
                    "epoch":           epoch,
                    "model_state":     model.state_dict(),
                    "optimizer_state": optimizer.state_dict(),
                    "val_loss":        best_val_loss,
                    "val_action_acc":  vl["action_acc"],
                    "config": {
                        "channels":    dataset.num_channels,
                        "map_height":  dataset.map_height,
                        "map_width":   dataset.map_width,
                    },
                },
                out_dir / "best_model.pt",
            )
            print(f"  → Saved best (val_loss={best_val_loss:.4f}, action_acc={vl['action_acc']:.3f})")

    print(f"\nDone. Best val_loss: {best_val_loss:.4f}")
    print(f"Checkpoint: {out_dir / 'best_model.pt'}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train NN policy from imitation data")
    parser.add_argument("--data-dir",   default="./data",        help="Directory with states.bin, actions.jsonl, meta.json")
    parser.add_argument("--out-dir",    default="./checkpoints",  help="Directory for saved checkpoints")
    parser.add_argument("--epochs",     type=int,   default=50)
    parser.add_argument("--batch-size", type=int,   default=256)
    parser.add_argument("--lr",         type=float, default=1e-3)
    parser.add_argument("--workers",    type=int,   default=0,    help="DataLoader worker processes (0 for MPS compatibility)")
    args = parser.parse_args()
    train(args)
