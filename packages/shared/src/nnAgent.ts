/**
 * Neural Network Agent - uses ONNX Runtime for inference.
 *
 * Usage:
 *   1. Train model: python train.py --data-dir ... --epochs 50
 *   2. Export to ONNX: python export_onnx.py --checkpoint best_model.pt --output model.onnx
 *   3. Run games: DATA_DIR=... P1AGENT=nn P2AGENT=basicAgent npm run record
 */

import type { Agent, AgentObservation, AgentAction } from './agent.js';
import { playerViewToTensor } from './engine/tensorUtils.js';
import type { PlayerView } from './types.js';
import { UnitType, wrapX, wrappedDistX } from './types.js';

// Lazy-load node modules to avoid browser build errors
let _ort: any = null;
let _resolve: (path: string) => string | null = null;

function getOrt() {
  if (!_ort) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ortNamespace = require('onnxruntime-node');
    _ort = ortNamespace.default;
  }
  return _ort;
}

function getResolve() {
  if (!_resolve) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolve } = require('node:path');
    _resolve = resolve;
  }
  return _resolve;
}

function getExecutionProviders(): string[] {
  if (typeof process !== 'undefined' && process.platform === 'darwin') {
    return ['coreml', 'cpu'];
  }
  if (typeof process !== 'undefined' && process.platform === 'linux') {
    return ['cuda', 'cpu'];
  }
  return ['cpu'];
}

const ACTION_TYPES = [
  'END_TURN',
  'SET_PRODUCTION',
  'MOVE',
  'LOAD',
  'UNLOAD',
  'SLEEP',
  'WAKE',
  'SKIP',
] as const;

const UNIT_TYPES = [
  UnitType.Army,
  UnitType.Fighter,
  UnitType.Bomber,
  UnitType.Transport,
  UnitType.Destroyer,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Battleship,
] as const;

export class NnAgent implements Agent {
  private session: any = null;
  private playerId: string = '';
  private mapWidth: number = 0;
  private mapHeight: number = 0;

  async init(config: { playerId: string; mapWidth: number; mapHeight: number }): Promise<void> {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;

    // Load ONNX runtime and model
    const resolve = getResolve();
    const modelPath = resolve((typeof process !== 'undefined' && process.env?.NN_MODEL_PATH) || './model.onnx');

    const ort = getOrt();
    const sessionOptions: any = {
      executionProviders: getExecutionProviders(),
      logSeverityLevel: 3, // errors only — suppress CoreML partition warnings
    };

    this.session = await ort.InferenceSession.create(modelPath, sessionOptions);
  }

