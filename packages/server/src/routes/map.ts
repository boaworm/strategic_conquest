import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Terrain } from '@sc/shared';

const MAPS_DIR = path.join(process.cwd(), 'maps');

// Ensure maps directory exists
export async function ensureMapsDir() {
  try {
    await fs.mkdir(MAPS_DIR, { recursive: true });
  } catch (err) {
    // Directory might already exist
  }
}

// Load a specific saved map by ID
export async function loadSavedMap(id: string): Promise<LoadedSavedMap | null> {
  try {
    const filePath = path.join(MAPS_DIR, `${id}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    const map = JSON.parse(content) as SavedMap;
    // Convert string tiles to Terrain enum
    const tiles = map.tiles.map(row =>
      row.map(t => t === 'land' ? Terrain.Land : Terrain.Ocean)
    );
    return { ...map, tiles };
  } catch (err) {
    return null;
  }
}

export interface SavedMap {
  id: string;
  name: string;
  width: number;
  height: number;
  tiles: ('land' | 'ocean')[][];
  cities: Array<{ x: number; y: number; name?: string; owner?: 'player1' | 'player2' }>;
  createdAt: number;
  updatedAt: number;
}

// Type for internal use when loading maps
export interface LoadedSavedMap {
  id: string;
  name: string;
  width: number;
  height: number;
  tiles: import('@sc/shared').Terrain[][];
  cities: Array<{ x: number; y: number; name?: string; owner?: 'player1' | 'player2' }>;
  createdAt: number;
  updatedAt: number;
}

export function createMapRoutes(): Router {
  const router = Router();

  /**
   * GET /api/maps
   * List all saved maps
   */
  router.get('/maps', async (_req, res) => {
    try {
      await ensureMapsDir();
      const files = await fs.readdir(MAPS_DIR);
      const maps: Array<{ id: string; name: string; width: number; height: number; createdAt: number; updatedAt: number }> = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(MAPS_DIR, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const map = JSON.parse(content) as SavedMap;
          maps.push({
            id: map.id,
            name: map.name,
            width: map.width,
            height: map.height,
            createdAt: map.createdAt,
            updatedAt: map.updatedAt,
          });
        }
      }

      // Sort by updated date (newest first)
      maps.sort((a, b) => b.updatedAt - a.updatedAt);
      res.json(maps);
    } catch (err) {
      console.error('Error listing maps:', err);
      res.status(500).json({ error: 'Failed to list maps' });
    }
  });

  /**
   * POST /api/maps
   * Save a new map
   */
  router.post('/maps', async (req, res) => {
    try {
      const { name, width, height, tiles, cities } = req.body;

      if (!name || !width || !height || !tiles || !cities) {
        res.status(400).json({ error: 'Missing required fields: name, width, height, tiles, cities' });
        return;
      }

      await ensureMapsDir();

      const id = crypto.randomUUID();
      const now = Date.now();

      const map: SavedMap = {
        id,
        name,
        width,
        height,
        tiles,
        cities,
        createdAt: now,
        updatedAt: now,
      };

      const filePath = path.join(MAPS_DIR, `${id}.json`);
      await fs.writeFile(filePath, JSON.stringify(map, null, 2));

      res.status(201).json({ id, name, width, height, createdAt: now, updatedAt: now });
    } catch (err) {
      console.error('Error saving map:', err);
      res.status(500).json({ error: 'Failed to save map' });
    }
  });

  /**
   * GET /api/maps/:id
   * Get a specific map
   */
  router.get('/maps/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const filePath = path.join(MAPS_DIR, `${id}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      const map = JSON.parse(content) as SavedMap;
      res.json(map);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Map not found' });
      } else {
        console.error('Error loading map:', err);
        res.status(500).json({ error: 'Failed to load map' });
      }
    }
  });

  /**
   * PUT /api/maps/:id
   * Update an existing map
   */
  router.put('/maps/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name, width, height, tiles, cities } = req.body;

      const filePath = path.join(MAPS_DIR, `${id}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      const existingMap = JSON.parse(content) as SavedMap;

      const updatedMap: SavedMap = {
        ...existingMap,
        name: name ?? existingMap.name,
        width: width ?? existingMap.width,
        height: height ?? existingMap.height,
        tiles: tiles ?? existingMap.tiles,
        cities: cities ?? existingMap.cities,
        updatedAt: Date.now(),
      };

      await fs.writeFile(filePath, JSON.stringify(updatedMap, null, 2));
      res.json({ id, name: updatedMap.name, width: updatedMap.width, height: updatedMap.height, updatedAt: updatedMap.updatedAt });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Map not found' });
      } else {
        console.error('Error updating map:', err);
        res.status(500).json({ error: 'Failed to update map' });
      }
    }
  });

  /**
   * DELETE /api/maps/:id
   * Delete a map
   */
  router.delete('/maps/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const filePath = path.join(MAPS_DIR, `${id}.json`);
      await fs.unlink(filePath);
      res.status(204).end();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Map not found' });
      } else {
        console.error('Error deleting map:', err);
        res.status(500).json({ error: 'Failed to delete map' });
      }
    }
  });

  return router;
}
