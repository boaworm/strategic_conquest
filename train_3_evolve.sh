python -u packages/trainer/ai/evolve.py \
    --checkpoint packages/trainer/ai/checkpoints/bertil-v2.0.pt \
    --population 100 \
    --generations 30 \
    --games-per-agent 10 \
    --workers 1 \
    --map-width 30 \
    --map-height 10 \
    --output /Volumes/500G/Training/evolution
