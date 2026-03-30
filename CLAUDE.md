# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Patching rules
Precision Editing Protocol
Anchor Strategy: When using edit_file, use the smallest possible old_str that is still unique. Avoid including more than 1 line of unchanged context.

Verification: You MUST run grep -F (fixed strings) on your intended old_str before calling edit_file to ensure a match exists.

Fallback to Patch: If an edit_file call fails once, DO NOT try again with the same tool. Instead, generate a Unified Diff and use the bash tool to apply it:
cat << 'EOF' > change.patch
[DIFF CONTENT]
EOF
patch path/to/file change.patch

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
npx tsc -p packages/shared/tsconfig.json        # Rebuild shared (required before running workers)
```

### Client dev server (Vite, port 5173)
```bash
cd packages/client && npm run dev
```

### AI training (genetic algorithm)
```bash
cd packages/trainer
npm run train                          # Run genetic training (see index.ts for all CLI flags)
NUM_GAMES=50000 WORKERS=8 OUTPUT_DIR=./data npm run collect   # Collect imitation learning data
npm run nn-sim                         # NN agent vs BasicAgent over Unix domain socket
```

### Python NN training (Phase 2)
```bash
cd packages/trainer/ai
pip install -r requirements.txt
python train.py --data-dir ../data --out-dir ./checkpoints --epochs 50
```

## Architecture

### Monorepo structure
Four npm workspaces: `shared`, `server`, `client`, `trainer`. All TypeScript, all ESM (`"type": "module"`).

### `packages/shared` — the engine
The authoritative game engine. **No I/O dependencies** — runs identically in browser, server, and headless trainer. Everything else imports from here via `@sc/shared`.

Key files:
- `src/types.ts` — all game entities (`GameState`, `Unit`, `City`, `Terrain`, `AgentAction`, etc.)
- `src/engine/map.ts` — procedural map generation. Cylindrical topology (X wraps, Y doesn't). Constraint-based: islands, city placement, player starting positions.
- `src/engine/game.ts` — `applyAction()` and `getPlayerView()`. The two core engine functions.
- `src/engine/tensorUtils.ts` — converts `PlayerView` → `Float32Array` for NN training (14 channels × H × W).
- `src/agents/` — `BasicAgent` and `AdamAI` live here so both server and trainer can use them.

**Always rebuild shared before running compiled workers**: `npx tsc -p packages/shared/tsconfig.json`

### `packages/server`
Express + Socket.IO. Server-authoritative: holds the real `GameState`, sends per-player `PlayerView` views via `getPlayerView()`.

- `gameManager.ts` — session registry, token validation, turn management
- `aiPlayer.ts` — spawns AI agents as Socket.IO clients connecting back to the same server
- `routes/game.ts` — REST: create/list/delete games

Socket events: `action` (client→server), `stateUpdate` / `gameStart` / `actionRejected` (server→client).

### `packages/client`
React + Vite + Zustand + Canvas.

- `store/gameStore.ts` — all game state; socket lives here; `sendAction()` is the one way to emit moves
- `components/GameCanvas.tsx` — the main rendering component. Draws tiles, units, cities on a `<canvas>`. Also owns: `computeReachableTiles()` (BFS for movement range overlay), `computePath()` (BFS pathfinding for click-to-move), combat animations, "Your turn" banner, camera.
- `sounds.ts` — Web Audio API procedural sound effects (no audio files)

### `packages/trainer`
Headless-only. Two separate systems:

**Genetic algorithm** (`index.ts`, `genetics/`, `tournament.ts`, `parallel.ts`):
- Evolves `EvolvedAgent` (28-weight genome) against `BasicAgent`
- Uses Node.js `worker_threads` for parallel game evaluation

**Imitation learning data collection** (`collect_data.ts`, `collect_worker.ts`):
- Spawns N child processes via `child_process.spawn('npx tsx ...')` (not worker threads — tsx doesn't transfer to workers reliably)
- Workers write progress to `tmp/progress-N.txt` (file-based, no IPC pipes); main process polls every second
- Output: `states.bin` (raw float32, shape [N, 14, H, W]) + `actions.jsonl` (one JSON per line) + `meta.json`
- **`collect` script rebuilds shared first** — workers import compiled `@sc/shared/dist`, so stale dist = stale constraints

**NN training** (`ai/`): Python/PyTorch. `dataset.py` reads the binary format via `np.memmap`. `train.py` trains a `PolicyCNN` with three output heads (action type, target tile, production type).

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
const action: AgentAction = agent.act({ tiles, myUnits, myCities, visibleEnemyUnits, visibleEnemyCities, turn, myPlayerId })
```
`act()` is called once per action (not once per turn). The agent calls `END_TURN` when done.

### Map generation constraints (scale with map area)
- `MIN_ISLAND_SIZE ≈ 2% of area` (min 6)
- `MIN_CITY_DIST = 3` for area < 1500, else 4
- `MIN_ISLAND_CITIES = 2` for area < 1500, else 3
- `cityCount ≈ clamp(area/30, 8, 30)`
- 200 retry attempts before throwing; collect_worker wraps in try/catch and skips failed maps
