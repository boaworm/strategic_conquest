import { parentPort, workerData } from 'node:worker_threads';
import { type Genome } from './genetics/genome.js';
import { runGame, type RunnerOptions } from './runner.js';
import { computeFitness, type FitnessWeights, DEFAULT_FITNESS_WEIGHTS } from './genetics/fitness.js';
import { EvolvedAgent } from './agents/evolvedAgent.js';
import { BasicAgent } from './agents/basicAgent.js';

export interface WorkerTask {
  genomeIndex: number;
  genome: Genome;
  opponentGenome?: Genome;  // if undefined, play vs BasicAgent
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

// When run as a worker thread, process incoming tasks
if (parentPort) {
  parentPort.on('message', (task: WorkerTask) => {
    const agent = new EvolvedAgent(task.genome);
    const opponent = task.opponentGenome
      ? new EvolvedAgent(task.opponentGenome)
      : new BasicAgent();

    const opts = { ...task.runnerOpts, mapSeed: task.mapSeed };
    const fitnessWeights = task.fitnessWeights ?? DEFAULT_FITNESS_WEIGHTS;

    let fitness: number;
    let won: boolean;
    let turns: number;

    if (task.asPlayer1) {
      const result = runGame(agent, opponent, opts);
      fitness = computeFitness(result.p1Outcome, fitnessWeights);
      won = result.winner === 'player1';
      turns = result.turns;
    } else {
      const result = runGame(opponent, agent, opts);
      fitness = computeFitness(result.p2Outcome, fitnessWeights);
      won = result.winner === 'player2';
      turns = result.turns;
    }

    const response: WorkerResult = {
      genomeIndex: task.genomeIndex,
      fitness,
      won,
      turns,
    };

    parentPort!.postMessage(response);
  });
}
