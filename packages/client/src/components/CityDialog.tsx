import { UnitType, UnitDomain, UNIT_STATS } from '@sc/shared';
import { useGameStore } from '../store/gameStore';

const UNIT_TYPES = Object.values(UnitType);

interface Props {
  cityId: string;
  currentProduction: UnitType | null;
  turnsLeft: number;
  coastal: boolean;
  onClose: () => void;
}

export function CityDialog({ cityId, currentProduction, turnsLeft, coastal, onClose }: Props) {
  const sendAction = useGameStore((s) => s.sendAction);

  const availableTypes = UNIT_TYPES.filter(
    (ut) => coastal || UNIT_STATS[ut].domain !== UnitDomain.Sea,
  );

  function setProduction(unitType: UnitType | null) {
    sendAction({ type: 'SET_PRODUCTION', cityId, unitType });
    onClose();
  }

  return (
    <div className="bg-gray-800 text-white rounded-lg p-3 space-y-2">
        <h2 className="text-lg font-bold">City Production</h2>
        {currentProduction && (
          <div className="text-sm text-gray-300">
            Currently building: <span className="capitalize">{currentProduction}</span>{' '}
            ({turnsLeft} turns left)
          </div>
        )}
        <div className="space-y-1">
          {availableTypes.map((ut) => {
            const stats = UNIT_STATS[ut];
            return (
              <button
                key={ut}
                className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-gray-700 ${
                  ut === currentProduction ? 'bg-gray-600' : 'bg-gray-900'
                }`}
                onClick={() => setProduction(ut)}
              >
                <span className="capitalize font-medium">{ut}</span>
                <span className="text-gray-400 ml-2">
                  ({stats.buildTime} turns • ATK:{stats.attack})
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-2">
          <button
            className="px-3 py-1 bg-red-700 rounded text-sm hover:bg-red-600"
            onClick={() => setProduction(null)}
          >
            Stop Production
          </button>
          <button
            className="px-3 py-1 bg-gray-600 rounded text-sm hover:bg-gray-500"
            onClick={onClose}
          >
            Close
          </button>
        </div>
    </div>
  );
}
