# RoboAi Cobot Stack — Complete Project Reference

Use this document as context when prompting Claude about this project.
Repository: https://github.com/Ai-Robotics-Prototype/V1
Working directory on dev machine: ~/cobot_ws/
Working directory on Jetson: ~/cobot_ws/ (same structure)

---

## Hardware Target

| Component | Spec |
|---|---|
| Compute | NVIDIA Jetson AGX Orin 64 GB |
| OS | Ubuntu 22.04 + JetPack 6 (L4T r36.2.0) |
| GPU | Ampere SM87, 2048 CUDA cores |
| Robot arm | Chinese cobot — brand TBD (xArm / JAKA / Dobot / generic TCP/IP) |
| Cameras | 2× Intel RealSense D435i (cam0, cam1) |
| LiDAR | 1× 3D LiDAR → /lidar/points (PointCloud2) |
| Gripper | TCP/IP — DH-Robotics, Robotiq 2F, or fake/sim |
| Dev machine | Windows 11 + WSL2 Ubuntu 22.04 (no ROS2 installed) |

---

## ROS2 Stack

- **ROS2 Humble** (ament_python + ament_cmake packages)
- **Build**: `colcon build --symlink-install` with `colcon_defaults.yaml` (Release, SM87)
- **Launch**: `ros2 launch cobot_bringup full_stack.launch.py`
- 14 packages total (see package list below)

---

## Package List

| Package | Type | Role |
|---|---|---|
| `perception_fusion` | Python | Sensor fusion: LiDAR + RGBD → fused point cloud |
| `cuda_pointcloud` | C++/CUDA | GPU point cloud: voxel grid, range filter, normals |
| `object_detection` | Python | YOLOv8 inference: TensorRT → Ultralytics fallback |
| `occupancy_map` | C++ | nvblox 3D reconstruction (TSDF/ESDF/mesh) |
| `human_safety` | Python | mediapipe skeleton detection, proximity zones |
| `safety_monitor` | Python | ISO 10218 safety state machine, estop latch |
| `scene_graph` | Python | Kalman-filtered object tracking, UUID track IDs |
| `language_interface` | Python | Ollama LLM (llama3.1:8b) → task commands |
| `task_planner` | Python | Pick-and-place state machine, no MoveIt2 |
| `robot_driver` | Python | TCP/IP bridge to physical robot arm |
| `gripper_driver` | Python | TCP/IP gripper control |
| `fleet_agent` | Python | Experience logging, OTA updates, cloud upload |
| `cobot_dashboard` | Python | FastAPI WebSocket dashboard server (ROS2 side) |
| `cobot_bringup` | CMake | Launch files, config files, package deps |

---

## Full Topic / Service Map

```
Sensors
  /lidar/points          PointCloud2   → perception_fusion, cuda_pointcloud
  /cam0/color/image_raw  Image         → object_detection, human_safety
  /cam1/color/image_raw  Image         → object_detection, human_safety
  /cam0/depth/image_rect_raw  Image    → occupancy_map
  /cam0/depth/camera_info     CameraInfo → occupancy_map

perception_fusion / cuda_pointcloud
  /perception/fused_cloud  PointCloud2  → occupancy_map

object_detection
  /perception/detections   String (JSON) → scene_graph

scene_graph
  /perception/scene_graph  String (JSON) → task_planner, cobot_dashboard

occupancy_map
  /map/occupancy           OccupancyGrid
  /map/mesh_markers        MarkerArray
  /map/status              String (JSON)

human_safety
  /safety/human_proximity  Float32      → safety_monitor
  /safety/zone             String       → safety_monitor, task_planner
  /safety/skeleton_markers MarkerArray

safety_monitor
  /safety/speed_scale      Float32      → robot_driver_node
  /safety/estop            Bool         → task_planner, robot_driver_node
  /safety/status           String (JSON)
  /safety/reset_estop      Trigger (service)

language_interface
  /task/command            String (JSON) → task_planner
  /language/response       String
  /language/status         String (JSON)
  /language/input          String (subscription)

task_planner
  /task/target_pose        PoseStamped  → robot_driver_node
  /robot/joint_command     JointState   → robot_driver_node
  /task/state              String
  /task/status             String (JSON)
  → calls /gripper/set     SetBool (service)

robot_driver_node
  /joint_states            JointState   (published at 50 Hz)
  /robot/tcp_pose          PoseStamped  (published at 50 Hz)
  /robot/status            String (JSON) — is_moving, error_code, mode
  /robot/enable            SetBool (service)
  /robot/clear_error       Trigger (service)
  /robot/go_home           Trigger (service)
  → TF: base_link → tool0

gripper_node
  /gripper/command         Float32 (0=open, 1=closed)
  /gripper/state           String (JSON)
  /gripper/open            Trigger (service)
  /gripper/close           Trigger (service)
  /gripper/set             SetBool (service)  ← called by task_planner

fleet_agent
  /opt/cobot/logs/*.jsonl  (file output)

cobot_dashboard
  http://host:8080         WebSocket + static frontend
```

