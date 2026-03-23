# Neural Network Agent Design for Strategic Conquest

## Overview

This document outlines the design for a neural network-based agent that can play Strategic Conquest. The agent will use a Model-of-Experts (MoE) architecture where a central "Runner" coordinates decisions by querying specialized neural network models.

## Key Design Principles

### 1. Model-of-Experts (MoE) Architecture

Rather than a single monolithic network, we'll use specialized experts:

| Expert | Input | Output | Purpose |
|--------|-------|--------|---------|
| **CommanderExpert** | Global state (macro map view) | Strategy latent vector | Decide high-level strategy (economy vs defense vs attack) |
| **CityProductionExpert** | City state + economic context + Strategy vector | Unit type probability distribution | Decide what to build in a city |
| **UnitMovementExpert** | Unit state + visible map + Strategy vector | Move destination probability | Decide where a unit should move |
| **CombatTargetExpert** | Unit state + enemy units + Strategy vector | Target selection probability | Decide which enemy to attack |
| **TransportLoadExpert** | Transport state + army units + Strategy vector | Cargo assignment probability | Decide which units to load |
| **TransportUnloadExpert** | Transport state + target map + Strategy vector | Unload location probability | Decide where to unload cargo |

### 2. State Representation

The state fed to the NN should be:
- **Normalized** (values scaled to 0-1 range)
- **Fixed-size tensors** (NNs require fixed input dimensions)
- **Meaningful features** (capturing strategic relevance)
- **Fog-of-war aware** (only visible information)

### 3. Action Space

Actions can be:
- **Discrete** (classification): Select from predefined options
- **Continuous** (regression): Direct coordinate output
- **Mixed**: Classification for "what" + regression for "where"

## Architecture Details

### State Encoder (Spatial CNN Grid)

To allow the neural network to inherently understand spatial relationships, bottlenecks, and distances, the state is represented as a 3D tensor `[Channels × MapHeight × MapWidth]`. This is fed into Convolutional Neural Networks (CNNs) using circular padding on the X-axis for the cylindrical map.

```
Input: Game State Tensor
  ├─ Channel 1: Friendly Infantry (1 if present, 0 otherwise)
  ├─ Channel 2: Friendly Tanks
  ├─ Channel 3: Friendly Fighters
  ├─ Channel 4: Friendly Bombers
  ├─ Channel 5: Friendly Transports
  ├─ Channel 6: Friendly Submarines
  ├─ Channel 7: Friendly Destroyers
  ├─ Channel 8: Friendly Cruisers
  ├─ Channel 9: Friendly Battleships
  ├─ Channel 10: Friendly Carriers
  ├─ Channel 11: Friendly Cities
  ├─ Channel 12: Visible Enemy Units (aggregate or separate channels)
  ├─ Channel 13: Visible Enemy Cities
  ├─ Channel 14: Terrain (1 for Ocean, 0 for Land)
  ├─ Channel 15: Fog of War (1 for visible, 0 for hidden)
  └─ Global Features (Appended to flattened CNN output):
     ├─ Turn number (normalized)
     ├─ Current player (1-hot)
     ├─ Friendly/Enemy unit counts
     └─ Strategy Latent Vector (from CommanderExpert)
```

### Action Decoder

```
Output: Action Selection
  ├─ Action Type (1-hot: 8 values)
  │  ├─ END_TURN
  │  ├─ SET_PRODUCTION
  │  ├─ MOVE
  │  ├─ LOAD
  │  ├─ UNLOAD
  │  ├─ SLEEP
  │  ├─ WAKE
  │  └─ SKIP
  ├─ Target ID (if applicable)
  │  ├─ City ID (for SET_PRODUCTION)
  │  ├─ Unit ID (for MOVE/LOAD/UNLOAD/SLEEP/WAKE/SKIP)
  │  └─ Target Unit ID (for LOAD)
  └─ Destination (x, y) coordinates (for MOVE/UNLOAD)
```

## Runner Architecture

The Runner is the central coordinator that:

1. **Maintains Game State**: Tracks the current game state from server updates
2. **Manages Turn Flow**: Knows when it's the agent's turn
3. **Orchestrates Experts**: Calls the appropriate expert(s) to make decisions
4. **Handles Constraints**: Validates that actions are legal before sending
5. **Manages Memory**: Tracks history for better decision-making

