/**
 * Test Runner Engine
 *
 * A reusable framework for running agent tests with replay output.
 * Simulates game turns where the agent takes multiple actions until END_TURN.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BasicAgent,
  applyAction,
  getPlayerView,
  GamePhase,
  UNIT_STATS,
  Terrain,
  UnitType,
  advanceProduction,
  setProduction,
  type GameState,
  type Unit,
  type City,
  type AgentAction,
  type PlayerView,
  type PlayerId,
} from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPLAY_DIR = process.env.REPLAY_DIR ?? path.resolve(__dirname, '..', '..', '..', 'tmp');

function resolveReplayDir(): string {
  const configured = path.isAbsolute(REPLAY_DIR)
    ? REPLAY_DIR
    : path.resolve(__dirname, REPLAY_DIR);

  try {
    if (fs.existsSync(configured)) {
      if (fs.statSync(configured).isDirectory()) {
        return configured;
      }
    } else {
      fs.mkdirSync(configured, { recursive: true });
      return configured;
    }
  } catch {
    // Fall through to tmp_logs fallback.
  }

  const fallback = path.resolve(__dirname, '..', '..', '..', 'tmp_logs');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * After END_TURN, override any city production that isn't in the allowed list.
 * The agent is free to request whatever it wants; the test engine silently corrects it.
 */
function enforceAllowedProduction(state: GameState, playerId: PlayerId): void {
  const allowed = state.testOptions?.allowedProduction;
  if (!allowed || allowed.length === 0) return;
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    if (city.producing !== null && !allowed.includes(city.producing)) {
      setProduction(city, allowed[0]);
    }
  }
}

// All unit types for default allowedProduction
export const ALL_UNIT_TYPES: UnitType[] = [
  UnitType.Army,
  UnitType.Fighter,
  UnitType.Bomber,
  UnitType.Transport,
  UnitType.Destroyer,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Battleship,
];

/**
 * Map configuration for test games.
 */
export interface MapConfig {
  width: number;
  height: number;
  tiles: Terrain[][];
}

/**
 * Unit configuration for test setup.
 */
export interface UnitConfig {
  id: string;
  type: string;
  owner: PlayerId | null;
  x: number;
  y: number;
  health?: number;
  movesLeft?: number;
  fuel?: number;
  cargo?: string[];
  carriedBy?: string | null;
}

/**
 * City configuration for test setup.
 */
export interface CityConfig {
  id: string;
  x: number;
  y: number;
  owner: PlayerId | null;
}

/**
 * Test configuration.
 */
export interface TestConfig {
  testName: string;
  mapConfig: MapConfig;
  units: UnitConfig[];
  cities: CityConfig[];
  maxTurns: number;
  exploredTiles?: string[]; // Explicitly explored tiles (x,y format) - applies to both players
  p1ExploredTiles?: string[]; // Per-player explored tiles (overrides exploredTiles for P1)
  p2ExploredTiles?: string[]; // Per-player explored tiles (overrides exploredTiles for P2)
  victoryCondition?: (state: GameState) => boolean;
  testOptions?: {
    cityCaptureSuccessRate?: number; // 1 = 100% success
    initialProduction?: 'army'; // Set initial city production for all cities
    allowedProduction?: UnitType[]; // If set, overrides default (ALL_UNIT_TYPES)
  };
}

/**
 * Snapshot of game state for replay.
 */
export interface GameSnapshot {
  turn: number;
  currentPlayer: PlayerId | null;
  cities: City[];
  units: Unit[];
  winner: PlayerId | null;
  p1Explored: string[];
  p2Explored: string[];
}

/**
 * Replay file format.
 */
export interface ReplayFile {
  meta: {
    id: string;
    testName: string;
    recordedAt: string;
    turns: number;
    winner: PlayerId | null;
    p1Cities: number;
    p2Cities: number;
    neutralCities: number;
    mapWidth: number;
    mapHeight: number;
    frames: number;
    p1Agent: string;
    p2Agent: string;
  };
  tiles: Terrain[][];
  frames: GameSnapshot[];
}

/**
 * Test result.
 */
export interface TestResult {
  passed: boolean;
  turns: number;
  message: string;
  replayPath?: string;
  frames?: GameSnapshot[];
}

/**
 * Creates a game state from test configuration.
 */
