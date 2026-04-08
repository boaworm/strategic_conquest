/**
 * Worker process for parallel data collection.
 * Config comes from environment variables; progress is written to stdout as JSON lines.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  createGameState,
  applyAction,
  getPlayerView,
  BasicAgent,
  playerViewToTensor,
} from '@sc/shared';
import type { AgentAction } from '@sc/shared';
import { snapshotGame } from './replayUtils.js';

const workerId  = parseInt(process.env.WORKER_ID!);
const gameStart = parseInt(process.env.GAME_START!);
const gameEnd   = parseInt(process.env.GAME_END!);
const mapWidth  = parseInt(process.env.MAP_WIDTH!);
const mapHeight = parseInt(process.env.MAP_HEIGHT!);
const maxTurns  = parseInt(process.env.MAX_TURNS!);
const tmpDir    = process.env.TMP_DIR!;

const MAX_ACTIONS_PER_TURN  = 500;
const MAX_SAMPLES_PER_GAME  = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');

// Optional: save per-game replays when REPLAY_DIR is set
const replayDir = process.env.REPLAY_DIR ?? null;
if (replayDir) fs.mkdirSync(replayDir, { recursive: true });

const progressFile = path.join(tmpDir, `progress-${workerId}.txt`);

function writeProgress(gameNumber: number): void {
  fs.writeFileSync(progressFile, String(gameNumber));
}

process.stderr.write(`[W${workerId}] started, games ${gameStart}-${gameEnd}\n`);

const statesFd  = fs.openSync(path.join(tmpDir, `worker-${workerId}.states.bin`), 'w');
const actionsWs = fs.createWriteStream(path.join(tmpDir, `worker-${workerId}.actions.jsonl`), { encoding: 'utf-8' });

let totalSamples = 0;
const wins = { player1: 0, player2: 0, draw: 0 };

// Process pre-assigned game range - no locking needed
for (let gameNumber = gameStart; gameNumber <= gameEnd; gameNumber++) {
  let state: ReturnType<typeof createGameState>;
  try {
    state = createGameState({ width: mapWidth, height: mapHeight });
  } catch {
    // Map generation failed constraints — skip this game
    writeProgress(gameNumber);
    continue;
  }

  const agents: Record<string, BasicAgent> = {
    player1: new BasicAgent(),
    player2: new BasicAgent(),
  };
  agents.player1.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  agents.player2.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  let prevPlayer = state.currentPlayer;
  let actionsThisTurn = 0;

  // Reservoir sampling: uniformly sample MAX_SAMPLES_PER_GAME across the full game.
  type Sample = { tensor: Float32Array; actionJson: string };
  const reservoir: Sample[] = [];
  let seenThisGame = 0;

  // Per-game replay frames (only when REPLAY_DIR is set)
  const replayFrames = replayDir ? [snapshotGame(state)] : null;
  let prevTurn = state.turn;

  while (state.winner === null && state.turn < maxTurns) {
    const pid = state.currentPlayer as 'player1' | 'player2';

    if (pid !== prevPlayer) {
      actionsThisTurn = 0;
      prevPlayer = pid;
    }

    const view = getPlayerView(state, pid);
    const action: AgentAction = agents[pid].act({ ...view, myPlayerId: pid } as any);

    // Reservoir sampling (Algorithm R)
    const sample: Sample = { tensor: playerViewToTensor(view), actionJson: JSON.stringify(action) };
    if (seenThisGame < MAX_SAMPLES_PER_GAME) {
      reservoir.push(sample);
    } else {
      const j = Math.floor(Math.random() * (seenThisGame + 1));
      if (j < MAX_SAMPLES_PER_GAME) reservoir[j] = sample;
    }
    seenThisGame++;

    const res = applyAction(state, action, pid);
    if (!res.success) {
      applyAction(state, { type: 'END_TURN' }, pid);
      actionsThisTurn = 0;
    } else if (action.type === 'END_TURN') {
      actionsThisTurn = 0;
    } else {
      actionsThisTurn++;
      if (actionsThisTurn >= MAX_ACTIONS_PER_TURN) {
        applyAction(state, { type: 'END_TURN' }, pid);
        actionsThisTurn = 0;
      }
    }

    // Snapshot after each full round (turn increments after player2 ends)
    if (replayFrames && state.turn !== prevTurn) {
      replayFrames.push(snapshotGame(state));
      prevTurn = state.turn;
    }
  }

  // Flush reservoir to disk
  for (const s of reservoir) {
    fs.writeSync(statesFd, Buffer.from(s.tensor.buffer));
    actionsWs.write(s.actionJson + '\n');
    totalSamples++;
  }

  if (state.winner === 'player1')      wins.player1++;
  else if (state.winner === 'player2') wins.player2++;
  else                                  wins.draw++;

  const p1cities = state.cities.filter((c) => c.owner === 'player1').length;
  const p2cities = state.cities.filter((c) => c.owner === 'player2').length;
  const neutral  = state.cities.filter((c) => c.owner === null).length;

  // Save replay file if REPLAY_DIR is configured
  if (replayDir && replayFrames) {
    if (state.winner !== null && replayFrames[replayFrames.length - 1].turn !== state.turn) {
      replayFrames.push(snapshotGame(state));
    }
    const id = randomUUID();
    const replay = {
      meta: {
        id,
        recordedAt: new Date().toISOString(),
        turns: state.turn,
        winner: state.winner,
        p1Cities: p1cities,
        p2Cities: p2cities,
        neutralCities: neutral,
        mapWidth: state.mapWidth,
        mapHeight: state.mapHeight,
        frames: replayFrames.length,
      },
      tiles: state.tiles,
      frames: replayFrames,
    };
    fs.writeFileSync(path.join(replayDir, `${id}.json`), JSON.stringify(replay));
  }

   process.stderr.write(
    `[W${workerId}] game ${gameNumber}: turns=${state.turn} winner=${state.winner ?? 'draw'} ` +
    `p1=${p1cities} p2=${p2cities} neutral=${neutral} samples=${seenThisGame}\n`,
  );

  if (gameNumber === gameStart || gameNumber % 50 === 0 || gameNumber === gameEnd) {
    writeProgress(gameNumber);
  }
}

fs.closeSync(statesFd);
await new Promise<void>((resolve) => actionsWs.end(resolve));

// Write final result as JSON so main process can read it
fs.writeFileSync(path.join(tmpDir, `result-${workerId}.json`), JSON.stringify({ samples: totalSamples, wins }));
