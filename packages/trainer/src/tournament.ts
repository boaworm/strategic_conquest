import type { Agent } from '@sc/shared';
import { type Genome } from './genetics/genome.js';
import { type GameResult, runGame, type RunnerOptions } from './runner.js';
import { computeFitness, type FitnessWeights, DEFAULT_FITNESS_WEIGHTS } from './genetics/fitness.js';
import { type RankedAgent } from './genetics/population.js';
import { EvolvedAgent } from './agents/evolvedAgent.js';
import { BasicAgent } from './agents/basicAgent.js';

export interface TournamentConfig {
  /** Number of games each agent plays (half as p1, half as p2) */
  gamesPerAgent: number;
  runnerOpts: RunnerOptions;
  fitnessWeights?: FitnessWeights;
  /** If true, agents play against the basic greedy agent; otherwise round-robin */
  vsBaseline?: boolean;
}

export const DEFAULT_TOURNAMENT_CONFIG: TournamentConfig = {
  gamesPerAgent: 4,
  runnerOpts: { mapWidth: 30, mapHeight: 20, maxTurns: 200 },
  vsBaseline: true,
};

/**
 * Evaluate a population of genomes via a tournament.
 * Returns agents ranked by aggregate fitness.
 */
export function runTournament(
  genomes: Genome[],
  config: TournamentConfig = DEFAULT_TOURNAMENT_CONFIG,
): RankedAgent[] {
  const fitnessWeights = config.fitnessWeights ?? DEFAULT_FITNESS_WEIGHTS;
  const scores = new Map<number, number>(); // genome index → total fitness

  for (let i = 0; i < genomes.length; i++) {
    scores.set(i, 0);
  }

  if (config.vsBaseline) {
    // Each agent plays against the basic greedy agent
    for (let i = 0; i < genomes.length; i++) {
      let totalFitness = 0;
      const gamesPerSide = Math.ceil(config.gamesPerAgent / 2);

      // Play as player1
      for (let g = 0; g < gamesPerSide; g++) {
        const agent = new EvolvedAgent(genomes[i]);
        const opponent = new BasicAgent();
        const seed = (i * config.gamesPerAgent + g) * 7919 + 1;
        const result = runGame(agent, opponent, {
          ...config.runnerOpts,
          mapSeed: seed,
        });
        totalFitness += computeFitness(result.p1Outcome, fitnessWeights);
      }

      // Play as player2
      for (let g = 0; g < gamesPerSide; g++) {
        const agent = new EvolvedAgent(genomes[i]);
        const opponent = new BasicAgent();
        const seed = (i * config.gamesPerAgent + g + gamesPerSide) * 7919 + 2;
        const result = runGame(opponent, agent, {
          ...config.runnerOpts,
          mapSeed: seed,
        });
        totalFitness += computeFitness(result.p2Outcome, fitnessWeights);
      }

      scores.set(i, totalFitness / config.gamesPerAgent);
    }
  } else {
    // Round-robin (subset): each agent plays against a few random opponents
    for (let i = 0; i < genomes.length; i++) {
      let totalFitness = 0;
      let gamesPlayed = 0;

      for (let g = 0; g < config.gamesPerAgent; g++) {
        // Pick a random opponent (deterministically based on index)
        const oppIdx = (i + g + 1) % genomes.length;
        if (oppIdx === i) continue;

        const asP1 = g % 2 === 0;
        const agent = new EvolvedAgent(genomes[i]);
        const opponent = new EvolvedAgent(genomes[oppIdx]);
        const seed = (i * config.gamesPerAgent + g) * 7919 + 3;

        if (asP1) {
          const result = runGame(agent, opponent, {
            ...config.runnerOpts,
            mapSeed: seed,
          });
          totalFitness += computeFitness(result.p1Outcome, fitnessWeights);
        } else {
          const result = runGame(opponent, agent, {
            ...config.runnerOpts,
            mapSeed: seed,
          });
          totalFitness += computeFitness(result.p2Outcome, fitnessWeights);
        }
        gamesPlayed++;
      }

      scores.set(i, gamesPlayed > 0 ? totalFitness / gamesPlayed : 0);
    }
  }

  // Build ranked list
  const ranked: RankedAgent[] = [];
  for (let i = 0; i < genomes.length; i++) {
    ranked.push({
      genome: genomes[i],
      fitness: scores.get(i)!,
    });
  }

  return ranked.sort((a, b) => b.fitness - a.fitness);
}
