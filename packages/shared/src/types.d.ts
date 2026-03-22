export interface Coord {
    x: number;
    y: number;
}
/**
 * Wrap an X coordinate for cylindrical map topology.
 * East-west wraps, north-south does not.
 */
export declare function wrapX(x: number, mapWidth: number): number;
/**
 * Compute the shortest east-west distance on a cylindrical map.
 */
export declare function wrappedDistX(x1: number, x2: number, mapWidth: number): number;
export type PlayerId = 'player1' | 'player2';
/**
 * Player type indicator - helps distinguish human vs AI players
 */
export type PlayerType = 'human' | 'ai';
export declare enum Terrain {
    Ocean = "ocean",
    Land = "land"
}
export declare enum UnitType {
    Infantry = "infantry",
    Tank = "tank",
    Fighter = "fighter",
    Bomber = "bomber",
    Transport = "transport",
    Destroyer = "destroyer",
    Submarine = "submarine",
    Carrier = "carrier",
    Battleship = "battleship"
}
export declare enum UnitDomain {
    Land = "land",
    Sea = "sea",
    Air = "air"
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
export declare const UNIT_STATS: Record<UnitType, UnitStats>;
export interface Tile {
    terrain: Terrain;
    x: number;
    y: number;
}
export interface City {
    id: string;
    x: number;
    y: number;
    owner: PlayerId | null;
    producing: UnitType | null;
    productionTurnsLeft: number;
    productionProgress: number;
}
export interface Unit {
    id: string;
    type: UnitType;
    owner: PlayerId;
    x: number;
    y: number;
    health: number;
    movesLeft: number;
    fuel?: number;
    sleeping: boolean;
    /** Has this unit attacked this turn? */
    hasAttacked: boolean;
    /** IDs of units being carried */
    cargo: string[];
    /** ID of transport/carrier carrying this unit, or null */
    carriedBy: string | null;
}
export declare enum GamePhase {
    Lobby = "lobby",
    Active = "active",
    Finished = "finished"
}
export interface GameState {
    mapWidth: number;
    mapHeight: number;
    tiles: Terrain[][];
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
    seenEnemies: Record<PlayerId, {
        id: string;
        type: UnitType;
        owner: PlayerId;
        x: number;
        y: number;
    }[]>;
}
export declare enum TileVisibility {
    Hidden = "hidden",
    Seen = "seen",// previously seen, not currently visible
    Visible = "visible"
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
export type GameAction = {
    type: 'MOVE';
    unitId: string;
    to: Coord;
} | {
    type: 'SET_PRODUCTION';
    cityId: string;
    unitType: UnitType | null;
} | {
    type: 'LOAD';
    unitId: string;
    transportId: string;
} | {
    type: 'UNLOAD';
    unitId: string;
    to: Coord;
} | {
    type: 'SLEEP';
    unitId: string;
} | {
    type: 'WAKE';
    unitId: string;
} | {
    type: 'SKIP';
    unitId: string;
} | {
    type: 'DISBAND';
    unitId: string;
} | {
    type: 'END_TURN';
};
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
export interface ServerToClientEvents {
    gameStart: (view: PlayerView) => void;
    stateUpdate: (view: PlayerView) => void;
    actionResult: (result: ActionResult) => void;
    actionRejected: (data: {
        reason: string;
    }) => void;
    playerJoined: (data: {
        playerId: PlayerId;
    }) => void;
    playerDisconnected: (data: {
        playerId: PlayerId;
    }) => void;
    gamePaused: (data: {
        reason: string;
    }) => void;
    gameResumed: () => void;
    gameOver: (data: {
        winner: PlayerId;
    }) => void;
    error: (data: {
        message: string;
    }) => void;
}
export interface ClientToServerEvents {
    action: (action: GameAction) => void;
}
export type AIDifficulty = 'easy' | 'medium' | 'hard';
/**
 * AI Player selection - either a built-in AI by difficulty or a trained agent
 */
export type AIPlayer = AIDifficulty | 'basic' | 'evolved' | string;
export interface CreateGameRequest {
    mapWidth?: number;
    mapHeight?: number;
    mode?: 'pvp' | 'pve' | 'ai_vs_ai';
    p1Type?: 'human' | 'ai';
    p2Type?: 'human' | 'ai';
    difficulty?: AIDifficulty;
    p1AI?: AIPlayer;
    p2AI?: AIPlayer;
}
export interface CreateGameResponse {
    gameId: string;
    adminToken: string;
    p1Token: string;
    p2Token: string;
    mode: 'pvp' | 'pve' | 'ai_vs_ai';
    p1Type: 'human' | 'ai';
    p2Type: 'human' | 'ai';
    difficulty?: AIDifficulty;
    p1AI?: AIPlayer;
    p2AI?: AIPlayer;
}
export interface GameInfo {
    gameId: string;
    phase: GamePhase;
    turn: number;
    playersConnected: number;
}
//# sourceMappingURL=types.d.ts.map