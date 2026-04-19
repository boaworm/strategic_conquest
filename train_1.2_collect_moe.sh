#!/bin/bash
# Collect MoE data.
# Usage:
#   ./train_1.2_collect_moe.sh              # Collect all movement + production
#   ./train_1.2_collect_moe.sh army         # Collect only army movement
#   ./train_1.2_collect_moe.sh production   # Collect only production
# Run from the project root with the venv active.

set -e

BASE_DATA_DIR=/Volumes/500G/Training/moe

# Find next sample_N directory
RUN_NUM=$(ls -1 "$BASE_DATA_DIR" 2>/dev/null | grep -E '^sample_[0-9]+$' | sed 's/sample_//' | sort -n | tail -1)
RUN_NUM=$((RUN_NUM + 1))
RUN_DIR="sample_$RUN_NUM"

NUM_GAMES=10000
MAX_SAMPLES_PER_GAME=5000
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

# Each run gets its own numbered subdirectory
export DATA_DIR="$BASE_DATA_DIR/$RUN_DIR"
mkdir -p "$DATA_DIR"

echo "Output directory: $DATA_DIR"

export NUM_GAMES
export MAX_SAMPLES_PER_GAME
export WORKERS
export MAX_TURNS
export MAP_WIDTH
export MAP_HEIGHT

npm run collect-moe --workspace=packages/trainer
