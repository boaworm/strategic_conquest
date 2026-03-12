import {
  type Agent,
  type AgentAction,
  type AgentConfig,
  type AgentObservation,
  type UnitView,
  type CityView,
  type Coord,
  UnitType,
  UnitDomain,
  UNIT_STATS,
  Terrain,
  TileVisibility,
  wrapX,
  wrappedDistX,
} from '@sc/shared';
import { type Genome, FEATURE_NAMES } from '../genetics/genome.js';

/**
 * An AI agent driven by a genome (weight vector).
 * Uses the weights to score candidate actions and picks the highest-scoring one.
 */
export class EvolvedAgent implements Agent {
  private playerId!: string;
  private mapWidth!: number;
  private mapHeight!: number;

  constructor(private genome: Genome) {}

  init(config: AgentConfig): void {
    this.playerId = config.playerId;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
  }

  act(obs: AgentObservation): AgentAction {
    // 1. Set production for any idle city
    for (const city of obs.myCities) {
      if (city.producing === null) {
        return { type: 'SET_PRODUCTION', cityId: city.id, unitType: this.chooseProduction(obs) };
      }
    }

    // 2. Move units that still have moves
    for (const unit of obs.myUnits) {
      if (unit.sleeping || unit.movesLeft <= 0 || unit.carriedBy !== null) continue;

      const action = this.scoreMoves(obs, unit);
      if (action) return action;
    }

    return { type: 'END_TURN' };
  }

  // ── Production decision (genome-weighted) ──────────────────

  private chooseProduction(obs: AgentObservation): UnitType {
    const globalFeatures = this.extractGlobalFeatures(obs);
    const unitTypes = [
      UnitType.Infantry, UnitType.Fighter, UnitType.Bomber,
      UnitType.Transport, UnitType.Destroyer, UnitType.Submarine,
      UnitType.Carrier, UnitType.Battleship,
    ];
    const prodFeatureNames = [
      'prodArmy', 'prodFighter', 'prodBomber',
      'prodTransport', 'prodDestroyer', 'prodSubmarine',
      'prodCarrier', 'prodBattleship',
    ] as const;

    let bestScore = -Infinity;
    let bestType = UnitType.Infantry;

    for (let i = 0; i < unitTypes.length; i++) {
      const featureIdx = FEATURE_NAMES.indexOf(prodFeatureNames[i]);
      // Base score from genome weight
      let score = this.genome.weights[featureIdx];

      // Modulate by global features (e.g., favor armies when city ratio is bad)
      const cityRatioIdx = FEATURE_NAMES.indexOf('myCityCount');
      const enemyCityIdx = FEATURE_NAMES.indexOf('enemyCityCount');
      const myCities = globalFeatures[cityRatioIdx];
      const enemyCities = globalFeatures[enemyCityIdx];

      if (unitTypes[i] === UnitType.Infantry) {
        // Boost army production when we have fewer cities
        score += (enemyCities - myCities) * 0.1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestType = unitTypes[i];
      }
    }

    return bestType;
  }

  // ── Movement decision (genome-scored) ──────────────────────

  private scoreMoves(obs: AgentObservation, unit: UnitView): AgentAction | null {
    const stats = UNIT_STATS[unit.type];
    const candidates = this.getAdjacentTiles(unit.x, unit.y);
    let bestScore = -Infinity;
    let bestCoord: Coord | null = null;

    for (const c of candidates) {
      if (c.y < 0 || c.y >= this.mapHeight) continue;
      const tile = obs.tiles[c.y]?.[c.x];
      if (!tile) continue;

      // Domain check
      if (stats.domain === UnitDomain.Land && tile.terrain === Terrain.Ocean) continue;
      if (stats.domain === UnitDomain.Sea && tile.terrain === Terrain.Land) {
        const hasCity = [...obs.myCities, ...obs.visibleEnemyCities].some(
          (ct) => ct.x === c.x && ct.y === c.y,
        );
        if (!hasCity) continue;
      }

      const features = this.extractMoveFeatures(obs, unit, c);
      const score = this.dotProduct(features);

      if (score > bestScore) {
        bestScore = score;
        bestCoord = c;
      }
    }

    if (bestCoord) {
      return { type: 'MOVE', unitId: unit.id, to: bestCoord };
    }
    return null;
  }

  // ── Feature extraction ─────────────────────────────────────

