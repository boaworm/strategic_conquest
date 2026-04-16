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
import { generatePresetMap as genPresetMap } from './mapPresets.js';

export { generatePresetMap } from './mapPresets.js';

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
export function genId(prefix: string): string {
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
  preset?: 'world' | 'europe'; // fixed geography preset (ignores seed/landRatio/cityCount)
}

/**
 * Generate a map using island-first generation.
 *
 * Algorithm:
 * 1. Generate first island (2-5 cities, must have coastal city)
 * 2. Generate second island farthest from first (2-5 cities, must have coastal city)
 * 3. Repeat: find farthest ocean spot, grow 1-7 city island there
 * 4. Stop when no ocean spot is at least 5 tiles from any land
 *
 * `height` is the number of *playable* rows. Two extra rows are added
 * automatically for the ice caps, so the actual tile grid is height + 2 rows tall.
 */
export function generateMap(opts: MapOptions): {
  tiles: Terrain[][];
  cities: City[];
  units: Unit[];
  totalHeight: number;
} {
  if (opts.preset) {
    return genPresetMap(opts.preset, opts.width, opts.height, genId);
  }

  const {
    width,
    height,
    seed = Date.now(),
    landRatio = 0.35,
  } = opts;

  const totalHeight = height + 2;
  const mapArea = width * height;
  const minCityDist = 4;

  // Island tile counts (scale with map size)
  // For maps 50x20 and below: island can be up to 10% of map, capped at 100 tiles (for 7 cities)
  const maxIslandTiles = Math.min(Math.floor(mapArea * 0.08), 100);   // max island size (reduced to 8%)
  const minIslandTiles = Math.max(6, Math.floor(maxIslandTiles * 0.4));   // min ~40% of max
  const maxIslands = mapArea < 500 ? 5 : 5;         // 5 islands on small maps
  const minOceanDist = mapArea < 500 ? 4 : 8;  // Smaller spacing for small maps

  type Island = {
    tiles: Coord[];
    cities: CityConfig[];
    center: Coord;
  };
  type CityConfig = { x: number; y: number; owner: PlayerId | null };

  const rng = mulberry32(seed);

  // Helper: check if tile is coastal (adjacent to ocean)
  function isCoastal(x: number, y: number): boolean {
    const dirs = [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
    for (const d of dirs) {
      const nx = wrapX(x + d.dx, width);
      const ny = y + d.dy;
      if (ny >= 0 && ny < totalHeight && tiles[ny][nx] === Terrain.Ocean) {
        return true;
      }
    }
    return false;
  }

  // Start with all ocean
  const tiles: Terrain[][] = Array.from({ length: totalHeight }, () =>
    Array.from({ length: width }, () => Terrain.Ocean),
  );

  const islands: Island[] = [];
  const landSet = new Set<string>();

  // Helper: distance from a point to nearest land tile
  function distToNearestLand(x: number, y: number): number {
    if (landSet.has(`${x},${y}`)) return 0;
    let minDist = Infinity;
    for (const island of islands) {
      for (const tile of island.tiles) {
        const d = Math.max(wrappedDistX(x, tile.x, width), Math.abs(y - tile.y));
        if (d < minDist) minDist = d;
      }
    }
    return minDist;
  }

  // Helper: find ocean tile farthest from any land
  function findFarthestOceanPoint(): Coord | null {
    let best: Coord | null = null;
    let bestDist = -1;

    for (let y = 2; y < totalHeight - 2; y++) {
      for (let x = 0; x < width; x++) {
        if (landSet.has(`${x},${y}`)) continue;
        const d = distToNearestLand(x, y);
        if (d > bestDist) {
          bestDist = d;
          best = { x, y };
        }
      }
    }
    return best;
  }

  // Helper: check if tile is adjacent to existing land (including diagonals)
  function isAdjacentToLand(x: number, y: number): boolean {
    const dirs = [
      { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
      { dx: 1, dy: 1 }, { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }
    ];
    for (const d of dirs) {
      const nx = wrapX(x + d.dx, width);
      const ny = y + d.dy;
      if (ny >= 0 && ny < totalHeight && landSet.has(`${nx},${ny}`)) {
        return true;
      }
    }
    return false;
  }

  // Helper: grow an island from a starting point
  function growIsland(startX: number, startY: number, targetSize: number): Coord[] {
    const islandTiles: Coord[] = [{ x: startX, y: startY }];
    const islandSet = new Set<string>([`${startX},${startY}`]);

    let growAttempts = 0;
    while (islandTiles.length < targetSize && growAttempts < targetSize * 20) {
      growAttempts++;
      const edgeIdx = Math.floor(rng() * islandTiles.length);
      const center = islandTiles[edgeIdx];

      const dirIdx = Math.floor(rng() * 8);
      const dirs = [
        { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
        { dx: 1, dy: 1 }, { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 },
      ];
      const { dx, dy } = dirs[dirIdx];

      const nx = wrapX(center.x + dx, width);
      const ny = center.y + dy;

      if (ny < 2 || ny >= totalHeight - 2) continue;

      const key = `${nx},${ny}`;
      if (islandSet.has(key)) continue;
      if (landSet.has(key)) continue;  // Don't grow on existing land
      if (isAdjacentToLand(nx, ny)) continue;  // Don't connect to existing islands

      islandTiles.push({ x: nx, y: ny });
      islandSet.add(key);
    }

    return islandTiles;
  }

  // Helper: place cities on an island (returns array of city configs)
  function placeCitiesOnIsland(islandTiles: Coord[], minCities: number, maxCities: number, targetCityCount?: number): CityConfig[] {
    const cityConfigs: CityConfig[] = [];
    const dist = (a: Coord, b: Coord) => Math.max(wrappedDistX(a.x, b.x, width), Math.abs(a.y - b.y));

    // Shuffle tiles for randomness
    const shuffledTiles = [...islandTiles];
    for (let i = shuffledTiles.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffledTiles[i], shuffledTiles[j]] = [shuffledTiles[j], shuffledTiles[i]];
    }

    const target = targetCityCount ?? minCities + Math.floor(rng() * (maxCities - minCities + 1));
    const cap = Math.min(target, maxCities);

    // Place cities up to target count (hard-capped at maxCities)
    for (const tile of shuffledTiles) {
      if (cityConfigs.length >= cap) break;

      const tooClose = cityConfigs.some(c => dist(tile, c) < minCityDist);
      if (tooClose) continue;

      cityConfigs.push({ x: tile.x, y: tile.y, owner: null });
    }

    return cityConfigs;
  }

  // Helper: check if island has at least one coastal city
  function hasCoastalCity(island: Island, cityConfigs: CityConfig[]): boolean {
    return cityConfigs.some(c => isCoastal(c.x, c.y));
  }

  // Step 1: Generate first island (2-5 cities, must have coastal city)
  let firstIsland: Island | null = null;
  for (let attempt = 0; attempt < 50 && !firstIsland; attempt++) {
    const islandSize = Math.floor(rng() * (maxIslandTiles - minIslandTiles + 1)) + minIslandTiles;
    const startX = Math.floor(rng() * width);
    const startY = 2 + Math.floor(rng() * (height - 4));
    const islandTiles = growIsland(startX, startY, islandSize);

    if (islandTiles.length < minIslandTiles) continue;

    const targetCities = 2 + Math.floor(rng() * 4); // 2-5 cities
    const cityConfigs = placeCitiesOnIsland(islandTiles, 2, 5, targetCities);
    if (cityConfigs.length < 2) continue;
    if (!hasCoastalCity({ tiles: islandTiles, cities: cityConfigs, center: { x: startX, y: startY } }, cityConfigs)) continue;

    for (const t of islandTiles) {
      tiles[t.y][t.x] = Terrain.Land;
      landSet.add(`${t.x},${t.y}`);
    }
    firstIsland = { tiles: islandTiles, cities: cityConfigs, center: { x: startX, y: startY } };
  }
  if (!firstIsland) throw new Error('Failed to generate first island with coastal city');
  islands.push(firstIsland);

  // Step 2: Generate second island (2-5 cities, must have coastal city)
  let secondIsland: Island | null = null;
  for (let attempt = 0; attempt < 50 && !secondIsland; attempt++) {
    const farthest = findFarthestOceanPoint();
    if (!farthest) break;

    const islandSize = Math.floor(rng() * (maxIslandTiles - minIslandTiles + 1)) + minIslandTiles;
    const islandTiles = growIsland(farthest.x, farthest.y, islandSize);

    if (islandTiles.length < minIslandTiles) continue;

    const targetCities = 2 + Math.floor(rng() * 4); // 2-5 cities
    const cityConfigs = placeCitiesOnIsland(islandTiles, 2, 5, targetCities);
    if (cityConfigs.length < 2) continue;
    if (!hasCoastalCity({ tiles: islandTiles, cities: cityConfigs, center: farthest }, cityConfigs)) continue;

    for (const t of islandTiles) {
      tiles[t.y][t.x] = Terrain.Land;
      landSet.add(`${t.x},${t.y}`);
    }
    secondIsland = { tiles: islandTiles, cities: cityConfigs, center: farthest };
  }
  if (!secondIsland) throw new Error('Failed to generate second island with coastal city');
  islands.push(secondIsland);

  // Step 3: Repeat - find farthest ocean point, grow 1-7 city island
  while (islands.length < maxIslands) {
    const farthest = findFarthestOceanPoint();
    if (!farthest || distToNearestLand(farthest.x, farthest.y) < minOceanDist) break;

    const islandSize = Math.floor(rng() * (maxIslandTiles - minIslandTiles + 1)) + minIslandTiles;
    const islandTiles = growIsland(farthest.x, farthest.y, islandSize);

    if (islandTiles.length < 4) continue;

    const targetCities = Math.min(7, 1 + Math.floor(rng() * 7)); // 1-7 cities, hard-capped at 7
    const cityConfigs = placeCitiesOnIsland(islandTiles, 1, 7, targetCities);
    if (cityConfigs.length < 1) continue;

    for (const t of islandTiles) {
      tiles[t.y][t.x] = Terrain.Land;
      landSet.add(`${t.x},${t.y}`);
    }
    islands.push({ tiles: islandTiles, cities: cityConfigs, center: farthest });
  }

  if (islands.length < 2) throw new Error('Failed to generate at least 2 islands');

  // Assign P1 to first island, P2 to second island (they have coastal cities)
  const p1Island = islands[0];
  const p2Island = islands[1];

  p1Island.cities[0].owner = 'player1';
  p2Island.cities[0].owner = 'player2';

  // Build final City objects
  const cities: City[] = [];
  for (const island of islands) {
    for (const cfg of island.cities) {
      cities.push({
        id: genId('city'),
        x: cfg.x,
        y: cfg.y,
        owner: cfg.owner,
        producing: cfg.owner ? UnitType.Army : null,
        productionTurnsLeft: cfg.owner ? 3 : 0,
        productionProgress: 0,
      });
    }
  }

  // Starting units
  const p1City = cities.find(c => c.owner === 'player1');
  const p2City = cities.find(c => c.owner === 'player2');

  if (!p1City || !p2City) {
    throw new Error('Failed to assign starting cities to players');
  }

  const units: Unit[] = [
    {
      id: genId('unit'),
      type: UnitType.Army,
      owner: 'player1' as PlayerId,
      x: p1City.x,
      y: p1City.y,
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
      x: p2City.x,
      y: p2City.y,
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
