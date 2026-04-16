import { Terrain, type City, type Unit, UnitType, type PlayerId } from '../types.js';
import { WORLD_MAP_GRID, EUROPE_MAP_GRID } from '../svgMapData.js';

type GenIdFn = (prefix: string) => string;

type LandRegion =
  | { type: 'rect'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

interface CityDef {
  nx: number;
  ny: number;
  name: string;
  startPlayer?: 'player1' | 'player2';
}

function rasterize(regions: LandRegion[], width: number, height: number): boolean[][] {
  const grid: boolean[][] = Array.from({ length: height }, () => new Array(width).fill(false));
  for (let row = 0; row < height; row++) {
    const ny = (row + 0.5) / height;
    for (let col = 0; col < width; col++) {
      const nx = (col + 0.5) / width;
      for (const r of regions) {
        let hit = false;
        if (r.type === 'rect') {
          hit = nx >= r.x1 && nx <= r.x2 && ny >= r.y1 && ny <= r.y2;
        } else {
          const dx = (nx - r.cx) / r.rx;
          const dy = (ny - r.cy) / r.ry;
          hit = dx * dx + dy * dy <= 1;
        }
        if (hit) { grid[row][col] = true; break; }
      }
    }
  }
  return grid;
}

function snapCities(
  defs: CityDef[],
  land: boolean[][],
  width: number,
  height: number,
): Array<{ x: number; y: number; startPlayer?: PlayerId }> {
  const MIN_DIST = 3;
  const result: Array<{ x: number; y: number; startPlayer?: PlayerId }> = [];

  // Process start-player cities first so they get guaranteed placement
  const sorted = [...defs].sort((a, b) => (b.startPlayer ? 1 : 0) - (a.startPlayer ? 1 : 0));

  for (const def of sorted) {
    const tx = Math.min(width - 1, Math.max(0, Math.round(def.nx * width - 0.5)));
    const ty = Math.min(height - 1, Math.max(0, Math.round(def.ny * height - 0.5)));

    let bestX = -1, bestY = -1, bestD = Infinity;
    const R = 10;
    for (let dy = -R; dy <= R; dy++) {
      const y = ty + dy;
      if (y < 0 || y >= height) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = ((tx + dx) % width + width) % width;
        if (!land[y][x]) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestX = x; bestY = y; }
      }
    }
    if (bestX < 0) continue;

    const tooClose = result.some(c => {
      const ddx = Math.min(Math.abs(c.x - bestX), width - Math.abs(c.x - bestX));
      return Math.max(ddx, Math.abs(c.y - bestY)) < MIN_DIST;
    });
    if (tooClose && !def.startPlayer) continue;

    result.push({ x: bestX, y: bestY, startPlayer: def.startPlayer as PlayerId | undefined });
  }
  return result;
}

export interface PresetResult {
  tiles: Terrain[][];
  cities: City[];
  units: Unit[];
  totalHeight: number;
}

function buildMap(
  regions: LandRegion[],
  cityDefs: CityDef[],
  width: number,
  height: number,
  genId: GenIdFn,
): PresetResult {
  const totalHeight = height + 2;
  const land = rasterize(regions, width, height);

  const tiles: Terrain[][] = [new Array(width).fill(Terrain.Ocean)];
  for (let row = 0; row < height; row++) {
    tiles.push(land[row].map(l => l ? Terrain.Land : Terrain.Ocean));
  }
  tiles.push(new Array(width).fill(Terrain.Ocean));

  const placed = snapCities(cityDefs, land, width, height);

  const cities: City[] = placed.map(p => ({
    id: genId('city'),
    x: p.x,
    y: p.y + 1, // +1 for ice cap row
    owner: p.startPlayer ?? null,
    producing: p.startPlayer ? UnitType.Army : null,
    productionTurnsLeft: p.startPlayer ? 3 : 0,
    productionProgress: 0,
  }));

  const p1City = cities.find(c => c.owner === 'player1');
  const p2City = cities.find(c => c.owner === 'player2');
  if (!p1City || !p2City) {
    throw new Error(`Preset map failed to place player starting cities (p1=${!!p1City}, p2=${!!p2City})`);
  }

  const units: Unit[] = [
    {
      id: genId('unit'), type: UnitType.Army, owner: 'player1' as PlayerId,
      x: p1City.x, y: p1City.y, health: 1, movesLeft: 1,
      sleeping: false, hasAttacked: false, cargo: [], carriedBy: null,
    },
    {
      id: genId('unit'), type: UnitType.Army, owner: 'player2' as PlayerId,
      x: p2City.x, y: p2City.y, health: 1, movesLeft: 1,
      sleeping: false, hasAttacked: false, cargo: [], carriedBy: null,
    },
  ];

  return { tiles, cities, units, totalHeight };
}

