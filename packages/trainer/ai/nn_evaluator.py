"""
NN Model Evaluator - plays games using an ONNX model.

This provides a pure-Python game evaluator that can be used for
neuroevolution without requiring TypeScript/Node.js.

For full game logic, it imports the shared engine via a Python binding
or uses a simplified game simulation.
"""

import onnxruntime as ort
import numpy as np
from typing import Dict, List, Tuple, Optional
import random


class NNEvaluator:
    """Evaluates NN models by playing games."""

    def __init__(self, model_path: str, map_width: int = 50, map_height: int = 20):
        self.model_path = model_path
        self.map_width = map_width
        self.map_height = map_height

        # Load ONNX model
        self.session = ort.InferenceSession(model_path)

        # Action and unit type mappings
        self.action_types = [
            'END_TURN', 'SET_PRODUCTION', 'MOVE', 'LOAD', 'UNLOAD',
            'SLEEP', 'WAKE', 'SKIP', 'DISBAND'
        ]
        self.unit_types = [
            'army', 'fighter', 'bomber', 'transport', 'destroyer',
            'submarine', 'carrier', 'battleship'
        ]

    def create_observation(self, game_state: dict) -> np.ndarray:
        """
        Convert game state to observation tensor.

        This is a simplified version - the full implementation would
        match the tensorUtils.ts encoding.
        """
        # Create 14-channel tensor
        # Shape: [14, H+2, W]
        tensor = np.zeros((14, self.map_height + 2, self.map_width), dtype=np.float32)

        # Channel 0-7: Friendly unit types
        # Channel 8: Friendly units (aggregate)
        # Channel 9: Enemy units (aggregate)
        # Channel 10: Terrain (1 for Ocean, 0 for Land)
        # Channel 11: My cities
        # Channel 12: Enemy cities
        # Channel 13: My bomber blast radius

        # Populate from game state
        for unit in game_state.get('my_units', []):
            channel = self.unit_to_channel(unit['type'])
            if 0 <= channel <= 7:
                tensor[channel, unit['y'], unit['x']] = 1.0
                tensor[8, unit['y'], unit['x']] = 1.0  # Aggregate

        for unit in game_state.get('enemy_units', []):
            tensor[9, unit['y'], unit['x']] = 1.0  # Enemy aggregate

        # Terrain
        for y in range(self.map_height):
            for x in range(self.map_width):
                if game_state.get('terrain', {}).get((x, y)) == 'ocean':
                    tensor[10, y, x] = 1.0

        # Cities
        for city in game_state.get('my_cities', []):
            tensor[11, city['y'], city['x']] = 1.0

        for city in game_state.get('enemy_cities', []):
            tensor[12, city['y'], city['x']] = 1.0

        return tensor

    def unit_to_channel(self, unit_type: str) -> int:
        """Map unit type to tensor channel."""
        unit_map = {
            'army': 0, 'fighter': 1, 'bomber': 2, 'transport': 3,
            'destroyer': 4, 'submarine': 5, 'carrier': 6, 'battleship': 7
        }
        return unit_map.get(unit_type, 0)

    def select_moveable_unit(self, units: List[dict]) -> Optional[dict]:
        """Select first moveable unit."""
        for unit in units:
            if unit.get('moves_left', 0) > 0 and not unit.get('sleeping', False):
                return unit
        return units[0] if units else None

    def select_city(self, cities: List[dict]) -> Optional[dict]:
        """Select first city."""
        return cities[0] if cities else None

    def act(self, observation: np.ndarray, my_units: List[dict], my_cities: List[dict]) -> dict:
        """
        Get action from NN.

        Args:
            observation: [14, H+2, W] tensor
            my_units: List of my units
            my_cities: List of my cities

        Returns:
            Action dict
        """
        # Add batch dimension
        input_tensor = observation[np.newaxis, ...].astype(np.float32)

        # Run inference
        input_name = self.session.get_inputs()[0].name
        outputs = self.session.run(None, {input_name: input_tensor})

        # Extract predictions
        action_type_probs = outputs[0].flatten()
        target_tile_probs = outputs[1].flatten()
        prod_type_probs = outputs[2].flatten()

        action_type_idx = np.argmax(action_type_probs)
        target_tile_idx = np.argmax(target_tile_probs)
        prod_type_idx = np.argmax(prod_type_probs)

        action_type = self.action_types[action_type_idx]

        # Build action
        if action_type == 'MOVE':
            unit = self.select_moveable_unit(my_units)
            if unit:
                x = target_tile_idx % self.map_width
                y = target_tile_idx // self.map_width
                return {
                    'type': 'MOVE',
                    'unitId': unit['id'],
                    'to': {'x': x, 'y': y}
                }

        elif action_type == 'SET_PRODUCTION':
            city = self.select_city(my_cities)
            if city:
                return {
                    'type': 'SET_PRODUCTION',
                    'cityId': city['id'],
                    'unitType': self.unit_types[prod_type_idx]
                }

        # Default: END_TURN
        return {'type': 'END_TURN'}


class SimpleGame:
    """
    Simplified game state for evaluation.

    This is a placeholder - for real evaluation, use the TypeScript
    engine via nn_simulator.ts or implement full game logic in Python.
    """

    def __init__(self, map_width: int = 50, map_height: int = 20):
        self.map_width = map_width
        self.map_height = map_height
        self.turn = 0
        self.winner = None

        # Initialize simple state
        self.units = []
        self.cities = []
        self.terrain = {}

    def to_observation(self, player_id: str) -> dict:
        """Convert to observation format for NN."""
        return {
            'my_units': [u for u in self.units if u['owner'] == player_id],
            'enemy_units': [u for u in self.units if u['owner'] != player_id],
            'my_cities': [c for c in self.cities if c['owner'] == player_id],
            'enemy_cities': [c for c in self.cities if c['owner'] != player_id],
            'terrain': self.terrain,
        }


def play_game(model_path: str, map_width: int = 50, map_height: int = 20,
              max_turns: int = 200) -> Tuple[str, int]:
    """
    Play a game using the NN model.

    Returns: (winner, turns)
    """
    # This is a placeholder implementation.
    # For actual evaluation, you need to:
    # 1. Use the TypeScript game engine (via nn_simulator.ts)
    # 2. Or implement full game logic in Python

    # For now, return a random result
    evaluator = NNEvaluator(model_path, map_width, map_height)
    game = SimpleGame(map_width, map_height)

    # Placeholder: simulate random game
    turns = random.randint(50, max_turns)
    winner = random.choice(['player1', 'player2'])

    return winner, turns


def evaluate_model(model_path: str, num_games: int, map_width: int = 50,
                   map_height: int = 20) -> float:
    """
    Evaluate a model by playing multiple games.

    Returns: win rate against BasicAgent
    """
    wins = 0
    total = 0

    for _ in range(num_games):
        winner, _ = play_game(model_path, map_width, map_height)
        if winner == 'player1':  # NN is player1
            wins += 1
        total += 1

    return wins / total if total > 0 else 0.0


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, help='ONNX model path')
    parser.add_argument('--games', type=int, default=10)
    parser.add_argument('--map-width', type=int, default=50)
    parser.add_argument('--map-height', type=int, default=20)
    args = parser.parse_args()

    win_rate = evaluate_model(args.model, args.games, args.map_width, args.map_height)
    print(f"Win rate: {win_rate:.4f}")
