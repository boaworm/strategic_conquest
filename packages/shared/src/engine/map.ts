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
 *
 * Guarantees:
 * - At least 3 islands (MIN_ISLANDS)
 * - Each island has at least 3 cities (MIN_ISLAND_CITIES)
 * - Cities on the same island are at least 4 tiles apart (Chebyshev, MIN_CITY_DIST)
 * - Cities on different islands have no minimum distance requirement
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

  const MIN_CITY_DIST = 4;       // Minimum Chebyshev distance between cities on the same island
  const MIN_ISLAND_CITIES = 3;   // Each island must have at least this many cities
  const MIN_ISLANDS = 3;         // Minimum number of islands
  const MIN_ISLAND_SIZE = 20;    // Islands smaller than this are removed (too small for 3 cities)

  type CityConfig = { x: number; y: number; owner: PlayerId | null };

  // Retry with shifted seeds until constraints are satisfied
  for (let attempt = 0; attempt < 200; attempt++) {
    const rng = mulberry32(seed + attempt * 7919);

    // Init all ocean (totalHeight rows)
    const tiles: Terrain[][] = Array.from({ length: totalHeight }, () =>
      Array.from({ length: width }, () => Terrain.Ocean),
    );

    // Generate land blobs (only in the playable area, rows 1..totalHeight-2)
    const targetLand = Math.floor(width * height * landRatio);
    let landCount = 0;

    const blobCount = 6 + Math.floor(rng() * 6);
    const blobCenters: Coord[] = [];

    for (let i = 0; i < blobCount; i++) {
      const cx = Math.floor(rng() * width);
      const cy = 1 + Math.floor(rng() * height);
      blobCenters.push({ x: cx, y: cy });
    }

    while (landCount < targetLand) {
      for (const center of blobCenters) {
        if (landCount >= targetLand) break;

        let x = center.x;
        let y = center.y;
        const steps = 10 + Math.floor(rng() * 30);

        for (let s = 0; s < steps && landCount < targetLand; s++) {
          x = wrapX(x, width);
          if (x >= 0 && x < width && y >= 1 && y <= totalHeight - 2) {
            if (tiles[y][x] === Terrain.Ocean) {
              tiles[y][x] = Terrain.Land;
              landCount++;
            }
          }
          const dir = Math.floor(rng() * 4);
          if (dir === 0) x++;
          else if (dir === 1) x--;
          else if (dir === 2) y++;
          else y--;
        }
      }
    }

    // Find all islands and remove those too small to support MIN_ISLAND_CITIES cities.
    // This also removes single-tile islands.
    const allIslands = findIslandTiles(tiles, width, totalHeight);
    for (const island of allIslands) {
      if (island.length < MIN_ISLAND_SIZE) {
        for (const t of island) tiles[t.y][t.x] = Terrain.Ocean;
      }
    }

    const validIslands = allIslands.filter(island => island.length >= MIN_ISLAND_SIZE);
    if (validIslands.length < MIN_ISLANDS) continue;

    // Build tile -> island index lookup
    const tileIslandMap = new Map<string, number>();
    for (let i = 0; i < validIslands.length; i++) {
      for (const tile of validIslands[i]) {
        tileIslandMap.set(`${tile.x},${tile.y}`, i);
      }
    }

    const posKey = (c: { x: number; y: number }) => `${c.x},${c.y}`;
    const getIslandIdx = (x: number, y: number) => tileIslandMap.get(`${x},${y}`);

    const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.max(wrappedDistX(a.x, b.x, width), Math.abs(a.y - b.y));

    // Cities on the same island must be at least MIN_CITY_DIST apart.
    // Cities on different islands have no minimum distance constraint.
    const isTooClose = (pos: { x: number; y: number }, existingCities: CityConfig[]) => {
      const posIsland = getIslandIdx(pos.x, pos.y);
      if (posIsland === undefined) return false;
      return existingCities.some(c => {
        const cityIsland = getIslandIdx(c.x, c.y);
        if (cityIsland !== posIsland) return false;
        return chebyshev(pos, c) < MIN_CITY_DIST;
      });
    };

    // Shuffle tiles within each island independently
    const shuffledIslandTiles: Coord[][] = validIslands.map(island => {
      const shuffled = [...island];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    });

    const cityConfigs: CityConfig[] = [];
    const usedPositions = new Set<string>();

    // Place Player 1 on island 0
    let p1Start: Coord | null = null;
    for (const tile of shuffledIslandTiles[0]) {
      if (!isTooClose(tile, cityConfigs)) {
        p1Start = tile;
        break;
      }
    }
    if (!p1Start) continue;
    cityConfigs.push({ x: p1Start.x, y: p1Start.y, owner: 'player1' });
    usedPositions.add(posKey(p1Start));

    // Place Player 2 on a different island, maximizing distance from Player 1
    let p2Start: Coord | null = null;
    let maxDist = -1;
    for (let i = 1; i < validIslands.length; i++) {
      for (const tile of shuffledIslandTiles[i]) {
        if (isTooClose(tile, cityConfigs)) continue;
        const dist = wrappedDistX(p1Start.x, tile.x, width) + Math.abs(p1Start.y - tile.y);
        if (dist > maxDist) {
          maxDist = dist;
          p2Start = tile;
        }
      }
    }
    if (!p2Start) continue;
    cityConfigs.push({ x: p2Start.x, y: p2Start.y, owner: 'player2' });
    usedPositions.add(posKey(p2Start));

    // Ensure each island has at least MIN_ISLAND_CITIES cities total
    let valid = true;
    for (let i = 0; i < validIslands.length; i++) {
      const existing = cityConfigs.filter(c => getIslandIdx(c.x, c.y) === i);
      let needed = MIN_ISLAND_CITIES - existing.length;

      for (const tile of shuffledIslandTiles[i]) {
        if (needed <= 0) break;
        if (usedPositions.has(posKey(tile))) continue;
        if (isTooClose(tile, cityConfigs)) continue;
        cityConfigs.push({ x: tile.x, y: tile.y, owner: null });
        usedPositions.add(posKey(tile));
        needed--;
      }

      if (needed > 0) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    // Place remaining neutral cities up to cityCount, spread across all islands
    const allTiles = shuffledIslandTiles.flat();
    for (let i = allTiles.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [allTiles[i], allTiles[j]] = [allTiles[j], allTiles[i]];
    }

    const neutralPlaced = cityConfigs.filter(c => c.owner === null).length;
    let placed = neutralPlaced;
    for (const tile of allTiles) {
      if (placed >= cityCount) break;
      if (usedPositions.has(posKey(tile))) continue;
      if (isTooClose(tile, cityConfigs)) continue;
      cityConfigs.push({ x: tile.x, y: tile.y, owner: null });
      usedPositions.add(posKey(tile));
      placed++;
    }

    // Build final City objects with IDs (only called on success)
    const cities: City[] = cityConfigs.map(cfg => ({
      id: genId('city'),
      x: cfg.x,
      y: cfg.y,
      owner: cfg.owner,
      producing: cfg.owner ? UnitType.Army : null,
      productionTurnsLeft: cfg.owner ? 3 : 0,
      productionProgress: 0,
    }));

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

  throw new Error('Failed to generate a valid map after 200 attempts');
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
