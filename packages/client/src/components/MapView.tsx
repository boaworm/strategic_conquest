import { useRef, useEffect, useState, useCallback } from 'react';
import { Terrain, wrapX, generatePresetMap, WORLD_CITIES, EUROPE_CITIES } from '@sc/shared';

// Simple ID generator (no dependencies)
let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

type GenIdFn = (prefix: string) => string;

// ── Color palette ──────────────────────────────────────────────

const COL_OCEAN        = '#0a2463';
const COL_OCEAN_ACCENT = '#0e3a7e';
const COL_LAND         = '#3a7d44';
const COL_LAND_ACCENT  = '#2d6636';
const COL_P1           = '#4a9eed';
const COL_P2           = '#ed4a4a';
const COL_NEUTRAL      = '#aaa';
const COL_GRID         = 'rgba(0,0,0,0.2)';
const COL_CITY_BORDER  = '#fff';

function ownerColor(owner: 'player1' | 'player2' | null): string {
  if (owner === 'player1') return COL_P1;
  if (owner === 'player2') return COL_P2;
  return COL_NEUTRAL;
}

// ── Drawing helpers ────────────────────────────────────────────

function drawIceCap(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, south: boolean) {
  ctx.fillStyle = '#e8eaf0';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#2a2a3a';
  ctx.beginPath();
  if (south) {
    const b = y + size;
    ctx.moveTo(x, b); ctx.lineTo(x, b - size * 0.3); ctx.lineTo(x + size * 0.15, b - size * 0.55);
    ctx.lineTo(x + size * 0.25, b - size * 0.35); ctx.lineTo(x + size * 0.38, b - size * 0.7);
    ctx.lineTo(x + size * 0.5, b - size * 0.4); ctx.lineTo(x + size * 0.62, b - size * 0.65);
    ctx.lineTo(x + size * 0.75, b - size * 0.3); ctx.lineTo(x + size * 0.85, b - size * 0.5);
    ctx.lineTo(x + size, b - size * 0.25); ctx.lineTo(x + size, b);
  } else {
    const b = y;
    ctx.moveTo(x, b); ctx.lineTo(x, b + size * 0.3); ctx.lineTo(x + size * 0.15, b + size * 0.55);
    ctx.lineTo(x + size * 0.25, b + size * 0.35); ctx.lineTo(x + size * 0.38, b + size * 0.7);
    ctx.lineTo(x + size * 0.5, b + size * 0.4); ctx.lineTo(x + size * 0.62, b + size * 0.65);
    ctx.lineTo(x + size * 0.75, b + size * 0.3); ctx.lineTo(x + size * 0.85, b + size * 0.5);
    ctx.lineTo(x + size, b + size * 0.25); ctx.lineTo(x + size, b);
  }
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff';
  const ph = size * 0.12;
  [[0.38, south ? -0.7 : 0.7], [0.62, south ? -0.65 : 0.65]].forEach(([px, py]) => {
    const base = south ? y + size : y;
    const vy = base + size * (py as number);
    ctx.beginPath();
    ctx.moveTo(x + size * (px as number) - size * 0.06, vy + (south ? ph : -ph));
    ctx.lineTo(x + size * (px as number), vy);
    ctx.lineTo(x + size * (px as number) + size * 0.06, vy + (south ? ph : -ph));
    ctx.closePath(); ctx.fill();
  });
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    const ia = angle + Math.PI / 5;
    ctx.lineTo(cx + r * 0.4 * Math.cos(ia), cy + r * 0.4 * Math.sin(ia));
  }
  ctx.closePath();
  ctx.fill();
}

// ── Canvas renderer ───────────────────────────────────────────

interface MapCanvasProps {
  mapWidth: number;
  mapHeight: number;
  tiles: Terrain[][];
  cities: Array<{ x: number; y: number; owner: 'player1' | 'player2' | null; name: string }>;
}

