import { type GameState, type Unit, type CombatResult } from '../types.js';
/**
 * Resolve one round of combat using Axis & Allies-style d6 rules.
 * Attacker hits if d6 ≤ attack stat, defender hits if d6 ≤ defense stat.
 * Special: submarine attacker negates defender retaliation.
 * If noRetaliation is true, the defender cannot fire back (shore bombardment).
 */
export declare function resolveCombat(state: GameState, attacker: Unit, defender: Unit, noRetaliation?: boolean): CombatResult;
/**
 * Remove destroyed units from game state, including any cargo they carried.
 */
export declare function removeDestroyedUnits(state: GameState): string[];
//# sourceMappingURL=combat.d.ts.map