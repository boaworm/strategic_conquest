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

### Movement experts (×8)

One model per unit type: `army`, `fighter`, `missile`, `transport`, `destroyer`,
`submarine`, `carrier`, `battleship`.

**Input:** 15 channels × H × W
- Channels 0–13: standard `playerViewToTensor` output (identical to `NnAgent`)
- Channel 14: unit-position marker — 1.0 at the acting unit's tile, 0 elsewhere

**Output heads:**
- `action_type` — logits over `[MOVE, SLEEP, SKIP, LOAD, UNLOAD]` (only the subset
  valid for the unit type is used at inference; invalid actions are masked to −∞)
- `target_tile` — logits over H×W (used when action_type = MOVE or UNLOAD)

**Backbone:** 3 conv layers with cylindrical X-padding, BatchNorm, ReLU; action head via global-avg-pool → MLP; tile head via 1×1 conv.

### Production expert (×1)

**Input:** 15 channels × H × W + global feature vector (28 values)

Spatial channels:
- Channels 0–13: `playerViewToTensor` output
- Channel 14: city-position marker — 1.0 at the city being queried

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
  For each unit (movesLeft > 0, not sleeping, not carriedBy):
    action = movementExperts[unit.type].act(mapTensor + unitMarkerChannel)
    apply action
    if SLEEP or SKIP: move on to next unit
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

The `collect_moe.ts` script records `(state_tensor_14ch, action)` with per-unit-type metadata:
- `unitType` — which unit type took this action (for movement experts)
- `unitX`, `unitY` — unit position (to build channel 14 at training time)
- `cityX`, `cityY` — for SET_PRODUCTION actions
- `globalFeatures` — 28-value vector (for production expert only)

Outputs per-unit-type files:
```
training/moe/army.states.bin       # 14-ch tensors
training/moe/army.positions.bin    # (x, y) int16 pairs
training/moe/army.actions.jsonl
... (×8 for each unit type)
training/moe/production.states.bin
training/moe/production.cities.bin  # (x, y) int16 pairs
training/moe/production.globals.bin # float32 28-value vectors
training/moe/production.actions.jsonl
```

The 14-ch tensor is stored without the unit-marker channel; the marker is synthesised at training time from the saved position.

---

## Training scripts

### `train_2.2_learn_moe.sh`

```bash
./train_2.2_learn_moe.sh army       # Train army movement expert
./train_2.2_learn_moe.sh production # Train production expert
```

Internally calls `train_movement.py` or `train_production.py` with 8 worker files.

### Python training scripts

**Movement expert:**
```bash
python train_movement.py \
    --unit-type army \
    --data-dir /Volumes/500G/Training/moe \
    --out-dir ./checkpoints/moe \
    --epochs 50
```

**Production expert:**
```bash
python train_production.py \
    --data-dir /Volumes/500G/Training/moe \
    --out-dir ./checkpoints/moe \
    --epochs 50
```

Both scripts:
- Train incrementally across 8 worker files (warm-start from previous checkpoint)
- Save `<type>.pt` checkpoint in `checkpoints/moe/`
- Export `<type>.onnx` (with external data merged inline)
- The `.onnx` file can be copied to long-term storage manually

---

## Neuroevolution

`train_3_evolve_moe.sh` runs neuroevolution on MoE models:
- Perturbs all 9 models simultaneously (or per-expert for fine-grained search)
- Evaluates via `eval_game.js --agent moe --moe-dir <dir>`
- Saves champion as `champion.json` with perturbations

---

## Status

- [x] `nnMoEAgent.ts` — full implementation, wired into agent selector
- [x] `collect_moe_worker.ts` + `collect_moe_data.ts` — per-unit-type data collection
- [x] `dataset_moe.py` — Python dataset loaders (MovementDataset, ProductionDataset)
- [x] `train_movement.py` — movement expert training + ONNX export
- [x] `train_production.py` — production expert training + ONNX export
- [x] `train_1.2_collect_moe.sh` + `train_2.2_learn_moe.sh` — shell scripts
- [x] `eval_game.js` — supports `--agent moe --moe-dir <dir>`
- [x] `game_evaluator.py` — `run_games_moe_sequential(moe_dir, ...)`
- [x] `models_moe.py` — shared `MovementCNN` + `ProductionCNN` definitions
- [x] `evolve_moe.py` — full neuroevolution for 9-model ensemble
- [x] `train_3_evolve_moe.sh` — shell script
