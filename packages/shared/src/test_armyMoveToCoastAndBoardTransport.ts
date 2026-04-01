/**
 * Test: Army should move to coastal transport and board it
 *
 * Setup:
 * - Small 8x6 map
 * - All tiles fully discovered
 * - Island: land at columns 2-4, rows 2-4
 * - Army at (3, 3) - middle of island
 * - Transport at (5, 3) - coastal ocean (adjacent to land at 4,3)
 * - City at (3, 4) - between army and transport
 *
 * Output: Replay-compatible JSON file for visualization
 */
import {
  runTest,
  createIslandMap,
  getLandTiles,
} from './testRunner.js';
import { UnitType } from './index.js';

const TEST_NAME = 'Army Move to Coast and Board Transport';

async function main() {
  const mapConfig = createIslandMap(8, 6, { x: 2, y: 2, w: 3, h: 3 });

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities: [
        { id: 'city1', x: 3, y: 4, owner: 'player1' },
      ],
      units: [
        { id: 'army1', type: UnitType.Army, owner: 'player1', x: 3, y: 3 },
        { id: 'transport1', type: UnitType.Transport, owner: 'player1', x: 5, y: 3 },
      ],
      maxTurns: 5,
      exploredTiles: getLandTiles(mapConfig),
      victoryCondition: (state) => {
        const army = state.units.find((u) => u.id === 'army1');
        return army?.carriedBy === 'transport1';
      },
    },
    { verbose: true, saveReplay: true, agentPlayer1: true },
  );

  if (!result.passed) {
    const lastFrame = result.frames?.[result.frames.length - 1];
    const army = lastFrame?.units.find((u) => u.id === 'army1');
    const transport = lastFrame?.units.find((u) => u.id === 'transport1');
    console.log(`Army at (${army?.x},${army?.y}), Transport at (${transport?.x},${transport?.y})`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