export function createGameStateFromConfig(config: TestConfig): GameState {
  const state: any = {
    tiles: config.mapConfig.tiles,
    mapWidth: config.mapConfig.width,
    mapHeight: config.mapConfig.height,
    turn: 1,
    currentPlayer: 'player1',
    winner: null,
    phase: GamePhase.Active,
    cities: config.cities.map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      owner: c.owner,
      producing: config.testOptions?.initialProduction ?? null,
      productionTurnsLeft: 0,
      productionProgress: 0,
    })),
    testOptions: config.testOptions,
    units: config.units.map((u) => {
      const stats = UNIT_STATS[u.type as keyof typeof UNIT_STATS];
      return {
        id: u.id,
        type: u.type,
        owner: u.owner,
        x: u.x,
        y: u.y,
        health: u.health ?? stats?.maxHealth ?? 1,
        movesLeft: u.movesLeft ?? stats?.movesPerTurn ?? 3,
        fuel: u.fuel ?? stats?.maxFuel,
        sleeping: false,
        hasAttacked: false,
        cargo: u.cargo ?? [],
        carriedBy: u.carriedBy ?? null,
      };
    }),
    explored: {
      player1: new Set(),
      player2: new Set(),
    },
    bombersProduced: { player1: 0, player2: 0 },
    seenEnemies: { player1: [], player2: [] },
  };

  // Set up per-player explored tiles
  if (config.p1ExploredTiles) {
    config.p1ExploredTiles.forEach((tile) => state.explored.player1.add(tile));
  } else if (config.exploredTiles) {
    config.exploredTiles.forEach((tile) => state.explored.player1.add(tile));
  } else {
    // Default: explore all land tiles
    for (let y = 1; y < config.mapConfig.height - 1; y++) {
      for (let x = 0; x < config.mapConfig.width; x++) {
        if (config.mapConfig.tiles[y]?.[x] === Terrain.Land) {
          state.explored.player1.add(`${x},${y}`);
        }
      }
    }
  }

  if (config.p2ExploredTiles) {
    config.p2ExploredTiles.forEach((tile) => state.explored.player2.add(tile));
  } else if (config.exploredTiles) {
    config.exploredTiles.forEach((tile) => state.explored.player2.add(tile));
  } else {
    // Default: explore all land tiles
    for (let y = 1; y < config.mapConfig.height - 1; y++) {
      for (let x = 0; x < config.mapConfig.width; x++) {
        if (config.mapConfig.tiles[y]?.[x] === Terrain.Land) {
          state.explored.player2.add(`${x},${y}`);
        }
      }
    }
  }

  return state;
}

/**
 * Creates a snapshot of the current game state.
 */
export function snapshotGame(state: GameState): GameSnapshot {
  const p1Explored = Array.from(state.explored.player1 || []);
  const p2Explored = Array.from(state.explored.player2 || []);
  return {
    turn: state.turn,
    currentPlayer: state.currentPlayer,
    cities: JSON.parse(JSON.stringify(state.cities)),
    units: JSON.parse(JSON.stringify(state.units)),
    winner: state.winner,
    p1Explored,
    p2Explored,
  };
}

/**
 * Runs a test with the given configuration.
 * Returns a promise that resolves to the test result.
 */
