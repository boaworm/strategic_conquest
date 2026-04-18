import {
  type GameState,
  type Unit,
  type Coord,
  Terrain,
  UnitDomain,
  UnitType,
  UNIT_STATS,
  wrapX,
  wrappedDistX,
} from '../types.js';

/**
 * Chebyshev (king-move) distance to the nearest friendly city,
 * accounting for cylindrical X wrapping.
 * Returns Infinity if the player has no cities.
 */
export function distToNearestFriendlyCity(
  state: GameState,
  x: number,
  y: number,
  owner: string,
): number {
  let best = Infinity;
  for (const city of state.cities) {
    if (city.owner !== owner) continue;
    const dx = wrappedDistX(x, city.x, state.mapWidth);
    const dy = Math.abs(y - city.y);
    best = Math.min(best, Math.max(dx, dy));
  }
  return best;
}

/**
 * Chebyshev distance to the nearest friendly city OR carrier with cargo space,
 * accounting for cylindrical X wrapping.
 * Returns Infinity if none exist.
 */
export function distToNearestLandingSpot(
  state: GameState,
  x: number,
  y: number,
  owner: string,
  unitType: UnitType,
): number {
  let best = Infinity;
  // Friendly cities
  for (const city of state.cities) {
    if (city.owner !== owner) continue;
    const dx = wrappedDistX(x, city.x, state.mapWidth);
    const dy = Math.abs(y - city.y);
    best = Math.min(best, Math.max(dx, dy));
  }
  // Friendly carriers with space (only relevant for fighters)
  if (unitType === UnitType.Fighter) {
    for (const u of state.units) {
      if (u.owner !== owner) continue;
      if (u.type !== UnitType.Carrier) continue;
      if (u.carriedBy !== null) continue;
      if (u.cargo.length >= UNIT_STATS[u.type].cargoCapacity) continue;
      const dx = wrappedDistX(x, u.x, state.mapWidth);
      const dy = Math.abs(y - u.y);
      best = Math.min(best, Math.max(dx, dy));
    }
  }
  return best;
}

/**
 * Check whether a unit can move to the given tile.
 * X wraps (cylindrical map), Y does not.
 */
export function canMoveTo(
  state: GameState,
  unit: Unit,
  to: Coord,
): { ok: boolean; error?: string } {
  // Wrap X
  const wx = wrapX(to.x, state.mapWidth);
  const wy = to.y;

  // Y bounds check (north/south walls)
  if (wy < 0 || wy >= state.mapHeight) {
    return { ok: false, error: 'Out of bounds' };
  }

  // Ice cap rows are impassable
  if (wy === 0 || wy === state.mapHeight - 1) {
    return { ok: false, error: 'Cannot enter ice caps' };
  }

  // Must be adjacent (1 tile in any direction, including diagonals)
  // Use wrapped distance for X
  const dx = wrappedDistX(wx, unit.x, state.mapWidth);
  const dy = Math.abs(wy - unit.y);
  if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
    return { ok: false, error: 'Can only move one tile at a time' };
  }

  // Moves remaining
  if (unit.movesLeft <= 0) {
    return { ok: false, error: 'No moves left this turn' };
  }

  const terrain = state.tiles[wy][wx];
  const stats = UNIT_STATS[unit.type];

  // Domain checks
  if (stats.domain === UnitDomain.Land) {
    if (terrain === Terrain.Ocean) {
      return { ok: false, error: 'Land units cannot enter ocean' };
    }
  }

  if (stats.domain === UnitDomain.Sea) {
    if (terrain === Terrain.Land) {
      const cityHere = state.cities.find((c) => c.x === wx && c.y === wy);
      if (!cityHere) {
        return { ok: false, error: 'Sea units cannot enter land' };
      }
      // Naval ships cannot enter enemy cities
      if (cityHere.owner !== unit.owner) {
        return { ok: false, error: 'Naval ships cannot enter enemy cities' };
      }
    }
  }

  // Air unit fuel-return check: after this move the unit must
  // still have enough fuel to reach a friendly city or carrier.
  // Missiles have no fuel constraint (single-use weapons).
  if (stats.domain === UnitDomain.Air && unit.fuel !== undefined && unit.type !== UnitType.Missile) {
    const fuelAfterMove = unit.fuel - 1;
    const dist = distToNearestLandingSpot(state, wx, wy, unit.owner, unit.type);
    if (fuelAfterMove < dist) {
      return { ok: false, error: 'Not enough fuel to reach a friendly city or carrier' };
    }
  }

  return { ok: true };
}

/**
 * Normalize a move target — wraps X, keeps Y.
 */
export function normalizeCoord(to: Coord, mapWidth: number): Coord {
  return { x: wrapX(to.x, mapWidth), y: to.y };
}

/**
 * Get all friendly units on a specific tile.
 */
export function getUnitsAt(state: GameState, pos: Coord, owner?: string): Unit[] {
  const wx = wrapX(pos.x, state.mapWidth);
  return state.units.filter(
    (u) =>
      u.x === wx &&
      u.y === pos.y &&
      u.carriedBy === null &&
      (owner === undefined || u.owner === owner),
  );
}

/**
 * Get all tiles visible to a player, with east-west wrapping.
 */
export function getVisibleTiles(
  state: GameState,
  playerId: string,
): Set<string> {
  // Use boolean grid for faster computation, then convert to Set
  const grid = Array.from({ length: state.mapHeight }, () =>
    new Array(state.mapWidth).fill(false)
  );

  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    if (unit.carriedBy !== null) continue;

    // Fixed FoW radii by unit class:
    // - Fighters and missiles: 3
    // - Everyone else: 2
    const range = (unit.type === UnitType.Fighter || unit.type === UnitType.Missile) ? 3 : 2;

    for (let dy = -range; dy <= range; dy++) {
      const ny = unit.y + dy;
      if (ny < 0 || ny >= state.mapHeight) continue;
      for (let dx = -range; dx <= range; dx++) {
        const nx = wrapX(unit.x + dx, state.mapWidth);
        grid[ny][nx] = true;
      }
    }
  }

  // Cities also provide vision (range 2)
  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    for (let dy = -2; dy <= 2; dy++) {
      const ny = city.y + dy;
      if (ny < 0 || ny >= state.mapHeight) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const nx = wrapX(city.x + dx, state.mapWidth);
        grid[ny][nx] = true;
      }
    }
  }

  // Convert grid to Set for return
  const visible = new Set<string>();
  for (let y = 0; y < state.mapHeight; y++) {
    for (let x = 0; x < state.mapWidth; x++) {
      if (grid[y][x]) visible.add(`${x},${y}`);
    }
  }

  return visible;
}

/**
 * Can the given player detect submarines at (x, y)?
 * Only destroyers and submarines can "see" enemy submarines.
 * Returns true if any friendly destroyer or submarine has the tile within vision range.
 */
export function canDetectSubmarine(
  state: GameState,
  x: number,
  y: number,
  playerId: string,
): boolean {
  const wx = wrapX(x, state.mapWidth);
  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    if (unit.carriedBy !== null) continue;
    if (unit.type !== UnitType.Destroyer && unit.type !== UnitType.Submarine) continue;
    const stats = UNIT_STATS[unit.type];
    const dx = wrappedDistX(wx, unit.x, state.mapWidth);
    const dy = Math.abs(y - unit.y);
    if (dx <= stats.vision && dy <= stats.vision) return true;
  }
  return false;
}