// ── WORLD MAP ────────────────────────────────────────────────────────────────
// Standard Mercator projection. Seam at 180° (International Date Line, mid-Pacific).
// Map wraps east-west. Left edge = 180°W, right edge = 180°E.
//
// Coordinate conversion:
//   nx = (lon_east + 180) / 360        (lon_east in degrees, negative = west)
//   ny = (80 - lat) / 160              (lat in degrees N, range 80°N..80°S)

const W: LandRegion[] = [
  // ── North America ──────────────────────────────────────────────────────────
  // Alaska (160°W–130°W, 54°N–71°N)
  { type: 'rect', x1: 0.056, y1: 0.056, x2: 0.139, y2: 0.163 },
  // Yukon / BC coast (141°W–124°W, 54°N–60°N)
  { type: 'rect', x1: 0.108, y1: 0.125, x2: 0.156, y2: 0.163 },
  // Canada main body + NW Territories (135°W–55°W, 49°N–70°N)
  { type: 'rect', x1: 0.125, y1: 0.063, x2: 0.347, y2: 0.194 },
  // USA + southern Canada (124°W–67°W, 25°N–49°N)
  { type: 'rect', x1: 0.156, y1: 0.194, x2: 0.314, y2: 0.344 },
  // Mexico (117°W–87°W, 15°N–32°N)
  { type: 'rect', x1: 0.175, y1: 0.300, x2: 0.258, y2: 0.406 },
  // Central America (87°W–77°W, 8°N–18°N)
  { type: 'rect', x1: 0.258, y1: 0.388, x2: 0.286, y2: 0.450 },
  // Cuba / Caribbean (approximate)
  { type: 'ellipse', cx: 0.288, cy: 0.363, rx: 0.015, ry: 0.007 },

  // ── South America ──────────────────────────────────────────────────────────
  // Northern coast (Colombia/Venezuela, 80°W–50°W, 0°–12°N)
  { type: 'rect', x1: 0.278, y1: 0.425, x2: 0.361, y2: 0.500 },
  // Western coast + Andes (80°W–65°W, 5°N–23°S)
  { type: 'rect', x1: 0.278, y1: 0.469, x2: 0.319, y2: 0.644 },
  // Brazil main body (65°W–35°W, 5°N–25°S)
  { type: 'rect', x1: 0.319, y1: 0.469, x2: 0.403, y2: 0.656 },
  // Argentina / Uruguay (73°W–50°W, 23°S–55°S)
  { type: 'rect', x1: 0.297, y1: 0.644, x2: 0.361, y2: 0.844 },
  // Chile narrow strip (75°W–68°W, 18°S–55°S)
  { type: 'rect', x1: 0.292, y1: 0.613, x2: 0.311, y2: 0.844 },

  // ── Europe ─────────────────────────────────────────────────────────────────
  // Iceland (25°W–13°W, 63°N–66°N)
  { type: 'ellipse', cx: 0.460, cy: 0.106, rx: 0.017, ry: 0.010 },
  // British Isles (10°W–2°E, 50°N–59°N)
  { type: 'rect', x1: 0.472, y1: 0.131, x2: 0.506, y2: 0.188 },
  // Iberian Peninsula (9°W–3°E, 36°N–44°N)
  { type: 'rect', x1: 0.475, y1: 0.225, x2: 0.508, y2: 0.275 },
  // France + Benelux (5°W–8°E, 42°N–51°N)
  { type: 'rect', x1: 0.486, y1: 0.181, x2: 0.522, y2: 0.238 },
  // Scandinavia (5°E–30°E, 55°N–71°N)
  { type: 'rect', x1: 0.514, y1: 0.056, x2: 0.583, y2: 0.156 },
  // Germany + Poland + Central Europe (9°E–24°E, 46°N–55°N)
  { type: 'rect', x1: 0.525, y1: 0.156, x2: 0.567, y2: 0.213 },
  // Italy peninsula (7°E–18°E, 37°N–47°N)
  { type: 'rect', x1: 0.519, y1: 0.206, x2: 0.550, y2: 0.269 },
  // Balkans + Romania (13°E–30°E, 36°N–48°N)
  { type: 'rect', x1: 0.536, y1: 0.200, x2: 0.583, y2: 0.275 },
  // Ukraine + Belarus (22°E–40°E, 44°N–55°N)
  { type: 'rect', x1: 0.561, y1: 0.156, x2: 0.611, y2: 0.225 },

  // ── Russia ─────────────────────────────────────────────────────────────────
  // European Russia (28°E–60°E, 54°N–70°N)
  { type: 'rect', x1: 0.578, y1: 0.063, x2: 0.667, y2: 0.163 },
  // W + C Siberia (60°E–110°E, 54°N–70°N)
  { type: 'rect', x1: 0.667, y1: 0.063, x2: 0.806, y2: 0.163 },
  // E Siberia (110°E–168°E, 50°N–70°N)
  { type: 'rect', x1: 0.806, y1: 0.063, x2: 0.967, y2: 0.188 },
  // Chukotka / Far East (168°E–180°E, wraps to 180°W–168°W)
  { type: 'rect', x1: 0.967, y1: 0.094, x2: 1.000, y2: 0.163 },
  { type: 'rect', x1: 0.000, y1: 0.094, x2: 0.033, y2: 0.163 },

  // ── Turkey + Middle East ───────────────────────────────────────────────────
  // Turkey (26°E–45°E, 36°N–42°N)
  { type: 'rect', x1: 0.572, y1: 0.238, x2: 0.625, y2: 0.275 },
  // Caucasus (40°E–50°E, 38°N–43°N)
  { type: 'rect', x1: 0.611, y1: 0.231, x2: 0.639, y2: 0.263 },
  // Levant + Iraq + Iran (35°E–65°E, 28°N–38°N)
  { type: 'rect', x1: 0.597, y1: 0.263, x2: 0.681, y2: 0.325 },
  // Arabian Peninsula (35°E–60°E, 12°N–28°N)
  { type: 'rect', x1: 0.597, y1: 0.325, x2: 0.667, y2: 0.425 },

  // ── Central Asia ───────────────────────────────────────────────────────────
  // Kazakhstan + C. Asia (50°E–85°E, 36°N–55°N)
  { type: 'rect', x1: 0.639, y1: 0.156, x2: 0.736, y2: 0.275 },

  // ── Africa ─────────────────────────────────────────────────────────────────
  // North Africa strip (17°W–37°E, 15°N–37°N)
  { type: 'rect', x1: 0.453, y1: 0.269, x2: 0.603, y2: 0.406 },
  // West Africa bulge (17°W–15°E, 5°S–15°N)
  { type: 'rect', x1: 0.453, y1: 0.406, x2: 0.542, y2: 0.531 },
  // Central Africa (15°E–40°E, 5°S–5°N)
  { type: 'rect', x1: 0.542, y1: 0.469, x2: 0.611, y2: 0.531 },
  // East Africa (25°E–52°E, 10°S–15°N)
  { type: 'rect', x1: 0.569, y1: 0.406, x2: 0.644, y2: 0.563 },
  // Southern Africa (12°E–40°E, 35°S–5°S)
  { type: 'rect', x1: 0.533, y1: 0.531, x2: 0.611, y2: 0.719 },
  // South Africa tip (16°E–35°E, 35°S–22°S)
  { type: 'rect', x1: 0.544, y1: 0.644, x2: 0.597, y2: 0.719 },
  // Madagascar (43°E–50°E, 12°S–26°S)
  { type: 'ellipse', cx: 0.629, cy: 0.681, rx: 0.010, ry: 0.044 },

  // ── South Asia ─────────────────────────────────────────────────────────────
  // India + Pakistan + Bangladesh (60°E–97°E, 8°N–37°N)
  { type: 'rect', x1: 0.667, y1: 0.269, x2: 0.769, y2: 0.450 },
  // India southern tip (76°E–80°E, 8°N–12°N)
  { type: 'rect', x1: 0.711, y1: 0.425, x2: 0.722, y2: 0.450 },
  // Sri Lanka
  { type: 'ellipse', cx: 0.725, cy: 0.450, rx: 0.006, ry: 0.009 },

  // ── East Asia ──────────────────────────────────────────────────────────────
  // China + Mongolia (73°E–135°E, 18°N–55°N)
  { type: 'rect', x1: 0.703, y1: 0.156, x2: 0.875, y2: 0.388 },
  // Korea (125°E–130°E, 34°N–43°N)
  { type: 'rect', x1: 0.847, y1: 0.231, x2: 0.861, y2: 0.288 },
  // Japan (130°E–145°E, 31°N–45°N)
  { type: 'rect', x1: 0.861, y1: 0.219, x2: 0.903, y2: 0.306 },
  // Taiwan
  { type: 'ellipse', cx: 0.836, cy: 0.350, rx: 0.006, ry: 0.012 },

  // ── Southeast Asia ─────────────────────────────────────────────────────────
  // Mainland (92°E–110°E, 0°–28°N)
  { type: 'rect', x1: 0.756, y1: 0.325, x2: 0.806, y2: 0.500 },
  // Malay Peninsula (100°E–105°E, 1°N–7°N)
  { type: 'rect', x1: 0.778, y1: 0.456, x2: 0.792, y2: 0.494 },
  // Sumatra (95°E–106°E, 6°S–5°N)
  { type: 'rect', x1: 0.764, y1: 0.469, x2: 0.794, y2: 0.538 },
  // Borneo (108°E–119°E, 4°S–7°N)
  { type: 'rect', x1: 0.800, y1: 0.456, x2: 0.831, y2: 0.525 },
  // Java (106°E–115°E, 8°S–6°S)
  { type: 'rect', x1: 0.794, y1: 0.550, x2: 0.819, y2: 0.563 },
  // Philippines (117°E–127°E, 5°N–21°N)
  { type: 'rect', x1: 0.825, y1: 0.369, x2: 0.853, y2: 0.469 },
  // New Guinea (131°E–150°E, 2°S–9°S)
  { type: 'rect', x1: 0.864, y1: 0.519, x2: 0.917, y2: 0.556 },

  // ── Australia ──────────────────────────────────────────────────────────────
  // Australia (114°E–154°E, 10°S–39°S)
  { type: 'rect', x1: 0.817, y1: 0.619, x2: 0.928, y2: 0.744 },
  // New Zealand (166°E–178°E, 34°S–47°S)
  { type: 'ellipse', cx: 0.960, cy: 0.731, rx: 0.017, ry: 0.041 },
];

