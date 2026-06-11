# Cobot Perception Stack — Architecture

## LiDAR object identification

The `lidar_object_identifier` package consumes `/lidar/points_filtered`
and publishes static-object identifications on
`/lidar_objects/identified` at 5 Hz. Pipeline: workspace crop → RANSAC
ground → optional polygon mask → Euclidean clustering → shape
descriptors → parts library match → N-frame persistence. The dashboard
shows live boxes on the 3D View tab, a Monitor card, per-part stats on
the Parts Library cards, and a workspace polygon editor in Configure.
This is separate from any motion / safety LiDAR pipeline; the two coexist
at the topic level. Note: nvblox remains in camera-depth mode by
design — LiDAR mode is blocked by the Livox MID-360's non-repetitive
scan pattern (see `cobot_bringup/config/nvblox.yaml` comment).

## Motion optimization

The `motion_optimization` package (TOPP-RA + smoother + MoveIt2 bridge)
sits in front of the Estun driver. Programs carry a
`motion_profile_name` (Conservative / Balanced / Aggressive / custom);
the program executor scales `/estun/move` speeds against the active
profile and publishes `MotionStatistics` after each cycle. Configure
via the Configure → Motion section in the dashboard, or directly under
`/opt/cobot/motion/`. The MoveIt2 bridge stays inactive until an Estun
URDF lands at `/opt/cobot/models/estun_s10_140.urdf`.


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
| toppra | motion_optimization | Time-optimal trajectory parameterization |
| open3d | lidar_object_identifier | Convex hull + DBSCAN clustering |

## Development Branches

| Branch | Owner | Scope |
|--------|-------|-------|
| feature/perception-person1 | Person 1 | perception_fusion, object_detection |
| feature/safety-person2 | Person 2 | human_safety, scene_graph, safety_monitor |
| feature/robot-person3 | Person 3 | task_planner, language_interface, fleet_agent, bringup |

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

## Current Status — May 2026 (JetPack 6 Fresh Install)

### Complete
- JetPack 6.2.2 flashed (Ubuntu 22.04, CUDA 12.6, L4T R36.5.0)
- ROS2 Humble installed natively (no Docker needed)
- All 14 packages building cleanly (including CUDA C++ kernels)
- Isaac ROS NITROS 3.2.5 installed via apt
- YOLOv8n model at /opt/cobot/models/yolov8n.pt
- Ollama 0.24.0 + Llama 3.1 8B running on :11434
- Whisper base model installed
- Dashboard mock server on :8080 (systemd auto-start: roboai-dashboard.service)
- Frontend built and served: http://localhost:8080
- 3D point cloud viewer operational (react-three-fiber, OrbitControls)
- Camera MJPEG streams with detection overlays (cam0, cam1)
- All dashboard controls working (estop, task, jog, gripper, voice)

### Needs Hardware
- RealSense D435i cameras → /cam0 and /cam1 topics
- Ouster LiDAR → /lidar/points topic
- Robot arm (brand TBD) → configure cobot_bringup/config/robot_driver.yaml
- Extrinsic calibration (cameras + LiDAR)
- Safety zone testing with real human proximity
- First autonomous pick/place run

### Key Commands
```bash
# Dashboard
sudo systemctl start roboai-dashboard   # start
curl http://localhost:8080/health        # verify
journalctl -u roboai-dashboard -f       # logs

# ROS2 workspace
source /opt/ros/humble/setup.bash
source ~/cobot_ws/install/setup.bash
colcon build --symlink-install
ros2 launch cobot_bringup full_stack.launch.py

# Language interface
bash scripts/test_language.sh
```