---

## Safety Architecture (ISO 10218)

```
Distance       Zone     Speed Scale   ESTOP
> 1.2 m      GREEN       100%          off
0.6–1.2 m    YELLOW       25%          off
< 0.6 m      RED           0%          off
< 0.3 m      RED           0%          on  (latched)
no detection  —            0%          on  (watchdog)
startup       —            0%          on  (3 s warmup)
```

- ESTOP is **latched**: once triggered it stays on until zone returns GREEN
  and `/safety/reset_estop` (Trigger service) is called explicitly.
- `task_planner` pauses (does not abort) on YELLOW zone.
- `robot_driver_node` calls `adapter.estop()` immediately on ESTOP signal.

---

## Robot Driver System (TCP/IP, no ROS2 on robot)

### Brand Adapters (`src/robot_driver/robot_driver/adapters/`)

| File | Brand | Protocol |
|---|---|---|
| `xarm_adapter.py` | UFACTORY xArm | xArm Python SDK |
| `jaka_adapter.py` | JAKA | JSON over TCP port 10000 |
| `dobot_adapter.py` | Dobot CR series | Plain-text TCP ports 29999 / 30003 |
| `generic_adapter.py` | Unknown / any | Auto-probe ports, fallback to fake/sim |
| `base_adapter.py` | (abstract) | `RobotState` + `MotionTarget` dataclasses, ABC |

### To configure the brand

Edit `src/cobot_bringup/config/robot_driver.yaml`:
```yaml
robot_driver_node:
  ros__parameters:
    brand: generic       # xarm | jaka | dobot | generic
    robot_ip: "192.168.1.10"
    robot_port: 0        # 0 = auto (brand default)
```

`generic` probes ports `[10000, 29999, 8080, 5000, 8181, 2000]` and tries to
fingerprint JAKA / Dobot / Fairino from response. Falls back to **fake mode**
(simulated motion, no physical movement) if unrecognised.

### robot_driver_node topics
- Subscribes: `/task/target_pose` → `adapter.move_to()` (Cartesian)
- Subscribes: `/robot/joint_command` → `adapter.move_to()` (joint)
- Subscribes: `/safety/speed_scale` → scales all motion
- Subscribes: `/safety/estop` → calls `adapter.estop()` immediately
- Publishes: `/joint_states`, `/robot/tcp_pose`, `/robot/status` at 50 Hz
- Reconnect timer: 5 s interval, thread-safe lock around adapter calls

---

## Gripper Driver (`src/gripper_driver/`)

Configure in `src/cobot_bringup/config/gripper.yaml`:
```yaml
gripper_node:
  ros__parameters:
    brand: fake          # dh | robotiq | xarm | fake
    gripper_ip: "192.168.1.100"
    gripper_port: 0
    open_position: 0.0
    close_position: 1.0
    speed: 0.5
    force: 0.5
```

