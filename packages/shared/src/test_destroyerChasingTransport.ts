/**
 * Test: Destroyer attacks loaded transport first, then empty transport
 *
 * Setup:
 * - 24x10 map with two small islands
 * - P1 destroyer at (5, 4)
 * - P2 loaded transport at (6, 4) with 6 armies - highest priority
 * - P2 empty transport at (7, 4) - lower priority
 *
 * Goal:
 * - Destroyer attacks loaded transport first (tier 0 priority)
 * - After loaded transport destroyed, attacks empty transport (tier 4 priority)
 * - Destroyer vs Transport: 80% chance to destroy per hit
 * - Victory: both transports destroyed within 6 turns
 */
import { runTest } from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Destroyer Chases Transport';

function createDestroyerChaseTestMap(): { mapConfig: any, cities: any[], units: any[], exploredTiles: string[] } {
  const width = 24;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      } else if ((x >= 2 && x <= 4 && y >= 3 && y <= 5) ||
                 (x >= 19 && x <= 21 && y >= 3 && y <= 5)) {
        tiles[y][x] = Terrain.Land;
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  const cities = [
    { id: 'city_p1', x: 3, y: 4, owner: 'player1' },
    { id: 'city_p2', x: 20, y: 4, owner: 'player2' },
  ];

  // Destroyer adjacent to LOADED transport - highest priority target
  // Transport has 6 armies (max capacity) - cannot move until unloaded
  // Empty transport at (7,4) - lower priority, should be attacked after loaded transport
  const units = [
    { id: 'destroyer1', type: UnitType.Destroyer, owner: 'player1', x: 5, y: 4, movesLeft: 6 },
    { id: 'transport1', type: UnitType.Transport, owner: 'player2', x: 6, y: 4, movesLeft: 4, cargo: ['army1', 'army2', 'army3', 'army4', 'army5', 'army6'] },
    { id: 'army1', type: UnitType.Army, owner: 'player2', x: 6, y: 4, movesLeft: 1, carriedBy: 'transport1' },
    { id: 'army2', type: UnitType.Army, owner: 'player2', x: 6, y: 4, movesLeft: 1, carriedBy: 'transport1' },
    { id: 'army3', type: UnitType.Army, owner: 'player2', x: 6, y: 4, movesLeft: 1, carriedBy: 'transport1' },
    { id: 'army4', type: UnitType.Army, owner: 'player2', x: 6, y: 4, movesLeft: 1, carriedBy: 'transport1' },
    { id: 'army5', type: UnitType.Army, owner: 'player2', x: 6, y: 4, movesLeft: 1, carriedBy: 'transport1' },
    { id: 'army6', type: UnitType.Army, owner: 'player2', x: 6, y: 4, movesLeft: 1, carriedBy: 'transport1' },
    { id: 'transport2', type: UnitType.Transport, owner: 'player2', x: 7, y: 4, movesLeft: 4, cargo: [] },
  ];

  const exploredTiles: string[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      exploredTiles.push(`${x},${y}`);
    }
  }

  return { mapConfig, cities, units, exploredTiles };
}

async function main() {
  const { mapConfig, cities, units, exploredTiles } = createDestroyerChaseTestMap();

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 6,
      exploredTiles,
      victoryCondition: (state) => {
        const loadedTransport = state.units.find((u) => u.id === 'transport1');
        const emptyTransport = state.units.find((u) => u.id === 'transport2');
        const loadedDestroyed = loadedTransport === undefined || loadedTransport.health <= 0;
        const emptyDestroyed = emptyTransport === undefined || emptyTransport.health <= 0;
        return loadedDestroyed && emptyDestroyed;
      },
      testOptions: {
        cityCaptureSuccessRate: 1,
        initialProduction: 'army',
      },
    },
    { verbose: false, saveReplay: true, agentPlayer1: true, agentPlayer2: false },
  );

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
