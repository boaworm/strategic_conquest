import { type Genome } from './genome.js';
export interface PopulationConfig {
    size: number;
    eliteCount: number;
    mutationRate: number;
    mutationStrength: number;
    seed?: number;
}
export declare const DEFAULT_POP_CONFIG: PopulationConfig;
export interface RankedAgent {
    genome: Genome;
    fitness: number;
}
/**
 * Initialize a random population.
 */
export declare function initPopulation(config: PopulationConfig): Genome[];
/**
 * Produce the next generation from the current ranked population.
 * - Top `eliteCount` survive unchanged
 * - Rest are filled by crossover + mutation of tournament-selected parents
 */
export declare function nextGeneration(ranked: RankedAgent[], config: PopulationConfig): Genome[];
//# sourceMappingURL=population.d.ts.map