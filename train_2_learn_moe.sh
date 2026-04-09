#!/bin/bash
# Train all 9 MoE expert models sequentially, one worker file at a time.
# Each unit type trains on file 0, warm-starts into file 1, ..., file 7.
# Max RAM per run: ~9 GB (army/transport), well under 40 GB limit.
# Run from the project root with the venv active.

set -e

DATA_DIR=/Volumes/500G/Training/moe
OUT_DIR=$(pwd)/packages/trainer/ai/checkpoints/moe
EPOCHS=50
NUM_FILES=8

cd packages/trainer/ai

for UNIT_TYPE in army fighter bomber transport destroyer submarine carrier battleship; do
  echo "=== Training movement expert: $UNIT_TYPE ==="
  for FILE_IDX in $(seq 0 $((NUM_FILES - 1))); do
    echo "--- $UNIT_TYPE file $FILE_IDX/$((NUM_FILES - 1)) ---"
    python train_movement.py \
      --unit-type "$UNIT_TYPE" \
      --data-dir  "$DATA_DIR" \
      --out-dir   "$OUT_DIR" \
      --epochs    "$EPOCHS" \
      --file-idx  "$FILE_IDX"
  done
done

echo "=== Training production expert ==="
for FILE_IDX in $(seq 0 $((NUM_FILES - 1))); do
  echo "--- production file $FILE_IDX/$((NUM_FILES - 1)) ---"
  python train_production.py \
    --data-dir "$DATA_DIR" \
    --out-dir  "$OUT_DIR" \
    --epochs   "$EPOCHS" \
    --file-idx "$FILE_IDX"
done

echo "=== All MoE models trained. ONNX files in $OUT_DIR ==="
