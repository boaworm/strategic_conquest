#!/bin/bash
# Train MoE expert models.
# Usage:
#   ./train_2_learn_moe.sh            # Train all movement experts + production
#   ./train_2_learn_moe.sh army       # Train only army movement expert
#   ./train_2_learn_moe.sh production # Train only production expert
# Run from the project root with the venv active.

set -e

if [ -z "$DATA_DIR" ]; then echo "DATA_DIR env var required"; exit 1; fi
if [ -z "$RESUME" ]; then
  echo "RESUME env var required. Set RESUME=1 to warm-start from existing checkpoints, RESUME=0 to train from scratch."
  echo "  RESUME=0 DATA_DIR=... ./train_2_learn_moe.sh          # fresh retrain all"
  echo "  RESUME=1 DATA_DIR=... ./train_2_learn_moe.sh army     # continue training army"
  exit 1
fi

OUT_DIR=$(pwd)/packages/trainer/ai/checkpoints/moe
EPOCHS=40
NUM_FILES=8

cd packages/trainer/ai

train_movement() {
  local UNIT_TYPE="$1"
  echo "=== Training movement expert: $UNIT_TYPE ==="
  for FILE_IDX in $(seq 0 $((NUM_FILES - 1))); do
    echo "--- $UNIT_TYPE file $((FILE_IDX + 1))/$NUM_FILES ---"
    python -u train_movement.py \
      --unit-type "$UNIT_TYPE" \
      --data-dir  "$DATA_DIR" \
      --out-dir   "$OUT_DIR" \
      --epochs    "$EPOCHS" \
      --file-idx  "$FILE_IDX" \
      $([ "$RESUME" = "1" ] && echo --resume)
  done
}

train_production() {
  echo "=== Training production expert ==="
  for FILE_IDX in $(seq 0 $((NUM_FILES - 1))); do
    echo "--- production file $((FILE_IDX + 1))/$NUM_FILES ---"
    python -u train_production.py \
      --data-dir "$DATA_DIR" \
      --out-dir  "$OUT_DIR" \
      --epochs   "$EPOCHS" \
      --file-idx "$FILE_IDX" \
      $([ "$RESUME" = "1" ] && echo --resume)
  done
}

if [ -z "$1" ]; then
  for UNIT_TYPE in army fighter missile transport destroyer submarine carrier battleship; do
    train_movement "$UNIT_TYPE"
  done
  train_production
elif [ "$1" = "production" ]; then
  train_production
else
  train_movement "$1"
fi

echo "=== Done. Checkpoints in $OUT_DIR ==="
