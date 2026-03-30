import { performance } from 'node:perf_hooks';
import { BasicAgent } from '@sc/shared';
import { runGame } from './runner.js';

const agent1 = new BasicAgent();
const agent2 = new BasicAgent();

console.time('Game');
const start = performance.now();

const result = runGame(agent1, agent2, { maxTurns: 200 });

const end = performance.now();

console.log('Game result:', result);
console.log(`Time: ${(end - start).toFixed(2)}ms`);
