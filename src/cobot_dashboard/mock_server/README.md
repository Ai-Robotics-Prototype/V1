# RoboAi Mock Server

Standalone FastAPI server that simulates all robot data streams.
No ROS2 or hardware required.

## Install

```bash
cd mock_server
pip install -r requirements.txt
```

## Run

```bash
python3 server.py
```

Server starts on **http://localhost:8080**

## Endpoints

| Endpoint | Description |
|---|---|
| `WS /ws/state` | Robot state at 25 Hz (safety, joints, task, detections) |
| `WS /ws/lidar` | Point cloud at 10 Hz (3500 points) |
| `GET /stream/cam0` | MJPEG stream, 15 fps |
| `GET /stream/cam1` | MJPEG stream, 15 fps |
| `POST /cmd/estop` | `{"active": true\|false}` |
| `POST /cmd/task` | `{"command": "go"\|"pause"\|"home"}` |
| `POST /cmd/voice` | `{"text": "..."}` |
| `POST /cmd/jog` | `{"joint": N, "delta": rad}` |
| `GET /health` | `{"status":"ok","ros":false,"mock":true}` |
| `GET /api/config` | Example robot config |

## Run with frontend dev server

```bash
# Terminal 1 — mock backend
cd mock_server && python3 server.py

# Terminal 2 — Vite dev server (proxies API to :8080)
cd frontend && npm run dev
```

Open http://localhost:5173
