export * from './types.js';
export * from './agent.js';
export * from './basicAgent.js';
export { GunAirAgent } from './gunAirAgent.js';
// NnAgent and NnMoEAgent are server-only (use onnxruntime-node)
// They are stubbed for browser builds via vite.config.ts
export { NnAgent } from './nnAgent.js';
export { NnMoEAgent } from './nnMoEAgent.js';
export { createGameState, generateMap, generatePresetMap } from './engine/map.js';
export { WORLD_CITIES, EUROPE_CITIES } from './engine/mapPresets.js';
export { applyAction, getPlayerView, isCityCoastal } from './engine/game.js';
export { canMoveTo, canDetectSubmarine, getVisibleTiles, getUnitsAt, normalizeCoord, distToNearestFriendlyCity, distToNearestLandingSpot } from './engine/movement.js';
export { resolveCombat, removeDestroyedUnits } from './engine/combat.js';
export { advanceProduction, setProduction } from './engine/production.js';
export { playerViewToTensor, NUM_CHANNELS } from './engine/tensorUtils.js';
