/**
 * MapQuery — per-turn cached spatial queries for the BasicAgent.
 *
 * Two independent axes for every island:
 *   friendly  = all visible cities belong to us
 *   explored  = every land tile has been seen (not Hidden)
 *
 * An island can be friendly+unexplored, contested+explored, etc.
 */

import type { AgentObservation } from './agent.js';
import type { UnitView, CityView, Coord } from './types.js';
import { UnitType, UnitDomain, UNIT_STATS, Terrain, TileVisibility, wrapX, wrappedDistX } from './types.js';

// ── Island classification result ─────────────────────────────────────────────

export interface IslandInfo {
  /** "x,y" → island index for every known land tile */
  islandOf: Map<string, number>;
  /** Islands where all visible cities belong to us */
  friendlyIndices: Set<number>;
  /** Islands that are not friendly (enemy/neutral cities or no cities) */
  contestedIndices: Set<number>;
  /** Islands where every land tile has been seen */
  exploredIslands: Set<number>;
}

// ── MapQuery ─────────────────────────────────────────────────────────────────

export class MapQuery {
  private readonly mapWidth: number;
  private readonly mapHeight: number;

  // Per-turn cache
  private cachedTurn: number = -1;
  private cachedIslands!: IslandInfo;

  constructor(mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  // ── Island classification ──────────────────────────────────────────────────

  /** Flood-fill land tiles to find connected islands, then classify each. */
  classifyIslands(obs: AgentObservation): IslandInfo {
    if (this.cachedTurn === obs.turn) return this.cachedIslands;

    const tiles = obs.tiles;
    const h = tiles.length;
    const w = tiles[0]?.length ?? 0;

    const visited = new Set<string>();
    const islandOf = new Map<string, number>();
    let islandCount = 0;

    for (let y = 1; y < h - 1; y++) {
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

    // Group cities by island
    const myCityIds = new Set(obs.myCities.map((c) => c.id));
    const allCities = [...obs.myCities, ...obs.visibleEnemyCities];
    const citiesOnIsland = new Map<number, typeof allCities>();
    for (const city of allCities) {
      const idx = islandOf.get(`${city.x},${city.y}`);
      if (idx === undefined) continue;
      if (!citiesOnIsland.has(idx)) citiesOnIsland.set(idx, []);
      citiesOnIsland.get(idx)!.push(city);
    }

    const friendlyIndices = new Set<number>();
    const contestedIndices = new Set<number>();
    const exploredIslands = new Set<number>();

    for (let i = 0; i < islandCount; i++) {
      // Friendly = all visible cities on island belong to us
      const cities = citiesOnIsland.get(i);
      if (cities && cities.length > 0 && cities.every((c) => myCityIds.has(c.id))) {
        friendlyIndices.add(i);
      } else {
        contestedIndices.add(i);
      }

      // Explored = every land tile on island has been seen
      let allSeen = true;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 0; x < w; x++) {
          if (islandOf.get(`${x},${y}`) !== i) continue;
          const tile = tiles[y]?.[x];
          if (!tile || tile.terrain !== Terrain.Land) continue;
          if (tile.visibility === TileVisibility.Hidden) {
            allSeen = false;
            break;
          }
        }
        if (!allSeen) break;
      }
      if (allSeen) exploredIslands.add(i);
    }

    this.cachedIslands = { islandOf, friendlyIndices, contestedIndices, exploredIslands };
    this.cachedTurn = obs.turn;
    return this.cachedIslands;
  }

  // ── Island single-property queries ─────────────────────────────────────────

  /** Get island index for a land position. */
  getIslandIdx(x: number, y: number, obs: AgentObservation): number | undefined {
    return this.classifyIslands(obs).islandOf.get(`${x},${y}`);
  }

  /** Get island index for any position (land or ocean — checks neighbors for sea tiles). */
  getIslandIdxForUnit(x: number, y: number, obs: AgentObservation): number | undefined {
    const { islandOf } = this.classifyIslands(obs);
    const idx = islandOf.get(`${x},${y}`);
    if (idx !== undefined) return idx;
    // Sea unit: check adjacent land tiles
    for (const adj of this.getAdjacentTiles(x, y)) {
      const adjIdx = islandOf.get(`${adj.x},${adj.y}`);
      if (adjIdx !== undefined) return adjIdx;
    }
    return undefined;
  }

