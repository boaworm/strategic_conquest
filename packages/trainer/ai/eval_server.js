/**
 * Persistent Node.js evaluation server for MoE evolution.
 *
 * Stays alive for the entire evolution run. Reads genome requests from stdin
 * (one JSON line per request), runs games using the real TypeScript engine,
 * writes fitness results to stdout (one JSON line per response).
 *
 * Protocol:
 *   stdin:  {"weights_npz": "<base64>", "games": N, "width": W, "height": H, "maxTurns": T}
 *   stdout: {"results": [0.042, 0.038, ...]}
 *   stdout: {"error": "message"}  (on failure)
 *
 * Inference is delegated to a persistent Python MPS sidecar (moe_mps_server.py).
 */

import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createGameState, applyAction, getPlayerView, BasicAgent, NnMoEAgent, UNIT_STATS, distToNearestFriendlyCity } from '@sc/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Strike-value of a combat event from p1's perspective.
 *   enemy killed (defender or attacker): + (buildTime + cargo)
 *   own killed   (defender or attacker): - (buildTime + cargo)
 *
 * Location multiplier (Run 7+ zone-based formulation):
 *   zone_factor = dist_to_enemy_city / (dist_to_my_city + dist_to_enemy_city)
 *   loc_factor  = 1 + γ · zone_factor
 *     → zone_factor = 1 when the strike happens at MY city (max defensive value)
 *     → zone_factor = 0 when at THEIR city (low value: they can replace easily)
 *     → zone_factor = 0.5 in the middle (neutral)
 *   γ=4 gives loc_factor range [1, 5].
 */
function strikeFromCombat(state, combat, attackerUnit, defenderUnit, p1, p2, gamma) {
  if (!combat) return 0;
  let signed = 0;

  const cargoVal = u => (u?.cargo ?? []).reduce((s, cid) => {
    const c = state.units.find(x => x.id === cid);
    return c ? s + (UNIT_STATS[c.type]?.buildTime ?? 0) : s;
  }, 0);

  if (combat.defenderDestroyed && defenderUnit) {
    const v = (UNIT_STATS[defenderUnit.type]?.buildTime ?? 0) + cargoVal(defenderUnit);
    signed += (defenderUnit.owner === p1) ? -v : +v;
  }
  if (combat.attackerDestroyed && attackerUnit) {
    const v = (UNIT_STATS[attackerUnit.type]?.buildTime ?? 0) + cargoVal(attackerUnit);
    signed += (attackerUnit.owner === p1) ? -v : +v;
  }
  if (signed === 0) return 0;

  const loc = defenderUnit ?? attackerUnit;
  const dMyRaw    = distToNearestFriendlyCity(state, loc.x, loc.y, p1);
  const dEnemyRaw = distToNearestFriendlyCity(state, loc.x, loc.y, p2);
  // Cap infinities (player wiped out) to a finite far-distance fallback.
  const dMy    = isFinite(dMyRaw)    ? dMyRaw    : 100;
  const dEnemy = isFinite(dEnemyRaw) ? dEnemyRaw : 100;
  const zone = dEnemy / (dMy + dEnemy + 1e-6);
  const mult = 1 + gamma * zone;
  return signed * mult;
}

// ── MPSSidecar ────────────────────────────────────────────────────────────────

/**
 * Manages one persistent Python moe_mps_server.py child process.
 * Binary protocol: [1B msg_type][4B payload_len BE][payload]
 */
class MPSSidecar {
  constructor() {
    this.proc = null;
    this._chunks = [];
    this._totalBytes = 0;
    this._pending = null;  // { n, resolve, reject }
    this._mapHeight = 0;
    this._mapWidth = 0;
  }

  start() {
    const pythonBin = process.env.PYTHON_EXECUTABLE ?? 'python3';
    const script = join(__dirname, 'moe_mps_server.py');

    this.proc = spawn(pythonBin, [script], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });

    this.proc.stdout.on('data', (chunk) => {
      this._chunks.push(chunk);
      this._totalBytes += chunk.length;
      this._tryResolve();
    });

    this.proc.on('close', (code) => {
      if (this._pending) {
        const { reject } = this._pending;
        this._pending = null;
        reject(new Error(`MPS sidecar exited with code ${code}`));
      }
    });

