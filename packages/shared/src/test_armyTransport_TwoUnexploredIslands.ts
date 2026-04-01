/**
 * Test: Army transport to two unexplored islands
 *
 * Setup:
 *   - 30x10 map with three islands: left, center, right
 *   - P1 has one coastal city on center island
 *   - Neutral city on left island (coastal)
 *   - Neutral city on right island (middle of island, no shore access)
 *   - All production allowed
 *   - P1 starts with transport and army on center island
 *
 * Goal:
 *   - P1 captures all three islands within 50 turns
 *   - Verifies transport can reach unexplored islands and disembark
 */
import { runTest } from './testRunner.js';
import { UnitType, Terrain } from './index.js';

const TEST_NAME = 'Army Transport Two Unexplored Islands';

async function main() {
  // ── Map ────────────────────────────────────────────────────────────────────
  // 30x10 grid.
  // Row 0 / Row 9 → ocean (ice caps)
  // Left island:   x 2-6,   y 2-6
  // Center island: x 12-16, y 2-6
  // Right island:  x 24-28, y 2-6
  const width = 30;
  const height = 10;
  const tiles: Terrain[][] = [];

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      if (y === 0 || y === height - 1) {
        tiles[y][x] = Terrain.Ocean; // ice caps
      } else if (x >= 2 && x <= 6 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land; // Left island
      } else if (x >= 12 && x <= 16 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land; // Center island
      } else if (x >= 24 && x <= 28 && y >= 2 && y <= 6) {
        tiles[y][x] = Terrain.Land; // Right island
      } else {
        tiles[y][x] = Terrain.Ocean;
      }
    }
  }

  const mapConfig = { tiles, width, height };

  // ── Cities ─────────────────────────────────────────────────────────────────
  const cities = [
    // P1 city on center island (coastal - east side)
    { id: 'p1_city1', x: 16, y: 4, owner: 'player1' as const },
    // Neutral city on left island (coastal - east side)
    { id: 'neutral_city1', x: 6, y: 4, owner: null },
    // Neutral city on right island (middle - no shore access)
    { id: 'neutral_city2', x: 26, y: 4, owner: null },
  ];

  // ── Initial units ──────────────────────────────────────────────────────────
  // P1 starts with army and transport on center island
  const units = [
    { id: 'p1_army1', type: UnitType.Army, owner: 'player1' as const, x: 15, y: 4 },
    { id: 'p1_transport1', type: UnitType.Transport, owner: 'player1' as const, x: 17, y: 4 },
  ];

  // ── Fog of war ─────────────────────────────────────────────────────────────
  // P1 only knows their center island initially
  const p1ExploredTiles: string[] = [];
  for (let y = 2; y <= 6; y++) {
    for (let x = 12; x <= 16; x++) {
      p1ExploredTiles.push(`${x},${y}`);
    }
  }

  let leftIslandCaptured = false;
  let rightIslandCaptured = false;

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities,
      units,
      maxTurns: 50,
      p1ExploredTiles,
      testOptions: {
        allowedProduction: undefined, // All production allowed
        cityCaptureSuccessRate: 1,
      },
      victoryCondition: (state) => {
        // Check if neutral cities are captured
        const neutralCity1 = state.cities.find((c) => c.id === 'neutral_city1');
        const neutralCity2 = state.cities.find((c) => c.id === 'neutral_city2');

        if (neutralCity1 && neutralCity1.owner === 'player1' && !leftIslandCaptured) {
          leftIslandCaptured = true;
          console.log(`Left island captured (turn ${state.turn})`);
        }

        if (neutralCity2 && neutralCity2.owner === 'player1' && !rightIslandCaptured) {
          rightIslandCaptured = true;
          console.log(`Right island captured (turn ${state.turn})`);
        }

        // Test passes when both neutral islands are captured
        return leftIslandCaptured && rightIslandCaptured;
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
    const neutralCity1 = lastFrame?.cities.find((c) => c.id === 'neutral_city1');
    const neutralCity2 = lastFrame?.cities.find((c) => c.id === 'neutral_city2');

    console.log(`\n=== FAILURE DIAGNOSTICS ===`);
    console.log(`Turns played: ${lastFrame?.turn ?? '?'}`);
    console.log(`Left island captured: ${leftIslandCaptured} (owner: ${neutralCity1?.owner ?? 'N/A'})`);
    console.log(`Right island captured: ${rightIslandCaptured} (owner: ${neutralCity2?.owner ?? 'N/A'})`);

    const transport = lastFrame?.units.find((u) => u.id === 'p1_transport1');
    if (transport) {
      console.log(`Transport: (${transport.x},${transport.y}), cargo: ${transport.cargo.length}`);
    }
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
