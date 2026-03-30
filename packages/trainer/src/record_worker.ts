/**
 * Worker process for parallel replay recording.
 * Config comes from environment variables; progress written to tmp/progress-N.txt.
 * Each completed game is written directly as a JSON file to REPLAY_DIR.
 *
 * P1_AGENT / P2_AGENT — agent name for each player (default: basicAgent).
 * Supported values: basicAgent, gunAirAgent
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  createGameState,
  applyAction,
  getPlayerView,
  BasicAgent,
  GunAirAgent,
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

function makeAgent(name: string): Agent {
  switch (name.toLowerCase()) {
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

  const agents: Record<string, Agent> = {
    player1: makeAgent(p1AgentName),
    player2: makeAgent(p2AgentName),
  };
  agents.player1.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  agents.player2.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  const frames: ReturnType<typeof snapshotGame>[] = [snapshotGame(state, agents)];
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

  // Get phase transitions from agents
  const p1Phase2Turn = agents.player1 instanceof BasicAgent ? agents.player1.getPhaseTransitions().phase2Turn : undefined;
  const p1Phase3Turn = agents.player1 instanceof BasicAgent ? agents.player1.getPhaseTransitions().phase3Turn : undefined;
  const p2Phase2Turn = agents.player2 instanceof BasicAgent ? agents.player2.getPhaseTransitions().phase2Turn : undefined;
  const p2Phase3Turn = agents.player2 instanceof BasicAgent ? agents.player2.getPhaseTransitions().phase3Turn : undefined;

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
    p1Phase2Turn,
    p1Phase3Turn,
    p2Phase2Turn,
    p2Phase3Turn,
  };

  fs.writeFileSync(path.join(replayDir, `${id}.json`), JSON.stringify({ meta, tiles: state.tiles, frames }));
  completed++;

  const phaseTag = (agent: Agent, prefix: string): string => {
    if (!(agent instanceof BasicAgent)) return '';
    const { phase2Turn, phase3Turn } = agent.getPhaseTransitions();
    return [
      phase2Turn !== undefined ? `${prefix}ph2=${phase2Turn}` : '',
      phase3Turn !== undefined ? `${prefix}ph3=${phase3Turn}` : '',
    ].filter(Boolean).join(' ');
  };
  const phaseParts = [phaseTag(agents.player1, 'p1'), phaseTag(agents.player2, 'p2')].filter(Boolean).join(' ');

  process.stderr.write(
    `[W${workerId}] game ${gameNum + g}: [${id.slice(0, 8)}] turns=${state.turn} winner=${state.winner ?? 'draw'} ` +
    `p1=${p1Cities} p2=${p2Cities} neutral=${neutral}${phaseParts ? ' ' + phaseParts : ''}\n`,
  );

  if (g === 0 || (g + 1) % 10 === 0 || g === numGames - 1) {
    writeProgress(g + 1);
  }
}

// Write final result summary
fs.writeFileSync(path.join(tmpDir, `result-${workerId}.json`), JSON.stringify({ completed, skipped }));
writeProgress(numGames);
process.stderr.write(`[W${workerId}] done — ${completed} recorded, ${skipped} skipped\n`);
