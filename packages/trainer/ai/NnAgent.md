# Neural Network Agent

The NN agent uses a trained PyTorch model to make decisions during gameplay.

## Architecture

```
State Tensor (14×H×W) → PolicyCNN → Action Distribution
                                           ↓
                              Sample argmax / multinomial
                                           ↓
                                    Game Action
```

## Integration Points

### 1. State Encoding (TypeScript)

`packages/shared/src/engine/tensorUtils.ts` converts `PlayerView` → `Float32Array`:

```typescript
const tensor = playerViewToTensor(view);
// Shape: [14, H+2, W] - flattened to Float32Array
```

**Channels**:
- 0-7: Unit types (army, fighter, bomber, transport, destroyer, submarine, carrier, battleship)
- 8: Friendly units
- 9: Enemy units
- 10: Terrain (land/ocean)
- 11: My cities
- 12: Enemy cities
- 13: My bomber blast radius

### 2. Model Inference (Python)

```python
from ai.dataset import PolicyCNN
import torch

# Load model
model = PolicyCNN(channels=14, map_height=22, map_width=50)
model.load_state_dict(torch.load('checkpoints/best_model.pt')['model_state'])
model.eval()

# Run inference
state = torch.FloatTensor(tensor).unsqueeze(0)  # Add batch dim
with torch.no_grad():
    out = model(state)

# Extract predictions
action_type_idx = out['action_type'].argmax().item()
target_tile_idx = out['target_tile'].argmax().item()
prod_type_idx = out['prod_type'].argmax().item()
```

### 3. Decode Action

```python
ACTION_TYPES = ['END_TURN', 'SET_PRODUCTION', 'MOVE', 'LOAD', 'UNLOAD', 'SLEEP', 'WAKE', 'SKIP', 'DISBAND']
UNIT_TYPES = ['army', 'fighter', 'bomber', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship']

action_type = ACTION_TYPES[action_type_idx]

if action_type == 'MOVE':
    x = target_tile_idx % map_width
    y = target_tile_idx // map_width
    return {'type': 'MOVE', 'unitId': unit_id, 'to': {'x', 'y'}}

elif action_type == 'SET_PRODUCTION':
    unit_type = UNIT_TYPES[prod_type_idx]
    return {'type': 'SET_PRODUCTION', 'cityId': city_id, 'unitType': unit_type}

else:
    return {'type': action_type}
```

## Running NN vs BasicAgent

```bash
cd packages/trainer
npm run nn-sim
```

This runs simulated games between the NN agent and BasicAgent over a Unix domain socket.

## Training Loop

```bash
# Train for 50 epochs
python train.py --data-dir /Volumes/500G/Training/training --epochs 50

# Monitor training
watch -n 1 'tail checkpoints/training.log'
```

## Expected Performance

| Metric | BasicAgent | NN Agent (target) |
|--------|------------|-------------------|
| Action accuracy | - | >60% |
| Win rate vs Basic | - | >55% |

## Next Steps

1. **Collect data** - Run 1000+ BasicAgent vs BasicAgent games
2. **Train model** - 50 epochs, monitor validation loss
3. **Evaluate** - Run NN vs BasicAgent tournaments
4. **Iterate** - Collect more data from NN games, retrain