  /** Is island friendly (all visible cities ours)? */
  isIslandFriendly(islandIdx: number | undefined, obs: AgentObservation): boolean {
    if (islandIdx === undefined) return false;
    return this.classifyIslands(obs).friendlyIndices.has(islandIdx);
  }

  /** Is island explored (all land tiles seen)? */
  isIslandExplored(islandIdx: number | undefined, obs: AgentObservation): boolean {
    if (islandIdx === undefined) return false;
    return this.classifyIslands(obs).exploredIslands.has(islandIdx);
  }

  /** Is island contested (has enemy/neutral cities, or no cities)? */
  isIslandContested(islandIdx: number | undefined, obs: AgentObservation): boolean {
    if (islandIdx === undefined) return false;
    return this.classifyIslands(obs).contestedIndices.has(islandIdx);
  }

  /** Does island have enemy-owned cities? (stricter than contested — excludes neutral-only) */
  islandHasEnemyCities(islandIdx: number | undefined, obs: AgentObservation): boolean {
    if (islandIdx === undefined) return false;
    const { islandOf } = this.classifyIslands(obs);
    return obs.visibleEnemyCities.some((c) => {
      if (c.owner === null) return false;
      return islandOf.get(`${c.x},${c.y}`) === islandIdx;
    });
  }

  // ── Locate nearest island by category ──────────────────────────────────────

  /** Locate nearest friendly island (by coastal ocean tile). Returns ocean coord to sail to. */
  locateNearestFriendlyIsland(from: Coord, obs: AgentObservation): Coord | null {
    const { islandOf, friendlyIndices } = this.classifyIslands(obs);
    return this.locateNearestIslandBySet(from, obs, friendlyIndices, islandOf);
  }

  /** Locate nearest contested island (by coastal ocean tile). Returns ocean coord to sail to. */
  locateNearestContestedIsland(from: Coord, obs: AgentObservation): Coord | null {
    const { islandOf, contestedIndices } = this.classifyIslands(obs);
    return this.locateNearestIslandBySet(from, obs, contestedIndices, islandOf);
  }

  /** Locate nearest unexplored island (by coastal ocean tile). Returns ocean coord to sail to. */
  locateNearestUnexploredIsland(from: Coord, obs: AgentObservation): Coord | null {
    const { islandOf, exploredIslands } = this.classifyIslands(obs);
    // Find islands that are NOT explored
    const allIslands = new Set<number>();
    for (const idx of islandOf.values()) allIslands.add(idx);
    const unexploredSet = new Set<number>();
    for (const idx of allIslands) {
      if (!exploredIslands.has(idx)) unexploredSet.add(idx);
    }
    if (unexploredSet.size === 0) return null;
    return this.locateNearestIslandBySet(from, obs, unexploredSet, islandOf);
  }

