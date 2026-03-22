/**
 * Genome: a weight vector over hand-crafted strategic features.
 * Each gene is a float ∈ [-1, 1] that weights a specific feature
 * when the evolved agent decides which action is best.
 */
/** Feature names used by the evolved agent's scoring function. */
export declare const FEATURE_NAMES: readonly ["distToNearestNeutralCity", "distToNearestEnemyCity", "distToNearestEnemy", "distToNearestFriendly", "adjacentEnemyCount", "adjacentFriendlyCount", "hiddenTilesNearby", "healthRatio", "movesLeftRatio", "onFriendlyCity", "myCityCount", "enemyCityCount", "myUnitCount", "enemyUnitCount", "myArmyRatio", "myNavalRatio", "turnNumber", "mapControlEstimate", "prodArmy", "prodFighter", "prodBomber", "prodTransport", "prodDestroyer", "prodSubmarine", "prodCarrier", "prodBattleship"];
export type FeatureName = (typeof FEATURE_NAMES)[number];
export declare const GENOME_LENGTH: 26;
export interface Genome {
    weights: number[];
}
/** Create a genome with random weights in [-1, 1]. */
export declare function randomGenome(rng: () => number): Genome;
/** Clone a genome. */
export declare function cloneGenome(g: Genome): Genome;
/** Serialize genome to JSON. */
export declare function genomeToJSON(g: Genome): string;
/** Deserialize genome from JSON. */
export declare function genomeFromJSON(json: string): Genome;
//# sourceMappingURL=genome.d.ts.map