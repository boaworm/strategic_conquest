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
    python -u train_production.py \
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
    python -u train_movement.py \
      --unit-type "$EXPERT_TYPE" \
      --data-dir  "$DATA_DIR" \
      --out-dir   "$OUT_DIR" \
      --epochs    "$EPOCHS" \
      --file-idx  "$FILE_IDX" \
      --resume
  done
fi

echo "=== Done. Checkpoint in $OUT_DIR ==="

# Sanity check: warn if any worker files have mismatched sample counts
echo "=== Sanity checking training data ==="
python - <<EOF
import os
from pathlib import Path

data_dir = Path("$DATA_DIR")
H, W = 22, 50
expert_type = "$EXPERT_TYPE"
errors = []

for worker_id in range(8):
    states_file = data_dir / f'worker-{worker_id}-{expert_type}.states.bin'
    if not states_file.exists():
        continue

    states_size = states_file.stat().st_size
    pos_file = data_dir / f'worker-{worker_id}-{expert_type}.positions.bin'
    actions_file = data_dir / f'worker-{worker_id}-{expert_type}.actions.bin'
    tiles_file = data_dir / f'worker-{worker_id}-{expert_type}.tiles.bin'

    n_states = states_size // (14 * H * W * 4)
    n_pos = pos_file.stat().st_size // 4 if pos_file.exists() else 0
    n_actions = actions_file.stat().st_size // 1 if actions_file.exists() else 0
    n_tiles = tiles_file.stat().st_size // 4 if tiles_file.exists() else 0

    if not (n_states == n_pos == n_actions == n_tiles):
        errors.append(f"worker-{worker_id}: states={n_states}, pos={n_pos}, actions={n_actions}, tiles={n_tiles}")

if errors:
    print("WARNING: Data mismatch detected (may cause training crashes):")
    for e in errors:
        print(f"  {e}")
else:
    print(f"Sanity check passed: all {expert_type} files have matching sample counts")
EOF
