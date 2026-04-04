# Neural Network Agent

The NN agent uses a trained PyTorch model to make decisions during gameplay. This document covers the complete training workflow from data collection to advanced evolution.

---

## Architecture

```
State Tensor (14×H×W) → PolicyCNN → Action Distribution
                                         ↓
                            Sample argmax / multinomial
                                         ↓
                                  Game Action
```

---

## Quick Start: Play vs Trained NN Agent

### Prerequisites
Place your trained ONNX model in `packages/trainer/ai/checkpoints/`:
```bash
# Example: adam.onnx
ls packages/trainer/ai/checkpoints/adam.onnx
```

### Run BasicAgent vs NN Agent
```bash
cd packages/trainer

# Playtest: 8 games, max 300 turns, basicAgent vs NN(adam)
DATA_DIR=tmp NUM_GAMES=8 MAX_TURNS=300 P1AGENT=basicAgent P2AGENT=nnAgent:adam npm run record

# Output: tmp/replays/*.json (replay files)
# Run "npm run replay" to view
```

### NN Agent Syntax
| Syntax | Description | Example |
|--------|-------------|---------|
| `nnAgent:<name>` | Shorthand → looks for `checkpoints/<name>.onnx` | `nnAgent:adam` → `checkpoints/adam.onnx` |
| `nn:<name>` | Short alias for nnAgent | `nn:gen1` → `checkpoints/gen1.onnx` |
| `nnAgent:<path>` | Full path to ONNX file | `nnAgent:/full/path/model.onnx` |

---

## Workflow Overview

| Phase | Description | Output |
|-------|-------------|--------|
| 1 | Simulate heuristic agent, record games | `worker-*.states.bin`, `worker-*.actions.jsonl` |
| 2 | Train model against recorded data | `checkpoints/best_model.pt` |
| 3 | Continue training with new data | Updated checkpoint |
| 4 | Genetic programming evolution | `champion.json` with evolved weights |
| 5 | NN vs NN self-play | Performance metrics |
| 6 | Heuristic vs NN evaluation | Win rate comparison |

---

## Phase 1: Simulate Heuristic Agent & Record Games

### BasicAgent vs BasicAgent (Imitation Learning Baseline)

Collect training data from heuristic agent games:

```bash
cd packages/trainer

# Collect 1500 games, up to 3000 samples per game, 8 parallel workers
DATA_DIR=/Volumes/500G/Training NUM_GAMES=1500 MAX_SAMPLES_PER_GAME=3000 WORKERS=8 npm run collect
```

**Output files** (in `DATA_DIR/training/`):
- `worker-0.states.bin`, `worker-1.states.bin`, ... — Raw float32 tensors
- `worker-0.actions.jsonl`, `worker-1.actions.jsonl`, ... — Action labels
- `meta.json` — Dataset metadata

### Recording NN Agent Games

To record games where the NN agent plays (for continued training):

```bash
# Run NN vs BasicAgent games and record decisions
# Modify collect_worker.ts to use NnAgent instead of BasicAgent
DATA_DIR=/Volumes/500G/Training NUM_GAMES=500 WORKERS=4 npm run collect
```

### Recording with nnAgent in `npm run record`

Record replays with NN agent for playtesting or data collection:

```bash
# NN vs BasicAgent
DATA_DIR=tmp NUM_GAMES=100 MAX_TURNS=300 \
  P1AGENT=nnAgent:adam P2AGENT=basicAgent \
  npm run record

# NN vs NN (different models)
DATA_DIR=tmp NUM_GAMES=100 MAX_TURNS=300 \
  P1AGENT=nnAgent:adam P2AGENT=nnAgent:bob \
  npm run record

# BasicAgent vs NN
DATA_DIR=tmp NUM_GAMES=100 MAX_TURNS=300 \
  P1AGENT=basicAgent P2AGENT=nnAgent:adam \
  npm run record
```

**Output**: `DATA_DIR/replays/*.json` with meta including `p1Agent`, `p2Agent`, winner, turns.

### Recording Heuristic vs Heuristic (EvolvedAgent)

After genetic evolution, record games with evolved agents:

```bash
# Use evolved genome for data collection
# Set EVOLVED_GENOME=./champion.json before running collect
DATA_DIR=/Volumes/500G/Training NUM_GAMES=1000 WORKERS=8 npm run collect
```

---

