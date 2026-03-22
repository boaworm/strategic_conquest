import { type Agent, type AgentAction, type AgentConfig, type AgentObservation } from '@sc/shared';
import { type Genome } from '../genetics/genome.js';
/**
 * An AI agent driven by a genome (weight vector).
 * Uses the weights to score candidate actions and picks the highest-scoring one.
 */
export declare class EvolvedAgent implements Agent {
    private genome;
    private playerId;
    private mapWidth;
    private mapHeight;
    constructor(genome: Genome);
    init(config: AgentConfig): void;
    act(obs: AgentObservation): AgentAction;
    private chooseProduction;
    private scoreMoves;
    private extractMoveFeatures;
    private extractGlobalFeatures;
    private dotProduct;
    private nearestDist;
    private getAdjacentTiles;
}
//# sourceMappingURL=evolvedAgent.d.ts.map