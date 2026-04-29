DATA_DIR=./tmp MAX_TURNS=300 NUM_GAMES=8 WORKERS=8 MAP_WIDTH=50 MAP_HEIGHT=20 \
P1_AGENT=nnMoEAgent:./packages/trainer/ai/checkpoints/david-moe-v1.0 \
P2_AGENT=basicAgent \
npm run record
