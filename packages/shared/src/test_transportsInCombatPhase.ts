/**
 * Test: Transports shuttle armies back and forth between islands
 *
 * Setup:
 * - 20x10 map
 * - Western island: 5x5 at cols 2-6, rows 2-6 (player 1)
 * - Eastern island: 5x5 at cols 14-18, rows 2-6 (player 2)
 * - Player 1: 2 cities on western island
 * - Player 2: 2 cities on eastern island
 * - All production locked to armies
 * - Both islands fully explored (Combat phase from start)
 * - Initial armies ready to load
 *
 * Goal:
 * - Transports load armies, sail to enemy island, disembark, return
 * - Test passes when both transports have completed round trips
 */
import {
  runTest,
} from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Transports In Combat Phase';

async function main() {
  const width = 20;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean;
      } else if (x >= 2 && x <= 6 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land;
      } else if (x >= 14 && x <= 18 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land;
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  const cities = [
    // Player 1 cities on western island
    { id: 'p1_city1', x: 4, y: 4, owner: 'player1' as const },
    { id: 'p1_city2', x: 4, y: 2, owner: 'player1' as const },
    // Player 2 cities on eastern island
    { id: 'p2_city1', x: 16, y: 4, owner: 'player2' as const },
    { id: 'p2_city2', x: 16, y: 6, owner: 'player2' as const },
  ];

  const units = [
    // Player 1: 1 army between cities (x=4), transport at coastal
    { id: 'p1_army1', type: UnitType.Army, owner: 'player1' as const, x: 3, y: 4 },
    { id: 'p1_transport1', type: UnitType.Transport, owner: 'player1' as const, x: 7, y: 4 },
    // Player 2: 1 army between cities (x=16), transport at coastal
    { id: 'p2_army1', type: UnitType.Army, owner: 'player2' as const, x: 15, y: 4 },
    { id: 'p2_transport1', type: UnitType.Transport, owner: 'player2' as const, x: 13, y: 4 },
  ];

  // Explore both islands fully
  const exploredTiles: string[] = [];
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) exploredTiles.push(`${x},${y}`);
    for (let x = 14; x <= 18; x++) exploredTiles.push(`${x},${y}`);
  }

  let p1RoundTrips = 0;
  let p2RoundTrips = 0;
  let p1Departed = false;  // Has P1 transport left home island with cargo?
  let p2Departed = false;  // Has P2 transport left home island with cargo?
  let p1Unloaded = false;  // Has P1 unloaded at enemy?
  let p2Unloaded = false;  // Has P2 unloaded at enemy?
  let p1Returned = false;  // Has P1 returned home empty?
  let p2Returned = false;  // Has P2 returned home empty?

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 100,
      exploredTiles,
      testOptions: {
        allowedProduction: [UnitType.Army],
      },
      victoryCondition: (state) => {
        const p1Transport = state.units.find((u) => u.id === 'p1_transport1');
        const p2Transport = state.units.find((u) => u.id === 'p2_transport1');

        if (!p1Transport || !p2Transport) return false;

        const p1AtHome = p1Transport.x <= 7 && p1Transport.y >= 2 && p1Transport.y <= 6;
        const p1HasCargo = p1Transport.cargo.length > 0;
        const p2AtHome = p2Transport.x >= 12 && p2Transport.y >= 2 && p2Transport.y <= 6;
        const p2HasCargo = p2Transport.cargo.length > 0;

        // Track P1 round trip sequence: load -> depart -> unload -> return -> load again
        // P1 departed home island with cargo
        if (!p1Departed && !p1AtHome && p1HasCargo) {
          p1Departed = true;
          console.log(`P1 transport departed for enemy island (${p1Transport.x},${p1Transport.y}) with ${p1Transport.cargo.length} armies (turn ${state.turn})`);
        }
        // P1 unloaded at enemy island
        if (p1Departed && !p1Unloaded && !p1AtHome && !p1HasCargo) {
          p1Unloaded = true;
          console.log(`P1 transport unloaded at enemy island (turn ${state.turn})`);
        }
        // P1 returned home empty
        if (p1Unloaded && !p1Returned && p1AtHome && !p1HasCargo) {
          p1Returned = true;
          console.log(`P1 transport returned home empty (turn ${state.turn})`);
        }
        // P1 loaded again at home = completed round trip
        if (p1Returned && !p1AtHome && p1HasCargo) {
          p1RoundTrips++;
          console.log(`P1 transport departed with cargo - round trip #${p1RoundTrips} complete (turn ${state.turn})`);
        }

        // Track P2 round trip sequence
        // P2 departed home island with cargo
        if (!p2Departed && !p2AtHome && p2HasCargo) {
          p2Departed = true;
          console.log(`P2 transport departed for enemy island (${p2Transport.x},${p2Transport.y}) with ${p2Transport.cargo.length} armies (turn ${state.turn})`);
        }
        // P2 unloaded at enemy island
        if (p2Departed && !p2Unloaded && !p2AtHome && !p2HasCargo) {
          p2Unloaded = true;
          console.log(`P2 transport unloaded at enemy island (turn ${state.turn})`);
        }
        // P2 returned home empty
        if (p2Unloaded && !p2Returned && p2AtHome && !p2HasCargo) {
          p2Returned = true;
          console.log(`P2 transport returned home empty (turn ${state.turn})`);
        }
        // P2 loaded again at home = completed round trip
        if (p2Returned && !p2AtHome && p2HasCargo) {
          p2RoundTrips++;
          console.log(`P2 transport departed with cargo - round trip #${p2RoundTrips} complete (turn ${state.turn})`);
        }

        // Test passes when both transports have completed at least 1 round trip
        return p1RoundTrips >= 1 && p2RoundTrips >= 1;
      },
    },
    { verbose: true, saveReplay: true, agentPlayer1: true, agentPlayer2: true },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    const p1Transport = lastFrame?.units.find((u) => u.id === 'p1_transport1');
    const p2Transport = lastFrame?.units.find((u) => u.id === 'p2_transport1');
    console.log(`\nTurn ${lastFrame?.turn}`);
    console.log(`P1 round trips: ${p1RoundTrips}, P2 round trips: ${p2RoundTrips}`);
    console.log(`P1 Transport: at (${p1Transport?.x},${p1Transport?.y}), cargo: ${p1Transport?.cargo.length}`);
    console.log(`P2 Transport: at (${p2Transport?.x},${p2Transport?.y}), cargo: ${p2Transport?.cargo.length}`);

    const p1Armies = lastFrame?.units.filter(u => u.type === UnitType.Army && u.owner === 'player1' && !u.carriedBy).length || 0;
    const p2Armies = lastFrame?.units.filter(u => u.type === UnitType.Army && u.owner === 'player2' && !u.carriedBy).length || 0;
    console.log(`P1 armies on land: ${p1Armies}, P2 armies on land: ${p2Armies}`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
