import { useRef, useEffect, useState, useCallback } from 'react';
import { Terrain, wrapX } from '@sc/shared';

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
const COL_HIGHLIGHT    = 'rgba(255,255,255,0.3)';
const COL_BRUSH        = 'rgba(255,255,0,0.3)';

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
  cities: Array<{ x: number; y: number; owner: 'player1' | 'player2' | null }>;
  editorMode?: boolean;
  onTileClick?: (tx: number, ty: number) => void;
  onCityClick?: (city: { x: number; y: number; owner: 'player1' | 'player2' | null }, isRightClick: boolean) => void;
  hoverTile?: { x: number; y: number } | null;
}

function MapCanvas({ mapWidth, mapHeight, tiles, cities, editorMode, onTileClick, onCityClick, hoverTile }: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef({ x: mapWidth / 2, y: mapHeight / 2, tileSize: 24 });
  const dragRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const paintRef = useRef(false);
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

    // Hover highlight
    if (hoverTile && hoverTile.x >= x0 && hoverTile.x <= x1 && hoverTile.y >= y0 && hoverTile.y <= y1) {
      const hx = wrapX(hoverTile.x, mapWidth);
      const hsx = hoverTile.x * ts - ox, hsy = hoverTile.y * ts - oy;
      ctx.fillStyle = COL_BRUSH;
      ctx.fillRect(hsx, hsy, ts, ts);
      ctx.strokeStyle = '#ff0';
      ctx.lineWidth = 1;
      ctx.strokeRect(hsx, hsy, ts, ts);
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
    }
  }, [mapWidth, mapHeight, tiles, cities, hoverTile]);

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

      // Hover highlight
      if (hoverTile && hoverTile.x >= x0 && hoverTile.x <= x1 && hoverTile.y >= y0 && hoverTile.y <= y1) {
        const hx = wrapX(hoverTile.x, mapWidth);
        const hsx = hoverTile.x * ts - ox, hsy = hoverTile.y * ts - oy;
        ctx.fillStyle = COL_BRUSH;
        ctx.fillRect(hsx, hsy, ts, ts);
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 1;
        ctx.strokeRect(hsx, hsy, ts, ts);
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
      }
    };
  }, [mapWidth, mapHeight, tiles, cities, hoverTile]);

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

  // Screen to tile conversion
  const screenToTile = useCallback((screenX: number, screenY: number): { tx: number; ty: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { x: camX, y: camY, tileSize: ts } = camRef.current;
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const pixelX = screenX - rect.left;
    const pixelY = screenY - rect.top;
    const ox = camX * ts - W / 2, oy = camY * ts - H / 2;
    const tx = wrapX(Math.floor((ox + pixelX) / ts), mapWidth);
    const ty = Math.floor((oy + pixelY) / ts);
    if (ty < 0 || ty >= mapHeight) return null;
    return { tx, ty };
  }, [mapWidth, mapHeight]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const tile = screenToTile(e.clientX, e.clientY);

    // Editor mode: left-click for action
    if (editorMode && tile && e.button === 0) {
      paintRef.current = true;
      onTileClick?.(tile.tx, tile.ty);
      e.preventDefault();
      return;
    }

    // Editor mode: right-click on city to delete
    if (editorMode && tile && e.button === 2) {
      const city = cities.find(c => c.x === tile.tx && c.y === tile.ty);
      if (city) {
        onCityClick?.(city, true);
        e.preventDefault();
        return;
      }
    }

    // Pan with right/middle mouse
    if (e.button === 2 || e.button === 1) {
      dragRef.current = { sx: e.clientX, sy: e.clientY, cx: camRef.current.x, cy: camRef.current.y };
      e.preventDefault();
    }
  }, [editorMode, screenToTile, onTileClick, onCityClick, cities]);

  const onClick = useCallback((e: React.MouseEvent) => {
    const tile = screenToTile(e.clientX, e.clientY);
    if (editorMode && tile && e.button === 0) {
      onTileClick?.(tile.tx, tile.ty);
      e.preventDefault();
    }
  }, [editorMode, screenToTile, onTileClick]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    // Painting in editor mode
    if (editorMode && paintRef.current) {
      const tile = screenToTile(e.clientX, e.clientY);
      if (tile) onTileClick?.(tile.tx, tile.ty);
    }

    // Panning
    const d = dragRef.current; if (!d) return;
    const ts = camRef.current.tileSize;
    camRef.current.x = d.cx - (e.clientX - d.sx) / ts;
    camRef.current.y = d.cy - (e.clientY - d.sy) / ts;
    drawRef.current();
  }, [editorMode, screenToTile, onTileClick]);

  const onMouseUp = useCallback(() => {
    dragRef.current = null;
    paintRef.current = false;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    camRef.current.tileSize = Math.min(64, Math.max(8, camRef.current.tileSize * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    drawRef.current();
  }, []);

  const onMouseLeave = useCallback(() => {
    dragRef.current = null;
    paintRef.current = false;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ cursor: editorMode ? 'crosshair' : 'grab' }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

// ── Main component ────────────────────────────────────────────

interface EditorCity {
  x: number;
  y: number;
  owner: 'player1' | 'player2' | null;
}

interface EditorState {
  tiles: Terrain[][];
  cities: EditorCity[];
}

export function MapView() {
  const [mapWidth, setMapWidth] = useState(65);
  const [mapHeight, setMapHeight] = useState(25);
  const [mapData, setMapData] = useState<{ tiles: Terrain[][]; cities: Array<{ x: number; y: number; owner: 'player1' | 'player2' | null }> } | null>(null);
  const [editorMode, setEditorMode] = useState(false);
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const [originalState, setOriginalState] = useState<EditorState | null>(null);
  type BrushType = { type: 'terrain'; terrain: Terrain } | { type: 'city' };
const [brush, setBrush] = useState<BrushType>({ type: 'terrain', terrain: Terrain.Land });
  const [hoverTile, setHoverTile] = useState<{ x: number; y: number } | null>(null);
const [savedMaps, setSavedMaps] = useState<Array<{ id: string; name: string; width: number; height: number }>>([]);
const [selectedMapId, setSelectedMapId] = useState<string>('');

  // Parse URL params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const widthParam = params.get('width');
    const heightParam = params.get('height');
    const editorParam = params.get('editor');

    if (widthParam) {
      const w = parseInt(widthParam, 10);
      if (Number.isFinite(w) && w > 0) setMapWidth(w);
    }
    if (heightParam) {
      const h = parseInt(heightParam, 10);
      if (Number.isFinite(h) && h > 0) setMapHeight(h);
    }
    if (editorParam === 'true') setEditorMode(true);
  }, []);

  // Handle tile click in editor mode
  const handleTileClick = useCallback((tx: number, ty: number) => {
    if (!editorState) return;

    if (brush.type === 'city') {
      setEditorState(prev => {
        if (!prev) return null;
        const newTiles = prev.tiles.map(row => [...row]);
        newTiles[ty][tx] = Terrain.Land;
        const newCities = prev.cities.filter(c => !(c.x === tx && c.y === ty));
        return {
          ...prev,
          tiles: newTiles,
          cities: [...newCities, { x: tx, y: ty, owner: null }],
        };
      });
    } else if (brush.type === 'terrain') {
      const newTerrain = brush.terrain;
      setEditorState(prev => {
        if (!prev) return null;
        const newTiles = prev.tiles.map(row => [...row]);
        newTiles[ty][tx] = newTerrain;
        const newCities = prev.cities.filter(c => !(c.x === tx && c.y === ty));
        return { ...prev, tiles: newTiles, cities: newCities };
      });
    }
  }, [editorState, brush]);

  // Handle city click (right-click to delete)
  const handleCityClick = useCallback((city: { x: number; y: number; owner: 'player1' | 'player2' | null }, isRightClick: boolean) => {
    if (!editorMode || !isRightClick || !editorState) return;

    setEditorState(prev => {
      if (!prev) return null;
      return {
        ...prev,
        cities: prev.cities.filter(c => !(c.x === city.x && c.y === city.y)),
      };
    });
  }, [editorMode, editorState]);

 
  // Reset to original map
  const resetMap = useCallback(() => {
    if (!originalState) return;
    setEditorState({
      tiles: originalState.tiles.map(row => [...row]),
      cities: [...originalState.cities],
    });
  }, [originalState]);

  // Save map to server
  const saveMapToServer = useCallback(async () => {
    if (!editorState) return;

    const mapName = savedMaps.find(m => m.id === selectedMapId)?.name || 'untitled';

    try {
      const exportData = {
        name: mapName,
        width: mapWidth,
        height: mapHeight,
        tiles: editorState.tiles.map(row => row.map(t => t === Terrain.Land ? 'land' : 'ocean')),
        cities: editorState.cities.map(({ x, y }) => ({ x, y })),
      };

      if (selectedMapId) {
        // Update existing map
        const response = await fetch(`/api/maps/${selectedMapId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(exportData),
        });
        if (!response.ok) throw new Error('Failed to update map');
      } else {
        // Create new map
        const response = await fetch('/api/maps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(exportData),
        });
        if (!response.ok) throw new Error('Failed to save map');
      }
      alert('Map saved!');
    } catch (err) {
      alert('Failed to save map: ' + (err as Error).message);
    }
  }, [editorState, mapWidth, mapHeight, selectedMapId, savedMaps]);

  // Load map from server
  const loadMapFromServer = useCallback(async (mapId: string) => {
    try {
      const response = await fetch(`/api/maps/${mapId}`);
      if (!response.ok) throw new Error('Failed to load map');

      const data = await response.json();

      // Validate and convert tiles
      const newTiles: Terrain[][] = data.tiles.map((row: string[]) =>
        row.map((t: string) => t === 'land' ? Terrain.Land : Terrain.Ocean)
      );

      // Validate and convert cities
      const newCities: EditorCity[] = data.cities.map((c: { x: number; y: number }) => ({
        x: c.x,
        y: c.y,
        owner: null,
      }));

      setEditorState({
        tiles: newTiles,
        cities: newCities,
      });
      setMapData({ tiles: newTiles, cities: newCities });
      setMapWidth(data.width);
      setMapHeight(data.height);
      setSelectedMapId(mapId);
    } catch (err) {
      alert('Failed to load map: ' + (err as Error).message);
    }
  }, []);

  // Load maps on mount
  useEffect(() => {
    fetch('/api/maps')
      .then(r => r.json())
      .then((maps: Array<{ id: string; name: string; width: number; height: number }>) => {
        setSavedMaps(maps);
        if (maps.length > 0) {
          setSelectedMapId(maps[0].id);
          loadMapFromServer(maps[0].id);
        }
      })
      .catch(err => console.error('Failed to load maps:', err));
  }, [loadMapFromServer]);

 
  // Update mapData when editorState changes
  useEffect(() => {
    if (editorMode && editorState) {
      setMapData({
        tiles: editorState.tiles,
        cities: editorState.cities.map(c => ({ ...c })),
      });
    }
  }, [editorMode, editorState]);

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
        <h1 className="font-bold text-lg">{editorMode ? 'Map Editor' : 'Map Viewer'}</h1>
        <span className="text-gray-500 ml-auto">{mapWidth}×{mapHeight}</span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4 px-4 py-2 bg-gray-800 border-b border-gray-700 text-white text-sm shrink-0 flex-wrap">
        <span className="text-gray-400">Map:</span>
        <select
          className="bg-gray-700 text-white px-3 py-1 rounded"
          value={selectedMapId}
          onChange={(e) => {
            setSelectedMapId(e.target.value);
            loadMapFromServer(e.target.value);
          }}
        >
          {savedMaps.map(map => (
            <option key={map.id} value={map.id}>{map.name} ({map.width}×{map.height})</option>
          ))}
        </select>

        <div className="border-l border-gray-600 h-6 mx-2"></div>

        <button
          className={`px-3 py-1 rounded ${editorMode ? 'bg-purple-600' : 'bg-gray-700 hover:bg-gray-600'}`}
          onClick={() => setEditorMode(!editorMode)}
        >
          {editorMode ? 'Exit Editor' : 'Edit Mode'}
        </button>

        {editorMode && (
          <>
            <span className="text-gray-400">Brush:</span>
            <button
              className={`px-3 py-1 rounded ${brush.type === 'terrain' && brush.terrain === Terrain.Land ? 'bg-green-600' : 'bg-gray-700 hover:bg-gray-600'}`}
              onClick={() => setBrush({ type: 'terrain', terrain: Terrain.Land })}
              title="Land (L)"
            >
              Land
            </button>
            <button
              className={`px-3 py-1 rounded ${brush.type === 'terrain' && brush.terrain === Terrain.Ocean ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}`}
              onClick={() => setBrush({ type: 'terrain', terrain: Terrain.Ocean })}
              title="Ocean (O)"
            >
              Ocean
            </button>
            <button
              className={`px-3 py-1 rounded ${brush.type === 'city' ? 'bg-purple-600' : 'bg-gray-700 hover:bg-gray-600'}`}
              onClick={() => setBrush({ type: 'city' })}
              title="City (C)"
            >
              City
            </button>

            <div className="border-l border-gray-600 h-6 mx-2"></div>

            <button
              className="px-3 py-1 rounded bg-green-600 hover:bg-green-500"
              onClick={saveMapToServer}
            >
              Save
            </button>
            <button
              className="px-3 py-1 rounded bg-red-600 hover:bg-red-500"
              onClick={resetMap}
            >
              Reset
            </button>
          </>
        )}

        {!editorMode && (
          <span className="text-gray-400 ml-2">Controls: drag to pan, scroll to zoom</span>
        )}
      </div>

      {/* Map canvas */}
      <div className="flex-1 overflow-hidden relative">
        <MapCanvas
          mapWidth={mapWidth}
          mapHeight={mapHeight}
          tiles={mapData.tiles}
          cities={mapData.cities}
          editorMode={editorMode}
          onTileClick={handleTileClick}
          onCityClick={handleCityClick}
          hoverTile={hoverTile}
        />

      </div>

      {/* Status bar */}
      <div className="px-4 py-2 bg-gray-900 border-t border-gray-700 text-white text-xs shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {editorMode ? (
            <>
              <span>Brush: <span className={
                brush.type === 'terrain' && brush.terrain === Terrain.Land ? 'text-green-400' :
                brush.type === 'terrain' && brush.terrain === Terrain.Ocean ? 'text-blue-400' :
                'text-purple-400'
              }>
                {brush.type === 'city' ? 'City' : brush.terrain}
              </span></span>
              <span>Cities: {editorState?.cities.length || 0}</span>
            </>
          ) : (
            <span>Controls: drag to pan, scroll to zoom</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded" style={{ backgroundColor: COL_LAND }}></div>
          <span>Land</span>
          <div className="w-4 h-4 rounded" style={{ backgroundColor: COL_OCEAN }}></div>
          <span>Ocean</span>
        </div>
      </div>
    </div>
  );
}
