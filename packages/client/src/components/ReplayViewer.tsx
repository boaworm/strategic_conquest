import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  Terrain,
  UnitType,
  UNIT_STATS,
  wrapX,
} from '@sc/shared';
import type { City, Unit } from '@sc/shared';

// ── Types ────────────────────────────────────────────────────

interface ReplayMeta {
  id: string;
  recordedAt: string;
  turns: number;
  winner: string | null;
  p1Cities: number;
  p2Cities: number;
  neutralCities: number;
  mapWidth: number;
  mapHeight: number;
  frames: number;
}

interface ReplayFrame {
  turn: number;
  currentPlayer: string;
  cities: City[];
  units: Unit[];
  winner: string | null;
  phases?: Record<string, number>;
}

interface ReplayData {
  meta: ReplayMeta;
  mapWidth: number;
  mapHeight: number;
  tiles: Terrain[][];
  frames: ReplayFrame[];
}

// ── Color palette (mirrors GameCanvas) ───────────────────────

const COL_OCEAN        = '#0a2463';
const COL_OCEAN_ACCENT = '#0e3a7e';
const COL_LAND         = '#3a7d44';
const COL_LAND_ACCENT  = '#2d6636';
const COL_FOG          = '#111122';
const COL_GRID         = 'rgba(0,0,0,0.2)';
const COL_P1           = '#4a9eed';
const COL_P2           = '#ed4a4a';
const COL_NEUTRAL      = '#aaa';
const COL_PHASE1       = '#22c55e'; // green
const COL_PHASE2       = '#3b82f6'; // blue
const COL_PHASE3       = '#ef4444'; // red

function ownerColor(owner: string | null): string {
  if (owner === 'player1') return COL_P1;
  if (owner === 'player2') return COL_P2;
  return COL_NEUTRAL;
}

// ── Drawing helpers (copied from GameCanvas) ──────────────────

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

