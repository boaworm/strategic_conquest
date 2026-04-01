import type { AgentAction, AgentObservation } from './agent.js';
import type { UnitView, CityView, Coord } from './types.js';
import { UnitType, UnitDomain, UNIT_STATS, Terrain, TileVisibility, wrapX, wrappedDistX } from './types.js';

// ── JSON schema types (mirrors movement_rules.json) ───────────────────────────

export interface MovementRule {
  conditions?: string[];
  action: string;
  note?: string;
}

export interface MovementRulesSchema {
  movement: {
    army: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
    transport: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
    destroyer: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
    fighter: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
    battleship: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
    submarine: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
    bomber: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
    carrier: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
  };
}

// ── Context passed to the engine on each query ───────────────────────────────

export interface MovementHelpers {
  /** BFS island classification */
  classifyIslands(obs: AgentObservation): {
    islandOf: Map<string, number>;
    friendlyIndices: Set<number>;
    exploredIslands: Set<number>;
  };
  /** Distance between two coordinates */
  wrappedDist(a: Coord, b: Coord): number;
  /** Get adjacent tiles (with wrapping) */
  getAdjacentTiles(x: number, y: number, mapWidth: number): Coord[];
  /** Get adjacent land tiles */
  getAdjacentLandTiles(obs: AgentObservation, x: number, y: number, mapWidth: number): Coord[];
  /** Get adjacent ocean tiles */
  getAdjacentOceanTiles(obs: AgentObservation, x: number, y: number, mapWidth: number): Coord | null;
  /** Get adjacent coastal ocean tiles (ocean tiles adjacent to land) */
  getAdjacentCoastalOcean(obs: AgentObservation, x: number, y: number, mapWidth: number, mapHeight: number): Coord[];
  /** BFS pathfinding to find best step toward target */
  bestStepToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): Coord | null;
  /** BFS pathfinding to find farthest step toward target within movesLeft */
  farthestStepToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): Coord | null;
  /** Check if island is friendly */
  isIslandFriendly(islandIdx: number | undefined, friendlyIndices: Set<number>): boolean;
  /** Check if island is fully explored */
  isIslandExplored(islandIdx: number | undefined, exploredIslands: Set<number>): boolean;
  /** Check if island is contested (has enemy cities) */
  isIslandContested(islandIdx: number | undefined, obs: AgentObservation, islandOf: Map<string, number>): boolean;
  /** Check if unit can reach a city */
  canReachCity(city: CityView, unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): boolean;
  /** Get nearest neutral city reachable from unit */
  getNearestReachableNeutralCity(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): CityView | null;
  /** Get nearest reachable enemy city on contested island */
  getNearestReachableEnemyCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, friendlyIndices: Set<number>, mapWidth: number, mapHeight: number): CityView | null;
  /** Get nearest unexplored tile reachable from unit */
  getNearestReachableUnexplored(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): Coord | null;
  /** Get nearest coastal city on friendly island */
  getNearestFriendlyCoastalCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, friendlyIndices: Set<number>, mapWidth: number, mapHeight: number): Coord | null;
  /** Find waiting transport on friendly island */
  findWaitingTransport(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, friendlyIndices: Set<number>, mapWidth: number): UnitView | null;
  /** Check if unit is adjacent to transport with room */
  isAdjacentToTransportWithRoom(unit: UnitView, obs: AgentObservation, mapWidth: number): UnitView | null;
  /** Check if unit is onboard a transport */
  isOnboardTransport(unit: UnitView): boolean;
  /** Check if transport can disembark to unexplored/contested island */
  canDisembarkToUnexploredOrContested(transport: UnitView, obs: AgentObservation, islandOf: Map<string, number>, friendlyIndices: Set<number>, exploredIslands: Set<number>): number | null;
  /** Check if another transport has equal or fewer armies */
  anotherTransportWithEqualOrFewerArmies(currentTransport: UnitView, obs: AgentObservation, islandOf: Map<string, number>): boolean;
  /** Check if transport is parked */
  isTransportParked(obs: AgentObservation, unit: UnitView, islandOf: Map<string, number>, friendlyIndices: Set<number>, mapWidth: number): boolean;
  /** Check if transport is on land at a friendly city */
  isTransportOnLandAtCity(obs: AgentObservation, unit: UnitView, islandOf: Map<string, number>, friendlyIndices: Set<number>, mapWidth: number): boolean;
  /** Find any land on island */
  findAnyLandOnIsland(obs: AgentObservation, islandOf: Map<string, number>, islandIdx: number, mapWidth: number, mapHeight: number): Coord | null;
  /** Find coastal city on island */
  findCoastalCityOnIsland(obs: AgentObservation, islandIdx: number, friendlyIndices: Set<number>, islandOf: Map<string, number>, mapWidth: number, findAnyCity: boolean): Coord | null;
  /** Get islands by explored state */
  getIslandsByExploredState(obs: AgentObservation, islandOf: Map<string, number>, exploredIslands: Set<number>, isExplored: boolean): number[];
  /** Get islands by friendly state */
  getIslandsByFriendlyState(obs: AgentObservation, islandOf: Map<string, number>, friendlyIndices: Set<number>, isFriendly: boolean): number[];
  /** Check if transport should depart the friendly island */
  shouldTransportDepart(transport: UnitView, obs: AgentObservation, islandOf: Map<string, number>, friendlyIndices: Set<number>, mapWidth: number): boolean;
  /** Find friendly island with most armies */
  friendlyIslandWithMostArmies(obs: AgentObservation, islandOf: Map<string, number>, friendlyIndices: Set<number>): number | null;
  /** Find contested island with most armies */
  contestedIslandWithMostArmies(obs: AgentObservation, islandOf: Map<string, number>): number | null;
  /** Get island index for a position, handling ocean tiles by checking adjacent land */
  getSeaUnitIslandIdx(x: number, y: number, islandOf: Map<string, number>): number | undefined;
  /** Get all ocean tiles adjacent to an island */
  getOceanTilesAdjacentToIsland(obs: AgentObservation, islandOf: Map<string, number>, islandIdx: number, mapWidth: number, mapHeight: number): Coord[];
  /** Get nearest unexplored land tile */
  getNearestUnexploredLand(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
  /** Get nearest Hidden land tile */
  getNearestHiddenLand(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
  /** Get nearest unexplored ocean tile */
  getNearestUnexploredOcean(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
  /** Get nearest Hidden ocean tile */
  getNearestHiddenOcean(obs: AgentObservation, from: Coord, mapWidth: number, mapHeight: number): Coord | null;
}

export interface MovementContext {
  phase: 1 | 2 | 3;
  unit: UnitView;
  obs: AgentObservation;
  helpers: MovementHelpers;
  mapWidth: number;
  mapHeight: number;
  transportTarget?: Coord | null;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const PHASE_NAMES: Record<1 | 2 | 3, 'Explore' | 'Expand' | 'Combat'> = {
  1: 'Explore',
  2: 'Expand',
  3: 'Combat',
};

const UNIT_NAME_MAP: Record<string, UnitType> = {
  Army: UnitType.Army,
  Transport: UnitType.Transport,
  Destroyer: UnitType.Destroyer,
  Submarine: UnitType.Submarine,
  Battleship: UnitType.Battleship,
  Fighter: UnitType.Fighter,
  Bomber: UnitType.Bomber,
  Carrier: UnitType.Carrier,
};

// ── Condition evaluators (keyed by the exact condition string in the JSON) ───

type ConditionEvaluator = (ctx: MovementContext) => boolean;

function buildConditionEvaluators(): Map<string, ConditionEvaluator> {
  const map = new Map<string, ConditionEvaluator>();

  // Army conditions
  map.set('Can reach neutral city on current island', (ctx) => {
    if (ctx.unit.type !== UnitType.Army) return false;
    const { islandOf } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    const neutralCities = ctx.obs.visibleEnemyCities.filter((c) => c.owner === null);
    return neutralCities.some((c) => {
      const cityIsland = islandOf.get(`${c.x},${c.y}`);
      if (cityIsland !== myIslandIdx) return false; // Not on current island
      return ctx.helpers.canReachCity(c, ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight);
    });
  });

  map.set('Island is contested', (ctx) => {
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    if (myIslandIdx === undefined || !friendlyIndices.has(myIslandIdx)) return false;
    return ctx.helpers.isIslandContested(myIslandIdx, ctx.obs, islandOf);
  });

  map.set('Island not fully explored', (ctx) => {
    const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return !ctx.helpers.isIslandExplored(myIslandIdx, exploredIslands);
  });

  map.set('Island is friendly and explored', (ctx) => {
    const { islandOf, friendlyIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return ctx.helpers.isIslandFriendly(myIslandIdx, friendlyIndices) &&
           ctx.helpers.isIslandExplored(myIslandIdx, exploredIslands);
  });

  map.set('Adjacent to friendly transport with room', (ctx) => {
    if (ctx.unit.type !== UnitType.Army) return false;
    return ctx.helpers.isAdjacentToTransportWithRoom(ctx.unit, ctx.obs, ctx.mapWidth) !== null;
  });

  map.set('Transport has no army onboard', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    return ctx.unit.cargo.length === 0;
  });

  map.set('Onboard transport', (ctx) => {
    return ctx.unit.carriedBy !== null;
  });

  map.set('Can disembark to unexplored or contested island', (ctx) => {
    if (ctx.unit.carriedBy === null) return false;
    // Find the transport carrying this unit
    const transport = ctx.obs.myUnits.find((u) => u.id === ctx.unit.carriedBy);
    if (!transport || transport.type !== UnitType.Transport) return false;
    const { islandOf, friendlyIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    return ctx.helpers.canDisembarkToUnexploredOrContested(
      transport, ctx.obs, islandOf, friendlyIndices, exploredIslands,
    ) !== null;
  });

  map.set('Transport is at sea', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    return tile?.terrain === Terrain.Ocean;
  });

  map.set('Transport is offshore waiting for armies', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    return ctx.helpers.findWaitingTransport(ctx.unit, ctx.obs, islandOf, friendlyIndices, ctx.mapWidth) !== null;
  });

  // Transport conditions
  map.set('No units onboard', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    return ctx.unit.cargo.length === 0;
  });

  map.set('Units onboard', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    return ctx.unit.cargo.length > 0;
  });

  map.set('Transport capacity at max', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    return ctx.unit.cargo.length >= UNIT_STATS[ctx.unit.type].cargoCapacity;
  });

  map.set('Transport capacity not at max', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    return ctx.unit.cargo.length < UNIT_STATS[ctx.unit.type].cargoCapacity;
  });

  map.set('Another transport with equal or fewer armies onboard', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf } = ctx.helpers.classifyIslands(ctx.obs);
    return ctx.helpers.anotherTransportWithEqualOrFewerArmies(
      ctx.unit, ctx.obs, islandOf,
    );
  });

  map.set('At friendly island', (ctx) => {
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return ctx.helpers.isIslandFriendly(myIslandIdx, friendlyIndices);
  });

  map.set('On ocean', (ctx) => {
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    return tile?.terrain === Terrain.Ocean;
  });

  map.set('Not at friendly island', (ctx) => {
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = ctx.helpers.getSeaUnitIslandIdx(ctx.unit.x, ctx.unit.y, islandOf);
    return !ctx.helpers.isIslandFriendly(myIslandIdx, friendlyIndices);
  });

  map.set('Adjacent to friendly island', (ctx) => {
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
    for (const tile of adjTiles) {
      const adjIsland = islandOf.get(`${tile.x},${tile.y}`);
      if (adjIsland !== undefined && friendlyIndices.has(adjIsland)) {
        return true;
      }
    }
    return false;
  });

  map.set('No transport on island', (ctx) => {
    if (ctx.unit.type !== UnitType.Army) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    if (myIslandIdx === undefined || !friendlyIndices.has(myIslandIdx)) {
      return false; // Not on friendly island
    }
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    // Check for any transport on or adjacent to the island
    for (const unit of ctx.obs.myUnits) {
      if (unit.type !== UnitType.Transport) continue;
      if (unit.cargo.length >= cap) continue; // Full
      const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(unit.x, unit.y, islandOf);
      if (transportIslandIdx === myIslandIdx) {
        return false; // Transport found on island
      }
    }
    return true; // No transport on island
  });

  map.set('Transport at unexplored island', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    const transportIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    if (transportIslandIdx === undefined) return false;
    // Check if transport is on ocean adjacent to unexplored land
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    if (!tile || tile.terrain !== Terrain.Ocean) return false;
    // Check if there's unexplored land on this island
    const unexploredLand = ctx.helpers.findAnyLandOnIsland(ctx.obs, islandOf, transportIslandIdx, ctx.mapWidth, ctx.mapHeight);
    if (!unexploredLand) return false;
    // Check if this land is unexplored
    const landTile = ctx.obs.tiles[unexploredLand.y]?.[unexploredLand.x];
    return landTile?.visibility === TileVisibility.Hidden;
  });

  map.set('Transport approaching unexplored island', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    // Transport must be on ocean (not on land)
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    if (!tile || tile.terrain !== Terrain.Ocean) return false;
    // Check if there's unexplored land adjacent to transport
    const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
    for (const adj of adjTiles) {
      const adjTile = ctx.obs.tiles[adj.y]?.[adj.x];
      if (adjTile && adjTile.terrain === Terrain.Land) {
        const adjIsland = islandOf.get(`${adj.x},${adj.y}`);
        if (adjIsland !== undefined) {
          // Check if this land is unexplored
          if (adjTile.visibility === TileVisibility.Hidden) {
            return true;
          }
        }
      }
    }
    return false;
  });

  map.set('Transport at friendly island with most armies', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(ctx.unit.x, ctx.unit.y, islandOf);
    if (transportIslandIdx === undefined || !friendlyIndices.has(transportIslandIdx)) {
      return false; // Not on friendly island
    }
    const mostArmiesIdx = ctx.helpers.friendlyIslandWithMostArmies(ctx.obs, islandOf, friendlyIndices);
    return mostArmiesIdx === transportIslandIdx && mostArmiesIdx !== null;
  });

  map.set('Transport at coastal tile on same island', (ctx) => {
    if (ctx.unit.type !== UnitType.Army) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    if (myIslandIdx === undefined || !friendlyIndices.has(myIslandIdx)) {
      return false;
    }
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    for (const unit of ctx.obs.myUnits) {
      if (unit.type !== UnitType.Transport) continue;
      if (unit.cargo.length >= cap) continue;
      const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(unit.x, unit.y, islandOf);
      if (transportIslandIdx !== myIslandIdx) continue;
      const transportTile = ctx.obs.tiles[unit.y]?.[unit.x];
      if (!transportTile || transportTile.terrain !== Terrain.Ocean) continue;
      const adjTiles = ctx.helpers.getAdjacentTiles(unit.x, unit.y, ctx.mapWidth);
      for (const adj of adjTiles) {
        const adjTile = ctx.obs.tiles[adj.y]?.[adj.x];
        if (adjTile && adjTile.terrain === Terrain.Land) {
          return true;
        }
      }
    }
    return false;
  });

  map.set('Transport at friendly island, not most armies', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(ctx.unit.x, ctx.unit.y, islandOf);
    if (transportIslandIdx === undefined || !friendlyIndices.has(transportIslandIdx)) {
      return false; // Not on friendly island
    }
    const mostArmiesIdx = ctx.helpers.friendlyIslandWithMostArmies(ctx.obs, islandOf, friendlyIndices);
    return mostArmiesIdx !== transportIslandIdx && mostArmiesIdx !== null;
  });

  map.set('Transport at contested island with most armies', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf } = ctx.helpers.classifyIslands(ctx.obs);
    const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(ctx.unit.x, ctx.unit.y, islandOf);
    if (transportIslandIdx === undefined) return false;
    const mostArmiesIdx = ctx.helpers.contestedIslandWithMostArmies(ctx.obs, islandOf);
    return mostArmiesIdx === transportIslandIdx && mostArmiesIdx !== null;
  });

  map.set('Adjacent to transport with room', (ctx) => {
    if (ctx.unit.type !== UnitType.Army) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    if (myIslandIdx === undefined || !friendlyIndices.has(myIslandIdx)) {
      return false; // Not on friendly island
    }
    const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
    const allPositions = [...adjTiles, { x: ctx.unit.x, y: ctx.unit.y }];
    for (const pos of allPositions) {
      const transport = ctx.obs.myUnits.find(
        (u) => u.type === UnitType.Transport &&
               u.cargo.length < UNIT_STATS[u.type].cargoCapacity &&
               u.x === pos.x && u.y === pos.y,
      );
      if (transport) {
        const transportIsland = ctx.helpers.getSeaUnitIslandIdx(transport.x, transport.y, islandOf);
        if (transportIsland !== undefined && friendlyIndices.has(transportIsland)) {
          return true;
        }
      }
    }
    return false;
  });

  map.set('On land at city', (ctx) => {
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    if (!tile || tile.terrain !== Terrain.Land) return false;
    // Check if unit is at a friendly city location
    const city = ctx.obs.myCities.find((c) => c.x === ctx.unit.x && c.y === ctx.unit.y);
    return city !== null;
  });

  map.set('Transport in city', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    // Check if transport is on land at a friendly city location
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    if (!tile || tile.terrain !== Terrain.Land) return false;
    const city = ctx.obs.myCities.find((c) => c.x === ctx.unit.x && c.y === ctx.unit.y);
    return city !== undefined;
  });

  map.set('Transport parked at coastal', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    // Check if transport is on ocean
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    if (!tile || tile.terrain !== Terrain.Ocean) return false;
    // Check if adjacent to friendly island
    const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
    for (const adj of adjTiles) {
      const adjIsland = islandOf.get(`${adj.x},${adj.y}`);
      if (adjIsland !== undefined && friendlyIndices.has(adjIsland)) {
        return true;
      }
    }
    return false;
  });

  map.set('Waiting transport on island', (ctx) => {
    if (ctx.unit.type !== UnitType.Army) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    return ctx.helpers.findWaitingTransport(ctx.unit, ctx.obs, islandOf, friendlyIndices, ctx.mapWidth) !== null;
  });

  map.set('No armies to load', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    // Check if there are any armies adjacent to or at the transport's location
    const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
    const allPositions = [...adjTiles, { x: ctx.unit.x, y: ctx.unit.y }];
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const army = allPositions.map(pos => ctx.obs.myUnits.find(
      (u) => u.type === UnitType.Army && u.x === pos.x && u.y === pos.y && u.carriedBy === null,
    )).find(u => u !== undefined);
    // Return true if no army found (i.e., no armies to load)
    return army === undefined;
  });

  map.set('Unexplored islands available', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    const unexploredIslands = ctx.helpers.getIslandsByExploredState(
      ctx.obs, islandOf, exploredIslands, false,
    );
    return unexploredIslands.length > 0;
  });

  map.set('Contested islands available', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const contestedIslands = ctx.helpers.getIslandsByFriendlyState(
      ctx.obs, islandOf, friendlyIndices, false,
    );
    return contestedIslands.length > 0;
  });

  map.set('In combat phase', (ctx) => {
    return ctx.phase === 3;
  });

  map.set('Enemy city within range', (ctx) => {
    if (ctx.unit.type !== UnitType.Bomber) return false;
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    for (const city of ctx.obs.visibleEnemyCities) {
      if (city.owner === null) continue;
      if (ctx.helpers.wrappedDist(city, ctx.unit) <= maxFuel) {
        return true;
      }
    }
    return false;
  });

  map.set('Troops within city', (ctx) => {
    if (ctx.unit.type !== UnitType.Bomber) return false;
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    for (const city of ctx.obs.visibleEnemyCities) {
      if (city.owner === null) continue;
      if (ctx.helpers.wrappedDist(city, ctx.unit) > maxFuel) continue;
      const hasDefender = ctx.obs.visibleEnemyUnits.some(
        (u) => u.x === city.x && u.y === city.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
      );
      if (hasDefender) return true;
    }
    return false;
  });

  map.set('Friendly troops within 2 squares', (ctx) => {
    if (ctx.unit.type !== UnitType.Bomber) return false;
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    for (const city of ctx.obs.visibleEnemyCities) {
      if (city.owner === null) continue;
      if (ctx.helpers.wrappedDist(city, ctx.unit) > maxFuel) continue;
      const friendlyArmyNear = ctx.obs.myUnits.some(
        (u) => u.type === UnitType.Army && ctx.helpers.wrappedDist(u, city) <= 2,
      );
      if (friendlyArmyNear) return true;
    }
    return false;
  });

  map.set('Enemy transport/carrier/battleship in range', (ctx) => {
    if (ctx.unit.type !== UnitType.Submarine) return false;
    const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Carrier, UnitType.Battleship];
    for (const preyType of huntingOrder) {
      const candidates = ctx.obs.visibleEnemyUnits.filter((e) => e.type === preyType);
      for (const target of candidates) {
        if (ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
          return true;
        }
      }
    }
    return false;
  });

  map.set('Transport should depart', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
    return ctx.helpers.shouldTransportDepart(ctx.unit, ctx.obs, islandOf, friendlyIndices, ctx.mapWidth);
  });

  // Destroyer conditions
  map.set('Enemy transport/destroyer/submarine in range', (ctx) => {
    if (ctx.unit.type !== UnitType.Destroyer) return false;
    const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Submarine, UnitType.Destroyer];
    for (const preyType of huntingOrder) {
      const candidates = ctx.obs.visibleEnemyUnits.filter((e) => e.type === preyType);
      for (const target of candidates) {
        if (ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
          return true;
        }
      }
    }
    return false;
  });

  // Fighter conditions
  map.set('Enemy transport in range with at least one unit onboard', (ctx) => {
    if (ctx.unit.type !== UnitType.Fighter) return false;
    for (const target of ctx.obs.visibleEnemyUnits) {
      if (target.type === UnitType.Transport && target.cargo.length > 0 &&
          ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
        return true;
      }
    }
    return false;
  });

  map.set('Enemy submarine in range', (ctx) => {
    if (ctx.unit.type !== UnitType.Fighter) return false;
    for (const target of ctx.obs.visibleEnemyUnits) {
      if (target.type === UnitType.Submarine &&
          ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
        return true;
      }
    }
    return false;
  });

  map.set('Friendly city under attack (enemy army within 3 squares)', (ctx) => {
    if (ctx.unit.type !== UnitType.Fighter) return false;
    for (const city of ctx.obs.myCities) {
      for (const enemy of ctx.obs.visibleEnemyUnits) {
        if (enemy.type === UnitType.Army &&
            ctx.helpers.wrappedDist(enemy, city) <= 3) {
          return true;
        }
      }
    }
    return false;
  });

  map.set('Fighter needs a landing strip', (ctx) => {
    if (ctx.unit.type !== UnitType.Carrier) return false;
    const fightersNeedingLand = ctx.obs.myUnits.filter(
      (u) => u.type === UnitType.Fighter && u.carriedBy === null && u.movesLeft > 0,
    );
    return ctx.unit.cargo.length < UNIT_STATS[ctx.unit.type].cargoCapacity &&
           fightersNeedingLand.length > 0;
  });

  map.set('Has active target', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    return ctx.transportTarget !== null && ctx.transportTarget !== undefined;
  });

  // Battleship conditions
  map.set('Enemy ship in range (transport/destroyer/battleship/carrier)', (ctx) => {
    if (ctx.unit.type !== UnitType.Battleship) return false;
    const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Destroyer, UnitType.Carrier, UnitType.Battleship];
    for (const preyType of huntingOrder) {
      const candidates = ctx.obs.visibleEnemyUnits.filter((e) => e.type === preyType);
      for (const target of candidates) {
        if (ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
          return true;
        }
      }
    }
    return false;
  });

  map.set('Enemy city in range with units', (ctx) => {
    if (ctx.unit.type !== UnitType.Battleship) return false;
    const enemyCitiesWithUnits = ctx.obs.visibleEnemyCities
      .filter((c) => c.owner !== null && c.coastal)
      .map((c) => ({
        city: c,
        defenders: ctx.obs.visibleEnemyUnits.filter(
          (u) => u.x === c.x && u.y === c.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
        ).length,
      }))
      .filter((e) => e.defenders > 0);
    return enemyCitiesWithUnits.some((e) =>
      ctx.helpers.wrappedDist(e.city, ctx.unit) <= ctx.unit.movesLeft,
    );
  });

  map.set('Enemy city not within range but has units', (ctx) => {
    if (ctx.unit.type !== UnitType.Battleship) return false;
    const enemyCitiesWithUnits = ctx.obs.visibleEnemyCities
      .filter((c) => c.owner !== null && c.coastal)
      .map((c) => ({
        city: c,
        defenders: ctx.obs.visibleEnemyUnits.filter(
          (u) => u.x === c.x && u.y === c.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
        ).length,
      }))
      .filter((e) => e.defenders > 0);
    return enemyCitiesWithUnits.some((e) =>
      ctx.helpers.wrappedDist(e.city, ctx.unit) > ctx.unit.movesLeft,
    );
  });

  // Bomber conditions
  map.set('Enemy city within range, troops within city, friendly troops within 2 squares', (ctx) => {
    if (ctx.unit.type !== UnitType.Bomber) return false;
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    for (const city of ctx.obs.visibleEnemyCities) {
      if (city.owner === null) continue;
      const hasDefender = ctx.obs.visibleEnemyUnits.some(
        (u) => u.x === city.x && u.y === city.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
      );
      if (!hasDefender) continue;
      const friendlyArmyNear = ctx.obs.myUnits.some(
        (u) => u.type === UnitType.Army && ctx.helpers.wrappedDist(u, city) <= 2,
      );
      if (!friendlyArmyNear) continue;
      if (ctx.helpers.wrappedDist(city, ctx.unit) <= maxFuel) {
        return true;
      }
    }
    return false;
  });

  map.set('Enemy transport within range with at least one army onboard', (ctx) => {
    if (ctx.unit.type !== UnitType.Bomber) return false;
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    for (const target of ctx.obs.visibleEnemyUnits) {
      if (target.type === UnitType.Transport && target.cargo.length > 0 &&
          ctx.helpers.wrappedDist(target, ctx.unit) <= maxFuel) {
        return true;
      }
    }
    return false;
  });

  map.set('Area with at least 30 enemy unit production combined value', (ctx) => {
    if (ctx.unit.type !== UnitType.Bomber) return false;
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    for (const enemy of ctx.obs.visibleEnemyUnits) {
      if (ctx.helpers.wrappedDist(enemy, ctx.unit) > maxFuel) continue;
      let areaValue = 0;
      for (const e of ctx.obs.visibleEnemyUnits) {
        if (ctx.helpers.wrappedDist(e, enemy) <= 1) {
          areaValue += UNIT_STATS[e.type].buildTime;
        }
      }
      if (areaValue >= 30) {
        return true;
      }
    }
    return false;
  });

  return map;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class MovementRulesEngine {
  private readonly rules: MovementRulesSchema;
  private readonly conditionEvaluators: Map<string, ConditionEvaluator>;
  private readonly mapWidth: number;
  private readonly mapHeight: number;

  constructor(rules: MovementRulesSchema, mapWidth: number, mapHeight: number) {
    this.rules = rules;
    this.conditionEvaluators = buildConditionEvaluators();
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /**
   * Evaluate the rules for the given unit and return the action to take.
   * Rules are evaluated top-to-bottom within the current phase for the unit type;
   * the first rule whose conditions all pass wins. A rule with no conditions
   * always matches.
   */
   chooseMove(ctx: MovementContext): AgentAction | null {
    const unitType = ctx.unit.type;
    const phaseName = PHASE_NAMES[ctx.phase];

    const phaseRules = this.rules.movement[unitType as unknown as 'army' | 'transport' | 'destroyer' | 'fighter' | 'battleship' | 'submarine' | 'bomber' | 'carrier']?.[phaseName];
    if (!phaseRules) {
      console.warn(`[MovementRulesEngine] No rules for unit type ${unitType} in phase ${phaseName}`);
      return null;
    }

    for (const rule of phaseRules) {
      const allMet = (rule.conditions ?? []).every((cond) => {
        const evaluator = this.conditionEvaluators.get(cond);
        if (!evaluator) {
          console.warn(`[MovementRulesEngine] Unknown condition: "${cond}"`);
          return false;
        }
        return evaluator(ctx);
      });

      if (allMet) {
        const result = this.resolveAction(rule, ctx);
        if (result) return result;
      }
    }

    // No rule matched - return null to indicate wait/SKIP
    return null;
  }

  /** Resolve the action field of a rule to a concrete AgentAction */
  private resolveAction(rule: MovementRule, ctx: MovementContext): AgentAction | null {
    const action = rule.action.trim();

    // WAIT actions
    if (action === 'Wait at current position') {
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    if (action === 'Continue toward target') {
      const target = ctx.transportTarget;
      if (!target) return null; // Let other rules evaluate

      const step = ctx.helpers.farthestStepToward(
        ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
      );
      if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      
      // If we are at the target or cannot reach it, clear it and let other rules run
      return null;
    }

    // MOVE actions - flat structure with unique action names
    if (action === 'Move to nearest neutral city and take it') {
      const nearestNeutral = ctx.helpers.getNearestReachableNeutralCity(
        ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
      );
      if (nearestNeutral) {
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, nearestNeutral, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to enemy city and take it') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const nearestEnemy = ctx.helpers.getNearestReachableEnemyCity(
        ctx.unit, ctx.obs, islandOf, friendlyIndices, ctx.mapWidth, ctx.mapHeight,
      );
      if (nearestEnemy) {
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, nearestEnemy, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to transport and board' || action === 'Move to waiting transport and board') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const waitingTransport = ctx.helpers.findWaitingTransport(
        ctx.unit, ctx.obs, islandOf, friendlyIndices, ctx.mapWidth,
      );
      if (waitingTransport) {
        const adjacentTransport = ctx.helpers.isAdjacentToTransportWithRoom(ctx.unit, ctx.obs, ctx.mapWidth);
        if (adjacentTransport) {
          return { type: 'LOAD', unitId: ctx.unit.id, transportId: adjacentTransport.id };
        }
        const adjTiles = ctx.helpers.getAdjacentTiles(waitingTransport.x, waitingTransport.y, ctx.mapWidth);
        for (const adj of adjTiles) {
          const tile = ctx.obs.tiles[adj.y]?.[adj.x];
          if (tile && tile.terrain === Terrain.Land) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, adj, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to nearest transport at coastal and board') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
      if (myIslandIdx === undefined || !friendlyIndices.has(myIslandIdx)) {
        return { type: 'SKIP', unitId: ctx.unit.id };
      }
      const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
      // Find nearest transport on coastal on the same island
      let nearestTransport: UnitView | null = null;
      let nearestDist = Infinity;
      for (const unit of ctx.obs.myUnits) {
        if (unit.type !== UnitType.Transport) continue;
        if (unit.cargo.length >= cap) continue; // Full
        const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(unit.x, unit.y, islandOf);
        if (transportIslandIdx !== myIslandIdx) continue; // Different island
        // Check if transport is on coastal (ocean next to land)
        const transportTile = ctx.obs.tiles[unit.y]?.[unit.x];
        if (!transportTile || transportTile.terrain !== Terrain.Ocean) continue;
        const adjTiles = ctx.helpers.getAdjacentTiles(unit.x, unit.y, ctx.mapWidth);
        let isCoastal = false;
        for (const adj of adjTiles) {
          const adjTile = ctx.obs.tiles[adj.y]?.[adj.x];
          if (adjTile && adjTile.terrain === Terrain.Land) {
            isCoastal = true;
            break;
          }
        }
        if (!isCoastal) continue; // Not on coastal
        const dist = ctx.helpers.wrappedDist(unit, ctx.unit);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestTransport = unit;
        }
      }
      if (nearestTransport) {
        // Check if adjacent - can load now
        const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
        for (const adj of adjTiles) {
          if (adj.x === nearestTransport.x && adj.y === nearestTransport.y) {
            return { type: 'LOAD', unitId: ctx.unit.id, transportId: nearestTransport.id };
          }
        }
        // Find nearest land tile adjacent to transport
        const transAdjTiles = ctx.helpers.getAdjacentTiles(nearestTransport.x, nearestTransport.y, ctx.mapWidth);
        let nearestLand: Coord | null = null;
        let nearestLandDist = Infinity;
        for (const adj of transAdjTiles) {
          const adjTile = ctx.obs.tiles[adj.y]?.[adj.x];
          if (adjTile && adjTile.terrain === Terrain.Land) {
            const dist = ctx.helpers.wrappedDist(adj, ctx.unit);
            if (dist < nearestLandDist) {
              nearestLandDist = dist;
              nearestLand = adj;
            }
          }
        }
        if (nearestLand) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, nearestLand, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to nearest unexplored area on island') {
      const { islandOf } = ctx.helpers.classifyIslands(ctx.obs);
      const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
      if (myIslandIdx === undefined) return { type: 'SKIP', unitId: ctx.unit.id };

      // Find nearest unexplored land tile on the same island
      const tiles = ctx.obs.tiles;
      const h = tiles.length;
      const w = tiles[0]?.length ?? 0;

      let closest: Coord | null = null;
      let closestDist = Infinity;

      for (let y = 1; y < h - 1; y++) {
        for (let x = 0; x < w; x++) {
          const tile = tiles[y]?.[x];
          if (!tile || tile.terrain !== Terrain.Land) continue;
          if (tile.visibility !== TileVisibility.Hidden) continue;

          const idx = islandOf.get(`${x},${y}`);
          if (idx !== myIslandIdx) continue; // Not on same island

          const dist = ctx.helpers.wrappedDist(ctx.unit, { x, y });
          if (dist < closestDist) {
            closestDist = dist;
            closest = { x, y };
          }
        }
      }

      if (closest) {
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, closest, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to nearest unexplored island') {
      const { islandOf, friendlyIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
      const unexploredIslands = ctx.helpers.getIslandsByExploredState(
        ctx.obs, islandOf, exploredIslands, false,
      );
      if (unexploredIslands.length > 0) {
        const targetIsland = unexploredIslands[0];
        const targetLand = ctx.helpers.findAnyLandOnIsland(
          ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight,
        );
        if (targetLand) {
          const coastalOcean = ctx.helpers.getAdjacentOceanTiles(
            ctx.obs, targetLand.x, targetLand.y, ctx.mapWidth,
          );
          if (coastalOcean) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
        const targetCity = ctx.helpers.findCoastalCityOnIsland(
          ctx.obs, targetIsland, friendlyIndices, islandOf, ctx.mapWidth, false,
        );
        if (targetCity) {
          const coastalOcean = ctx.helpers.getOceanTilesAdjacentToIsland(
            ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight,
          ).find(tile => ctx.helpers.wrappedDist(tile, targetCity) <= 1);
          if (coastalOcean) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight,
            );
            if (step && ctx.obs.tiles[step.y]?.[step.x]?.terrain === Terrain.Ocean) {
              return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to nearest contested island') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const contestedIslands = ctx.helpers.getIslandsByFriendlyState(
        ctx.obs, islandOf, friendlyIndices, false,
      );
      if (contestedIslands.length > 0) {
        const targetIsland = contestedIslands[0];
        const targetLand = ctx.helpers.findAnyLandOnIsland(
          ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight,
        );
        if (targetLand) {
          const coastalOcean = ctx.helpers.getAdjacentOceanTiles(
            ctx.obs, targetLand.x, targetLand.y, ctx.mapWidth,
          );
          if (coastalOcean) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
        const targetCity = ctx.helpers.findCoastalCityOnIsland(
          ctx.obs, targetIsland, friendlyIndices, islandOf, ctx.mapWidth, false,
        );
        if (targetCity) {
          const coastalOcean = ctx.helpers.getOceanTilesAdjacentToIsland(
            ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight,
          ).find(tile => ctx.helpers.wrappedDist(tile, targetCity) <= 1);
          if (coastalOcean) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight,
            );
            if (step && ctx.obs.tiles[step.y]?.[step.x]?.terrain === Terrain.Ocean) {
              return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to friendly island with most armies') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const targetIslandIdx = ctx.helpers.friendlyIslandWithMostArmies(ctx.obs, islandOf, friendlyIndices);
      if (targetIslandIdx !== null) {
        // Find the coastal ocean tile nearest to the transport
        const h = ctx.obs.tiles.length;
        const w = ctx.obs.tiles[0]?.length ?? 0;
        let nearestCoastal: Coord | null = null;
        let nearestDist = Infinity;

        for (let y = 1; y < h - 1; y++) {
          for (let x = 0; x < w; x++) {
            const tile = ctx.obs.tiles[y]?.[x];
            if (!tile || tile.terrain !== Terrain.Ocean) continue;

            // Check if this is coastal (adjacent to land on target island)
            const adj = ctx.helpers.getAdjacentTiles(x, y, ctx.mapWidth);
            let isCoastalOnTarget = false;
            for (const a of adj) {
              const aTile = ctx.obs.tiles[a.y]?.[a.x];
              if (aTile && aTile.terrain === Terrain.Land) {
                const aIsland = islandOf.get(`${a.x},${a.y}`);
                if (aIsland === targetIslandIdx) {
                  isCoastalOnTarget = true;
                  break;
                }
              }
            }
            if (!isCoastalOnTarget) continue;

            // Check if this is the nearest coastal tile
            const dist = ctx.helpers.wrappedDist({ x, y }, ctx.unit);
            if (dist < nearestDist) {
              nearestDist = dist;
              nearestCoastal = { x, y };
            }
          }
        }

        if (nearestCoastal) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, nearestCoastal, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to contested island with most armies') {
      const { islandOf } = ctx.helpers.classifyIslands(ctx.obs);
      const targetIslandIdx = ctx.helpers.contestedIslandWithMostArmies(ctx.obs, islandOf);
      if (targetIslandIdx !== null) {
        // Find the coastal ocean tile nearest to the transport
        const h = ctx.obs.tiles.length;
        const w = ctx.obs.tiles[0]?.length ?? 0;
        let nearestCoastal: Coord | null = null;
        let nearestDist = Infinity;

        for (let y = 1; y < h - 1; y++) {
          for (let x = 0; x < w; x++) {
            const tile = ctx.obs.tiles[y]?.[x];
            if (!tile || tile.terrain !== Terrain.Ocean) continue;

            // Check if this is coastal (adjacent to land on target island)
            const adj = ctx.helpers.getAdjacentTiles(x, y, ctx.mapWidth);
            let isCoastalOnTarget = false;
            for (const a of adj) {
              const aTile = ctx.obs.tiles[a.y]?.[a.x];
              if (aTile && aTile.terrain === Terrain.Land) {
                const aIsland = islandOf.get(`${a.x},${a.y}`);
                if (aIsland === targetIslandIdx) {
                  isCoastalOnTarget = true;
                  break;
                }
              }
            }
            if (!isCoastalOnTarget) continue;

            // Check if this is the nearest coastal tile
            const dist = ctx.helpers.wrappedDist({ x, y }, ctx.unit);
            if (dist < nearestDist) {
              nearestDist = dist;
              nearestCoastal = { x, y };
            }
          }
        }

        if (nearestCoastal) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, nearestCoastal, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to the city') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const nearestEnemy = ctx.helpers.getNearestReachableEnemyCity(
        ctx.unit, ctx.obs, islandOf, friendlyIndices, ctx.mapWidth, ctx.mapHeight,
      );
      if (nearestEnemy) {
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, nearestEnemy, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to nearest coastal city and wait') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const nearestCoastal = ctx.helpers.getNearestFriendlyCoastalCity(
        ctx.unit, ctx.obs, islandOf, friendlyIndices, ctx.mapWidth, ctx.mapHeight,
      );
      if (nearestCoastal) {
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, nearestCoastal, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to land on unexplored island') {
      const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
      const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(ctx.unit.x, ctx.unit.y, islandOf);
      if (transportIslandIdx !== undefined) {
        const targetLand = ctx.helpers.findAnyLandOnIsland(
          ctx.obs, islandOf, transportIslandIdx, ctx.mapWidth, ctx.mapHeight,
        );
        if (targetLand) {
          const coastalOcean = ctx.helpers.getOceanTilesAdjacentToIsland(
            ctx.obs, islandOf, transportIslandIdx, ctx.mapWidth, ctx.mapHeight,
          ).find(tile => ctx.helpers.wrappedDist(tile, targetLand) <= 1);
          if (coastalOcean) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to coastal ocean adjacent to unexplored island') {
      const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
      const transportIslandIdx = ctx.helpers.getSeaUnitIslandIdx(ctx.unit.x, ctx.unit.y, islandOf);
      if (transportIslandIdx !== undefined) {
        const targetLand = ctx.helpers.findAnyLandOnIsland(
          ctx.obs, islandOf, transportIslandIdx, ctx.mapWidth, ctx.mapHeight,
        );
        if (targetLand) {
          const coastalOcean = ctx.helpers.getAdjacentOceanTiles(
            ctx.obs, targetLand.x, targetLand.y, ctx.mapWidth,
          );
          if (coastalOcean) {
            const step = ctx.helpers.farthestStepToward(
              ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to adjacent ocean and wait') {
      const city = ctx.obs.myCities.find((c) => c.x === ctx.unit.x && c.y === ctx.unit.y);
      if (city) {
        // Find adjacent coastal ocean tile (ocean with land neighbor)
        const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
        let targetOcean: Coord | null = null;
        for (const adj of adjTiles) {
          const tile = ctx.obs.tiles[adj.y]?.[adj.x];
          if (tile && tile.terrain === Terrain.Ocean) {
            // Check if this is coastal (has land neighbor)
            const adj2 = ctx.helpers.getAdjacentTiles(adj.x, adj.y, ctx.mapWidth);
            for (const a2 of adj2) {
              const tile2 = ctx.obs.tiles[a2.y]?.[a2.x];
              if (tile2 && tile2.terrain === Terrain.Land) {
                targetOcean = adj;
                break;
              }
            }
            if (targetOcean) break;
          }
        }
        if (targetOcean) {
          const step = ctx.helpers.bestStepToward(ctx.obs, ctx.unit, targetOcean, ctx.mapWidth, ctx.mapHeight);
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to adjacent ocean, then sail to unexplored island') {
      const city = ctx.obs.myCities.find((c) => c.x === ctx.unit.x && c.y === ctx.unit.y);
      if (city) {
        const oceanTile = ctx.helpers.getAdjacentOceanTiles(ctx.obs, ctx.unit.x, ctx.unit.y, ctx.mapWidth);
        if (oceanTile) {
          const step = ctx.helpers.farthestStepToward(ctx.obs, ctx.unit, oceanTile, ctx.mapWidth, ctx.mapHeight);
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
      const unexploredIslands = ctx.helpers.getIslandsByExploredState(ctx.obs, islandOf, exploredIslands, false);
      if (unexploredIslands.length > 0) {
        const targetIsland = unexploredIslands[0];
        const targetCity = ctx.helpers.findCoastalCityOnIsland(ctx.obs, targetIsland, ctx.helpers.classifyIslands(ctx.obs).friendlyIndices, islandOf, ctx.mapWidth, false);
        if (targetCity) {
          const step = ctx.helpers.farthestStepToward(ctx.obs, ctx.unit, targetCity, ctx.mapWidth, ctx.mapHeight);
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
        const targetLand = ctx.helpers.findAnyLandOnIsland(ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight);
        if (targetLand) {
          const step = ctx.helpers.farthestStepToward(ctx.obs, ctx.unit, targetLand, ctx.mapWidth, ctx.mapHeight);
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to friendly city within 15 squares of enemy city or enemy units worth 15+') {
      const CONFLICT_RADIUS = 15;
      const conflictCities = ctx.obs.myCities.filter((c) => {
        const enemyCityNear = ctx.obs.visibleEnemyCities.some(
          (e) => e.owner !== null && ctx.helpers.wrappedDist(c, e) <= CONFLICT_RADIUS,
        );
        const enemyUnitNear = ctx.obs.visibleEnemyUnits.some((e) => ctx.helpers.wrappedDist(c, e) <= CONFLICT_RADIUS);
        return enemyCityNear || enemyUnitNear;
      });
      if (conflictCities.some((c) => c.x === ctx.unit.x && c.y === ctx.unit.y)) {
        return { type: 'SKIP', unitId: ctx.unit.id };
      }
      const nearestConflict = this.nearestCity(conflictCities, ctx.unit);
      if (nearestConflict) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, nearestConflict, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to nearest friendly city') {
      const homeCity = this.nearestCity(ctx.obs.myCities, ctx.unit);
      if (homeCity) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, homeCity, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to ocean for patrol') {
      const unexplored = ctx.helpers.getNearestReachableUnexplored(
        ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
      );
      if (unexplored) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, unexplored, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Move to unexplored naval areas') {
      const unexplored = ctx.helpers.getNearestReachableUnexplored(
        ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
      );
      if (unexplored) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, unexplored, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // LOAD action (Army loading onto a transport)
    if (action === 'Load army') {
      if (ctx.unit.type === UnitType.Army) {
        const adjacentTransport = ctx.helpers.isAdjacentToTransportWithRoom(
          ctx.unit, ctx.obs, ctx.mapWidth,
        );
        if (adjacentTransport) {
          return { type: 'LOAD', unitId: ctx.unit.id, transportId: adjacentTransport.id };
        }
        const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
        const transportsWithRoom = ctx.obs.myUnits.filter(
          (u) => u.type === UnitType.Transport &&
                 u.cargo.length < UNIT_STATS[u.type].cargoCapacity,
        );
        const friendlyTransports = transportsWithRoom.filter((t) => {
          const transIsland = ctx.helpers.getSeaUnitIslandIdx(t.x, t.y, islandOf);
          return transIsland !== undefined && friendlyIndices.has(transIsland);
        });
        if (friendlyTransports.length > 0) {
          let nearest: UnitView | null = null;
          let nearestDist = Infinity;
          for (const t of friendlyTransports) {
            const d = ctx.helpers.wrappedDist(t, ctx.unit);
            if (d < nearestDist) {
              nearestDist = d;
              nearest = t;
            }
          }
          if (nearest) {
            const adjTiles = ctx.helpers.getAdjacentTiles(nearest.x, nearest.y, ctx.mapWidth);
            for (const adj of adjTiles) {
              const adjTile = ctx.obs.tiles[adj.y]?.[adj.x];
              if (adjTile && adjTile.terrain === Terrain.Land) {
                const step = ctx.helpers.bestStepToward(
                  ctx.obs, ctx.unit, adj, ctx.mapWidth, ctx.mapHeight,
                );
                if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
              }
            }
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // BOARD actions
    if (action === 'Board transport to explore new islands' || action === 'Board a carrier if available') {
      if (ctx.unit.type === UnitType.Army) {
        const adjacentTransport = ctx.helpers.isAdjacentToTransportWithRoom(
          ctx.unit, ctx.obs, ctx.mapWidth,
        );
        if (adjacentTransport) {
          return { type: 'LOAD', unitId: ctx.unit.id, transportId: adjacentTransport.id };
        }
      } else if (ctx.unit.type === UnitType.Fighter) {
        const needyCarrier = ctx.obs.myUnits.find(
          (u) => u.type === UnitType.Carrier && u.cargo.length < UNIT_STATS[UnitType.Carrier].cargoCapacity,
        );
        if (needyCarrier) {
          const step = ctx.helpers.farthestStepToward(
            ctx.obs, ctx.unit, needyCarrier, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // BOARD CARRIER for fighter (separate case for clarity)
    if (action === 'Board a carrier if available' && ctx.unit.type === UnitType.Fighter) {
      const needyCarrier = ctx.obs.myUnits.find(
        (u) => u.type === UnitType.Carrier && u.cargo.length < UNIT_STATS[UnitType.Carrier].cargoCapacity,
      );
      if (needyCarrier) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, needyCarrier, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // DISEMBARK action
    if (action === 'Disembark to new island') {
      if (ctx.unit.carriedBy === null) return { type: 'SKIP', unitId: ctx.unit.id };
      const transport = ctx.obs.myUnits.find((u) => u.id === ctx.unit.carriedBy);
      if (!transport) return { type: 'SKIP', unitId: ctx.unit.id };
      const { islandOf, friendlyIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
      const disembarkIslandIdx = ctx.helpers.canDisembarkToUnexploredOrContested(
        transport, ctx.obs, islandOf, friendlyIndices, exploredIslands,
      );
      if (disembarkIslandIdx !== null) {
        // Find adjacent land tile on the target island (not any land on the island)
        const adj = ctx.helpers.getAdjacentTiles(transport.x, transport.y, ctx.mapWidth);
        for (const tile of adj) {
          if (tile.y <= 0 || tile.y >= ctx.mapHeight - 1) continue;
          const t = ctx.obs.tiles[tile.y]?.[tile.x];
          if (!t || t.terrain !== Terrain.Land) continue;
          const idx = islandOf.get(`${tile.x},${tile.y}`);
          if (idx === disembarkIslandIdx) {
            return { type: 'MOVE', unitId: ctx.unit.id, to: tile };
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // PATROL actions
    if (action === 'Begin patrol pattern around ocean' || action === 'Patrol ocean looking for enemy ships') {
      const unexplored = ctx.helpers.getNearestReachableUnexplored(
        ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
      );
      if (unexplored) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, unexplored, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // EXPLORE unexplored naval areas (Carrier)
    if (action === 'Explore unexplored naval areas') {
      const unexplored = ctx.helpers.getNearestReachableUnexplored(
        ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
      );
      if (unexplored) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, unexplored, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // MOVE to nearest unexplored sea zone (Fighter)
    if (action === 'Move to nearest unexplored sea zone (explore)') {
      const unexplored = ctx.helpers.getNearestReachableUnexplored(
        ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
      );
      if (unexplored) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, unexplored, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // FLY TO CITY action (Fighter)
    if (action === 'Fly to friendly city, stay there') {
      if (ctx.unit.type === UnitType.Fighter) {
        const citiesUnderAttack = ctx.obs.myCities.filter((c) =>
          ctx.obs.visibleEnemyUnits.some(
            (e) => e.type === UnitType.Army && ctx.helpers.wrappedDist(e, c) <= 3,
          ),
        );
        if (citiesUnderAttack.length > 0) {
          const nearestCityUnderAttack = this.nearestCity(citiesUnderAttack, ctx.unit);
          if (nearestCityUnderAttack) {
            const step = ctx.helpers.farthestStepToward(
              ctx.obs, ctx.unit, nearestCityUnderAttack, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            if (ctx.unit.x === nearestCityUnderAttack.x && ctx.unit.y === nearestCityUnderAttack.y) {
              return { type: 'SKIP', unitId: ctx.unit.id };
            }
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // SAIL to friendly island, park at coastal
    if (action === 'Sail to nearest friendly island, park at coastal') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      
      const coastalCities = ctx.obs.myCities.filter((c) => {
        const idx = islandOf.get(`${c.x},${c.y}`);
        if (idx === undefined || !friendlyIndices.has(idx)) return false;
        const adj = ctx.helpers.getAdjacentTiles(c.x, c.y, ctx.mapWidth);
        return adj.some(a => ctx.obs.tiles[a.y]?.[a.x]?.terrain === Terrain.Ocean);
      });

      const nearestFriendly = this.nearestCity(coastalCities, ctx.unit);
      if (nearestFriendly) {
        const coastalTiles = ctx.helpers.getAdjacentCoastalOcean(
          ctx.obs, nearestFriendly.x, nearestFriendly.y, ctx.mapWidth, ctx.mapHeight,
        );
        if (coastalTiles.length > 0) {
          let targetTile = coastalTiles[0];
          let minDist = ctx.helpers.wrappedDist(targetTile, ctx.unit);
          for (const tile of coastalTiles) {
            const dist = ctx.helpers.wrappedDist(tile, ctx.unit);
            if (dist < minDist) { minDist = dist; targetTile = tile; }
          }
          const step = ctx.helpers.farthestStepToward(ctx.obs, ctx.unit, targetTile, ctx.mapWidth, ctx.mapHeight);
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return null;
    }

    // SAIL to unexplored island
    if (action === 'Sail to unexplored island') {
      const { islandOf, friendlyIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
      const unexploredIslands = ctx.helpers.getIslandsByExploredState(ctx.obs, islandOf, exploredIslands, false);
      if (unexploredIslands.length > 0) {
        const targetIsland = unexploredIslands[0];
        const targetLand = ctx.helpers.findAnyLandOnIsland(ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight);
        if (targetLand) {
          const coastalOcean = ctx.helpers.getOceanTilesAdjacentToIsland(ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight)
            .find(tile => ctx.helpers.wrappedDist(tile, targetLand) <= 1);
          if (coastalOcean) {
            const step = ctx.helpers.farthestStepToward(ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight);
            if (step && ctx.obs.tiles[step.y]?.[step.x]?.terrain === Terrain.Ocean) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      return null;
    }

    // SAIL to contested island
    if (action === 'Sail to contested island') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const contestedIslands = ctx.helpers.getIslandsByFriendlyState(ctx.obs, islandOf, friendlyIndices, false);
      
      if (contestedIslands.length > 0) {
        const targetIsland = contestedIslands[0];
        const targetCity = ctx.helpers.findCoastalCityOnIsland(ctx.obs, targetIsland, friendlyIndices, islandOf, ctx.mapWidth, true);

        if (targetCity) {
           const coastalOcean = ctx.helpers.getOceanTilesAdjacentToIsland(ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight)
             .find(tile => ctx.helpers.wrappedDist(tile, targetCity) <= 1);
           if (coastalOcean) {
             const step = ctx.helpers.farthestStepToward(ctx.obs, ctx.unit, coastalOcean, ctx.mapWidth, ctx.mapHeight);
             if (step && ctx.obs.tiles[step.y]?.[step.x]?.terrain === Terrain.Ocean) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
           }
        }
      }
      return null;
    }

    // SAIL to unexplored ocean (fallback for loaded transports when no target islands)
    if (action === 'Sail to unexplored ocean') {
      const target = ctx.helpers.getNearestHiddenOcean(ctx.obs, ctx.unit, ctx.mapWidth, ctx.mapHeight);
      if (target) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
        );
        if (step && ctx.obs.tiles[step.y]?.[step.x]?.terrain === Terrain.Ocean) {
          return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }

      // No hidden tiles found, just move in any ocean direction
      const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
      for (const tile of adjTiles) {
        if (tile.y <= 0 || tile.y >= ctx.mapHeight - 1) continue;
        const t = ctx.obs.tiles[tile.y]?.[tile.x];
        if (t && t.terrain === Terrain.Ocean) {
          return { type: 'MOVE', unitId: ctx.unit.id, to: tile };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // CONTINUE toward target
    if (action === 'Continue toward target') {
      const target = ctx.transportTarget;
      if (!target) return null;
      const step = ctx.helpers.farthestStepToward(ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight);
      if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      return null;
    }

    // SAIL in random direction (fallback when no unexplored islands/ocean available)
    if (action === 'Sail in random direction') {
      // Find a distant ocean tile in a random direction
      // Pick a random direction (using unit position as seed for consistency)
      const dirs = [
        { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
      ];
      const dir = dirs[(ctx.unit.x + ctx.unit.y) % dirs.length];

      // Search for ocean tile in that direction
      const maxSteps = ctx.unit.movesLeft;
      for (let step = 1; step <= maxSteps; step++) {
        const x = wrapX(ctx.unit.x + dir.x * step, ctx.mapWidth);
        const y = ctx.unit.y + dir.y * step;
        if (y <= 0 || y >= ctx.mapHeight - 1) break; // hit ice cap
        const t = ctx.obs.tiles[y]?.[x];
        if (t && t.terrain === Terrain.Ocean) {
          return { type: 'MOVE', unitId: ctx.unit.id, to: { x, y } };
        }
      }

      // No distant ocean found, just move to adjacent ocean
      const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
      for (const tile of adjTiles) {
        if (tile.y <= 0 || tile.y >= ctx.mapHeight - 1) continue;
        const t = ctx.obs.tiles[tile.y]?.[tile.x];
        if (t && t.terrain === Terrain.Ocean) {
          return { type: 'MOVE', unitId: ctx.unit.id, to: tile };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // RETURN to friendly island for resupply
    if (action === 'Return to friendly island for resupply') {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
      for (const tile of adjTiles) {
        const adjIsland = islandOf.get(`${tile.x},${tile.y}`);
        if (adjIsland !== undefined && friendlyIndices.has(adjIsland)) {
          const coastalCities = ctx.obs.myCities.filter((c) => {
            for (const [dx, dy] of [
              [-1, -1], [0, -1], [1, -1],
              [-1,  0],          [1,  0],
              [-1,  1], [0,  1], [1,  1],
            ] as [number, number][]) {
              const nx = wrapX(c.x + dx, ctx.mapWidth);
              const ny = c.y + dy;
              if (ny > 0 && ny < ctx.mapHeight - 1) {
                const tile = ctx.obs.tiles[ny]?.[nx];
                if (tile && tile.terrain === Terrain.Ocean) return true;
              }
            }
            return false;
          }).filter((c) => {
            const idx = islandOf.get(`${c.x},${c.y}`);
            return idx !== undefined && friendlyIndices.has(idx);
          });
          const nearestFriendly = this.nearestCity(coastalCities, ctx.unit);
          if (nearestFriendly) {
            const targetTile = ctx.helpers.getAdjacentOceanTiles(
              ctx.obs, nearestFriendly.x, nearestFriendly.y, ctx.mapWidth,
            );
            if (targetTile) {
              const step = ctx.helpers.farthestStepToward(
                ctx.obs, ctx.unit, targetTile, ctx.mapWidth, ctx.mapHeight,
              );
              if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
            const step = ctx.helpers.farthestStepToward(
              ctx.obs, ctx.unit, nearestFriendly, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
          return { type: 'SKIP', unitId: ctx.unit.id };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // ATTACK actions
    if (action === 'Attack it') {
      if (ctx.unit.type === UnitType.Destroyer) {
        const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Submarine, UnitType.Destroyer];
        for (const preyType of huntingOrder) {
          const candidates = ctx.obs.visibleEnemyUnits.filter((e) => e.type === preyType);
          for (const target of candidates) {
            if (ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
              const step = ctx.helpers.farthestStepToward(
                ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
              );
              if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
          }
        }
      }
      if (ctx.unit.type === UnitType.Fighter) {
        for (const target of ctx.obs.visibleEnemyUnits) {
          if (target.type === UnitType.Transport && target.cargo.length > 0 &&
              ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
            const step = ctx.helpers.farthestStepToward(
              ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
          if (target.type === UnitType.Submarine &&
              ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
            const step = ctx.helpers.farthestStepToward(
              ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      if (ctx.unit.type === UnitType.Battleship) {
        const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Destroyer, UnitType.Carrier, UnitType.Battleship];
        for (const preyType of huntingOrder) {
          const candidates = ctx.obs.visibleEnemyUnits.filter((e) => e.type === preyType);
          for (const target of candidates) {
            if (ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
              const step = ctx.helpers.farthestStepToward(
                ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
              );
              if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Attack') {
      if (ctx.unit.type === UnitType.Fighter) {
        for (const target of ctx.obs.visibleEnemyUnits) {
          if (target.type === UnitType.Transport && target.cargo.length > 0 &&
              ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
            const step = ctx.helpers.farthestStepToward(
              ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
          if (target.type === UnitType.Submarine &&
              ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
            const step = ctx.helpers.farthestStepToward(
              ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // BOMB actions (Bomber)
    if (action === 'Bombard the city while it has units') {
      const enemyCitiesWithUnits = ctx.obs.visibleEnemyCities
        .filter((c) => c.owner !== null && c.coastal)
        .map((c) => ({
          city: c,
          defenders: ctx.obs.visibleEnemyUnits.filter(
            (u) => u.x === c.x && u.y === c.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
          ).length,
        }))
        .filter((e) => e.defenders > 0);
      if (enemyCitiesWithUnits.length > 0) {
        const nearest = this.nearestCity(enemyCitiesWithUnits.map((e) => e.city), ctx.unit);
        if (nearest) {
          const step = ctx.helpers.farthestStepToward(
            ctx.obs, ctx.unit, nearest, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Bomb city') {
      const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
      let bestCityTarget: CityView | null = null;
      let bestCityValue = -1;
      for (const city of ctx.obs.visibleEnemyCities) {
        if (city.owner === null) continue;
        const hasDefender = ctx.obs.visibleEnemyUnits.some(
          (u) => u.x === city.x && u.y === city.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
        );
        if (!hasDefender) continue;
        const friendlyArmyNear = ctx.obs.myUnits.some(
          (u) => u.type === UnitType.Army && ctx.helpers.wrappedDist(u, city) <= 2,
        );
        if (!friendlyArmyNear) continue;
        const cityUnits = ctx.obs.visibleEnemyUnits.filter(
          (u) => u.x === city.x && u.y === city.y,
        );
        const productionValue = cityUnits.reduce((sum, u) => sum + UNIT_STATS[u.type].buildTime, 0);
        if (productionValue > 0 && ctx.helpers.wrappedDist(city, ctx.unit) <= maxFuel) {
          if (productionValue > bestCityValue) {
            bestCityValue = productionValue;
            bestCityTarget = city;
          }
        }
      }
      if (bestCityTarget) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, bestCityTarget, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Bomb transport') {
      const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
      for (const target of ctx.obs.visibleEnemyUnits) {
        if (target.type === UnitType.Transport && target.cargo.length > 0 &&
            ctx.helpers.wrappedDist(target, ctx.unit) <= maxFuel) {
          const step = ctx.helpers.farthestStepToward(
            ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }
    if (action === 'Bomb area') {
      const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
      let bestAreaTarget: UnitView | null = null;
      let bestAreaValue = -1;
      for (const enemy of ctx.obs.visibleEnemyUnits) {
        if (ctx.helpers.wrappedDist(enemy, ctx.unit) > maxFuel) continue;
        let areaValue = 0;
        for (const e of ctx.obs.visibleEnemyUnits) {
          if (ctx.helpers.wrappedDist(e, enemy) <= 1) {
            areaValue += UNIT_STATS[e.type].buildTime;
          }
        }
        if (areaValue >= 30 && areaValue > bestAreaValue) {
          bestAreaValue = areaValue;
          bestAreaTarget = enemy;
        }
      }
      if (bestAreaTarget) {
        const step = ctx.helpers.farthestStepToward(
          ctx.obs, ctx.unit, bestAreaTarget, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // POSITION CARRIER (Carrier)
    if (action === 'Position carrier to support fighter operations') {
      if (ctx.unit.type === UnitType.Carrier) {
        const fighterRange = UNIT_STATS[UnitType.Fighter].movesPerTurn;
        const citiesInRange = new Set<string>();
        for (let i = 0; i < ctx.obs.myCities.length; i++) {
          for (let j = i + 1; j < ctx.obs.myCities.length; j++) {
            const dist = ctx.helpers.wrappedDist(ctx.obs.myCities[i], ctx.obs.myCities[j]);
            if (dist <= fighterRange) {
              citiesInRange.add(`${ctx.obs.myCities[i].x},${ctx.obs.myCities[i].y}`);
              citiesInRange.add(`${ctx.obs.myCities[j].x},${ctx.obs.myCities[j].y}`);
            }
          }
        }
        const isolatedCities = ctx.obs.myCities.filter(
          (c) => !citiesInRange.has(`${c.x},${c.y}`) && c.coastal,
        );
        let target: Coord | null = null;
        if (isolatedCities.length > 0) {
          target = this.nearestCity(isolatedCities, ctx.unit);
        }
        if (!target) {
          target = ctx.helpers.getNearestReachableUnexplored(
            ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
          );
        }
        if (target) {
          const step = ctx.helpers.farthestStepToward(
            ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // Unhandled action
    console.warn(`[MovementRulesEngine] Unhandled action: "${action}"`);
    return null;
  }

  private nearestCity(
    cities: readonly { x: number; y: number }[],
    from: Coord,
  ): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (const c of cities) {
      const d = this.wrapDist(c, from);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  private wrapDist(a: Coord, b: Coord): number {
    return wrappedDistX(a.x, b.x, this.mapWidth) + Math.abs(a.y - b.y);
  }
}
