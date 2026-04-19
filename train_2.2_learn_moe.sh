#!/bin/bash
# Train a single MoE expert (movement or production).
# Usage:
#   ./train_2.2_learn_moe.sh army       # Train army movement expert
#   ./train_2.2_learn_moe.sh production # Train production expert
# Run from the project root with the venv active.

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <expert-type>"
  echo "  expert-type: one of army, fighter, missile, transport, destroyer, submarine, carrier, battleship, production"
  exit 1
fi

EXPERT_TYPE="$1"

if [ -z "$DATA_DIR" ]; then echo "DATA_DIR env var required"; exit 1; fi
OUT_DIR=$(pwd)/packages/trainer/ai/checkpoints/moe
EPOCHS=40
NUM_FILES=8

cd packages/trainer/ai

if [ "$EXPERT_TYPE" = "production" ]; then
  echo "=== Training production expert ==="
  for FILE_IDX in $(seq 0 $((NUM_FILES - 1))); do
    echo "--- production file $FILE_IDX/$((NUM_FILES - 1)) ---"
    python train_production.py \
      --data-dir "$DATA_DIR" \
      --out-dir  "$OUT_DIR" \
      --epochs   "$EPOCHS" \
      --file-idx "$FILE_IDX" \
      --resume
  done
else
  echo "=== Training movement expert: $EXPERT_TYPE ==="
  for FILE_IDX in $(seq 0 $((NUM_FILES - 1))); do
    echo "--- $EXPERT_TYPE file $FILE_IDX/$((NUM_FILES - 1)) ---"
    python train_movement.py \
      --unit-type "$EXPERT_TYPE" \
      --data-dir  "$DATA_DIR" \
      --out-dir   "$OUT_DIR" \
      --epochs    "$EPOCHS" \
      --file-idx  "$FILE_IDX" \
      --resume
  done
fi

echo "=== Done. Checkpoint in $OUT_DIR ==="
