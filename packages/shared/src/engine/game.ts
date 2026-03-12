import {
  type GameState,
  type GameAction,
  type ActionResult,
  type PlayerView,
  type TileView,
  type CityView,
  type UnitView,
  GamePhase,
  TileVisibility,
  Terrain,
  UnitDomain,
  UnitType,
  UNIT_STATS,
  type PlayerId,
  wrapX,
  wrappedDistX,
} from '../types.js';
import { canMoveTo, canDetectSubmarine, getUnitsAt, getVisibleTiles, normalizeCoord } from './movement.js';
import { resolveCombat, removeDestroyedUnits } from './combat.js';
import { advanceProduction, setProduction } from './production.js';

/**
 * Apply an action to the game state. Mutates state in place.
 */
export function applyAction(
  state: GameState,
  action: GameAction,
  playerId: PlayerId,
): ActionResult {
  if (state.phase !== GamePhase.Active) {
    return { success: false, error: 'Game is not active' };
  }

  // Configuration actions allowed regardless of whose turn it is
  switch (action.type) {
    case 'SET_PRODUCTION':
      return handleSetProduction(state, action.cityId, action.unitType, playerId);
    case 'SLEEP':
      return handleSleep(state, action.unitId, playerId, true);
    case 'WAKE':
      return handleSleep(state, action.unitId, playerId, false);
    case 'SKIP':
      return handleSkip(state, action.unitId, playerId);
    case 'DISBAND':
      return handleDisband(state, action.unitId, playerId);
    default:
      break;
  }

  // Turn actions require it to be the player's turn
  if (state.currentPlayer !== playerId) {
    return { success: false, error: 'Not your turn' };
  }

  switch (action.type) {
    case 'MOVE':
      return handleMove(state, action.unitId, action.to, playerId);
    case 'LOAD':
      return handleLoad(state, action.unitId, action.transportId, playerId);
    case 'UNLOAD':
      return handleUnload(state, action.unitId, action.to, playerId);
    case 'END_TURN':
      return handleEndTurn(state, playerId);
    default:
      return { success: false, error: 'Unknown action type' };
  }
}

