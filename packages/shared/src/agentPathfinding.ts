/**
 * Shared pathfinding utilities for agents.
 * Extracted so both BasicAgent and NnMoEAgent use identical BFS logic.
 */

import type { AgentObservation } from './agent.js';
import type { UnitView, Coord } from './types.js';
import { UnitType, UnitDomain, UNIT_STATS, Terrain, TileVisibility, wrapX, wrappedDistX } from './types.js';

export function getAdjacentTiles(x: number, y: number, mapWidth: number): Coord[] {
  return [
    { x: wrapX(x - 1, mapWidth), y: y - 1 },
    { x,                          y: y - 1 },
    { x: wrapX(x + 1, mapWidth), y: y - 1 },
    { x: wrapX(x - 1, mapWidth), y        },
    { x: wrapX(x + 1, mapWidth), y        },
    { x: wrapX(x - 1, mapWidth), y: y + 1 },
    { x,                          y: y + 1 },
    { x: wrapX(x + 1, mapWidth), y: y + 1 },
  ];
}

export function wrappedDist(a: Coord, b: Coord, mapWidth: number): number {
  return wrappedDistX(a.x, b.x, mapWidth) + Math.abs(a.y - b.y);
}

export function makeCanEnter(
  obs: AgentObservation,
  unit: UnitView,
  mapHeight: number,
): (x: number, y: number) => boolean {
  const stats = UNIT_STATS[unit.type];
  const enemyPositions = unit.type === UnitType.Transport
    ? new Set(obs.visibleEnemyUnits.map((e) => `${e.x},${e.y}`))
    : null;
  // Pre-index friendly transports with room for boarding checks
  const friendlyTransportsWithRoom = stats.domain === UnitDomain.Land
    ? new Map(
        obs.myUnits
          .filter(u => UNIT_STATS[u.type].canCarry.includes(unit.type) &&
                       (u as any).cargo?.length < UNIT_STATS[u.type].cargoCapacity)
          .map(u => [`${u.x},${u.y}`, u])
      )
    : null;
  return (x: number, y: number): boolean => {
    if (y <= 0 || y >= mapHeight - 1) return false;
    if (enemyPositions?.has(`${x},${y}`)) return false;
    const tile = obs.tiles[y]?.[x];
    if (stats.domain === UnitDomain.Land) {
      if (!!tile && tile.terrain === Terrain.Land) return true;
      // Allow boarding a friendly transport on an ocean tile
      return friendlyTransportsWithRoom?.has(`${x},${y}`) ?? false;
    }
    if (stats.domain === UnitDomain.Sea) {
      if (!tile || tile.visibility === TileVisibility.Hidden) return true;
      if (tile.terrain === Terrain.Ocean) return true;
      return obs.myCities.some((c) => c.x === x && c.y === y);
    }
    // Air
    return !!tile;
  };
}

/**
 * BFS from unit toward target. Returns the first step (single adjacent tile)
 * on the shortest valid path, or null if unreachable.
 */
export function bestStepToward(
  obs: AgentObservation,
  unit: UnitView,
  target: Coord,
  mapWidth: number,
  mapHeight: number,
): Coord | null {
  const canEnter = makeCanEnter(obs, unit, mapHeight);
  const visited = new Set<string>();
  visited.add(`${unit.x},${unit.y}`);
  const queue: Array<{ x: number; y: number; first: Coord | null }> = [
    { x: unit.x, y: unit.y, first: null },
  ];
  const MAX = mapWidth * mapHeight;
  while (queue.length > 0 && visited.size < MAX) {
    const cur = queue.shift()!;
    const neighbors = getAdjacentTiles(cur.x, cur.y, mapWidth)
      .filter((n) => n.y > 0 && n.y < mapHeight - 1)
      .sort((a, b) => wrappedDist(a, target, mapWidth) - wrappedDist(b, target, mapWidth));
    for (const n of neighbors) {
      const k = `${n.x},${n.y}`;
      if (visited.has(k)) continue;
      visited.add(k);
      const firstStep = cur.first ?? n;
      if (n.x === target.x && n.y === target.y) {
        if (!canEnter(n.x, n.y)) {
          if (firstStep.x === n.x && firstStep.y === n.y) return null;
          return firstStep;
        }
        return firstStep;
      }
      if (!canEnter(n.x, n.y)) continue;
      queue.push({ x: n.x, y: n.y, first: firstStep });
    }
  }
  return null;
}