function drawUnitShape(ctx: CanvasRenderingContext2D, type: UnitType, cx: number, cy: number, size: number, color: string) {
  ctx.save();
  const r = size * 0.38;
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, size / 12); ctx.globalAlpha = 1;
  switch (type) {
    case UnitType.Army: {
      const hw = r * 0.9, hh = r * 0.35, trackY = cy + r * 0.25, trackH = r * 0.3;
      ctx.fillStyle = '#000'; ctx.globalAlpha = 0.4;
      ctx.beginPath(); ctx.roundRect(cx - hw, trackY, hw * 2, trackH, trackH * 0.4); ctx.fill();
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#fff';
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(cx - hw * 0.7 + (i * hw * 1.4) / 3, trackY + trackH * 0.5, trackH * 0.25, 0, 2 * Math.PI); ctx.fill(); }
      ctx.globalAlpha = 1; ctx.fillStyle = color;
      const hullTop = trackY - hh * 1.6;
      ctx.beginPath(); ctx.moveTo(cx - hw, trackY); ctx.lineTo(cx - hw * 0.75, hullTop); ctx.lineTo(cx + hw * 0.85, hullTop); ctx.lineTo(cx + hw, trackY); ctx.closePath(); ctx.fill();
      const tw = hw * 0.7, th = hh * 0.9, tl = cx - hw * 0.35, tt = hullTop - th;
      ctx.fillRect(tl, tt, tw, th); ctx.fillRect(tl + tw, tt + th * 0.35, hw * 0.65, th * 0.3);
      break;
    }
    case UnitType.Fighter: {
      ctx.beginPath(); ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.15, cy - r * 0.2); ctx.lineTo(cx + r, cy + r * 0.1); ctx.lineTo(cx + r * 0.8, cy + r * 0.35); ctx.lineTo(cx + r * 0.15, cy + r * 0.15);
      ctx.lineTo(cx + r * 0.15, cy + r * 0.55); ctx.lineTo(cx + r * 0.45, cy + r); ctx.lineTo(cx + r * 0.3, cy + r); ctx.lineTo(cx, cy + r * 0.7);
      ctx.lineTo(cx - r * 0.3, cy + r); ctx.lineTo(cx - r * 0.45, cy + r); ctx.lineTo(cx - r * 0.15, cy + r * 0.55); ctx.lineTo(cx - r * 0.15, cy + r * 0.15);
      ctx.lineTo(cx - r * 0.8, cy + r * 0.35); ctx.lineTo(cx - r, cy + r * 0.1); ctx.lineTo(cx - r * 0.15, cy - r * 0.2); ctx.closePath(); ctx.fill(); break;
    }
    case UnitType.Missile: {
      ctx.beginPath(); ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.12, cy - r * 0.65); ctx.lineTo(cx + r * 0.12, cy - r * 0.15); ctx.lineTo(cx + r * 0.8, cy + r * 0.3); ctx.lineTo(cx + r * 0.12, cy + r * 0.35);
      ctx.lineTo(cx + r * 0.35, cy + r); ctx.lineTo(cx + r * 0.12, cy + r * 0.75); ctx.lineTo(cx, cy + r * 0.88);
      ctx.lineTo(cx - r * 0.12, cy + r * 0.75); ctx.lineTo(cx - r * 0.35, cy + r); ctx.lineTo(cx - r * 0.12, cy + r * 0.35);
      ctx.lineTo(cx - r * 0.8, cy + r * 0.3); ctx.lineTo(cx - r * 0.12, cy - r * 0.15); ctx.lineTo(cx - r * 0.12, cy - r * 0.65);
      ctx.closePath(); ctx.fill(); break;
    }
    case UnitType.Transport: {
      const hw = r * 0.93, deckY = cy - r * 0.2, wl = cy + r * 0.1, keel = cy + r * 0.52;
      ctx.beginPath(); ctx.moveTo(cx - hw, deckY); ctx.lineTo(cx + hw * 0.68, deckY); ctx.lineTo(cx + hw, wl); ctx.lineTo(cx + hw * 0.88, keel); ctx.lineTo(cx - hw, keel); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.globalAlpha = 0.25; ctx.lineWidth = Math.max(1, size / 16);
      ctx.beginPath(); ctx.moveTo(cx - hw, wl); ctx.lineTo(cx + hw, wl); ctx.stroke();
      ctx.globalAlpha = 0.4; ctx.fillStyle = '#000';
      ctx.fillRect(cx - hw + hw * 0.03, deckY - r * 0.72, hw * 0.22, r * 0.72);
      ctx.globalAlpha = 0.32;
      ctx.fillRect(cx + hw * 0.32, deckY - r * 0.38, hw * 0.22, r * 0.38);
      ctx.fillRect(cx + hw * 0.04, deckY - r * 0.3, hw * 0.2, r * 0.3);
      ctx.fillRect(cx - hw * 0.2, deckY - r * 0.22, hw * 0.18, r * 0.22);
      ctx.globalAlpha = 1; ctx.fillStyle = color; break;
    }
    case UnitType.Destroyer: {
      const hw = r * 0.93, deckY = cy + r * 0.04, wl = cy + r * 0.2, keel = cy + r * 0.42;
      ctx.beginPath(); ctx.moveTo(cx - hw, deckY + r * 0.06); ctx.lineTo(cx - hw, wl); ctx.lineTo(cx - hw * 0.8, keel);
      ctx.lineTo(cx + hw * 0.72, keel); ctx.lineTo(cx + hw, wl - r * 0.04); ctx.lineTo(cx + hw * 0.58, deckY); ctx.lineTo(cx - hw * 0.9, deckY); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.globalAlpha = 0.3; ctx.lineWidth = Math.max(1, size / 18);
      ctx.beginPath(); ctx.moveTo(cx - hw, wl); ctx.lineTo(cx + hw, wl); ctx.stroke();
      ctx.globalAlpha = 0.38; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.moveTo(cx - hw * 0.16, deckY); ctx.lineTo(cx - hw * 0.16, deckY - r * 0.42); ctx.lineTo(cx + hw * 0.07, deckY - r * 0.28); ctx.lineTo(cx + hw * 0.07, deckY); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.42; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(cx + hw * 0.28, deckY - r * 0.05, r * 0.1, 0, 2 * Math.PI); ctx.fill();
      ctx.fillRect(cx + hw * 0.38, deckY - r * 0.09, hw * 0.3, r * 0.05);
      ctx.globalAlpha = 1; ctx.fillStyle = color; break;
    }
    case UnitType.Submarine: {
      const hw = r * 0.9, mid = cy + r * 0.22, hullH = r * 0.28;
      ctx.beginPath(); ctx.ellipse(cx, mid, hw, hullH, 0, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#000'; ctx.globalAlpha = 0.38;
      const sailBaseY = mid - hullH * 0.72, sailH = r * 0.52;
      ctx.beginPath(); ctx.moveTo(cx - hw * 0.17, sailBaseY); ctx.lineTo(cx - hw * 0.11, sailBaseY - sailH); ctx.lineTo(cx + hw * 0.13, sailBaseY - sailH); ctx.lineTo(cx + hw * 0.19, sailBaseY); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = color; break;
    }
    case UnitType.Carrier: {
      const hw = r * 0.96, deckY = cy - r * 0.06, wl = cy + r * 0.18, keel = cy + r * 0.42;
      ctx.beginPath(); ctx.moveTo(cx - hw, deckY); ctx.lineTo(cx + hw * 0.84, deckY); ctx.lineTo(cx + hw, deckY + r * 0.08); ctx.lineTo(cx + hw * 0.92, keel); ctx.lineTo(cx - hw * 0.88, keel); ctx.lineTo(cx - hw, wl); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.globalAlpha = 0.2; ctx.lineWidth = Math.max(1, size / 14);
      ctx.beginPath(); ctx.moveTo(cx - hw, wl); ctx.lineTo(cx + hw, wl); ctx.stroke();
      ctx.globalAlpha = 0.44; ctx.fillStyle = '#000';
      ctx.fillRect(cx - hw * 0.06, deckY - r * 0.46, hw * 0.17, r * 0.46);
      ctx.globalAlpha = 1; ctx.fillStyle = color; break;
    }
    case UnitType.Battleship: {
      const hw = r * 0.95, deckY = cy - r * 0.08, wl = cy + r * 0.22, keel = cy + r * 0.6;
      ctx.beginPath(); ctx.moveTo(cx - hw, deckY); ctx.lineTo(cx + hw * 0.58, deckY); ctx.lineTo(cx + hw, wl); ctx.lineTo(cx + hw * 0.86, keel); ctx.lineTo(cx - hw * 0.82, keel); ctx.lineTo(cx - hw, wl); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.globalAlpha = 0.25; ctx.lineWidth = Math.max(1, size / 13);
      ctx.beginPath(); ctx.moveTo(cx - hw, wl); ctx.lineTo(cx + hw, wl); ctx.stroke();
      ctx.globalAlpha = 0.38; ctx.fillStyle = '#000';
      ctx.fillRect(cx - hw * 0.36 * 0.58, deckY - r * 0.58, hw * 0.36, r * 0.58);
      ctx.globalAlpha = 0.44; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(cx + hw * 0.38, deckY - r * 0.05, r * 0.13, 0, 2 * Math.PI); ctx.fill();
      ctx.fillRect(cx + hw * 0.51, deckY - r * 0.1, hw * 0.32, r * 0.04);
      ctx.fillRect(cx + hw * 0.51, deckY - r * 0.02, hw * 0.32, r * 0.04);
      ctx.globalAlpha = 1; ctx.fillStyle = color; break;
    }
  }
  ctx.restore();
}

