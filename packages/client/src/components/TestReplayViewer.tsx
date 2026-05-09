import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  Terrain,
  UnitType,
  UNIT_STATS,
  wrapX,
  TileVisibility,
} from '@sc/shared';
import type { City, Unit } from '@sc/shared';

// Cache tinted canvases keyed by "unitType:size:color"
const unitImageTintCache = new Map<string, HTMLCanvasElement>();

// ── Types ────────────────────────────────────────────────────

export interface TestReplayMeta {
  id: string;
  testName?: string;
  gameNum?: number;
  recordedAt: string;
  turns: number;
  winner: string | null;
  p1Cities: number;
  p2Cities: number;
  neutralCities: number;
  mapWidth: number;
  mapHeight: number;
  frames: number;
  p1Agent?: string;
  p2Agent?: string;
  passed?: boolean;
}

export interface TestReplayFrame {
  turn: number;
  currentPlayer: string;
  cities: City[];
  units: Unit[];
  winner: string | null;
  /** Fog of war for player1: set of "x,y" keys that are explored */
  p1Explored?: string[];
  /** Fog of war for player2: set of "x,y" keys that are explored */
  p2Explored?: string[];
}

export interface TestReplayData {
  meta: TestReplayMeta;
  tiles: Terrain[][];
  frames: TestReplayFrame[];
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

function ownerColor(owner: string | null): string {
  if (owner === 'player1') return COL_P1;
  if (owner === 'player2') return COL_P2;
  return COL_NEUTRAL;
}

// ── Drawing helpers ───────────────────────────────────────────

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

// ── Fog of War helpers ────────────────────────────────────────

/** Compute tile visibility for a player given explored set */
function computeVisibility(
  x: number,
  y: number,
  explored: Set<string>,
  visible: Set<string>
): TileVisibility {
  const key = `${x},${y}`;
  if (visible.has(key)) return TileVisibility.Visible;
  if (explored.has(key)) return TileVisibility.Seen;
  return TileVisibility.Hidden;
}

/** Get visible tiles for a player (vision radius around their units and cities) */
function getVisibleTiles(
  units: Unit[],
  cities: City[],
  mapWidth: number,
  mapHeight: number,
  playerId: string
): Set<string> {
  const visible = new Set<string>();
  const visionRadius = 2;

  const sources: { x: number; y: number }[] = [
    ...units.filter(u => u.owner === playerId),
    ...cities.filter(c => c.owner === playerId),
  ];

  for (const src of sources) {
    for (let dy = -visionRadius; dy <= visionRadius; dy++) {
      for (let dx = -visionRadius; dx <= visionRadius; dx++) {
        const nx = wrapX(src.x + dx, mapWidth);
        const ny = src.y + dy;
        if (ny < 0 || ny >= mapHeight) continue;
        visible.add(`${nx},${ny}`);
      }
    }
  }

  return visible;
}

// ── Canvas component for one player's view ────────────────────

interface PlayerViewCanvasProps {
  tiles: Terrain[][];
  frame: TestReplayFrame;
  player: 'player1' | 'player2';
  explored: Set<string>;
  showCoordinates: boolean;
}

const PlayerViewCanvas = React.memo(({
  tiles,
  frame,
  player,
  explored,
  showCoordinates,
}: PlayerViewCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [camState, setCamState] = useState({ ox: 0, oy: 0, scale: 1 });
  const draggingRef = useRef({ dragging: false, lx: 0, ly: 0 });
  const unitImagesRef = useRef<Partial<Record<UnitType, HTMLImageElement>>>({});
  const [imagesLoaded, setImagesLoaded] = useState(0);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const requestRedraw = useCallback(() => {
    // Trigger a re-render by updating a dummy state
    setImagesLoaded(n => n);
  }, []);

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

  // Load unit images
  useEffect(() => {
    for (const [type, src] of Object.entries(UNIT_IMAGE_SRCS) as [UnitType, string][]) {
      const img = new Image();
      img.src = src;
      img.onload = () => {
        unitImagesRef.current[type] = img;
        unitImageTintCache.clear();
        setImagesLoaded((n) => n + 1);
      };
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mapW = tiles[0]?.length ?? 0;
    const mapH = tiles.length;

    // Set canvas internal resolution to match display size for crisp rendering
    const width = canvasSize.width > 0 ? canvasSize.width : canvas.clientWidth;
    const height = canvasSize.height > 0 ? canvasSize.height : canvas.clientHeight;
    canvas.width = Math.max(width, 1);
    canvas.height = Math.max(height, 1);

    // Compute tile size to fit entire map in canvas
    const actualTileSize = Math.min(canvas.width / mapW, canvas.height / mapH);

    const mapPixelWidth = mapW * actualTileSize;
    const mapPixelHeight = mapH * actualTileSize;

    const { ox, oy, scale } = camState;

    ctx.save();

    // Center the map in the canvas (accounting for scale)
    const centerX = (canvas.width - mapPixelWidth * scale) / 2;
    const centerY = (canvas.height - mapPixelHeight * scale) / 2;
    ctx.translate(centerX + ox, centerY + oy);
    ctx.scale(scale, scale);

    // Visible tiles for this player
    const visible = getVisibleTiles(frame.units, frame.cities, mapW, mapH, player);

    // Draw tiles (coordinates are in unscaled space, so they get scaled by ctx.scale)
    for (let y = 0; y < mapH; y++) {
      for (let x = 0; x < mapW; x++) {
        const tx = x * actualTileSize;
        const ty = y * actualTileSize;
        const vis = computeVisibility(x, y, explored, visible);

        if (vis === TileVisibility.Hidden) {
          ctx.fillStyle = COL_FOG;
          ctx.fillRect(tx, ty, actualTileSize, actualTileSize);
          continue;
        }

        // Checkerboard pattern
        if (tiles[y][x] === Terrain.Ocean) {
          ctx.fillStyle = (x + y) % 2 === 0 ? COL_OCEAN : COL_OCEAN_ACCENT;
        } else {
          ctx.fillStyle = (x + y) % 2 === 0 ? COL_LAND : COL_LAND_ACCENT;
        }
        ctx.fillRect(tx, ty, actualTileSize, actualTileSize);

        // Dim seen tiles
        if (vis === TileVisibility.Seen) {
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          ctx.fillRect(tx, ty, actualTileSize, actualTileSize);
        }

        // Ice caps
        if (y === 0 || y === mapH - 1) {
          ctx.save();
          if (vis === TileVisibility.Seen) ctx.globalAlpha = 0.5;
          drawIceCap(ctx, tx, ty, actualTileSize, y === mapH - 1);
          ctx.restore();
        }

        // Tile coordinates (x,y) in top-left corner
        if (showCoordinates && actualTileSize >= 8) {
          ctx.save();
          ctx.font = `8px monospace`;
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.lineWidth = 1;
          const coordText = `(${x},${y})`;
          ctx.strokeText(coordText, tx + 2, ty + 10);
          ctx.fillText(coordText, tx + 2, ty + 10);
          ctx.restore();
        }
      }
    }

    // Grid
    ctx.strokeStyle = COL_GRID;
    ctx.lineWidth = 1;
    for (let x = 0; x <= mapW; x++) {
      ctx.beginPath(); ctx.moveTo(x * actualTileSize, 0); ctx.lineTo(x * actualTileSize, mapH * actualTileSize); ctx.stroke();
    }
    for (let y = 0; y <= mapH; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * actualTileSize); ctx.lineTo(mapW * actualTileSize, y * actualTileSize); ctx.stroke();
    }

    // Cities
    for (const city of frame.cities) {
      const cx = city.x * actualTileSize + actualTileSize / 2;
      const cy = city.y * actualTileSize + actualTileSize / 2;
      const vis = computeVisibility(city.x, city.y, explored, visible);
      if (vis === TileVisibility.Hidden) continue;

      const dimmed = vis === TileVisibility.Seen;
      ctx.fillStyle = ownerColor(city.owner);
      if (dimmed) ctx.globalAlpha = 0.5;
      ctx.fillRect(city.x * actualTileSize + 2, city.y * actualTileSize + 2, actualTileSize - 4, actualTileSize - 4);
      ctx.globalAlpha = 1;
      drawStar(ctx, cx, cy, actualTileSize * 0.25, '#fff');
    }

    // Units
    const unitMap = new Map<string, Unit[]>();
    for (const unit of frame.units) {
      const key = `${unit.x},${unit.y}`;
      if (!unitMap.has(key)) unitMap.set(key, []);
      unitMap.get(key)!.push(unit);
    }

    for (const [key, units] of unitMap.entries()) {
      const [x, y] = key.split(',').map(Number);
      const vis = computeVisibility(x, y, explored, visible);
      if (vis === TileVisibility.Hidden) continue;

      const dimmed = vis === TileVisibility.Seen;
      const cx = x * actualTileSize + actualTileSize / 2;
      const cy = y * actualTileSize + actualTileSize / 2;

      for (const unit of units) {
        const isMyUnit = unit.owner === player;

        // Skip enemy units that aren't visible
        if (!isMyUnit && vis !== TileVisibility.Visible) continue;

        const color = ownerColor(unit.owner);
        if (dimmed) ctx.globalAlpha = 0.5;

        drawUnit(ctx, unit.type, cx, cy, actualTileSize, color, unitImagesRef.current);

        ctx.globalAlpha = 1;
      }

      // Stack count (exclude carried units)
      const visibleUnits = units.filter((u) => !u.carriedBy);
      if (visibleUnits.length > 1) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(actualTileSize * 0.4)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(visibleUnits.length.toString(), cx, cy);
      }

      // Cargo count for transports/carriers
      const transport = units.find((u) => u.type === UnitType.Transport || u.type === UnitType.Carrier);
      if (transport && transport.cargo.length > 0 && actualTileSize >= 14) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.floor(actualTileSize * 0.3)}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(transport.cargo.length.toString(), cx - actualTileSize / 2 + 2, cy - actualTileSize / 2 + 1);
      }
    }

    ctx.restore();
  }, [tiles, frame, player, explored, camState, canvasSize, imagesLoaded, showCoordinates]);

  
  // Camera controls
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Set initial canvas size from parent container
    const updateSize = () => {
      const parent = canvas.parentElement;
      if (parent) {
        setCanvasSize({ width: parent.clientWidth, height: parent.clientHeight });
      }
    };
    updateSize();

    const resizeObserver = new ResizeObserver(() => {
      updateSize();
      requestRedraw();
    });
    resizeObserver.observe(canvas.parentElement!);

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Left click only for dragging
      e.preventDefault();
      draggingRef.current.dragging = true;
      draggingRef.current.lx = e.clientX;
      draggingRef.current.ly = e.clientY;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current.dragging) return;
      e.preventDefault();
      const dx = e.clientX - draggingRef.current.lx;
      const dy = e.clientY - draggingRef.current.ly;
      draggingRef.current.lx = e.clientX;
      draggingRef.current.ly = e.clientY;
      setCamState(prev => ({ ...prev, ox: prev.ox + dx, oy: prev.oy + dy }));
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      draggingRef.current.dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setCamState(prev => ({ ...prev, scale: Math.max(0.25, Math.min(4, prev.scale * factor)) }));
    };

    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      resizeObserver.disconnect();
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const mapW = tiles[0]?.length ?? 0;
  const mapH = tiles.length;

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        cursor: 'grab',
        imageRendering: 'pixelated',
      }}
      title="Drag to pan, scroll to zoom"
    />
  );
});

