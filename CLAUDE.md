# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Critical Instructions
- **Brevity is mandatory.** Do not explain your reasoning unless explicitly asked.
- **No Preamble/Postamble.** Do not say "Certainly," "I can help with that," or "Let me know if you need anything else."
- **Focus on Action.** Execute tool calls (bash, file_edit) immediately.
- **Summary Only.** After a complex task, provide a maximum 2-sentence summary of what changed.
- **Direct Answers.** If I ask a question, lead with the answer. Skip the "introductory paragraph."
- **NEVER USE ANY OF THESE**: timeout wait sleep
- **DO NOT EVER RUN** npm run test_replay   **NEVER EVER DO IT**

# GIT
I do all git commit, push, pull, add, delete, rename/mv

You can use it for diff

## Patching rules
Precision Editing Protocol
Anchor Strategy: When using edit_file, use the smallest possible old_str that is still unique. Avoid including more than 1 line of unchanged context.

Verification: You MUST run grep -F (fixed strings) on your intended old_str before calling edit_file to ensure a match exists.

Generate patches that are patch/diff compatible. That way we can avoid issues with things like newlines or extra spaces etc.

## Temporary files, data, scripts
Keep all things like this in a tmp/ directory in the root level.
It should always be OK to remove everything in tmp/
You should never write to locations outside of the project dir.

## Commands

### Running the game (development)
```bash
npm run dev          # Build shared+client, then start server with hot-reload (port 4000)
npm start            # Build shared+client, then start server (production mode)
```

### Building
```bash
npm run build                                    # Build shared + client
npm run build --workspace=packages/shared        # Build shared only
npm run build --workspace=packages/client        # Build client only
npx tsc -p packages/shared/tsconfig.json        # Rebuild shared (required before workers)
```

### Client dev server (Vite, port 5173)
```bash
cd packages/client && npm run dev
```

### AI training (genetic algorithm)
```bash
cd packages/trainer
npm run train                          # Run genetic training (see index.ts for CLI flags)
npm run record                         # Record agent-vs-agent replays
npm run replay                         # Interactive replay viewer
npm run test_replay                    # Run test suite with replay output
NUM_GAMES=50000 WORKERS=8 OUTPUT_DIR=./data npm run collect   # Collect IL data
npm run nn-sim                         # NN agent vs BasicAgent over Unix domain socket
```

### Data collection (imitation learning)
```bash
# Rebuilds shared first, then collects (state, action) pairs
NUM_GAMES=50000 WORKERS=8 OUTPUT_DIR=./data npm run collect
```

### Python NN training (Phase 2)
```bash
cd packages/trainer/ai
pip install -r requirements.txt
python train.py --data-dir ../data --out-dir ./checkpoints --epochs 50
```

## Architecture

### Monorepo structure
Five npm workspaces: `shared`, `server`, `client`, `trainer`, `testing`. All TypeScript, all ESM (`"type": "module"`).

### `packages/shared` — the engine
The authoritative game engine. **No I/O dependencies** — runs identically in browser, server, and headless trainer. Everything else imports from here via `@sc/shared`.

