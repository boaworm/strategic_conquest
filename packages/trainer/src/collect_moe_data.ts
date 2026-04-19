/**
 * MoE Imitation Learning — Parallel Data Collection
 *
 * Spawns WORKERS child processes running collect_moe_worker.ts.
 * Each worker saves per-unit-type binary files to a tmp dir;
 * this coordinator renames them into OUTPUT_DIR/moe/ on completion.
 *
 * Output files (binary format):
 *   worker-{i}-{type}.states.bin     — float32 [N, 14, H, W]
 *   worker-{i}-{type}.positions.bin  — int16 [N, 2] (x, y of the acting unit)
 *   worker-{i}-{type}.actions.bin    — int8 [N] action type encoding
 *   worker-{i}-{type}.tiles.bin      — int32 [N] tile index (-1 for non-move)
 *   worker-{i}-production.states.bin
 *   worker-{i}-production.cities.bin   — int16 [N, 2]
 *   worker-{i}-production.globals.bin  — float32 [N, 22]
 *   worker-{i}-production.unitTypes.bin — int8 [N]
 *   meta.json
 *
 * Usage:
 *   DATA_DIR=./data NUM_GAMES=50000 WORKERS=8 npm run collect-moe
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const NUM_GAMES  = parseInt(process.env.NUM_GAMES  ?? '1000');
const WORKERS    = parseInt(process.env.WORKERS    ?? '8');
if (!process.env.DATA_DIR) { console.error('DATA_DIR env var is required'); process.exit(1); }
const OUTPUT_DIR = process.env.DATA_DIR;
const MAP_WIDTH  = parseInt(process.env.MAP_WIDTH  ?? '50');
const MAP_HEIGHT = parseInt(process.env.MAP_HEIGHT ?? '20');
const MAX_TURNS  = parseInt(process.env.MAX_TURNS  ?? '500');
const MAX_SAMPLES_PER_GAME = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');
const PROD_ONLY  = process.env.PROD_ONLY === '1';
const UNIT_TYPE_FILTER = process.env.UNIT_TYPE_FILTER; // optional: collect only this unit type

const UNIT_TYPE_NAMES = ['army', 'fighter', 'missile', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship'];

const workerScript = fileURLToPath(new URL('../dist/collect_moe_worker.js', import.meta.url));
const tmpDir = path.join(OUTPUT_DIR, 'tmp');

function spawnWorker(workerId: number, gameStart: number, gameEnd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript], {
      env: {
        ...process.env,
        WORKER_ID:       String(workerId),
        GAME_START:      String(gameStart),
        GAME_END:        String(gameEnd),
        MAP_WIDTH:       String(MAP_WIDTH),
        MAP_HEIGHT:      String(MAP_HEIGHT),
        MAX_TURNS:       String(MAX_TURNS),
        MAX_SAMPLES_PER_GAME: String(MAX_SAMPLES_PER_GAME),
        PROD_ONLY:       String(PROD_ONLY ? 1 : 0),
        UNIT_TYPE_FILTER: UNIT_TYPE_FILTER ?? '',
        TMP_DIR:         tmpDir,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Worker ${workerId} exited with code ${code}`));
    });
    child.on('error', (err) => reject(new Error(`Worker ${workerId} failed: ${err.message}`)));
  });
}

function readProgress(workerId: number, gameStart: number, gameEnd: number): number {
  try {
    const done = parseInt(fs.readFileSync(path.join(tmpDir, `progress-${workerId}.txt`), 'utf-8')) || 0;
    return Math.max(0, Math.min(done - gameStart + 1, gameEnd - gameStart + 1));
  } catch { return 0; }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`MoE data collection: ${NUM_GAMES} games, ${WORKERS} worker(s), map ${MAP_WIDTH}×${MAP_HEIGHT}`);

  const t0 = Date.now();
  let lastPct = -1;

  const workerRanges = Array.from({ length: WORKERS }, (_, i) => {
    const gamesPerWorker = Math.ceil(NUM_GAMES / WORKERS);
    const start = i * gamesPerWorker + 1;
    const end = Math.min(start + gamesPerWorker - 1, NUM_GAMES);
    return { start, end };
  });

  const pollInterval = setInterval(() => {
    const totalDone = workerRanges.reduce((sum, { start, end }, i) => sum + readProgress(i, start, end), 0);
    const pct = Math.min(100, Math.floor((totalDone / NUM_GAMES) * 100));
    if (pct > lastPct) {
      lastPct = pct;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const status = workerRanges.map(({ start, end }, i) => `W${i}:${readProgress(i, start, end)}/${end - start + 1}`).join('  ');
      console.log(`${pct}% (${totalDone}/${NUM_GAMES} games, ${elapsed}s)  ${status}`);
    }
  }, 1000);

  await Promise.all(workerRanges.map(({ start, end }, i) => spawnWorker(i, start, end)));
  clearInterval(pollInterval);

  // Aggregate results
  const totalSamples: Record<string, number> = {};
  const wins = { player1: 0, player2: 0, draw: 0 };

  for (let i = 0; i < WORKERS; i++) {
    const result = JSON.parse(fs.readFileSync(path.join(tmpDir, `result-${i}.json`), 'utf-8'));
    for (const [k, v] of Object.entries(result.samples as Record<string, number>)) {
      totalSamples[k] = (totalSamples[k] ?? 0) + v;
    }
    wins.player1 += result.wins.player1;
    wins.player2 += result.wins.player2;
    wins.draw     += result.wins.draw;
  }

  // Move per-worker files into OUTPUT_DIR
  for (let i = 0; i < WORKERS; i++) {
    // Movement files: collect all or filtered type only
    if (!PROD_ONLY) {
      const typesToProcess = UNIT_TYPE_FILTER ? [UNIT_TYPE_FILTER] : UNIT_TYPE_NAMES;
      for (const type of typesToProcess) {
        for (const ext of ['states.bin', 'positions.bin', 'actions.bin', 'tiles.bin']) {
          const src = path.join(tmpDir, `worker-${i}-${type}.${ext}`);
          if (fs.existsSync(src)) {
            fs.renameSync(src, path.join(OUTPUT_DIR, `worker-${i}-${type}.${ext}`));
          }
        }
      }
    }
    // Production files: collect unless filtering to specific movement type
    if (!UNIT_TYPE_FILTER) {
      for (const ext of ['states.bin', 'cities.bin', 'globals.bin', 'unitTypes.bin']) {
        const src = path.join(tmpDir, `worker-${i}-production.${ext}`);
        fs.renameSync(src, path.join(OUTPUT_DIR, `worker-${i}-production.${ext}`));
      }
    }
  }
  fs.rmSync(tmpDir, { recursive: true });

  const meta = {
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT + 2,
    numChannels: 14,
    numSamples: totalSamples,
    numGames: NUM_GAMES,
    wins,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
  console.log(`  Output: ${OUTPUT_DIR}/`);
  for (const [k, v] of Object.entries(totalSamples).sort()) {
    console.log(`  ${k.padEnd(12)}: ${(v as number).toLocaleString()} samples`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