// World capitals. Player 1 = Ottawa (N. America), Player 2 = Beijing (Asia).
// nx = (lon_east + 180) / 360,  ny = (80 - lat) / 160
const WC: CityDef[] = [
  { nx: 0.290, ny: 0.216, name: 'Ottawa',        startPlayer: 'player1' },
  { nx: 0.823, ny: 0.251, name: 'Beijing',        startPlayer: 'player2' },
  // Americas
  { nx: 0.286, ny: 0.257, name: 'Washington DC' },
  { nx: 0.180, ny: 0.365, name: 'Los Angeles' },
  { nx: 0.224, ny: 0.379, name: 'Mexico City' },
  { nx: 0.297, ny: 0.434, name: 'Caracas' },
  { nx: 0.294, ny: 0.472, name: 'Bogota' },
  { nx: 0.286, ny: 0.575, name: 'Lima' },
  { nx: 0.367, ny: 0.599, name: 'Brasilia' },
  { nx: 0.337, ny: 0.716, name: 'Buenos Aires' },
  { nx: 0.304, ny: 0.709, name: 'Santiago' },
  // Europe
  { nx: 0.500, ny: 0.178, name: 'London' },
  { nx: 0.506, ny: 0.194, name: 'Paris' },
  { nx: 0.537, ny: 0.172, name: 'Berlin' },
  { nx: 0.535, ny: 0.238, name: 'Rome' },
  { nx: 0.490, ny: 0.248, name: 'Madrid' },
  { nx: 0.558, ny: 0.174, name: 'Warsaw' },
  { nx: 0.585, ny: 0.184, name: 'Kyiv' },
  // Russia
  { nx: 0.604, ny: 0.151, name: 'Moscow' },
  // Middle East + Africa
  { nx: 0.592, ny: 0.251, name: 'Ankara' },
  { nx: 0.587, ny: 0.312, name: 'Cairo' },
  { nx: 0.629, ny: 0.346, name: 'Riyadh' },
  { nx: 0.509, ny: 0.459, name: 'Lagos' },
  { nx: 0.607, ny: 0.444, name: 'Addis Ababa' },
  { nx: 0.602, ny: 0.508, name: 'Nairobi' },
  { nx: 0.543, ny: 0.527, name: 'Kinshasa' },
  { nx: 0.551, ny: 0.712, name: 'Cape Town' },
  // Asia
  { nx: 0.643, ny: 0.277, name: 'Tehran' },
  { nx: 0.703, ny: 0.289, name: 'Islamabad' },
  { nx: 0.714, ny: 0.322, name: 'Delhi' },
  { nx: 0.779, ny: 0.414, name: 'Bangkok' },
  { nx: 0.797, ny: 0.539, name: 'Jakarta' },
  { nx: 0.852, ny: 0.265, name: 'Seoul' },
  { nx: 0.888, ny: 0.278, name: 'Tokyo' },
  // Australia
  { nx: 0.914, ny: 0.722, name: 'Canberra' },
];

