#!/bin/bash
# Collect MoE data until each worker's file reaches target size.
# Usage:
#   DATA_DIR=/Volumes/500G/Training ./train_1.2_collect_moe.sh              # Collect all movement + production
#   DATA_DIR=/Volumes/500G/Training ./train_1.2_collect_moe.sh army         # Collect only army movement
#   DATA_DIR=/Volumes/500G/Training ./train_1.2_collect_moe.sh production   # Collect only production

set -e

if [ -z "$DATA_DIR" ]; then echo "DATA_DIR env var required"; exit 1; fi
BASE_DATA_DIR="$DATA_DIR"

TARGET_SIZE_GB=40
TARGET_SIZE_BYTES=$((TARGET_SIZE_GB * 1024 * 1024 * 1024))

RUN_NUM=$(ls -1 "$BASE_DATA_DIR" 2>/dev/null | grep -E '^sample_[0-9]+$' | sed 's/sample_//' | sort -n | tail -1)
RUN_NUM=$((RUN_NUM + 1))
RUN_DIR="sample_$RUN_NUM"

MAX_SAMPLES_PER_GAME=50000
WORKERS=8
MAX_TURNS=300
MAP_WIDTH=50
MAP_HEIGHT=20

if [ -z "$1" ]; then
  echo "=== Collecting all movement experts + production ==="
  export PROD_ONLY=0
  export UNIT_TYPES=
elif [ "$1" = "production" ]; then
  echo "=== Collecting production data only ==="
  export PROD_ONLY=1
  export UNIT_TYPES=
else
  # Join all positional args with commas: e.g. destroyer battleship carrier → destroyer,battleship,carrier
  UNIT_TYPES_VAL=$(IFS=,; echo "$*")
  echo "=== Collecting movement data for: $UNIT_TYPES_VAL ==="
  export PROD_ONLY=0
  export UNIT_TYPES="$UNIT_TYPES_VAL"
fi

export MAX_SAMPLES_PER_GAME
export WORKERS
export MAX_TURNS
export MAP_WIDTH
export MAP_HEIGHT
export TARGET_SIZE_BYTES

echo "=== Building ==="
npx tsc -p packages/shared/tsconfig.json && npm run build --workspace=packages/trainer

export DATA_DIR="$BASE_DATA_DIR/$RUN_DIR"
mkdir -p "$DATA_DIR"

echo "Output directory: $DATA_DIR"
echo "Target size per worker file: ${TARGET_SIZE_GB}G (${TARGET_SIZE_BYTES} bytes)"
echo "Workers: $WORKERS"

echo "=== Starting data collection ==="
node packages/trainer/dist/collect_moe_data.js

echo "=== All workers reached target size ==="

# Sanity check
echo "=== Sanity checking collected data ==="
python3 - <<EOF
import sys, os
sys.path.insert(0, os.path.join(os.getcwd(), 'packages/trainer/ai'))
from models_moe import NUM_BASE_CHANNELS
from pathlib import Path

data_dir = Path("$DATA_DIR")
H, W = 22, 50
errors = []

