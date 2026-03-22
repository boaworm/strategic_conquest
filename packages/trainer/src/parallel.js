import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULT_FITNESS_WEIGHTS } from './genetics/fitness.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Evaluate a population using a pool of worker threads.
 * Each worker runs one game at a time. Tasks are distributed round-robin.
 */
export async function evaluateParallel(genomes, config) {
    const workerFile = path.join(__dirname, 'worker.ts');
    const fitnessWeights = config.fitnessWeights ?? DEFAULT_FITNESS_WEIGHTS;
    // Build task list
    const tasks = [];
    for (let i = 0; i < genomes.length; i++) {
        const gamesPerSide = Math.ceil(config.gamesPerAgent / 2);
        for (let g = 0; g < gamesPerSide; g++) {
            // As player 1
            tasks.push({
                genomeIndex: i,
                genome: genomes[i],
                asPlayer1: true,
                mapSeed: (i * config.gamesPerAgent + g) * 7919 + 1,
                runnerOpts: config.runnerOpts,
                fitnessWeights,
            });
            // As player 2
            tasks.push({
                genomeIndex: i,
                genome: genomes[i],
                asPlayer1: false,
                mapSeed: (i * config.gamesPerAgent + g + gamesPerSide) * 7919 + 2,
                runnerOpts: config.runnerOpts,
                fitnessWeights,
            });
        }
    }
    // Accumulate results
    const fitnessAccum = new Map();
    for (let i = 0; i < genomes.length; i++) {
        fitnessAccum.set(i, { total: 0, count: 0 });
    }
    // Create worker pool
    const workers = [];
    for (let i = 0; i < config.workerCount; i++) {
        const w = new Worker(workerFile, {
            execArgv: ['--loader', 'tsx'],
        });
        workers.push(w);
    }
    // Distribute tasks
    return new Promise((resolve, reject) => {
        let taskIdx = 0;
        let completed = 0;
        function sendNext(worker) {
            if (taskIdx < tasks.length) {
                worker.postMessage(tasks[taskIdx++]);
            }
        }
        for (const worker of workers) {
            worker.on('message', (result) => {
                const accum = fitnessAccum.get(result.genomeIndex);
                accum.total += result.fitness;
                accum.count++;
                completed++;
                if (completed === tasks.length) {
                    // All done — terminate workers and return results
                    for (const w of workers)
                        w.terminate();
                    const ranked = [];
                    for (let i = 0; i < genomes.length; i++) {
                        const a = fitnessAccum.get(i);
                        ranked.push({
                            genome: genomes[i],
                            fitness: a.count > 0 ? a.total / a.count : 0,
                        });
                    }
                    ranked.sort((a, b) => b.fitness - a.fitness);
                    resolve(ranked);
                }
                else {
                    sendNext(worker);
                }
            });
            worker.on('error', (err) => {
                for (const w of workers)
                    w.terminate();
                reject(err);
            });
            // Start each worker with a task
            sendNext(worker);
        }
    });
}
//# sourceMappingURL=parallel.js.map