import { Router } from 'express';
import type { GameManager } from '../gameManager.js';
import type { AIDifficulty, GameAction } from '@sc/shared';
import { GameState, GamePhase } from '@sc/shared';

/**
 * Training API for AI agents
 *
 * This API allows AI agents to:
 * - Create training games
 * - Observe game state
 * - Make moves
 * - Get rewards/feedback
 */

export interface TrainingGameConfig {
  mapWidth?: number;
  mapHeight?: number;
  difficulty?: AIDifficulty;
  maxTurns?: number;
}

export interface TrainingGameInfo {
  gameId: string;
  playerToken: string;
  mapWidth: number;
  mapHeight: number;
  difficulty: AIDifficulty;
}

export interface AgentObservation {
  tiles: any[][];
  myUnits: any[];
  myCities: any[];
  visibleEnemyUnits: any[];
  visibleEnemyCities: any[];
  turn: number;
  myPlayerId: string;
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

export interface GameResult {
  winner: string | null;
  turns: number;
  reward: number;
}

export function createTrainingRoutes(manager: GameManager): Router {
  const router = Router();

  // ── Game Creation ────────────────────────────────────────────

  /**
   * POST /api/training/games
   * Create a new training game for an AI agent.
   * Returns a token that the agent can use to connect via WebSocket or HTTP.
   */
  router.post('/training/games', async (req, res) => {
    const { mapWidth, mapHeight, difficulty = 'medium' } = req.body ?? {};
    const session = await manager.createGame(
      mapWidth ?? 30,
      mapHeight ?? 20,
      true, // isPvE
      difficulty as AIDifficulty,
    );

    const gameInfo: TrainingGameInfo = {
      gameId: session.id,
      playerToken: session.tokens.p2Token, // Agent will play as player2
      mapWidth: session.state.mapWidth,
      mapHeight: session.state.mapHeight,
      difficulty: session.difficulty ?? 'medium',
    };

    res.status(201).json(gameInfo);
  });

  /**
   * GET /api/training/games/:gameId/state
   * Get the current state of a training game from the agent's perspective.
   */
  router.get('/training/games/:gameId/state', (req, res) => {
    const session = manager.getGame(req.params.gameId);
    if (!session) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    // For now, return full state (agent can filter what it needs)
    // In the future, we could have different observation levels
    const state = session.state;

    res.json({
      tiles: state.tiles,
      units: state.units,
      cities: state.cities,
      currentPlayer: state.currentPlayer,
      turn: state.turn,
      phase: state.phase,
      mapWidth: state.mapWidth,
      mapHeight: state.mapHeight,
    });
  });

  /**
   * POST /api/training/games/:gameId/action
   * Submit an action for the AI agent.
   * The agent should be the current player.
   */
  router.post('/training/games/:gameId/action', (req, res) => {
    const session = manager.getGame(req.params.gameId);
    if (!session) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    if (session.state.phase !== 'active') {
      res.status(400).json({ error: 'Game is not active' });
      return;
    }

    // Agent plays as player2
    const playerId = 'player2' as const;
    const action = req.body as GameAction;

    const result = manager.processAction(session, playerId, action);

    res.json(result);
  });

  /**
   * POST /api/training/games/:gameId/step
   * Submit an action and get the new state and reward in one call.
   * This is the main API for reinforcement learning.
   */
  router.post('/training/games/:gameId/step', (req, res) => {
    const sessionRaw = manager.getGame(req.params.gameId);
    if (!sessionRaw) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    const session = sessionRaw; // Type assertion

    if (session.state.phase !== GamePhase.Active) {
      res.status(400).json({ error: 'Game is not active' });
      return;
    }

    const playerId = 'player2' as const;
    const action = req.body as GameAction;

    // Get state before action for comparison
    const stateBefore = session.state;

    const result = manager.processAction(session, playerId, action);

    if (!result.success) {
      // Negative reward for invalid action
      res.json({
        success: false,
        error: result.error,
        reward: -1,
        done: false,
      });
      return;
    }

    // Calculate reward based on game state changes
    const reward = calculateReward(stateBefore, session.state, playerId);

    // Check if game is over
    const done = session.state.phase === (GamePhase as any).Finished;

    res.json({
      success: true,
      reward,
      done,
      turn: session.state.turn,
      currentPlayer: session.state.currentPlayer,
      winner: session.state.winner,
    });
  });

  /**
   * DELETE /api/training/games/:gameId
   * Delete a training game (frees up resources).
   */
  router.delete('/training/games/:gameId', (req, res) => {
    if (manager.deleteGame(req.params.gameId)) {
      res.status(204).end();
    } else {
      res.status(404).json({ error: 'Game not found' });
    }
  });

  /**
   * Helper function to calculate reward for RL
   * Based on: city count, unit count, combat results
   */
  function calculateReward(
    stateBefore: GameState,
    stateAfter: GameState,
    playerId: string,
  ): number {
    let reward = 0;

    // City differential
    const citiesBefore = stateBefore.cities.filter(
      (c) => c.owner === playerId,
    ).length;
    const citiesAfter = stateAfter.cities.filter(
      (c) => c.owner === playerId,
    ).length;
    reward += (citiesAfter - citiesBefore) * 10; // +10 for each new city

    // Unit differential (but penalize excessive growth to encourage efficiency)
    const unitsBefore = stateBefore.units.filter(
      (u) => u.owner === playerId,
    ).length;
    const unitsAfter = stateAfter.units.filter(
      (u) => u.owner === playerId,
    ).length;
    const unitChange = unitsAfter - unitsBefore;
    reward += unitChange * 2; // +2 for each new unit

    // Combat rewards
    // If enemy units were destroyed (need to track this properly)
    // For now, small positive reward for each enemy unit destroyed

    // Time penalty (encourage winning quickly)
    reward -= 0.1; // Small penalty per turn

    return reward;
  }

  return router;
}
