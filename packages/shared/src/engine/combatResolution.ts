import { CombatResult, Unit, UnitType } from '../types.js';
import combatData from '../combat_resolution.json' assert { type: 'json' };

type Resolution =
  | { attackerDestroyed: number; defenderDestroyed: number }
  | 'n/a';

type CombatTable = Record<UnitType, Record<UnitType | 'City', Resolution>>;

const table = combatData as CombatTable;

/**
 * Look up the probabilistic outcome of an attacker vs defender matchup.
 * Returns 'n/a' if this matchup is not allowed (e.g., air vs submarine).
 * Percentages are 0-100.
 */
export function getCombatResolution(
  attackerType: UnitType,
  defenderType: UnitType | 'City',
): Resolution {
  return table[attackerType][defenderType];
}

/**
 * Resolve combat using the JSON-defined probabilities.
 * Rolls dice to determine if attacker and/or defender are destroyed.
 */
export function resolveCombatFromTable(
  attacker: Unit,
  defender: Unit,
): CombatResult | null {
  const resolution = getCombatResolution(attacker.type, defender.type);

  if (resolution === 'n/a') {
    return null;
  }

  // Roll for attacker destruction
  const attackerRoll = Math.floor(Math.random() * 100) + 1;
  const attackerDestroyed = attackerRoll <= resolution.attackerDestroyed;

  // Roll for defender destruction
  const defenderRoll = Math.floor(Math.random() * 100) + 1;
  const defenderDestroyed = defenderRoll <= resolution.defenderDestroyed;

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerDamage: attackerDestroyed ? 1 : 0,
    defenderDamage: defenderDestroyed ? 1 : 0,
    attackerDestroyed,
    defenderDestroyed,
  };
}
