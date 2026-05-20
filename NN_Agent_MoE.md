# MoE Neural Network Agent — Design Document

## Overview

Two agent architectures exist side-by-side:

| Agent | Env var | Description |
|-------|---------|-------------|
| `NnAgent` | `player1=nnAgent:<model>` | Single dense CNN, trained end-to-end |
| `NnMoEAgent` | `player1=nnMoEAgent:<dir>` | 9 specialist models (8 movement + 1 production) |

`<dir>` is a directory containing the 9 ONNX files (see Filenames below).

---

## Architecture

### Base tensor channel layout (channels 0–12)

`playerViewToTensor` / `fillViewTensor` produces 13 channels:

| Ch | Description |
|----|-------------|
| 0–7 | Friendly unit types (army…battleship) — health-clamped accumulation |
| 8 | Cities: 1.0 = friendly, −0.5 = neutral/uncaptured, −1.0 = enemy, 0 = no city |
| 9 | Visible enemy units — health-clamped accumulation |
| 10 | Terrain: 1 = Land, 0 = Ocean |
| 11 | Fog of war: 1 = visible, 0.5 = previously seen, 0 = hidden |
| 12 | Global turn ÷ 1000 (broadcast over all tiles) |

Channels 13+ are written by the caller (agent or dataset loader), not by `fillViewTensor`.

### Movement experts (×8)

One model per unit type: `army`, `fighter`, `missile`, `transport`, `destroyer`,
`submarine`, `carrier`, `battleship`.

**Input:** 17 channels × H × W
- Channels 0–12: `fillViewTensor` output (13 base channels)
- Channel 13: unit-position marker — 1.0 at the acting unit's tile, 0 elsewhere
- Channel 14: carried/cargo flag — army: 1.0 if aboard a transport; transport: cargo count ÷ 6; 0 for all other unit types
- Channel 15: dx — cylindrical-wrapped relative X from the unit to each tile, normalised to [−0.5, 0.5]
- Channel 16: dy — relative Y from the unit to each tile, normalised to (−1, 1)

**Output heads:**
- `action_type` — logits over `[MOVE, SKIP]` (invalid actions are masked to −∞)
- `target_tile` — logits over H×W (used when action_type = MOVE)

**Backbone:** 3 conv layers with cylindrical X-padding, BatchNorm, ReLU; action head via global-avg-pool → MLP; tile head via 1×1 conv over per-tile features concatenated with broadcast global-avg-pool context (256→1).

### Production expert (×1)

**Input:** 15 channels × H × W + global feature vector (28 values)

Spatial channels:
- Channels 0–12: `fillViewTensor` output (13 base channels)
- Channel 13: city-position marker — 1.0 at the city being queried
- Channel 14: unused (zero)

Global features (28-value vector):
| Index | Feature |
|-------|---------|
| 0–7 | My unit counts by type (army…battleship), normalised ÷ 20 |
| 8–15 | Visible enemy unit counts by type, normalised ÷ 20 |
| 16 | My city count ÷ total cities |
| 17 | Total cities ÷ 30 |
| 18 | Turn ÷ maxTurns (÷ 300) |
| 19 | `productionTurnsLeft` ÷ 10 |
| 20 | 1 if city is coastal (can build naval), else 0 |
| 21 | Combat contact flag (enemy units or cities visible) |
| 22 | Cities producing Army count ÷ 10 |
| 23 | Fighter count ÷ 20 |
| 24 | Missile count ÷ 20 |
| 25 | Army count ÷ 20 |
| 26 | min(Fighter, Missile, Army) count ÷ 20 |
| 27 | Bias (constant 1.0) |

**Output:** `unit_type` — logits over 8 unit types

---

## ONNX file naming convention

All files live in a single `<dir>` directory:

```
army.onnx
fighter.onnx
missile.onnx
transport.onnx
destroyer.onnx
submarine.onnx
carrier.onnx
battleship.onnx
production.onnx
```

Note: `missile.onnx` (not `bomber.onnx`) — the unit type is `missile`.

---

## Game-runner logic (`NnMoEAgent.act`)

The agent uses a three-phase turn structure:

