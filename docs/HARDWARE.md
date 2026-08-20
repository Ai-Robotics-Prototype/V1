# HARDWARE.md — session constants
> Always loaded. Slow-changing facts about the physical + network setup.
> Update on hardware change; not per-session. STATE.md carries anything
> that shifts inside a session.

## Robot
- **Estun S10-140** (6-DOF articulated), controller firmware **2.3.3.43 exact**.
- URDF: `s10_140_description` (Phase E). J3 and J5 sign flips live in URDF axes
  (Option A, addendum-33 / cri-axis-convention memory); do NOT correct back
  to CAD — the CRI write path is calibrated against these axes.
- Frame mapping (URDF ↔ CRI controller ee_pose):
  `ctrl_X = -URDF_Z`, `ctrl_Y = -URDF_X`, `ctrl_Z = +URDF_Y`.
  Physical "up" is URDF **+Y** for MoveIt Cartesian planning.
- Encoder LSB: 0.343–0.687 mdeg (Phase D characterization).
- Session override: `max_step_rad = 0.002`.

## Network
- **Controller:** `192.168.2.136`
  - `:9000` WebSocket (V1/roboai-estun WS transport — kept STOPPED as
    fallback, not disabled)
  - `:9001` CRI TCP (canonical write path, F1+)
  - UDP `9030` + `10086` (CRI stream)
- **Jetson eno1:** `192.168.2.246` (static)
- **Wi-Fi lease last seen `.143`** (unreserved — DHCP reservation still
  pending, THIRD bite this week; MAC `50:2e:91:95:b6:15` → `.246` reserve
  requested but not landed).
- **Ouster LiDAR:** blocked at physical layer; do NOT add `/24` to eno1
  (SSH hazard — cobot-lidar-status memory).

## Sensors
- 2× RealSense D435i (cam0, cam1). NanoOWL on cam0 (`roboai-nanoowl`,
  L4T PyTorch, ~3–4 FPS, no TRT engine).
- Livox MID-360 LiDAR (non-repetitive scan → nvblox stays camera-depth mode).

## Compute
- NVIDIA Jetson AGX Orin 64GB. JetPack 6.2.2, Ubuntu 22.04, CUDA 12.6,
  L4T R36.5.0. ROS2 Humble native (no Docker). Isaac ROS NITROS 3.2.5.

## Repos
- **V1** (`Ai-Robotics-Prototype/V1`) — dashboard + roboai-* services.
  Working branch: `feature/estun-write-path`. Head: `c995e5d+`.
  **Public → make private + rotate `aicollabs12`-era credentials
  (long-open item, final argument per addendum-36).**
- **CodroidROS2** (`theodoresimpson/CodroidROS2`) — CRI ROS2 stack + MoveIt
  configs. Head: `bd51632+` (private).

## Systemd (all under `/etc/systemd/system/`)
- `roboai-dashboard.service` — FastAPI + WS + static frontend on :8080
- `roboai-detector.service` — TensorRT detector (Ultralytics import broken;
  do not re-add).
- `roboai-executor.service` — Lua/WS program executor (fallback).
- `roboai-estun.service` — WS driver. **STOPPED not disabled** in F1
  sessions; monitor_only emits `/estun/rejected` 2 Hz baseline.
- `roboai-lidar-identifier.service`, `roboai-collision-monitor.service`,
  `roboai-nanoowl.service`, `roboai-pbd*` — see individual service files.
- `roboai-autodeploy.path` → `autodeploy_wrapper.sh` — watches commits,
  fires `scripts/deploy.sh`.

## Safety zones (ISO 10218)
| Distance    | Zone   | Speed | ESTOP |
|-------------|--------|-------|-------|
| > 1.2 m     | GREEN  | 100%  | off   |
| 0.6–1.2 m   | YELLOW | 25%   | off   |
| < 0.3 m     | RED    | 0%    | on (latched) |
| timeout     | —      | 0%    | on (watchdog) |
| startup     | —      | 0%    | on (3 s warmup) |

Latch reset: zone=GREEN + service call `/safety/reset_estop`.
