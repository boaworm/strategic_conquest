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
  wrapX,
} from '@sc/shared';
import {
  ProductionRulesEngine,
  type ProductionRulesSchema,
} from './basicAgent_productionRulesEngine.js';
import { MovementRulesEngine } from './basicAgent_movementRulesEngine.js';
import { MapQuery } from './basicAgent_mapQuery.js';
import MOVEMENT_RULES from './basicAgent_movement_rules.json' with { type: 'json' };
import PRODUCTION_RULES_RAW from './basicAgent_production_rules.json' with { type: 'json' };

const PRODUCTION_RULES: ProductionRulesSchema = {
  production: PRODUCTION_RULES_RAW.production,
};

/**
 * Strategy (in priority order):
 *  1. Claim any visible undefended city (neutral or enemy-owned without visible defenders).
 *  2. Explore unexplored land areas on the current island.
 *  3. Board transports to reach other islands and claim their cities.
 *  4. Only when no free cities remain: fight for defended enemy cities using
 *     missiles/fighters/battleships to weaken defenders, then armies to capture.
 */
export class BasicAgent implements Agent {
  private playerId!: string;
  private mapWidth!: number;
  private mapHeight!: number;

  // Current strategic phase
  private phase: 1 | 2 | 3 = 1;

  // Current transport target (persistent across turns)
  private transportTarget: Coord | null = null;

  private readonly productionEngine = new ProductionRulesEngine(PRODUCTION_RULES);
  private movementEngine!: MovementRulesEngine;
  private mapQuery!: MapQuery;

  // Starting island index - set once on init
  private startingIslandIdx: number | undefined = undefined;

  // Patrol tracking per fighter (keyed by unit ID)
  private readonly fighterPatrolState = new Map<string, {
    waypoint: Coord | null;
    lastVisitTurn: number;
    routeIndex: number;
    lastDir: Coord | null;
  }>();

  // Direction tracking per transport (keyed by unit ID)
  private readonly transportState = new Map<string, {
    target: Coord | null;
    lastDir: Coord | null;
  }>();

  init(config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    this.transportTarget = null;
    this.phase = 1;
    this.startingIslandIdx = undefined;
    this.fighterPatrolState.clear();
    this.movementEngine = new MovementRulesEngine(MOVEMENT_RULES, config.mapWidth, config.mapHeight);
    this.mapQuery = new MapQuery(config.mapWidth, config.mapHeight);
  }

  /**
   * Determine current strategic phase.
   * Phase 3: Enemy contact → stay in combat
   * Phase 2: Starting island fully explored + captured → explore other islands
   * Phase 1: Default → expand starting island
   */
  private computePhase(obs: AgentObservation): 1 | 2 | 3 {
    // Phase 3: Already in combat or enemy contact
    if (this.phase === 3) return 3;

    const { islandOf, exploredIslands } = this.mapQuery.classifyIslands(obs);

    // Set starting island on first turn
    if (this.startingIslandIdx === undefined && obs.myCities.length > 0) {
      const cityIdx = islandOf.get(`${obs.myCities[0].x},${obs.myCities[0].y}`);
      if (cityIdx !== undefined) {
        this.startingIslandIdx = cityIdx;
      }
    }

    // Enemy contact → phase 3
    if (obs.visibleEnemyCities.some((c) => c.owner !== null) || obs.visibleEnemyUnits.length > 0) {
      this.phase = 3;
      return 3;
    }

    // Starting island fully explored + captured → phase 2
    if (this.phase === 1 && this.startingIslandIdx !== undefined) {
      if (this.isIslandFullyExplored(this.startingIslandIdx, exploredIslands) &&
          this.isIslandFullyCaptured(this.startingIslandIdx, islandOf, obs)) {
        this.phase = 2;
      }
    }

    return this.phase;
  }

  getPhase(): 1 | 2 | 3 {
    return this.phase;
  }

