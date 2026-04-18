import {
  type GameState,
  type GameAction,
  type ActionResult,
  type PlayerView,
  type TileView,
  type CityView,
  type UnitView,
  type Unit,
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

/** Check if a unit is on a city tile owned by its owner. */
function unitInOwnCity(state: GameState, unit: Unit): boolean {
  return state.cities.some(
    (c) => c.x === unit.x && c.y === unit.y && c.owner === unit.owner
  );
}

/** Check if a tile has a city. */
function tileHasCity(state: GameState, x: number, y: number): boolean {
  return state.cities.some((c) => c.x === x && c.y === y);
}
import { removeDestroyedUnits } from './combat.js';
import { resolveCombatFromTable, CombatOutcome } from './combatResolution.js';
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

  // Normalize target for cylindrical wrapping
  const target = normalizeCoord(to, state.mapWidth);

  // Army disembarkation: army on transport can move to adjacent land tile
  if (unit.carriedBy !== null && unit.type === UnitType.Army && unit.movesLeft > 0) {
    const transport = state.units.find((u) => u.id === unit.carriedBy);
    if (!transport) return { success: false, error: 'Transport not found' };

    // Must be adjacent to transport
    const dx = wrappedDistX(unit.x, target.x, state.mapWidth);
    const dy = Math.abs(unit.y - target.y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
      return { success: false, error: 'Can only move to adjacent tile' };
    }

    // Target must be land (not ice cap)
    if (target.y <= 0 || target.y >= state.mapHeight - 1) {
      return { success: false, error: 'Cannot move there' };
    }
    const terrain = state.tiles[target.y]?.[target.x];
    if (terrain !== Terrain.Land) {
      return { success: false, error: 'Can only disembark to land' };
    }

    // Disembark from transport
    unit.carriedBy = null;
    transport.cargo = transport.cargo.filter((id) => id !== unit.id);

    // Handle enemy units at target
    const enemiesAtTarget = getUnitsAt(state, target).filter((u) => u.owner !== playerId);
    if (enemiesAtTarget.length > 0) {
      if (unit.hasAttacked) {
        // Re-attach and fail
        unit.carriedBy = transport.id;
        transport.cargo.push(unit.id);
        return { success: false, error: 'Already attacked this turn' };
      }
      const defender = enemiesAtTarget[Math.floor(Math.random() * enemiesAtTarget.length)];
      const outcome = resolveCombatFromTable(unit, defender);
      removeDestroyedUnits(state);

      // Build combat result from outcome
      const combat = {
        attackerId: unit.id,
        defenderId: defender.id,
        attackerDamage: (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
        defenderDamage: (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
        attackerDestroyed: outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
        defenderDestroyed: outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
      };

      if (combat.attackerDestroyed) {
        checkWinCondition(state);
        return { success: true, combat };
      }
      const remaining = getUnitsAt(state, target).filter((u) => u.owner !== playerId);
      if (remaining.length > 0) {
        // Attack failed, re-attach
        unit.carriedBy = transport.id;
        transport.cargo.push(unit.id);
        unit.movesLeft--;
        unit.hasAttacked = true;
        checkWinCondition(state);
        return { success: true, combat };
      }
      // Enemy destroyed, land the unit
      unit.x = target.x;
      unit.y = target.y;
      unit.movesLeft--;
      unit.hasAttacked = true;
      checkWinCondition(state);
      return { success: true, combat };
    }

    // No enemies - land the unit
    unit.x = target.x;
    unit.y = target.y;
    unit.movesLeft--;
    checkWinCondition(state);
    return { success: true };
  }

  if (unit.carriedBy !== null) return { success: false, error: 'Unit is being carried' };

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
        const outcome = resolveCombatFromTable(unit, defender);

        // Set health to 0 for destroyed units so removeDestroyedUnits can remove them
        if (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) {
          unit.health = 0;
        }
        if (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) {
          defender.health = 0;
        }
        removeDestroyedUnits(state);

        // Build combat result from outcome
        const combat = {
          attackerId: unit.id,
          defenderId: defender.id,
          attackerDamage: (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
          defenderDamage: (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
          attackerDestroyed: outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
          defenderDestroyed: outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
        };

        unit.movesLeft--;
        unit.hasAttacked = true;
        checkWinCondition(state);
        return { success: true, combat };
      }
    }
  }

  // Naval units in cities can attack adjacent enemy naval units
  const attackerInCity = unitInOwnCity(state, unit);
  if (attackerInCity && UNIT_STATS[unit.type].domain === UnitDomain.Sea) {
    const terrain = state.tiles[target.y]?.[target.x];
    // Can only attack adjacent ocean tiles
    if (terrain === Terrain.Ocean) {
      const dx = wrappedDistX(target.x, unit.x, state.mapWidth);
      const dy = Math.abs(target.y - unit.y);
      if (dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0)) {
        const enemySea = getUnitsAt(state, target).filter(
          (u) => u.owner !== playerId && UNIT_STATS[u.type].domain === UnitDomain.Sea,
        );
        if (enemySea.length > 0) {
          if (unit.movesLeft <= 0) {
            return { success: false, error: 'No moves left this turn' };
          }
          if (unit.hasAttacked) {
            return { success: false, error: 'Already attacked this turn' };
          }
          const defender = enemySea[Math.floor(Math.random() * enemySea.length)];
          const outcome = resolveCombatFromTable(unit, defender);

          if (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) {
            unit.health = 0;
          }
          if (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) {
            defender.health = 0;
          }
          removeDestroyedUnits(state);

          const combat = {
            attackerId: unit.id,
            defenderId: defender.id,
            attackerDamage: (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
            defenderDamage: (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
            attackerDestroyed: outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
            defenderDestroyed: outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
          };

          unit.movesLeft--;
          unit.hasAttacked = true;
          checkWinCondition(state);
          return { success: true, combat };
        }
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

  // Naval bombardment: sea unit attacking an adjacent land tile it can't enter
  if (!check.ok && UNIT_STATS[unit.type].domain === UnitDomain.Sea) {
    const wx = wrapX(target.x, state.mapWidth);
    const terrain = state.tiles[target.y]?.[wx];
    if (terrain === Terrain.Land) {
      const dx = wrappedDistX(wx, unit.x, state.mapWidth);
      const dy = Math.abs(target.y - unit.y);
      const adjacent = dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
      if (adjacent && unit.movesLeft > 0 && !unit.hasAttacked) {
        const landTargets = getUnitsAt(state, target).filter(
          (u) => u.owner !== playerId && UNIT_STATS[u.type].domain === UnitDomain.Land,
        );
        if (landTargets.length > 0) {
          const defender = landTargets[Math.floor(Math.random() * landTargets.length)];
          const outcome = resolveCombatFromTable(unit, defender);
          if (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) unit.health--;
          if (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) defender.health--;
          unit.hasAttacked = true;
          unit.movesLeft = 0;
          const combat = {
            attackerId: unit.id,
            defenderId: defender.id,
            attackerDamage: (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
            defenderDamage: (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
            attackerDestroyed: unit.health <= 0,
            defenderDestroyed: defender.health <= 0,
          };
          removeDestroyedUnits(state);
          checkWinCondition(state);
          return { success: true, combat };
        }
      }
    }
  }

  if (!check.ok) return { success: false, error: check.error };

  // Check for enemy units at destination
  const allEnemyUnits = getUnitsAt(state, target).filter((u) => u.owner !== playerId);

  // Filter out undetected submarines — only DD/SS can reveal them
  const subDetected = canDetectSubmarine(state, target.x, target.y, playerId);
  const enemyUnits = allEnemyUnits.filter(
    (u) => u.type !== UnitType.Submarine || subDetected,
  );

  // Submarine ambush: undetected subs get a free attack on non-DD/non-SS naval units moving into their tile
  const isAmbushVulnerable =
    !subDetected &&
    unit.type !== UnitType.Submarine &&
    unit.type !== UnitType.Destroyer &&
    UNIT_STATS[unit.type].domain === UnitDomain.Sea;

  if (isAmbushVulnerable) {
    const ambushSubs = allEnemyUnits.filter((u) => u.type === UnitType.Submarine);
    for (const sub of ambushSubs) {
      if (sub.hasAttacked) continue;
      const outcome = resolveCombatFromTable(sub, unit);
      if (outcome === null) continue;
      const subDestroyed = outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED;
      const unitDestroyed = outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED;
      if (unitDestroyed) unit.health--;
      if (subDestroyed) sub.health--;
      sub.hasAttacked = true;
      const combat = {
        attackerId: sub.id,
        defenderId: unit.id,
        attackerDamage: subDestroyed ? 1 : 0,
        defenderDamage: unitDestroyed ? 1 : 0,
        attackerDestroyed: sub.health <= 0,
        defenderDestroyed: unit.health <= 0,
      };
      removeDestroyedUnits(state);
      if (unit.health <= 0) {
        checkWinCondition(state);
        return { success: true, combat };
      }
      // Unit survived — sub dives, move continues (fall through)
    }
  }

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

    // Naval units in a city can ONLY attack naval units
    const attackerInCity = unitInOwnCity(state, unit);
    if (attackerInCity && UNIT_STATS[unit.type].domain === UnitDomain.Sea) {
      const hasNavalTarget = enemyUnits.some(
        (e) => UNIT_STATS[e.type].domain === UnitDomain.Sea,
      );
      if (!hasNavalTarget) {
        return { success: false, error: 'Naval units in cities can only attack naval units' };
      }
    }

    // Pick a defender from the enemies present
    // Sea units prioritize sea targets (to attack transports, not land units on same tile)
    let defender: Unit;
    if (UNIT_STATS[unit.type].domain === UnitDomain.Sea) {
      const seaTargets = enemyUnits.filter((e) => UNIT_STATS[e.type].domain === UnitDomain.Sea);
      if (seaTargets.length > 0) {
        defender = seaTargets[Math.floor(Math.random() * seaTargets.length)];
      } else {
        defender = enemyUnits[Math.floor(Math.random() * enemyUnits.length)];
      }
    } else {
      defender = enemyUnits[Math.floor(Math.random() * enemyUnits.length)];
    }

    // Bomber: check for intercepting fighters anywhere in the blast area.
    // If interceptors are present, the bomber fights them instead of bombing.
    // Bomber survives → it has "attacked" and flies back (not destroyed, no bomb dropped).
    // Bomber destroyed → no bomb.
    // No interceptors → bomb drops, kills ALL enemy units in blast area, bomber is destroyed.
    if (unit.type === UnitType.Missile) {
      const blastRadius = getBomberBlastRadius(state, playerId);
      const affectedTiles = getTilesInRadius(target.x, target.y, blastRadius, state.mapWidth, state.mapHeight);

      // Gather all enemy fighters in the blast area
      const interceptors = affectedTiles.flatMap((pos) =>
        state.units.filter(
          (u) => u.x === pos.x && u.y === pos.y && u.owner !== playerId &&
                 u.type === UnitType.Fighter && u.carriedBy === null,
        ),
      );

      if (interceptors.length > 0) {
        let lastInterceptCombat = {
          attackerId: unit.id,
          defenderId: interceptors[0].id,
          attackerDamage: 0,
          defenderDamage: 0,
          attackerDestroyed: false,
          defenderDestroyed: false,
        };
        for (const fighter of interceptors) {
          const bomberHits = Math.floor(Math.random() * 6) + 1 <= 1; // bomber attack = 1
          const fighterHits = Math.floor(Math.random() * 6) + 1 <= UNIT_STATS[fighter.type].defense;
          if (bomberHits) fighter.health--;
          if (fighterHits) unit.health--;
          lastInterceptCombat = {
            attackerId: unit.id,
            defenderId: fighter.id,
            attackerDamage: fighterHits ? 1 : 0,
            defenderDamage: bomberHits ? 1 : 0,
            attackerDestroyed: unit.health <= 0,
            defenderDestroyed: fighter.health <= 0,
          };
          removeDestroyedUnits(state);
          if (unit.health <= 0) {
            checkWinCondition(state);
            return { success: true, combat: lastInterceptCombat };
          }
        }
        // Bomber survived — intercepted, no bomb; bomber flies back alive
        unit.movesLeft = 0;
        unit.hasAttacked = true;
        return { success: true, combat: lastInterceptCombat };
      }

      // No interceptors — drop the bomb; kill ALL enemy units in blast area, bomber is destroyed
      const enemiesInArea = affectedTiles.flatMap((pos) =>
        state.units.filter(
          (u) => u.x === pos.x && u.y === pos.y && u.owner !== playerId &&
                 u.carriedBy === null && u.id !== unit.id,
        ),
      );
      for (const enemy of enemiesInArea) {
        enemy.health = 0;
      }
      unit.health = 0;
      const bombCombat = {
        attackerId: unit.id,
        defenderId: (enemiesInArea[0] ?? defender).id,
        attackerDamage: 1,
        defenderDamage: 0,
        attackerDestroyed: true,
        defenderDestroyed: enemiesInArea.length > 0,
      };
      removeDestroyedUnits(state);
      checkWinCondition(state);
      return { success: true, combat: bombCombat, bomberBlastRadius: blastRadius, bomberBlastCenter: target };
    }

    // Normal combat with the selected defender
    const outcome = resolveCombatFromTable(unit, defender);

    // Set health to 0 for destroyed units so removeDestroyedUnits can remove them
    if (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) {
      unit.health = 0;
    }
    if (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) {
      defender.health = 0;
    }
    removeDestroyedUnits(state);

    // Build combat result from outcome
    const combat = {
      attackerId: unit.id,
      defenderId: defender.id,
      attackerDamage: (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
      defenderDamage: (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
      attackerDestroyed: outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
      defenderDestroyed: outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
    };

    // If attacker survived AND no enemies remain on the target tile, move in
    if (!combat.attackerDestroyed) {
      const remainingEnemies = getUnitsAt(state, target).filter((u) => u.owner !== playerId);
      if (remainingEnemies.length === 0) {
        // Naval units do NOT move into cities after combat
        const isNavalAttacker = UNIT_STATS[unit.type].domain === UnitDomain.Sea;
        const targetIsCity = tileHasCity(state, target.x, target.y);

        if (!(isNavalAttacker && targetIsCity)) {
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
        const captureResult = tryCaptureCity(state, unit, playerId);
        unit.movesLeft--;
        unit.hasAttacked = true;
        checkWinCondition(state);
        return { success: true, combat, cityCaptured: captureResult.captured ?? undefined, cityCaptureFailed: captureResult.failed };
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
  if (unit.type === UnitType.Fighter || unit.type === UnitType.Missile) {
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
  const captureResult = tryCaptureCity(state, unit, playerId);
  return { success: true, cityCaptured: captureResult.captured ?? undefined, cityCaptureFailed: captureResult.failed };
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
  unit: import('../types.js').Unit,
  playerId: PlayerId,
): { captured: string | null; failed?: boolean } {
  if (unit.type !== 'army' as string) return { captured: null };
  const city = state.cities.find((c) => c.x === unit.x && c.y === unit.y);
  if (!city) return { captured: null };
  if (city.owner === playerId) return { captured: null };

  const isNeutral = city.owner === null;
  const baseWinChance = isNeutral ? 0.7 : 0.5;

  // Use test override if available
  const winChance = state.testOptions?.cityCaptureSuccessRate ?? baseWinChance;

  if (Math.random() >= winChance) {
    // City defense succeeds (attack fails). Army is destroyed.
    unit.health = 0;
    removeDestroyedUnits(state);
    return { captured: null, failed: true };
  }

  // Attack succeeds. Army is consumed to capture the city.
  city.owner = playerId;
  city.producing = null;
  city.productionTurnsLeft = 0;
  city.productionProgress = 0;
  unit.health = 0;
  removeDestroyedUnits(state);
  checkWinCondition(state);
  return { captured: city.id };
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
      // Exclude ice cap rows — transports cannot enter y=0 or y=mapHeight-1,
      // so ocean there does not make a city usable as a port.
      if (ny > 0 && ny < state.mapHeight - 1 && state.tiles[ny][nx] === Terrain.Ocean) {
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

  // Check for enemy units at the landing tile before moving in
  const enemiesAtTarget = getUnitsAt(state, target).filter((u) => u.owner !== playerId);

  if (enemiesAtTarget.length > 0) {
    if (unit.hasAttacked) {
      unit.carriedBy = transport.id;
      return { success: false, error: 'Already attacked this turn' };
    }

    const defender = enemiesAtTarget[Math.floor(Math.random() * enemiesAtTarget.length)];
    const outcome = resolveCombatFromTable(unit, defender);
    if (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) unit.health = 0;
    if (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) defender.health = 0;
    removeDestroyedUnits(state);

    // Build combat result from outcome
    const combat = {
      attackerId: unit.id,
      defenderId: defender.id,
      attackerDamage: (outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
      defenderDamage: (outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED) ? 1 : 0,
      attackerDestroyed: outcome === CombatOutcome.ATTACKER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
      defenderDestroyed: outcome === CombatOutcome.DEFENDER_DESTROYED || outcome === CombatOutcome.BOTH_DESTROYED,
    };

    if (combat.attackerDestroyed) {
      // Unit lost — removed from state by removeDestroyedUnits above; transport.cargo cleaned up too
      checkWinCondition(state);
      return { success: true, combat };
    }

    const remaining = getUnitsAt(state, target).filter((u) => u.owner !== playerId);
    if (remaining.length > 0) {
      // Survived but tile is not clear — stay in the transport
      unit.carriedBy = transport.id;
      unit.movesLeft--;
      unit.hasAttacked = true;
      checkWinCondition(state);
      return { success: true, combat };
    }

    // Tile is clear — land the unit
    unit.x = target.x;
    unit.y = target.y;
    unit.movesLeft--;
    unit.hasAttacked = true;
    transport.cargo = transport.cargo.filter((id) => id !== unit.id);
    const captureResult = tryCaptureCity(state, unit, playerId);
    checkWinCondition(state);
    return { success: true, combat, cityCaptured: captureResult.captured ?? undefined, cityCaptureFailed: captureResult.failed };
  }

  // No enemies — land and try to capture
  unit.x = target.x;
  unit.y = target.y;
  unit.movesLeft--;
  transport.cargo = transport.cargo.filter((id) => id !== unit.id);
  const captureResult = tryCaptureCity(state, unit, playerId);
  checkWinCondition(state);
  return { success: true, cityCaptured: captureResult.captured ?? undefined, cityCaptureFailed: captureResult.failed };
}

/**
 * Handle the beginning of a player's turn:
 * - Advance production
 * - Reset moves and attack status
 * - Repair capital ships
 * - Refuel air units
 * - Keep seen enemy memory (last-known positions) across turns
 */
function handleBeginOfTurn(state: GameState, playerId: PlayerId): void {
  // Advance production for this player (at beginning of turn)
  advanceProduction(state, playerId);

  // Refresh moves and attack status for this player's units (including newly produced)
  for (const unit of state.units) {
    if (unit.owner === playerId) {
      const stats = UNIT_STATS[unit.type];
      unit.movesLeft = stats.movesPerTurn;
      unit.hasAttacked = false;
    }
  }

  // Repair capital ships in cities
  for (const unit of state.units) {
    if (
      unit.owner === playerId &&
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
    if (unit.owner === playerId && unit.fuel !== undefined) {
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

}

function handleEndTurn(state: GameState, playerId: PlayerId): ActionResult {
  // Crash fighters and bombers not on a friendly city or carrier
  let aircraftCrashed = 0;
  for (const unit of state.units) {
    if (unit.owner !== playerId) continue;
    if (unit.type !== UnitType.Fighter && unit.type !== UnitType.Missile) continue;
    if (unit.carriedBy !== null) continue; // safe on carrier
    const onCity = state.cities.some(
      (c) => c.x === unit.x && c.y === unit.y && c.owner === unit.owner,
    );
    if (!onCity) {
      unit.health = 0;
      aircraftCrashed++;
    }
  }
  if (aircraftCrashed > 0) {
    removeDestroyedUnits(state);
  }

  // Switch player
  if (state.currentPlayer === 'player1') {
    state.currentPlayer = 'player2';
  } else {
    state.currentPlayer = 'player1';
    state.turn++;
  }

  // Handle the beginning of the new current player's turn
  handleBeginOfTurn(state, state.currentPlayer);

  checkWinCondition(state);
  return { success: true, fightersCrashed: aircraftCrashed > 0 ? aircraftCrashed : undefined };
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
 * @param hideUnexploredTerrain  When true, hidden tiles use Terrain.Unknown
 *   instead of the real terrain, preventing map-topology leaks to clients.
 *   Server-side agents should pass false so pathfinding still works.
 */
export function getPlayerView(
  state: GameState,
  playerId: PlayerId,
  hideUnexploredTerrain = false,
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
        terrain: (hideUnexploredTerrain && vis === TileVisibility.Hidden) ? Terrain.Unknown : state.tiles[y][x],
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

  const visibleEnemyUnits = currentlyVisible;

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
    myBomberBlastRadius: getBomberBlastRadius(state, playerId),
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
