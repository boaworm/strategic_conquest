/**
 * Test: Army transport - capture neutral island in combat phase
 *
 * Setup:
 *   - 30x10 map with two islands: west (P1), east (neutral)
 *   - P1 on west island with coastal city, army, and transport
 *   - Neutral city on east island (coastal)
 *   - P1 starts in combat phase (simulated by having visible enemy elsewhere)
 *
 * Goal:
 *   - P1 loads army, sails to east island, captures neutral city
 *   - Verifies transport can reach and disembark at unexplored neutral islands
 *
 * Success criteria:
 *   - P1 captures neutral city on east island
 */
import { runTest } from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Army Transport Capture Neutral Island';

async function main() {
  // ── Map ────────────────────────────────────────────────────────────────────
  // 30x10 grid.
  // Row 0 / Row 9 → ocean (ice caps)
  // West island:   x 2-6,   y 2-6   (P1)
  // East island:   x 24-28, y 2-6   (neutral)
  const width = 30;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean; // ice caps
      } else if (x >= 2 && x <= 6 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land; // West island (P1)
      } else if (x >= 24 && x <= 28 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land; // East island (neutral)
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  // ── Cities ─────────────────────────────────────────────────────────────────
  const cities = [
    // P1 city on west island (coastal - east side for transport access)
    { id: 'p1_city1', x: 6, y: 4, owner: 'player1' as const },
    // Neutral city on east island (coastal - west side)
    { id: 'neutral_city1', x: 24, y: 4, owner: null },
  ];

  // ── Initial units ──────────────────────────────────────────────────────────
  // P1 starts with army adjacent to transport for easy loading
  const units = [
    { id: 'p1_army1', type: UnitType.Army, owner: 'player1' as const, x: 6, y: 4 },
    { id: 'p1_transport1', type: UnitType.Transport, owner: 'player1' as const, x: 7, y: 4 },
  ];

  // ── Fog of war ─────────────────────────────────────────────────────────────
  // P1 only knows their west island initially
  const p1ExploredTiles: string[] = [];
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) {
      p1ExploredTiles.push(`${x},${y}`);
    }
  }

  let neutralCityCaptured = false;

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 40,
      p1ExploredTiles,
      testOptions: {
        allowedProduction: undefined,
        cityCaptureSuccessRate: 1,
      },
      victoryCondition: (state) => {
        // Check if neutral city is captured
        const neutralCity = state.cities.find((c) => c.id === 'neutral_city1');
        if (neutralCity && neutralCity.owner === 'player1' && !neutralCityCaptured) {
          neutralCityCaptured = true;
          console.log(`Neutral city captured (turn ${state.turn})`);
        }

        return neutralCityCaptured;
      },
    },
    {
      verbose: true,
      saveReplay: true,
      agentPlayer1: true,
      agentPlayer2: false,
    },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    const neutralCity = lastFrame?.cities.find((c) => c.id === 'neutral_city1');

    console.log(`\n=== FAILURE DIAGNOSTICS ===`);
    console.log(`Turns played: ${lastFrame?.turn ?? '?'}`);
    console.log(`Neutral city captured: ${neutralCityCaptured} (owner: ${neutralCity?.owner ?? 'N/A'})`);

    const transport = lastFrame?.units.find((u) => u.id === 'p1_transport1');
    if (transport) {
      console.log(`Transport: (${transport.x},${transport.y}), cargo: ${transport.cargo.length}`);
    }

    const p1Armies = lastFrame?.units.filter(u => u.owner === 'player1' && u.type === UnitType.Army);
    console.log(`P1 armies: ${p1Armies?.length ?? 0}`);
    p1Armies?.forEach(a => console.log(`  ${a.id}: (${a.x},${a.y}), carriedBy=${a.carriedBy ?? 'none'}`));
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
