/**
 * Records N agent-vs-agent games and saves each as a replay file.
 * Runs across WORKERS parallel child processes using a pool — each slot claims
 * one game at a time so workers stay busy until the exact target is reached.
 *
 * Usage:
 *   npm run record
 *   NUM_GAMES=50 WORKERS=8 npm run record
 *   NUM_GAMES=20 MAX_TURNS=300 P1_AGENT=basicAgent P2_AGENT=gunAirAgent npm run record
 *
 * Agent names (case-insensitive): basicAgent, gunAirAgent, adamAI
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const NUM_GAMES  = parseInt(process.env.NUM_GAMES  ?? '5');
const WORKERS    = parseInt(process.env.WORKERS    ?? String(os.cpus().length));
const MAP_WIDTH  = parseInt(process.env.MAP_WIDTH  ?? '50');
const MAP_HEIGHT = parseInt(process.env.MAP_HEIGHT ?? '20');
const MAX_TURNS  = parseInt(process.env.MAX_TURNS  ?? '500');
const REPLAY_DIR = process.env.REPLAY_DIR ?? '../../tmp';
const P1_AGENT   = process.env.P1_AGENT ?? process.env.P1AGENT ?? 'basicAgent';
const P2_AGENT   = process.env.P2_AGENT ?? process.env.P2AGENT ?? 'basicAgent';

// Use compiled JS worker to avoid tsx startup overhead on every child process
const workerScript = fileURLToPath(new URL('../dist/record_worker.js', import.meta.url));
const tmpDir = path.join(REPLAY_DIR, '.record-tmp');

function spawnWorker(slotId: number, gameNum: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript], {
      env: {
        ...process.env,
        WORKER_ID:  String(slotId),
        GAME_NUM:   String(gameNum),
        NUM_GAMES:  '1',
        MAP_WIDTH:  String(MAP_WIDTH),
        MAP_HEIGHT: String(MAP_HEIGHT),
        MAX_TURNS:  String(MAX_TURNS),
        REPLAY_DIR: REPLAY_DIR,
        TMP_DIR:    tmpDir,
        P1_AGENT:   P1_AGENT,
        P2_AGENT:   P2_AGENT,
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Worker slot ${slotId} (game ${gameNum}) exited with code ${code}`));
    });

    child.on('error', (err) => {
      reject(new Error(`Worker slot ${slotId} failed to start: ${err.message}`));
    });
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(REPLAY_DIR, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const concurrency = Math.min(WORKERS, NUM_GAMES);
  console.log(`Recording ${NUM_GAMES} game(s) across ${concurrency} worker(s) → ${REPLAY_DIR}`);
  console.log(`  p1=${P1_AGENT}  p2=${P2_AGENT}`);

  const t0 = Date.now();
  let nextGame = 0;      // claimed game count (JS single-thread: no race between awaits)
  let totalCompleted = 0;
  let totalSkipped = 0;

  async function runSlot(slotId: number): Promise<void> {
    while (nextGame < NUM_GAMES) {
      const gameNum = ++nextGame;  // claim before first await — safe in single-threaded JS event loop
      await spawnWorker(slotId, gameNum);

      try {
        const r = JSON.parse(fs.readFileSync(path.join(tmpDir, `result-${slotId}.json`), 'utf-8'));
        totalCompleted += r.completed;
        totalSkipped   += r.skipped;
      } catch { /* worker may have crashed before writing result */ }

      const done = totalCompleted + totalSkipped;
      const pct  = Math.floor((done / NUM_GAMES) * 100);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${pct}% (${done}/${NUM_GAMES} games, ${elapsed}s)`);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => runSlot(i)),
  );

  fs.rmSync(tmpDir, { recursive: true });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${totalCompleted} replays recorded, ${totalSkipped} skipped`);
  console.log(`Run "npm run replay" to view.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
