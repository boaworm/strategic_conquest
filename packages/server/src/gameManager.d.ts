import { type GameState, type GameAction, type PlayerId, type PlayerView, type PlayerType, applyAction, type AIDifficulty } from '@sc/shared';
import { type GameTokens } from './tokenAuth.js';
export interface GameSession {
    id: string;
    tokens: GameTokens;
    state: GameState;
    /** Set of socket ids per player */
    sockets: Map<PlayerId, Set<string>>;
    /** Player types: 'human' or 'ai' */
    playerTypes: Map<PlayerId, PlayerType>;
    /** Disconnect timer per player */
    disconnectTimers: Map<PlayerId, ReturnType<typeof setTimeout>>;
    /** Track which players have joined at least once */
    joinedPlayers: Set<PlayerId>;
    /** AI difficulty if PvE mode */
    difficulty?: AIDifficulty;
    /** Is this a PvE game? */
    isPvE: boolean;
    /** Is this an AI vs AI game? */
    isAiVsAi: boolean;
    createdAt: number;
}
export declare class GameManager {
    private games;
    /** token → { gameId, role } */
    private tokenIndex;
    createGame(mapWidth?: number, mapHeight?: number, isPvE?: boolean, difficulty?: AIDifficulty, p1Type?: 'human' | 'ai', p2Type?: 'human' | 'ai'): GameSession;
    /**
     * Look up a token. Returns the game session and the role, or null.
     */
    authenticate(token: string): {
        session: GameSession;
        role: 'admin' | PlayerId;
    } | null;
    /**
     * Register a socket for a player in a game.
     * Returns true if both players are now connected and the game should start.
     */
    addSocket(session: GameSession, playerId: PlayerId, socketId: string): boolean;
    /**
     * Remove a socket. Returns 'paused' if the player has no remaining connections,
     * 'ok' otherwise. Starts a disconnect timer if paused.
     */
    removeSocket(session: GameSession, playerId: PlayerId, socketId: string, onForfeit: () => void): 'ok' | 'paused';
    processAction(session: GameSession, playerId: PlayerId, action: GameAction): ReturnType<typeof applyAction>;
    getPlayerView(session: GameSession, playerId: PlayerId): PlayerView;
    getGame(id: string): GameSession | undefined;
    listGames(): {
        id: string;
        phase: string;
        turn: number;
        playersConnected: number;
        mode: string;
    }[];
    deleteGame(id: string): boolean;
}
//# sourceMappingURL=gameManager.d.ts.map