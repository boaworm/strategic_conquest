/**
 * MoE data collection worker.
 *
 * Runs games and saves (state, action) pairs.
 * Stops when file size reaches TARGET_SIZE_BYTES.
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
import type { AgentAction } from '@sc/shared';

const workerId    = parseInt(process.env.WORKER_ID!);
const mapWidth    = parseInt(process.env.MAP_WIDTH!);
const mapHeight   = parseInt(process.env.MAP_HEIGHT!);
const maxTurns    = parseInt(process.env.MAX_TURNS!);
const prodOnly    = process.env.PROD_ONLY === '1';
const unitTypeFilter = process.env.UNIT_TYPE_FILTER;
const targetSizeBytes = parseInt(process.env.TARGET_SIZE_BYTES ?? '0');
const MAX_SAMPLES_PER_GAME = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');
const MAX_PER_BUCKET       = Math.max(50, Math.floor(MAX_SAMPLES_PER_GAME / 9));
const PROD_SAMPLE_MULTIPLIER = parseInt(process.env.PROD_SAMPLE_MULTIPLIER ?? '3');
const MAX_PER_PROD_BUCKET    = prodOnly ? Infinity : MAX_PER_BUCKET * PROD_SAMPLE_MULTIPLIER;

const MOVEMENT_ACTION_TO_IDX: Record<string, number> = { MOVE: 0, SLEEP: 1, SKIP: 2, LOAD: 3, UNLOAD: 4 };
const UNIT_TYPE_NAMES = ['army', 'fighter', 'missile', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship'] as const;
const UNIT_TYPE_TO_IDX: Record<string, number> = { army: 0, fighter: 1, missile: 2, transport: 3, destroyer: 4, submarine: 5, carrier: 6, battleship: 7 };

const NUM_GLOBAL = 28;
const FLUSH_EVERY = 256;

const progressFile = path.join(process.env.DATA_DIR!, `progress-${workerId}.txt`);

function getNextGameNumber(): number {
  process.stdout.write('NEXT\n');
  const buf = Buffer.alloc(32);
  const n = fs.readSync(0, buf, 0, 32, null);
  return parseInt(buf.toString('utf8', 0, n).trim());
}

// File handles
function openFiles(name: string) {
  const base = path.join(process.env.DATA_DIR!, `worker-${workerId}-${name}`);
  return {
    statesFd:    fs.openSync(`${base}.states.bin`, 'w'),
    positionsFd: fs.openSync(`${base}.positions.bin`, 'w'),
    actionsFd:   fs.openSync(`${base}.actions.bin`, 'w'),
    tilesFd:     fs.openSync(`${base}.tiles.bin`, 'w'),
  };
}

const movementFiles = prodOnly ? null : Object.fromEntries(
  UNIT_TYPE_NAMES.map(name => [name, openFiles(name)])
) as Record<string, ReturnType<typeof openFiles>> | null;

const prodBase = path.join(process.env.DATA_DIR!, `worker-${workerId}-production`);
const prodFiles = {
  statesFd:    fs.openSync(`${prodBase}.states.bin`, 'w'),
  citiesFd:    fs.openSync(`${prodBase}.cities.bin`, 'w'),
  globalsFd:   fs.openSync(`${prodBase}.globals.bin`, 'w'),
  unitTypesFd: fs.openSync(`${prodBase}.unitTypes.bin`, 'w'),
};

// Buffers
type MovementBuf = { states: Buffer[]; positions: Buffer[]; actions: number[]; tiles: number[] };
type ProductionBuf = { states: Buffer[]; cities: Buffer[]; globals: Buffer[]; unitTypes: number[] };

const movementBufs = prodOnly ? null : Object.fromEntries(
  UNIT_TYPE_NAMES.map(n => [n, { states: [] as Buffer[], positions: [] as Buffer[], actions: [] as number[], tiles: [] as number[] }])
) as Record<string, MovementBuf> | null;

const prodBuf: ProductionBuf = { states: [], cities: [], globals: [], unitTypes: [] };

function flushMovement(unitType: string): void {
  if (prodOnly || !movementBufs || !movementFiles) return;
  const buf = movementBufs[unitType];
  const files = movementFiles[unitType];
  if (buf.states.length === 0) return;
  fs.writeSync(files.statesFd, Buffer.concat(buf.states));
  fs.fsyncSync(files.statesFd);
  fs.writeSync(files.positionsFd, Buffer.concat(buf.positions));
  fs.fsyncSync(files.positionsFd);
  fs.writeSync(files.actionsFd, Buffer.from(new Uint8Array(buf.actions)));
  fs.fsyncSync(files.actionsFd);
  const tiles = new Int32Array(buf.tiles);
  fs.writeSync(files.tilesFd, Buffer.from(tiles.buffer, tiles.byteOffset, tiles.byteLength));
  fs.fsyncSync(files.tilesFd);
  buf.states = []; buf.positions = []; buf.actions = []; buf.tiles = [];
}

function flushProduction(): void {
  if (prodBuf.states.length === 0) return;
  fs.writeSync(prodFiles.statesFd, Buffer.concat(prodBuf.states));
  fs.fsyncSync(prodFiles.statesFd);
  fs.writeSync(prodFiles.citiesFd, Buffer.concat(prodBuf.cities));
  fs.fsyncSync(prodFiles.citiesFd);
  fs.writeSync(prodFiles.globalsFd, Buffer.concat(prodBuf.globals));
  fs.fsyncSync(prodFiles.globalsFd);
  fs.writeSync(prodFiles.unitTypesFd, Buffer.from(new Uint8Array(prodBuf.unitTypes)));
  fs.fsyncSync(prodFiles.unitTypesFd);
  prodBuf.states = []; prodBuf.cities = []; prodBuf.globals = []; prodBuf.unitTypes = [];
}

function buildGlobalFeatures(view: any, city: { x: number; y: number; productionTurnsLeft: number; coastal: boolean }, turn: number): Float32Array {
  const f = new Float32Array(NUM_GLOBAL);
  for (let i = 0; i < UNIT_TYPE_NAMES.length; i++) {
    f[i] = view.myUnits.filter((u: any) => u.type === UNIT_TYPE_NAMES[i]).length / 20;
    f[8 + i] = view.visibleEnemyUnits.filter((u: any) => u.type === UNIT_TYPE_NAMES[i]).length / 20;
  }
  const totalCities = view.myCities.length + view.visibleEnemyCities.length;
  f[16] = totalCities > 0 ? view.myCities.length / totalCities : 0;
  f[17] = totalCities / 30;
  f[18] = turn / maxTurns;
  f[19] = city.productionTurnsLeft / 10;
  f[20] = city.coastal ? 1.0 : 0.0;
  f[21] = (view.visibleEnemyUnits.length > 0 || view.visibleEnemyCities.length > 0) ? 1.0 : 0.0;
  f[22] = view.myCities.filter((c: any) => c.producing === 'army').length / 10;
  f[23] = view.myUnits.filter((u: any) => u.type === 'fighter').length / 20;
  f[24] = view.myUnits.filter((u: any) => u.type === 'missile').length / 20;
  f[25] = view.myUnits.filter((u: any) => u.type === 'army').length / 20;
  const fc = view.myUnits.filter((u: any) => u.type === 'fighter').length;
  const mc = view.myUnits.filter((u: any) => u.type === 'missile').length;
  const ac = view.myUnits.filter((u: any) => u.type === 'army').length;
  f[26] = Math.min(fc, mc, ac) / 20;
  f[27] = 1.0;
  return f;
}

function saveMovementSample(unitType: string, tensor: Float32Array, x: number, y: number, actionType: string, tileIdx: number): void {
  if (prodOnly || !movementBufs || !movementFiles) return;
  const buf = movementBufs[unitType];
  buf.states.push(Buffer.from(tensor.buffer));
  buf.positions.push(Buffer.from(new Int16Array([x, y]).buffer));
  buf.actions.push(MOVEMENT_ACTION_TO_IDX[actionType] ?? 2);
  buf.tiles.push(tileIdx);
  if (buf.states.length >= FLUSH_EVERY) flushMovement(unitType);
}

function saveProductionSample(tensor: Float32Array, cityX: number, cityY: number, globals: Float32Array, unitTypeName: string): void {
  prodBuf.states.push(Buffer.from(tensor.buffer));
  prodBuf.cities.push(Buffer.from(new Int16Array([cityX, cityY]).buffer));
  prodBuf.globals.push(Buffer.from(globals.buffer));
  prodBuf.unitTypes.push(UNIT_TYPE_TO_IDX[unitTypeName] ?? 0);
  if (prodBuf.states.length >= FLUSH_EVERY) flushProduction();
}

function checkFileSize(): number {
  if (targetSizeBytes <= 0) return 0;
  const unitTypes = unitTypeFilter ? [unitTypeFilter] : UNIT_TYPE_NAMES;
  let maxSize = 0;
  for (const name of unitTypes) {
    const statesFile = path.join(process.env.DATA_DIR!, `worker-${workerId}-${name}.states.bin`);
    if (fs.existsSync(statesFile)) {
      const size = fs.statSync(statesFile).size;
      if (size > maxSize) maxSize = size;
    }
  }
  return maxSize;
}


let totalSamples: Record<string, number> = {};
let gamesCompleted = 0;

while (true) {
  let state: ReturnType<typeof createGameState>;
  try {
    state = createGameState({ width: mapWidth, height: mapHeight });
  } catch {
    continue;
  }
  const gameNumber = getNextGameNumber();

  const agents = { player1: new BasicAgent(), player2: new BasicAgent() };
  agents.player1.init({ playerId: 'player1', mapWidth: state.mapWidth, mapHeight: state.mapHeight });
  agents.player2.init({ playerId: 'player2', mapWidth: state.mapWidth, mapHeight: state.mapHeight });

  const gameCounts: Record<string, number> = {};
  for (const name of [...UNIT_TYPE_NAMES, 'production']) gameCounts[name] = 0;

  let prevPlayer = state.currentPlayer;
  let actionsThisTurn = 0;
  const MAX_ACTIONS_PER_TURN = 500;

  while (state.winner === null && state.turn < maxTurns) {
    const pid = state.currentPlayer as 'player1' | 'player2';
    if (pid !== prevPlayer) { actionsThisTurn = 0; prevPlayer = pid; }

    const view = getPlayerView(state, pid) as any;
    const action: AgentAction = agents[pid].act({ ...view, myPlayerId: pid });

    if (pid === 'player1') {
      const tensor = playerViewToTensor(view);
      if (!prodOnly && (action.type === 'MOVE' || action.type === 'SLEEP' || action.type === 'SKIP' || action.type === 'LOAD' || action.type === 'UNLOAD')) {
        const unit = view.myUnits.find((u: any) => u.id === (action as any).unitId);
        if (unit && (!unitTypeFilter || unit.type === unitTypeFilter) && gameCounts[unit.type] < MAX_PER_BUCKET) {
          const tileIdx = (action.type === 'MOVE' || action.type === 'UNLOAD') ? ((action as any).to.y * state.mapWidth + (action as any).to.x) : -1;
          saveMovementSample(unit.type, tensor, unit.x, unit.y, action.type, tileIdx);
          gameCounts[unit.type]++;
        }
      } else if (action.type === 'SET_PRODUCTION' && !unitTypeFilter) {
        const city = view.myCities.find((c: any) => c.id === (action as any).cityId);
        if (city && gameCounts['production'] < MAX_PER_PROD_BUCKET) {
          const globals = buildGlobalFeatures(view, city, state.turn);
          saveProductionSample(tensor, city.x, city.y, globals, (action as any).unitType);
          gameCounts['production']++;
        }
      }
    }

    const res = applyAction(state, action, pid);
    if (!res.success) { applyAction(state, { type: 'END_TURN' }, pid); actionsThisTurn = 0; }
    else if (action.type === 'END_TURN') { actionsThisTurn = 0; }
    else {
      actionsThisTurn++;
      if (actionsThisTurn >= MAX_ACTIONS_PER_TURN) { applyAction(state, { type: 'END_TURN' }, pid); actionsThisTurn = 0; }
    }
  }

  const movesSampled = Object.entries(gameCounts).filter(([k]) => k !== 'production').reduce((sum, [, v]) => sum + v, 0);
  const prodSampled = unitTypeFilter ? 0 : gameCounts['production'];

  // Accumulate totals
  for (const [k, v] of Object.entries(gameCounts)) {
    totalSamples[k] = (totalSamples[k] ?? 0) + v;
  }

  // Flush after every game so disk reflects reality for size checks and survives interrupts
  if (!prodOnly) { for (const name of UNIT_TYPE_NAMES) flushMovement(name); }
  if (!unitTypeFilter) flushProduction();

  const currentSize = checkFileSize();
  const pctTag = targetSizeBytes > 0 ? ` ${Math.floor(currentSize / targetSizeBytes * 100)}%` : '';
  process.stderr.write(`[MoE-W${workerId}]${pctTag} game ${gameNumber}: Moves=${movesSampled}, Production=${prodSampled}\n`);

  if (currentSize >= targetSizeBytes) {
    break;
  }

  gamesCompleted++;
  if (gamesCompleted % 50 === 0) fs.writeFileSync(progressFile, String(gamesCompleted));
}

// Flush and close
if (!prodOnly) { for (const name of UNIT_TYPE_NAMES) flushMovement(name); }
if (!unitTypeFilter) flushProduction();

if (!prodOnly) {
  for (const name of UNIT_TYPE_NAMES) {
    const f = movementFiles![name];
    fs.closeSync(f.statesFd); fs.closeSync(f.positionsFd); fs.closeSync(f.actionsFd); fs.closeSync(f.tilesFd);
  }
}
if (!unitTypeFilter) {
  fs.closeSync(prodFiles.statesFd); fs.closeSync(prodFiles.citiesFd); fs.closeSync(prodFiles.globalsFd); fs.closeSync(prodFiles.unitTypesFd);
}

fs.writeFileSync(path.join(process.env.DATA_DIR!, `result-${workerId}.json`), JSON.stringify({ samples: totalSamples, wins: { player1: 0, player2: 0, draw: 0 } }));
process.stderr.write(`[MoE-W${workerId}] done — ${gamesCompleted} games\n`);
