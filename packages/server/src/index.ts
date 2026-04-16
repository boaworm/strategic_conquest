import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import type {
  PlayerId,
  GameAction,
  ServerToClientEvents,
  ClientToServerEvents,
} from '@sc/shared';
import { GamePhase } from '@sc/shared';
import { GameManager } from './gameManager.js';
import { createGameRoutes } from './routes/game.js';
import { createTrainingRoutes } from './routes/training.js';
import { createReplayRoutes } from './routes/replay.js';
import { createMapRoutes } from './routes/map.js';

// ── Parse CLI args ────────────────────────────────────────────

const _argv = process.argv.slice(2);

function parsePort(): number {
  for (let i = 0; i < _argv.length; i++) {
    if (_argv[i] === '--port' || _argv[i] === '-p') {
      const val = Number(_argv[i + 1]);
      if (!Number.isNaN(val) && val > 0 && val < 65536) return val;
    }
    // Also accept --port=N
    if (_argv[i].startsWith('--port=')) {
      const val = Number(_argv[i].split('=')[1]);
      if (!Number.isNaN(val) && val > 0 && val < 65536) return val;
    }
  }
  // Bare number as first arg
  if (_argv.length > 0) {
    const val = Number(_argv[0]);
    if (!Number.isNaN(val) && val > 0 && val < 65536) return val;
  }
  return 4000;
}

const PORT = parsePort();


