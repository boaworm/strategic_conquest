#!/bin/bash
# Train all 9 MoE expert models sequentially.
# Run from the project root with the venv active.

set -e

DATA_DIR=/Volumes/500G/Training/moe
OUT_DIR=packages/trainer/ai/checkpoints/moe
EPOCHS=50

cd packages/trainer/ai

for UNIT_TYPE in army fighter bomber transport destroyer submarine carrier battleship; do
  echo "=== Training movement expert: $UNIT_TYPE ==="
  python train_movement.py \
    --unit-type "$UNIT_TYPE" \
    --data-dir "$DATA_DIR" \
    --out-dir  "$OUT_DIR" \
    --epochs   "$EPOCHS"
done

echo "=== Training production expert ==="
python train_production.py \
  --data-dir "$DATA_DIR" \
  --out-dir  "$OUT_DIR" \
  --epochs   "$EPOCHS"

echo "=== All MoE models trained. ONNX files in $OUT_DIR ==="
