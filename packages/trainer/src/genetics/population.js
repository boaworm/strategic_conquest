import { randomGenome, cloneGenome } from './genome.js';
import { crossover, mutate } from './crossover.js';
export const DEFAULT_POP_CONFIG = {
    size: 100,
    eliteCount: 10,
    mutationRate: 0.15,
    mutationStrength: 0.3,
};
/** Simple seeded PRNG (mulberry32). */
function mulberry32(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * Initialize a random population.
 */
export function initPopulation(config) {
    const rng = mulberry32(config.seed ?? Date.now());
    const pop = [];
    for (let i = 0; i < config.size; i++) {
        pop.push(randomGenome(rng));
    }
    return pop;
}
/**
 * Tournament selection: pick `k` random agents and return the fittest.
 */
function tournamentSelect(ranked, k, rng) {
    let best = null;
    for (let i = 0; i < k; i++) {
        const idx = Math.floor(rng() * ranked.length);
        const candidate = ranked[idx];
        if (!best || candidate.fitness > best.fitness) {
            best = candidate;
        }
    }
    return cloneGenome(best.genome);
}
/**
 * Produce the next generation from the current ranked population.
 * - Top `eliteCount` survive unchanged
 * - Rest are filled by crossover + mutation of tournament-selected parents
 */
export function nextGeneration(ranked, config) {
    const rng = mulberry32(Date.now());
    // Sort by fitness descending
    const sorted = [...ranked].sort((a, b) => b.fitness - a.fitness);
    const next = [];
    // Elites survive
    for (let i = 0; i < config.eliteCount && i < sorted.length; i++) {
        next.push(cloneGenome(sorted[i].genome));
    }
    // Fill remainder via crossover + mutation
    while (next.length < config.size) {
        const parent1 = tournamentSelect(sorted, 3, rng);
        const parent2 = tournamentSelect(sorted, 3, rng);
        const [child1, child2] = crossover(parent1, parent2, rng);
        mutate(child1, config.mutationRate, config.mutationStrength, rng);
        mutate(child2, config.mutationRate, config.mutationStrength, rng);
        next.push(child1);
        if (next.length < config.size) {
            next.push(child2);
        }
    }
    return next;
}
//# sourceMappingURL=population.js.map