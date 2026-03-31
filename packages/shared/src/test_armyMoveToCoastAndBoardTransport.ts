/**
 * Test: Army should move to coastal transport and board it
 *
 * Setup:
 * - Small 8x6 map
 * - All tiles fully discovered
 * - Island: land at columns 2-4, rows 2-4
 * - Army at (3, 3) - middle of island
 * - Transport at (5, 3) - coastal ocean (adjacent to land at 4,3)
 * - City at (3, 4) - between army and transport
 *
 * Output: Replay-compatible JSON file for visualization
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BasicAgent,
  createGameState,
  applyAction,
  getPlayerView,
  Terrain,
  TileVisibility,
  UnitType,
  GamePhase,
  type GameState,
  type Unit,
  type City,
  type AgentAction,
  type PlayerView,
} from './index.js';

const MAX_TURNS = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = path.basename(fileURLToPath(import.meta.url), '.ts');
const REPLAY_DIR = process.env.REPLAY_DIR ?? path.resolve(__dirname, '..', '..', '..', 'tmp');

function createTestMap(): { tiles: Terrain[][]; width: number; height: number } {
  const width = 8;
  const height = 6;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean; // Ice caps not in Terrain enum, use ocean as impassable
      } else if (x >= 2 && x <= 4 && y >= 2 && y <= 4) {
        tiles[y][x] = Terrain.Land;
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  return { tiles, width, height };
}

function createTestGameState(): GameState {
  const { tiles, width, height } = createTestMap();

  const state: any = {
    tiles,
    mapWidth: width,
    mapHeight: height,
    turn: 1,
    currentPlayer: 'player1',
    winner: null,
    phase: GamePhase.Active,
    cities: [
      { id: 'city1', x: 3, y: 4, owner: 'player1', producing: null, productionTurnsLeft: 0, productionProgress: 0 },
    ] as City[],
    units: [
      {
        id: 'army1',
        type: UnitType.Army,
        owner: 'player1',
        x: 3,
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
        x: 5,
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
      player1: new Set(),
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

  console.log('\n=== Test: Army Move to Coast and Board Transport ===\n');
  console.log('Map: 8x6, Land at cols 2-4, rows 2-4');
  console.log('Army at (3,3), Transport at (5,3), City at (3,4)');
  console.log('');

  const state = createTestGameState();
  const agent = new BasicAgent();
  agent.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  const frames: any[] = [];

  // Record initial state
  frames.push(snapshotGame(state));

  // Run 5 turns - agent takes actions, we apply them
  for (let t = 0; t < MAX_TURNS; t++) {
    const pid = state.currentPlayer as 'player1' | 'player2';
    const view: PlayerView = getPlayerView(state, pid);

    const action: AgentAction = agent.act({
      ...view,
      myPlayerId: pid,
      myBomberBlastRadius: 0,
    } as any);

    console.log(`Turn ${state.turn} ${pid}: ${JSON.stringify(action)}`);

    // Apply the agent's action
    applyAction(state, action, pid);

    // Record state after each turn
    frames.push(snapshotGame(state));

    // Check if army boarded transport
    const army = state.units.find((u: Unit) => u.id === 'army1');
    if (army?.carriedBy === 'transport1') {
      console.log('\n=== TEST PASSED: Army boarded transport ===\n');
      break;
    }
  }

  // Check final state
  const army = state.units.find((u: Unit) => u.id === 'army1');
  const transport = state.units.find((u: Unit) => u.id === 'transport1');
  const passed = army?.carriedBy === 'transport1';

  if (passed) {
    console.log('SUCCESS: Army is onboard transport');
  } else {
    console.log('FAILED: Army did not board transport');
    console.log(`Army at (${army?.x},${army?.y}), Transport at (${transport?.x},${transport?.y})`);
  }

  // Save replay file
  const id = `test-army-to-transport-${Date.now()}`;
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
  console.log(`Run: npm run replay -- --file ${id}.json`);

  return passed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runArmyMoveToCoastAndBoardTransportTest();
}
