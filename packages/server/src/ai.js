import { UNIT_STATS, UnitType as UT, UnitDomain as UD, Terrain as T, TileVisibility as TV, wrapX, wrappedDistX, } from '@sc/shared';
/**
 * A basic greedy AI that:
 * 1. Sets all idle cities to produce armies (early game) or a mix of units
 * 2. Sends armies toward the nearest neutral or enemy city
 * 3. Attacks enemy units within reach
 * 4. Handles naval/air units with simple heuristics
 */
export class BasicAgent {
    playerId;
    mapWidth;
    mapHeight;
    init(config) {
        this.playerId = config.playerId;
        this.mapWidth = config.mapWidth;
        this.mapHeight = config.mapHeight;
    }
    act(obs) {
        // 1. Set production for any idle city
        for (const city of obs.myCities) {
            if (city.producing === null) {
                const unitType = this.chooseProduction(obs, city);
                return { type: 'SET_PRODUCTION', cityId: city.id, unitType };
            }
        }
        // 2. Move units that still have moves
        for (const unit of obs.myUnits) {
            if (unit.sleeping || unit.movesLeft <= 0 || unit.carriedBy !== null)
                continue;
            const action = this.decideUnitAction(obs, unit);
            if (action)
                return action;
        }
        return { type: 'END_TURN' };
    }
    chooseProduction(obs, _city) {
        const armyCount = obs.myUnits.filter((u) => u.type === UT.Infantry).length;
        const cityCount = obs.myCities.length;
        // Early game: build armies to expand
        if (armyCount < cityCount * 2 + 3) {
            return UT.Infantry;
        }
        // Mix in naval units when we have enough armies
        const hasCoastalNeed = obs.visibleEnemyCities.some((c) => this.requiresNavalApproach(obs, c));
        if (hasCoastalNeed) {
            const transportCount = obs.myUnits.filter((u) => u.type === UT.Transport).length;
            if (transportCount < 2)
                return UT.Transport;
            const destroyerCount = obs.myUnits.filter((u) => u.type === UT.Destroyer).length;
            if (destroyerCount < 1)
                return UT.Destroyer;
        }
        // Default to infantry
        return UT.Infantry;
    }
    requiresNavalApproach(obs, target) {
        // Simple check: is there ocean between our nearest city and the target?
        const nearest = this.nearestCity(obs.myCities, target);
        if (!nearest)
            return false;
        const dist = this.wrappedDist(nearest, target);
        return dist > 8;
    }
    decideUnitAction(obs, unit) {
        const stats = UNIT_STATS[unit.type];
        // Try to attack an adjacent enemy
        const adjacentEnemy = this.findAdjacentEnemy(obs, unit);
        if (adjacentEnemy) {
            return { type: 'MOVE', unitId: unit.id, to: { x: adjacentEnemy.x, y: adjacentEnemy.y } };
        }
        if (stats.domain === UD.Land) {
            return this.decideLandUnit(obs, unit);
        }
        if (stats.domain === UD.Sea) {
            return this.decideSeaUnit(obs, unit);
        }
        if (stats.domain === UD.Air) {
            return this.decideAirUnit(obs, unit);
        }
        return null;
    }
    decideLandUnit(obs, unit) {
        // Priority 1: Move toward nearest neutral city to capture
        const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
        const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);
        // Prefer closer neutral cities
        const target = this.nearestCity([...neutralCities, ...enemyCities], unit);
        if (target) {
            return this.moveToward(obs, unit, target);
        }
        // Explore: move toward unexplored area
        return this.moveTowardExploration(obs, unit);
    }
    decideSeaUnit(obs, unit) {
        const stats = UNIT_STATS[unit.type];
        // Transports: try to carry armies
        if (stats.cargoCapacity > 0 && unit.type === UT.Transport) {
            // If carrying armies, move toward enemy/neutral coastal city
            if (unit.cargo.length > 0) {
                const coastalTarget = this.nearestCity(obs.visibleEnemyCities, unit);
                if (coastalTarget) {
                    // Try to unload adjacent to target
                    const adj = this.getAdjacentLand(obs, unit);
                    if (adj) {
                        const cargoId = unit.cargo[0];
                        return { type: 'UNLOAD', unitId: cargoId, to: adj };
                    }
                    return this.moveToward(obs, unit, coastalTarget);
                }
            }
            // Look for armies to load (same tile or adjacent)
            const armyToLoad = obs.myUnits.find((u) => u.type === UT.Infantry &&
                u.carriedBy === null &&
                unit.cargo.length < stats.cargoCapacity &&
                u.movesLeft > 0 &&
                wrappedDistX(u.x, unit.x, obs.tiles[0].length) <= 1 &&
                Math.abs(u.y - unit.y) <= 1);
            if (armyToLoad) {
                return { type: 'LOAD', unitId: armyToLoad.id, transportId: unit.id };
            }
        }
        // Combat ships: move toward visible enemy units
        const enemyShip = this.nearestEnemy(obs.visibleEnemyUnits.filter((u) => UNIT_STATS[u.type].domain === UD.Sea), unit);
        if (enemyShip) {
            return this.moveToward(obs, unit, enemyShip);
        }
        return this.moveTowardExploration(obs, unit);
    }
    decideAirUnit(obs, unit) {
        // If low fuel, return to nearest city or carrier
        if (unit.fuel !== undefined && unit.fuel <= 4) {
            const refuel = this.nearestCity(obs.myCities, unit);
            if (refuel) {
                return this.moveToward(obs, unit, refuel);
            }
        }
        // Attack nearest enemy
        const enemy = this.nearestEnemy(obs.visibleEnemyUnits, unit);
        if (enemy) {
            return this.moveToward(obs, unit, enemy);
        }
        // Scout
        return this.moveTowardExploration(obs, unit);
    }
    // ── Helpers ──────────────────────────────────────────────
    findAdjacentEnemy(obs, unit) {
        return obs.visibleEnemyUnits.find((e) => {
            const dx = wrappedDistX(e.x, unit.x, this.mapWidth);
            const dy = Math.abs(e.y - unit.y);
            return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
        });
    }
    moveToward(obs, unit, target) {
        const best = this.bestStepToward(obs, unit, target);
        if (best) {
            return { type: 'MOVE', unitId: unit.id, to: best };
        }
        return null;
    }
    bestStepToward(obs, unit, target) {
        const stats = UNIT_STATS[unit.type];
        const candidates = this.getAdjacentTiles(unit.x, unit.y);
        let bestDist = Infinity;
        let bestCoord = null;
        for (const c of candidates) {
            if (c.y < 0 || c.y >= this.mapHeight)
                continue;
            const tile = obs.tiles[c.y]?.[c.x];
            if (!tile)
                continue;
            // Check terrain compatibility
            if (stats.domain === UD.Land && tile.terrain === T.Ocean)
                continue;
            if (stats.domain === UD.Sea && tile.terrain === T.Land) {
                // Sea units can enter city tiles — check if there's a city
                const hasCity = [...obs.myCities, ...obs.visibleEnemyCities].some((ct) => ct.x === c.x && ct.y === c.y);
                if (!hasCity)
                    continue;
            }
            const dist = this.wrappedDist(c, target);
            if (dist < bestDist) {
                bestDist = dist;
                bestCoord = c;
            }
        }
        return bestCoord;
    }
    moveTowardExploration(obs, unit) {
        // Move toward nearest hidden tile
        const stats = UNIT_STATS[unit.type];
        const candidates = this.getAdjacentTiles(unit.x, unit.y);
        // Prefer tiles adjacent to hidden areas
        let bestScore = -Infinity;
        let bestCoord = null;
        for (const c of candidates) {
            if (c.y < 0 || c.y >= this.mapHeight)
                continue;
            const tile = obs.tiles[c.y]?.[c.x];
            if (!tile)
                continue;
            if (stats.domain === UD.Land && tile.terrain === T.Ocean)
                continue;
            if (stats.domain === UD.Sea && tile.terrain === T.Land) {
                const hasCity = [...obs.myCities, ...obs.visibleEnemyCities].some((ct) => ct.x === c.x && ct.y === c.y);
                if (!hasCity)
                    continue;
            }
            // Score: number of adjacent hidden tiles (encourages exploring fog)
            let score = 0;
            for (const adj of this.getAdjacentTiles(c.x, c.y)) {
                if (adj.y < 0 || adj.y >= this.mapHeight)
                    continue;
                const adjTile = obs.tiles[adj.y]?.[adj.x];
                if (adjTile && adjTile.visibility === TV.Hidden) {
                    score++;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestCoord = c;
            }
        }
        if (bestCoord && bestScore > 0) {
            return { type: 'MOVE', unitId: unit.id, to: bestCoord };
        }
        // No hidden tiles nearby — just pick a random valid adjacent tile
        const valid = candidates.filter((c) => {
            if (c.y < 0 || c.y >= this.mapHeight)
                return false;
            const tile = obs.tiles[c.y]?.[c.x];
            if (!tile)
                return false;
            if (stats.domain === UD.Land && tile.terrain === T.Ocean)
                return false;
            if (stats.domain === UD.Sea && tile.terrain === T.Land)
                return false;
            return true;
        });
        if (valid.length > 0) {
            const pick = valid[Math.floor(Math.random() * valid.length)];
            return { type: 'MOVE', unitId: unit.id, to: pick };
        }
        return null;
    }
    getAdjacentTiles(x, y) {
        const dirs = [
            { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
            { x: -1, y: 0 }, { x: 1, y: 0 },
            { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
        ];
        return dirs.map((d) => ({
            x: wrapX(x + d.x, this.mapWidth),
            y: y + d.y,
        }));
    }
    getAdjacentLand(obs, unit) {
        const adj = this.getAdjacentTiles(unit.x, unit.y);
        for (const c of adj) {
            if (c.y < 0 || c.y >= this.mapHeight)
                continue;
            const tile = obs.tiles[c.y]?.[c.x];
            if (tile && tile.terrain === T.Land) {
                return c;
            }
        }
        return null;
    }
    nearestCity(cities, from) {
        let best = null;
        let bestDist = Infinity;
        for (const c of cities) {
            const d = this.wrappedDist(c, from);
            if (d < bestDist) {
                bestDist = d;
                best = c;
            }
        }
        return best;
    }
    nearestEnemy(enemies, from) {
        let best = null;
        let bestDist = Infinity;
        for (const e of enemies) {
            const d = this.wrappedDist(e, from);
            if (d < bestDist) {
                bestDist = d;
                best = e;
            }
        }
        return best;
    }
    wrappedDist(a, b) {
        return wrappedDistX(a.x, b.x, this.mapWidth) + Math.abs(a.y - b.y);
    }
}
//# sourceMappingURL=ai.js.map