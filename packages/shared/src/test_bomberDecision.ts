import {
  GameState,
  PlayerId,
  Terrain,
  UnitType,
  GamePhase,
  Coord,
} from './types.js';
import { runTest, TestConfig, createIslandMap } from './testRunner.js';

/**
 * Test: Bombers should attack highest-value enemy targets
 *
 * Setup:
 * - Map: 30x8
 * - P1 city at (5, 3) with 2 bombers starting there
 * - Tiny 2x2 island at (14, 2) with P2 city
 * - P2 Battleship at (11, 4) - leftmost
 * - P1 Destroyer at (13, 4) - middle, provides vision for both targets
 * - P2 Transport at (15, 4) - rightmost, with cargo (higher priority)
 *
 * Success: Both bombers attack their correct targets (transport + battleship)
 * Replay: Turn 0 shows all units, Turn 2 shows P1 victory with only destroyer remaining
 */

export function createBomberDecisionTestMap(): GameState {
  const mapWidth = 30;
  const mapHeight = 8;

  // Create ocean map
  const tiles: Terrain[][] = Array.from({ length: mapHeight }, () =>
    Array.from({ length: mapWidth }, () => Terrain.Ocean),
  );

  // Create tiny 2x2 island at (14, 2)
  tiles[2][14] = Terrain.Land;
  tiles[2][15] = Terrain.Land;
  tiles[3][14] = Terrain.Land;
  tiles[3][15] = Terrain.Land;

  const state: GameState = {
    mapWidth,
    mapHeight,
    tiles,
    cities: [],
    units: [],
    currentPlayer: 'player1',
    turn: 1,
    phase: GamePhase.Active,
    winner: null,
    explored: { player1: new Set(), player2: new Set() },
    bombersProduced: { player1: 0, player2: 0 },
    testOptions: {
      cityCaptureSuccessRate: 1,
    },
  };

  // P2 city at (14, 2) on the tiny island
  state.cities.push({
    id: 'city_p2_1',
    x: 14,
    y: 2,
    owner: 'player2' as PlayerId,
    producing: null,
    productionTurnsLeft: 0,
    productionProgress: 0,
  });

  // P1 city at (5, 3) - bomber starting position
  state.cities.push({
    id: 'city_p1_1',
    x: 5,
    y: 3,
    owner: 'player1' as PlayerId,
    producing: null,
    productionTurnsLeft: 0,
    productionProgress: 0,
  });

  // P2 Battleship at (11, 4) - leftmost
  state.units.push({
    id: 'unit_p2_bs',
    type: UnitType.Battleship,
    owner: 'player2' as PlayerId,
    x: 11,
    y: 4,
    health: 2,
    movesLeft: 5,
    fuel: undefined,
    sleeping: false,
    hasAttacked: false,
    cargo: [],
    carriedBy: null,
  });

  // P1 Destroyer at (13, 4) - middle, provides vision for both targets
  state.units.push({
    id: 'unit_p1_dd',
    type: UnitType.Destroyer,
    owner: 'player1' as PlayerId,
    x: 13,
    y: 4,
    health: 1,
    movesLeft: 6,
    fuel: undefined,
    sleeping: false,
    hasAttacked: false,
    cargo: [],
    carriedBy: null,
  });

  // P2 Transport at (15, 4) - rightmost, with cargo (higher priority)
  state.units.push({
    id: 'unit_p2_trans',
    type: UnitType.Transport,
    owner: 'player2' as PlayerId,
    x: 15,
    y: 4,
    health: 1,
    movesLeft: 4,
    fuel: undefined,
    sleeping: false,
    hasAttacked: false,
    cargo: ['unit_p2_army'],
    carriedBy: null,
  });

  // P1 Bomber #1 at P1 city (5, 3) - should attack transport (higher priority)
  state.units.push({
    id: 'unit_p1_bomber1',
    type: UnitType.Missile,
    owner: 'player1' as PlayerId,
    x: 5,
    y: 3,
    health: 1,
    movesLeft: 15,
    sleeping: false,
    hasAttacked: false,
    cargo: [],
    carriedBy: null,
  });

  // P1 Bomber #2 at P1 city (5, 3) - should attack battleship (second priority)
  state.units.push({
    id: 'unit_p1_bomber2',
    type: UnitType.Missile,
    owner: 'player1' as PlayerId,
    x: 5,
    y: 3,
    health: 1,
    movesLeft: 15,
    sleeping: false,
    hasAttacked: false,
    cargo: [],
    carriedBy: null,
  });

  // Dummy army unit for transport cargo
  state.units.push({
    id: 'unit_p2_army',
    type: UnitType.Army,
    owner: 'player2' as PlayerId,
    x: 15,
    y: 4,
    health: 1,
    movesLeft: 1,
    fuel: undefined,
    sleeping: false,
    hasAttacked: false,
    cargo: [],
    carriedBy: 'unit_p2_trans',
  });

  return state;
}