// ── Unit image loading & tinted rendering ────────────────────

const UNIT_IMAGE_SRCS: Record<UnitType, string> = {
  [UnitType.Army]:       '/units/army.png',
  [UnitType.Fighter]:    '/units/figher.png',
  [UnitType.Missile]:     '/units/missile.png',
  [UnitType.Transport]:  '/units/transport.png',
  [UnitType.Destroyer]:  '/units/destroyer.png',
  [UnitType.Submarine]:  '/units/submarine.png',
  [UnitType.Carrier]:    '/units/carrier.png',
  [UnitType.Battleship]: '/units/battleship.png',
};

const unitImageTintCache = new Map<string, HTMLCanvasElement>();

function drawUnit(
  ctx: CanvasRenderingContext2D,
  type: UnitType,
  cx: number,
  cy: number,
  size: number,
  color: string,
  images: Partial<Record<UnitType, HTMLImageElement>>,
) {
  const img = images[type];
  if (!img || !img.complete || img.naturalWidth === 0) {
    drawUnitShape(ctx, type, cx, cy, size, color);
    return;
  }

  const aspect = img.naturalWidth / img.naturalHeight;
  const w = aspect >= 1 ? Math.round(size * 0.82) : Math.round(size * 0.82 * aspect);
  const h = aspect >= 1 ? Math.round(w / aspect) : Math.round(size * 0.82);

  const cacheKey = `${type}:${w}:${h}:${color}`;
  let tinted = unitImageTintCache.get(cacheKey);
  if (!tinted) {
    tinted = document.createElement('canvas');
    tinted.width = w;
    tinted.height = h;
    const tc = tinted.getContext('2d')!;
    tc.fillStyle = color;
    tc.fillRect(0, 0, w, h);
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(img, 0, 0, w, h);
    unitImageTintCache.set(cacheKey, tinted);
  }

  ctx.drawImage(tinted, Math.round(cx - w / 2), Math.round(cy - h / 2));
}

