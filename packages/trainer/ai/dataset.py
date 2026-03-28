"""
GameDataset — loads imitation learning data produced by collect_data.ts.

File format (all in OUTPUT_DIR/):
  states.bin    — raw float32, shape [N, C, H, W] with no header
  actions.jsonl — one action JSON per line
  meta.json     — mapWidth, mapHeight, numChannels, numSamples, numGames, wins
"""

import json
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

# Action type encoding (must stay in sync with AgentAction in @sc/shared)
ACTION_TYPES = [
    "END_TURN",
    "SET_PRODUCTION",
    "MOVE",
    "LOAD",
    "UNLOAD",
    "SLEEP",
    "WAKE",
    "SKIP",
    "DISBAND",
]
ACTION_TO_IDX = {a: i for i, a in enumerate(ACTION_TYPES)}
NUM_ACTION_TYPES = len(ACTION_TYPES)

# Unit type encoding for SET_PRODUCTION (must match UNIT_STATS keys in @sc/shared)
UNIT_TYPES = [
    "army",
    "fighter",
    "bomber",
    "transport",
    "destroyer",
    "submarine",
    "carrier",
    "battleship",
]
UNIT_TO_IDX = {u: i for i, u in enumerate(UNIT_TYPES)}
NUM_UNIT_TYPES = len(UNIT_TYPES)


class GameDataset(Dataset):
    """
    Streams imitation-learning samples from disk.

    Each item returns:
      state       — float32 tensor [C, H, W]
      action_type — long scalar ∈ [0, NUM_ACTION_TYPES)
      target_tile — long scalar ∈ [0, H*W), or -1 if not applicable (non-MOVE/UNLOAD)
      prod_type   — long scalar ∈ [0, NUM_UNIT_TYPES), or -1 if not applicable
    """

    def __init__(self, data_dir: str):
        data_dir = Path(data_dir)

        with open(data_dir / "meta.json") as f:
            meta = json.load(f)

        self.map_width   = meta["mapWidth"]
        self.map_height  = meta["mapHeight"]
        self.num_channels = meta["numChannels"]
        self.num_samples  = meta["numSamples"]

        # Memory-map the states file — avoids loading everything into RAM.
        # Each sample is num_channels * map_height * map_width float32 values.
        self.states = np.memmap(
            data_dir / "states.bin",
            dtype="float32",
            mode="r",
            shape=(self.num_samples, self.num_channels, self.map_height, self.map_width),
        )

        # Load action JSONs into memory — much smaller than the tensors.
        with open(data_dir / "actions.jsonl") as f:
            self.actions = [json.loads(line) for line in f if line.strip()]

        if len(self.actions) != self.num_samples:
            raise ValueError(
                f"Data mismatch: meta says {self.num_samples} samples "
                f"but actions.jsonl has {len(self.actions)} lines"
            )

    def __len__(self) -> int:
        return self.num_samples

    def __getitem__(self, idx: int) -> dict:
        # .copy() is required when using memmap with num_workers > 0
        state = torch.from_numpy(self.states[idx].copy())

        action = self.actions[idx]
        action_type = action.get("type", "END_TURN")

        action_type_idx = ACTION_TO_IDX.get(action_type, 0)

        # Target tile: flat index y*W + x, only for MOVE / UNLOAD
        target_tile = -1
        if action_type in ("MOVE", "UNLOAD") and "to" in action:
            tx = action["to"]["x"]
            ty = action["to"]["y"]
            target_tile = ty * self.map_width + tx

        # Production type: only for SET_PRODUCTION
        prod_type = -1
        if action_type == "SET_PRODUCTION":
            prod_type = UNIT_TO_IDX.get(action.get("unitType", ""), -1)

        return {
            "state":       state,
            "action_type": torch.tensor(action_type_idx, dtype=torch.long),
            "target_tile": torch.tensor(target_tile,     dtype=torch.long),
            "prod_type":   torch.tensor(prod_type,       dtype=torch.long),
        }
