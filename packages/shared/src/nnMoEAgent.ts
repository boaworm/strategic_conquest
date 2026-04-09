/**
 * Mixture-of-Experts Neural Network Agent.
 *
 * Loads 9 specialist ONNX models from a directory:
 *   army.onnx, fighter.onnx, bomber.onnx, transport.onnx,
 *   destroyer.onnx, submarine.onnx, carrier.onnx, battleship.onnx,
 *   production.onnx
 *
 * Game-runner logic (mirrors BasicAgent's two-pass unit ordering):
 *   Pass 1: free armies → sea units → air units
 *   Pass 2: carried armies (disembark after transports moved)
 *   Production: cities where producing === null
 *
 * Usage:
 *   P1_AGENT=nnMoEAgent:<dir>  (dir contains the 9 .onnx files)
 *   process.env.NN_MOE_DIR = '<dir>'
 */

import type { Agent, AgentAction, AgentConfig, AgentObservation } from './agent.js';
import type { PlayerView, UnitView, CityView } from './types.js';
import { UnitType, UnitDomain, UNIT_STATS, wrapX } from './types.js';
import { playerViewToTensor } from './engine/tensorUtils.js';
import { resolve, join } from 'node:path';

import * as ortNamespace from 'onnxruntime-node';
const ort = ortNamespace.default;

// ── Constants ────────────────────────────────────────────────────────────────

const MOVEMENT_ACTION_TYPES = ['MOVE', 'SLEEP', 'SKIP', 'LOAD', 'UNLOAD'] as const;
type MovementActionType = typeof MOVEMENT_ACTION_TYPES[number];

const UNIT_TYPE_NAMES: Record<UnitType, string> = {
  [UnitType.Army]:       'army',
  [UnitType.Fighter]:    'fighter',
  [UnitType.Bomber]:     'bomber',
  [UnitType.Transport]:  'transport',
  [UnitType.Destroyer]:  'destroyer',
  [UnitType.Submarine]:  'submarine',
  [UnitType.Carrier]:    'carrier',
  [UnitType.Battleship]: 'battleship',
};

const PROD_UNIT_TYPES = [
  UnitType.Army, UnitType.Fighter, UnitType.Bomber, UnitType.Transport,
  UnitType.Destroyer, UnitType.Submarine, UnitType.Carrier, UnitType.Battleship,
] as const;

// NUM_GLOBAL_FEATURES for production expert — see NN_Agent_MoE.md
const NUM_GLOBAL = 22;

function getExecutionProviders(): string[] {
  if (typeof process !== 'undefined' && process.platform === 'darwin') return ['coreml', 'cpu'];
  if (typeof process !== 'undefined' && process.platform === 'linux') return ['cuda', 'cpu'];
  return ['cpu'];
}

// ── NnMoEAgent ───────────────────────────────────────────────────────────────

export class NnMoEAgent implements Agent {
  private playerId: string = '';
  private mapWidth: number = 0;
  private mapHeight: number = 0;

  /** Movement expert sessions, keyed by UnitType */
  private movementSessions: Map<UnitType, any> = new Map();
  /** Production expert session */
  private productionSession: any = null;

  // Per-turn state: tracks which units and cities have been handled this turn
  private pendingUnitIds: Set<string> = new Set();
  private pendingCityIds: Set<string> = new Set();
  private pass: 1 | 2 | 'prod' = 1;

  /**
   * Inject pre-created ONNX sessions directly (used by eval_server.js to avoid file I/O).
   * sessions: { army: InferenceSession, ..., production: InferenceSession }
   */
  initFromSessions(sessions: Record<string, any>, config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;

    this.movementSessions.clear();
    for (const ut of Object.values(UnitType)) {
      const name = ut as string; // UnitType values are the string names e.g. 'army'
      if (sessions[name]) {
        this.movementSessions.set(ut as UnitType, sessions[name]);
      }
    }
    this.productionSession = sessions['production'] ?? null;
  }

  async init(config: AgentConfig): Promise<void> {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;

    const dir = resolve(
      (typeof process !== 'undefined' && process.env?.NN_MOE_DIR) || './moe_models'
    );

    const opts: any = {
      executionProviders: getExecutionProviders(),
      logSeverityLevel: 3,
    };

    // Load all 9 models in parallel
    const unitTypes = Object.values(UnitType) as UnitType[];
    await Promise.all([
      ...unitTypes.map(async (ut) => {
        const name = UNIT_TYPE_NAMES[ut];
        const modelPath = join(dir, `${name}.onnx`);
        const session = await ort.InferenceSession.create(modelPath, opts);
        this.movementSessions.set(ut, session);
      }),
      (async () => {
        const modelPath = join(dir, 'production.onnx');
        this.productionSession = await ort.InferenceSession.create(modelPath, opts);
      })(),
    ]);
  }

