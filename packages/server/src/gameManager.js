import { GamePhase, createGameState, applyAction, getPlayerView, } from '@sc/shared';
import { generateTokens } from './tokenAuth.js';
const DISCONNECT_TIMEOUT_MS = 60_000;
export class GameManager {
    games = new Map();
    /** token → { gameId, role } */
    tokenIndex = new Map();
    createGame(mapWidth = 60, mapHeight = 40, isPvE = false, difficulty = 'medium', p1Type = 'human', p2Type = 'human') {
        const id = crypto.randomUUID();
        const tokens = generateTokens();
        const state = createGameState({ width: mapWidth, height: mapHeight });
        // Game starts in lobby phase until both players connect
        state.phase = GamePhase.Lobby;
        const isAiVsAi = p1Type === 'ai' && p2Type === 'ai';
        const session = {
            id,
            tokens,
            state,
            sockets: new Map([
                ['player1', new Set()],
                ['player2', new Set()],
            ]),
            playerTypes: new Map([
                ['player1', p1Type],
                ['player2', p2Type],
            ]),
            disconnectTimers: new Map(),
            joinedPlayers: new Set(),
            difficulty: isPvE ? difficulty : undefined,
            isPvE,
            isAiVsAi,
            createdAt: Date.now(),
        };
        this.games.set(id, session);
        this.tokenIndex.set(tokens.adminToken, { gameId: id, role: 'admin' });
        this.tokenIndex.set(tokens.p1Token, { gameId: id, role: 'player1' });
        this.tokenIndex.set(tokens.p2Token, { gameId: id, role: 'player2' });
        // For AI vs AI, start immediately (both players are AI and will connect)
        if (isAiVsAi) {
            session.state.phase = GamePhase.Active;
        }
        return session;
    }
    /**
     * Look up a token. Returns the game session and the role, or null.
     */
    authenticate(token) {
        const entry = this.tokenIndex.get(token);
        if (!entry)
            return null;
        const session = this.games.get(entry.gameId);
        if (!session)
            return null;
        return { session, role: entry.role };
    }
    /**
     * Register a socket for a player in a game.
     * Returns true if both players are now connected and the game should start.
     */
    addSocket(session, playerId, socketId) {
        const sockets = session.sockets.get(playerId);
        sockets.add(socketId);
        session.joinedPlayers.add(playerId);
        // Cancel disconnect timer if any
        const timer = session.disconnectTimers.get(playerId);
        if (timer) {
            clearTimeout(timer);
            session.disconnectTimers.delete(playerId);
        }
        // Check if game should start (both joined + phase is lobby)
        if (session.state.phase === GamePhase.Lobby &&
            session.joinedPlayers.has('player1') &&
            session.joinedPlayers.has('player2') &&
            session.sockets.get('player1').size > 0 &&
            session.sockets.get('player2').size > 0) {
            session.state.phase = GamePhase.Active;
            return true;
        }
        return false;
    }
    /**
     * Remove a socket. Returns 'paused' if the player has no remaining connections,
     * 'ok' otherwise. Starts a disconnect timer if paused.
     */
    removeSocket(session, playerId, socketId, onForfeit) {
        const sockets = session.sockets.get(playerId);
        sockets.delete(socketId);
        if (sockets.size === 0 && session.state.phase === GamePhase.Active) {
            const timer = setTimeout(() => {
                // Forfeit
                const winner = playerId === 'player1' ? 'player2' : 'player1';
                session.state.phase = GamePhase.Finished;
                session.state.winner = winner;
                session.disconnectTimers.delete(playerId);
                onForfeit();
            }, DISCONNECT_TIMEOUT_MS);
            session.disconnectTimers.set(playerId, timer);
            return 'paused';
        }
        return 'ok';
    }
    processAction(session, playerId, action) {
        return applyAction(session.state, action, playerId);
    }
    getPlayerView(session, playerId) {
        return getPlayerView(session.state, playerId);
    }
    getGame(id) {
        return this.games.get(id);
    }
    listGames() {
        const result = [];
        for (const [, session] of this.games) {
            result.push({
                id: session.id,
                phase: session.state.phase,
                turn: session.state.turn,
                playersConnected: (session.sockets.get('player1').size > 0 ? 1 : 0) +
                    (session.sockets.get('player2').size > 0 ? 1 : 0),
                mode: session.isAiVsAi ? 'ai_vs_ai' : session.isPvE ? 'pve' : 'pvp',
            });
        }
        return result;
    }
    deleteGame(id) {
        const session = this.games.get(id);
        if (!session)
            return false;
        // Clean up timers
        for (const timer of session.disconnectTimers.values()) {
            clearTimeout(timer);
        }
        // Clean up token index
        this.tokenIndex.delete(session.tokens.adminToken);
        this.tokenIndex.delete(session.tokens.p1Token);
        this.tokenIndex.delete(session.tokens.p2Token);
        this.games.delete(id);
        return true;
    }
}
//# sourceMappingURL=gameManager.js.map