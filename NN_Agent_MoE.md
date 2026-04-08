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

One model per unit type: `army`, `fighter`, `bomber`, `transport`, `destroyer`,
`submarine`, `carrier`, `battleship`.

**Input:** 15 channels × H × W
- Channels 0–13: standard `playerViewToTensor` output (identical to `NnAgent`)
- Channel 14: unit-position marker — 1.0 at the acting unit's tile, 0 elsewhere

**Output heads:**
- `action_type` — logits over `[MOVE, SLEEP, SKIP, LOAD, UNLOAD]` (only the subset
  valid for the unit type is used at inference; invalid actions are masked to −∞)
- `target_tile` — logits over H×W (used when action_type = MOVE or UNLOAD)

**Backbone:** identical to `NnAgent` — 3 conv layers with cylindrical X-padding,
BatchNorm, ReLU; action head via global-avg-pool → MLP; tile head via 1×1 conv.

### Production expert (×1)

**Input:** 15 channels × H × W + global feature vector (22 values)

Spatial channels:
- Channels 0–13: `playerViewToTensor` output
- Channel 14: city-position marker — 1.0 at the city being queried

Global features (concatenated with backbone output after global-avg-pool):
| Index | Feature |
|-------|---------|
| 0–7 | My unit counts by type (army…battleship), normalised ÷ 20 |
| 8–15 | Visible enemy unit counts by type, normalised ÷ 20 |
| 16 | My city count ÷ total cities |
| 17 | Total cities ÷ 30 |
| 18 | Turn ÷ maxTurns |
| 19 | `productionTurnsLeft` ÷ 10 |
| 20 | 1 if city is coastal (can build naval), else 0 |
| 21 | Bias (constant 1.0) |

**Output:** `unit_type` — logits over 8 unit types

---

## ONNX file naming convention

All files live in a single `<dir>` directory:

```
army.onnx
fighter.onnx
bomber.onnx
transport.onnx
destroyer.onnx
submarine.onnx
carrier.onnx
battleship.onnx
production.onnx
```

---

## Game-runner logic (`NnMoEAgent.act`)

The agent mirrors `BasicAgent`'s two-pass unit ordering (from `basicAgent.ts`):

```
Pass 1 — free armies (board transports first) → sea units → air units
  For each unit (movesLeft > 0, not sleeping, not carriedBy):
    action = movementExperts[unit.type].act(mapTensor + unitMarkerChannel)
    apply action
    if SLEEP or SKIP: move on to next unit
    loop until unit.movesLeft == 0

Pass 2 — carried armies (disembark after transports have moved)
  Same loop, only for army units with carriedBy != null

Production (end of turn):
  For each city where producing === null:
    action = productionExpert.act(mapTensor + cityMarkerChannel + globalFeatures)
    apply SET_PRODUCTION
```

---

## Data collection

The existing `collect_worker.ts` records `(state_tensor_14ch, action)` for all
actions from BasicAgent-vs-BasicAgent games.

For MoE training we need per-sample metadata:
- `unitType` — which unit type took this action (for movement experts)
- `unitX`, `unitY` — unit position (to build channel 14 at training time)
- `cityX`, `cityY` — for SET_PRODUCTION actions
- `globalFeatures` — 22-value vector (for production expert only)

### New collection script: `collect_moe.ts`

Outputs per-unit-type files:
```
training/moe/army.states.bin       # 14-ch tensors
training/moe/army.positions.bin    # (x, y) int16 pairs
training/moe/army.actions.jsonl
... (×8 for each unit type)
training/moe/production.states.bin
training/moe/production.cities.bin  # (x, y) int16 pairs
training/moe/production.globals.bin # float32 22-value vectors
training/moe/production.actions.jsonl
```

The 14-ch tensor is stored without the unit-marker channel; the marker is
synthesised at training time from the saved position. This saves disk space.

---

## Training scripts

### `train_movement.py`

```
python train_movement.py \
    --unit-type army \
    --data-dir /Volumes/500G/Training/moe \
    --out-dir ./checkpoints/moe \
    --epochs 50
```

Trains one model, saves `checkpoints/moe/army.pt` + exports `army.onnx`.

### `train_production.py`

```
python train_production.py \
    --data-dir /Volumes/500G/Training/moe \
    --out-dir ./checkpoints/moe \
    --epochs 50
```

Saves `checkpoints/moe/production.pt` + exports `production.onnx`.

---

## Evolution

`train_3_evolve.sh` can be pointed at either agent type.
For MoE evolution, the perturbation applies to all 9 models simultaneously
(or optionally to one at a time for fine-grained search — TBD).

---

## Status

- [x] `nnMoEAgent.ts` — full implementation, wired into agent selector
- [x] `collect_moe_worker.ts` + `collect_moe_data.ts` — per-unit-type data collection
- [x] `dataset_moe.py` — Python dataset loaders
- [x] `train_movement.py` — movement expert training + ONNX export
- [x] `train_production.py` — production expert training + ONNX export
- [x] `train_1_collect_moe.sh` + `train_2_learn_moe.sh` — shell scripts
- [x] `eval_game.js` — supports `--agent moe --moe-dir <dir>`
- [x] `game_evaluator.py` — `run_games_moe_sequential(moe_dir, ...)`
- [x] `models_moe.py` — shared `MovementCNN` + `ProductionCNN` definitions
- [x] `evolve_moe.py` — full neuroevolution for 9-model ensemble
- [x] `train_3_evolve_moe.sh` — shell script
