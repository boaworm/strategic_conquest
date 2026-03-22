import { io, type Socket } from 'socket.io-client';
import { AdamAI, BasicAgent } from '@sc/shared';
import type { Agent } from '@sc/shared';
import type { GameSession } from './gameManager.js';
import type { PlayerId } from '@sc/shared';

/**
 * Spawns an AI player that connects to the game via WebSocket
 * and automatically plays using the selected AI agent.
 */
export async function spawnAIPlayer(
  session: GameSession,
  playerId: PlayerId,
  aiName: 'adam' | 'basic',
): Promise<Socket> {
  const token = playerId === 'player1' ? session.tokens.p1Token : session.tokens.p2Token;
  const serverUrl = process.env.SERVER_URL || 'http://localhost:4000';
  // socket.io uses the default namespace "/" - the "/socket.io/" is just the transport path
  const socketPath = serverUrl;

  // Create the appropriate AI agent
  let agent: Agent;
  if (aiName === 'adam') {
    agent = new AdamAI();
  } else {
    agent = new BasicAgent();
  }
  agent.init({
    playerId,
    mapWidth: session.state.mapWidth,
    mapHeight: session.state.mapHeight,
  });

  // Connect the socket and wait for connection
  const socket = io(socketPath, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => {
      resolve();
    });
    socket.on('connect_error', (err) => {
      reject(err);
    });
    socket.on('error', (err) => {
      reject(err);
    });
  });

  socket.on('gameStart', (view: any) => {
    console.log(`[AI Player] ${playerId} received gameStart`);
    triggerAITurn(socket, agent, view, playerId);
  });

  socket.on('stateUpdate', (view: any) => {
    console.log(`[AI Player] ${playerId} received stateUpdate, turn=${view.turn}, currentPlayer=${view.currentPlayer}`);
    triggerAITurn(socket, agent, view, playerId);
  });

  return socket;
}

/**
 * Trigger the AI to take its turn
 */
function triggerAITurn(socket: Socket, agent: Agent, view: any, expectedPlayerId: string) {
  // Check if it's this player's turn
  const currentPlayer = view.currentPlayer;

  console.log(`[AI Player] ${expectedPlayerId} turn check: currentPlayer=${currentPlayer}, expected=${expectedPlayerId}`);

  if (currentPlayer !== expectedPlayerId) {
    console.log(`[AI Player] ${expectedPlayerId} - Not my turn, skipping`);
    return;
  }

  console.log(`[AI Player] ${expectedPlayerId} - My turn! Cities: ${view.myCities.length}, Units: ${view.myUnits.length}`);

  // Let the AI decide on an action
  const action = agent.act({
    tiles: view.tiles,
    myUnits: view.myUnits,
    myCities: view.myCities,
    visibleEnemyUnits: view.visibleEnemyUnits,
    visibleEnemyCities: view.visibleEnemyCities,
    turn: view.turn,
    myPlayerId: expectedPlayerId as any,
  });

  console.log(`[AI Player] ${expectedPlayerId} - Action: ${action.type}`);
  socket.emit('action', action);
}
