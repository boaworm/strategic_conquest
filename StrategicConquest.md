# Strategic Conquest — Reimplementation Design Document

## Overview

A faithful modern reimplementation of the classic Mac strategy game *Strategic Conquest* (originally by Dave Pare, published by Delta Tao Software), delivered as a web application. The game is a turn-based wargame of territorial conquest on a tile-based map of land and ocean, inspired by the old mainframe game *Empire*.

This project has **two equal goals**:
1. A playable, polished web game (human vs. human multiplayer and human vs. AI)
2. A training platform where AI agents can be evolved via **genetic programming** to play the game — two AIs play headlessly against each other, fitness is measured, and generations of agents are selected and mutated toward increasingly strong play

---

## Core Gameplay

### Objective
Eliminate all enemy cities and units. The last player with cities standing wins.

### Map
- Tile-based grid (classic: 60×40 or configurable size)
- **Cylindrical topology**: the map wraps east↔west seamlessly. Moving east off the right edge brings you to the left edge and vice versa. North and south borders are hard walls (poles of the cylinder)
- Terrain types: **Ocean**, **Land**, **City** (on land)
- Cities are the economic engine: each city produces one unit per N turns
- Map can be pre-designed or procedurally generated
- Map generation ensures land blobs wrap seamlessly at the east/west seam

### Fog of War
- Each unit has a visibility radius (varies by unit type)
- Tiles outside vision range are hidden or last-known-state
- Enemy unit positions are only revealed when within a friendly unit's sight

### Cities
- Start as **neutral** (grey), **player** (e.g. blue), or **enemy** (red)
- Captured by moving a friendly Army unit onto them
- Each city has a **production queue**: one unit type selected at a time
- Unit is produced after N turns (varies by unit type)
- Captured cities reset production

### Turn Structure
1. Player moves all units (or skips/sleeps them)
2. Cities advance their production counters
3. Newly produced units appear in their city
4. AI takes its turn
5. Repeat

### Unit Commands
- **Move**: click destination or use directional input
- **Sleep**: unit stays put, skips future turns until woken
- **Sentry / Patrol**: unit auto-attacks enemies in range
- **Load / Unload**: armies board/disembark transports
- **Skip turn**: defer this unit for now

---

## Unit Types

| Unit       | Moves/Turn | Vision | Health | Builds In | Domain | Notes                                                        |
|------------|-----------|--------|--------|-----------|--------|--------------------------------------------------------------|
| Army       | 1         | 1      | 1      | 5 turns   | Land   | Captures cities; can be carried by Transport                 |
| Fighter    | 10        | 3      | 1      | 12 turns  | Air    | Must land on city or Carrier each turn; intercepts Bombers   |
| Bomber     | 15        | 3      | 1      | 15 turns  | Air    | Area-of-effect attack; fuel limited (30); see blast radius below |
| Transport  | 4         | 2      | 1      | 8 turns   | Sea    | Carries up to 6 Armies; unarmed                              |
| Destroyer  | 6         | 2      | 1      | 12 turns  | Sea    | Fast escort; anti-sub capable                                |
| Submarine  | 4         | 2      | 1      | 12 turns  | Sea    | Hidden unless adjacent to Destroyer                          |
| Carrier    | 5         | 2      | 2      | 18 turns  | Sea    | Carries up to 4 Fighters; light attack                       |
| Battleship | 5         | 2      | 2      | 24 turns  | Sea    | Strongest sea unit; high attack and defence                  |

### Bomber Blast Radius

Blast radius upgrades automatically as a player produces more Bombers cumulatively:

| Bombers produced | Blast radius | Label in UI        | Effect                                    |
|-----------------|-------------|--------------------------------|--------------------------------------------|
| 0–9             | 0 (single tile) | *bomber*          | Hits target tile only                     |
| 10–19           | 1 (3×3 area)    | *bomber (nuclear)* | Hits target + all adjacent tiles         |
| 20+             | 2 (5×5 area)    | *bomber (mega)*    | Hits target + two rings of adjacent tiles |

