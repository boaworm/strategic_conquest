import { type Genome } from './genetics/genome.js';
import { type RunnerOptions } from './runner.js';
import { type FitnessWeights } from './genetics/fitness.js';
export interface WorkerTask {
    genomeIndex: number;
    genome: Genome;
    opponentGenome?: Genome;
    asPlayer1: boolean;
    mapSeed: number;
    runnerOpts: RunnerOptions;
    fitnessWeights?: FitnessWeights;
}
export interface WorkerResult {
    genomeIndex: number;
    fitness: number;
    won: boolean;
    turns: number;
}
//# sourceMappingURL=worker.d.ts.map