/**
 * Test: Army should move to coastal transport and board it
 *
 * Setup:
 * - 10x8 map
 * - Island: 6x6 land area at columns 2-7, rows 1-6
 * - Army at (2, 3) - west side of island
 * - Transport at (9, 3) - east coast ocean (off the east side)
 * - City at (5, 3) - in the middle between army and transport
 *
 * Output: Replay-compatible JSON file for visualization
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BasicAgent,
  applyAction,
  getPlayerView,
  Terrain,
  UnitType,
  GamePhase,
  UNIT_STATS,
  type GameState,
  type Unit,
  type City,
  type AgentAction,
  type PlayerView,
} from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = path.basename(fileURLToPath(import.meta.url), '.ts');
const REPLAY_DIR = process.env.REPLAY_DIR ?? path.resolve(__dirname, '..', '..', '..', 'tmp');
const MAX_TURNS = 6;

function createTestMap(): { tiles: Terrain[][]; width: number; height: number } {
  const width = 10;
  const height = 8;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      // Ice caps at top and bottom
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      }
      // 6x6 island at cols 2-7, rows 1-6
      else if (x >= 2 && x <= 7 && y >= 1 && y <= 6) {
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

function createTestGameState(): GameState {
  const { tiles, width, height } = createTestMap();

  // tiles is already Terrain[][]
  const terrainOnly = tiles;

  // Populate explored set with all land tiles (so all tiles are visible)
  const explored = new Set<string>();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      explored.add(`${x},${y}`);
    }
  }

  const state: any = {
    tiles: terrainOnly,
    mapWidth: width,
    mapHeight: height,
    turn: 1,
    currentPlayer: 'player1',
    winner: null,
    phase: GamePhase.Active,
    cities: [
      { id: 'city1', x: 5, y: 3, owner: 'player1', producing: null, productionTurnsLeft: 0, productionProgress: 0 },
    ] as City[],
    units: [
      {
        id: 'army1',
        type: UnitType.Army,
        owner: 'player1',
        x: 2,
        y: 3,
        health: 100,
        movesLeft: 3,
        sleeping: false,
        hasAttacked: false,
        cargo: [],
        carriedBy: null,
      },
      {
        id: 'transport1',
        type: UnitType.Transport,
        owner: 'player1',
        x: 9,
        y: 3,
        health: 100,
        movesLeft: 6,
        sleeping: false,
        hasAttacked: false,
        cargo: [],
        carriedBy: null,
      },
    ] as Unit[],
    explored: {
      player1: explored,
      player2: new Set(),
    },
    bombersProduced: { player1: 0, player2: 0 },
    seenEnemies: { player1: [], player2: [] },
  };

  return state;
}

function snapshotGame(state: GameState): any {
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

export function runArmyMoveToCoastAndBoardTransportTest(): boolean {
  const replayDir = path.resolve(__dirname, REPLAY_DIR);
  fs.mkdirSync(replayDir, { recursive: true });

  console.log('\n=== Test: Army Move to Coast and Board Transport (2) ===\n');

  const state = createTestGameState();
  const agent = new BasicAgent();
  agent.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  const frames: any[] = [];

  // Record initial state
  frames.push(snapshotGame(state));

  // Run turns - agent takes actions for player1 only
  // Each game turn: agent takes multiple actions until END_TURN, then turn counter increments
  let gameTurn = 0;
  while (gameTurn < MAX_TURNS) {
    gameTurn++;

    // Only act as player1
    const pid = 'player1' as 'player1' | 'player2';

    // Agent takes actions until it ends turn
    while (true) {
      const view: PlayerView = getPlayerView(state, pid);

      const action: AgentAction = agent.act({
        ...view,
        myPlayerId: pid,
        myBomberBlastRadius: 0,
      } as any);

      // Apply the agent's action
      const result = applyAction(state, action, pid);
      if (!result.success) {
        break; // stop this turn
      }

      // Record state after each action
      frames.push(snapshotGame(state));

      // Check if army boarded transport
      const armyCheck = state.units.find((u: Unit) => u.id === 'army1');
      if (armyCheck?.carriedBy === 'transport1') {
        console.log('TEST PASSED: Army boarded transport');
        return true;
      }

      // Check if agent ended turn
      if (action.type === 'END_TURN') {
        break; // exit inner loop, increment game turn
      }
    }

    // Manually reset for next game turn (skip player2)
    for (const unit of state.units) {
      if (unit.owner === pid) {
        const stats = UNIT_STATS[unit.type];
        unit.movesLeft = stats.movesPerTurn;
        unit.hasAttacked = false;
      }
    }
    state.currentPlayer = pid; // switch back to player1
    state.phase = GamePhase.Active; // keep game active
    state.turn++; // increment turn counter
  }

  // Check final state
  const armyFinal = state.units.find((u: Unit) => u.id === 'army1');
  const transport = state.units.find((u: Unit) => u.id === 'transport1');
  const passed = armyFinal?.carriedBy === 'transport1';

  if (passed) {
    console.log('SUCCESS: Army is onboard transport');
  } else {
    console.log('FAILED: Army did not board transport');
    console.log(`Army at (${armyFinal?.x},${armyFinal?.y}), Transport at (${transport?.x},${transport?.y})`);
  }

  // Save replay file
  const id = `test-army-to-transport-2-${Date.now()}`;
  const replayFile = {
    meta: {
      id,
      testName: __filename,
      recordedAt: new Date().toISOString(),
      turns: state.turn,
      winner: state.winner,
      p1Cities: state.cities.filter((c: City) => c.owner === 'player1').length,
      p2Cities: state.cities.filter((c: City) => c.owner === 'player2').length,
      neutralCities: state.cities.filter((c: City) => c.owner === null).length,
      mapWidth: state.mapWidth,
      mapHeight: state.mapHeight,
      frames: frames.length,
      p1Agent: 'basicAgent',
      p2Agent: 'none',
    },
    tiles: state.tiles,
    frames,
  };

  const outputPath = path.join(replayDir, `${id}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(replayFile));
  console.log(`\nReplay saved to: ${outputPath}`);
  console.log(`Run: npm run replay`);

  return passed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runArmyMoveToCoastAndBoardTransportTest();
}