function handleMove(
  state: GameState,
  unitId: string,
  to: { x: number; y: number },
  playerId: PlayerId,
): ActionResult {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return { success: false, error: 'Unit not found' };
  if (unit.owner !== playerId) return { success: false, error: 'Not your unit' };
  if (unit.carriedBy !== null) return { success: false, error: 'Unit is being carried' };

  // Normalize target for cylindrical wrapping
  const target = normalizeCoord(to, state.mapWidth);

  // Shore bombardment: Battleship can attack land units on adjacent non-ocean tiles (including cities)
  if (unit.type === UnitType.Battleship) {
    const terrain = state.tiles[target.y]?.[target.x];
    if (terrain !== undefined && terrain !== Terrain.Ocean) {
      const enemyLand = getUnitsAt(state, target).filter(
        (u) => u.owner !== playerId && UNIT_STATS[u.type].domain === UnitDomain.Land,
      );
      if (enemyLand.length > 0) {
        // Must be adjacent and have moves
        const dx = wrappedDistX(target.x, unit.x, state.mapWidth);
        const dy = Math.abs(target.y - unit.y);
        if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
          return { success: false, error: 'Target not adjacent' };
        }
        if (unit.movesLeft <= 0) {
          return { success: false, error: 'No moves left this turn' };
        }
        if (unit.hasAttacked) {
          return { success: false, error: 'Already attacked this turn' };
        }
        // Pick a random land unit as the target
        const defender = enemyLand[Math.floor(Math.random() * enemyLand.length)];
        const combat = resolveCombat(state, unit, defender, true);
        removeDestroyedUnits(state);
        unit.movesLeft--;
        unit.hasAttacked = true;
        checkWinCondition(state);
        return { success: true, combat };
      }
    }
  }

  // Auto-embark: land unit moving onto ocean tile with friendly transport
  // (checked before canMoveTo because land units normally can't enter ocean)
  if (
    UNIT_STATS[unit.type].domain === UnitDomain.Land &&
    state.tiles[target.y]?.[target.x] === Terrain.Ocean &&
    unit.movesLeft > 0
  ) {
    const transport = state.units.find(
      (u) =>
        u.x === target.x &&
        u.y === target.y &&
        u.owner === playerId &&
        u.carriedBy === null &&
        UNIT_STATS[u.type].canCarry.includes(unit.type) &&
        u.cargo.length < UNIT_STATS[u.type].cargoCapacity,
    );
    if (transport) {
      // Must be adjacent
      const embarkDx = wrappedDistX(unit.x, target.x, state.mapWidth);
      const embarkDy = Math.abs(unit.y - target.y);
      if (embarkDx <= 1 && embarkDy <= 1 && !(embarkDx === 0 && embarkDy === 0)) {
        unit.carriedBy = transport.id;
        unit.x = target.x;
        unit.y = target.y;
        unit.movesLeft = 0;
        transport.cargo.push(unit.id);
        return { success: true };
      }
    }
  }

  const check = canMoveTo(state, unit, target);
  if (!check.ok) return { success: false, error: check.error };

  // Check for enemy units at destination
  const allEnemyUnits = getUnitsAt(state, target).filter((u) => u.owner !== playerId);

  // Filter out undetected submarines — only DD/SS can reveal them
  const subDetected = canDetectSubmarine(state, target.x, target.y, playerId);
  const enemyUnits = allEnemyUnits.filter(
    (u) => u.type !== UnitType.Submarine || subDetected,
  );

  if (enemyUnits.length > 0) {
    if (unit.hasAttacked) {
      return { success: false, error: 'Already attacked this turn' };
    }

    // Submarine can only attack naval units
    if (unit.type === UnitType.Submarine) {
      const hasNavalTarget = enemyUnits.some(
        (e) => UNIT_STATS[e.type].domain === UnitDomain.Sea,
      );
      if (!hasNavalTarget) {
        return { success: false, error: 'Submarines can only attack naval units' };
      }
    }

    // Pick a random defender from the enemies present
    const defender = enemyUnits[Math.floor(Math.random() * enemyUnits.length)];

    // Bomber: destroy units in blast radius, bomber is always destroyed
    if (unit.type === UnitType.Bomber) {
      const blastRadius = getBomberBlastRadius(state, playerId);
      // Destroy all units (enemy AND friendly if radius > 0) in affected tiles
      const affectedTiles = getTilesInRadius(target.x, target.y, blastRadius, state.mapWidth, state.mapHeight);
      for (const pos of affectedTiles) {
        const unitsOnTile = state.units.filter(
          (u) => u.x === pos.x && u.y === pos.y && u.carriedBy === null && u.id !== unit.id,
        );
        for (const u of unitsOnTile) {
          // Radius 0: only enemies. Radius 1+: everyone (friendly and enemy)
          if (blastRadius === 0 && u.owner === playerId) continue;
          u.health = 0;
        }
      }
      unit.health = 0;
      const combat = {
        attackerId: unit.id,
        defenderId: defender.id,
        attackerDamage: 1,
        defenderDamage: 0,
        attackerDestroyed: true,
        defenderDestroyed: true,
      };
      removeDestroyedUnits(state);
      checkWinCondition(state);
      return { success: true, combat, bomberBlastRadius: blastRadius, bomberBlastCenter: target };
    }

    // Normal combat with the selected defender
    const combat = resolveCombat(state, unit, defender);
    removeDestroyedUnits(state);

    // If attacker survived AND no enemies remain on the target tile, move in
    if (!combat.attackerDestroyed) {
      const remainingEnemies = getUnitsAt(state, target).filter((u) => u.owner !== playerId);
      if (remainingEnemies.length === 0) {
        unit.x = target.x;
        unit.y = target.y;

        // Sync cargo positions
        if (unit.cargo.length > 0) {
          for (const cargoId of unit.cargo) {
            const carried = state.units.find((u) => u.id === cargoId);
            if (carried) {
              carried.x = unit.x;
              carried.y = unit.y;
            }
          }
        }

        // Fuel consumption for air units (combat counts as a move)
        if (unit.fuel !== undefined) {
          unit.fuel--;
          if (unit.fuel <= 0) {
            unit.health = 0;
            removeDestroyedUnits(state);
            checkWinCondition(state);
            unit.movesLeft--;
            unit.hasAttacked = true;
            return { success: true, combat };
          }
        }

        // Check for city capture (armies only)
        const cityCaptured = tryCaptureCity(state, unit, playerId);
        unit.movesLeft--;
        unit.hasAttacked = true;
        checkWinCondition(state);
        return { success: true, combat, cityCaptured: cityCaptured ?? undefined };
      }
      // Attacker survived but defenders remain — stay put
      unit.movesLeft--;
      unit.hasAttacked = true;
      checkWinCondition(state);
      return { success: true, combat };
    }

    unit.hasAttacked = true;
    unit.movesLeft--;
    checkWinCondition(state);
    return { success: true, combat };
  }

  // No combat — just move
  unit.x = target.x;
  unit.y = target.y;
  unit.movesLeft--;

  // Sync cargo positions when a transport/carrier moves
  if (unit.cargo.length > 0) {
    for (const cargoId of unit.cargo) {
      const carried = state.units.find((u) => u.id === cargoId);
      if (carried) {
        carried.x = unit.x;
        carried.y = unit.y;
      }
    }
  }

  // Fuel consumption for air units
  if (unit.fuel !== undefined) {
    unit.fuel--;
    if (unit.fuel <= 0) {
      // Crashed — remove
      unit.health = 0;
      removeDestroyedUnits(state);
      return { success: true };
    }
  }

  // Auto-land: fighter moving onto a tile with a friendly carrier auto-loads
  if (unit.type === UnitType.Fighter) {
    const carrier = state.units.find(
      (u) =>
        u.x === unit.x &&
        u.y === unit.y &&
        u.owner === playerId &&
        u.type === UnitType.Carrier &&
        u.carriedBy === null &&
        u.cargo.length < UNIT_STATS[u.type].cargoCapacity,
    );
    if (carrier) {
      unit.carriedBy = carrier.id;
      carrier.cargo.push(unit.id);
      unit.movesLeft = 0;
      // Refuel on landing
      const stats = UNIT_STATS[unit.type];
      if (stats.maxFuel !== undefined) unit.fuel = stats.maxFuel;
      return { success: true };
    }
  }

  // Air units landing on a friendly city end their turn and refuel
  if (unit.type === UnitType.Fighter || unit.type === UnitType.Bomber) {
    const onFriendlyCity = state.cities.some(
      (c) => c.x === unit.x && c.y === unit.y && c.owner === playerId,
    );
    if (onFriendlyCity) {
      unit.movesLeft = 0;
      const stats = UNIT_STATS[unit.type];
      if (stats.maxFuel !== undefined) unit.fuel = stats.maxFuel;
    }
  }

  // Check for city capture
  const cityCaptured = tryCaptureCity(state, unit, playerId);
  return { success: true, cityCaptured: cityCaptured ?? undefined };
}

