"""
MoEEvalPool — manages N persistent Node.js eval_server.js processes.

Each server stays alive for the entire evolution run.
Python submits genomes as JSON (with base64-encoded numpy npz weights),
servers return fitness lists as JSON.

Usage:
    pool = MoEEvalPool(num_workers=8, map_width=30, map_height=10,
                       max_turns=300, games_per_agent=10)
    results = pool.evaluate(base_states, perturbations, configs)
    pool.close()
"""

import base64
import io
import json
import os
import subprocess
import sys
import threading
import warnings
import logging
from pathlib import Path
from queue import Queue

import numpy as np
import torch

warnings.filterwarnings("ignore")
logging.getLogger("torch.onnx").setLevel(logging.ERROR)

# Path to eval_server.js (same directory as this file)
_EVAL_SERVER = str(Path(__file__).parent / 'eval_server.js')
# Run from packages/trainer so @sc/shared resolves correctly
_SERVER_CWD = str(Path(__file__).parent.parent)

NUM_GLOBAL = 28  # must match models_moe.py


def _clean_key(layer: str) -> str:
    """Strip torch.compile's `_orig_mod.` prefix so npz keys match model.state_dict()."""
    return layer.removeprefix('_orig_mod.')


def _build_base_npz(base_states: dict) -> bytes:
    """Pack base model weights (no perturbation) into a numpy .npz buffer."""
    from models_moe import ALL_MODEL_NAMES
    arrays = {}
    for name in ALL_MODEL_NAMES:
        for layer, param in base_states[name].items():
            arrays[f'{name}/{_clean_key(layer)}'] = param.detach().cpu().numpy()
    buf = io.BytesIO()
    np.savez(buf, **arrays)
    return buf.getvalue()


def _build_delta_npz(perturbations: dict) -> bytes:
    """Pack perturbation deltas (numpy arrays) into a numpy .npz buffer."""
    from models_moe import ALL_MODEL_NAMES
    arrays = {}
    for name in ALL_MODEL_NAMES:
        for layer, arr in perturbations.get(name, {}).items():
            arrays[f'{name}/{_clean_key(layer)}'] = arr
    buf = io.BytesIO()
    np.savez(buf, **arrays)
    return buf.getvalue()


# Kept for champion ONNX export only
_ONNX_EXPORT_LOCK = threading.Lock()


def _export_model_to_bytes(model, model_name: str, config: dict) -> bytes:
    """Export a PyTorch model to ONNX bytes (in-memory, no disk I/O)."""
    model.eval().cpu()
    H, W = config['map_height'], config['map_width']
    in_channels = int(model.conv1.weight.shape[1])
    buf = io.BytesIO()

    with _ONNX_EXPORT_LOCK, warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if model_name == 'production':
            dummy_spatial = torch.randn(1, in_channels, H, W)
            dummy_global  = torch.randn(1, NUM_GLOBAL)
            torch.onnx.export(
                model, (dummy_spatial, dummy_global), buf,
                export_params=True, opset_version=18, do_constant_folding=True,
                input_names=["input", "global_features"],
                output_names=["unit_type"],
            )
        else:
            dummy = torch.randn(1, in_channels, H, W)
            torch.onnx.export(
                model, dummy, buf,
                export_params=True, opset_version=18, do_constant_folding=True,
                input_names=["input"],
                output_names=["action_type", "target_tile"],
            )

    return buf.getvalue()


