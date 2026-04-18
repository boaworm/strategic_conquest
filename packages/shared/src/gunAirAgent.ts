/**
 * GunAirAgent — a minimal skeleton AI for demonstration and testing.
 *
 * Behaviour:
 *  - Armies: each army moves one step in a random legal direction.
 *  - Production: assign a random unit type. When a unit is completed
 *    (productionTurnsLeft === 0 and city just produced), switch to a
 *    different random unit type.
 *  - Everything else (naval, air, etc.): skipped — END_TURN after armies.
 */

import type { Agent, AgentAction, AgentConfig, AgentObservation } from './agent.js';
import { UnitType, Terrain } from './types.js';
import type { UnitView, CityView } from './types.js';
import { wrapX } from './types.js';

const ALL_UNIT_TYPES: UnitType[] = [
  UnitType.Army,
  UnitType.Fighter,
  UnitType.Missile,
  UnitType.Transport,
  UnitType.Destroyer,
  UnitType.Submarine,
  UnitType.Carrier,
  UnitType.Battleship,
];

function randomOther(exclude: UnitType): UnitType {
  const choices = ALL_UNIT_TYPES.filter((t) => t !== exclude);
  return choices[Math.floor(Math.random() * choices.length)];
}

export class GunAirAgent implements Agent {
  private mapWidth = 0;
  private mapHeight = 0;
  private playerId = '';

  // Track which cities have had production set this turn to avoid re-setting them.
  private productionSet = new Set<string>();

  // Track which units have been acted on this call cycle (turn).
  private actedUnits = new Set<string>();

  // Track last known production per city so we can detect completion.
  private cityProduction = new Map<string, UnitType | null>();

  init(config: AgentConfig): void {
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    this.playerId = config.playerId;
  }

  act(obs: AgentObservation): AgentAction {
    // Reset per-turn tracking when currentPlayer changes back to us.
    // `act` is called once per action, so we reset on the very first call
    // of a new turn by checking if actedUnits still has entries from last turn.
    // Simplest heuristic: clear at turn start via a stored turn counter.
    if (this.lastTurn !== obs.turn) {
      this.lastTurn = obs.turn;
      this.actedUnits.clear();
      this.productionSet.clear();
    }

    // ── 1. Set production for any city that needs it ──────────────────────
    for (const city of obs.myCities) {
      if (this.productionSet.has(city.id)) continue;

      const needsAssignment =
        city.producing === null ||
        // Detect completion: turnsLeft just hit 0, meaning unit was delivered.
        city.productionTurnsLeft === 0;

      if (needsAssignment) {
        this.productionSet.add(city.id);
        const current = city.producing ?? UnitType.Army;
        // Pick a different random type on completion; any random type if idle.
        const next = city.producing !== null ? randomOther(current) : ALL_UNIT_TYPES[Math.floor(Math.random() * ALL_UNIT_TYPES.length)];
        return { type: 'SET_PRODUCTION', cityId: city.id, unitType: next };
      }
    }

    // ── 2. Move each army one step in a random legal direction ────────────
    const armies = obs.myUnits.filter(
      (u) => u.type === UnitType.Army && u.movesLeft > 0 && u.carriedBy === null && !u.sleeping,
    );

    for (const army of armies) {
      if (this.actedUnits.has(army.id)) continue;

      const move = this.randomArmyMove(obs, army);
      if (move) {
        this.actedUnits.add(army.id);
        return move;
      }
      // No legal move — skip this unit so we don't loop forever.
      this.actedUnits.add(army.id);
      return { type: 'SKIP', unitId: army.id };
    }

    // ── 3. Done — end the turn ────────────────────────────────────────────
    return { type: 'END_TURN' };
  }

  private lastTurn = -1;

  /** Pick a random adjacent tile that an army can step onto. */
  private randomArmyMove(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const dirs = [
      { x: 0, y: -1 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ];

    // Shuffle directions so we don't always prefer the same axis.
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }

    for (const d of dirs) {
      const nx = wrapX(unit.x + d.x, this.mapWidth);
      const ny = unit.y + d.y;

      if (ny < 1 || ny > this.mapHeight - 2) continue; // ice caps / off-map

      const tile = obs.tiles[ny]?.[nx];
      if (!tile) continue;
      if (tile.terrain !== Terrain.Land) continue; // armies can only walk on land

      return { type: 'MOVE', unitId: unit.id, to: { x: nx, y: ny } };
    }

    return null; // surrounded by ocean / ice — no legal move
  }
}
