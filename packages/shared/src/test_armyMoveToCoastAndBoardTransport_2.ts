/**
 * Test: Army should move to coastal transport and board it
 *
 * Setup:
 * - 10x8 map
 * - Island: 6x6 land area at columns 2-7, rows 1-6
 * - Army at (2, 3) - west side of island
 * - Transport at (9, 3) - east coast ocean (off the east side)
 * - City at (5, 3) - in the middle between army and transport
 *
 * Output: Replay-compatible JSON file for visualization
 */
import {
  runTest,
  createIslandMap,
  getLandTiles,
} from './testRunner.js';
import { UnitType } from './index.js';

const TEST_NAME = 'Army Move to Coast and Board Transport v2';

async function main() {
  const mapConfig = createIslandMap(10, 8, { x: 2, y: 1, w: 6, h: 6 });

  const result = await runTest(
    {
      testName: TEST_NAME,
      mapConfig,
      cities: [
        { id: 'city1', x: 5, y: 3, owner: 'player1' },
      ],
      units: [
        { id: 'army1', type: UnitType.Army, owner: 'player1', x: 2, y: 3 },
        { id: 'transport1', type: UnitType.Transport, owner: 'player1', x: 9, y: 3 },
      ],
      maxTurns: 6,
      exploredTiles: getLandTiles(mapConfig),
      victoryCondition: (state) => {
        const army = state.units.find((u) => u.id === 'army1');
        return army?.carriedBy === 'transport1';
      },
    },
    { verbose: true, saveReplay: true, agentPlayer1: true },
  );

  if (!result.passed) {
    const army = result.frames?.[result.frames.length - 1]?.units.find((u) => u.id === 'army1');
    const transport = result.frames?.[result.frames.length - 1]?.units.find((u) => u.id === 'transport1');
    console.log(`Army at (${army?.x},${army?.y}), Transport at (${transport?.x},${transport?.y})`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
