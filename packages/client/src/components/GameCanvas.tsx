import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import {
  type PlayerView,
  type UnitView,
  type CityView,
  type CombatResult,
  type Coord,
  TileVisibility,
  Terrain,
  UnitType,
  UnitDomain,
  UNIT_STATS,
  wrapX,
  wrappedDistX,
} from '@sc/shared';
import { useGameStore, DEFAULT_TILE_SIZE } from '../store/gameStore';
import { playAttackSound, playCityCaptureFanfare, playCrashSound } from '../sounds';

// ── Classic colour palette ───────────────────────────────────

const COL_OCEAN = '#0a2463';
const COL_OCEAN_ACCENT = '#0e3a7e';
const COL_LAND = '#3a7d44';
const COL_LAND_ACCENT = '#2d6636';
const COL_FOG = '#111122';
const COL_GRID = 'rgba(0,0,0,0.2)';

const COL_P1 = '#4a9eed';
const COL_P2 = '#ed4a4a';
const COL_NEUTRAL = '#aaa';
const COL_SELECTED_MY_TURN = '#ffd700';
const COL_SELECTED_NOT_MY_TURN = '#888888';

// ── Drawing helpers ──────────────────────────────────────────

function ownerColor(owner: string | null): string {
  if (owner === 'player1') return COL_P1;
  if (owner === 'player2') return COL_P2;
  return COL_NEUTRAL;
}

/** Draw a small filled star (city icon). */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const outerX = cx + r * Math.cos(angle);
    const outerY = cy + r * Math.sin(angle);
    ctx.lineTo(outerX, outerY);
    const innerAngle = angle + Math.PI / 5;
    const innerX = cx + r * 0.4 * Math.cos(innerAngle);
    const innerY = cy + r * 0.4 * Math.sin(innerAngle);
    ctx.lineTo(innerX, innerY);
  }
  ctx.closePath();
  ctx.fill();
}

