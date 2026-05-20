"""
MoE dataset loaders for movement experts and production expert.

File layout (all in DATA_DIR/):
  worker-{i}-{type}.states.bin     — float32 [N, 14, H, W]
  worker-{i}-{type}.positions.bin  — int16   [N, 2]  (x, y of the acting unit)
  worker-{i}-{type}.actions.bin    — uint8 action index (0=MOVE, 1=SKIP)
  worker-{i}-production.states.bin
  worker-{i}-production.cities.bin  — int16   [N, 2]
  worker-{i}-production.globals.bin — float32 [N, 28]
  worker-{i}-production.unitTypes.jsonl — {unitType}
  meta.json
"""

import json
import glob
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import Dataset

# Movement action types (must match collect_moe_worker.ts)
MOVEMENT_ACTION_TYPES = ['MOVE', 'SKIP']
MOVEMENT_ACTION_TO_IDX = {a: i for i, a in enumerate(MOVEMENT_ACTION_TYPES)}
NUM_MOVEMENT_ACTIONS = len(MOVEMENT_ACTION_TYPES)

# Unit types (must match UnitType enum in types.ts)
UNIT_TYPES = ['army', 'fighter', 'missile', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship']
UNIT_TYPE_TO_IDX = {u: i for i, u in enumerate(UNIT_TYPES)}
NUM_UNIT_TYPES = len(UNIT_TYPES)

NUM_GLOBAL = 28


def _load_meta(data_dir: Path) -> dict:
    meta_path = data_dir / 'meta.json'
    if meta_path.exists():
        with open(meta_path) as f:
            return json.load(f)
    return {}


class MovementDataset(Dataset):
    """
    Dataset for one movement expert (one unit type).

    Each item:
      state       — float32 [15, H, W]  (14 base channels + unit marker channel)
      action_type — long scalar in [0, NUM_MOVEMENT_ACTIONS)
      target_tile — long scalar in [0, H*W), or -1 if not a MOVE action
    """

    def __init__(self, data_dir: str, unit_type: str, file_idx: int | None = None, use_bf16: bool = True):
        data_dir = Path(data_dir)
        meta = _load_meta(data_dir)
        self.map_height = meta.get('mapHeight', 22)
        self.map_width  = meta.get('mapWidth', 50)
        self.H = self.map_height
        self.W = self.map_width
        self.HW = self.H * self.W

        state_files = sorted(data_dir.glob(f'worker-*-{unit_type}.states.bin'))
        if not state_files:
            raise FileNotFoundError(f"No data found for unit type '{unit_type}' in {data_dir}")
        if file_idx is not None:
            state_files = [state_files[file_idx]]

        self.unit_type = unit_type

        # Build LUT [H, W, 2, H, W] upfront — tiny (~10 MB)
        grid_x = np.tile(np.arange(self.W, dtype=np.float32)[np.newaxis, :], (self.H, 1))
        grid_y = np.tile(np.arange(self.H, dtype=np.float32)[:, np.newaxis], (1, self.W))
        lut = np.empty((self.H, self.W, 2, self.H, self.W), dtype=np.float32)
        for uy in range(self.H):
            for ux in range(self.W):
                dx = (grid_x - ux) / self.W
                lut[uy, ux, 0] = dx - np.round(dx)
                lut[uy, ux, 1] = (grid_y - uy) / self.H

        # Pass 1: count total samples from file sizes — no data loaded yet
        file_ns = []
        for sf in state_files:
            n = sf.stat().st_size // (13 * self.H * self.W * 4)
            file_ns.append(n)
        N = sum(file_ns)
        if N == 0:
            raise ValueError(f"No valid data loaded for unit type '{unit_type}' (all files empty or missing)")

        # Pre-allocate final arrays — one allocation each, no concatenation needed
        states17          = np.zeros((N, 17, self.H, self.W), dtype=np.float32)  # built in fp32, converted to bf16 at end
        self.positions    = np.empty((N, 2),  dtype=np.int16)
        self.action_types = np.empty(N,       dtype=np.int64)
        self.tile_idxs    = np.empty(N,       dtype=np.int64)

        # Pass 2: fill slice by slice — peak extra RAM = one file's raw states at a time
        offset = 0
        for sf, n in zip(state_files, file_ns):
            if n == 0:
                print(f"  .states.bin file is empty, ignoring: {sf.name}")
                continue
            base = str(sf)[:-len('.states.bin')]
            pf  = Path(base + '.positions.bin')
            af  = Path(base + '.actions.bin')
            tf  = Path(base + '.tiles.bin')
            cf  = Path(base + '.carried.bin')
            cgf = Path(base + '.cargo.bin')

            raw_states = np.memmap(sf, dtype=np.float32, mode='r')
            states13 = raw_states[:n * 13 * self.H * self.W].reshape(n, 13, self.H, self.W)

            raw_pos  = np.memmap(pf, dtype=np.int16, mode='r')[:n * 2].reshape(n, 2)
            xs = raw_pos[:, 0].astype(np.int32)
            ys = raw_pos[:, 1].astype(np.int32)
            valid = (xs >= 0) & (xs < self.W) & (ys >= 0) & (ys < self.H)
            rows  = np.where(valid)[0]

            carried = np.memmap(cf,  dtype=np.uint8, mode='r')[:n].astype(np.float32) if cf.exists()  else np.zeros(n, dtype=np.float32)
            cargo   = np.memmap(cgf, dtype=np.uint8, mode='r')[:n].astype(np.float32) / 6.0          if cgf.exists() else np.zeros(n, dtype=np.float32)

            sl = slice(offset, offset + n)
            states17[sl, :13] = states13
            states17[offset + rows, 13, ys[rows], xs[rows]] = 1.0
            states17[offset + rows, 14, ys[rows], xs[rows]] = (carried + cargo)[rows]
            # ch15-16: dx/dy from LUT
            states17[sl, 15] = lut[ys.clip(0, self.H-1), xs.clip(0, self.W-1), 0]
            states17[sl, 16] = lut[ys.clip(0, self.H-1), xs.clip(0, self.W-1), 1]

            self.positions[sl]    = raw_pos
            self.action_types[sl] = np.memmap(af, dtype=np.int8,  mode='r')[:n].astype(np.int64)
            self.tile_idxs[sl]    = np.memmap(tf, dtype=np.int32, mode='r')[:n].astype(np.int64)

            del raw_states, states13, raw_pos
            offset += n

        # CUDA: store as bfloat16 (halves memory, matches autocast); MPS: keep float32 (bfloat16 support limited)
        self.states17 = torch.from_numpy(states17).bfloat16() if use_bf16 else torch.from_numpy(states17)
        self.action_types = torch.from_numpy(self.action_types)
        self.tile_idxs    = torch.from_numpy(self.tile_idxs)

    def __len__(self) -> int:
        return len(self.states17)

    def __getitem__(self, idx: int):
        return self.states17[idx], self.action_types[idx], self.tile_idxs[idx]


class ProductionDataset(Dataset):
    """
    Dataset for the production expert.

    Each item:
      state          — float32 [15, H, W]  (13 base + city marker + 0-pad)
      global_features — float32 [22]
      unit_type      — long scalar in [0, NUM_UNIT_TYPES)
    """

    def __init__(self, data_dir: str, file_idx: int | None = None, use_bf16: bool = True):
        data_dir = Path(data_dir)
        meta = _load_meta(data_dir)
        self.map_height = meta.get('mapHeight', 22)
        self.map_width  = meta.get('mapWidth', 50)
        self.H = self.map_height
        self.W = self.map_width

        state_files = sorted(data_dir.glob('worker-*-production.states.bin'))
        if not state_files:
            raise FileNotFoundError(f"No production data found in {data_dir}")
        if file_idx is not None:
            state_files = [state_files[file_idx]]

        state_arrays, city_arrays, global_arrays, unit_type_list = [], [], [], []

        for sf in state_files:
            base = str(sf)[:-len('.states.bin')]
            cf  = Path(base + '.cities.bin')
            gf  = Path(base + '.globals.bin')
            uf  = Path(base + '.unitTypes.bin')

            raw_states = np.frombuffer(sf.read_bytes(), dtype=np.float32)
            n = len(raw_states) // (13 * self.H * self.W)
            if n == 0:
                print(f"  .states.bin file is empty, ignoring: {sf.name}")
                continue
            states = raw_states[:n * 13 * self.H * self.W].reshape(n, 13, self.H, self.W)

            raw_cities = np.frombuffer(cf.read_bytes(), dtype=np.int16)
            cities = raw_cities[:n * 2].reshape(n, 2)

            raw_globals = np.frombuffer(gf.read_bytes(), dtype=np.float32)
            globals_ = raw_globals[:n * NUM_GLOBAL].reshape(n, NUM_GLOBAL)

            raw_units = np.frombuffer(uf.read_bytes(), dtype=np.int8)

            state_arrays.append(states)
            city_arrays.append(cities)
            global_arrays.append(globals_)
            unit_type_list.append(raw_units[:n])

        if not state_arrays:
            raise ValueError(f"No valid data loaded (all files empty or missing)")
        self.states    = np.concatenate(state_arrays,  axis=0)
        self.cities    = np.concatenate(city_arrays,   axis=0)
        self.globals   = np.concatenate(global_arrays, axis=0)
        self.unit_types = np.concatenate(unit_type_list, axis=0).astype(np.int64)

        # Build states15: ch0-12 = base state, ch13 = city marker, ch14 = 0 (unused for production)
        N = len(self.states)
        states15 = np.zeros((N, 15, self.H, self.W), dtype=np.float32)
        states15[:, :13] = self.states
        del self.states
        cxs = self.cities[:, 0].astype(np.int32)
        cys = self.cities[:, 1].astype(np.int32)
        valid = (cxs >= 0) & (cxs < self.W) & (cys >= 0) & (cys < self.H)
        rows = np.where(valid)[0]
        states15[rows, 13, cys[rows], cxs[rows]] = 1.0  # ch13: city position marker
        self.states15 = torch.from_numpy(states15).bfloat16() if use_bf16 else torch.from_numpy(states15)

    def __len__(self) -> int:
        return len(self.states15)

    def __getitem__(self, idx: int):
        return (
            self.states15[idx],
            torch.from_numpy(self.globals[idx].copy()),
            torch.tensor(self.unit_types[idx], dtype=torch.long),
        )
