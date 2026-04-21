/**
 * Records N agent-vs-agent games and saves each as a replay file.
 * Spawns a pool of long-lived worker processes via IPC. The parent holds
 * a shared game queue and hands one game at a time to whichever worker
 * is free, so slow games don't stall the pool. Workers load their agents
 * (and any ONNX sessions) once at startup and reuse them across games.
 *
 * Usage:
 *   npm run record
 *   NUM_GAMES=50 WORKERS=8 npm run record
 *   NUM_GAMES=20 MAX_TURNS=300 P1_AGENT=basicAgent P2_AGENT=gunAirAgent npm run record
 *
 * Agent names (case-insensitive): basicAgent, gunAirAgent,
 *   nnAgent:<model>, nnMoEAgent:<dir>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fork, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const NUM_GAMES  = parseInt(process.env.NUM_GAMES  ?? '5');
const WORKERS    = parseInt(process.env.WORKERS    ?? String(os.cpus().length));
const MAP_WIDTH  = parseInt(process.env.MAP_WIDTH  ?? '50');
const MAP_HEIGHT = parseInt(process.env.MAP_HEIGHT ?? '20');
const MAX_TURNS  = parseInt(process.env.MAX_TURNS  ?? '500');
if (!process.env.DATA_DIR) { console.error('DATA_DIR env var is required'); process.exit(1); }
const REPLAY_DIR = path.join(process.env.DATA_DIR, 'replays');
const P1_AGENT   = process.env.P1_AGENT ?? process.env.P1AGENT ?? 'basicAgent';
const P2_AGENT   = process.env.P2_AGENT ?? process.env.P2AGENT ?? 'basicAgent';

const workerScript = fileURLToPath(new URL('../dist/record_worker.js', import.meta.url));

type GameResult = { completed: number; skipped: number };

function spawnWorker(slotId: number): ChildProcess {
  return fork(workerScript, [], {
    env: {
      ...process.env,
      WORKER_ID:  String(slotId),
      MAP_WIDTH:  String(MAP_WIDTH),
      MAP_HEIGHT: String(MAP_HEIGHT),
      MAX_TURNS:  String(MAX_TURNS),
      REPLAY_DIR: REPLAY_DIR,
      P1_AGENT:   P1_AGENT,
      P2_AGENT:   P2_AGENT,
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(REPLAY_DIR, { recursive: true });

  const concurrency = Math.min(WORKERS, NUM_GAMES);
  console.log(`Recording ${NUM_GAMES} game(s) across ${concurrency} worker(s) → ${REPLAY_DIR}`);
  console.log(`  p1=${P1_AGENT}  p2=${P2_AGENT}`);

  const t0 = Date.now();
  let nextGame = 0;      // claimed game count (single-threaded JS: safe between awaits)
  let totalCompleted = 0;
  let totalSkipped = 0;

  async function runSlot(slotId: number): Promise<void> {
    const child = spawnWorker(slotId);

    try {
      while (nextGame < NUM_GAMES) {
        const gameNum = ++nextGame;  // claim before awaiting
        const gameStart = Date.now();

        const result = await new Promise<GameResult>((resolve, reject) => {
          const onMessage = (msg: any) => {
            if (msg?.type === 'done') {
              child.off('message', onMessage);
              child.off('exit', onExit);
              resolve(msg.result as GameResult);
            }
          };
          const onExit = (code: number | null) => {
            child.off('message', onMessage);
            reject(new Error(`Worker ${slotId} exited with code ${code} during game ${gameNum}`));
          };
          child.on('message', onMessage);
          child.on('exit', onExit);
          child.send({ type: 'game', gameNum });
        });

        totalCompleted += result.completed;
        totalSkipped   += result.skipped;

        const done   = totalCompleted + totalSkipped;
        const pct    = Math.floor((done / NUM_GAMES) * 100);
        const gameMs = ((Date.now() - gameStart) / 1000).toFixed(1);
        console.log(`${pct}% (${done}/${NUM_GAMES} games, ${gameMs}s)`);
      }
    } finally {
      // Drain complete — tell the worker to exit and wait for it
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('exit', () => resolve());
        try { child.send({ type: 'exit' }); } catch { /* already gone */ }
      });
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, i) => runSlot(i)),
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${totalCompleted} replays recorded, ${totalSkipped} skipped`);
  console.log(`Run "npm run replay" to view.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
