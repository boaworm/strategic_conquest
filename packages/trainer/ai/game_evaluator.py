"""
Game evaluator for evolution - runs games using Node.js + TypeScript engine.
Supports both single-model (NnAgent) and MoE (NnMoEAgent) evaluation.
"""

import os
import subprocess
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
