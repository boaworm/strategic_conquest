/**
 * Worker process for parallel data collection.
 * Requests game IDs from the coordinator via IPC; exits when it receives gameId -1.
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
const mapWidth  = parseInt(process.env.MAP_WIDTH!);
const mapHeight = parseInt(process.env.MAP_HEIGHT!);
const maxTurns  = parseInt(process.env.MAX_TURNS!);
const tmpDir    = process.env.TMP_DIR!;

const MAX_ACTIONS_PER_TURN  = 500;
const MAX_SAMPLES_PER_GAME  = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');

const replayDir = process.env.REPLAY_DIR ?? null;
if (replayDir) fs.mkdirSync(replayDir, { recursive: true });

const progressFile = path.join(tmpDir, `progress-${workerId}.txt`);
let gamesCompleted = 0;

function writeProgress(): void {
  fs.writeFileSync(progressFile, String(gamesCompleted));
}

function nextGameId(): Promise<number> {
  return new Promise((resolve) => {
    process.send!('next');
    process.once('message', (msg: any) => resolve(msg.gameId));
  });
}

process.stderr.write(`[W${workerId}] started\n`);

const statesFd  = fs.openSync(path.join(tmpDir, `worker-${workerId}.states.bin`), 'w');
const actionsFd = fs.openSync(path.join(tmpDir, `worker-${workerId}.actions.bin`), 'w');
const tilesFd   = fs.openSync(path.join(tmpDir, `worker-${workerId}.tiles.bin`), 'w');

let totalSamples = 0;
const wins = { player1: 0, player2: 0, draw: 0 };

async function main() {
  while (true) {
    const gameNumber = await nextGameId();
    if (gameNumber < 0) break;

    let state: ReturnType<typeof createGameState>;
    try {
      state = createGameState({ width: mapWidth, height: mapHeight });
    } catch {
      writeProgress();
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

    type Sample = { tensor: Float32Array; actionType: number; tileIdx: number };
    const reservoir: Sample[] = [];
    let seenThisGame = 0;

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

      const actionType = encodeActionType(action.type);
      const tileIdx = action.type === 'MOVE'
        ? ((action as any).to.y * state.mapWidth + (action as any).to.x)
        : -1;

      const sample: Sample = { tensor: playerViewToTensor(view), actionType, tileIdx };
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

      if (replayFrames && state.turn !== prevTurn) {
        replayFrames.push(snapshotGame(state));
        prevTurn = state.turn;
      }
    }

    for (const s of reservoir) {
      fs.writeSync(statesFd,  Buffer.from(s.tensor.buffer));
      fs.writeSync(actionsFd, Buffer.from(new Uint8Array([s.actionType])));
      fs.writeSync(tilesFd,   Buffer.from(new Int32Array([s.tileIdx])));
      totalSamples++;
    }

    if (state.winner === 'player1')      wins.player1++;
    else if (state.winner === 'player2') wins.player2++;
    else                                  wins.draw++;

    const p1cities = state.cities.filter((c) => c.owner === 'player1').length;
    const p2cities = state.cities.filter((c) => c.owner === 'player2').length;
    const neutral  = state.cities.filter((c) => c.owner === null).length;

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

    gamesCompleted++;
    if (gamesCompleted % 10 === 0) writeProgress();
  }

  writeProgress();
  fs.closeSync(statesFd);
  fs.closeSync(actionsFd);
  fs.closeSync(tilesFd);

  fs.writeFileSync(path.join(tmpDir, `result-${workerId}.json`), JSON.stringify({ samples: totalSamples, wins }));
  process.stderr.write(`[W${workerId}] done: ${gamesCompleted} games, ${totalSamples} samples\n`);
}

main().catch((err) => { process.stderr.write(`[W${workerId}] error: ${err}\n`); process.exit(1); });

function encodeActionType(type: string): number {
  switch (type) {
    case 'MOVE':          return 0;
    case 'SET_PRODUCTION':return 1;
    case 'SLEEP':         return 2;
    case 'SKIP':          return 3;
    case 'WAKE':          return 6;
    case 'END_TURN':      return 7;
    default:              return 3;
  }
}
