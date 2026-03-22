// ── Coordinates ──────────────────────────────────────────────
/**
 * Wrap an X coordinate for cylindrical map topology.
 * East-west wraps, north-south does not.
 */
export function wrapX(x, mapWidth) {
    return ((x % mapWidth) + mapWidth) % mapWidth;
}
/**
 * Compute the shortest east-west distance on a cylindrical map.
 */
export function wrappedDistX(x1, x2, mapWidth) {
    const raw = Math.abs(x1 - x2);
    return Math.min(raw, mapWidth - raw);
}
// ── Terrain ──────────────────────────────────────────────────
export var Terrain;
(function (Terrain) {
    Terrain["Ocean"] = "ocean";
    Terrain["Land"] = "land";
})(Terrain || (Terrain = {}));
// ── Unit types ───────────────────────────────────────────────
export var UnitType;
(function (UnitType) {
    UnitType["Infantry"] = "infantry";
    UnitType["Tank"] = "tank";
    UnitType["Fighter"] = "fighter";
    UnitType["Bomber"] = "bomber";
    UnitType["Transport"] = "transport";
    UnitType["Destroyer"] = "destroyer";
    UnitType["Submarine"] = "submarine";
    UnitType["Carrier"] = "carrier";
    UnitType["Battleship"] = "battleship";
})(UnitType || (UnitType = {}));
export var UnitDomain;
(function (UnitDomain) {
    UnitDomain["Land"] = "land";
    UnitDomain["Sea"] = "sea";
    UnitDomain["Air"] = "air";
})(UnitDomain || (UnitDomain = {}));
export const UNIT_STATS = {
    [UnitType.Infantry]: {
        type: UnitType.Infantry,
        domain: UnitDomain.Land,
        movesPerTurn: 1,
        vision: 1,
        maxHealth: 1,
        buildTime: 3,
        attack: 1,
        defense: 2,
        cargoCapacity: 0,
        canCarry: [],
    },
    [UnitType.Tank]: {
        type: UnitType.Tank,
        domain: UnitDomain.Land,
        movesPerTurn: 2,
        vision: 1,
        maxHealth: 1,
        buildTime: 5,
        attack: 3,
        defense: 2,
        cargoCapacity: 0,
        canCarry: [],
    },
    [UnitType.Fighter]: {
        type: UnitType.Fighter,
        domain: UnitDomain.Air,
        movesPerTurn: 10,
        vision: 3,
        maxHealth: 1,
        buildTime: 12,
        attack: 3,
        defense: 4,
        cargoCapacity: 0,
        canCarry: [],
    },
    [UnitType.Bomber]: {
        type: UnitType.Bomber,
        domain: UnitDomain.Air,
        movesPerTurn: 15,
        vision: 3,
        maxHealth: 1,
        buildTime: 15,
        attack: 4,
        defense: 1,
        maxFuel: 30,
        cargoCapacity: 0,
        canCarry: [],
    },
    [UnitType.Transport]: {
        type: UnitType.Transport,
        domain: UnitDomain.Sea,
        movesPerTurn: 5,
        vision: 2,
        maxHealth: 1,
        buildTime: 8,
        attack: 0,
        defense: 1,
        cargoCapacity: 6,
        canCarry: [UnitType.Infantry, UnitType.Tank],
    },
    [UnitType.Destroyer]: {
        type: UnitType.Destroyer,
        domain: UnitDomain.Sea,
        movesPerTurn: 6,
        vision: 2,
        maxHealth: 1,
        buildTime: 12,
        attack: 2,
        defense: 2,
        cargoCapacity: 0,
        canCarry: [],
    },
    [UnitType.Submarine]: {
        type: UnitType.Submarine,
        domain: UnitDomain.Sea,
        movesPerTurn: 5,
        vision: 2,
        maxHealth: 1,
        buildTime: 12,
        attack: 2,
        defense: 2,
        cargoCapacity: 0,
        canCarry: [],
    },
    [UnitType.Carrier]: {
        type: UnitType.Carrier,
        domain: UnitDomain.Sea,
        movesPerTurn: 5,
        vision: 2,
        maxHealth: 2,
        buildTime: 18,
        attack: 1,
        defense: 3,
        cargoCapacity: 4,
        canCarry: [UnitType.Fighter],
    },
    [UnitType.Battleship]: {
        type: UnitType.Battleship,
        domain: UnitDomain.Sea,
        movesPerTurn: 4,
        vision: 2,
        maxHealth: 2,
        buildTime: 24,
        attack: 4,
        defense: 4,
        cargoCapacity: 0,
        canCarry: [],
    },
};
// ── Game State ───────────────────────────────────────────────
export var GamePhase;
(function (GamePhase) {
    GamePhase["Lobby"] = "lobby";
    GamePhase["Active"] = "active";
    GamePhase["Finished"] = "finished";
})(GamePhase || (GamePhase = {}));
// ── Fog of War views (sent to clients) ──────────────────────
export var TileVisibility;
(function (TileVisibility) {
    TileVisibility["Hidden"] = "hidden";
    TileVisibility["Seen"] = "seen";
    TileVisibility["Visible"] = "visible";
})(TileVisibility || (TileVisibility = {}));
//# sourceMappingURL=types.js.map