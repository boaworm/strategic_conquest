import { createGameState, applyAction, getPlayerView, GamePhase, } from '@sc/shared';
const MAX_ACTIONS_PER_TURN = 500; // safety limit to prevent infinite loops
/**
 * Run a complete headless game between two agents.
 * Returns outcome data for both players.
 */
export function runGame(agent1, agent2, opts = {}) {
    const { mapWidth = 30, mapHeight = 20, mapSeed, maxTurns = 200, } = opts;
    const state = createGameState({
        width: mapWidth,
        height: mapHeight,
        seed: mapSeed ?? Date.now(),
        landRatio: 0.35,
        cityCount: 10,
    });
    // Init agents
    agent1.init({ playerId: 'player1', mapWidth, mapHeight });
    agent2.init({ playerId: 'player2', mapWidth, mapHeight });
    const agents = {
        player1: agent1,
        player2: agent2,
    };
    // Main game loop
    while (state.phase === GamePhase.Active && state.turn <= maxTurns) {
        const currentPlayer = state.currentPlayer;
        const agent = agents[currentPlayer];
        // Build observation from fog-of-war view
        const view = getPlayerView(state, currentPlayer);
        const obs = {
            tiles: view.tiles,
            myUnits: view.myUnits,
            myCities: view.myCities,
            visibleEnemyUnits: view.visibleEnemyUnits,
            visibleEnemyCities: view.visibleEnemyCities,
            turn: view.turn,
            myPlayerId: currentPlayer,
        };
        // Let agent take actions until it ends its turn
        let actionCount = 0;
        while (actionCount < MAX_ACTIONS_PER_TURN) {
            const action = agent.act(obs);
            actionCount++;
            if (action.type === 'END_TURN') {
                applyAction(state, { type: 'END_TURN' }, currentPlayer);
                break;
            }
            // Apply action to state
            const result = applyAction(state, action, currentPlayer);
            if (!result.success) {
                // Agent made invalid move — skip it, try again
                // After too many failures, force end turn
                if (actionCount >= MAX_ACTIONS_PER_TURN) {
                    applyAction(state, { type: 'END_TURN' }, currentPlayer);
                    break;
                }
                continue;
            }
            // Refresh observation after successful action
            const updatedView = getPlayerView(state, currentPlayer);
            obs.tiles = updatedView.tiles;
            obs.myUnits = updatedView.myUnits;
            obs.myCities = updatedView.myCities;
            obs.visibleEnemyUnits = updatedView.visibleEnemyUnits;
            obs.visibleEnemyCities = updatedView.visibleEnemyCities;
            obs.turn = updatedView.turn;
            // Check if game ended mid-turn (e.g. last enemy destroyed)
            if (state.phase !== GamePhase.Active)
                break;
        }
        if (state.phase !== GamePhase.Active)
            break;
    }
    // Compute outcomes
    const totalCities = state.cities.length;
    const p1Cities = state.cities.filter((c) => c.owner === 'player1').length;
    const p2Cities = state.cities.filter((c) => c.owner === 'player2').length;
    const totalUnits = state.units.length;
    const p1Units = state.units.filter((u) => u.owner === 'player1').length;
    const p2Units = state.units.filter((u) => u.owner === 'player2').length;
    const isDraw = state.winner === null;
    return {
        winner: state.winner,
        turns: state.turn,
        p1Outcome: {
            won: state.winner === 'player1',
            lost: state.winner === 'player2',
            draw: isDraw,
            turnsTaken: state.turn,
            maxTurns,
            finalCityRatio: totalCities > 0 ? p1Cities / totalCities : 0,
            finalUnitRatio: totalUnits > 0 ? p1Units / totalUnits : 0,
        },
        p2Outcome: {
            won: state.winner === 'player2',
            lost: state.winner === 'player1',
            draw: isDraw,
            turnsTaken: state.turn,
            maxTurns,
            finalCityRatio: totalCities > 0 ? p2Cities / totalCities : 0,
            finalUnitRatio: totalUnits > 0 ? p2Units / totalUnits : 0,
        },
    };
}
//# sourceMappingURL=runner.js.map