import { GENOME_LENGTH, cloneGenome } from './genome.js';
/**
 * Single-point crossover: pick a random cut point and swap tails.
 */
export function crossover(parent1, parent2, rng) {
    const cut = Math.floor(rng() * GENOME_LENGTH);
    const child1 = cloneGenome(parent1);
    const child2 = cloneGenome(parent2);
    for (let i = cut; i < GENOME_LENGTH; i++) {
        child1.weights[i] = parent2.weights[i];
        child2.weights[i] = parent1.weights[i];
    }
    return [child1, child2];
}
/**
 * Uniform crossover: each gene independently picked from either parent.
 */
export function uniformCrossover(parent1, parent2, rng) {
    const child = cloneGenome(parent1);
    for (let i = 0; i < GENOME_LENGTH; i++) {
        if (rng() < 0.5) {
            child.weights[i] = parent2.weights[i];
        }
    }
    return child;
}
/**
 * Mutate a genome in-place. Each gene has `rate` probability of being perturbed.
 * Perturbation: add Gaussian noise with given `strength`, clamp to [-1, 1].
 */
export function mutate(genome, rate, strength, rng) {
    for (let i = 0; i < GENOME_LENGTH; i++) {
        if (rng() < rate) {
            // Box-Muller transform for Gaussian noise
            const u1 = rng() || 1e-10;
            const u2 = rng();
            const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            genome.weights[i] += gaussian * strength;
            // Clamp
            genome.weights[i] = Math.max(-1, Math.min(1, genome.weights[i]));
        }
    }
}
//# sourceMappingURL=crossover.js.map