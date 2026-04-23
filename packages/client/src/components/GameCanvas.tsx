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
import type { LastKnownEnemy } from '../store/gameStore';
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

      // Fuel constraint for missiles (and any other air unit with limited fuel)
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
    case UnitType.Missile: {
      // Top-down missile: sharp nose, narrow body, swept delta wings, small tail fins
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);                      // nose tip
      ctx.lineTo(cx + r * 0.12, cy - r * 0.65);   // right nose edge
      ctx.lineTo(cx + r * 0.12, cy - r * 0.15);   // right body above wing
      ctx.lineTo(cx + r * 0.8, cy + r * 0.3);     // right wingtip
      ctx.lineTo(cx + r * 0.12, cy + r * 0.35);   // right wing trailing
      ctx.lineTo(cx + r * 0.35, cy + r);           // right tail fin tip
      ctx.lineTo(cx + r * 0.12, cy + r * 0.75);   // right tail fin inner
      ctx.lineTo(cx, cy + r * 0.88);              // tail centre
      ctx.lineTo(cx - r * 0.12, cy + r * 0.75);  // left tail fin inner
      ctx.lineTo(cx - r * 0.35, cy + r);          // left tail fin tip
      ctx.lineTo(cx - r * 0.12, cy + r * 0.35);  // left wing trailing
      ctx.lineTo(cx - r * 0.8, cy + r * 0.3);    // left wingtip
      ctx.lineTo(cx - r * 0.12, cy - r * 0.15);  // left body above wing
      ctx.lineTo(cx - r * 0.12, cy - r * 0.65);  // left nose edge
      ctx.closePath();
      ctx.fill();
      break;
    }
    case UnitType.Transport: {
      // Transport: low boxy hull, single bridge tower at stern
      const hw = r * 0.93;
      const deckY = cy + r * 0.04;   // LOW deck — sits close to the waterline
      const wl = cy + r * 0.2;
      const keel = cy + r * 0.46;
      // Hull — boxy with slight bow taper
      ctx.beginPath();
      ctx.moveTo(cx - hw, deckY);
      ctx.lineTo(cx + hw * 0.72, deckY);
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
      // Single bridge tower at stern
      ctx.globalAlpha = 0.42;
      const brW = hw * 0.28;
      const brH = r * 0.62;
      ctx.fillRect(cx - hw + hw * 0.02, deckY - brH, brW, brH);
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
      // Battleship: larger destroyer silhouette — deeper hull, taller angled bridge, twin-barrel turrets
      const hw = r * 0.95;
      const deckY = cy - r * 0.02;  // slightly higher deck than destroyer (more freeboard)
      const wl = cy + r * 0.26;
      const keel = cy + r * 0.54;   // deeper keel — heavier ship
      // Hull — same knife-bow shape as destroyer but deeper/heavier
      ctx.beginPath();
      ctx.moveTo(cx - hw, deckY + r * 0.06);   // stern top
      ctx.lineTo(cx - hw, wl);                  // stern
      ctx.lineTo(cx - hw * 0.78, keel);
      ctx.lineTo(cx + hw * 0.7, keel);
      ctx.lineTo(cx + hw, wl - r * 0.04);       // sharp bow tip
      ctx.lineTo(cx + hw * 0.56, deckY);
      ctx.lineTo(cx - hw * 0.9, deckY);
      ctx.closePath();
      ctx.fill();
      // Waterline
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = Math.max(1, size / 16);
      ctx.beginPath();
      ctx.moveTo(cx - hw, wl);
      ctx.lineTo(cx + hw, wl);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      // Angled bridge — same forward-lean as destroyer but taller/wider
      ctx.globalAlpha = 0.38;
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.16, deckY);
      ctx.lineTo(cx - hw * 0.18, deckY - r * 0.58);
      ctx.lineTo(cx + hw * 0.09, deckY - r * 0.38);
      ctx.lineTo(cx + hw * 0.09, deckY);
      ctx.closePath();
      ctx.fill();
      // Tall mast with radar crossbar
      ctx.globalAlpha = 0.44;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(1, size / 22);
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.06, deckY - r * 0.58);
      ctx.lineTo(cx - hw * 0.06, deckY - r * 0.90);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - hw * 0.17, deckY - r * 0.78);
      ctx.lineTo(cx + hw * 0.05, deckY - r * 0.78);
      ctx.stroke();
      // Fore turret 1 (near bow) — twin barrels
      ctx.globalAlpha = 0.44;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(cx + hw * 0.3, deckY - r * 0.06, r * 0.12, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx + hw * 0.42, deckY - r * 0.12, hw * 0.34, r * 0.04);
      ctx.fillRect(cx + hw * 0.42, deckY - r * 0.03, hw * 0.34, r * 0.04);
      // Fore turret 2 (mid-fore) — twin barrels
      ctx.globalAlpha = 0.42;
      ctx.beginPath();
      ctx.arc(cx + hw * 0.08, deckY - r * 0.06, r * 0.10, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx + hw * 0.18, deckY - r * 0.10, hw * 0.26, r * 0.04);
      ctx.fillRect(cx + hw * 0.18, deckY - r * 0.02, hw * 0.26, r * 0.04);
      // Aft turret — twin barrels pointing stern
      ctx.globalAlpha = 0.42;
      ctx.beginPath();
      ctx.arc(cx - hw * 0.52, deckY - r * 0.05, r * 0.10, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillRect(cx - hw * 0.82, deckY - r * 0.09, hw * 0.28, r * 0.04);
      ctx.fillRect(cx - hw * 0.82, deckY - r * 0.01, hw * 0.28, r * 0.04);
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

// ── Unit image loading & tinted rendering ────────────────────

const UNIT_IMAGE_SRCS: Record<UnitType, string> = {
  [UnitType.Army]:       '/units/army.png',
  [UnitType.Fighter]:    '/units/fighter.png',
  [UnitType.Missile]:     '/units/missile.png',
  [UnitType.Transport]:  '/units/transport.png',
  [UnitType.Destroyer]:  '/units/destroyer.png',
  [UnitType.Submarine]:  '/units/submarine.png',
  [UnitType.Carrier]:    '/units/carrier.png',
  [UnitType.Battleship]: '/units/battleship.png',
};

// Cache tinted canvases keyed by "unitType:size:color"
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
  const lastKnownEnemies = useGameStore((s) => s.lastKnownEnemies);

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
    phase: 'waiting' | 'clashing' | 'flash' | 'result' | 'done';
  }
  interface MissileBlastAnim {
    centerX: number;       // tile coords
    centerY: number;
    radius: number;        // blast radius in tiles (0, 1, or 2)
    progress: number;      // 0→1
    startTime: number;
    phase: 'expanding' | 'fading' | 'done';
  }
  const combatAnimRef = useRef<CombatAnim | null>(null);
  const missileBlastRef = useRef<MissileBlastAnim | null>(null);
  const pendingCombatRef = useRef<{ unitId: string; type: UnitType; owner: string; fromX: number; fromY: number; toX: number; toY: number } | null>(null);
  const animFrameRef = useRef<number>(0);
  const [, forceRender] = useState(0);

  // Combat result text display
  interface CombatResultText {
    text: string;
    x: number;
    y: number;
    startTime: number;
    color: string;
  }
  const combatResultRef = useRef<CombatResultText | null>(null);

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
    knownEnemyIds: Set<string>; // enemies visible when path started
  }
  const moveAnimRef = useRef<MoveAnim | null>(null);
  const MOVE_STEP_DURATION = 333; // ms per tile

  // Fading text for messages like "Out of range"
  interface FadingText {
    text: string;
    x: number;
    y: number;
    startTime: number;
    color: string;
  }
  const fadingTextRef = useRef<FadingText | null>(null);
  const hoverTileRef = useRef<{ x: number; y: number } | null>(null);

  // ── Unit sprite images ─────────────────────────────────────
  const unitImagesRef = useRef<Partial<Record<UnitType, HTMLImageElement>>>({});
  useEffect(() => {
    for (const [type, src] of Object.entries(UNIT_IMAGE_SRCS) as [UnitType, string][]) {
      const img = new Image();
      img.src = src;
      img.onload = () => {
        unitImagesRef.current[type] = img;
        unitImageTintCache.clear(); // invalidate tint cache on new load
        setImagesLoaded((n) => n + 1);
      };
    }
  }, []);
  const [imagesLoaded, setImagesLoaded] = useState(0);

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

          drawUnit(ctx, unit.type, cxCenter, cyCenter, tileSize, ownerColor(unit.owner), unitImagesRef.current);

          // Stack count when multiple units on same tile (white number, bottom-right)
          if (units.length > 1 && tileSize >= 14) {
            ctx.fillStyle = '#fff';
            ctx.font = `bold ${Math.max(10, tileSize * 0.45)}px sans-serif`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`${units.length}`, screenPx + tileSize - 2, screenPy + tileSize - 2);
          }

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

    // ── Last-known-enemy ghosts ───────────────────────────────
    {
      const ghosts = Object.values(lastKnownEnemies);
      const hover = hoverTileRef.current;
      for (const ghost of ghosts) {
        if (view.visibleEnemyUnits.some((u) => u.id === ghost.id)) continue;
        const wx = ghost.x;
        const wy = ghost.y;
        const screenPx = wx * tileSize - originX;
        const screenPy = wy * tileSize - originY;
        if (screenPx + tileSize < 0 || screenPx > canvasW) continue;
        if (screenPy + tileSize < 0 || screenPy > canvasH) continue;
        const cxCenter = screenPx + tileSize / 2;
        const cyCenter = screenPy + tileSize / 2;
        ctx.save();
        ctx.globalAlpha = 0.55;
        drawUnit(ctx, ghost.type, cxCenter, cyCenter, tileSize, '#888888', unitImagesRef.current);
        ctx.restore();
        // Tooltip on hover
        if (hover && hover.x === wx && hover.y === wy) {
          const label = 'Last known position';
          const fontSize = Math.max(11, tileSize * 0.38);
          ctx.save();
          ctx.font = `${fontSize}px sans-serif`;
          const tw = ctx.measureText(label).width;
          const pad = 4;
          const bx = Math.min(cxCenter - tw / 2 - pad, canvasW - tw - pad * 2 - 2);
          const by = screenPy - fontSize - pad * 2 - 2;
          ctx.fillStyle = 'rgba(0,0,0,0.75)';
          ctx.fillRect(bx, by, tw + pad * 2, fontSize + pad * 2);
          ctx.fillStyle = '#cccccc';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(label, bx + pad, by + pad);
          ctx.restore();
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
        drawUnit(ctx, combatAnim.attackerType, ax, ay, tileSize, ownerColor(combatAnim.attackerOwner), unitImagesRef.current);
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

        // Attacker is already drawn by normal unit rendering at its new position
        // No need to draw it here - this prevents double-drawing and flickering
      } else if (combatAnim.phase === 'result') {
        // Only draw attacker at target if it survived
        if (!combatAnim.result?.attackerDestroyed) {
          drawUnit(ctx, combatAnim.attackerType, toSX, toSY, tileSize, ownerColor(combatAnim.attackerOwner), unitImagesRef.current);
        }
      }
    }

    // ── Combat result text (Win/Draw/Loss) ────────────────────
    const resultText = combatResultRef.current;
    if (resultText) {
      const elapsed = performance.now() - resultText.startTime;
      if (elapsed < 2000) {
        const rx = resultText.x * tileSize - originX + tileSize / 2;
        const ry = resultText.y * tileSize - originY - tileSize * 0.5;
        ctx.save();
        ctx.font = `bold ${Math.max(16, tileSize * 0.6)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillText(resultText.text, rx + 2, ry + 2);
        ctx.fillStyle = resultText.color;
        ctx.fillText(resultText.text, rx, ry);
        ctx.restore();
      } else {
        combatResultRef.current = null;
      }
    }

    // ── Fading text messages (e.g., "Out of range") ───────────
    const fadeText = fadingTextRef.current;
    if (fadeText) {
      const elapsed = performance.now() - fadeText.startTime;
      const fadeDuration = 2000;
      const alpha = Math.max(0, 1 - elapsed / fadeDuration);
      if (alpha > 0) {
        const rx = fadeText.x * tileSize - originX + tileSize / 2;
        const ry = fadeText.y * tileSize - originY - tileSize * 0.5;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = `bold ${Math.max(14, tileSize * 0.5)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillText(fadeText.text, rx + 2, ry + 2);
        ctx.fillStyle = fadeText.color;
        ctx.fillText(fadeText.text, rx, ry);
        ctx.restore();
      } else {
        fadingTextRef.current = null;
      }
    }

    // ── Missile blast: mushroom cloud animation ───────────────
    const blast = missileBlastRef.current;
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
      drawUnit(ctx, mAnim.unitType, sx, sy, tileSize, ownerColor(mAnim.unitOwner), unitImagesRef.current);

      // Cargo count badge for animating transport/carrier
      if (
        (mAnim.unitType === UnitType.Transport || mAnim.unitType === UnitType.Carrier) &&
        tileSize >= 14
      ) {
        const animUnit = view.myUnits.find((u) => u.id === mAnim.unitId);
        if (animUnit && animUnit.cargo.length > 0) {
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.max(8, tileSize * 0.3)}px sans-serif`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(`${animUnit.cargo.length}`, sx - tileSize / 2 + 2, sy - tileSize / 2 + 1);
        }
      }
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
  }, [view, cachedAllUnits, cityByPos, selectedUnitId, selectedCityId, playerId, combatAnimRef, lastKnownEnemies]);

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
          // Transition to result phase - unit stays visible for 2 seconds
          anim.phase = 'result';
          anim.startTime = performance.now();
          anim.progress = 0;
        }
        needsFrame = true;
      } else if (anim && anim.phase === 'result') {
        const elapsed = performance.now() - anim.startTime;
        anim.progress = Math.min(elapsed / 2000, 1); // 2 seconds for result display

        if (anim.progress >= 1) {
          anim.phase = 'done';
          combatAnimRef.current = null;
          forceRender((n) => n + 1);
        }
        needsFrame = true;
      }

      const blast = missileBlastRef.current;
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
          missileBlastRef.current = null;
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

      // Combat result text — keep animating until cleared
      if (combatResultRef.current !== null) needsFrame = true;

      // Progress move animation: send MOVE actions as each step completes
      const mAnim = moveAnimRef.current;
      if (mAnim) {
        const elapsed = fnow - mAnim.startTime;
        const totalSteps = mAnim.pathTiles.length - 1;
        const currentStep = Math.min(Math.floor(elapsed / MOVE_STEP_DURATION) + 1, totalSteps);

        // Send any unsent MOVE actions up to currentStep, stopping on enemy discovery
        let pathInterrupted = false;
        while (mAnim.sentCount < currentStep) {
          const step = mAnim.pathTiles[mAnim.sentCount + 1];
          // Stop if any new enemy has become visible since path started
          const newEnemySpotted = view.visibleEnemyUnits.some(
            (e) => !mAnim.knownEnemyIds.has(e.id),
          );
          // Stop if next tile now has an enemy
          const enemyOnStep = view.visibleEnemyUnits.some(
            (e) => e.x === step.x && e.y === step.y && !e.carriedBy,
          );
          if (newEnemySpotted || enemyOnStep) {
            moveAnimRef.current = null;
            pathInterrupted = true;
            forceRender((n) => n + 1);
            break;
          }
          sendAction({ type: 'MOVE', unitId: mAnim.unitId, to: step });
          mAnim.sentCount++;
        }
        if (pathInterrupted) {
          draw();
          if (needsFrame) animFrameRef.current = requestAnimationFrame(animLoop);
          return;
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

  // ── Kick off clash / missile blast when actionResult arrives with combat ───
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

    // Missile blast: skip normal clash, show expanding red circle
    if (lastActionResult.missileBlastRadius !== undefined && lastActionResult.missileBlastCenter) {
      const bc = lastActionResult.missileBlastCenter;
      missileBlastRef.current = {
        centerX: bc.x,
        centerY: bc.y,
        radius: lastActionResult.missileBlastRadius,
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

    // Set combat result text after flash completes
    setTimeout(() => {
      let text: string;
      let color: string;
      if (combat.attackerDestroyed && combat.defenderDestroyed) {
        text = 'Both defeated';
        color = '#f39c12'; // orange
      } else if (combat.defenderDestroyed) {
        text = 'Victory';
        color = '#2ecc71'; // green
      } else if (combat.attackerDestroyed) {
        text = 'Defeat';
        color = '#e74c3c'; // red
      } else {
        text = 'Draw';
        color = '#aaaaaa'; // grey
      }
      combatResultRef.current = {
        text,
        x: pending.toX,
        y: pending.toY,
        startTime: performance.now(),
        color,
      };
      forceRender((n) => n + 1);
    }, CLASH_DURATION + FLASH_DURATION + 100);

    // The animation loop will pick it up
  }, [lastActionResult]);

  // ── Enemy combat animation (PvE: AI attacked one of our units/cities) ────
  useEffect(() => {
    if (!lastEnemyCombat) return;
    const {
      attackerUnitId, attackerType, attackerOwner,
      fromX, fromY, toX, toY,
      combat, cityCaptured,
      missileBlastRadius, missileBlastCenter,
    } = lastEnemyCombat;

    // Center camera on the attack location
    const { setCamera } = useGameStore.getState();
    setCamera(toX, toY);

    // City captured without combat (undefended city walk-in)
    if (cityCaptured && !combat) {
      playArmorCrashSound();
      return;
    }

    // Missile blast
    if (missileBlastRadius !== undefined && missileBlastCenter) {
      moveAnimRef.current = null;
      missileBlastRef.current = {
        centerX: missileBlastCenter.x,
        centerY: missileBlastCenter.y,
        radius: missileBlastRadius,
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

    // Set combat result text after flash completes (for enemy attacks on our units)
    setTimeout(() => {
      let text: string;
      let color: string;
      // From our perspective: attacker is the enemy, defender is our unit
      if (combat.attackerDestroyed && combat.defenderDestroyed) {
        text = 'Both defeated';
        color = '#f39c12'; // orange
      } else if (combat.attackerDestroyed) {
        text = 'Victory';
        color = '#2ecc71'; // green
      } else if (combat.defenderDestroyed) {
        text = 'Defeat';
        color = '#e74c3c'; // red
      } else {
        text = 'Draw';
        color = '#aaaaaa'; // grey
      }
      combatResultRef.current = {
        text,
        x: toX,
        y: toY,
        startTime: performance.now(),
        color,
      };
      forceRender((n) => n + 1);
    }, CLASH_DURATION + FLASH_DURATION + 100);

    forceRender((n) => n + 1);
  }, [lastEnemyCombat]);

  // Redraw whenever dependencies change (imagesLoaded ensures redraw after sprites arrive)
  useEffect(() => {
    draw();
  }, [draw, imagesLoaded]);

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
      const { tileSize, cameraX, cameraY } = useGameStore.getState();
      if (e.ctrlKey) {
        // Pinch gesture → zoom
        const factor = Math.exp(-e.deltaY * 0.003);
        const newTileSize = Math.max(6, Math.min(64, tileSize * factor));
        if (newTileSize !== tileSize) {
          setTileSize(newTileSize);
          requestRedraw();
        }
      } else {
        // Two-finger scroll → pan
        const newCamX = cameraX + e.deltaX / tileSize;
        const newCamY = cameraY + e.deltaY / tileSize;
        setCamera(newCamX, newCamY);
        requestRedraw();
      }
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

          // For fighters, check if click is outside safe return range
          const isFighter = unit.type === UnitType.Fighter;
          if (isFighter) {
            const reachable = computeReachableTiles(unit, view, mapW, mapH);
            if (!reachable.has(`${tx},${ty}`)) {
              fadingTextRef.current = {
                text: 'Out of range',
                x: tx,
                y: ty,
                startTime: performance.now(),
                color: '#e74c3c',
              };
              forceRender((n) => n + 1);
              return;
            }
            // Check if clicking a full friendly carrier
            const targetCarrier = view.myUnits.find(
              (u) => u.x === tx && u.y === ty && u.type === UnitType.Carrier && u.carriedBy === null,
            );
            if (targetCarrier && targetCarrier.cargo.length >= UNIT_STATS[UnitType.Carrier].cargoCapacity) {
              fadingTextRef.current = {
                text: 'Carrier full',
                x: tx,
                y: ty,
                startTime: performance.now(),
                color: '#e74c3c',
              };
              forceRender((n) => n + 1);
              return;
            }
          }

          const path = computePath(unit.x, unit.y, tx, ty, unit.movesLeft, domain);

          // For air units on multi-step paths: trim any step that leaves the unit
          // unable to return to a friendly base (city or carrier).
          // Exception: missiles clicking directly on an enemy fly the full path (attack intent).
          // Single-step clicks bypass this entirely (player is acting intentionally).
          const isAir = domain === UnitDomain.Air;
          const attackingEnemy = view.visibleEnemyUnits.some(
            (e) => e.x === tx && e.y === ty && !e.carriedBy,
          );
          const isMissile = unit.type === UnitType.Missile;
          const shouldTrim = isAir && path.length > 1 && !(isMissile && attackingEnemy);
          const trimmedPath = shouldTrim ? (() => {
            const landingSpots = [
              ...view.myCities.map((c) => ({ x: c.x, y: c.y })),
              ...view.myUnits.filter(
                (u) => u.type === UnitType.Carrier &&
                  u.cargo.length < (UNIT_STATS[UnitType.Carrier].cargoCapacity ?? 2),
              ).map((u) => ({ x: u.x, y: u.y })),
            ];
            const distToBase = (x: number, y: number): number => {
              let min = Infinity;
              for (const s of landingSpots) {
                min = Math.min(min, Math.max(wrappedDistX(x, s.x, mapW), Math.abs(y - s.y)));
              }
              return min;
            };
            const hasFuel = unit.fuel !== undefined;
            let budget: number = hasFuel ? (unit.fuel as number) : unit.movesLeft;
            const safe: Coord[] = [];
            for (const step of path) {
              budget--;
              if (budget < 0) break;
              // Stop if no longer able to reach a friendly base from this position
              if (distToBase(step.x, step.y) > budget) break;
              safe.push(step);
            }
            return safe;
          })() : path;
          if (trimmedPath.length > 0) {
            // Check for enemy on any step of the path
            let enemyStepIdx = -1;
            for (let i = 0; i < trimmedPath.length; i++) {
              const step = trimmedPath[i];
              const enemy = view.visibleEnemyUnits.find(
                (e) => e.x === step.x && e.y === step.y && !e.carriedBy,
              );
              if (enemy) {
                enemyStepIdx = i;
                break;
              }
            }

            const knownEnemyIds = new Set(view.visibleEnemyUnits.map((e) => e.id));

            // If enemy is on the path, stop before it — never auto-attack
            if (enemyStepIdx >= 0) {
              const safePath = trimmedPath.slice(0, enemyStepIdx);
              if (safePath.length > 0) {
                playMoveSound(unit.type);
                moveAnimRef.current = {
                  unitId: unit.id,
                  unitType: unit.type,
                  unitOwner: unit.owner,
                  pathTiles: [{ x: unit.x, y: unit.y }, ...safePath],
                  startTime: performance.now(),
                  sentCount: 0,
                  knownEnemyIds,
                };
                sendAction({ type: 'MOVE', unitId: selectedUnitId, to: safePath[0] });
                moveAnimRef.current.sentCount = 1;
                forceRender((n) => n + 1);
              }
              // If enemy is the very first step, do nothing — player must click it directly
              return;
            }

            // No enemy on path — proceed with full movement
            playMoveSound(unit.type);
            moveAnimRef.current = {
              unitId: unit.id,
              unitType: unit.type,
              unitOwner: unit.owner,
              pathTiles: [{ x: unit.x, y: unit.y }, ...trimmedPath],
              startTime: performance.now(),
              sentCount: 0,
              knownEnemyIds,
            };
            sendAction({ type: 'MOVE', unitId: selectedUnitId, to: trimmedPath[0] });
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
      for (const [ddx, ddy] of [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[-1,1],[1,-1],[1,1]] as [number,number][]) {
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
      onMouseMove={(e) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const mx = (e.clientX - rect.left) * dpr;
        const my = (e.clientY - rect.top) * dpr;
        const { cameraX, cameraY, tileSize } = useGameStore.getState();
        const canvasW = canvas.width / dpr;
        const canvasH = canvas.height / dpr;
        const originX = cameraX * tileSize - canvasW / 2;
        const originY = cameraY * tileSize - canvasH / 2;
        const tx = Math.floor((mx / dpr + originX) / tileSize);
        const ty = Math.floor((my / dpr + originY) / tileSize);
        const prev = hoverTileRef.current;
        if (!prev || prev.x !== tx || prev.y !== ty) {
          hoverTileRef.current = { x: tx, y: ty };
          // Only trigger redraw if hovering over a ghost tile
          const ghosts = Object.values(useGameStore.getState().lastKnownEnemies);
          if (ghosts.some((g) => g.x === tx && g.y === ty) ||
              (prev && ghosts.some((g) => g.x === prev.x && g.y === prev.y))) {
            requestRedraw();
          }
        }
      }}
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
