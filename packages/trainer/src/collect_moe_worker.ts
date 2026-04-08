/**
 * MoE data collection worker.
 *
 * Runs BasicAgent vs BasicAgent games and saves (state, action) pairs split
 * by unit type, so each movement expert and the production expert can be
 * trained independently.
 *
 * Output (in TMP_DIR/):
 *   worker-{id}-{type}.states.bin    — float32, 14 × H × W per sample
 *   worker-{id}-{type}.positions.bin — int16, [x, y] per sample
 *   worker-{id}-{type}.actions.jsonl — {actionType, tileIdx} per sample
 *   worker-{id}-production.states.bin
 *   worker-{id}-production.cities.bin  — int16, [cityX, cityY] per sample
 *   worker-{id}-production.globals.bin — float32, 22 values per sample
 *   worker-{id}-production.unitTypes.jsonl — {unitType} per sample
 *   worker-{id}-result.json
 */

import fs from 'fs';
import path from 'path';
import {
  createGameState,
  applyAction,
  getPlayerView,
  BasicAgent,
  playerViewToTensor,
  UnitType,
} from '@sc/shared';
import type { AgentAction, AgentObservation } from '@sc/shared';
import type { PlayerView } from '@sc/shared';

const workerId    = parseInt(process.env.WORKER_ID!);
const gameStart   = parseInt(process.env.GAME_START!);
const gameEnd     = parseInt(process.env.GAME_END!);
const mapWidth    = parseInt(process.env.MAP_WIDTH!);
const mapHeight   = parseInt(process.env.MAP_HEIGHT!);
const maxTurns    = parseInt(process.env.MAX_TURNS!);
const tmpDir      = process.env.TMP_DIR!;

// Cap per bucket per game — keeps total output comparable to base collector
const MAX_SAMPLES_PER_GAME = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');
const MAX_PER_BUCKET       = Math.max(50, Math.floor(MAX_SAMPLES_PER_GAME / 9));

