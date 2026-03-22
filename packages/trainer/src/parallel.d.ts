import { type Genome } from './genetics/genome.js';
import { type RankedAgent } from './genetics/population.js';
import { type RunnerOptions } from './runner.js';
import { type FitnessWeights } from './genetics/fitness.js';
export interface ParallelEvalConfig {
    workerCount: number;
    gamesPerAgent: number;
    runnerOpts: RunnerOptions;
    fitnessWeights?: FitnessWeights;
    vsBaseline?: boolean;
}
/**
 * Evaluate a population using a pool of worker threads.
 * Each worker runs one game at a time. Tasks are distributed round-robin.
 */
export declare function evaluateParallel(genomes: Genome[], config: ParallelEvalConfig): Promise<RankedAgent[]>;
//# sourceMappingURL=parallel.d.ts.map