// ── Canvas renderer ───────────────────────────────────────────

interface ReplayCanvasProps {
  replay: ReplayData;
  frame: ReplayFrame;
}

function ReplayCanvas({ replay, frame }: ReplayCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef({ x: replay.mapWidth / 2, y: replay.mapHeight / 2, tileSize: 24 });
  const dragRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const unitImagesRef = useRef<Partial<Record<UnitType, HTMLImageElement>>>({});
  const drawRef = useRef<() => void>(() => {});

  const mapW = replay.mapWidth;
  const mapH = replay.mapHeight;

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
    const y0 = Math.max(0, Math.floor(oy / Math.max(1, ts))), y1 = Math.min(mapH - 1, Math.ceil((oy + H) / Math.max(1, ts)));
    if (x1 - x0 > 2000 || y1 - y0 > 2000) return;

    ctx.fillStyle = COL_FOG; ctx.fillRect(0, 0, W, H);

    // Tiles
    for (let wy = y0; wy <= y1; wy++) {
      for (let wx = x0; wx <= x1; wx++) {
        const tx = wrapX(wx, mapW);
        const terrain = replay.tiles[wy]?.[tx];
        if (terrain === undefined) continue;
        const sx = wx * ts - ox, sy = wy * ts - oy;
        ctx.fillStyle = terrain === Terrain.Ocean
          ? ((tx + wy) % 2 === 0 ? COL_OCEAN : COL_OCEAN_ACCENT)
          : ((tx + wy) % 2 === 0 ? COL_LAND : COL_LAND_ACCENT);
        ctx.fillRect(sx, sy, ts, ts);
        if (wy === 0 || wy === mapH - 1) drawIceCap(ctx, sx, sy, ts, wy === mapH - 1);
        if (ts >= 12) { ctx.strokeStyle = COL_GRID; ctx.lineWidth = 0.5; ctx.strokeRect(sx, sy, ts, ts); }
      }
    }

    // Build lookups
    const cityByPos = new Map<string, City>();
    for (const c of frame.cities) cityByPos.set(`${c.x},${c.y}`, c);
    const unitsByPos = new Map<string, Unit[]>();
    for (const u of frame.units) {
      if (u.carriedBy) continue;
      const key = `${u.x},${u.y}`;
      const arr = unitsByPos.get(key) ?? []; arr.push(u); unitsByPos.set(key, arr);
    }

    // Cities & units
    for (let wy = y0; wy <= y1; wy++) {
      for (let wx = x0; wx <= x1; wx++) {
        const tx = wrapX(wx, mapW);
        const sx = wx * ts - ox, sy = wy * ts - oy;
        const ccx = sx + ts / 2, ccy = sy + ts / 2;
        const key = `${tx},${wy}`;

        const city = cityByPos.get(key);
        if (city) {
          const pad = ts * 0.12;
          ctx.fillStyle = ownerColor(city.owner);
          ctx.fillRect(sx + pad, sy + pad, ts - 2 * pad, ts - 2 * pad);
          drawStar(ctx, ccx, ccy, ts * 0.3, '#fff');
        }

        const units = unitsByPos.get(key);
        if (units && units.length > 0) {
          drawUnit(ctx, units[0].type, ccx, ccy, ts, ownerColor(units[0].owner), unitImagesRef.current);
          if ((units[0].type === UnitType.Carrier || units[0].type === UnitType.Transport) && units[0].cargo.length > 0 && ts >= 14) {
            ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(8, ts * 0.3)}px sans-serif`;
            ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(`${units[0].cargo.length}`, sx + 2, sy + 1);
          }
          if (units.length > 1 && ts >= 14) {
            ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(8, ts * 0.3)}px sans-serif`;
            ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillText(`${units.length}`, sx + ts - 2, sy + 1);
          }
          if ((units[0].type === UnitType.Battleship || units[0].type === UnitType.Carrier) && units[0].health < UNIT_STATS[units[0].type].maxHealth && ts >= 10) {
            const bw = ts - 4, bh = Math.max(2, ts / 8), bx = sx + 2, by = sy + ts - bh - 1;
            ctx.fillStyle = '#333'; ctx.fillRect(bx, by, bw, bh);
            ctx.fillStyle = '#e74c3c'; ctx.fillRect(bx, by, bw * (units[0].health / UNIT_STATS[units[0].type].maxHealth), bh);
          }
        }
      }
    }
  }, [frame, replay, mapW, mapH]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr; canvas.height = r.height * dpr;
      const ctx = canvas.getContext('2d'); if (ctx) ctx.scale(dpr, dpr);
      draw();
    });
    ro.observe(canvas); return () => ro.disconnect();
  }, [draw]);

  useEffect(() => { drawRef.current = draw; });
  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    for (const [type, src] of Object.entries(UNIT_IMAGE_SRCS) as [UnitType, string][]) {
      const img = new Image();
      img.src = src;
      img.onload = () => {
        unitImagesRef.current[type] = img;
        unitImageTintCache.clear();
        drawRef.current();
      };
    }
  }, []);

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
    draw();
  }, [draw]);
  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    camRef.current.tileSize = Math.min(64, Math.max(8, camRef.current.tileSize * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    draw();
  }, [draw]);

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

