# Cobot Perception Stack — Architecture

## System Overview

ROS2 Humble stack running on NVIDIA Jetson AGX Orin 64GB. The system performs
real-time sensor fusion, 3D object detection, human safety monitoring, and
natural-language-driven pick-and-place task execution.

## Node Graph

```
Sensors (LiDAR, 2x RGBD)
  │
  ▼
perception_fusion/sensor_fusion_node     → /perception/fused_cloud
  │
  ├──▶ object_detection/detector_node    → /perception/detections
  │         │
  │         ▼
  │    scene_graph/scene_graph_node      → /perception/scene_graph
  │
  └──▶ occupancy_map/occupancy_map_node  → /map/occupancy

Cameras (RGB only)
  │
  ▼
human_safety/human_safety_node           → /safety/human_proximity
                                         → /safety/zone
                                         → /safety/skeleton_markers

/safety/human_proximity + /safety/zone
  │
  ▼
safety_monitor/safety_monitor_node       → /safety/speed_scale
                                         → /safety/estop
                                         → /safety/status

language_interface/language_node         → /task/command
  (Ollama llama3.1:8b, fully offline)

/perception/scene_graph + /task/command + /safety/*
  │
  ▼
task_planner/task_planner_node           → /task/target_pose (→ MoveIt2)
                                         → /task/state
                                         → /task/status

/task/status + /safety/status + /perception/scene_graph
  │
  ▼
fleet_agent/experience_logger_node       → /opt/cobot/logs/*.jsonl
fleet_agent/upload_agent_node            → cloud upload (2am, if enabled)
fleet_agent/update_agent_node            → OTA model refresh (if enabled)

All topics → cobot_dashboard/dashboard_server  (http://host:8080)
```

## Safety Architecture (ISO 10218)

```
Distance    Zone     Speed Scale    ESTOP
> 1.2 m   GREEN       100%          off
0.6–1.2 m YELLOW       25%          off
< 0.3 m   RED           0%          on  (latched)
timeout   —             0%          on  (watchdog)
startup   —             0%          on  (3s warmup)
```

Latch reset: requires zone=GREEN + service call `/safety/reset_estop`.

## Key Parameters

| Package | Config File | Key Parameters |
|---------|-------------|----------------|
| perception_fusion | config/perception.yaml | voxel_size, max_range |
| object_detection | config/detection.yaml | model_path, confidence_threshold |
| human_safety | config/safety.yaml | zone_*_m, no_detection_safe_distance |
| safety_monitor | config/safety.yaml | watchdog_timeout_s, estop_latch |
| task_planner | config/task_planner.yaml | home_position, pick_height_offset_m |
| language_interface | config/language.yaml | ollama_host, model_name |
| fleet_agent | fleet_agent/config/fleet.yaml | enabled, upload_hour |

## Third-party Dependencies

| Library | Package | Use |
|---------|---------|-----|
| open3d | perception_fusion | Voxel downsampling |
| ultralytics | object_detection | YOLOv8 inference |
| mediapipe | human_safety | Skeleton detection |
| filterpy | scene_graph | Kalman filtering |
| fastapi + uvicorn | cobot_dashboard | Web dashboard |
| Ollama (external) | language_interface | LLM inference (llama3.1:8b) |

## Development Branches

| Branch | Owner | Scope |
|--------|-------|-------|
| feature/perception-person1 | Person 1 | perception_fusion, object_detection |
| feature/safety-person2 | Person 2 | human_safety, scene_graph, safety_monitor |
| feature/robot-person3 | Person 3 | task_planner, language_interface, fleet_agent, bringup |

## Dashboard v3 — WORKING

URL: http://192.168.1.246:8080
Theme: white/light, Standard Bots layout — NO 3D arm viewer
Start server:  `python3 src/cobot_dashboard/cobot_dashboard/dashboard_server.py`
Start cameras: `ros2 launch cobot_bringup cameras.launch.py`
Start LiDAR:   `python3 src/cobot_bringup/scripts/ouster_bridge.py`
Build frontend: `cd src/cobot_dashboard/frontend && npm run build` (outputs to `frontend/dist/`)

Camera topics: /cam0/cam0/color/image_raw, /cam1/cam1/color/image_raw (serials 134322070161, 101622073355)
LiDAR:   Ouster at 192.168.1.150 UDP 56201 → bridge at src/cobot_bringup/scripts/ouster_bridge.py
eth0 must be 192.168.1.200/24 — set automatically by ouster_bridge.py
cv2 BROKEN — Pillow used for all image encoding (numpy for array ops)
Removed: 3D arm viewer (ArmViewer3D), dark theme, broken store imports