  async act(observation: AgentObservation): Promise<AgentAction> {
    if (!this.session) {
      throw new Error('NnAgent not initialized. Call init() first.');
    }

    // Convert observation to tensor
    const view = observation as any as PlayerView;
    const tensor = playerViewToTensor(view);

    // Create ONNX tensor (1, 14, H, W)
    const ort = getOrt();
    const inputTensor = new ort.Tensor('float32', tensor, [1, 14, this.mapHeight, this.mapWidth]);
    const feeds = { input: inputTensor };

    // Run inference
    const results = await this.session.run(feeds);

    // Decode predictions
    const actionTypeIdx = this.argmax(results.action_type.data as Float32Array);
    const targetTileIdx = this.argmax(results.target_tile.data as Float32Array);
    const prodTypeIdx = this.argmax(results.prod_type.data as Float32Array);

    const actionType = ACTION_TYPES[actionTypeIdx];
    const targetX = targetTileIdx % this.mapWidth;
    const targetY = Math.floor(targetTileIdx / this.mapWidth);

    if (actionType === 'MOVE') {
      // Pick the moveable unit closest to the target tile
      const unit = this.selectUnitClosestTo(observation, targetX, targetY);
      if (!unit) return { type: 'END_TURN' };
      // Move one step toward target (or to target if adjacent)
      const to = this.stepToward(unit.x, unit.y, targetX, targetY);
      return { type: 'MOVE', unitId: unit.id, to };
    }

    if (actionType === 'SET_PRODUCTION') {
      const unitType = UNIT_TYPES[prodTypeIdx];
      // Pick a city not already producing this type
      const city = observation.myCities.find(c => c.producing !== unitType) ?? observation.myCities[0];
      if (!city) return { type: 'END_TURN' };
      return { type: 'SET_PRODUCTION', cityId: city.id, unitType };
    }

    if (actionType === 'SLEEP') {
      const unit = this.selectUnitClosestTo(observation, targetX, targetY);
      if (!unit) return { type: 'END_TURN' };
      return { type: 'SLEEP', unitId: unit.id };
    }

    if (actionType === 'WAKE') {
      const sleepingUnit = observation.myUnits.find(u => u.sleeping && !u.carriedBy);
      if (!sleepingUnit) return { type: 'END_TURN' };
      return { type: 'WAKE', unitId: sleepingUnit.id };
    }

    if (actionType === 'SKIP') {
      const unit = this.selectUnitClosestTo(observation, targetX, targetY);
      if (!unit) return { type: 'END_TURN' };
      return { type: 'SKIP', unitId: unit.id };
    }

    if (actionType === 'LOAD') {
      // Find an army and a nearby transport
      const army = observation.myUnits.find(u => u.type === UnitType.Army && u.movesLeft > 0 && !u.carriedBy);
      const transport = observation.myUnits.find(u => u.type === UnitType.Transport);
      if (!army || !transport) return { type: 'END_TURN' };
      return { type: 'LOAD', unitId: army.id, transportId: transport.id };
    }

    if (actionType === 'UNLOAD') {
      // Find a transport with cargo
      const transport = observation.myUnits.find(u => u.type === UnitType.Transport && u.cargo && u.cargo.length > 0);
      if (!transport || !transport.cargo?.length) return { type: 'END_TURN' };
      const to = this.stepToward(transport.x, transport.y, targetX, targetY);
      return { type: 'UNLOAD', unitId: transport.cargo[0], to };
    }

    return { type: 'END_TURN' };
  }

  private argmax(arr: Float32Array): number {
    let maxIdx = 0;
    let maxValue = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] > maxValue) {
        maxValue = arr[i];
        maxIdx = i;
      }
    }
    return maxIdx;
  }

  /**
   * Find the moveable unit closest to (tx, ty), accounting for cylindrical X wrapping.
   */
  private selectUnitClosestTo(obs: AgentObservation, tx: number, ty: number): AgentObservation['myUnits'][0] | undefined {
    const candidates = obs.myUnits.filter(u => u.movesLeft > 0 && !u.sleeping && !u.carriedBy);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, u) => {
      const dx = wrappedDistX(u.x, tx, this.mapWidth);
      const dy = Math.abs(u.y - ty);
      const distU = dx + dy;
      const dxB = wrappedDistX(best.x, tx, this.mapWidth);
      const dyB = Math.abs(best.y - ty);
      const distB = dxB + dyB;
      return distU < distB ? u : best;
    });
  }

  /**
   * Compute one adjacent step from (fx, fy) toward (tx, ty), respecting cylindrical X wrap.
   */
  private stepToward(fx: number, fy: number, tx: number, ty: number): { x: number; y: number } {
    let dx = tx - fx;
    // Adjust for wrap: pick shortest path on X axis
    if (dx > this.mapWidth / 2) dx -= this.mapWidth;
    else if (dx < -this.mapWidth / 2) dx += this.mapWidth;
    const dy = ty - fy;

    let stepX = 0;
    let stepY = 0;
    if (Math.abs(dx) >= Math.abs(dy)) {
      stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    } else {
      stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    }

    return {
      x: wrapX(fx + stepX, this.mapWidth),
      y: fy + stepY,
    };
  }
}
