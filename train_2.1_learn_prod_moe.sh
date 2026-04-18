#!/bin/bash
# Train only the production expert MoE model.
# Trains on all worker files together (full dataset).
# Run from the project root with the venv active.

set -e

DATA_DIR=/Volumes/500G/Training/moe/moe
OUT_DIR=$(pwd)/packages/trainer/ai/checkpoints/moe
EPOCHS=40
RESUME=0

cd packages/trainer/ai

echo "=== Training production expert (full dataset) ==="
python train_production.py \
  --data-dir "$DATA_DIR" \
  --out-dir  "$OUT_DIR" \
  --epochs   "$EPOCHS" \
  ${RESUME:+--resume}

echo "=== Production expert trained. ONNX file in $OUT_DIR ==="