// ── Phase track bars component (renders bars only, no label) ───

interface PhaseTrackBarsProps {
  frames: ReplayFrame[];
  playerId: string;
  color: string;
}

function PhaseTrackBars({ frames, playerId, color }: PhaseTrackBarsProps) {
  if (frames.length === 0) return null;

  const bars: React.ReactNode[] = [];
  const segmentWidth = 100 / frames.length;

  for (let i = 0; i < frames.length; i++) {
    const phase = frames[i].phases?.[playerId] ?? 1;
    const bg = phase === 3 ? COL_PHASE3 : phase === 2 ? COL_PHASE2 : COL_PHASE1;
    bars.push(
      <div
        key={i}
        className="absolute top-0 bottom-0"
        style={{
          left: `${i * segmentWidth}%`,
          width: `${segmentWidth}%`,
          backgroundColor: bg,
        }}
      />
    );
  }

  return <>{bars}</>;
}

// ── Unit table constants ──────────────────────────────────────

const UNIT_TYPES_ORDERED = [
  UnitType.Army, UnitType.Transport, UnitType.Destroyer,
  UnitType.Submarine, UnitType.Battleship, UnitType.Carrier,
  UnitType.Fighter, UnitType.Missile,
] as const;

const UNIT_LABELS: Record<UnitType, string> = {
  [UnitType.Army]: 'Army', [UnitType.Transport]: 'Transport', [UnitType.Destroyer]: 'Destroyer',
  [UnitType.Submarine]: 'Submarine', [UnitType.Battleship]: 'Battleship', [UnitType.Carrier]: 'Carrier',
  [UnitType.Fighter]: 'Fighter', [UnitType.Missile]: 'Missile',
};

// ── Main component ────────────────────────────────────────────

interface ReplayViewerProps {
  onBack: () => void;
  initialId?: string;
}