```
Phase 1 — Production (end of turn):
  For each city where producing === null:
    action = productionExpert.act(mapTensor + cityMarkerChannel + globalFeatures)
    apply SET_PRODUCTION

Pass 1 — Free armies → sea units → air units:
  For each unit (movesLeft > 0, not carriedBy):
    action = movementExperts[unit.type].act(mapTensor + unitMarkerChannel)
    apply action
    if SKIP: move on to next unit
    loop until unit.movesLeft == 0

Pass 2 — Carried armies (disembark after transports have moved):
  Same loop, only for army units with carriedBy != null
```

Unit ordering in Pass 1:
1. Free armies (board transports first)
2. Sea units (transport, destroyer, submarine, carrier, battleship)
3. Air units (fighter, missile)

---

## Data collection

The `collect_moe_worker.ts` script records `(state_tensor_13ch, action)` with per-unit-type metadata:
- `unitType` — which unit type took this action (for movement experts)
- `unitX`, `unitY` — unit position (to build channel 13 marker at training time)
- `cityX`, `cityY` — for SET_PRODUCTION actions
- `globalFeatures` — 28-value vector (for production expert only)

Outputs per-unit-type files:
```
worker-{i}-army.states.bin        # 13-ch tensors
worker-{i}-army.positions.bin     # (x, y) int16 pairs
worker-{i}-army.actions.bin       # uint8 action index
worker-{i}-army.tiles.bin         # int32 target tile index
worker-{i}-army.carried.bin       # uint8 carried-by-transport flag (army only)
... (×8 for each unit type, carried.bin only for army)
worker-{i}-production.states.bin
worker-{i}-production.cities.bin  # (x, y) int16 pairs
worker-{i}-production.globals.bin # float32 28-value vectors
worker-{i}-production.unitTypes.bin
```

The 13-ch tensor is stored without the marker channels; ch13 (position marker), ch14 (carried/cargo flag) and ch15/ch16 (dx/dy relative position) are synthesised at training time by `dataset_moe.py`. The runtime agent (`nnMoEAgent.ts`) synthesises the same channels for the ONNX path; the MPS sidecar receives 15 channels and derives ch15/ch16 itself.

**Map height convention**: `MAP_HEIGHT` in `train_1.2_collect_moe.sh` refers to **playable rows**. The engine automatically adds one ice cap row at top and one at bottom, so the actual tensor height is `MAP_HEIGHT + 2`. Example: `MAP_HEIGHT=20` → 22-row tensor (rows 0 and 21 are impassable ice).

---

## Training scripts

### Collection — `train_1_collect_moe.sh`

```bash
DATA_DIR=/media/henrik/data/ARMY ./train_1_collect_moe.sh              # All movement experts + production (~50G/worker total)
DATA_DIR=/media/henrik/data/ARMY ./train_1_collect_moe.sh army         # Army only
DATA_DIR=/media/henrik/data/ARMY ./train_1_collect_moe.sh production   # Production only
```

Stop condition: sum of all unit-type states files per worker reaches `TARGET_SIZE_GB` (default 50G). Output goes into a new `sample_N/` subdirectory under `DATA_DIR`. Runs on CPU via Node.js — no GPU or Docker needed.

### Training — `train_2_learn_moe.sh`

```bash
# Train all 9 experts sequentially
RESUME=0 DATA_DIR=/media/henrik/data/ARMY/sample_1 ./train_2_learn_moe.sh

# Train specific experts only
RESUME=1 DATA_DIR=/media/henrik/data/ARMY/sample_1 ./train_2_learn_moe.sh army
RESUME=1 DATA_DIR=/media/henrik/data/ARMY/sample_1 ./train_2_learn_moe.sh destroyer carrier submarine battleship
RESUME=1 DATA_DIR=/media/henrik/data/ARMY/sample_1 ./train_2_learn_moe.sh production
```

`RESUME` is required:
- `RESUME=0` — train from scratch
- `RESUME=1` — warm-start from existing checkpoint (safe to use even if no checkpoint exists yet)

**GB10 DGX Spark**: auto-detected via `nvidia-smi`. Runs inside the `sc-train` NGC Docker container (build once with `./build_docker.sh`). One container for the entire run; torch.compile warms up once and is reused across all files and unit types.

