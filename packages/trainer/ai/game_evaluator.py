"""
Game evaluator for evolution - runs games using Node.js + TypeScript engine.
Supports both single-model (NnAgent) and MoE (NnMoEAgent) evaluation.
"""

import os
import subprocess
import random
import numpy as np
from pathlib import Path


def _run_eval(extra_args: list, model_env: dict, map_width: int, map_height: int,
              max_turns: int, num_games: int) -> list:
    """Internal helper: launch eval_game.js and parse fitness results."""
    script_path = Path(__file__).parent / 'eval_game.js'

    cmd = [
        'node', str(script_path),
        '--width',     str(map_width),
        '--height',    str(map_height),
        '--max-turns', str(max_turns),
        '--games',     str(num_games),
    ] + extra_args

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=Path(__file__).parent.parent,   # packages/trainer
        env={**dict(os.environ), **model_env},
    )

    if result.returncode != 0:
        raise RuntimeError(f"Game evaluation failed: {result.stderr}")

    results = []
    for line in result.stdout.strip().split('\n'):
        line = line.strip()
        if line:
            try:
                results.append(float(line))
            except ValueError:
                pass

    if len(results) != num_games:
        raise RuntimeError(
            f"Expected {num_games} results, got {len(results)}. stderr: {result.stderr}"
        )

    for i, r in enumerate(results):
        print(f"  Game {i+1}: fitness={r:.4f}", flush=True)

    return results


def run_games_sequential(model_path: str, map_width: int, map_height: int,
                         max_turns: int = 300, num_games: int = 3) -> list:
    """
    Evaluate a single dense NnAgent model over num_games games.
    model_path should be an absolute path to an .onnx file.
    """
    model_path = os.path.abspath(model_path)
    return _run_eval(
        extra_args=['--agent', 'nn', '--model', model_path],
        model_env={'NN_MODEL_PATH': model_path},
        map_width=map_width, map_height=map_height,
        max_turns=max_turns, num_games=num_games,
    )


def run_games_moe_sequential(moe_dir: str, map_width: int, map_height: int,
                              max_turns: int = 300, num_games: int = 3) -> list:
    """
    Evaluate a NnMoEAgent from a directory of 9 .onnx files over num_games games.
    moe_dir should be an absolute path.
    """
    moe_dir = os.path.abspath(moe_dir)
    return _run_eval(
        extra_args=['--agent', 'moe', '--moe-dir', moe_dir],
        model_env={'NN_MOE_DIR': moe_dir},
        map_width=map_width, map_height=map_height,
        max_turns=max_turns, num_games=num_games,
    )


# ── PyTorch-based MoE evaluation (in-process, no Node.js) ────────────────────

def run_games_torch_moe(base_states, perturbations, configs, map_width, map_height,
                        max_turns, num_games, device=None):
    """
    Evaluate MoE agent using PyTorch with MPS/CPU.

    Args:
        base_states: Dict of {model_name: state_dict} for 9 experts
        perturbations: Dict of {model_name: perturbation_dict}
        configs: Dict of {model_name: config_dict}
        map_width, map_height: Map dimensions (playable, excludes ice caps)
        max_turns: Max turns per game
        num_games: Number of games to run
        device: torch.device (defaults to MPS if available, else CPU)

    Returns:
        List of fitness scores (one per game)
    """
    import torch
    from models_moe import MovementCNN, ProductionCNN, ALL_MODEL_NAMES, UNIT_TYPE_NAMES, NUM_GLOBAL

    if device is None:
        device = torch.device('mps') if torch.backends.mps.is_available() else torch.device('cpu')

    # Load all 9 models with perturbations applied
    models = {}
    for name in ALL_MODEL_NAMES:
        if name == 'production':
            model = ProductionCNN(**configs[name])
        else:
            model = MovementCNN(**configs[name])

        # Get base state
        state = base_states[name].copy()

        # Apply perturbations
        if name in perturbations:
            for layer_name in list(state.keys()):
                if layer_name in perturbations[name]:
                    pert = perturbations[name][layer_name]
                    noise = torch.tensor(pert['data'], dtype=state[layer_name].dtype)
                    noise = noise.reshape(pert['shape'])
                    state[layer_name] = state[layer_name] + noise

        model.load_state_dict(state)
        model.to(device)
        model.eval()
        models[name] = model

    # Run games
    results = []
    for g in range(num_games):
        fitness = run_single_game_torch_moe(models, device, map_width, map_height, max_turns)
        results.append(fitness)
        print(f"  Game {g+1}: fitness={fitness:.4f}", flush=True)

    return results


