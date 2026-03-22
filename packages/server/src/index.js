import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { GamePhase } from '@sc/shared';
import { GameManager } from './gameManager.js';
import { createGameRoutes } from './routes/game.js';
import { createTrainingRoutes } from './routes/training.js';
// ── Parse port from CLI args ─────────────────────────────────
function parsePort() {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' || args[i] === '-p') {
            const val = Number(args[i + 1]);
            if (!Number.isNaN(val) && val > 0 && val < 65536)
                return val;
        }
        // Also accept --port=N
        if (args[i].startsWith('--port=')) {
            const val = Number(args[i].split('=')[1]);
            if (!Number.isNaN(val) && val > 0 && val < 65536)
                return val;
        }
    }
    // Bare number as first arg
    if (args.length > 0) {
        const val = Number(args[0]);
        if (!Number.isNaN(val) && val > 0 && val < 65536)
            return val;
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
const io = new SocketIOServer(server, {
    cors: { origin: '*' },
});
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
// ── REST routes ──────────────────────────────────────────────
app.use('/api', createGameRoutes(manager));
app.use('/api', createTrainingRoutes(manager));
// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', games: manager.listGames().length });
});
// ── Serve the built client ───────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..', 'public');
app.use(express.static(clientDir));
// SPA fallback: any non-API, non-socket route serves index.html
app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
});
// ── WebSocket handling ───────────────────────────────────────
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
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
    socket.gameId = auth.session.id;
    socket.playerId = auth.role;
    next();
});
io.on('connection', (socket) => {
    const gameId = socket.gameId;
    const playerId = socket.playerId;
    const session = manager.getGame(gameId);
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
        for (const pid of ['player1', 'player2']) {
            const view = manager.getPlayerView(session, pid);
            const sockets = session.sockets.get(pid);
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
    socket.on('action', (action) => {
        if (session.state.phase !== GamePhase.Active) {
            socket.emit('actionRejected', { reason: 'Game is not active' });
            return;
        }
        const result = manager.processAction(session, playerId, action);
        if (!result.success) {
            socket.emit('actionRejected', { reason: result.error ?? 'Unknown error' });
            return;
        }
        // Send action result to the acting player's connections
        const actorSockets = session.sockets.get(playerId);
        for (const sid of actorSockets) {
            io.to(sid).emit('actionResult', result);
        }
        // Send updated view to all connected players
        for (const pid of ['player1', 'player2']) {
            const view = manager.getPlayerView(session, pid);
            const sockets = session.sockets.get(pid);
            for (const sid of sockets) {
                io.to(sid).emit('stateUpdate', view);
            }
        }
        // Check for game over
        if (session.state.phase === GamePhase.Finished && session.state.winner) {
            io.to(gameId).emit('gameOver', { winner: session.state.winner });
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
//# sourceMappingURL=index.js.map