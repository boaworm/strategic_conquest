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


def _build_models_npz(base_states: dict, perturbations: dict) -> bytes:
    """
    Apply perturbations to base state dicts, pack all model weights into
    a numpy .npz buffer (key = '{model_name}/{layer}'), return raw bytes.
    """
    from models_moe import ALL_MODEL_NAMES

    arrays = {}
    for name in ALL_MODEL_NAMES:
        pert = perturbations.get(name, {})
        for layer, param in base_states[name].items():
            if layer in pert:
                noise = torch.tensor(pert[layer]['data'], dtype=param.dtype).reshape(pert[layer]['shape'])
                arr = (param + noise).detach().cpu().numpy()
            else:
                arr = param.detach().cpu().numpy()
            arrays[f'{name}/{layer}'] = arr

    buf = io.BytesIO()
    np.savez(buf, **arrays)
    return buf.getvalue()


# Kept for champion ONNX export only
_ONNX_EXPORT_LOCK = threading.Lock()


def _export_model_to_bytes(model, model_name: str, config: dict) -> bytes:
    """Export a PyTorch model to ONNX bytes (in-memory, no disk I/O)."""
    model.eval().cpu()
    H, W = config['map_height'], config['map_width']
    buf = io.BytesIO()

    with _ONNX_EXPORT_LOCK, warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if model_name == 'production':
            dummy_spatial = torch.randn(1, 15, H, W)
            dummy_global  = torch.randn(1, NUM_GLOBAL)
            torch.onnx.export(
                model, (dummy_spatial, dummy_global), buf,
                export_params=True, opset_version=18, do_constant_folding=True,
                input_names=["input", "global_features"],
                output_names=["unit_type"],
            )
        else:
            dummy = torch.randn(1, 15, H, W)
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

    def evaluate(self, weights_npz_b64: str, games: int, width: int, height: int, max_turns: int) -> list:
        """Send one genome request, block until response."""
        request = json.dumps({
            'weights_npz': weights_npz_b64,
            'games': games,
            'width': width,
            'height': height,
            'maxTurns': max_turns,
        })
        with self._lock:
            self._proc.stdin.write((request + '\n').encode())
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
            if not line:
                raise RuntimeError("eval_server stdout closed unexpectedly")
            response = json.loads(line.decode())

        if 'error' in response:
            raise RuntimeError(f"eval_server error: {response['error']}")
        return response['results']

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
                 max_turns: int, games_per_agent: int):
        self.map_width = map_width
        self.map_height = map_height
        self.max_turns = max_turns
        self.games_per_agent = games_per_agent

        # Queue of idle servers
        self._idle: Queue = Queue()
        self._servers = []
        for _ in range(num_workers):
            s = _EvalServer()
            self._servers.append(s)
            self._idle.put(s)

        print(f"[MoEEvalPool] {num_workers} eval servers ready", flush=True)

    def preexport(self, base_states: dict, perturbations: dict, configs: dict = None) -> str:
        """
        Pack 9 model weight tensors into a base64-encoded numpy npz buffer.
        configs is ignored (kept for API compatibility).
        """
        npz_bytes = _build_models_npz(base_states, perturbations)
        return base64.b64encode(npz_bytes).decode('ascii')

    def evaluate_b64(self, weights_npz_b64: str) -> list:
        """
        Send pre-built npz weights to an idle server, return fitness list.
        Thread-safe — multiple threads can call this concurrently.
        """
        server = self._idle.get()
        try:
            results = server.evaluate(
                weights_npz_b64, self.games_per_agent,
                self.map_width, self.map_height, self.max_turns,
            )
        finally:
            self._idle.put(server)
        return results

    def evaluate(self, base_states: dict, perturbations: dict, configs: dict) -> list:
        """Export + evaluate in one call (kept for compatibility)."""
        return self.evaluate_b64(self.preexport(base_states, perturbations))

    def close(self):
        for s in self._servers:
            s.close()
        print("[MoEEvalPool] all servers closed", flush=True)
