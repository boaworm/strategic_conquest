import { PlayerView, UnitType, TileVisibility, Terrain } from '../types.js';

export const NUM_CHANNELS = 14;

/**
 * Converts a PlayerView into a flat Float32Array representing a 3D tensor
 * of shape [Channels, Height, Width].
 * 
 * Channels:
 *  0: Friendly Army
 *  1: Friendly Fighter
 *  2: Friendly Missile
 *  3: Friendly Transport
 *  4: Friendly Destroyer
 *  5: Friendly Submarine
 *  6: Friendly Carrier
 *  7: Friendly Battleship
 *  8: Friendly Cities (1.0 = idle, 0.5 = producing)
 *  9: Visible Enemy Units
 * 10: Visible Enemy Cities
 * 11: Terrain (1 = Land, 0 = Ocean)
 * 12: Fog of War (1 = currently visible, 0.5 = previously seen, 0 = hidden)
 * 13: Global context broadcast across entire channel (Turn / 1000)
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

  // We moved setting these channels to the bottom (11, 12, 13)

  // 2. Friendly Units (Channels 0-7)
  const unitTypeToChannel: Record<UnitType, number> = {
    [UnitType.Army]: 0,
    [UnitType.Fighter]: 1,
    [UnitType.Missile]: 2,
    [UnitType.Transport]: 3,
    [UnitType.Destroyer]: 4,
    [UnitType.Submarine]: 5,
    [UnitType.Carrier]: 6,
    [UnitType.Battleship]: 7,
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

  // 3. Friendly Cities (Channel 8)
  for (const city of view.myCities) {
    const val = city.producing === null ? 1.0 : 0.5;
    setVal(8, city.y, city.x, val);
  }

  // 4. Enemy Units (Channel 9)
  for (const enemyUnit of view.visibleEnemyUnits) {
    const idx = 9 * (height * width) + enemyUnit.y * width + enemyUnit.x;
    if (enemyUnit.y >= 0 && enemyUnit.y < height && enemyUnit.x >= 0 && enemyUnit.x < width) {
      buffer[idx] = Math.min(buffer[idx] + enemyUnit.health, 1.0);
    }
  }

  // 5. Enemy Cities (Channel 10)
  for (const enemyCity of view.visibleEnemyCities) {
    setVal(10, enemyCity.y, enemyCity.x, 1.0);
  }

  // 6. Terrain, Fog, Context were channels 11, 12, 13
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = view.tiles[y][x];
      setVal(11, y, x, tile.terrain === Terrain.Land ? 1.0 : 0.0);
      let visVal = 0.0;
      if (tile.visibility === TileVisibility.Visible) visVal = 1.0;
      else if (tile.visibility === TileVisibility.Seen) visVal = 0.5;
      setVal(12, y, x, visVal);
      setVal(13, y, x, Math.min(view.turn / 1000.0, 1.0));
    }
  }

  return buffer;
}
