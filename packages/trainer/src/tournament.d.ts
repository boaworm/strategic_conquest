import { type Genome } from './genetics/genome.js';
import { type RunnerOptions } from './runner.js';
import { type FitnessWeights } from './genetics/fitness.js';
import { type RankedAgent } from './genetics/population.js';
export interface TournamentConfig {
    /** Number of games each agent plays (half as p1, half as p2) */
    gamesPerAgent: number;
    runnerOpts: RunnerOptions;
    fitnessWeights?: FitnessWeights;
    /** If true, agents play against the basic greedy agent; otherwise round-robin */
    vsBaseline?: boolean;
}
export declare const DEFAULT_TOURNAMENT_CONFIG: TournamentConfig;
/**
 * Evaluate a population of genomes via a tournament.
 * Returns agents ranked by aggregate fitness.
 */
export declare function runTournament(genomes: Genome[], config?: TournamentConfig): RankedAgent[];
//# sourceMappingURL=tournament.d.ts.map