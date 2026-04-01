/**
 * Test: Army explores home island, captures neutral city, then expands via transport
 *
 * Setup:
 * - 20x10 map
 * - Western island: cols 1-6, rows 2-7
 * - Eastern island: cols 13-18, rows 2-7
 * - Ocean divide between them
 * - Player1 starts at coastal city on western island with 1 army
 * - Neutral city on western island
 * - Neutral city on eastern island
 *
 * Goal:
 * - Army captures neutral city on western island (army is consumed)
 * - Home city produces new army (5 turns)
 * - Captured city produces new army (5 turns)
 * - New armies build transports and sail to eastern island
 */
import {
  runTest,
  getLandTiles,
} from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Explore and Expand to New Island';

function createTwoIslandMap(): { mapConfig: any, cities: any[], units: any[], exploredTiles: string[] } {
  const width = 20;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      } else if (x >= 1 && x <= 5 && y >= 2 && y <= 8) {
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
    { id: 'city1', x: 5, y: 4, owner: 'player1' },
    { id: 'city2', x: 2, y: 4, owner: null },
    { id: 'city3', x: 15, y: 5, owner: null },
  ];

  const units = [
    { id: 'army1', type: UnitType.Army, owner: 'player1', x: 5, y: 4 },
  ];

  // Only explore tiles visible from starting city (radius 2)
  const exploredTiles: string[] = [];
  const startX = 5;
  const startY = 4;
  const visionRange = 2;
  for (let dy = -visionRange; dy <= visionRange; dy++) {
    for (let dx = -visionRange; dx <= visionRange; dx++) {
      const x = startX + dx;
      const y = startY + dy;
      if (y > 0 && y < height - 1 && x >= 0 && x < width) {
        if (tiles[y]?.[x] === Terrain.Land) {
          exploredTiles.push(`${x},${y}`);
        }
      }
    }
  }

  return { mapConfig, cities, units, exploredTiles };
}

async function main() {
  const { mapConfig, cities, units, exploredTiles } = createTwoIslandMap();

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 40,
      exploredTiles,
      victoryCondition: (state) => {
        // Check if player1 has captured all three cities
        const city1Owner = state.cities.find((c) => c.id === 'city1')?.owner;
        const city2Owner = state.cities.find((c) => c.id === 'city2')?.owner;
        const city3Owner = state.cities.find((c) => c.id === 'city3')?.owner;
        return city1Owner === 'player1' && city2Owner === 'player1' && city3Owner === 'player1';
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
    console.log(`Cities: ${JSON.stringify(lastFrame?.cities)}`);

    const p1Units = lastFrame?.units.filter((u) => u.owner === 'player1') || [];
    console.log(`Player1 has ${p1Units.length} units:`);
    p1Units.forEach((u) => {
      console.log(`  - ${u.type} at (${u.x},${u.y}), carriedBy: ${u.carriedBy}`);
    });
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
