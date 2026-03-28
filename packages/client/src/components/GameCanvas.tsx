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
import { playAttackSound, playCityCaptureFanfare, playCrashSound, playArmorCrashSound, playMoveSound } from '../sounds';

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

/**
 * BFS from a unit's position to find all tiles it can legally reach with its
 * remaining moves. Uses only client-visible tile data (terrain, visibility).
 *
 * - Land units: land tiles only
 * - Sea units:  ocean tiles + own coastal cities
 * - Air units:  any tile, but must retain enough fuel to reach a landing spot
 * - Air units without fuel (fighters): any tile within movesLeft steps
 */
function computeReachableTiles(
  unit: UnitView,
  view: PlayerView,
  mapW: number,
  mapH: number,
): Set<string> {
  const stats = UNIT_STATS[unit.type];
  const reachable = new Set<string>();
  // visited maps key → best movesLeft when the tile was reached (prune revisits)
  const visited = new Map<string, number>();
  visited.set(`${unit.x},${unit.y}`, unit.movesLeft);

  // Precompute landing spots for fuel-constrained air units
  const hasFuel = stats.domain === UnitDomain.Air && unit.fuel !== undefined;
  const landingSpots: Array<{ x: number; y: number }> = [];
  if (hasFuel) {
    for (const c of view.myCities) landingSpots.push({ x: c.x, y: c.y });
    for (const u of view.myUnits) {
      if (u.type === UnitType.Carrier && u.cargo.length < UNIT_STATS[UnitType.Carrier].cargoCapacity) {
        landingSpots.push({ x: u.x, y: u.y });
      }
    }
  }

  function distToLanding(x: number, y: number): number {
    let min = Infinity;
    for (const s of landingSpots) {
      min = Math.min(min, Math.max(wrappedDistX(x, s.x, mapW), Math.abs(y - s.y)));
    }
    return min;
  }

  const dirs: Array<[number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];

  // [x, y, movesRemaining, fuelRemaining]
  const queue: Array<[number, number, number, number]> = [
    [unit.x, unit.y, unit.movesLeft, unit.fuel ?? Infinity],
  ];

  while (queue.length > 0) {
    const [cx, cy, moves, fuel] = queue.shift()!;
    if (moves <= 0) continue;

    for (const [dx, dy] of dirs) {
      const nx = wrapX(cx + dx, mapW);
      const ny = cy + dy;

      if (ny <= 0 || ny >= mapH - 1) continue; // ice caps are impassable

      const tile = view.tiles[ny]?.[nx];
      if (!tile || tile.visibility === TileVisibility.Hidden) continue;

      // Terrain / domain constraints
      if (stats.domain === UnitDomain.Land && tile.terrain === Terrain.Ocean) continue;
      if (stats.domain === UnitDomain.Sea && tile.terrain === Terrain.Land) {
        if (!view.myCities.some((c) => c.x === nx && c.y === ny)) continue;
      }

      // Fuel constraint for bombers (and any other air unit with limited fuel)
      const newFuel = fuel - 1; // Infinity - 1 = Infinity, so unconstrained units are fine
      if (newFuel < 0) continue;
      if (hasFuel && distToLanding(nx, ny) > newFuel) continue;

      const newMoves = moves - 1;
      const key = `${nx},${ny}`;
      const best = visited.get(key) ?? -1;
      if (newMoves <= best) continue; // already reached with equal or more moves remaining

      visited.set(key, newMoves);
      reachable.add(key);
      if (newMoves > 0) queue.push([nx, ny, newMoves, newFuel]);
    }
  }

  return reachable;
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
    case UnitType.Army: {
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
      // Container ship: tall boxy hull (high freeboard), bridge tower at stern, cargo containers on deck
      const hw = r * 0.93;
      const deckY = cy - r * 0.2;   // HIGH deck — tall sides distinguish it from the sleek destroyer
      const wl = cy + r * 0.1;
      const keel = cy + r * 0.52;
      // Hull — boxy rectangle with only slight bow taper
      ctx.beginPath();
      ctx.moveTo(cx - hw, deckY);
      ctx.lineTo(cx + hw * 0.68, deckY);
      ctx.lineTo(cx + hw, wl);
      ctx.lineTo(cx + hw * 0.88, keel);
      ctx.lineTo(cx - hw, keel);
      ctx.closePath();
      ctx.fill();
      // Waterline stripe
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = Math.max(1, size / 16);
      ctx.beginPath();
      ctx.moveTo(cx - hw, wl);
      ctx.lineTo(cx + hw, wl);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      // Bridge tower at far stern — tall, prominent
      ctx.globalAlpha = 0.4;
      const brW = hw * 0.22;
      const brH = r * 0.72;
      ctx.fillRect(cx - hw + hw * 0.03, deckY - brH, brW, brH);
      // Funnel on top of bridge
      ctx.globalAlpha = 0.48;
      ctx.fillRect(cx - hw + hw * 0.1, deckY - brH - r * 0.26, hw * 0.07, r * 0.26);
      // Three cargo containers along deck — clearly rectangular blocks of different heights
      ctx.globalAlpha = 0.32;
      ctx.fillRect(cx + hw * 0.32, deckY - r * 0.38, hw * 0.22, r * 0.38);   // bow-side, tallest
      ctx.fillRect(cx + hw * 0.04, deckY - r * 0.3,  hw * 0.2,  r * 0.3);   // middle
      ctx.fillRect(cx - hw * 0.2,  deckY - r * 0.22, hw * 0.18, r * 0.22);  // near bridge, shortest
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Destroyer: {
      // Fast warship: very low sleek hull, sharp bow, angled bridge, radar mast, fore & aft guns
      const hw = r * 0.93;
      const deckY = cy + r * 0.04;  // LOW deck — nearly flush with waterline
      const wl = cy + r * 0.2;
      const keel = cy + r * 0.42;
      // Hull — narrow, knife-like; sharp bow, slight stern step
      ctx.beginPath();
      ctx.moveTo(cx - hw, deckY + r * 0.06);   // stern top (slight step)
      ctx.lineTo(cx - hw, wl);                  // stern
      ctx.lineTo(cx - hw * 0.8, keel);
      ctx.lineTo(cx + hw * 0.72, keel);
      ctx.lineTo(cx + hw, wl - r * 0.04);       // sharp bow tip, above waterline
      ctx.lineTo(cx + hw * 0.58, deckY);
      ctx.lineTo(cx - hw * 0.9, deckY);
      ctx.closePath();
      ctx.fill();
      // Waterline
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = Math.max(1, size / 18);
      ctx.beginPath();
      ctx.moveTo(cx - hw, wl);
      ctx.lineTo(cx + hw, wl);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      // Angled bridge (leans forward — fast-ship silhouette)
      ctx.globalAlpha = 0.38;
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.16, deckY);
      ctx.lineTo(cx - hw * 0.16, deckY - r * 0.42);
      ctx.lineTo(cx + hw * 0.07,  deckY - r * 0.28);
      ctx.lineTo(cx + hw * 0.07,  deckY);
      ctx.closePath();
      ctx.fill();
      // Tall mast with radar crossbar
      ctx.globalAlpha = 0.44;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(1, size / 22);
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.06, deckY - r * 0.42);
      ctx.lineTo(cx - hw * 0.06, deckY - r * 0.74);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.16, deckY - r * 0.64);
      ctx.lineTo(cx + hw * 0.04, deckY - r * 0.64);
      ctx.stroke();
      // Fore gun turret + barrel
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(cx + hw * 0.28, deckY - r * 0.05, r * 0.1, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx + hw * 0.38, deckY - r * 0.09, hw * 0.3, r * 0.05);
      // Aft gun turret + barrel (behind bridge, pointing stern)
      ctx.globalAlpha = 0.38;
      ctx.beginPath();
      ctx.arc(cx - hw * 0.5, deckY - r * 0.04, r * 0.08, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx - hw * 0.78, deckY - r * 0.07, hw * 0.27, r * 0.05);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Submarine: {
      // Submarine: smooth cigar hull sitting low (mostly submerged), large conning tower, stern planes
      const hw = r * 0.9;
      const mid = cy + r * 0.22;  // hull centre sits below waterline
      const hullH = r * 0.28;
      // Hull — smooth ellipse (cigar shape)
      ctx.beginPath();
      ctx.ellipse(cx, mid, hw, hullH, 0, 0, 2 * Math.PI);
      ctx.fill();
      // Conning tower / sail — tall trapezoid rising above hull
      ctx.fillStyle = '#000';
      ctx.globalAlpha = 0.38;
      const sailBaseY = mid - hullH * 0.72;
      const sailH = r * 0.52;
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.17, sailBaseY);
      ctx.lineTo(cx - hw * 0.11, sailBaseY - sailH);
      ctx.lineTo(cx + hw * 0.13, sailBaseY - sailH);
      ctx.lineTo(cx + hw * 0.19, sailBaseY);
      ctx.closePath();
      ctx.fill();
      // Periscope + scope head
      ctx.globalAlpha = 0.42;
      ctx.fillRect(cx + hw * 0.02, sailBaseY - sailH - r * 0.22, hw * 0.05, r * 0.22);
      ctx.fillRect(cx + hw * 0.02, sailBaseY - sailH - r * 0.22, hw * 0.1, r * 0.03);
      // Stern diving planes — prominent X-fins make the stern unmistakeable
      ctx.globalAlpha = 0.34;
      const px = cx - hw * 0.78;
      ctx.beginPath();
      ctx.moveTo(px + hw * 0.06, mid);
      ctx.lineTo(px - hw * 0.08, mid - hullH * 1.55);
      ctx.lineTo(px - hw * 0.02, mid - hullH * 1.55);
      ctx.lineTo(px + hw * 0.1, mid - hullH * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px + hw * 0.06, mid);
      ctx.lineTo(px - hw * 0.08, mid + hullH * 1.55);
      ctx.lineTo(px - hw * 0.02, mid + hullH * 1.55);
      ctx.lineTo(px + hw * 0.1, mid + hullH * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Carrier: {
      // Aircraft carrier: extremely flat wide deck, angled flight-deck stripe, island aft, 2 planes on deck
      const hw = r * 0.96;
      const deckY = cy - r * 0.06;
      const wl = cy + r * 0.18;
      const keel = cy + r * 0.42;
      // Hull — very flat and wide
      ctx.beginPath();
      ctx.moveTo(cx - hw, deckY);
      ctx.lineTo(cx + hw * 0.84, deckY);
      ctx.lineTo(cx + hw, deckY + r * 0.08);
      ctx.lineTo(cx + hw * 0.92, keel);
      ctx.lineTo(cx - hw * 0.88, keel);
      ctx.lineTo(cx - hw, wl);
      ctx.closePath();
      ctx.fill();
      // Waterline
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = Math.max(1, size / 14);
      ctx.beginPath();
      ctx.moveTo(cx - hw, wl);
      ctx.lineTo(cx + hw, wl);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      // Angled flight-deck stripe (the defining visual of a carrier)
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(2, size / 9);
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.55, deckY + r * 0.02);
      ctx.lineTo(cx + hw * 0.35, deckY + r * 0.02);
      ctx.stroke();
      // Island superstructure — aft starboard, tiered
      ctx.globalAlpha = 0.44;
      ctx.fillStyle = '#000';
      const isW = hw * 0.17;
      const isH = r * 0.46;
      ctx.fillRect(cx - hw * 0.06, deckY - isH, isW, isH);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(cx - hw * 0.04, deckY - isH - r * 0.14, isW * 0.68, r * 0.14);
      // Mast + radar arm
      ctx.globalAlpha = 0.44;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(1, size / 22);
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.01, deckY - isH - r * 0.14);
      ctx.lineTo(cx - hw * 0.01, deckY - isH - r * 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.1, deckY - isH - r * 0.28);
      ctx.lineTo(cx + hw * 0.06, deckY - isH - r * 0.28);
      ctx.stroke();
      // Two tiny plane silhouettes on deck
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = '#000';
      const pr = r * 0.1;
      for (const px of [cx + hw * 0.52, cx + hw * 0.16]) {
        const py = deckY - r * 0.04;
        ctx.beginPath();
        ctx.moveTo(px, py - pr);
        ctx.lineTo(px + pr * 0.85, py + pr * 0.28);
        ctx.lineTo(px + pr * 0.18, py + pr * 0.08);
        ctx.lineTo(px + pr * 0.14, py + pr);
        ctx.lineTo(px - pr * 0.14, py + pr);
        ctx.lineTo(px - pr * 0.18, py + pr * 0.08);
        ctx.lineTo(px - pr * 0.85, py + pr * 0.28);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      break;
    }
    case UnitType.Battleship: {
      // Battleship: wide deep hull, massive superstructure, three twin-barrel gun turrets, twin funnels
      const hw = r * 0.95;
      const deckY = cy - r * 0.08;
      const wl = cy + r * 0.22;
      const keel = cy + r * 0.6;   // DEEP keel — heaviest ship on the water
      // Hull — wide and deep
      ctx.beginPath();
      ctx.moveTo(cx - hw, deckY);
      ctx.lineTo(cx + hw * 0.58, deckY);
      ctx.lineTo(cx + hw, wl);
      ctx.lineTo(cx + hw * 0.86, keel);
      ctx.lineTo(cx - hw * 0.82, keel);
      ctx.lineTo(cx - hw, wl);
      ctx.closePath();
      ctx.fill();
      // Waterline
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = Math.max(1, size / 13);
      ctx.beginPath();
      ctx.moveTo(cx - hw, wl);
      ctx.lineTo(cx + hw, wl);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      // Central superstructure — tall, wide, tiered
      ctx.globalAlpha = 0.38;
      const sW = hw * 0.36;
      const sH = r * 0.58;
      ctx.fillRect(cx - sW * 0.58, deckY - sH, sW, sH);
      ctx.globalAlpha = 0.44;
      const uW = sW * 0.62;
      const uH = r * 0.3;
      ctx.fillRect(cx - uW * 0.5, deckY - sH - uH, uW, uH);
      ctx.globalAlpha = 0.48;
      ctx.fillRect(cx - uW * 0.32, deckY - sH - uH - r * 0.15, uW * 0.55, r * 0.15);
      // Mast
      ctx.globalAlpha = 0.46;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(1, size / 20);
      ctx.beginPath();
      ctx.moveTo(cx - uW * 0.04, deckY - sH - uH - r * 0.15);
      ctx.lineTo(cx - uW * 0.04, deckY - sH - uH - r * 0.42);
      ctx.stroke();
      // Twin funnels behind superstructure
      ctx.globalAlpha = 0.42;
      ctx.fillStyle = '#000';
      ctx.fillRect(cx - sW * 0.54, deckY - r * 0.42, hw * 0.1,  r * 0.42);
      ctx.fillRect(cx - sW * 0.4,  deckY - r * 0.34, hw * 0.08, r * 0.34);
      // Fore turret 1 (closest to bow) — twin barrels
      ctx.globalAlpha = 0.44;
      ctx.beginPath();
      ctx.arc(cx + hw * 0.38, deckY - r * 0.05, r * 0.13, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx + hw * 0.51, deckY - r * 0.1,  hw * 0.32, r * 0.04);
      ctx.fillRect(cx + hw * 0.51, deckY - r * 0.02, hw * 0.32, r * 0.04);
      // Fore turret 2 (behind turret 1) — twin barrels
      ctx.globalAlpha = 0.42;
      ctx.beginPath();
      ctx.arc(cx + hw * 0.14, deckY - r * 0.05, r * 0.12, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx + hw * 0.26, deckY - r * 0.09, hw * 0.27, r * 0.04);
      ctx.fillRect(cx + hw * 0.26, deckY - r * 0.01, hw * 0.27, r * 0.04);
      // Aft turret — twin barrels pointing stern
      ctx.globalAlpha = 0.42;
      ctx.beginPath();
      ctx.arc(cx - hw * 0.65, deckY - r * 0.05, r * 0.12, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx - hw * 0.95, deckY - r * 0.09, hw * 0.29, r * 0.04);
      ctx.fillRect(cx - hw * 0.95, deckY - r * 0.01, hw * 0.29, r * 0.04);
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
  const setCanvasSize = useGameStore((s) => s.setCanvasSize);

  const lastActionResult = useGameStore((s) => s.lastActionResult);
  const lastEnemyCombat = useGameStore((s) => s.lastEnemyCombat);

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

  // "Your turn" banner: stores the timestamp when the current player's turn began
  const yourTurnStartRef = useRef<number | null>(null);
  const prevPlayerRef = useRef<string | null>(null);

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
      const dpr = window.devicePixelRatio || 1;
      const canvasW = canvas.width / dpr;
      const canvasH = canvas.height / dpr;

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

    // ── Movement range overlay ────────────────────────────────
    // Show all reachable tiles for the selected own unit (only on our turn, only if moves remain)
    if (selectedUnitId && view.currentPlayer === playerId) {
      const selUnit = view.myUnits.find((u) => u.id === selectedUnitId);
      if (selUnit && selUnit.movesLeft > 0 && !selUnit.carriedBy) {
        const reachable = computeReachableTiles(selUnit, view, mapW, mapH);
        if (reachable.size > 0) {
          ctx.save();
          ctx.strokeStyle = '#ff4444';
          ctx.lineWidth = Math.max(1, tileSize / 14);
          ctx.lineJoin = 'round';
          ctx.beginPath();

          for (let wy = startTileY; wy <= endTileY; wy++) {
            for (let wx = startTileX; wx <= endTileX; wx++) {
              const tx = wrapX(wx, mapW);
              if (!reachable.has(`${tx},${wy}`)) continue;

              const spx = wx * tileSize - originX;
              const spy = wy * tileSize - originY;

              // Draw each edge that borders a non-reachable tile
              if (!reachable.has(`${wrapX(tx - 1, mapW)},${wy}`)) {
                ctx.moveTo(spx, spy);
                ctx.lineTo(spx, spy + tileSize);
              }
              if (!reachable.has(`${wrapX(tx + 1, mapW)},${wy}`)) {
                ctx.moveTo(spx + tileSize, spy);
                ctx.lineTo(spx + tileSize, spy + tileSize);
              }
              if (!reachable.has(`${tx},${wy - 1}`)) {
                ctx.moveTo(spx, spy);
                ctx.lineTo(spx + tileSize, spy);
              }
              if (!reachable.has(`${tx},${wy + 1}`)) {
                ctx.moveTo(spx, spy + tileSize);
                ctx.lineTo(spx + tileSize, spy + tileSize);
              }
            }
          }

          ctx.stroke();
          ctx.restore();
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

    // ── "Your turn" banner ────────────────────────────────────
    const ytStart = yourTurnStartRef.current;
    if (ytStart !== null) {
      const elapsed = performance.now() - ytStart;
      const alpha = Math.max(0, 1 - elapsed / 2000);
      if (alpha > 0) {
        ctx.save();
        const fontSize = Math.round(Math.min(canvasW, canvasH) * 0.11);
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Subtle dark shadow for legibility
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillStyle = '#000';
        ctx.fillText('Your turn', canvasW / 2 + 3, canvasH * 0.25 + 3);
        // Main text
        ctx.globalAlpha = alpha * 0.7;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Your turn', canvasW / 2, canvasH * 0.25);
        ctx.restore();
      } else {
        yourTurnStartRef.current = null;
      }
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

  // ── "Your turn" banner — fire when the turn switches to this player ──────
  // Must be defined BEFORE the animLoop useEffect so yourTurnStartRef is set
  // before the loop's first needsFrame check in the same React commit.
  useEffect(() => {
    const prev = prevPlayerRef.current;
    prevPlayerRef.current = view.currentPlayer;
    if (prev !== null && prev !== view.currentPlayer && view.currentPlayer === playerId) {
      yourTurnStartRef.current = performance.now();
    }
  }, [view.currentPlayer, playerId]);

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

      // "Your turn" banner fade
      if (yourTurnStartRef.current !== null && fnow - yourTurnStartRef.current < 2000) {
        needsFrame = true;
      }

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

    if (lastActionResult.cityCaptured) {
      playCityCaptureFanfare();
    }
    
    // City capture failed → armor crash
    if (lastActionResult.cityCaptureFailed) {
      playArmorCrashSound();
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

  // ── Enemy combat animation (PvE: AI attacked one of our units/cities) ────
  useEffect(() => {
    if (!lastEnemyCombat) return;
    const {
      attackerUnitId, attackerType, attackerOwner,
      fromX, fromY, toX, toY,
      combat, cityCaptured,
      bomberBlastRadius, bomberBlastCenter,
    } = lastEnemyCombat;

    // Center camera on the attack location
    const { setCamera } = useGameStore.getState();
    setCamera(toX, toY);

    // City captured without combat (undefended city walk-in)
    if (cityCaptured && !combat) {
      playArmorCrashSound();
      return;
    }

    // Bomber blast
    if (bomberBlastRadius !== undefined && bomberBlastCenter) {
      moveAnimRef.current = null;
      bomberBlastRef.current = {
        centerX: bomberBlastCenter.x,
        centerY: bomberBlastCenter.y,
        radius: bomberBlastRadius,
        progress: 0,
        startTime: performance.now(),
        phase: 'expanding',
      };
      playAttackSound(attackerType);
      forceRender((n) => n + 1);
      return;
    }

    if (!combat) return;

    moveAnimRef.current = null;
    combatAnimRef.current = {
      attackerUnitId,
      attackerType,
      attackerOwner,
      fromX,
      fromY,
      toX,
      toY,
      progress: 0,
      startTime: performance.now(),
      result: combat,
      phase: 'clashing',
    };

    playAttackSound(attackerType);

    const now = performance.now();
    if (combat.defenderDamage > 0) {
      flameHitsRef.current.push({ x: toX, y: toY, startTime: now + CLASH_DURATION + FLASH_DURATION });
    }
    if (combat.attackerDamage > 0) {
      flameHitsRef.current.push({ x: fromX, y: fromY, startTime: now + CLASH_DURATION + FLASH_DURATION });
    }
    forceRender((n) => n + 1);
  }, [lastEnemyCombat]);

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

      setCanvasSize(cssW, cssH);

      // Only set tileSize on first render — after that the user controls zoom
      if (!useGameStore.getState().viewportInitialized) {
        setTileSize(cssH / 15);
      }

      requestRedraw();
    });

    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw, setTileSize, setCanvasSize]);

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

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { tileSize } = useGameStore.getState();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newTileSize = Math.max(6, Math.min(64, tileSize * factor));
      if (newTileSize === tileSize) return;
      setTileSize(newTileSize);
      requestRedraw();
    };

    canvas.addEventListener('mousedown', onNativeMouseDown);
    canvas.addEventListener('mousemove', onNativeMouseMove);
    canvas.addEventListener('mouseup', onNativeMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      canvas.removeEventListener('mousedown', onNativeMouseDown);
      canvas.removeEventListener('mousemove', onNativeMouseMove);
      canvas.removeEventListener('mouseup', onNativeMouseUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [setCamera, setTileSize, requestRedraw]);

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
            } else {
              playMoveSound(unit.type);
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
            // Allow partial moves: if target is out of range, consume all moves toward it

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

            playMoveSound(unit.type);
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
   * BFS from (fx,fy) to (goalX,goalY), respecting domain terrain rules.
   * Returns up to `maxSteps` waypoints along the shortest path.
   * Handles cylindrical X-wrapping. Returns [] if no path exists.
   */
  function computePath(
    fx: number, fy: number,
    goalX: number, goalY: number,
    maxSteps: number,
    domain: UnitDomain,
  ): Coord[] {
    const goalKey = `${goalX},${goalY}`;
    const startKey = `${fx},${fy}`;

    // BFS — find shortest path ignoring move-count limit so we can route around obstacles
    const parent = new Map<string, string | null>();
    parent.set(startKey, null);
    const queue: Coord[] = [{ x: fx, y: fy }];

    const canEnter = (nx: number, ny: number): boolean => {
      if (ny < 0 || ny >= mapH) return false;
      if (ny === 0 || ny === mapH - 1) return false;
      const terrain = view.tiles[ny]?.[nx]?.terrain;
      if (terrain === undefined) return false;
      if (domain === UnitDomain.Land && terrain === Terrain.Ocean) return false;
      if (domain === UnitDomain.Sea && terrain === Terrain.Land) {
        const hasCity = [...view.myCities, ...view.visibleEnemyCities].some(
          (ci) => ci.x === nx && ci.y === ny,
        );
        if (!hasCity) return false;
      }
      return true;
    };

    let found = false;
    outer: while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const [ddx, ddy] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]] as [number,number][]) {
        const nx = wrapX(cur.x + ddx, mapW);
        const ny = cur.y + ddy;
        const key = `${nx},${ny}`;
        if (parent.has(key)) continue;
        if (!canEnter(nx, ny)) continue;
        parent.set(key, `${cur.x},${cur.y}`);
        if (key === goalKey) { found = true; break outer; }
        // Don't expand through enemy-occupied tiles (can attack but not pass through)
        const enemyHere = view.visibleEnemyUnits.some(
          (u) => u.x === nx && u.y === ny && !u.carriedBy,
        );
        // Sea units must not route through neutral or enemy cities (can move TO them, not through)
        const isNonOwnCity = domain === UnitDomain.Sea &&
          view.tiles[ny]?.[nx]?.terrain === Terrain.Land &&
          !view.myCities.some((c) => c.x === nx && c.y === ny);
        // Air units must not route THROUGH friendly cities (landing stops the unit there);
        // they may still fly TO a friendly city as the explicit destination.
        const isAirThroughFriendlyCity = domain === UnitDomain.Air &&
          view.myCities.some((c) => c.x === nx && c.y === ny);
        if (!enemyHere && !isNonOwnCity && !isAirThroughFriendlyCity) queue.push({ x: nx, y: ny });
      }
    }

    if (!found) return [];

    // Reconstruct full path from goal back to start
    const fullPath: Coord[] = [];
    let cur: string | null | undefined = goalKey;
    while (cur && cur !== startKey) {
      const [px, py] = cur.split(',').map(Number);
      fullPath.push({ x: px, y: py });
      cur = parent.get(cur);
    }
    fullPath.reverse();

    // Return only the first maxSteps steps, stopping early on enemy tile
    const result: Coord[] = [];
    for (const step of fullPath) {
      result.push(step);
      const enemyHere = view.visibleEnemyUnits.some(
        (u) => u.x === step.x && u.y === step.y && !u.carriedBy,
      );
      if (enemyHere || result.length >= maxSteps) break;
    }
    return result;
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
