# Neural Network Agent Design for Strategic Conquest

## Overview

This document outlines the design for a neural network-based agent that can play Strategic Conquest. The current infrastructure supports:

1. **Genetic Algorithm** (TypeScript): Weight-vector genome evolution against `BasicAgent`
2. **Imitation Learning Data Collection**: Parallel (state, action) pair collection for supervised learning
3. **NN Training** (Python/PyTorch): Policy CNN trained on collected data

## Current Infrastructure

### Genetic Algorithm (`packages/trainer`)

- **Genome**: 28-weight vector over hand-crafted strategic features
- **Features**: Unit-level (10), Global strategic (8), Production per unit type (8)
- **Fitness**: Win bonus + turn speed + city/unit ratios - loss penalty
- **Parallelism**: Worker threads for population evaluation
- **Output**: `champion.json` — genome file usable by `EvolvedAgent`

### Imitation Learning (`packages/trainer/src/collect_data.ts`)

- **Workers**: Child processes (not worker threads — tsx doesn't transfer to workers reliably)
- **Output**:
  - `states.bin` — raw float32 bytes, shape `[N, 14, H, W]`
  - `actions.jsonl` — one action JSON per line
  - `meta.json` — map dimensions, channels, sample count, wins
- **Sampling**: Reservoir sampling (Algorithm R), max 3000 samples per game

### State Tensor Representation (14 channels)

The state is represented as a 3D tensor `[Channels × MapHeight × MapWidth]`:

| Channel | Description |
|---------|-------------|
| 1 | Friendly Army |
| 2 | Friendly Fighter |
| 3 | Friendly Bomber |
| 4 | Friendly Transport |
| 5 | Friendly Destroyer |
| 6 | Friendly Submarine |
| 7 | Friendly Carrier |
| 8 | Friendly Battleship |
| 9 | Friendly Cities |
| 10 | Visible Enemy Units (aggregate) |
| 11 | Visible Enemy Cities |
| 12 | Terrain (1 for Ocean, 0 for Land) |
| 13 | Fog of War (1 for visible, 0 for hidden) |
| 14 | Turn number (normalized) |

**Note**: The map includes ice cap rows at `y=0` and `y=mapHeight-1` (impassable), so actual tensor height is `H+2`.

### Action Space

Actions are discrete classifications:

| Action | Description |
|--------|-------------|
| `END_TURN` | Finish all actions |
| `SET_PRODUCTION` | Set city production (requires city ID + unit type) |
| `MOVE` | Move unit (requires unit ID + destination coordinates) |
| `LOAD` | Load army onto transport (requires unit ID + transport ID) |
| `UNLOAD` | Unload cargo (requires unit ID + destination coordinates) |
| `SLEEP` | Sleep unit until woken |
| `WAKE` | Wake sleeping unit |
| `SKIP` | Skip this unit for now |

## Architecture Options for NN Agent

### Option 1: Monolithic Policy CNN

Single network that outputs action probabilities over all possible actions.

**Pros**:
- Simple architecture
- End-to-end training
- Can learn feature representations automatically

**Cons**:
- Large action space (all tiles × all units)
- Hard to enforce action legality
- May struggle with long-horizon planning

### Option 2: Multi-Head Architecture

Separate output heads for different action components:

```
Policy CNN
  ├─ Action Type Head (8 classes)
  ├─ Target Tile Head (H × W grid)
  ├─ Unit ID Head (max units)
  └─ Production Type Head (8 unit types)
```

**Pros**:
- Modular design
- Easier to mask invalid actions
- Can train heads separately

**Cons**:
- More complex training
- Requires careful coordination between heads

### Option 3: Model-of-Experts (MoE)

Specialized experts for different decision types:

| Expert | Input | Output | Purpose |
|--------|-------|--------|---------|
| **CommanderExpert** | Global state | Strategy latent vector | High-level strategy |
| **CityProductionExpert** | City state + context | Unit type distribution | City production |
| **UnitMovementExpert** | Unit state + visible map | Move destination | Unit movement |
| **CombatTargetExpert** | Unit state + enemies | Target selection | Combat decisions |
| **TransportLoadExpert** | Transport state | Cargo assignment | Loading decisions |
| **TransportUnloadExpert** | Transport state | Unload location | Unloading decisions |

**Pros**:
- Specialized learning per task
- Easier to interpret decisions
- Can train experts separately

**Cons**:
- Complex coordination logic
- More data needed per expert
- Harder to transfer between contexts

## Training Strategy

### Phase 1: Imitation Learning (Bootstrapping)

1. Run 50,000+ headless games of `BasicAgent` vs `BasicAgent`
2. Collect (state, action) pairs via reservoir sampling
3. Pre-train policy network to mimic `BasicAgent` (~90% action accuracy)

### Phase 2: Reinforcement Learning

1. Transition to self-play or vs `BasicAgent`
2. Use policy gradient or PPO for fine-tuning
3. Reward shaping: +10 for unit kill, +50 for city capture, +1000 for victory

### Phase 3: Advanced Features

1. Add history/memory tracking
2. Implement attention over units/cities
3. Add temperature scheduling for exploration

## Technical Considerations

### Simulator Performance

- **TypeScript engine**: Runs headlessly at ~100-500 games/second (single-threaded)
- **Parallelism**: 8 workers → ~800-4000 games/second
- **Python overhead**: NN inference adds ~1-10ms per decision
- **Bottleneck**: For millions of games, consider porting engine to C++/JAX

### Action Masking

Invalid actions must be masked before sampling:

- Cannot move land units onto ocean
- Cannot attack sleeping units
- Cannot load non-army units onto transports
- Cannot set production on neutral cities
- Cannot move units with 0 moves left

### Cylindrical Map Handling

The map wraps east-west. For CNN processing:

- Use circular padding on X-axis
- Convolution kernels respect wraparound
- Pooling operations handle edge tiles correctly

## Next Steps

1. **Choose architecture**: Monolithic vs multi-head vs MoE
2. **Implement state converter**: `PlayerView` → Float32Array (already exists in `tensorUtils.ts`)
3. **Build Python training loop**: PyTorch model + data loader
4. **Benchmark games/second**: Measure inference throughput
5. **Start with imitation learning**: Bootstrap from `BasicAgent`
6. **Transition to RL**: Fine-tune with self-play
