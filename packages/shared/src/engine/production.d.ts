import { type GameState, type City, type Unit, UnitType } from '../types.js';
export declare function resetProductionIdCounter(): void;
/**
 * Advance production for all cities owned by the given player.
 * Returns any newly produced units.
 */
export declare function advanceProduction(state: GameState, playerId: string): Unit[];
/**
 * Set production for a city. Preserves accumulated progress.
 */
export declare function setProduction(city: City, unitType: UnitType | null): void;
//# sourceMappingURL=production.d.ts.map