/**
 * Worker process for parallel replay recording.
 * Config comes from environment variables; progress written to tmp/progress-N.txt.
 * Each completed game is written directly as a JSON file to REPLAY_DIR.
 *
 * P1_AGENT / P2_AGENT — agent name for each player (default: basicAgent).
 * Supported values: basicAgent, gunAirAgent, nnAgent:<model_path>, nnMoEAgent:<dir>
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

const workerId  = parseInt(process.env.WORKER_ID!);
const gameNum   = parseInt(process.env.GAME_NUM ?? process.env.WORKER_ID!);
const numGames  = parseInt(process.env.NUM_GAMES!);
const mapWidth  = parseInt(process.env.MAP_WIDTH!);
const mapHeight = parseInt(process.env.MAP_HEIGHT!);
const maxTurns  = parseInt(process.env.MAX_TURNS!);
const replayDir = process.env.REPLAY_DIR!;
const tmpDir    = process.env.TMP_DIR!;
const p1AgentName = process.env.P1_AGENT ?? process.env.P1AGENT ?? 'basicAgent';
const p2AgentName = process.env.P2_AGENT ?? process.env.P2AGENT ?? 'basicAgent';

const MAX_ACTIONS_PER_TURN = 500;

// Track if either agent is async (NnAgent)
let p1IsAsync = false;
let p2IsAsync = false;

// Resolve model path - supports shorthand names like "adam" → checkpoints/adam.onnx
function resolveModelPath(modelName: string): string {
  // If it's an absolute path or contains /, use as-is
  if (modelName.startsWith('/') || modelName.includes('/')) {
    return modelName;
  }
  // Otherwise, treat as shorthand and look in ../ai/checkpoints relative to dist/
  const checkpointsDir = path.join(__dirname, '../ai/checkpoints');
  return path.join(checkpointsDir, `${modelName}.onnx`);
}

function makeAgent(name: string): Agent {
  const lower = name.toLowerCase();

  // nnAgent:<model>  or  nn:<model>
  if (lower.startsWith('nnagent:') || lower.startsWith('nn:')) {
    const modelName = name.split(':')[1];
    if (modelName) {
      const agent = new NnAgent();
      process.env.NN_MODEL_PATH = resolveModelPath(modelName);
      return agent;
    }
  }

  // nnMoEAgent:<dir>  or  moe:<dir>
  if (lower.startsWith('nnmoeagent:') || lower.startsWith('moe:')) {
    const dir = name.split(':')[1];
    if (dir) {
      process.env.NN_MOE_DIR = dir.startsWith('/') ? dir : path.resolve(__dirname, '..', dir);
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

const progressFile = path.join(tmpDir, `progress-${workerId}.txt`);

function writeProgress(game: number): void {
  fs.writeFileSync(progressFile, String(game));
}

process.stderr.write(`[W${workerId}] started — ${numGames} games (p1=${p1AgentName} p2=${p2AgentName})\n`);

// Check if agents are async
p1IsAsync = p1AgentName.toLowerCase().startsWith('nnagent:') || p1AgentName.toLowerCase().startsWith('nn:');
p2IsAsync = p2AgentName.toLowerCase().startsWith('nnagent:') || p2AgentName.toLowerCase().startsWith('nn:');

let completed = 0;
let skipped = 0;

async function runGame(g: number): Promise<void> {
  let state: ReturnType<typeof createGameState>;
  try {
    state = createGameState({ width: mapWidth, height: mapHeight });
  } catch {
    skipped++;
    writeProgress(g + 1);
    return;
  }

  const agents: Record<string, Agent> = {
    player1: makeAgent(p1AgentName),
    player2: makeAgent(p2AgentName),
  };

  // Initialize agents (await for NnAgent)
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
    gameNum: gameNum + g,
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

  fs.writeFileSync(path.join(replayDir, `${id}.json`), JSON.stringify({ meta, mapWidth: state.mapWidth, mapHeight: state.mapHeight, tiles: state.tiles, frames }));
  completed++;

  process.stderr.write(
    `[W${workerId}] game ${gameNum + g}: [${id.slice(0, 8)}] turns=${state.turn} winner=${state.winner ?? 'draw'} ` +
    `p1=${p1Cities} p2=${p2Cities} neutral=${neutral}\n`,
  );

  if (g === 0 || (g + 1) % 10 === 0 || g === numGames - 1) {
    writeProgress(g + 1);
  }
}

// Run games sequentially (async if NN agent involved)
async function runAllGames(): Promise<void> {
  for (let g = 0; g < numGames; g++) {
    await runGame(g);
  }
  // Write final result summary
  fs.writeFileSync(path.join(tmpDir, `result-${workerId}.json`), JSON.stringify({ completed, skipped }));
  writeProgress(numGames);
  process.stderr.write(`[W${workerId}] done — ${completed} recorded, ${skipped} skipped\n`);
}

runAllGames().catch(err => {
  process.stderr.write(`[W${workerId}] error: ${err.message}\n`);
  process.exit(1);
});
