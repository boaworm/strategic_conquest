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

/**
 * A basic greedy AI that:
 * 1. Sets all idle cities to produce armies (early game) or a mix of units
 * 2. Sends armies toward the nearest neutral or enemy city
 * 3. Attacks enemy units within reach
 * 4. Handles naval/air units with simple heuristics
 */
export class BasicAgent implements Agent {
  private playerId!: string;
  private mapWidth!: number;
  private mapHeight!: number;

  init(config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
  }

  act(obs: AgentObservation): AgentAction {
    // ── Phase 1: Handle all units ──────────────────────────────
    // For each unit that still has moves, decide what to do.
    // If the unit is sleeping, wake it so it can act next cycle.
    // If we can't find a valid action (unit completely blocked), SKIP it
    // to exhaust its moves — this is critical to prevent an infinite loop
    // where the same stuck unit is re-evaluated every stateUpdate.
    for (const unit of obs.myUnits) {
      if (unit.carriedBy !== null) continue;

      if (unit.sleeping) {
        if (unit.movesLeft > 0) {
          return { type: 'WAKE', unitId: unit.id };
        }
        continue;
      }

      if (unit.movesLeft <= 0) continue;

      const action = this.decideUnitAction(obs, unit);
      if (action) {
        return action;
      }
      // decideUnitAction returned null — unit is completely blocked.
      // SKIP it so the server marks its moves as exhausted, preventing
      // this unit from being looped over indefinitely.
      return { type: 'SKIP', unitId: unit.id };
    }

    // ── Phase 2: Ensure all cities are producing ───────────────
    for (const city of obs.myCities) {
      if (city.producing === null) {
        const unitType = this.chooseProduction(obs, city);
        return { type: 'SET_PRODUCTION', cityId: city.id, unitType };
      }
    }

    // All units have acted and all cities are producing — end the turn.
    return { type: 'END_TURN' };
  }

  private chooseProduction(obs: AgentObservation, city: CityView): UnitType {
    const stats = UNIT_STATS;
    const myLandUnits = obs.myUnits.filter((u) => UNIT_STATS[u.type].domain === UnitDomain.Land);
    const mySeaUnits = obs.myUnits.filter((u) => UNIT_STATS[u.type].domain === UnitDomain.Sea);
    const enemyCities = obs.visibleEnemyCities;
    const myCities = obs.myCities;

    const infantryCount = myLandUnits.filter((u) => u.type === UnitType.Infantry).length;
    const tankCount = myLandUnits.filter((u) => u.type === UnitType.Tank).length;
    const transportCount = mySeaUnits.filter((u) => u.type === UnitType.Transport).length;
    const destroyerCount = mySeaUnits.filter((u) => u.type === UnitType.Destroyer).length;
    const carrierCount = mySeaUnits.filter((u) => u.type === UnitType.Carrier).length;
    const battleshipCount = mySeaUnits.filter((u) => u.type === UnitType.Battleship).length;

    const enemyCoastalCities = enemyCities.filter((c) => c.coastal);
    const coastalCity = myCities.some((c) => c.coastal);

    // 1. Naval production logic (if we have coastal cities)
    if (coastalCity) {
      // Count enemy sea units
      const enemySeaUnits = obs.visibleEnemyUnits.filter(
        (u) => UNIT_STATS[u.type].domain === UnitDomain.Sea,
      );
      const enemyTransportCount = enemySeaUnits.filter((u) => u.type === UnitType.Transport).length;
      const enemyDestroyerCount = enemySeaUnits.filter((u) => u.type === UnitType.Destroyer).length;
      const enemySubmarineCount = enemySeaUnits.filter((u) => u.type === UnitType.Submarine).length;

      // Build transports first if we have land units but no way to move them across ocean
      if (enemyCoastalCities.length > 0 && transportCount === 0 && infantryCount + tankCount >= 2) {
        return UnitType.Transport;
      }

      // Build destroyers if enemy has submarines or naval units
      if (enemySubmarineCount > 0 && destroyerCount === 0) {
        return UnitType.Destroyer;
      }
      if (enemySeaUnits.length > 0 && destroyerCount < 2) {
        return UnitType.Destroyer;
      }

      // Build carriers if we have fighters and no carriers
      const fighterCount = obs.myUnits.filter((u) => u.type === UnitType.Fighter).length;
      if (fighterCount > 0 && carrierCount === 0) {
        return UnitType.Carrier;
      }

      // Build battleships for heavy naval support
      if (battleshipCount < 1 && destroyerCount >= 2) {
        return UnitType.Battleship;
      }
    }

    // 2. Land production logic
    // If we have transports and are in expansion mode, build tanks for offensive power
    if (transportCount > 0 && tankCount < infantryCount) {
      return UnitType.Tank;
    }

    // If we're defending (enemy is very close) or need more bodies, build infantry
    const nearestEnemy = this.nearestCity(enemyCities, city);
    if (nearestEnemy) {
      const dist = this.wrappedDist(nearestEnemy, city);
      if (dist <= 2) {
        // Very close enemy - build infantry for defense (cheap, good defense)
        return UnitType.Infantry;
      }
    }

    // If enemy has tanks, build some tanks for counter
    const enemyTankCount = obs.visibleEnemyUnits.filter((u) => u.type === UnitType.Tank).length;
    if (enemyTankCount > 0 && tankCount < enemyTankCount) {
      return UnitType.Tank;
    }

    // Default mix: favor infantry for economy, some tanks for offense
    if (tankCount < infantryCount / 2) {
      return UnitType.Tank;
    }
    return UnitType.Infantry;
  }

