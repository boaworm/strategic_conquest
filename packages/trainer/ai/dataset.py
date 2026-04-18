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
    "missile",
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

    def __init__(self, data_dir: str, worker_idx: int | None = None):
        data_dir = Path(data_dir)

        with open(data_dir / "meta.json") as f:
            meta = json.load(f)

        self.map_width    = meta["mapWidth"]
        self.map_height   = meta["mapHeight"]
        self.num_channels = meta["numChannels"]

        sample_size = self.num_channels * self.map_height * self.map_width

        if worker_idx is not None:
            # Single worker file mode — load into RAM (fits ~33GB)
            states_path = data_dir / f"worker-{worker_idx}.states.bin"
            actions_path = data_dir / f"worker-{worker_idx}.actions.jsonl"
            size = states_path.stat().st_size
            count = size // (4 * sample_size)
            shape = (count, self.num_channels, self.map_height, self.map_width)
            self.num_samples = count
            print(f"  Loading worker-{worker_idx} into RAM...", flush=True)
            mm = np.memmap(str(states_path), dtype="float32", mode="r", shape=shape)
            self.states = np.array(mm)
            del mm
            print(f"  Loaded {self.states.nbytes / 1e9:.1f} GB ({count:,} samples)", flush=True)

            with open(actions_path) as f:
                actions = [json.loads(line) for line in f if line.strip()]
        elif (data_dir / "states.bin").exists():
            # Consolidated mode — memmap (may be too large for RAM)
            self.num_samples = meta["numSamples"]
            shape = (self.num_samples, self.num_channels, self.map_height, self.map_width)
            self.states = np.memmap(str(data_dir / "states.bin"), dtype="float32", mode="r", shape=shape)
            print(f"  Mapped {self.num_samples:,} samples (memmap)", flush=True)

            with open(data_dir / "actions.jsonl") as f:
                actions = [json.loads(line) for line in f if line.strip()]
        else:
            raise FileNotFoundError(
                f"No states.bin or worker_idx specified for {data_dir}"
            )

        if len(actions) != self.num_samples:
            raise ValueError(
                f"Data mismatch: states has {self.num_samples} samples "
                f"but actions has {len(actions)} lines"
            )

        # Pre-encode actions into numpy arrays (eliminates per-sample dict lookups)
        print("Encoding actions...", flush=True)
        action_types, target_tiles, prod_types = _encode_actions(actions, self.map_width)
        del actions  # free the list of dicts

        # Convert everything to torch tensors for fast __getitem__ and shared memory
        print("Converting to tensors...", flush=True)
        self.states = torch.from_numpy(self.states) if isinstance(self.states, np.ndarray) else torch.tensor(self.states)
        self.action_types = torch.from_numpy(action_types)
        self.target_tiles = torch.from_numpy(target_tiles)
        self.prod_types   = torch.from_numpy(prod_types)

    @staticmethod
    def count_workers(data_dir: str) -> int:
        """Return the number of worker-*.states.bin files in data_dir."""
        return len(glob.glob(str(Path(data_dir) / "worker-*.states.bin")))

    def __len__(self) -> int:
        return self.num_samples

    def __getitem__(self, idx: int) -> dict:
        return {
            "state":       self.states[idx],
            "action_type": self.action_types[idx],
            "target_tile": self.target_tiles[idx],
            "prod_type":   self.prod_types[idx],
        }
