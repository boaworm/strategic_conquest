/**
 * Fitness function: evaluates an agent's performance in a game.
 *
 * fitness = W_win  * didWin
 *         + W_turn * (maxTurns - turnsToWin) / maxTurns
 *         + W_city * finalCityRatio
 *         + W_unit * finalUnitRatio
 *         - W_loss * didLose
 */
export const DEFAULT_FITNESS_WEIGHTS = {
    win: 10,
    turnSpeed: 2,
    cityRatio: 3,
    unitRatio: 1,
    loss: -5,
};
export function computeFitness(outcome, weights = DEFAULT_FITNESS_WEIGHTS) {
    let fitness = 0;
    if (outcome.won) {
        fitness += weights.win;
        // Reward faster wins
        fitness +=
            weights.turnSpeed *
                (outcome.maxTurns - outcome.turnsTaken) /
                outcome.maxTurns;
    }
    if (outcome.lost) {
        fitness += weights.loss;
    }
    fitness += weights.cityRatio * outcome.finalCityRatio;
    fitness += weights.unitRatio * outcome.finalUnitRatio;
    return fitness;
}
//# sourceMappingURL=fitness.js.map