// ── EUROPE MAP ───────────────────────────────────────────────────────────────
// Coverage: 30°W to 45°E longitude (75° wide), 20°N to 72°N latitude (52° tall).
// Includes Northern Africa and Turkey as requested.
//
// Coordinate conversion:
//   nx = (lon_east + 30) / 75        (lon_east: negative = west)
//   ny = (72 - lat) / 52

const E: LandRegion[] = [
  // Iceland (25°W–12°W, 63°N–66°N)
  { type: 'ellipse', cx: 0.153, cy: 0.144, rx: 0.087, ry: 0.029 },
  // Ireland (10°W–5.5°W, 51°N–55.5°N)
  { type: 'ellipse', cx: 0.300, cy: 0.360, rx: 0.033, ry: 0.044 },
  // Great Britain (5.5°W–2°E, 49.5°N–59°N)
  { type: 'rect', x1: 0.327, y1: 0.250, x2: 0.427, y2: 0.433 },
  // Iberian Peninsula (9°W–4°E, 36°N–44°N)
  { type: 'rect', x1: 0.280, y1: 0.538, x2: 0.453, y2: 0.692 },
  // France + Benelux (5°W–8.5°E, 42°N–51.5°N)
  { type: 'rect', x1: 0.333, y1: 0.394, x2: 0.513, y2: 0.577 },
  // Germany + Denmark + Austria + Czech + Slovakia (9°E–24°E, 46°N–55°N)
  { type: 'rect', x1: 0.520, y1: 0.327, x2: 0.720, y2: 0.500 },
  // Poland + Baltic area (14°E–28°E, 49°N–59°N)
  { type: 'rect', x1: 0.587, y1: 0.250, x2: 0.773, y2: 0.442 },
  // Norway coast (4°E–16°E, 57°N–71°N)
  { type: 'rect', x1: 0.453, y1: 0.019, x2: 0.613, y2: 0.288 },
  // Sweden (12°E–25°E, 55°N–69°N)
  { type: 'rect', x1: 0.560, y1: 0.058, x2: 0.733, y2: 0.327 },
  // Finland (20°E–32°E, 60°N–70°N)
  { type: 'rect', x1: 0.667, y1: 0.038, x2: 0.827, y2: 0.231 },
  // Italy peninsula (7°E–18.5°E, 37°N–46°N)
  { type: 'rect', x1: 0.493, y1: 0.500, x2: 0.647, y2: 0.673 },
  // Sicily
  { type: 'ellipse', cx: 0.583, cy: 0.673, rx: 0.022, ry: 0.015 },
  // Sardinia
  { type: 'ellipse', cx: 0.507, cy: 0.617, rx: 0.015, ry: 0.025 },
  // Balkans + Hungary + Romania (13°E–30°E, 36°N–48°N)
  { type: 'rect', x1: 0.560, y1: 0.462, x2: 0.800, y2: 0.692 },
  // Greece extension south (21°E–27°E, 36°N–41°N)
  { type: 'rect', x1: 0.680, y1: 0.596, x2: 0.760, y2: 0.692 },
  // Crete
  { type: 'ellipse', cx: 0.737, cy: 0.692, rx: 0.027, ry: 0.013 },
  // Cyprus
  { type: 'ellipse', cx: 0.853, cy: 0.673, rx: 0.017, ry: 0.011 },
  // Belarus (24°E–32°E, 51°N–56°N)
  { type: 'rect', x1: 0.720, y1: 0.308, x2: 0.827, y2: 0.404 },
  // Ukraine (22°E–40°E, 44°N–52°N)
  { type: 'rect', x1: 0.693, y1: 0.385, x2: 0.933, y2: 0.538 },
  // Western Russia (28°E–45°E, 54°N–70°N)
  { type: 'rect', x1: 0.773, y1: 0.038, x2: 1.000, y2: 0.346 },
  // Turkey (26°E–45°E, 36°N–42°N)
  { type: 'rect', x1: 0.747, y1: 0.577, x2: 1.000, y2: 0.692 },
  // Morocco (9°W–2°W, 28°N–36°N)
  { type: 'rect', x1: 0.280, y1: 0.692, x2: 0.387, y2: 0.846 },
  // Algeria (2°W–9°E, 18°N–37°N) — only northern strip visible
  { type: 'rect', x1: 0.373, y1: 0.673, x2: 0.520, y2: 1.000 },
  // Tunisia (9°E–12°E, 30°N–37.5°N)
  { type: 'rect', x1: 0.520, y1: 0.663, x2: 0.560, y2: 0.808 },
  // Libya (12°E–25°E, 20°N–33.5°N)
  { type: 'rect', x1: 0.560, y1: 0.740, x2: 0.733, y2: 1.000 },
  // Egypt + Sinai (24.5°E–37°E, 22°N–31.5°N)
  { type: 'rect', x1: 0.727, y1: 0.779, x2: 0.893, y2: 1.000 },
];