**Apple Silicon / other**: runs directly via `python` (activate `sc_env` first).

Trains each expert across 8 worker files sequentially (warm-starting from the previous file's checkpoint). One expert fully trained before the next starts.

### Docker setup (GB10 only)

```bash
./build_docker.sh   # Build sc-train image from Dockerfile.train (run once, or after dep changes)
```

The image extends `nvcr.io/nvidia/pytorch:25.12-py3` and adds the project's extra Python deps. The torch.compile kernel cache persists across runs in `tmp/torch_cache/` (host-mounted into the container).

### Python training scripts

Called internally by `train_2_learn_moe.sh`. Can also be run directly (with `sc_env` active):

**Movement expert:**
```bash
python train_movement.py \
    --unit-type army \
    --data-dir /media/henrik/data/ARMY/sample_1 \
    --out-dir ./checkpoints/moe \
    --epochs 40 \
    --num-files 8 \
    --target-vram-usage-gb 100
```

**Production expert:**
```bash
python train_production.py \
    --data-dir /media/henrik/data/ARMY/sample_1 \
    --out-dir ./checkpoints/moe \
    --epochs 40 \
    --num-files 8
```

`--num-files N` loops through worker files 0..N-1 in a single Python process (avoids torch.compile recompilation between files). `--resume` warm-starts from an existing checkpoint.

Both scripts:
- Train incrementally across worker files (warm-start from previous checkpoint)
- Save `<type>.pt` checkpoint in `checkpoints/moe/`
- Export `<type>.onnx` (external data merged inline, no `.onnx.data` sidecar)

### Preserving a trained model

The working checkpoint lives in `checkpoints/moe/`. After training a unit type, copy the new files into the named model directory to preserve them. Example using transport training data:

```bash
# Run from: packages/trainer/ai/
# Replace transport expert in caesar-moe-v2.0
cp checkpoints/moe/transport.onnx \
   checkpoints/moe/transport.onnx.data \
   checkpoints/moe/transport.pt \
   checkpoints/caesar-moe-v2.0/
```

Files to copy per unit type:
- `checkpoints/moe/<type>.onnx` — required (runtime inference)
- `checkpoints/moe/<type>.onnx.data` — required if it exists (external weights; present for `transport`, `production`, `army` — check before copying)
- `checkpoints/moe/<type>.pt` — required (PyTorch checkpoint, needed for future training/evolution)

Named model directories live under `checkpoints/` (e.g. `checkpoints/caesar-moe-v2.0/`). The directory name is what you pass to `nnMoEAgent:<dir>` or `--moe-dir`.

---

## Neuroevolution

`train_3_evolve_moe.sh` runs neuroevolution on MoE models:
- Perturbs all 9 models simultaneously (or per-expert for fine-grained search)
- Evaluates via `eval_game.js --agent moe --moe-dir <dir>`
- Saves champion as `champion.json` with perturbations

Output directory defaults to `/Volumes/500G/Training/evolution_moe` (Mac). Override on GB10:
```bash
EVOLUTION_OUT_DIR=/media/henrik/data/evolution_moe ./train_3_evolve_moe.sh
```

---

## Status

- [x] `nnMoEAgent.ts` — full implementation, wired into agent selector
- [x] `collect_moe_worker.ts` + `collect_moe_data.ts` — per-unit-type data collection
- [x] `dataset_moe.py` — Python dataset loaders (MovementDataset, ProductionDataset)
- [x] `train_movement.py` — movement expert training + ONNX export
- [x] `train_production.py` — production expert training + ONNX export
- [x] `train_1_collect_moe.sh` — collection (all types or single type, sum-based stop)
- [x] `train_2_learn_moe.sh` — train all 9 experts (or subset) sequentially; GB10 auto-uses NGC Docker
- [x] `eval_game.js` — supports `--agent moe --moe-dir <dir>`
- [x] `game_evaluator.py` — `run_games_moe_sequential(moe_dir, ...)`
- [x] `models_moe.py` — shared `MovementCNN` + `ProductionCNN` definitions
- [x] `evolve_moe.py` — full neuroevolution for 9-model ensemble
- [x] `train_3_evolve_moe.sh` — shell script
