import {
  Terrain,
  City,
  Unit,
  UnitType,
  GameState,
  GamePhase,
  type PlayerId,
  type Coord,
  wrapX,
  wrappedDistX,
} from '../types.js';

/**
 * Simple seeded PRNG (mulberry32) for reproducible maps.
 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

export function resetIdCounter(): void {
  nextId = 1;
}

export interface MapOptions {
  width: number;
  height: number;
  seed?: number;
  landRatio?: number;    // 0-1, default 0.35
  cityCount?: number;    // total neutral cities, default ~15
}

/**
 * Generate a map using a simple blob-based land generator.
 * Places starting cities for both players on opposite sides.
 *
 * `height` is the number of *playable* rows. Two extra rows are added
 * automatically for the north and south ice caps, so the actual tile
 * grid is height + 2 rows tall.
 */
export function generateMap(opts: MapOptions): {
  tiles: Terrain[][];
  cities: City[];
  units: Unit[];
  totalHeight: number;
} {
  const {
    width,
    height,
    seed = Date.now(),
    landRatio = 0.35,
    cityCount = 15,
  } = opts;

  // Add 2 rows for ice caps (north pole at y=0, south pole at y=totalHeight-1)
  const totalHeight = height + 2;

  const rng = mulberry32(seed);

  // Init all ocean (totalHeight rows)
  const tiles: Terrain[][] = Array.from({ length: totalHeight }, () =>
    Array.from({ length: width }, () => Terrain.Ocean),
  );

  // Generate land blobs (only in the playable area, rows 1..totalHeight-2)
  const targetLand = Math.floor(width * height * landRatio);
  let landCount = 0;

  // Seed several land blobs within the playable area
  const blobCount = 6 + Math.floor(rng() * 6);
  const blobCenters: Coord[] = [];

  for (let i = 0; i < blobCount; i++) {
    const cx = Math.floor(rng() * width);
    // Keep blobs in the playable area (rows 1..totalHeight-2)
    const cy = 1 + Math.floor(rng() * height);
    blobCenters.push({ x: cx, y: cy });
  }

  // Grow land from blob centers (clamped to playable area)
  while (landCount < targetLand) {
    for (const center of blobCenters) {
      if (landCount >= targetLand) break;

      // Random walk from center
      let x = center.x;
      let y = center.y;
      const steps = 10 + Math.floor(rng() * 30);

      for (let s = 0; s < steps && landCount < targetLand; s++) {
        // Wrap X for cylindrical map
        x = wrapX(x, width);
        // Stay inside playable rows (1..totalHeight-2)
        if (x >= 0 && x < width && y >= 1 && y <= totalHeight - 2) {
          if (tiles[y][x] === Terrain.Ocean) {
            tiles[y][x] = Terrain.Land;
            landCount++;
          }
        }
        // Random direction
        const dir = Math.floor(rng() * 4);
        if (dir === 0) x++;
        else if (dir === 1) x--;
        else if (dir === 2) y++;
        else y--;
      }
    }
  }

  // Find all islands and filter out single-tile islands
  const islandTiles = findIslandTiles(tiles, width, totalHeight);
  // Remove single-tile islands by turning them back to ocean
  for (const island of islandTiles) {
    if (island.length === 1) {
      const t = island[0];
      tiles[t.y][t.x] = Terrain.Ocean;
    }
  }

  // Collect all land tiles (excluding ice cap border rows and single-tile islands)
  const landTiles: Coord[] = [];
  for (let y = 1; y <= totalHeight - 2; y++) {
    for (let x = 0; x < width; x++) {
      if (tiles[y][x] === Terrain.Land) {
        landTiles.push({ x, y });
      }
    }
  }

  // Shuffle land tiles
  for (let i = landTiles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [landTiles[i], landTiles[j]] = [landTiles[j], landTiles[i]];
  }

  const cities: City[] = [];
  const usedPositions = new Set<string>();

  function posKey(c: Coord): string {
    return `${c.x},${c.y}`;
  }

  // Player 1 start: random land tile (already shuffled)
  const p1Start = landTiles[0];

  // Player 2 start: maximize distance from Player 1 (cylindrical wrapping distances)
  let p2Start = landTiles[landTiles.length - 1];
  let maxDist = -1;
  for (let i = 1; i < landTiles.length; i++) {
    const cand = landTiles[i];
    const dist = wrappedDistX(p1Start.x, cand.x, width) + Math.abs(p1Start.y - cand.y);
    if (dist > maxDist) {
      maxDist = dist;
      p2Start = cand;
    }
  }

  // Player starting cities
  cities.push({
    id: genId('city'),
    x: p1Start.x,
    y: p1Start.y,
    owner: 'player1',
    producing: UnitType.Army,
    productionTurnsLeft: 3,
    productionProgress: 0,
  });
  usedPositions.add(posKey(p1Start));

  cities.push({
    id: genId('city'),
    x: p2Start.x,
    y: p2Start.y,
    owner: 'player2',
    producing: UnitType.Army,
    productionTurnsLeft: 3,
    productionProgress: 0,
  });
  usedPositions.add(posKey(p2Start));

  // Neutral cities: spread across the map
  let placed = 0;
  for (const tile of landTiles) {
    if (placed >= cityCount) break;
    const key = posKey(tile);
    if (usedPositions.has(key)) continue;

    // Check if adjacent to any existing city (Chebyshev distance <= 1)
    const tooClose = cities.some(
      (c) => {
        const dx = wrappedDistX(c.x, tile.x, width);
        const dy = Math.abs(c.y - tile.y);
        return dx <= 1 && dy <= 1;
      },
    );
    if (tooClose) continue;

    cities.push({
      id: genId('city'),
      x: tile.x,
      y: tile.y,
      owner: null,
      producing: null,
      productionTurnsLeft: 0,
      productionProgress: 0,
    });
    usedPositions.add(key);
    placed++;
  }

  // Starting units: one army per player at their city
  const units: Unit[] = [
    {
      id: genId('unit'),
      type: UnitType.Army,
      owner: 'player1' as PlayerId,
      x: p1Start.x,
      y: p1Start.y,
      health: 1,
      movesLeft: 1,
      sleeping: false,
      hasAttacked: false,
      cargo: [],
      carriedBy: null,
    },
    {
      id: genId('unit'),
      type: UnitType.Army,
      owner: 'player2' as PlayerId,
      x: p2Start.x,
      y: p2Start.y,
      health: 1,
      movesLeft: 1,
      sleeping: false,
      hasAttacked: false,
      cargo: [],
      carriedBy: null,
    },
  ];

  return { tiles, cities, units, totalHeight };
}