- `dh` — DH-Robotics AG-95/PGC (Modbus RTU-over-TCP)
- `robotiq` — Robotiq 2F-85/140 (Modbus TCP port 502)
- `fake` — simulated, logs only

---

## Task Planner State Machine

States (in order): `STARTUP → IDLE → SELECT_TARGET → APPROACH → DESCEND → PICK → LIFT → PLACE → RELEASE → HOME → IDLE`

Key parameters (`src/cobot_bringup/config/task_planner.yaml`):
```yaml
task_planner_node:
  ros__parameters:
    home_joints: [0.0, -1.57, 0.0, -1.57, 0.0, 0.0]
    pick_height_offset_m: 0.15
    descend_height_m: 0.02
    lift_height_m: 0.15
    task_timeout_s: 30.0
    motion_settle_s: 2.0
```

Motion is executed by publishing `PoseStamped` to `/task/target_pose` →
`robot_driver_node` → TCP/IP → robot. No MoveIt2 dependency anywhere.

---

## Perception Pipeline

### Python path (CPU fallback)
`perception_fusion/sensor_fusion_node.py`
- ApproximateTimeSynchronizer (slop=0.05 s), TF transform
- Calls `cuda_fusion.py`: CuPy GPU voxel downsample, range filter, normals
- Falls back to NumPy if CuPy unavailable

### GPU path (Jetson)
`cuda_pointcloud` C++/CUDA package
- `voxel_grid.cu` — Morton-key sort + centroid reduction (Thrust)
- `range_filter.cu` — `thrust::copy_if` on 3D norm
- `normal_estimation.cu` — brute-force k-NN (k≤32), covariance PCA
- Pre-allocates 6 device buffers × 500k pts, single CUDA stream
- CUDA architecture: SM87 (Jetson AGX Orin)

### Object detection (`object_detection/`)
- `trt_engine.py` — TensorRT FP16/INT8, `execute_async_v3`, NMS via cv2
- `detector_node.py` — auto-selects: TRT engine → Ultralytics YOLO → retry timer

### 3D map (`occupancy_map/`)
- nvblox integration with `#ifdef NVBLOX_AVAILABLE` guard
- Publishes OccupancyGrid + mesh markers + status JSON
- Config: `src/occupancy_map/config/nvblox.yaml`

---

## Language Interface

- Ollama HTTP POST to `/api/generate` (stream=false)
- Model: `llama3.1:8b` (fully offline, no internet required on Jetson)
- Parses JSON plan from LLM response, publishes to `/task/command`
- Retries every 10 s if Ollama unreachable
- Config: `src/cobot_bringup/config/language.yaml`
  - `ollama_host: "http://localhost:11434"`
  - `model_name: "llama3.1:8b"`

---

## Dashboard

### ROS2 server (`cobot_dashboard/dashboard_server.py`)
- FastAPI + WebSocket, port 8080
- Bridges ROS2 topics to WebSocket clients
- Serves static frontend files

### Mock server (`cobot_dashboard/mock_server/server.py`)
- **Standalone FastAPI — zero ROS2 dependency**
- Identical API/WebSocket/MJPEG interface as ROS2 server
- Run: `python3 server.py` (port 8080)

Endpoints:

| Endpoint | Description |
|---|---|
| `WS /ws/state` | 25 Hz — safety, joints, task, detections, scene_graph |
| `WS /ws/lidar` | 10 Hz — 3500-point cloud JSON |
| `GET /stream/cam0` | MJPEG 15 fps |
| `GET /stream/cam1` | MJPEG 15 fps |
| `POST /cmd/estop` | `{"active": true\|false}` |
| `POST /cmd/task` | `{"command": "go"\|"pause"\|"home"}` |
| `POST /cmd/voice` | `{"text": "..."}` |
| `POST /cmd/jog` | `{"joint": N, "delta": rad}` |
| `GET /health` | `{"status":"ok","ros":false,"mock":true}` |
| `GET /api/config` | Robot config values |

