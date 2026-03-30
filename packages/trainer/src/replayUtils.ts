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
  p1Phase2Turn?: number;
  p1Phase3Turn?: number;
  p2Phase2Turn?: number;
  p2Phase3Turn?: number;
}

export interface ReplayFrame {
  turn: number;
  currentPlayer: string;
  cities: City[];
  units: Unit[];
  winner: string | null;
  p1Phase?: number;
  p2Phase?: number;
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
    for (const pid of ['player1', 'player2'] as const) {
      const agent = agents[pid];
      if (agent instanceof BasicAgent) {
        frame[pid === 'player1' ? 'p1Phase' : 'p2Phase'] = agent.getPhase();
      }
    }
  }

  return frame;
}
