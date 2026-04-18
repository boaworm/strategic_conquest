#!/bin/bash
DATA_DIR=/Volumes/500G/Training/moe NUM_GAMES=15000 MAX_SAMPLES_PER_GAME=10000 WORKERS=8 MAX_TURNS=300 MAP_WIDTH=50 MAP_HEIGHT=22 PROD_ONLY=1 \
  npm run collect-moe --workspace=packages/trainer
