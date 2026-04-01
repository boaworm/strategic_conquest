import type { AgentAction, AgentObservation } from './agent.js';
import type { UnitView, CityView, Coord } from './types.js';
import { UnitType, UnitDomain, UNIT_STATS, Terrain, TileVisibility, wrapX, wrappedDistX } from './types.js';
import { MapQuery } from './basicAgent_mapQuery.js';

// ── JSON schema types ────────────────────────────────────────────────────────

export interface MovementRule {
  conditions?: string[];
  action: string;
  note?: string;
}

export interface MovementRulesSchema {
  movement: {
    [unitType: string]: {
      Explore: MovementRule[];
      Expand: MovementRule[];
      Combat: MovementRule[];
    };
  };
}

// ── Context passed to the engine ─────────────────────────────────────────────

export interface MovementContext {
  phase: 1 | 2 | 3;
  unit: UnitView;
  obs: AgentObservation;
  map: MapQuery;
  mapWidth: number;
  mapHeight: number;
  transportTarget?: Coord | null;
}

// ── Phase name mapping ───────────────────────────────────────────────────────

const PHASE_NAMES: Record<1 | 2 | 3, 'Explore' | 'Expand' | 'Combat'> = {
  1: 'Explore',
  2: 'Expand',
  3: 'Combat',
};

// ── Condition evaluators ─────────────────────────────────────────────────────

type ConditionEvaluator = (ctx: MovementContext) => boolean;

