import { Unit, UnitType } from '../types.js';
import combatData from '../combat_resolution.json' with { type: 'json' };

/** Combat outcome enum */
export enum CombatOutcome {
  ATTACKER_DESTROYED,
  DEFENDER_DESTROYED,
  BOTH_DESTROYED,
  NONE,
}

type Resolution =
  | { attackerDestroyed: number; defenderDestroyed: number }
  | 'n/a';

type CombatTable = Record<string, Record<string, Resolution>>;

const table = combatData as unknown as CombatTable;

/**
 * Look up if a matchup is allowed.
 * Returns true if the attacker can attack the defender.
 */
export function isCombatAllowed(attackerType: UnitType, defenderType: UnitType): boolean {
  const resolution = table[attackerType][defenderType];
  return resolution !== 'n/a';
}

/**
 * Resolve combat using the JSON-defined probabilities.
 * Returns the outcome enum based on dice rolls.
 * Returns null if the matchup is not allowed.
 */
export function resolveCombatFromTable(
  attacker: Unit,
  defender: Unit,
): CombatOutcome | null {
  const resolution = table[attacker.type][defender.type];

  if (resolution === 'n/a') {
    return null;
  }

  // Roll for attacker destruction (0-99)
  const attackerRoll = Math.floor(Math.random() * 100);
  const attackerDestroyed = attackerRoll < resolution.attackerDestroyed;

  // Roll for defender destruction (0-99)
  const defenderRoll = Math.floor(Math.random() * 100);
  const defenderDestroyed = defenderRoll < resolution.defenderDestroyed;

  if (attackerDestroyed && defenderDestroyed) {
    return CombatOutcome.BOTH_DESTROYED;
  }
  if (attackerDestroyed) {
    return CombatOutcome.ATTACKER_DESTROYED;
  }
  if (defenderDestroyed) {
    return CombatOutcome.DEFENDER_DESTROYED;
  }
  return CombatOutcome.NONE;
}