## Phase 2: Train Model Against Recorded Data

### Initial Training

```bash
cd packages/trainer/ai

# Install dependencies
pip install -r requirements.txt

# Train from scratch
python train.py \
  --data-dir /Volumes/500G/Training/training \
  --out-dir ./checkpoints \
  --epochs 50 \
  --batch-size 1024 \
  --workers 4
```

**Training output**:
- `checkpoints/best_model.pt` — Best checkpoint (lowest validation loss)
- Training progress printed to stdout

**Key metrics to monitor**:
- `action_acc` — Overall action type accuracy (target: >80%)
- `val_loss` — Validation loss (should decrease)
- `tile_loss` / `prod_loss` — Head-specific losses

### Training Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--epochs` | 50 | Number of training epochs |
| `--batch-size` | 1024 | Batch size per iteration |
| `--lr` | 1e-3 | Base learning rate (scaled linearly with batch) |
| `--workers` | 4 | DataLoader worker processes |
| `--resume` | None | Checkpoint path to resume from |

---

## Phase 3: Continue Training with New Data

### Option A: Resume from Checkpoint

Add more data and continue training from existing model:

```bash
# Collect additional data
DATA_DIR=/Volumes/500G/Training2 NUM_GAMES=500 WORKERS=4 npm run collect

# Combine datasets (append per-worker files)
cat /Volumes/500G/Training/training/worker-*.states.bin > combined/states.bin
cat /Volumes/500G/Training/training/worker-*.actions.jsonl > combined/actions.jsonl

# Continue training from checkpoint
python train.py \
  --data-dir ./combined \
  --out-dir ./checkpoints \
  --epochs 50 \
  --resume ./checkpoints/best_model.pt
```

### Option B: Fine-tune on New Data Only

Train only on recent games (e.g., NN agent decisions):

```bash
# Collect NN agent games
DATA_DIR=/Volumes/500G/NN_Games NUM_GAMES=200 WORKERS=4 npm run collect

# Fine-tune
python train.py \
  --data-dir /Volumes/500G/NN_Games/training \
  --out-dir ./checkpoints \
  --epochs 20 \
  --lr 1e-4 \
  --resume ./checkpoints/best_model.pt
```

**Key insight**: Better agent → better decisions → better training data. This is the bootstrap loop.

---

## Phase 4: Neuroevolution - Evolve NN Weights

After supervised training, use Evolution Strategies to fine-tune the NN weights directly.

### Step 4.1: Export Base Model to ONNX

```bash
cd packages/trainer/ai

# Export the supervised-trained model to ONNX
python export_onnx.py --checkpoint ./checkpoints/best_model.pt --output ./checkpoints/albert-gen1.onnx
```

### Step 4.2: Run Neuroevolution (Pure JavaScript)

```bash
cd packages/trainer

# Evolve NN weights from supervised checkpoint (fast, no socket overhead)
npm run nn-evolve -- \
  --base ./ai/checkpoints/best_model.pt \
  --pop 30 \
  --gens 50 \
  --games-per-agent 5 \
  --workers 8 \
  --output ./ai/evolved
```

**How it works:**
1. Load base checkpoint, extract layer structure
2. Create population of random perturbations
3. For each generation:
   - Export each genome to ONNX (Python helper, one-time per genome)
   - Evaluate fitness via games (JavaScript, NnAgent + ONNX Runtime)
   - Select, crossover, mutate
4. Save best checkpoints

**Performance:** ~10x faster than socket-based approach because:
- No subprocess spawning per game
- No Unix domain socket IPC
- All game logic runs in-process

**Parameters:**
| Flag | Default | Description |
|------|---------|-------------|
| `--base` | required | Base PyTorch checkpoint path |
| `--pop` | 30 | Population size |
| `--gens` | 50 | Number of generations |
| `--games-per-agent` | 5 | Games per evaluation |
| `--workers` | 8 | Parallel workers |
| `--elitism` | 2 | Elites per generation |
| `--scale` | 0.1 | Initial perturbation scale |
| `--mutation-rate` | 0.05 | Mutation rate |
| `--mutation-strength` | 0.1 | Mutation strength |
| `--output` | ./ai/evolved | Output directory |
| `--map-width` | 50 | Map width |
| `--map-height` | 20 | Map height |
| `--max-turns` | 300 | Max turns per game |

