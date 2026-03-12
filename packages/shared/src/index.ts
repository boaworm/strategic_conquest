export * from './types.js';
export * from './agent.js';
export { createGameState, generateMap } from './engine/map.js';
export { applyAction, getPlayerView, isCityCoastal } from './engine/game.js';
export { canMoveTo, canDetectSubmarine, getVisibleTiles, getUnitsAt, normalizeCoord, distToNearestFriendlyCity, distToNearestLandingSpot } from './engine/movement.js';
export { resolveCombat, removeDestroyedUnits } from './engine/combat.js';
export { advanceProduction, setProduction } from './engine/production.js';