  /**
   * act() is called repeatedly until END_TURN is returned.
   * Internally we maintain pass state across calls within a single turn.
   */
  async act(observation: AgentObservation): Promise<AgentAction> {
    // Detect new turn: reset state when obs.turn changes or pendingUnitIds is empty on first call
    const allMyUnitIds = new Set(observation.myUnits.map(u => u.id));
    const isNewTurn = this.pendingUnitIds.size === 0 ||
      ![...this.pendingUnitIds].some(id => allMyUnitIds.has(id));

    if (isNewTurn) {
      this.startTurn(observation);
    }

    // Pass 1: free armies → sea → air
    if (this.pass === 1) {
      const action = await this.runPass1(observation);
      if (action) return action;
      this.pass = 2;
    }

    // Pass 2: carried armies
    if (this.pass === 2) {
      const action = await this.runPass2(observation);
      if (action) return action;
      this.pass = 'prod';
    }

    // Production
    if (this.pass === 'prod') {
      const action = await this.runProduction(observation);
      if (action) return action;
    }

    // All done
    this.pendingUnitIds.clear();
    this.pendingCityIds.clear();
    this.pass = 1;
    return { type: 'END_TURN' };
  }

  // ── Turn initialisation ───────────────────────────────────────────────────

  private startTurn(obs: AgentObservation): void {
    this.pass = 1;
    this.pendingUnitIds = new Set(
      obs.myUnits.filter(u => u.movesLeft > 0 && !u.sleeping).map(u => u.id)
    );
    this.pendingCityIds = new Set(
      obs.myCities.filter(c => c.producing === null).map(c => c.id)
    );
  }

  // ── Pass 1: free armies first, then sea, then air ─────────────────────────

  private async runPass1(obs: AgentObservation): Promise<AgentAction | null> {
    const pass1Order = (u: UnitView) => {
      if (u.type === UnitType.Army && u.carriedBy === null) return 0;
      if (UNIT_STATS[u.type].domain === UnitDomain.Sea) return 1;
      if (UNIT_STATS[u.type].domain === UnitDomain.Air) return 2;
      return 3;
    };

    const units = obs.myUnits
      .filter(u => this.pendingUnitIds.has(u.id) && u.carriedBy === null)
      .sort((a, b) => pass1Order(a) - pass1Order(b));

    for (const unit of units) {
      const action = await this.askMovementExpert(unit, obs);
      if (action) {
        if (action.type === 'SLEEP' || action.type === 'SKIP') {
          this.pendingUnitIds.delete(unit.id);
        } else if (unit.movesLeft <= 1) {
          // After this move the unit will have 0 moves left
          this.pendingUnitIds.delete(unit.id);
        }
        return action;
      }
      this.pendingUnitIds.delete(unit.id);
    }
    return null;
  }

  // ── Pass 2: carried armies disembark ─────────────────────────────────────

  private async runPass2(obs: AgentObservation): Promise<AgentAction | null> {
    const units = obs.myUnits.filter(
      u => this.pendingUnitIds.has(u.id) && u.carriedBy !== null && u.type === UnitType.Army
    );

    for (const unit of units) {
      const action = await this.askMovementExpert(unit, obs);
      if (action) {
        if (action.type === 'SLEEP' || action.type === 'SKIP' || unit.movesLeft <= 1) {
          this.pendingUnitIds.delete(unit.id);
        }
        return action;
      }
      this.pendingUnitIds.delete(unit.id);
    }
    return null;
  }

  // ── Production ────────────────────────────────────────────────────────────

  private async runProduction(obs: AgentObservation): Promise<AgentAction | null> {
    for (const cityId of [...this.pendingCityIds]) {
      const city = obs.myCities.find(c => c.id === cityId);
      if (!city) { this.pendingCityIds.delete(cityId); continue; }

      this.pendingCityIds.delete(cityId);
      const unitType = await this.askProductionExpert(city, obs);
      return { type: 'SET_PRODUCTION', cityId: city.id, unitType };
    }
    return null;
  }

  // ── Expert inference ──────────────────────────────────────────────────────

