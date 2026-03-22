import { runGame } from './runner.js';
import { computeFitness, DEFAULT_FITNESS_WEIGHTS } from './genetics/fitness.js';
import { EvolvedAgent } from './agents/evolvedAgent.js';
import { BasicAgent } from './agents/basicAgent.js';
export const DEFAULT_TOURNAMENT_CONFIG = {
    gamesPerAgent: 4,
    runnerOpts: { mapWidth: 30, mapHeight: 20, maxTurns: 200 },
    vsBaseline: true,
};
/**
 * Evaluate a population of genomes via a tournament.
 * Returns agents ranked by aggregate fitness.
 */
export function runTournament(genomes, config = DEFAULT_TOURNAMENT_CONFIG) {
    const fitnessWeights = config.fitnessWeights ?? DEFAULT_FITNESS_WEIGHTS;
    const scores = new Map(); // genome index → total fitness
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
    }
    else {
        // Round-robin (subset): each agent plays against a few random opponents
        for (let i = 0; i < genomes.length; i++) {
            let totalFitness = 0;
            let gamesPlayed = 0;
            for (let g = 0; g < config.gamesPerAgent; g++) {
                // Pick a random opponent (deterministically based on index)
                const oppIdx = (i + g + 1) % genomes.length;
                if (oppIdx === i)
                    continue;
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
                }
                else {
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
    const ranked = [];
    for (let i = 0; i < genomes.length; i++) {
        ranked.push({
            genome: genomes[i],
            fitness: scores.get(i),
        });
    }
    return ranked.sort((a, b) => b.fitness - a.fitness);
}
//# sourceMappingURL=tournament.js.map