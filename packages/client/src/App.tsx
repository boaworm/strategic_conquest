import { useState } from 'react';
import { useGameStore } from './store/gameStore';
import { GameCanvas } from './components/GameCanvas';
import { UnitPanel } from './components/UnitPanel';
import { CityDialog } from './components/CityDialog';
import { HUD } from './components/HUD';
import { MainMenu } from './components/MainMenu';
import { GamePhase } from '@sc/shared';

export default function App() {
  const view = useGameStore((s) => s.view);
  const connected = useGameStore((s) => s.connected);
  const playerId = useGameStore((s) => s.playerId);
  const [cityDialogId, setCityDialogId] = useState<string | null>(null);

  // Derive city from live view so it always reflects server state
  const cityDialog = cityDialogId
    ? view?.myCities.find((c) => c.id === cityDialogId) ?? null
    : null;

  // Not connected — show main menu
  if (!connected || !view) {
    return (
      <div className="min-h-screen bg-gray-950">
        <MainMenu />
        {connected && !view && (
          <div className="text-center text-gray-400 mt-8">
            Waiting for opponent to join...
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="h-screen bg-gray-950 flex flex-col overflow-hidden"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && cityDialogId) {
          setCityDialogId(null);
        }
      }}
      tabIndex={-1}
    >
      <HUD />
      <div className="flex-1 flex overflow-hidden">
        {/* Map area */}
        <div className="flex-1 overflow-hidden relative">
          <GameCanvas
            view={view}
            onCityClick={(city) => setCityDialogId(city.id)}
            selectedCityId={cityDialogId}
          />
        </div>

        {/* Side panel */}
        <div className="w-60 p-2 space-y-2 overflow-y-auto">
          <UnitPanel />

          {/* City list */}
          <div className="bg-gray-800 text-white p-3 rounded space-y-1">
            <div className="font-bold text-sm mb-1">My Cities ({view.myCities.length})</div>
            {view.myCities.map((city) => (
              <button
                key={city.id}
                className={`w-full text-left text-xs px-2 py-1 rounded hover:bg-gray-700 ${cityDialogId === city.id ? 'bg-purple-900 ring-1 ring-purple-500' : 'bg-gray-900'}`}
                onClick={() => setCityDialogId(city.id)}
              >
                ({city.x},{city.y}){' '}
                {city.producing ? (
                  <span className="capitalize">
                    ({city.productionTurnsLeft}) {city.producing}
                  </span>
                ) : (
                  <span className="text-gray-500">(0) Idle</span>
                )}
              </button>
            ))}
          </div>

          {/* City production dialog — inline in sidebar */}
          {cityDialog && (
            <CityDialog
              cityId={cityDialog.id}
              currentProduction={cityDialog.producing}
              turnsLeft={cityDialog.productionTurnsLeft}
              coastal={cityDialog.coastal}
              onClose={() => setCityDialogId(null)}
            />
          )}
        </div>
      </div>

      {/* Win / Loss popup */}
      {view.phase === GamePhase.Finished && view.winner && (
        <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/60">
          <div className="bg-gray-800 border-2 border-gray-500 rounded-xl px-16 py-12 text-center shadow-2xl">
            {view.winner === playerId ? (
              <>
                <div className="text-6xl font-extrabold text-yellow-400 mb-4">YOU WON!</div>
                <div className="text-xl text-gray-300">Congratulations, Commander!</div>
              </>
            ) : (
              <>
                <div className="text-6xl font-extrabold text-red-500 mb-4">YOU LOST :(</div>
                <div className="text-xl text-gray-300">Better luck next time...</div>
              </>
            )}
            <button
              className="mt-6 px-6 py-2 bg-blue-700 rounded hover:bg-blue-600 text-white font-semibold"
              onClick={() => window.location.reload()}
            >
              Play New Game
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
