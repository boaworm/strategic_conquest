import { Router } from 'express';
import type { GameManager } from '../gameManager.js';
import type { AIDifficulty } from '@sc/shared';
/**
 * Training API for AI agents
 *
 * This API allows AI agents to:
 * - Create training games
 * - Observe game state
 * - Make moves
 * - Get rewards/feedback
 */
export interface TrainingGameConfig {
    mapWidth?: number;
    mapHeight?: number;
    difficulty?: AIDifficulty;
    maxTurns?: number;
}
export interface TrainingGameInfo {
    gameId: string;
    playerToken: string;
    mapWidth: number;
    mapHeight: number;
    difficulty: AIDifficulty;
}
export interface AgentObservation {
    tiles: any[][];
    myUnits: any[];
    myCities: any[];
    visibleEnemyUnits: any[];
    visibleEnemyCities: any[];
    turn: number;
    myPlayerId: string;
}
export interface ActionResult {
    success: boolean;
    error?: string;
}
export interface GameResult {
    winner: string | null;
    turns: number;
    reward: number;
}
export declare function createTrainingRoutes(manager: GameManager): Router;
//# sourceMappingURL=training.d.ts.map