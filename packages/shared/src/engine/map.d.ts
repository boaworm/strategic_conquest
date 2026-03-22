import { Terrain, City, Unit, GameState } from '../types.js';
export declare function resetIdCounter(): void;
export interface MapOptions {
    width: number;
    height: number;
    seed?: number;
    landRatio?: number;
    cityCount?: number;
}
/**
 * Generate a map using a simple blob-based land generator.
 * Places starting cities for both players on opposite sides.
 */
export declare function generateMap(opts: MapOptions): {
    tiles: Terrain[][];
    cities: City[];
    units: Unit[];
};
/**
 * Create a full initial GameState from map options.
 */
export declare function createGameState(opts: MapOptions): GameState;
//# sourceMappingURL=map.d.ts.map