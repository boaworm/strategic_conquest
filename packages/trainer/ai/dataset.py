"""
GameDataset — loads imitation learning data produced by collect_data.ts.

File format (all in OUTPUT_DIR/):
  Consolidated mode:
    states.bin    — raw float32, shape [N, C, H, W] with no header
    actions.jsonl — one action JSON per line
    meta.json     — mapWidth, mapHeight, numChannels, numSamples, numGames, wins
  Per-worker mode (if states.bin not found):
    worker-*.states.bin — one file per worker
    worker-*.actions.jsonl — one file per worker
    meta.json — same as above
"""

import json
import glob
from bisect import bisect_right
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


def _encode_actions(actions: list[dict], map_width: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pre-encode action dicts into numpy arrays for fast __getitem__ access."""
    n = len(actions)
    action_types = np.empty(n, dtype=np.int64)
    target_tiles = np.full(n, -1, dtype=np.int64)
    prod_types = np.full(n, -1, dtype=np.int64)

    for i, action in enumerate(actions):
        atype = action.get("type", "END_TURN")
        action_types[i] = ACTION_TO_IDX.get(atype, 0)

        if atype in ("MOVE", "UNLOAD") and "to" in action:
            target_tiles[i] = action["to"]["y"] * map_width + action["to"]["x"]

        if atype == "SET_PRODUCTION":
            prod_types[i] = UNIT_TO_IDX.get(action.get("unitType", ""), -1)

    return action_types, target_tiles, prod_types


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

        states_file = data_dir / "states.bin"
        actions_file = data_dir / "actions.jsonl"

        # Check if consolidated files exist
        if states_file.exists() and actions_file.exists():
            # Consolidated mode — single files
            print("Loading states into RAM...", flush=True)
            mm = np.memmap(
                states_file,
                dtype="float32",
                mode="r",
                shape=(self.num_samples, self.num_channels, self.map_height, self.map_width),
            )
            self.states = np.array(mm)  # copy into RAM
            del mm
            print(f"  Loaded {self.states.nbytes / 1e9:.1f} GB", flush=True)

            with open(actions_file) as f:
                actions = [json.loads(line) for line in f if line.strip()]
        else:
            # Per-worker mode — load all worker files into RAM
            worker_states = sorted(glob.glob(str(data_dir / "worker-*.states.bin")))

            if not worker_states:
                raise FileNotFoundError(
                    f"No states.bin or worker-*.states.bin found in {data_dir}"
                )

            sample_size = self.num_channels * self.map_height * self.map_width
            chunks = []

            print("Loading worker states into RAM...", flush=True)
            for wf in worker_states:
                size = Path(wf).stat().st_size
                count = size // (4 * sample_size)
                mm = np.memmap(wf, dtype="float32", mode="r",
                               shape=(count, self.num_channels, self.map_height, self.map_width))
                chunks.append(np.array(mm))  # copy into RAM
                del mm

            self.states = np.concatenate(chunks, axis=0)
            del chunks
            print(f"  Loaded {self.states.nbytes / 1e9:.1f} GB", flush=True)

            # Load all actions from worker files
            actions = []
            for wa in sorted(glob.glob(str(data_dir / "worker-*.actions.jsonl"))):
                with open(wa) as f:
                    actions.extend([json.loads(line) for line in f if line.strip()])

        if len(actions) != self.num_samples:
            raise ValueError(
                f"Data mismatch: meta says {self.num_samples} samples "
                f"but actions has {len(actions)} lines"
            )

        # Pre-encode actions into numpy arrays (eliminates per-sample dict lookups)
        print("Encoding actions...", flush=True)
        self.action_types, self.target_tiles, self.prod_types = _encode_actions(actions, self.map_width)
        del actions  # free the list of dicts

    def __len__(self) -> int:
        return self.num_samples

    def __getitem__(self, idx: int) -> dict:
        return {
            "state":       torch.from_numpy(self.states[idx].copy()),
            "action_type": torch.tensor(self.action_types[idx], dtype=torch.long),
            "target_tile": torch.tensor(self.target_tiles[idx], dtype=torch.long),
            "prod_type":   torch.tensor(self.prod_types[idx],   dtype=torch.long),
        }
