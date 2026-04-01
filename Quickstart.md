# Quickstart

## Test Cases

### Running individual tests

```bash
npx tsx packages/shared/src/test_exploreAndExpand_3.ts
npx tsx packages/shared/src/test_transportEarlyDeparture.ts
```

### View test replays

```bash
# Run test suite and open the most recent replay
npm run test_replay

# View specific replay
npx tsx packages/trainer/src/replay_picker.ts tmp/test-*.json
```

### Adding a new test

1. Create a new test file in `packages/shared/src/test_*.ts`
2. Use the `runTest()` helper from `testRunner.ts`
3. Define a `victoryCondition` that checks the expected outcome
4. Add the test to `packages/trainer/src/test_replay_picker.ts`

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

## Record games

All data operations use the `DATA_DIR` environment variable:

```bash
# Record 5 games (default)
DATA_DIR=./data npm run record

# Record 100 games across 8 workers
DATA_DIR=./data NUM_GAMES=100 WORKERS=8 npm run record

# Custom map size, turn limit, and agent matchup
DATA_DIR=./data NUM_GAMES=50 MAX_TURNS=300 P1_AGENT=basicAgent P2_AGENT=gunAirAgent npm run record

# Use tmp directory for quick tests
rm -fR tmp/* && DATA_DIR=tmp NUM_GAMES=8 MAX_TURNS=300 P1AGENT=basicAgent P2AGENT=basicAgent npm run record
```

## View replays

```bash
# View replays from default data directory
DATA_DIR=./data npm run replay

# View replays from tmp directory
DATA_DIR=tmp npm run replay
```

## Collect training data (Imitation Learning)

```bash
# Collect (state, action) pairs for NN training
DATA_DIR=./data NUM_GAMES=50000 WORKERS=8 npm run collect

# Output: DATA_DIR/training/states.bin, actions.jsonl, meta.json
```