### WebSocket state message schema (25 Hz)
```json
{
  "t": 1234567890123,
  "safety": { "zone": "GREEN", "speed_scale": 1.0, "estop": false, "human_proximity": 1.8 },
  "joints": { "names": ["shoulder_pan",...], "positions": [...], "velocities": [...] },
  "task":   { "state": "IDLE", "target": null },
  "detections": [ {"id":1,"class_name":"bottle","score":0.94,"x":0.4,"y":0.2,"z":0.8,"w":0.08,"l":0.08,"h":0.22} ],
  "scene_graph": { "objects": [ {"id":"obj_001","class":"bottle","pos":[0.4,0.2,0.8],"last_seen_ms":120,"confidence":0.94} ] }
}
```

### Frontend (`cobot_dashboard/frontend/`)
- React 18 + Vite, Three.js, Zustand, framer-motion
- Build: `npm run build` → `dist/` served by mock server or ROS2 server

Components:
| Component | Description |
|---|---|
| `SafetyBanner` | Full-width zone-coloured band, estop pulse, inline release confirm |
| `TopBar` | Brand, view tabs (Camera/LiDAR/Split/Scene), mode toggle, latency chip |
| `EStopButton` | Fixed 80px circle, hold-to-release arc |
| `CameraPanel` | MJPEG `<img>` + SVG bbox overlay (pinhole projection fx=fy=615) |
| `LidarPanel` | Three.js point cloud, height-coloured, safety zone rings, orbit controls |
| `DetectionsPanel` | Sorted by distance, score bars, slide-in animation |
| `SceneGraphPanel` | Object table with age highlighting |
| `RobotControls` | GO/PAUSE/HOME (operator) + joint grid + jog panel (engineer mode) |

Store: Zustand with localStorage persistence for `mode` and `activeView`.
WS reconnect: exponential backoff 1 s → 2 s → 4 s → 8 s → 10 s cap.

Design tokens:
```css
--bg-app: #0A0A0B    --bg-panel: #141416   --bg-surface: #1C1C1F
--accent: #2F7FFF    --zone-green: #00C47A  --zone-yellow: #F5A623
--zone-red: #FF3B3B  --zone-estop: #FF0033
```

---

## GPU / NVIDIA Acceleration

| Layer | Technology | Where |
|---|---|---|
| Point cloud fusion | CuPy (Python) | `perception_fusion/cuda_fusion.py` |
| Point cloud fusion | CUDA C++ kernels | `cuda_pointcloud/src/` |
| Object detection | TensorRT FP16/INT8 | `object_detection/trt_engine.py` |
| 3D reconstruction | Isaac ROS nvblox | `occupancy_map/` |
| Visual SLAM | Isaac ROS cuVSLAM | `cobot_bringup/launch/isaac_ros_full.launch.py` |
| Docker base | L4T r36.2.0 + JetPack 6 | `docker/Dockerfile` |

Export YOLOv8 to TensorRT:
```bash
python3 scripts/export_trt.py --model yolov8n.pt --fp16 --imgsz 640
```

---

## Fleet Agent

- `experience_logger_node.py` — logs all topic data to `/opt/cobot/logs/*.jsonl`
- `upload_agent_node.py` — uploads logs to cloud at 2 AM (if enabled)
- `update_agent_node.py` — OTA model refresh (if enabled)
- Config: `src/fleet_agent/config/fleet.yaml`

---

## File Structure

