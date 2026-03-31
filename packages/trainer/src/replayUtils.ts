import type { GameState, City, Unit, Terrain, Agent } from '@sc/shared';
import { BasicAgent } from '@sc/shared';

export interface ReplayMeta {
  id: string;
  gameNum?: number;
  recordedAt: string;
  turns: number;
  winner: string | null;
  p1Cities: number;
  p2Cities: number;
  neutralCities: number;
  mapWidth: number;
  mapHeight: number;
  frames: number;
  p1Agent?: string;
  p2Agent?: string;
}

export interface ReplayFrame {
  turn: number;
  currentPlayer: string;
  cities: City[];
  units: Unit[];
  winner: string | null;
  phases?: Record<string, number>;
}

export interface ReplayFile {
  meta: ReplayMeta;
  /** tiles[y][x] — static throughout the game */
  tiles: Terrain[][];
  frames: ReplayFrame[];
}

export function snapshotGame(state: GameState, agents?: Record<string, Agent>): ReplayFrame {
  const frame: ReplayFrame = {
    turn: state.turn,
    currentPlayer: state.currentPlayer,
    cities: JSON.parse(JSON.stringify(state.cities)),
    units: JSON.parse(JSON.stringify(state.units)),
    winner: state.winner,
  };

  if (agents) {
    const phases: Record<string, number> = {};
    for (const pid of ['player1', 'player2'] as const) {
      const agent = agents[pid];
      if (agent instanceof BasicAgent) {
        phases[pid] = agent.getPhase();
      }
    }
    if (Object.keys(phases).length > 0) frame.phases = phases;
  }

  return frame;
}