  /** Check if an island is fully explored (all land tiles seen). */
  private isIslandFullyExplored(
    islandIdx: number,
    exploredIslands: Set<number>,
  ): boolean {
    return exploredIslands.has(islandIdx);
  }

  /** Check if an island has no neutral cities (all captured or enemy-owned). */
  private isIslandFullyCaptured(
    islandIdx: number,
    islandOf: Map<string, number>,
    obs: AgentObservation,
  ): boolean {
    for (const city of obs.visibleEnemyCities) {
      if (city.owner === null) {
        const idx = islandOf.get(`${city.x},${city.y}`);
        if (idx === islandIdx) return false;
      }
    }
    return true;
  }

  act(obs: AgentObservation): AgentAction {
    this.computePhase(obs);

    // Two-pass unit evaluation:
    //   Pass 1: Land armies (to BOARD transports), then sea, then air
    //   Pass 2: Carried armies (to DISEMBARK after transports have moved)
    const pass1Order = (u: UnitView) => {
      if (u.type === UnitType.Army && u.carriedBy === null) return 0; // free armies board first
      if (UNIT_STATS[u.type].domain === UnitDomain.Sea) return 1;    // sea (incl. transports)
      if (UNIT_STATS[u.type].domain === UnitDomain.Air) return 2;    // air
      return 3;                                                       // other land (shouldn't exist)
    };
    const pass2Order = (u: UnitView) => {
      if (u.type === UnitType.Army && u.carriedBy !== null) return 0; // carried armies disembark
      return 1;                                                       // skip everything else
    };

    // Pass 1: free armies → sea → air
    const pass1 = [...obs.myUnits].sort((a, b) => pass1Order(a) - pass1Order(b));
    for (const unit of pass1) {
      if (unit.carriedBy !== null) continue; // skip carried units in pass 1
      if (unit.sleeping) {
        if (unit.movesLeft > 0) return { type: 'WAKE', unitId: unit.id };
        continue;
      }
      if (unit.movesLeft <= 0) continue;
      if (unit.hasAttacked) continue;

      const action = this.evaluateUnit(unit, obs);
      if (action) return action;

      return { type: 'SKIP', unitId: unit.id };
    }

    // Pass 2: carried armies (disembark after transports moved)
    const pass2 = [...obs.myUnits].sort((a, b) => pass2Order(a) - pass2Order(b));
    for (const unit of pass2) {
      if (unit.carriedBy === null) continue; // only carried units
      if (unit.type !== UnitType.Army) continue;
      if (unit.movesLeft <= 0) continue;

      const action = this.evaluateUnit(unit, obs);
      if (action) return action;

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

  private evaluateUnit(unit: UnitView, obs: AgentObservation): AgentAction | null {
    // Clear transport target when empty — prevents stale targets from trapping
    // the transport in continue_toward_target after a dropoff.
    if (unit.type === UnitType.Transport && unit.cargo.length === 0) {
      this.transportTarget = null;
    }

    const action = this.movementEngine.chooseMove({
      phase: this.phase,
      unit,
      obs,
      map: this.mapQuery,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
      transportTarget: this.transportTarget,
      patrolState: this.fighterPatrolState,
      transportState: this.transportState,
    });
    if (action) {
      if (unit.type === UnitType.Transport && action.type === 'MOVE') {
        this.transportTarget = action.to;
      } else if (unit.type === UnitType.Transport && action.type === 'SKIP') {
        this.transportTarget = null;
      }
      return action;
    }
    return null;
  }

  private chooseProduction(obs: AgentObservation, city: CityView): UnitType {
    return this.productionEngine.chooseProduction({
      phase: this.phase,
      city,
      obs,
      helpers: {
        enemyCityReachableByLand: (o, c) =>
          this.enemyCityWithinLandDist(o, c, this.mapWidth * this.mapHeight),
        classifyIslands: (o) => this.mapQuery.classifyIslands(o),
      },
    });
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
}