function handleSkip(
  state: GameState,
  unitId: string,
  playerId: PlayerId,
): ActionResult {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return { success: false, error: 'Unit not found' };
  if (unit.owner !== playerId) return { success: false, error: 'Not your unit' };
  unit.movesLeft = 0;
  return { success: true };
}

function handleDisband(
  state: GameState,
  unitId: string,
  playerId: PlayerId,
): ActionResult {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return { success: false, error: 'Unit not found' };
  if (unit.owner !== playerId) return { success: false, error: 'Not your unit' };

  // Remove from transport cargo if carried
  if (unit.carriedBy) {
    const transport = state.units.find((u) => u.id === unit.carriedBy);
    if (transport) {
      transport.cargo = transport.cargo.filter((id) => id !== unitId);
    }
  }

  // Destroy cargo if this unit carries others
  for (const cargoId of unit.cargo) {
    const carried = state.units.find((u) => u.id === cargoId);
    if (carried) carried.health = 0;
  }

  unit.health = 0;
  removeDestroyedUnits(state);
  return { success: true };
}

function tryCaptureCity(
  state: GameState,
  unit: { type: string; x: number; y: number; owner: string },
  playerId: PlayerId,
): string | null {
  if (unit.type !== 'infantry' && unit.type !== 'tank') return null;
  const city = state.cities.find((c) => c.x === unit.x && c.y === unit.y);
  if (!city) return null;
  if (city.owner === playerId) return null;

  city.owner = playerId;
  city.producing = null;
  city.productionTurnsLeft = 0;
  city.productionProgress = 0;
  return city.id;
}

