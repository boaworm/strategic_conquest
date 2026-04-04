import { Router } from 'express';
import type { GameManager } from '../gameManager.js';
import type { AIDifficulty } from '@sc/shared';
import { NNModelRegistry } from '../nnModelRegistry.js';

// Model registry - scans ./checkpoints for ONNX files
export const modelRegistry = new NNModelRegistry('./checkpoints');

export function createGameRoutes(manager: GameManager): Router {
  const router = Router();

  /**
   * GET /api/nn-models
   * List available NN models for selection
   */
  router.get('/nn-models', (_req, res) => {
    res.json(modelRegistry.getModels());
  });

  /**
   * POST /api/games
   * Create a new game. Returns gameId + all three tokens.
   */
  router.post('/games', async (req, res) => {
    const { mapWidth, mapHeight, mode, difficulty, p1Type, p2Type, p1AI, p2AI, p1ModelId, p2ModelId } = req.body ?? {};
    const isPvE = mode === 'pve';
    const isAiVsAi = mode === 'ai_vs_ai';
    const diff: AIDifficulty = (isPvE || isAiVsAi) ? (difficulty ?? 'medium') : 'medium';

    const session = await manager.createGame(
      mapWidth ?? 60,
      mapHeight ?? 40,
      isPvE,
      diff,
      p1Type ?? 'human',
      p2Type ?? 'human',
      p1AI ?? 'basic',
      p2AI ?? 'basic',
      p1ModelId,
      p2ModelId,
    );

    const response = {
      gameId: session.id,
      adminToken: session.tokens.adminToken,
      p1Token: session.tokens.p1Token,
      p2Token: session.tokens.p2Token,
      mode: session.isAiVsAi ? 'ai_vs_ai' : session.isPvE ? 'pve' : 'pvp',
      p1Type: session.playerTypes.get('player1') ?? 'human',
      p2Type: session.playerTypes.get('player2') ?? 'human',
      difficulty: session.difficulty,
    };

    res.status(201).json(response);
  });

  /**
   * GET /api/games
   * List all active games (public info only).
   */
  router.get('/games', (_req, res) => {
    res.json(manager.listGames());
  });

  /**
   * DELETE /api/games/:id
   * Delete a game (requires admin token in Authorization header).
   */
  router.delete('/games/:id', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Missing authorization token' });
      return;
    }

    const auth = manager.authenticate(token);
    if (!auth || auth.session.id !== req.params.id || auth.role !== 'admin') {
      res.status(403).json({ error: 'Invalid or unauthorized token' });
      return;
    }

    manager.deleteGame(req.params.id);
    res.status(204).end();
  });

  /**
   * POST /api/games/:id/force-end-turn
   * Force end the current player's turn (for debugging/fixing stuck turns).
   * No authentication required - for testing only.
   */
  router.post('/games/:id/force-end-turn', (req, res) => {
    const session = manager.getGame(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    try {
      const result = manager.forceEndTurn(session);
      res.json({
        success: true,
        ...result,
      });
    } catch (err) {
      console.error('Error forcing end of turn:', err);
      res.status(500).json({ error: 'Failed to end turn' });
    }
  });

  return router;
}
