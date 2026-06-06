#!/bin/bash
# Evolve frank-moe-v1.0 via neuroevolution.
#
# Runs natively on the host (NOT Docker): the eval pipeline needs Node.js to run
# eval_server.js, and the sc-train Docker image does not include Node.
# Requires: torch + CUDA, sc_env Python venv, and `node` in PATH.
#
# Every knob is overridable via env vars. Defaults are the Run-7 8h config:
#   workers=10  pop=20  games=32  gens=16  max-turns=300       ← games doubled vs Run 6 (sem → 0.011)
#   scale=0.03  mutation-rate=0.05  mutation-strength=0.03
#   per-genome-timeout=900s  baseline-every=4
#
#   fitness-mode = bounded
#   fitness = cityScore + β · tanh(strikeValue / strikeScale)
#   strikeScale=100  β=0.05                    → strike contribution capped at ±0.05
#   gamma=4  (zone-based location: 1× at enemy city, 5× at my city)
#     strike location multiplier = 1 + γ · dist_to_enemy_city / (dist_to_my_city + dist_to_enemy_city)
#     → defensive kills (near my city) weighted up to 5×
#     → offensive kills (near their city) only 1× (they can replace)
#
# Estimated wall time: ~30 min/gen × 16 gens ~= 8 h.

set -euo pipefail

PYTHON="${PYTHON:-sc_env/bin/python3}"
CHECKPOINTS="${CHECKPOINTS:-packages/trainer/ai/checkpoints/frank-moe-v1.0}"
POPULATION="${POPULATION:-20}"
GENERATIONS="${GENERATIONS:-16}"
GAMES_PER_AGENT="${GAMES_PER_AGENT:-32}"
WORKERS="${WORKERS:-10}"
SCALE="${SCALE:-0.03}"
MUTATION_RATE="${MUTATION_RATE:-0.05}"
MUTATION_STRENGTH="${MUTATION_STRENGTH:-0.03}"
MAP_WIDTH="${MAP_WIDTH:-50}"
MAP_HEIGHT="${MAP_HEIGHT:-20}"
MAX_TURNS="${MAX_TURNS:-300}"
PER_GENOME_TIMEOUT="${PER_GENOME_TIMEOUT:-900}"
ELITISM="${ELITISM:-2}"
BASELINE_EVERY="${BASELINE_EVERY:-4}"

# Fitness mode: additive | multiplicative | bounded
FITNESS_MODE="${FITNESS_MODE:-bounded}"
ALPHA="${ALPHA:-1.0}"             # additive only
BETA="${BETA:-0.05}"              # strike weight (capped at ±BETA in bounded mode)
GAMMA="${GAMMA:-4.0}"             # zone location amplification: loc = 1 + γ · zone_factor
STRIKE_SCALE="${STRIKE_SCALE:-100.0}"   # tanh scale: tanh(strikeValue / STRIKE_SCALE)

RUN_DIR="${RUN_DIR:-/media/henrik/data/evolution/run_$(date +%Y%m%d_%H%M)}"
mkdir -p "$RUN_DIR"

# Optional: limit to a subset of experts via MODELS env var (e.g. MODELS="army production")
MODELS_ARG=""
if [ -n "${MODELS:-}" ]; then
    MODELS_ARG="--models $MODELS"
fi

echo "=== Evolution config ==="
echo "  checkpoints      $CHECKPOINTS"
echo "  population       $POPULATION"
echo "  generations      $GENERATIONS"
echo "  games-per-agent  $GAMES_PER_AGENT"
echo "  workers          $WORKERS"
echo "  scale            $SCALE"
echo "  mutation-rate    $MUTATION_RATE"
echo "  mutation-str     $MUTATION_STRENGTH"
echo "  map              ${MAP_WIDTH}x${MAP_HEIGHT}  max-turns=$MAX_TURNS"
echo "  per-genome-to    ${PER_GENOME_TIMEOUT}s"
echo "  baseline-every   ${BASELINE_EVERY}"
echo "  fitness          mode=${FITNESS_MODE}  α=${ALPHA}  β=${BETA}  γ=${GAMMA}  strikeScale=${STRIKE_SCALE}"
echo "  models           ${MODELS:-all 9}"
echo "  run dir          $RUN_DIR"
echo ""

"$PYTHON" -u packages/trainer/ai/evolve_moe.py \
    --checkpoints "$CHECKPOINTS" \
    --population "$POPULATION" \
    --generations "$GENERATIONS" \
    --games-per-agent "$GAMES_PER_AGENT" \
    --workers "$WORKERS" \
    --scale "$SCALE" \
    --mutation-rate "$MUTATION_RATE" \
    --mutation-strength "$MUTATION_STRENGTH" \
    --map-width "$MAP_WIDTH" \
    --map-height "$MAP_HEIGHT" \
    --max-turns "$MAX_TURNS" \
    --per-genome-timeout "$PER_GENOME_TIMEOUT" \
    --elitism "$ELITISM" \
    --baseline-every "$BASELINE_EVERY" \
    --alpha "$ALPHA" \
    --beta "$BETA" \
    --gamma "$GAMMA" \
    --fitness-mode "$FITNESS_MODE" \
    --strike-scale "$STRIKE_SCALE" \
    $MODELS_ARG \
    --output "$RUN_DIR" 2>&1 | tee "$RUN_DIR/run.log"