/**
 * Find all connected land tiles (islands) using flood fill.
 * Returns an array of islands, where each island is an array of coordinates.
 */
function findIslandTiles(tiles: Terrain[][], width: number, height: number): Coord[][] {
  const visited: boolean[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => false),
  );
  const islands: Coord[][] = [];

  // Directions for 8-connectivity (including diagonals)
  const dirs = [
    { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
    { x: -1, y: 0 },                 { x: 1, y: 0 },
    { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (tiles[y][x] === Terrain.Land && !visited[y][x]) {
        const island: Coord[] = [];
        const stack: Coord[] = [{ x, y }];
        visited[y][x] = true;

        while (stack.length > 0) {
          const curr = stack.pop()!;
          island.push(curr);

          // Check all 8 directions for connected land
          for (const d of dirs) {
            const nx = wrapX(curr.x + d.x, width);
            const ny = curr.y + d.y;

            if (ny >= 0 && ny < height && !visited[ny][nx] && tiles[ny][nx] === Terrain.Land) {
              visited[ny][nx] = true;
              stack.push({ x: nx, y: ny });
            }
          }
        }

        islands.push(island);
      }
    }
  }

  return islands;
}

/**
 * Create a full initial GameState from map options.
 */
export function createGameState(opts: MapOptions): GameState {
  resetIdCounter();
  const { tiles, cities, units, totalHeight } = generateMap(opts);
  return {
    mapWidth: opts.width,
    // mapHeight reflects the full tile grid including the two ice cap rows
    mapHeight: totalHeight,
    tiles,
    cities,
    units,
    currentPlayer: 'player1',
    turn: 1,
    phase: GamePhase.Active,
    winner: null,
    explored: {
      player1: new Set<string>(),
      player2: new Set<string>(),
    },
    bombersProduced: {
      player1: 0,
      player2: 0,
    },
    seenEnemies: {
      player1: [],
      player2: [],
    },
  };
}
