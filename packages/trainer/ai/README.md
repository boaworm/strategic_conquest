# Neural Network Agent Training

Imitation learning pipeline that trains a CNN to mimic BasicAgent decisions.

## Overview

1. **Data Collection** (`collect_data.ts`) - Run headless games between BasicAgent opponents
2. **Training** (`train.py`) - Train CNN on collected (state, action) pairs
3. **Inference** - Use trained model as NN agent in games

---

## Step 1: Collect Training Data

```bash
cd packages/trainer

# Collect 1500 games, up to 3000 samples per game
DATA_DIR=/Volumes/500G/Training NUM_GAMES=1500 MAX_SAMPLES_PER_GAME=3000 WORKERS=8 npm run collect
```

### Output Files

Per-worker files (no merge to avoid disk duplication):
- `worker-0.states.bin`, `worker-1.states.bin`, ... - Raw float32 tensors
- `worker-0.actions.jsonl`, `worker-1.actions.jsonl`, ... - Action labels
- `meta.json` - Dataset metadata

### Data Format

**states.bin** (per worker):
- Shape: `[N, 14, 22, 50]` float32 tensor
- 14 channels: 8 unit types + 4 terrain + 2 ownership
- Map includes ice cap rows (H+2)

**actions.jsonl** (per worker):
- One JSON line per sample
- Fields: `type`, `unitId`, `to`, `unitType`, etc.

---

## Step 2: Train the Model

```bash
cd packages/trainer/ai

# Install dependencies
pip install -r requirements.txt

# Train (uses per-worker files automatically)
python train.py \
  --data-dir /Volumes/500G/Training/training \
  --out-dir ./checkpoints \
  --epochs 50 \
  --batch-size 256 \
  --workers 4
```

### Training Details

**Model**: PolicyCNN with cylindrical X-padding
- 3 conv layers (64 → 128 → 128 channels)
- Action type head (9 classes)
- Target tile head (H×W spatial logits)
- Production type head (8 classes)

**Loss**: `loss = action_loss + 0.5 * tile_loss + 0.5 * prod_loss`

**Output**: `checkpoints/best_model.pt` (lowest validation loss)

---

## Step 3: Use the Trained Model

See `NnAgent.md` for inference implementation.

---

## Disk Space Requirements

| Component | Size |
|-----------|------|
| Per-worker states | ~200 MB |
| 8 workers total | ~1.6 GB |
| Checkpoints | ~50 MB |

**Note**: Per-worker format avoids merge duplication. Training code reads worker files directly.
