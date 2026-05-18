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
