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

def start_server():
    if os.path.exists(UDS_PATH):
        os.remove(UDS_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(UDS_PATH)
    server.listen(1)
    
    print(f"PyTorch IPC Skeleton listening on {UDS_PATH}")
    
    if HAS_TORCH:
        model = MockExpert()
        # Ensure lazy init triggers
        dummy_input = torch.zeros(1, CHANNELS, 10, 30)
        model(dummy_input)

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
            
            if HAS_TORCH:
                # Mock forward pass just to burn some GPU/CPU cycles
                # tensor_torch = torch.from_numpy(tensor_np).view(1, shape_c, 10, 30)
                # print(model(tensor_torch))
                pass

            turns += 1

            # Send a fast default action just to benchmark the roundtrip
            # We send END_TURN right now just to let the game engine loop quickly
            resp = json.dumps({"type": "END_TURN"}) + "\n"
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