// ── Server setup ─────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Proxy-resilient path handling: if request is /subpath/api/... or /subpath/assets/...
// rewrite it to /api/... or /assets/... so it matches local routes.
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url}`);
  const prefixes = ['/api', '/socket.io', '/assets', '/health'];
  for (const p of prefixes) {
    const idx = req.url.indexOf(p);
    if (idx > 0) {
      req.url = req.url.substring(idx);
      break;
    }
  }
  next();
});

const server = http.createServer(app);
const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(
  server,
  {
    cors: { origin: '*' },
  },
);

// Deep logging for debugging reverse proxy / WebSocket issues
server.on('upgrade', (req, _socket, _head) => {
  console.log(`[Upgrade] ${req.method} ${req.url}`);
});

io.engine.on('connection_error', (err) => {
  console.error('[Socket.IO Error]', {
    url: err.req.url,
    code: err.code,
    message: err.message,
    context: err.context,
  });
});

const manager = new GameManager();
// Wire up io so forceEndTurn can emit socket events
manager.io = io;

// ── REST routes ──────────────────────────────────────────────

app.use('/api', createGameRoutes(manager));
app.use('/api', createTrainingRoutes(manager));
app.use('/api', createReplayRoutes());
app.use('/api', createMapRoutes());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', games: manager.listGames().length });
});

// ── Serve the built client ───────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(clientDir));

// SPA fallback: any non-API, non-socket route serves index.html
app.use((_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

// ── WebSocket handling ───────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    console.error('Socket connection rejected: Missing auth token');
    return next(new Error('Missing auth token'));
  }

  const auth = manager.authenticate(token);
  if (!auth) {
    console.error('Socket connection rejected: Invalid token', token);
    return next(new Error('Invalid token'));
  }
  if (auth.role === 'admin') {
    return next(new Error('Admin token cannot be used for socket connections'));
  }

  // Attach game info to socket
  (socket as any).gameId = auth.session.id;
  (socket as any).playerId = auth.role;
  next();
});

io.on('connection', (socket) => {
  const gameId = (socket as any).gameId as string;
  const playerId = (socket as any).playerId as PlayerId;

  const session: import('./gameManager.js').GameSession = manager.getGame(gameId)!;
  if (!session) {
    socket.emit('error', { message: 'Game not found' });
    socket.disconnect();
    return;
  }

  // Join a Socket.IO room for this game
  socket.join(gameId);

  // Register socket
  const shouldStart = manager.addSocket(session, playerId, socket.id);

  // Notify others that a player joined (skip for AI vs AI games)
  if (!session.isAiVsAi) {
    socket.to(gameId).emit('playerJoined', { playerId });
  }

  if (shouldStart) {
    // Game transitions from Lobby to Active — send initial state to both players
    for (const pid of ['player1', 'player2'] as PlayerId[]) {
      const view = manager.getPlayerView(session, pid);
      const sockets = session.sockets.get(pid)!;
      for (const sid of sockets) {
        io.to(sid).emit('gameStart', view);
      }
    }
  }

  if (session.state.phase === GamePhase.Active) {
    // Game already active (reconnect or second tab) — send current state
    const view = manager.getPlayerView(session, playerId);
    socket.emit('stateUpdate', view);

    // If game was paused, resume
    socket.to(gameId).emit('gameResumed');
  }

  // ── Handle game actions ────────────────────────────────────

  socket.on('action', (action: GameAction) => {
    if (session.state.phase !== GamePhase.Active) {
      socket.emit('actionRejected', { reason: 'Game is not active' });
      return;
    }

    // PvE: capture attacker info BEFORE applying action (positions change after).
    // Used to emit enemyCombat to the human player and pace AI actions.
    type EnemyCombatCapture = {
      humanId: PlayerId;
      attackerUnitId: string;
      attackerType: import('@sc/shared').UnitType;
      attackerOwner: string;
      fromX: number; fromY: number;
      toX: number; toY: number;
    };
    let enemyCombatCapture: EnemyCombatCapture | null = null;
    if (!session.isAiVsAi && action.type === 'MOVE' && session.playerTypes.get(playerId) === 'ai') {
      const attackerUnit = session.state.units.find((u) => u.id === action.unitId);
      const humanId: PlayerId = playerId === 'player1' ? 'player2' : 'player1';
      if (attackerUnit) {
        const hasDefender = session.state.units.some(
          (u) => u.x === action.to.x && u.y === action.to.y && u.owner === humanId,
        );
        const hasCity = session.state.cities.some(
          (c) => c.x === action.to.x && c.y === action.to.y && c.owner === humanId,
        );
        if (hasDefender || hasCity) {
          enemyCombatCapture = {
            humanId,
            attackerUnitId: attackerUnit.id,
            attackerType: attackerUnit.type,
            attackerOwner: attackerUnit.owner,
            fromX: attackerUnit.x,
            fromY: attackerUnit.y,
            toX: action.to.x,
            toY: action.to.y,
          };
        }
      }
    }

    const result = manager.processAction(session, playerId, action);

    if (!result.success) {
      socket.emit('actionRejected', { reason: result.error ?? 'Unknown error' });
      return;
    }

    // Send action result to the acting player's connections
    const actorSockets = session.sockets.get(playerId)!;
    for (const sid of actorSockets) {
      io.to(sid).emit('actionResult', result);
    }

    // Check for game over
    if (session.state.phase === (GamePhase.Finished as GamePhase) && session.state.winner) {
      io.to(gameId).emit('gameOver', { winner: session.state.winner });
    }

    // PvE enemy combat: send human the event + updated view immediately,
    // delay stateUpdate to AI so it pauses while the human watches the animation.
    const ANIM_DELAY_MS = 2000;
    if (
      enemyCombatCapture &&
      (result.combat || result.cityCaptured || result.bomberBlastRadius !== undefined)
    ) {
      const { humanId, ...combatData } = enemyCombatCapture;
      const humanView = manager.getPlayerView(session, humanId);
      const humanSockets = session.sockets.get(humanId)!;
      for (const sid of humanSockets) {
        io.to(sid).emit('enemyCombat', {
          ...combatData,
          combat: result.combat ?? null,
          cityCaptured: !!result.cityCaptured,
          bomberBlastRadius: result.bomberBlastRadius,
          bomberBlastCenter: result.bomberBlastCenter,
        });
        io.to(sid).emit('stateUpdate', humanView);
      }

      // AI gets its stateUpdate after the animation delay
      const aiSocketIds = Array.from(actorSockets);
      const aiView = manager.getPlayerView(session, playerId);
      setTimeout(() => {
        for (const sid of aiSocketIds) {
          io.to(sid).emit('stateUpdate', aiView);
        }
      }, ANIM_DELAY_MS);
      return;
    }

    // Normal: send updated view to all players
    for (const pid of ['player1', 'player2'] as PlayerId[]) {
      const view = manager.getPlayerView(session, pid);
      const sockets = session.sockets.get(pid)!;
      for (const sid of sockets) {
        io.to(sid).emit('stateUpdate', view);
      }
    }
  });

  // ── Handle disconnect ──────────────────────────────────────

  socket.on('disconnect', () => {
    const status = manager.removeSocket(session, playerId, socket.id, () => {
      // Forfeit callback
      if (session.state.winner) {
        io.to(gameId).emit('gameOver', { winner: session.state.winner });
      }
    });

    if (status === 'paused') {
      io.to(gameId).emit('gamePaused', {
        reason: `${playerId} disconnected. Waiting for reconnect...`,
      });
      socket.to(gameId).emit('playerDisconnected', { playerId });
    }
  });
});

// ── Start ────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Strategic Conquest server listening on port ${PORT}`);
});
