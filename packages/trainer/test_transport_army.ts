import { describe, it } from 'node:test';
import { equal } from 'node:assert/strict';
import { BasicAgent } from '@sc/shared';
import { UnitType, AgentAction } from '@sc/shared/src/types';

// Mock game state for testing
describe('Transport & Army Movement', () => {
  const agent = new BasicAgent();
  const mapWidth = 10;
  const mapHeight = 10;

  const islandOf = new Map<string, number>([
    ['1,1', 0], ['2,1', 0], ['3,1', 0],  // Friendly island
    ['1,5', 1], ['2,5', 1], ['3,5', 1]   // Unexplored island
  ]);

  const mineIndices = new Set<number>([0]);
  const exploredIslands = new Set<number>([0]);

  // Mock observations
  const baseObs: AgentObservation = {
    myUnits: [],
    myCities: [{ x: 1, y: 1, coastal: true }],
    tiles: Array(mapHeight).fill(0).map((_, y) =>
      Array(mapWidth).fill(0).map((_, x) => ({
        terrain: y === 1 ? 'Land' : 'Ocean',
        visibility: y === 1 ? 'Visible' : 'Hidden'
      }))
    ),
    visibleEnemyUnits: [],
    visibleEnemyCities: [],
    turn: 1,
    phase: 1
  };

  // Test 1: Transport should load armies from coastal city
  it('Transport loads armies from coastal city', () => {
    // Setup: Transport at coastal ocean, armies in city
    const transport: UnitView = {
      id: 't1',
      type: UnitType.Transport,
      x: 2, y: 1,  // At ocean tile adjacent to city
      cargo: [],
      movesLeft: 5
    };

    const army: UnitView = {
      id: 'a1',
      type: UnitType.Army,
      x: 1, y: 1,  // At city center
      cargo: [],
      movesLeft: 5
    };

    const obs = {
      ...baseObs,
      myUnits: [transport, army],
      tiles: Array(mapHeight).fill(0).map((_, y) =>
        Array(mapWidth).fill(0).map((_, x) => ({
          terrain: y === 1 ? 'Land' : 'Ocean',
          visibility: y === 1 || (y === 0 && x === 2) ? 'Visible' : 'Hidden'
        }))
      ),
      islandOf,
      mineIndices,
      exploredIslands
    };

    // Phase 1 - transport should load army
    agent.phase = 1;
    const result = agent.determineMoveForTransport(obs, transport, mineIndices, exploredIslands, islandOf);

    equal((result as { type: string }).type, 'LOAD', 'Transport should load armies when available');
    equal((result as { transportId: string }).transportId, army.id, 'Transport should target correct army');
  });

  // Test 2: Transport with army should sail to unexplored island
  it('Transport with army sails to unexplored island', () => {
    const transport: UnitView = {
      id: 't1',
      type: UnitType.Transport,
      x: 2, y: 1,
      cargo: [{ id: 'a1', type: UnitType.Army }],
      movesLeft: 5
    };

    const obs = {
      ...baseObs,
      myUnits: [transport],
      islandOf,
      mineIndices,
      exploredIslands: new Set<number>([0])
    };

    // Phase 2 - transport should head to unexplored island
    agent.phase = 2;
    const result = agent.determineMoveForTransport(obs, transport, mineIndices, exploredIslands, islandOf);

    equal((result as { type: string }).type, 'MOVE', 'Transport should move with loaded army');
    // Add more specific checks for target island
  });

  // Test 3: Disembark on unexplored island
  it('Army disembarks on unexplored island', () => {
    const transport: UnitView = {
      id: 't1',
      type: UnitType.Transport,
      x: 1, y: 5,  // At unexplored island
      cargo: [{ id: 'a1', type: UnitType.Army }],
      movesLeft: 5
    };

    const obs = {
      ...baseObs,
      myUnits: [transport],
      visibleEnemyCities: [],
      islandOf,
      mineIndices: new Set<number>([0]),
      exploredIslands: new Set<number>([0])
    };

    const result = agent.determineMoveForTransport(obs, transport, mineIndices, exploredIslands, islandOf);
    equal((result as { type: string }).type, 'UNLOAD', 'Army should disembark on unexplored island');
  });
});