function buildConditionEvaluators(): Map<string, ConditionEvaluator> {
  const m = new Map<string, ConditionEvaluator>();

  // ── Army conditions ─────────────────────────────────────────

  m.set('neutral_city_reachable_on_island', (ctx) => {
    return ctx.map.locateNearestNeutralCityOnIsland(ctx.unit, ctx.obs) !== null;
  });

  m.set('island_has_enemy_cities', (ctx) => {
    const idx = ctx.map.getIslandIdx(ctx.unit.x, ctx.unit.y, ctx.obs);
    return ctx.map.islandHasEnemyCities(idx, ctx.obs);
  });

  m.set('island_not_explored', (ctx) => {
    const idx = ctx.map.getIslandIdx(ctx.unit.x, ctx.unit.y, ctx.obs);
    return !ctx.map.isIslandExplored(idx, ctx.obs);
  });

  m.set('island_friendly_and_explored', (ctx) => {
    const idx = ctx.map.getIslandIdx(ctx.unit.x, ctx.unit.y, ctx.obs);
    return ctx.map.isIslandFriendly(idx, ctx.obs) && ctx.map.isIslandExplored(idx, ctx.obs);
  });

  m.set('island_friendly', (ctx) => {
    const idx = ctx.map.getIslandIdxForUnit(ctx.unit.x, ctx.unit.y, ctx.obs);
    return ctx.map.isIslandFriendly(idx, ctx.obs);
  });

  m.set('transport_on_island', (ctx) => {
    return ctx.map.findTransportOnIsland(ctx.unit, ctx.obs) !== null;
  });

  m.set('no_transport_on_island', (ctx) => {
    return ctx.map.findTransportOnIsland(ctx.unit, ctx.obs) === null;
  });

  m.set('onboard_transport', (ctx) => {
    return ctx.unit.carriedBy !== null;
  });

  m.set('can_disembark', (ctx) => {
    if (ctx.unit.carriedBy === null) return false;
    const transport = ctx.obs.myUnits.find((u) => u.id === ctx.unit.carriedBy);
    if (!transport) return false;
    return ctx.map.canDisembark(transport, ctx.obs) !== null;
  });

  // ── Transport conditions ────────────────────────────────────

  m.set('has_active_target', (ctx) => {
    return ctx.transportTarget !== null && ctx.transportTarget !== undefined;
  });

  m.set('no_cargo', (ctx) => {
    return ctx.unit.cargo.length === 0;
  });

  m.set('has_cargo', (ctx) => {
    return ctx.unit.cargo.length > 0;
  });

  m.set('cargo_full', (ctx) => {
    return ctx.unit.cargo.length >= UNIT_STATS[ctx.unit.type].cargoCapacity;
  });

  m.set('cargo_not_full', (ctx) => {
    return ctx.unit.cargo.length < UNIT_STATS[ctx.unit.type].cargoCapacity;
  });

  m.set('in_city', (ctx) => {
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    if (!tile || tile.terrain !== Terrain.Land) return false;
    return ctx.obs.myCities.some((c) => c.x === ctx.unit.x && c.y === ctx.unit.y);
  });

  m.set('parked_at_coastal', (ctx) => {
    const tile = ctx.obs.tiles[ctx.unit.y]?.[ctx.unit.x];
    if (!tile || tile.terrain !== Terrain.Ocean) return false;
    const idx = ctx.map.getIslandIdxForUnit(ctx.unit.x, ctx.unit.y, ctx.obs);
    return ctx.map.isIslandFriendly(idx, ctx.obs);
  });

  m.set('at_friendly_island', (ctx) => {
    const idx = ctx.map.getIslandIdxForUnit(ctx.unit.x, ctx.unit.y, ctx.obs);
    return ctx.map.isIslandFriendly(idx, ctx.obs);
  });

  m.set('at_contested_island', (ctx) => {
    const idx = ctx.map.getIslandIdxForUnit(ctx.unit.x, ctx.unit.y, ctx.obs);
    return idx !== undefined && !ctx.map.isIslandFriendly(idx, ctx.obs);
  });

  m.set('unexplored_islands_exist', (ctx) => {
    return ctx.map.locateNearestUnexploredIsland(ctx.unit, ctx.obs) !== null;
  });

  m.set('contested_islands_exist', (ctx) => {
    return ctx.map.locateNearestContestedIsland(ctx.unit, ctx.obs) !== null;
  });

  m.set('another_transport_fewer_armies', (ctx) => {
    return ctx.map.anotherTransportWithFewerArmies(ctx.unit, ctx.obs);
  });

  m.set('at_island_with_most_armies', (ctx) => {
    const idx = ctx.map.getIslandIdxForUnit(ctx.unit.x, ctx.unit.y, ctx.obs);
    const mostIdx = ctx.map.friendlyIslandWithMostArmies(ctx.obs);
    return idx !== undefined && mostIdx === idx;
  });

  // ── Combat conditions (shared) ──────────────────────────────

  m.set('enemy_ship_in_range', (ctx) => {
    return ctx.map.huntForEnemyShipping(ctx.unit, ctx.obs, ctx.unit.movesLeft) !== null;
  });

  m.set('enemy_high_value_ship_in_range', (ctx) => {
    return ctx.map.findEnemyInRange(ctx.unit, ctx.obs, [UnitType.Transport, UnitType.Carrier, UnitType.Battleship]) !== null;
  });

  m.set('enemy_transport_with_cargo_in_range', (ctx) => {
    return ctx.map.findEnemyTransportWithCargo(ctx.unit, ctx.obs, ctx.unit.movesLeft) !== null;
  });

  m.set('enemy_submarine_in_range', (ctx) => {
    return ctx.map.findEnemyInRange(ctx.unit, ctx.obs, [UnitType.Submarine]) !== null;
  });

  m.set('friendly_city_under_attack', (ctx) => {
    return ctx.map.findCityUnderAttack(ctx.obs, 3) !== null;
  });

  m.set('enemy_city_with_defenders_in_range', (ctx) => {
    return ctx.map.findEnemyCityWithDefenders(ctx.unit, ctx.obs, ctx.unit.movesLeft) !== null;
  });

  m.set('enemy_city_with_defenders_exists', (ctx) => {
    return ctx.map.findEnemyCityWithDefenders(ctx.unit, ctx.obs) !== null;
  });

  m.set('enemy_loaded_transport_in_range', (ctx) => {
    return ctx.map.findEnemyTransportWithCargo(ctx.unit, ctx.obs, ctx.unit.movesLeft) !== null;
  });

  m.set('enemy_city_with_troops_in_range', (ctx) => {
    return ctx.map.locateEnemyCityWithTroops(ctx.unit, ctx.obs, ctx.unit.movesLeft) !== null;
  });

  m.set('enemy_city_with_troops_exists', (ctx) => {
    return ctx.map.locateEnemyCityWithTroops(ctx.unit, ctx.obs) !== null;
  });

  m.set('enemy_shipping_exists', (ctx) => {
    return ctx.map.huntForEnemyShipping(ctx.unit, ctx.obs) !== null;
  });

  // ── Bomber conditions ───────────────────────────────────────

  m.set('bomber_city_target_available', (ctx) => {
    return ctx.map.findBomberTarget(ctx.unit, ctx.obs) !== null;
  });

  m.set('enemy_transport_with_cargo_in_fuel_range', (ctx) => {
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    return ctx.map.findEnemyTransportWithCargo(ctx.unit, ctx.obs, maxFuel) !== null;
  });

  m.set('high_value_enemy_cluster', (ctx) => {
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    return ctx.map.findHighValueEnemyCluster(ctx.unit, ctx.obs, maxFuel, 30) !== null;
  });

  return m;
}

