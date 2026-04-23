/**
 * MoE Imitation Learning — Parallel Data Collection
 *
 * Spawns WORKERS child processes. Each worker runs continuously,
 * asking the coordinator for game numbers. Workers stop when their
 * file reaches TARGET_SIZE_BYTES. Coordinator waits for all workers.
 *
 * Usage:
 *   DATA_DIR=./data WORKERS=8 TARGET_SIZE_BYTES=42949672960 npm run collect-moe
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const WORKERS    = parseInt(process.env.WORKERS    ?? '8');
if (!process.env.DATA_DIR) { console.error('DATA_DIR env var is required'); process.exit(1); }
const OUTPUT_DIR = process.env.DATA_DIR;
const MAP_WIDTH  = parseInt(process.env.MAP_WIDTH  ?? '50');
const MAP_HEIGHT = parseInt(process.env.MAP_HEIGHT ?? '20');
const MAX_TURNS  = parseInt(process.env.MAX_TURNS  ?? '500');
const MAX_SAMPLES_PER_GAME = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');
const PROD_ONLY  = process.env.PROD_ONLY === '1';
const UNIT_TYPE_FILTER = process.env.UNIT_TYPE_FILTER;
const TARGET_SIZE_BYTES = parseInt(process.env.TARGET_SIZE_BYTES ?? '0');

const UNIT_TYPE_NAMES = ['army', 'fighter', 'missile', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship'];

const workerScript = fileURLToPath(new URL('../dist/collect_moe_worker.js', import.meta.url));

let nextGameNumber = 1;
const workerStatus: Map<number, { done: boolean; lastGame: number }> = new Map();

function spawnWorker(workerId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript], {
      env: {
        ...process.env,
        WORKER_ID:       String(workerId),
        MAP_WIDTH:       String(MAP_WIDTH),
        MAP_HEIGHT:      String(MAP_HEIGHT),
        MAX_TURNS:       String(MAX_TURNS),
        MAX_SAMPLES_PER_GAME: String(MAX_SAMPLES_PER_GAME),
        PROD_ONLY:       String(PROD_ONLY ? 1 : 0),
        UNIT_TYPE_FILTER: UNIT_TYPE_FILTER ?? '',
        TARGET_SIZE_BYTES: String(TARGET_SIZE_BYTES),
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      if (line.trim() === 'NEXT') {
        child.stdin!.write(`${nextGameNumber++}\n`);
      }
    });

    workerStatus.set(workerId, { done: false, lastGame: 0 });

    child.on('exit', (code) => {
      if (code === 0) {
        workerStatus.set(workerId, { done: true, lastGame: workerStatus.get(workerId)?.lastGame ?? 0 });
        console.log(`Worker ${workerId} done (file size reached)`);
        resolve();
      } else {
        reject(new Error(`Worker ${workerId} exited with code ${code}`));
      }
    });
    child.on('error', (err) => reject(new Error(`Worker ${workerId} failed: ${err.message}`)));
  });
}

function allWorkersDone(): boolean {
  for (const [id, status] of workerStatus) {
    if (!status.done) return false;
  }
  return workerStatus.size === WORKERS;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`MoE data collection: ${WORKERS} workers, map ${MAP_WIDTH}×${MAP_HEIGHT}, target ${TARGET_SIZE_BYTES} bytes`);

  const t0 = Date.now();

  // Spawn all workers
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => spawnWorker(i)));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
