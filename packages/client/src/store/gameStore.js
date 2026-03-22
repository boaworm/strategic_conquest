import { create } from 'zustand';
import { io } from 'socket.io-client';
export const DEFAULT_TILE_SIZE = 32;
export const useGameStore = create((set, get) => ({
    connected: false,
    token: null,
    gameId: null,
    playerId: null,
    view: null,
    lastActionResult: null,
    error: null,
    gamePaused: false,
    socket: null,
    selectedUnitId: null,
    autoEndTurn: true,
    autoSelectNext: true,
    tileSize: DEFAULT_TILE_SIZE,
    cameraX: 0,
    cameraY: 0,
    viewportInitialized: false,
    createGame: async (mapWidth, mapHeight, mode = 'pvp', difficulty) => {
        const body = {};
        if (mapWidth)
            body.mapWidth = mapWidth;
        if (mapHeight)
            body.mapHeight = mapHeight;
        body.mode = mode;
        if (difficulty)
            body.difficulty = difficulty;
        console.log('Creating game via fetch("./api/games")...');
        const res = await fetch('./api/games', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            console.error('Failed to create game:', res.status, text);
            throw new Error(`Failed to create game: ${res.status}`);
        }
        const data = await res.json();
        set({ gameId: data.gameId });
        return data;
    },
    joinGame: (token) => {
        if (!token) {
            console.error('joinGame called with empty token');
            return;
        }
        const existing = get().socket;
        if (existing)
            existing.disconnect();
        const socketPath = window.location.pathname.replace(/\/?$/, '') + '/socket.io/';
        console.log('Joining game, socket path:', socketPath);
        const socket = io({
            path: socketPath,
            auth: { token },
            transports: ['websocket', 'polling'], // allow fallback to polling if ws fails
        });
        socket.on('connect', () => {
            console.log('Socket connected!');
            set({ connected: true, token, error: null });
        });
        socket.on('connect_error', (err) => {
            console.error('Socket connection error:', err);
            set({ error: `Connection failed: ${err.message}` });
        });
        socket.on('disconnect', (reason) => {
            console.log('Socket disconnected:', reason);
            set({ connected: false });
        });
        socket.on('gameStart', (view) => {
            // Derive playerId from view
            const pid = view.myUnits.length > 0 ? view.myUnits[0].owner : view.currentPlayer;
            // Center camera on first owned city (or first unit)
            const updates = { view, playerId: pid };
            if (!get().viewportInitialized) {
                const city = view.myCities[0];
                if (city) {
                    updates.cameraX = city.x;
                    updates.cameraY = city.y;
                }
                else if (view.myUnits[0]) {
                    updates.cameraX = view.myUnits[0].x;
                    updates.cameraY = view.myUnits[0].y;
                }
                updates.viewportInitialized = true;
            }
            set(updates);
        });
        socket.on('stateUpdate', (view) => {
            const pid = view.myUnits.length > 0 ? view.myUnits[0].owner : get().playerId;
            set({ view, playerId: pid, gamePaused: false });
            // Auto-select next moveable unit when current one is done
            if (get().autoSelectNext && view.currentPlayer === pid) {
                const selId = get().selectedUnitId;
                const selUnit = selId ? view.myUnits.find((u) => u.id === selId) : null;
                const needNext = !selUnit || selUnit.movesLeft <= 0 || selUnit.sleeping || selUnit.carriedBy !== null;
                if (needNext) {
                    const next = view.myUnits.find((u) => u.movesLeft > 0 && !u.sleeping && u.carriedBy === null);
                    set({ selectedUnitId: next?.id ?? null });
                }
            }
            // Auto end turn: if it's my turn and all my units have 0 moves (or are sleeping/carried)
            // BUT skip if any city is idle — give the player a chance to set production
            if (get().autoEndTurn && view.currentPlayer === pid) {
                const hasIdleCity = view.myCities.some((c) => c.producing === null);
                const allDone = view.myUnits.length > 0 && view.myUnits.every((u) => u.movesLeft <= 0 || u.sleeping || u.carriedBy !== null);
                if (allDone && !hasIdleCity) {
                    const s = get().socket;
                    if (s)
                        s.emit('action', { type: 'END_TURN' });
                }
            }
        });
        socket.on('actionResult', (result) => {
            set({ lastActionResult: result });
        });
        socket.on('actionRejected', (data) => {
            // Suppress "Not your turn" — HUD already shows turn status
            if (data.reason === 'Not your turn')
                return;
            set({ error: data.reason });
        });
        socket.on('gamePaused', () => {
            set({ gamePaused: true });
        });
        socket.on('gameResumed', () => {
            set({ gamePaused: false });
        });
        socket.on('error', (data) => {
            set({ error: data.message });
        });
        set({ socket });
    },
    sendAction: (action) => {
        const socket = get().socket;
        if (socket)
            socket.emit('action', action);
    },
    disconnect: () => {
        const socket = get().socket;
        if (socket)
            socket.disconnect();
        set({
            socket: null,
            connected: false,
            view: null,
            token: null,
            gameId: null,
            playerId: null,
            error: null,
            gamePaused: false,
            selectedUnitId: null,
        });
    },
    selectUnit: (id) => {
        set({ selectedUnitId: id });
    },
    setAutoEndTurn: (v) => {
        set({ autoEndTurn: v });
    },
    setAutoSelectNext: (v) => {
        set({ autoSelectNext: v });
    },
    setTileSize: (size) => {
        set({ tileSize: size });
    },
    setCamera: (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        set({ cameraX: x, cameraY: y });
    },
}));
//# sourceMappingURL=gameStore.js.map