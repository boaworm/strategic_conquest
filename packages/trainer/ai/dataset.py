"""
GameDataset — loads imitation learning data produced by collect_data.ts.

File format (all in OUTPUT_DIR/):
  Consolidated mode:
    states.bin    — raw float32, shape [N, C, H, W] with no header
    actions.bin   — raw int8, N action type encodings (0-7)
    tiles.bin     — raw int32, N tile indices (-1 for non-move actions)
    meta.json     — mapWidth, mapHeight, numChannels, numSamples, numGames, wins
  Per-worker mode (if states.bin not found):
    worker-*.states.bin — one file per worker
    worker-*.actions.bin — one file per worker
    worker-*.tiles.bin — one file per worker
    meta.json — same as above
"""

import json
import glob
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

# Action type encoding (must stay in sync with encodeActionType in collect_worker.ts)
ACTION_TYPES = [
    "MOVE",
    "SET_PRODUCTION",
    "SLEEP",
    "SKIP",
    "LOAD",
    "UNLOAD",
    "WAKE",
    "END_TURN",
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


class GameDataset(Dataset):
    """
    Streams imitation-learning samples from disk.

    Each item returns:
      state       — float32 tensor [C, H, W]
      action_type — long scalar in [0, NUM_ACTION_TYPES)
      target_tile — long scalar in [0, H*W), or -1 if not applicable (non-MOVE/UNLOAD)
      prod_type   — long scalar in [0, NUM_UNIT_TYPES), or -1 if not applicable
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
            actions_path = data_dir / f"worker-{worker_idx}.actions.bin"
            tiles_path = data_dir / f"worker-{worker_idx}.tiles.bin"
            size = states_path.stat().st_size
            count = size // (4 * sample_size)
            shape = (count, self.num_channels, self.map_height, self.map_width)
            self.num_samples = count
            print(f"  Loading worker-{worker_idx} into RAM...", flush=True)
            self.states = np.memmap(str(states_path), dtype="float32", mode="r", shape=shape)
            print(f"  Loaded {self.states.nbytes / 1e9:.1f} GB ({count:,} samples)", flush=True)

            # Load actions and tiles as raw numpy arrays
            self.action_types = np.frombuffer(actions_path.read_bytes(), dtype=np.int8)
            self.target_tiles = np.frombuffer(tiles_path.read_bytes(), dtype=np.int32)
        elif (data_dir / "states.bin").exists():
            # Consolidated mode — memmap (may be too large for RAM)
            self.num_samples = meta["numSamples"]
            shape = (self.num_samples, self.num_channels, self.map_height, self.map_width)
            self.states = np.memmap(str(data_dir / "states.bin"), dtype="float32", mode="r", shape=shape)
            print(f"  Mapped {self.num_samples:,} samples (memmap)", flush=True)

            self.action_types = np.frombuffer((data_dir / "actions.bin").read_bytes(), dtype=np.int8)
            self.target_tiles = np.frombuffer((data_dir / "tiles.bin").read_bytes(), dtype=np.int32)
        else:
            raise FileNotFoundError(
                f"No states.bin or worker_idx specified for {data_dir}"
            )

        if len(self.action_types) != self.num_samples:
            raise ValueError(
                f"Data mismatch: states has {self.num_samples} samples "
                f"but actions has {len(self.action_types)} entries"
            )

        # Convert to torch tensors for fast __getitem__
        print("Converting to tensors...", flush=True)
        self.states = torch.from_numpy(self.states) if isinstance(self.states, np.ndarray) else torch.tensor(self.states)
        self.action_types = torch.from_numpy(self.action_types.astype(np.int64))
        self.target_tiles = torch.from_numpy(self.target_tiles.astype(np.int64))
        self.prod_types   = torch.full((self.num_samples,), -1, dtype=torch.int64)  # Not used in base dataset

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
