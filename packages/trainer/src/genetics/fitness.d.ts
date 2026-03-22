/**
 * Fitness function: evaluates an agent's performance in a game.
 *
 * fitness = W_win  * didWin
 *         + W_turn * (maxTurns - turnsToWin) / maxTurns
 *         + W_city * finalCityRatio
 *         + W_unit * finalUnitRatio
 *         - W_loss * didLose
 */
export interface GameOutcome {
    won: boolean;
    lost: boolean;
    draw: boolean;
    turnsTaken: number;
    maxTurns: number;
    /** # of cities this agent owns at end / total cities */
    finalCityRatio: number;
    /** # of units this agent owns at end / total units (or 0 if none) */
    finalUnitRatio: number;
}
export interface FitnessWeights {
    win: number;
    turnSpeed: number;
    cityRatio: number;
    unitRatio: number;
    loss: number;
}
export declare const DEFAULT_FITNESS_WEIGHTS: FitnessWeights;
export declare function computeFitness(outcome: GameOutcome, weights?: FitnessWeights): number;
//# sourceMappingURL=fitness.d.ts.map