  private requiresNavalApproach(obs: AgentObservation, target: CityView): boolean {
    // Simple check: is there ocean between our nearest city and the target?
    const nearest = this.nearestCity(obs.myCities, target);
    if (!nearest) return false;
    const dist = this.wrappedDist(nearest, target);
    return dist > 8;
  }

  private decideUnitAction(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const stats = UNIT_STATS[unit.type];

    // Try to attack an adjacent enemy
    const adjacentEnemy = this.findAdjacentEnemy(obs, unit);
    if (adjacentEnemy) {
      return { type: 'MOVE', unitId: unit.id, to: { x: adjacentEnemy.x, y: adjacentEnemy.y } };
    }

    if (stats.domain === UnitDomain.Land) {
      return this.decideLandUnit(obs, unit);
    }
    if (stats.domain === UnitDomain.Sea) {
      return this.decideSeaUnit(obs, unit);
    }
    if (stats.domain === UnitDomain.Air) {
      return this.decideAirUnit(obs, unit);
    }

    return null;
  }

  private decideLandUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    // Priority 1: Move toward nearest neutral city to capture
    const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
    const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);

    // Prefer closer neutral cities
    const target = this.nearestCity([...neutralCities, ...enemyCities], unit);

    if (target) {
      return this.moveToward(obs, unit, target);
    }

    // Explore: move toward unexplored area
    return this.moveTowardExploration(obs, unit);
  }

  private decideSeaUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const stats = UNIT_STATS[unit.type];

    // Transports: try to carry armies
    if (stats.cargoCapacity > 0 && unit.type === UnitType.Transport) {
      // If carrying armies, move toward enemy/neutral coastal city
      if (unit.cargo.length > 0) {
        const coastalTarget = this.nearestCity(obs.visibleEnemyCities, unit);
        if (coastalTarget) {
          // Try to unload adjacent to target
          const adj = this.getAdjacentLand(obs, unit);
          if (adj) {
            const cargoId = unit.cargo[0];
            return { type: 'UNLOAD', unitId: cargoId, to: adj };
          }
          return this.moveToward(obs, unit, coastalTarget);
        }
      }
      // Look for armies to load (same tile or adjacent)
      const armyToLoad = obs.myUnits.find(
        (u) =>
          u.type === UnitType.Infantry &&
          u.carriedBy === null &&
          unit.cargo.length < stats.cargoCapacity &&
          u.movesLeft > 0 &&
          wrappedDistX(u.x, unit.x, obs.tiles[0].length) <= 1 &&
          Math.abs(u.y - unit.y) <= 1,
      );
      if (armyToLoad) {
        return { type: 'LOAD', unitId: armyToLoad.id, transportId: unit.id };
      }
    }

    // Combat ships: move toward visible enemy units
    const enemyShip = this.nearestEnemy(obs.visibleEnemyUnits.filter(
      (u) => UNIT_STATS[u.type].domain === UnitDomain.Sea,
    ), unit);
    if (enemyShip) {
      return this.moveToward(obs, unit, enemyShip);
    }

    return this.moveTowardExploration(obs, unit);
  }

  private decideAirUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    // If low fuel, return to nearest city or carrier
    if (unit.fuel !== undefined && unit.fuel <= 4) {
      const refuel = this.nearestCity(obs.myCities, unit);
      if (refuel) {
        return this.moveToward(obs, unit, refuel);
      }
    }

    // Attack nearest enemy
    const enemy = this.nearestEnemy(obs.visibleEnemyUnits, unit);
    if (enemy) {
      return this.moveToward(obs, unit, enemy);
    }

    // Scout
    return this.moveTowardExploration(obs, unit);
  }

  // ── Helpers ──────────────────────────────────────────────

  private findAdjacentEnemy(obs: AgentObservation, unit: UnitView): UnitView | undefined {
    return obs.visibleEnemyUnits.find((e) => {
      const dx = wrappedDistX(e.x, unit.x, this.mapWidth);
      const dy = Math.abs(e.y - unit.y);
      return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
    });
  }

  private moveToward(obs: AgentObservation, unit: UnitView, target: Coord): AgentAction | null {
    const best = this.bestStepToward(obs, unit, target);
    if (best) {
      return { type: 'MOVE', unitId: unit.id, to: best };
    }
    return null;
  }

  private bestStepToward(obs: AgentObservation, unit: UnitView, target: Coord): Coord | null {
    const stats = UNIT_STATS[unit.type];
    const candidates = this.getAdjacentTiles(unit.x, unit.y);
    let bestDist = Infinity;
    let bestCoord: Coord | null = null;

    for (const c of candidates) {
      if (c.y < 0 || c.y >= this.mapHeight) continue;

      // Check for ice caps (north and south edges)
      if (c.y === 0 || c.y === this.mapHeight - 1) continue;

      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile) continue;

      // Check terrain compatibility
      if (stats.domain === UnitDomain.Land && tile.terrain === Terrain.Ocean) continue;
      if (stats.domain === UnitDomain.Sea && tile.terrain === Terrain.Land) {
        // Sea units can enter city tiles — check if there's a city
        const hasCity = [...obs.myCities, ...obs.visibleEnemyCities].some(
          (ct) => ct.x === c.x && ct.y === c.y,
        );
        if (!hasCity) continue;
      }

      const dist = this.wrappedDist(c, target);
      if (dist < bestDist) {
        bestDist = dist;
        bestCoord = c;
      }
    }

    return bestCoord;
  }

  private moveTowardExploration(obs: AgentObservation, unit: UnitView): AgentAction | null {
    // Move toward nearest hidden tile
    const stats = UNIT_STATS[unit.type];
    const candidates = this.getAdjacentTiles(unit.x, unit.y);

    // Prefer tiles adjacent to hidden areas
    let bestScore = -Infinity;
    let bestCoord: Coord | null = null;

    for (const c of candidates) {
      if (c.y < 0 || c.y >= this.mapHeight) continue;
      // Check for ice caps
      if (c.y === 0 || c.y === this.mapHeight - 1) continue;

      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile) continue;

      if (stats.domain === UnitDomain.Land && tile.terrain === Terrain.Ocean) continue;
      if (stats.domain === UnitDomain.Sea && tile.terrain === Terrain.Land) {
        const hasCity = [...obs.myCities, ...obs.visibleEnemyCities].some(
          (ct) => ct.x === c.x && ct.y === c.y,
        );
        if (!hasCity) continue;
      }

      // Score: number of adjacent hidden tiles (encourages exploring fog)
      let score = 0;
      for (const adj of this.getAdjacentTiles(c.x, c.y)) {
        if (adj.y < 0 || adj.y >= this.mapHeight) continue;
        if (adj.y === 0 || adj.y === this.mapHeight - 1) continue;
        const adjTile = obs.tiles[adj.y]?.[adj.x];
        if (adjTile && adjTile.visibility === TileVisibility.Hidden) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCoord = c;
      }
    }

    if (bestCoord && bestScore > 0) {
      return { type: 'MOVE', unitId: unit.id, to: bestCoord };
    }

    // No hidden tiles nearby — just pick a random valid adjacent tile
    const valid = candidates.filter((c) => {
      if (c.y < 0 || c.y >= this.mapHeight) return false;
      // Check for ice caps
      if (c.y === 0 || c.y === this.mapHeight - 1) return false;
      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile) return false;
      if (stats.domain === UnitDomain.Land && tile.terrain === Terrain.Ocean) return false;
      if (stats.domain === UnitDomain.Sea && tile.terrain === Terrain.Land) {
        const hasCity = [...obs.myCities, ...obs.visibleEnemyCities].some(
          (ct) => ct.x === c.x && ct.y === c.y,
        );
        if (!hasCity) return false;
      }
      return true;
    });

    if (valid.length > 0) {
      const pick = valid[Math.floor(Math.random() * valid.length)];
      return { type: 'MOVE', unitId: unit.id, to: pick };
    }

    // No valid moves - sleep or skip instead of returning null
    return { type: 'SLEEP', unitId: unit.id };
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

  private getAdjacentLand(obs: AgentObservation, unit: UnitView): Coord | null {
    const adj = this.getAdjacentTiles(unit.x, unit.y);
    for (const c of adj) {
      if (c.y < 0 || c.y >= this.mapHeight) continue;
      // Check for ice caps
      if (c.y === 0 || c.y === this.mapHeight - 1) continue;
      const tile = obs.tiles[c.y]?.[c.x];
      if (tile && tile.terrain === Terrain.Land) {
        return c;
      }
    }
    return null;
  }

  private nearestCity(cities: readonly { x: number; y: number }[], from: Coord): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (const c of cities) {
      const d = this.wrappedDist(c, from);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  private nearestEnemy(enemies: readonly UnitView[], from: Coord): UnitView | null {
    let best: UnitView | null = null;
    let bestDist = Infinity;
    for (const e of enemies) {
      const d = this.wrappedDist(e, from);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  private wrappedDist(a: Coord, b: Coord): number {
    return wrappedDistX(a.x, b.x, this.mapWidth) + Math.abs(a.y - b.y);
  }
}
