# Cobot Perception Stack

A production ROS2 Humble perception and control stack for a collaborative robot arm
running on NVIDIA Jetson AGX Orin 64GB.

## Hardware

| Component | Model | Notes |
|-----------|-------|-------|
| Compute | NVIDIA Jetson AGX Orin 64GB | Primary compute platform |
| LiDAR | Ouster OS1-32 | ~20Hz point cloud |
| Camera Front-Left | Intel RealSense D435i | RGB + depth |
| Camera Front-Right | Intel RealSense D435i | RGB + depth |
| Robot Arm | UR5e (configurable) | MoveIt2 via ros2_control |

## Quick Start

### Docker
```bash
cd ~/cobot_ws
docker compose -f docker/docker-compose.yml up
```

### Native
```bash
cd ~/cobot_ws
source /opt/ros/humble/setup.bash
source scripts/aliases.sh
rosdep install --from-paths src --ignore-src -r -y
cb
cbs
launch
```

## Architecture
See [CLAUDE.md](CLAUDE.md) for full architecture documentation.

## Editions (basic + full)

The dashboard ships as a single codebase with two editions selected by a
feature-map switch: **basic** (operator tablet — Monitor, Program Library,
Wizard, Demonstration, Speed, Corner smoothing) and **full** (our PC —
adds Deep Editor, 3D View, Cameras & LiDAR, Part Recognition, I/O Panel,
Event Log, Configure). E-STOP, safety interlocks, delete integrity, and
codegen behaviour are edition-independent and cannot be gated.

Repo rules (non-negotiable):
- **ONE repo, ONE branch flow.** No edition branches, ever.
- **Releases are TAGS**: `vX.Y-basic` and `vX.Y-full` cut from the SAME
  commit. Both editions ship whatever's on that commit; the runtime
  edition flag decides which surfaces render.
- **Feature map is the single source of truth**:
  - Backend: `src/cobot_dashboard/cobot_dashboard/edition.py`
  - Frontend mirror: `src/cobot_dashboard/frontend/src/lib/edition.js`
  - Drift caught by `src/cobot_dashboard/test/test_edition_matrix.py`.
- **Safety-invariant keys** (`estop`, `safety_interlocks`,
  `delete_integrity`, `codegen`, `refusal_gates`) MUST NOT appear as
  feature keys. Both edition modules reject them at import time.
- Per-device edition persists in `/opt/cobot/dashboard_editions.json`
  and is unlocked via the StatusBar affordance (passphrase from
  `COBOT_EDITION_UNLOCK_PASS`, default `full-please`).

## Packages

| Package | Type | Role |
|---------|------|------|
| `perception_fusion` | Python | LiDAR + RGBD sensor fusion |
| `object_detection` | Python | YOLOv8 3D object detection |
| `occupancy_map` | C++ | nvblox occupancy mapping |
| `human_safety` | Python | Skeleton detection + proximity |
| `scene_graph` | Python | Kalman-filtered object tracker |
| `language_interface` | Python | LLM natural language commands |
| `task_planner` | Python | Pick-and-place state machine |
| `safety_monitor` | Python | ISO 10218 speed-separation monitor |
| `fleet_agent` | Python | Logging, OTA updates, cloud sync |
| `cobot_bringup` | CMake | Launch files, URDF, config |
| `cobot_dashboard` | Python | FastAPI + WebSocket live dashboard |