    this.proc.on('error', (err) => {
      process.stderr.write(`[MPSSidecar] spawn error: ${err.message}\n`);
    });
  }

  _tryResolve() {
    if (!this._pending || this._totalBytes < this._pending.n) return;
    const { n, resolve } = this._pending;
    this._pending = null;

    const result = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this._chunks[0];
      const needed = n - offset;
      if (chunk.length <= needed) {
        chunk.copy(result, offset);
        offset += chunk.length;
        this._totalBytes -= chunk.length;
        this._chunks.shift();
      } else {
        chunk.copy(result, offset, 0, needed);
        this._chunks[0] = chunk.slice(needed);
        this._totalBytes -= needed;
        offset = n;
      }
    }
    resolve(result);
  }

  _readExact(n) {
    return new Promise((resolve, reject) => {
      this._pending = { n, resolve, reject };
      this._tryResolve();
    });
  }

  _sendNpz(msgType, npzBuf, mapHeight, mapWidth) {
    // Frame: [1B type][4B payload_len][2B H][2B W][npz_bytes]
    const hdr = Buffer.allocUnsafe(9);
    hdr[0] = msgType;
    hdr.writeUInt32BE(4 + npzBuf.length, 1);
    hdr.writeUInt16BE(mapHeight, 5);
    hdr.writeUInt16BE(mapWidth,  7);
    this.proc.stdin.write(hdr);
    this.proc.stdin.write(npzBuf);
  }

  /** Send base weights once — sidecar stores them for all subsequent delta evals. */
  async setBase(npzBuf, mapHeight, mapWidth) {
    this._mapHeight = mapHeight;
    this._mapWidth  = mapWidth;
    this._sendNpz(4, npzBuf, mapHeight, mapWidth);
    const ack = await this._readExact(1);
    if (ack[0] !== 4) throw new Error(`SET_BASE ACK bad: ${ack[0]}`);
  }

  /** Send perturbation delta; sidecar applies base+delta before inference. */
  async setWeights(npzBuf, mapHeight, mapWidth) {
    this._mapHeight = mapHeight;
    this._mapWidth  = mapWidth;
    this._sendNpz(1, npzBuf, mapHeight, mapWidth);
    const ack = await this._readExact(1);
    if (ack[0] !== 1) throw new Error(`SET_WEIGHTS ACK bad: ${ack[0]}`);
  }

  /** Run movement inference for one unit. tensor15 is Float32Array. */
  async inferMovement(unitTypeIdx, tensor15) {
    const tBytes = new Uint8Array(tensor15.buffer, tensor15.byteOffset, tensor15.byteLength);
    const payloadLen = 1 + tBytes.length;

    const hdr = Buffer.allocUnsafe(5);
    hdr[0] = 2;
    hdr.writeUInt32BE(payloadLen, 1);
    this.proc.stdin.write(hdr);
    this.proc.stdin.write(Buffer.from([unitTypeIdx]));
    this.proc.stdin.write(tBytes);

    const NUM_ACTIONS = 2;  // must match NUM_MOVEMENT_ACTIONS in models_moe.py
    const responseSize = (NUM_ACTIONS + this._mapHeight * this._mapWidth) * 4;
    const buf = await this._readExact(responseSize);
    // buf is a Node.js Buffer — slice its ArrayBuffer for alignment safety
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + responseSize);
    const flt = new Float32Array(ab);
    return {
      actionType: flt.subarray(0, NUM_ACTIONS),
      targetTile: flt.subarray(NUM_ACTIONS),
    };
  }

  /** Run production inference. spatial and globalFeatures are Float32Arrays. */
  async inferProduction(spatial, globalFeatures) {
    const sBytes = new Uint8Array(spatial.buffer, spatial.byteOffset, spatial.byteLength);
    const gBytes = new Uint8Array(globalFeatures.buffer, globalFeatures.byteOffset, globalFeatures.byteLength);
    const payloadLen = sBytes.length + gBytes.length;

    const hdr = Buffer.allocUnsafe(5);
    hdr[0] = 3;
    hdr.writeUInt32BE(payloadLen, 1);
    this.proc.stdin.write(hdr);
    this.proc.stdin.write(sBytes);
    this.proc.stdin.write(gBytes);

    const buf = await this._readExact(8 * 4);
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + 32);
    return { unitType: new Float32Array(ab) };
  }

  close() {
    if (!this.proc) return;
    const hdr = Buffer.allocUnsafe(5);
    hdr[0] = 255;
    hdr.writeUInt32BE(0, 1);
    try { this.proc.stdin.write(hdr); this.proc.stdin.end(); } catch { /**/ }
  }
}

// ── Game runner ───────────────────────────────────────────────────────────────

