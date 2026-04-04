import os
import socket
import struct
import json
import time
import numpy as np
try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    print("WARNING: PyTorch not found. Running with NumPy mock only.")

UDS_PATH = os.environ.get("UDS_PATH", "/tmp/ai_training.sock")

# 14 channels (as defined in tensorUtils.ts)
CHANNELS = 14

if HAS_TORCH:
    class MockExpert(nn.Module):
        def __init__(self, channels=CHANNELS):
            super().__init__()
            self.conv = nn.Sequential(
                nn.Conv2d(channels, 32, kernel_size=3, padding=1, padding_mode='circular'),
                nn.ReLU(),
                nn.Conv2d(32, 16, kernel_size=3, padding=1, padding_mode='circular'),
                nn.ReLU(),
                nn.Flatten(),
            )
            self.fc = nn.LazyLinear(8) # 8 Action types max

        def forward(self, x):
            # Input: [Batch, Channels, Height, Width]
            return self.fc(self.conv(x))


# Global ONNX session for inference
onnx_session = None

def start_server():
    global onnx_session

    # Load ONNX model if specified
    onnx_model_path = os.environ.get("NN_MODEL_PATH")
    if onnx_model_path:
        try:
            import onnxruntime as ort
            onnx_session = ort.InferenceSession(onnx_model_path)
            print(f"Loaded ONNX model: {onnx_model_path}")
        except Exception as e:
            print(f"Failed to load ONNX model: {e}")
            onnx_session = None

    if os.path.exists(UDS_PATH):
        os.remove(UDS_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(UDS_PATH)
    server.listen(1)

    print(f"PyTorch IPC Skeleton listening on {UDS_PATH}")

    if HAS_TORCH and onnx_session is None:
        model = MockExpert()
        # Ensure lazy init triggers
        dummy_input = torch.zeros(1, CHANNELS, 10, 30)
        model(dummy_input)
    else:
        model = None

    try:
        while True:
            conn, addr = server.accept()
            print("Node.js client connected! Starting benchmark...")
            handle_client(conn, model if HAS_TORCH else None)
    except KeyboardInterrupt:
        print("Shutting down...")
    finally:
        server.close()
        if os.path.exists(UDS_PATH):
            os.remove(UDS_PATH)

def handle_client(conn, model):
    turns = 0
    start_time = time.time()
    
    try:
        while True:
            # Read 4-byte length prefix (UInt32 LE)
            header = conn.recv(4)
            if not header:
                break
            
            byte_len = struct.unpack('<I', header)[0]
            
            # Read the tensor payload
            payload = bytearray()
            while len(payload) < byte_len:
                chunk = conn.recv(min(4096, byte_len - len(payload)))
                if not chunk:
                    break
                payload.extend(chunk)
                
            if len(payload) != byte_len:
                print("Incomplete payload read. Disconnecting.")
                break

            # Convert binary Float32Array to numpy array
            tensor_np = np.frombuffer(payload, dtype=np.float32)
            
            # Reshape based on length: total_elements = C * H * W
            shape_c = CHANNELS
            hw = len(tensor_np) // shape_c
            
            # Assuming typical tiny map is 30x10, so H=10, W=30 => 300
            # We dynamically deduce H and W if possible since H*W = hw
            # For this mock let's just assume we don't care about exact H/W to 
            # run the forward pass, we can compute it if needed.
            
            if onnx_session is not None:
            # Run ONNX model inference
            input_name = onnx_session.get_inputs()[0].name

            # Reshape tensor: flat -> [1, 14, H+2, W]
            # Need to deduce H and W from tensor length
            # tensor length = 14 * (H+2) * W
            total = len(tensor_np)
            # Try common map sizes
            inferred_shape = None
            for h in range(10, 30):
                for w in range(20, 80):
                    if 14 * h * w == total:
                        inferred_shape = (1, 14, h, w)
                        break
                if inferred_shape:
                    break

            if inferred_shape:
                tensor_torch = torch.from_numpy(tensor_np).view(inferred_shape)
                input_tensor = {input_name: tensor_torch.numpy()}
                outputs = onnx_session.run(None, input_tensor)

                # Extract action type (first output, argmax)
                action_probs = outputs[0].flatten()
                action_idx = int(np.argmax(action_probs))

                # Map action index to action type
                action_types = ['END_TURN', 'SET_PRODUCTION', 'MOVE', 'LOAD', 'UNLOAD', 'SLEEP', 'WAKE', 'SKIP', 'DISBAND']
                action_type = action_types[min(action_idx, len(action_types) - 1)]

                # Build action response
                if action_type == 'MOVE':
                    # Extract target tile from second output
                    tile_probs = outputs[1].flatten()
                    tile_idx = int(np.argmax(tile_probs))
                    action = {
                        'type': action_type,
                        'unitId': 'unit_0',  # Placeholder - would need unit tracking
                        'to': {'x': tile_idx % 30, 'y': tile_idx // 30}
                    }
                elif action_type == 'SET_PRODUCTION':
                    # Extract production type from third output
                    prod_probs = outputs[2].flatten()
                    prod_idx = int(np.argmax(prod_probs))
                    unit_types = ['army', 'fighter', 'bomber', 'transport', 'destroyer', 'submarine', 'carrier', 'battleship']
                    action = {
                        'type': action_type,
                        'cityId': 'city_0',  # Placeholder
                        'unitType': unit_types[min(prod_idx, len(unit_types) - 1)]
                    }
                else:
                    action = {'type': action_type}
            else:
                action = {'type': 'END_TURN'}  # Fallback

        elif HAS_TORCH and model is not None:
            # Mock forward pass just to burn some GPU/CPU cycles
            # tensor_torch = torch.from_numpy(tensor_np).view(1, shape_c, 10, 30)
            # print(model(tensor_torch))
            action = {'type': 'END_TURN'}
        else:
            action = {'type': 'END_TURN'}

            turns += 1

            # Send action response
            resp = json.dumps(action) + "\n"
            conn.sendall(resp.encode('utf-8'))
            
            # Print stats periodically
            if turns % 10 == 0:
                elapsed = time.time() - start_time
                tps = turns / elapsed
                print(f"[{turns} turns] Throughput: {tps:.2f} turns/sec")
                
    except ConnectionResetError:
        pass
    except Exception as e:
        print(f"Client disconnected with error: {e}")
        
    print("Session ended.")

if __name__ == "__main__":
    start_server()