export async function runTest(
  config: TestConfig,
  options: {
    verbose?: boolean;
    saveReplay?: boolean;
    agentPlayer1?: boolean;
    agentPlayer2?: boolean;
  } = {},
): Promise<TestResult> {
  const verbose = options.verbose ?? true;
  const saveReplay = options.saveReplay ?? true;
  const agent1 = options.agentPlayer1 ?? true ? new BasicAgent() : null;
  const agent2 = options.agentPlayer2 ?? false ? new BasicAgent() : null;

  if (verbose) {
    console.log(`\n=== Test: ${config.testName} ===\n`);
  }

  // Create game state
  const state = createGameStateFromConfig(config);
  const agent = new BasicAgent();
  agent.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  agent1?.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  agent2?.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  const frames: GameSnapshot[] = [];

  // Record initial state (turn 0 / before game starts)
  const initialState = snapshotGame(state);
  initialState.turn = 0;
  frames.push(initialState);

  // Victory condition defaults to checking if any unit is carried
  const victoryCondition = config.victoryCondition ?? (() => false);

  // Run turns
  let gameTurn = 0;
  while (gameTurn < config.maxTurns) {
    gameTurn++;

    // Player 1 takes actions
    let currentPlayer = 'player1' as PlayerId;
    while (true) {
      const view: PlayerView = getPlayerView(state, currentPlayer);
      const currentAgent = agent1 ?? agent;

      const action: AgentAction = currentAgent.act({
        ...view,
        myPlayerId: currentPlayer,
        myBomberBlastRadius: 0,
      } as any);

      // Apply the agent's action
      const result = applyAction(state, action, currentPlayer);
      if (!result.success) {
        break;
      }

      // Record frame after each action (except END_TURN)
      if (action.type !== 'END_TURN' && action.type !== 'SET_PRODUCTION') {
        const actionFrame = snapshotGame(state);
        actionFrame.turn = state.turn;
        frames.push(actionFrame);
      }

      // Check victory condition
      if (victoryCondition(state)) {
        if (verbose) {
          console.log('TEST PASSED');
        }
        // Set winner to current player
        state.winner = currentPlayer;
        // Add N+1 frame to show "end state"
        const endState = snapshotGame(state);
        endState.turn = state.turn + 1;
        frames.push(endState);
        const replayPath = saveReplay ? saveReplayFile(config.testName, state, frames) : undefined;
        return { passed: true, turns: state.turn, message: 'Test passed', replayPath };
      }

      // Check if agent ended turn
      if (action.type === 'END_TURN') {
        enforceAllowedProduction(state, currentPlayer);
        break;
      }
    }

    // Player 2 takes actions (if agent enabled)
    if (agent2) {
      currentPlayer = 'player2';
      while (true) {
        const view: PlayerView = getPlayerView(state, currentPlayer);

        const action: AgentAction = agent2.act({
          ...view,
          myPlayerId: currentPlayer,
          myBomberBlastRadius: 0,
        } as any);

        // Apply the agent's action
        const result = applyAction(state, action, currentPlayer);
        if (!result.success) {
          break;
        }

        // Record frame after each action (except END_TURN)
        if (action.type !== 'END_TURN' && action.type !== 'SET_PRODUCTION') {
          const actionFrame = snapshotGame(state);
          actionFrame.turn = state.turn;
          frames.push(actionFrame);
        }

        // Check victory condition
        if (victoryCondition(state)) {
          if (verbose) {
            console.log('TEST PASSED');
          }
          // Set winner to current player
          state.winner = currentPlayer;
          // Add N+1 frame to show "end state"
          const endState = snapshotGame(state);
          endState.turn = state.turn + 1;
          frames.push(endState);
          const replayPath = saveReplay ? saveReplayFile(config.testName, state, frames) : undefined;
          return { passed: true, turns: state.turn, message: 'Test passed', replayPath };
        }

        // Check if agent ended turn
        if (action.type === 'END_TURN') {
          enforceAllowedProduction(state, currentPlayer);
          break;
        }
      }
    }

    // Reset for next game turn
    // Advance production first (new units are added to state.units)
    advanceProduction(state, 'player1' as PlayerId);
    advanceProduction(state, 'player2' as PlayerId);

    for (const unit of state.units) {
      const stats = UNIT_STATS[unit.type as keyof typeof UNIT_STATS];
      unit.movesLeft = stats?.movesPerTurn ?? 3;
      unit.hasAttacked = false;
    }
    state.currentPlayer = 'player1';
    state.phase = GamePhase.Active;
    state.turn++;
  }

  // Test failed - check final state
  const passed = victoryCondition(state);
  const message = passed
    ? 'Test passed'
    : `Test failed after ${config.maxTurns} turns`;

  if (verbose) {
    console.log(passed ? 'TEST PASSED' : 'TEST FAILED');
  }

  const replayPath = saveReplay ? saveReplayFile(config.testName, state, frames) : undefined;
  return { passed, turns: state.turn, message, replayPath, frames };
}

/**
 * Saves a replay file and returns the path.
 */
export function saveReplayFile(
  testName: string,
  state: GameState,
  frames: GameSnapshot[],
): string {
  const replayDir = resolveReplayDir();

  const id = `test-${testName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`;
  const replay: ReplayFile = {
    meta: {
      id,
      testName,
      recordedAt: new Date().toISOString(),
      turns: state.turn,
      winner: state.winner,
      p1Cities: state.cities.filter((c) => c.owner === 'player1').length,
      p2Cities: state.cities.filter((c) => c.owner === 'player2').length,
      neutralCities: state.cities.filter((c) => c.owner === null).length,
      mapWidth: state.mapWidth,
      mapHeight: state.mapHeight,
      frames: frames.length,
      p1Agent: 'basicAgent',
      p2Agent: 'basicAgent',
    },
    tiles: state.tiles,
    frames,
  };

  const outputPath = path.join(replayDir, `${id}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(replay));
  console.log(`\nReplay saved to: ${outputPath}`);
  console.log(`Run: npm run replay`);

  return outputPath;
}

/**
 * Creates a simple island map with ocean borders.
 */
export function createIslandMap(
  width: number,
  height: number,
  islandRect: { x: number; y: number; w: number; h: number },
): MapConfig {
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      // Ocean borders (including ice cap rows)
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      }
      // Island area
      else if (x >= islandRect.x && x < islandRect.x + islandRect.w && y >= islandRect.y && y < islandRect.y + islandRect.h) {
        tiles[y][x] = Terrain.Land;
      }
      // Ocean elsewhere
      else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  return { tiles, width, height };
}

/**
 * Gets all land tile coordinates from a map config.
 * Useful for setting up fully explored test maps.
 */
export function getLandTiles(mapConfig: MapConfig): string[] {
  const tiles: string[] = [];
  for (let y = 1; y < mapConfig.height - 1; y++) {
    for (let x = 0; x < mapConfig.width; x++) {
      if (mapConfig.tiles[y]?.[x] === Terrain.Land) {
        tiles.push(`${x},${y}`);
      }
    }
  }
  return tiles;
}