// Europe capitals. Player 1 = London, Player 2 = Moscow.
// nx = (lon_east + 30) / 75,  ny = (72 - lat) / 52
const EC: CityDef[] = [
  { nx: 0.399, ny: 0.394, name: 'London',         startPlayer: 'player1' },
  { nx: 0.901, ny: 0.312, name: 'Moscow',          startPlayer: 'player2' },
  // Western Europe
  { nx: 0.107, ny: 0.154, name: 'Reykjavik' },
  { nx: 0.316, ny: 0.360, name: 'Dublin' },
  { nx: 0.279, ny: 0.640, name: 'Lisbon' },
  { nx: 0.351, ny: 0.608, name: 'Madrid' },
  { nx: 0.431, ny: 0.444, name: 'Paris' },
  { nx: 0.459, ny: 0.408, name: 'Brussels' },
  { nx: 0.465, ny: 0.377, name: 'Amsterdam' },
  { nx: 0.499, ny: 0.483, name: 'Bern' },
  // Central Europe
  { nx: 0.579, ny: 0.375, name: 'Berlin' },
  { nx: 0.568, ny: 0.313, name: 'Copenhagen' },
  { nx: 0.543, ny: 0.233, name: 'Oslo' },
  { nx: 0.641, ny: 0.244, name: 'Stockholm' },
  { nx: 0.733, ny: 0.227, name: 'Helsinki' },
  { nx: 0.680, ny: 0.381, name: 'Warsaw' },
  { nx: 0.592, ny: 0.421, name: 'Prague' },
  { nx: 0.619, ny: 0.458, name: 'Vienna' },
  { nx: 0.655, ny: 0.471, name: 'Budapest' },
  // Southern Europe
  { nx: 0.567, ny: 0.579, name: 'Rome' },
  { nx: 0.673, ny: 0.523, name: 'Belgrade' },
  { nx: 0.711, ny: 0.563, name: 'Sofia' },
  { nx: 0.748, ny: 0.523, name: 'Bucharest' },
  { nx: 0.716, ny: 0.654, name: 'Athens' },
  // Turkey
  { nx: 0.787, ny: 0.596, name: 'Istanbul' },
  { nx: 0.839, ny: 0.617, name: 'Ankara' },
  // Eastern Europe
  { nx: 0.768, ny: 0.348, name: 'Minsk' },
  { nx: 0.807, ny: 0.413, name: 'Kyiv' },
  { nx: 0.737, ny: 0.333, name: 'Vilnius' },
  { nx: 0.721, ny: 0.290, name: 'Riga' },
  { nx: 0.730, ny: 0.242, name: 'Tallinn' },
  { nx: 0.804, ny: 0.233, name: 'St. Petersburg' },
  // North Africa
  { nx: 0.309, ny: 0.731, name: 'Rabat' },
  { nx: 0.441, ny: 0.679, name: 'Algiers' },
  { nx: 0.536, ny: 0.677, name: 'Tunis' },
  { nx: 0.577, ny: 0.752, name: 'Tripoli' },
  { nx: 0.816, ny: 0.806, name: 'Cairo' },
];

