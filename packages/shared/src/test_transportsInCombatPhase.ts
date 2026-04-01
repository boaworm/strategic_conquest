/**
 * Test: Transport shuttle – back-and-forth in combat phase
 *
 * Setup:
 *   - 20×10 map, two islands separated by ocean.
 *   - P1 island: x 2-6, y 2-6  |  P2 island: x 14-18, y 2-6
 *   - Each player: 2 cities, 1 army, 1 transport offshore.
 *   - Both players see both islands (combat phase from turn 1).
 *   - Production forced to Army only.
 *   - City capture disabled (cityCaptureSuccessRate = 0) to keep island ownership stable.
 *
 * Victory condition:
 *   Both P1 and P2 must each complete 2 full shuttle trips:
 *     trip = pickup at home island → dropoff at enemy island.
 */
import { runTest } from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Transport Shuttle Combat Phase';

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
    { id: 'p1_city1', x: 6, y: 4, owner: 'player1' as const },
    { id: 'p1_city2', x: 3, y: 4, owner: 'player1' as const },
    { id: 'p2_city1', x: 14, y: 4, owner: 'player2' as const },
    { id: 'p2_city2', x: 17, y: 4, owner: 'player2' as const },
  ];

  // Transports offset vertically so they cross the ocean on different rows
  // and avoid head-on combat deadlock.
  const units = [
    { id: 'p1_army1', type: UnitType.Army, owner: 'player1' as const, x: 5, y: 3 },
    { id: 'p1_transport1', type: UnitType.Transport, owner: 'player1' as const, x: 7, y: 2 },
    { id: 'p2_army1', type: UnitType.Army, owner: 'player2' as const, x: 15, y: 5 },
    { id: 'p2_transport1', type: UnitType.Transport, owner: 'player2' as const, x: 13, y: 6 },
  ];

  // Both players see both islands → combat phase from start
  const allLand: string[] = [];
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) allLand.push(`${x},${y}`);
    for (let x = 14; x <= 18; x++) allLand.push(`${x},${y}`);
  }

  // ── Shuttle tracking ───────────────────────────────────────────────────────
  const p1 = { lastCargo: 0, pickups: 0, dropoffs: 0 };
  const p2 = { lastCargo: 0, pickups: 0, dropoffs: 0 };

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 80,
      exploredTiles: allLand,
      testOptions: {
        allowedProduction: [UnitType.Army],
        cityCaptureSuccessRate: 0,
      },

      victoryCondition: (state) => {
        // Track P1 transport
        const t1 = state.units.find((u) => u.id === 'p1_transport1');
        if (t1) {
          const cargo = t1.cargo?.length ?? 0;
          if (cargo > p1.lastCargo && t1.x <= 8) {
            p1.pickups++;
            console.log(`[turn ${state.turn}] P1 ▲ PICKUP #${p1.pickups} at (${t1.x},${t1.y}) cargo=${cargo}`);
          }
          if (cargo < p1.lastCargo && t1.x >= 13) {
            p1.dropoffs++;
            console.log(`[turn ${state.turn}] P1 ▼ DROPOFF #${p1.dropoffs} at (${t1.x},${t1.y}) cargo=${cargo}`);
          }
          p1.lastCargo = cargo;
        }

        // Track P2 transport
        const t2 = state.units.find((u) => u.id === 'p2_transport1');
        if (t2) {
          const cargo = t2.cargo?.length ?? 0;
          if (cargo > p2.lastCargo && t2.x >= 12) {
            p2.pickups++;
            console.log(`[turn ${state.turn}] P2 ▲ PICKUP #${p2.pickups} at (${t2.x},${t2.y}) cargo=${cargo}`);
          }
          if (cargo < p2.lastCargo && t2.x <= 7) {
            p2.dropoffs++;
            console.log(`[turn ${state.turn}] P2 ▼ DROPOFF #${p2.dropoffs} at (${t2.x},${t2.y}) cargo=${cargo}`);
          }
          p2.lastCargo = cargo;
        }

        return p1.dropoffs >= 2 && p2.dropoffs >= 2;
      },
    },
    {
      verbose: true,
      saveReplay: true,
      agentPlayer1: true,
      agentPlayer2: true,
    },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    const t1 = lastFrame?.units.find((u) => u.id === 'p1_transport1');
    const t2 = lastFrame?.units.find((u) => u.id === 'p2_transport1');
    console.log(`\n=== FAILURE DIAGNOSTICS ===`);
    console.log(`Turns played: ${lastFrame?.turn ?? '?'}`);
    console.log(`P1: pickups=${p1.pickups} dropoffs=${p1.dropoffs}  transport=${t1 ? `(${t1.x},${t1.y}) cargo=${t1.cargo?.length}` : 'destroyed'}`);
    console.log(`P2: pickups=${p2.pickups} dropoffs=${p2.dropoffs}  transport=${t2 ? `(${t2.x},${t2.y}) cargo=${t2.cargo?.length}` : 'destroyed'}`);
    const p1Units = lastFrame?.units.filter((u) => u.owner === 'player1') ?? [];
    const p2Units = lastFrame?.units.filter((u) => u.owner === 'player2') ?? [];
    console.log(`P1 units: ${p1Units.map((u) => `${u.type}@(${u.x},${u.y})`).join(', ')}`);
    console.log(`P2 units: ${p2Units.map((u) => `${u.type}@(${u.x},${u.y})`).join(', ')}`);
    const p1Cities = lastFrame?.cities.filter((c) => c.owner === 'player1') ?? [];
    const p2Cities = lastFrame?.cities.filter((c) => c.owner === 'player2') ?? [];
    console.log(`P1 cities: ${p1Cities.map((c) => `${c.id}(${c.x},${c.y})`).join(', ')}`);
    console.log(`P2 cities: ${p2Cities.map((c) => `${c.id}(${c.x},${c.y})`).join(', ')}`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
