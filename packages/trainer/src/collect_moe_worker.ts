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
const unitTypesStr = process.env.UNIT_TYPES ?? '';
const targetSizeBytes = parseInt(process.env.TARGET_SIZE_BYTES ?? '0');
const MAX_SAMPLES_PER_GAME = parseInt(process.env.MAX_SAMPLES_PER_GAME ?? '3000');
const MAX_PER_BUCKET       = Math.max(50, Math.floor(MAX_SAMPLES_PER_GAME / 9));
const PROD_SAMPLE_MULTIPLIER = parseInt(process.env.PROD_SAMPLE_MULTIPLIER ?? '3');
const MAX_PER_PROD_BUCKET    = prodOnly ? Infinity : MAX_PER_BUCKET * PROD_SAMPLE_MULTIPLIER;

const MOVEMENT_ACTION_TO_IDX: Record<string, number> = { MOVE: 0, SKIP: 1 };
const UNIT_TYPE_NAMES = ['army', 'fighter', 'missile', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship'] as const;
const UNIT_TYPE_TO_IDX: Record<string, number> = { army: 0, fighter: 1, missile: 2, transport: 3, destroyer: 4, submarine: 5, carrier: 6, battleship: 7 };

// Initialize unit types tracking (after constants are declared)
const unitTypes: string[] = unitTypesStr ? unitTypesStr.split(',').filter(Boolean) : [];
const unitTypeTargetsReached: Record<string, boolean> = {};
if (unitTypes.length === 0 && !prodOnly) {
  // Default to all movement types if none specified
  unitTypes.push(...UNIT_TYPE_NAMES);
}
unitTypes.forEach(type => { unitTypeTargetsReached[type] = false; });

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
    // carried.bin: 1 byte per army sample — 1 if carried by transport, 0 if free
    // cargo.bin:   1 byte per transport sample — raw cargo count (0–6)
    carriedFd:   name === 'army'      ? fs.openSync(`${base}.carried.bin`, 'w') : -1,
    cargoFd:     name === 'transport' ? fs.openSync(`${base}.cargo.bin`,   'w') : -1,
  };
}

const movementFiles = prodOnly ? null : Object.fromEntries(
  unitTypes.map(name => [name, openFiles(name)])
) as Record<string, ReturnType<typeof openFiles>> | null;

const prodBase = path.join(process.env.DATA_DIR!, `worker-${workerId}-production`);
const prodFiles = {
  statesFd:    fs.openSync(`${prodBase}.states.bin`, 'w'),
  citiesFd:    fs.openSync(`${prodBase}.cities.bin`, 'w'),
  globalsFd:   fs.openSync(`${prodBase}.globals.bin`, 'w'),
  unitTypesFd: fs.openSync(`${prodBase}.unitTypes.bin`, 'w'),
};

// Buffers
type MovementBuf = { states: Buffer[]; positions: Buffer[]; actions: number[]; tiles: number[]; carried: number[]; cargo: number[] };
type ProductionBuf = { states: Buffer[]; cities: Buffer[]; globals: Buffer[]; unitTypes: number[] };

