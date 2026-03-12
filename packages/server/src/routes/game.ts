import { Router } from 'express';
import type { GameManager } from '../gameManager.js';

export function createGameRoutes(manager: GameManager): Router {
  const router = Router();

  /**
   * POST /api/games
   * Create a new game. Returns gameId + all three tokens.
   */
  router.post('/games', (req, res) => {
    const { mapWidth, mapHeight } = req.body ?? {};
    const session = manager.createGame(
      mapWidth ?? 60,
      mapHeight ?? 40,
    );

    res.status(201).json({
      gameId: session.id,
      adminToken: session.tokens.adminToken,
      p1Token: session.tokens.p1Token,
      p2Token: session.tokens.p2Token,
    });
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

  return router;
}