export function ReplayViewer({ onBack, initialId }: ReplayViewerProps) {
  const [metas, setMetas] = useState<ReplayMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [frameIdx, setFrameIdx] = useState(0);

  // Use same origin as page (works for both replay server on 4001 and game server on 4000)
  const serverOrigin = window.location.origin;

  useEffect(() => {
    fetch(`${serverOrigin}/api/replays`)
      .then((r) => r.json())
      .then((data) => {
        setMetas(data.replays ?? []);
        // Auto-load if initialId provided
        if (initialId) loadReplay(initialId);
      })
      .catch(() => setError('Could not connect to server. Is it running?'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOrigin, initialId]);

  async function loadReplay(id: string) {
    setLoading(true);
    setError('');
    try {
      const r = await fetch(`${serverOrigin}/api/replays/${id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: ReplayData = await r.json();
      // Normalise: replay.mapWidth/Height might be in meta
      if (!data.mapWidth) (data as any).mapWidth = data.meta.mapWidth;
      if (!data.mapHeight) (data as any).mapHeight = data.meta.mapHeight;
      setReplay(data);
      setFrameIdx(0);
    } catch (e: unknown) {
      setError(`Failed to load: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  const currentCounts = useMemo(() => {
    if (!replay) return null;
    const frame = replay.frames[frameIdx];
    const counts: Record<UnitType, { p1: number; p2: number }> = {} as any;
    for (const t of UNIT_TYPES_ORDERED) counts[t] = { p1: 0, p2: 0 };
    for (const u of frame.units) {
      if (u.owner === 'player1') counts[u.type].p1++;
      else if (u.owner === 'player2') counts[u.type].p2++;
    }
    return counts;
  }, [replay, frameIdx]);

  const totalProduced = useMemo(() => {
    if (!replay) return null;
    const seen = new Set<string>();
    const counts: Record<UnitType, { p1: number; p2: number }> = {} as any;
    for (const t of UNIT_TYPES_ORDERED) counts[t] = { p1: 0, p2: 0 };
    for (let i = 0; i <= frameIdx; i++) {
      for (const u of replay.frames[i].units) {
        if (!seen.has(u.id)) {
          seen.add(u.id);
          if (u.owner === 'player1') counts[u.type].p1++;
          else if (u.owner === 'player2') counts[u.type].p2++;
        }
      }
    }
    return counts;
  }, [replay, frameIdx]);

  // Kill stats: kills by killer player against victim type
  // Computed by tracking when units disappear between frames
  const killStats = useMemo(() => {
    if (!replay) return null;
    // killsByKiller[killerOwner][victimType] = count
    const killsByKiller: { player1: Record<UnitType, number>; player2: Record<UnitType, number> } = {
      player1: {} as Record<UnitType, number>,
      player2: {} as Record<UnitType, number>,
    };
    for (const t of UNIT_TYPES_ORDERED) {
      (killsByKiller.player1 as any)[t] = 0;
      (killsByKiller.player2 as any)[t] = 0;
    }

    // Compare consecutive frames to find dead units
    for (let i = 1; i <= frameIdx; i++) {
      const prevFrame = replay.frames[i - 1];
      const currFrame = replay.frames[i];

      // Build set of units in current frame
      const currUnitIds = new Set(currFrame.units.map(u => u.id));

      // Check which units from previous frame are gone
      for (const u of prevFrame.units) {
        if (!currUnitIds.has(u.id)) {
          // Unit died between frames - attribute kill to enemy player
          const killerOwner = u.owner === 'player1' ? 'player2' : 'player1';
          killsByKiller[killerOwner][u.type]++;
        }
      }
    }

    return killsByKiller;
  }, [replay, frameIdx]);

  if (replay) {
    const frame = replay.frames[frameIdx];
    const total = replay.frames.length;
    const p1c = frame.cities.filter((c) => c.owner === 'player1').length;
    const p2c = frame.cities.filter((c) => c.owner === 'player2').length;
    const nc  = frame.cities.filter((c) => c.owner === null).length;
    const p1u = frame.units.filter((u) => u.owner === 'player1' && !u.carriedBy).length;
    const p2u = frame.units.filter((u) => u.owner === 'player2' && !u.carriedBy).length;

    return (
      <div className="h-screen bg-gray-950 flex flex-col overflow-hidden">
        <div className="flex items-center gap-4 px-4 py-2 bg-gray-900 border-b border-gray-700 text-white text-sm shrink-0 flex-wrap">
          <button className="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600" onClick={() => setReplay(null)}>← List</button>
          <button className="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600" onClick={onBack}>✕ Close</button>
          <span className="font-bold">Turn {frame.turn}</span>
          <span className="text-gray-400">
            <span style={{ color: COL_P1 }}>P1</span>: {p1c}c {p1u}u &nbsp;
            <span style={{ color: COL_P2 }}>P2</span>: {p2c}c {p2u}u &nbsp;
            neutral: {nc}
          </span>
          <span className="text-gray-500 font-mono text-xs ml-auto">{replay.meta?.id?.slice(0, 8)}</span>
          {frame.winner && (
            <span className="font-bold" style={{ color: frame.winner === 'player1' ? COL_P1 : COL_P2 }}>
              {frame.winner} wins!
            </span>
          )}
        </div>

        {currentCounts && totalProduced && killStats && (
          <div className="shrink-0 px-4 py-1 bg-gray-900 border-b border-gray-700 flex gap-8 text-xs">
            <table className="border-collapse">
              <thead>
                <tr>
                  <th className="text-gray-500 font-normal text-left pr-2 pb-0.5">Current</th>
                  <th className="px-2 pb-0.5" style={{ color: COL_P1 }}>P1</th>
                  <th className="px-2 pb-0.5" style={{ color: COL_P2 }}>P2</th>
                </tr>
              </thead>
              <tbody>
                {UNIT_TYPES_ORDERED.map((t) => (
                  <tr key={t}>
                    <td className="text-gray-400 pr-2">{UNIT_LABELS[t]}</td>
                    <td className="text-center px-2" style={{ color: COL_P1 }}>{currentCounts[t].p1 || ''}</td>
                    <td className="text-center px-2" style={{ color: COL_P2 }}>{currentCounts[t].p2 || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="border-collapse">
              <thead>
                <tr>
                  <th className="text-gray-500 font-normal text-left pr-2 pb-0.5">Produced</th>
                  <th className="px-2 pb-0.5" style={{ color: COL_P1 }}>P1</th>
                  <th className="px-2 pb-0.5" style={{ color: COL_P2 }}>P2</th>
                </tr>
              </thead>
              <tbody>
                {UNIT_TYPES_ORDERED.map((t) => (
                  <tr key={t}>
                    <td className="text-gray-400 pr-2">{UNIT_LABELS[t]}</td>
                    <td className="text-center px-2" style={{ color: COL_P1 }}>{totalProduced[t].p1 || ''}</td>
                    <td className="text-center px-2" style={{ color: COL_P2 }}>{totalProduced[t].p2 || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="border-collapse">
              <thead>
                <tr>
                  <th className="text-gray-500 font-normal text-left pr-2 pb-0.5">Kills by P1</th>
                  <th className="px-2 pb-0.5" style={{ color: COL_P1 }}>P1</th>
                </tr>
              </thead>
              <tbody>
                {UNIT_TYPES_ORDERED.map((t) => (
                  <tr key={t}>
                    <td className="text-gray-400 pr-2">{UNIT_LABELS[t]}</td>
                    <td className="text-center px-2" style={{ color: COL_P1 }}>{killStats.player1[t] || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="border-collapse">
              <thead>
                <tr>
                  <th className="text-gray-500 font-normal text-left pr-2 pb-0.5">Kills by P2</th>
                  <th className="px-2 pb-0.5" style={{ color: COL_P2 }}>P2</th>
                </tr>
              </thead>
              <tbody>
                {UNIT_TYPES_ORDERED.map((t) => (
                  <tr key={t}>
                    <td className="text-gray-400 pr-2">{UNIT_LABELS[t]}</td>
                    <td className="text-center px-2" style={{ color: COL_P2 }}>{killStats.player2[t] || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          <ReplayCanvas replay={replay} frame={frame} />
        </div>

        {/* Phase tracks and slider - table layout */}
        {replay.frames.length > 0 && (
          <div className="shrink-0 px-4 py-2 bg-gray-900 border-t border-gray-700">
            <table className="w-full border-collapse" style={{tableLayout: 'fixed'}}>
              <colgroup>
                <col style={{width: '80px'}} />
                <col style={{width: '100%'}} />
                <col style={{width: '120px'}} />
              </colgroup>
              <tbody>
                <tr>
                  <td className="text-xs font-bold align-top" style={{ color: COL_P1 }}>Player 1</td>
                  <td className="p-0 align-top">
                    <div className="w-full h-2 bg-gray-800 relative overflow-hidden">
                      <PhaseTrackBars frames={replay.frames} playerId="player1" color={COL_P1} />
                    </div>
                  </td>
                  <td></td>
                </tr>
                <tr>
                  <td className="text-xs font-bold align-top" style={{ color: COL_P2 }}>Player 2</td>
                  <td className="p-0 align-top">
                    <div className="w-full h-2 bg-gray-800 relative overflow-hidden">
                      <PhaseTrackBars frames={replay.frames} playerId="player2" color={COL_P2} />
                    </div>
                  </td>
                  <td></td>
                </tr>
                <tr>
                  <td className="text-center align-top">
                    <button className="w-8 h-8 px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 text-white text-sm disabled:opacity-40 flex items-center justify-center"
                      disabled={frameIdx === 0} onClick={() => setFrameIdx((i) => Math.max(0, i - 1))}>‹</button>
                  </td>
                  <td className="p-0 align-top">
                    <input type="range" min={0} max={total - 1} value={frameIdx}
                      onChange={(e) => setFrameIdx(Number(e.target.value))} className="w-full h-2" />
                  </td>
                  <td className="text-right align-top">
                    <div className="flex items-center justify-end gap-1">
                      <button className="w-8 h-8 px-2 py-1 bg-gray-700 rounded hover:bg-gray-600 text-white text-sm disabled:opacity-40 flex items-center justify-center"
                        disabled={frameIdx === total - 1} onClick={() => setFrameIdx((i) => Math.min(total - 1, i + 1))}>›</button>
                      <span className="text-gray-400 text-sm whitespace-nowrap">
                        Turn {frame.turn} ({frameIdx + 1}/{total})
                      </span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ── Listing view ──────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto mt-16 bg-gray-800 text-white rounded-lg p-6 space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold flex-1">Replay Viewer</h2>
        <button className="px-3 py-1 bg-gray-600 rounded hover:bg-gray-500 text-sm" onClick={onBack}>Back</button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {loading && <p className="text-gray-400 text-sm">Loading...</p>}

      {metas.length === 0 && !loading && !error && (
        <div className="text-gray-400 text-sm space-y-1">
          <p>No replays found.</p>
          <p>Run <code className="bg-gray-900 px-1 rounded">npm run replay</code> to record games.</p>
        </div>
      )}

      {metas.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 grid grid-cols-[1fr_6rem_6rem_8rem_8rem_6rem] gap-2 px-2">
            <span>ID</span><span>Recorded</span><span>Turns</span><span className="text-center" style={{color:COL_P1}}>P1 cities</span><span className="text-center" style={{color:COL_P2}}>P2 cities</span><span>Winner</span>
          </div>
          <div className="max-h-96 overflow-y-auto space-y-1">
            {metas.map((m) => (
              <button
                key={m.id}
                className="w-full text-left px-2 py-2 bg-gray-900 rounded hover:bg-gray-700 text-sm grid grid-cols-[1fr_6rem_6rem_8rem_8rem_6rem] gap-2 items-center"
                onClick={() => loadReplay(m.id)}
              >
                <span className="font-mono text-xs text-gray-400">{m.id.slice(0, 8)}</span>
                <span className="text-xs text-gray-400">{m.recordedAt.slice(5, 16).replace('T', ' ')}</span>
                <span>{m.turns}</span>
                <span className="text-center" style={{color:COL_P1}}>{m.p1Cities}</span>
                <span className="text-center" style={{color:COL_P2}}>{m.p2Cities}</span>
                <span className={m.winner ? 'font-semibold' : 'text-gray-500'} style={{color: m.winner === 'player1' ? COL_P1 : m.winner === 'player2' ? COL_P2 : undefined}}>
                  {m.winner ?? 'draw'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