/**
 * Check if a city is adjacent to at least one ocean tile.
 */
export function isCityCoastal(
  state: GameState,
  city: { x: number; y: number },
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = wrapX(city.x + dx, state.mapWidth);
      const ny = city.y + dy;
      if (ny >= 0 && ny < state.mapHeight && state.tiles[ny][nx] === Terrain.Ocean) {
        return true;
      }
    }
  }
  return false;
}

function handleSetProduction(
  state: GameState,
  cityId: string,
  unitType: import('../types.js').UnitType | null,
  playerId: PlayerId,
): ActionResult {
  const city = state.cities.find((c) => c.id === cityId);
  if (!city) return { success: false, error: 'City not found' };
  if (city.owner !== playerId) return { success: false, error: 'Not your city' };

  // Naval units require a coastal city (adjacent to ocean)
  if (unitType !== null && UNIT_STATS[unitType].domain === UnitDomain.Sea) {
    if (!isCityCoastal(state, city)) {
      return { success: false, error: 'Only coastal cities can build ships' };
    }
  }

  setProduction(city, unitType);
  return { success: true };
}

function handleSleep(
  state: GameState,
  unitId: string,
  playerId: PlayerId,
  sleep: boolean,
): ActionResult {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return { success: false, error: 'Unit not found' };
  if (unit.owner !== playerId) return { success: false, error: 'Not your unit' };

  unit.sleeping = sleep;
  return { success: true };
}

function handleLoad(
  state: GameState,
  unitId: string,
  transportId: string,
  playerId: PlayerId,
): ActionResult {
  const unit = state.units.find((u) => u.id === unitId);
  const transport = state.units.find((u) => u.id === transportId);
  if (!unit) return { success: false, error: 'Unit not found' };
  if (!transport) return { success: false, error: 'Transport not found' };
  if (unit.owner !== playerId || transport.owner !== playerId) {
    return { success: false, error: 'Not your unit' };
  }

  const tStats = UNIT_STATS[transport.type];
  if (tStats.cargoCapacity === 0) {
    return { success: false, error: 'Cannot carry units' };
  }
  if (!tStats.canCarry.includes(unit.type)) {
    return { success: false, error: 'Cannot carry this unit type' };
  }
  if (transport.cargo.length >= tStats.cargoCapacity) {
    return { success: false, error: 'Transport is full' };
  }
  // Must be on same tile or adjacent
  const dx = wrappedDistX(unit.x, transport.x, state.mapWidth);
  const dy = Math.abs(unit.y - transport.y);
  if (dx > 1 || dy > 1) {
    return { success: false, error: 'Must be adjacent to transport' };
  }
  if (unit.movesLeft <= 0) {
    return { success: false, error: 'No moves left' };
  }

  unit.carriedBy = transport.id;
  unit.x = transport.x;
  unit.y = transport.y;
  unit.movesLeft = 0;
  transport.cargo.push(unit.id);
  return { success: true };
}

function handleUnload(
  state: GameState,
  unitId: string,
  to: { x: number; y: number },
  playerId: PlayerId,
): ActionResult {
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return { success: false, error: 'Unit not found' };
  if (unit.owner !== playerId) return { success: false, error: 'Not your unit' };
  if (!unit.carriedBy) return { success: false, error: 'Unit is not being carried' };
  if (unit.movesLeft <= 0) return { success: false, error: 'No moves left' };

  const transport = state.units.find((u) => u.id === unit.carriedBy);
  if (!transport) return { success: false, error: 'Transport not found' };

  // Check destination is adjacent to transport
  const dx = wrappedDistX(to.x, transport.x, state.mapWidth);
  const dy = Math.abs(to.y - transport.y);
  if (dx > 1 || dy > 1) {
    return { success: false, error: 'Can only unload to adjacent tile' };
  }

  // Temporarily detach so canMoveTo works for the land unit
  unit.carriedBy = null;
  unit.x = transport.x;
  unit.y = transport.y;
  const target = normalizeCoord(to, state.mapWidth);
  const check = canMoveTo(state, unit, target);
  if (!check.ok) {
    // Reattach on failure
    unit.carriedBy = transport.id;
    return { success: false, error: check.error };
  }

  unit.x = target.x;
  unit.y = target.y;
  unit.movesLeft--;
  transport.cargo = transport.cargo.filter((id) => id !== unit.id);

  // Check for city capture
  const cityCaptured = tryCaptureCity(state, unit, playerId);
  checkWinCondition(state);
  return { success: true, cityCaptured: cityCaptured ?? undefined };
}

