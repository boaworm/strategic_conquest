import { type GameState, type GameAction, type ActionResult, type PlayerView, type PlayerId } from '../types.js';
/**
 * Apply an action to the game state. Mutates state in place.
 */
export declare function applyAction(state: GameState, action: GameAction, playerId: PlayerId): ActionResult;
/**
 * Check if a city is adjacent to at least one ocean tile.
 */
export declare function isCityCoastal(state: GameState, city: {
    x: number;
    y: number;
}): boolean;
/**
 * Generate a fog-of-war filtered view for a specific player.
 */
export declare function getPlayerView(state: GameState, playerId: PlayerId): PlayerView;
//# sourceMappingURL=game.d.ts.map