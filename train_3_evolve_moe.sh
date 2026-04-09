python -u packages/trainer/ai/evolve_moe.py \
    --checkpoints packages/trainer/ai/checkpoints/moe \
    --population 100 \
    --generations 30 \
    --games-per-agent 10 \
    --workers 8 \
    --scale 0.05 \
    --map-width 50 \
    --map-height 20 \
    --output /Volumes/500G/Training/evolution_moe