async function runGame(nnAgent, basicAgent, mapWidth, mapHeight, maxTurns, alpha, beta, gamma, fitnessMode, strikeScale) {
  const state = createGameState({ width: mapWidth, height: mapHeight });
  const totalCities = state.cities.length;
  const p1 = 'player1';
  const p2 = 'player2';
  let winner = null;
  let cityScore = 0;
  let strikeValue = 0;  // signed sum of combat events from p1's perspective

  // Capture pre-action attacker/defender so we can read their type+cargo+location even if killed.
  const captureCombat = (action, currentPid) => {
    if (!action || !action.unitId) return { attackerUnit: null, defenderUnit: null };
    const attacker = state.units.find(u => u.id === action.unitId);
    // For MOVE/ATTACK actions, defender is at the target tile (any enemy unit there)
    let defender = null;
    if (action.targetX !== undefined && action.targetY !== undefined) {
      defender = state.units.find(u => u.x === action.targetX && u.y === action.targetY && u.owner !== currentPid);
    }
    return {
      attackerUnit: attacker ? { ...attacker, cargo: [...(attacker.cargo || [])] } : null,
      defenderUnit: defender ? { ...defender, cargo: [...(defender.cargo || [])] } : null,
    };
  };

  while (winner === null && state.turn < maxTurns) {
    const pid = state.currentPlayer;

    if (pid === p1) {
      let consecutiveFailures = 0;
      let done = false;
      while (!done && state.winner === null && state.currentPlayer === pid) {
        const view = getPlayerView(state, pid);
        const action = await nnAgent.act({ ...view, myPlayerId: pid });
        if (action.type === 'END_TURN') {
          applyAction(state, action, pid);
          done = true;
        } else {
          const snap = captureCombat(action, pid);
          const res = applyAction(state, action, pid);
          if (res.combat) {
            strikeValue += strikeFromCombat(state, res.combat, snap.attackerUnit, snap.defenderUnit, p1, p2, gamma);
          }
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
      cityScore += state.cities.filter(c => c.owner === p1).length;
    } else {
      const view = getPlayerView(state, pid);
      const action = basicAgent.act({ ...view, myPlayerId: pid });
      // capture for p2's actions too — strike value counts attacks against p1
      const snap = captureCombat(action, pid);
      const res = applyAction(state, action, pid);
      if (res.combat) {
        strikeValue += strikeFromCombat(state, res.combat, snap.attackerUnit, snap.defenderUnit, p1, p2, gamma);
      }
      if (!res.success && action.type !== 'END_TURN') {
        applyAction(state, { type: 'END_TURN' }, pid);
      }
    }

    winner = state.winner;
  }

  const cityFitness = totalCities > 0 ? cityScore / (maxTurns * totalCities) : 0;
  // Three fitness modes:
  //   additive       : α·cityScore + β·strikeValue                     (Run 5 — strikes can compensate for city loss)
  //   multiplicative : cityScore · (1 + β·strikeValue)                 (Run 6 — multiplier unbounded above, gameable)
  //   bounded        : cityScore + β·tanh(strikeValue / strikeScale)   (Run 7+ — strike contribution bounded to ±β)
  if (fitnessMode === 'multiplicative') {
    return cityFitness * (1 + beta * strikeValue);
  }
  if (fitnessMode === 'bounded') {
    const s = strikeScale > 0 ? strikeScale : 100;
    return cityFitness + beta * Math.tanh(strikeValue / s);
  }
  return alpha * cityFitness + beta * strikeValue;
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(req, sidecar) {
  // Base-weights setup (sent once before evolution loop)
  if (req.base_npz !== undefined) {
    const state0 = createGameState({ width: req.width, height: req.height });
    const npzBuf = Buffer.from(req.base_npz, 'base64');
    await sidecar.setBase(npzBuf, state0.mapHeight, req.width);
    return { ok: true };
  }

  const { weights_npz, games, width, height, maxTurns, alpha = 1.0, beta = 0.0, gamma = 0.0, fitnessMode = 'additive', strikeScale = 100 } = req;

  const state0 = createGameState({ width, height });
  const actualMapHeight = state0.mapHeight;

  const npzBuf = Buffer.from(weights_npz, 'base64');
  await sidecar.setWeights(npzBuf, actualMapHeight, width);

  const nnAgent = new NnMoEAgent();
  const basicAgent = new BasicAgent();

  nnAgent.initFromMPS(sidecar, {
    playerId: 'player1',
    mapWidth: width,
    mapHeight: actualMapHeight,
  });
  basicAgent.init({ playerId: 'player2', mapWidth: width, mapHeight: actualMapHeight });

  const results = [];
  for (let g = 0; g < games; g++) {
    const fitness = await runGame(nnAgent, basicAgent, width, height, maxTurns, alpha, beta, gamma, fitnessMode, strikeScale);
    results.push(fitness);
  }
  return { results };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const sidecar = new MPSSidecar();
sidecar.start();

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
    const result = await handleRequest(req, sidecar);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    process.stderr.write(`[eval_server] error: ${e.message}\n${e.stack}\n`);
    process.stdout.write(JSON.stringify({ error: e.message }) + '\n');
  }
});

rl.on('close', () => {
  process.stderr.write('[eval_server] stdin closed, exiting\n');
  sidecar.close();
  process.exit(0);
});
