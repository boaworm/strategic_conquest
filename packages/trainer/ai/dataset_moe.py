"""
MoE dataset loaders for movement experts and production expert.

File layout (all in DATA_DIR/):
  worker-{i}-{type}.states.bin     — float32 [N, 14, H, W]
  worker-{i}-{type}.positions.bin  — int16   [N, 2]  (x, y of the acting unit)
  worker-{i}-{type}.actions.jsonl  — {actionType, tileIdx}
  worker-{i}-production.states.bin
  worker-{i}-production.cities.bin  — int16   [N, 2]
  worker-{i}-production.globals.bin — float32 [N, 22]
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
MOVEMENT_ACTION_TYPES = ['MOVE', 'SLEEP', 'SKIP', 'LOAD', 'UNLOAD']
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
      target_tile — long scalar in [0, H*W), or -1 if not a MOVE/UNLOAD action
    """

    def __init__(self, data_dir: str, unit_type: str, file_idx: int | None = None):
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
        state_arrays, pos_arrays, action_type_list, tile_idx_list, carried_arrays, cargo_arrays = [], [], [], [], [], []

        for sf in state_files:
            base = str(sf)[:-len('.states.bin')]
            pf  = Path(base + '.positions.bin')
            af  = Path(base + '.actions.bin')
            tf  = Path(base + '.tiles.bin')
            cf  = Path(base + '.carried.bin')  # army only: 1 byte per sample (1=carried, 0=free)
            cgf = Path(base + '.cargo.bin')    # transport only: 1 byte per sample (raw cargo count 0–6)

            raw_states = np.frombuffer(sf.read_bytes(), dtype=np.float32)
            n = len(raw_states) // (13 * self.H * self.W)
            if n == 0:
                print(f"  .states.bin file is empty, ignoring: {sf.name}")
                continue
            states = raw_states[:n * 13 * self.H * self.W].reshape(n, 13, self.H, self.W)

            raw_pos = np.frombuffer(pf.read_bytes(), dtype=np.int16)
            positions = raw_pos[:n * 2].reshape(n, 2)

            raw_actions = np.frombuffer(af.read_bytes(), dtype=np.int8)
            raw_tiles = np.frombuffer(tf.read_bytes(), dtype=np.int32)

            # Carried flag (army only) — zeros if file absent
            if cf.exists():
                carried = np.frombuffer(cf.read_bytes(), dtype=np.uint8)[:n].astype(np.float32)
            else:
                carried = np.zeros(n, dtype=np.float32)

            # Cargo fraction (transport only) — zeros if file absent; normalised by capacity 6
            if cgf.exists():
                cargo = np.frombuffer(cgf.read_bytes(), dtype=np.uint8)[:n].astype(np.float32) / 6.0
            else:
                cargo = np.zeros(n, dtype=np.float32)

            state_arrays.append(states)
            pos_arrays.append(positions)
            action_type_list.append(raw_actions[:n])
            tile_idx_list.append(raw_tiles[:n])
            carried_arrays.append(carried)
            cargo_arrays.append(cargo)

        if not state_arrays:
            raise ValueError(f"No valid data loaded for unit type '{unit_type}' (all files empty or missing)")
        self.states    = np.concatenate(state_arrays, axis=0)      # [N, 13, H, W]
        self.positions = np.concatenate(pos_arrays, axis=0)         # [N, 2]
        self.action_types = np.concatenate(action_type_list, axis=0).astype(np.int64)
        self.tile_idxs    = np.concatenate(tile_idx_list,    axis=0).astype(np.int64)
        carried_flat      = np.concatenate(carried_arrays, axis=0)  # [N]
        cargo_flat        = np.concatenate(cargo_arrays,   axis=0)  # [N]

        assert len(self.states) == len(self.positions) == len(self.action_types) == len(self.tile_idxs)

        # Build states15: ch0-12 = base state, ch13 = position marker, ch14 = carried/cargo signal
        N = len(self.states)
        states15 = np.zeros((N, 15, self.H, self.W), dtype=np.float32)
        states15[:, :13] = self.states
        del self.states
        xs = self.positions[:, 0].astype(np.int32)
        ys = self.positions[:, 1].astype(np.int32)
        valid = (xs >= 0) & (xs < self.W) & (ys >= 0) & (ys < self.H)
        rows = np.where(valid)[0]
        states15[rows, 13, ys[rows], xs[rows]] = 1.0  # ch13: unit position marker
        # ch14: army=carried flag (0/1), transport=cargo fraction (0–1), others=0
        states15[rows, 14, ys[rows], xs[rows]] = (carried_flat + cargo_flat)[rows]
        self.states15 = states15

    def __len__(self) -> int:
        return len(self.states15)

    def __getitem__(self, idx: int):
        return (
            torch.from_numpy(self.states15[idx].copy()),
            torch.tensor(self.action_types[idx], dtype=torch.long),
            torch.tensor(self.tile_idxs[idx],    dtype=torch.long),
        )


class ProductionDataset(Dataset):
    """
    Dataset for the production expert.

    Each item:
      state          — float32 [15, H, W]  (13 base + city marker + 0-pad)
      global_features — float32 [22]
      unit_type      — long scalar in [0, NUM_UNIT_TYPES)
    """

    def __init__(self, data_dir: str, file_idx: int | None = None):
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
        self.states15 = states15

    def __len__(self) -> int:
        return len(self.states15)

    def __getitem__(self, idx: int):
        return (
            torch.from_numpy(self.states15[idx].copy()),
            torch.from_numpy(self.globals[idx].copy()),
            torch.tensor(self.unit_types[idx], dtype=torch.long),
        )
