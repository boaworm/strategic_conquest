import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import type {
  PlayerView,
  GameAction,
  ActionResult,
  EnemyCombatEvent,
  PlayerId,
  CreateGameResponse,
  ServerToClientEvents,
  ClientToServerEvents,
} from '@sc/shared';

interface GameStore {
  // Connection state
  connected: boolean;
  token: string | null;
  gameId: string | null;
  playerId: PlayerId | null;

  // Game state (fog-of-war filtered)
  view: PlayerView | null;
  lastActionResult: ActionResult | null;
  lastEnemyCombat: EnemyCombatEvent | null;
  error: string | null;
  gamePaused: boolean;

  // Socket
  socket: Socket<ServerToClientEvents, ClientToServerEvents> | null;

  // Actions
  createGame: (
    mapWidth?: number,
    mapHeight?: number,
    mode?: 'pvp' | 'pve' | 'ai_vs_ai',
    p1Type?: 'human' | 'ai',
    p2Type?: 'human' | 'ai',
    p1AI?: 'adam' | 'basic' | 'gunair',
    p2AI?: 'adam' | 'basic' | 'gunair',
  ) => Promise<CreateGameResponse>;
  joinGame: (token: string) => void;
  sendAction: (action: GameAction) => void;
  disconnect: () => void;

  // Selected unit for UI
  selectedUnitId: string | null;
  selectUnit: (id: string | null) => void;

  // Auto end turn
  autoEndTurn: boolean;
  setAutoEndTurn: (v: boolean) => void;

  // Auto-select next moveable unit
  autoSelectNext: boolean;
  setAutoSelectNext: (v: boolean) => void;

  // Viewport / camera
  tileSize: number;
  cameraX: number; // center of viewport in tile coords
  cameraY: number;
  viewportInitialized: boolean;
  setTileSize: (size: number) => void;
  setCamera: (x: number, y: number) => void;
}

export const DEFAULT_TILE_SIZE = 32;

