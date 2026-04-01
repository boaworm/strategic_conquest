/**
 * Test: Battleship prioritizes attacking enemy transport, then bombards city
 *
 * Setup:
 * - 20x10 map
 * - Island: 3x5 at cols 7-9, rows 2-6
 * - P2 city on west side of island at (7, 4)
 * - P1 battleship at (6, 4) - one square west of city (adjacent)
 * - P2 transport with 1 army at (5, 4) - between battleship and city
 * - P2 has 1 army in the city
 * - City produces armies
 *
 * Goal:
 * - Battleship attacks and destroys the transport (adjacent)
 * - Battleship moves to city and bombards until no armies remain
 * - Victory: city is undefended (no armies left)
 */
import {
  runTest,
  getLandTiles,
} from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Battleship Prioritizes Transport Then City';

function createBattleshipTestMap(): { mapConfig: any, cities: any[], units: any[], exploredTiles: string[] } {
  const width = 20;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        // Ice cap rows
        tiles[y][x] = Terrain.Ocean;
      } else if (x >= 7 && x <= 9 && y >= 2 && y <= 6) {
        // Island: 3x5 rectangle
        tiles[y][x] = Terrain.Land;
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  // P2 city on west side of island
  const cities = [
    { id: 'city1', x: 7, y: 4, owner: 'player2' },
  ];

  // P1 battleship adjacent to transport, transport adjacent to city
  const units = [
    { id: 'battleship1', type: UnitType.Battleship, owner: 'player1', x: 6, y: 4, movesLeft: 5 },
    { id: 'transport1', type: UnitType.Transport, owner: 'player2', x: 5, y: 4, movesLeft: 4, cargo: ['army1'] },
    { id: 'army1', type: UnitType.Army, owner: 'player2', x: 5, y: 4, movesLeft: 1 },
    { id: 'army2', type: UnitType.Army, owner: 'player2', x: 7, y: 4, movesLeft: 1 },
  ];

  // Explore all ocean and land tiles for both players (full visibility)
  const exploredTiles: string[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      exploredTiles.push(`${x},${y}`);
    }
  }

  return { mapConfig, cities, units, exploredTiles };
}

async function main() {
  const { mapConfig, cities, units, exploredTiles } = createBattleshipTestMap();

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 20,
      exploredTiles,
      victoryCondition: (state) => {
        // Find the city
        const city = state.cities.find((c) => c.id === 'city1');
        if (!city || city.owner !== 'player2') return false;

        // Check if there are any P2 armies on the city tile
        const armiesOnCity = state.units.filter(
          (u) => u.owner === 'player2' && u.type === UnitType.Army &&
            u.x === city.x && u.y === city.y
        );

        // Victory when no armies are left on the city
        return armiesOnCity.length === 0;
      },
      testOptions: {
        cityCaptureSuccessRate: 1,
        initialProduction: 'army',
      },
    },
    { verbose: true, saveReplay: true, agentPlayer1: true, agentPlayer2: true },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    console.log(`\nTurn ${lastFrame?.turn}`);

    const city = lastFrame?.cities.find((c) => c.id === 'city1');
    console.log(`City owner: ${city?.owner}`);

    const p2Armies = lastFrame?.units.filter(
      (u) => u.owner === 'player2' && u.type === UnitType.Army
    );
    console.log(`P2 armies: ${p2Armies?.length || 0}`);
    p2Armies?.forEach((u) => {
      console.log(`  - Army at (${u.x},${u.y})`);
    });

    const battleship = lastFrame?.units.find((u) => u.type === UnitType.Battleship);
    console.log(`Battleship at (${battleship?.x},${battleship?.y}), health: ${battleship?.health}`);

    const transport = lastFrame?.units.find((u) => u.type === UnitType.Transport);
    console.log(`Transport: ${transport ? 'exists' : 'destroyed'}`);

    // Show all units
    console.log(`\nAll units:`);
    lastFrame?.units.forEach((u) => {
      console.log(`  - ${u.owner}'s ${u.type} at (${u.x},${u.y}), health: ${u.health}, cargo: ${u.cargo?.length ?? 0}`);
    });
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