function handleEndTurn(state: GameState, playerId: PlayerId): ActionResult {
  // Advance production for current player
  advanceProduction(state, playerId);

  // Crash fighters not on a friendly city or carrier
  let fightersCrashed = 0;
  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    if (unit.type !== UnitType.Fighter) continue;
    if (unit.carriedBy !== null) continue; // safe on carrier
    const onCity = state.cities.some(
      (c) => c.x === unit.x && c.y === unit.y && c.owner === unit.owner,
    );
    if (!onCity) {
      unit.health = 0;
      fightersCrashed++;
    }
  }
  if (fightersCrashed > 0) {
    removeDestroyedUnits(state);
  }

  // Switch player
  if (state.currentPlayer === 'player1') {
    state.currentPlayer = 'player2';
  } else {
    state.currentPlayer = 'player1';
    state.turn++;
  }

  // Refresh moves for the new current player's units
  for (const unit of state.units) {
    if (unit.owner === state.currentPlayer) {
      const stats = UNIT_STATS[unit.type];
      unit.movesLeft = stats.movesPerTurn;
      unit.hasAttacked = false;
    }
  }

  // Repair capital ships in cities
  for (const unit of state.units) {
    if (
      unit.owner === state.currentPlayer &&
      (unit.type === UnitType.Battleship || unit.type === UnitType.Carrier) &&
      unit.health < UNIT_STATS[unit.type].maxHealth
    ) {
      const inCity = state.cities.some(
        (c) => c.x === unit.x && c.y === unit.y && c.owner === unit.owner,
      );
      if (inCity) {
        unit.health = UNIT_STATS[unit.type].maxHealth;
      }
    }
  }

  // Refuel air units on cities or carriers
  for (const unit of state.units) {
    if (unit.owner === state.currentPlayer && unit.fuel !== undefined) {
      const stats = UNIT_STATS[unit.type];
      // On a friendly city?
      const onCity = state.cities.some(
        (c) => c.x === unit.x && c.y === unit.y && c.owner === unit.owner,
      );
      // On a carrier?
      const onCarrier = unit.carriedBy !== null;

      if (onCity || onCarrier) {
        unit.fuel = stats.maxFuel!;
      }
    }
  }

  // Clear seen enemies for the new current player (fresh turn)
  state.seenEnemies[state.currentPlayer] = [];

  checkWinCondition(state);
  return { success: true, fightersCrashed: fightersCrashed > 0 ? fightersCrashed : undefined };
}

function checkWinCondition(state: GameState): void {
  for (const player of ['player1', 'player2'] as PlayerId[]) {
    const hasCities = state.cities.some((c) => c.owner === player);
    if (!hasCities) {
      const winner = player === 'player1' ? 'player2' : 'player1';
      state.phase = GamePhase.Finished;
      state.winner = winner;
      return;
    }
  }
}

/** Get bomber blast radius based on total bombers produced by this player. */
function getBomberBlastRadius(state: GameState, playerId: PlayerId): number {
  const count = state.bombersProduced[playerId] ?? 0;
  if (count >= 20) return 2;
  if (count >= 10) return 1;
  return 0;
}

/** Get all tile coordinates within Chebyshev distance `radius` of (cx, cy). */
function getTilesInRadius(
  cx: number,
  cy: number,
  radius: number,
  mapWidth: number,
  mapHeight: number,
): { x: number; y: number }[] {
  const tiles: { x: number; y: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= mapHeight) continue;
      const nx = wrapX(cx + dx, mapWidth);
      tiles.push({ x: nx, y: ny });
    }
  }
  return tiles;
}

// ── Fog of War View ──────────────────────────────────────────

/**
 * Generate a fog-of-war filtered view for a specific player.
 */
