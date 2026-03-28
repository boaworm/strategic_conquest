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

  // Nearest undefended/neutral city to claim — expansion mode.
  private expansionTarget: Coord | null = null;
  // Nearest defended enemy city — attack mode (only when no free cities exist).
  private attackTarget: Coord | null = null;
  // Current strategic phase (recomputed each act() call).
  private phase: 1 | 2 | 3 = 1;

  init(config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
  }

  /**
   * Determine current strategic phase from observable signals:
   *  1 — Colonise home island  (neutral cities still visible nearby)
   *  2 — Expansion             (home done, no enemy contact yet)
   *  3 — Combat                (enemy-owned cities within striking range of ours)
   *
   * Phase 3 covers both "we have a foothold on their island" and "they've taken one
   * of ours" — in both cases we want air/naval support and island-specific armies.
   */
  private computePhase(obs: AgentObservation): 1 | 2 | 3 {
    // Phase 3: any of our cities is within combatDist of an enemy-owned city.
    // Covers both "foothold on enemy island" and "enemy is on our island".
    const combatDist = Math.min(12, Math.floor(this.mapWidth / 4));
    const inCombat = obs.myCities.some((mine) =>
      obs.visibleEnemyCities.some(
        (enemy) => enemy.owner !== null && this.wrappedDist(mine, enemy) <= combatDist,
      ),
    );
    if (inCombat) return 3;

    // Phase 2: home island colonised — no neutral cities visible AND no land left to
    // explore.  Use a land army's exploration result as the proxy: if no army can find
    // an unexplored land tile, the island is done.  Require at least 2 cities so we
    // don't trigger on turn 1 before any exploration has happened.
    const hasVisibleNeutral = obs.visibleEnemyCities.some((c) => c.owner === null);
    if (!hasVisibleNeutral && obs.myCities.length >= 2) {
      const sampleArmy = obs.myUnits.find(
        (u) => u.type === UnitType.Army && u.carriedBy === null,
      );
      const islandFullyExplored =
        !sampleArmy || this.moveTowardExploration(obs, sampleArmy) === null;
      if (islandFullyExplored) return 2;
    }

    // Phase 1 by default: colonise and explore the home island.
    return 1;
  }

  private updateTargets(obs: AgentObservation): void {
    // Center of mass of all our units (for picking the nearest target)
    const n = obs.myUnits.length || obs.myCities.length || 1;
    const cx = Math.round(
      (obs.myUnits.reduce((s, u) => s + u.x, 0) + obs.myCities.reduce((s, c) => s + c.x, 0)) /
      (obs.myUnits.length + obs.myCities.length || 1)
    );
    const cy = Math.round(
      (obs.myUnits.reduce((s, u) => s + u.y, 0) + obs.myCities.reduce((s, c) => s + c.y, 0)) /
      (obs.myUnits.length + obs.myCities.length || 1)
    );
    const center: Coord = { x: cx, y: cy };

    // Free cities: neutral, or enemy-owned but no visible enemy land unit standing on them.
    const freeCities = obs.visibleEnemyCities.filter(
      (c) =>
        c.owner === null ||
        !obs.visibleEnemyUnits.some(
          (u) => UNIT_STATS[u.type].domain === UnitDomain.Land && u.x === c.x && u.y === c.y,
        ),
    );

    if (freeCities.length > 0) {
      this.expansionTarget = this.nearestCity(freeCities, center);
      this.attackTarget = null;
    } else {
      this.expansionTarget = null;
      const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
      // Keep attackTarget stable if still visible (avoid oscillating)
      if (
        this.attackTarget &&
        enemyCities.some((c) => c.x === this.attackTarget!.x && c.y === this.attackTarget!.y)
      ) {
        // keep existing
      } else {
        this.attackTarget = this.nearestCity(enemyCities, center);
      }
    }
  }

  // When in attack mode, support units act before armies to soften defenders.
  private attackPriority(unit: UnitView): number {
    switch (unit.type) {
      case UnitType.Bomber:     return 0;
      case UnitType.Fighter:    return 1;
      case UnitType.Battleship: return 2;
      case UnitType.Destroyer:  return 3;
      default:                  return 10;
    }
  }

  act(obs: AgentObservation): AgentAction {
    this.updateTargets(obs);
    this.phase = this.computePhase(obs);

    // Sea units first so transports can LOAD armies before armies burn their moves on SKIP.
    // In attack mode, override with attack priority (bombers/fighters/battleships lead).
    const domainOrder = (u: UnitView) => {
      const d = UNIT_STATS[u.type].domain;
      return d === UnitDomain.Sea ? 0 : d === UnitDomain.Air ? 1 : 2;
    };
    const units = this.attackTarget
      ? [...obs.myUnits].sort((a, b) => this.attackPriority(a) - this.attackPriority(b))
      : [...obs.myUnits].sort((a, b) => domainOrder(a) - domainOrder(b));

    for (const unit of units) {
      if (unit.carriedBy !== null) continue;

      if (unit.sleeping) {
        if (unit.movesLeft > 0) return { type: 'WAKE', unitId: unit.id };
        continue;
      }

      if (unit.movesLeft <= 0) continue;
      if (unit.hasAttacked) continue; // can't attack again; done for this turn

      const action = this.decideUnitAction(obs, unit);
      if (action) return action;

      // Completely blocked — exhaust moves to prevent infinite re-evaluation.
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
    const armyCount       = obs.myUnits.filter((u) => u.type === UnitType.Army).length;
    const transportCount  = obs.myUnits.filter((u) => u.type === UnitType.Transport).length;
    const destroyerCount  = obs.myUnits.filter((u) => u.type === UnitType.Destroyer).length;
    const carrierCount    = obs.myUnits.filter((u) => u.type === UnitType.Carrier).length;
    const battleshipCount = obs.myUnits.filter((u) => u.type === UnitType.Battleship).length;
    const fighterCount    = obs.myUnits.filter((u) => u.type === UnitType.Fighter).length;
    const bomberCount     = obs.myUnits.filter((u) => u.type === UnitType.Bomber).length;
    const cityCount       = obs.myCities.length;

    // ── Phase 1: colonise home island ────────────────────────────────────────
    // Build armies almost exclusively. One early transport at a coastal city once
    // we have 3+ armies so it's ready to sail the moment Phase 2 kicks in.
    if (this.phase === 1) {
      if (city.coastal && armyCount >= 3 && transportCount === 0) return UnitType.Transport;
      return UnitType.Army;
    }

    // ── Phase 2: expansion to other islands ──────────────────────────────────
    // Once home island is explored, keep transports flowing as long as every
    // existing transport is "useful" (carrying troops or at sea returning home).
    // An empty transport parked at a home port is idle — don't build another.
    if (this.phase === 2) {
      if (city.coastal && this.needsMoreTransports(obs)) return UnitType.Transport;
      if (city.coastal && destroyerCount < 1) return UnitType.Destroyer;
      return UnitType.Army;
    }

    // ── Phase 3: combat ───────────────────────────────────────────────────────
    // Classify this city: contested (near enemy) vs home territory.
    const combatDist = Math.min(12, Math.floor(this.mapWidth / 4));
    const isContestedCity = obs.visibleEnemyCities.some(
      (enemy) => enemy.owner !== null && this.wrappedDist(city, enemy) <= combatDist,
    );

    if (isContestedCity) {
      // On a contested island: produce armies to capture / defend cities.
      return UnitType.Army;
    }

    // Home territory in Phase 3: keep the invasion pipeline full first,
    // then invest in air and naval power.
    //
    // Transports come before expensive naval/air units — without them armies
    // pile up indefinitely and neither side can invade.
    // Bombers are high priority because more total produced = bigger blast radius
    // (upgrades at 10 and 20 cumulative).
    const submarineCount  = obs.myUnits.filter((u) => u.type === UnitType.Submarine).length;
    const wantBombers     = Math.min(10, Math.max(4, cityCount));  // blast radius unlocks at 10 & 20
    const wantFighters    = Math.min(8,  Math.ceil(cityCount * 0.6));
    const wantBattleships = Math.min(4,  Math.ceil(cityCount / 3));
    const wantDestroyers  = Math.min(4,  Math.ceil(cityCount / 3));
    const wantSubmarines  = Math.min(3,  Math.ceil(cityCount / 4));

    // Transports first — army capacity must exist before producing more armies.
    // Cap armies at ~3× transport capacity; beyond that transports are the bottleneck.
    // Only count HOME armies (not near any enemy city) so captured-island armies
    // don't mask a backlog of unshipped troops on the home island.
    const totalTransportSlots = transportCount * UNIT_STATS[UnitType.Transport].cargoCapacity;
    const combatDistLocal = Math.min(12, Math.floor(this.mapWidth / 4));
    const armiesWaiting = obs.myUnits.filter(
      (u) =>
        u.type === UnitType.Army &&
        u.carriedBy === null &&
        !obs.visibleEnemyCities.some(
          (e) => e.owner !== null && this.wrappedDist(u, e) <= combatDistLocal,
        ),
    ).length;
    if (city.coastal && this.needsMoreTransports(obs) && armiesWaiting > totalTransportSlots) {
      return UnitType.Transport;
    }

    if (bomberCount  < wantBombers)  return UnitType.Bomber;
    if (fighterCount < wantFighters) return UnitType.Fighter;

    if (city.coastal) {
      if (battleshipCount < wantBattleships) return UnitType.Battleship;
      if (destroyerCount  < wantDestroyers)  return UnitType.Destroyer;
      if (submarineCount  < wantSubmarines)  return UnitType.Submarine;
      if (fighterCount >= 3 && carrierCount === 0) return UnitType.Carrier;
      if (this.needsMoreTransports(obs)) return UnitType.Transport;
    }

    // Don't keep building armies once home armies vastly outnumber transport capacity.
    if (armiesWaiting > totalTransportSlots * 2) return UnitType.Bomber;

    // Non-coastal home city or all quotas met: build armies as strategic reserve
    return UnitType.Army;
  }

  /**
   * Returns true if we should queue another transport.
   * We need more transports when every existing transport is "useful":
   *   - carrying troops (shipping out), OR
   *   - at sea / away from home (returning to pick up more).
   * An empty transport parked at a home port is idle — no need to build another.
   */
  private needsMoreTransports(obs: AgentObservation): boolean {
    const transports = obs.myUnits.filter((u) => u.type === UnitType.Transport);
    if (transports.length === 0) return true;

    const combatDist = Math.min(12, Math.floor(this.mapWidth / 4));
    const nearEnemy = (coord: Coord) =>
      obs.visibleEnemyCities.some(
        (e) => e.owner !== null && this.wrappedDist(coord, e) <= combatDist,
      );

    // An idle transport: empty AND docked at a home (non-contested) city.
    const hasIdle = transports.some(
      (t) =>
        t.cargo.length === 0 &&
        obs.myCities.some((c) => c.x === t.x && c.y === t.y && !nearEnemy(c)),
    );
    return !hasIdle;
  }

  private decideUnitAction(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const stats = UNIT_STATS[unit.type];

    // Only attack if we can actually enter the enemy's tile (e.g. sea units can't attack armies in cities)
    const adjacentEnemy = this.findAdjacentEnemy(obs, unit);
    if (adjacentEnemy) {
      const tile = obs.tiles[adjacentEnemy.y]?.[adjacentEnemy.x];
      const canAttack =
        !tile ||
        stats.domain === UnitDomain.Air ||
        (stats.domain === UnitDomain.Land && tile.terrain === Terrain.Land) ||
        (stats.domain === UnitDomain.Sea && tile.terrain === Terrain.Ocean);
      if (canAttack) {
        return { type: 'MOVE', unitId: unit.id, to: { x: adjacentEnemy.x, y: adjacentEnemy.y } };
      }
    }

    if (stats.domain === UnitDomain.Land) return this.decideLandUnit(obs, unit);
    if (stats.domain === UnitDomain.Sea)  return this.decideSeaUnit(obs, unit);
    if (stats.domain === UnitDomain.Air)  return this.decideAirUnit(obs, unit);

    return null;
  }

  private decideLandUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    // ── STEP 1: Nearest free city reachable by land ────────────────────────────
    // Free = neutral OR enemy-owned without a visible land defender on the tile.
    const freeCities = obs.visibleEnemyCities.filter(
      (c) =>
        c.owner === null ||
        !obs.visibleEnemyUnits.some(
          (u) => UNIT_STATS[u.type].domain === UnitDomain.Land && u.x === c.x && u.y === c.y,
        ),
    );
    const freeTarget = this.nearestCity(freeCities, unit);
    if (freeTarget) {
      const move = this.moveToward(obs, unit, freeTarget);
      if (move) return move;
      // Free city exists but is unreachable by land (on another island) — fall through.
    }

    // ── STEP 2: Attack nearest reachable enemy city ────────────────────────────
    // Reached here because either no free cities are visible, or they're only accessible
    // by sea. In both cases, attack any enemy city reachable by land.
    // In full attack mode (no free cities), also chase nearby enemy units first.
    if (this.attackTarget) {
      const COMBAT_RANGE = 6;
      const nearbyEnemy = this.nearestEnemy(
        obs.visibleEnemyUnits.filter((u) => UNIT_STATS[u.type].domain !== UnitDomain.Air),
        unit,
      );
      if (nearbyEnemy && this.wrappedDist(nearbyEnemy, unit) <= COMBAT_RANGE) {
        return this.moveToward(obs, unit, nearbyEnemy);
      }
      const move = this.moveToward(obs, unit, this.attackTarget);
      if (move) return move;
    } else {
      // Expansion mode but free cities unreachable by land — try any visible enemy city.
      const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
      const target = this.nearestCity(enemyCities, unit);
      if (target) {
        const move = this.moveToward(obs, unit, target);
        if (move) return move;
      }
    }

    // ── BOARD DOCKED TRANSPORT ────────────────────────────────────────────────
    // Only in Phase 2/3: home island is done, prioritise embarking over local exploration.
    // In Phase 1 armies should keep colonising the home island, not rush to the dock.
    if (this.phase >= 2) {
    const dockedTransport = obs.myUnits.find(
      (u) =>
        u.type === UnitType.Transport &&
        u.cargo.length < UNIT_STATS[UnitType.Transport].cargoCapacity &&
        obs.myCities.some((c) => c.x === u.x && c.y === u.y),
    );
    if (dockedTransport) {
      if (
        wrappedDistX(unit.x, dockedTransport.x, this.mapWidth) <= 1 &&
        Math.abs(unit.y - dockedTransport.y) <= 1
      ) {
        return { type: 'LOAD', unitId: unit.id, transportId: dockedTransport.id };
      }
      const move = this.moveToward(obs, unit, dockedTransport);
      if (move) return move;
      // Docked transport is on another island — fall through to explore locally.
    }
    } // end phase >= 2

    // ── EXPLORE ────────────────────────────────────────────────────────────────
    // Always explore — finds neutral cities on the current island before they're
    // visible, and ensures the army contributes even when no city is yet in sight.
    const explorationMove = this.moveTowardExploration(obs, unit);
    if (explorationMove) return explorationMove;

    // ── BOARD FLOATING TRANSPORT ──────────────────────────────────────────────
    // Only board a transport that already has a good load — a transport with 1-2
    // armies that picks up one more at sea will sail off half-empty. Prefer waiting
    // at a coastal city so the transport can fill up properly at the dock.
    const halfCap = Math.ceil(UNIT_STATS[UnitType.Transport].cargoCapacity / 2);
    const transport = obs.myUnits.find(
      (u) =>
        u.type === UnitType.Transport &&
        u.cargo.length >= halfCap &&
        u.cargo.length < UNIT_STATS[UnitType.Transport].cargoCapacity,
    );
    if (transport) {
      if (
        wrappedDistX(unit.x, transport.x, this.mapWidth) <= 1 &&
        Math.abs(unit.y - transport.y) <= 1
      ) {
        return { type: 'LOAD', unitId: unit.id, transportId: transport.id };
      }
      const move = this.moveToward(obs, unit, transport);
      if (move) return move;
      // Transport is at sea and unreachable by land — fall through to wait at a coastal city.
    }

    // Wait at the nearest coastal city for a transport to arrive.
    const coastal = this.nearestCity(obs.myCities.filter((c) => c.coastal), unit);
    if (coastal) {
      if (unit.x === coastal.x && unit.y === coastal.y) {
        return { type: 'SKIP', unitId: unit.id };
      }
      return this.moveToward(obs, unit, coastal);
    }

    return null;
  }

  private decideSeaUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const stats = UNIT_STATS[unit.type];

    if (unit.type === UnitType.Transport) {
      const cap = stats.cargoCapacity;

      // Helper used in both the loading and the empty-transport sections.
      const tCombatDist = Math.min(12, Math.floor(this.mapWidth / 4));
      const nearEnemyCoord = (coord: Coord) =>
        obs.visibleEnemyCities.some(
          (e) => e.owner !== null && this.wrappedDist(coord, e) <= tCombatDist,
        );

      if (unit.cargo.length > 0) {
        // ── Top off before departing ────────────────────────────────────────
        // Don't sail with a half-empty hold. If we're still near a home port
        // and armies are within boarding range (or close enough to walk over),
        // keep loading until full or no more armies are coming.
        if (unit.cargo.length < cap) {
          // Always load any adjacent home army — no port gate.
          const moreArmy = obs.myUnits.find(
            (u) =>
              u.type === UnitType.Army &&
              u.carriedBy === null &&
              u.movesLeft > 0 &&
              !nearEnemyCoord(u) &&
              wrappedDistX(u.x, unit.x, this.mapWidth) <= 1 &&
              Math.abs(u.y - unit.y) <= 1,
          );
          if (moreArmy) return { type: 'LOAD', unitId: moreArmy.id, transportId: unit.id };
          // No adjacent army. Wait only if near a home port and armies are on their way.
          const nearHomePort = obs.myCities.some(
            (c) =>
              !nearEnemyCoord(c) &&
              wrappedDistX(unit.x, c.x, this.mapWidth) <= 1 &&
              Math.abs(unit.y - c.y) <= 1,
          );
          if (nearHomePort) {
            const armiesApproaching = obs.myUnits.some(
              (u) =>
                u.type === UnitType.Army &&
                u.carriedBy === null &&
                !nearEnemyCoord(u) &&
                this.wrappedDist(u, unit) <= 4,
            );
            if (armiesApproaching) return { type: 'SKIP', unitId: unit.id };
          }
          // Port is dry or at sea — depart with what we have.
        }

        // Engine requires cargo unit to have movesLeft > 0 to UNLOAD.
        // handleLoad sets movesLeft=0, so don't UNLOAD the same turn we loaded.
        const cargoUnit = obs.myUnits.find((u) => u.id === unit.cargo[0]);
        const canUnload = cargoUnit && cargoUnit.movesLeft > 0;

        // Conquerable = free (neutral / undefended) OR any enemy-owned city.
        const conquerableCities = obs.visibleEnemyCities.filter(
          (c) =>
            c.owner === null ||
            !obs.visibleEnemyUnits.some(
              (u) => UNIT_STATS[u.type].domain === UnitDomain.Land && u.x === c.x && u.y === c.y,
            ),
        );
        // Also treat any enemy-owned city as worth stopping for (attack mode).
        const targetableCities = obs.visibleEnemyCities.length > 0
          ? obs.visibleEnemyCities
          : [];

        // Unload when adjacent to non-friendly land that is near enemy/neutral territory.
        // We check from adjLand (not the transport position) so a transport parked at
        // a home port doesn't accidentally unload onto its own island's land tiles.
        const adjLand = this.getAdjacentLandToward(obs, unit,
          this.nearestCity([...conquerableCities, ...targetableCities], unit) ??
          this.expansionTarget ?? this.attackTarget,
        );
        if (canUnload && adjLand) {
          const onOurLand = obs.myCities.some((c) => c.x === adjLand.x && c.y === adjLand.y);
          const nearEnemyTerritory = obs.visibleEnemyCities.some(
            (c) => this.wrappedDist(adjLand, c) <= 20,
          );
          if (!onOurLand && nearEnemyTerritory) {
            return { type: 'UNLOAD', unitId: unit.cargo[0], to: adjLand };
          }
        }

        // Steer toward the nearest conquerable city; fall back to expansion/attack target.
        const deliveryTarget =
          this.nearestCity(conquerableCities, unit) ??
          this.expansionTarget ??
          this.attackTarget;
        if (deliveryTarget) {
          const move = this.moveToward(obs, unit, deliveryTarget);
          if (move) return move;
        }

        return this.moveTowardExploration(obs, unit);
      }

      // ── Empty transport: return to HOME shores and link up with armies ────────
      // Key problem: after delivering armies, captured enemy cities appear in obs.myCities.
      // Nearest "coastal city" is now on the enemy island. We must navigate toward
      // HOME armies instead — armies that are NOT near any enemy-owned city.
      const nearEnemy = nearEnemyCoord;

      // Load immediately if a home army is already adjacent
      const adjacentHomeArmy = obs.myUnits.find(
        (u) =>
          u.type === UnitType.Army &&
          u.carriedBy === null &&
          u.movesLeft > 0 &&
          unit.cargo.length < cap &&
          !nearEnemy(u) &&
          wrappedDistX(u.x, unit.x, this.mapWidth) <= 1 &&
          Math.abs(u.y - unit.y) <= 1,
      );
      if (adjacentHomeArmy) return { type: 'LOAD', unitId: adjacentHomeArmy.id, transportId: unit.id };

      // Navigate toward the home coastal city with the most waiting armies.
      // This prevents transports from fanning out to different soldiers when all
      // the armies are stacked at one city waiting for a ride.
      const homeArmies = obs.myUnits.filter(
        (u) => u.type === UnitType.Army && u.carriedBy === null && !nearEnemy(u),
      );
      if (homeArmies.length > 0) {
        let bestTarget: Coord = homeArmies[0];
        let bestCount = 0;
        for (const city of obs.myCities.filter((c) => c.coastal && !nearEnemy(c))) {
          // Count armies within radius 2 of the city, not just on the exact tile.
          // Armies one step away from a coastal city are effectively "at the dock"
          // and should attract transports just as strongly.
          const count = homeArmies.filter(
            (u) => wrappedDistX(u.x, city.x, this.mapWidth) <= 2 && Math.abs(u.y - city.y) <= 2,
          ).length;
          if (count > bestCount) { bestCount = count; bestTarget = city; }
        }
        if (bestCount === 0) {
          // No armies near any coastal city — navigate to the nearest army directly
          const nearest = this.nearestUnit(homeArmies, unit);
          if (nearest) bestTarget = nearest;
        }
        const move = this.moveToward(obs, unit, bestTarget);
        if (move) return move;
      }

      // No home armies in sight — park at the nearest home coastal city and wait
      const homeCoastalCities = obs.myCities.filter((c) => c.coastal && !nearEnemy(c));
      const pickupPort = this.nearestCity(
        homeCoastalCities.length > 0 ? homeCoastalCities : obs.myCities.filter((c) => c.coastal),
        unit,
      );
      if (pickupPort) {
        const portMove = this.moveToward(obs, unit, pickupPort);
        if (portMove) return portMove;
        // At port — load any adjacent army (army may not yet be inside the city tile)
        const boardingArmy = obs.myUnits.find(
          (u) =>
            u.type === UnitType.Army &&
            u.carriedBy === null &&
            u.movesLeft > 0 &&
            unit.cargo.length < cap &&
            wrappedDistX(u.x, unit.x, this.mapWidth) <= 1 &&
            Math.abs(u.y - unit.y) <= 1,
        );
        if (boardingArmy) return { type: 'LOAD', unitId: boardingArmy.id, transportId: unit.id };
        return { type: 'SKIP', unitId: unit.id };
      }

      // No friendly coastal ports at all — explore
      const exploreMove = this.moveTowardExploration(obs, unit);
      if (exploreMove) return exploreMove;
    }

    // ── Battleship: coastal bombardment + hunt high-value enemy ships ───────────
    // Carriers and transports are priority targets; then find the most-defended
    // enemy city and sit offshore bombarding it; finally hunt any sea unit.
    if (unit.type === UnitType.Battleship) {
      for (const prey of [UnitType.Carrier, UnitType.Transport, UnitType.Destroyer] as UnitType[]) {
        const t = this.nearestEnemy(obs.visibleEnemyUnits.filter((u) => u.type === prey), unit);
        if (t) { const m = this.moveToward(obs, unit, t); if (m) return m; }
      }
      // Coastal bombardment — pick the enemy city with the most land defenders
      const bestCity = obs.visibleEnemyCities
        .filter((c) => c.owner !== null)
        .map((c) => ({
          city: c,
          defenders: obs.visibleEnemyUnits.filter(
            (u) => u.x === c.x && u.y === c.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
          ).length,
        }))
        .sort((a, b) => b.defenders - a.defenders)[0];
      if (bestCity) { const m = this.moveToward(obs, unit, bestCity.city); if (m) return m; }
      const seaTarget = this.nearestEnemy(
        obs.visibleEnemyUnits.filter((u) => UNIT_STATS[u.type].domain === UnitDomain.Sea), unit,
      );
      if (seaTarget) return this.moveToward(obs, unit, seaTarget);
      if (this.attackTarget) { const m = this.moveToward(obs, unit, this.attackTarget); if (m) return m; }
      return this.moveTowardExploration(obs, unit);
    }

    // ── Destroyer: hunt submarines and transports ────────────────────────────
    if (unit.type === UnitType.Destroyer) {
      for (const prey of [UnitType.Submarine, UnitType.Transport] as UnitType[]) {
        const t = this.nearestEnemy(obs.visibleEnemyUnits.filter((u) => u.type === prey), unit);
        if (t) { const m = this.moveToward(obs, unit, t); if (m) return m; }
      }
      const seaTarget = this.nearestEnemy(
        obs.visibleEnemyUnits.filter((u) => UNIT_STATS[u.type].domain === UnitDomain.Sea), unit,
      );
      if (seaTarget) return this.moveToward(obs, unit, seaTarget);
      const target = this.attackTarget ?? this.expansionTarget;
      if (target) { const m = this.moveToward(obs, unit, target); if (m) return m; }
      return this.moveTowardExploration(obs, unit);
    }

    // ── Submarine: hunt transports and carriers ──────────────────────────────
    if (unit.type === UnitType.Submarine) {
      for (const prey of [UnitType.Transport, UnitType.Carrier] as UnitType[]) {
        const t = this.nearestEnemy(obs.visibleEnemyUnits.filter((u) => u.type === prey), unit);
        if (t) { const m = this.moveToward(obs, unit, t); if (m) return m; }
      }
      const seaTarget = this.nearestEnemy(
        obs.visibleEnemyUnits.filter((u) => UNIT_STATS[u.type].domain === UnitDomain.Sea), unit,
      );
      if (seaTarget) return this.moveToward(obs, unit, seaTarget);
      return this.moveTowardExploration(obs, unit);
    }

    // ── Carrier: follow the fleet toward the front; avoid leading attacks ─────
    const target = this.attackTarget ?? this.expansionTarget;
    if (target) { const m = this.moveToward(obs, unit, target); if (m) return m; }
    return this.moveTowardExploration(obs, unit);
  }

  private decideAirUnit(obs: AgentObservation, unit: UnitView): AgentAction | null {
    // Always refuel first if low
    if (unit.fuel !== undefined) {
      const carrier = obs.myUnits.find((u) => u.type === UnitType.Carrier);
      const refuelBase = carrier
        ? this.nearestUnit([carrier], unit) ?? this.nearestCity(obs.myCities, unit)
        : this.nearestCity(obs.myCities, unit);
      if (refuelBase) {
        const distToRefuel = this.wrappedDist(unit, refuelBase);
        // Head home if we can't safely advance further (keep 1-turn buffer)
        if (unit.fuel <= distToRefuel + 1) {
          return this.moveToward(obs, unit, refuelBase);
        }
      }
    }

    // ── Bomber: hunt transports, then bomb the densest enemy cluster ─────────
    if (unit.type === UnitType.Bomber) {
      // Transports are defenceless against air and extremely valuable targets
      const transport = this.nearestEnemy(
        obs.visibleEnemyUnits.filter((u) => u.type === UnitType.Transport), unit,
      );
      if (transport) return this.moveToward(obs, unit, transport);

      // Find the tile with the most enemy units stacked on it
      const posCounts = new Map<string, { coord: Coord; count: number }>();
      for (const u of obs.visibleEnemyUnits) {
        const k = `${u.x},${u.y}`;
        const e = posCounts.get(k) ?? { coord: { x: u.x, y: u.y }, count: 0 };
        e.count++;
        posCounts.set(k, e);
      }
      const densest = [...posCounts.values()].sort((a, b) => b.count - a.count)[0];
      if (densest) { const m = this.moveToward(obs, unit, densest.coord); if (m) return m; }

      if (this.attackTarget) { const m = this.moveToward(obs, unit, this.attackTarget); if (m) return m; }
    }

    // ── Fighter: hunt transports and bombers, then clear air, then support attack ─
    if (unit.type === UnitType.Fighter) {
      // Transports and bombers are high-value soft targets
      for (const prey of [UnitType.Transport, UnitType.Bomber] as UnitType[]) {
        const t = this.nearestEnemy(obs.visibleEnemyUnits.filter((u) => u.type === prey), unit);
        if (t) return this.moveToward(obs, unit, t);
      }
      // Sweep enemy air units
      const airTarget = this.nearestEnemy(
        obs.visibleEnemyUnits.filter((u) => UNIT_STATS[u.type].domain === UnitDomain.Air), unit,
      );
      if (airTarget) return this.moveToward(obs, unit, airTarget);
      // Clear defenders near the attack target
      if (this.attackTarget) {
        const nearTargetEnemies = obs.visibleEnemyUnits.filter(
          (u) => this.wrappedDist(u, this.attackTarget!) <= 3,
        );
        const t = this.nearestEnemy(nearTargetEnemies, unit);
        if (t) return this.moveToward(obs, unit, t);
        const m = this.moveToward(obs, unit, this.attackTarget);
        if (m) return m;
      }
    }

    // Generic fallback: attack nearest visible enemy, or scout
    const enemy = this.nearestEnemy(obs.visibleEnemyUnits, unit);
    if (enemy) return this.moveToward(obs, unit, enemy);

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

        // Unexplored (null) tiles are the best exploration target; hidden tiles second.
        if (!tile || tile.visibility === TileVisibility.Hidden) {
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
}
