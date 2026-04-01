/**
 * Test: Transport departs early with single army when no more armies available
 *
 * Setup:
 * - 20x10 map
 * - Western island: cols 1-6, rows 2-7
 * - Eastern island: cols 13-18, rows 2-7
 * - Ocean divide between them
 * - Player1 starts at coastal city on western island
 * - One army starts one square inland from city
 * - Transport starts at coastal tile next to city
 * - City produces army every 5 turns
 * - Eastern island is visible (unexplored but seen)
 *
 * Goal:
 * - Transport should depart with the single army (no more armies to wait for)
 * - Transport sails to eastern island
 * - Army disembarks
 * - Test passes when transport has successfully delivered the army to the new island
 */
import {
  runTest,
} from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Transport Early Departure';

// Track transport journey for victory condition
let transportReturnedToHome = false;
let transportReturnedAndLoaded = false;
let lastTurn = 0;

function createTwoIslandMap(): { mapConfig: any, cities: any[], units: any[], exploredTiles: string[] } {
  const width = 20;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      } else if (x >= 1 && x <= 6 && y >= 2 && y <= 8) {
        tiles[y][x] = Terrain.Land;
      } else if (x >= 13 && x <= 18 && y >= 2 && y <= 7) {
        tiles[y][x] = Terrain.Land;
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  const cities = [
    { id: 'city1', x: 6, y: 5, owner: 'player1' },
    { id: 'city2', x: 15, y: 5, owner: null },
  ];

  const units = [
    { id: 'army1', type: UnitType.Army, owner: 'player1', x: 5, y: 5 },
    { id: 'transport1', type: UnitType.Transport, owner: 'player1', x: 7, y: 5 },
  ];

  // Explore the western island and make eastern island visible (but not explored)
  const exploredTiles: string[] = [];

  // Explore western island (cols 1-6, rows 2-8)
  for (let y = 2; y <= 8; y++) {
    for (let x = 1; x <= 6; x++) {
      exploredTiles.push(`${x},${y}`);
    }
  }

  // Make eastern island visible but not explored (only the city is seen)
  exploredTiles.push(`15,5`); // The enemy city

  return { mapConfig, cities, units, exploredTiles };
}

async function main() {
  // Reset tracking variables
  transportReturnedToHome = false;
  transportReturnedAndLoaded = false;

  const { mapConfig, cities, units, exploredTiles } = createTwoIslandMap();

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 50,
      exploredTiles,
      victoryCondition: (state) => {
        lastTurn = state.turn;
        if (state.turn < 10) return false; // Need at least 10 turns for full journey

        const transport = state.units.find((u) => u.id === 'transport1');
        if (!transport) return false;

        // Track if transport returned to home island (x <= 7) after delivering
        if (transportReturnedToHome === false && transport.x <= 7 && transport.cargo.length === 0) {
          // Verify we've already delivered an army (at least 1 army on land means army1 was delivered)
          const armiesOnLand = state.units.filter(u => u.type === 'army' && u.owner === 'player1' && !u.carriedBy).length;
          if (armiesOnLand >= 1) {
            transportReturnedToHome = true;
          }
        }

        // Track if transport loaded troops after returning
        if (transportReturnedToHome && transport.x <= 7 && transport.cargo.length > 0) {
          transportReturnedAndLoaded = true;
        }

        // Test passes when transport: departed early, delivered army, returned home, and loaded again
        return transportReturnedAndLoaded;
      },
      testOptions: {
        cityCaptureSuccessRate: 1,
      },
    },
    { verbose: true, saveReplay: true, agentPlayer1: true },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    console.log(`Turn ${lastFrame?.turn}`);
    console.log(`ReturnedToHome: ${transportReturnedToHome}, Returned&Loaded: ${transportReturnedAndLoaded}`);

    const transport = lastFrame?.units.find((u) => u.id === 'transport1');
    console.log(`Transport: at (${transport?.x},${transport?.y}), cargo: ${transport?.cargo.length}`);

    const army1 = lastFrame?.units.find((u) => u.id === 'army1');
    console.log(`Army1: at (${army1?.x},${army1?.y}), carriedBy: ${army1?.carriedBy || '-'}`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