**Evolution parameters:**
- `--pop`: Population size (default: 30)
- `--gens`: Number of generations (default: 50)
- `--games-per-agent`: Games per evaluation (default: 5)
- `--workers`: Parallel workers (default: 8)
- `--scale`: Initial perturbation scale (default: 0.1)
- `--elitism`: Elites per generation (default: 2)

**How it works:**
1. Load base model from supervised training
2. Create population of weight perturbations
3. For each generation:
   - Export each genome to ONNX
   - Play games via nn-simulator
   - Compute fitness (win rate)
   - Select, crossover, mutate
4. Save best checkpoints

### Step 4.3: Evaluate Champion

```bash
# Best checkpoints saved to ./ai/evolved/checkpoint_gen*.pt
# Load perturbations and apply to base model for final evaluation
```

### Step 4.3: Evaluate Champion

```bash
# Champion genome saved to champion.json
cat champion.json

# Use evolved agent for games
EVOLVED_GENOME=./champion.json npm run record
```

### Step 4.4: Use Evolved Data for NN Training

Record games with evolved agent and retrain NN:

```bash
# Record evolved agent games
DATA_DIR=/Volumes/500G/Evolved NUM_GAMES=1000 WORKERS=8 npm run collect

# Retrain NN on evolved behavior
python train.py \
  --data-dir /Volumes/500G/Evolved/training \
  --out-dir ./checkpoints \
  --epochs 50 \
  --resume ./checkpoints/best_model.pt
```

**Why this works**: The evolved agent discovers strategies the basic heuristic doesn't use. The NN learns these advanced patterns.

---

## Phase 5: NN vs NN Self-Play

### Setup Unix Domain Socket

```bash
# Terminal 1: Start Python inference server
cd packages/trainer/ai
python server.py --checkpoint ./checkpoints/best_model.pt --uds-path /tmp/nn_vs_nn.sock

# Terminal 2: Run self-play games
export UDS_PATH=/tmp/nn_vs_nn.sock
cd packages/trainer
npm run nn-sim
```

### Tournament Evaluation

```bash
# Run multiple games and collect stats
for i in {1..10}; do
  export UDS_PATH=/tmp/nn_vs_nn.sock
  npm run nn-sim 2>&1 | grep -E "Game over|NN winrate"
done
```

### Self-Play Training (Advanced)

To train via self-play (not imitation):

1. Modify `train.py` to use reinforcement learning loss
2. Reward: +1000 win, -1000 loss, +10 kill, +50 city capture
3. Use PPO or policy gradient instead of supervised learning

---

## Phase 6: Heuristic (BasicAgent) vs NN Evaluation

### Run Tournament

```bash
# NN is always player1, BasicAgent is player2
# Run via nn-sim (BasicAgent runs in TypeScript, NN via Python socket)

export UDS_PATH=/tmp/nn_eval.sock
cd packages/trainer/ai

# Terminal 1: Start NN server
python server.py --checkpoint ./checkpoints/best_model.pt --uds-path /tmp/nn_eval.sock

# Terminal 2: Run games
cd packages/trainer
for i in {1..50}; do
  npm run nn-sim 2>&1
done
```

### Expected Performance

| Metric | BasicAgent | NN Agent (target) |
|--------|------------|-------------------|
| Action accuracy | - | >80% |
| Win rate vs Basic | - | >55% |
| Games/second (sim) | ~300 | ~50 (with Python overhead) |

### Analyze Results

```bash
# Count wins from log output
grep -c "NN wins" *.log
grep -c "BasicAgent wins" *.log
grep -c "Draw" *.log
```

---

## State Tensor Representation

| Channel | Description |
|---------|-------------|
| 0-7 | Friendly unit types (army, fighter, bomber, transport, destroyer, submarine, carrier, battleship) |
| 8 | Friendly units (aggregate) |
| 9 | Enemy units (aggregate) |
| 10 | Terrain (1 for Ocean, 0 for Land) |
| 11 | My cities |
| 12 | Enemy cities |
| 13 | My bomber blast radius |

**Shape**: `[14, H+2, W]` — includes ice cap rows at y=0 and y=H-1

---

## Action Space

| Action | Description |
|--------|-------------|
| `END_TURN` | Finish all actions |
| `SET_PRODUCTION` | Set city production (requires city ID + unit type) |
| `MOVE` | Move unit (requires unit ID + destination) |
| `LOAD` | Load army onto transport |
| `UNLOAD` | Unload cargo |
| `SLEEP` | Sleep unit |
| `WAKE` | Wake sleeping unit |
| `SKIP` | Skip this unit |
| `DISBAND` | Disband unit (not yet implemented) |