/**
 * Build world map from SVG-derived grid data (WORLD_MAP_GRID).
 * The grid is 120x40 (playable area) with ice caps on rows 0 and 41.
 */
function buildWorldMapFromGrid(width: number, height: number, genId: GenIdFn): PresetResult {
  // WORLD_MAP_GRID is 120x40
  const gridWidth = 120;
  const gridHeight = 40;

  // Create tiles array with ice caps
  const totalHeight = height + 2;
  const tiles: Terrain[][] = [];

  // Top ice cap
  tiles.push(new Array(width).fill(Terrain.Ocean));

  // Playable area - scale the traced grid
  for (let y = 0; y < height; y++) {
    const row: Terrain[] = [];
    const gridY = Math.floor(y * gridHeight / height);
    for (let x = 0; x < width; x++) {
      const gridX = Math.floor(x * gridWidth / width) % gridWidth;
      const cell = WORLD_MAP_GRID[gridY]?.[gridX] || 'ocean';
      row.push(cell === 'land' ? Terrain.Land : Terrain.Ocean);
    }
    tiles.push(row);
  }

  // Bottom ice cap
  tiles.push(new Array(width).fill(Terrain.Ocean));

  // Convert tiles to land mask for city snapping
  const landMask = tiles.map((row, y) => y === 0 || y === totalHeight - 1 ? row.map(() => false) : row.map(t => t === Terrain.Land));

  // Place cities based on player starting positions
  // P1: North America (Ottawa area), P2: Asia (Beijing area)
  const cityDefs: CityDef[] = WC;
  const placed = snapCities(cityDefs, landMask, width, height);

  const cities: City[] = placed.map(p => ({
    id: genId('city'),
    x: p.x,
    y: p.y + 1, // +1 for ice cap row
    owner: p.startPlayer ?? null,
    producing: p.startPlayer ? UnitType.Army : null,
    productionTurnsLeft: p.startPlayer ? 3 : 0,
    productionProgress: 0,
  }));

  const p1City = cities.find(c => c.owner === 'player1');
  const p2City = cities.find(c => c.owner === 'player2');
  if (!p1City || !p2City) {
    throw new Error(`World map failed to place player starting cities (p1=${!!p1City}, p2=${!!p2City})`);
  }

  const units: Unit[] = [
    {
      id: genId('unit'), type: UnitType.Army, owner: 'player1' as PlayerId,
      x: p1City.x, y: p1City.y, health: 1, movesLeft: 1,
      sleeping: false, hasAttacked: false, cargo: [], carriedBy: null,
    },
    {
      id: genId('unit'), type: UnitType.Army, owner: 'player2' as PlayerId,
      x: p2City.x, y: p2City.y, health: 1, movesLeft: 1,
      sleeping: false, hasAttacked: false, cargo: [], carriedBy: null,
    },
  ];

  return { tiles, cities, units, totalHeight };
}

