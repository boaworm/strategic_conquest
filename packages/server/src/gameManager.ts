import {
  type GameState,
  type GameAction,
  type PlayerId,
  type PlayerView,
  GamePhase,
  createGameState,
  applyAction,
  getPlayerView,
  type AIDifficulty,
} from '@sc/shared';
import { generateTokens, type GameTokens } from './tokenAuth.js';

export interface GameSession {
  id: string;
  tokens: GameTokens;
  state: GameState;
  /** Set of socket ids per player */
  sockets: Map<PlayerId, Set<string>>;
  /** Disconnect timer per player */
  disconnectTimers: Map<PlayerId, ReturnType<typeof setTimeout>>;
  /** Track which players have joined at least once */
  joinedPlayers: Set<PlayerId>;
  /** AI difficulty if PvE mode */
  difficulty?: AIDifficulty;
  /** Is this a PvE game? */
  isPvE: boolean;
  createdAt: number;
}

const DISCONNECT_TIMEOUT_MS = 60_000;

export class GameManager {
  private games = new Map<string, GameSession>();
  /** token → { gameId, role } */
  private tokenIndex = new Map<
    string,
    { gameId: string; role: 'admin' | PlayerId }
  >();

  createGame(
    mapWidth = 60,
    mapHeight = 40,
    isPvE = false,
    difficulty: AIDifficulty = 'medium',
  ): GameSession {
    const id = crypto.randomUUID();
    const tokens = generateTokens();

    const state = createGameState({ width: mapWidth, height: mapHeight });
    // Game starts in lobby phase until both players connect
    state.phase = GamePhase.Lobby;

    const session: GameSession = {
      id,
      tokens,
      state,
      sockets: new Map([
        ['player1', new Set()],
        ['player2', new Set()],
      ]),
      disconnectTimers: new Map(),
      joinedPlayers: new Set(),
      difficulty: isPvE ? difficulty : undefined,
      isPvE,
      createdAt: Date.now(),
    };

    this.games.set(id, session);
    this.tokenIndex.set(tokens.adminToken, { gameId: id, role: 'admin' });
    this.tokenIndex.set(tokens.p1Token, { gameId: id, role: 'player1' });
    this.tokenIndex.set(tokens.p2Token, { gameId: id, role: 'player2' });

    return session;
  }

  /**
   * Look up a token. Returns the game session and the role, or null.
   */
  authenticate(token: string): {
    session: GameSession;
    role: 'admin' | PlayerId;
  } | null {
    const entry = this.tokenIndex.get(token);
    if (!entry) return null;
    const session = this.games.get(entry.gameId);
    if (!session) return null;
    return { session, role: entry.role };
  }

  /**
   * Register a socket for a player in a game.
   * Returns true if both players are now connected and the game should start.
   */
  addSocket(
    session: GameSession,
    playerId: PlayerId,
    socketId: string,
  ): boolean {
    const sockets = session.sockets.get(playerId)!;
    sockets.add(socketId);
    session.joinedPlayers.add(playerId);

    // Cancel disconnect timer if any
    const timer = session.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      session.disconnectTimers.delete(playerId);
    }

    // Check if game should start (both joined + phase is lobby)
    if (
      session.state.phase === GamePhase.Lobby &&
      session.joinedPlayers.has('player1') &&
      session.joinedPlayers.has('player2') &&
      session.sockets.get('player1')!.size > 0 &&
      session.sockets.get('player2')!.size > 0
    ) {
      session.state.phase = GamePhase.Active;
      return true;
    }
    return false;
  }

  /**
   * Remove a socket. Returns 'paused' if the player has no remaining connections,
   * 'ok' otherwise. Starts a disconnect timer if paused.
   */
  removeSocket(
    session: GameSession,
    playerId: PlayerId,
    socketId: string,
    onForfeit: () => void,
  ): 'ok' | 'paused' {
    const sockets = session.sockets.get(playerId)!;
    sockets.delete(socketId);

    if (sockets.size === 0 && session.state.phase === GamePhase.Active) {
      const timer = setTimeout(() => {
        // Forfeit
        const winner: PlayerId =
          playerId === 'player1' ? 'player2' : 'player1';
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

  processAction(
    session: GameSession,
    playerId: PlayerId,
    action: GameAction,
  ): ReturnType<typeof applyAction> {
    return applyAction(session.state, action, playerId);
  }

  getPlayerView(session: GameSession, playerId: PlayerId): PlayerView {
    return getPlayerView(session.state, playerId);
  }

  getGame(id: string): GameSession | undefined {
    return this.games.get(id);
  }

  listGames(): { id: string; phase: string; turn: number; playersConnected: number }[] {
    const result: { id: string; phase: string; turn: number; playersConnected: number }[] = [];
    for (const [, session] of this.games) {
      result.push({
        id: session.id,
        phase: session.state.phase,
        turn: session.state.turn,
        playersConnected:
          (session.sockets.get('player1')!.size > 0 ? 1 : 0) +
          (session.sockets.get('player2')!.size > 0 ? 1 : 0),
      });
    }
    return result;
  }

  deleteGame(id: string): boolean {
    const session = this.games.get(id);
    if (!session) return false;
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