```
cobot_ws/
├── colcon_defaults.yaml          # symlink-install, Release, SM87
├── CLAUDE.md                     # architecture reference (short)
├── PROJECT.md                    # this file (full reference)
├── scripts/
│   ├── export_trt.py             # YOLOv8 → TensorRT export + benchmark
│   ├── install_isaac_ros.sh      # Isaac ROS apt packages + pip deps
│   ├── benchmark_perception.sh   # topic Hz + GPU stats
│   └── aliases.sh                # cb, cbp, cbs, launch shortcuts
├── docker/
│   ├── Dockerfile                # L4T r36.2.0 + ROS2 Humble + all deps
│   ├── docker-compose.yml        # nvidia runtime, host network, privileged
│   └── entrypoint.sh
└── src/
    ├── cobot_bringup/
    │   ├── launch/
    │   │   ├── full_stack.launch.py        # all nodes, CPU perception
    │   │   ├── isaac_ros_full.launch.py    # GPU path + nvblox + SLAM
    │   │   ├── perception_only.launch.py
    │   │   └── safety_test.launch.py
    │   └── config/
    │       ├── perception.yaml
    │       ├── detection.yaml
    │       ├── safety.yaml
    │       ├── task_planner.yaml
    │       ├── language.yaml
    │       ├── robot_driver.yaml           # ← set brand + IP here
    │       └── gripper.yaml               # ← set gripper brand here
    ├── perception_fusion/
    │   └── perception_fusion/
    │       ├── sensor_fusion_node.py
    │       └── cuda_fusion.py             # CuPy GPU fusion
    ├── cuda_pointcloud/                   # C++/CUDA package
    │   ├── include/cuda_pointcloud/cuda_pointcloud.hpp
    │   └── src/
    │       ├── cuda_pointcloud_node.cpp
    │       ├── voxel_grid.cu
    │       ├── range_filter.cu
    │       ├── cloud_concat.cu
    │       └── normal_estimation.cu
    ├── object_detection/
    │   └── object_detection/
    │       ├── detector_node.py
    │       └── trt_engine.py
    ├── occupancy_map/                     # C++ + nvblox
    │   ├── src/occupancy_map_node.cpp
    │   ├── config/nvblox.yaml
    │   └── launch/nvblox.launch.py
    ├── human_safety/
    │   └── human_safety/human_safety_node.py   # mediapipe skeleton
    ├── safety_monitor/
    │   └── safety_monitor/safety_monitor_node.py
    ├── scene_graph/
    │   └── scene_graph/scene_graph_node.py     # filterpy Kalman tracking
    ├── language_interface/
    │   └── language_interface/language_node.py # Ollama llama3.1:8b
    ├── task_planner/
    │   └── task_planner/task_planner_node.py   # no MoveIt2
    ├── robot_driver/
    │   ├── robot_driver/
    │   │   ├── robot_driver_node.py
    │   │   └── adapters/
    │   │       ├── base_adapter.py
    │   │       ├── xarm_adapter.py
    │   │       ├── jaka_adapter.py
    │   │       ├── dobot_adapter.py
    │   │       └── generic_adapter.py     # auto-probe + fake fallback
    │   └── config/robot_driver.yaml
    ├── gripper_driver/
    │   ├── gripper_driver/gripper_node.py # DH / Robotiq / fake
    │   └── config/gripper.yaml
    ├── fleet_agent/
    │   ├── fleet_agent/
    │   │   ├── experience_logger_node.py
    │   │   ├── upload_agent_node.py
    │   │   └── update_agent_node.py
    │   └── config/fleet.yaml
    └── cobot_dashboard/
        ├── cobot_dashboard/dashboard_server.py  # ROS2 WebSocket bridge
        ├── mock_server/
        │   ├── server.py                        # standalone mock (no ROS2)
        │   └── requirements.txt
        └── frontend/                            # React PWA
            ├── package.json
            ├── vite.config.js
            └── src/
                ├── App.jsx
                ├── store.js                     # Zustand
                ├── global.css
                └── components/
                    ├── SafetyBanner.jsx
                    ├── TopBar.jsx
                    ├── EStopButton.jsx
                    ├── CameraPanel.jsx
                    ├── LidarPanel.jsx
                    ├── DetectionsPanel.jsx
                    ├── SceneGraphPanel.jsx
                    └── RobotControls.jsx
```

