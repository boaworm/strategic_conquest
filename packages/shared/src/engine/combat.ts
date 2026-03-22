import { type GameState, type Unit, type CombatResult, UnitType, UNIT_STATS } from '../types.js';

/** Roll a d6 (1-6). */
function d6(): number {
  return Math.floor(Math.random() * 6) + 1;
}

/**
 * Resolve one round of combat using Axis & Allies-style d6 rules.
 * Attacker hits if d6 ≤ attack stat, defender hits if d6 ≤ defense stat.
 * Special: submarine attacker negates defender retaliation.
 * If noRetaliation is true, the defender cannot fire back (shore bombardment).
 */
export function resolveCombat(
  state: GameState,
  attacker: Unit,
  defender: Unit,
  noRetaliation = false,
): CombatResult {
  const aStats = UNIT_STATS[attacker.type];
  const dStats = UNIT_STATS[defender.type];

  // Attacker rolls
  const attackerRoll = Math.floor(Math.random() * 6) + 1;
  const attackerHits = attackerRoll <= aStats.attack;
  // Defender rolls (suppressed for submarine attacker or shore bombardment)
  const defenderRoll = Math.floor(Math.random() * 6) + 1;
  const defenderHits =
    noRetaliation || attacker.type === UnitType.Submarine
      ? false
      : defenderRoll <= dStats.defense;

  let attackerDmg = 0;
  let defenderDmg = 0;

  if (attackerHits) {
    defender.health--;
    defenderDmg++;
  }
  if (defenderHits) {
    attacker.health--;
    attackerDmg++;
  }

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerDamage: attackerDmg,
    defenderDamage: defenderDmg,
    attackerDestroyed: attacker.health <= 0,
    defenderDestroyed: defender.health <= 0,
  };
}

/**
 * Remove destroyed units from game state, including any cargo they carried.
 */
export function removeDestroyedUnits(state: GameState): string[] {
  const removedIds: string[] = [];
  const toRemove = new Set<string>();

  for (const unit of state.units) {
    if (unit.health <= 0) {
      toRemove.add(unit.id);
      removedIds.push(unit.id);
      // Remove cargo too
      for (const cargoId of unit.cargo) {
        toRemove.add(cargoId);
        removedIds.push(cargoId);
      }
    }
  }

  state.units = state.units.filter((u) => !toRemove.has(u.id));
  // Clean up carriedBy references
  for (const unit of state.units) {
    if (unit.carriedBy && toRemove.has(unit.carriedBy)) {
      unit.carriedBy = null;
    }
    unit.cargo = unit.cargo.filter((id) => !toRemove.has(id));
  }

  return removedIds;
}
