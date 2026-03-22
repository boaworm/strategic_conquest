import { useGameStore } from '../store/gameStore';
import { GamePhase } from '@sc/shared';

export function HUD() {
  const view = useGameStore((s) => s.view);
  const playerId = useGameStore((s) => s.playerId);
  const gameId = useGameStore((s) => s.gameId);
  const sendAction = useGameStore((s) => s.sendAction);
  const gamePaused = useGameStore((s) => s.gamePaused);
  const error = useGameStore((s) => s.error);
  const autoEndTurn = useGameStore((s) => s.autoEndTurn);
  const setAutoEndTurn = useGameStore((s) => s.setAutoEndTurn);
  const autoSelectNext = useGameStore((s) => s.autoSelectNext);
  const setAutoSelectNext = useGameStore((s) => s.setAutoSelectNext);

  if (!view) return null;

  const isMyTurn = view.currentPlayer === playerId;

  return (
    <div className="bg-gray-900 text-white px-4 py-2 flex items-center justify-between gap-4 text-sm relative z-50">
      <div className="flex items-center gap-4">
        <span className="font-bold">Turn {view.turn}</span>
        <span className={isMyTurn ? 'text-green-400 font-bold' : 'text-gray-400'}>
          {isMyTurn ? '⬤ Your turn' : '○ Opponent\'s turn'}
        </span>
        <span>Cities: {view.myCities.length}</span>
        <span>Units: {view.myUnits.length}</span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {gamePaused && <span className="text-yellow-400">⏸ Game paused</span>}
        {error && <span className="text-red-400">{error}</span>}
        {view.phase === GamePhase.Finished && view.winner && (
          <span className={view.winner === playerId ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
            {view.winner === playerId ? '🏆 Victory!' : '💀 Defeat'}
          </span>
        )}
        <label className="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoSelectNext}
            onChange={(e) => setAutoSelectNext(e.target.checked)}
            className="accent-blue-500"
          />
          Select next unit
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoEndTurn}
            onChange={(e) => setAutoEndTurn(e.target.checked)}
            className="accent-blue-500"
          />
          Auto end turn
        </label>
        {isMyTurn && view.phase === GamePhase.Active && (
          <button
            className="px-3 py-1 bg-blue-700 rounded hover:bg-blue-600"
            onClick={() => sendAction({ type: 'END_TURN' })}
          >
            End Turn
          </button>
        )}
        {!isMyTurn && view.phase === GamePhase.Active && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!gameId) return;

              // Prompt for admin token
              const adminToken = prompt('Enter admin token to force end turn:');
              if (!adminToken) return;

              try {
                const res = await fetch(`/api/games/${gameId}/force-end-turn`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${adminToken}`,
                    'Content-Type': 'application/json',
                  },
                });

                if (res.ok) {
                  const data = await res.json();
                  alert(`Turn forced! Now ${data.newPlayer}'s turn.`);
                } else {
                  const error = await res.json();
                  alert(`Failed to force turn: ${error.error}`);
                }
              } catch (err) {
                console.error('Force end turn error:', err);
                alert('Failed to force turn. Check console for details.');
              }
            }}
          >
            <button
              type="submit"
              className="px-3 py-1 bg-yellow-700 rounded hover:bg-yellow-600 text-black font-bold text-xs"
              title="Force end of opponent's turn (for debugging)"
            >
              Force End Turn
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
