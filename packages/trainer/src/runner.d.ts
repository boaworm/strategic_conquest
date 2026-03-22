import { type Agent, type PlayerId } from '@sc/shared';
import { type GameOutcome } from './genetics/fitness.js';
export interface RunnerOptions {
    mapWidth?: number;
    mapHeight?: number;
    mapSeed?: number;
    maxTurns?: number;
}
export interface GameResult {
    winner: PlayerId | null;
    turns: number;
    p1Outcome: GameOutcome;
    p2Outcome: GameOutcome;
}
/**
 * Run a complete headless game between two agents.
 * Returns outcome data for both players.
 */
export declare function runGame(agent1: Agent, agent2: Agent, opts?: RunnerOptions): GameResult;
//# sourceMappingURL=runner.d.ts.map