  /** Find nearest coastal ocean tile adjacent to any island in the given set. */
  private locateNearestIslandBySet(
    from: Coord,
    obs: AgentObservation,
    islandSet: Set<number>,
    islandOf: Map<string, number>,
  ): Coord | null {
    if (islandSet.size === 0) return null;
    const h = obs.tiles.length;
    const w = obs.tiles[0]?.length ?? 0;

    let best: Coord | null = null;
    let bestDist = Infinity;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = obs.tiles[y]?.[x];
        if (!tile || tile.terrain !== Terrain.Ocean) continue;

        // Is this ocean tile adjacent to an island in the set?
        for (const adj of this.getAdjacentTiles(x, y)) {
          const adjIdx = islandOf.get(`${adj.x},${adj.y}`);
          if (adjIdx !== undefined && islandSet.has(adjIdx)) {
            const dist = this.wrappedDist(from, { x, y });
            if (dist < bestDist) {
              bestDist = dist;
              best = { x, y };
            }
            break; // No need to check other neighbors
          }
        }
      }
    }
    return best;
  }

  // ── Locate nearest tiles ───────────────────────────────────────────────────

  /** Locate nearest unexplored (Hidden) land tile. */
  locateNearestUnexploredLand(from: Coord, obs: AgentObservation): Coord | null {
    return this.findNearestTile(obs, from, Terrain.Land, TileVisibility.Hidden);
  }

  /** Locate nearest unexplored (Hidden) ocean tile. */
  locateNearestUnexploredOcean(from: Coord, obs: AgentObservation): Coord | null {
    return this.findNearestTile(obs, from, Terrain.Ocean, TileVisibility.Hidden);
  }

  /** Locate nearest unexplored land tile on a specific island. */
  locateNearestUnexploredLandOnIsland(from: Coord, islandIdx: number, obs: AgentObservation): Coord | null {
    const { islandOf } = this.classifyIslands(obs);
    const h = obs.tiles.length;
    const w = obs.tiles[0]?.length ?? 0;
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        if (islandOf.get(`${x},${y}`) !== islandIdx) continue;
        const tile = obs.tiles[y]?.[x];
        if (!tile || tile.terrain !== Terrain.Land) continue;
        if (tile.visibility !== TileVisibility.Hidden) continue;
        const dist = this.wrappedDist(from, { x, y });
        if (dist < bestDist) { bestDist = dist; best = { x, y }; }
      }
    }
    return best;
  }

  // ── Locate cities ──────────────────────────────────────────────────────────

  /** Locate nearest neutral city reachable by the given unit. */
  locateNearestNeutralCity(unit: UnitView, obs: AgentObservation): CityView | null {
    const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
    let best: CityView | null = null;
    let bestDist = Infinity;
    for (const city of neutralCities) {
      const dist = this.wrappedDist(unit, city);
      if (dist < bestDist && this.canReachByBFS(obs, unit, city)) {
        bestDist = dist;
        best = city;
      }
    }
    return best;
  }

  /** Locate nearest neutral city on the same island as the unit. */
  locateNearestNeutralCityOnIsland(unit: UnitView, obs: AgentObservation): CityView | null {
    const { islandOf } = this.classifyIslands(obs);
    const myIslandIdx = islandOf.get(`${unit.x},${unit.y}`);
    if (myIslandIdx === undefined) return null;
    const neutralCities = obs.visibleEnemyCities.filter((c) => {
      if (c.owner !== null) return false;
      return islandOf.get(`${c.x},${c.y}`) === myIslandIdx;
    });
    let best: CityView | null = null;
    let bestDist = Infinity;
    for (const city of neutralCities) {
      const dist = this.wrappedDist(unit, city);
      if (dist < bestDist && this.canReachByBFS(obs, unit, city)) {
        bestDist = dist;
        best = city;
      }
    }
    return best;
  }

  /** Locate nearest enemy-owned city reachable by the given unit. */
  locateNearestEnemyCity(unit: UnitView, obs: AgentObservation): CityView | null {
    const enemies = obs.visibleEnemyCities.filter((c) => c.owner !== null);
    let best: CityView | null = null;
    let bestDist = Infinity;
    for (const city of enemies) {
      const dist = this.wrappedDist(unit, city);
      if (dist < bestDist && this.canReachByBFS(obs, unit, city)) {
        bestDist = dist;
        best = city;
      }
    }
    return best;
  }

  /** Locate nearest enemy city on the same island. */
  locateNearestEnemyCityOnIsland(unit: UnitView, obs: AgentObservation): CityView | null {
    const { islandOf } = this.classifyIslands(obs);
    const myIslandIdx = islandOf.get(`${unit.x},${unit.y}`);
    if (myIslandIdx === undefined) return null;
    const enemies = obs.visibleEnemyCities.filter((c) => {
      if (c.owner === null) return false;
      return islandOf.get(`${c.x},${c.y}`) === myIslandIdx;
    });
    let best: CityView | null = null;
    let bestDist = Infinity;
    for (const city of enemies) {
      const dist = this.wrappedDist(unit, city);
      if (dist < bestDist && this.canReachByBFS(obs, unit, city)) {
        bestDist = dist;
        best = city;
      }
    }
    return best;
  }

  /** Locate nearest friendly coastal city. */
  locateNearestFriendlyCoastalCity(from: Coord, obs: AgentObservation): Coord | null {
    const { islandOf, friendlyIndices } = this.classifyIslands(obs);
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (const city of obs.myCities) {
      const idx = islandOf.get(`${city.x},${city.y}`);
      if (idx === undefined || !friendlyIndices.has(idx)) continue;
      if (!this.isCityCoastal(city, obs)) continue;
      const dist = this.wrappedDist(from, city);
      if (dist < bestDist) { bestDist = dist; best = city; }
    }
    return best;
  }

  /** Locate nearest friendly city (any, not just coastal). */
  locateNearestFriendlyCity(from: Coord, obs: AgentObservation): Coord | null {
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (const city of obs.myCities) {
      const dist = this.wrappedDist(from, city);
      if (dist < bestDist) { bestDist = dist; best = city; }
    }
    return best;
  }

  /** Is a city coastal (has at least one adjacent ocean tile)? */
  isCityCoastal(city: Coord, obs: AgentObservation): boolean {
    for (const adj of this.getAdjacentTiles(city.x, city.y)) {
      if (adj.y <= 0 || adj.y >= this.mapHeight - 1) continue;
      const tile = obs.tiles[adj.y]?.[adj.x];
      if (tile && tile.terrain === Terrain.Ocean) return true;
    }
    return false;
  }

  // ── Transport / cargo queries ──────────────────────────────────────────────

  /** Find nearest transport with room that is adjacent to the unit. */
  findAdjacentTransportWithRoom(unit: UnitView, obs: AgentObservation): UnitView | null {
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    for (const adj of this.getAdjacentTiles(unit.x, unit.y)) {
      const transport = obs.myUnits.find(
        (u) => u.type === UnitType.Transport && u.x === adj.x && u.y === adj.y &&
               u.carriedBy === null && u.cargo.length < cap,
      );
      if (transport) return transport;
    }
    return null;
  }

  /** Find a transport with room parked offshore at the same island as the unit. */
  findTransportOnIsland(unit: UnitView, obs: AgentObservation): UnitView | null {
    const islandIdx = this.getIslandIdx(unit.x, unit.y, obs);
    if (islandIdx === undefined) return null;
    const cap = UNIT_STATS[UnitType.Transport].cargoCapacity;
    let best: UnitView | null = null;
    let bestDist = Infinity;
    for (const t of obs.myUnits) {
      if (t.type !== UnitType.Transport) continue;
      if (t.cargo.length >= cap) continue;
      const tIsland = this.getIslandIdxForUnit(t.x, t.y, obs);
      if (tIsland !== islandIdx) continue;
      // Must be on ocean (offshore)
      const tile = obs.tiles[t.y]?.[t.x];
      if (!tile || tile.terrain !== Terrain.Ocean) continue;
      const dist = this.wrappedDist(unit, t);
      if (dist < bestDist) { bestDist = dist; best = t; }
    }
    return best;
  }

  /** Can a carried army disembark to a non-friendly or unexplored island from the transport? */
  canDisembark(transport: UnitView, obs: AgentObservation): Coord | null {
    const { islandOf, friendlyIndices, exploredIslands } = this.classifyIslands(obs);
    const adjacentLand = this.getAdjacentLandTiles(obs, transport.x, transport.y);
    for (const land of adjacentLand) {
      const landIdx = islandOf.get(`${land.x},${land.y}`);
      if (landIdx === undefined) continue;
      const isFriendlyAndExplored = friendlyIndices.has(landIdx) && exploredIslands.has(landIdx);
      if (!isFriendlyAndExplored) return land;
    }
    return null;
  }

  /** Is there another transport at the same island with equal or fewer armies? */
  anotherTransportWithFewerArmies(transport: UnitView, obs: AgentObservation): boolean {
    const currentIsland = this.getIslandIdxForUnit(transport.x, transport.y, obs);
    if (currentIsland === undefined) return false;
    for (const u of obs.myUnits) {
      if (u.type !== UnitType.Transport || u.id === transport.id) continue;
      if (u.carriedBy !== null) continue;
      const uIsland = this.getIslandIdxForUnit(u.x, u.y, obs);
      if (uIsland !== currentIsland) continue;
      if (u.cargo.length <= transport.cargo.length) return true;
    }
    return false;
  }

  /** Get the friendly island with the most armies on it. Returns island index. */
  friendlyIslandWithMostArmies(obs: AgentObservation): number | null {
    const { islandOf, friendlyIndices } = this.classifyIslands(obs);
    const counts = new Map<number, number>();
    for (const u of obs.myUnits) {
      if (u.type !== UnitType.Army || u.carriedBy !== null) continue;
      const idx = islandOf.get(`${u.x},${u.y}`);
      if (idx !== undefined && friendlyIndices.has(idx)) {
        counts.set(idx, (counts.get(idx) || 0) + 1);
      }
    }
    let maxIdx: number | null = null;
    let maxN = -1;
    for (const [idx, n] of counts) {
      if (n > maxN) { maxN = n; maxIdx = idx; }
    }
    return maxIdx;
  }

  // ── Enemy queries ──────────────────────────────────────────────────────────

  /** Find nearest enemy unit of given types within movement range. */
  findEnemyInRange(unit: UnitView, obs: AgentObservation, targetTypes: UnitType[]): UnitView | null {
    let best: UnitView | null = null;
    let bestDist = Infinity;
    for (const e of obs.visibleEnemyUnits) {
      if (!targetTypes.includes(e.type)) continue;
      const dist = this.wrappedDist(unit, e);
      if (dist <= unit.movesLeft && dist < bestDist) {
        bestDist = dist;
        best = e;
      }
    }
    return best;
  }

  /** Find nearest enemy city with defenders (for bombardment). */
  findEnemyCityWithDefenders(from: Coord, obs: AgentObservation, maxRange?: number): CityView | null {
    let best: CityView | null = null;
    let bestDist = Infinity;
    for (const city of obs.visibleEnemyCities) {
      if (city.owner === null) continue;
      const hasDefender = obs.visibleEnemyUnits.some(
        (u) => u.x === city.x && u.y === city.y && UNIT_STATS[u.type].domain === UnitDomain.Land,
      );
      if (!hasDefender) continue;
      const dist = this.wrappedDist(from, city);
      if (maxRange !== undefined && dist > maxRange) continue;
      if (dist < bestDist) { bestDist = dist; best = city; }
    }
    return best;
  }

  /** Find nearest enemy-owned city with visible land troops on it. */
  locateEnemyCityWithTroops(from: Coord, obs: AgentObservation, maxRange?: number): CityView | null {
    return this.findEnemyCityWithDefenders(from, obs, maxRange);
  }

  /**
   * Hunt for enemy shipping using per-unit priorities:
   *
   * Submarines (hunter-killer):
   *   Tier 0: Loaded transports
   *   Tier 1: Carriers, Battleships (high-value capital ships)
   *   Tier 2: Other submarines
   *   Tier 3: Destroyers
   *
   * Destroyers (ASW):
   *   Tier 0: Loaded transports
   *   Tier 1: Enemy submarines (primary ASW target)
   *   Tier 2: Destroyers (peer engagement)
   *   Tier 3: Other ships
   *
   * Within each tier, pick nearest; ties break by higher build value.
   */
  huntForEnemyShipping(unit: UnitView, obs: AgentObservation, maxRange?: number): UnitView | null {
    let best: UnitView | null = null;
    let bestTier = Infinity;
    let bestDist = Infinity;
    let bestValue = -1;

    for (const e of obs.visibleEnemyUnits) {
      const tier = this.getTargetTier(unit.type, e.type, e.cargo.length > 0);
      if (tier === Infinity) continue; // Not a valid target for this unit type

      const dist = this.wrappedDist(unit, e);
      if (maxRange !== undefined && dist > maxRange) continue;

      const value = UNIT_STATS[e.type].buildTime;

      const better =
        tier < bestTier ||
        (tier === bestTier && dist < bestDist) ||
        (tier === bestTier && dist === bestDist && value > bestValue);

      if (better) {
        best = e;
        bestTier = tier;
        bestDist = dist;
        bestValue = value;
      }
    }

    return best;
  }

  /**
   * Get target priority tier for a given unit type vs target.
   * Returns Infinity if target is not a valid target for this unit type.
   */
  private getTargetTier(attacker: UnitType, target: UnitType, targetIsLoaded: boolean): number {
    if (targetIsLoaded && target === UnitType.Transport) {
      return 0; // Loaded transports are always top priority
    }

    switch (attacker) {
      case UnitType.Submarine:
        // Hunter-killer: capital ships > other subs > destroyers
        if (target === UnitType.Carrier || target === UnitType.Battleship) return 1;
        if (target === UnitType.Submarine) return 2;
        if (target === UnitType.Destroyer) return 3;
        return Infinity;

      case UnitType.Destroyer:
        // ASW: subs > destroyers > other ships > empty transports
        if (target === UnitType.Submarine) return 1;
        if (target === UnitType.Destroyer) return 2;
        if (target === UnitType.Carrier || target === UnitType.Battleship) return 3;
        if (target === UnitType.Transport) return 4;
        return Infinity;

      case UnitType.Battleship:
        // Capital ship: destroyers > carriers > other battleships
        if (target === UnitType.Destroyer) return 1;
        if (target === UnitType.Carrier) return 2;
        if (target === UnitType.Battleship) return 3;
        return Infinity;

      default:
        return Infinity;
    }
  }

  /**
   * Find highest-priority bomber target across the entire visible map.
   * Score = production cost (buildTime), with special multipliers:
   * - Enemy city with defenders AND friendly unit within 2 squares: *999
   * - Enemy transport with >=1 army: *3
   * Returns the target coordinate (unit or city location).
   */
  findBomberTarget(unit: UnitView, obs: AgentObservation): Coord | null {
    const maxFuel = UNIT_STATS[unit.type].maxFuel ?? 100;
    type Target = { x: number; y: number; score: number; dist: number };
    const targets: Target[] = [];

    // Score all visible enemy units by production cost
    for (const u of obs.visibleEnemyUnits) {
      if (this.wrappedDist(unit, u) > maxFuel) continue;
      let score = UNIT_STATS[u.type].buildTime;

      // Transport with at least 1 army: multiply by 3
      if (u.type === UnitType.Transport && u.cargo.length >= 1) {
        score *= 3;
      }

      targets.push({ x: u.x, y: u.y, score, dist: this.wrappedDist(unit, u) });
    }

    // Score enemy cities
    for (const city of obs.visibleEnemyCities) {
      if (city.owner === null) continue;
      if (this.wrappedDist(unit, city) > maxFuel) continue;

      const defenders = obs.visibleEnemyUnits.filter(
        (u) => u.x === city.x && u.y === city.y,
      );

      // City with defenders AND friendly unit within 2 squares: score * 999
      if (defenders.length > 0) {
        const friendlyNear = obs.myUnits.some(
          (u) => u.type === UnitType.Army && this.wrappedDist(u, city) <= 2,
        );
        if (friendlyNear) {
          targets.push({ x: city.x, y: city.y, score: 999, dist: this.wrappedDist(unit, city) });
          continue;
        }
      }

      // Otherwise city has no production cost value (skip)
    }

    if (targets.length === 0) return null;

    // Return highest score target (prefer closer if tied)
    targets.sort((a, b) => b.score - a.score || a.dist - b.dist);
    return { x: targets[0].x, y: targets[0].y };
  }

  /** Find enemy transport with cargo (bomber/fighter target). */
  findEnemyTransportWithCargo(from: Coord, obs: AgentObservation, maxRange: number): UnitView | null {
    let best: UnitView | null = null;
    let bestDist = Infinity;
    for (const e of obs.visibleEnemyUnits) {
      if (e.type !== UnitType.Transport || e.cargo.length === 0) continue;
      const dist = this.wrappedDist(from, e);
      if (dist > maxRange) continue;
      if (dist < bestDist) { bestDist = dist; best = e; }
    }
    return best;
  }

  /** Find area with at least `minValue` enemy production value (bomber area target). */
  findHighValueEnemyCluster(from: Coord, obs: AgentObservation, maxRange: number, minValue: number): UnitView | null {
    let best: UnitView | null = null;
    let bestValue = -1;
    for (const e of obs.visibleEnemyUnits) {
      if (this.wrappedDist(from, e) > maxRange) continue;
      let areaValue = 0;
      for (const e2 of obs.visibleEnemyUnits) {
        if (this.wrappedDist(e, e2) <= 1) areaValue += UNIT_STATS[e2.type].buildTime;
      }
      if (areaValue >= minValue && areaValue > bestValue) {
        bestValue = areaValue;
        best = e;
      }
    }
    return best;
  }

  /** Find friendly city under attack (enemy army within `radius` squares). */
  findCityUnderAttack(obs: AgentObservation, radius: number): CityView | null {
    for (const city of obs.myCities) {
      for (const e of obs.visibleEnemyUnits) {
        if (e.type === UnitType.Army && this.wrappedDist(e, city) <= radius) return city;
      }
    }
    return null;
  }

  /** Find friendly city within `radius` of enemy city or enemy units worth `minValue`+. */
  findConflictZoneCity(from: Coord, obs: AgentObservation, radius: number): Coord | null {
    const conflictCities = obs.myCities.filter((c) => {
      const enemyCityNear = obs.visibleEnemyCities.some(
        (e) => e.owner !== null && this.wrappedDist(c, e) <= radius,
      );
      const enemyUnitNear = obs.visibleEnemyUnits.some((e) => this.wrappedDist(c, e) <= radius);
      return enemyCityNear || enemyUnitNear;
    });
    if (conflictCities.length === 0) return null;
    // Already at one? stay
    if (conflictCities.some((c) => c.x === from.x && c.y === from.y)) return from;
    // Return nearest
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (const c of conflictCities) {
      const dist = this.wrappedDist(from, c);
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    return best;
  }

  // ── Pathfinding ────────────────────────────────────────────────────────────

  /**
   * BFS from unit toward target. Returns the first step (single adjacent tile)
   * on the shortest path, or null if unreachable.
   */
  bestStepToward(obs: AgentObservation, unit: UnitView, target: Coord): Coord | null {
    const canEnter = this.makeCanEnter(obs, unit);
    const visited = new Set<string>();
    visited.add(`${unit.x},${unit.y}`);
    const queue: Array<{ x: number; y: number; first: Coord | null }> = [
      { x: unit.x, y: unit.y, first: null },
    ];
    const MAX = this.mapWidth * this.mapHeight;
    while (queue.length > 0 && visited.size < MAX) {
      const cur = queue.shift()!;
      const neighbors = this.getAdjacentTiles(cur.x, cur.y)
        .filter((n) => n.y > 0 && n.y < this.mapHeight - 1)
        .sort((a, b) => this.wrappedDist(a, target) - this.wrappedDist(b, target));
      for (const n of neighbors) {
        const k = `${n.x},${n.y}`;
        if (visited.has(k)) continue;
        visited.add(k);
        const firstStep = cur.first ?? n;
        if (n.x === target.x && n.y === target.y) {
          if (!canEnter(n.x, n.y)) {
            // Can't enter target (sea unit at enemy city) — return step just before
            if (firstStep.x === n.x && firstStep.y === n.y) return null;
            return firstStep;
          }
          return firstStep;
        }
        if (!canEnter(n.x, n.y)) continue;
        queue.push({ x: n.x, y: n.y, first: firstStep });
      }
    }
    return null;
  }

  /**
   * BFS bounded by `unit.movesLeft`. Returns the first step (adjacent tile) that
   * gets the unit closest to `target` within its remaining movement range.
   */
  farthestStepToward(obs: AgentObservation, unit: UnitView, target: Coord): Coord | null {
    const canEnter = this.makeCanEnter(obs, unit);
    const visited = new Set<string>();
    visited.add(`${unit.x},${unit.y}`);
    const queue: Array<{ x: number; y: number; dist: number; first: Coord }> = [];

    let bestStep: Coord | null = null;
    let bestDistToTarget = this.wrappedDist(unit, target);

    for (const adj of this.getAdjacentTiles(unit.x, unit.y)) {
      if (adj.y <= 0 || adj.y >= this.mapHeight - 1) continue;
      const k = `${adj.x},${adj.y}`;
      if (visited.has(k)) continue;
      visited.add(k);
      if (!canEnter(adj.x, adj.y)) continue;
      const d = this.wrappedDist(adj, target);
      if (d < bestDistToTarget) { bestDistToTarget = d; bestStep = adj; }
      if (unit.movesLeft > 1) queue.push({ x: adj.x, y: adj.y, dist: 1, first: adj });
    }

    const MAX = this.mapWidth * this.mapHeight;
    while (queue.length > 0 && visited.size < MAX) {
      const cur = queue.shift()!;
      if (cur.dist >= unit.movesLeft) continue;
      for (const n of this.getAdjacentTiles(cur.x, cur.y)) {
        if (n.y <= 0 || n.y >= this.mapHeight - 1) continue;
        const k = `${n.x},${n.y}`;
        if (visited.has(k)) continue;
        visited.add(k);
        if (!canEnter(n.x, n.y)) continue;
        const d = this.wrappedDist(n, target);
        if (d < bestDistToTarget) { bestDistToTarget = d; bestStep = cur.first; }
        queue.push({ x: n.x, y: n.y, dist: cur.dist + 1, first: cur.first });
      }
    }
    return bestStep;
  }

  /** BFS reachability check — can the unit reach `target` at all? */
  canReachByBFS(obs: AgentObservation, unit: UnitView, target: Coord): boolean {
    return this.bestStepToward(obs, unit, target) !== null;
  }

  // ── Adjacency helpers ──────────────────────────────────────────────────────

  /** Get 8 neighbors with X-axis wrapping. */
  getAdjacentTiles(x: number, y: number): Coord[] {
    return [
      { x: wrapX(x - 1, this.mapWidth), y: y - 1 },
      { x,                               y: y - 1 },
      { x: wrapX(x + 1, this.mapWidth), y: y - 1 },
      { x: wrapX(x - 1, this.mapWidth), y        },
      { x: wrapX(x + 1, this.mapWidth), y        },
      { x: wrapX(x - 1, this.mapWidth), y: y + 1 },
      { x,                               y: y + 1 },
      { x: wrapX(x + 1, this.mapWidth), y: y + 1 },
    ];
  }

  /** Get adjacent land tiles. */
  getAdjacentLandTiles(obs: AgentObservation, x: number, y: number): Coord[] {
    return this.getAdjacentTiles(x, y).filter((c) => {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) return false;
      const tile = obs.tiles[c.y]?.[c.x];
      return tile !== undefined && tile.terrain === Terrain.Land;
    });
  }

  /** Get first adjacent ocean tile (prefers coastal). */
  getAdjacentOceanTile(obs: AgentObservation, x: number, y: number): Coord | null {
    let anyOcean: Coord | null = null;
    for (const c of this.getAdjacentTiles(x, y)) {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) continue;
      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile || tile.terrain !== Terrain.Ocean) continue;
      if (anyOcean === null) anyOcean = c;
      // Prefer coastal (adjacent to land)
      for (const a of this.getAdjacentTiles(c.x, c.y)) {
        const at = obs.tiles[a.y]?.[a.x];
        if (at && at.terrain === Terrain.Land) return c;
      }
    }
    return anyOcean;
  }

  /** Get all adjacent coastal ocean tiles. */
  getAdjacentCoastalOcean(obs: AgentObservation, x: number, y: number): Coord[] {
    return this.getAdjacentTiles(x, y).filter((c) => {
      if (c.y <= 0 || c.y >= this.mapHeight - 1) return false;
      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile || tile.terrain !== Terrain.Ocean) return false;
      return this.getAdjacentTiles(c.x, c.y).some((a) => {
        const at = obs.tiles[a.y]?.[a.x];
        return at !== undefined && at.terrain === Terrain.Land;
      });
    });
  }

  // ── Distance ───────────────────────────────────────────────────────────────

  wrappedDist(a: Coord, b: Coord): number {
    return wrappedDistX(a.x, b.x, this.mapWidth) + Math.abs(a.y - b.y);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private findNearestTile(
    obs: AgentObservation, from: Coord, terrain: Terrain, visibility: TileVisibility,
  ): Coord | null {
    const h = obs.tiles.length;
    const w = obs.tiles[0]?.length ?? 0;
    let best: Coord | null = null;
    let bestDist = Infinity;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 0; x < w; x++) {
        const tile = obs.tiles[y]?.[x];
        if (!tile || tile.terrain !== terrain) continue;
        if (tile.visibility !== visibility) continue;
        const dist = this.wrappedDist(from, { x, y });
        if (dist < bestDist) { bestDist = dist; best = { x, y }; }
      }
    }
    return best;
  }

  /** Build a canEnter function for the given unit's domain. */
  private makeCanEnter(obs: AgentObservation, unit: UnitView): (x: number, y: number) => boolean {
    const stats = UNIT_STATS[unit.type];
    // Transports avoid tiles with visible enemy units (prevents combat deadlocks)
    const enemyPositions = unit.type === UnitType.Transport
      ? new Set(obs.visibleEnemyUnits.map((e) => `${e.x},${e.y}`))
      : null;
    return (x: number, y: number): boolean => {
      if (y <= 0 || y >= this.mapHeight - 1) return false;
      if (enemyPositions?.has(`${x},${y}`)) return false;
      const tile = obs.tiles[y]?.[x];
      if (stats.domain === UnitDomain.Land) return !!tile && tile.terrain === Terrain.Land;
      if (stats.domain === UnitDomain.Sea) {
        if (!tile) return true; // unexplored — assume navigable ocean
        if (tile.terrain === Terrain.Ocean) return true;
        return obs.myCities.some((c) => c.x === x && c.y === y); // friendly port
      }
      // Air
      if (!tile) return false;
      return true;
    };
  }
}