Key files:
- `src/types.ts` — all game entities (`GameState`, `Unit`, `City`, `Terrain`, `AgentAction`, socket events)
- `src/agent.ts` — `Agent` interface (`init()`, `act()`) + `AgentAction` type
- `src/basicAgent.ts` — `BasicAgent` implementation
- `src/gunAirAgent.ts` — `GunAirAgent` skeleton (random moves)
- `src/engine/map.ts` — procedural map generation. Cylindrical topology (X wraps, Y doesn't). Constraint-based: islands, city placement, player starting positions.
- `src/engine/game.ts` — `applyAction()` and `getPlayerView()`. The two core engine functions.
- `src/engine/movement.ts` — movement validation, pathfinding helpers
- `src/engine/combat.ts` — combat resolution
- `src/engine/production.ts` — city production logic
- `src/engine/tensorUtils.ts` — converts `PlayerView` → `Float32Array` for NN training (14 channels × H × W)

**Always rebuild shared before running compiled workers**: `npx tsc -p packages/shared/tsconfig.json`

### `packages/server`
Express + Socket.IO. Server-authoritative: holds the real `GameState`, sends per-player `PlayerView` views via `getPlayerView()`.

Key files:
- `src/index.ts` — Express + Socket.IO entry point, CLI `--port` parsing
- `src/gameManager.ts` — `GameManager` class: session registry, token validation, turn management
- `src/tokenAuth.ts` — token generation and validation
- `src/aiPlayer.ts` — spawns AI agents as Socket.IO clients
- `src/routes/game.ts` — REST: create/list/delete games
- `src/routes/training.ts` — training-related REST endpoints
- `src/routes/replay.ts` — replay-related REST endpoints

Socket events: `action` (client→server), `stateUpdate` / `gameStart` / `actionRejected` / `enemyCombat` (server→client).

### `packages/client`
React + Vite + Zustand + Canvas.

Key files:
- `src/main.tsx` — React entry point
- `src/App.tsx` — main app component
- `src/store/gameStore.ts` — Zustand store: socket, game state, `sendAction()`
- `src/components/GameCanvas.tsx` — Canvas rendering, camera, pathfinding overlay
- `src/components/HUD.tsx` — turn status, unit panel, controls
- `src/components/CityDialog.tsx` — city production UI
- `src/components/UnitPanel.tsx` — selected unit details
- `src/components/MainMenu.tsx` — main menu
- `src/components/ReplayViewer.tsx` — replay playback UI
- `src/sounds.ts` — Web Audio API procedural sound effects (no audio files)

### `packages/trainer`
Headless-only. Genetic algorithm + data collection.

Key files:
- `src/index.ts` — CLI entry point (`--pop`, `--gens`, `--workers`, `--out`)
- `src/genetics/genome.ts` — `Genome` (28-weight vector), feature names
- `src/genetics/population.ts` — `initPopulation()`, `nextGeneration()`, tournament selection
- `src/genetics/fitness.ts` — `computeFitness()` with configurable weights
- `src/genetics/crossover.ts` — crossover + mutation operators
- `src/tournament.ts` — `runTournament()` population evaluation
- `src/parallel.ts` — worker thread pool for parallel evaluation
- `src/runner.ts` — re-exports `runGame()` from `@sc/testing`
- `src/agents/basicAgent.ts` — BasicAgent copy for trainer use
- `src/agents/evolvedAgent.ts` — genome-driven agent
- `src/collect_data.ts` — parallel data collection coordinator
- `src/collect_worker.ts` — data collection worker
- `src/record_replay.ts` — replay recording coordinator
- `src/record_worker.ts` — replay recording worker
- `src/replayUtils.ts` — `snapshotGame()` for replay frames

**Scripts**:
- `npm run train` — genetic training
- `npm run record` — record N games as JSON replays
- `npm run replay` — interactive replay picker
- `npm run collect` — collect (state, action) pairs for IL
- `npm run nn-sim` — NN simulator test

### `packages/testing`
Testing utilities used by trainer and server.

Key files:
- `src/runGame.ts` — `runGame()` helper: runs headless game between two agents, returns `GameResult`
- `src/profile_game.ts` — performance profiling

## Key concepts

### Map topology
The map is cylindrical: X wraps (use `wrapX(x, mapW)` and `wrappedDistX(a, b, mapW)` for all X-axis math), Y does not. Ice caps at `y=0` and `y=mapHeight-1` are impassable. Playable rows are `1..mapHeight-2`.

### Turn flow
A player takes multiple actions (MOVE, SET_PRODUCTION, LOAD, UNLOAD, SLEEP, WAKE, SKIP) then emits `END_TURN`. The server advances `currentPlayer`, resets `movesLeft` for all units of the new player, and broadcasts a fresh `stateUpdate`.

### Fog of war
`getPlayerView(state, playerId)` computes what one player can see. `explored` (a `Set<"x,y">`) persists across turns. `seenEnemies` resets each turn. Units outside vision radius are hidden.

### AI agent contract
```typescript
agent.init({ playerId, mapWidth, mapHeight })
const action: AgentAction = agent.act(obs)
// obs: { tiles, myUnits, myCities, visibleEnemyUnits, visibleEnemyCities, turn, myPlayerId, myBomberBlastRadius }
```
`act()` is called once per action (not once per turn). The agent calls `END_TURN` when done.

### Map generation constraints (scale with map area)
- `MIN_ISLAND_SIZE ≈ 2% of area` (min 6)
- `MIN_CITY_DIST = 3` for area < 1500, else 4
- `MIN_ISLAND_CITIES = 2` for area < 1500, else 3
- `cityCount ≈ clamp(area/30, 8, 30)`
- 200 retry attempts before throwing; collect_worker wraps in try/catch and skips failed maps
