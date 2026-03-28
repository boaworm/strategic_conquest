import type { GameState, City, Unit, Terrain } from '@sc/shared';

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
}

export interface ReplayFile {
  meta: ReplayMeta;
  /** tiles[y][x] — static throughout the game */
  tiles: Terrain[][];
  frames: ReplayFrame[];
}

export function snapshotGame(state: GameState): ReplayFrame {
  return {
    turn: state.turn,
    currentPlayer: state.currentPlayer,
    cities: JSON.parse(JSON.stringify(state.cities)),
    units: JSON.parse(JSON.stringify(state.units)),
    winner: state.winner,
  };
}
