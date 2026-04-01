# Quickstart

## Test Cases

### Running individual tests

```bash
npx tsx packages/shared/src/test_exploreAndExpand_3.ts
npx tsx packages/shared/src/test_transportEarlyDeparture.ts
```

### View test replays

```bash
# Run all tests and open the most recent replay
npm run test_replay

# View specific replay
npx tsx packages/trainer/src/replay.ts tmp/test-*.json
```

### Adding a new test

1. Create a new test file in `packages/shared/src/test_*.ts`
2. Use the `runTest()` helper from `testRunner.ts`
3. Define a `victoryCondition` that checks the expected outcome
4. Add the test to `packages/trainer/src/test_replay_picker.ts`

Example:
```typescript
import { runTest } from './testRunner.js';
import { UnitType, Terrain } from './index.js';

async function main() {
  const result = await runTest(
    {
      testName: 'My Test',
      mapConfig: { /* ... */ },
      cities: [ /* ... */ ],
      units: [ /* ... */ ],
      maxTurns: 50,
      exploredTiles: [ /* ... */ ],
      victoryCondition: (state) => {
        // Return true when test passes
        return state.units.some(u => u.type === UnitType.Army);
      },
    },
    { verbose: true, saveReplay: true, agentPlayer: 'player1' },
  );
  process.exit(result.passed ? 0 : 1);
}
```

## Prerequisites

- Node.js 18+
- npm 9+

## Install

```bash
npm install
```

## Start the server (build + run)

```bash
npm start
```

This builds the shared library and client, then starts the server on **http://localhost:4000**.

## Development mode (auto-rebuild on change)

```bash
npm run dev
```

## Custom port

```bash
npx tsx packages/server/src/index.ts --port 8080
```

## Play a game

1. Open http://localhost:4000
2. Click **Create Game** — you'll receive three tokens (admin, player 1, player 2)
3. Copy the **Player 2 token** and share it with your opponent
4. Both players enter their token and click **Join**
5. Game starts when both players are connected

## Train an AI

```bash
# Quick test run
npx tsx packages/trainer/src/index.ts --pop 20 --gens 10

# Full training
npx tsx packages/trainer/src/index.ts --pop 200 --gens 500 --out champion.json

# See all options
npx tsx packages/trainer/src/index.ts --help
```