const movementBufs = prodOnly ? null : Object.fromEntries(
  unitTypes.map(n => [n, { states: [] as Buffer[], positions: [] as Buffer[], actions: [] as number[], tiles: [] as number[], carried: [] as number[], cargo: [] as number[] }])
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
  if (files.carriedFd >= 0) {
    fs.writeSync(files.carriedFd, Buffer.from(new Uint8Array(buf.carried)));
    fs.fsyncSync(files.carriedFd);
  }
  if (files.cargoFd >= 0) {
    fs.writeSync(files.cargoFd, Buffer.from(new Uint8Array(buf.cargo)));
    fs.fsyncSync(files.cargoFd);
  }
  buf.states = []; buf.positions = []; buf.actions = []; buf.tiles = []; buf.carried = []; buf.cargo = [];
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

function saveMovementSample(unitType: string, tensor: Float32Array, x: number, y: number, actionType: string, tileIdx: number, carriedByTransport = false, cargoCount = 0): void {
  if (prodOnly || !movementBufs || !movementFiles) return;
  const buf = movementBufs[unitType];
  buf.states.push(Buffer.from(tensor.buffer));
  buf.positions.push(Buffer.from(new Int16Array([x, y]).buffer));
  buf.actions.push(MOVEMENT_ACTION_TO_IDX[actionType] ?? 2);
  buf.tiles.push(tileIdx);
  buf.carried.push(carriedByTransport ? 1 : 0);
  buf.cargo.push(cargoCount);
  if (buf.states.length >= FLUSH_EVERY) flushMovement(unitType);
}

function saveProductionSample(tensor: Float32Array, cityX: number, cityY: number, globals: Float32Array, unitTypeName: string): void {
  prodBuf.states.push(Buffer.from(tensor.buffer));
  prodBuf.cities.push(Buffer.from(new Int16Array([cityX, cityY]).buffer));
  prodBuf.globals.push(Buffer.from(globals.buffer));
  prodBuf.unitTypes.push(UNIT_TYPE_TO_IDX[unitTypeName] ?? 0);
  if (prodBuf.states.length >= FLUSH_EVERY) flushProduction();
}

function checkFileSizeForUnitType(unitType: string): number {
  if (targetSizeBytes <= 0) return 0;
  const statesFile = path.join(process.env.DATA_DIR!, `worker-${workerId}-${unitType}.states.bin`);
  if (fs.existsSync(statesFile)) {
    return fs.statSync(statesFile).size;
  }
  return 0;
}

function checkAllFileSizes(): boolean {
  if (targetSizeBytes <= 0) return false;

  // Check if all specified unit types have reached target size
  let allDone = true;
  for (const unitType of unitTypes) {
    const size = checkFileSizeForUnitType(unitType);
    if (size >= targetSizeBytes) {
      if (!unitTypeTargetsReached[unitType]) {
        unitTypeTargetsReached[unitType] = true;
        console.log(`[MoE-W${workerId}] Unit type ${unitType} reached target size: ${size} bytes`);
      }
    } else {
      allDone = false;
    }
  }

  // Check production if not filtering
  if (!unitTypes.length && !prodOnly) {
    const prodStatesFile = path.join(process.env.DATA_DIR!, `worker-${workerId}-production.states.bin`);
    if (fs.existsSync(prodStatesFile)) {
      const prodSize = fs.statSync(prodStatesFile).size;
      if (prodSize < targetSizeBytes) allDone = false;
    } else {
      allDone = false;
    }
  }

  return allDone;
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

  // Initialize game counts for unit types we're tracking
  const gameCounts: Record<string, number> = {};
  for (const name of unitTypes) {
    gameCounts[name] = 0;
  }
  // Include production if we're collecting it
  if (!prodOnly && (unitTypes.length === 0 || unitTypes.includes("production"))) {
    gameCounts['production'] = 0;
  }

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
      if (!prodOnly && (action.type === 'MOVE' || action.type === 'SKIP')) {
        const unit = view.myUnits.find((u: any) => u.id === (action as any).unitId);
        if (unit && unitTypes.includes(unit.type) && !unitTypeTargetsReached[unit.type] && gameCounts[unit.type] < MAX_PER_BUCKET) {
          const tileIdx = action.type === 'MOVE' ? ((action as any).to.y * state.mapWidth + (action as any).to.x) : -1;
          const isCarried = unit.type === 'army' && unit.carriedBy != null;
          const cargoCount = unit.type === 'transport' ? (unit.cargo?.length ?? 0) : 0;
          saveMovementSample(unit.type, tensor, unit.x, unit.y, action.type, tileIdx, isCarried, cargoCount);
          gameCounts[unit.type]++;
        }
      } else if (action.type === 'SET_PRODUCTION' &&
                 !prodOnly &&
                 (unitTypes.length === 0 || unitTypes.includes("production")) &&
                 !unitTypeTargetsReached["production"] &&
                 gameCounts['production'] < MAX_PER_PROD_BUCKET) {
        const city = view.myCities.find((c: any) => c.id === (action as any).cityId);
        if (city) {
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

  const movesSampled = Object.entries(gameCounts)
    .filter(([k]) => k !== 'production')
    .reduce((sum, [, v]) => sum + v, 0);
  const prodSampled = gameCounts['production'] ?? 0;

  // Accumulate totals
  for (const [k, v] of Object.entries(gameCounts)) {
    totalSamples[k] = (totalSamples[k] ?? 0) + v;
  }

  // Flush after every game so disk reflects reality for size checks and survives interrupts
  if (!prodOnly) { for (const name of unitTypes) flushMovement(name); }
  if (!prodOnly && (unitTypes.length === 0 || unitTypes.includes("production"))) {
    flushProduction();
  }

  const allTargetsReached = checkAllFileSizes();
  const pctTag = targetSizeBytes > 0 ? ` ${Math.floor(Object.values(unitTypeTargetsReached).filter(v => v).length / unitTypes.length * 100)}%` : '';
  process.stderr.write(`[MoE-W${workerId}]${pctTag} game ${gameNumber}: Moves=${movesSampled}, Production=${prodSampled}\n`);

  if (allTargetsReached) {
    break;
  }

  gamesCompleted++;
  if (gamesCompleted % 50 === 0) fs.writeFileSync(progressFile, String(gamesCompleted));
}

// Flush and close
if (!prodOnly) { for (const name of unitTypes) flushMovement(name); }
if (!prodOnly && (unitTypes.length === 0 || unitTypes.includes("production"))) {
  flushProduction();
}

if (!prodOnly && movementFiles) {
  for (const name of unitTypes) {
    const f = movementFiles[name];
    fs.closeSync(f.statesFd); fs.closeSync(f.positionsFd); fs.closeSync(f.actionsFd); fs.closeSync(f.tilesFd);
    if (f.carriedFd >= 0) fs.closeSync(f.carriedFd);
    if (f.cargoFd   >= 0) fs.closeSync(f.cargoFd);
  }
}
if (!prodOnly && (unitTypes.length === 0 || unitTypes.includes("production"))) {
  fs.closeSync(prodFiles.statesFd); fs.closeSync(prodFiles.citiesFd); fs.closeSync(prodFiles.globalsFd); fs.closeSync(prodFiles.unitTypesFd);
}

fs.writeFileSync(path.join(process.env.DATA_DIR!, `result-${workerId}.json`), JSON.stringify({
  samples: totalSamples,
  wins: { player1: 0, player2: 0, draw: 0 },
  unitTypeTargetsReached: unitTypeTargetsReached
}));
process.stderr.write(`[MoE-W${workerId}] done — ${gamesCompleted} games\n`);
