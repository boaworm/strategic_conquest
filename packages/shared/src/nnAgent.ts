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
import { UnitType } from './types.js';

import { resolve } from 'node:path';
import * as ortNamespace from 'onnxruntime-node';
const ort = ortNamespace.default;

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
  'DISBAND',
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
    const modelPath = resolve((typeof process !== 'undefined' && process.env?.NN_MODEL_PATH) || './model.onnx');

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
    // Note: observation is AgentObservation, but playerViewToTensor expects PlayerView
    // For now, cast to PlayerView - this works because AgentObservation has the same fields
    // that playerViewToTensor uses (tiles, myUnits, myCities, etc.)
    const view = observation as any as PlayerView;
    const tensor = playerViewToTensor(view);

    // Create ONNX tensor (1, 14, H, W) - matches export_onnx.py dummy_input shape
    const inputTensor = new ort.Tensor('float32', tensor, [1, 14, this.mapHeight, this.mapWidth]);
    const feeds = { input: inputTensor };

    // Run inference
    const results = await this.session.run(feeds);

    // Decode predictions
    const actionTypeIdx = this.argmax(results.action_type.data as Float32Array);
    const targetTileIdx = this.argmax(results.target_tile.data as Float32Array);
    const prodTypeIdx = this.argmax(results.prod_type.data as Float32Array);

    const actionType = ACTION_TYPES[actionTypeIdx];

    // Build action based on type
    if (actionType === 'MOVE') {
      const x = targetTileIdx % this.mapWidth;
      const y = Math.floor(targetTileIdx / this.mapWidth);
      return {
        type: 'MOVE',
        unitId: this.selectMoveableUnit(observation),
        to: { x, y },
      };
    }

    if (actionType === 'SET_PRODUCTION') {
      const unitType = UNIT_TYPES[prodTypeIdx];
      return {
        type: 'SET_PRODUCTION',
        cityId: this.selectCity(observation),
        unitType,
      };
    }

    // Default: END_TURN
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

  private selectMoveableUnit(obs: AgentObservation): string {
    // Find first unit with moves left
    const unit = obs.myUnits.find((u) => u.movesLeft > 0 && !u.sleeping && !u.carriedBy);
    return unit?.id ?? obs.myUnits[0]?.id ?? 'unknown';
  }

  private selectCity(obs: AgentObservation): string {
    return obs.myCities[0]?.id ?? 'unknown';
  }
}
