import { io, type Socket } from 'socket.io-client';
import { BasicAgent, GunAirAgent, UNIT_STATS } from '@sc/shared';
import type { Agent, AgentAction } from '@sc/shared';
import type { GameSession } from './gameManager.js';
import type { PlayerId } from '@sc/shared';

const TAG = '[AI]';

/**
 * Spawns an AI player that connects to the game via WebSocket
 * and automatically plays using the selected AI agent.
 */
export async function spawnAIPlayer(
  session: GameSession,
  playerId: PlayerId,
  aiName: 'basic' | 'gunair',
): Promise<Socket> {
  const token = playerId === 'player1' ? session.tokens.p1Token : session.tokens.p2Token;
  const serverUrl = process.env.SERVER_URL || 'http://localhost:4000';

  // Create the appropriate AI agent
  let agent: Agent;
  if (aiName === 'gunair') {
    agent = new GunAirAgent();
  } else {
    agent = new BasicAgent();
  }
  agent.init({
    playerId,
    mapWidth: session.state.mapWidth,
    mapHeight: session.state.mapHeight,
  });

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

  socket.on('gameStart', (view: any) => {
    triggerAITurn(socket, agent, view, playerId);
  });

  socket.on('stateUpdate', (view: any) => {
    triggerAITurn(socket, agent, view, playerId);
  });

  /**
   * actionRejected — the server refused the last action.
   * No stateUpdate will follow, so we must self-recover here.
   * Safest fallback: end the turn. This prevents the AI from
   * silently freezing and blocking the game indefinitely.
   */
  socket.on('actionRejected', (data: { reason: string }) => {
    if (data.reason === 'Game is not active') {
      // Game has ended — stop trying to act
      return;
    }
    console.error(`${TAG} ${playerId} action rejected: ${data.reason} — sending END_TURN to unblock`);
    socket.emit('action', { type: 'END_TURN' });
  });

  return socket;
}

/**
 * Trigger the AI to take its turn.
 * Decides the next action and emits it, with full debug logging.
 */
function triggerAITurn(socket: Socket, agent: Agent, view: any, expectedPlayerId: string) {
  if (view.currentPlayer !== expectedPlayerId) return;

  const prefix = `${TAG} ${expectedPlayerId} turn ${view.turn}`;

  // Log current unit status
  const activeUnits = (view.myUnits as any[]).filter(
    (u: any) => !u.sleeping && u.movesLeft > 0 && u.carriedBy === null,
  );
  for (const u of activeUnits) {
    const stats = UNIT_STATS[u.type as keyof typeof UNIT_STATS];
    console.log(
      `${prefix} | Unit ${u.type} (${u.id}) at (${u.x},${u.y}) — moves ${u.movesLeft}/${stats.movesPerTurn}`,
    );
  }

  const sleepingUnits = (view.myUnits as any[]).filter(
    (u: any) => u.sleeping && u.movesLeft > 0 && u.carriedBy === null,
  );
  for (const u of sleepingUnits) {
    console.log(`${prefix} | Unit ${u.type} (${u.id}) at (${u.x},${u.y}) — sleeping, will wake`);
  }

  // Log city production status
  for (const city of view.myCities as any[]) {
    if (city.producing) {
      console.log(
        `${prefix} | City (${city.x},${city.y}) producing ${city.producing} (${city.productionTurnsLeft} turns left)`,
      );
    } else {
      console.log(`${prefix} | City (${city.x},${city.y}) — idle, will assign production`);
    }
  }

  // Let the AI decide and log the chosen action
  const action: AgentAction = agent.act({
    tiles: view.tiles,
    myUnits: view.myUnits,
    myCities: view.myCities,
    visibleEnemyUnits: view.visibleEnemyUnits,
    visibleEnemyCities: view.visibleEnemyCities,
    turn: view.turn,
    myPlayerId: expectedPlayerId as any,
    myBomberBlastRadius: view.myBomberBlastRadius,
  });

  logAction(prefix, action, view);
  socket.emit('action', action);
}

/** Pretty-print the action the AI chose. */
function logAction(prefix: string, action: AgentAction, view: any) {
  switch (action.type) {
    case 'MOVE': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      const from = unit ? `(${unit.x},${unit.y})` : '(??)';
      console.log(`${prefix} | → MOVE ${unit?.type ?? action.unitId} from ${from} to (${action.to.x},${action.to.y})`);
      break;
    }
    case 'SKIP': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      console.log(`${prefix} | → SKIP ${unit?.type ?? action.unitId} (stuck — no valid moves)`);
      break;
    }
    case 'SLEEP': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      console.log(`${prefix} | → SLEEP ${unit?.type ?? action.unitId}`);
      break;
    }
    case 'WAKE': {
      const unit = (view.myUnits as any[]).find((u: any) => u.id === action.unitId);
      console.log(`${prefix} | → WAKE ${unit?.type ?? action.unitId}`);
      break;
    }
    case 'SET_PRODUCTION': {
      const city = (view.myCities as any[]).find((c: any) => c.id === action.cityId);
      const was = city?.producing ?? 'idle';
      const now = action.unitType;
      const change = was === now ? `stays ${now}` : `${was} → ${now}`;
      console.log(`${prefix} | → SET_PRODUCTION city (${city?.x ?? '?'},${city?.y ?? '?'}): ${change}`);
      break;
    }
    case 'LOAD':
      console.log(`${prefix} | → LOAD unit ${action.unitId} onto transport ${action.transportId}`);
      break;
    case 'UNLOAD':
      console.log(`${prefix} | → UNLOAD unit ${action.unitId} to (${action.to.x},${action.to.y})`);
      break;
    case 'END_TURN':
      console.log(`${prefix} | → END_TURN`);
      break;
    default:
      console.log(`${prefix} | → ${JSON.stringify(action)}`);
  }
}