class _EvalServer:
    """One persistent Node.js eval_server.js process."""

    def __init__(self):
        env = {**os.environ, 'PYTHON_EXECUTABLE': sys.executable}
        self._proc = subprocess.Popen(
            ['node', _EVAL_SERVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,  # forward server logs to our stderr
            cwd=_SERVER_CWD,
            env=env,
        )
        self._lock = threading.Lock()

    def _send_recv(self, request: dict) -> dict:
        with self._lock:
            self._proc.stdin.write((json.dumps(request) + '\n').encode())
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
            if not line:
                raise RuntimeError("eval_server stdout closed unexpectedly")
            return json.loads(line.decode())

    def set_base(self, base_npz_b64: str, width: int, height: int) -> None:
        """Send base weights once — sidecar stores them for all subsequent delta evals."""
        resp = self._send_recv({'base_npz': base_npz_b64, 'width': width, 'height': height})
        if 'error' in resp:
            raise RuntimeError(f"eval_server set_base error: {resp['error']}")

    def evaluate(self, weights_npz_b64: str, games: int, width: int, height: int, max_turns: int,
                 alpha: float = 1.0, beta: float = 0.0, gamma: float = 0.0,
                 fitness_mode: str = 'additive', strike_scale: float = 100.0) -> list:
        """Send one delta genome request, block until response."""
        resp = self._send_recv({
            'weights_npz': weights_npz_b64,
            'games': games,
            'width': width,
            'height': height,
            'maxTurns': max_turns,
            'alpha': alpha,
            'beta': beta,
            'gamma': gamma,
            'fitnessMode': fitness_mode,
            'strikeScale': strike_scale,
        })
        if 'error' in resp:
            raise RuntimeError(f"eval_server error: {resp['error']}")
        return resp['results']

    def kill(self):
        """Force-terminate the subprocess; blocked readline() will see EOF."""
        try:
            self._proc.kill()
        except Exception:
            pass

    def is_alive(self) -> bool:
        return self._proc.poll() is None

    def close(self):
        try:
            self._proc.stdin.close()
            self._proc.wait(timeout=10)
        except Exception:
            self._proc.kill()


class MoEEvalPool:
    """
    Pool of N persistent eval_server.js processes.
    Thread-safe: multiple threads can call evaluate() concurrently.
    """

    def __init__(self, num_workers: int, map_width: int, map_height: int,
                 max_turns: int, games_per_agent: int,
                 per_genome_timeout: float = 120.0,
                 alpha: float = 1.0, beta: float = 0.0, gamma: float = 0.0,
                 fitness_mode: str = 'additive', strike_scale: float = 100.0):
        self.map_width = map_width
        self.map_height = map_height
        self.max_turns = max_turns
        self.games_per_agent = games_per_agent
        self.per_genome_timeout = per_genome_timeout
        self.alpha = alpha
        self.beta = beta
        self.gamma = gamma
        self.fitness_mode = fitness_mode
        self.strike_scale = strike_scale
        self._base_npz_b64: str | None = None
        self._pool_lock = threading.Lock()

        # Queue of idle servers
        self._idle: Queue = Queue()
        self._servers = []
        for _ in range(num_workers):
            s = _EvalServer()
            self._servers.append(s)
            self._idle.put(s)

        print(f"[MoEEvalPool] {num_workers} eval servers ready (per-genome timeout={per_genome_timeout}s)", flush=True)

    def set_base(self, base_states: dict, map_width: int, map_height: int) -> None:
        """Send base weights to all eval servers (call once before evolution loop)."""
        npz_bytes = _build_base_npz(base_states)
        self._base_npz_b64 = base64.b64encode(npz_bytes).decode('ascii')
        for server in self._servers:
            server.set_base(self._base_npz_b64, map_width, map_height)
        print(f"[MoEEvalPool] base weights loaded into {len(self._servers)} servers", flush=True)

    def preexport(self, base_states: dict, perturbations: dict, configs: dict = None) -> str:
        """
        Pack perturbation deltas into a base64-encoded numpy npz buffer.
        base_states and configs are ignored (kept for API compatibility).
        """
        return base64.b64encode(_build_delta_npz(perturbations)).decode('ascii')

    def _respawn_server(self, dead_server: '_EvalServer') -> '_EvalServer':
        """Kill the dead server and spawn a replacement with base weights loaded."""
        try: dead_server.kill()
        except Exception: pass
        new_server = _EvalServer()
        if self._base_npz_b64 is not None:
            new_server.set_base(self._base_npz_b64, self.map_width, self.map_height)
        with self._pool_lock:
            try:
                idx = self._servers.index(dead_server)
                self._servers[idx] = new_server
            except ValueError:
                self._servers.append(new_server)
        return new_server

    def evaluate_b64(self, weights_npz_b64: str) -> list:
        """
        Send pre-built npz weights to an idle server, return fitness list.
        Thread-safe — multiple threads can call this concurrently.
        Per-genome timeout kills the sidecar and respawns a replacement.
        """
        server = self._idle.get()
        timer = None
        if self.per_genome_timeout and self.per_genome_timeout > 0:
            timer = threading.Timer(self.per_genome_timeout, server.kill)
            timer.daemon = True
            timer.start()
        try:
            results = server.evaluate(
                weights_npz_b64, self.games_per_agent,
                self.map_width, self.map_height, self.max_turns,
                alpha=self.alpha, beta=self.beta, gamma=self.gamma,
                fitness_mode=self.fitness_mode, strike_scale=self.strike_scale,
            )
            if timer: timer.cancel()
            self._idle.put(server)
            return results
        except Exception:
            if timer: timer.cancel()
            # server is suspect (killed by timer or died on its own) — replace it
            new_server = self._respawn_server(server)
            self._idle.put(new_server)
            raise

    def evaluate(self, base_states: dict, perturbations: dict, configs: dict) -> list:
        """Export + evaluate in one call (kept for compatibility)."""
        return self.evaluate_b64(self.preexport(base_states, perturbations))

    def close(self):
        for s in self._servers:
            s.close()
        print("[MoEEvalPool] all servers closed", flush=True)