function MapCanvas({ mapWidth, mapHeight, tiles, cities }: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef({ x: mapWidth / 2, y: mapHeight / 2, tileSize: 24 });
  const dragRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const drawRef = useRef<() => void>(() => {});

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr, H = canvas.height / dpr;
    const { x: camX, y: camY, tileSize: ts } = camRef.current;
    const ox = camX * ts - W / 2, oy = camY * ts - H / 2;
    const x0 = Math.floor(ox / Math.max(1, ts)), x1 = Math.ceil((ox + W) / Math.max(1, ts));
    const y0 = Math.max(0, Math.floor(oy / Math.max(1, ts))), y1 = Math.min(mapHeight - 1, Math.ceil((oy + H) / Math.max(1, ts)));
    if (x1 - x0 > 2000 || y1 - y0 > 2000) return;

    ctx.fillStyle = '#111122'; ctx.fillRect(0, 0, W, H);

    // Tiles
    for (let wy = y0; wy <= y1; wy++) {
      for (let wx = x0; wx <= x1; wx++) {
        const tx = wrapX(wx, mapWidth);
        const terrain = tiles[wy]?.[tx];
        if (terrain === undefined) continue;
        const sx = wx * ts - ox, sy = wy * ts - oy;
        ctx.fillStyle = terrain === Terrain.Ocean
          ? ((tx + wy) % 2 === 0 ? COL_OCEAN : COL_OCEAN_ACCENT)
          : ((tx + wy) % 2 === 0 ? COL_LAND : COL_LAND_ACCENT);
        ctx.fillRect(sx, sy, ts, ts);
        if (wy === 0 || wy === mapHeight - 1) drawIceCap(ctx, sx, sy, ts, wy === mapHeight - 1);
        if (ts >= 12) { ctx.strokeStyle = COL_GRID; ctx.lineWidth = 0.5; ctx.strokeRect(sx, sy, ts, ts); }
      }
    }

    // Cities with labels
    for (const city of cities) {
      const tx = wrapX(city.x, mapWidth);
      const sx = tx * ts - ox, sy = city.y * ts - oy;
      const ccx = sx + ts / 2, ccy = sy + ts / 2;

      // City marker
      const pad = ts * 0.15;
      ctx.fillStyle = ownerColor(city.owner);
      ctx.fillRect(sx + pad, sy + pad, ts - 2 * pad, ts - 2 * pad);
      ctx.strokeStyle = COL_CITY_BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + pad, sy + pad, ts - 2 * pad, ts - 2 * pad);
      drawStar(ctx, ccx, ccy, ts * 0.25, '#fff');

      // City name label
      if (ts >= 14) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(9, ts * 0.35)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.shadowColor = '#000';
        ctx.shadowBlur = 3;
        ctx.fillText(city.name, ccx, sy + ts - 2);
        ctx.shadowBlur = 0;
      }
    }
  }, [mapWidth, mapHeight, tiles, cities]);

  useEffect(() => {
    drawRef.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.width / dpr, H = canvas.height / dpr;
      const { x: camX, y: camY, tileSize: ts } = camRef.current;
      const ox = camX * ts - W / 2, oy = camY * ts - H / 2;
      const x0 = Math.floor(ox / Math.max(1, ts)), x1 = Math.ceil((ox + W) / Math.max(1, ts));
      const y0 = Math.max(0, Math.floor(oy / Math.max(1, ts))), y1 = Math.min(mapHeight - 1, Math.ceil((oy + H) / Math.max(1, ts)));
      if (x1 - x0 > 2000 || y1 - y0 > 2000) return;

      ctx.fillStyle = '#111122'; ctx.fillRect(0, 0, W, H);

      // Tiles
      for (let wy = y0; wy <= y1; wy++) {
        for (let wx = x0; wx <= x1; wx++) {
          const tx = wrapX(wx, mapWidth);
          const terrain = tiles[wy]?.[tx];
          if (terrain === undefined) continue;
          const sx = wx * ts - ox, sy = wy * ts - oy;
          ctx.fillStyle = terrain === Terrain.Ocean
            ? ((tx + wy) % 2 === 0 ? COL_OCEAN : COL_OCEAN_ACCENT)
            : ((tx + wy) % 2 === 0 ? COL_LAND : COL_LAND_ACCENT);
          ctx.fillRect(sx, sy, ts, ts);
          if (wy === 0 || wy === mapHeight - 1) drawIceCap(ctx, sx, sy, ts, wy === mapHeight - 1);
          if (ts >= 12) { ctx.strokeStyle = COL_GRID; ctx.lineWidth = 0.5; ctx.strokeRect(sx, sy, ts, ts); }
        }
      }

      // Cities with labels
      for (const city of cities) {
        const tx = wrapX(city.x, mapWidth);
        const sx = tx * ts - ox, sy = city.y * ts - oy;
        const ccx = sx + ts / 2, ccy = sy + ts / 2;

        // City marker
        const pad = ts * 0.15;
        ctx.fillStyle = ownerColor(city.owner);
        ctx.fillRect(sx + pad, sy + pad, ts - 2 * pad, ts - 2 * pad);
        ctx.strokeStyle = COL_CITY_BORDER;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + pad, sy + pad, ts - 2 * pad, ts - 2 * pad);
        drawStar(ctx, ccx, ccy, ts * 0.25, '#fff');

        // City name label
        if (ts >= 14) {
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.max(9, ts * 0.35)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.shadowColor = '#000';
          ctx.shadowBlur = 3;
          ctx.fillText(city.name, ccx, sy + ts - 2);
          ctx.shadowBlur = 0;
        }
      }
    };
  }, [mapWidth, mapHeight, tiles, cities]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr; canvas.height = r.height * dpr;
      const ctx = canvas.getContext('2d'); if (ctx) ctx.scale(dpr, dpr);
      drawRef.current();
    });
    ro.observe(canvas); return () => ro.disconnect();
  }, []);

  useEffect(() => { drawRef.current(); }, [drawRef.current]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 2 || e.button === 1) {
      dragRef.current = { sx: e.clientX, sy: e.clientY, cx: camRef.current.x, cy: camRef.current.y };
      e.preventDefault();
    }
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current; if (!d) return;
    const ts = camRef.current.tileSize;
    camRef.current.x = d.cx - (e.clientX - d.sx) / ts;
    camRef.current.y = d.cy - (e.clientY - d.sy) / ts;
    drawRef.current();
  }, []);
  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    camRef.current.tileSize = Math.min(64, Math.max(8, camRef.current.tileSize * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    drawRef.current();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ cursor: 'crosshair' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

// ── Main component ────────────────────────────────────────────

export function MapView() {
  const [preset, setPreset] = useState<'world' | 'europe'>('world');
  const [mapWidth, setMapWidth] = useState(65);
  const [mapHeight, setMapHeight] = useState(25);
  const [mapData, setMapData] = useState<{ tiles: Terrain[][]; cities: Array<{ x: number; y: number; owner: 'player1' | 'player2' | null; name: string }> } | null>(null);

  // Parse URL params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mapParam = params.get('map');
    const widthParam = params.get('width');
    const heightParam = params.get('height');

    if (mapParam === 'europe') setPreset('europe');
    else if (mapParam === 'world') setPreset('world');

    if (widthParam) {
      const w = parseInt(widthParam, 10);
      if (Number.isFinite(w) && w > 0) setMapWidth(w);
    }
    if (heightParam) {
      const h = parseInt(heightParam, 10);
      if (Number.isFinite(h) && h > 0) setMapHeight(h);
    }
  }, []);

  // Get city names from preset
  const cityPreset = preset === 'world' ? WORLD_CITIES : EUROPE_CITIES;

  // Generate map when preset or size changes
  useEffect(() => {
    const result = generatePresetMap(preset, mapWidth, mapHeight, genId as GenIdFn);
    const cityList = result.cities.map((c: { x: number; y: number; owner: 'player1' | 'player2' | null }) => {
      // Find matching city from preset by position (allow some tolerance for scaling)
      const tolerance = 2;
      const matched = cityPreset.find(presetCity => {
        // Scale preset coordinates to current map size
        const scaledX = Math.round(presetCity.nx * mapWidth);
        const scaledY = Math.round(presetCity.ny * mapHeight);
        return Math.abs(scaledX - c.x) <= tolerance && Math.abs(scaledY - c.y) <= tolerance;
      });
      return {
        x: c.x,
        y: c.y,
        owner: c.owner,
        name: matched?.name || (c.owner === 'player1' ? 'P1 Capital' : c.owner === 'player2' ? 'P2 Capital' : `City`),
      };
    });
    setMapData({ tiles: result.tiles, cities: cityList });
  }, [preset, mapWidth, mapHeight, cityPreset]);

  // Build city list with names
  const citiesWithNames = mapData?.cities.map((c: { x: number; y: number; owner: 'player1' | 'player2' | null; name: string }) => ({
    ...c,
  })) || [];

  // Preset info
  const presetInfo = preset === 'europe'
    ? 'Europe (includes N. Africa & Turkey). P1: London, P2: Moscow'
    : 'World map (Mercator). P1: Ottawa, P2: Beijing';

  if (!mapData) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-white">
        Loading...
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-700 text-white text-sm shrink-0">
        <h1 className="font-bold text-lg">Map Viewer</h1>
        <span className="text-gray-400">{presetInfo}</span>
        <span className="text-gray-500 ml-auto">{mapWidth}×{mapHeight}</span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-800 border-b border-gray-700 text-white text-sm shrink-0 flex-wrap">
        <span className="text-gray-400">Map:</span>
        <button
          className={`px-3 py-1 rounded ${preset === 'world' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
          onClick={() => setPreset('world')}
        >
          World
        </button>
        <button
          className={`px-3 py-1 rounded ${preset === 'europe' ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
          onClick={() => setPreset('europe')}
        >
          Europe
        </button>

        <span className="text-gray-400 ml-2">Size:</span>
        {[
          { label: 'Small', w: 50, h: 20 },
          { label: 'Medium', w: 65, h: 25 },
          { label: 'Large', w: 80, h: 30 },
          { label: 'XL', w: 120, h: 40 },
        ].map((s) => (
          <button
            key={s.label}
            className={`px-3 py-1 rounded ${mapWidth === s.w ? 'bg-green-600' : 'bg-gray-700 hover:bg-gray-600'}`}
            onClick={() => { setMapWidth(s.w); setMapHeight(s.h); }}
          >
            {s.label} ({s.w}×{s.h})
          </button>
        ))}

        <span className="text-gray-400 ml-4">Controls: drag to pan, scroll to zoom</span>
      </div>

      {/* Map canvas */}
      <div className="flex-1 overflow-hidden">
        <MapCanvas
          mapWidth={mapWidth}
          mapHeight={mapHeight}
          tiles={mapData.tiles}
          cities={citiesWithNames}
        />
      </div>

      {/* Legend */}
      <div className="px-4 py-2 bg-gray-900 border-t border-gray-700 text-white text-xs shrink-0 flex gap-4">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ backgroundColor: COL_P1 }}></div>
          <span>Player 1 (London/Ottawa)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ backgroundColor: COL_P2 }}></div>
          <span>Player 2 (Moscow/Beijing)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ backgroundColor: COL_NEUTRAL }}></div>
          <span>Neutral cities</span>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <div className="w-4 h-4 rounded" style={{ backgroundColor: COL_LAND }}></div>
          <span>Land</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ backgroundColor: COL_OCEAN }}></div>
          <span>Ocean</span>
        </div>
      </div>
    </div>
  );
}