/** Draw classic unit shapes programmatically. */
function drawUnitShape(
  ctx: CanvasRenderingContext2D,
  type: UnitType,
  cx: number,
  cy: number,
  size: number,
  color: string,
) {
  ctx.save();
  const r = size * 0.38;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, size / 12);
  ctx.globalAlpha = 1;

  switch (type) {
    case UnitType.Infantry: {
      // Stick-figure soldier with rifle
      const lw = Math.max(1.5, size / 10);
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      const headR = r * 0.18;
      const headY = cy - r * 0.55;
      const shoulderY = headY + headR + r * 0.08;
      const hipY = cy + r * 0.15;
      const footY = cy + r * 0.7;
      // Head
      ctx.beginPath();
      ctx.arc(cx, headY, headR, 0, 2 * Math.PI);
      ctx.fill();
      // Spine (neck to hip)
      ctx.beginPath();
      ctx.moveTo(cx, shoulderY);
      ctx.lineTo(cx, hipY);
      ctx.stroke();
      // Arms (angled outward from shoulders)
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.4, shoulderY + r * 0.3);
      ctx.lineTo(cx, shoulderY);
      ctx.lineTo(cx + r * 0.35, shoulderY + r * 0.35);
      ctx.stroke();
      // Legs (V shape from hip)
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.3, footY);
      ctx.lineTo(cx, hipY);
      ctx.lineTo(cx + r * 0.3, footY);
      ctx.stroke();
      // Rifle (from right hand going up past head)
      ctx.lineWidth = lw * 0.8;
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.35, shoulderY + r * 0.35);
      ctx.lineTo(cx + r * 0.15, headY - headR * 0.5);
      ctx.stroke();
      break;
    }
    case UnitType.Tank: {
      // Side-profile tank: tracks on bottom, hull, turret + barrel on top
      const hw = r * 0.9;
      const hh = r * 0.35;
      const trackY = cy + r * 0.25;
      // Tracks (dark rounded rectangle at bottom)
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.4;
      const trackH = r * 0.3;
      ctx.beginPath();
      ctx.roundRect(cx - hw, trackY, hw * 2, trackH, trackH * 0.4);
      ctx.fill();
      // Track wheels (small circles)
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#fff';
      const wheelR = trackH * 0.25;
      for (let i = 0; i < 4; i++) {
        const wx = cx - hw * 0.7 + (i * hw * 1.4) / 3;
        ctx.beginPath();
        ctx.arc(wx, trackY + trackH * 0.5, wheelR, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      // Hull body (trapezoid sitting on tracks)
      const hullTop = trackY - hh * 1.6;
      ctx.beginPath();
      ctx.moveTo(cx - hw, trackY);
      ctx.lineTo(cx - hw * 0.75, hullTop);
      ctx.lineTo(cx + hw * 0.85, hullTop);
      ctx.lineTo(cx + hw, trackY);
      ctx.closePath();
      ctx.fill();
      // Turret (smaller rectangle on top-left of hull)
      const turretW = hw * 0.7;
      const turretH = hh * 0.9;
      const turretLeft = cx - hw * 0.35;
      const turretTop = hullTop - turretH;
      ctx.fillRect(turretLeft, turretTop, turretW, turretH);
      // Gun barrel (extends right from turret)
      const barrelH = turretH * 0.3;
      const barrelY = turretTop + turretH * 0.35;
      ctx.fillRect(turretLeft + turretW, barrelY, hw * 0.65, barrelH);
      break;
    }
    case UnitType.Fighter: {
      // Top-down fighter jet: pointed nose, swept wings, tail fins
      ctx.beginPath();
      // Fuselage
      ctx.moveTo(cx, cy - r);               // nose
      ctx.lineTo(cx + r * 0.15, cy - r * 0.2);
      // Right wing
      ctx.lineTo(cx + r, cy + r * 0.1);
      ctx.lineTo(cx + r * 0.8, cy + r * 0.35);
      ctx.lineTo(cx + r * 0.15, cy + r * 0.15);
      // Right tail fin
      ctx.lineTo(cx + r * 0.15, cy + r * 0.55);
      ctx.lineTo(cx + r * 0.45, cy + r);
      ctx.lineTo(cx + r * 0.3, cy + r);
      ctx.lineTo(cx, cy + r * 0.7);
      // Left tail fin (mirror)
      ctx.lineTo(cx - r * 0.3, cy + r);
      ctx.lineTo(cx - r * 0.45, cy + r);
      ctx.lineTo(cx - r * 0.15, cy + r * 0.55);
      ctx.lineTo(cx - r * 0.15, cy + r * 0.15);
      // Left wing
      ctx.lineTo(cx - r * 0.8, cy + r * 0.35);
      ctx.lineTo(cx - r, cy + r * 0.1);
      ctx.lineTo(cx - r * 0.15, cy - r * 0.2);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case UnitType.Bomber: {
      // Top-down heavy bomber: wide straight wings, fat fuselage, twin tail
      ctx.beginPath();
      // Nose (rounded)
      ctx.moveTo(cx - r * 0.2, cy - r * 0.7);
      ctx.quadraticCurveTo(cx, cy - r, cx + r * 0.2, cy - r * 0.7);
      // Right fuselage to wing
      ctx.lineTo(cx + r * 0.2, cy - r * 0.15);
      ctx.lineTo(cx + r * 1.1, cy - r * 0.05);  // right wingtip
      ctx.lineTo(cx + r * 1.1, cy + r * 0.2);
      ctx.lineTo(cx + r * 0.2, cy + r * 0.15);
      // Right tail
      ctx.lineTo(cx + r * 0.2, cy + r * 0.6);
      ctx.lineTo(cx + r * 0.5, cy + r);
      ctx.lineTo(cx + r * 0.35, cy + r);
      ctx.lineTo(cx, cy + r * 0.75);
      // Left tail (mirror)
      ctx.lineTo(cx - r * 0.35, cy + r);
      ctx.lineTo(cx - r * 0.5, cy + r);
      ctx.lineTo(cx - r * 0.2, cy + r * 0.6);
      // Left wing
      ctx.lineTo(cx - r * 0.2, cy + r * 0.15);
      ctx.lineTo(cx - r * 1.1, cy + r * 0.2);
      ctx.lineTo(cx - r * 1.1, cy - r * 0.05);
      ctx.lineTo(cx - r * 0.2, cy - r * 0.15);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case UnitType.Transport: {
      // Classic side-profile transport ship: hull, bridge at far stern, smokestack, cargo holds
      const hw = r * 0.95;
      const hullTop = cy - r * 0.1;
      const waterline = cy + r * 0.2;
      const hullBottom = cy + r * 0.55;
      // Hull
      ctx.beginPath();
      ctx.moveTo(cx - hw, hullTop);
      ctx.lineTo(cx + hw * 0.6, hullTop);
      ctx.lineTo(cx + hw, waterline);
      ctx.lineTo(cx + hw * 0.85, hullBottom);
      ctx.lineTo(cx - hw * 0.8, hullBottom);
      ctx.lineTo(cx - hw, waterline);
      ctx.closePath();
      ctx.fill();
      // Waterline stripe
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = Math.max(1, size / 14);
      ctx.beginPath();
      ctx.moveTo(cx - hw, waterline);
      ctx.lineTo(cx + hw, waterline);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Bridge at far stern
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.35;
      const bridgeW = hw * 0.3;
      const bridgeH = r * 0.45;
      ctx.fillRect(cx - hw + hw * 0.05, hullTop - bridgeH, bridgeW, bridgeH);
      // Smokestack on bridge
      const stackW = hw * 0.1;
      const stackH = r * 0.3;
      ctx.fillRect(cx - hw + hw * 0.12, hullTop - bridgeH - stackH, stackW, stackH);
      // Cargo hold hatches (three along deck)
      ctx.globalAlpha = 0.25;
      const hatchW = hw * 0.2;
      const hatchH = r * 0.13;
      ctx.fillRect(cx - hw * 0.2, hullTop - hatchH * 0.8, hatchW, hatchH);
      ctx.fillRect(cx + hw * 0.1, hullTop - hatchH * 0.8, hatchW, hatchH);
      ctx.fillRect(cx + hw * 0.38, hullTop - hatchH * 0.8, hatchW * 0.8, hatchH);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Destroyer: {
      // Side-profile destroyer: sleek fast warship, single gun turret fore
      const dhw = r * 0.9;
      const dhullTop = cy - r * 0.05;
      const dwl = cy + r * 0.2;
      const dkeel = cy + r * 0.45;
      // Hull
      ctx.beginPath();
      ctx.moveTo(cx - dhw, dhullTop);                   // stern
      ctx.lineTo(cx + dhw * 0.65, dhullTop);            // deck
      ctx.lineTo(cx + dhw, dwl);                        // bow point
      ctx.lineTo(cx + dhw * 0.8, dkeel);                // bow under
      ctx.lineTo(cx - dhw * 0.75, dkeel);               // keel
      ctx.lineTo(cx - dhw, dwl);                        // stern under
      ctx.closePath();
      ctx.fill();
      // Waterline
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = Math.max(1, size / 16);
      ctx.beginPath();
      ctx.moveTo(cx - dhw, dwl);
      ctx.lineTo(cx + dhw, dwl);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Bridge (small block aft of center)
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.35;
      ctx.fillRect(cx - dhw * 0.3, dhullTop - r * 0.35, dhw * 0.35, r * 0.35);
      // Mast
      ctx.fillRect(cx - dhw * 0.12, dhullTop - r * 0.6, dhw * 0.06, r * 0.25);
      // Fore gun turret
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(cx + dhw * 0.3, dhullTop - r * 0.05, r * 0.1, 0, 2 * Math.PI);
      ctx.fill();
      // Gun barrel
      ctx.fillRect(cx + dhw * 0.3, dhullTop - r * 0.08, dhw * 0.3, r * 0.06);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Submarine: {
      // Side-profile submarine: cigar hull with conning tower (sail)
      const shw = r * 0.9;
      const shullMid = cy + r * 0.15;
      const shullH = r * 0.28;
      // Hull (elongated ellipse)
      ctx.beginPath();
      ctx.moveTo(cx + shw, shullMid);                           // bow tip
      ctx.quadraticCurveTo(cx + shw * 0.3, shullMid - shullH, cx - shw * 0.7, shullMid - shullH * 0.8);
      ctx.lineTo(cx - shw, shullMid);                           // stern
      ctx.lineTo(cx - shw * 0.7, shullMid + shullH * 0.8);
      ctx.quadraticCurveTo(cx + shw * 0.3, shullMid + shullH, cx + shw, shullMid);
      ctx.closePath();
      ctx.fill();
      // Conning tower (sail)
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.35;
      const sailW = shw * 0.25;
      const sailH = r * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx - sailW * 0.3, shullMid - shullH * 0.7);
      ctx.lineTo(cx - sailW * 0.1, shullMid - shullH * 0.7 - sailH);
      ctx.lineTo(cx + sailW, shullMid - shullH * 0.7 - sailH * 0.7);
      ctx.lineTo(cx + sailW, shullMid - shullH * 0.7);
      ctx.closePath();
      ctx.fill();
      // Periscope (thin line up from sail)
      ctx.fillRect(cx + sailW * 0.3, shullMid - shullH * 0.7 - sailH - r * 0.15, sailW * 0.1, r * 0.15);
      // Stern planes (small fins at back)
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.moveTo(cx - shw, shullMid);
      ctx.lineTo(cx - shw * 0.85, shullMid - shullH * 1.1);
      ctx.lineTo(cx - shw * 0.7, shullMid);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - shw, shullMid);
      ctx.lineTo(cx - shw * 0.85, shullMid + shullH * 1.1);
      ctx.lineTo(cx - shw * 0.7, shullMid);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Carrier: {
      // Side-profile aircraft carrier: very flat deck, shallow hull, small island
      const chw = r * 0.95;
      const cDeck = cy + r * 0.05;
      const cwl = cy + r * 0.25;
      const ckeel = cy + r * 0.45;
      // Hull (very shallow)
      ctx.beginPath();
      ctx.moveTo(cx - chw, cDeck);
      ctx.lineTo(cx + chw * 0.8, cDeck);
      ctx.lineTo(cx + chw, cDeck + r * 0.05);
      ctx.lineTo(cx + chw * 0.9, ckeel);
      ctx.lineTo(cx - chw * 0.85, ckeel);
      ctx.lineTo(cx - chw, cwl);
      ctx.closePath();
      ctx.fill();
      // Flight deck line
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = Math.max(1, size / 14);
      ctx.beginPath();
      ctx.moveTo(cx - chw, cDeck);
      ctx.lineTo(cx + chw * 0.8, cDeck);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Small island superstructure
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.4;
      const islandW = chw * 0.15;
      const islandH = r * 0.35;
      ctx.fillRect(cx - chw * 0.1, cDeck - islandH, islandW, islandH);
      // Mast on island
      ctx.fillRect(cx - chw * 0.04, cDeck - islandH - r * 0.18, islandW * 0.2, r * 0.18);
      // Deck marking lines
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, size / 18);
      ctx.beginPath();
      ctx.moveTo(cx + chw * 0.65, cDeck - r * 0.01);
      ctx.lineTo(cx - chw * 0.6, cDeck - r * 0.01);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Battleship: {
      // Side-profile battleship: heavy hull, large superstructure, two turrets
      const bhw = r * 0.95;
      const bhullTop = cy - r * 0.05;
      const bwl = cy + r * 0.22;
      const bkeel = cy + r * 0.55;
      // Hull
      ctx.beginPath();
      ctx.moveTo(cx - bhw, bhullTop);
      ctx.lineTo(cx + bhw * 0.6, bhullTop);
      ctx.lineTo(cx + bhw, bwl);
      ctx.lineTo(cx + bhw * 0.85, bkeel);
      ctx.lineTo(cx - bhw * 0.8, bkeel);
      ctx.lineTo(cx - bhw, bwl);
      ctx.closePath();
      ctx.fill();
      // Waterline
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = Math.max(1, size / 14);
      ctx.beginPath();
      ctx.moveTo(cx - bhw, bwl);
      ctx.lineTo(cx + bhw, bwl);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Large superstructure (wide, tall central block)
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.35;
      const btowerW = bhw * 0.4;
      const btowerH = r * 0.5;
      ctx.fillRect(cx - btowerW * 0.5, bhullTop - btowerH, btowerW, btowerH);
      // Upper bridge (smaller block on top of superstructure)
      const ubW = btowerW * 0.6;
      const ubH = r * 0.25;
      ctx.fillRect(cx - ubW * 0.5, bhullTop - btowerH - ubH, ubW, ubH);
      // Mast
      ctx.fillRect(cx - ubW * 0.08, bhullTop - btowerH - ubH - r * 0.2, ubW * 0.12, r * 0.2);
      // Smokestack (behind superstructure)
      ctx.fillRect(cx - bhw * 0.35, bhullTop - r * 0.4, bhw * 0.15, r * 0.4);
      // Second smokestack
      ctx.fillRect(cx - bhw * 0.48, bhullTop - r * 0.32, bhw * 0.1, r * 0.32);
      // Fore turret
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(cx + bhw * 0.3, bhullTop - r * 0.05, r * 0.13, 0, 2 * Math.PI);
      ctx.fill();
      // Fore gun barrels
      ctx.fillRect(cx + bhw * 0.3, bhullTop - r * 0.1, bhw * 0.35, r * 0.04);
      ctx.fillRect(cx + bhw * 0.3, bhullTop - r * 0.02, bhw * 0.35, r * 0.04);
      // Aft turret
      ctx.beginPath();
      ctx.arc(cx - bhw * 0.6, bhullTop - r * 0.05, r * 0.12, 0, 2 * Math.PI);
      ctx.fill();
      // Aft gun barrels
      ctx.fillRect(cx - bhw * 0.9, bhullTop - r * 0.08, bhw * 0.3, r * 0.03);
      ctx.fillRect(cx - bhw * 0.9, bhullTop - r * 0.01, bhw * 0.3, r * 0.03);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
  }
  ctx.restore();
}

/** Draw an ice-cap tile: white base with a jagged black mountain range silhouette. */
function drawIceCap(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  south: boolean,
) {
  // White base
  ctx.fillStyle = '#e8eaf0';
  ctx.fillRect(x, y, size, size);

  // Mountain silhouette
  ctx.fillStyle = '#2a2a3a';
  ctx.beginPath();
  if (south) {
    // Mountains grow upward from bottom edge (south pole, peaks point up)
    const base = y + size;
    ctx.moveTo(x, base);
    ctx.lineTo(x, base - size * 0.3);
    ctx.lineTo(x + size * 0.15, base - size * 0.55);
    ctx.lineTo(x + size * 0.25, base - size * 0.35);
    ctx.lineTo(x + size * 0.38, base - size * 0.7);
    ctx.lineTo(x + size * 0.5, base - size * 0.4);
    ctx.lineTo(x + size * 0.62, base - size * 0.65);
    ctx.lineTo(x + size * 0.75, base - size * 0.3);
    ctx.lineTo(x + size * 0.85, base - size * 0.5);
    ctx.lineTo(x + size, base - size * 0.25);
    ctx.lineTo(x + size, base);
  } else {
    // Mountains grow downward from top edge (north pole, peaks point down)
    const base = y;
    ctx.moveTo(x, base);
    ctx.lineTo(x, base + size * 0.3);
    ctx.lineTo(x + size * 0.15, base + size * 0.55);
    ctx.lineTo(x + size * 0.25, base + size * 0.35);
    ctx.lineTo(x + size * 0.38, base + size * 0.7);
    ctx.lineTo(x + size * 0.5, base + size * 0.4);
    ctx.lineTo(x + size * 0.62, base + size * 0.65);
    ctx.lineTo(x + size * 0.75, base + size * 0.3);
    ctx.lineTo(x + size * 0.85, base + size * 0.5);
    ctx.lineTo(x + size, base + size * 0.25);
    ctx.lineTo(x + size, base);
  }
  ctx.closePath();
  ctx.fill();

  // Snow highlights on peaks
  ctx.fillStyle = '#fff';
  if (south) {
    const base = y + size;
    const peakH = size * 0.12;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.38 - size * 0.06, base - size * 0.7 + peakH);
    ctx.lineTo(x + size * 0.38, base - size * 0.7);
    ctx.lineTo(x + size * 0.38 + size * 0.06, base - size * 0.7 + peakH);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + size * 0.62 - size * 0.05, base - size * 0.65 + peakH);
    ctx.lineTo(x + size * 0.62, base - size * 0.65);
    ctx.lineTo(x + size * 0.62 + size * 0.05, base - size * 0.65 + peakH);
    ctx.closePath();
    ctx.fill();
  } else {
    const base = y;
    const peakH = size * 0.12;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.38 - size * 0.06, base + size * 0.7 - peakH);
    ctx.lineTo(x + size * 0.38, base + size * 0.7);
    ctx.lineTo(x + size * 0.38 + size * 0.06, base + size * 0.7 - peakH);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + size * 0.62 - size * 0.05, base + size * 0.65 - peakH);
    ctx.lineTo(x + size * 0.62, base + size * 0.65);
    ctx.lineTo(x + size * 0.62 + size * 0.05, base + size * 0.65 - peakH);
    ctx.closePath();
    ctx.fill();
  }
}

