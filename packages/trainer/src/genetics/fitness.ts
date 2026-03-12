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

export const DEFAULT_FITNESS_WEIGHTS: FitnessWeights = {
  win: 10,
  turnSpeed: 2,
  cityRatio: 3,
  unitRatio: 1,
  loss: -5,
};

export function computeFitness(
  outcome: GameOutcome,
  weights: FitnessWeights = DEFAULT_FITNESS_WEIGHTS,
): number {
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
