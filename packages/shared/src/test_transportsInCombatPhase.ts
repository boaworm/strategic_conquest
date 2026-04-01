/**
 * Test: Transports continue shuttling armies in combat phase
 *
 * Setup:
 * - 30x10 map
 * - Western island: cols 2-4, rows 2-7 (player 1)
 * - Eastern island: cols 25-27, rows 2-7 (player 2)
 * - Ocean divide between them
 * - Player 1: 2 cities on western island, 1 transport, 1 army
 * - Player 2: 2 cities on eastern island, 1 transport, 1 army
 * - All production fixed to armies
 * - Both islands fully explored (so we're in Combat phase from start)
 *
 * Goal:
 * - Both transports should sail to the enemy island
 * - Test passes when P1 transport reaches eastern island (x >= 24) with cargo
 */
import {
  runTest,
} from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Transports In Combat Phase';

// Track transport journey
let p1TransportReachedEnemyIsland = false;

function createTwoIslandMap(): { mapConfig: any, cities: any[], units: any[], exploredTiles: string[] } {
  const width = 30;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      } else if (x >= 2 && x <= 4 && y >= 2 && y <= 7) {
        tiles[y][x] = Terrain.Land;
      } else if (x >= 25 && x <= 27 && y >= 2 && y <= 7) {
        tiles[y][x] = Terrain.Land;
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  const cities = [
    // Player 1 cities on western island
    { id: 'p1_city1', x: 4, y: 4, owner: 'player1' },
    { id: 'p1_city2', x: 3, y: 5, owner: 'player1' },
    // Player 2 cities on eastern island
    { id: 'p2_city1', x: 25, y: 4, owner: 'player2' },
    { id: 'p2_city2', x: 26, y: 5, owner: 'player2' },
  ];

  const units = [
    // Player 1 units - army adjacent to transport
    { id: 'p1_army1', type: UnitType.Army, owner: 'player1', x: 4, y: 4 },
    { id: 'p1_transport1', type: UnitType.Transport, owner: 'player1', x: 5, y: 4 },
    // Player 2 units - army adjacent to transport
    { id: 'p2_army1', type: UnitType.Army, owner: 'player2', x: 25, y: 4 },
    { id: 'p2_transport1', type: UnitType.Transport, owner: 'player2', x: 24, y: 4 },
  ];

  // Explore both islands fully
  const exploredTiles: string[] = [];

  // Western island (player 1)
  for (let y = 2; y <= 7; y++) {
    for (let x = 2; x <= 4; x++) {
      exploredTiles.push(`${x},${y}`);
    }
  }

  // Eastern island (player 2)
  for (let y = 2; y <= 7; y++) {
    for (let x = 25; x <= 27; x++) {
      exploredTiles.push(`${x},${y}`);
    }
  }

  return { mapConfig, cities, units, exploredTiles };
}

async function main() {
  p1TransportReachedEnemyIsland = false;

  const { mapConfig, cities, units, exploredTiles } = createTwoIslandMap();

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 100,
      exploredTiles,
      victoryCondition: (state) => {
        const p1Transport = state.units.find((u) => u.id === 'p1_transport1');

        if (!p1Transport) return false;

        // Track P1 transport: reached eastern island (adjacent, x >= 24) with cargo
        if (!p1TransportReachedEnemyIsland && p1Transport.x >= 24 && p1Transport.cargo.length > 0) {
          p1TransportReachedEnemyIsland = true;
          console.log(`P1 transport reached enemy island at (${p1Transport.x},${p1Transport.y}) with cargo=${p1Transport.cargo.length}`);
        }

        // Test passes when transport reaches enemy island with cargo
        return p1TransportReachedEnemyIsland;
      },
      testOptions: {
        cityCaptureSuccessRate: 1,
      },
    },
    { verbose: true, saveReplay: true, agentPlayer1: true, agentPlayer2: true },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    const p1Transport = lastFrame?.units.find((u) => u.id === 'p1_transport1');
    const p1Army = lastFrame?.units.find((u) => u.id === 'p1_army1');
    console.log(`Turn ${lastFrame?.turn}`);
    console.log(`P1 Transport: at (${p1Transport?.x},${p1Transport?.y}), cargo: ${p1Transport?.cargo.length}`);
    console.log(`P1 Army: at (${p1Army?.x},${p1Army?.y}), carriedBy: ${p1Army?.carriedBy}`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
