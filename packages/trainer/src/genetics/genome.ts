/**
 * Genome: a weight vector over hand-crafted strategic features.
 * Each gene is a float ∈ [-1, 1] that weights a specific feature
 * when the evolved agent decides which action is best.
 */

/** Feature names used by the evolved agent's scoring function. */
export const FEATURE_NAMES = [
  // Unit-level features (per-unit scoring for move targets)
  'distToNearestNeutralCity',
  'distToNearestEnemyCity',
  'distToNearestEnemy',
  'distToNearestFriendly',
  'adjacentEnemyCount',
  'adjacentFriendlyCount',
  'hiddenTilesNearby',
  'healthRatio',
  'movesLeftRatio',
  'onFriendlyCity',

  // Global strategic features (for production decisions)
  'myCityCount',
  'enemyCityCount',
  'myUnitCount',
  'enemyUnitCount',
  'myArmyRatio',
  'myNavalRatio',
  'turnNumber',
  'mapControlEstimate',

  // Production weights per unit type
  'prodArmy',
  'prodFighter',
  'prodBomber',
  'prodTransport',
  'prodDestroyer',
  'prodSubmarine',
  'prodCarrier',
  'prodBattleship',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export const GENOME_LENGTH = FEATURE_NAMES.length;

export interface Genome {
  weights: number[]; // length = GENOME_LENGTH, each ∈ [-1, 1]
}

/** Create a genome with random weights in [-1, 1]. */
export function randomGenome(rng: () => number): Genome {
  const weights: number[] = [];
  for (let i = 0; i < GENOME_LENGTH; i++) {
    weights.push(rng() * 2 - 1);
  }
  return { weights };
}

/** Clone a genome. */
export function cloneGenome(g: Genome): Genome {
  return { weights: [...g.weights] };
}

/** Serialize genome to JSON. */
export function genomeToJSON(g: Genome): string {
  return JSON.stringify(g);
}

/** Deserialize genome from JSON. */
export function genomeFromJSON(json: string): Genome {
  const parsed = JSON.parse(json) as Genome;
  if (!Array.isArray(parsed.weights) || parsed.weights.length !== GENOME_LENGTH) {
    throw new Error(`Invalid genome: expected ${GENOME_LENGTH} weights`);
  }
  return parsed;
}