def run_single_game_torch_moe(models, device, map_width, map_height, max_turns):
    """
    Run one game between MoE agent (P1) and random BasicAgent (P2).

    Returns:
        Fitness score (city-accumulation score normalized to [0,1])
    """
    import torch
    import torch.nn.functional as F

    # Game state
    rng = np.random.RandomState(random.randint(0, 2**31))
    actual_height = map_height + 2  # Include ice caps

    # Generate map
    tiles = np.zeros((actual_height, map_width), dtype=np.float32)
    num_blobs = max(2, map_width * map_height // 200)
    for _ in range(num_blobs):
        cx = rng.randint(0, map_width)
        cy = rng.randint(2, actual_height - 2)
        radius = rng.randint(3, min(8, max(4, map_height // 2)))
        for y in range(max(1, cy - radius), min(actual_height - 1, cy + radius)):
            for x in range(max(0, cx - radius), min(map_width, cx + radius)):
                if (x - cx) ** 2 + (y - cy) ** 2 < radius ** 2:
                    tiles[y, x] = 1.0  # Land

    # Ice caps
    tiles[0, :] = 0.0
    tiles[-1, :] = 0.0

    # Place cities
    land_tiles = np.where(tiles == 1.0)
    land_positions = list(zip(land_tiles[0], land_tiles[1]))
    cities = []
    if len(land_positions) > 0:
        num_cities = min(10, len(land_positions) // 30)
        indices = rng.choice(len(land_positions), size=num_cities, replace=False)
        for i, idx in enumerate(indices):
            x, y = land_positions[idx]
            cities.append({'id': f'city_{i}', 'x': x, 'y': y, 'owner': 'neutral',
                          'producing': None, 'coastal': False})

    # Place units
    units = []
    if len(land_positions) > 0:
        # P1 spawn (left side)
        p1_x, p1_y = map_width // 4, map_height // 2
        best_p1 = min(land_positions, key=lambda p: (p[1]-p1_y)**2 + (p[0]-p1_x)**2)
        units.append({'id': 'p1_unit', 'type': 'army', 'owner': 'player1',
                     'x': best_p1[1], 'y': best_p1[0], 'moves_left': 1,
                     'carriedBy': None, 'sleeping': False})

        # P2 spawn (right side)
        p2_x, p2_y = 3 * map_width // 4, map_height // 2
        best_p2 = min(land_positions, key=lambda p: (p[1]-p2_y)**2 + (p[0]-p2_x)**2)
        units.append({'id': 'p2_unit', 'type': 'army', 'owner': 'player2',
                     'x': best_p2[1], 'y': best_p2[0], 'moves_left': 1,
                     'carriedBy': None, 'sleeping': False})

    # Assign cities to players
    if len(cities) >= 2:
        cities[0]['owner'] = 'player1'
        cities[0]['producing'] = 'army'
        cities[1]['owner'] = 'player2'
        cities[1]['producing'] = 'army'

    current_player = 'player1'
    turn = 1
    winner = None
    total_cities = len(cities)

    # Track pending units/cities per turn
    pending_unit_ids = set()
    pending_city_ids = set()
    pass_num = 1  # 1, 2, or 'prod'

    UNIT_TYPE_NAMES = ['army', 'fighter', 'bomber', 'transport',
                       'destroyer', 'submarine', 'carrier', 'battleship']
    UNIT_DOMAIN = {'army': 'land', 'fighter': 'air', 'bomber': 'air',
                   'transport': 'sea', 'destroyer': 'sea', 'submarine': 'sea',
                   'carrier': 'sea', 'battleship': 'sea'}

    def wrap_x(x, w):
        return x % w

    def build_tensor(tiles, my_units, enemy_units, my_cities, enemy_cities, turn,
                     marker_x=None, marker_y=None):
        """Build 15-channel tensor: 14 base + 1 marker."""
        h, w = tiles.shape
        # Base 14 channels from playerViewToTensor logic
        # Channel 11 = terrain, 12 = fog, 13 = turn context
        tensor = np.zeros((15, h, w), dtype=np.float32)

        # Terrain (channel 11)
        tensor[11] = tiles.copy()

        # Fog of war (channel 12) - all visible
        tensor[12] = 1.0

        # Turn context (channel 13)
        tensor[13] = min(turn / 1000.0, 1.0)

        # Marker (channel 14) if provided
        if marker_x is not None and marker_y is not None:
            if 0 <= marker_y < h and 0 <= marker_x < w:
                tensor[14, marker_y, marker_x] = 1.0

        return tensor

    def get_player_view(player_id):
        my_units = [u for u in units if u['owner'] == player_id]
        enemy_units = [u for u in units if u['owner'] != player_id]
        my_cities = [c for c in cities if c['owner'] == player_id]
        enemy_cities = [c for c in cities if c['owner'] != player_id]
        return {
            'tiles': tiles.tolist(),
            'myUnits': my_units,
            'myCities': my_cities,
            'visibleEnemyUnits': enemy_units,
            'visibleEnemyCities': enemy_cities,
            'turn': turn,
        }

    def argmax(arr):
        return int(np.argmax(arr))

    def step_toward(fx, fy, tx, ty, mw):
        dx = tx - fx
        if dx > mw / 2:
            dx -= mw
        elif dx < -mw / 2:
            dx += mw
        dy = ty - fy
        if abs(dx) >= abs(dy):
            step_x = 1 if dx > 0 else (-1 if dx < 0 else 0)
            step_y = 0
        else:
            step_x = 0
            step_y = 1 if dy > 0 else (-1 if dy < 0 else 0)
        return wrap_x(fx + step_x, mw), fy + step_y

    def run_moe_turn(obs):
        """Run MoE agent's turn, returns action or None."""
        nonlocal pass_num, pending_unit_ids, pending_city_ids

        my_units = obs['myUnits']
        my_cities = obs['myCities']

        # Detect new turn
        all_unit_ids = set(u['id'] for u in my_units if u['moves_left'] > 0 and not u['sleeping'])
        is_new_turn = len(pending_unit_ids) == 0 or not any(
            uid in all_unit_ids for uid in pending_unit_ids
        )

        if is_new_turn:
            pending_unit_ids = set(u['id'] for u in my_units
                                   if u['moves_left'] > 0 and not u['sleeping'])
            pending_city_ids = set(c['id'] for c in my_cities if c['producing'] is None)
            pass_num = 1

        # Pass 1: free armies -> sea -> air
        if pass_num == 1:
            def pass1_order(u):
                if u['type'] == 'army' and u['carriedBy'] is None:
                    return 0
                if UNIT_DOMAIN.get(u['type'], '') == 'sea':
                    return 1
                if UNIT_DOMAIN.get(u['type'], '') == 'air':
                    return 2
                return 3

            sorted_units = sorted(
                [u for u in my_units if u['id'] in pending_unit_ids and u['carriedBy'] is None],
                key=pass1_order
            )

            for unit in sorted_units:
                action = run_movement_expert(unit, obs)
                if action:
                    if action['type'] in ('SLEEP', 'SKIP'):
                        pending_unit_ids.discard(unit['id'])
                    elif unit['moves_left'] <= 1:
                        pending_unit_ids.discard(unit['id'])
                    return action
                pending_unit_ids.discard(unit['id'])

            pass_num = 2

        # Pass 2: carried armies
        if pass_num == 2:
            sorted_units = [u for u in my_units
                          if u['id'] in pending_unit_ids and u['carriedBy'] is not None
                          and u['type'] == 'army']

            for unit in sorted_units:
                action = run_movement_expert(unit, obs)
                if action:
                    if action['type'] in ('SLEEP', 'SKIP') or unit['moves_left'] <= 1:
                        pending_unit_ids.discard(unit['id'])
                    return action
                pending_unit_ids.discard(unit['id'])

            pass_num = 'prod'

        # Production
        if pass_num == 'prod':
            for city_id in list(pending_city_ids):
                city = next((c for c in my_cities if c['id'] == city_id), None)
                if city:
                    pending_city_ids.discard(city_id)
                    unit_type = run_production_expert(city, obs)
                    return {'type': 'SET_PRODUCTION', 'cityId': city['id'],
                           'unitType': unit_type}

        # Done
        pass_num = 1
        pending_unit_ids.clear()
        pending_city_ids.clear()
        return {'type': 'END_TURN'}

    def run_movement_expert(unit, obs):
        """Query movement expert for a unit."""
        model = models[unit['type']]

        # Build tensor with marker
        tensor = build_tensor(
            np.array(tiles), obs['myUnits'], obs['visibleEnemyUnits'],
            obs['myCities'], obs['visibleEnemyCities'], obs['turn'],
            unit['x'], unit['y']
        )

        input_tensor = torch.from_numpy(tensor).unsqueeze(0).float().to(device)

        with torch.no_grad():
            outputs = model(input_tensor)

        action_type_idx = argmax(outputs['action_type'].cpu().numpy()[0])
        target_tile_idx = argmax(outputs['target_tile'].cpu().numpy()[0])

        action_types = ['MOVE', 'SLEEP', 'SKIP', 'LOAD', 'UNLOAD']
        action_type = action_types[min(action_type_idx, len(action_types) - 1)]

        tx = target_tile_idx % map_width
        ty = target_tile_idx // map_width

        if action_type == 'MOVE':
            to_x, to_y = step_toward(unit['x'], unit['y'], tx, ty, map_width)
            return {'type': 'MOVE', 'unitId': unit['id'], 'to': {'x': to_x, 'y': to_y}}
        elif action_type == 'SLEEP':
            return {'type': 'SLEEP', 'unitId': unit['id']}
        elif action_type == 'SKIP':
            return {'type': 'SKIP', 'unitId': unit['id']}
        elif action_type == 'LOAD':
            transport = next((u for u in obs['myUnits'] if u['type'] == 'transport'), None)
            if transport:
                return {'type': 'LOAD', 'unitId': unit['id'], 'transportId': transport['id']}
            return None
        elif action_type == 'UNLOAD':
            to_x, to_y = step_toward(unit['x'], unit['y'], tx, ty, map_width)
            return {'type': 'UNLOAD', 'unitId': unit['id'], 'to': {'x': to_x, 'y': to_y}}

        return None

    def run_production_expert(city, obs):
        """Query production expert for a city."""
        model = models['production']

        # Build spatial tensor
        spatial = build_tensor(
            np.array(tiles), obs['myUnits'], obs['visibleEnemyUnits'],
            obs['myCities'], obs['visibleEnemyCities'], obs['turn'],
            city['x'], city['y']
        )

        # Build global features
        all_unit_types = UNIT_TYPE_NAMES
        global_features = np.zeros(NUM_GLOBAL, dtype=np.float32)

        # 0-7: my unit counts
        for i, ut in enumerate(all_unit_types):
            global_features[i] = len([u for u in obs['myUnits'] if u['type'] == ut]) / 20

        # 8-15: enemy unit counts
        for i, ut in enumerate(all_unit_types):
            global_features[8 + i] = len([u for u in obs['visibleEnemyUnits'] if u['type'] == ut]) / 20

        # 16: my city fraction
        total_cities = len(obs['myCities']) + len(obs['visibleEnemyCities'])
        global_features[16] = len(obs['myCities']) / total_cities if total_cities > 0 else 0

        # 17: total cities
        global_features[17] = total_cities / 30

        # 18: turn
        global_features[18] = obs['turn'] / 300

        # 19: production turns left
        global_features[19] = (city['producingTurnsLeft'] if 'producingTurnsLeft' in city else 0) / 10

        # 20: coastal
        global_features[20] = 1.0 if city.get('coastal', False) else 0.0

        # 21: bias
        global_features[21] = 1.0

        spatial_tensor = torch.from_numpy(spatial).unsqueeze(0).float().to(device)
        global_tensor = torch.from_numpy(global_features).unsqueeze(0).float().to(device)

        with torch.no_grad():
            outputs = model(spatial_tensor, global_tensor)

        unit_type_idx = argmax(outputs['unit_type'].cpu().numpy()[0])
        return all_unit_types[min(unit_type_idx, len(all_unit_types) - 1)]

    # Main game loop
    p1_cities_score = 0

    while winner is None and turn < max_turns:
        view = get_player_view(current_player)

        if current_player == 'player1':
            # MoE agent
            action = run_moe_turn(view)
            if action is None:
                action = {'type': 'END_TURN'}
        else:
            # Random BasicAgent
            rng_seed = random.randint(0, 2**31)
            obs_rng = np.random.RandomState(rng_seed)
            if obs_rng.random() < 0.3 and view['myUnits']:
                unit = obs_rng.choice(view['myUnits'])
                action = {
                    'type': 'MOVE',
                    'unitId': unit['id'],
                    'to': {
                        'x': obs_rng.randint(0, map_width - 1),
                        'y': obs_rng.randint(1, actual_height - 2)
                    }
                }
            else:
                action = {'type': 'END_TURN'}

        # Apply action
        if action['type'] == 'END_TURN':
            current_player = 'player2' if current_player == 'player1' else 'player1'
            if current_player == 'player1':
                turn += 1
            # Reset moves for current player's units
            for u in units:
                if u['owner'] == current_player:
                    u['moves_left'] = 1
        elif action['type'] == 'MOVE':
            unit = next((u for u in units if u['id'] == action.get('unitId')), None)
            if unit and unit['moves_left'] > 0:
                unit['x'] = action['to']['x']
                unit['y'] = action['to']['y']
                unit['moves_left'] = 0
        elif action['type'] == 'SET_PRODUCTION':
            city = next((c for c in cities if c['id'] == action.get('cityId')), None)
            if city and city['owner'] == current_player:
                city['producing'] = action.get('unitType')

        # Track P1 city score
        p1_cities = len([c for c in cities if c['owner'] == 'player1'])
        p1_cities_score += p1_cities

        # Check winner (simplified: no unit death in this minimal game)
        p1_units = [u for u in units if u['owner'] == 'player1']
        p2_units = [u for u in units if u['owner'] == 'player2']

        if not p1_units:
            winner = 'player2'
        elif not p2_units:
            winner = 'player1'

    # Fitness = normalized city-accumulation score
    fitness = p1_cities_score / (max_turns * total_cities) if total_cities > 0 else 0
    return min(fitness, 1.0)  # Clamp to [0,1]