export const useGameStore = create<GameStore>((set, get) => ({
  connected: false,
  token: null,
  gameId: null,
  playerId: null,
  view: null,
  lastActionResult: null,
  lastEnemyCombat: null,
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

  createGame: async (
    mapWidth?: number,
    mapHeight?: number,
    mode: 'pvp' | 'pve' | 'ai_vs_ai' = 'pvp',
    p1Type: 'human' | 'ai' = 'human',
    p2Type: 'human' | 'ai' = 'human',
    p1AI?: 'adam' | 'basic' | 'gunair',
    p2AI?: 'adam' | 'basic' | 'gunair',
  ) => {
    const body: Record<string, number | string> = {};
    if (mapWidth) body.mapWidth = mapWidth;
    if (mapHeight) body.mapHeight = mapHeight;
    body.mode = mode;
    if (p1Type) body.p1Type = p1Type;
    if (p2Type) body.p2Type = p2Type;
    if (p1AI) body.p1AI = p1AI;
    if (p2AI) body.p2AI = p2AI;

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
    const data: CreateGameResponse = await res.json();
    set({ gameId: data.gameId });
    return data;
  },

  joinGame: (token: string) => {
    if (!token) {
      console.error('joinGame called with empty token');
      return;
    }
    const existing = get().socket;
    if (existing) existing.disconnect();

    const socketPath = window.location.pathname.replace(/\/?$/, '') + '/socket.io/';
    console.log('Joining game, socket path:', socketPath);

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
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

    socket.on('gameStart', (view: PlayerView) => {
      // Derive playerId from view
      const pid = view.myUnits.length > 0 ? view.myUnits[0].owner : view.currentPlayer;
      // Center camera on first owned city (or first unit)
      const updates: Partial<GameStore> = { view, playerId: pid };
      if (!get().viewportInitialized) {
        const city = view.myCities[0];
        if (city) {
          updates.cameraX = city.x;
          updates.cameraY = city.y;
        } else if (view.myUnits[0]) {
          updates.cameraX = view.myUnits[0].x;
          updates.cameraY = view.myUnits[0].y;
        }
        updates.viewportInitialized = true;
      }
      set(updates as GameStore);
    });

    socket.on('stateUpdate', (view: PlayerView) => {
      const pid = view.myUnits.length > 0 ? view.myUnits[0].owner : get().playerId;

      // Center camera on enemy attacks/movements when it's not our turn
      const lastView = get().view;
      if (view.currentPlayer !== pid && lastView) {
        // Check enemy units for movement (enemy attacks are detected in GameCanvas via combat animation)
        for (const u of view.visibleEnemyUnits) {
          const lastUnit = lastView.visibleEnemyUnits.find((lu) => lu.id === u.id);
          if (lastUnit && (u.x !== lastUnit.x || u.y !== lastUnit.y)) {
            // Enemy unit moved - center camera on new position
            const { setCamera } = get();
            setCamera(u.x, u.y);
            break;
          }
        }
      }

      set({ view, playerId: pid, gamePaused: false });

      // Auto-select next moveable unit when current one is done
      if (get().autoSelectNext && view.currentPlayer === pid) {
        const selId = get().selectedUnitId;
        const selUnit = selId ? view.myUnits.find((u) => u.id === selId) : null;
        const needNext = !selUnit || selUnit.movesLeft <= 0 || selUnit.sleeping || selUnit.carriedBy !== null;
        if (needNext) {
          const next = view.myUnits.find(
            (u) => u.movesLeft > 0 && !u.sleeping && u.carriedBy === null,
          );
          set({ selectedUnitId: next?.id ?? null });
        }
      }

      // Auto end turn: if it's my turn and all my units have 0 moves (or are sleeping/carried)
      // BUT skip if any city is idle — give the player a chance to set production
      if (get().autoEndTurn && view.currentPlayer === pid) {
        const hasIdleCity = view.myCities.some((c) => c.producing === null);
        const allDone = view.myUnits.length > 0 && view.myUnits.every(
          (u) => u.movesLeft <= 0 || u.sleeping || u.carriedBy !== null,
        );
        if (allDone && !hasIdleCity) {
          const s = get().socket;
          if (s) s.emit('action', { type: 'END_TURN' });
        }
      }
    });

    socket.on('actionResult', (result: ActionResult) => {
      set({ lastActionResult: result });
    });

    socket.on('actionRejected', (data: { reason: string }) => {
      // Suppress "Not your turn" — HUD already shows turn status
      if (data.reason === 'Not your turn') return;
      set({ error: data.reason });
    });

    socket.on('enemyCombat', (data: EnemyCombatEvent) => {
      set({ lastEnemyCombat: data });
    });

    socket.on('gamePaused', () => {
      set({ gamePaused: true });
    });

    socket.on('gameResumed', () => {
      set({ gamePaused: false });
    });

    socket.on('error', (data: { message: string }) => {
      set({ error: data.message });
    });

    set({ socket });
  },

  sendAction: (action: GameAction) => {
    const socket = get().socket;
    if (socket) socket.emit('action', action);
  },

  disconnect: () => {
    const socket = get().socket;
    if (socket) socket.disconnect();
    set({
      socket: null,
      connected: false,
      view: null,
      token: null,
      gameId: null,
      playerId: null,
      error: null,
      gamePaused: false,
      lastEnemyCombat: null,
      selectedUnitId: null,
    });
  },

  selectUnit: (id: string | null) => {
    set({ selectedUnitId: id });
  },

  setAutoEndTurn: (v: boolean) => {
    set({ autoEndTurn: v });
  },

  setAutoSelectNext: (v: boolean) => {
    set({ autoSelectNext: v });
  },

  setTileSize: (size: number) => {
    set({ tileSize: size });
  },

  setCamera: (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    set({ cameraX: x, cameraY: y });
  },
}));
