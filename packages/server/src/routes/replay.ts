import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default: packages/trainer/replays relative to server dist/routes/
const DEFAULT_REPLAY_DIR = path.resolve(__dirname, '..', '..', '..', 'trainer', 'replays');
const REPLAY_DIR = process.env.REPLAY_DIR ?? DEFAULT_REPLAY_DIR;

export function createReplayRoutes(): Router {
  const router = Router();

  /** List available replays (returns meta objects, newest first) */
  router.get('/replays', (_req, res) => {
    try {
      if (!fs.existsSync(REPLAY_DIR)) {
        res.json({ replays: [] });
        return;
      }
      const files = fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.json'));
      const metas = [];
      for (const f of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, f), 'utf-8'));
          if (raw.meta) metas.push(raw.meta);
        } catch { /* skip corrupt files */ }
      }
      metas.sort((a: { recordedAt: string }, b: { recordedAt: string }) =>
        b.recordedAt.localeCompare(a.recordedAt));
      res.json({ replays: metas });
    } catch {
      res.status(500).json({ error: 'Failed to list replays' });
    }
  });

  /** Serve a specific replay file by UUID */
  router.get('/replays/:id', (req, res) => {
    const id = req.params.id;
    // Allow UUID format only
    if (!/^[\w-]{8,64}$/.test(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const filepath = path.join(REPLAY_DIR, `${id}.json`);
    if (!fs.existsSync(filepath)) {
      res.status(404).json({ error: 'Replay not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    fs.createReadStream(filepath).pipe(res);
  });

  return router;
}
