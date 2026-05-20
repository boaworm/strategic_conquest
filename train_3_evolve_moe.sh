#!/bin/bash
set -e

is_gb10() { command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null 2>&1; }

run_python() {
    if is_gb10; then
        if ! docker image inspect sc-train &>/dev/null 2>&1; then
            echo "Docker image 'sc-train' not found. Run ./build_docker.sh first."; exit 1
        fi
        local out_dir="${EVOLUTION_OUT_DIR:-/Volumes/500G/Training/evolution_moe}"
        docker run --rm --gpus=all --shm-size=16g \
            -v "$(pwd):$(pwd)" \
            -v "$out_dir:$out_dir" \
            -w "$(pwd)" \
            sc-train python "$@"
    else
        python "$@"
    fi
}

run_python -u packages/trainer/ai/evolve_moe.py \
    --checkpoints packages/trainer/ai/checkpoints/moe \
    --population 100 \
    --generations 30 \
    --games-per-agent 10 \
    --workers 8 \
    --scale 0.05 \
    --map-width 50 \
    --map-height 20 \
    --output "${EVOLUTION_OUT_DIR:-/Volumes/500G/Training/evolution_moe}"
