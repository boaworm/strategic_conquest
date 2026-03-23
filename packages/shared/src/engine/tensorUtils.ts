import { PlayerView, UnitType, TileVisibility, Terrain } from '../types.js';

export const NUM_CHANNELS = 15;

/**
 * Converts a PlayerView into a flat Float32Array representing a 3D tensor
 * of shape [Channels, Height, Width].
 * 
 * Channels:
 *  0: Friendly Infantry
 *  1: Friendly Tank
 *  2: Friendly Fighter
 *  3: Friendly Bomber
 *  4: Friendly Transport
 *  5: Friendly Destroyer
 *  6: Friendly Submarine
 *  7: Friendly Carrier
 *  8: Friendly Battleship
 *  9: Friendly Cities (1.0 = idle, 0.5 = producing)
 * 10: Visible Enemy Units
 * 11: Visible Enemy Cities
 * 12: Terrain (1 = Land, 0 = Ocean)
 * 13: Fog of War (1 = currently visible, 0.5 = previously seen, 0 = hidden)
 * 14: Global context broadcast across entire channel (Turn / 1000)
 */
export function playerViewToTensor(view: PlayerView): Float32Array {
  const height = view.tiles.length;
  const width = height > 0 ? view.tiles[0].length : 0;
  
  const buffer = new Float32Array(NUM_CHANNELS * height * width);
  
  // Helper to safely write to the fixed size array
  const setVal = (c: number, y: number, x: number, val: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      buffer[c * (height * width) + y * width + x] = val;
    }
  };

  // 1. Terrain & Visibility (Channels 12, 13)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = view.tiles[y][x];
      // Terrain
      setVal(12, y, x, tile.terrain === Terrain.Land ? 1.0 : 0.0);
      
      // Visibility
      let visVal = 0.0;
      if (tile.visibility === TileVisibility.Visible) visVal = 1.0;
      else if (tile.visibility === TileVisibility.Seen) visVal = 0.5;
      setVal(13, y, x, visVal);

      // Global Context (Channel 14) - broadcasted
      setVal(14, y, x, Math.min(view.turn / 1000.0, 1.0));
    }
  }

  // 2. Friendly Units (Channels 0-8)
  const unitTypeToChannel: Record<UnitType, number> = {
    [UnitType.Infantry]: 0,
    [UnitType.Tank]: 1,
    [UnitType.Fighter]: 2,
    [UnitType.Bomber]: 3,
    [UnitType.Transport]: 4,
    [UnitType.Destroyer]: 5,
    [UnitType.Submarine]: 6,
    [UnitType.Carrier]: 7,
    [UnitType.Battleship]: 8,
  };

  for (const unit of view.myUnits) {
    const channel = unitTypeToChannel[unit.type];
    // We encode health as the value (1.0 = full, 0.5 = half, etc.)
    // If multiple units stack, we add them, capping at 1.0
    const idx = channel * (height * width) + unit.y * width + unit.x;
    if (unit.y >= 0 && unit.y < height && unit.x >= 0 && unit.x < width) {
      buffer[idx] = Math.min(buffer[idx] + unit.health, 1.0);
    }
  }

  // 3. Friendly Cities (Channel 9)
  for (const city of view.myCities) {
    // 1.0 means requires action (idle), 0.5 means producing something
    const val = city.producing === null ? 1.0 : 0.5;
    setVal(9, city.y, city.x, val);
  }

  // 4. Enemy Units (Channel 10)
  for (const enemyUnit of view.visibleEnemyUnits) {
    const idx = 10 * (height * width) + enemyUnit.y * width + enemyUnit.x;
    if (enemyUnit.y >= 0 && enemyUnit.y < height && enemyUnit.x >= 0 && enemyUnit.x < width) {
      buffer[idx] = Math.min(buffer[idx] + enemyUnit.health, 1.0);
    }
  }

  // 5. Enemy Cities (Channel 11)
  for (const enemyCity of view.visibleEnemyCities) {
    setVal(11, enemyCity.y, enemyCity.x, 1.0);
  }

  return buffer;
}
