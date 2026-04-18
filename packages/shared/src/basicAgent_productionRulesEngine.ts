import { UnitType, UNIT_STATS } from './types.js';
import type { CityView, Coord } from './types.js';
import type { AgentObservation } from './agent.js';

// ── JSON schema types (mirrors production_rules.json) ────────────────────────

export interface ProductionRule {
  conditions?: string[];
  produce: string;
  /** Per-unit scaling factors used by lowest_score() */
  scaling_factors?: Record<string, number>;
  note?: string;
}

export interface ProductionRulesSchema {
  production: {
    Explore: ProductionRule[];
    Expand: ProductionRule[];
    Combat: ProductionRule[];
  };
}

// ── Context passed to the engine on each query ───────────────────────────────

export interface ProductionHelpers {
  /** True if any visible enemy-owned city is reachable from this city over land only */
  enemyCityReachableByLand(obs: AgentObservation, city: Coord): boolean;
  /** BFS island classification */
  classifyIslands(obs: AgentObservation): {
    islandOf: Map<string, number>;
    friendlyIndices: Set<number>;
  };
}

export interface ProductionContext {
  phase: 1 | 2 | 3;
  city: CityView;
  obs: AgentObservation;
  helpers: ProductionHelpers;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const PHASE_NAMES: Record<1 | 2 | 3, keyof ProductionRulesSchema['production']> = {
  1: 'Explore',
  2: 'Expand',
  3: 'Combat',
};

const UNIT_NAME_MAP: Record<string, UnitType> = {
  Army:       UnitType.Army,
  Transport:  UnitType.Transport,
  Destroyer:  UnitType.Destroyer,
  Submarine:  UnitType.Submarine,
  Battleship: UnitType.Battleship,
  Carrier:    UnitType.Carrier,
  Fighter:    UnitType.Fighter,
  Missile:    UnitType.Missile,
};

/** alive + currently-building count for a unit type */
function unitCount(type: UnitType, obs: AgentObservation): number {
  return (
    obs.myUnits.filter((u) => u.type === type).length +
    obs.myCities.filter((c) => c.producing === type).length
  );
}

/** balance(A, B) — pick whichever has fewer; random tiebreak */
function resolveBalance(args: string[], obs: AgentObservation): UnitType {
  const [a, b] = args.map((n) => UNIT_NAME_MAP[n.trim()]);
  const ca = unitCount(a, obs);
  const cb = unitCount(b, obs);
  if (ca !== cb) return ca < cb ? a : b;
  return Math.random() < 0.5 ? a : b;
}

/** lowest_score(A, B, …) — score = (alive+inProd)*buildTime/scale; pick min */
function resolveLowestScore(
  args: string[],
  scalingFactors: Record<string, number>,
  obs: AgentObservation,
): UnitType {
  let bestType = UNIT_NAME_MAP[args[0].trim()];
  let bestScore = Infinity;
  for (const raw of args) {
    const name = raw.trim();
    const type = UNIT_NAME_MAP[name];
    if (!type) continue;
    const scale = scalingFactors[name] ?? 1;
    const score = (unitCount(type, obs) * UNIT_STATS[type].buildTime) / scale;
    if (score < bestScore) {
      bestScore = score;
      bestType = type;
    }
  }
  return bestType;
}

/** Resolve the produce field of a rule to a concrete UnitType */
function resolveProduce(rule: ProductionRule, obs: AgentObservation): UnitType {
  const produce = rule.produce.trim();

  // Plain unit name
  if (Object.prototype.hasOwnProperty.call(UNIT_NAME_MAP, produce)) {
    return UNIT_NAME_MAP[produce];
  }

  // Function-call syntax: name(arg, arg, ...)
  const m = produce.match(/^(\w+)\((.+)\)$/);
  if (m) {
    const [, fnName, argsStr] = m;
    const args = argsStr.split(',');
    if (fnName === 'balance') return resolveBalance(args, obs);
    if (fnName === 'lowest_score') {
      return resolveLowestScore(args, rule.scaling_factors ?? {}, obs);
    }
  }

  console.warn(`[ProductionRulesEngine] Unknown produce expression: "${produce}"`);
  return UnitType.Army;
}

// ── Condition evaluators (keyed by the exact condition string in the JSON) ───

type ConditionEvaluator = (ctx: ProductionContext) => boolean;

function buildConditionEvaluators(): Map<string, ConditionEvaluator> {
  const map = new Map<string, ConditionEvaluator>();

  map.set('City has access to water', (ctx) => ctx.city.coastal);

  map.set('City has no access to water', (ctx) => !ctx.city.coastal);

  map.set('Enemy city is reachable by land from this city', (ctx) =>
    ctx.helpers.enemyCityReachableByLand(ctx.obs, ctx.city),
  );

  // active_transports < max(1, ceil(army_producing_cities_on_this_island / 3))
  map.set(
    'active_transports < max(1, ceil(army_producing_cities_on_this_island / 3))',
    (ctx) => {
      const { islandOf, friendlyIndices } = ctx.helpers.classifyIslands(ctx.obs);
      // Count army-producing cities on ALL friendly islands (not just this island)
      const armyCitiesTotal = ctx.obs.myCities.filter(
        (c) =>
          c.id !== ctx.city.id &&
          c.producing === UnitType.Army &&
          friendlyIndices.has(islandOf.get(`${c.x},${c.y}`) ?? -1)
      ).length;
      const activeTransports = ctx.obs.myUnits.filter(
        (u) => u.type === UnitType.Transport,
      ).length;
      const target = Math.max(1, Math.ceil(armyCitiesTotal / 3));
      return activeTransports < target;
    },
  );

  // active_transports < 1 (simple check for no transports)
  map.set(
    'active_transports < 1',
    (ctx) => {
      const activeTransports = ctx.obs.myUnits.filter(
        (u) => u.type === UnitType.Transport,
      ).length;
      return activeTransports < 1;
    },
  );

  return map;
}

// ── Engine ───────────────────────────────────────────────────────────────────

export class ProductionRulesEngine {
  private readonly rules: ProductionRulesSchema;
  private readonly conditionEvaluators: Map<string, ConditionEvaluator>;

  constructor(rules: ProductionRulesSchema) {
    this.rules = rules;
    this.conditionEvaluators = buildConditionEvaluators();
  }

  /**
   * Evaluate the rules for the given context and return the unit type to build.
   * Rules are evaluated top-to-bottom within the current phase; the first rule
   * whose conditions all pass wins.  A rule with no conditions always matches.
   */
  chooseProduction(ctx: ProductionContext): UnitType {
    const phaseName = PHASE_NAMES[ctx.phase];
    const phaseRules = this.rules.production[phaseName];

    for (const rule of phaseRules) {
      const conditions = rule.conditions ?? [];
      const allMet = conditions.every((cond) => {
        const evaluator = this.conditionEvaluators.get(cond);
        if (!evaluator) {
          console.warn(`[ProductionRulesEngine] Unknown condition: "${cond}"`);
          return false;
        }
        return evaluator(ctx);
      });

      if (allMet) return resolveProduce(rule, ctx.obs);
    }

    // Fallback (should be unreachable if rules always end with an unconditional rule)
    return UnitType.Army;
  }
}