Frontend layout (MonitorLayout):
  Left 50%: dual camera feeds (CameraPanel cam=0, CameraPanel cam=1) with SVG detection overlay
  Middle 30%: LiDAR 2D canvas top-down view with safety rings
  Right 20%: ProgramPanel drag-drop builder with voice bar
  Bottom: ControlStrip (RunControl | JointPositions | DetectedObjects)

Store actions added: runProgram, pauseProgram, resumeProgram, cancelProgram,
  openGripper, closeGripper, sendVoice, enableJog (30s auto-disable), reorderSteps

## Dashboard v2 — Commercial Features (superseded by v3)

URL: http://192.168.1.246:8080
Start: `cd /home/teddy/cobot_ws && python3 src/cobot_dashboard/cobot_dashboard/dashboard_server.py`
Build: `cd src/cobot_dashboard/frontend && npm run build` (outputs to `frontend/dist/`)

Works without ROS2 (simulation mode — oscillating joints, safety zone cycling).

### Working endpoints
```
POST /cmd/estop          — trigger / release with zone check (body: {active:bool})
POST /cmd/task           — run/pause/resume/home/cancel (body: {command:str})
POST /cmd/home           — alias for /cmd/task {command:"home"}
POST /cmd/resume         — alias for /cmd/estop {active:false}
POST /cmd/jog            — single joint jog (body: {joint:0-5, delta:rad})
POST /cmd/joints         — set all 6 joints at once (body: {positions:[6]})
POST /cmd/gripper        — open/close/width (body: {action:str, width_mm?:float})
POST /cmd/voice          — NLP command parsing (body: {text:str})
POST /cmd/speed_override — 0-100% speed scaling (body: {percent:int})
POST /cmd/teach_point    — save named point to disk
POST /cmd/go_to_point    — move to saved point
POST /cmd/pick           — pick detected object
POST /cmd/clear_error    — clear robot fault
POST /cmd/program/save   — save named program to disk
POST /cmd/program/load/{name}
POST /cmd/program/add|remove|reorder
GET  /api/state          — full state snapshot
GET  /api/log            — audit trail (last 500 events)
GET  /api/saved_points   — all teach points
GET  /api/programs       — saved program list
GET  /stream/cam0        — MJPEG camera stream
GET  /stream/cam1        — MJPEG camera stream
GET  /stream/annotated   — MJPEG annotated detection overlay from detector_node
WS   /ws/state           — 25 Hz state broadcast (nested JSON)
WS   /ws/lidar           — 10 Hz pointcloud (real if /lidar/points live, else sim)
```

### Saved data
- Teach points: `/opt/cobot/calibration/saved_points.json`
- Programs: `/opt/cobot/programs/*.json`
- Audit log: in-memory, 500 events, export via Configure → Log tab

### Frontend components
- `SafetyBanner` — zone/estop strip below header
- `ControlStrip` — speed override slider, TCP position, gripper, joint bars + torque bars
- `ProgramPanel` — program builder with save/load/run
- `FaultPanel`   — floating fault/estop overlay
- `ConfigureLayout` — modal with Status / Safety / Audit Log tabs
- `ArmViewer3D`  — R3F arm with correct J4/J6 rotation.y kinematics (not used in current layout)

### Perception stack

| Node | Launch | Notes |
|------|--------|-------|
| detector_node | `python3 src/object_detection/object_detection/detector_node.py` | YOLOv8n CUDA, cv2 stub required, ~5fps on Jetson |
| ouster_bridge | `python3 src/cobot_bringup/scripts/ouster_bridge.py [port]` | UDP 56201, auto-detects beam/header format |

**cv2 is broken on this Jetson** — all image code uses Pillow + numpy only.
**onnxruntime crashes** — use TRT engine or ultralytics .pt via cv2 stub.
**pycuda broken** — use `torch` for CUDA ops.
**Isaac ROS requires JetPack 6** — DO NOT install on this JetPack 5.1.2 system.

Detection JSON format (`/perception/detections`):
```json
{"detections": [{"id": int, "class_id": int, "class_name": str, "score": float,
  "bbox_px": [x1,y1,x2,y2], "depth_m": float, "pos_3d": [x,y,z],
  "distance_m": float, "pickable": bool, "timestamp": float}]}
```

## Quick Commands

```bash
source scripts/aliases.sh
cb                   # colcon build --symlink-install
cbp <pkg>            # build single package
cbs                  # source install/setup.bash
launch               # ros2 launch cobot_bringup full_stack.launch.py

# Safety test
ros2 topic pub /safety/human_proximity std_msgs/Float32 "data: 2.0"
ros2 service call /safety/reset_estop std_srvs/srv/Trigger

# Language test
bash scripts/test_language.sh
```
