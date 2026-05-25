#!/bin/bash
# Train MoE expert models.
# Usage:
#   ./train_2_learn_moe.sh                                    # Train all movement experts + production
#   ./train_2_learn_moe.sh army                               # Train only army movement expert
#   ./train_2_learn_moe.sh army missile transport             # Train specific units
#   ./train_2_learn_moe.sh production                         # Train only production expert
# Run from the project root with the venv active.

set -e

is_gb10() { command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; }

if [ -z "$DATA_DIR" ]; then echo "DATA_DIR env var required"; exit 1; fi
if [ -z "$RESUME" ]; then
  echo "RESUME env var required. Set RESUME=1 to warm-start from existing checkpoints, RESUME=0 to train from scratch."
  echo "  RESUME=0 DATA_DIR=... ./train_2_learn_moe.sh          # fresh retrain all"
  echo "  RESUME=1 DATA_DIR=... ./train_2_learn_moe.sh army     # continue training army"
  exit 1
fi

PROJECT_ROOT=$(pwd)
OUT_DIR=$PROJECT_ROOT/packages/trainer/ai/checkpoints/moe
EPOCHS=40
NUM_FILES=8
TARGET_VRAM_USAGE_GB=50
PRODUCTION_MIN_BATCHES=${PRODUCTION_MIN_BATCHES:-20}
RESUME_FLAG=$([ "$RESUME" = "1" ] && echo "--resume" || echo "")
START_AT_FILE_FLAG=$([ -n "$START_AT_FILE" ] && echo "--start-at-file $START_AT_FILE" || echo "")
PROFILE_FLAG=$([ "$PROFILE" = "1" ] && echo "--profile" || echo "")

# Parse which units and whether to run production
UNITS=()
DO_PRODUCTION=false
if [ -z "$1" ]; then
  UNITS=(army fighter missile transport destroyer submarine carrier battleship)
  DO_PRODUCTION=true
else
  for ARG in "$@"; do
    if [ "$ARG" = "production" ]; then DO_PRODUCTION=true; else UNITS+=("$ARG"); fi
  done
fi

cd packages/trainer/ai

if is_gb10; then
  if ! docker image inspect sc-train &>/dev/null 2>&1; then
    echo "Docker image 'sc-train' not found. Run ./build_docker.sh first."; exit 1
  fi
  cache_dir="$PROJECT_ROOT/tmp/torch_cache"
  mkdir -p "$cache_dir"

  inner="set -e"
  for UNIT_TYPE in "${UNITS[@]}"; do
    inner="$inner
echo '=== Training movement expert: $UNIT_TYPE ==='
python -u train_movement.py --unit-type $UNIT_TYPE --data-dir $DATA_DIR --out-dir $OUT_DIR --epochs $EPOCHS --num-files $NUM_FILES --target-vram-usage-gb $TARGET_VRAM_USAGE_GB $RESUME_FLAG $PROFILE_FLAG $START_AT_FILE_FLAG"
  done
  if $DO_PRODUCTION; then
    inner="$inner
echo '=== Training production expert ==='
python -u train_production.py --data-dir $DATA_DIR --out-dir $OUT_DIR --epochs $EPOCHS --num-files $NUM_FILES --target-vram-usage-gb $TARGET_VRAM_USAGE_GB --min-batches $PRODUCTION_MIN_BATCHES $RESUME_FLAG"
  fi

  docker rm -f sc-train-run &>/dev/null || true
  docker run --rm --init --name sc-train-run --gpus=all --shm-size=16g --user "$(id -u):$(id -g)" \
    -v "$PROJECT_ROOT:$PROJECT_ROOT" \
    -v "$DATA_DIR:$DATA_DIR" \
    -v "$cache_dir:/torch_cache" \
    -e TORCHINDUCTOR_CACHE_DIR=/torch_cache/inductor \
    -e TRITON_CACHE_DIR=/torch_cache/triton \
    -w "$PROJECT_ROOT/packages/trainer/ai" \
    sc-train bash -c "$inner"
else
  for UNIT_TYPE in "${UNITS[@]}"; do
    echo "=== Training movement expert: $UNIT_TYPE ==="
    python -u train_movement.py \
      --unit-type            "$UNIT_TYPE" \
      --data-dir             "$DATA_DIR" \
      --out-dir              "$OUT_DIR" \
      --epochs               "$EPOCHS" \
      --num-files            "$NUM_FILES" \
      --target-vram-usage-gb "$TARGET_VRAM_USAGE_GB" \
      $RESUME_FLAG $PROFILE_FLAG $START_AT_FILE_FLAG
  done
  if $DO_PRODUCTION; then
    echo "=== Training production expert ==="
    python -u train_production.py \
      --data-dir             "$DATA_DIR" \
      --out-dir              "$OUT_DIR" \
      --epochs               "$EPOCHS" \
      --num-files            "$NUM_FILES" \
      --target-vram-usage-gb "$TARGET_VRAM_USAGE_GB" \
      --max-batch-size       "$PRODUCTION_MAX_BATCH" \
      $RESUME_FLAG $START_AT_FILE_FLAG
  fi
fi

echo "=== Done. Checkpoints in $OUT_DIR ==="
