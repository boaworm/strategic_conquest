/**
 * IPC worker for parallel replay recording.
 * Stays alive across games; parent sends { type: 'game', gameNum } per job
 * and { type: 'exit' } when the pool is drained. Responds with
 * { type: 'done', result: { completed, skipped } } per game.
 *
 * Static config (env vars, set once by parent at fork):
 *   WORKER_ID, MAP_WIDTH, MAP_HEIGHT, MAX_TURNS, REPLAY_DIR,
 *   P1_AGENT, P2_AGENT
 *
 * Agent names (case-insensitive): basicAgent, gunAirAgent,
 *   nnAgent:<model>, nnMoEAgent:<dir>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  createGameState,
  applyAction,
  getPlayerView,
  BasicAgent,
  GunAirAgent,
  NnAgent,
  NnMoEAgent,
} from '@sc/shared';
import type { Agent, AgentAction } from '@sc/shared';
import { snapshotGame, type ReplayMeta } from './replayUtils.js';

const workerId    = parseInt(process.env.WORKER_ID!);
const mapWidth    = parseInt(process.env.MAP_WIDTH!);
const mapHeight   = parseInt(process.env.MAP_HEIGHT!);
const maxTurns    = parseInt(process.env.MAX_TURNS!);
const replayDir   = process.env.REPLAY_DIR!;
const p1AgentName = process.env.P1_AGENT ?? process.env.P1AGENT ?? 'basicAgent';
const p2AgentName = process.env.P2_AGENT ?? process.env.P2AGENT ?? 'basicAgent';

const MAX_ACTIONS_PER_TURN = 500;

const isAsync = (n: string) => {
  const l = n.toLowerCase();
  return l.startsWith('nnagent:') || l.startsWith('nn:')
      || l.startsWith('nnmoeagent:') || l.startsWith('moe:');
};
const p1IsAsync = isAsync(p1AgentName);
const p2IsAsync = isAsync(p2AgentName);

function resolveModelPath(modelName: string): string {
  if (modelName.startsWith('/') || modelName.includes('/')) return modelName;
  const checkpointsDir = path.join(__dirname, '../ai/checkpoints');
  return path.join(checkpointsDir, `${modelName}.onnx`);
}

function makeAgent(name: string): Agent {
  const lower = name.toLowerCase();

  if (lower.startsWith('nnagent:') || lower.startsWith('nn:')) {
    const modelName = name.split(':')[1];
    if (modelName) {
      const agent = new NnAgent();
      process.env.NN_MODEL_PATH = resolveModelPath(modelName);
      return agent;
    }
  }

  if (lower.startsWith('nnmoeagent:') || lower.startsWith('moe:')) {
    const dir = name.split(':')[1];
    if (dir) {
      const projectRoot = path.resolve(__dirname, '../../..');
      process.env.NN_MOE_DIR = path.resolve(projectRoot, dir.replace(/^\.\//, ''));
      return new NnMoEAgent();
    }
  }

  switch (lower) {
    case 'gunairagent':
    case 'gunair':
      return new GunAirAgent();
    case 'basicagent':
    case 'basic':
    default:
      return new BasicAgent();
  }
}

fs.mkdirSync(replayDir, { recursive: true });

process.stderr.write(`[W${workerId}] started — (p1=${p1AgentName} p2=${p2AgentName})\n`);

type GameResult = { completed: number; skipped: number };

async function runGame(gameNum: number): Promise<GameResult> {
  let state: ReturnType<typeof createGameState>;
  try {
    state = createGameState({ width: mapWidth, height: mapHeight });
  } catch {
    return { completed: 0, skipped: 1 };
  }

  const agents: Record<string, Agent> = {
    player1: makeAgent(p1AgentName),
    player2: makeAgent(p2AgentName),
  };

  const init1 = agents.player1.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  const init2 = agents.player2.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  if (p1IsAsync) await init1;
  if (p2IsAsync) await init2;

  const frames: ReturnType<typeof snapshotGame>[] = [];
  let prevTurn = state.turn;
  let actionsThisTurn = 0;
  let prevPlayer = state.currentPlayer;

  while (state.winner === null && state.turn <= maxTurns) {
    const pid = state.currentPlayer as 'player1' | 'player2';
    if (pid !== prevPlayer) { actionsThisTurn = 0; prevPlayer = pid; }

    const view = getPlayerView(state, pid);
    const actionResult = agents[pid].act({ ...view, myPlayerId: pid } as any);
    const action: AgentAction = actionResult instanceof Promise ? await actionResult : actionResult;

    const res = applyAction(state, action, pid);
    if (!res.success) {
      actionsThisTurn++;
      if (actionsThisTurn >= MAX_ACTIONS_PER_TURN) {
        applyAction(state, { type: 'END_TURN' }, pid);
        actionsThisTurn = 0;
      }
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
      frames.push(snapshotGame(state, agents));
      prevTurn = state.turn;
    }
  }

  if (state.winner !== null && frames[frames.length - 1].turn !== state.turn) {
    frames.push(snapshotGame(state, agents));
  }

  const p1Cities = state.cities.filter((c) => c.owner === 'player1').length;
  const p2Cities = state.cities.filter((c) => c.owner === 'player2').length;
  const neutral  = state.cities.filter((c) => c.owner === null).length;

  const id = randomUUID();

  const meta: ReplayMeta = {
    id,
    gameNum,
    recordedAt: new Date().toISOString(),
    turns: state.turn,
    winner: state.winner,
    p1Cities,
    p2Cities,
    neutralCities: neutral,
    mapWidth: state.mapWidth,
    mapHeight: state.mapHeight,
    frames: frames.length,
    p1Agent: p1AgentName,
    p2Agent: p2AgentName,
  };

  fs.writeFileSync(
    path.join(replayDir, `${id}.json`),
    JSON.stringify({ meta, mapWidth: state.mapWidth, mapHeight: state.mapHeight, tiles: state.tiles, frames }),
  );

  process.stderr.write(
    `[W${workerId}] game ${gameNum}: [${id.slice(0, 8)}] turns=${state.turn} winner=${state.winner ?? 'draw'} ` +
    `p1=${p1Cities} p2=${p2Cities} neutral=${neutral}\n`,
  );

  return { completed: 1, skipped: 0 };
}

process.on('message', async (msg: any) => {
  if (msg?.type === 'exit') {
    process.stderr.write(`[W${workerId}] exiting\n`);
    process.exit(0);
  }
  if (msg?.type === 'game') {
    try {
      const result = await runGame(msg.gameNum);
      process.send!({ type: 'done', result });
    } catch (err: any) {
      process.stderr.write(`[W${workerId}] game ${msg.gameNum} error: ${err.message}\n`);
      process.send!({ type: 'done', result: { completed: 0, skipped: 1 } });
    }
  }
});
