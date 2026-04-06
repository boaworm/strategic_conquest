"""
Game evaluator for evolution - runs games in Python using onnxruntime.

Avoids npm/node subprocess overhead by running game loop directly in Python.
"""

import os
import sys
import random
from pathlib import Path

import numpy as np
import onnxruntime as ort

# Game constants
NUM_CHANNELS = 14
NUM_ACTION_TYPES = 9
NUM_UNIT_TYPES = 8

ACTION_TYPES = ['END_TURN', 'SET_PRODUCTION', 'MOVE', 'LOAD', 'UNLOAD', 'SLEEP', 'WAKE', 'SKIP', 'DISBAND']
UNIT_TYPES = ['army', 'fighter', 'bomber', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship']


class SimpleGame:
    """Minimal game state for evaluation."""

    def __init__(self, width: int, height: int, seed: int = None):
        self.map_width = width
        self.map_height = height
        self.seed = seed or random.randint(0, 2**31)
        self.rng = np.random.RandomState(self.seed)

        # Generate simple map (land/ocean)
        self.tiles = self._generate_map()

        # Place starting cities
        self.cities = self._place_cities()

        # Place starting units
        self.units = self._place_units()

        self.current_player = 'player1'
        self.turn = 1
        self.winner = None
        self.max_turns = 300

    def _generate_map(self) -> np.ndarray:
        """Generate a simple land/ocean map."""
        tiles = np.zeros((self.map_height, self.map_width), dtype=np.float32)

        # Simple blob-based land generation
        num_blobs = self.map_width * self.map_height // 500
        for _ in range(num_blobs):
            cx = self.rng.randint(0, self.map_width)
            cy = self.rng.randint(2, self.map_height - 2)
            radius = self.rng.randint(3, 8)

            for y in range(max(1, cy - radius), min(self.map_height - 1, cy + radius)):
                for x in range(max(0, cx - radius), min(self.map_width, cx + radius)):
                    if (x - cx) ** 2 + (y - cy) ** 2 < radius ** 2:
                        tiles[y, x] = 1.0  # Land

        # Ice caps
        tiles[0, :] = 0.0
        tiles[-1, :] = 0.0

        return tiles

    def _place_cities(self) -> list:
        """Place neutral cities on land tiles."""
        cities = []
        land_tiles = np.where(self.tiles == 1.0)

        if len(land_tiles[0]) > 0:
            num_cities = min(10, len(land_tiles[0]) // 50)
            indices = self.rng.choice(len(land_tiles[0]), size=num_cities, replace=False)

            for i, idx in enumerate(indices):
                x = land_tiles[1][idx]
                y = land_tiles[0][idx]
                cities.append({
                    'id': f'city_{i}',
                    'x': x, 'y': y,
                    'owner': 'neutral',
                    'production': None
                })

        return cities

    def _place_units(self) -> list:
        """Place starting units for both players."""
        units = []

        # Player 1 starting position (left side)
        p1_x = self.map_width // 4
        p1_y = self.map_height // 2

        # Find nearest land tile
        for y in range(self.map_height):
            for x in range(self.map_width):
                if self.tiles[y, x] == 1.0 and abs(x - p1_x) < 5 and abs(y - p1_y) < 5:
                    units.append({
                        'id': 'unit_p1_0',
                        'type': 'army',
                        'owner': 'player1',
                        'x': x, 'y': y,
                        'moves_left': 1,
                        'health': 100
                    })
                    break

        # Player 2 starting position (right side)
        p2_x = 3 * self.map_width // 4
        p2_y = self.map_height // 2

        for y in range(self.map_height):
            for x in range(self.map_width):
                if self.tiles[y, x] == 1.0 and abs(x - p2_x) < 5 and abs(y - p2_y) < 5:
                    units.append({
                        'id': 'unit_p2_0',
                        'type': 'army',
                        'owner': 'player2',
                        'x': x, 'y': y,
                        'moves_left': 1,
                        'health': 100
                    })
                    break

        return units

    def get_player_view(self, player_id: str) -> dict:
        """Get player's observation of the game state."""
        return {
            'tiles': self.tiles.tolist(),
            'myUnits': [u for u in self.units if u['owner'] == player_id],
            'myCities': [c for c in self.cities if c['owner'] == player_id],
            'visibleEnemyUnits': [u for u in self.units if u['owner'] != player_id],
            'visibleEnemyCities': [c for c in self.cities if c['owner'] != player_id],
            'turn': self.turn,
            'myPlayerId': player_id
        }

    def apply_action(self, action: dict, player_id: str) -> bool:
        """Apply an action to the game state."""
        if action['type'] == 'END_TURN':
            self.current_player = 'player2' if self.current_player == 'player1' else 'player1'
            if self.current_player == 'player1':
                self.turn += 1
            return True

        if action['type'] == 'MOVE':
            unit = next((u for u in self.units if u['id'] == action.get('unitId')), None)
            if unit and unit['moves_left'] > 0:
                unit['x'] = action['to']['x']
                unit['y'] = action['to']['y']
                unit['moves_left'] = 0
                return True

        if action['type'] == 'SET_PRODUCTION':
            city = next((c for c in self.cities if c['id'] == action.get('cityId')), None)
            if city and city['owner'] == player_id:
                city['production'] = action['unitType']
                return True

        return False

    def check_winner(self) -> str:
        """Check if there's a winner."""
        p1_units = [u for u in self.units if u['owner'] == 'player1']
        p2_units = [u for u in self.units if u['owner'] == 'player2']

        if not p1_units:
            return 'player2'
        if not p2_units:
            return 'player1'

        if self.turn >= self.max_turns:
            return None  # Draw

        return None


def player_view_to_tensor(view: dict, map_width: int, map_height: int) -> np.ndarray:
    """Convert player view to tensor for NN input."""
    # Model expects height+2 (including ice caps)
    actual_height = map_height + 2
    tensor = np.zeros((NUM_CHANNELS, actual_height, map_width), dtype=np.float32)
    # Place tiles with ice caps (row 0 and row -1 are ice caps)
    tensor[11, 1:-1, :] = np.array(view['tiles'])
    tensor[13, 1:-1, :] = view['turn'] / 1000.0
    return tensor


def run_game(model_path: str, map_width: int, map_height: int, max_turns: int = 300) -> float:
    """
    Run a single game between NN (player1) and BasicAgent (player2).

    Returns: 1 if NN wins, 0 if NN loses, 0.5 for draw
    """
    # Suppress CoreML warnings
    ort.set_default_logger_severity(3)

    session = ort.InferenceSession(
        model_path,
        providers=['CoreMLExecutionProvider', 'CPUExecutionProvider']
    )
    game = SimpleGame(map_width, map_height)

    class BasicAgent:
        def act(self, obs, rng):
            if rng.random() < 0.3 and obs['myUnits']:
                return {
                    'type': 'MOVE',
                    'unitId': obs['myUnits'][0]['id'],
                    'to': {'x': rng.randint(0, map_width-1), 'y': rng.randint(1, map_height-2)}
                }
            return {'type': 'END_TURN'}

    basic_agent = BasicAgent()
    rng = np.random.RandomState(game.seed + 1000)

    while game.winner is None and game.turn < max_turns:
        view = game.get_player_view(game.current_player)

        if game.current_player == 'player1':
            tensor = player_view_to_tensor(view, map_width, map_height)
            input_tensor = np.expand_dims(tensor, axis=0).astype(np.float32)

            outputs = session.run(None, {'input': input_tensor})
            action_idx = int(np.argmax(outputs[0]))
            action_type = ACTION_TYPES[min(action_idx, len(ACTION_TYPES) - 1)]

            if action_type == 'MOVE' and view['myUnits']:
                target_idx = int(np.argmax(outputs[1]))
                action = {
                    'type': 'MOVE',
                    'unitId': view['myUnits'][0]['id'],
                    'to': {'x': target_idx % map_width, 'y': target_idx // map_width}
                }
            else:
                action = {'type': 'END_TURN'}
        else:
            action = basic_agent.act(view, rng)

        game.apply_action(action, game.current_player)
        game.winner = game.check_winner()

    if game.winner == 'player1':
        return 1.0
    elif game.winner == 'player2':
        return 0.0
    else:
        return 0.5


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Run game evaluation')
    parser.add_argument('--model', required=True, help='ONNX model path')
    parser.add_argument('--map-width', type=int, default=50)
    parser.add_argument('--map-height', type=int, default=20)
    parser.add_argument('--max-turns', type=int, default=300)
    args = parser.parse_args()

    result = run_game(args.model, args.map_width, args.map_height, args.max_turns)
    print(f"Game result: {'NN wins' if result == 1 else 'NN loses' if result == 0 else 'Draw'}")


if __name__ == '__main__':
    main()