  private extractMoveFeatures(obs: AgentObservation, unit: UnitView, target: Coord): number[] {
    const features = new Array(FEATURE_NAMES.length).fill(0);

    // Distance features (lower = better, so negate for scoring)
    const neutralCities = obs.visibleEnemyCities.filter((c) => c.owner === null);
    const enemyCities = obs.visibleEnemyCities.filter((c) => c.owner !== null);

    const nearestNeutral = this.nearestDist(neutralCities, target);
    const nearestEnemy = this.nearestDist(enemyCities, target);
    const nearestEnemyUnit = this.nearestDist(obs.visibleEnemyUnits, target);
    const nearestFriendly = this.nearestDist(
      obs.myUnits.filter((u) => u.id !== unit.id),
      target,
    );

    const maxDist = this.mapWidth + this.mapHeight;

    features[FEATURE_NAMES.indexOf('distToNearestNeutralCity')] =
      nearestNeutral === null ? 0 : 1 - nearestNeutral / maxDist;
    features[FEATURE_NAMES.indexOf('distToNearestEnemyCity')] =
      nearestEnemy === null ? 0 : 1 - nearestEnemy / maxDist;
    features[FEATURE_NAMES.indexOf('distToNearestEnemy')] =
      nearestEnemyUnit === null ? 0 : 1 - nearestEnemyUnit / maxDist;
    features[FEATURE_NAMES.indexOf('distToNearestFriendly')] =
      nearestFriendly === null ? 0 : 1 - nearestFriendly / maxDist;

    // Adjacent counts
    let adjEnemy = 0;
    let adjFriendly = 0;
    for (const adj of this.getAdjacentTiles(target.x, target.y)) {
      for (const e of obs.visibleEnemyUnits) {
        if (e.x === adj.x && e.y === adj.y) adjEnemy++;
      }
      for (const f of obs.myUnits) {
        if (f.x === adj.x && f.y === adj.y && f.id !== unit.id) adjFriendly++;
      }
    }
    features[FEATURE_NAMES.indexOf('adjacentEnemyCount')] = Math.min(adjEnemy / 4, 1);
    features[FEATURE_NAMES.indexOf('adjacentFriendlyCount')] = Math.min(adjFriendly / 4, 1);

    // Hidden tiles nearby (exploration incentive)
    let hidden = 0;
    for (const adj of this.getAdjacentTiles(target.x, target.y)) {
      if (adj.y >= 0 && adj.y < this.mapHeight) {
        const t = obs.tiles[adj.y]?.[adj.x];
        if (t && t.visibility === TileVisibility.Hidden) hidden++;
      }
    }
    features[FEATURE_NAMES.indexOf('hiddenTilesNearby')] = hidden / 8;

    // Unit state
    const stats = UNIT_STATS[unit.type];
    features[FEATURE_NAMES.indexOf('healthRatio')] = unit.health / stats.maxHealth;
    features[FEATURE_NAMES.indexOf('movesLeftRatio')] = unit.movesLeft / stats.movesPerTurn;

    // On a friendly city?
    const onCity = obs.myCities.some((c) => c.x === target.x && c.y === target.y);
    features[FEATURE_NAMES.indexOf('onFriendlyCity')] = onCity ? 1 : 0;

    // Global features
    const global = this.extractGlobalFeatures(obs);
    for (let i = FEATURE_NAMES.indexOf('myCityCount'); i < FEATURE_NAMES.length; i++) {
      features[i] = global[i];
    }

    return features;
  }

  private extractGlobalFeatures(obs: AgentObservation): number[] {
    const features = new Array(FEATURE_NAMES.length).fill(0);

    const totalCities = obs.myCities.length + obs.visibleEnemyCities.length;
    features[FEATURE_NAMES.indexOf('myCityCount')] =
      totalCities > 0 ? obs.myCities.length / totalCities : 0.5;
    features[FEATURE_NAMES.indexOf('enemyCityCount')] =
      totalCities > 0 ? obs.visibleEnemyCities.length / totalCities : 0.5;

    const totalUnits = obs.myUnits.length + obs.visibleEnemyUnits.length;
    features[FEATURE_NAMES.indexOf('myUnitCount')] =
      totalUnits > 0 ? obs.myUnits.length / totalUnits : 0.5;
    features[FEATURE_NAMES.indexOf('enemyUnitCount')] =
      totalUnits > 0 ? obs.visibleEnemyUnits.length / totalUnits : 0.5;

    const myArmies = obs.myUnits.filter((u) => u.type === UnitType.Infantry).length;
    features[FEATURE_NAMES.indexOf('myArmyRatio')] =
      obs.myUnits.length > 0 ? myArmies / obs.myUnits.length : 0;

    const myNaval = obs.myUnits.filter(
      (u) => UNIT_STATS[u.type].domain === UnitDomain.Sea,
    ).length;
    features[FEATURE_NAMES.indexOf('myNavalRatio')] =
      obs.myUnits.length > 0 ? myNaval / obs.myUnits.length : 0;

    features[FEATURE_NAMES.indexOf('turnNumber')] = Math.min(obs.turn / 200, 1);

    // Map control estimate: fraction of visible tiles
    let visibleCount = 0;
    let totalTiles = 0;
    for (const row of obs.tiles) {
      for (const t of row) {
        totalTiles++;
        if (t.visibility === TileVisibility.Visible) visibleCount++;
      }
    }
    features[FEATURE_NAMES.indexOf('mapControlEstimate')] =
      totalTiles > 0 ? visibleCount / totalTiles : 0;

    return features;
  }

  // ── Utility ────────────────────────────────────────────────

  private dotProduct(features: number[]): number {
    let sum = 0;
    for (let i = 0; i < features.length; i++) {
      sum += features[i] * this.genome.weights[i];
    }
    return sum;
  }

  private nearestDist(entities: readonly Coord[], from: Coord): number | null {
    let best: number | null = null;
    for (const e of entities) {
      const d = wrappedDistX(e.x, from.x, this.mapWidth) + Math.abs(e.y - from.y);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  private getAdjacentTiles(x: number, y: number): Coord[] {
    const dirs = [
      { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      { x: -1, y: 0 },                     { x: 1, y: 0 },
      { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
    ];
    return dirs.map((d) => ({
      x: wrapX(x + d.x, this.mapWidth),
      y: y + d.y,
    }));
  }
}
