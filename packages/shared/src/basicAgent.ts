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
} from './productionRulesEngine.js';

// Mirrors production_rules.json — the JSON file is the human-readable spec.
const PRODUCTION_RULES: ProductionRulesSchema = {
  production: {
    Explore: [
      { conditions: [], produce: 'Army' },
    ],
    Expand: [
      {
        conditions: [
          'City has access to water',
          'active_transports < max(1, ceil(army_producing_cities_on_this_island / 3))',
        ],
        produce: 'Transport',
      },
      { produce: 'Army' },
    ],
    Combat: [
      {
        conditions: ['Enemy city is reachable by land from this city'],
        produce: 'Army',
      },
      {
        conditions: ['City has no access to water'],
        produce: 'balance(Fighter, Bomber)',
      },
      {
        conditions: ['City has access to water'],
        produce: 'lowest_score(Transport, Battleship, Submarine, Destroyer, Fighter, Bomber)',
        scaling_factors: {
          Transport:  1,
          Battleship: 2,
          Submarine:  2,
          Destroyer:  1,
          Fighter:    1,
          Bomber:     1,
        },
      },
    ],
  },
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

  // Current strategic phase (recomputed each act() call).
  private phase: 1 | 2 | 3 = 1;
  // Turn numbers when phases first advanced (undefined = not yet reached).
  private phase2Turn: number | undefined = undefined;
  private phase3Turn: number | undefined = undefined;

  // Patrol direction for destroyers (persistent across turns)
  private destroyerPatrolDir: { x: number; y: number } | null = null;

  private readonly productionEngine = new ProductionRulesEngine(PRODUCTION_RULES);

  init(config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    // Reset patrol direction on new game
    this.destroyerPatrolDir = null;
  }

  /**
   * Determine current strategic phase from observable signals:
   *  1 — Explore: Fully explore starting island and take all cities
   *  2 — Expand: Build transports and move armies to other islands
   *  3 — Combat: Encountered enemy, prioritize combat
   *
   * Phase transitions are one-way: 1 → 2 → 3, never back.
   */
  private homeIslandIdx!: number;

  private computePhase(obs: AgentObservation): 1 | 2 | 3 {
    // If already in combat, stay in phase 3
    if (this.phase === 3) return 3;

    // Check for enemy contact
    const { islandOf, mineIndices, exploredIslands } = this.classifyIslands(obs);
    const homeRef = obs.myCities[0] ?? { x: 0, y: 1 };
    const hasEnemyContact = obs.visibleEnemyCities.some((c) => c.owner !== null) ||
                             obs.visibleEnemyUnits.some((u) => u.type === UnitType.Army && this.wrappedDist(u, homeRef) <= 2);

    // Phase transitions
    if (this.phase === 2 && hasEnemyContact) return 3; // Phase 2 → 3
    if (this.phase === 1) {
      if (this.homeIslandIdx !== undefined && mineIndices.has(this.homeIslandIdx) && this.isIslandExplored(this.homeIslandIdx, exploredIslands)) {
        // Home island is fully explored and ours - ready to expand
        return 2;
      }
    }

    return 1;
  }

  getPhaseTransitions(): { phase2Turn: number | undefined; phase3Turn: number | undefined } {
    return { phase2Turn: this.phase2Turn, phase3Turn: this.phase3Turn };
  }

  act(obs: AgentObservation): AgentAction {
    const newPhase = this.computePhase(obs);
    if (newPhase > this.phase) {
      if (newPhase === 2) this.phase2Turn = obs.turn;
      if (newPhase === 3) this.phase3Turn = obs.turn;
    }
    this.phase = newPhase;

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
      if (unit.carriedBy !== null) continue;

      if (unit.sleeping) {
        if (unit.movesLeft > 0) return { type: 'WAKE', unitId: unit.id };
        continue;
      }

      if (unit.movesLeft <= 0) continue;
      if (unit.hasAttacked) continue; // can't attack again; done for this turn

      const action = this.determineMoveForUnit(obs, unit);
      if (action) return action;

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

  // ── Helper Methods for Rule Evaluation ──────────────────────────────────────

  /**
   * Check if current phase matches the given phase.
   */
  private isPhase(phase: 1 | 2 | 3): boolean {
    return this.phase === phase;
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
  private canReachCity(city: CityView, unit: UnitView, obs: AgentObservation): boolean {
    const move = this.moveToward(obs, unit, city);
    return move !== null;
  }

  /**
   * Check if any neutral city is reachable from unit.
   */
  private canReachNeutralCity(unit: UnitView, obs: AgentObservation): boolean {
    const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
    for (const city of neutralCities) {
      if (this.canReachCity(city, unit, obs)) return true;
    }
    return false;
  }

  /**
   * Get nearest neutral city that is reachable.
   */
  private getNearestReachableNeutralCity(unit: UnitView, obs: AgentObservation): CityView | null {
    const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
    let nearest: CityView | null = null;
    let nearestDist = Infinity;

    for (const city of neutralCities) {
      const dist = this.wrappedDist(city, unit);
      if (dist < nearestDist && this.canReachCity(city, unit, obs)) {
        nearestDist = dist;
        nearest = city;
      }
    }
    return nearest;
  }

  /**
   * Check if unit is adjacent to a friendly transport with room.
   */
  private isAdjacentToTransportWithRoom(unit: UnitView, obs: AgentObservation): UnitView | null {
    const adjTiles = this.getAdjacentTiles(unit.x, unit.y);
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
   * Check if transport can disembark to unexplored or contested land.
   */
  private canDisembarkToUnexploredOrContested(transport: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>, exploredIslands: Set<number>): Coord | null {
    const adjacentLand = this.getAdjacentLandTiles(obs, transport.x, transport.y);
    for (const land of adjacentLand) {
      const landIdx = islandOf.get(`${land.x},${land.y}`);
      const notExplored = !this.isIslandExplored(landIdx, exploredIslands);
      const notFriendly = !this.isIslandFriendly(landIdx, mineIndices);

      if (notExplored || notFriendly) {
        return land;
      }
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
  ): UnitView | null {
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    const myIslandIdx = islandOf.get(`${unit.x},${unit.y}`);
    if (myIslandIdx === undefined || !mineIndices.has(myIslandIdx)) {
      return null; // Not on a friendly island
    }

    // Find transports that are:
    // 1. On friendly island
    // 2. On ocean tile (offshore)
    // 3. Has room for cargo
    // 4. Not currently sailing with armies
    for (const transport of obs.myUnits) {
      if (transport.type !== UnitType.Transport) continue;
      if (transport.id === unit.id) continue; // Skip self
      if (transport.cargo.length >= cap) continue; // Full

      const transportIslandIdx = islandOf.get(`${transport.x},${transport.y}`);
      if (transportIslandIdx === undefined || !mineIndices.has(transportIslandIdx)) {
        continue; // Not on friendly island
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
   * Get nearest reachable enemy city on a contested island.
   */
  private getNearestReachableEnemyCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>): CityView | null {
    const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
    let nearest: CityView | null = null;
    let nearestDist = Infinity;

    for (const city of enemyCities) {
      const cityIsland = islandOf.get(`${city.x},${city.y}`);
      // Only target enemy cities on contested islands
      if (this.isIslandContested(cityIsland, obs, islandOf)) {
        const dist = this.wrappedDist(city, unit);
        if (dist < nearestDist && this.canReachCity(city, unit, obs)) {
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
  private getNearestReachableUnexplored(unit: UnitView, obs: AgentObservation): Coord | null {
    const unexplored = this.nearestUnexploredTile(obs, unit);
    // nearestUnexploredTile already checks reachability via bestStepToward
    return unexplored;
  }

  /**
   * Get nearest coastal city on friendly island.
   */
  private getNearestFriendlyCoastalCity(unit: UnitView, obs: AgentObservation, islandOf: Map<string, number>, mineIndices: Set<number>): Coord | null {
    const coastalCities = this.getCoastalCities(obs, mineIndices, islandOf);
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
   * Determine the move for a unit based on its type.
   * Each unit type has its own movement function.
   * Combat only happens when specified in rules.json conditions.
   */
  private determineMoveForUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const { islandOf, mineIndices, exploredIslands } = this.classifyIslands(obs);

    if (unit.type === UnitType.Army) {
      return this.determineMoveForArmy(obs, unit, mineIndices, exploredIslands, islandOf);
    }
    if (unit.type === UnitType.Transport) {
      return this.determineMoveForTransport(obs, unit, mineIndices, exploredIslands, islandOf);
    }
    if (unit.type === UnitType.Destroyer) {
      return this.determineMoveForDestroyer(obs, unit);
    }
    if (unit.type === UnitType.Battleship) {
      return this.determineMoveForBattleship(obs, unit, mineIndices, exploredIslands, islandOf);
    }
    if (unit.type === UnitType.Carrier) {
      return this.determineMoveForCarrier(obs, unit);
    }
    if (unit.type === UnitType.Submarine) {
      return this.determineMoveForSubmarine(obs, unit);
    }
    if (unit.type === UnitType.Bomber) {
      return this.determineMoveForBomber(obs, unit, obs.myBomberBlastRadius);
    }
    if (unit.type === UnitType.Fighter) {
      return this.determineMoveForFighter(obs, unit, mineIndices, islandOf);
    }

    return null;
  }

  // ── Unit-Specific Movement Functions ────────────────────────────────────────

  /**
   * Determine the move for an Army unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForArmy(
    obs: AgentObservation,
    unit: UnitView,
    mineIndices: Set<number>,
    exploredIslands: Set<number>,
    islandOf: Map<string, number>,
  ): AgentAction | null {
    const myIslandIdx = islandOf.get(`${unit.x},${unit.y}`);

    // Rule 1: Can reach neutral city on current island -> Move to nearest neutral city and take it
    if (this.canReachNeutralCity(unit, obs)) {
      const nearestNeutral = this.getNearestReachableNeutralCity(unit, obs);
      if (nearestNeutral) {
        const move = this.moveToward(obs, unit, nearestNeutral);
        if (move) return move;
      }
    }

    // Rule 2: Island is contested -> Move toward enemy city and take it
    if (this.isIslandContested(myIslandIdx, obs, islandOf)) {
      const nearestEnemyCity = this.getNearestReachableEnemyCity(unit, obs, islandOf, mineIndices);
      if (nearestEnemyCity) {
        const move = this.moveToward(obs, unit, nearestEnemyCity);
        if (move) return move;
      }
    }

    // Rule 3: Island not fully explored -> Move toward unexplored area
    if (!this.isIslandExplored(myIslandIdx, exploredIslands)) {
      const unexplored = this.getNearestReachableUnexplored(unit, obs);
      if (unexplored) {
        const step = this.bestStepToward(obs, unit, unexplored);
        if (step) return { type: 'MOVE', unitId: unit.id, to: step };
      }
    }

    // Rule 4: Island is friendly AND transport offshore waiting -> Move toward transport
    if (this.isIslandFriendly(myIslandIdx, mineIndices)) {
      const waitingTransport = this.findWaitingTransport(unit, obs, islandOf, mineIndices);
      if (waitingTransport) {
        const move = this.moveToward(obs, unit, waitingTransport);
        if (move) return move;
      }
    }

    // Rule 5: Adjacent to friendly transport with room AND island is friendly -> Board transport
    const adjacentTransport = this.isAdjacentToTransportWithRoom(unit, obs);
    if (adjacentTransport && this.isIslandFriendly(myIslandIdx, mineIndices)) {
      return { type: 'LOAD', unitId: unit.id, transportId: adjacentTransport.id };
    }

    // Rule 5: Island is friendly and explored -> Move to coastal city and wait
    if (this.isIslandFriendly(myIslandIdx, mineIndices) && this.isIslandExplored(myIslandIdx, exploredIslands)) {
      const nearestCoastal = this.getNearestFriendlyCoastalCity(unit, obs, islandOf, mineIndices);
      if (nearestCoastal) {
        const move = this.moveToward(obs, unit, nearestCoastal);
        if (move) return move;
      }
      // If already at coastal city, wait (SKIP)
      const atCoastal = obs.myCities.some(
        (c) => c.x === unit.x && c.y === unit.y &&
          this.getAdjacentOceanTiles(obs, c.x, c.y) !== null
      );
      if (atCoastal) {
        return { type: 'SKIP', unitId: unit.id };
      }
    }

    // Rule 6: Onboard transport AND can disembark to unexplored or contested island -> Disembark
    if (this.isOnboardTransport(unit)) {
      const transport = obs.myUnits.find((u) => u.id === unit.carriedBy);
      if (transport) {
        const disembarkTarget = this.canDisembarkToUnexploredOrContested(transport, obs, islandOf, mineIndices, exploredIslands);
        if (disembarkTarget) {
          return { type: 'UNLOAD', unitId: unit.id, to: disembarkTarget };
        }
      }
    }

    return null;
  }

  /**
   * Determine the move for a Transport unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForTransport(
    obs: AgentObservation,
    unit: UnitView,
    mineIndices: Set<number>,
    exploredIslands: Set<number>,
    islandOf: Map<string, number>,
  ): AgentAction | null {
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    const myIslandIdx = islandOf.get(`${unit.x},${unit.y}`);
    const onFriendlyIsland = this.isIslandFriendly(myIslandIdx, mineIndices);

    // Rule 1: No units onboard AND Not at friendly island AND Adjacent to friendly island -> Return to friendly island
    if (unit.cargo.length === 0 && !onFriendlyIsland) {
      // Check if adjacent to friendly island
      const adjTiles = this.getAdjacentTiles(unit.x, unit.y);
      for (const tile of adjTiles) {
        const adjIsland = islandOf.get(`${tile.x},${tile.y}`);
        if (adjIsland !== undefined && mineIndices.has(adjIsland)) {
          // Found adjacent friendly island - return to it
          const friendlyCoastal = this.getCoastalCities(obs, mineIndices, islandOf);
          const nearestFriendly = this.nearestCity(friendlyCoastal, unit);
          if (nearestFriendly) {
            const targetTile = this.getAdjacentOceanTiles(obs, nearestFriendly.x, nearestFriendly.y);
            if (targetTile) {
              const move = this.moveToward(obs, unit, targetTile);
              if (move) return move;
            }
            const move = this.moveToward(obs, unit, nearestFriendly);
            if (move) return move;
          }
          break;
        }
      }
    }

    // Rule 2: At friendly island AND units onboard AND (expansion or exploration phase) -> Sail to unexplored island
    if (onFriendlyIsland && unit.cargo.length > 0 && (this.phase === 1 || this.phase === 2)) {
      // Sail to nearest unexplored island
      const unexploredIslands = this.getIslandsByExploredState(obs, islandOf, exploredIslands, false);
      if (unexploredIslands.length > 0) {
        const targetIsland = unexploredIslands[0];
        const targetCity = this.findCoastalCityOnIsland(obs, targetIsland, mineIndices, islandOf);
        if (targetCity) {
          const move = this.moveToward(obs, unit, targetCity);
          if (move) return move;
        }
        // If no coastal city, sail to any land on the island
        const targetLand = this.findAnyLandOnIsland(obs, islandOf, targetIsland);
        if (targetLand) {
          const move = this.moveToward(obs, unit, targetLand);
          if (move) return move;
        }
      }
      // If no unexplored islands, sail to contested island
      const contestedIslands = this.getIslandsByFriendlyState(obs, islandOf, mineIndices, false);
      if (contestedIslands.length > 0) {
        const targetIsland = contestedIslands[0];
        const targetCity = this.findCoastalCityOnIsland(obs, targetIsland, mineIndices, islandOf);
        if (targetCity) {
          const move = this.moveToward(obs, unit, targetCity);
          if (move) return move;
        }
        const targetLand = this.findAnyLandOnIsland(obs, islandOf, targetIsland);
        if (targetLand) {
          const move = this.moveToward(obs, unit, targetLand);
          if (move) return move;
        }
      }
      // If none, sail to unexplored sea areas
      const unexplored = this.nearestUnexploredTile(obs, unit);
      if (unexplored) {
        const step = this.bestStepToward(obs, unit, unexplored);
        if (step) return { type: 'MOVE', unitId: unit.id, to: step };
      }
    }

    // Rule 3: At sea AND units onboard AND expansion phase -> Move to coastal square next to unexplored island
    if (!onFriendlyIsland && unit.cargo.length > 0 && this.phase === 2) {
      const unexploredIslands = this.getIslandsByExploredState(obs, islandOf, exploredIslands, false);
      if (unexploredIslands.length > 0) {
        const targetIsland = unexploredIslands[0];
        const targetCity = this.findCoastalCityOnIsland(obs, targetIsland, mineIndices, islandOf);
        if (targetCity) {
          const move = this.moveToward(obs, unit, targetCity);
          if (move) return move;
        }
        const targetLand = this.findAnyLandOnIsland(obs, islandOf, targetIsland);
        if (targetLand) {
          const move = this.moveToward(obs, unit, targetLand);
          if (move) return move;
        }
      }
    }

    // Rule 4: At sea AND units onboard AND combat phase -> Move to coastal square next to contested island
    if (!onFriendlyIsland && unit.cargo.length > 0 && this.phase === 3) {
      const contestedIslands = this.getIslandsByFriendlyState(obs, islandOf, mineIndices, false);
      if (contestedIslands.length > 0) {
        const targetIsland = contestedIslands[0];
        const targetCity = this.findCoastalCityOnIsland(obs, targetIsland, mineIndices, islandOf);
        if (targetCity) {
          const move = this.moveToward(obs, unit, targetCity);
          if (move) return move;
        }
        const targetLand = this.findAnyLandOnIsland(obs, islandOf, targetIsland);
        if (targetLand) {
          const move = this.moveToward(obs, unit, targetLand);
          if (move) return move;
        }
      }
    }

    // Rule 5: At friendly island AND units onboard AND combat phase -> Sail to nearest contested island
    if (onFriendlyIsland && unit.cargo.length > 0 && this.phase === 3) {
      const contestedIslands = this.getIslandsByFriendlyState(obs, islandOf, mineIndices, false);
      if (contestedIslands.length > 0) {
        const targetIsland = contestedIslands[0];
        const targetCity = this.findCoastalCityOnIsland(obs, targetIsland, mineIndices, islandOf);
        if (targetCity) {
          const move = this.moveToward(obs, unit, targetCity);
          if (move) return move;
        }
        const targetLand = this.findAnyLandOnIsland(obs, islandOf, targetIsland);
        if (targetLand) {
          const move = this.moveToward(obs, unit, targetLand);
          if (move) return move;
        }
      }
    }

    // Rule 6: At friendly island AND no units onboard AND (expansion or combat phase) -> Park near friendly city
    // First check if we're already parked (on a coastal sea tile adjacent to a friendly city)
    if (onFriendlyIsland && unit.cargo.length === 0 && (this.phase === 2 || this.phase === 3)) {
      const isParked = this.isTransportParked(obs, unit, islandOf, mineIndices);
      if (isParked) {
        // Already parked - skip to Rule 7/8 for loading
        // Don't return here, let Rule 7/8 handle loading logic
      } else {
        // Not parked yet - move to coastal sea square next to nearest friendly coastal city
        const friendlyCoastal = this.getCoastalCities(obs, mineIndices, islandOf);
        const nearestFriendly = this.nearestCity(friendlyCoastal, unit);
        if (nearestFriendly) {
          const targetTile = this.getAdjacentOceanTiles(obs, nearestFriendly.x, nearestFriendly.y);
          if (targetTile) {
            const move = this.moveToward(obs, unit, targetTile);
            if (move) return move;
          }
          // Fallback: move toward the city itself if no ocean tile available
          const move = this.moveToward(obs, unit, nearestFriendly);
          if (move) return move;
        }
      }
    }

    // Rule 7: At friendly island AND no units onboard AND (expansion or combat phase) AND army adjacent or at same location -> Load
    if (onFriendlyIsland && unit.cargo.length === 0 && (this.phase === 2 || this.phase === 3)) {
      // Check adjacent tiles
      const adjArmies = this.getAdjacentTiles(unit.x, unit.y).flatMap((c) =>
        obs.myUnits.filter(
          (u) => u.type === UnitType.Army && u.carriedBy === null && this.isIslandFriendly(islandOf.get(`${c.x},${c.y}`), mineIndices),
        ),
      );
      // Also check the transport's current tile (armies at same location)
      const sameTileArmies = obs.myUnits.filter(
        (u) => u.type === UnitType.Army && u.x === unit.x && u.y === unit.y && u.carriedBy === null && this.isIslandFriendly(islandOf.get(`${unit.x},${unit.y}`), mineIndices),
      );
      const allArmies = [...adjArmies, ...sameTileArmies];
      if (allArmies.length > 0) {
        return { type: 'LOAD', unitId: allArmies[0].id, transportId: unit.id };
      }
    }

    // Rule 8: At friendly island AND no units onboard AND already parked AND no armies to load -> Wait
    if (onFriendlyIsland && unit.cargo.length === 0) {
      const isParked = this.isTransportParked(obs, unit, islandOf, mineIndices);
      if (isParked) {
        return { type: 'SKIP', unitId: unit.id };
      }
    }

    return null;
  }

  /**
   * Check if transport is already parked on a coastal sea tile adjacent to a friendly city.
   */
  private isTransportParked(
    obs: AgentObservation,
    unit: UnitView,
    islandOf: Map<string, number>,
    mineIndices: Set<number>,
  ): boolean {
    const myIslandIdx = islandOf.get(`${unit.x},${unit.y}`);
    if (myIslandIdx === undefined || !mineIndices.has(myIslandIdx)) {
      return false; // Not on a friendly island
    }

    // Check if unit is on an ocean tile (parked position)
    const currentTile = obs.tiles[unit.y]?.[unit.x];
    if (!currentTile || currentTile.terrain !== Terrain.Ocean) {
      return false; // Not on ocean
    }

    // Check if adjacent to a friendly coastal city on the same island
    for (const [dx, dy] of [
      [-1, -1], [0, -1], [1, -1],
      [-1,  0],          [1,  0],
      [-1,  1], [0,  1], [1,  1],
    ] as [number, number][]) {
      const nx = wrapX(unit.x + dx, this.mapWidth);
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

  // ── Shared Transport Helpers ────────────────────────────────────────────────

  private getCoastalCities(
    obs: AgentObservation,
    mineIndices: Set<number>,
    islandOf: Map<string, number>,
  ): Coord[] {
    return obs.myCities.filter((c) => {
      for (const [dx, dy] of [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],          [1,  0],
        [-1,  1], [0,  1], [1,  1],
      ] as [number, number][]) {
        const nx = wrapX(c.x + dx, this.mapWidth);
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

  private findCoastalCityOnIsland(
    obs: AgentObservation,
    islandIdx: number,
    mineIndices: Set<number>,
    islandOf: Map<string, number>,
  ): Coord | null {
    const coastal = obs.myCities.filter((c) => {
      for (const [dx, dy] of [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],          [1,  0],
        [-1,  1], [0,  1], [1,  1],
      ] as [number, number][]) {
        const nx = wrapX(c.x + dx, this.mapWidth);
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

  private findAnyLandOnIsland(
    obs: AgentObservation,
    islandOf: Map<string, number>,
    islandIdx: number,
  ): Coord | null {
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

  private getIslandsByExploredState(
    obs: AgentObservation,
    islandOf: Map<string, number>,
    exploredIslands: Set<number>,
    isExplored: boolean,
  ): number[] {
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

  private getIslandsByFriendlyState(
    obs: AgentObservation,
    islandOf: Map<string, number>,
    mineIndices: Set<number>,
    isFriendly: boolean,
  ): number[] {
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
   * Determine the move for a Destroyer unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForDestroyer(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const fMov = UNIT_STATS[UnitType.Destroyer].movesPerTurn;

    // Rule 1: Enemy transport/destroyer/submarine in range -> Attack it
    const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Submarine, UnitType.Destroyer];
    for (const preyType of huntingOrder) {
      const candidates = obs.visibleEnemyUnits.filter((e) => e.type === preyType);
      for (const target of candidates) {
        if (this.wrappedDist(target, unit) <= fMov) {
          const move = this.moveToward(obs, unit, target);
          if (move) return move;
        }
      }
    }

    // Rule 2: No enemy ships in range -> Move toward unexplored naval areas
    const unexplored = this.nearestUnexploredTile(obs, unit);
    if (unexplored) {
      const step = this.bestStepToward(obs, unit, unexplored);
      if (step) return { type: 'MOVE', unitId: unit.id, to: step };
    }

    // Rule 3: No unexplored naval areas -> Begin patrol pattern around ocean
    // Pick random direction, sail until unable, then pick new random direction
    if (!this.destroyerPatrolDir) {
      const dirs = [
        { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
        { x: -1, y: 0 }, { x: 1, y: 0 },
        { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
      ];
      this.destroyerPatrolDir = dirs[Math.floor(Math.random() * dirs.length)];
    }

    // Try to move in patrol direction
    const patrolX = unit.x + this.destroyerPatrolDir.x * fMov;
    const patrolY = unit.y + this.destroyerPatrolDir.y * fMov;
    const wrappedPatrolX = wrapX(patrolX, this.mapWidth);

    // Check if patrol destination is valid ocean
    const patrolTile = obs.tiles[patrolY]?.[wrappedPatrolX];
    if (patrolTile && patrolTile.terrain === Terrain.Ocean) {
      const step = this.bestStepToward(obs, unit, { x: wrappedPatrolX, y: patrolY });
      if (step) return { type: 'MOVE', unitId: unit.id, to: step };
    }

    // If unable to move in patrol direction, pick new random direction
    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 }, { x: 1, y: 0 },
      { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
    ];
    this.destroyerPatrolDir = dirs[Math.floor(Math.random() * dirs.length)];

    const newPatrolX = unit.x + this.destroyerPatrolDir.x * fMov;
    const newPatrolY = unit.y + this.destroyerPatrolDir.y * fMov;
    const newWrappedX = wrapX(newPatrolX, this.mapWidth);
    const newPatrolTile = obs.tiles[newPatrolY]?.[newWrappedX];
    if (newPatrolTile && newPatrolTile.terrain === Terrain.Ocean) {
      const step = this.bestStepToward(obs, unit, { x: newWrappedX, y: newPatrolY });
      if (step) return { type: 'MOVE', unitId: unit.id, to: step };
    }

    return null;
  }

  /**
   * Determine the move for a Battleship unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForBattleship(
    obs: AgentObservation,
    unit: UnitView,
    mineIndices: Set<number>,
    exploredIslands: Set<number>,
    islandOf: Map<string, number>,
  ): AgentAction | null {
    const fMov = UNIT_STATS[UnitType.Battleship].movesPerTurn;

    // Rule 1: Enemy ship in range (transport/destroyer/battleship/carrier) -> Attack it
    const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Destroyer, UnitType.Carrier, UnitType.Battleship];
    for (const preyType of huntingOrder) {
      const candidates = obs.visibleEnemyUnits.filter((e) => e.type === preyType);
      for (const target of candidates) {
        if (this.wrappedDist(target, unit) <= fMov) {
          const move = this.moveToward(obs, unit, target);
          if (move) return move;
        }
      }
    }

    // Rule 2: Enemy city in range with units -> Bombard the city while it has units
    const enemyCitiesWithUnits = obs.visibleEnemyCities
      .filter((c) => c.owner !== null && c.coastal)
      .map((c) => ({
        city: c,
        defenders: obs.visibleEnemyUnits.filter(
          (u) => u.x === c.x && u.y === c.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
        ).length,
      }))
      .filter((e) => e.defenders > 0);

    for (const entry of enemyCitiesWithUnits) {
      if (this.wrappedDist(entry.city, unit) <= fMov) {
        const move = this.moveToward(obs, unit, entry.city);
        if (move) return move;
      }
    }

    // Rule 3: Enemy city not within range but has units -> Move toward the city
    for (const entry of enemyCitiesWithUnits) {
      if (this.wrappedDist(entry.city, unit) > fMov) {
        const move = this.moveToward(obs, unit, entry.city);
        if (move) return move;
      }
    }

    // Rule 4: No enemy ships/cities in range -> Patrol ocean looking for enemy ships
    const unexplored = this.nearestUnexploredTile(obs, unit);
    if (unexplored) {
      const step = this.bestStepToward(obs, unit, unexplored);
      if (step) return { type: 'MOVE', unitId: unit.id, to: step };
    }

    // Patrol: move toward nearest enemy city if no unexplored areas
    const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
    const patrolTarget = this.nearestCity(enemyCities, unit);
    if (patrolTarget) {
      const move = this.moveToward(obs, unit, patrolTarget);
      if (move) return move;
    }

    return null;
  }

  /**
   * Determine the move for a Carrier unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForCarrier(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const fMov = UNIT_STATS[UnitType.Fighter].movesPerTurn;

    // Rule 1: Fighter needs a landing strip -> Position carrier to support fighter operations
    if (unit.cargo.length < UNIT_STATS[UnitType.Carrier].cargoCapacity) {
      // Check if there are fighters that need landing (low fuel or no carrier to land on)
      const fightersNeedingLand = obs.myUnits.filter(
        (u) => u.type === UnitType.Fighter && u.carriedBy === null && u.movesLeft > 0,
      );
      if (fightersNeedingLand.length > 0) {
        // Find friendly cities that are more than fighter range apart (need carrier to bridge)
        const fighterRange = UNIT_STATS[UnitType.Fighter].movesPerTurn;
        const citiesInRange = new Set<string>();

        // Find cities within fighter range of each other
        for (let i = 0; i < obs.myCities.length; i++) {
          for (let j = i + 1; j < obs.myCities.length; j++) {
            const dist = this.wrappedDist(obs.myCities[i], obs.myCities[j]);
            if (dist <= fighterRange) {
              citiesInRange.add(`${obs.myCities[i].x},${obs.myCities[i].y}`);
              citiesInRange.add(`${obs.myCities[j].x},${obs.myCities[j].y}`);
            }
          }
        }

        // Move toward a friendly city that's isolated (not in citiesInRange)
        // or toward unexplored sea to position for future expansion
        const isolatedCities = obs.myCities.filter(
          (c) => !citiesInRange.has(`${c.x},${c.y}`) && c.coastal
        );

        let target: Coord | null = null;
        if (isolatedCities.length > 0) {
          target = this.nearestCity(isolatedCities, unit);
        }

        // If no isolated cities, move toward unexplored sea
        if (!target) {
          target = this.nearestUnexploredTile(obs, unit);
        }

        if (target) {
          const step = this.bestStepToward(obs, unit, target);
          if (step) return { type: 'MOVE', unitId: unit.id, to: step };
        }
      }
    }

    // Rule 2: No landing strip needed -> Explore unexplored naval areas
    const unexplored = this.nearestUnexploredTile(obs, unit);
    if (unexplored) {
      const step = this.bestStepToward(obs, unit, unexplored);
      if (step) return { type: 'MOVE', unitId: unit.id, to: step };
    }

    return null;
  }

  /**
   * Determine the move for a Submarine unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForSubmarine(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const fMov = UNIT_STATS[UnitType.Submarine].movesPerTurn;

    // Rule 1: Enemy transport/carrier/battleship in range -> Attack it
    const huntingOrder: UnitType[] = [UnitType.Transport, UnitType.Carrier, UnitType.Battleship];
    for (const preyType of huntingOrder) {
      const candidates = obs.visibleEnemyUnits.filter((e) => e.type === preyType);
      for (const target of candidates) {
        if (this.wrappedDist(target, unit) <= fMov) {
          const move = this.moveToward(obs, unit, target);
          if (move) return move;
        }
      }
    }

    // Rule 2: No enemy ships in range -> Move toward unexplored naval areas
    const unexplored = this.nearestUnexploredTile(obs, unit);
    if (unexplored) {
      const step = this.bestStepToward(obs, unit, unexplored);
      if (step) return { type: 'MOVE', unitId: unit.id, to: step };
    }

    // Rule 3: No unexplored naval areas -> Begin patrol pattern around ocean
    const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
    const patrolTarget = this.nearestCity(enemyCities, unit);
    if (patrolTarget) {
      const move = this.moveToward(obs, unit, patrolTarget);
      if (move) return move;
    }

    // Try adjacent ocean tiles for patrol
    const adjTiles = this.getAdjacentTiles(unit.x, unit.y);
    for (const tile of adjTiles) {
      const tileObj = obs.tiles[tile.y]?.[tile.x];
      if (tileObj && tileObj.terrain === Terrain.Ocean) {
        return { type: 'MOVE', unitId: unit.id, to: tile };
      }
    }

    return { type: 'SKIP', unitId: unit.id };
  }

  /**
   * Determine the move for a Bomber unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForBomber(
    obs: AgentObservation,
    unit: UnitView,
    blastRadius: number,
  ): AgentAction | null {
    const maxFuel = UNIT_STATS[UnitType.Bomber].maxFuel ?? 100;

    // Rule 1: Enemy city within range, troops within city, friendly troops within 2 squares -> Bomb city
    let bestCityTarget: Coord | null = null;
    let bestCityValue = -1;

    for (const city of obs.visibleEnemyCities) {
      if (city.owner === null) continue;
      const hasDefender = obs.visibleEnemyUnits.some(
        (u) => u.x === city.x && u.y === city.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
      );
      if (!hasDefender) continue;

      const friendlyArmyNear = obs.myUnits.some(
        (u) => u.type === UnitType.Army && this.wrappedDist(u, city) <= 2,
      );
      if (!friendlyArmyNear) continue;

      const cityUnits = obs.visibleEnemyUnits.filter(
        (u) => u.x === city.x && u.y === city.y,
      );
      const productionValue = cityUnits.reduce((sum, u) => sum + UNIT_STATS[u.type].buildTime, 0);

      if (productionValue > 0 && this.wrappedDist(city, unit) <= maxFuel) {
        if (productionValue > bestCityValue) {
          bestCityValue = productionValue;
          bestCityTarget = city;
        }
      }
    }

    if (bestCityTarget) {
      const move = this.moveToward(obs, unit, bestCityTarget);
      if (move) return move;
    }

    // Rule 2: Enemy transport within range with at least one army onboard -> Bomb transport
    for (const target of obs.visibleEnemyUnits) {
      if (target.type === UnitType.Transport && target.cargo.length > 0 && this.wrappedDist(target, unit) <= maxFuel) {
        const move = this.moveToward(obs, unit, target);
        if (move) return move;
      }
    }

    // Rule 3: Area with at least 30 enemy unit production combined value -> Bomb area
    // Sum production value of all enemy units in a 3x3 area around each potential target
    let bestAreaTarget: Coord | null = null;
    let bestAreaValue = -1;

    for (const enemy of obs.visibleEnemyUnits) {
      if (this.wrappedDist(enemy, unit) > maxFuel) continue;
      let areaValue = 0;
      for (const e of obs.visibleEnemyUnits) {
        if (this.wrappedDist(e, enemy) <= 1) {
          areaValue += UNIT_STATS[e.type].buildTime;
        }
      }
      if (areaValue >= 30 && areaValue > bestAreaValue) {
        bestAreaValue = areaValue;
        bestAreaTarget = enemy;
      }
    }

    if (bestAreaTarget && bestAreaValue >= 30) {
      const move = this.moveToward(obs, unit, bestAreaTarget);
      if (move) return move;
    }

    // Rule 4: No high-value targets in range -> Move to friendly city within 15 squares of enemy city or enemy units worth 15+
    const CONFLICT_RADIUS = 15;
    const conflictCities = obs.myCities.filter((c) => {
      const enemyCityNear = obs.visibleEnemyCities.some(
        (e) => e.owner !== null && this.wrappedDist(c, e) <= CONFLICT_RADIUS,
      );
      const enemyUnitNear = obs.visibleEnemyUnits.some((e) => this.wrappedDist(c, e) <= CONFLICT_RADIUS);
      return enemyCityNear || enemyUnitNear;
    });

    // Check if already at conflict city
    if (conflictCities.some((c) => c.x === unit.x && c.y === unit.y)) {
      return { type: 'SKIP', unitId: unit.id };
    }

    const nearestConflict = this.nearestCity(conflictCities, unit);
    if (nearestConflict) {
      const move = this.moveToward(obs, unit, nearestConflict);
      if (move) return move;
    }

    // No conflict cities — return to nearest friendly city
    const homeCity = this.nearestCity(obs.myCities, unit);
    if (homeCity) {
      const move = this.moveToward(obs, unit, homeCity);
      if (move) return move;
    }

    return null;
  }

  /**
   * Determine the move for a Fighter unit according to rules.json.
   * Evaluate conditions top-to-bottom, first match executes.
   * If no conditions match, perform wait (SKIP).
   */
  private determineMoveForFighter(
    obs: AgentObservation,
    unit: UnitView,
    mineIndices: Set<number>,
    islandOf: Map<string, number>,
  ): AgentAction | null {
    const fMov = UNIT_STATS[UnitType.Fighter].movesPerTurn;

    // Rule 1: Enemy transport in range with at least one unit onboard -> Attack
    for (const target of obs.visibleEnemyUnits) {
      if (target.type === UnitType.Transport && target.cargo.length > 0 && this.wrappedDist(target, unit) <= fMov) {
        const move = this.moveToward(obs, unit, target);
        if (move) return move;
      }
    }

    // Rule 2: Enemy submarine in range -> Attack
    for (const target of obs.visibleEnemyUnits) {
      if (target.type === UnitType.Submarine && this.wrappedDist(target, unit) <= fMov) {
        const move = this.moveToward(obs, unit, target);
        if (move) return move;
      }
    }

    // Rule 3: Friendly city under attack (enemy army within 3 squares) -> Fly to friendly city, stay there
    const citiesUnderAttack = obs.myCities.filter((c) =>
      obs.visibleEnemyUnits.some(
        (e) => e.type === UnitType.Army && this.wrappedDist(e, c) <= 3,
      ),
    );
    if (citiesUnderAttack.length > 0) {
      // Find nearest city under attack
      const nearestCityUnderAttack = this.nearestCity(citiesUnderAttack, unit);
      if (nearestCityUnderAttack) {
        const move = this.moveToward(obs, unit, nearestCityUnderAttack);
        if (move) return move;
        // If already at the city, hold position
        if (unit.x === nearestCityUnderAttack.x && unit.y === nearestCityUnderAttack.y) {
          return { type: 'SKIP', unitId: unit.id };
        }
      }
    }

    // Rule 4: Board a carrier if available
    const needyCarrier = obs.myUnits.find(
      (u) => u.type === UnitType.Carrier && u.cargo.length < UNIT_STATS[UnitType.Carrier].cargoCapacity,
    );
    if (needyCarrier) {
      const move = this.moveToward(obs, unit, needyCarrier);
      if (move) return move;
    }

    // Rule 5: Move to nearest unexplored sea zone (explore)
    const unexplored = this.nearestUnexploredTile(obs, unit);
    if (unexplored) {
      const step = this.bestStepToward(obs, unit, unexplored);
      if (step) return { type: 'MOVE', unitId: unit.id, to: step };
    }

    return null;
  }

  // ── Shared Movement Helpers ─────────────────────────────────────────────────


  private moveToward(obs: AgentObservation, unit: UnitView, target: Coord): AgentAction | null {
    const best = this.bestStepToward(obs, unit, target);
    if (best) return { type: 'MOVE', unitId: unit.id, to: best };
    return null;
  }

  private bestStepToward(obs: AgentObservation, unit: UnitView, target: Coord): Coord | null {
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
      for (const d of dirs) {
        const nx = wrapX(cur.x + d.x, this.mapWidth);
        const ny = cur.y + d.y;
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

  private getAdjacentTiles(x: number, y: number): Coord[] {
    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 },                     { x: 1, y: 0 },
      { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
    ];
    return dirs.map((d) => ({
      x: wrapX(x + d.x, this.mapWidth),
      y: y + d.y,
    }));
  }

  /** Returns the adjacent land tile closest to `toward` (or any land tile if toward is null). */
  private getAdjacentAirTileToward(unit: UnitView, toward: Coord): Coord | null {
    const adj = this.getAdjacentTiles(unit.x, unit.y);
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (const c of adj) {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) continue; // no ice caps
      const d = this.wrappedDist(c, toward);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  /** Returns all adjacent ocean tiles. */
  private getAdjacentOceanTiles(obs: AgentObservation, x: number, y: number): Coord | null {
    const adj = this.getAdjacentTiles(x, y);
    for (const c of adj) {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) continue;
      const tile = obs.tiles[c.y]?.[c.x];
      if (tile && tile.terrain === Terrain.Ocean) return c;
    }
    return null;
  }

  private getAdjacentLandToward(obs: AgentObservation, unit: UnitView, toward: Coord | null): Coord | null {
    const adj = this.getAdjacentTiles(unit.x, unit.y);
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
  private getAdjacentLandTiles(obs: AgentObservation, x: number, y: number): Coord[] {
    const adj = this.getAdjacentTiles(x, y);
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

    return { islandOf, mineIndices, contestedIndices, exploredIslands };
  }
}
