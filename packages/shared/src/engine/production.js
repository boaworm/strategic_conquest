import { UnitType, UNIT_STATS, } from '../types.js';
let nextProdId = 1000;
function genUnitId() {
    return `unit_${nextProdId++}`;
}
export function resetProductionIdCounter() {
    nextProdId = 1000;
}
/**
 * Advance production for all cities owned by the given player.
 * Returns any newly produced units.
 */
export function advanceProduction(state, playerId) {
    const newUnits = [];
    for (const city of state.cities) {
        if (city.owner !== playerId)
            continue;
        if (city.producing === null)
            continue;
        city.productionTurnsLeft--;
        city.productionProgress++;
        if (city.productionTurnsLeft <= 0) {
            const stats = UNIT_STATS[city.producing];
            const unit = {
                id: genUnitId(),
                type: city.producing,
                owner: playerId,
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
                const pid = playerId;
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
export function setProduction(city, unitType) {
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
//# sourceMappingURL=production.js.map