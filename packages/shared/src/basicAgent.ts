import {
  type Agent,
  type AgentAction,
  type AgentConfig,
  type AgentObservation,
  type UnitView,
  type CityView,
  type Coord,
  UnitType,
  UnitDomain,
  UNIT_STATS,
  Terrain,
  TileVisibility,
  wrapX,
  wrappedDistX,
} from '@sc/shared';
import {
  ProductionRulesEngine,
  type ProductionRulesSchema,
} from './basicAgent_productionRulesEngine.js';
import {
  MovementRulesEngine,
  type MovementRulesSchema,
} from './basicAgent_movementRulesEngine.js';
import MOVEMENT_RULES from '../../../movement_rules.json' with { type: 'json' };
import PRODUCTION_RULES_RAW from '../../../production_rules.json' with { type: 'json' };

// ── Type for MovementHelpers (mirrors basicAgent_movementRulesEngine.ts) ─────

type MovementHelpers = {
  classifyIslands(obs: AgentObservation): {
    islandOf: Map<string, number>;
    mineIndices: Set<number>;
    exploredIslands: Set<number>;
  };
  wrappedDist(a: Coord, b: Coord): number;
  getAdjacentTiles(x: number, y: number, mapWidth: number): Coord[];
  getAdjacentLandTiles(obs: AgentObservation, x: number, y: number, mapWidth: number): Coord[];
  getAdjacentOceanTiles(obs: AgentObservation, x: number, y: number, mapWidth: number): Coord | null;
  getAdjacentCoastalOcean(obs: AgentObservation, x: number, y: number, mapWidth: number, mapHeight: number): Coord[];
  bestStepToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): Coord | null;
  farthestStepToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): Coord | null;
  isIslandFriendly(islandIdx: number | undefined, mineIndices: Set<number>): boolean;
  isIslandExplored(islandIdx: number | undefined, exploredIslands: Set<number>): boolean;
  isIslandContested(islandIdx: number | undefined, obs: AgentObservation, islandOf: Map<string, number>): boolean;
  canReachCity(city: CityView, unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): boolean;
  getNearestReachableNeutralCity(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): CityView | null;
  getNearestReachableEnemyCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number, mapHeight: number): CityView | null;
  getNearestReachableUnexplored(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): Coord | null;
  getNearestFriendlyCoastalCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number, mapHeight: number): Coord | null;
  findWaitingTransport(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): UnitView | null;
  isAdjacentToTransportWithRoom(unit: UnitView, obs: AgentObservation, mapWidth: number): UnitView | null;
  isOnboardTransport(unit: UnitView): boolean;
  canDisembarkToUnexploredOrContested(transport: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, exploredIslands: Set<number>): number | null;
  anotherTransportWithEqualOrFewerArmies(currentTransport: UnitView, obs: AgentObservation, islandOf: Map<string, number>): boolean;
  isTransportParked(obs: AgentObservation, unit: UnitView, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): boolean;
  isTransportOnLandAtCity(obs: AgentObservation, unit: UnitView, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): boolean;
  findAnyLandOnIsland(obs: AgentObservation, islandOf: Map<string, number>, islandIdx: number, mapWidth: number, mapHeight: number): Coord | null;
  findCoastalCityOnIsland(obs: AgentObservation, islandIdx: number, mineIndices: Set<number>, islandOf: Map<string, number>, mapWidth: number): Coord | null;
  getIslandsByExploredState(obs: AgentObservation, islandOf: Map<string, number>, exploredIslands: Set<number>, isExplored: boolean): number[];
  getIslandsByFriendlyState(obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, isFriendly: boolean): number[];
  shouldTransportDepart(transport: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): boolean;
  friendlyIslandWithMostArmies(obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>): number | null;
  contestedIslandWithMostArmies(obs: AgentObservation, islandOf: Map<string, number>): number | null;
  getSeaUnitIslandIdx(x: number, y: number, islandOf: Map<string, number>): number | undefined;
  getOceanTilesAdjacentToIsland(obs: AgentObservation, islandOf: Map<string, number>, islandIdx: number, mapWidth: number, mapHeight: number): Coord[];
  getNearestUnexploredLand(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
  getNearestHiddenLand(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
  getNearestUnexploredOcean(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
  getNearestHiddenOcean(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
};

// The production_rules.json file contains extra metadata (phases, shared_functions)
// that isn't part of the ProductionRulesSchema. Extract just the production section.
const PRODUCTION_RULES: ProductionRulesSchema = {
  production: PRODUCTION_RULES_RAW.production,
};

/**
 * Strategy (in priority order):
 *  1. Claim any visible undefended city (neutral or enemy-owned without visible defenders).
 *  2. Explore unexplored land areas on the current island.
 *  3. Board transports to reach other islands and claim their cities.
 *  4. Only when no free cities remain: fight for defended enemy cities using
 *     bombers/fighters/battleships to weaken defenders, then armies to capture.
 */
export class BasicAgent implements Agent {
  private playerId!: string;
  private mapWidth!: number;
  private mapHeight!: number;

  // Current strategic phase
  private phase: 1 | 2 | 3 = 1;

  // Patrol direction for destroyers (persistent across turns)
  private destroyerPatrolDir: { x: number; y: number } | null = null;

  // Current transport target (persistent across turns)
  private transportTarget: Coord | null = null;

  private readonly productionEngine = new ProductionRulesEngine(PRODUCTION_RULES);
  private movementEngine!: MovementRulesEngine;
  private movementHelpers!: MovementHelpers;

  // Track turn for cache invalidation
  private lastTurn: number = -1;

  // Cache for classifyIslands - cleared each turn
  private islandCache: {
    key: string | null;
    result: {
      islandOf: Map<string, number>;
      mineIndices: Set<number>;
      contestedIndices: Set<number>;
      exploredIslands: Set<number>;
    };
  } = { key: null, result: {} as any };

  // Home island index - set once on init
  private homeIslandIdx: number | undefined = undefined;

  init(config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    // Reset patrol direction on new game
    this.destroyerPatrolDir = null;
    // Reset transport target on new game
    this.transportTarget = null;
    // Reset on new game
    this.phase = 1;
    this.homeIslandIdx = undefined;
    // Initialize movement engine with rules from JSON
    this.movementEngine = new MovementRulesEngine(MOVEMENT_RULES, config.mapWidth, config.mapHeight);
    this.movementHelpers = this.buildMovementHelpers();
  }

  /**
   * Determine current strategic phase.
   * Phase 3: Enemy contact → stay in combat
   * Phase 2: Home island fully explored → explore other islands
   * Phase 1: Default → expand home island
   */
  private computePhase(obs: AgentObservation): 1 | 2 | 3 {
    // Phase 3: Already in combat or enemy contact
    if (this.phase === 3) return 3;

    const { islandOf, exploredIslands } = this.classifyIslands(obs);

    // Set home island on first turn
    if (this.homeIslandIdx === undefined && obs.myCities.length > 0) {
      const cityIdx = islandOf.get(`${obs.myCities[0].x},${obs.myCities[0].y}`);
      if (cityIdx !== undefined) {
        this.homeIslandIdx = cityIdx;
      }
    }

    // Enemy contact → phase 3
    if (obs.visibleEnemyCities.some((c) => c.owner !== null) || obs.visibleEnemyUnits.length > 0) {
      this.phase = 3;
      return 3;
    }

    // Home island fully explored → phase 2
    if (this.phase === 1 && this.homeIslandIdx !== undefined && this.isIslandExplored(this.homeIslandIdx, exploredIslands)) {
      this.phase = 2;
    }

    return this.phase;
  }

  getPhase(): 1 | 2 | 3 {
    return this.phase;
  }

  act(obs: AgentObservation): AgentAction {
    this.computePhase(obs);

    // Sea units first so transports can LOAD armies before armies burn their moves on SKIP.
    // In attack mode, override with attack priority (bombers/fighters/battleships lead).
    let domainOrder = (u: UnitView) => {
      const d = UNIT_STATS[u.type].domain;
      return d === UnitDomain.Sea ? 0 : d === UnitDomain.Air ? 1 : 2;
    };
    const sortedUnits = [...obs.myUnits].sort((a, b) => domainOrder(a) - domainOrder(b));

    // Sea units first so transports can LOAD armies before armies burn their moves
    // In attack mode, override with attack priority
    const attackOrder = (u: UnitView) => {
      if (u.type === UnitType.Transport && u.cargo.length > 0) return 0; // Transport with army onboard
      if (UNIT_STATS[u.type].domain === UnitDomain.Sea) return 0;
      return 2; // Land and air units follow
    };
    const units = [...obs.myUnits].sort((a, b) => attackOrder(a) - attackOrder(b));

    for (const unit of units) {
      // Handle carried units (ARMY on transport, fighter on carrier)
      if (unit.carriedBy !== null) {
        // Army on transport: check adjacent 8 tiles for land on non-friendly island
        if (unit.type === UnitType.Army && unit.movesLeft > 0) {
          const { islandOf, mineIndices } = this.classifyIslands(obs);
          const adj = this.getAdjacentTiles(unit.x, unit.y, this.mapWidth);

          const clearCandidates: Coord[] = [];
          const attackCandidates: Coord[] = [];

          for (const tile of adj) {
            // Check if this is a land tile (not ice cap)
            if (tile.y <= 0 || tile.y >= this.mapHeight - 1) continue;
            const t = obs.tiles[tile.y]?.[tile.x];
            if (!t || t.terrain !== Terrain.Land) continue;

            // Check if it's on a non-friendly island
            const islandIdx = islandOf.get(`${tile.x},${tile.y}`);
            if (islandIdx === undefined || mineIndices.has(islandIdx)) continue;

            // Check if tile has enemy units
            const hasEnemy = obs.myUnits.some(u =>
              u.x === tile.x && u.y === tile.y && u.owner !== obs.myPlayerId
            );

            if (hasEnemy) {
              attackCandidates.push(tile);
            } else {
              clearCandidates.push(tile);
            }
          }

          // Prefer clear landing, only attack if necessary
          const target = clearCandidates.length > 0 ? clearCandidates[0] :
                         attackCandidates.length > 0 ? attackCandidates[0] : null;

          if (target) {
            return { type: 'MOVE', unitId: unit.id, to: target };
          }
          continue; // No valid land to disembark to, skip
        } else {
          continue; // Non-army or no moves, skip
        }
      }

      if (unit.sleeping) {
        if (unit.movesLeft > 0) return { type: 'WAKE', unitId: unit.id };
        continue;
      }

      if (unit.movesLeft <= 0) continue;
      if (unit.hasAttacked) continue; // can't attack again; done for this turn

      const action = this.movementEngine.chooseMove({
        phase: this.phase,
        unit,
        obs,
        helpers: this.movementHelpers,
        mapWidth: this.mapWidth,
        mapHeight: this.mapHeight,
        transportTarget: this.transportTarget,
      });
      if (action) {
        // For transport MOVE actions, set the target for continued movement
        if (unit.type === UnitType.Transport && action.type === 'MOVE') {
          this.transportTarget = action.to;
        } else if (unit.type === UnitType.Transport && action.type === 'SKIP') {
          // Clear target when transport can't move (reached target or blocked)
          this.transportTarget = null;
        }
        return action;
      }

      // Blocked — exhaust moves to prevent infinite re-evaluation.
      return { type: 'SKIP', unitId: unit.id };
    }

    // Ensure all cities are producing
    for (const city of obs.myCities) {
      if (city.producing === null) {
        return { type: 'SET_PRODUCTION', cityId: city.id, unitType: this.chooseProduction(obs, city) };
      }
    }

    return { type: 'END_TURN' };
  }

  private chooseProduction(obs: AgentObservation, city: CityView): UnitType {
    return this.productionEngine.chooseProduction({
      phase: this.phase,
      city,
      obs,
      helpers: {
        enemyCityReachableByLand: (o, c) =>
          this.enemyCityWithinLandDist(o, c, this.mapWidth * this.mapHeight),
        classifyIslands: (o) => this.classifyIslands(o),
      },
    });
  }

  private buildMovementHelpers(): MovementHelpers {
    return {
      classifyIslands: (obs) => this.classifyIslands(obs),
      wrappedDist: (a, b) => this.wrappedDist(a, b),
      getAdjacentTiles: (x, y) => this.getAdjacentTiles(x, y, this.mapWidth),
      getAdjacentLandTiles: (obs, x, y) => this.getAdjacentLandTiles(obs, x, y, this.mapWidth),
      getAdjacentOceanTiles: (obs, x, y) => this.getAdjacentOceanTiles(obs, x, y, this.mapWidth),
      bestStepToward: (obs, unit, target) => this.bestStepToward(obs, unit, target, this.mapWidth, this.mapHeight),
      farthestStepToward: (obs, unit, target) => this.farthestStepToward(obs, unit, target, this.mapWidth, this.mapHeight),
      isIslandFriendly: (islandIdx, mineIndices) => this.isIslandFriendly(islandIdx, mineIndices),
      isIslandExplored: (islandIdx, exploredIslands) => this.isIslandExplored(islandIdx, exploredIslands),
      isIslandContested: (islandIdx, obs, islandOf) => this.isIslandContested(islandIdx, obs, islandOf),
      canReachCity: (city, unit, obs) => this.canReachCity(city, unit, obs, this.mapWidth, this.mapHeight),
      getNearestReachableNeutralCity: (unit, obs) => this.getNearestReachableNeutralCity(unit, obs, this.mapWidth, this.mapHeight),
      getNearestReachableEnemyCity: (unit, obs, islandOf, mineIndices) => this.getNearestReachableEnemyCity(unit, obs, islandOf, mineIndices, this.mapWidth, this.mapHeight),
      getNearestReachableUnexplored: (unit, obs) => this.getNearestReachableUnexplored(unit, obs, this.mapWidth, this.mapHeight),
      getNearestFriendlyCoastalCity: (unit, obs, islandOf, mineIndices) => this.getNearestFriendlyCoastalCity(unit, obs, islandOf, mineIndices, this.mapWidth, this.mapHeight),
      findWaitingTransport: (unit, obs, islandOf, mineIndices) => this.findWaitingTransport(unit, obs, islandOf, mineIndices, this.mapWidth),
      isAdjacentToTransportWithRoom: (unit, obs) => this.isAdjacentToTransportWithRoom(unit, obs, this.mapWidth),
      isOnboardTransport: (unit) => this.isOnboardTransport(unit),
      canDisembarkToUnexploredOrContested: (transport, obs, islandOf, mineIndices, exploredIslands) =>
        this.canDisembarkToUnexploredOrContested(transport, obs, islandOf, mineIndices, exploredIslands),
      anotherTransportWithEqualOrFewerArmies: (currentTransport, obs, islandOf) =>
        this.anotherTransportWithEqualOrFewerArmies(currentTransport, obs, islandOf),
      isTransportParked: (obs, unit, islandOf, mineIndices) => this.isTransportParked(obs, unit, islandOf, mineIndices, this.mapWidth),
      isTransportOnLandAtCity: (obs, unit, islandOf, mineIndices) => this.isTransportOnLandAtCity(obs, unit, islandOf, mineIndices, this.mapWidth),
      findAnyLandOnIsland: (obs, islandOf, islandIdx) => this.findAnyLandOnIsland(obs, islandOf, islandIdx, this.mapWidth, this.mapHeight),
      findCoastalCityOnIsland: (obs, islandIdx, mineIndices, islandOf) => this.findCoastalCityOnIsland(obs, islandIdx, mineIndices, islandOf, this.mapWidth),
      getIslandsByExploredState: (obs, islandOf, exploredIslands, isExplored) => this.getIslandsByExploredState(obs, islandOf, exploredIslands, isExplored),
      getIslandsByFriendlyState: (obs, islandOf, mineIndices, isFriendly) => this.getIslandsByFriendlyState(obs, islandOf, mineIndices, isFriendly),
      shouldTransportDepart: (transport, obs, islandOf, mineIndices) => this.shouldTransportDepart(transport, obs, islandOf, mineIndices, this.mapWidth),
      friendlyIslandWithMostArmies: (obs, islandOf, mineIndices) => this.friendlyIslandWithMostArmies(obs, islandOf, mineIndices),
      contestedIslandWithMostArmies: (obs, islandOf) => this.contestedIslandWithMostArmies(obs, islandOf),
      getSeaUnitIslandIdx: (x, y, islandOf) => this.getSeaUnitIslandIdx(x, y, islandOf),
      getOceanTilesAdjacentToIsland: (obs, islandOf, islandIdx) => this.getOceanTilesAdjacentToIsland(obs, islandOf, islandIdx, this.mapWidth, this.mapHeight),
      getNearestUnexploredLand: (obs, from) => this.getNearestUnexploredLand(obs, from, this.mapWidth, this.mapHeight),
      getNearestHiddenLand: (obs, from) => this.getNearestHiddenLand(obs, from, this.mapWidth, this.mapHeight),
      getNearestUnexploredOcean: (obs, from) => this.getNearestUnexploredOcean(obs, from, this.mapWidth, this.mapHeight),
      getNearestHiddenOcean: (obs, from) => this.getNearestHiddenOcean(obs, from, this.mapWidth, this.mapHeight),
      getAdjacentCoastalOcean: (obs, x, y) => this.getAdjacentCoastalOcean(obs, x, y, this.mapWidth, this.mapHeight),
    };
  }

  // ── Helper Methods for Rule Evaluation ──────────────────────────────────────

  /**
   * Check if current phase matches the given phase.
   */
  private isPhase(phase: 1 | 2 | 3): boolean {
    return this.phase === phase;
  }

  /**
   * Get island index for a position, handling ocean tiles by checking adjacent land.
   * Sea units on ocean are considered "at" the nearest adjacent island.
   */
  private getSeaUnitIslandIdx(x: number, y: number, islandOf: Map<string, number>): number | undefined {
    const idx = islandOf.get(`${x},${y}`);
    if (idx !== undefined) return idx;
    const adj = this.getAdjacentTiles(x, y, this.mapWidth);
    for (const tile of adj) {
      const adjIdx = islandOf.get(`${tile.x},${tile.y}`);
      if (adjIdx !== undefined) return adjIdx;
    }
    return undefined;
  }

  /**
   * Check if an island is friendly (owned by us).
   */
  private isIslandFriendly(islandIdx: number | undefined, mineIndices: Set<number>): boolean {
    if (islandIdx === undefined) return false;
    return mineIndices.has(islandIdx);
  }

  /**
   * Check if an island is fully explored.
   */
  private isIslandExplored(islandIdx: number | undefined, exploredIslands: Set<number>): boolean {
    if (islandIdx === undefined) return false;
    return exploredIslands.has(islandIdx);
  }

  /**
   * Check if an island has enemy cities (is contested).
   */
  private isIslandContested(islandIdx: number | undefined, obs: AgentObservation, islandOf: Map<string, number>): boolean {
    if (islandIdx === undefined) return false;
    const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
    for (const city of enemyCities) {
      const cityIsland = islandOf.get(`${city.x},${city.y}`);
      if (cityIsland === islandIdx) return true;
    }
    return false;
  }

  /**
   * Check if a city is reachable from unit using BFS pathfinding.
   */
  private canReachCity(city: CityView, unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): boolean {
    const move = this.moveToward(obs, unit, city, mapWidth, mapHeight);
    return move !== null;
  }

  /**
   * Check if any neutral city is reachable from unit.
   */
  private canReachNeutralCity(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): boolean {
    const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
    for (const city of neutralCities) {
      if (this.canReachCity(city, unit, obs, mapWidth, mapHeight)) return true;
    }
    return false;
  }

  /**
   * Get nearest neutral city that is reachable.
   */
  private getNearestReachableNeutralCity(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): CityView | null {
    const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
    let nearest: CityView | null = null;
    let nearestDist = Infinity;

    for (const city of neutralCities) {
      const dist = this.wrappedDist(city, unit);
      if (dist < nearestDist && this.canReachCity(city, unit, obs, mapWidth, mapHeight)) {
        nearestDist = dist;
        nearest = city;
      }
    }
    return nearest;
  }

  /**
   * Check if unit is adjacent to a friendly transport with room.
   */
  private isAdjacentToTransportWithRoom(unit: UnitView, obs: AgentObservation, mapWidth: number): UnitView | null {
    const adjTiles = this.getAdjacentTiles(unit.x, unit.y, mapWidth);
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;

    for (const tile of adjTiles) {
      const transport = obs.myUnits.find(
        (u) => u.type === UnitType.Transport && u.x === tile.x && u.y === tile.y && u.carriedBy === null && u.cargo.length < cap
      );
      if (transport) return transport;
    }
    return null;
  }

  /**
   * Check if unit is onboard a transport.
   */
  private isOnboardTransport(unit: UnitView): boolean {
    return unit.carriedBy !== null;
  }

  /**
   * Check if transport can disembark to unexplored or contested island.
   * Returns the island index if yes, null otherwise.
   */
  private canDisembarkToUnexploredOrContested(transport: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, exploredIslands: Set<number>): number | null {
    const adjacentLand = this.getAdjacentLandTiles(obs, transport.x, transport.y, this.mapWidth);
    const disembarkIslands = new Set<number>();
    for (const land of adjacentLand) {
      const landIdx = islandOf.get(`${land.x},${land.y}`);
      if (landIdx === undefined) continue;
      const notExplored = !this.isIslandExplored(landIdx, exploredIslands);
      const notFriendly = !this.isIslandFriendly(landIdx, mineIndices);

      if (notExplored || notFriendly) {
        disembarkIslands.add(landIdx);
      }
    }
    // Return first disembarkable island (or null if none)
    for (const islandIdx of disembarkIslands) {
      return islandIdx;
    }
    return null;
  }

  /**
   * Find a waiting transport on a friendly island that is offshore (on ocean tile adjacent to land).
   * Returns the transport unit if found, null otherwise.
   */
  private findWaitingTransport(
    unit: UnitView,
    obs: AgentObservation,
    islandOf: Map<string, number>,
    mineIndices: Set<number>,
    mapWidth: number,
  ): UnitView | null {
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    const myIslandIdx = this.getSeaUnitIslandIdx(unit.x, unit.y, islandOf);
    if (myIslandIdx === undefined || !mineIndices.has(myIslandIdx)) {
      return null; // Not on a friendly island
    }

    // Find transports that are:
    // 1. Adjacent to friendly island (offshore)
    // 2. On ocean tile
    // 3. Has room for cargo
    for (const transport of obs.myUnits) {
      if (transport.type !== UnitType.Transport) continue;
      if (transport.id === unit.id) continue; // Skip self
      if (transport.cargo.length >= cap) continue; // Full

      const transportIslandIdx = this.getSeaUnitIslandIdx(transport.x, transport.y, islandOf);
      if (transportIslandIdx === undefined || !mineIndices.has(transportIslandIdx)) {
        continue; // Not at friendly island
      }

      // Check if transport is on ocean (offshore)
      const transportTile = obs.tiles[transport.y]?.[transport.x];
      if (!transportTile || transportTile.terrain !== Terrain.Ocean) {
        continue; // Not on ocean
      }

      // Transport is offshore on friendly island with room
      return transport;
    }

    return null;
  }

  /**
   * Check if transport should depart the friendly island.
   * Returns true if:
   * a) Transport is full, OR
   * b) No friendly armies at the island, OR
   * c) Another friendly transport at the same island has same or fewer armies
   */
  private shouldTransportDepart(
    transport: UnitView,
    obs: AgentObservation,
    islandOf: Map<string, number>,
    mineIndices: Set<number>,
    mapWidth: number
  ): boolean {
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    const transportIslandIdx = this.getSeaUnitIslandIdx(transport.x, transport.y, islandOf);
    if (transportIslandIdx === undefined || !mineIndices.has(transportIslandIdx)) {
      return false; // Not at friendly island
    }

    // Check if transport is on ocean (offshore)
    const transportTile = obs.tiles[transport.y]?.[transport.x];
    if (!transportTile || transportTile.terrain !== Terrain.Ocean) {
      return false; // Not on ocean
    }

    // a) Transport is full
    if (transport.cargo.length >= cap) {
      return true;
    }

    // b) Count friendly armies at the island
    let friendlyArmyCount = 0;
    for (const unit of obs.myUnits) {
      if (unit.type === UnitType.Army && unit.carriedBy === null) {
        const unitIsland = islandOf.get(`${unit.x},${unit.y}`);
        if (unitIsland === transportIslandIdx) {
          friendlyArmyCount++;
        }
      }
    }
    if (friendlyArmyCount === 0) {
      return true;
    }

    // c) Check if another transport at same island has same or fewer armies
    for (const unit of obs.myUnits) {
      if (unit.type === UnitType.Transport && unit.id !== transport.id) {
        const otherIsland = this.getSeaUnitIslandIdx(unit.x, unit.y, islandOf);
        if (otherIsland === transportIslandIdx) {
          // Check if other transport is also on ocean at same island
          const otherTile = obs.tiles[unit.y]?.[unit.x];
          if (otherTile && otherTile.terrain === Terrain.Ocean) {
            if (unit.cargo.length <= transport.cargo.length) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * Get nearest reachable enemy city on a contested island.
   */
  private getNearestReachableEnemyCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number, mapHeight: number): CityView | null {
    const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
    let nearest: CityView | null = null;
    let nearestDist = Infinity;

    for (const city of enemyCities) {
      const cityIsland = islandOf.get(`${city.x},${city.y}`);
      // Only target enemy cities on contested islands
      if (this.isIslandContested(cityIsland, obs, islandOf)) {
        const dist = this.wrappedDist(city, unit);
        if (dist < nearestDist && this.canReachCity(city, unit, obs, mapWidth, mapHeight)) {
          nearestDist = dist;
          nearest = city;
        }
      }
    }
    return nearest;
  }

  /**
   * Get nearest unexplored tile reachable from unit.
   */
  private getNearestReachableUnexplored(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): Coord | null {
    const unexplored = this.nearestUnexploredTile(obs, unit);
    // nearestUnexploredTile already checks reachability via bestStepToward
    return unexplored;
  }

  /**
   * Get nearest coastal city on friendly island.
   */
  private getNearestFriendlyCoastalCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number, mapHeight: number): Coord | null {
    const coastalCities = this.getCoastalCities(obs, mineIndices, islandOf, mapWidth);
    return this.nearestCity(coastalCities, unit);
  }

  /**
   * BFS over land-only tiles from `from`. Returns true if any visible enemy-owned
   * city is reachable within `maxDist` steps. Sea tiles are never crossed, so two
   * cities separated by even a single ocean tile will NOT trigger this check.
   */
  private enemyCityWithinLandDist(obs: AgentObservation, from: Coord, maxDist: number): boolean {
    const enemySet = new Set(
      obs.visibleEnemyCities
        .filter((c) => c.owner !== null)
        .map((c) => `${c.x},${c.y}`),
    );
    if (enemySet.size === 0) return false;

    const visited = new Set<string>();
    visited.add(`${from.x},${from.y}`);
    const queue: Array<{ x: number; y: number; dist: number }> = [
      { x: from.x, y: from.y, dist: 0 },
    ];
    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y:  0 },                   { x: 1, y:  0 },
      { x: -1, y:  1 }, { x: 0, y:  1 }, { x: 1, y:  1 },
    ];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.dist >= maxDist) continue;
      for (const d of dirs) {
        const nx = wrapX(cur.x + d.x, this.mapWidth);
        const ny = cur.y + d.y;
        const k  = `${nx},${ny}`;
        if (visited.has(k)) continue;
        visited.add(k);
        const tile = obs.tiles[ny]?.[nx];
        if (!tile || tile.terrain !== Terrain.Land) continue; // ocean / unexplored = impassable
        if (enemySet.has(k)) return true;
        queue.push({ x: nx, y: ny, dist: cur.dist + 1 });
      }
    }
    return false;
  }

  /**
   * Determine the move for a unit based on its type using the MovementRulesEngine.
   */
  private determineMoveForUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    return this.movementEngine.chooseMove({
      phase: this.phase,
      unit,
      obs,
      helpers: this.movementHelpers,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
    });
  }

  // ── Unit-Specific Movement Functions (deprecated - kept for reference) ─────

  // ── Shared Movement Helpers ─────────────────────────────────────────────────


  private moveToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): AgentAction | null {
    const best = this.bestStepToward(obs, unit, target, mapWidth, mapHeight);
    if (best) return { type: 'MOVE', unitId: unit.id, to: best };
    return null;
  }

  private bestStepToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): Coord | null {
    const stats = UNIT_STATS[unit.type];

    // Sea units can only enter friendly cities (ports); enemy/neutral cities are blocked.
    const canEnter = (x: number, y: number): boolean => {
      if (y <= 0 || y >= this.mapHeight - 1) return false; // ice caps
      const tile = obs.tiles[y]?.[x];
      if (stats.domain === UnitDomain.Land) return !!tile && tile.terrain === Terrain.Land;
      if (stats.domain === UnitDomain.Sea) {
        if (!tile) return true; // unexplored — assume navigable ocean
        if (tile.terrain === Terrain.Ocean) return true;
        return obs.myCities.some((c) => c.x === x && c.y === y); // friendly port only
      }
      if (!tile) return false;
      return true; // air
    };

    const key = (x: number, y: number) => `${x},${y}`;
    const visited = new Set<string>();
    visited.add(key(unit.x, unit.y));

    const queue: Array<{ x: number; y: number; first: Coord | null }> = [
      { x: unit.x, y: unit.y, first: null },
    ];

    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 },                    { x: 1, y: 0 },
      { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
    ];

    const MAX_VISITED = this.mapWidth * this.mapHeight;
    while (queue.length > 0 && visited.size < MAX_VISITED) {
      const cur = queue.shift()!;

      // Sort neighbors by distance to target to prioritize moving toward the goal
      const neighbors = dirs.map(d => ({
        x: wrapX(cur.x + d.x, this.mapWidth),
        y: cur.y + d.y,
      })).filter(n => n.y > 0 && n.y < this.mapHeight - 1)
       .sort((a, b) => this.wrappedDist(a, target) - this.wrappedDist(b, target));

      for (const n of neighbors) {
        const nx = n.x;
        const ny = n.y;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        visited.add(k);

        const firstStep = cur.first ?? { x: nx, y: ny };

        if (nx === target.x && ny === target.y) {
          // Sea units can't enter enemy/neutral cities — stop at the adjacent ocean tile instead.
          // If firstStep === target we're already adjacent and can't get closer; return null.
          if (!canEnter(nx, ny)) {
            if (firstStep.x === nx && firstStep.y === ny) return null;
            return firstStep;
          }
          return firstStep;
        }
        if (!canEnter(nx, ny)) continue;
        queue.push({ x: nx, y: ny, first: firstStep });
      }
    }

    return null;
  }

  /**
   * Find the farthest tile toward target within movesLeft steps.
   * Uses BFS to find the path, then returns the tile closest to target
   * that is reachable within the unit's movement range.
   */
  private farthestStepToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): Coord | null {
    const stats = UNIT_STATS[unit.type];

    // Sea units can only enter friendly cities (ports); enemy/neutral cities are blocked.
    const canEnter = (x: number, y: number): boolean => {
      if (y <= 0 || y >= this.mapHeight - 1) return false; // ice caps
      const tile = obs.tiles[y]?.[x];
      if (stats.domain === UnitDomain.Land) return !!tile && tile.terrain === Terrain.Land;
      if (stats.domain === UnitDomain.Sea) {
        if (!tile) return true; // unexplored — assume navigable ocean
        if (tile.terrain === Terrain.Ocean) return true;
        return obs.myCities.some((c) => c.x === x && c.y === y); // friendly port only
      }
      if (!tile) return false;
      return true; // air
    };

    const key = (x: number, y: number) => `${x},${y}`;
    const visited = new Set<string>();
    visited.add(key(unit.x, unit.y));

    const queue: Array<{ x: number; y: number; dist: number; path: Coord[] }> = [
      { x: unit.x, y: unit.y, dist: 0, path: [] },
    ];

    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 },                    { x: 1, y: 0 },
      { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
    ];

    let bestStep: Coord | null = null;
    let bestDistToTarget = this.wrappedDist(unit, target);
    let bestPathLen = 0;

    const MAX_VISITED = this.mapWidth * this.mapHeight;
    while (queue.length > 0 && visited.size < MAX_VISITED) {
      const cur = queue.shift()!;

      // Check if this tile is closer to target than our best
      const distToTarget = this.wrappedDist(cur, target);
      if (distToTarget < bestDistToTarget) {
        bestDistToTarget = distToTarget;
        // Use the FIRST step in the path (adjacent to start) - game engine only allows 1-tile moves
        if (cur.path.length > 0) {
          bestStep = cur.path[0];
          bestPathLen = cur.path.length;
        }
      }

      // Don't exceed movesLeft
      if (cur.dist >= unit.movesLeft) continue;

      for (const d of dirs) {
        const nx = wrapX(cur.x + d.x, this.mapWidth);
        const ny = cur.y + d.y;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        visited.add(k);

        if (!canEnter(nx, ny)) continue;

        const newPath = [...cur.path, { x: nx, y: ny }];
        queue.push({ x: nx, y: ny, dist: cur.dist + 1, path: newPath });
      }
    }

    return bestStep;
  }

  /** BFS over known land tiles; returns true if any adjacent tile is null (never mapped). */
  /** Returns true if any land tile reachable from `from` has never been explored. */
  private hasUnexploredLand(obs: AgentObservation, from: Coord): boolean {
    const visited = new Set<string>();
    const queue: Coord[] = [{ x: from.x, y: from.y }];
    visited.add(`${from.x},${from.y}`);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const [dx, dy] of [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],           [1,  0],
        [-1,  1], [0,  1], [1,  1],
      ] as [number, number][]) {
        const nx = wrapX(cur.x + dx, this.mapWidth);
        const ny = cur.y + dy;
        if (ny <= 0 || ny >= this.mapHeight - 1) continue;
        const k = `${nx},${ny}`;
        if (visited.has(k)) continue;
        visited.add(k);
        const tile = obs.tiles[ny]?.[nx];
        if (!tile) continue;                                                  // off-map
        if (tile.terrain !== Terrain.Land) continue;                         // skip ocean / ice
        if (tile.visibility === TileVisibility.Hidden) return true;           // unexplored land
        queue.push({ x: nx, y: ny });
      }
    }
    return false;
  }

  private moveTowardExploration(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const stats = UNIT_STATS[unit.type];
    const canEnterExplore = (x: number, y: number): boolean => {
      if (y <= 0 || y >= this.mapHeight - 1) return false;
      const tile = obs.tiles[y]?.[x];
      if (stats.domain === UnitDomain.Land) return !!tile && tile.terrain === Terrain.Land;
      if (stats.domain === UnitDomain.Sea) {
        if (!tile) return true; // unexplored — assume navigable ocean
        if (tile.terrain === Terrain.Ocean) return true;
        return obs.myCities.some((c) => c.x === x && c.y === y); // friendly ports only
      }
      if (!tile) return false;
      return true;
    };

    const key = (x: number, y: number) => `${x},${y}`;
    const visited = new Set<string>();
    visited.add(key(unit.x, unit.y));
    const queue: Array<{ x: number; y: number; first: Coord | null }> = [
      { x: unit.x, y: unit.y, first: null },
    ];

    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 },                    { x: 1, y: 0 },
      { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
    ];

    while (queue.length > 0 && visited.size < this.mapWidth * this.mapHeight) {
      const cur = queue.shift()!;
      for (const d of dirs) {
        const nx = wrapX(cur.x + d.x, this.mapWidth);
        const ny = cur.y + d.y;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        visited.add(k);

        const tile = obs.tiles[ny]?.[nx];
        const firstStep = cur.first ?? { x: nx, y: ny };

        if (!canEnterExplore(nx, ny)) continue;

        // Hidden = never explored: worth exploring (Seen = was explored, skip).
        if (tile.visibility === TileVisibility.Hidden) {
          return { type: 'MOVE', unitId: unit.id, to: firstStep };
        }

        queue.push({ x: nx, y: ny, first: firstStep });
      }
    }

    return null;
  }

  private getAdjacentTiles(x: number, y: number, mapWidth: number): Coord[] {
    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 },                     { x: 1, y: 0 },
      { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
    ];
    return dirs.map((d) => ({
      x: wrapX(x + d.x, mapWidth),
      y: y + d.y,
    }));
  }

  /** Returns the adjacent land tile closest to `toward` (or any land tile if toward is null). */
  private getAdjacentAirTileToward(unit: UnitView, toward: Coord): Coord | null {
    const adj = this.getAdjacentTiles(unit.x, unit.y, this.mapWidth);
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (const c of adj) {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) continue; // no ice caps
      const d = this.wrappedDist(c, toward);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  /** Returns an adjacent coastal ocean tile (preferred) or any adjacent ocean tile. */
  private getAdjacentOceanTiles(obs: AgentObservation, x: number, y: number, mapWidth: number): Coord | null {
    const adj = this.getAdjacentTiles(x, y, mapWidth);
    let anyOcean: Coord | null = null;
    for (const c of adj) {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) continue;
      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile || tile.terrain !== Terrain.Ocean) continue;
      if (anyOcean === null) anyOcean = c;
      if (this.isCoastalOcean(obs, c.x, c.y, mapWidth, this.mapHeight)) return c;
    }
    return anyOcean;
  }

  /**
   * Check if a tile is coastal ocean (ocean with at least one land neighbor).
   */
  private isCoastalOcean(obs: AgentObservation, x: number, y: number, mapWidth: number, mapHeight: number): boolean {
    const tile = obs.tiles[y]?.[x];
    if (!tile || tile.terrain !== Terrain.Ocean) return false;

    const adj = this.getAdjacentTiles(x, y, mapWidth);
    for (const c of adj) {
      if (c.y <= 0 || c.y >= mapHeight - 1) continue;
      const adjTile = obs.tiles[c.y]?.[c.x];
      if (adjTile && adjTile.terrain === Terrain.Land) return true;
    }
    return false;
  }

  /**
   * Check if a tile is deep ocean (all 8 neighbors are ocean).
   */
  private isDeepOcean(obs: AgentObservation, x: number, y: number, mapWidth: number, mapHeight: number): boolean {
    const tile = obs.tiles[y]?.[x];
    if (!tile || tile.terrain !== Terrain.Ocean) return false;

    const adj = this.getAdjacentTiles(x, y, mapWidth);
    for (const c of adj) {
      if (c.y <= 0 || c.y >= mapHeight - 1) return false;
      const adjTile = obs.tiles[c.y]?.[c.x];
      if (!adjTile || adjTile.terrain !== Terrain.Ocean) return false;
    }
    return true;
  }

  /**
   * Get adjacent coastal ocean tiles (ocean tiles adjacent to land).
   */
  private getAdjacentCoastalOcean(obs: AgentObservation, x: number, y: number, mapWidth: number, mapHeight: number): Coord[] {
    const adj = this.getAdjacentTiles(x, y, mapWidth);
    const result: Coord[] = [];
    for (const c of adj) {
      if (c.y <= 0 || c.y >= mapHeight - 1) continue;
      if (this.isCoastalOcean(obs, c.x, c.y, mapWidth, mapHeight)) {
        result.push(c);
      }
    }
    return result;
  }

  private getAdjacentLandToward(obs: AgentObservation, unit: UnitView, toward: Coord | null): Coord | null {
    const adj = this.getAdjacentTiles(unit.x, unit.y, this.mapWidth);
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (const c of adj) {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) continue;
      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile || tile.terrain !== Terrain.Land) continue;
      const d = toward ? this.wrappedDist(c, toward) : 0;
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  /** Returns the nearest unexplored tile (Hidden) from `unit` position. */
  private nearestUnexploredTile(obs: AgentObservation, unit: UnitView): Coord | null {
    const stats = UNIT_STATS[unit.type];
    const canEnter = (x: number, y: number): boolean => {
      if (y <= 0 || y >= this.mapHeight - 1) return false;
      const tile = obs.tiles[y]?.[x];
      if (!tile) return false;
      if (stats.domain === UnitDomain.Land) return tile.terrain === Terrain.Land;
      if (stats.domain === UnitDomain.Sea) return tile.terrain === Terrain.Ocean;
      return true; // air
    };

    const key = (x: number, y: number) => `${x},${y}`;
    const visited = new Set<string>();
    visited.add(key(unit.x, unit.y));
    const queue: Array<{ x: number; y: number; dist: number }> = [
      { x: unit.x, y: unit.y, dist: 0 },
    ];

    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 },                    { x: 1, y: 0 },
      { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
    ];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const d of dirs) {
        const nx = wrapX(cur.x + d.x, this.mapWidth);
        const ny = cur.y + d.y;
        const k = key(nx, ny);
        if (visited.has(k)) continue;
        visited.add(k);

        const tile = obs.tiles[ny]?.[nx];
        if (!tile || !canEnter(nx, ny)) continue;

        if (tile.visibility === TileVisibility.Hidden) {
          return { x: nx, y: ny };
        }

        queue.push({ x: nx, y: ny, dist: cur.dist + 1 });
      }
    }

    return null;
  }

  /** Returns all adjacent land tiles. */
  private getAdjacentLandTiles(obs: AgentObservation, x: number, y: number, mapWidth: number): Coord[] {
    const adj = this.getAdjacentTiles(x, y, mapWidth);
    return adj.filter((c) => {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) return false;
      const tile = obs.tiles[c.y]?.[c.x];
      return !!tile && tile.terrain === Terrain.Land;
    });
  }

  private nearestCity(
    cities: readonly { x: number; y: number }[],
    from: Coord,
  ): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (const c of cities) {
      const d = this.wrappedDist(c, from);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  private nearestUnit(units: readonly UnitView[], from: Coord): UnitView | null {
    let best: UnitView | null = null;
    let bestDist = Infinity;
    for (const u of units) {
      const d = this.wrappedDist(u, from);
      if (d < bestDist) { bestDist = d; best = u; }
    }
    return best;
  }

  private nearestEnemy(enemies: readonly UnitView[], from: Coord): UnitView | null {
    let best: UnitView | null = null;
    let bestDist = Infinity;
    for (const e of enemies) {
      const d = this.wrappedDist(e, from);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    return best;
  }

  private wrappedDist(a: Coord, b: Coord): number {
    return wrappedDistX(a.x, b.x, this.mapWidth) + Math.abs(a.y - b.y);
  }

  /**
   * Flood-fill obs.tiles to find connected land regions, then classify each:
   *   MINE       — island where every visible city is owned by us (safe staging area)
   *   CONTESTED  — island with ≥1 neutral/enemy city, OR land with no visible cities
   *   EXPLORED   — island where all land tiles are visible (not Hidden)
   *
   * Returns:
   *   islandOf       "x,y" → island index
   *   mineIndices    set of "mine" island indices
   *   contestedIndices set of "contested" island indices
   *   exploredIslands set of "explored" island indices
   */
  private classifyIslands(obs: AgentObservation): {
    islandOf: Map<string, number>;
    mineIndices: Set<number>;
    contestedIndices: Set<number>;
    exploredIslands: Set<number>;
  } {
    // Use cached result if available for this observation
    const cacheKey = `${obs.turn}`;
    if (this.islandCache.key === cacheKey) {
      return this.islandCache.result;
    }

    const tiles = obs.tiles;
    const h = tiles.length;
    const w = tiles[0]?.length ?? 0;

    const visited = new Set<string>();
    const islandOf = new Map<string, number>();
    let islandCount = 0;

    for (let y = 1; y < h - 1; y++) {          // skip ice cap rows
      for (let x = 0; x < w; x++) {
        const key = `${x},${y}`;
        if (visited.has(key)) continue;
        if (tiles[y]?.[x]?.terrain !== Terrain.Land) continue;

        const idx = islandCount++;
        const queue: Coord[] = [{ x, y }];
        visited.add(key);
        islandOf.set(key, idx);

        while (queue.length > 0) {
          const curr = queue.shift()!;
          for (const [dx, dy] of [
            [-1, -1], [0, -1], [1, -1],
            [-1,  0],           [1,  0],
            [-1,  1], [0,  1], [1,  1],
          ] as [number, number][]) {
            const nx = wrapX(curr.x + dx, this.mapWidth);
            const ny = curr.y + dy;
            if (ny < 1 || ny >= h - 1) continue;
            const nkey = `${nx},${ny}`;
            if (visited.has(nkey)) continue;
            if (tiles[ny]?.[nx]?.terrain !== Terrain.Land) continue;
            visited.add(nkey);
            islandOf.set(nkey, idx);
            queue.push({ x: nx, y: ny });
          }
        }
      }
    }

    // Classify each island based on city ownership
    const myCityIds = new Set(obs.myCities.map((c) => c.id));
    const allCities = [...obs.myCities, ...obs.visibleEnemyCities];

    // Group cities by island
    const citiesOnIsland = new Map<number, typeof allCities>();
    for (const city of allCities) {
      const idx = islandOf.get(`${city.x},${city.y}`);
      if (idx === undefined) continue;
      if (!citiesOnIsland.has(idx)) citiesOnIsland.set(idx, []);
      citiesOnIsland.get(idx)!.push(city);
    }

    const mineIndices = new Set<number>();
    const contestedIndices = new Set<number>();
    const exploredIslands = new Set<number>();

    for (let i = 0; i < islandCount; i++) {
      const cities = citiesOnIsland.get(i);
      if (!cities || cities.length === 0) {
        // No visible cities → treat as contested so we explore/deliver here
        contestedIndices.add(i);
      } else if (cities.every((c) => myCityIds.has(c.id))) {
        // Every visible city is ours → safe home territory
        mineIndices.add(i);
      } else {
        // At least one neutral or enemy city
        contestedIndices.add(i);
      }

      // Check if island is fully explored
      let islandIsExplored = true;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 0; x < w; x++) {
          const idx = islandOf.get(`${x},${y}`);
          if (idx === i) {
            const tile = tiles[y]?.[x];
            if (!tile || tile.terrain !== Terrain.Land) continue;
            if (tile.visibility === TileVisibility.Hidden) {
              islandIsExplored = false;
              break;
            }
          }
        }
      }
      if (islandIsExplored) {
        exploredIslands.add(i);
      }
    }

    const result = { islandOf, mineIndices, contestedIndices, exploredIslands };
    this.islandCache = { key: cacheKey, result };
    return result;
  }

  // ── Additional Helper Methods (for MovementRulesEngine) ─────────────────────

  /**
   * Check if there's another transport at the same island with equal or fewer armies onboard.
   */
  private anotherTransportWithEqualOrFewerArmies(currentTransport: UnitView, obs: AgentObservation, islandOf: Map<string, number>): boolean {
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    const currentIslandIdx = this.getSeaUnitIslandIdx(currentTransport.x, currentTransport.y, islandOf);
    if (currentIslandIdx === undefined) return false;

    for (const transport of obs.myUnits) {
      if (transport.type !== UnitType.Transport) continue;
      if (transport.id === currentTransport.id) continue; // Skip self
      if (transport.carriedBy !== null) continue; // Only count transports at sea

      const transportIslandIdx = this.getSeaUnitIslandIdx(transport.x, transport.y, islandOf);
      if (transportIslandIdx !== currentIslandIdx) continue; // Different island

      if (transport.cargo.length <= currentTransport.cargo.length) {
        return true; // Found transport with equal or fewer armies
      }
    }
    return false;
  }

  /**
   * Check if transport is already parked on a coastal sea tile adjacent to a friendly city.
   */
  private isTransportParked(obs: AgentObservation, unit: UnitView, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): boolean {
    // Check if unit is on an ocean tile (parked position)
    const currentTile = obs.tiles[unit.y]?.[unit.x];
    if (!currentTile || currentTile.terrain !== Terrain.Ocean) {
      return false; // Not on ocean
    }

    const myIslandIdx = this.getSeaUnitIslandIdx(unit.x, unit.y, islandOf);
    if (myIslandIdx === undefined || !mineIndices.has(myIslandIdx)) {
      return false; // Not adjacent to a friendly island
    }

    // Check if adjacent to a friendly coastal city on the same island
    for (const [dx, dy] of [
      [-1, -1], [0, -1], [1, -1],
      [-1,  0],          [1,  0],
      [-1,  1], [0,  1], [1,  1],
    ] as [number, number][]) {
      const nx = wrapX(unit.x + dx, mapWidth);
      const ny = unit.y + dy;
      for (const city of obs.myCities) {
        if (city.x === nx && city.y === ny) {
          // Check that the city is on the same island
          const cityIslandIdx = islandOf.get(`${city.x},${city.y}`);
          if (cityIslandIdx === myIslandIdx) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Check if transport is on land at a friendly city.
   */
  private isTransportOnLandAtCity(obs: AgentObservation, unit: UnitView, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): boolean {
    if (unit.type !== UnitType.Transport) return false;
    const myIslandIdx = islandOf.get(`${unit.x},${unit.y}`);
    if (myIslandIdx === undefined || !mineIndices.has(myIslandIdx)) {
      return false; // Not on a friendly island
    }
    // Check if transport is on land at a friendly city
    const tile = obs.tiles[unit.y]?.[unit.x];
    if (!tile || tile.terrain !== Terrain.Land) return false;
    const city = obs.myCities.find((c) => c.x === unit.x && c.y === unit.y);
    return city !== undefined;
  }

  /**
   * Find any land on an island.
   */
  private findAnyLandOnIsland(obs: AgentObservation, islandOf: Map<string, number>, islandIdx: number, mapWidth: number, mapHeight: number): Coord | null {
    const h = obs.tiles.length;
    const w = obs.tiles[0]?.length ?? 0;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = obs.tiles[y]?.[x];
        if (tile && tile.terrain === Terrain.Land) {
          const idx = islandOf.get(`${x},${y}`);
          if (idx === islandIdx) {
            return { x, y };
          }
        }
      }
    }
    return null;
  }

  /**
   * Find coastal city on an island.
   */
  private findCoastalCityOnIsland(obs: AgentObservation, islandIdx: number, mineIndices: Set<number>, islandOf: Map<string, number>, mapWidth: number): Coord | null {
    const coastal = obs.myCities.filter((c) => {
      for (const [dx, dy] of [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],          [1,  0],
        [-1,  1], [0,  1], [1,  1],
      ] as [number, number][]) {
        const nx = wrapX(c.x + dx, mapWidth);
        const ny = c.y + dy;
        if (ny > 0 && ny < this.mapHeight - 1) {
          const tile = obs.tiles[ny]?.[nx];
          if (tile && tile.terrain === Terrain.Ocean) return true;
        }
      }
      return false;
    });
    for (const city of coastal) {
      const idx = islandOf.get(`${city.x},${city.y}`);
      if (idx === islandIdx && mineIndices.has(idx)) {
        return city;
      }
    }
    return null;
  }

  /**
   * Get islands by explored state.
   */
  private getIslandsByExploredState(obs: AgentObservation, islandOf: Map<string, number>, exploredIslands: Set<number>, isExplored: boolean): number[] {
    const tiles = obs.tiles;
    const h = tiles.length;
    const w = tiles[0]?.length ?? 0;

    // Find all unique island indices
    const allIslands = new Set<number>();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = tiles[y]?.[x];
        if (tile && tile.terrain === Terrain.Land) {
          const idx = islandOf.get(`${x},${y}`);
          if (idx !== undefined) allIslands.add(idx);
        }
      }
    }

    const result: number[] = [];
    for (const idx of allIslands) {
      const isActuallyExplored = exploredIslands.has(idx);
      if (isActuallyExplored === isExplored) {
        result.push(idx);
      }
    }
    return result;
  }

  /**
   * Get islands by friendly state.
   */
  private getIslandsByFriendlyState(obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, isFriendly: boolean): number[] {
    const tiles = obs.tiles;
    const h = tiles.length;
    const w = tiles[0]?.length ?? 0;

    // Find all unique island indices
    const allIslands = new Set<number>();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = tiles[y]?.[x];
        if (tile && tile.terrain === Terrain.Land) {
          const idx = islandOf.get(`${x},${y}`);
          if (idx !== undefined) allIslands.add(idx);
        }
      }
    }

    const result: number[] = [];
    for (const idx of allIslands) {
      const isActuallyFriendly = mineIndices.has(idx);
      if (isActuallyFriendly === isFriendly) {
        result.push(idx);
      }
    }
    return result;
  }

  /**
   * Get coastal cities on friendly islands.
   */
  private getCoastalCities(obs: AgentObservation, mineIndices: Set<number>, islandOf: Map<string, number>, mapWidth: number): Coord[] {
    return obs.myCities.filter((c) => {
      for (const [dx, dy] of [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],          [1,  0],
        [-1,  1], [0,  1], [1,  1],
      ] as [number, number][]) {
        const nx = wrapX(c.x + dx, mapWidth);
        const ny = c.y + dy;
        if (ny > 0 && ny < this.mapHeight - 1) {
          const tile = obs.tiles[ny]?.[nx];
          if (tile && tile.terrain === Terrain.Ocean) return true;
        }
      }
      return false;
    }).filter((c) => {
      const idx = islandOf.get(`${c.x},${c.y}`);
      return idx !== undefined && mineIndices.has(idx);
    });
  }

  /**
   * Find friendly island with most armies. Returns island index or null.
   */
  private friendlyIslandWithMostArmies(obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>): number | null {
    const armyCounts = new Map<number, number>();
    for (const unit of obs.myUnits) {
      if (unit.type === UnitType.Army && unit.carriedBy === null) {
        const idx = islandOf.get(`${unit.x},${unit.y}`);
        if (idx !== undefined && mineIndices.has(idx)) {
          armyCounts.set(idx, (armyCounts.get(idx) || 0) + 1);
        }
      }
    }
    let maxCount = -1;
    let maxIdx: number | null = null;
    for (const [idx, count] of armyCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxIdx = idx;
      }
    }
    return maxIdx;
  }

  /**
   * Find contested island with most armies. Returns island index or null.
   */
  private contestedIslandWithMostArmies(obs: AgentObservation, islandOf: Map<string, number>): number | null {
    const armyCounts = new Map<number, number>();
    for (const unit of obs.myUnits) {
      if (unit.type === UnitType.Army && unit.carriedBy === null) {
        const idx = islandOf.get(`${unit.x},${unit.y}`);
        if (idx !== undefined) {
          armyCounts.set(idx, (armyCounts.get(idx) || 0) + 1);
        }
      }
    }
    let maxCount = -1;
    let maxIdx: number | null = null;
    for (const [idx, count] of armyCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxIdx = idx;
      }
    }
    return maxIdx;
  }

  /**
   * Get all ocean tiles adjacent to a given island.
   * Returns an array of coordinates, or empty array if island not found.
   */
  private getOceanTilesAdjacentToIsland(obs: AgentObservation, islandOf: Map<string, number>, islandIdx: number, mapWidth: number, mapHeight: number): Coord[] {
    const tiles = obs.tiles;
    const h = tiles.length;
    const w = tiles[0]?.length ?? 0;

    const result: Coord[] = [];
    const seen = new Set<string>();

    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = tiles[y]?.[x];
        // Check if this is an ocean tile
        if (!tile || tile.terrain !== Terrain.Ocean) continue;

        // Check if this ocean tile is adjacent to the target island
        const adj = this.getAdjacentTiles(x, y, mapWidth);
        for (const adjTile of adj) {
          if (adjTile.y <= 0 || adjTile.y >= mapHeight - 1) continue;
          const adjIsland = islandOf.get(`${adjTile.x},${adjTile.y}`);
          if (adjIsland === islandIdx) {
            const key = `${x},${y}`;
            if (!seen.has(key)) {
              seen.add(key);
              result.push({ x, y });
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Get nearest unexplored land tile (Hidden = never seen).
   */
  private getNearestUnexploredLand(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null {
    return this.findNearestTile(obs, from, mapWidth, mapHeight, Terrain.Land, TileVisibility.Hidden);
  }

  /**
   * Get nearest Hidden land tile (same as unexplored for land).
   */
  private getNearestHiddenLand(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null {
    return this.findNearestTile(obs, from, mapWidth, mapHeight, Terrain.Land, TileVisibility.Hidden);
  }

  /**
   * Get nearest unexplored ocean tile (Hidden = never seen).
   */
  private getNearestUnexploredOcean(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null {
    return this.findNearestTile(obs, from, mapWidth, mapHeight, Terrain.Ocean, TileVisibility.Hidden);
  }

  /**
   * Get nearest Hidden ocean tile (same as unexplored for ocean).
   */
  private getNearestHiddenOcean(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null {
    return this.findNearestTile(obs, from, mapWidth, mapHeight, Terrain.Ocean, TileVisibility.Hidden);
  }

  /**
   * Find nearest tile matching terrain and visibility criteria.
   */
  private findNearestTile(
    obs: AgentObservation,
    from: Coord,
    mapWidth: number,
    mapHeight: number,
    terrain: Terrain,
    visibility: TileVisibility
  ): Coord | null {
    const tiles = obs.tiles;
    const h = tiles.length;
    const w = tiles[0]?.length ?? 0;

    let closest: Coord | null = null;
    let closestDist = Infinity;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = tiles[y]?.[x];
        if (!tile || tile.terrain !== terrain) continue;
        if (tile.visibility !== visibility) continue;

        const dist = this.wrappedDist(from, { x, y });
        if (dist < closestDist) {
          closestDist = dist;
          closest = { x, y };
        }
      }
    }

    return closest;
  }
}