  private async askMovementExpert(unit: UnitView, obs: AgentObservation): Promise<AgentAction | null> {
    const session = this.movementSessions.get(unit.type);
    if (!session) return null;

    const tensor15 = this.buildMovementTensor(obs, unit.x, unit.y);
    const tensorH = (tensor15.length / 15) / this.mapWidth;
    const input = new ort.Tensor('float32', tensor15, [1, 15, tensorH, this.mapWidth]);
    const results = await session.run({ input });

    const actionIdx = this.argmax(results.action_type.data as Float32Array);
    const tileIdx = this.argmax(results.target_tile.data as Float32Array);
    const actionType = MOVEMENT_ACTION_TYPES[actionIdx] ?? 'SKIP';

    const tx = tileIdx % this.mapWidth;
    const ty = Math.floor(tileIdx / this.mapWidth);

    if (actionType === 'MOVE') {
      const to = this.stepToward(unit.x, unit.y, tx, ty);
      return { type: 'MOVE', unitId: unit.id, to };
    }
    if (actionType === 'SLEEP') return { type: 'SLEEP', unitId: unit.id };
    if (actionType === 'SKIP')  return { type: 'SKIP',  unitId: unit.id };
    if (actionType === 'LOAD') {
      const transport = obs.myUnits.find(u => u.type === UnitType.Transport);
      if (!transport) return { type: 'SKIP', unitId: unit.id };
      return { type: 'LOAD', unitId: unit.id, transportId: transport.id };
    }
    if (actionType === 'UNLOAD') {
      const to = this.stepToward(unit.x, unit.y, tx, ty);
      return { type: 'UNLOAD', unitId: unit.id, to };
    }
    return { type: 'SKIP', unitId: unit.id };
  }

  private async askProductionExpert(city: CityView, obs: AgentObservation): Promise<UnitType> {
    if (!this.productionSession) return UnitType.Army;

    const tensor15 = this.buildMovementTensor(obs, city.x, city.y);
    const globalFeatures = this.buildGlobalFeatures(city, obs);

    const tensorH = (tensor15.length / 15) / this.mapWidth;
    const inputTensor = new ort.Tensor('float32', tensor15, [1, 15, tensorH, this.mapWidth]);
    const globalTensor = new ort.Tensor('float32', globalFeatures, [1, NUM_GLOBAL]);
    const results = await this.productionSession.run({ input: inputTensor, global_features: globalTensor });

    const unitTypeIdx = this.argmax(results.unit_type.data as Float32Array);
    return PROD_UNIT_TYPES[unitTypeIdx] ?? UnitType.Army;
  }

  // ── Tensor construction ───────────────────────────────────────────────────

  /**
   * Build a 15-channel tensor: channels 0–13 from playerViewToTensor,
   * channel 14 = position marker for the given (x, y).
   */
  private buildMovementTensor(obs: AgentObservation, markerX: number, markerY: number): Float32Array {
    const view = obs as any as PlayerView;
    const base14 = playerViewToTensor(view); // length = 14 * tensorH * mapWidth
    const HW = base14.length / 14;           // actual tensor H*W (playerViewToTensor crops ice caps)
    const tensorW = this.mapWidth;
    const out = new Float32Array(15 * HW);
    out.set(base14);
    // Channel 14: marker
    const markerIdx = 14 * HW + markerY * tensorW + markerX;
    if (markerIdx < out.length) out[markerIdx] = 1.0;
    return out;
  }


  private buildGlobalFeatures(city: CityView, obs: AgentObservation): Float32Array {
    const f = new Float32Array(NUM_GLOBAL);
    const allUnitTypes = PROD_UNIT_TYPES;

    // 0–7: my unit counts by type (normalised)
    for (let i = 0; i < 8; i++) {
      f[i] = obs.myUnits.filter(u => u.type === allUnitTypes[i]).length / 20;
    }
    // 8–15: visible enemy unit counts by type
    for (let i = 0; i < 8; i++) {
      f[8 + i] = obs.visibleEnemyUnits.filter(u => u.type === allUnitTypes[i]).length / 20;
    }
    // 16: my city fraction
    const totalCities = obs.myCities.length + obs.visibleEnemyCities.length; // rough estimate
    f[16] = totalCities > 0 ? obs.myCities.length / totalCities : 0;
    // 17: total cities (normalised)
    f[17] = totalCities / 30;
    // 18: turn fraction (obs.turn may not exist on all versions — guard)
    f[18] = ((obs as any).turn ?? 0) / 300;
    // 19: city production turns left (normalised by rough max cost ~10)
    f[19] = city.productionTurnsLeft / 10;
    // 20: coastal flag
    f[20] = city.coastal ? 1.0 : 0.0;
    // 21: bias
    f[21] = 1.0;
    return f;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private argmax(arr: Float32Array): number {
    let maxIdx = 0;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] > arr[maxIdx]) maxIdx = i;
    }
    return maxIdx;
  }

  private stepToward(fx: number, fy: number, tx: number, ty: number): { x: number; y: number } {
    let dx = tx - fx;
    if (dx > this.mapWidth / 2) dx -= this.mapWidth;
    else if (dx < -this.mapWidth / 2) dx += this.mapWidth;
    const dy = ty - fy;
    let stepX = 0, stepY = 0;
    if (Math.abs(dx) >= Math.abs(dy)) stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    else stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    return { x: wrapX(fx + stepX, this.mapWidth), y: fy + stepY };
  }
}