---

## How to Run

### Development (Windows WSL, no ROS2)

```bash
# Mock backend
cd ~/cobot_ws/src/cobot_dashboard/mock_server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 server.py
# Open browser: http://<WSL-IP>:8080
# Get WSL IP: hostname -I | awk '{print $1}'

# Frontend dev server (optional, hot reload)
cd ~/cobot_ws/src/cobot_dashboard/frontend
npm run dev
# Open browser: http://<WSL-IP>:5173
```

### Production (Jetson AGX Orin)

```bash
# Build
source /opt/ros/humble/setup.bash
cd ~/cobot_ws
colcon build --symlink-install
source install/setup.bash

# Launch full stack (CPU perception path)
ros2 launch cobot_bringup full_stack.launch.py robot_brand:=generic robot_ip:=192.168.1.10

# Launch with GPU acceleration (Isaac ROS installed)
ros2 launch cobot_bringup isaac_ros_full.launch.py

# Launch perception only (no robot)
ros2 launch cobot_bringup perception_only.launch.py
```

### Docker (Jetson)

```bash
cd ~/cobot_ws/docker
docker compose up
```

---

## Key Configuration Files

| File | What to change |
|---|---|
| `cobot_bringup/config/robot_driver.yaml` | `brand`, `robot_ip` — set when robot arrives |
| `cobot_bringup/config/gripper.yaml` | `brand`, `gripper_ip` |
| `cobot_bringup/config/detection.yaml` | `model_path` — path to .engine or .pt file |
| `cobot_bringup/config/safety.yaml` | Zone distances, watchdog timeout |
| `cobot_bringup/config/task_planner.yaml` | Home joints, pick heights |
| `cobot_bringup/config/language.yaml` | Ollama host, model name |
| `fleet_agent/config/fleet.yaml` | Enable/disable cloud upload |

---

## Third-party Dependencies

| Library | Package | Install |
|---|---|---|
| CuPy | perception_fusion | `pip install cupy-cuda12x` |
| Ultralytics | object_detection | `pip install ultralytics` |
| TensorRT | object_detection | JetPack bundled |
| mediapipe | human_safety | `pip install mediapipe` |
| filterpy | scene_graph | `pip install filterpy` |
| xArm Python SDK | robot_driver | `pip install xArm-Python-SDK` |
| pymodbus | gripper_driver | `pip install pymodbus` |
| FastAPI + uvicorn | cobot_dashboard | `pip install fastapi uvicorn[standard]` |
| Ollama | language_interface | External service, `ollama pull llama3.1:8b` |
| Isaac ROS | occupancy_map, bringup | `bash scripts/install_isaac_ros.sh` |

---

## CI/CD

GitHub Actions: `.github/workflows/build_check.yml`
- Triggers on push/PR to `main`
- ubuntu-22.04 runner, ROS2 Humble
- `colcon build` + `colcon test`

---

## Important Design Decisions

1. **No MoveIt2** — task_planner publishes PoseStamped directly to robot_driver_node. Simpler, no motion planning overhead for pick-and-place.
2. **No ROS2 on robot** — robot_driver uses TCP/IP brand adapters. Changing brand = editing one yaml file.
3. **Generic adapter auto-probe** — if brand is unknown, probes common ports and fingerprints protocol. Falls back to fake/sim mode so the rest of the stack keeps running.
4. **Mock server = identical API** — frontend works against mock server with zero code changes on deploy to Jetson.
5. **GPU optional** — every GPU path has a CPU fallback. Stack runs on any Linux machine for development.
6. **ESTOP is latched** — RED zone or watchdog timeout sets estop. Requires explicit service call + GREEN zone to release. This is intentional for safety.
