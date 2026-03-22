import { type Genome } from './genome.js';
/**
 * Single-point crossover: pick a random cut point and swap tails.
 */
export declare function crossover(parent1: Genome, parent2: Genome, rng: () => number): [Genome, Genome];
/**
 * Uniform crossover: each gene independently picked from either parent.
 */
export declare function uniformCrossover(parent1: Genome, parent2: Genome, rng: () => number): Genome;
/**
 * Mutate a genome in-place. Each gene has `rate` probability of being perturbed.
 * Perturbation: add Gaussian noise with given `strength`, clamp to [-1, 1].
 */
export declare function mutate(genome: Genome, rate: number, strength: number, rng: () => number): void;
//# sourceMappingURL=crossover.d.ts.map