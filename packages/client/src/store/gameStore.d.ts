import { Socket } from 'socket.io-client';
import type { PlayerView, GameAction, ActionResult, PlayerId, CreateGameResponse, ServerToClientEvents, ClientToServerEvents } from '@sc/shared';
interface GameStore {
    connected: boolean;
    token: string | null;
    gameId: string | null;
    playerId: PlayerId | null;
    view: PlayerView | null;
    lastActionResult: ActionResult | null;
    error: string | null;
    gamePaused: boolean;
    socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
    createGame: (mapWidth?: number, mapHeight?: number, mode?: 'pvp' | 'pve', difficulty?: string) => Promise<CreateGameResponse>;
    joinGame: (token: string) => void;
    sendAction: (action: GameAction) => void;
    disconnect: () => void;
    selectedUnitId: string | null;
    selectUnit: (id: string | null) => void;
    autoEndTurn: boolean;
    setAutoEndTurn: (v: boolean) => void;
    autoSelectNext: boolean;
    setAutoSelectNext: (v: boolean) => void;
    tileSize: number;
    cameraX: number;
    cameraY: number;
    viewportInitialized: boolean;
    setTileSize: (size: number) => void;
    setCamera: (x: number, y: number) => void;
}
export declare const DEFAULT_TILE_SIZE = 32;
export declare const useGameStore: import("zustand").UseBoundStore<import("zustand").StoreApi<GameStore>>;
export {};
//# sourceMappingURL=gameStore.d.ts.map