// ── Action resolvers ─────────────────────────────────────────────────────────

type ActionResolver = (ctx: MovementContext) => AgentAction | null;

function buildActionResolvers(): Map<string, ActionResolver> {
  const a = new Map<string, ActionResolver>();

  // ── Wait ────────────────────────────────────────────────────

  a.set('wait', (ctx) => {
    return { type: 'SKIP', unitId: ctx.unit.id };
  });

  // ── Army movement ───────────────────────────────────────────

  a.set('move_to_nearest_neutral_city_on_island', (ctx) => {
    const city = ctx.map.locateNearestNeutralCityOnIsland(ctx.unit, ctx.obs);
    if (!city) return null;
    const step = ctx.map.bestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('move_to_nearest_enemy_city_on_island', (ctx) => {
    const city = ctx.map.locateNearestEnemyCityOnIsland(ctx.unit, ctx.obs);
    if (!city) return null;
    const step = ctx.map.bestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('move_to_nearest_unexplored_land_on_island', (ctx) => {
    const idx = ctx.map.getIslandIdx(ctx.unit.x, ctx.unit.y, ctx.obs);
    if (idx === undefined) return null;
    const target = ctx.map.locateNearestUnexploredLandOnIsland(ctx.unit, idx, ctx.obs);
    if (!target) return null;
    const step = ctx.map.bestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('move_to_transport_and_board', (ctx) => {
    // If adjacent to a transport, load immediately
    const adj = ctx.map.findAdjacentTransportWithRoom(ctx.unit, ctx.obs);
    if (adj) return { type: 'LOAD', unitId: ctx.unit.id, transportId: adj.id };
    // Otherwise move toward the nearest transport on this island
    const transport = ctx.map.findTransportOnIsland(ctx.unit, ctx.obs);
    if (!transport) return null;
    // Find a land tile adjacent to the transport to walk toward
    const landTiles = ctx.map.getAdjacentLandTiles(ctx.obs, transport.x, transport.y);
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (const lt of landTiles) {
      const d = ctx.map.wrappedDist(ctx.unit, lt);
      if (d < bestDist) { bestDist = d; best = lt; }
    }
    if (best) {
      const step = ctx.map.bestStepToward(ctx.obs, ctx.unit, best);
      if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
    }
    return null;
  });

  a.set('move_to_nearest_coastal_city', (ctx) => {
    const target = ctx.map.locateNearestFriendlyCoastalCity(ctx.unit, ctx.obs);
    if (!target) return null;
    const step = ctx.map.bestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('disembark', (ctx) => {
    if (ctx.unit.carriedBy === null) return null;
    const transport = ctx.obs.myUnits.find((u) => u.id === ctx.unit.carriedBy);
    if (!transport) return null;
    const target = ctx.map.canDisembark(transport, ctx.obs);
    if (!target) return null;
    return { type: 'MOVE', unitId: ctx.unit.id, to: target };
  });

  // ── Transport movement ──────────────────────────────────────

  a.set('continue_toward_target', (ctx) => {
    if (!ctx.transportTarget) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, ctx.transportTarget);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('move_to_adjacent_ocean', (ctx) => {
    const ocean = ctx.map.getAdjacentOceanTile(ctx.obs, ctx.unit.x, ctx.unit.y);
    if (!ocean) return null;
    const step = ctx.map.bestStepToward(ctx.obs, ctx.unit, ocean);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('park_at_nearest_friendly_coastal', (ctx) => {
    const target = ctx.map.locateNearestFriendlyCoastalCity(ctx.unit, ctx.obs);
    if (!target) return null;
    const coastalOcean = ctx.map.getAdjacentCoastalOcean(ctx.obs, target.x, target.y);
    if (coastalOcean.length === 0) return null;
    // Pick nearest coastal ocean tile
    let best = coastalOcean[0];
    let bestDist = ctx.map.wrappedDist(ctx.unit, best);
    for (const c of coastalOcean) {
      const d = ctx.map.wrappedDist(ctx.unit, c);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, best);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('sail_to_nearest_unexplored_island', (ctx) => {
    const target = ctx.map.locateNearestUnexploredIsland(ctx.unit, ctx.obs);
    if (!target) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('sail_to_nearest_contested_island', (ctx) => {
    const target = ctx.map.locateNearestContestedIsland(ctx.unit, ctx.obs);
    if (!target) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('sail_to_unexplored_ocean', (ctx) => {
    const target = ctx.map.locateNearestUnexploredOcean(ctx.unit, ctx.obs);
    if (target) {
      const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
      if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
    }
    // Fallback: move to any adjacent ocean tile
    for (const adj of ctx.map.getAdjacentTiles(ctx.unit.x, ctx.unit.y)) {
      if (adj.y <= 0 || adj.y >= ctx.mapHeight - 1) continue;
      const t = ctx.obs.tiles[adj.y]?.[adj.x];
      if (t && t.terrain === Terrain.Ocean) {
        return { type: 'MOVE', unitId: ctx.unit.id, to: adj };
      }
    }
    return { type: 'SKIP', unitId: ctx.unit.id };
  });

  a.set('sail_to_friendly_island_most_armies', (ctx) => {
    const targetIdx = ctx.map.friendlyIslandWithMostArmies(ctx.obs);
    if (targetIdx === null) return null;
    const { islandOf } = ctx.map.classifyIslands(ctx.obs);
    // Find nearest coastal ocean tile adjacent to that island
    const h = ctx.obs.tiles.length;
    const w = ctx.obs.tiles[0]?.length ?? 0;
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = ctx.obs.tiles[y]?.[x];
        if (!tile || tile.terrain !== Terrain.Ocean) continue;
        for (const adj of ctx.map.getAdjacentTiles(x, y)) {
          if (islandOf.get(`${adj.x},${adj.y}`) === targetIdx) {
            const dist = ctx.map.wrappedDist({ x, y }, ctx.unit);
            if (dist < bestDist) { bestDist = dist; best = { x, y }; }
            break;
          }
        }
      }
    }
    if (!best) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, best);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  // ── Attack actions ──────────────────────────────────────────

  a.set('attack_nearest_enemy_ship', (ctx) => {
    const target = ctx.map.huntForEnemyShipping(ctx.unit, ctx.obs, ctx.unit.movesLeft);
    if (!target) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('hunt_for_enemy_shipping', (ctx) => {
    const target = ctx.map.huntForEnemyShipping(ctx.unit, ctx.obs);
    if (!target) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('attack_nearest_enemy', (ctx) => {
    // Fighter: prioritize loaded transports, then subs
    if (ctx.unit.type === UnitType.Fighter) {
      const transport = ctx.map.findEnemyTransportWithCargo(ctx.unit, ctx.obs, ctx.unit.movesLeft);
      if (transport) {
        const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, transport);
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
      const sub = ctx.map.findEnemyInRange(ctx.unit, ctx.obs, [UnitType.Submarine]);
      if (sub) {
        const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, sub);
        if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
      }
    }
    return null;
  });

  a.set('attack_enemy_city_with_defenders', (ctx) => {
    const city = ctx.map.findEnemyCityWithDefenders(ctx.unit, ctx.obs, ctx.unit.movesLeft);
    if (!city) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('bombard_enemy_city_with_troops', (ctx) => {
    const city = ctx.map.locateEnemyCityWithTroops(ctx.unit, ctx.obs, ctx.unit.movesLeft);
    if (!city) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('move_to_enemy_city_with_defenders', (ctx) => {
    const city = ctx.map.findEnemyCityWithDefenders(ctx.unit, ctx.obs);
    if (!city) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('move_to_enemy_city_with_troops', (ctx) => {
    const city = ctx.map.locateEnemyCityWithTroops(ctx.unit, ctx.obs);
    if (!city) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  // ── Fighter ─────────────────────────────────────────────────

  a.set('move_to_city_under_attack', (ctx) => {
    const city = ctx.map.findCityUnderAttack(ctx.obs, 3);
    if (!city) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  // ── Bomber ──────────────────────────────────────────────────

  a.set('bomb_city', (ctx) => {
    const city = ctx.map.findBomberTarget(ctx.unit, ctx.obs);
    if (!city) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, city);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('bomb_transport', (ctx) => {
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    const target = ctx.map.findEnemyTransportWithCargo(ctx.unit, ctx.obs, maxFuel);
    if (!target) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('bomb_area', (ctx) => {
    const maxFuel = UNIT_STATS[ctx.unit.type].maxFuel ?? 100;
    const target = ctx.map.findHighValueEnemyCluster(ctx.unit, ctx.obs, maxFuel, 30);
    if (!target) return null;
    const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
    return step ? { type: 'MOVE', unitId: ctx.unit.id, to: step } : null;
  });

  a.set('move_to_conflict_zone', (ctx) => {
    const target = ctx.map.findConflictZoneCity(ctx.unit, ctx.obs, 15);
    if (target) {
      if (target.x === ctx.unit.x && target.y === ctx.unit.y) {
        return { type: 'SKIP', unitId: ctx.unit.id };
      }
      const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
      if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
    }
    // Fallback: return to nearest friendly city
    const home = ctx.map.locateNearestFriendlyCity(ctx.unit, ctx.obs);
    if (home) {
      const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, home);
      if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
    }
    return { type: 'SKIP', unitId: ctx.unit.id };
  });

  // ── Generic movement ────────────────────────────────────────

  a.set('move_to_nearest_unexplored_ocean', (ctx) => {
    const target = ctx.map.locateNearestUnexploredOcean(ctx.unit, ctx.obs);
    if (target) {
      const step = ctx.map.farthestStepToward(ctx.obs, ctx.unit, target);
      if (step) return { type: 'MOVE', unitId: ctx.unit.id, to: step };
    }
    return { type: 'SKIP', unitId: ctx.unit.id };
  });

  return a;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class MovementRulesEngine {
  private readonly rules: MovementRulesSchema;
  private readonly conditionEvaluators: Map<string, ConditionEvaluator>;
  private readonly actionResolvers: Map<string, ActionResolver>;
  private readonly mapWidth: number;
  private readonly mapHeight: number;

  constructor(rules: MovementRulesSchema, mapWidth: number, mapHeight: number) {
    this.rules = rules;
    this.conditionEvaluators = buildConditionEvaluators();
    this.actionResolvers = buildActionResolvers();
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /**
   * Evaluate rules top-to-bottom for the unit's type and current phase.
   * First rule whose conditions all pass wins. Returns the resolved action.
   */
  chooseMove(ctx: MovementContext): AgentAction | null {
    const unitType = ctx.unit.type;
    const phaseName = PHASE_NAMES[ctx.phase];

    const phaseRules = this.rules.movement[unitType]?.[phaseName];
    if (!phaseRules || phaseRules.length === 0) return null;

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
        const resolver = this.actionResolvers.get(rule.action);
        if (!resolver) {
          console.warn(`[MovementRulesEngine] Unknown action: "${rule.action}"`);
          return null;
        }
        const result = resolver(ctx);
        if (result) return result;
        // If resolver returns null, continue to next rule
      }
    }

    return null;
  }
}
