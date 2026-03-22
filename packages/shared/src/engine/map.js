import { Terrain, UnitType, GamePhase, wrapX, wrappedDistX, } from '../types.js';
/**
 * Simple seeded PRNG (mulberry32) for reproducible maps.
 */
function mulberry32(seed) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let nextId = 1;
function genId(prefix) {
    return `${prefix}_${nextId++}`;
}
export function resetIdCounter() {
    nextId = 1;
}
/**
 * Generate a map using a simple blob-based land generator.
 * Places starting cities for both players on opposite sides.
 */
export function generateMap(opts) {
    const { width, height, seed = Date.now(), landRatio = 0.35, cityCount = 15, } = opts;
    const rng = mulberry32(seed);
    // Init all ocean
    const tiles = Array.from({ length: height }, () => Array.from({ length: width }, () => Terrain.Ocean));
    // Generate land blobs
    const targetLand = Math.floor(width * height * landRatio);
    let landCount = 0;
    // Seed several land blobs
    const blobCount = 6 + Math.floor(rng() * 6);
    const blobCenters = [];
    for (let i = 0; i < blobCount; i++) {
        const cx = Math.floor(rng() * width);
        const cy = Math.floor(rng() * height);
        blobCenters.push({ x: cx, y: cy });
    }
    // Grow land from blob centers
    while (landCount < targetLand) {
        for (const center of blobCenters) {
            if (landCount >= targetLand)
                break;
            // Random walk from center
            let x = center.x;
            let y = center.y;
            const steps = 10 + Math.floor(rng() * 30);
            for (let s = 0; s < steps && landCount < targetLand; s++) {
                // Wrap X for cylindrical map
                x = wrapX(x, width);
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    if (tiles[y][x] === Terrain.Ocean) {
                        tiles[y][x] = Terrain.Land;
                        landCount++;
                    }
                }
                // Random direction
                const dir = Math.floor(rng() * 4);
                if (dir === 0)
                    x++;
                else if (dir === 1)
                    x--;
                else if (dir === 2)
                    y++;
                else
                    y--;
            }
        }
    }
    // Collect all land tiles (excluding ice cap border rows)
    const landTiles = [];
    for (let y = 1; y < height - 1; y++) {
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
    const cities = [];
    const usedPositions = new Set();
    function posKey(c) {
        return `${c.x},${c.y}`;
    }
    // Player 1 start: left quarter of map
    const p1Candidates = landTiles.filter((t) => t.x < width / 4);
    // Player 2 start: right quarter of map
    const p2Candidates = landTiles.filter((t) => t.x > (width * 3) / 4);
    const p1Start = p1Candidates[0] ?? landTiles[0];
    const p2Start = p2Candidates[0] ?? landTiles[landTiles.length - 1];
    // Player starting cities
    cities.push({
        id: genId('city'),
        x: p1Start.x,
        y: p1Start.y,
        owner: 'player1',
        producing: UnitType.Infantry,
        productionTurnsLeft: 3,
        productionProgress: 0,
    });
    usedPositions.add(posKey(p1Start));
    cities.push({
        id: genId('city'),
        x: p2Start.x,
        y: p2Start.y,
        owner: 'player2',
        producing: UnitType.Infantry,
        productionTurnsLeft: 3,
        productionProgress: 0,
    });
    usedPositions.add(posKey(p2Start));
    // Neutral cities: spread across the map
    let placed = 0;
    for (const tile of landTiles) {
        if (placed >= cityCount)
            break;
        const key = posKey(tile);
        if (usedPositions.has(key))
            continue;
        // Minimum distance from existing cities (using wrapped X distance)
        const tooClose = cities.some((c) => wrappedDistX(c.x, tile.x, width) + Math.abs(c.y - tile.y) < 4);
        if (tooClose)
            continue;
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
    const units = [
        {
            id: genId('unit'),
            type: UnitType.Infantry,
            owner: 'player1',
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
            type: UnitType.Infantry,
            owner: 'player2',
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
    return { tiles, cities, units };
}
/**
 * Create a full initial GameState from map options.
 */
export function createGameState(opts) {
    resetIdCounter();
    const { tiles, cities, units } = generateMap(opts);
    return {
        mapWidth: opts.width,
        mapHeight: opts.height,
        tiles,
        cities,
        units,
        currentPlayer: 'player1',
        turn: 1,
        phase: GamePhase.Active,
        winner: null,
        explored: {
            player1: new Set(),
            player2: new Set(),
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
//# sourceMappingURL=map.js.map