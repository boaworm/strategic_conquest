/**
 * Records N BasicAgent vs BasicAgent games and saves each as a replay file.
 *
 * Usage:
 *   npm run record
 *   NUM_GAMES=10 npm run record
 *   NUM_GAMES=20 MAP_WIDTH=50 MAP_HEIGHT=20 npm run record
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

const NUM_GAMES  = parseInt(process.env.NUM_GAMES  ?? '5');
const MAP_WIDTH  = parseInt(process.env.MAP_WIDTH  ?? '50');
const MAP_HEIGHT = parseInt(process.env.MAP_HEIGHT ?? '20');
const MAX_TURNS  = parseInt(process.env.MAX_TURNS  ?? '500');
const REPLAY_DIR = process.env.REPLAY_DIR ?? '../../tmp';

const MAX_ACTIONS_PER_TURN = 500;

fs.mkdirSync(REPLAY_DIR, { recursive: true });
console.log(`Recording ${NUM_GAMES} game(s) → ${REPLAY_DIR}`);

for (let g = 0; g < NUM_GAMES; g++) {
  const id = randomUUID();

  let state;
  try {
    state = createGameState({ width: MAP_WIDTH, height: MAP_HEIGHT });
  } catch {
    console.log(`  Game ${g + 1}: map generation failed, skipping`);
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

  while (state.winner === null && state.turn <= MAX_TURNS) {
    const pid = state.currentPlayer as 'player1' | 'player2';
    if (pid !== prevPlayer) { actionsThisTurn = 0; prevPlayer = pid; }

    const view = getPlayerView(state, pid);
    const action: AgentAction = agents[pid].act({ ...view, myPlayerId: pid } as any);

    const res = applyAction(state, action, pid);
    if (!res.success) {
      if (state.turn > 20) {
        console.log(`  [REJECTED] turn=${state.turn} ${pid} → ${JSON.stringify(action)} | reason: ${res.error}`);
      }
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

  fs.writeFileSync(path.join(REPLAY_DIR, `${id}.json`), JSON.stringify({ meta, tiles: state.tiles, frames }));
  console.log(`  Game ${g + 1}: [${id.slice(0, 8)}] turns=${state.turn} winner=${state.winner ?? 'draw'} p1=${p1Cities} p2=${p2Cities} neutral=${neutral}`);
}

console.log(`\nDone. Run "npm run replay" to view.`);
