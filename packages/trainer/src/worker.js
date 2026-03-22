import { parentPort } from 'node:worker_threads';
import { runGame } from './runner.js';
import { computeFitness, DEFAULT_FITNESS_WEIGHTS } from './genetics/fitness.js';
import { EvolvedAgent } from './agents/evolvedAgent.js';
import { BasicAgent } from './agents/basicAgent.js';
// When run as a worker thread, process incoming tasks
if (parentPort) {
    parentPort.on('message', (task) => {
        const agent = new EvolvedAgent(task.genome);
        const opponent = task.opponentGenome
            ? new EvolvedAgent(task.opponentGenome)
            : new BasicAgent();
        const opts = { ...task.runnerOpts, mapSeed: task.mapSeed };
        const fitnessWeights = task.fitnessWeights ?? DEFAULT_FITNESS_WEIGHTS;
        let fitness;
        let won;
        let turns;
        if (task.asPlayer1) {
            const result = runGame(agent, opponent, opts);
            fitness = computeFitness(result.p1Outcome, fitnessWeights);
            won = result.winner === 'player1';
            turns = result.turns;
        }
        else {
            const result = runGame(opponent, agent, opts);
            fitness = computeFitness(result.p2Outcome, fitnessWeights);
            won = result.winner === 'player2';
            turns = result.turns;
        }
        const response = {
            genomeIndex: task.genomeIndex,
            fitness,
            won,
            turns,
        };
        parentPort.postMessage(response);
    });
}
//# sourceMappingURL=worker.js.map