for worker_id in range(8):
    for unit_type in ['army', 'fighter', 'missile', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship']:
        states_file = data_dir / f'worker-{worker_id}-{unit_type}.states.bin'
        if not states_file.exists():
            continue
        states_size = states_file.stat().st_size
        pos_file = data_dir / f'worker-{worker_id}-{unit_type}.positions.bin'
        actions_file = data_dir / f'worker-{worker_id}-{unit_type}.actions.bin'
        tiles_file = data_dir / f'worker-{worker_id}-{unit_type}.tiles.bin'
        n_states = states_size // (NUM_BASE_CHANNELS * H * W * 4)
        n_pos = pos_file.stat().st_size // 4 if pos_file.exists() else 0
        n_actions = actions_file.stat().st_size // 1 if actions_file.exists() else 0
        n_tiles = tiles_file.stat().st_size // 4 if tiles_file.exists() else 0
        if not (n_states == n_pos == n_actions == n_tiles):
            errors.append(f"worker-{worker_id}-{unit_type}: states={n_states}, pos={n_pos}, actions={n_actions}, tiles={n_tiles}")

if errors:
    print("SANITY CHECK FAILED:")
    for e in errors:
        print(f"  {e}")
    exit(1)
else:
    print("Sanity check passed")
EOF

if [ -n "$COMBINE_DATA_INTO_GB_CHUNKS" ]; then
  echo "=== Combining worker files into ${COMBINE_DATA_INTO_GB_CHUNKS}G chunks ==="
  python3 - <<EOF
import math, os
from pathlib import Path

data_dir    = Path("$DATA_DIR")
chunk_bytes = $COMBINE_DATA_INTO_GB_CHUNKS * 1024**3

def cat_files(srcs, dst):
    with open(dst, 'wb') as out:
        for src in srcs:
            with open(src, 'rb') as inp:
                while True:
                    buf = inp.read(64 * 1024 * 1024)
                    if not buf:
                        break
                    out.write(buf)

def combine_unit(unit, states_files, exts, optional_exts=[]):
    file_size     = states_files[0].stat().st_size
    max_per_group = max(1, int(chunk_bytes // file_size))
    if max_per_group == 1:
        print(f"{unit}: {file_size/1024**3:.1f}G per file, nothing to combine")
        return
    num_groups = math.ceil(len(states_files) / max_per_group)
    print(f"{unit}: {len(states_files)} x {file_size/1024**3:.1f}G -> {num_groups} file(s) of up to {max_per_group}")

    # Write to tmp files first to avoid read/write conflicts
    for g in range(num_groups):
        group = states_files[g * max_per_group:(g + 1) * max_per_group]
        for ext in exts:
            srcs = [Path(str(sf).replace('.states.bin', f'.{ext}.bin')) for sf in group]
            cat_files(srcs, data_dir / f'_tmp-{g}-{unit}.{ext}.bin')
        for ext in optional_exts:
            srcs = [Path(str(sf).replace('.states.bin', f'.{ext}.bin')) for sf in group
                    if Path(str(sf).replace('.states.bin', f'.{ext}.bin')).exists()]
            if srcs:
                cat_files(srcs, data_dir / f'_tmp-{g}-{unit}.{ext}.bin')

    # Delete originals
    all_exts = exts + optional_exts
    for sf in states_files:
        base = str(sf).replace('.states.bin', '')
        for ext in all_exts:
            p = Path(f'{base}.{ext}.bin')
            if p.exists():
                p.unlink()

    # Rename tmp -> worker-N
    for g in range(num_groups):
        for p in data_dir.glob(f'_tmp-{g}-{unit}.*.bin'):
            p.rename(data_dir / p.name.replace(f'_tmp-{g}-', f'worker-{g}-'))

ALL_MOVEMENT_TYPES = ['army','fighter','missile','transport','destroyer','submarine','carrier','battleship']
unit_filter  = "$UNIT_TYPE_FILTER"
prod_only    = "$PROD_ONLY" == "1"

if prod_only:
    movement_types = []
elif unit_filter:
    movement_types = [unit_filter]
else:
    movement_types = ALL_MOVEMENT_TYPES

for unit in movement_types:
    states_files = sorted(data_dir.glob(f'worker-*-{unit}.states.bin'))
    if states_files:
        combine_unit(unit, states_files,
                     exts=['states','positions','actions','tiles'],
                     optional_exts=['carried','cargo'])

if not unit_filter:
    prod_files = sorted(data_dir.glob('worker-*-production.states.bin'))
    if prod_files:
        combine_unit('production', prod_files,
                     exts=['states','cities','globals','unitTypes'])

print("Done.")
EOF
  echo "=== Combining complete ==="
fi