// ── Component ────────────────────────────────────────────────

interface Props {
  view: PlayerView;
  onCityClick?: (city: CityView) => void;
  selectedCityId?: string | null;
}

export function GameCanvas({ view, onCityClick, selectedCityId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sendAction = useGameStore((s) => s.sendAction);
  const selectedUnitId = useGameStore((s) => s.selectedUnitId);
  const selectUnit = useGameStore((s) => s.selectUnit);
  const playerId = useGameStore((s) => s.playerId);
  // We don't subscribe to camera/zoom state here to avoid high-frequency re-renders during panning.
  // Instead, we read them directly from the store in the draw/event handlers.
  const setCamera = useGameStore((s) => s.setCamera);
  const setTileSize = useGameStore((s) => s.setTileSize);

  const lastActionResult = useGameStore((s) => s.lastActionResult);

  const mapW = view.tiles[0]?.length ?? 0;
  const mapH = view.tiles.length;

  // Drag state (not in store – ephemeral)
  const dragRef = useRef<{ dragging: boolean; lastX: number; lastY: number }>({
    dragging: false,
    lastX: 0,
    lastY: 0,
  });

  // ── Combat animation state ─────────────────────────────────
  interface CombatAnim {
    attackerUnitId: string;
    attackerType: UnitType;
    attackerOwner: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    progress: number;      // 0→1 over the animation
    startTime: number;
    result: CombatResult | null;  // filled once server responds
    phase: 'waiting' | 'clashing' | 'flash' | 'done';
  }
  interface BomberBlastAnim {
    centerX: number;       // tile coords
    centerY: number;
    radius: number;        // blast radius in tiles (0, 1, or 2)
    progress: number;      // 0→1
    startTime: number;
    phase: 'expanding' | 'fading' | 'done';
  }
  const combatAnimRef = useRef<CombatAnim | null>(null);
  const bomberBlastRef = useRef<BomberBlastAnim | null>(null);
  const pendingCombatRef = useRef<{ unitId: string; type: UnitType; owner: string; fromX: number; fromY: number; toX: number; toY: number } | null>(null);
  const animFrameRef = useRef<number>(0);
  const [, forceRender] = useState(0);

  // Flame hit indicators: shown on units that were hit in combat
  interface FlameHit {
    x: number;
    y: number;
    startTime: number;
  }
  const flameHitsRef = useRef<FlameHit[]>([]);
  const FLAME_DURATION = 2000;

  // Move animation for multi-tile paths
  interface MoveAnim {
    unitId: string;
    unitType: UnitType;
    unitOwner: string;
    pathTiles: Coord[]; // index 0 = start position
    startTime: number;
    sentCount: number; // how many MOVE actions already sent
  }
  const moveAnimRef = useRef<MoveAnim | null>(null);
  const MOVE_STEP_DURATION = 333; // ms per tile

  // ── Pre-calculations ──────────────────────────────────────
  const redrawRequestedRef = useRef<number | null>(null);

  const cityByPos = useMemo(() => {
    const map = new Map<string, CityView>();
    const allCities = [...view.myCities, ...view.visibleEnemyCities];
    for (const c of allCities) map.set(`${c.x},${c.y}`, c);
    return map;
  }, [view]);

  // We can't useMemo for unitsByPos easily because of the animation dependencies,
  // but we can pre-calculate the base unit set to avoid per-frame spreads.
  const cachedAllUnits = useMemo(() => [...view.myUnits, ...view.visibleEnemyUnits], [view]);

  // Duration constants (ms)
  const CLASH_DURATION = 500;
  const FLASH_DURATION = 200;
  const BLAST_EXPAND_DURATION = 800;
  const BLAST_FADE_DURATION = 600;

  // ── Convert screen pixel to tile coord (cylindrical) ──────
  const screenToTile = useCallback(
    (screenX: number, screenY: number): { tx: number; ty: number } | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const { cameraX, cameraY, tileSize } = useGameStore.getState();
      const rect = canvas.getBoundingClientRect();
      const pixelX = screenX - rect.left;
      const pixelY = screenY - rect.top;
      const canvasW = canvas.width;
      const canvasH = canvas.height;

      // Camera centre in pixels
      const camPx = cameraX * tileSize;
      const camPy = cameraY * tileSize;

      // Top-left corner world pixel
      const originX = camPx - canvasW / 2;
      const originY = camPy - canvasH / 2;

      const worldX = originX + pixelX;
      const worldY = originY + pixelY;

      const tx = wrapX(Math.floor(worldX / tileSize), mapW);
      const ty = Math.floor(worldY / tileSize);

      if (ty < 0 || ty >= mapH) return null;
      return { tx, ty };
    },
    [mapW, mapH],
  );

  // ── Draw ───────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { cameraX, cameraY, tileSize } = useGameStore.getState();

    const canvasW = canvas.width / (window.devicePixelRatio || 1);
    const canvasH = canvas.height / (window.devicePixelRatio || 1);

    // Camera centre in pixels
    const camPx = cameraX * tileSize;
    const camPy = cameraY * tileSize;

    // World-pixel origin of the viewport
    const originX = camPx - canvasW / 2;
    const originY = camPy - canvasH / 2;

    // Range of tiles visible (with guards against invalid tile sizes)
    const effectiveTileSize = Math.max(1, tileSize);
    const startTileX = Math.floor(originX / effectiveTileSize);
    const endTileX = Math.ceil((originX + canvasW) / effectiveTileSize);
    const startTileY = Math.max(0, Math.floor(originY / effectiveTileSize));
    const endTileY = Math.min(mapH - 1, Math.ceil((originY + canvasH) / effectiveTileSize));

    // Security check: prevent infinite or massive loops if something goes wrong
    if (endTileX - startTileX > 2000 || endTileY - startTileY > 2000) return;

    // Clear
    ctx.fillStyle = COL_FOG;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // ── Tiles ──
    for (let wy = startTileY; wy <= endTileY; wy++) {
      for (let wx = startTileX; wx <= endTileX; wx++) {
        const tx = wrapX(wx, mapW); // handles negative and >mapW
        const tile = view.tiles[wy]?.[tx];
        if (!tile) continue;

        const screenPx = wx * tileSize - originX;
        const screenPy = wy * tileSize - originY;

        if (tile.visibility === TileVisibility.Hidden) {
          ctx.fillStyle = COL_FOG;
        } else if (tile.terrain === Terrain.Ocean) {
          // Subtle checkerboard for water
          ctx.fillStyle = (tx + wy) % 2 === 0 ? COL_OCEAN : COL_OCEAN_ACCENT;
        } else {
          ctx.fillStyle = (tx + wy) % 2 === 0 ? COL_LAND : COL_LAND_ACCENT;
        }

        if (tile.visibility === TileVisibility.Seen) {
          ctx.globalAlpha = 0.5;
        }

        ctx.fillRect(screenPx, screenPy, tileSize, tileSize);
        ctx.globalAlpha = 1;

        // Ice caps at north (y=0) and south (y=mapH-1) borders
        if (tile.visibility !== TileVisibility.Hidden && (wy === 0 || wy === mapH - 1)) {
          ctx.save();
          if (tile.visibility === TileVisibility.Seen) ctx.globalAlpha = 0.5;
          drawIceCap(ctx, screenPx, screenPy, tileSize, wy === mapH - 1);
          ctx.restore();
        }

        // Grid
        if (tileSize >= 12) {
          ctx.strokeStyle = COL_GRID;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(screenPx, screenPy, tileSize, tileSize);
        }
      }
    }

    // ── Build lookup sets for quick coordinate testing ──
    const anim = combatAnimRef.current;
    const unitsByPos = new Map<string, UnitView[]>();
    for (const u of cachedAllUnits) {
      if (u.carriedBy) continue;
      // During animation, skip the attacker from the normal position list
      if (anim && anim.phase !== 'done' && u.id === anim.attackerUnitId) continue;
      // During move animation, skip the unit
      const mAnim = moveAnimRef.current;
      if (mAnim && u.id === mAnim.unitId) continue;
      const key = `${u.x},${u.y}`;
      let arr = unitsByPos.get(key);
      if (!arr) {
        arr = [];
        unitsByPos.set(key, arr);
      }
      arr.push(u);
    }

    // ── Cities & Units (draw on every wrapped copy visible) ──
    for (let wy = startTileY; wy <= endTileY; wy++) {
      for (let wx = startTileX; wx <= endTileX; wx++) {
        const tx = wrapX(wx, mapW);
        const screenPx = wx * tileSize - originX;
        const screenPy = wy * tileSize - originY;
        const cxCenter = screenPx + tileSize / 2;
        const cyCenter = screenPy + tileSize / 2;
        const key = `${tx},${wy}`;

        // Visibility check
        const tile = view.tiles[wy]?.[tx];
        if (!tile || tile.visibility === TileVisibility.Hidden) continue;

        const dimmed = tile.visibility === TileVisibility.Seen;

        // City
        const city = cityByPos.get(key);
        if (city) {
          if (dimmed) ctx.globalAlpha = 0.5;
          // City background square
          const pad = tileSize * 0.12;
          ctx.fillStyle = ownerColor(city.owner);
          ctx.fillRect(screenPx + pad, screenPy + pad, tileSize - 2 * pad, tileSize - 2 * pad);
          // Star
          drawStar(ctx, cxCenter, cyCenter, tileSize * 0.3, '#fff');
          ctx.globalAlpha = 1;

          // Purple highlight for selected city
          if (selectedCityId && city.id === selectedCityId) {
            ctx.strokeStyle = '#a855f7';
            ctx.lineWidth = Math.max(2, tileSize / 8);
            ctx.strokeRect(screenPx + 1, screenPy + 1, tileSize - 2, tileSize - 2);
          }
        }

        // Unit (top one only)
        const units = unitsByPos.get(key);
        if (units && units.length > 0) {
          const unit = units[0];
          if (dimmed) ctx.globalAlpha = 0.5;

          drawUnitShape(ctx, unit.type, cxCenter, cyCenter, tileSize, ownerColor(unit.owner));

          // Cargo count for carriers/transports (white number, top-left)
          if (
            (unit.type === UnitType.Carrier || unit.type === UnitType.Transport) &&
            unit.cargo.length > 0 &&
            tileSize >= 14
          ) {
            ctx.fillStyle = '#fff';
            ctx.font = `bold ${Math.max(8, tileSize * 0.3)}px sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`${unit.cargo.length}`, screenPx + 2, screenPy + 1);
          }

          // Damage indicator for capital ships (BB/CV with health < max)
          if (
            (unit.type === UnitType.Battleship || unit.type === UnitType.Carrier) &&
            unit.health < UNIT_STATS[unit.type].maxHealth &&
            tileSize >= 10
          ) {
            const flameR = Math.max(2, tileSize * 0.12);
            const fx = screenPx + tileSize * 0.75;
            const fy = screenPy + tileSize * 0.2;
            // Orange flame
            ctx.fillStyle = '#ff6600';
            ctx.beginPath();
            ctx.arc(fx, fy, flameR, 0, 2 * Math.PI);
            ctx.fill();
            // Yellow center
            ctx.fillStyle = '#ffcc00';
            ctx.beginPath();
            ctx.arc(fx, fy, flameR * 0.5, 0, 2 * Math.PI);
            ctx.fill();
          }

          // Stack indicator
          if (units.length > 1 && tileSize >= 14) {
            ctx.fillStyle = '#fff';
            ctx.font = `bold ${Math.max(8, tileSize * 0.3)}px sans-serif`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillText(`${units.length}`, screenPx + tileSize - 2, screenPy + 1);
          }

          // Health bar (own units only, if damaged)
          if (unit.owner === playerId && unit.health < 10 && tileSize >= 10) {
            const barW = tileSize - 4;
            const barH = Math.max(2, tileSize / 8);
            const barX = screenPx + 2;
            const barY = screenPy + tileSize - barH - 1;
            ctx.fillStyle = '#333';
            ctx.fillRect(barX, barY, barW, barH);
            ctx.fillStyle = unit.health > 5 ? '#2ecc71' : unit.health > 2 ? '#f39c12' : '#e74c3c';
            ctx.fillRect(barX, barY, barW * (unit.health / 10), barH);
          }

          ctx.globalAlpha = 1;
        }
      }
    }

    // ── Selection highlight (drawn after all tiles so it's always on top) ──
    if (selectedUnitId) {
      const selUnit = [...view.myUnits, ...view.visibleEnemyUnits].find((u) => u.id === selectedUnitId);
      if (selUnit) {
        // Use the parent's position if carried
        let sx = selUnit.x;
        let sy = selUnit.y;
        if (selUnit.carriedBy) {
          const parent = [...view.myUnits, ...view.visibleEnemyUnits].find((u) => u.id === selUnit.carriedBy);
          if (parent) { sx = parent.x; sy = parent.y; }
        }
        const isMyTurn = view.currentPlayer === playerId;
        const hlColor = isMyTurn ? COL_SELECTED_MY_TURN : COL_SELECTED_NOT_MY_TURN;
        // Draw on every wrapped copy visible
        for (let wx = startTileX; wx <= endTileX; wx++) {
          if (wrapX(wx, mapW) !== sx) continue;
          if (sy < startTileY || sy > endTileY) continue;
          const px = wx * tileSize - originX;
          const py = sy * tileSize - originY;
          ctx.strokeStyle = hlColor;
          ctx.lineWidth = Math.max(2, tileSize / 8);
          ctx.strokeRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
        }
      }
    }

    // ── Combat animation overlay ──────────────────────────────
    const combatAnim = combatAnimRef.current;
    if (combatAnim && combatAnim.phase !== 'done') {
      const fromSX = combatAnim.fromX * tileSize - originX + tileSize / 2;
      const fromSY = combatAnim.fromY * tileSize - originY + tileSize / 2;
      const toSX = combatAnim.toX * tileSize - originX + tileSize / 2;
      const toSY = combatAnim.toY * tileSize - originY + tileSize / 2;

      if (combatAnim.phase === 'clashing') {
        // Oscillating bounce toward target: 3 oscillations, max 50% travel
        const oscillations = 3;
        const maxTravel = 0.5;
        const envelope = Math.sin(combatAnim.progress * Math.PI);
        const bounce = Math.sin(combatAnim.progress * oscillations * 2 * Math.PI);
        const t = envelope * maxTravel * Math.max(0, bounce);
        const ax = fromSX + (toSX - fromSX) * t;
        const ay = fromSY + (toSY - fromSY) * t;
        drawUnitShape(ctx, combatAnim.attackerType, ax, ay, tileSize, ownerColor(combatAnim.attackerOwner));
      } else if (combatAnim.phase === 'flash') {
        // White flash burst at midpoint
        const mx = (fromSX + toSX) / 2;
        const my = (fromSY + toSY) / 2;
        const flashR = tileSize * (1 + combatAnim.progress * 0.5);
        ctx.globalAlpha = 1 - combatAnim.progress;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(mx, my, flashR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Draw attacker at final position if it survived and moved (defender destroyed)
        if (combatAnim.result && !combatAnim.result.attackerDestroyed) {
          const drawX = combatAnim.result.defenderDestroyed ? toSX : fromSX;
          const drawY = combatAnim.result.defenderDestroyed ? toSY : fromSY;
          drawUnitShape(ctx, combatAnim.attackerType, drawX, drawY, tileSize, ownerColor(combatAnim.attackerOwner));
        }
      }
    }

    // ── Bomber blast: mushroom cloud animation ───────────────
    const blast = bomberBlastRef.current;
    if (blast && blast.phase !== 'done') {
      const bSX = blast.centerX * tileSize - originX + tileSize / 2;
      const bSY = blast.centerY * tileSize - originY + tileSize / 2;
      const maxR = (blast.radius + 0.7) * tileSize;

      const p = blast.progress;
      const alpha = blast.phase === 'expanding'
        ? 0.6 + 0.3 * (1 - p)
        : 0.7 * (1 - p);
      ctx.save();
      ctx.globalAlpha = alpha;

      // Scale factor: grows during expanding, full during fading
      const scale = blast.phase === 'expanding' ? p : 1;

      // ── Stem ──
      const stemW = maxR * 0.25 * scale;
      const stemH = maxR * 1.4 * scale;
      const stemBottomY = bSY + maxR * 0.3;
      const stemTopY = stemBottomY - stemH;
      // Stem gradient (dark red-brown at base, orange-yellow at top)
      const stemGrad = ctx.createLinearGradient(bSX, stemBottomY, bSX, stemTopY);
      stemGrad.addColorStop(0, '#8B2500');
      stemGrad.addColorStop(0.5, '#cc4400');
      stemGrad.addColorStop(1, '#ff6600');
      ctx.fillStyle = stemGrad;
      ctx.beginPath();
      ctx.moveTo(bSX - stemW * 0.6, stemBottomY);
      ctx.quadraticCurveTo(bSX - stemW, stemTopY + stemH * 0.3, bSX - stemW * 0.3, stemTopY);
      ctx.lineTo(bSX + stemW * 0.3, stemTopY);
      ctx.quadraticCurveTo(bSX + stemW, stemTopY + stemH * 0.3, bSX + stemW * 0.6, stemBottomY);
      ctx.closePath();
      ctx.fill();

      // ── Mushroom cap ──
      const capCY = stemTopY;
      const capRX = maxR * 0.7 * scale;
      const capRY = maxR * 0.35 * scale;
      // Cap gradient (orange core → dark red edge)
      const capGrad = ctx.createRadialGradient(bSX, capCY, 0, bSX, capCY, capRX);
      capGrad.addColorStop(0, '#ffcc00');
      capGrad.addColorStop(0.3, '#ff6600');
      capGrad.addColorStop(0.7, '#cc2200');
      capGrad.addColorStop(1, '#660000');
      ctx.fillStyle = capGrad;
      ctx.beginPath();
      ctx.ellipse(bSX, capCY, capRX, capRY, 0, 0, Math.PI * 2);
      ctx.fill();

      // ── Bright fireball core ──
      const coreR = maxR * 0.2 * scale;
      ctx.globalAlpha = alpha * 0.9;
      const coreGrad = ctx.createRadialGradient(bSX, capCY, 0, bSX, capCY, coreR);
      coreGrad.addColorStop(0, '#ffffff');
      coreGrad.addColorStop(0.4, '#ffee88');
      coreGrad.addColorStop(1, 'rgba(255,102,0,0)');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(bSX, capCY, coreR, 0, Math.PI * 2);
      ctx.fill();

      // ── Base dust ring ──
      const ringR = maxR * 0.9 * scale;
      const ringRY = maxR * 0.15 * scale;
      ctx.globalAlpha = alpha * 0.4;
      ctx.fillStyle = '#aa4400';
      ctx.beginPath();
      ctx.ellipse(bSX, stemBottomY, ringR, ringRY, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    // ── Move animation overlay ────────────────────────────────
    const mAnim = moveAnimRef.current;
    if (mAnim) {
      const elapsed = performance.now() - mAnim.startTime;
      const totalSteps = mAnim.pathTiles.length - 1;
      const stepFloat = Math.min(elapsed / MOVE_STEP_DURATION, totalSteps);
      const stepIndex = Math.min(Math.floor(stepFloat), totalSteps - 1);
      const stepProgress = stepFloat - stepIndex;

      const from = mAnim.pathTiles[stepIndex];
      const to = mAnim.pathTiles[Math.min(stepIndex + 1, totalSteps)];

      // Handle wrap-around interpolation for X
      let toX = to.x;
      const dxRaw = toX - from.x;
      if (dxRaw > mapW / 2) toX -= mapW;
      else if (dxRaw < -mapW / 2) toX += mapW;

      const interpX = from.x + (toX - from.x) * stepProgress;
      const interpY = from.y + (to.y - from.y) * stepProgress;

      const sx = interpX * tileSize - originX + tileSize / 2;
      const sy = interpY * tileSize - originY + tileSize / 2;
      drawUnitShape(ctx, mAnim.unitType, sx, sy, tileSize, ownerColor(mAnim.unitOwner));
    }

    // ── Flame hit indicators ──────────────────────────────────
    const now = performance.now();
    for (const flame of flameHitsRef.current) {
      const elapsed = now - flame.startTime;
      if (elapsed > FLAME_DURATION) continue;
      const alpha = 1 - elapsed / FLAME_DURATION;
      const fSX = flame.x * tileSize - originX;
      const fSY = flame.y * tileSize - originY;
      const fs = tileSize * 0.6;
      const fx = fSX + tileSize * 0.2;
      const fy = fSY + tileSize * 0.1;

      ctx.save();
      ctx.globalAlpha = alpha;
      // Draw a simple flame shape
      ctx.fillStyle = '#ff4400';
      ctx.beginPath();
      ctx.moveTo(fx + fs * 0.5, fy);
      ctx.quadraticCurveTo(fx + fs * 0.8, fy + fs * 0.3, fx + fs * 0.6, fy + fs * 0.6);
      ctx.quadraticCurveTo(fx + fs * 0.7, fy + fs * 0.8, fx + fs * 0.5, fy + fs);
      ctx.quadraticCurveTo(fx + fs * 0.3, fy + fs * 0.8, fx + fs * 0.4, fy + fs * 0.6);
      ctx.quadraticCurveTo(fx + fs * 0.2, fy + fs * 0.3, fx + fs * 0.5, fy);
      ctx.fill();
      // Inner bright flame
      ctx.fillStyle = '#ffaa00';
      ctx.beginPath();
      ctx.moveTo(fx + fs * 0.5, fy + fs * 0.25);
      ctx.quadraticCurveTo(fx + fs * 0.65, fy + fs * 0.45, fx + fs * 0.55, fy + fs * 0.65);
      ctx.quadraticCurveTo(fx + fs * 0.5, fy + fs * 0.75, fx + fs * 0.45, fy + fs * 0.65);
      ctx.quadraticCurveTo(fx + fs * 0.35, fy + fs * 0.45, fx + fs * 0.5, fy + fs * 0.25);
      ctx.fill();
      ctx.restore();
    }
  }, [view, cachedAllUnits, cityByPos, selectedUnitId, selectedCityId, playerId, combatAnimRef]);

  /** Throttled draw call for input events */
  const requestRedraw = useCallback(() => {
    if (redrawRequestedRef.current !== null) return;
    redrawRequestedRef.current = requestAnimationFrame(() => {
      redrawRequestedRef.current = null;
      draw();
    });
  }, [draw]);

  /** Cleanup any pending redraw on unmount */
  useEffect(() => {
    return () => {
      if (redrawRequestedRef.current !== null) cancelAnimationFrame(redrawRequestedRef.current);
    };
  }, []);

  // ── Combat animation loop ──────────────────────────────────
  useEffect(() => {
    let running = true;

    function animLoop() {
      if (!running) return;
      let needsFrame = false;

      const anim = combatAnimRef.current;
      if (anim && anim.phase === 'clashing') {
        const elapsed = performance.now() - anim.startTime;
        anim.progress = Math.min(elapsed / CLASH_DURATION, 1);

        if (anim.progress >= 1) {
          // Transition to flash phase
          anim.phase = 'flash';
          anim.startTime = performance.now();
          anim.progress = 0;
        }
        needsFrame = true;
      } else if (anim && anim.phase === 'flash') {
        const elapsed = performance.now() - anim.startTime;
        anim.progress = Math.min(elapsed / FLASH_DURATION, 1);

        if (anim.progress >= 1) {
          anim.phase = 'done';
          combatAnimRef.current = null;
          forceRender((n) => n + 1);
        }
        needsFrame = true;
      }

      const blast = bomberBlastRef.current;
      if (blast && blast.phase === 'expanding') {
        const elapsed = performance.now() - blast.startTime;
        blast.progress = Math.min(elapsed / BLAST_EXPAND_DURATION, 1);
        if (blast.progress >= 1) {
          blast.phase = 'fading';
          blast.startTime = performance.now();
          blast.progress = 0;
        }
        needsFrame = true;
      } else if (blast && blast.phase === 'fading') {
        const elapsed = performance.now() - blast.startTime;
        blast.progress = Math.min(elapsed / BLAST_FADE_DURATION, 1);
        if (blast.progress >= 1) {
          blast.phase = 'done';
          bomberBlastRef.current = null;
          forceRender((n) => n + 1);
        }
        needsFrame = true;
      }

      // Clean up expired flame hits
      const fnow = performance.now();
      const activeFlames = flameHitsRef.current.filter((f) => fnow - f.startTime < FLAME_DURATION);
      if (activeFlames.length !== flameHitsRef.current.length) {
        flameHitsRef.current = activeFlames;
      }
      if (activeFlames.length > 0) needsFrame = true;

      // Progress move animation: send MOVE actions as each step completes
      const mAnim = moveAnimRef.current;
      if (mAnim) {
        const elapsed = fnow - mAnim.startTime;
        const totalSteps = mAnim.pathTiles.length - 1;
        const currentStep = Math.min(Math.floor(elapsed / MOVE_STEP_DURATION) + 1, totalSteps);

        // Send any unsent MOVE actions up to currentStep
        while (mAnim.sentCount < currentStep) {
          const step = mAnim.pathTiles[mAnim.sentCount + 1];
          sendAction({ type: 'MOVE', unitId: mAnim.unitId, to: step });
          mAnim.sentCount++;
        }

        if (elapsed >= totalSteps * MOVE_STEP_DURATION) {
          moveAnimRef.current = null;
          forceRender((n) => n + 1);
        } else {
          needsFrame = true;
        }
      }

      draw();
      if (needsFrame) {
        animFrameRef.current = requestAnimationFrame(animLoop);
      }
    }

    animLoop();
    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [draw]);

  // ── Kick off clash / bomber blast when actionResult arrives with combat ───
  useEffect(() => {
    if (!lastActionResult) return;
    const isMyTurn = view.currentPlayer === playerId;

    // City capture → trumpet fanfare
    if (lastActionResult.cityCaptured) {
      playCityCaptureFanfare();
    }

    // Fighter crash sound
    if (lastActionResult.fightersCrashed) {
      playCrashSound();
    }

    if (!lastActionResult.combat) return;
    const pending = pendingCombatRef.current;
    if (!pending) return;

    // Center camera on enemy attacks
    if (!isMyTurn) {
      const { setCamera } = useGameStore.getState();
      // Center on the combat location
      setCamera(pending.toX, pending.toY);
      // Also play sound for enemy attacks
      playAttackSound(pending.type);
    }

    // Cancel any in-progress move animation when combat starts
    moveAnimRef.current = null;

    // Bomber blast: skip normal clash, show expanding red circle
    if (lastActionResult.bomberBlastRadius !== undefined && lastActionResult.bomberBlastCenter) {
      const bc = lastActionResult.bomberBlastCenter;
      bomberBlastRef.current = {
        centerX: bc.x,
        centerY: bc.y,
        radius: lastActionResult.bomberBlastRadius,
        progress: 0,
        startTime: performance.now(),
        phase: 'expanding',
      };
      pendingCombatRef.current = null;
      forceRender((n) => n + 1);
      if (isMyTurn) playAttackSound(pending.type);
      return;
    }

    combatAnimRef.current = {
      attackerUnitId: pending.unitId,
      attackerType: pending.type,
      attackerOwner: pending.owner,
      fromX: pending.fromX,
      fromY: pending.fromY,
      toX: pending.toX,
      toY: pending.toY,
      progress: 0,
      startTime: performance.now(),
      result: lastActionResult.combat,
      phase: 'clashing',
    };
    pendingCombatRef.current = null;

    // Play attack sound for player attacks
    if (isMyTurn) {
      playAttackSound(pending.type);
    }

    // Spawn flame indicators for hits
    const combat = lastActionResult.combat;
    const now = performance.now();
    if (combat.defenderDamage > 0) {
      // Attacker scored a hit → flame on defender's tile
      flameHitsRef.current.push({ x: pending.toX, y: pending.toY, startTime: now + CLASH_DURATION + FLASH_DURATION });
    }
    if (combat.attackerDamage > 0) {
      // Defender scored a hit → flame on attacker's tile
      flameHitsRef.current.push({ x: pending.fromX, y: pending.fromY, startTime: now + CLASH_DURATION + FLASH_DURATION });
    }
    // The animation loop will pick it up
  }, [lastActionResult]);

  // Redraw whenever dependencies change
  useEffect(() => {
    draw();
  }, [draw]);

  // Resize observer to adapt canvas to container
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(dpr, dpr);

      // Lock to 15 tiles vertically
      const newTileSize = cssH / 15;
      setTileSize(newTileSize);

      requestRedraw();
    });

    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  // ── Mouse handlers (native for blocking gestures) ───────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onNativeMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = { dragging: false, lastX: e.clientX, lastY: e.clientY };
      }
    };

    const onNativeMouseMove = (e: MouseEvent) => {
      if (!(e.buttons & 2)) return;

      // Stop Vivaldi/browser from seeing this as a gesture
      e.preventDefault();
      e.stopPropagation();

      const d = dragRef.current;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;

      if (!d.dragging && Math.abs(dx) + Math.abs(dy) > 4) {
        d.dragging = true;
      }

      if (d.dragging) {
        const { cameraX, cameraY, tileSize } = useGameStore.getState();
        setCamera(cameraX - dx / tileSize, cameraY - dy / tileSize);
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        requestRedraw();
      }
    };

    const onNativeMouseUp = (e: MouseEvent) => {
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        dragRef.current.dragging = false;
      }
    };

    // Passive: false is missing here because we removed the wheel listener
    canvas.addEventListener('mousedown', onNativeMouseDown);
    canvas.addEventListener('mousemove', onNativeMouseMove);
    canvas.addEventListener('mouseup', onNativeMouseUp);

    return () => {
      canvas.removeEventListener('mousedown', onNativeMouseDown);
      canvas.removeEventListener('mousemove', onNativeMouseMove);
      canvas.removeEventListener('mouseup', onNativeMouseUp);
    };
  }, [setCamera, requestRedraw]);

  function handleMouseUp(e: React.MouseEvent) {
    // Only handle left-click in React land for UI logic
    if (e.button !== 0) return;

    const pos = screenToTile(e.clientX, e.clientY);
    if (!pos) return;
    const { tx, ty } = pos;

    // ── SHIFT+CLICK: select / cycle ──────────────────────────
    if (e.shiftKey) {
      const myUnitsHere = view.myUnits.filter(
        (u) => u.x === tx && u.y === ty && !u.carriedBy,
      );
      // Build a cycle list: all non-carried units + their cargo + city
      const cycleIds: (string | 'city')[] = [];
      for (const u of myUnitsHere) {
        cycleIds.push(u.id);
        const carried = view.myUnits.filter((c) => c.carriedBy === u.id);
        for (const c of carried) cycleIds.push(c.id);
      }
      const myCity = view.myCities.find((c) => c.x === tx && c.y === ty);
      if (myCity) cycleIds.push('city');

      if (cycleIds.length === 0) {
        selectUnit(null);
        return;
      }

      // Find current selection in cycle
      const currentIdx = selectedUnitId ? cycleIds.indexOf(selectedUnitId) : -1;

      if (currentIdx >= 0) {
        const nextIdx = (currentIdx + 1) % cycleIds.length;
        const next = cycleIds[nextIdx];
        if (next === 'city' && myCity && onCityClick) {
          selectUnit(null);
          onCityClick(myCity);
        } else {
          selectUnit(next as string);
        }
      } else {
        const first = cycleIds[0];
        if (first === 'city' && myCity && onCityClick) {
          selectUnit(null);
          onCityClick(myCity);
        } else {
          selectUnit(first as string);
        }
      }
      return;
    }

    // ── CLICK (no shift): move selected unit ─────────────────
    if (selectedUnitId) {
      const unit = view.myUnits.find((u) => u.id === selectedUnitId);
      if (unit) {
        const { tileSize } = useGameStore.getState();
        const unitX = unit.carriedBy
          ? (view.myUnits.find((u) => u.id === unit.carriedBy)?.x ?? unit.x)
          : unit.x;
        const unitY = unit.carriedBy
          ? (view.myUnits.find((u) => u.id === unit.carriedBy)?.y ?? unit.y)
          : unit.y;

        const dx = wrappedDistX(tx, unitX, mapW);
        const dy = Math.abs(ty - unitY);
        if (dx === 0 && dy === 0) return;

        if (unit.carriedBy && dx <= 1 && dy <= 1) {
          sendAction({ type: 'UNLOAD', unitId: selectedUnitId, to: { x: tx, y: ty } });
          return;
        }

        if (unit.movesLeft > 0 && !unit.carriedBy) {
          if (dx <= 1 && dy <= 1) {
            const enemyOnTarget = view.visibleEnemyUnits.find(
              (e) => e.x === tx && e.y === ty && !e.carriedBy,
            );
            if (enemyOnTarget) {
              pendingCombatRef.current = {
                unitId: unit.id,
                type: unit.type,
                owner: unit.owner,
                fromX: unit.x,
                fromY: unit.y,
                toX: tx,
                toY: ty,
              };
            }
            sendAction({ type: 'MOVE', unitId: selectedUnitId, to: { x: tx, y: ty } });
            return;
          }

          const domain = UNIT_STATS[unit.type].domain;
          const path = computePath(unit.x, unit.y, tx, ty, unit.movesLeft, domain);
          if (path.length > 0) {
            const lastStep = path[path.length - 1];
            const reachedTarget = lastStep.x === tx && lastStep.y === ty;
            const enemyOnLast = view.visibleEnemyUnits.find(
              (e) => e.x === lastStep.x && e.y === lastStep.y && !e.carriedBy,
            );
            if (!reachedTarget && !enemyOnLast) return;

            if (enemyOnLast) {
              const stepBefore = path.length > 1 ? path[path.length - 2] : { x: unit.x, y: unit.y };
              pendingCombatRef.current = {
                unitId: unit.id,
                type: unit.type,
                owner: unit.owner,
                fromX: stepBefore.x,
                fromY: stepBefore.y,
                toX: lastStep.x,
                toY: lastStep.y,
              };
            }

            moveAnimRef.current = {
              unitId: unit.id,
              unitType: unit.type,
              unitOwner: unit.owner,
              pathTiles: [{ x: unit.x, y: unit.y }, ...path],
              startTime: performance.now(),
              sentCount: 0,
            };
            sendAction({ type: 'MOVE', unitId: selectedUnitId, to: path[0] });
            moveAnimRef.current.sentCount = 1;
            forceRender((n) => n + 1);
            return;
          }
        }
      }
    }
  }

  /**
   * Compute a greedy straight-line path from (fx,fy) to (goalX,goalY),
   * returning up to `maxSteps` waypoints. Each step picks the adjacent tile
   * closest to the goal, preferring straight movement.
   */
  function computePath(
    fx: number, fy: number,
    goalX: number, goalY: number,
    maxSteps: number,
    domain: UnitDomain,
  ): Coord[] {
    const path: Coord[] = [];
    let cx = fx, cy = fy;
    for (let i = 0; i < maxSteps; i++) {
      if (cx === goalX && cy === goalY) break;
      const rawDx = goalX - cx;
      const halfW = Math.floor(mapW / 2);
      let sdx = rawDx;
      if (rawDx > halfW) sdx = rawDx - mapW;
      else if (rawDx < -halfW) sdx = rawDx + mapW;
      const sdy = goalY - cy;
      const stepX = sdx === 0 ? 0 : sdx > 0 ? 1 : -1;
      const stepY = sdy === 0 ? 0 : sdy > 0 ? 1 : -1;

      const candidates: Coord[] = [];
      if (stepX !== 0 && stepY !== 0) candidates.push({ x: cx + stepX, y: cy + stepY });
      if (stepX !== 0) candidates.push({ x: cx + stepX, y: cy });
      if (stepY !== 0) candidates.push({ x: cx, y: cy + stepY });
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          if (dx === 0 && dy === 0) continue;
          const c = { x: cx + dx, y: cy + dy };
          if (!candidates.some((p) => p.x === c.x && p.y === c.y)) candidates.push(c);
        }
      }

      let moved = false;
      for (const c of candidates) {
        const nx = wrapX(c.x, mapW);
        const ny = c.y;
        if (ny < 0 || ny >= mapH) continue;
        if (ny === 0 || ny === mapH - 1) continue;
        const terrain = view.tiles[ny]?.[nx]?.terrain;
        if (terrain === undefined) continue;

        if (domain === UnitDomain.Land && terrain === Terrain.Ocean) continue;
        if (domain === UnitDomain.Sea && terrain === Terrain.Land) {
          const hasCity = [...view.myCities, ...view.visibleEnemyCities].some(
            (ci) => ci.x === nx && ci.y === ny,
          );
          if (!hasCity) continue;
        }

        const enemyHere = view.visibleEnemyUnits.some(
          (u) => u.x === nx && u.y === ny && !u.carriedBy,
        );
        if (enemyHere) {
          path.push({ x: nx, y: ny });
          moved = true;
          break;
        }

        path.push({ x: nx, y: ny });
        cx = nx;
        cy = ny;
        moved = true;
        break;
      }
      if (!moved) break;
      if (path.length > 0) {
        const last = path[path.length - 1];
        const enemyOnLast = view.visibleEnemyUnits.some(
          (u) => u.x === last.x && u.y === last.y && !u.carriedBy,
        );
        if (enemyOnLast) break;
      }
    }
    return path;
  }

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === ' ' && selectedUnitId) {
          e.preventDefault();
          sendAction({ type: 'SKIP', unitId: selectedUnitId });
        }
      }}
      className="w-full h-full block cursor-grab active:cursor-grabbing outline-none touch-none"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