---

## Complete Training Loop

```bash
# 1. Collect baseline data
DATA_DIR=./data NUM_GAMES=1000 WORKERS=8 npm run collect

# 2. Train initial model (Python)
cd ai
python train.py --data-dir ./data/training --epochs 50

# 3. Export to ONNX (Python)
python export_onnx.py --checkpoint ./checkpoints/best_model.pt --output ./checkpoints/adam.onnx

# 4. Playtest vs BasicAgent (JavaScript)
cd ..
DATA_DIR=tmp NUM_GAMES=8 MAX_TURNS=300 P1AGENT=basicAgent P2AGENT=nnAgent:adam npm run record

# 5. Neuroevolution - evolve NN weights (JavaScript, fast!)
npm run nn-evolve -- \
  --base ./ai/checkpoints/best_model.pt \
  --pop 30 --gens 50 --games-per-agent 5 --workers 8 \
  --output ./ai/evolved

# 6. Export champion to standalone ONNX
# (Manually apply champion perturbations to base, export via Python)
python ai/evolve_export.py --checkpoint ./ai/checkpoints/best_model.pt \
  --output ./checkpoints/bob.onnx --perturbations "$(cat ./ai/evolved/champion.json | jq -r '.perturbations')"

# 7. Play vs evolved NN
DATA_DIR=tmp NUM_GAMES=8 MAX_TURNS=300 P1AGENT=nnAgent:bob P2AGENT=basicAgent npm run record
```

## Training Workflow Summary

```
Supervised Training (imitation)
    ↓
Export to ONNX
    ↓
Neuroevolution (ES fine-tuning)
    ↓
Evolved NN (better than baseline)
```

---

## Disk Space Requirements

| Component | Size |
|-----------|------|
| Per-worker states (1500 games) | ~200 MB |
| 8 workers total | ~1.6 GB |
| Checkpoints | ~50 MB |
| Combined datasets | ~2-5 GB |

---

## Troubleshooting

### Low Action Accuracy (<60%)
- Collect more data (2000+ games)
- Increase epochs (100+)
- Check data quality (are games too short?)

### Overfitting (train_acc >> val_acc)
- Reduce model size
- Add dropout
- Collect more diverse data

### NN Loses to BasicAgent
- Run genetic evolution first
- Use evolved agent data for training
- Increase training diversity

### nnAgent: Model Not Found
```
Error: ENOENT: no such file or directory, open '.../checkpoints/adam.onnx'
```
- Verify model exists: `ls packages/trainer/ai/checkpoints/adam.onnx`
- Export from checkpoint: `python export_onnx.py --checkpoint best_model.pt --output checkpoints/adam.onnx`

### nnAgent: Async Initialization
The `record` script now supports async NnAgent initialization automatically. No special handling needed.

---

## Next Steps

1. **Phase 1-2**: Collect data, train baseline model
2. **Phase 3**: Iterate with more data
3. **Phase 4**: Evolve with genetic programming
4. **Phase 5-6**: Evaluate NN vs NN and vs BasicAgent

---

## nnAgent Command Reference

### Export Model to ONNX
```bash
cd packages/trainer/ai
python export_onnx.py --checkpoint ./checkpoints/best_model.pt --output ./checkpoints/adam.onnx
```

### Playtest NN Agent
```bash
cd packages/trainer
DATA_DIR=tmp NUM_GAMES=8 MAX_TURNS=300 P1AGENT=basicAgent P2AGENT=nnAgent:adam npm run record
npm run replay  # View replays
```

### Continue Training with NN Data
```bash
# Record NN agent games
DATA_DIR=/Volumes/500G/NN_Data NUM_GAMES=500 P1AGENT=nnAgent:adam npm run collect

# Retrain
python train.py --data-dir /Volumes/500G/NN_Data/training --out-dir ./checkpoints --epochs 50 --resume ./checkpoints/best_model.pt
```

### Neuroevolution (Evolve NN Weights)
```bash
cd packages/trainer
npm run nn-evolve -- --checkpoint ./ai/checkpoints/best_model.pt --pop 30 --gens 50 --output ./ai/evolved
```
