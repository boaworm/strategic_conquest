"""
MoE model definitions — shared by train_movement.py, train_production.py, evolve_moe.py.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_BASE_CHANNELS    = 13  # fillViewTensor output (channels 0–12); caller adds ch13+ markers
NUM_MOVEMENT_ACTIONS = 2   # MOVE, SKIP
NUM_UNIT_TYPES       = 8   # army … battleship
NUM_GLOBAL           = 28  # production expert global feature vector length

UNIT_TYPE_NAMES = ['army', 'fighter', 'missile', 'transport',
                   'destroyer', 'submarine', 'carrier', 'battleship']
ALL_MODEL_NAMES = UNIT_TYPE_NAMES + ['production']


def _circular_pad(x: torch.Tensor, pad: int) -> torch.Tensor:
    """Circular (wrap-around) padding on the X axis only.

    The Y zero-pad is folded into each conv layer's own ``padding=(1, 0)``.
    ``F.pad`` does not preserve channels_last, so the result is restored to the
    input's memory format — this keeps a channels_last tensor on cuDNN's NHWC
    bf16 conv path with no layout-conversion kernels.
    """
    out = F.pad(x, (pad, pad, 0, 0), mode="circular")   # wrap X
    if x.is_contiguous(memory_format=torch.channels_last):
        out = out.contiguous(memory_format=torch.channels_last)
    return out


class MovementCNN(nn.Module):
    """
    17-channel CNN for a single unit-type movement expert.
    Inputs : [B, 17, H, W]
      ch0-12: base state (terrain, units, ownership)
      ch13:   unit position marker
      ch14:   army-carried / transport-cargo flag
      ch15:   dx from unit to each tile (cylindrical-wrapped, normalised to [-0.5, 0.5])
      ch16:   dy from unit to each tile (normalised to [-0.5, 0.5])
    Outputs: action_type [B, 2], target_tile [B, H*W]

    target_tile head uses global average-pooled context concatenated with per-tile
    features so each tile score accounts for the full board state, not just its
    local 7x7 neighbourhood.
    """

    def __init__(self, channels: int = 17, map_height: int = 22, map_width: int = 50):
        super().__init__()
        self.map_height = map_height
        self.map_width  = map_width

        self.conv1 = nn.Conv2d(channels, 64,  kernel_size=3, padding=(1, 0))
        self.conv2 = nn.Conv2d(64,       128, kernel_size=3, padding=(1, 0))
        self.conv3 = nn.Conv2d(128,      128, kernel_size=3, padding=(1, 0))
        self.bn1   = nn.BatchNorm2d(64)
        self.bn2   = nn.BatchNorm2d(128)
        self.bn3   = nn.BatchNorm2d(128)

        self.action_type_head = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, NUM_MOVEMENT_ACTIONS),
        )
        # 128 local features + 128 global context → score per tile
        self.target_tile_head = nn.Conv2d(256, 1, kernel_size=1)

    def _backbone(self, x):
        x = F.relu(self.bn1(self.conv1(_circular_pad(x, 1))))
        x = F.relu(self.bn2(self.conv2(_circular_pad(x, 1))))
        x = F.relu(self.bn3(self.conv3(_circular_pad(x, 1))))
        return x

    def forward(self, x):
        feat = self._backbone(x)  # [B, 128, H, W]

        # Broadcast global avg pool across spatial dims so every tile sees full board
        global_ctx = feat.mean(dim=[2, 3], keepdim=True).expand_as(feat)  # [B, 128, H, W]
        combined   = torch.cat([feat, global_ctx], dim=1)                  # [B, 256, H, W]

        return {
            "action_type": self.action_type_head(feat),
            "target_tile": self.target_tile_head(combined).flatten(1),
        }


class ProductionCNN(nn.Module):
    """
    CNN + global-feature MLP for the production expert.
    Inputs : spatial [B, 15, H, W], global_features [B, 22]
    Outputs: unit_type [B, 8]
    """

    def __init__(self, channels: int = 15, map_height: int = 22, map_width: int = 50,
                 num_global: int = NUM_GLOBAL):
        super().__init__()
        self.map_height = map_height
        self.map_width  = map_width

        self.conv1 = nn.Conv2d(channels, 64,  kernel_size=3, padding=(1, 0))
        self.conv2 = nn.Conv2d(64,       128, kernel_size=3, padding=(1, 0))
        self.conv3 = nn.Conv2d(128,      128, kernel_size=3, padding=(1, 0))
        self.bn1   = nn.BatchNorm2d(64)
        self.bn2   = nn.BatchNorm2d(128)
        self.bn3   = nn.BatchNorm2d(128)
        self.spatial_pool = nn.AdaptiveAvgPool2d(1)

        self.global_mlp = nn.Sequential(
            nn.Linear(num_global, 64), nn.ReLU(),
            nn.Linear(64, 64),         nn.ReLU(),
            nn.Linear(64, 64),         nn.ReLU(),
        )
        self.head = nn.Sequential(
            nn.Linear(128 + 64, 64), nn.ReLU(),
            nn.Linear(64, NUM_UNIT_TYPES),
        )

    def _backbone(self, x):
        x = F.relu(self.bn1(self.conv1(_circular_pad(x, 1))))
        x = F.relu(self.bn2(self.conv2(_circular_pad(x, 1))))
        x = F.relu(self.bn3(self.conv3(_circular_pad(x, 1))))
        return x

    def forward(self, spatial, global_features):
        feat = self._backbone(spatial)
        sp   = self.spatial_pool(feat).flatten(1)
        gf   = self.global_mlp(global_features)
        return {"unit_type": self.head(torch.cat([sp, gf], dim=1))}


def load_model(ckpt_path: str, map_cpu: bool = True):
    """Load a MovementCNN or ProductionCNN from a .pt checkpoint."""
    device = "cpu" if map_cpu else None
    ckpt = torch.load(ckpt_path, weights_only=False,
                      map_location="cpu" if map_cpu else None)
    config = ckpt['config']
    if 'unit_type' in ckpt:
        model = MovementCNN(**config)
    else:
        model = ProductionCNN(**config)
    model.load_state_dict(ckpt['model_state'])
    return model, config
