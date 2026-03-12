import {
  type GameState,
  type City,
  type Unit,
  UnitType,
  UNIT_STATS,
} from '../types.js';

let nextProdId = 1000;
function genUnitId(): string {
  return `unit_${nextProdId++}`;
}

export function resetProductionIdCounter(): void {
  nextProdId = 1000;
}

/**
 * Advance production for all cities owned by the given player.
 * Returns any newly produced units.
 */
export function advanceProduction(
  state: GameState,
  playerId: string,
): Unit[] {
  const newUnits: Unit[] = [];

  for (const city of state.cities) {
    if (city.owner !== playerId) continue;
    if (city.producing === null) continue;

    city.productionTurnsLeft--;
    city.productionProgress++;

    if (city.productionTurnsLeft <= 0) {
      const stats = UNIT_STATS[city.producing];
      const unit: Unit = {
        id: genUnitId(),
        type: city.producing,
        owner: playerId as 'player1' | 'player2',
        x: city.x,
        y: city.y,
        health: stats.maxHealth,
        movesLeft: 0, // newly produced, can't move this turn
        fuel: stats.maxFuel,
        sleeping: false,
        hasAttacked: false,
        cargo: [],
        carriedBy: null,
      };
      newUnits.push(unit);
      state.units.push(unit);

      // Track bomber production for blast radius upgrades
      if (city.producing === UnitType.Bomber) {
        const pid = playerId as 'player1' | 'player2';
        state.bombersProduced[pid] = (state.bombersProduced[pid] ?? 0) + 1;
      }

      // Reset production timer and progress
      city.productionTurnsLeft = stats.buildTime;
      city.productionProgress = 0;
    }
  }

  return newUnits;
}

/**
 * Set production for a city. Preserves accumulated progress.
 */
export function setProduction(
  city: City,
  unitType: UnitType | null,
): void {
  if (unitType === null) {
    city.producing = null;
    city.productionTurnsLeft = 0;
    // Keep progress so resuming later remembers invested turns
    return;
  }
  const stats = UNIT_STATS[unitType];
  city.producing = unitType;
  city.productionTurnsLeft = Math.max(1, stats.buildTime - city.productionProgress);
}
