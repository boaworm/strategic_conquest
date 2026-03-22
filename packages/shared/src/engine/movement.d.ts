import { type GameState, type Unit, type Coord, UnitType } from '../types.js';
/**
 * Chebyshev (king-move) distance to the nearest friendly city,
 * accounting for cylindrical X wrapping.
 * Returns Infinity if the player has no cities.
 */
export declare function distToNearestFriendlyCity(state: GameState, x: number, y: number, owner: string): number;
/**
 * Chebyshev distance to the nearest friendly city OR carrier with cargo space,
 * accounting for cylindrical X wrapping.
 * Returns Infinity if none exist.
 */
export declare function distToNearestLandingSpot(state: GameState, x: number, y: number, owner: string, unitType: UnitType): number;
/**
 * Check whether a unit can move to the given tile.
 * X wraps (cylindrical map), Y does not.
 */
export declare function canMoveTo(state: GameState, unit: Unit, to: Coord): {
    ok: boolean;
    error?: string;
};
/**
 * Normalize a move target — wraps X, keeps Y.
 */
export declare function normalizeCoord(to: Coord, mapWidth: number): Coord;
/**
 * Get all friendly units on a specific tile.
 */
export declare function getUnitsAt(state: GameState, pos: Coord, owner?: string): Unit[];
/**
 * Get all tiles visible to a player, with east-west wrapping.
 */
export declare function getVisibleTiles(state: GameState, playerId: string): Set<string>;
/**
 * Can the given player detect submarines at (x, y)?
 * Only destroyers and submarines can "see" enemy subs.
 * Returns true if any friendly DD or SS has the tile within vision range.
 */
export declare function canDetectSubmarine(state: GameState, x: number, y: number, playerId: string): boolean;
//# sourceMappingURL=movement.d.ts.map