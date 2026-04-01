import { performance } from 'node:perf_hooks';
import {
  type Agent,
  type AgentObservation,
  type GameState,
  type PlayerId,
  type GameAction,
  createGameState,
  applyAction,
  getPlayerView,
  GamePhase,
} from '@sc/shared';

export interface RunGameOptions {
  mapWidth?: number;
  mapHeight?: number;
  mapSeed?: number;
  maxTurns?: number;
  profilePhases?: {
    init: number;
    turnLoop: number;
    getPlayerView: number;
    applyAction: number;
    agentAct: number;
  };
}

export interface GameResult {
  winner: PlayerId | null;
  turns: number;
  p1Outcome: {
    won: boolean;
    lost: boolean;
    draw: boolean;
    turnsTaken: number;
    maxTurns: number;
    finalCityRatio: number;
    finalUnitRatio: number;
  };
  p2Outcome: {
    won: boolean;
    lost: boolean;
    draw: boolean;
    turnsTaken: number;
    maxTurns: number;
    finalCityRatio: number;
    finalUnitRatio: number;
  };
}

const MAX_ACTIONS_PER_TURN = 500; // safety limit to prevent infinite loops

/**
 * Run a complete headless game between two agents.
 * Returns outcome data for both players.
 */
export function runGame(
  agent1: Agent,
  agent2: Agent,
  opts: RunGameOptions = {},
): GameResult {
  const {
    mapWidth = 30,
    mapHeight = 20,
    mapSeed,
    maxTurns = 200,
    profilePhases,
  } = opts;

  const t0 = performance.now();
  const state = createGameState({
    width: mapWidth,
    height: mapHeight,
    seed: mapSeed ?? Date.now(),
    landRatio: 0.35,
    cityCount: 10,
  });
  if (profilePhases) profilePhases.init += performance.now() - t0;

  // Init agents
  agent1.init({ playerId: 'player1', mapWidth, mapHeight });
  agent2.init({ playerId: 'player2', mapWidth, mapHeight });

  const agents: Record<PlayerId, Agent> = {
    player1: agent1,
    player2: agent2,
  };

  // Main game loop
  while (state.phase === GamePhase.Active && state.turn <= maxTurns) {
    const loopStart = performance.now();
    const currentPlayer = state.currentPlayer;
    const agent = agents[currentPlayer];

    // Build observation from fog-of-war view
    const tView1 = performance.now();
    const view = getPlayerView(state, currentPlayer);
    if (profilePhases) profilePhases.getPlayerView += performance.now() - tView1;

    const obs: AgentObservation = {
      tiles: view.tiles,
      myUnits: view.myUnits,
      myCities: view.myCities,
      visibleEnemyUnits: view.visibleEnemyUnits,
      visibleEnemyCities: view.visibleEnemyCities,
      turn: view.turn,
      myPlayerId: currentPlayer,
      myBomberBlastRadius: view.myBomberBlastRadius,
    };

    // Let agent take actions until it ends its turn
    let actionCount = 0;
    while (actionCount < MAX_ACTIONS_PER_TURN) {
      const tAct = performance.now();
      const action = agent.act(obs);
      if (profilePhases) profilePhases.agentAct += performance.now() - tAct;
      actionCount++;

      if (action.type === 'END_TURN') {
        const tApply = performance.now();
        applyAction(state, { type: 'END_TURN' }, currentPlayer);
        if (profilePhases) profilePhases.applyAction += performance.now() - tApply;
        break;
      }

      // Apply action to state
      const tApply2 = performance.now();
      const result = applyAction(state, action as GameAction, currentPlayer);
      if (profilePhases) profilePhases.applyAction += performance.now() - tApply2;

      if (!result.success) {
        // Agent made invalid move — skip it, try again
        // After too many failures, force end turn
        if (actionCount >= MAX_ACTIONS_PER_TURN) {
          applyAction(state, { type: 'END_TURN' }, currentPlayer);
          break;
        }
        continue;
      }

      // Refresh observation after successful action
      const tView2 = performance.now();
      const updatedView = getPlayerView(state, currentPlayer);
      if (profilePhases) profilePhases.getPlayerView += performance.now() - tView2;
      obs.tiles = updatedView.tiles;
      obs.myUnits = updatedView.myUnits;
      obs.myCities = updatedView.myCities;
      obs.visibleEnemyUnits = updatedView.visibleEnemyUnits;
      obs.visibleEnemyCities = updatedView.visibleEnemyCities;
      obs.turn = updatedView.turn;

      // Check if game ended mid-turn (e.g. last enemy destroyed)
      if (state.phase !== GamePhase.Active) break;
    }

    if (profilePhases) profilePhases.turnLoop += performance.now() - loopStart;
    if (state.phase !== GamePhase.Active) break;
  }

  // Compute outcomes
  const totalCities = state.cities.length;
  const p1Cities = state.cities.filter((c) => c.owner === 'player1').length;
  const p2Cities = state.cities.filter((c) => c.owner === 'player2').length;

  const totalUnits = state.units.length;
  const p1Units = state.units.filter((u) => u.owner === 'player1').length;
  const p2Units = state.units.filter((u) => u.owner === 'player2').length;

  const isDraw = state.winner === null;

  return {
    winner: state.winner,
    turns: state.turn,
    p1Outcome: {
      won: state.winner === 'player1',
      lost: state.winner === 'player2',
      draw: isDraw,
      turnsTaken: state.turn,
      maxTurns,
      finalCityRatio: totalCities > 0 ? p1Cities / totalCities : 0,
      finalUnitRatio: totalUnits > 0 ? p1Units / totalUnits : 0,
    },
    p2Outcome: {
      won: state.winner === 'player2',
      lost: state.winner === 'player1',
      draw: isDraw,
      turnsTaken: state.turn,
      maxTurns,
      finalCityRatio: totalCities > 0 ? p2Cities / totalCities : 0,
      finalUnitRatio: totalUnits > 0 ? p2Units / totalUnits : 0,
    },
  };
}
