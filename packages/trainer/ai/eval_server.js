/**
 * Persistent Node.js evaluation server for MoE evolution.
 *
 * Stays alive for the entire evolution run. Reads genome requests from stdin
 * (one JSON line per request), runs games using the real TypeScript engine,
 * writes fitness results to stdout (one JSON line per response).
 *
 * Protocol:
 *   stdin:  {"models": {"army": "<base64_onnx>", ..., "production": "..."}, "games": N, "width": W, "height": H, "maxTurns": T}
 *   stdout: {"results": [0.042, 0.038, ...]}
 *   stdout: {"error": "message"}  (on failure)
 */

import { createInterface } from 'readline';
import { createGameState, applyAction, getPlayerView, BasicAgent, NnMoEAgent } from '@sc/shared';
import * as ortNamespace from 'onnxruntime-node';
const ort = ortNamespace.default;

const MAX_CONSECUTIVE_FAILURES = 3;

function getExecutionProviders() {
  if (process.platform === 'darwin') return ['coreml', 'cpu'];
  if (process.platform === 'linux') return ['cuda', 'cpu'];
  return ['cpu'];
}

const sessionOptions = {
  executionProviders: getExecutionProviders(),
  logSeverityLevel: 3,
};

/**
 * Create 9 InferenceSession instances from base64-encoded ONNX bytes.
 */
async function loadSessionsFromBase64(models) {
  const sessions = {};
  await Promise.all(
    Object.entries(models).map(async ([name, b64]) => {
      const buf = Buffer.from(b64, 'base64');
      sessions[name] = await ort.InferenceSession.create(buf, sessionOptions);
    })
  );
  return sessions;
}

/**
 * Run one game: MoE agent (player1) vs BasicAgent (player2).
 * Returns city-accumulation fitness normalized to [0, 1].
 */
async function runGame(nnAgent, basicAgent, mapWidth, mapHeight, maxTurns) {
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
        const action = await nnAgent.act(freshObs);
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
      const action = basicAgent.act({ ...view, myPlayerId: pid });
      const res = applyAction(state, action, pid);
      if (!res.success && action.type !== 'END_TURN') {
        applyAction(state, { type: 'END_TURN' }, pid);
      }
    }

    winner = state.winner;
  }

  return totalCities > 0 ? cityScore / (maxTurns * totalCities) : 0;
}

/**
 * Handle one genome request: load sessions, run N games, return results.
 */
async function handleRequest(req) {
  const { models, games, width, height, maxTurns } = req;

  const sessions = await loadSessionsFromBase64(models);

  // Init a fresh agent pair. NnMoEAgent re-uses sessions across games;
  // BasicAgent also re-uses (it's stateless across games).
  const nnAgent = new NnMoEAgent();
  const basicAgent = new BasicAgent();

  // We need mapHeight including ice caps for init — create a throwaway state
  const state0 = createGameState({ width, height });
  const actualMapHeight = state0.mapHeight;

  nnAgent.initFromSessions(sessions, {
    playerId: 'player1',
    mapWidth: width,
    mapHeight: actualMapHeight,
  });
  basicAgent.init({ playerId: 'player2', mapWidth: width, mapHeight: actualMapHeight });

  const results = [];
  for (let g = 0; g < games; g++) {
    const fitness = await runGame(nnAgent, basicAgent, width, height, maxTurns);
    results.push(fitness);
  }

  return results;
}

// ── Main: read JSON lines from stdin, write JSON lines to stdout ──────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

process.stderr.write('[eval_server] ready\n');

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;

  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: `JSON parse error: ${e.message}` }) + '\n');
    return;
  }

  try {
    const results = await handleRequest(req);
    process.stdout.write(JSON.stringify({ results }) + '\n');
  } catch (e) {
    process.stderr.write(`[eval_server] error: ${e.message}\n${e.stack}\n`);
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
  }
});

rl.on('close', () => {
  process.stderr.write('[eval_server] stdin closed, exiting\n');
  process.exit(0);
});
