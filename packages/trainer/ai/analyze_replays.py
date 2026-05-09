#!/usr/bin/env python3
"""
Analyze nnMoEAgent replay files to understand army/transport movement behavior.

Usage:
    python packages/trainer/ai/analyze_replays.py tmp/replays/
    python packages/trainer/ai/analyze_replays.py tmp/replays/ --player player1 --unit-types army transport
    python packages/trainer/ai/analyze_replays.py tmp/replays/ --extractMoves --player 1 --turns 18:20 --game <uuid>
"""

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def flood_fill_islands(tiles, width, height):
    """Return island_id[y][x] — 0 = ocean, 1+ = island index."""
    island = [[0] * width for _ in range(height)]
    island_id = 0
    for sy in range(height):
        for sx in range(width):
            if tiles[sy][sx] != "land" or island[sy][sx] != 0:
                continue
            island_id += 1
            stack = [(sx, sy)]
            while stack:
                x, y = stack.pop()
                if x < 0 or x >= width or y < 0 or y >= height:
                    continue
                if tiles[y][x] != "land" or island[y][x] != 0:
                    continue
                island[y][x] = island_id
                # 4-connected (no diagonals for island detection)
                stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    return island


def get_island(island_map, x, y, width):
    x = x % width  # cylindrical wrap
    return island_map[y][x]


def load_replay(path):
    with open(path) as f:
        return json.load(f)


def analyze_replay(replay, player="player1", unit_types=None):
    meta = replay["meta"]
    width = meta.get("mapWidth") or replay["mapWidth"]
    height = meta.get("mapHeight") or replay["mapHeight"]
    tiles = replay["tiles"]
    frames = replay["frames"]

    island_map = flood_fill_islands(tiles, width, height)

    # Track per-unit history
    prev_by_id = {}
    unit_start_island = {}  # first island seen for each unit

    loads = 0
    unloads = 0
    idle_cycles = 0      # embark+disembark at same tile within 3 turns
    stranded = 0         # transport with cargo, no movement for 5+ turns

    cross_island_armies = set()   # army ids that reached a new island
    transport_events = []         # (turn, transport_id, event, detail)

    # For idle cycle detection: track last embark position per army
    last_load_pos = {}

    # For stranded detection: transport_id -> (turns_since_moved, has_cargo)
    transport_idle = {}

    action_counts = defaultdict(int)  # inferred action type -> count (player1 armies only)

    for frame in frames:
        turn = frame["turn"]
        units_this = {u["id"]: u for u in frame["units"]}

        for uid, u in units_this.items():
            if u["owner"] != player:
                continue
            if unit_types and u["type"] not in unit_types:
                continue

            prev = prev_by_id.get(uid)

            # Track starting island
            if uid not in unit_start_island:
                isl = get_island(island_map, u["x"], u["y"], width)
                if isl > 0:
                    unit_start_island[uid] = isl

            if prev is None:
                prev_by_id[uid] = u
                continue

            moved = (u["x"] != prev["x"] or u["y"] != prev["y"])

            # --- Army action inference ---
            if u["type"] == "army":
                cb_now = u["carriedBy"]
                cb_prev = prev.get("carriedBy")

                if cb_prev is None and cb_now is not None:
                    # Embarked onto transport (MOVE to transport tile)
                    loads += 1
                    action_counts["EMBARK"] += 1
                    last_load_pos[uid] = (u["x"], u["y"])

                elif cb_prev is not None and cb_now is None:
                    # Disembarked (MOVE from transport to land)
                    unloads += 1
                    action_counts["DISEMBARK"] += 1

                    # Idle cycle: unloaded at same pos as loaded
                    lp = last_load_pos.get(uid)
                    if lp and lp == (u["x"], u["y"]):
                        idle_cycles += 1

                    # Cross-island check
                    start_isl = unit_start_island.get(uid, 0)
                    cur_isl = get_island(island_map, u["x"], u["y"], width)
                    if cur_isl > 0 and start_isl > 0 and cur_isl != start_isl:
                        cross_island_armies.add(uid)

                elif moved and cb_now is None:
                    action_counts["MOVE"] += 1
                elif u.get("sleeping") and not prev.get("sleeping"):
                    action_counts["SLEEP"] += 1
                elif not moved and cb_now is None:
                    action_counts["SKIP"] += 1

            # --- Transport tracking ---
            if u["type"] == "transport":
                cargo_now = set(u.get("cargo", []))
                cargo_prev = set(prev.get("cargo", []))

                if cargo_now != cargo_prev:
                    loaded = cargo_now - cargo_prev
                    unloaded_cargo = cargo_prev - cargo_now
                    if loaded:
                        transport_events.append((turn, uid, "EMBARKED", f"{len(loaded)} armies at ({u['x']},{u['y']})"))
                    if unloaded_cargo:
                        transport_events.append((turn, uid, "DISEMBARKED", f"{len(unloaded_cargo)} armies at ({u['x']},{u['y']})"))

                if moved:
                    transport_events.append((turn, uid, "MOVE", f"({prev['x']},{prev['y']})->({u['x']},{u['y']}) cargo={len(cargo_now)}"))
                    transport_idle[uid] = 0
                else:
                    # Count idle turns
                    idle = transport_idle.get(uid, 0) + 1
                    transport_idle[uid] = idle
                    if idle == 5 and cargo_now:
                        stranded += 1
                        transport_events.append((turn, uid, "STRANDED", f"5 turns no move, cargo={len(cargo_now)} at ({u['x']},{u['y']})"))

            prev_by_id[uid] = u

    # Count unique p1 transports
    all_transport_ids = set(
        u["id"]
        for frame in frames
        for u in frame["units"]
        if u["owner"] == player and u["type"] == "transport"
    )

    return {
        "meta": meta,
        "loads": loads,
        "unloads": unloads,
        "idle_cycles": idle_cycles,
        "stranded_events": stranded,
        "cross_island_armies": len(cross_island_armies),
        "transport_count": len(all_transport_ids),
        "transport_events": transport_events,
        "action_counts": dict(action_counts),
    }