export const WORLD_CITIES = WC;
export const EUROPE_CITIES = EC;

/**
 * Build Europe map from SVG-derived grid data (EUROPE_MAP_GRID).
 * The grid is 60x40 (playable area) with ice caps on rows 0 and 41.
 */
function buildEuropeMapFromGrid(width: number, height: number, genId: GenIdFn): PresetResult {
  // EUROPE_MAP_GRID is 60x40
  const gridWidth = 60;
  const gridHeight = 40;

  // Create tiles array with ice caps
  const totalHeight = height + 2;
  const tiles: Terrain[][] = [];

  // Top ice cap
  tiles.push(new Array(width).fill(Terrain.Ocean));

  // Playable area - scale the traced grid
  for (let y = 0; y < height; y++) {
    const row: Terrain[] = [];
    const gridY = Math.floor(y * gridHeight / height);
    for (let x = 0; x < width; x++) {
      const gridX = Math.floor(x * gridWidth / width);
      const cell = EUROPE_MAP_GRID[gridY]?.[gridX] || 'ocean';
      row.push(cell === 'land' ? Terrain.Land : Terrain.Ocean);
    }
    tiles.push(row);
  }

  // Bottom ice cap
  tiles.push(new Array(width).fill(Terrain.Ocean));

  // Convert tiles to land mask for city snapping
  const landMask = tiles.map((row, y) => y === 0 || y === totalHeight - 1 ? row.map(() => false) : row.map(t => t === Terrain.Land));

  // Place cities based on player starting positions
  // P1 = London (Western Europe), P2 = Moscow (Eastern Europe)
  const cityDefs: CityDef[] = EC;
  const placed = snapCities(cityDefs, landMask, width, height);

  const cities: City[] = placed.map(p => ({
    id: genId('city'),
    x: p.x,
    y: p.y + 1, // +1 for ice cap row
    owner: p.startPlayer ?? null,
    producing: p.startPlayer ? UnitType.Army : null,
    productionTurnsLeft: p.startPlayer ? 3 : 0,
    productionProgress: 0,
  }));

  const p1City = cities.find(c => c.owner === 'player1');
  const p2City = cities.find(c => c.owner === 'player2');
  if (!p1City || !p2City) {
    throw new Error(`Europe map failed to place player starting cities (p1=${!!p1City}, p2=${!!p2City})`);
  }

  const units: Unit[] = [
    {
      id: genId('unit'), type: UnitType.Army, owner: 'player1' as PlayerId,
      x: p1City.x, y: p1City.y, health: 1, movesLeft: 1,
      sleeping: false, hasAttacked: false, cargo: [], carriedBy: null,
    },
    {
      id: genId('unit'), type: UnitType.Army, owner: 'player2' as PlayerId,
      x: p2City.x, y: p2City.y, health: 1, movesLeft: 1,
      sleeping: false, hasAttacked: false, cargo: [], carriedBy: null,
    },
  ];

  return { tiles, cities, units, totalHeight };
}

export function generatePresetMap(
  preset: 'world' | 'europe',
  width: number,
  height: number,
  genId: GenIdFn,
): PresetResult {
  if (preset === 'world') {
    return buildWorldMapFromGrid(width, height, genId);
  }
  return buildEuropeMapFromGrid(width, height, genId);
}