// Main TestReplayViewer component
export function TestReplayViewer() {
  const [data, setData] = useState<TestReplayData | null>(null);
  const [replayList, setReplayList] = useState<TestReplayMeta[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [showCoordinates, setShowCoordinates] = useState(false);

  // Load replay list
  useEffect(() => {
    fetch('/api/replays')
      .then(r => r.json())
      .then((d: { replays: TestReplayMeta[] }) => setReplayList(d.replays ?? []))
      .catch(err => console.error('Failed to load replay list:', err));
  }, []);

  // Load replay from URL param or selected replay
  const loadReplay = (replayId: string) => {
    const id = replayId.endsWith('.json') ? replayId.slice(0, -5) : replayId;
    fetch(`/api/replays/${id}`)
      .then(r => r.json())
      .then(setData)
      .catch(err => console.error('Failed to load replay:', err));
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let replayId = params.get('testReplay');
    if (!replayId) return;
    loadReplay(replayId);
  }, []);

  if (!data) {
    return <div style={{ padding: 20 }}>Loading replay...</div>;
  }

  const { meta, tiles, frames } = data;

  // Use all frames (including step-by-step actions), not deduplicated by turn
  const allFrames = [...frames].sort((a, b) => {
    if (a.turn !== b.turn) return a.turn - b.turn;
    return 0;
  });
  const totalFrames = allFrames.length;

  const frame = allFrames[frameIdx];

  // Compute explored sets for current frame
  const p1Explored = new Set(frame.p1Explored ?? []);
  const p2Explored = new Set(frame.p2Explored ?? []);

  return (
    <div style={{ margin: 0, padding: 0, fontFamily: 'sans-serif', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ marginBottom: 15, flexShrink: 0, padding: '10px', background: '#1a1a2e', borderRadius: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <input
            type="checkbox"
            checked={showCoordinates}
            onChange={(e) => setShowCoordinates(e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          <span style={{ color: '#ccc' }}>Coords</span>
          <span style={{ fontWeight: 'bold', color: '#ccc', marginLeft: '20px' }}>Select Test Replay:</span>
          <select
            value={meta.id}
            onChange={(e) => {
              const selectedId = e.target.value;
              const url = new URL(window.location.href);
              url.searchParams.set('testReplay', selectedId);
              window.location.search = url.searchParams.toString();
            }}
            style={{ fontSize: 14, padding: '6px 10px', borderRadius: '4px', border: '1px solid #444', background: '#2a2a4e', color: '#fff' }}
          >
            {replayList.map((r) => (
              <option key={r.id} value={r.id}>
                {r.passed ? '[PASS]' : '[FAIL]'} {r.testName ?? r.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <h2 style={{ marginTop: 0, marginBottom: 15, flexShrink: 0, color: '#fff' }}>
        {meta.passed ? '[PASS]' : '[FAIL]'} {meta.testName ?? meta.id.slice(0, 8)}
      </h2>

      <div style={{ display: 'flex', gap: 20, flex: 1, minHeight: 0 }}>
        <div style={{ border: '2px solid #4a9eed', padding: 8, display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: '0 0 8px 0', color: '#4a9eed', flexShrink: 0 }}>Player 1 View - {meta.p1Agent ?? 'unknown'}</h3>
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            <PlayerViewCanvas
              tiles={tiles}
              frame={frame}
              player="player1"
              explored={p1Explored}
              showCoordinates={showCoordinates}
            />
          </div>
        </div>

        <div style={{ border: '2px solid #ed4a4a', padding: 8, display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: '0 0 8px 0', color: '#ed4a4a', flexShrink: 0 }}>Player 2 View - {meta.p2Agent ?? 'unknown'}</h3>
          <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
            <PlayerViewCanvas
              tiles={tiles}
              frame={frame}
              player="player2"
              explored={p2Explored}
              showCoordinates={showCoordinates}
            />
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 20, flexShrink: 0 }}>
        <label>
          Frame {frameIdx + 1} / {totalFrames} (Turn {frame.turn})
          <input
            type="range"
            min={0}
            max={totalFrames - 1}
            value={frameIdx}
            onChange={(e) => setFrameIdx(Number(e.target.value))}
            style={{ width: '80%', margin: '8px 0' }}
          />
        </label>
      </div>

      <div style={{ fontSize: 13, color: '#ccc', background: '#1a1a2e', padding: '12px', borderRadius: '8px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
        {meta.testName === 'test_armyMoveToCoastAndBoardTransport' && (
          <>
            <div>=== Test: Army Move to Coast and Board Transport ===</div>
            <div>Map: 8x6, Land at cols 2-4, rows 2-4</div>
            <div>Army at (3,3), Transport at (5,3), City at (3,4)</div>
            <div style={{ marginTop: '8px' }}>Turn 1 player1: {`{"type":"SKIP","unitId":"transport1"}`}</div>
            <div>Turn 1 player1: {`{"type":"MOVE","unitId":"army1","to":{"x":4,"y":3}}`}</div>
            <div>Turn 1 player1: {`{"type":"LOAD","unitId":"army1","transportId":"transport1"}`}</div>
            <div style={{ marginTop: '8px', color: '#4ade80' }}>=== TEST PASSED: Army boarded transport ===</div>
            <div>SUCCESS: Army is onboard transport</div>
          </>
        )}
        {meta.testName === 'test_armyMoveToCoastAndBoardTransport_2' && (
          <>
            <div>=== Test: Army Move to Coast and Board Transport (2) ===</div>
            <div>Map: 10x8, 6x6 Island at cols 2-7, rows 1-6</div>
            <div>Army at (2,3) [west], Transport at (9,3) [east coast], City at (5,3) [middle]</div>
            <div style={{ marginTop: '8px' }}>Turn 1 player1: {`{"type":"SKIP","unitId":"transport1"}`}</div>
            <div>Turn 1 player1: {`{"type":"SKIP","unitId":"army1"}`}</div>
            <div>Turn 1 player1: {`{"type":"SET_PRODUCTION","cityId":"city1","unitType":"army"}`}</div>
            <div>Turn 1 player1: {`{"type":"END_TURN"}`}</div>
            <div>Turn 1 player2: {`{"type":"END_TURN"}`}</div>
            <div style={{ marginTop: '8px', color: '#f87171' }}>FAILED: Army did not board transport</div>
            <div>Army at (2,3), Transport at (9,3)</div>
          </>
        )}
      </div>
    </div>
  );
}