const MOVEMENT_ACTION_TYPES = ['MOVE', 'SLEEP', 'SKIP', 'LOAD', 'UNLOAD'] as const;
const UNIT_TYPE_NAMES = ['army', 'fighter', 'bomber', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship'] as const;
type UnitTypeName = typeof UNIT_TYPE_NAMES[number];

const NUM_GLOBAL = 22;

const progressFile = path.join(tmpDir, `progress-${workerId}.txt`);

// ── File handles ─────────────────────────────────────────────────────────────

function openFiles(name: string) {
  const base = path.join(tmpDir, `worker-${workerId}-${name}`);
  return {
    statesFd:   fs.openSync(`${base}.states.bin`, 'w'),
    positionsFd: fs.openSync(`${base}.positions.bin`, 'w'),
    actionsWs:  fs.createWriteStream(`${base}.actions.jsonl`, { encoding: 'utf-8' }),
  };
}

const movementFiles = Object.fromEntries(
  UNIT_TYPE_NAMES.map(name => [name, openFiles(name)])
) as Record<UnitTypeName, ReturnType<typeof openFiles>>;

const prodBase = path.join(tmpDir, `worker-${workerId}-production`);
const prodFiles = {
  statesFd:   fs.openSync(`${prodBase}.states.bin`, 'w'),
  citiesFd:   fs.openSync(`${prodBase}.cities.bin`, 'w'),
  globalsFd:  fs.openSync(`${prodBase}.globals.bin`, 'w'),
  unitTypesWs: fs.createWriteStream(`${prodBase}.unitTypes.jsonl`, { encoding: 'utf-8' }),
};

// ── Sample counters ───────────────────────────────────────────────────────────

const totalSamples: Record<string, number> = Object.fromEntries(
  [...UNIT_TYPE_NAMES, 'production'].map(n => [n, 0])
);
const wins = { player1: 0, player2: 0, draw: 0 };

// ── Global features for production expert ────────────────────────────────────

function buildGlobalFeatures(view: PlayerView, city: { x: number; y: number; productionTurnsLeft: number; coastal: boolean }, turn: number): Float32Array {
  const f = new Float32Array(NUM_GLOBAL);

  // 0-7: my unit counts by type / 20
  for (let i = 0; i < UNIT_TYPE_NAMES.length; i++) {
    f[i] = view.myUnits.filter(u => u.type === UNIT_TYPE_NAMES[i]).length / 20;
  }
  // 8-15: visible enemy unit counts / 20
  for (let i = 0; i < UNIT_TYPE_NAMES.length; i++) {
    f[8 + i] = view.visibleEnemyUnits.filter(u => u.type === UNIT_TYPE_NAMES[i]).length / 20;
  }
  // 16: my city fraction
  const totalCities = view.myCities.length + view.visibleEnemyCities.length;
  f[16] = totalCities > 0 ? view.myCities.length / totalCities : 0;
  // 17: total visible cities / 30
  f[17] = totalCities / 30;
  // 18: turn fraction
  f[18] = turn / maxTurns;
  // 19: city production turns left / 10
  f[19] = city.productionTurnsLeft / 10;
  // 20: coastal flag
  f[20] = city.coastal ? 1.0 : 0.0;
  // 21: bias
  f[21] = 1.0;
  return f;
}

// ── Save helpers ──────────────────────────────────────────────────────────────

function saveMovementSample(
  unitType: UnitTypeName,
  tensor: Float32Array,
  x: number, y: number,
  actionType: string,
  tileIdx: number,
): void {
  const files = movementFiles[unitType];

  // states
  fs.writeSync(files.statesFd, Buffer.from(tensor.buffer));

  // positions: int16 [x, y]
  const pos = new Int16Array([x, y]);
  fs.writeSync(files.positionsFd, Buffer.from(pos.buffer));

  // action
  files.actionsWs.write(JSON.stringify({ actionType, tileIdx }) + '\n');

  totalSamples[unitType]++;
}

function saveProductionSample(
  tensor: Float32Array,
  cityX: number, cityY: number,
  globals: Float32Array,
  unitTypeName: string,
): void {
  fs.writeSync(prodFiles.statesFd, Buffer.from(tensor.buffer));

  const cityPos = new Int16Array([cityX, cityY]);
  fs.writeSync(prodFiles.citiesFd, Buffer.from(cityPos.buffer));

  fs.writeSync(prodFiles.globalsFd, Buffer.from(globals.buffer));

  prodFiles.unitTypesWs.write(JSON.stringify({ unitType: unitTypeName }) + '\n');

  totalSamples['production']++;
}

// ── Main game loop ─────────────────────────────────────────────────────────────

process.stderr.write(`[MoE-W${workerId}] started, games ${gameStart}-${gameEnd}\n`);

for (let gameNumber = gameStart; gameNumber <= gameEnd; gameNumber++) {
  let state: ReturnType<typeof createGameState>;
  try {
    state = createGameState({ width: mapWidth, height: mapHeight });
  } catch {
    if (gameNumber === gameStart || gameNumber % 50 === 0 || gameNumber === gameEnd) {
      fs.writeFileSync(progressFile, String(gameNumber));
    }
    continue;
  }

  const agents = {
    player1: new BasicAgent(),
    player2: new BasicAgent(),
  };
  agents.player1.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  agents.player2.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  // Per-bucket sample counts for this game
  const gameCounts: Record<string, number> = Object.fromEntries(
    [...UNIT_TYPE_NAMES, 'production'].map(n => [n, 0])
  );

  let prevPlayer = state.currentPlayer;
  let actionsThisTurn = 0;
  const MAX_ACTIONS_PER_TURN = 500;

  while (state.winner === null && state.turn < maxTurns) {
    const pid = state.currentPlayer as 'player1' | 'player2';

    if (pid !== prevPlayer) {
      actionsThisTurn = 0;
      prevPlayer = pid;
    }

    const view = getPlayerView(state, pid) as PlayerView;
    const action: AgentAction = agents[pid].act({ ...view, myPlayerId: pid } as any);

    // ── Record sample ──────────────────────────────────────────────────────
    if (pid === 'player1') {
      const tensor = playerViewToTensor(view);

      if (action.type === 'MOVE' || action.type === 'SLEEP' || action.type === 'SKIP' ||
          action.type === 'LOAD' || action.type === 'UNLOAD') {

        const unit = view.myUnits.find(u => u.id === (action as any).unitId);
        if (unit && gameCounts[unit.type] < MAX_PER_BUCKET) {
          const tileIdx = (action.type === 'MOVE' || action.type === 'UNLOAD')
            ? ((action as any).to.y * state.mapWidth + (action as any).to.x)
            : -1;
          saveMovementSample(unit.type as UnitTypeName, tensor, unit.x, unit.y, action.type, tileIdx);
          gameCounts[unit.type]++;
        }

      } else if (action.type === 'SET_PRODUCTION') {
        const cityId = (action as any).cityId;
        const city = view.myCities.find(c => c.id === cityId);
        if (city && gameCounts['production'] < MAX_PER_BUCKET) {
          const globals = buildGlobalFeatures(view, city, state.turn);
          saveProductionSample(tensor, city.x, city.y, globals, (action as any).unitType);
          gameCounts['production']++;
        }
      }
    }
    // ──────────────────────────────────────────────────────────────────────

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
  }

  if (state.winner === 'player1')      wins.player1++;
  else if (state.winner === 'player2') wins.player2++;
  else                                  wins.draw++;

  process.stderr.write(`[MoE-W${workerId}] game ${gameNumber}: turns=${state.turn} winner=${state.winner ?? 'draw'}\n`);

  if (gameNumber === gameStart || gameNumber % 50 === 0 || gameNumber === gameEnd) {
    fs.writeFileSync(progressFile, String(gameNumber));
  }
}

// ── Close files ───────────────────────────────────────────────────────────────

for (const name of UNIT_TYPE_NAMES) {
  const f = movementFiles[name];
  fs.closeSync(f.statesFd);
  fs.closeSync(f.positionsFd);
  await new Promise<void>(r => f.actionsWs.end(r));
}
fs.closeSync(prodFiles.statesFd);
fs.closeSync(prodFiles.citiesFd);
fs.closeSync(prodFiles.globalsFd);
await new Promise<void>(r => prodFiles.unitTypesWs.end(r));

fs.writeFileSync(
  path.join(tmpDir, `result-${workerId}.json`),
  JSON.stringify({ samples: totalSamples, wins })
);

process.stderr.write(`[MoE-W${workerId}] done — ${JSON.stringify(totalSamples)}\n`);
