import type { AgentAction, AgentObservation } from './agent.js';
import type { UnitView, CityView, Coord } from './types.js';
import { UnitType, UnitDomain, UNIT_STATS, Terrain, wrapX, wrappedDistX } from './types.js';

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
    mineIndices: Set<number>;
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
  /** BFS pathfinding to find best step toward target */
  bestStepToward(obs: AgentObservation, unit: UnitView, target: Coord, mapWidth: number, mapHeight: number): Coord | null;
  /** Check if island is friendly */
  isIslandFriendly(islandIdx: number | undefined, mineIndices: Set<number>): boolean;
  /** Check if island is fully explored */
  isIslandExplored(islandIdx: number | undefined, exploredIslands: Set<number>): boolean;
  /** Check if island is contested (has enemy cities) */
  isIslandContested(islandIdx: number | undefined, obs: AgentObservation, islandOf: Map<string, number>): boolean;
  /** Check if unit can reach a city */
  canReachCity(city: CityView, unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): boolean;
  /** Get nearest neutral city reachable from unit */
  getNearestReachableNeutralCity(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): CityView | null;
  /** Get nearest reachable enemy city on contested island */
  getNearestReachableEnemyCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number, mapHeight: number): CityView | null;
  /** Get nearest unexplored tile reachable from unit */
  getNearestReachableUnexplored(unit: UnitView, obs: AgentObservation, mapWidth: number, mapHeight: number): Coord | null;
  /** Get nearest coastal city on friendly island */
  getNearestFriendlyCoastalCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number, mapHeight: number): Coord | null;
  /** Find waiting transport on friendly island */
  findWaitingTransport(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): UnitView | null;
  /** Check if unit is adjacent to transport with room */
  isAdjacentToTransportWithRoom(unit: UnitView, obs: AgentObservation, mapWidth: number): UnitView | null;
  /** Check if unit is onboard a transport */
  isOnboardTransport(unit: UnitView): boolean;
  /** Check if transport can disembark to unexplored/contested land */
  canDisembarkToUnexploredOrContested(transport: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, exploredIslands: Set<number>): Coord | null;
  /** Check if another transport has equal or fewer armies */
  anotherTransportWithEqualOrFewerArmies(currentTransport: UnitView, obs: AgentObservation, islandOf: Map<string, number>): boolean;
  /** Check if transport is parked */
  isTransportParked(obs: AgentObservation, unit: UnitView, islandOf: Map<string, number>, mineIndices: Set<number>, mapWidth: number): boolean;
  /** Find any land on island */
  findAnyLandOnIsland(obs: AgentObservation, islandOf: Map<string, number>, islandIdx: number, mapWidth: number, mapHeight: number): Coord | null;
  /** Find coastal city on island */
  findCoastalCityOnIsland(obs: AgentObservation, islandIdx: number, mineIndices: Set<number>, islandOf: Map<string, number>, mapWidth: number): Coord | null;
  /** Get islands by explored state */
  getIslandsByExploredState(obs: AgentObservation, islandOf: Map<string, number>, exploredIslands: Set<number>, isExplored: boolean): number[];
  /** Get islands by friendly state */
  getIslandsByFriendlyState(obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, isFriendly: boolean): number[];
}

