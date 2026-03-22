import { type Agent, type AgentAction, type AgentConfig, type AgentObservation } from '@sc/shared';
/**
 * A basic greedy AI that:
 * 1. Sets all idle cities to produce armies (early game) or a mix of units
 * 2. Sends armies toward the nearest neutral or enemy city
 * 3. Attacks enemy units within reach
 * 4. Handles naval/air units with simple heuristics
 */
export declare class BasicAgent implements Agent {
    private playerId;
    private mapWidth;
    private mapHeight;
    init(config: AgentConfig): void;
    act(obs: AgentObservation): AgentAction;
    private chooseProduction;
    private requiresNavalApproach;
    private decideUnitAction;
    private decideLandUnit;
    private decideSeaUnit;
    private decideAirUnit;
    private findAdjacentEnemy;
    private moveToward;
    private bestStepToward;
    private moveTowardExploration;
    private getAdjacentTiles;
    private getAdjacentLand;
    private nearestCity;
    private nearestEnemy;
    private wrappedDist;
}
//# sourceMappingURL=basicAgent.d.ts.map