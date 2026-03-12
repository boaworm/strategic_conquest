// ── Coordinates ──────────────────────────────────────────────

export interface Coord {
  x: number;
  y: number;
}

/**
 * Wrap an X coordinate for cylindrical map topology.
 * East-west wraps, north-south does not.
 */
export function wrapX(x: number, mapWidth: number): number {
  return ((x % mapWidth) + mapWidth) % mapWidth;
}

/**
 * Compute the shortest east-west distance on a cylindrical map.
 */
export function wrappedDistX(x1: number, x2: number, mapWidth: number): number {
  const raw = Math.abs(x1 - x2);
  return Math.min(raw, mapWidth - raw);
}

// ── Players ──────────────────────────────────────────────────

export type PlayerId = 'player1' | 'player2';

// ── Terrain ──────────────────────────────────────────────────

export enum Terrain {
  Ocean = 'ocean',
  Land = 'land',
}

// ── Unit types ───────────────────────────────────────────────

export enum UnitType {
  Infantry = 'infantry',
  Tank = 'tank',
  Fighter = 'fighter',
  Bomber = 'bomber',
  Transport = 'transport',
  Destroyer = 'destroyer',
  Submarine = 'submarine',
  Carrier = 'carrier',
  Battleship = 'battleship',
}

export enum UnitDomain {
  Land = 'land',
  Sea = 'sea',
  Air = 'air',
}

export interface UnitStats {
  type: UnitType;
  domain: UnitDomain;
  movesPerTurn: number;
  vision: number;
  maxHealth: number;
  buildTime: number;
  attack: number;
  defense: number;
  /** Max fuel (air only). undefined = unlimited */
  maxFuel?: number;
  /** Cargo capacity (transports / carriers). 0 = cannot carry */
  cargoCapacity: number;
  /** What unit types can this unit carry? */
  canCarry: UnitType[];
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  [UnitType.Infantry]: {
    type: UnitType.Infantry,
    domain: UnitDomain.Land,
    movesPerTurn: 1,
    vision: 1,
    maxHealth: 1,
    buildTime: 3,
    attack: 1,
    defense: 2,
    cargoCapacity: 0,
    canCarry: [],
  },
  [UnitType.Tank]: {
    type: UnitType.Tank,
    domain: UnitDomain.Land,
    movesPerTurn: 2,
    vision: 1,
    maxHealth: 1,
    buildTime: 5,
    attack: 3,
    defense: 2,
    cargoCapacity: 0,
    canCarry: [],
  },
  [UnitType.Fighter]: {
    type: UnitType.Fighter,
    domain: UnitDomain.Air,
    movesPerTurn: 10,
    vision: 3,
    maxHealth: 1,
    buildTime: 12,
    attack: 3,
    defense: 4,
    cargoCapacity: 0,
    canCarry: [],
  },
  [UnitType.Bomber]: {
    type: UnitType.Bomber,
    domain: UnitDomain.Air,
    movesPerTurn: 15,
    vision: 3,
    maxHealth: 1,
    buildTime: 15,
    attack: 4,
    defense: 1,
    maxFuel: 30,
    cargoCapacity: 0,
    canCarry: [],
  },
  [UnitType.Transport]: {
    type: UnitType.Transport,
    domain: UnitDomain.Sea,
    movesPerTurn: 5,
    vision: 2,
    maxHealth: 1,
    buildTime: 8,
    attack: 0,
    defense: 1,
    cargoCapacity: 6,
    canCarry: [UnitType.Infantry, UnitType.Tank],
  },
  [UnitType.Destroyer]: {
    type: UnitType.Destroyer,
    domain: UnitDomain.Sea,
    movesPerTurn: 6,
    vision: 2,
    maxHealth: 1,
    buildTime: 12,
    attack: 2,
    defense: 2,
    cargoCapacity: 0,
    canCarry: [],
  },
  [UnitType.Submarine]: {
    type: UnitType.Submarine,
    domain: UnitDomain.Sea,
    movesPerTurn: 5,
    vision: 2,
    maxHealth: 1,
    buildTime: 12,
    attack: 2,
    defense: 2,
    cargoCapacity: 0,
    canCarry: [],
  },
  [UnitType.Carrier]: {
    type: UnitType.Carrier,
    domain: UnitDomain.Sea,
    movesPerTurn: 5,
    vision: 2,
    maxHealth: 2,
    buildTime: 18,
    attack: 1,
    defense: 3,
    cargoCapacity: 4,
    canCarry: [UnitType.Fighter],
  },
  [UnitType.Battleship]: {
    type: UnitType.Battleship,
    domain: UnitDomain.Sea,
    movesPerTurn: 4,
    vision: 2,
    maxHealth: 2,
    buildTime: 24,
    attack: 4,
    defense: 4,
    cargoCapacity: 0,
    canCarry: [],
  },
};

// ── Tile ─────────────────────────────────────────────────────

export interface Tile {
  terrain: Terrain;
  x: number;
  y: number;
}

// ── City ─────────────────────────────────────────────────────

export interface City {
  id: string;
  x: number;
  y: number;
  owner: PlayerId | null; // null = neutral
  producing: UnitType | null;
  productionTurnsLeft: number;
  productionProgress: number; // turns already invested
}