If enemy Fighters are anywhere inside the blast area, they intercept the Bomber before it drops its payload. Each Fighter gets one interception roll; if the Bomber survives all of them it flies back without bombing. If no Fighters are present, the bomb drops and kills **all** enemy units in the blast area — the Bomber is destroyed with them.

---

## Tech Stack

### Frontend
- **Framework**: [React](https://react.dev/) with TypeScript
- **Build tool**: [Vite](https://vitejs.dev/)
- **Rendering**: HTML5 Canvas (via a thin React wrapper) for the game map; React for UI chrome (menus, unit panels, city dialogs)
- **State management**: [Zustand](https://github.com/pmndrs/zustand) — lightweight and well-suited to game state
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) for UI chrome

### Game Logic
- Pure TypeScript, framework-agnostic — lives in `src/engine/`
- Fully deterministic and unit-testable
- Communicates with React via Zustand store

### AI
- Single-player AI implemented in TypeScript in `src/engine/ai/`
- Start with a basic greedy AI (expand to nearest neutral city, attack enemy units of opportunity)
- Designed to be replaceable/upgradeable

### Training Runner
- **Runtime**: Node.js with TypeScript (same server package, separate entry point)
- Headless game loop: no sockets, no HTTP — just the engine running as fast as the CPU allows
- Supports **parallelism**: run N games concurrently in worker threads (`node:worker_threads`) for population-level evaluation
- Emits structured logs (JSONL) per game: every turn, every action, outcome — for later analysis
- A **tournament mode**: play a round-robin or Swiss bracket across an entire population to rank agents

### Backend (multiplayer server)
- **Runtime**: Node.js with TypeScript
- **Transport**: [Socket.IO](https://socket.io/) over WebSockets — real-time bidirectional events between server and clients
- **HTTP layer**: [Express](https://expressjs.com/) — serves the static frontend build and REST endpoints for game creation/token validation
- **Game state**: held in-memory on the server (Redis persistence is a future option for durability)
- Shared types package (`packages/shared`) used by both client and server — no duplicated type definitions

### Testing
- [Vitest](https://vitest.dev/) for unit tests (game engine logic)
- No E2E testing initially

---

## Project Structure

Monorepo with three packages:

```
strategic_conquest/
├── StrategicConquest.md
├── package.json               ← workspace root (npm workspaces)
├── packages/
│   ├── shared/                ← Shared TypeScript types & pure engine logic
│   │   ├── src/
│   │   │   ├── types.ts       ← Tile, Unit, City, GameState, Player, Token, socket events
│   │   │   ├── engine/
│   │   │   │   ├── map.ts
│   │   │   │   ├── game.ts
│   │   │   │   ├── combat.ts
│   │   │   │   ├── movement.ts
│   │   │   │   └── production.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── client/                ← React frontend (Vite)
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── store/
│   │       │   └── gameStore.ts
│   │       ├── components/
│   │       │   ├── GameCanvas.tsx
│   │       │   ├── UnitPanel.tsx
│   │       │   ├── CityDialog.tsx
│   │       │   ├── HUD.tsx
│   │       │   ├── MainMenu.tsx
│   │       │   └── MultiplayerLobby.tsx
│   │       └── assets/
│   │           └── tiles/
│   │
  ├── server/                ← Node.js multiplayer server
  │   ├── src/
  │   │   ├── index.ts       ← Express + Socket.IO entry point
  │   │   ├── gameManager.ts ← In-memory registry of active games
  │   │   ├── gameSession.ts ← Per-game state: tokens, players, engine instance
  │   │   ├── tokenAuth.ts   ← Token generation and validation middleware
  │   │   └── routes/
  │   │       └── game.ts    ← REST: POST /game/create, GET /game/:id/state
  │   └── package.json
  │
  └── trainer/               ← Headless AI training runner
      ├── src/
      │   ├── index.ts       ← CLI entry point (npx trainer --pop 200 --gens 500)
      │   ├── runner.ts      ← Headless game loop (engine only, no I/O)
      │   ├── tournament.ts  ← Round-robin / Swiss ranking across a population
      │   ├── worker.ts      ← Worker thread: evaluates one game, returns fitness
      │   ├── genetics/
      │   │   ├── population.ts  ← Init, select, reproduce, mutate
      │   │   ├── genome.ts      ← Agent genome definition (weights / program tree)
      │   │   ├── fitness.ts     ← Fitness function(s)
      │   │   └── crossover.ts   ← Crossover operators
      │   └── agents/
      │       ├── agentInterface.ts  ← The contract every AI agent must implement
      │       ├── basicAgent.ts      ← Baseline greedy agent
      │       └── evolvedAgent.ts    ← Agent driven by a genome
│       └── package.json
```

---

## Design Decisions

### Canvas vs. DOM rendering for the map
The game map can be large (60×40 = 2400 tiles). Rendering each tile as a DOM element would be slow. **Canvas** gives us full control, good performance, and the classic pixel-art aesthetic of the original.

### Pure engine layer
By keeping all game logic in `src/engine/` with no React dependencies, we can:
- Unit test the engine in isolation
- Later swap the frontend (e.g. a terminal interface, or a different renderer)
- Run the AI server-side if multiplayer is added

### Zustand over Redux
Redux would be over-engineered for this scope. Zustand gives us a simple, mutable-style store with minimal boilerplate, which maps well to imperative game state updates.

### Single-player and multiplayer both supported
The engine is headless and turn-based, which makes it straightforward to drive from either a local AI loop or a server that relays moves between two remote players. The same `engine/` code runs on both client (for local games) and server (authoritative source for multiplayer games).

### Headless engine is the foundation
The engine in `packages/shared/src/engine/` has zero I/O dependencies — it takes a `GameState` and an `Action` and returns a new `GameState`. This makes it trivial to:
- Run it in a browser (single-player or spectate)
- Drive it from Socket.IO (multiplayer server)
- Loop it thousands of times per second in a training runner (AI evolution)

Every consumer uses the exact same code path, so bugs fixed in the engine benefit all three modes.

### Why TypeScript (client and server)
- **Shared types**: `packages/shared` defines `Unit`, `Tile`, `GameState`, socket event payloads etc. once, used by both client and server — eliminates client/server contract bugs entirely
- **Scale**: game logic is complex; TypeScript catches mistakes (wrong tile index, missing field on a unit, invalid move) at compile time rather than mid-game at runtime
- **Refactoring safety**: as we iterate on the design, TS makes large renames and restructures safe across the whole codebase
- **Strict mode**: all packages use `"strict": true` — no implicit `any`, no unchecked nulls

---

## Visual Style

The look matches the classic Strategic Conquest aesthetic as closely as possible:

- **Tile-based map** rendered on HTML5 Canvas
- **Classic unit symbols** matching the original game:
  - ⚓ anchor shapes for sea units, ✈ wing shapes for air, shield shapes for armies
  - Each unit type has a distinct recognisable shape drawn programmatically (no sprite images needed for MVP)
- **Color coding**: blue = player 1, red = player 2, grey = neutral cities, dark navy = ocean, green = land, black = fog
- **Cities**: filled coloured square with a contrasting "★" icon
- **Selected unit**: bright yellow highlight border, pulsing
- **Fog of war**: unexplored tiles are solid black; previously-seen tiles are dimmed
- **Zoom**: mouse wheel (or pinch on trackpad) zooms in/out from 8px to 64px per tile. Default tile size is 24px
- **Viewport**: the camera is centered on the player's starting city when the game begins. Pan by dragging, arrow keys, or moving the mouse to the screen edges. The viewport wraps seamlessly east/west matching the cylindrical map topology
- Minimal UI chrome — the map dominates the screen
- Keyboard shortcuts mirroring the original where possible (arrow keys, letter commands)

---

## AI Agent Interface

Every AI agent — whether a hardcoded baseline or a genome-driven evolved agent — implements the same TypeScript interface defined in `packages/shared`:

```typescript
// packages/shared/src/agentInterface.ts

export interface AgentObservation {
  /** Fog-of-war filtered view of the map (same format the human client receives) */
  tiles: TileView[][];
  myUnits: UnitView[];
  myCities: CityView[];
  visibleEnemyUnits: UnitView[];
  visibleEnemyCities: CityView[];
  turn: number;
  myPlayerId: PlayerId;
}

export type AgentAction =
  | { type: 'MOVE';            unitId: string; to: Coord }
  | { type: 'SET_PRODUCTION';  cityId: string; unitType: UnitType }
  | { type: 'LOAD';            unitId: string; transportId: string }
  | { type: 'UNLOAD';          unitId: string; to: Coord }
  | { type: 'SLEEP';           unitId: string }
  | { type: 'END_TURN' };

export interface Agent {
  /** Called once at game start. Receive any static config the agent needs. */
  init(config: AgentConfig): void;

  /**
   * Called by the runner each time this agent must act.
   * Must return exactly one action. The runner calls this repeatedly
   * until the agent emits END_TURN.
   */
  act(obs: AgentObservation): AgentAction;
}
```

This contract means:
- Any agent can be dropped into the headless runner, the Socket.IO server (replacing a human player), or even run client-side in the browser
- The evolved agent simply wraps a genome-encoded program/weights in the same `act()` method
- Human players and AI agents are indistinguishable from the engine's perspective

---

## Genetic Programming Design

### Genome Representation

Two approaches are worth evaluating (start with weights, graduate to GP trees if needed):

| Approach | Description | Pros | Cons |
|---|---|---|---|
| **Weight vector** | A fixed neural-network-like scoring function over hand-crafted features | Simple to implement, fast to evaluate | Expressiveness limited by feature design |
| **Program tree (GP)** | A tree of primitive operations (IF, ADD, MOVE-TOWARD, ATTACK-NEAREST) evolved as a program | Can discover novel strategies | Larger search space, bloat without pruning |

**Initial choice**: weight vector over a set of strategic features. This is faster to get working and already capable of non-trivial play. A GP tree representation can be layered on later.

### Feature Examples (for weight vector)
- Ratio of my cities to enemy cities
- Number of my units vs. enemy units
- Distance from each army to nearest neutral city
- Distance from each army to nearest enemy city
- Number of unloaded armies on transports
- Production queue completions remaining this turn
- Map control % (tiles visible to me vs. total)

### Fitness Function

Fitness is measured per game (or averaged over several games against diverse opponents):

```
fitness = W_win  * didWin
        + W_turn * (maxTurns - turnsToWin) / maxTurns   // reward faster wins
        + W_city * finalCityRatio                        // cities at end of game
        + W_unit * finalUnitRatio                        // units survived
        - W_loss * didLose
```

Weights `W_*` are tunable hyperparameters. Playing against a random baseline first, then progressively tougher opponents (previous generation champion).

### Evolutionary Loop

```
1. Initialise population of N agents with random genomes
2. For each generation:
   a. Evaluate: run a tournament (each agent plays K games, alternating sides)
   b. Rank agents by fitness
   c. Select top M agents (elitism) — they survive unchanged
   d. Fill remainder via:
        - Crossover: mix two parent genomes
        - Mutation: perturb random weights / swap subtrees
   e. Log generation stats (best fitness, mean fitness, best agent genome)
3. Export champion genome as JSON → usable immediately as the in-game AI
```

### Parallelism

Training is embarrassingly parallel at the game level. The runner uses Node.js `worker_threads`:
- Main thread manages the population and evolutionary operators
- Each worker thread runs one game (two agents, full engine loop) and returns `{ winner, turns, fitnessP1, fitnessP2 }`
- With an 8-core machine, ~8 games run simultaneously

### CLI Usage

```bash
# Run 500 generations, population of 200, 8 parallel workers
npx trainer --pop 200 --gens 500 --workers 8 --out champion.json

# Resume from a checkpoint
npx trainer --resume checkpoint_gen_250.json --gens 500

# Watch mode: render one game per generation in the browser
npx trainer --pop 200 --gens 500 --watch
```

### Champion Export

After training, the champion genome is saved as `champion.json`. The `evolvedAgent.ts` module reads this file and implements the `Agent` interface — making it a drop-in replacement for the in-game AI with no further changes.

---

## Trainer Tools

All trainer commands are run from `packages/trainer/`. The `collect` and `record` scripts rebuild `packages/shared` first so worker processes always use fresh compiled code.

### Game Recording (`npm run record`)

Records agent-vs-agent games and saves each as a JSON replay file. Runs across multiple parallel worker processes — defaults to one worker per logical CPU.

```bash
# Record 5 games (default), auto-detect CPU count for workers
npm run record

# Record 100 games across 8 workers
NUM_GAMES=100 WORKERS=8 npm run record

# Custom map size and output location
NUM_GAMES=50 MAP_WIDTH=60 MAP_HEIGHT=40 REPLAY_DIR=./replays npm run record

# Pit two different agents against each other
NUM_GAMES=20 MAX_TURNS=300 P1AGENT=basicAgent P2AGENT=gunAirAgent npm run record
```

**Environment variables:**

| Variable    | Default          | Description                                              |
|-------------|-----------------|----------------------------------------------------------|
| `NUM_GAMES` | `5`             | Total number of games to record                          |
| `WORKERS`   | CPU core count  | Number of parallel worker processes                      |
| `MAP_WIDTH` | `50`            | Map width in tiles                                       |
| `MAP_HEIGHT`| `20`            | Map height in tiles (playable rows; ice caps add 2 more) |
| `MAX_TURNS` | `500`           | Maximum turns before declaring a draw                    |
| `REPLAY_DIR`| `../../tmp`     | Directory to write replay JSON files into                |
| `P1AGENT`   | `basicAgent`    | Agent for player 1 (see agent names below)               |
| `P2AGENT`   | `basicAgent`    | Agent for player 2 (see agent names below)               |

**Agent names** (case-insensitive, underscore form `P1_AGENT` also accepted):

| Name          | Class         | Description                                      |
|---------------|--------------|--------------------------------------------------|
| `basicAgent`  | `BasicAgent`  | Full-featured greedy agent with expansion, combat, and naval/air logic |
| `gunAirAgent` | `GunAirAgent` | Skeleton agent — random army moves, random production; easy benchmark  |
| `adamAI`      | `AdamAI`      | Genetic-algorithm evolved agent                  |

The agent name is stored in each replay's metadata and shown in `npm run replay` listings so matchups are always visible.

Workers are spawned as compiled Node.js processes (`dist/record_worker.js`). Each worker writes its games directly to `REPLAY_DIR` as individual `<uuid>.json` files. Progress is reported as a percentage in the coordinator's stdout.

### Replay Viewer (`npm run replay`)

Interactive terminal picker to browse and play back recorded games.

```bash
npm run replay

# Point at a specific replay directory
REPLAY_DIR=./replays npm run replay
```

Reads all `.json` files from `REPLAY_DIR`, displays a list sorted by date, and lets you step through turns to inspect the game state.

### Imitation Learning Data Collection (`npm run collect`)

Records game states and agent actions for neural network training. Writes a binary tensor file (`states.bin`), action labels (`actions.jsonl`), and metadata (`meta.json`).

```bash
# Collect 50 000 games across 8 workers into ./data
NUM_GAMES=50000 WORKERS=8 OUTPUT_DIR=./data npm run collect

# Smaller test run
NUM_GAMES=1000 WORKERS=4 npm run collect
```

**Environment variables:**

| Variable              | Default   | Description                                              |
|-----------------------|----------|----------------------------------------------------------|
| `NUM_GAMES`           | `1000`   | Total games to simulate                                  |
| `WORKERS`             | `1`      | Number of parallel worker processes                      |
| `OUTPUT_DIR`          | `./data` | Output directory for `states.bin`, `actions.jsonl`, `meta.json` |
| `MAP_WIDTH`           | `50`     | Map width                                                |
| `MAP_HEIGHT`          | `20`     | Map height                                               |
| `MAX_TURNS`           | `500`    | Max turns per game                                       |
| `MAX_SAMPLES_PER_GAME`| `3000`   | Reservoir sample cap per game (Algorithm R)              |

Workers write per-worker binary chunks to a temp directory; the coordinator merges them into the final output files and deletes the temp dir on completion.

### Parallelism Model

Both `record` and `collect` use the same pattern:

1. Coordinator (`record_replay.ts` / `collect_data.ts`) splits `NUM_GAMES` evenly across `WORKERS`
2. Each worker is a compiled Node.js child process (`dist/record_worker.js` / `dist/collect_worker.js`) — no `tsx` startup overhead
3. Workers report progress by writing a game count to `tmp/progress-N.txt`; the coordinator polls these files once per second and prints `%` progress
4. The coordinator waits for all workers via `Promise.all`, then merges/summarises output

---

## Multiplayer Architecture

### Game Creation Flow

```
Client                          Server
  |                               |
  |-- POST /game/create --------> |
  |                               |  Generate game ID
  |                               |  Generate 3 tokens (crypto random)
  |                               |  Register game session (state: WAITING)
  |<-- { gameId, adminToken, ----- |
  |      p1Token, p2Token }        |
```

The creator receives all three tokens and is responsible for distributing them out-of-band (e.g. share links). The server never re-transmits tokens after this initial response.

### Token Types

| Token       | Purpose                                                                 |
|-------------|-------------------------------------------------------------------------|
| `adminToken` | Admin actions: cancel game, kick player, inspect full server state. Not needed by either player. Useful during development and for a future lobby/admin UI. |
| `p1Token`   | Authenticates Player 1 for all game actions (moves, production, end turn) |
| `p2Token`   | Authenticates Player 2 for all game actions                             |

Tokens are cryptographically random (128-bit, hex-encoded via `crypto.randomBytes`). They are passed as a Socket.IO auth credential on connection and validated server-side before any game event is processed.

### Join & Game Start Flow

```
Player 1 (browser)              Server                Player 2 (browser)
  |                               |                         |
  |-- socket.connect(p1Token) --> |                         |
  |<-- joined, waiting for p2 --- |                         |
  |                               | <-- socket.connect(p2Token) --|
  |                               |  Both players present          |
  |<-- gameStart(initialState) -- | -- gameStart(initialState) --> |
```

Once both player sockets are connected the server transitions the game to `ACTIVE`, generates the initial map, and emits `gameStart` with each player's personalised view (fog of war applied).

### Turn Flow (multiplayer)

1. Server tracks whose turn it is
2. Active player emits `move`, `setProduction`, `endTurn` etc.
3. Server validates the action against authoritative game state
4. Server updates state, computes fog, emits `stateUpdate` to both players (each gets their fog-filtered view)
5. When `endTurn` is received, server advances to the next player

The server is the **single source of truth** — clients never mutate state directly.

### Multiple Connections with the Same Token
A token maps to a `playerId`, not a socket. Multiple browser tabs or clients can connect with the same token simultaneously. They all:
- Receive the same fog-of-war view (same player's perspective)
- Can all send actions (moves, production, end-turn) — the server processes whichever arrives first per turn

This enables useful scenarios:
- **Spectating**: share your own token with a friend so they can watch your view live
- **Co-pilot**: two people collaborating on one side
- **Reconnect without penalty**: open a new tab and re-authenticate without waiting for a timeout

The server does not limit simultaneous connections per token. If conflicting actions arrive in the same turn (rare with human players), the first received wins and subsequent ones are rejected with an `ACTION_REJECTED` event.

### Disconnection Handling
- If *all* sockets for a player disconnect mid-game, the game is paused and a reconnect window is given (e.g. 60 seconds)
- Any socket reconnecting with the correct token within the window resumes the game
- If the window expires the disconnected player forfeits

---

## Running the Server

```bash
npm start               # build and start (port 4000)
npm start -- --verbose  # same, with verbose AI turn logging
VERBOSE=1 npm start     # alternative env-var form
npm run dev             # build and start with hot-reload
```

`--verbose` enables per-action `[AI]` log lines (unit moves, city production, SKIP/SLEEP/WAKE, END_TURN). Without it the server is silent except for errors.

---

## Milestones

### M1 — Map & Rendering
- [ ] Project scaffolding (Vite + React + TypeScript)
- [ ] Core types defined
- [ ] Procedural map generation (land/ocean/cities)
- [ ] Canvas renderer: draw tiles, fog of war, cities, units

### M2 — Core Game Loop
- [ ] Turn management
- [ ] Unit movement (click-to-move, keyboard)
- [ ] City production UI
- [ ] Fog of war updates per turn

### M3 — Combat & Win Condition
- [ ] Combat resolution
- [ ] City capture
- [ ] Win/lose detection

### M4 — AI Opponent (Baseline)
- [ ] `Agent` interface defined in `packages/shared`
- [ ] Basic greedy agent (expand to nearest neutral city, attack on opportunity)
- [ ] Wired into single-player game as the opponent

### M5 — Headless Training Runner
- [ ] `packages/trainer` scaffolded
- [ ] Headless game loop (engine only, no rendering, no I/O)
- [ ] Worker-thread parallelism for concurrent game evaluation
- [ ] Weight-vector genome + feature extractor
- [ ] Fitness function
- [ ] Selection, crossover, mutation operators
- [ ] Tournament / round-robin evaluator
- [ ] CLI interface (`--pop`, `--gens`, `--workers`, `--out`)
- [ ] Checkpoint save/resume
- [ ] Champion export to `champion.json` and hot-swap into in-game AI

### M6 — Multiplayer Server
- [ ] Node.js + Express + Socket.IO server scaffolding
- [ ] `POST /game/create` → generates gameId + 3 tokens
- [ ] Token authentication middleware
- [ ] Player join flow and game start handshake
- [ ] Server-authoritative turn loop with fog-of-war per player
- [ ] Disconnection / reconnection handling
- [ ] Client multiplayer lobby UI (enter token → join game)

### M7 — Polish
- [ ] Sound effects
- [ ] Unit animations
- [ ] Save / load game state (localStorage for single-player; server-side for multiplayer)
- [ ] Configurable map size and difficulty
- [ ] Admin token UI (game inspector / cancel game)

---

## Open Questions

- Tile art: pixel art sprites vs. simple colored shapes for MVP?
- Should the initial map always be symmetric (fair starts) or fully random?
- Fuel mechanic for air units: hard limit or just a strong incentive to stay near cities/carriers?
- How faithful to the original unit stats should we be vs. rebalancing for fun?
- Genome representation: start with weight vector only, or build the GP tree representation in parallel?
- Fitness function balance: should winning quickly be rewarded heavily, or is win/loss sufficient for early generations?
- Co-evolution strategy: should the training population always play against the current-generation champion, or should we maintain a hall-of-fame of past champions to prevent strategy collapse?
- Should the trainer be able to expose a WebSocket feed so the browser client can spectate a training run live ("watch mode")?
