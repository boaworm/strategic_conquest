import type { Coord, PlayerId, UnitType, TileView, UnitView, CityView } from './types.js';

// ── Agent Observation (fog-of-war filtered view for the AI) ──

export interface AgentObservation {
  tiles: TileView[][];
  myUnits: UnitView[];
  myCities: CityView[];
  visibleEnemyUnits: UnitView[];
  visibleEnemyCities: CityView[];
  turn: number;
  myPlayerId: PlayerId;
}

// ── Agent Actions ────────────────────────────────────────────

export type AgentAction =
  | { type: 'MOVE'; unitId: string; to: Coord }
  | { type: 'SET_PRODUCTION'; cityId: string; unitType: UnitType }
  | { type: 'LOAD'; unitId: string; transportId: string }
  | { type: 'UNLOAD'; unitId: string; to: Coord }
  | { type: 'SLEEP'; unitId: string }
  | { type: 'WAKE'; unitId: string }
  | { type: 'SKIP'; unitId: string }
  | { type: 'END_TURN' };

// ── Agent Configuration ──────────────────────────────────────

export interface AgentConfig {
  playerId: PlayerId;
  mapWidth: number;
  mapHeight: number;
}

// ── Agent Interface ──────────────────────────────────────────

export interface Agent {
  /** Called once at game start with static config. */
  init(config: AgentConfig): void;

  /**
   * Called by the runner each time this agent must act.
   * Must return exactly one action. The runner calls this repeatedly
   * until the agent emits END_TURN.
   */
  act(obs: AgentObservation): AgentAction;
}
