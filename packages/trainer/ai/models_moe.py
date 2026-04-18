"""
MoE model definitions — shared by train_movement.py, train_production.py, evolve_moe.py.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F

NUM_MOVEMENT_ACTIONS = 5   # MOVE, SLEEP, SKIP, LOAD, UNLOAD
NUM_UNIT_TYPES       = 8   # army … battleship
NUM_GLOBAL           = 28  # production expert global feature vector length

UNIT_TYPE_NAMES = ['army', 'fighter', 'missile', 'transport',
                   'destroyer', 'submarine', 'carrier', 'battleship']
ALL_MODEL_NAMES = UNIT_TYPE_NAMES + ['production']


def _circular_pad(x: torch.Tensor, pad: int) -> torch.Tensor:
    x = F.pad(x, (pad, pad, 0, 0), mode="circular")   # wrap X
    x = F.pad(x, (0, 0, pad, pad), mode="constant", value=0)  # zero-pad Y
    return x


class MovementCNN(nn.Module):
    """
    15-channel CNN for a single unit-type movement expert.
    Inputs : [B, 15, H, W]  (14 map channels + 1 unit-marker)
    Outputs: action_type [B, 5], target_tile [B, H*W]
    """

    def __init__(self, channels: int = 15, map_height: int = 22, map_width: int = 50):
        super().__init__()
        self.map_height = map_height
        self.map_width  = map_width

        self.conv1 = nn.Conv2d(channels, 64,  kernel_size=3, padding=0)
        self.conv2 = nn.Conv2d(64,       128, kernel_size=3, padding=0)
        self.conv3 = nn.Conv2d(128,      128, kernel_size=3, padding=0)
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
        self.target_tile_head = nn.Conv2d(128, 1, kernel_size=1)

    def _backbone(self, x):
        x = F.relu(self.bn1(self.conv1(_circular_pad(x, 1))))
        x = F.relu(self.bn2(self.conv2(_circular_pad(x, 1))))
        x = F.relu(self.bn3(self.conv3(_circular_pad(x, 1))))
        return x

    def forward(self, x):
        feat = self._backbone(x)
        return {
            "action_type": self.action_type_head(feat),
            "target_tile": self.target_tile_head(feat).flatten(1),
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

        self.conv1 = nn.Conv2d(channels, 64,  kernel_size=3, padding=0)
        self.conv2 = nn.Conv2d(64,       128, kernel_size=3, padding=0)
        self.conv3 = nn.Conv2d(128,      128, kernel_size=3, padding=0)
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
