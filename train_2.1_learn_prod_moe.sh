#!/bin/bash
# Train only the production expert MoE model.
# Trains on one worker file at a time, sequential (file-idx 0 through 7).
# Each run warm-starts from the previous checkpoint.
# Run from the project root with the venv active.

set -e

DATA_DIR=/Volumes/500G/Training/moe/moe
OUT_DIR=$(pwd)/packages/trainer/ai/checkpoints/moe
EPOCHS=40
NUM_FILES=8

cd packages/trainer/ai

echo "=== Training production expert (one file at a time) ==="
for FILE_IDX in $(seq 0 $((NUM_FILES - 1))); do
  echo "--- production file $FILE_IDX/$((NUM_FILES - 1)) ---"
  python train_production.py \
    --data-dir "$DATA_DIR" \
    --out-dir  "$OUT_DIR" \
    --epochs   "$EPOCHS" \
    --file-idx "$FILE_IDX" \
    --resume
done

echo "=== Production expert trained. ONNX file in $OUT_DIR ==="