export function getPlayerView(
  state: GameState,
  playerId: PlayerId,
): PlayerView {
  const visible = getVisibleTiles(state, playerId);

  // Persist newly visible tiles into the explored set
  const explored = state.explored[playerId];
  for (const key of visible) {
    explored.add(key);
  }

  // Build tile view
  const tiles: TileView[][] = Array.from({ length: state.mapHeight }, (_, y) =>
    Array.from({ length: state.mapWidth }, (_, x) => {
      const key = `${x},${y}`;
      const vis = visible.has(key)
        ? TileVisibility.Visible
        : explored.has(key)
          ? TileVisibility.Seen
          : TileVisibility.Hidden;
      return {
        terrain: state.tiles[y][x],
        visibility: vis,
        x,
        y,
      };
    }),
  );

  // My units (full info)
  const myUnits: UnitView[] = state.units
    .filter((u) => u.owner === playerId)
    .map(unitToView);

  // My cities (full info)
  const myCities: CityView[] = state.cities
    .filter((c) => c.owner === playerId)
    .map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      owner: c.owner,
      producing: c.producing,
      productionTurnsLeft: c.productionTurnsLeft,
      coastal: isCityCoastal(state, c),
    }));

  // Visible enemy units (submarines only visible if detected by friendly DD/SS)
  const currentlyVisible: UnitView[] = state.units
    .filter(
      (u) =>
        u.owner !== playerId &&
        u.carriedBy === null &&
        visible.has(`${u.x},${u.y}`) &&
        (u.type !== UnitType.Submarine ||
          canDetectSubmarine(state, u.x, u.y, playerId)),
    )
    .map(unitToView);

  // Persist newly visible enemies into seenEnemies for this turn
  const seen = state.seenEnemies[playerId];
  for (const ev of currentlyVisible) {
    const idx = seen.findIndex((s) => s.id === ev.id);
    if (idx >= 0) {
      // Update position
      seen[idx] = { id: ev.id, type: ev.type, owner: ev.owner, x: ev.x, y: ev.y };
    } else {
      seen.push({ id: ev.id, type: ev.type, owner: ev.owner, x: ev.x, y: ev.y });
    }
  }
  // Remove entries for units that no longer exist
  state.seenEnemies[playerId] = seen.filter((s) =>
    state.units.some((u) => u.id === s.id),
  );

  // Merge: currently visible + previously-seen-this-turn (at last known position)
  const visibleIds = new Set(currentlyVisible.map((u) => u.id));
  const ghostEnemies: UnitView[] = state.seenEnemies[playerId]
    .filter((s) => !visibleIds.has(s.id))
    .map((s) => {
      // The unit still exists but is not currently visible — show at last known position
      const real = state.units.find((u) => u.id === s.id);
      if (!real) return null;
      return {
        id: s.id,
        type: s.type,
        owner: s.owner,
        x: s.x,
        y: s.y,
        health: 1, // don't reveal actual health
        movesLeft: 0,
        fuel: undefined,
        sleeping: false,
        hasAttacked: false,
        cargo: [],
        carriedBy: null,
      } as UnitView;
    })
    .filter((u): u is UnitView => u !== null);

  const visibleEnemyUnits = [...currentlyVisible, ...ghostEnemies];

  // Visible enemy/neutral cities (include remembered cities on explored tiles)
  const visibleEnemyCities: CityView[] = state.cities
    .filter((c) => c.owner !== playerId && explored.has(`${c.x},${c.y}`))
    .map((c) => ({
      id: c.id,
      x: c.x,
      y: c.y,
      owner: c.owner,
      producing: null, // don't reveal enemy production
      productionTurnsLeft: 0,
      coastal: isCityCoastal(state, c),
    }));

  return {
    tiles,
    myUnits,
    myCities,
    visibleEnemyUnits,
    visibleEnemyCities,
    turn: state.turn,
    currentPlayer: state.currentPlayer,
    phase: state.phase,
    winner: state.winner,
  };
}

function unitToView(u: import('../types.js').Unit): UnitView {
  return {
    id: u.id,
    type: u.type,
    owner: u.owner,
    x: u.x,
    y: u.y,
    health: u.health,
    movesLeft: u.movesLeft,
    fuel: u.fuel,
    sleeping: u.sleeping,
    hasAttacked: u.hasAttacked,
    cargo: u.cargo,
    carriedBy: u.carriedBy,
  };
}
