#!/usr/bin/env python3
"""
MoE MPS inference server — spawned once per eval_server.js process.
Loads 9 PyTorch models and runs inference on MPS (Apple GPU).

Binary protocol over stdin / stdout:

  Frame:    [1B msg_type] [4B payload_len big-endian] [payload]

  MSG_SET_WEIGHTS = 1
    payload:  [2B H big-endian] [2B W big-endian] [npz bytes]
    response: [1B 0x01]   (ACK)

  MSG_INFER_MOVEMENT = 2
    payload:  [1B unit_type_idx] [float32 LE × 15*H*W]
    response: [float32 LE × 5] [float32 LE × H*W]

  MSG_INFER_PRODUCTION = 3
    payload:  [float32 LE × 15*H*W] [float32 LE × 28]
    response: [float32 LE × 8]

  MSG_EXIT = 255  (no response)

All float data uses native (little-endian) byte order.
"""

import io
import struct
import sys
from pathlib import Path

import numpy as np
import torch

_script_dir = Path(__file__).parent
sys.path.insert(0, str(_script_dir))
from models_moe import MovementCNN, ProductionCNN, UNIT_TYPE_NAMES, ALL_MODEL_NAMES

# ── Device ────────────────────────────────────────────────────────────────────

device = 'mps' if torch.backends.mps.is_available() else 'cpu'
sys.stderr.write(f'[moe_mps_server] device={device}\n')
sys.stderr.flush()

# ── I/O helpers ───────────────────────────────────────────────────────────────

_stdin  = sys.stdin.buffer
_stdout = sys.stdout.buffer
NUM_GLOBAL = 28


def _read_exact(n: int) -> bytes:
    chunks, remaining = [], n
    while remaining > 0:
        chunk = _stdin.read(remaining)
        if not chunk:
            sys.exit(0)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


# ── Model state ───────────────────────────────────────────────────────────────

_models: dict = {}
_base_tensors: dict = {}  # {f'{model_name}/{layer}': MPS tensor} — set once per run
_H: int = 0
_W: int = 0


def _init_models(H: int, W: int, channels: int = 15) -> None:
    global _H, _W
    _H, _W = H, W
    _models.clear()
    for name in UNIT_TYPE_NAMES:
        m = MovementCNN(channels=channels, map_height=H, map_width=W)
        _models[name] = m.to(device).eval()
    prod = ProductionCNN(channels=channels, map_height=H, map_width=W)
    _models['production'] = prod.to(device).eval()
    sys.stderr.write(f'[moe_mps_server] models initialised ({len(_models)} experts, {W}x{H})\n')
    sys.stderr.flush()


# ── Message handlers ──────────────────────────────────────────────────────────

def _handle_set_base(payload: bytes) -> None:
    global _H, _W
    H = struct.unpack('>H', payload[:2])[0]
    W = struct.unpack('>H', payload[2:4])[0]
    npz_bytes = payload[4:]

    if not _models or _H != H or _W != W:
        _init_models(H, W)

    buf = io.BytesIO(npz_bytes)
    data = np.load(buf, allow_pickle=False)

    for name in ALL_MODEL_NAMES:
        if name not in _models:
            continue
        cur_sd = _models[name].state_dict()
        new_sd = {}
        for key in cur_sd:
            arr_key = f'{name}/{key}'
            if arr_key in data:
                new_sd[key] = torch.from_numpy(data[arr_key].copy()).to(device)
            else:
                new_sd[key] = cur_sd[key]
        _models[name].load_state_dict(new_sd)
        # Store base as cloned MPS tensors for fast per-genome delta application
        for key, tensor in _models[name].state_dict().items():
            _base_tensors[f'{name}/{key}'] = tensor.clone()

    sys.stderr.write(f'[moe_mps_server] base weights stored ({len(_base_tensors)} tensors)\n')
    sys.stderr.flush()
    _stdout.write(b'\x04')
    _stdout.flush()