export interface MovementContext {
  phase: 1 | 2 | 3;
  unit: UnitView;
  obs: AgentObservation;
  helpers: MovementHelpers;
  mapWidth: number;
  mapHeight: number;
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
    const neutralCities = ctx.obs.visibleEnemyCities.filter((c) => c.owner === null);
    return neutralCities.some((c) =>
      ctx.helpers.canReachCity(c, ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight),
    );
  });

  map.set('Island is contested', (ctx) => {
    const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return ctx.helpers.isIslandContested(myIslandIdx, ctx.obs, islandOf);
  });

  map.set('Island not fully explored', (ctx) => {
    const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return !ctx.helpers.isIslandExplored(myIslandIdx, exploredIslands);
  });

  map.set('Island is friendly and explored', (ctx) => {
    const { islandOf, mineIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return ctx.helpers.isIslandFriendly(myIslandIdx, mineIndices) &&
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
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, mineIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    return ctx.helpers.canDisembarkToUnexploredOrContested(
      ctx.unit, ctx.obs, islandOf, mineIndices, exploredIslands,
    ) !== null;
  });

  map.set('Transport is at sea', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    return tile?.terrain === Terrain.Ocean;
  });

  map.set('Transport is offshore waiting for armies', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
    return ctx.helpers.findWaitingTransport(ctx.unit, ctx.obs, islandOf, mineIndices, ctx.mapWidth) !== null;
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
    const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return ctx.helpers.isIslandFriendly(myIslandIdx, mineIndices);
  });

  map.set('Not at friendly island', (ctx) => {
    const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const myIslandIdx = islandOf.get(`${ctx.unit.x},${ctx.unit.y}`);
    return !ctx.helpers.isIslandFriendly(myIslandIdx, mineIndices);
  });

  map.set('Adjacent to friendly island', (ctx) => {
    const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
    const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
    for (const tile of adjTiles) {
      const adjIsland = islandOf.get(`${tile.x},${tile.y}`);
      if (adjIsland !== undefined && mineIndices.has(adjIsland)) {
        return true;
      }
    }
    return false;
  });

  map.set('Army is adjacent or same location', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
    const allPositions = [...adjTiles, { x: ctx.unit.x, y: ctx.unit.y }];
    const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
    for (const pos of allPositions) {
      const unit = ctx.obs.myUnits.find(
        (u) => u.type === UnitType.Army && u.x === pos.x && u.y === pos.y && u.carriedBy === null,
      );
      if (unit) {
        const unitIsland = islandOf.get(`${unit.x},${unit.y}`);
        if (unitIsland !== undefined && mineIndices.has(unitIsland)) {
          return true;
        }
      }
    }
    return false;
  });

  map.set('No armies to load', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    return !ctx.helpers.isAdjacentToTransportWithRoom(ctx.unit, ctx.obs, ctx.mapWidth);
  });

  map.set('Unexplored islands available', (ctx) => {
    if (ctx.unit.type !== UnitType.Transport) return false;
    const { islandOf, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
    const unexploredIslands = ctx.helpers.getIslandsByExploredState(
      ctx.obs, islandOf, exploredIslands, false,
    );
    return unexploredIslands.length > 0;
  });

  map.set('In combat phase', (ctx) => {
    return ctx.phase === 3;
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
      const conditions = rule.conditions ?? [];
      const allMet = conditions.every((cond) => {
        const evaluator = this.conditionEvaluators.get(cond);
        if (!evaluator) {
          console.warn(`[MovementRulesEngine] Unknown condition: "${cond}"`);
          return false;
        }
        return evaluator(ctx);
      });

      if (allMet) {
        return this.resolveAction(rule, ctx);
      }
    }

    // No rule matched - return null to indicate wait/SKIP
    return null;
  }

  /** Resolve the action field of a rule to a concrete AgentAction */
  private resolveAction(rule: MovementRule, ctx: MovementContext): AgentAction | null {
    const action = rule.action.trim();

    // MOVE actions
    if (action.startsWith('Move to ')) {
      if (action.includes('neutral city')) {
        const nearestNeutral = ctx.helpers.getNearestReachableNeutralCity(
          ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
        );
        if (nearestNeutral) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, nearestNeutral, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      if (action.includes('enemy city')) {
        const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
        const nearestEnemy = ctx.helpers.getNearestReachableEnemyCity(
          ctx.unit, ctx.obs, islandOf, mineIndices, ctx.mapWidth, ctx.mapHeight,
        );
        if (nearestEnemy) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, nearestEnemy, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      if (action.includes('unexplored area')) {
        const unexplored = ctx.helpers.getNearestReachableUnexplored(
          ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
        );
        if (unexplored) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, unexplored, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
        // Unexplored tile exists but not reachable - skip this turn
        return null;
      }
      if (action.includes('transport and board')) {
        const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
        const waitingTransport = ctx.helpers.findWaitingTransport(
          ctx.unit, ctx.obs, islandOf, mineIndices, ctx.mapWidth,
        );
        if (waitingTransport) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, waitingTransport, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      if (action.includes('friendly city')) {
        const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
        const nearestCoastal = ctx.helpers.getNearestFriendlyCoastalCity(
          ctx.unit, ctx.obs, islandOf, mineIndices, ctx.mapWidth, ctx.mapHeight,
        );
        if (nearestCoastal) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, nearestCoastal, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
    }

    // LOAD action (Army loading onto a transport)
    if (action === 'Load army') {
      // If unit is an Army, try to load onto adjacent transport
      if (ctx.unit.type === UnitType.Army) {
        const adjacentTransport = ctx.helpers.isAdjacentToTransportWithRoom(
          ctx.unit, ctx.obs, ctx.mapWidth,
        );
        if (adjacentTransport) {
          return { type: 'LOAD', unitId: ctx.unit.id, transportId: adjacentTransport.id };
        }
        // Transport not adjacent but exists - try to move toward it
        const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
        // Find all transports with room on the same friendly island
        const transportsWithRoom = ctx.obs.myUnits.filter(
          (u) => u.type === UnitType.Transport &&
                 u.cargo.length < UNIT_STATS[u.type].cargoCapacity,
        );
        // Filter to transports on the same friendly island
        const friendlyTransports = transportsWithRoom.filter((t) => {
          const transIsland = islandOf.get(`${t.x},${t.y}`);
          return transIsland !== undefined && mineIndices.has(transIsland);
        });
        if (friendlyTransports.length > 0) {
          // Find nearest transport
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
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, nearest, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      // If unit is a Transport, check if army is adjacent and load it
      else if (ctx.unit.type === UnitType.Transport) {
        const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
        const allPositions = [...adjTiles, { x: ctx.unit.x, y: ctx.unit.y }];
        const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
        for (const pos of allPositions) {
          const army = ctx.obs.myUnits.find(
            (u) => u.type === UnitType.Army && u.x === pos.x && u.y === pos.y && u.carriedBy === null,
          );
          if (army) {
            const armyIsland = islandOf.get(`${army.x},${army.y}`);
            if (armyIsland !== undefined && mineIndices.has(armyIsland)) {
              return { type: 'LOAD', unitId: army.id, transportId: ctx.unit.id };
            }
          }
        }
      }
    }

    // BOARD action (army boarding transport)
    if (action === 'Board transport to explore new islands') {
      const adjacentTransport = ctx.helpers.isAdjacentToTransportWithRoom(
        ctx.unit, ctx.obs, ctx.mapWidth,
      );
      if (adjacentTransport) {
        return { type: 'LOAD', unitId: ctx.unit.id, transportId: adjacentTransport.id };
      }
    }

    // DISEMBARK action
    if (action === 'Disembark to new island') {
      const { islandOf, mineIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
      const disembarkTarget = ctx.helpers.canDisembarkToUnexploredOrContested(
        ctx.unit, ctx.obs, islandOf, mineIndices, exploredIslands,
      );
      if (disembarkTarget) {
        return { type: 'UNLOAD', unitId: ctx.unit.id, to: disembarkTarget };
      }
    }

    // SAIL actions (transport movement)
    if (action.startsWith('Sail to ')) {
      if (action.includes('friendly island')) {
        // Return to friendly island - find nearest coastal city on adjacent friendly island
        const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
        const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
        for (const tile of adjTiles) {
          const adjIsland = islandOf.get(`${tile.x},${tile.y}`);
          if (adjIsland !== undefined && mineIndices.has(adjIsland)) {
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
              return idx !== undefined && mineIndices.has(idx);
            });
            const nearestFriendly = this.nearestCity(coastalCities, ctx.unit);
            if (nearestFriendly) {
              const targetTile = ctx.helpers.getAdjacentOceanTiles(
                ctx.obs, nearestFriendly.x, nearestFriendly.y, ctx.mapWidth,
              );
              if (targetTile) {
                const step = ctx.helpers.bestStepToward(
                  ctx.obs, ctx.unit, targetTile, ctx.mapWidth, ctx.mapHeight,
                );
                if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
              }
              const step = ctx.helpers.bestStepToward(
                ctx.obs, ctx.unit, nearestFriendly, ctx.mapWidth, ctx.mapHeight,
              );
              if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
            break;
          }
        }
      }
      if (action.includes('unexplored island')) {
        const { islandOf, mineIndices, exploredIslands } = ctx.helpers.classifyIslands(ctx.obs);
        const unexploredIslands = ctx.helpers.getIslandsByExploredState(
          ctx.obs, islandOf, exploredIslands, false,
        );
        if (unexploredIslands.length > 0) {
          const targetIsland = unexploredIslands[0];
          // If we have armies onboard, try to disembark first
          if (ctx.unit.cargo.length > 0) {
            const disembarkTarget = ctx.helpers.canDisembarkToUnexploredOrContested(
              ctx.unit, ctx.obs, islandOf, mineIndices, exploredIslands,
            );
            if (disembarkTarget) {
              return { type: 'UNLOAD', unitId: ctx.unit.id, to: disembarkTarget };
            }
          }
          const targetCity = ctx.helpers.findCoastalCityOnIsland(
            ctx.obs, targetIsland, ctx.helpers.classifyIslands(ctx.obs).mineIndices, islandOf, ctx.mapWidth,
          );
          if (targetCity) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, targetCity, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
          const targetLand = ctx.helpers.findAnyLandOnIsland(
            ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight,
          );
          if (targetLand) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, targetLand, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      if (action.includes('contested island')) {
        const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
        const contestedIslands = ctx.helpers.getIslandsByFriendlyState(
          ctx.obs, islandOf, mineIndices, false,
        );
        if (contestedIslands.length > 0) {
          const targetIsland = contestedIslands[0];
          const targetCity = ctx.helpers.findCoastalCityOnIsland(
            ctx.obs, targetIsland, mineIndices, islandOf, ctx.mapWidth,
          );
          if (targetCity) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, targetCity, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
          const targetLand = ctx.helpers.findAnyLandOnIsland(
            ctx.obs, islandOf, targetIsland, ctx.mapWidth, ctx.mapHeight,
          );
          if (targetLand) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, targetLand, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
        }
      }
      if (action.includes('naval areas')) {
        const unexplored = ctx.helpers.getNearestReachableUnexplored(
          ctx.unit, ctx.obs, ctx.mapWidth, ctx.mapHeight,
        );
        if (unexplored) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, unexplored, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
    }

    // PARK/WAIT actions
    if (action.includes('Wait') || action.includes('park')) {
      const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
      // If already parked, skip
      if (ctx.helpers.isTransportParked(ctx.obs, ctx.unit, islandOf, mineIndices, ctx.mapWidth)) {
        return { type: 'SKIP', unitId: ctx.unit.id };
      }
      // Otherwise, try to find a parking spot adjacent to a friendly city
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
        return idx !== undefined && mineIndices.has(idx);
      });
      for (const city of coastalCities) {
        const targetTile = ctx.helpers.getAdjacentOceanTiles(ctx.obs, city.x, city.y, ctx.mapWidth);
        if (targetTile) {
          const step = ctx.helpers.bestStepToward(ctx.obs, ctx.unit, targetTile, ctx.mapWidth, ctx.mapHeight);
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
      // If no parking spot found, just skip
      return { type: 'SKIP', unitId: ctx.unit.id };
    }

    // RETURN/RESUPPLY actions
    if (action.includes('Return to friendly island')) {
      const { islandOf, mineIndices } = ctx.helpers.classifyIslands(ctx.obs);
      const adjTiles = ctx.helpers.getAdjacentTiles(ctx.unit.x, ctx.unit.y, ctx.mapWidth);
      for (const tile of adjTiles) {
        const adjIsland = islandOf.get(`${tile.x},${tile.y}`);
        if (adjIsland !== undefined && mineIndices.has(adjIsland)) {
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
            return idx !== undefined && mineIndices.has(idx);
          });
          const nearestFriendly = this.nearestCity(coastalCities, ctx.unit);
          if (nearestFriendly) {
            const targetTile = ctx.helpers.getAdjacentOceanTiles(
              ctx.obs, nearestFriendly.x, nearestFriendly.y, ctx.mapWidth,
            );
            if (targetTile) {
              const step = ctx.helpers.bestStepToward(
                ctx.obs, ctx.unit, targetTile, ctx.mapWidth, ctx.mapHeight,
              );
              if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, nearestFriendly, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
          break;
        }
      }
    }

    // ATTACK actions
    if (action.includes('Attack')) {
      if (ctx.unit.type === UnitType.Destroyer) {
        const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Submarine, UnitType.Destroyer];
        for (const preyType of huntingOrder) {
          const candidates = ctx.obs.visibleEnemyUnits.filter((e) => e.type === preyType);
          for (const target of candidates) {
            if (ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
              const step = ctx.helpers.bestStepToward(
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
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
          }
          if (target.type === UnitType.Submarine &&
              ctx.helpers.wrappedDist(target, ctx.unit) <= ctx.unit.movesLeft) {
            const step = ctx.helpers.bestStepToward(
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
              const step = ctx.helpers.bestStepToward(
                ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
              );
              if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            }
          }
        }
      }
    }

    // BOARD CARRIER action
    if (action === 'Board a carrier if available') {
      if (ctx.unit.type === UnitType.Fighter) {
        const needyCarrier = ctx.obs.myUnits.find(
          (u) => u.type === UnitType.Carrier && u.cargo.length < UNIT_STATS[UnitType.Carrier].cargoCapacity,
        );
        if (needyCarrier) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, needyCarrier, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
    }

    // FLY TO CITY action
    if (action.includes('Fly to friendly city')) {
      if (ctx.unit.type === UnitType.Fighter) {
        const citiesUnderAttack = ctx.obs.myCities.filter((c) =>
          ctx.obs.visibleEnemyUnits.some(
            (e) => e.type === UnitType.Army && ctx.helpers.wrappedDist(e, c) <= 3,
          ),
        );
        if (citiesUnderAttack.length > 0) {
          const nearestCityUnderAttack = this.nearestCity(citiesUnderAttack, ctx.unit);
          if (nearestCityUnderAttack) {
            const step = ctx.helpers.bestStepToward(
              ctx.obs, ctx.unit, nearestCityUnderAttack, ctx.mapWidth, ctx.mapHeight,
            );
            if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
            if (ctx.unit.x === nearestCityUnderAttack.x && ctx.unit.y === nearestCityUnderAttack.y) {
              return { type: 'SKIP', unitId: ctx.unit.id };
            }
          }
        }
      }
    }

    // BOMB actions (Bomber)
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
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, bestCityTarget, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
    }

    if (action === 'Bomb transport') {
      const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
      for (const target of ctx.obs.visibleEnemyUnits) {
        if (target.type === UnitType.Transport && target.cargo.length > 0 &&
            ctx.helpers.wrappedDist(target, ctx.unit) <= maxFuel) {
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
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
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, bestAreaTarget, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
    }

    // MOVE TO CONFLICT CITY (Bomber)
    if (action.includes('Move to friendly city within 15 squares of enemy city')) {
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
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, nearestConflict, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
    }

    // RETURN TO HOME CITY (Bomber)
    if (action === 'Return to nearest friendly city') {
      const homeCity = this.nearestCity(ctx.obs.myCities, ctx.unit);
      if (homeCity) {
        const step = ctx.helpers.bestStepToward(
          ctx.obs, ctx.unit, homeCity, ctx.mapWidth, ctx.mapHeight,
        );
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
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
          const step = ctx.helpers.bestStepToward(
            ctx.obs, ctx.unit, target, ctx.mapWidth, ctx.mapHeight,
          );
          if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
        }
      }
    }

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
