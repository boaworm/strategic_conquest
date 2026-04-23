#!/bin/bash
# Collect MoE data until each worker's file reaches target size.
# Usage:
#   ./train_1.2_collect_moe.sh              # Collect all movement + production
#   ./train_1.2_collect_moe.sh army         # Collect only army movement
#   ./train_1.2_collect_moe.sh production   # Collect only production

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
  export UNIT_TYPE_FILTER=
elif [ "$1" = "production" ]; then
  echo "=== Collecting production data only ==="
  export PROD_ONLY=1
  export UNIT_TYPE_FILTER=
else
  echo "=== Collecting movement data for: $1 ==="
  export PROD_ONLY=0
  export UNIT_TYPE_FILTER="$1"
fi

export DATA_DIR="$BASE_DATA_DIR/$RUN_DIR"
mkdir -p "$DATA_DIR"

echo "Output directory: $DATA_DIR"
echo "Target size per worker file: ${TARGET_SIZE_GB}G (${TARGET_SIZE_BYTES} bytes)"
echo "Workers: $WORKERS"

export MAX_SAMPLES_PER_GAME
export WORKERS
export MAX_TURNS
export MAP_WIDTH
export MAP_HEIGHT
export TARGET_SIZE_BYTES

echo "=== Starting data collection ==="
npm run collect-moe --workspace=packages/trainer

echo "=== All workers reached target size ==="

# Sanity check
echo "=== Sanity checking collected data ==="
python - <<EOF
import os
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
        n_states = states_size // (14 * H * W * 4)
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