def print_summary(results):
    print(f"\n{'Game':>4}  {'Turns':>5}  {'Winner':<8}  {'P1Cities':>8}  {'P2Cities':>8}  {'Trans':>5}  {'Embarks':>7}  {'Disembarks':>10}  {'IdleCycles':>10}  {'CrossIsland':>11}")
    print("-" * 110)
    for r in results:
        m = r["meta"]
        winner = str(m.get("winner") or "draw")[:8]
        print(f"{m.get('gameNum', '?'):>4}  {m['turns']:>5}  {winner:<8}  {m['p1Cities']:>8}  {m['p2Cities']:>8}  "
              f"{r['transport_count']:>5}  {r['loads']:>7}  {r['unloads']:>10}  {r['idle_cycles']:>10}  {r['cross_island_armies']:>11}")


def print_transport_events(results, max_per_game=30):
    for r in results:
        m = r["meta"]
        evts = r["transport_events"]
        if not evts:
            continue
        print(f"\n--- Game {m.get('gameNum', '?')} transport events (first {max_per_game}) ---")
        for evt in evts[:max_per_game]:
            turn, tid, etype, detail = evt
            print(f"  T{turn:3d}  {tid:12s}  {etype:<8}  {detail}")
        if len(evts) > max_per_game:
            print(f"  ... ({len(evts) - max_per_game} more)")


def print_action_counts(results):
    print(f"\n{'Game':>4}  {'MOVE':>6}  {'EMBARK':>7}  {'DISEMBARK':>10}  {'SLEEP':>6}  {'SKIP':>6}")
    print("-" * 55)
    for r in results:
        m = r["meta"]
        ac = r["action_counts"]
        print(f"{m.get('gameNum', '?'):>4}  {ac.get('MOVE', 0):>6}  {ac.get('EMBARK', 0):>7}  "
              f"{ac.get('DISEMBARK', 0):>10}  {ac.get('SLEEP', 0):>6}  {ac.get('SKIP', 0):>6}")


def extract_moves(replay, player_num=1, turn_range=None, unit_types=None, unit_id=None):
    """
    Extract per-action records for a player across specified turns.

    Uses the new frame.actions format: { player: [{proposed, applied}, ...] }.
    Falls back to position-diff inference for old replays without action logs.

    Returns one record per action per turn (a unit may appear multiple times
    if the agent was called more than once for it in a turn).
    """
    player = f"player{player_num}"
    width = replay["mapWidth"]
    height = replay["mapHeight"]
    tiles = replay["tiles"]
    island_map = flood_fill_islands(tiles, width, height)

    moves = []
    frames = replay["frames"]

    for frame in frames:
        turn = frame["turn"]

        if turn_range:
            start, end = turn_range
            if turn < start or turn > end:
                continue

        units_by_id = {u["id"]: u for u in frame["units"] if u["owner"] == player}

        raw_actions = frame.get("actions", {})
        player_logs = raw_actions.get(player) if isinstance(raw_actions, dict) else None

        # New format: list of {proposed, applied}
        if player_logs and isinstance(player_logs, list):
            for log in player_logs:
                proposed = log.get("proposed", {})
                applied  = log.get("applied",  {})

                # Determine which unit this action belongs to
                uid = proposed.get("unitId") or applied.get("unitId")
                unit = units_by_id.get(uid) if uid else None

                if unit_id and uid != unit_id:
                    continue
                if unit_types:
                    if unit is None or unit["type"] not in unit_types:
                        continue

                record = {
                    "turn": turn,
                    "unit_id": uid,
                    "unit_type": unit["type"] if unit else None,
                    "position": {"x": unit["x"], "y": unit["y"]} if unit else None,
                    "island": get_island(island_map, unit["x"], unit["y"], width) if unit else None,
                    "carried_by": unit.get("carriedBy") if unit else None,
                    "cargo": unit.get("cargo", []) if unit else [],
                    "proposed": proposed,
                    "applied": applied,
                }
                moves.append(record)
        else:
            # Old replay without action logs — one stub record per unit
            for uid, unit in units_by_id.items():
                if unit_id and uid != unit_id:
                    continue
                if unit_types and unit["type"] not in unit_types:
                    continue
                moves.append({
                    "turn": turn,
                    "unit_id": uid,
                    "unit_type": unit["type"],
                    "position": {"x": unit["x"], "y": unit["y"]},
                    "island": get_island(island_map, unit["x"], unit["y"], width),
                    "carried_by": unit.get("carriedBy"),
                    "cargo": unit.get("cargo", []),
                    "proposed": None,
                    "applied": None,
                })

    return moves


