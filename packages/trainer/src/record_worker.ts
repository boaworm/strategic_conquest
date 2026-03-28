/**
 * Worker process for parallel replay recording.
 * Config comes from environment variables; progress written to tmp/progress-N.txt.
 * Each completed game is written directly as a JSON file to REPLAY_DIR.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  createGameState,
  applyAction,
  getPlayerView,
  BasicAgent,
} from '@sc/shared';
import type { AgentAction } from '@sc/shared';
import { snapshotGame, type ReplayMeta } from './replayUtils.js';

const workerId  = parseInt(process.env.WORKER_ID!);
const gameNum   = parseInt(process.env.GAME_NUM ?? process.env.WORKER_ID!);
const numGames  = parseInt(process.env.NUM_GAMES!);
const mapWidth  = parseInt(process.env.MAP_WIDTH!);
const mapHeight = parseInt(process.env.MAP_HEIGHT!);
const maxTurns  = parseInt(process.env.MAX_TURNS!);
const replayDir = process.env.REPLAY_DIR!;
const tmpDir    = process.env.TMP_DIR!;

const MAX_ACTIONS_PER_TURN = 500;

fs.mkdirSync(replayDir, { recursive: true });

const progressFile = path.join(tmpDir, `progress-${workerId}.txt`);

function writeProgress(game: number): void {
  fs.writeFileSync(progressFile, String(game));
}

process.stderr.write(`[W${workerId}] started — ${numGames} games\n`);

let completed = 0;
let skipped = 0;

for (let g = 0; g < numGames; g++) {
  let state: ReturnType<typeof createGameState>;
  try {
    state = createGameState({ width: mapWidth, height: mapHeight });
  } catch {
    skipped++;
    writeProgress(g + 1);
    continue;
  }

  const agents: Record<string, BasicAgent> = {
    player1: new BasicAgent(),
    player2: new BasicAgent(),
  };
  agents.player1.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  agents.player2.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  const frames: ReturnType<typeof snapshotGame>[] = [snapshotGame(state)];
  let prevTurn = state.turn;
  let actionsThisTurn = 0;
  let prevPlayer = state.currentPlayer;

  while (state.winner === null && state.turn <= maxTurns) {
    const pid = state.currentPlayer as 'player1' | 'player2';
    if (pid !== prevPlayer) { actionsThisTurn = 0; prevPlayer = pid; }

    const view = getPlayerView(state, pid);
    const action: AgentAction = agents[pid].act({ ...view, myPlayerId: pid } as any);

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

    if (state.turn !== prevTurn) {
      frames.push(snapshotGame(state));
      prevTurn = state.turn;
    }
  }

  if (state.winner !== null && frames[frames.length - 1].turn !== state.turn) {
    frames.push(snapshotGame(state));
  }

  const p1Cities = state.cities.filter((c) => c.owner === 'player1').length;
  const p2Cities = state.cities.filter((c) => c.owner === 'player2').length;
  const neutral  = state.cities.filter((c) => c.owner === null).length;

  const id = randomUUID();
  const meta: ReplayMeta = {
    id,
    recordedAt: new Date().toISOString(),
    turns: state.turn,
    winner: state.winner,
    p1Cities,
    p2Cities,
    neutralCities: neutral,
    mapWidth: state.mapWidth,
    mapHeight: state.mapHeight,
    frames: frames.length,
  };

  fs.writeFileSync(path.join(replayDir, `${id}.json`), JSON.stringify({ meta, tiles: state.tiles, frames }));
  completed++;

  process.stderr.write(
    `[W${workerId}] game ${gameNum + g}: [${id.slice(0, 8)}] turns=${state.turn} winner=${state.winner ?? 'draw'} ` +
    `p1=${p1Cities} p2=${p2Cities} neutral=${neutral}\n`,
  );

  if (g === 0 || (g + 1) % 10 === 0 || g === numGames - 1) {
    writeProgress(g + 1);
  }
}

// Write final result summary
fs.writeFileSync(path.join(tmpDir, `result-${workerId}.json`), JSON.stringify({ completed, skipped }));
writeProgress(numGames);
process.stderr.write(`[W${workerId}] done — ${completed} recorded, ${skipped} skipped\n`);