### Runner Flow

```
1. Receive batched stateUpdates from simulation environment
2. Check if it's my turn
3. If yes, pass global state to CommanderExpert to generate Strategy Vector
4. Scan for pending decisions across the batch:
   a. Find units with moves left → UnitMovementExpert (conditioned on Strategy Vector)
   b. Find cities without production → CityProductionExpert (conditioned on Strategy Vector)
   c. Check for transport loading opportunities → TransportLoadExpert
   d. Check for transport unloading opportunities → TransportUnloadExpert
5. For each decision needed:
   a. Extract relevant spatial/CNN slice for the expert
   b. Call expert NN model (batched across multiple games)
   c. Sample action from probability distribution
   d. Validate action legality (masking invalid moves)
   e. Send batched actions to environment
6. If no decisions needed, END_TURN
```

## Training Strategy

### Data Collection

1. **Self-Play**: Agent plays against itself or basic AI
2. **Expert Demonstrations**: Use existing BasicAgent/AdamAI as "teachers"
3. **Human Play**: Record human games for imitation learning

### Loss Functions

| Expert | Loss Function |
|--------|---------------|
| CityProduction | Cross-entropy (multi-class) |
| UnitMovement | Cross-entropy over tile grid OR MSE for coordinates |
| CombatTarget | Cross-entropy over enemy units |
| TransportLoad | Cross-entropy over eligible cargo units |
| TransportUnload | Cross-entropy over unload locations |

### Reward Structure (for RL)

```
Immediate Rewards:
  ├─ Unit destruction (+10)
  ├─ Enemy unit destroyed (+15)
  ├─ City capture (+50)
  ├─ Enemy city captured (-50)
  └─ Turn completion (-1, discourages slow play)

Long-term Rewards:
  ├─ Victory (+1000)
  ├─ Defeat (-1000)
  ├─ Territory control (per city: +5)
  └─ Unit preservation (per unit health: +1)
```

## Implementation Plan

### Phase 1: Foundation
1. Create state encoder/decoder utilities
2. Implement basic Runner with mock experts
3. Test with simple heuristics

### Phase 2: Expert Models
1. Implement CityProductionExpert
2. Implement UnitMovementExpert
3. Implement CombatTargetExpert

### Phase 3: Training Infrastructure
1. Set up data collection pipeline
2. Implement training loop
3. Add logging/monitoring

### Phase 4: Advanced Features
1. Add TransportLoad/Unload experts
2. Implement memory/history tracking
3. Add temperature scheduling for exploration

## Technical Considerations

### Framework Choice
- **PyTorch**: Good for research, flexible
- **TensorFlow.js**: Can run in browser for debugging
- **ONNX**: For model portability

### Input Preprocessing
- Padding for variable-length units/cities
- Masking for invalid actions
- Normalization per feature type

### Output Postprocessing
- Masking invalid actions (e.g., can't move to ocean with land unit)
- Temperature scaling for exploration vs exploitation
- Top-K sampling for diversity

### Simulator Bottleneck for Millions of Games
- **The Challenge**: A Python training loop cannot make a WebSocket call to a Node.js server for every single unit move. Network/IPC serialization latency would severely bottleneck RL training to just a few dozen actions per second.
- **Batched Inference**: The system needs a headless environment that can batch thousands of `step()` calls simultaneously. State updates and NN inference must be highly batched.
- **Engine Porting**: To truly scale RL, the core TypeScript game engine (`packages/shared/src/engine`) will likely need to be ported to C++ or JAX. This allows the simulation to run directly alongside PyTorch on the GPU/CPU in a highly vectorized manner, bypassing Node.js entirely during training.

### Performance Optimizations (During Training)
- Process expert decisions in large batches
- Pre-compute and cache CNN feature maps for the board; only crop/re-center the feature map around specific units when querying the UnitMovementExpert
- Async expert calls to avoid blocking the main simulation thread

## Open Questions

1. **Should we use a transformer architecture** for better sequence modeling of game state?
2. **How much state history** should the agent remember?
3. **Should experts be trained separately or jointly**?
4. **What's the right balance** between RL and supervised learning?
5. **How to handle the cylindrical map** (X-wrapping) in the NN?

## Next Steps

1. Review and iterate on this design
2. Define the exact state tensor shapes
3. Create mock expert implementations
4. Start collecting training data
