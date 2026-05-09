import { io, type Socket } from 'socket.io-client';
import { BasicAgent, GunAirAgent, NnAgent, UNIT_STATS } from '@sc/shared';
import type { Agent, AgentAction } from '@sc/shared';
import type { GameSession } from './gameManager.js';
import type { PlayerId } from '@sc/shared';
import { VERBOSE } from './config.js';
import { modelRegistry } from './routes/game.js';

const TAG = '[AI]';
const log = VERBOSE ? console.log : () => {};

/**
 * Spawns an AI player that connects to the game via WebSocket
 * and automatically plays using the selected AI agent.
 */
export async function spawnAIPlayer(
  session: GameSession,
  playerId: PlayerId,
  aiName: 'basic' | 'gunair' | 'nn',
  modelId?: string,
): Promise<Socket> {
  const token = playerId === 'player1' ? session.tokens.p1Token : session.tokens.p2Token;
  const serverUrl = process.env.SERVER_URL || 'http://localhost:4000';

  // Create the appropriate AI agent
  let agent: Agent;
  if (aiName === 'gunair') {
    agent = new GunAirAgent();
  } else if (aiName === 'nn') {
    agent = new NnAgent();
    // Set model path if modelId provided
    if (modelId) {
      const model = modelRegistry.getModelById(modelId);
      if (model) {
        process.env.NN_MODEL_PATH = model.path;
        log(`${TAG} ${playerId} using NN model: ${model.name} (${model.path})`);
      } else {
        console.error(`${TAG} ${playerId} NN model not found: ${modelId}`);
      }
    }
  } else {
    agent = new BasicAgent();
  }

  // NnAgent.init() is async, others are sync
  if (aiName === 'nn') {
    await (agent as NnAgent).init({
      playerId,
      mapWidth: session.state.mapWidth,
      mapHeight: session.state.mapHeight,
    });
  } else {
    agent.init({
      playerId,
      mapWidth: session.state.mapWidth,
      mapHeight: session.state.mapHeight,
    });
  }

  // Connect the socket and wait for connection
  const socket = io(serverUrl, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => { resolve(); });
    socket.on('connect_error', (err) => { reject(err); });
    socket.on('error', (err) => { reject(err); });
  });

  // Track the last emitted action so actionRejected can SKIP that unit
  const lastActionRef: { current: AgentAction | null } = { current: null };

  socket.on('gameStart', async (view: any) => {
    await triggerAITurn(socket, agent, view, playerId, lastActionRef);
  });

  socket.on('stateUpdate', async (view: any) => {
    await triggerAITurn(socket, agent, view, playerId, lastActionRef);
  });

  /**
   * actionRejected — the server refused the last action.
   * Consume only the offending unit's remaining moves (SKIP), then
   * continue the turn. Falls back to END_TURN only when there is no
   * unit to SKIP (e.g. SET_PRODUCTION or END_TURN rejections).
   */
  socket.on('actionRejected', (data: { reason: string }) => {
    if (data.reason === 'Game is not active') {
      return;
    }
    const unitId = (lastActionRef.current as any)?.unitId as string | undefined;
    if (unitId) {
      console.error(`${TAG} ${playerId} action rejected: ${data.reason} — SKIPping unit ${unitId}`);
      socket.emit('action', { type: 'SKIP', unitId });
    } else {
      console.error(`${TAG} ${playerId} action rejected: ${data.reason} — sending END_TURN`);
      socket.emit('action', { type: 'END_TURN' });
    }
  });

  return socket;
}

/**
 * Trigger the AI to take its turn.
 * Decides the next action and emits it, with full debug logging.
 */
async function triggerAITurn(
  socket: Socket,
  agent: Agent,
  view: any,
  expectedPlayerId: string,
  lastActionRef: { current: AgentAction | null },
) {
  if (view.currentPlayer !== expectedPlayerId) return;

  const prefix = `${TAG} ${expectedPlayerId} turn ${view.turn}`;

  // Log current unit status
  const activeUnits = (view.myUnits as any[]).filter(
    (u: any) => !u.sleeping && u.movesLeft > 0 && u.carriedBy === null,
  );
  for (const u of activeUnits) {
    const stats = UNIT_STATS[u.type as keyof typeof UNIT_STATS];
    log(
      `${prefix} | Unit ${u.type} (${u.id}) at (${u.x},${u.y}) — moves ${u.movesLeft}/${stats.movesPerTurn}`,
    );
  }

  const sleepingUnits = (view.myUnits as any[]).filter(
    (u: any) => u.sleeping && u.movesLeft > 0 && u.carriedBy === null,
  );
  for (const u of sleepingUnits) {
    log(`${prefix} | Unit ${u.type} (${u.id}) at (${u.x},${u.y}) — sleeping, will wake`);
  }

  // Log city production status
  for (const city of view.myCities as any[]) {
    if (city.producing) {
      log(
        `${prefix} | City (${city.x},${city.y}) producing ${city.producing} (${city.productionTurnsLeft} turns left)`,
      );
    } else {
      log(`${prefix} | City (${city.x},${city.y}) — idle, will assign production`);
    }
  }

  // Let the AI decide and log the chosen action
  const action: AgentAction = await agent.act({
    tiles: view.tiles,
    myUnits: view.myUnits,
    myCities: view.myCities,
    visibleEnemyUnits: view.visibleEnemyUnits,
    visibleEnemyCities: view.visibleEnemyCities,
    turn: view.turn,
    myPlayerId: expectedPlayerId as any,
    myMissileBlastRadius: view.myMissileBlastRadius,
  });

  lastActionRef.current = action;
  logAction(prefix, action, view);
  socket.emit('action', action);
}

/** Pretty-print the action the AI chose. */
function logAction(prefix: string, action: AgentAction, view: any) {
  switch (action.type) {
    case 'MOVE': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      const from = unit ? `(${unit.x},${unit.y})` : '(??)';
      log(`${prefix} | → MOVE ${unit?.type ?? action.unitId} from ${from} to (${action.to.x},${action.to.y})`);
      break;
    }
    case 'SKIP': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      log(`${prefix} | → SKIP ${unit?.type ?? action.unitId} (stuck — no valid moves)`);
      break;
    }
    case 'SLEEP': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      log(`${prefix} | → SLEEP ${unit?.type ?? action.unitId}`);
      break;
    }
    case 'WAKE': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      log(`${prefix} | → WAKE ${unit?.type ?? action.unitId}`);
      break;
    }
    case 'SET_PRODUCTION': {
      const city = (view.myCities as any[]).find((c: any) => c.id === action.cityId);
      const was = city?.producing ?? 'idle';
      const now = action.unitType;
      const change = was === now ? `stays ${now}` : `${was} → ${now}`;
      log(`${prefix} | → SET_PRODUCTION city (${city?.x ?? '?'},${city?.y ?? '?'}): ${change}`);
      break;
    }
    case 'END_TURN':
      log(`${prefix} | → END_TURN`);
      break;
    default:
      log(`${prefix} | → ${JSON.stringify(action)}`);
  }
}
