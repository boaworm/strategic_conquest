import {
  type GameState,
  type GameAction,
  type PlayerId,
  type PlayerView,
  type PlayerType,
  GamePhase,
  createGameState,
  applyAction,
  getPlayerView,
  type AIDifficulty,
  UNIT_STATS,
} from '@sc/shared';
import { generateTokens, type GameTokens } from './tokenAuth.js';
import { spawnAIPlayer } from './aiPlayer.js';

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

const DISCONNECT_TIMEOUT_MS = 60_000;

export class GameManager {
  /** Injected after construction so forceEndTurn can push socket events. */
  public io?: import('socket.io').Server;

  private games = new Map<string, GameSession>();
  /** token → { gameId, role } */
  private tokenIndex = new Map<
    string,
    { gameId: string; role: 'admin' | PlayerId }
  >();

  /**
   * Create a game and spawn AI players if needed
   */
  async createGame(
    mapWidth = 60,
    mapHeight = 40,
    isPvE = false,
    difficulty: AIDifficulty = 'medium',
    p1Type: 'human' | 'ai' = 'human',
    p2Type: 'human' | 'ai' = 'human',
    p1AI: 'adam' | 'basic' = 'basic',
    p2AI: 'adam' | 'basic' = 'basic',
  ): Promise<GameSession> {
    const id = crypto.randomUUID();
    const tokens = generateTokens();

    const state = createGameState({ width: mapWidth, height: mapHeight });
    // Game starts in lobby phase until both players connect
    state.phase = GamePhase.Lobby;

    const isAiVsAi = p1Type === 'ai' && p2Type === 'ai';

    const session: GameSession = {
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

    // Spawn AI players if needed
    if (p1Type === 'ai') {
      console.log(`[AI Manager] Spawning ${p1AI} as player1 for game ${id}`);
      await spawnAIPlayer(session, 'player1', p1AI);
    }

    if (p2Type === 'ai') {
      console.log(`[AI Manager] Spawning ${p2AI} as player2 for game ${id}`);
      await spawnAIPlayer(session, 'player2', p2AI);
    }

    // For AI vs AI, start immediately (both players are AI and will connect)
    if (isAiVsAi) {
      session.state.phase = GamePhase.Active;
    }

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

    // Check if game should start
    // For AI vs AI: both must be connected
    // For PvE: player1 must be connected, player2 is AI (always connected)
    // For PvP: both must be connected
    const player1Connected = session.joinedPlayers.has('player1') && session.sockets.get('player1')!.size > 0;
    const player2Connected = session.joinedPlayers.has('player2') && session.sockets.get('player2')!.size > 0;

    let shouldStart = false;
    if (session.isAiVsAi) {
      // Both AI players must be connected
      shouldStart = player1Connected && player2Connected;
    } else if (session.isPvE) {
      // PvE: player1 (human) must connect; player2 (AI) is always connected
      // If player1 has joined and player2 is connected, start the game
      shouldStart = session.joinedPlayers.has('player1') && player2Connected;
    } else {
      // PvP: both players must be connected
      shouldStart = player1Connected && player2Connected;
    }

    if (shouldStart && session.state.phase === GamePhase.Lobby) {
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

  listGames(): { id: string; phase: string; turn: number; playersConnected: number; mode: string }[] {
    const result: { id: string; phase: string; turn: number; playersConnected: number; mode: string }[] = [];
    for (const [, session] of this.games) {
      result.push({
        id: session.id,
        phase: session.state.phase,
        turn: session.state.turn,
        playersConnected:
          (session.sockets.get('player1')!.size > 0 ? 1 : 0) +
          (session.sockets.get('player2')!.size > 0 ? 1 : 0),
        mode: session.isAiVsAi ? 'ai_vs_ai' : session.isPvE ? 'pve' : 'pvp',
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

  /**
   * Force end the current player's turn and switch to the next player.
   * Also resets moves and attack status for the new player's units.
   */
  forceEndTurn(session: GameSession): { previousPlayer: PlayerId; newPlayer: PlayerId; turn: number } {
    const currentTurn = session.state.currentPlayer;
    const nextPlayer = currentTurn === 'player1' ? 'player2' : 'player1';

    // Switch turn
    session.state.currentPlayer = nextPlayer;
    session.state.turn++;

    // Reset moves and attack status for the new player's units
    for (const unit of session.state.units) {
      if (unit.owner === nextPlayer) {
        const stats = UNIT_STATS[unit.type];
        unit.movesLeft = stats.movesPerTurn;
        unit.hasAttacked = false;
      }
    }

    // Emit updated state to all connected players via the manager-level io reference
    if (this.io) {
      const view1 = this.getPlayerView(session, 'player1');
      const view2 = this.getPlayerView(session, 'player2');

      session.sockets.get('player1')?.forEach((socketId) => {
        this.io?.to(socketId).emit('stateUpdate', view1);
      });
      session.sockets.get('player2')?.forEach((socketId) => {
        this.io?.to(socketId).emit('stateUpdate', view2);
      });
    }

    return { previousPlayer: currentTurn, newPlayer: nextPlayer, turn: session.state.turn };
  }
}