def _handle_set_weights(payload: bytes) -> None:
    """Apply perturbation delta on top of stored base weights (in-place, no load_state_dict)."""
    global _H, _W
    H = struct.unpack('>H', payload[:2])[0]
    W = struct.unpack('>H', payload[2:4])[0]
    npz_bytes = payload[4:]

    if not _models or _H != H or _W != W:
        _init_models(H, W)

    buf = io.BytesIO(npz_bytes)
    data = np.load(buf, allow_pickle=False)

    if not _base_tensors:
        # No base loaded — fall back to treating payload as full weights
        sys.stderr.write('[moe_mps_server] WARNING: no base weights, falling back to full load\n')
        sys.stderr.flush()
        for name in ALL_MODEL_NAMES:
            if name not in _models:
                continue
            cur_sd = _models[name].state_dict()
            new_sd = {}
            for key in cur_sd:
                arr_key = f'{name}/{key}'
                if arr_key in data:
                    new_sd[key] = torch.from_numpy(data[arr_key].copy()).to(device)
                else:
                    new_sd[key] = cur_sd[key]
            _models[name].load_state_dict(new_sd)
        _stdout.write(b'\x01')
        _stdout.flush()
        return

    for name in ALL_MODEL_NAMES:
        if name not in _models:
            continue
        for param_name, param in _models[name].named_parameters():
            key = f'{name}/{param_name}'
            base = _base_tensors.get(key)
            if base is None:
                continue
            if key in data:
                delta = torch.from_numpy(data[key].copy()).to(device)
                param.data.copy_(base).add_(delta)
            else:
                param.data.copy_(base)
        for buf_name, buf_tensor in _models[name].named_buffers():
            key = f'{name}/{buf_name}'
            base = _base_tensors.get(key)
            if base is None:
                continue
            if key in data:
                delta = torch.from_numpy(data[key].copy()).to(device)
                buf_tensor.copy_(base).add_(delta)
            else:
                buf_tensor.copy_(base)

    _stdout.write(b'\x01')
    _stdout.flush()


def _handle_infer_movement(payload: bytes) -> None:
    unit_idx = payload[0]
    name = UNIT_TYPE_NAMES[unit_idx] if unit_idx < len(UNIT_TYPE_NAMES) else None

    if name is None or name not in _models:
        _stdout.write(bytes((5 + _H * _W) * 4))
        _stdout.flush()
        return

    arr = np.frombuffer(payload[1:], dtype='<f4').copy()
    x = torch.from_numpy(arr).reshape(1, 15, _H, _W).to(device)

    with torch.no_grad():
        out = _models[name](x)

    at = out['action_type'][0].cpu().numpy().astype('<f4')
    tt = out['target_tile'][0].reshape(-1).cpu().numpy().astype('<f4')
    _stdout.write(at.tobytes())
    _stdout.write(tt.tobytes())
    _stdout.flush()


def _handle_infer_production(payload: bytes) -> None:
    n_spatial = 15 * _H * _W
    spatial = np.frombuffer(payload[:n_spatial * 4], dtype='<f4').copy()
    glob    = np.frombuffer(payload[n_spatial * 4:], dtype='<f4').copy()

    x = torch.from_numpy(spatial).reshape(1, 15, _H, _W).to(device)
    g = torch.from_numpy(glob).reshape(1, NUM_GLOBAL).to(device)

    with torch.no_grad():
        out = _models['production'](x, g)

    ut = out['unit_type'][0].cpu().numpy().astype('<f4')
    _stdout.write(ut.tobytes())
    _stdout.flush()


# ── Main loop ─────────────────────────────────────────────────────────────────

sys.stderr.write('[moe_mps_server] ready\n')
sys.stderr.flush()

while True:
    hdr = _read_exact(5)
    msg_type    = hdr[0]
    payload_len = struct.unpack('>I', hdr[1:5])[0]
    payload     = _read_exact(payload_len) if payload_len > 0 else b''

    if   msg_type == 1:   _handle_set_weights(payload)
    elif msg_type == 2:   _handle_infer_movement(payload)
    elif msg_type == 3:   _handle_infer_production(payload)
    elif msg_type == 4:   _handle_set_base(payload)
    elif msg_type == 255:
        sys.stderr.write('[moe_mps_server] exit\n')
        sys.stderr.flush()
        sys.exit(0)
    else:
        sys.stderr.write(f'[moe_mps_server] unknown msg_type={msg_type}\n')
        sys.stderr.flush()
