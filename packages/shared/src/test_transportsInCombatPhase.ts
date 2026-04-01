/**
 * Test: Transport shuttle – back-and-forth in combat phase
 *
 * Setup:
 *   - Two islands separated by ocean, one player on each.
 *   - Both players start with FOG OF WAR on the other island (only own island explored).
 *   - Production is restricted to Army only.
 *   - Player 1 starts with one transport parked offshore and one army on the coast.
 *   - Player 2 starts with just their city (no units) so they don't threaten yet.
 *
 * What we want to verify:
 *   1. P1's army boards the transport.
 *   2. Transport sails to the enemy island and drops off the army.
 *   3. Transport returns to pick up a freshly produced army.
 *   4. Repeat at least twice  ← this is the "smart shuttle" behaviour.
 *
 * Failure modes to look for in combat phase:
 *   - Transport stays idle after dropping army.
 *   - Transport never picks up second army.
 *   - Army never boards because island classification is wrong.
 */
import { runTest } from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Transport Shuttle Combat Phase';

async function main() {
  // ── Map ────────────────────────────────────────────────────────────────────
  // 20×10 grid.
  // Row 0 / Row 9 → ocean (ice caps – no unit can enter).
  // Left island:  x 2-6,  y 2-6  (Player 1)
  // Right island: x 14-18, y 2-6  (Player 2)
  // Everything else → ocean.
  const width = 20;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean; // ice caps
      } else if (x >= 2 && x <= 6 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land; // P1 island
      } else if (x >= 14 && x <= 18 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land; // P2 island
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  // ── Cities ─────────────────────────────────────────────────────────────────
  // Each player gets 2 cities: one on each coast of their island.
  // P1 west: (3,4)  P1 east: (6,4)   ← left island, x 2-6
  // P2 west: (14,4) P2 east: (17,4)  ← right island, x 14-18
  const cities = [
    { id: 'p1_city1', x: 6,  y: 4, owner: 'player1' as const }, // P1 east coast (coastal)
    { id: 'p1_city2', x: 3,  y: 4, owner: 'player1' as const }, // P1 west coast
    { id: 'p2_city1', x: 14, y: 4, owner: 'player2' as const }, // P2 west coast (coastal)
    { id: 'p2_city2', x: 17, y: 4, owner: 'player2' as const }, // P2 east coast
  ];

  // ── Initial units ──────────────────────────────────────────────────────────
  // P1: army at (5,4) on land, transport at (7,4) offshore – west approach.
  // P2: army at (17,4) on land, transport at (19,4) offshore – east approach.
  // Keeping the transports on opposite sides prevents them from blocking each other
  // as they sail across the ocean.
  const units = [
    { id: 'p1_army1',      type: UnitType.Army,      owner: 'player1' as const, x: 5,  y: 4 },
    { id: 'p1_transport1', type: UnitType.Transport,  owner: 'player1' as const, x: 7,  y: 4 },
    { id: 'p2_army1',      type: UnitType.Army,      owner: 'player2' as const, x: 17, y: 4 },
    { id: 'p2_transport1', type: UnitType.Transport,  owner: 'player2' as const, x: 19, y: 4 },
  ];

  // ── Fog of war ─────────────────────────────────────────────────────────────
  // Each player starts knowing ONLY their own island.
  // They will discover the enemy island when their transport sails there.
  const p1ExploredTiles: string[] = [];
  const p2ExploredTiles: string[] = [];

  // P1 knows the full left island (x 2-6, y 2-6)
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) {
      p1ExploredTiles.push(`${x},${y}`);
    }
  }
  // P2 knows the full right island (x 14-18, y 2-6)
  for (let y = 2; y <= 6; y++) {
    for (let x = 14; x <= 18; x++) {
      p2ExploredTiles.push(`${x},${y}`);
    }
  }

  // ── Victory tracking ───────────────────────────────────────────────────────
  // We track how many times the transport has picked up an army on the
  // home island (i.e. cargo goes 0→1 while transport is near P1 island x≤8).
  let pickupCount = 0;
  let dropoffCount = 0;
  let reachedEnemyIsland = false;
  let lastCargo = 0;
  let lastTransportX = 7;

  // ── Player 2 vision ────────────────────────────────────────────────────────
  // P2 needs to see P1 island to have a reason to leave their island
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) {
      p2ExploredTiles.push(`${x},${y}`);
    }
  }

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 60, // plenty of turns for multiple round trips
      p1ExploredTiles,
      p2ExploredTiles,
      testOptions: {
        allowedProduction: [UnitType.Army],
        cityCaptureSuccessRate: 1, // deterministic capture
      },

      victoryCondition: (state) => {
        const transport = state.units.find((u) => u.id === 'p1_transport1');
        if (!transport) return false;

        const cargo = transport.cargo.length;
        const tx = transport.x;

        if (cargo > lastCargo && tx <= 8) {
          pickupCount++;
          console.log(`[turn ${state.turn}] P1 ▲ PICKUP #${pickupCount} at (${tx},${transport.y})`);
        }

        if (cargo < lastCargo) {
          dropoffCount++;
          reachedEnemyIsland = reachedEnemyIsland || tx >= 13;
          console.log(`[turn ${state.turn}] P1 ▼ DROPOFF #${dropoffCount} at (${tx},${transport.y})`);
        }

        // Pass when P1 has made 2 pickups AND reached enemy island
        const p1Pass = pickupCount >= 2 && reachedEnemyIsland;

        // ALSO check P2 for movement as requested by user
        const p2Transport = state.units.find(u => u.id === 'p2_transport1');
        const p2Moved = p2Transport && p2Transport.x < 14; 
        if (p2Moved && !state.units.some(u => u.id === 'p2_moved_logged')) {
          console.log(`[turn ${state.turn}] P2 transport moving west!`);
          state.units.push({ id: 'p2_moved_logged' } as any); // hacky flag
        }

        return p1Pass;
      },
    },
    {
      verbose: true,
      saveReplay: true,
      agentPlayer1: true,
      agentPlayer2: true, // Enable P2 movement as requested!
    },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    const transport = lastFrame?.units.find((u) => u.id === 'p1_transport1');
    const p1Armies = lastFrame?.units.filter(
      (u) => u.owner === 'player1' && u.type === UnitType.Army,
    );
    const p1Cities = lastFrame?.cities.filter((c) => c.owner === 'player1');
    const p2Cities = lastFrame?.cities.filter((c) => c.owner === 'player2');

    console.log(`\n=== FAILURE DIAGNOSTICS ===`);
    console.log(`Turns played:       ${lastFrame?.turn ?? '?'}`);
    console.log(`Pickups made:       ${pickupCount}  (need ≥2)`);
    console.log(`Dropoffs made:      ${dropoffCount}`);
    console.log(`Reached enemy isle: ${reachedEnemyIsland}`);
    if (transport) {
      console.log(`Transport pos:      (${transport.x},${transport.y}), cargo: ${transport.cargo.length}`);
    } else {
      console.log(`Transport:          destroyed`);
    }
    console.log(`P1 armies: ${p1Armies?.length ?? 0}`);
    p1Armies?.forEach((a) =>
      console.log(`  ${a.id}: (${a.x},${a.y}), carriedBy=${a.carriedBy ?? 'none'}`),
    );
    console.log(`P1 cities: ${p1Cities?.map((c) => `${c.id}(${c.x},${c.y})`).join(', ')}`);
    console.log(`P2 cities: ${p2Cities?.map((c) => `${c.id}(${c.x},${c.y})`).join(', ')}`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