export function getBomberDecisionTestConfig(): TestConfig {
  const mapWidth = 30;
  const mapHeight = 8;

  // Create ocean map
  const tiles: Terrain[][] = Array.from({ length: mapHeight }, () =>
    Array.from({ length: mapWidth }, () => Terrain.Ocean),
  );

  // Create tiny 2x2 island at (14, 2)
  tiles[2][14] = Terrain.Land;
  tiles[2][15] = Terrain.Land;
  tiles[3][14] = Terrain.Land;
  tiles[3][15] = Terrain.Land;

  // Generate explored tiles for P1 (around P1 city)
  const p1Explored: string[] = ['3,1', '4,1', '5,1', '6,1', '7,1', '3,2', '4,2', '5,2', '6,2', '7,2', '3,3', '4,3', '5,3', '6,3', '7,3', '3,4', '4,4', '5,4', '6,4', '7,4', '3,5', '4,5', '5,5', '6,5', '7,5'];

  return {
    testName: 'bomberDecision',
    mapConfig: {
      width: mapWidth,
      height: mapHeight,
      tiles,
    },
    cities: [
      { id: 'city_p2_1', x: 14, y: 2, owner: 'player2' },
      { id: 'city_p1_1', x: 5, y: 3, owner: 'player1' },
    ],
    units: [
      // P2 Battleship at (11, 4) - leftmost
      {
        id: 'unit_p2_bs',
        type: 'battleship',
        owner: 'player2',
        x: 11,
        y: 4,
        health: 2,
        movesLeft: 5,
        cargo: [],
        carriedBy: null,
      },
      // P1 Destroyer at (13, 4) - middle, provides vision
      {
        id: 'unit_p1_dd',
        type: 'destroyer',
        owner: 'player1',
        x: 13,
        y: 4,
        health: 1,
        movesLeft: 6,
        cargo: [],
        carriedBy: null,
      },
      // P2 Transport with cargo at (15, 4) - rightmost (higher priority target)
      {
        id: 'unit_p2_trans',
        type: 'transport',
        owner: 'player2',
        x: 15,
        y: 4,
        health: 1,
        movesLeft: 4,
        cargo: ['unit_p2_army'],
        carriedBy: null,
      },
      // P1 Bomber #1 at P1 city (5, 3)
      {
        id: 'unit_p1_bomber1',
        type: 'missile',
        owner: 'player1',
        x: 5,
        y: 3,
        health: 1,
        movesLeft: 15,
        cargo: [],
        carriedBy: null,
      },
      // P1 Bomber #2 at P1 city (5, 3)
      {
        id: 'unit_p1_bomber2',
        type: 'missile',
        owner: 'player1',
        x: 5,
        y: 3,
        health: 1,
        movesLeft: 15,
        cargo: [],
        carriedBy: null,
      },
      // Dummy army for transport cargo
      {
        id: 'unit_p2_army',
        type: 'army',
        owner: 'player2',
        x: 15,
        y: 4,
        health: 1,
        movesLeft: 1,
        cargo: [],
        carriedBy: 'unit_p2_trans',
      },
    ],
    maxTurns: 20,
    p1ExploredTiles: p1Explored,
    p2ExploredTiles: p1Explored, // P2 also sees the island
    victoryCondition: (state) => {
      // Check if both bombers attacked their correct targets
      const transportAlive = state.units.some(
        (u) => u.id === 'unit_p2_trans' && u.health > 0,
      );
      const battleshipAlive = state.units.some(
        (u) => u.id === 'unit_p2_bs' && u.health > 0,
      );
      // Success if both transport and battleship were destroyed
      return !transportAlive && !battleshipAlive;
    },
    testOptions: {
      cityCaptureSuccessRate: 1,
    },
  };
}

// Run test if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = getBomberDecisionTestConfig();
  runTest(config, { verbose: true, saveReplay: true })
    .then((result) => {
      console.log('\nTest Result:', result);
    })
    .catch((err) => {
      console.error('Test error:', err);
    });
}
