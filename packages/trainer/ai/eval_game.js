/**
 * Node.js game evaluator for evolution.
 * Runs NN agent (player1) vs real BasicAgent (player2).
 *
 * Usage:
 *   # Single dense model (NnAgent):
 *   node eval_game.js --model model.onnx --width 30 --height 10 --max-turns 300 --games 10
 *
 *   # MoE agent (NnMoEAgent):
 *   node eval_game.js --agent moe --moe-dir ./checkpoints/moe --width 30 --height 10 --games 5
 *
 * Outputs one fitness value per line (city-accumulation score, normalised to [0,1]).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createGameState, applyAction, getPlayerView, BasicAgent, NnAgent, NnMoEAgent } from '@sc/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = process.argv[++i];
    args[key] = isNaN(Number(val)) ? val : Number(val);
  }
}

const agentType = args.agent || 'nn';          // 'nn' | 'moe'
const modelPath = args.model || process.env.NN_MODEL_PATH;
const moeDir    = args.moeDir || process.env.NN_MOE_DIR;
const mapWidth  = args.width    || 30;
const mapHeight = args.height   || 10;
const maxTurns  = args.maxTurns || 300;
const numGames  = args.games    || 1;

const MAX_CONSECUTIVE_FAILURES = 3;

async function runGame(p1Agent, basicAgent) {
  const state = createGameState({ width: mapWidth, height: mapHeight });
  const totalCities = state.cities.length;

  let winner = null;
  let cityScore = 0;

  while (winner === null && state.turn < maxTurns) {
    const pid = state.currentPlayer;

    if (pid === 'player1') {
      let consecutiveFailures = 0;
      let done = false;
      while (!done && state.winner === null && state.currentPlayer === pid) {
        const freshView = getPlayerView(state, pid);
        const freshObs = { ...freshView, myPlayerId: pid };
        const action = await p1Agent.act(freshObs);
        if (action.type === 'END_TURN') {
          applyAction(state, action, pid);
          done = true;
        } else {
          const res = applyAction(state, action, pid);
          if (!res.success) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              applyAction(state, { type: 'END_TURN' }, pid);
              done = true;
            }
          } else {
            consecutiveFailures = 0;
          }
        }
      }
      cityScore += state.cities.filter(c => c.owner === 'player1').length;
    } else {
      const view = getPlayerView(state, pid);
      const obs = { ...view, myPlayerId: pid };
      const action = basicAgent.act(obs);
      const res = applyAction(state, action, pid);
      if (!res.success && action.type !== 'END_TURN') {
        applyAction(state, { type: 'END_TURN' }, pid);
      }
    }

    winner = state.winner;
  }

  const fitness = totalCities > 0 ? cityScore / (maxTurns * totalCities) : 0;
  return { winner, state, fitness };
}

async function main() {
  // Build player1 agent
  let p1Agent;
  if (agentType === 'moe') {
    if (!moeDir) throw new Error('--moe-dir (or NN_MOE_DIR) required for moe agent');
    process.env.NN_MOE_DIR = path.resolve(moeDir);
    p1Agent = new NnMoEAgent();
  } else {
    process.env.NN_MODEL_PATH = modelPath || './checkpoints/bertil-v2.0.onnx';
    p1Agent = new NnAgent();
  }

  const basicAgent = new BasicAgent();

  const state0 = createGameState({ width: mapWidth, height: mapHeight });
  const actualMapHeight = state0.mapHeight;

  await p1Agent.init({ playerId: 'player1', mapWidth, mapHeight: actualMapHeight });
  basicAgent.init({ playerId: 'player2', mapWidth, mapHeight: actualMapHeight });

  for (let g = 0; g < numGames; g++) {
    try {
      const { winner, state, fitness } = await runGame(p1Agent, basicAgent);
      const nnCities = state.cities.filter(c => c.owner === 'player1').length;
      const totalCities = state.cities.length;
      console.log(fitness.toFixed(4));
      process.stderr.write(`Game ${g + 1}/${numGames}: Winner=${winner ?? 'draw'}, FinalCities=${nnCities}/${totalCities}, fitness=${fitness.toFixed(4)}\n`);
    } catch (err) {
      process.stderr.write(`Game ${g + 1} error: ${err.message}\n`);
      console.log(0);
    }
  }
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
