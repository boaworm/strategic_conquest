/**
 * Phase 2: Imitation Learning — Parallel Data Collection
 *
 * Runs NUM_GAMES headless games of BasicAgent vs BasicAgent across WORKERS
 * child processes and records every (state tensor, action) pair to disk.
 *
 * Output (in OUTPUT_DIR/):
 *   states.bin    — raw float32 bytes, N × (C × H × W) floats, no header
 *   actions.jsonl — one action JSON per line, line i corresponds to tensor i
 *   meta.json     — mapWidth, mapHeight, numChannels, numSamples, numGames, wins
 *
 * Usage:
 *   NUM_GAMES=50000 WORKERS=8 OUTPUT_DIR=./data npm run collect
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const NUM_GAMES  = parseInt(process.env.NUM_GAMES  ?? '1000');
const WORKERS    = parseInt(process.env.WORKERS    ?? '1');
if (!process.env.DATA_DIR) { console.error('DATA_DIR env var is required'); process.exit(1); }
const OUTPUT_DIR = path.join(process.env.DATA_DIR, 'training');
const MAP_WIDTH  = parseInt(process.env.MAP_WIDTH  ?? '50');
const MAP_HEIGHT = parseInt(process.env.MAP_HEIGHT ?? '20');
const MAX_TURNS          = parseInt(process.env.MAX_TURNS          ?? '500');
const MAX_SAMPLES_PER_GAME = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');

const NUM_CHANNELS = 14;
const TENSOR_BYTES = NUM_CHANNELS * (MAP_HEIGHT + 2) * MAP_WIDTH * 4;  // +2 for ice cap rows

// Use compiled JS worker — avoids tsx startup overhead on every child process
const workerScript = fileURLToPath(new URL('../dist/collect_worker.js', import.meta.url));
const tmpDir = path.join(OUTPUT_DIR, 'tmp');

function spawnWorker(workerId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript], {
      env: {
        ...process.env,
        WORKER_ID:  String(workerId),
        TOTAL_GAMES:  String(NUM_GAMES),
        MAP_WIDTH:  String(MAP_WIDTH),
        MAP_HEIGHT: String(MAP_HEIGHT),
        MAX_TURNS:           String(MAX_TURNS),
        MAX_SAMPLES_PER_GAME: String(MAX_SAMPLES_PER_GAME),
        TMP_DIR:             tmpDir,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });

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

function pipeFile(src: string, dest: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = fs.createReadStream(src);
    reader.on('error', reject);
    dest.on('error', reject);
    reader.on('end', () => {
      // 'end' means the reader delivered all data to the writable's buffer.
      // If the buffer is still draining, wait for it before moving on —
      // otherwise the next pipe would start while writes are still pending.
      if (dest.writableNeedDrain) {
        dest.once('drain', resolve);
      } else {
        resolve();
      }
    });
    reader.pipe(dest, { end: false });
  });
}

function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(0) + ' MB';
}

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // Initialize shared game counter
  fs.writeFileSync(path.join(tmpDir, 'game_counter.txt'), '0');

  console.log(`Collecting data: ${NUM_GAMES} games across ${WORKERS} worker(s), map ${MAP_WIDTH}×${MAP_HEIGHT}`);

  const t0 = Date.now();
  let lastReportedPct = -1;

  // Poll progress files every second
  const pollInterval = setInterval(() => {
    const totalDone = Array.from({ length: WORKERS }, (_, i) => readProgress(i))
      .reduce((a, b) => a + b, 0);
    const pct = Math.min(100, Math.floor((totalDone / NUM_GAMES) * 100));
    if (pct > lastReportedPct) {
      lastReportedPct = pct;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${pct}% completed (${totalDone.toLocaleString()}/${NUM_GAMES.toLocaleString()} games, ${elapsed}s)`);
    }
  }, 1000);

  await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => spawnWorker(i)),
  );

  clearInterval(pollInterval);

  // Aggregate results from workers
  let totalSamples = 0;
  const wins = { player1: 0, player2: 0, draw: 0 };
  for (let i = 0; i < WORKERS; i++) {
    const result = JSON.parse(fs.readFileSync(path.join(tmpDir, `result-${i}.json`), 'utf-8'));
    totalSamples += result.samples;
    wins.player1 += result.wins.player1;
    wins.player2 += result.wins.player2;
    wins.draw += result.wins.draw;
  }

  // Move worker files to output dir (no merge — keep per-worker files)
  for (let i = 0; i < WORKERS; i++) {
    fs.renameSync(path.join(tmpDir, `worker-${i}.states.bin`), path.join(OUTPUT_DIR, `worker-${i}.states.bin`));
    fs.renameSync(path.join(tmpDir, `worker-${i}.actions.jsonl`), path.join(OUTPUT_DIR, `worker-${i}.actions.jsonl`));
  }
  fs.rmSync(tmpDir, { recursive: true });

  const meta = {
    mapWidth:    MAP_WIDTH,
    mapHeight:   MAP_HEIGHT + 2,
    numChannels: NUM_CHANNELS,
    numSamples:  totalSamples,
    numGames:    NUM_GAMES,
    wins,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const mbPerWorker = ((TENSOR_BYTES * (totalSamples / WORKERS)) / 1e6).toFixed(1);

  console.log(`Done in ${elapsed}s`);
  console.log(`  ${totalSamples.toLocaleString()} samples, ${NUM_GAMES.toLocaleString()} games`);
  console.log(`  P1 wins: ${wins.player1}  P2 wins: ${wins.player2}  Draws: ${wins.draw}`);
  console.log(`  Per-worker states: ~${mbPerWorker} MB each`);
  console.log(`  Output: ${OUTPUT_DIR}/ (worker-*.states.bin, worker-*.actions.jsonl)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
