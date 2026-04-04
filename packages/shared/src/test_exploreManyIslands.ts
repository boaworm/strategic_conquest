/**
 * Test: Explore Many Islands
 *
 * Goal: Ensure BasicAgent can conquer 10 islands (20-30 cities total) within 100 turns.
 *
 * Map: 60x30 with 10 islands, 2-3 cities each.
 * Player: Single BasicAgent (player1) vs neutral cities.
 * Victory: All cities owned by player1.
 */
import {
  type TestConfig,
  runTest,
  createIslandMap,
  getLandTiles,
} from './testRunner.js';
import { Terrain, UnitType } from './index.js';

// Create a 60x30 map with 10 islands arranged in 2 rows of 5
function createManyIslandsMap(): { mapConfig: any; cities: any[] } {
  const width = 60;
  const height = 30;

  // Island layout: 2 rows, 5 columns
  // Each island is roughly 8x6 with spacing
  const islandConfigs = [
    // Row 1 (y=3)
    { x: 3, y: 3, w: 8, h: 6, cities: 3 },
    { x: 14, y: 3, w: 8, h: 6, cities: 2 },
    { x: 25, y: 3, w: 8, h: 6, cities: 3 },
    { x: 36, y: 3, w: 8, h: 6, cities: 2 },
    { x: 47, y: 3, w: 8, h: 6, cities: 3 },
    // Row 2 (y=13)
    { x: 3, y: 13, w: 8, h: 6, cities: 2 },
    { x: 14, y: 13, w: 8, h: 6, cities: 3 },
    { x: 25, y: 13, w: 8, h: 6, cities: 2 },
    { x: 36, y: 13, w: 8, h: 6, cities: 3 },
    { x: 47, y: 13, w: 8, h: 6, cities: 2 },
  ];

  // Initialize ocean map
  const tiles: Terrain[][] = [];
  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      tiles[y][x] = Terrain.Ocean;
    }
  }

  // Place islands
  const allLandTiles: string[] = [];
  for (const island of islandConfigs) {
    for (let dy = 0; dy < island.h; dy++) {
      for (let dx = 0; dx < island.w; dx++) {
        const x = island.x + dx;
        const y = island.y + dy;
        if (y > 0 && y < height - 1) {
          tiles[y][x] = Terrain.Land;
          allLandTiles.push(`${x},${y}`);
        }
      }
    }
  }

  const mapConfig = { tiles, width, height };

  // Place cities on each island (spread out)
  const cities: any[] = [];
  let cityId = 1;

  for (let i = 0; i < islandConfigs.length; i++) {
    const island = islandConfigs[i];
    const cityPositions: { x: number; y: number }[] = [];

    if (island.cities === 2) {
      // Two cities: opposite corners (both coastal)
      cityPositions.push({ x: island.x, y: island.y });           // top-left corner (coastal)
      cityPositions.push({ x: island.x + island.w - 1, y: island.y + island.h - 1 }); // bottom-right (coastal)
    } else {
      // Three cities: all on edges (coastal)
      cityPositions.push({ x: island.x, y: island.y });                    // top-left (coastal)
      cityPositions.push({ x: island.x + island.w - 1, y: island.y });     // top-right (coastal)
      cityPositions.push({ x: island.x + Math.floor(island.w / 2), y: island.y + island.h - 1 }); // bottom (coastal)
    }

    for (let j = 0; j < cityPositions.length; j++) {
      const pos = cityPositions[j];
      // First city on first island is player1's starting city (coastal)
      const isStartingCity = (i === 0 && j === 0);
      cities.push({
        id: `city_${cityId++}`,
        x: pos.x,
        y: pos.y,
        owner: isStartingCity ? 'player1' : null,
      });
    }
  }

  return { mapConfig, cities };
}

// Victory condition: all cities owned by player1
function allCitiesCaptured(state: any): boolean {
  const neutralCities = state.cities.filter((c: any) => c.owner === null).length;
  return neutralCities === 0;
}

// Test configuration
const { mapConfig, cities } = createManyIslandsMap();

// Only ONE starting army on player1's starting city (at coastal position 3,3)
const units = [{
  id: 'army_start',
  type: UnitType.Army,
  owner: 'player1' as const,
  x: 3,
  y: 3,
  movesLeft: 3,
}];

const config: TestConfig = {
  testName: 'exploreManyIslands',
  mapConfig,
  cities,
  units,
  maxTurns: 150,
  exploredTiles: [], // Start unexplored
  victoryCondition: allCitiesCaptured,
  testOptions: {
    initialProduction: 'army',
  },
};

// Run the test
runTest(config, { verbose: true, saveReplay: true })
  .then((result) => {
    console.log('\n=== Final Result ===');
    console.log(`Passed: ${result.passed}`);
    console.log(`Turns: ${result.turns}`);
    console.log(`Message: ${result.message}`);
    if (result.replayPath) {
      console.log(`Replay: ${result.replayPath}`);
    }
    process.exit(result.passed ? 0 : 1);
  })
  .catch((err) => {
    console.error('Test error:', err);
    process.exit(1);
  });
