import { useState, useRef, useEffect } from 'react';
import { UNIT_STATS, UnitType } from '@sc/shared';
import { useGameStore } from '../store/gameStore';

function missileLabel(blastRadius: number): string {
  if (blastRadius >= 2) return 'missile (mega)';
  if (blastRadius >= 1) return 'missile (nuclear)';
  return 'missile';
}

export function UnitPanel() {
  const view = useGameStore((s) => s.view);
  const selectedUnitId = useGameStore((s) => s.selectedUnitId);
  const sendAction = useGameStore((s) => s.sendAction);
  const selectUnit = useGameStore((s) => s.selectUnit);
  const setCamera = useGameStore((s) => s.setCamera);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ unitId: string; x: number; y: number } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctxMenu]);

  if (!view) return null;

  const selected = selectedUnitId
    ? view.myUnits.find((u) => u.id === selectedUnitId)
    : null;
  const selectedStats = selected
    ? UNIT_STATS[selected.type as UnitType]
    : null;

  return (
    <div className="bg-gray-800 text-white p-3 rounded space-y-2 w-56">
      {/* Selected unit detail */}
      {selected && selectedStats && (
        <div className="border-b border-gray-600 pb-2 mb-1">
          <div className="font-bold text-lg capitalize">
            {selected.type === UnitType.Missile ? missileLabel(view.myBomberBlastRadius) : selected.type}
          </div>
          <div className="text-sm space-y-1">
            <div>HP: {selected.health}/{selectedStats.maxHealth}</div>
            <div>Moves: {selected.movesLeft}/{selectedStats.movesPerTurn}</div>
            {selected.fuel !== undefined && (
              <div>Fuel: {selected.fuel}/{selectedStats.maxFuel}</div>
            )}
            {selected.cargo.length > 0 && (
              <div>Cargo: {selected.cargo.length}/{selectedStats.cargoCapacity}</div>
            )}
            {selected.sleeping && <div className="text-yellow-400">Sleeping</div>}
            {selected.hasAttacked && <div className="text-orange-400">Attacked</div>}
          </div>
          <div className="flex gap-1 flex-wrap mt-1">
            {selected.sleeping ? (
              <button
                className="px-2 py-1 bg-green-700 rounded text-xs hover:bg-green-600"
                onClick={() => sendAction({ type: 'WAKE', unitId: selected.id })}
              >
                Wake
              </button>
            ) : (
              <button
                className="px-2 py-1 bg-yellow-700 rounded text-xs hover:bg-yellow-600"
                onClick={() => sendAction({ type: 'SLEEP', unitId: selected.id })}
              >
                Sleep
              </button>
            )}
            <button
              className="px-2 py-1 bg-gray-600 rounded text-xs hover:bg-gray-500"
              onClick={() => selectUnit(null)}
            >
              Deselect
            </button>
          </div>
        </div>
      )}

      {/* Full unit list */}
      <div className="font-bold text-sm">My Units ({view.myUnits.length})</div>
      <div className="space-y-0.5 max-h-48 overflow-y-auto">
        {(() => {
          // Unit type display order
          const typeOrder: Record<string, number> = {
            army: 0,
            transport: 2,
            destroyer: 3, submarine: 4, carrier: 5, battleship: 6,
            fighter: 7, missile: 8,
          };
          // Build sorted list: top-level units sorted by type, children grouped below parent.
          // Use carriedBy (not cargo) as the authoritative parent→child link.
          const childrenOf = new Map<string, typeof view.myUnits>();
          for (const u of view.myUnits) {
            if (u.carriedBy !== null) {
              if (!childrenOf.has(u.carriedBy)) childrenOf.set(u.carriedBy, []);
              childrenOf.get(u.carriedBy)!.push(u);
            }
          }
          const topLevel = view.myUnits
            .filter((u) => u.carriedBy === null)
            .sort((a, b) => (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99));
          const sorted: typeof view.myUnits = [];
          const addedIds = new Set<string>();
          for (const u of topLevel) {
            sorted.push(u);
            addedIds.add(u.id);
            for (const child of (childrenOf.get(u.id) ?? [])) {
              sorted.push(child);
              addedIds.add(child.id);
            }
          }
          // Fallback: any orphaned carried units whose parent isn't in myUnits
          for (const u of view.myUnits) {
            if (!addedIds.has(u.id)) sorted.push(u);
          }
          return sorted.map((u) => {
            const canAct = u.movesLeft > 0 && !u.sleeping;
            const carried = u.carriedBy !== null;
            return (
              <button
                key={u.id}
                className={`w-full text-left text-xs py-1 rounded flex items-center gap-1 hover:bg-gray-700 ${
                  u.id === selectedUnitId ? 'bg-gray-600' : 'bg-gray-900'
                } ${carried ? 'pl-5 pr-2' : 'px-2'}`}
                onClick={() => { selectUnit(u.id); setCamera(u.x, u.y); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ unitId: u.id, x: e.clientX, y: e.clientY });
                }}
              >
                <span
                  className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                    canAct && !carried ? 'bg-green-400' : carried && canAct ? 'bg-blue-400' : 'bg-red-500'
                  }`}
                />
                <span className="capitalize truncate">
                  {(() => {
                    const label = u.type === UnitType.Missile ? missileLabel(view.myBomberBlastRadius) : u.type;
                    return carried ? `↳ ${label}` : label;
                  })()}
                </span>
                <span className="text-gray-400 ml-auto flex-shrink-0">({u.x},{u.y})</span>
              </button>
            );
          });
        })()}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="fixed bg-gray-700 border border-gray-500 rounded shadow-lg py-1 z-50"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            className="w-full text-left text-xs px-4 py-1 hover:bg-red-700 text-red-300"
            onClick={() => {
              sendAction({ type: 'DISBAND', unitId: ctxMenu.unitId });
              if (selectedUnitId === ctxMenu.unitId) selectUnit(null);
              setCtxMenu(null);
            }}
          >
            Disband
          </button>
        </div>
      )}
    </div>
  );
}
