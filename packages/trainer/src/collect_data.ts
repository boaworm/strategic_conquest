/**
 * Phase 2: Imitation Learning — Parallel Data Collection
 *
 * Runs NUM_GAMES headless games of BasicAgent vs BasicAgent across WORKERS
 * child processes and records every (state tensor, action) pair to disk.
 *
 * Output (in OUTPUT_DIR/):
 *   worker-N.states.bin  — raw float32 bytes, per worker
 *   worker-N.actions.bin — raw int8 bytes, per worker
 *   worker-N.tiles.bin   — raw int32 bytes, per worker
 *   meta.json            — mapWidth, mapHeight, numChannels, numSamples, numGames, wins
 *
 * Usage:
 *   TARGET_SIZE_GB=50 NUM_GAMES=999999 WORKERS=8 DATA_DIR=./data npm run collect
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';

const NUM_GAMES  = parseInt(process.env.NUM_GAMES  ?? '999999');
const WORKERS    = parseInt(process.env.WORKERS    ?? '1');
if (!process.env.DATA_DIR) { console.error('DATA_DIR env var is required'); process.exit(1); }
const OUTPUT_DIR = path.join(process.env.DATA_DIR, 'training');
const MAP_WIDTH  = parseInt(process.env.MAP_WIDTH  ?? '50');
const MAP_HEIGHT = parseInt(process.env.MAP_HEIGHT ?? '20');
const MAX_TURNS          = parseInt(process.env.MAX_TURNS          ?? '500');
const MAX_SAMPLES_PER_GAME = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');

const TARGET_SIZE_GB = parseFloat(process.env.TARGET_SIZE_GB ?? '0'); // 0 = unlimited
const TARGET_SIZE_KB = TARGET_SIZE_GB > 0 ? TARGET_SIZE_GB * 1024 * 1024 : Infinity;

const NUM_CHANNELS = 14;
const TENSOR_BYTES = NUM_CHANNELS * (MAP_HEIGHT + 2) * MAP_WIDTH * 4;  // +2 for ice cap rows

const workerScript = fileURLToPath(new URL('../dist/collect_worker.js', import.meta.url));
const tmpDir = path.join(OUTPUT_DIR, 'tmp');

function currentSizeKB(): number {
  try {
    const out = execSync(`du -sk "${OUTPUT_DIR}"`, { encoding: 'utf-8' });
    return parseInt(out.split('\t')[0]);
  } catch {
    return 0;
  }
}

function spawnWorker(workerId: number, onRequest: (child: ChildProcess) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript], {
      env: {
        ...process.env,
        WORKER_ID:   String(workerId),
        MAP_WIDTH:   String(MAP_WIDTH),
        MAP_HEIGHT:  String(MAP_HEIGHT),
        MAX_TURNS:   String(MAX_TURNS),
        MAX_SAMPLES_PER_GAME: String(MAX_SAMPLES_PER_GAME),
        TMP_DIR:     tmpDir,
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });

    child.on('message', () => onRequest(child));

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Worker ${workerId} exited with code ${code}`));
    });

    child.on('error', (err) => {
      reject(new Error(`Worker ${workerId} failed to start: ${err.message}`));
    });
  });
}

function readProgress(workerId: number): number {
  try {
    return parseInt(fs.readFileSync(path.join(tmpDir, `progress-${workerId}.txt`), 'utf-8')) || 0;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const limitStr = TARGET_SIZE_GB > 0 ? `, limit ${TARGET_SIZE_GB} GB` : '';
  console.log(`Collecting data: up to ${NUM_GAMES} games across ${WORKERS} worker(s), map ${MAP_WIDTH}×${MAP_HEIGHT}${limitStr}`);

  const t0 = Date.now();
  let nextGameId = 1;
  let totalAssigned = 0;
  let stopSignaled = false;

  function handleRequest(child: ChildProcess): void {
    if (stopSignaled || totalAssigned >= NUM_GAMES) {
      child.send({ gameId: -1 });
      return;
    }
    // Check size limit every 10 games
    if (TARGET_SIZE_KB < Infinity && totalAssigned % 10 === 0) {
      const sizeKB = currentSizeKB();
      if (sizeKB >= TARGET_SIZE_KB) {
        stopSignaled = true;
        console.log(`Size limit reached (${(sizeKB / 1024 / 1024).toFixed(2)} GB >= ${TARGET_SIZE_GB} GB), winding down workers`);
        child.send({ gameId: -1 });
        return;
      }
    }
    child.send({ gameId: nextGameId++ });
    totalAssigned++;
  }

  let lastReportedTotal = -1;

  const pollInterval = setInterval(() => {
    const totalDone = Array.from({ length: WORKERS }, (_, i) => readProgress(i))
      .reduce((sum, n) => sum + n, 0);
    if (totalDone !== lastReportedTotal) {
      lastReportedTotal = totalDone;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const sizeStr = TARGET_SIZE_KB < Infinity
        ? `  ${(currentSizeKB() / 1024 / 1024).toFixed(2)}/${TARGET_SIZE_GB} GB`
        : '';
      console.log(`${totalDone} games done (${elapsed}s)${sizeStr}`);
    }
  }, 5000);

  const workers = Array.from({ length: WORKERS }, (_, i) => spawnWorker(i, handleRequest));

  await Promise.all(workers);
  clearInterval(pollInterval);

  // Aggregate results from workers
  let totalSamples = 0;
  const wins = { player1: 0, player2: 0, draw: 0 };
  for (let i = 0; i < WORKERS; i++) {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(tmpDir, `result-${i}.json`), 'utf-8'));
      totalSamples += result.samples;
      wins.player1 += result.wins.player1;
      wins.player2 += result.wins.player2;
      wins.draw += result.wins.draw;
    } catch { /* worker may have done zero games */ }
  }

  // Move worker files to output dir
  for (let i = 0; i < WORKERS; i++) {
    for (const ext of ['states.bin', 'actions.bin', 'tiles.bin']) {
      const src = path.join(tmpDir, `worker-${i}.${ext}`);
      if (fs.existsSync(src)) {
        fs.renameSync(src, path.join(OUTPUT_DIR, `worker-${i}.${ext}`));
      }
    }
  }
  fs.rmSync(tmpDir, { recursive: true });

  const meta = {
    mapWidth:    MAP_WIDTH,
    mapHeight:   MAP_HEIGHT + 2,
    numChannels: NUM_CHANNELS,
    numSamples:  totalSamples,
    numGames:    totalAssigned,
    wins,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const mbPerWorker = ((TENSOR_BYTES * (totalSamples / WORKERS)) / 1e6).toFixed(1);

  console.log(`Done in ${elapsed}s`);
  console.log(`  ${totalSamples.toLocaleString()} samples, ${totalAssigned.toLocaleString()} games`);
  console.log(`  P1 wins: ${wins.player1}  P2 wins: ${wins.player2}  Draws: ${wins.draw}`);
  console.log(`  Per-worker states: ~${mbPerWorker} MB each`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
