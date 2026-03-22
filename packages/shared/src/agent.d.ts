import type { Coord, PlayerId, UnitType, TileView, UnitView, CityView } from './types.js';
export interface AgentObservation {
    tiles: TileView[][];
    myUnits: UnitView[];
    myCities: CityView[];
    visibleEnemyUnits: UnitView[];
    visibleEnemyCities: CityView[];
    turn: number;
    myPlayerId: PlayerId;
}
export type AgentAction = {
    type: 'MOVE';
    unitId: string;
    to: Coord;
} | {
    type: 'SET_PRODUCTION';
    cityId: string;
    unitType: UnitType;
} | {
    type: 'LOAD';
    unitId: string;
    transportId: string;
} | {
    type: 'UNLOAD';
    unitId: string;
    to: Coord;
} | {
    type: 'SLEEP';
    unitId: string;
} | {
    type: 'END_TURN';
};
export interface AgentConfig {
    playerId: PlayerId;
    mapWidth: number;
    mapHeight: number;
}
export interface Agent {
    /** Called once at game start with static config. */
    init(config: AgentConfig): void;
    /**
     * Called by the runner each time this agent must act.
     * Must return exactly one action. The runner calls this repeatedly
     * until the agent emits END_TURN.
     */
    act(obs: AgentObservation): AgentAction;
}
//# sourceMappingURL=agent.d.ts.map