// ── Unit (runtime instance) ──────────────────────────────────

export interface Unit {
  id: string;
  type: UnitType;
  owner: PlayerId;
  x: number;
  y: number;
  health: number;
  movesLeft: number;
  fuel?: number; // air units only
  sleeping: boolean;
  /** Has this unit attacked this turn? */
  hasAttacked: boolean;
  /** IDs of units being carried */
  cargo: string[];
  /** ID of transport/carrier carrying this unit, or null */
  carriedBy: string | null;
}

// ── Game State ───────────────────────────────────────────────

export enum GamePhase {
  Lobby = 'lobby',
  Active = 'active',
  Finished = 'finished',
}

export interface GameState {
  mapWidth: number;
  mapHeight: number;
  tiles: Terrain[][];       // tiles[y][x]
  cities: City[];
  units: Unit[];
  currentPlayer: PlayerId;
  turn: number;
  phase: GamePhase;
  winner: PlayerId | null;
  /** Tiles each player has explored (persists across turns) */
  explored: Record<PlayerId, Set<string>>;
  /** Total bombers produced per player (for blast radius upgrades) */
  bombersProduced: Record<PlayerId, number>;
  /** Enemy unit snapshots seen this turn (persists until end of turn) */
  seenEnemies: Record<PlayerId, { id: string; type: UnitType; owner: PlayerId; x: number; y: number }[]>;
}

// ── Fog of War views (sent to clients) ──────────────────────

export enum TileVisibility {
  Hidden = 'hidden',
  Seen = 'seen',       // previously seen, not currently visible
  Visible = 'visible', // currently visible
}

export interface TileView {
  terrain: Terrain;
  visibility: TileVisibility;
  x: number;
  y: number;
}

export interface UnitView {
  id: string;
  type: UnitType;
  owner: PlayerId;
  x: number;
  y: number;
  health: number;
  movesLeft: number;
  fuel?: number;
  sleeping: boolean;
  hasAttacked: boolean;
  cargo: string[];
  carriedBy: string | null;
}

export interface CityView {
  id: string;
  x: number;
  y: number;
  owner: PlayerId | null;
  /** Only visible if it's your city */
  producing: UnitType | null;
  productionTurnsLeft: number;
  /** True if the city is adjacent to ocean (can build ships) */
  coastal: boolean;
}

export interface PlayerView {
  tiles: TileView[][];
  myUnits: UnitView[];
  myCities: CityView[];
  visibleEnemyUnits: UnitView[];
  visibleEnemyCities: CityView[];
  turn: number;
  currentPlayer: PlayerId;
  phase: GamePhase;
  winner: PlayerId | null;
}

// ── Actions ──────────────────────────────────────────────────

export type GameAction =
  | { type: 'MOVE'; unitId: string; to: Coord }
  | { type: 'SET_PRODUCTION'; cityId: string; unitType: UnitType | null }
  | { type: 'LOAD'; unitId: string; transportId: string }
  | { type: 'UNLOAD'; unitId: string; to: Coord }
  | { type: 'SLEEP'; unitId: string }
  | { type: 'WAKE'; unitId: string }
  | { type: 'SKIP'; unitId: string }
  | { type: 'DISBAND'; unitId: string }
  | { type: 'END_TURN' };

export interface ActionResult {
  success: boolean;
  error?: string;
  /** Combat that occurred as a result of the action */
  combat?: CombatResult;
  /** City captured as a result of the action */
  cityCaptured?: string;
  /** Bomber blast radius (0 = single tile, 1 = adjacent, 2 = two rings) */
  bomberBlastRadius?: number;
  /** Center of bomber explosion */
  bomberBlastCenter?: Coord;
  /** Number of fighters that crashed (ran out of fuel / not on city or carrier) */
  fightersCrashed?: number;
}

export interface CombatResult {
  attackerId: string;
  defenderId: string;
  attackerDamage: number;
  defenderDamage: number;
  attackerDestroyed: boolean;
  defenderDestroyed: boolean;
}

// ── Socket events ────────────────────────────────────────────

export interface ServerToClientEvents {
  gameStart: (view: PlayerView) => void;
  stateUpdate: (view: PlayerView) => void;
  actionResult: (result: ActionResult) => void;
  actionRejected: (data: { reason: string }) => void;
  playerJoined: (data: { playerId: PlayerId }) => void;
  playerDisconnected: (data: { playerId: PlayerId }) => void;
  gamePaused: (data: { reason: string }) => void;
  gameResumed: () => void;
  gameOver: (data: { winner: PlayerId }) => void;
  error: (data: { message: string }) => void;
}

export interface ClientToServerEvents {
  action: (action: GameAction) => void;
}

// ── Game creation (REST) ─────────────────────────────────────

export interface CreateGameRequest {
  mapWidth?: number;  // default 60
  mapHeight?: number; // default 40
}

export interface CreateGameResponse {
  gameId: string;
  adminToken: string;
  p1Token: string;
  p2Token: string;
}

export interface GameInfo {
  gameId: string;
  phase: GamePhase;
  turn: number;
  playersConnected: number;
}