def main():
    parser = argparse.ArgumentParser(description="Analyze MoE agent replay behavior")
    parser.add_argument("replay_dir", nargs="?", help="Directory containing replay .json files")
    parser.add_argument("--player", type=int, default=1, help="Player number to analyze (1 or 2, default: 1)")
    parser.add_argument("--unit-type", type=str, default=None, help="Comma-separated list of unit types to filter (e.g., army,transport)")
    parser.add_argument("--unit-id", type=str, default=None, help="Filter to a specific unit ID (e.g., unit_20)")
    parser.add_argument("--events", action="store_true", help="Print transport event timelines")
    parser.add_argument("--extractMoves", action="store_true", help="Extract moves as JSON output")
    parser.add_argument("--game", type=str, default=None, help="Specific game UUID to analyze")
    parser.add_argument("--turns", type=str, default=None, help="Turn range to extract (e.g., 18:20 for turns 18-20)")
    args = parser.parse_args()

    # Handle --extractMoves mode
    if args.extractMoves:
        if not args.replay_dir:
            print("Error: replay_dir required when using --extractMoves", file=sys.stderr)
            sys.exit(1)

        replay_dir = Path(args.replay_dir)
        turn_range = parse_turn_range(args.turns) if args.turns else None
        unit_types = set(args.unit_type.split(",")) if args.unit_type else None
        unit_id = args.unit_id

        # Find the specific game if --game is provided
        if args.game:
            game_path = replay_dir / f"{args.game}.json"
            if not game_path.exists():
                print(f"Error: Game not found: {args.game}", file=sys.stderr)
                sys.exit(1)
            replay = load_replay(game_path)
            moves = extract_moves(replay, player_num=args.player, turn_range=turn_range, unit_types=unit_types, unit_id=unit_id)
            print(json.dumps(moves, indent=2))
        else:
            # Process all games
            all_moves = []
            paths = sorted(replay_dir.glob("*.json"))
            if not paths:
                print(f"No .json files found in {replay_dir}", file=sys.stderr)
                sys.exit(1)

            for path in paths:
                replay = load_replay(path)
                moves = extract_moves(replay, player_num=args.player, turn_range=turn_range, unit_types=unit_types, unit_id=unit_id)
                for m in moves:
                    m["game_id"] = path.stem
                all_moves.extend(moves)
            print(json.dumps(all_moves, indent=2))
        return

    # Original analysis mode
    if not args.replay_dir:
        print("Error: replay_dir required", file=sys.stderr)
        sys.exit(1)

    replay_dir = Path(args.replay_dir)
    player_str = f"player{args.player}"
    paths = sorted(replay_dir.glob("*.json"))
    if not paths:
        print(f"No .json files found in {replay_dir}", file=sys.stderr)
        sys.exit(1)

    results = []
    for path in paths:
        replay = load_replay(path)
        result = analyze_replay(replay, player=player_str, unit_types=args.unit_type)
        results.append(result)

    results.sort(key=lambda r: r["meta"].get("gameNum", 0))

    print(f"\n=== Replay analysis: {replay_dir} (player={player_str}) ===")
    print_summary(results)

    print(f"\n=== Army action distribution (player={player_str}) ===")
    print_action_counts(results)

    if args.events:
        print(f"\n=== Transport event timelines ===")
        print_transport_events(results)

    total_loads = sum(r["loads"] for r in results)
    total_unloads = sum(r["unloads"] for r in results)
    total_idle = sum(r["idle_cycles"] for r in results)
    total_cross = sum(r["cross_island_armies"] for r in results)
    total_stranded = sum(r["stranded_events"] for r in results)

    print(f"\n=== Totals across {len(results)} games ===")
    print(f"  Embarks:            {total_loads}")
    print(f"  Disembarks:         {total_unloads}")
    print(f"  Idle cycles:        {total_idle}  (embark+disembark at same tile)")
    print(f"  Stranded events:    {total_stranded}  (transport with cargo, no movement 5+ turns)")
    print(f"  Cross-island armies:{total_cross}  (armies that reached a new island)")


def parse_turn_range(range_str):
    """Parse turn range like '18:20' into (start, end) tuple."""
    if ":" in range_str:
        parts = range_str.split(":")
        return int(parts[0]), int(parts[1])
    return int(range_str), int(range_str)


if __name__ == "__main__":
    main()
