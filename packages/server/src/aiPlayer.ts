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
  const socketPath = `${process.env.SERVER_URL || 'http://localhost:4000'}/socket.io/`;

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

  // Connect the socket
  const socket = io(socketPath, {
    auth: { token },
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    console.log(`[AI Player] ${playerId} connected as ${aiName}`);
  });

  socket.on('gameStart', (view: any) => {
    console.log(`[AI Player] ${playerId} starting game`);
    triggerAITurn(socket, agent, view, playerId);
  });

  socket.on('stateUpdate', (view: any) => {
    console.log(`[AI Player] ${playerId} state update, turn ${view.turn}`);
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

  if (currentPlayer !== expectedPlayerId) {
    console.log(`[AI Player] ${expectedPlayerId}: not my turn (current: ${currentPlayer})`);
    return;
  }

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

  console.log(`[AI Player] ${expectedPlayerId} playing: ${action.type}`);
  socket.emit('action', action);
}
