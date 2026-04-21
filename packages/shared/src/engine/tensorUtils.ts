import { PlayerView, UnitType, TileVisibility, Terrain } from '../types.js';

export const NUM_CHANNELS = 14;

const UNIT_TYPE_TO_CHANNEL: Record<UnitType, number> = {
  [UnitType.Army]: 0,
  [UnitType.Fighter]: 1,
  [UnitType.Missile]: 2,
  [UnitType.Transport]: 3,
  [UnitType.Destroyer]: 4,
  [UnitType.Submarine]: 5,
  [UnitType.Carrier]: 6,
  [UnitType.Battleship]: 7,
};

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
/**
 * Fill channels 0–13 into a pre-allocated buffer (no allocation, no copy).
 * The caller owns the buffer; channel 14+ is untouched.
 * buf must have length >= NUM_CHANNELS * view.tiles.length * view.tiles[0].length.
 */
export function fillViewTensor(view: PlayerView, buf: Float32Array): void {
  const height = view.tiles.length;
  const width = height > 0 ? view.tiles[0].length : 0;
  const HW = height * width;

  // Clear channels 0-13 (typed-array fill = native memset)
  buf.fill(0, 0, 14 * HW);

  for (const unit of view.myUnits) {
    const idx = UNIT_TYPE_TO_CHANNEL[unit.type] * HW + unit.y * width + unit.x;
    buf[idx] = Math.min(buf[idx] + unit.health, 1.0);
  }

  for (const city of view.myCities) {
    buf[8 * HW + city.y * width + city.x] = city.producing === null ? 1.0 : 0.5;
  }

  for (const enemyUnit of view.visibleEnemyUnits) {
    const idx = 9 * HW + enemyUnit.y * width + enemyUnit.x;
    buf[idx] = Math.min(buf[idx] + enemyUnit.health, 1.0);
  }

  for (const enemyCity of view.visibleEnemyCities) {
    buf[10 * HW + enemyCity.y * width + enemyCity.x] = 1.0;
  }

  buf.fill(Math.min(view.turn / 1000.0, 1.0), 13 * HW, 14 * HW);

  const base11 = 11 * HW;
  const base12 = 12 * HW;
  for (let y = 0; y < height; y++) {
    const row = view.tiles[y];
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const tile = row[x];
      const i = rowOff + x;
      buf[base11 + i] = tile.terrain === Terrain.Land ? 1.0 : 0.0;
      buf[base12 + i] = tile.visibility === TileVisibility.Visible ? 1.0
                      : tile.visibility === TileVisibility.Seen    ? 0.5 : 0.0;
    }
  }
}

/** Allocating wrapper — kept for callers outside the agent hot path. */
export function playerViewToTensor(view: PlayerView): Float32Array {
  const height = view.tiles.length;
  const width = height > 0 ? view.tiles[0].length : 0;
  const buf = new Float32Array(NUM_CHANNELS * height * width);
  fillViewTensor(view, buf);
  return buf;
}
