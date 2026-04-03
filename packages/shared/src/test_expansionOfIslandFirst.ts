/**
 * Test: Island expansion with 5 cities - all captured before non-army production
 *
 * Setup:
 * - 20x10 map
 * - Single island spanning cols 1-18, rows 2-7
 * - 5 neutral cities, at least 4 squares apart
 * - Player1 starts with 1 army at one city
 *
 * Goal:
 * - All 5 cities are captured by armies
 * - No non-army unit (fighter, bomber, ship) is built before all cities are taken
 */
import {
  runTest,
  getLandTiles,
  ALL_UNIT_TYPES,
} from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Island Expansion First - All Cities Before Non-Army';

function createFiveCityIslandMap(): { mapConfig: any, cities: any[], units: any[], exploredTiles: string[] } {
  const width = 20;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      } else if (x >= 1 && x <= 18 && y >= 2 && y <= 7) {
        tiles[y][x] = Terrain.Land;
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  // 5 cities, at least 4 squares apart (using wrappedDist for X)
  // Island spans cols 1-18, rows 2-7
  // Coastal cities at y=2 and y=7 (adjacent to ocean)
  // City positions: (2,2), (7,2), (12,2), (17,2), (9,6)
  // - (2,2), (7,2), (12,2), (17,2) are coastal (y=2, adjacent to ocean at y=1)
  // - (9,6) is coastal (y=6, adjacent to ocean at y=7)
  // Distances all >= 4
  const cities = [
    { id: 'city1', x: 2, y: 2, owner: null },
    { id: 'city2', x: 7, y: 2, owner: null },
    { id: 'city3', x: 12, y: 2, owner: null },
    { id: 'city4', x: 17, y: 2, owner: null },
    { id: 'city5', x: 9, y: 6, owner: null },
  ];

  // Start with army at city1 (coastal)
  const units = [
    { id: 'army1', type: UnitType.Army, owner: 'player1', x: 2, y: 2 },
  ];

  // Explore all land tiles
  const exploredTiles = getLandTiles(mapConfig);

  return { mapConfig, cities, units, exploredTiles };
}

async function main() {
  const { mapConfig, cities, units, exploredTiles } = createFiveCityIslandMap();

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 50,
      exploredTiles,
      testOptions: {
        cityCaptureSuccessRate: 1,
        initialProduction: 'army',
      },
      victoryCondition: (state) => {
        // Check if player1 has captured all 5 cities
        const p1CityCount = state.cities.filter((c) => c.owner === 'player1').length;
        if (p1CityCount !== 5) return false;

        // Fail if any non-army unit was built by player1
        const nonArmyUnits = state.units.filter(
          (u) => u.owner === 'player1' && u.type !== UnitType.Army
        );
        return nonArmyUnits.length === 0;
      },
    },
    { verbose: true, saveReplay: true, agentPlayer1: true },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    console.log(`Turn ${lastFrame?.turn}`);
    const p1Cities = lastFrame?.cities.filter((c) => c.owner === 'player1') || [];
    console.log(`Player1 has ${p1Cities.length}/5 cities`);

    const p1Units = lastFrame?.units.filter((u) => u.owner === 'player1') || [];
    console.log(`Player1 has ${p1Units.length} units:`);
    p1Units.forEach((u) => {
      console.log(`  - ${u.type} at (${u.x},${u.y})`);
    });
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
