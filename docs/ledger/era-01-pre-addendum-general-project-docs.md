---
ledger_split: era-01-pre-addendum
source: cobot_project_conversation_v46.md
source_lines: 1-9480 (inclusive)
title: Pre-addendum era — project docs, lessons 1-99 numbered
redactions: |
  Three exposed (already-revoked) `ghp_*` GitHub PAT strings replaced with
  `[REDACTED_GHP_TOKEN_1]` (2 sites) and `[REDACTED_GHP_TOKEN_2]` (1 site)
  so GitHub's secret scanner does not reject the push. The two token
  strings correspond to distinct tokens (both revoked); token 1 is
  restated once in an earlier "GitHub Token Note" section. Consequence:
  the reconstruction test's byte-exact SHA compare against
  `cobot_project_conversation_v46.md` will MISMATCH; see
  `tools/ledger_reconstruction_test.py` docstring.
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# Cobot Perception Stack — Full Project Conversation
**Project**: Collaborative Robot Arm with LiDAR + Depth Camera Perception  
**Platform**: NVIDIA Jetson AGX Orin | ROS2 Humble | Isaac ROS  
**Developer**: Theodore Simpson (@theodoresimpson)
**Company**: NeuRobots Manufacturing  
**Naming note (v23, July 3 2026)**: All historical references to the pre-pivot working name "RoboAi" / "RoboAi Robotics" have been normalized to the final name **NeuRobots Manufacturing** throughout this document per Josh's instruction. The GitHub org (`Ai-Robotics-Prototype`) is unchanged (live repo identifier). Actual git commit messages, systemd service files, and configs on the Jetson may still contain the literal string "RoboAi" — the doc text was normalized; the machine artifacts were not.  
**GitHub Org**: Ai-Robotics-Prototype  
**Active Repo**: V1 (Private)  
**Date Started**: April 2026  
**Last Updated**: July 22 2026 (v36 — Addendum 21: testwizard runs, controller-crash forensics, driver hardening, speed 65%, first actuator, Sections 351–372)

---

## IMPORTANT — SOURCE OF TRUTH
This document is the single source of truth for the NeuRobots cobot project.
All future Claude conversations should reference this document first.
Upload this MD to your Claude project before starting any new conversation.
Claude Code reads CLAUDE.md automatically — keep both in sync.

---

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [Hardware](#2-hardware)
3. [Software Stack Architecture](#3-software-stack-architecture)
4. [ROS2 Package Breakdown](#4-ros2-package-breakdown)
5. [Quick Start](#5-quick-start)
6. [Development Setup](#6-development-setup)
7. [Windows WSL Setup (Step by Step)](#7-windows-wsl-setup-step-by-step)
8. [GitHub Setup](#8-github-setup)
9. [Claude Code Setup](#9-claude-code-setup)
10. [SSH & Remote Development](#10-ssh--remote-development)
11. [How to Develop Such a Large Project](#11-how-to-develop-such-a-large-project)
12. [Claude Code Pricing](#12-claude-code-pricing)
13. [Team Collaboration](#13-team-collaboration)
14. [Team Development Split](#14-team-development-split)
15. [How Components Interface Together](#15-how-components-interface-together)
16. [Cobot Selection Guide](#16-cobot-selection-guide)
17. [ROS2 Explained](#17-ros2-explained)
18. [ROS2 on Any Robot](#18-ros2-on-any-robot)
19. [Natural Language Robot Control](#19-natural-language-robot-control)
20. [Fleet Learning & Continuous Improvement](#20-fleet-learning--continuous-improvement)
21. [Commissioning Checklist](#21-commissioning-checklist)
22. [Key Files Reference](#22-key-files-reference)
23. [Useful Commands](#23-useful-commands)
24. [VS Code & WSL Explained](#24-vs-code--wsl-explained)
25. [GitHub Workflow (Practical)](#25-github-workflow-practical)
26. [Claude Code Token Usage](#26-claude-code-token-usage)
27. [Three-Way Development Workflow](#27-three-way-development-workflow)
28. [Complete Build Prompt for Claude Code](#28-complete-build-prompt-for-claude-code)
29. [Project Status & Key Decisions](#29-project-status--key-decisions)

---

## 1. Project Overview

A production-ready software stack that fuses a 3D LiDAR and two depth cameras, builds a live 3D world model, detects objects and humans, and drives a collaborative robot arm with real-time safety enforcement (ISO 10218 / ISO/TS 15066).

### Goals
- Real-time 3D environment understanding
- Object detection and tracking
- Human presence detection with safety zones
- Autonomous pick-and-place task execution
- Natural language robot control (offline capable)
- Fleet learning — robots get smarter over time
- ISO 10218 safety compliance

---

## 2. Hardware

| Device | Interface | Notes |
|--------|-----------|-------|
| NVIDIA Jetson AGX Orin | — | Host, 64 GB, JetPack 6.x |
| 3D LiDAR (e.g. Ouster OS1-32) | Ethernet | Publishes `sensor_msgs/PointCloud2` |
| Depth Camera 1 (Intel RealSense D435i) | USB3 | Left/front view — `/cam0` |
| Depth Camera 2 (Intel RealSense D435i) | USB3 | Right/rear view — `/cam1` |
| Cobot arm (e.g. UR5e / AUBO i10 / Flexiv Rizon) | EtherCAT/TCP | ROS2-compatible driver |

---

## 3. Software Stack Architecture

```
Hardware
  └─ LiDAR driver · Depth camera driver · Cobot driver
         │ ROS2 DDS topics
Middleware (ROS2 Humble)
         │
Perception
  ├─ perception_fusion   — merges LiDAR + RGBD → unified PointCloud2
  ├─ object_detection    — TensorRT YOLO on GPU → DetectionArray
  ├─ occupancy_map       — 3D OctoMap voxel grid (Isaac ROS nvblox)
  ├─ human_safety        — skeleton tracking + safety zone computation
  └─ scene_graph         — persistent tracked-object registry
         │
Awareness
  ├─ language_interface  — natural language → task plan (local LLM)
  └─ speech_recognition  — Whisper offline voice-to-text
         │
Planning
  ├─ task_planner        — BehaviorTree.cpp reactive task engine
  ├─ motion_planning     — MoveIt2 + OMPL with collision scene
  └─ safety_monitor      — ISO 10218 speed-separation, E-stop publisher
         │
Actuation
  └─ ros2_control        — joint trajectory controller + speed scaling
         │
Fleet
  └─ fleet_agent         — experience logging, OTA updates, data upload
```

### Key ROS2 Topics

| Topic | Type | Publisher | Subscriber |
|-------|------|-----------|------------|
| `/lidar/points` | PointCloud2 | lidar driver | perception_fusion |
| `/cam0/depth/points` | PointCloud2 | realsense | perception_fusion |
| `/perception/fused_cloud` | PointCloud2 | perception_fusion | occupancy_map |
| `/perception/detections` | Detection3DArray | object_detection | scene_graph |
| `/perception/scene_graph` | String (JSON) | scene_graph | task_planner, language_interface |
| `/safety/human_proximity` | Float32 | human_safety | safety_monitor |
| `/safety/speed_scale` | Float32 | safety_monitor | ros2_control |
| `/safety/estop` | Bool | safety_monitor | ros2_control |
| `/safety/zone` | String (JSON) | safety_monitor | task_planner, dashboard |
| `/task/state` | String | task_planner | dashboard |
| `/joint_states` | JointState | robot driver | safety_monitor |

---

## 4. ROS2 Package Breakdown

### `perception_fusion`
Subscribes to `/lidar/points`, `/cam0/depth/points`, `/cam1/depth/points`. Applies extrinsic calibration transforms, voxel-downsamples, and merges into `/perception/fused_cloud` at 15 Hz.

### `object_detection`
Runs a TensorRT-quantised YOLOv8 model (INT8) on the GPU. Publishes `vision_msgs/Detection3DArray` on `/perception/detections`. Includes model download script.

### `occupancy_map`
Wraps Isaac ROS nvblox for GPU-accelerated TSDF/occupancy mapping. Publishes OctoMap and collision scene to MoveIt2. Update rate: 10 Hz. Resolution: 2.5 cm voxels.

### `human_safety`
Runs MediaPipe BlazePose (TensorRT) to detect human skeletons. Computes minimum distance from each skeleton keypoint to robot TCP. Triggers speed scaling via `/safety/human_proximity`.

### `scene_graph`
Maintains a dictionary of tracked objects with poses, classes, and timestamps. Publishes `/perception/scene_graph` as JSON at 10 Hz. Supports object persistence across occlusion using Kalman-filter track IDs.

### `language_interface`
Takes voice or text input, calls local Llama LLM on Jetson GPU, reads scene graph, and outputs structured task plan for task_planner. Fully offline — no internet required.

### `task_planner`
Reads the scene graph and human proximity state. Uses BehaviorTree.cpp v4 to reactively select tasks: IDLE → PICK → PLACE → HOME, with pause/resume on human approach.

### `safety_monitor`
Implements ISO 10218 speed-and-separation monitoring. Three zones (GREEN / YELLOW / RED). Publishes `/safety/speed_scale` [0.0–1.0] and `/safety/estop`.

**ISO 10218 Zone thresholds (configurable):**
| Zone | Distance | Speed |
|------|----------|-------|
| GREEN | > 1.2 m | 100% |
| YELLOW | 0.6–1.2 m | 25% |
| RED | < 0.3 m | 0% (stop) |

### `fleet_agent`
Logs every robot interaction locally, uploads anonymised data to cloud when idle, receives and applies OTA model updates. The data flywheel that makes robots smarter over time.

### `cobot_bringup`
Top-level launch files, parameter files, URDF, and RViz config. `full_stack.launch.py` launches all nodes in correct order.

### `cobot_dashboard`
FastAPI + WebSocket server on port 8080. Live browser dashboard showing pointcloud, detections, safety zones, joint states, and task state.

---

## 5. Quick Start

### Docker (recommended)
```bash
# Build the image (~20 min first time on Jetson)
cd cobot_ws/docker
docker buildx build --platform linux/arm64 -t cobot-stack:latest .

# Run
docker run --rm --runtime=nvidia --privileged --network=host \
  --device=/dev/bus/usb \
  -e RMW_IMPLEMENTATION=rmw_cyclonedds_cpp \
  cobot-stack:latest \
  ros2 launch cobot_bringup full_stack.launch.py

# Open dashboard
# Browse to http://<jetson-ip>:8080
```

### Native Build
```bash
source /opt/ros/humble/setup.bash
cd cobot_ws
rosdep install --from-paths src --ignore-src -r -y
colcon build --symlink-install --cmake-args -DCMAKE_BUILD_TYPE=Release
source install/setup.bash
ros2 launch cobot_bringup full_stack.launch.py
```

---

## 6. Development Setup

### Recommended Architecture
```
Dev Laptop (fast iteration) → Git → Jetson (deploy & test)
```

**Never develop directly on the Jetson from day one.** The Jetson is slow to compile and a bad node can lock up your only robot.

### VS Code + Remote SSH Workflow
```
VS Code → Remote SSH extension → Jetson
                                    └── Claude Code runs here
                                    └── colcon build runs here
                                    └── ROS2 nodes run here
```

### Package Build Order (do sequentially)

**Week 1 — Get hardware talking**
- Driver verification (LiDAR, cameras, robot)
- Static TF tree correct
- Topics publishing at expected rates

**Week 2 — Perception**
- perception_fusion → verify fused cloud in Foxglove
- object_detection → verify detections on known objects
- occupancy_map → verify collision scene in RViz

**Week 3 — Safety + scene understanding**
- human_safety → verify zone transitions manually
- scene_graph → verify tracked objects persist
- safety_monitor → verify speed scaling responds

**Week 4 — Planning + language**
- MoveIt2 with collision scene
- task_planner → test pick/place manually first
- language_interface → test voice commands
- Full autonomous loop

### Folder Structure on Jetson
```
/home/user/
  cobot_ws/          ← ROS2 workspace (git repo)
    src/             ← all packages
    install/         ← never commit
    build/           ← never commit
    log/             ← never commit

/opt/cobot/
  models/            ← TensorRT engines + Llama model (not in git)
  calibration/       ← extrinsics YAML
  logs/              ← runtime logs
  bags/              ← recorded sensor data
```

### .gitignore
```
build/
install/
log/
*.pyc
__pycache__/
*.engine
*.onnx
*.gguf
.claude/
```

### Daily Development Loop
```bash
# 1. Write code on laptop via VS Code Remote SSH
# 2. Build just the changed package
colcon build --packages-select perception_fusion
source install/setup.bash

# 3. Test in isolation
ros2 run perception_fusion sensor_fusion_node

# 4. Visualise in Foxglove on laptop browser
#    http://jetson-ip:8765

# 5. Commit and push
git add -p
git commit -m "fix: TF lookup timeout in sensor fusion"
git push
```

### Record and Replay — Saves huge amounts of time
```bash
# Record real sensor data once
ros2 bag record /lidar/points /cam0/depth/points /cam0/color/image_raw

# Play back infinitely while developing — no hardware needed
ros2 bag play --loop my_recording.bag
```

---

## 7. Windows WSL Setup (Step by Step)

### What is a Terminal?
A terminal is a way to type instructions directly to your computer instead of clicking buttons. Instead of clicking through File Explorer, you type commands like `mkdir my_folder` and they execute instantly. The `$` at the end of a line means it's ready and waiting for you to type.

### Step 1 — Install WSL (Windows Subsystem for Linux)
1. Press **Windows key** → type **PowerShell**
2. Right click → **Run as administrator**
3. Paste and press Enter:
```powershell
wsl --install -d Ubuntu
```
4. Wait for download and restart computer
5. After restart Ubuntu opens asking for username and password
   - Username: something simple like `cobot`
   - Password: pick something you'll remember (nothing shows when you type — that's normal)

### Step 2 — Open Ubuntu in VS Code
1. Open VS Code
2. Click the **Extensions** icon (4 squares on left sidebar)
3. Search **WSL** → install the Microsoft one
4. Press **Ctrl + Shift + P** → type `WSL: Connect to WSL` → Enter
5. Bottom left corner shows **WSL: Ubuntu** in blue/green — you're connected
6. Go to **Terminal** → **New Terminal**

### Step 3 — Update Linux
```bash
sudo apt-get update && sudo apt-get upgrade -y
```
Enter your password when asked. Takes 2–3 minutes.

### Step 4 — Install tools
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git python3 python3-pip curl wget
```

### Step 5 — Install Claude Code
```bash
curl -fsSL https://claude.ai/install.sh | bash
```
Then add it to your PATH:
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```
Verify it works:
```bash
claude --version
```

### Step 6 — Log in to Claude Code
```bash
claude
```
It opens a link in your browser — click it, log in with your Claude account. Done.

### How to upgrade Claude Code
```bash
# Easiest — built in updater
claude update

# Or via npm
npm update -g @anthropic-ai/claude-code

# Full reinstall if update fails
npm uninstall -g @anthropic-ai/claude-code
npm install -g @anthropic-ai/claude-code@latest
```

---

## 8. GitHub Setup

### What is GitHub?
GitHub is like Google Drive for code. It backs up your project, lets the Jetson download it, and lets multiple people work on the same codebase.

### Create a Repo
1. Go to **github.com** → click **+** → **New repository**
2. Name: `cobot_ws`
3. Set to **Private**
4. Don't tick "Add README"
5. Click **Create repository** — leave the page open

### Push Your Code
```bash
cd ~/cobot_ws

# Create .gitignore first
cat > .gitignore << 'EOF'
build/
install/
log/
*.pyc
__pycache__/
*.engine
*.onnx
*.gguf
.claude/
EOF

git init
git add .
git commit -m "Initial cobot perception stack"

# Paste the URL from GitHub
git remote add origin git@github.com:YOUR_USERNAME/cobot_ws.git
git branch -M main
git push -u origin main
```

### Daily Git Workflow
```bash
# Save changes
git add .
git commit -m "describe what you changed"
git push

# Get latest from GitHub (on Jetson)
git pull
cb   # rebuild
```

### Team Branch Workflow
```bash
# Person A — working on perception_fusion
git checkout -b feature/perception-fusion
git push origin feature/perception-fusion
# Create Pull Request on GitHub

# Person B — working on safety_monitor
git checkout -b feature/safety-monitor
git push origin feature/safety-monitor

# Merge to main when tested
git checkout main
git merge feature/perception-fusion
git push
```

### Using GitHub Desktop Instead of Terminal
GitHub Desktop is easier for daily use:
1. Open GitHub Desktop
2. **File** → **Add Local Repository** → browse to `\\wsl$\Ubuntu\home\cobot\cobot_ws`
3. Click **Publish repository** → set Private → Publish
4. Every day: changed files appear automatically → write summary → **Commit to main** → **Push origin**

### View GitHub Code in VS Code
```bash
# Already cloned — just open it
cd ~/cobot_ws
code .

# Fresh clone on new machine
git clone git@github.com:YOUR_USERNAME/cobot_ws.git
cd cobot_ws
code .
```

### Delete a Repository
1. Go to the repo on github.com
2. **Settings** → scroll to bottom → **Danger Zone**
3. Click **Delete this repository**
4. Type the repo name to confirm → Delete

Note: This only removes it from GitHub. Local files in WSL remain untouched.

### Theodore's GitHub Repositories
| Repo | Status | Purpose |
|------|--------|---------|
| Ai-Collaborative-Robot-Prototype | ✅ Active — use this | Main project, updated 1hr ago |
| CollaborativeAi | 🗄️ Old V1 | Superseded |
| desktop-tutorial | 🗑️ Safe to delete | GitHub Desktop test repo |

---

## 9. Claude Code Setup

### What is Claude Code?
Claude Code is an AI coding assistant that lives in your terminal. It reads your entire codebase, edits files, runs builds, fixes errors, and understands your project — all through natural language. You describe what you want and it does it.

### How it connects
Claude Code uses your Pro or Max subscription directly. No separate API key needed — just log in with your claude.ai account.

### Connecting to Droplet or Jetson
```bash
# SSH into your machine
ssh root@your-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash

# Add to PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

# Log in — no API key needed with Pro/Max
claude
```

### The CLAUDE.md file
Place a file called `CLAUDE.md` in your project root. Claude Code reads this automatically every session so it already knows your hardware, topics, package structure, and current status without re-explaining anything.

Example content:
```markdown
# CLAUDE.md
## What this project is
Cobot perception stack on Jetson AGX Orin...

## Hardware
- LiDAR: Ouster OS1-32, IP 192.168.1.100
- Camera 0: RealSense D435i, namespace /cam0
- Camera 1: RealSense D435i, namespace /cam1
- Robot: [YOUR MODEL], IP 192.168.1.200

## Current status
- [ ] Hardware arrived
- [ ] Calibration done
- [x] Workspace building
- [ ] Perception verified
- [ ] Safety zones tested
- [ ] First autonomous run
```

### Useful Claude Code prompts for this project
```
"Build out the perception_fusion package completely —
 add CMakeLists.txt, package.xml, make it colcon buildable,
 then run colcon build and fix any errors"

"The human_safety node is not detecting skeletons —
 read the node and debug it"

"Add the language_interface package using Ollama and Llama 3.1 8B
 to accept voice commands and convert them to task plans"

"Write a Modbus TCP bridge node for a robot at 192.168.1.100
 that publishes /joint_states and accepts trajectory commands"

"Add the fleet_agent package with experience logging
 and OTA model update capability"
```

---

## 10. SSH & Remote Development

### What is SSH?
SSH lets you control the Jetson from your laptop — as if you were sitting in front of it — over your WiFi network. Once set up you never need to plug a monitor into the Jetson again.

### Find Jetson IP
On Jetson (plug monitor in once):
```bash
ip addr show | grep "inet "
# Look for something like 192.168.1.45
```

### Enable SSH on Jetson
```bash
sudo systemctl enable ssh
sudo systemctl start ssh
```

### Connect from Laptop
```bash
ssh nvidia@192.168.1.45
```

### Skip Password Every Time
```bash
ssh-keygen          # press Enter 3 times
ssh-copy-id nvidia@192.168.1.45
```

### SSH Config (add to ~/.ssh/config)
```
Host jetson
    HostName 192.168.1.45
    User nvidia
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60
```
Now just type: `ssh jetson`

### VS Code Remote SSH
1. Install **Remote - SSH** extension
2. Press **Ctrl + Shift + P** → `Remote-SSH: Connect to Host` → `jetson`
3. Open folder → `/home/nvidia/cobot_ws`
4. Press **Ctrl + `** for terminal — now running on Jetson
5. Type `claude` — Claude Code opens in your project

---

## 11. How to Develop Such a Large Project

### The right tool for each phase

| Phase | Tool | Why |
|-------|------|-----|
| Architecture & design | Claude chat (here) | Big picture thinking |
| Implementation | Claude Code | Multi-file editing, build & fix loops |
| Hardware testing | Jetson + Foxglove | Only real hardware can test real sensors |
| Review & collaboration | GitHub | Everyone sees changes |

### Build one package at a time
```bash
# SSH into Jetson
ssh jetson
cd cobot_ws
claude

# Tell it what to build one package at a time:
# "Build out the perception_fusion package completely,
#  add CMakeLists.txt and package.xml, run colcon build,
#  fix any errors until it compiles cleanly"
```

### tmux — Keep sessions alive
```bash
tmux new -s cobot      # start session
Ctrl+B then D          # detach (keeps running)
tmux attach -t cobot   # reattach later
```

### Dev session layout (4 panes)
```
┌─────────────────┬──────────────────┐
│                 │   ROS2 topics    │
│   Claude Code   ├──────────────────┤
│                 │   colcon build   │
├─────────────────┼──────────────────┤
│   ROS2 logs     │   System stats   │
└─────────────────┴──────────────────┘
```

---

## 12. Claude Code Pricing

| Plan | Cost | Best for |
|------|------|----------|
| Pro | $20/mo | ~45 msgs/5hrs — hits limits on large projects |
| Max 5x | $100/mo | ~225 msgs/5hrs — recommended for this project |
| Max 20x | $200/mo | Full-time, multiple agents |

**For this project**: **Max $100/mo** for the lead developer. Pro hits limits mid-session on a 9-package ROS2 stack.

**Why subscription beats API**: One developer used 10 billion tokens over 8 months — API cost would have been $15,000 while Max totalled $800.

**Team setup**: Start with one person on Max $100/mo. Add others when actively coding in parallel. Don't share accounts — violates terms and causes conflicts.

### Token Usage in Practice
Claude Code runs on your Claude subscription — no separate billing or per-token charges.
- **Pro $20/mo** — hits limits mid-session on large projects like this 11-package stack
- **Max $100/mo** — recommended for lead developer on this project
- **`/compact`** — type this in Claude Code between phases to compress context and save tokens
- Build one package at a time to use tokens efficiently
- CLAUDE.md avoids wasting tokens re-explaining architecture every session

---

## 13. Team Collaboration

### For 3 developers — recommended options

**Option 1 — Everyone gets Pro ($20/mo each)**
- $60/month total
- Each has their own login and Claude Code
- All push/pull to the same GitHub repo
- Good starting point

**Option 2 — Claude Team Plan**
- $100/seat Premium
- Company billing, individual logins
- Best when all coding heavily every day

**Option 3 — One Max + others free**
- Lead developer on Max $100/mo
- Partners contribute via GitHub at no cost
- Best while project is in early stages

**Most cost effective path:**
- Now: 1 × Max ($100/mo) — lead developer only
- When building in parallel: 3 × Pro ($60/mo total)
- When all coding full time: Team Plan ($300/mo)

---

## 14. Team Development Split

Split by stack layer — each person owns a complete vertical slice.

### Person 1 — Perception Lead
**Packages:** `perception_fusion` + `object_detection` + `occupancy_map`

```
LiDAR + Camera 0 + Camera 1
         ↓
  perception_fusion     ← merges all sensors
         ↓
  object_detection      ← YOLOv8 TensorRT
         ↓
  occupancy_map         ← nvblox GPU voxel grid
```

**Week 1-2 focus:** Drivers working, fused cloud in Foxglove, detections on known objects, collision scene in RViz.

---

### Person 2 — Safety & Awareness Lead
**Packages:** `human_safety` + `scene_graph` + `safety_monitor`

```
Camera feeds
      ↓
  human_safety      ← skeleton detection, proximity
      ↓
  scene_graph       ← Kalman-filtered object tracker
      ↓
  safety_monitor    ← ISO 10218 enforcement
```

**Week 3 focus:** Zone transitions verified manually, tracked objects persist, speed scaling responds, estop latch tested.

---

### Person 3 — Robot & Infrastructure Lead
**Packages:** `task_planner` + `language_interface` + `cobot_bringup` + `cobot_dashboard` + `fleet_agent`

```
scene_graph + safety_monitor
           ↓
    language_interface  ← voice/text → task plan
           ↓
    task_planner        ← pick/place state machine
           ↓
    cobot_bringup       ← launch files, integration
           ↓
    fleet_agent         ← logging, OTA updates
```

**Week 4 focus:** MoveIt2 working, voice commands working, full autonomous loop, dashboard live.

---

### Week by week plan

| Week | Person 1 | Person 2 | Person 3 |
|------|----------|----------|----------|
| 1 | LiDAR + camera drivers | Learn codebase, safety YAML | Cobot driver, MoveIt2 |
| 2 | perception_fusion + detection | human_safety node | cobot_bringup launch files |
| 3 | occupancy_map + nvblox | scene_graph + safety_monitor | task_planner skeleton |
| 4 | Integration support | Safety zone testing | Language interface + full loop |

---

## 15. How Components Interface Together

### Data flows in one direction

```
SENSORS
  LiDAR ──────────────────────────────► /lidar/points
  Camera 0 ───────────────────────────► /cam0/depth/points
  Camera 1 ───────────────────────────► /cam1/depth/points

PERSON 1 — PERCEPTION
  perception_fusion ──────────────────► /perception/fused_cloud
  object_detection ───────────────────► /perception/detections
  occupancy_map ──────────────────────► /collision_scene → MoveIt2

PERSON 2 — SAFETY
  human_safety ───────────────────────► /safety/human_proximity
                                         /safety/zone
  scene_graph ────────────────────────► /perception/scene_graph
  safety_monitor ─────────────────────► /safety/speed_scale
                                         /safety/estop

PERSON 3 — ROBOT
  language_interface ─────────────────► task commands
  task_planner ───────────────────────► /task/state
  MoveIt2 ────────────────────────────► joint trajectories
  ros2_control ───────────────────────► cobot arm moves

DASHBOARD
  cobot_dashboard ◄── all topics ── browser on port 8080
```

### Testing handoffs without full stack
```bash
# Person 1 records their outputs
ros2 bag record /perception/fused_cloud /perception/detections

# Person 2 develops using Person 1's recording
ros2 bag play --loop person1_output.bag

# Person 2 records their outputs
ros2 bag record /safety/speed_scale /safety/estop /perception/scene_graph

# Person 3 develops task_planner using recorded data
ros2 bag play --loop person2_output.bag
```

### Verify everything is connected
```bash
ros2 topic list                              # all topics present?
ros2 topic hz /perception/fused_cloud       # publishing at 15Hz?
ros2 topic echo /safety/zone                # what zone?
ros2 node info /sensor_fusion               # subscribed correctly?
```

---

## 16. Cobot Selection Guide

### What ROS2 requires from any cobot

| Requirement | Why it matters |
|-------------|----------------|
| Official ROS2 Humble driver | Your stack runs Humble — no driver = weeks of extra work |
| ros2_control interface | Required for MoveIt2 and safety speed scaling |
| /joint_states at 50Hz+ | Safety monitor needs this rate |
| EtherCAT or TCP/IP | Communication to Jetson |
| Joint torque sensing | ISO 10218 power and force limiting |
| Harmonic drives | Accuracy for pick/place |

### Harmonic drives — why they matter
| With Harmonic Drives | Without |
|---------------------|---------|
| Near-zero backlash | Noticeable play in joints |
| ±0.02mm repeatability | Lower repeatability |
| Smooth motion | Jerky movements |
| Accurate joint feedback | Less reliable safety stops |

### Chinese cobot rankings for ROS2 support

| Brand | ROS2 Humble | MoveIt2 | ros2_control | Harmonic Drives | Price |
|-------|-------------|---------|--------------|-----------------|-------|
| Flexiv Rizon | ✅ Official | ✅ Built in | ✅ Full | ✅ All joints | $35k–$60k |
| AUBO i-Series | ✅ Official | ✅ Included | ✅ Full | ✅ Yes | $18k–$35k |
| JAKA | ⚠️ Community | ⚠️ Partial | ⚠️ Limited | ⚠️ Higher models | $15k–$30k |
| ERACobot | ❌ Not found | ❌ Unknown | ❌ Unknown | ✅ Claimed | $6k–$12k |

**Recommendation:**
- Budget conscious: **AUBO i10** — active ROS2 Humble driver, MoveIt2 support
- Best integration: **Flexiv Rizon 4** — cleanest ROS2/MoveIt2/ros2_control of any Chinese cobot

### Questions to send every supplier

```
1. GitHub repo URL for ROS2 Humble driver?
2. Does it include ros2_control hardware interface?
3. Does it include MoveIt2 configuration package?
4. Does it have use_fake_hardware:=true simulation mode?
5. What communication protocol? (EtherCAT / Modbus / proprietary)
6. Maximum command frequency over TCP?
7. Joint torque sensors on all 6 joints?
8. ISO 10218-1 certificate number?
9. Can you demo on video call:
   - ros2 topic hz /joint_states (must show 50Hz+)
   - MoveIt2 planning and executing a motion
   - JointTrajectory command accepted via ros2_control
```

### Red flags
- No GitHub repo / sends PDF instead
- Says "ROS" without specifying ROS2
- Can't do live demo within a week
- GitHub repo last commit over 12 months ago
- No Humble branch — only Foxy or Noetic
- Modbus only, no EtherCAT option
- No joint torque sensors

### The one question that reveals everything
> **"Can you run `ros2 topic hz /joint_states` and show me the output right now on a video call?"**

Real driver → instant output showing 50Hz+
Fake claim → excuses

### Cobot with Ethernet/TCP only — still works

Any cobot with Ethernet/TCP can be bridged into ROS2:

```python
# Modbus TCP bridge — works for most Chinese cobots
from pymodbus.client import ModbusTcpClient
from sensor_msgs.msg import JointState

class ModbusBridge(Node):
    def __init__(self):
        self.robot = ModbusTcpClient('192.168.1.100')
        self.robot.connect()
        self.pub = self.create_publisher(JointState, '/joint_states', 10)
        self.create_timer(0.02, self.read_joints)   # 50Hz

    def read_joints(self):
        result = self.robot.read_holding_registers(address=0, count=6)
        msg = JointState()
        msg.position = [r / 10000.0 for r in result.registers]
        self.pub.publish(msg)
```

**Critical: ask for maximum command frequency** — must be 50Hz+ for safe operation.

| Command frequency | Safety suitability |
|------------------|--------------------|
| 500Hz+ | ✅ Excellent |
| 125Hz | ✅ Good |
| 50Hz | ⚠️ Minimum |
| 10Hz | ❌ Too slow — dangerous |

---

## 17. ROS2 Explained

### What it is
ROS2 (Robot Operating System 2) is not actually an OS — it's a communication framework that lets different parts of a robot talk to each other.

Think of it like a company's internal communication system — like email or Slack — that all departments already know how to use. You just plug in and start talking.

### Three core concepts

**Topics — like a radio broadcast**
```
Camera broadcasts on "/camera/image"
Detection AI tunes into "/camera/image"
Detection AI broadcasts on "/detections"
Safety monitor tunes into "/detections"
```

**Nodes — the individual workers**
```
sensor_fusion_node     ← one job: merge sensor data
detector_node          ← one job: detect objects
human_safety_node      ← one job: find humans
safety_monitor_node    ← one job: enforce safety zones
task_planner_node      ← one job: decide what to do
```

**Messages — the standard language**
```
/joint_states     → JointState   (names + positions + velocities)
/camera/image     → Image        (pixel data + timestamp)
/detections       → Detection3DArray (class + 3D position + confidence)
```

### Why ROS2 not ROS1

| Problem with ROS1 | How ROS2 fixes it |
|-------------------|------------------|
| Single point of failure (master) | Fully distributed — no master |
| Not real-time safe | Real-time capable — critical for safety |
| Linux only | Linux, Windows, Mac |
| Poor security | Encrypted communications |
| Not production ready | Built for industrial deployment |

### What it gives you for free
```
✅ LiDAR drivers          — already written, just plug in
✅ Camera drivers          — already written, just plug in
✅ Motion planning         — MoveIt2, already built
✅ 3D visualisation        — RViz, already built
✅ Sensor fusion tools     — already built
✅ Robot simulators        — Gazebo, already built
✅ Recording/playback      — ros2 bag, already built
```

---

## 18. ROS2 on Any Robot

### Three ways to run ROS2 on a robot that doesn't have it

**Option 1 — Docker (recommended)**
```bash
# Install Docker on robot computer
curl -fsSL https://get.docker.com | sh

# Run full cobot stack
docker run --rm --network=host --privileged \
    ros:humble \
    ros2 launch cobot_bringup full_stack.launch.py
```

**Option 2 — Native install (Ubuntu 22.04 only)**
```bash
sudo apt-get install -y ros-humble-desktop
source /opt/ros/humble/setup.bash
```

**Option 3 — Companion computer (most common in industry)**
```
Robot's original controller  ←→  Jetson AGX Orin
(locked, don't touch)              └── ROS2 runs here
                                   └── Talks via Ethernet/TCP
```

### The robot doesn't need to know ROS2 exists

The ROS2 driver translates between the robot's protocol and ROS2:
```
Robot speaks:  EtherCAT / Modbus / REST API
        ↕  ← ROS2 driver translates
ROS2 speaks:  /joint_states / JointTrajectory topics
```

### Minimum requirements to run ROS2 via Docker

| Requirement | Minimum |
|-------------|---------|
| OS | Linux (any distro) |
| RAM | 4 GB (8 GB+ recommended) |
| Storage | 20 GB free |
| Network | Ethernet port |
| CPU | Any x86 or ARM64 |

---

## 19. Natural Language Robot Control

### What it means
```
You say:  "pick up the red bottle and put it in the box"
Robot:     understands → plans → executes
```

### Online vs offline

| Approach | Internet | Latency | Cost per command |
|----------|---------|---------|-----------------|
| Claude/GPT API | ✅ Yes | 1-3s | ~$0.01 |
| Local Llama on Orin | ❌ No | 0.5-2s | $0 |
| Hybrid | Optional | Best of both | Minimal |

**For production: local LLM is the right answer.**

### Local LLMs that run on Jetson AGX Orin (64GB)

| Model | Size | Quality | Use case |
|-------|------|---------|----------|
| Llama 3.2 3B | 2GB | Good | Fast commands |
| Llama 3.1 8B | 5GB | Very good | ✅ Recommended |
| Llama 3.1 70B | 40GB | Excellent | Complex reasoning |
| Phi-3 Mini | 2GB | Good | Efficient |

### Install Ollama (easiest method)
```bash
# Install once (needs internet)
curl -fsSL https://ollama.ai/install.sh | sh

# Download model once (needs internet)
ollama pull llama3.1:8b

# After that — fully offline forever
ollama run llama3.1:8b
```

### How language interface integrates with the stack

```
Current:
  scene_graph → task_planner → MoveIt2 → robot

With language:
  scene_graph ──────────────────────────┐
                                        ▼
  Voice/Text → language_interface → task_planner → MoveIt2 → robot
                      │
                Local Llama (reads scene graph)
```

### Offline voice pipeline
```
You speak
    ↓
Whisper (local, 75MB)
    ↓
Text
    ↓
Llama 3.1 8B (local, 5GB)
    ↓
Task plan JSON
    ↓
task_planner executes
    ↓
Robot moves
```
**Entire pipeline — voice in, robot moves — zero internet.**

### Offline vision AI models for Jetson

| Model | Use case | Runs offline |
|-------|----------|-------------|
| YOLOv8n/m/l | Object detection | ✅ |
| YOLOv8-seg | Instance segmentation | ✅ |
| NanoOWL | Open vocabulary detection | ✅ |
| Depth Anything V2 | Monocular depth | ✅ |
| FoundationPose | 6DOF object pose | ✅ |
| RTMPose | Human skeleton | ✅ |
| Whisper tiny/base | Speech to text | ✅ |

---

## 20. Fleet Learning & Continuous Improvement

### The big picture
```
Customer Robot 1 ──┐
Customer Robot 2 ──┼──► Your Cloud ──► Improved Model ──► All Robots
Customer Robot 3 ──┘
```

Every robot gets smarter from every other robot's experience.

### Four types of learning

**Type 1 — Outcome logging (start here)**
Record what worked and what didn't. No model training yet.
```python
experience = {
    'object_class': 'bottle',
    'grasp_position': [x, y, z],
    'success': True,
    'attempts': 2
}
```
After 10,000 picks across fleet → know which objects are hardest, which grasp angles work best.

**Type 2 — Fine-tune detection model**
Customer robots see industry-specific objects. Customer labels unknowns via web UI → uploaded → YOLOv8 retrained → pushed to all robots.

**Type 3 — Fine-tune language model**
```python
{
  'prompt': 'grab the widget and drop it in the bin',
  'scene': {scene_graph},
  'correct_plan': {successful_task_plan},
  'industry': 'manufacturing'
}
```
Thousands of real successful interactions → Llama learns customer vocabulary and workflows.

**Type 4 — Reinforcement learning**
```
Robot 1 tries grasp 45° on cylinder → fails
Robot 1 tries grasp 60° on cylinder → succeeds → uploaded
Robot 2 immediately knows 60° works
Robot 3 immediately knows 60° works
```

### Data pipeline architecture
```
EACH JETSON
  Experience Buffer → /opt/cobot/logs/
  Upload Agent (runs at night):
    → compress logs
    → anonymise robot_id
    → HTTPS POST to your API
    → clear uploaded logs

YOUR CLOUD
  Ingestion API → S3 storage
  Data Pipeline → anonymise, filter, label
  Training Pipeline → fine-tune models
  Model Registry → versioned, rollback capable

ALL JETSONS
  Update Agent:
    → checks for new models
    → downloads when idle
    → validates checksum
    → hot-swaps model file
```

### OTA model updates
```python
class UpdateAgent:
    def check_for_updates(self):
        response = requests.get('https://your-api.com/models/latest',
            headers={'robot-id': self.robot_id,
                     'current-version': self.current_version})
        if response.json()['update_available']:
            self.download_and_install(response.json())

    def download_and_install(self, update_info):
        model_path = self.download_model(update_info['url'])
        assert self.verify_checksum(model_path, update_info['checksum'])
        self.wait_for_idle()   # safety critical
        shutil.move(model_path, '/opt/cobot/models/yolov8n.engine')
```

### Data tiers per customer
| Tier | Data collected | Customer benefit |
|------|---------------|-----------------|
| Basic | Success/fail counts | Reliability reports |
| Standard | Task logs + object classes | Custom object training |
| Premium | Full sensor logs | Maximum improvement |
| Enterprise | Everything | Private fine-tuned model |

### The compounding advantage
```
Month 1:    10 robots,   10,000 picks  → 5% better
Month 3:    25 robots,   75,000 picks  → 20% better
Month 6:    50 robots,  300,000 picks  → 45% better
Month 12:  100 robots, 1,000,000 picks → unbeatable
```
This data flywheel is your long-term competitive moat.

---

## 21. Commissioning Checklist

### Before hardware arrives
- [ ] GitHub repo created and code pushed
- [ ] Laptop setup complete (WSL, VS Code, Claude Code)
- [ ] Jetson setup scripts ready
- [ ] CLAUDE.md written and committed
- [ ] Cobot supplier verified with live ROS2 demo

### Hardware day
- [ ] Mount LiDAR above workspace (unobstructed 360° view)
- [ ] Mount Camera 0 (front-left, ~45° angle, 0.5–3 m from workspace)
- [ ] Mount Camera 1 (front-right or rear, same height)
- [ ] Connect LiDAR via Ethernet (set Jetson ethernet to 192.168.1.10)
- [ ] Connect cameras via USB3 ports (blue ports — not USB2 hubs)
- [ ] Connect cobot per its manual

### Software verification
```bash
# Run hardware check script
./scripts/03_verify_hardware.sh

# Check topic rates
ros2 topic hz /lidar/points           # expect ~20 Hz
ros2 topic hz /cam0/color/image_raw   # expect ~30 Hz
ros2 topic hz /perception/fused_cloud # expect ~15 Hz
ros2 topic hz /safety/speed_scale     # expect 50 Hz
ros2 topic hz /joint_states           # expect 50 Hz+
```

### Safety verification (do before robot moves)
```bash
ros2 topic echo /safety/status

# Test 1: Stand 2 m away → GREEN, scale=1.0
# Test 2: Move to 0.8 m → YELLOW, scale=0.25
# Test 3: Move to 0.2 m → RED, scale=0.0, estop=true
# Test 4: Disconnect LiDAR → watchdog triggers stop within 1s
```

### Language interface verification
```bash
# Start Ollama
ollama serve

# Test voice command
ros2 topic pub /language/command std_msgs/String \
  "data: 'pick up the bottle on the left'"

# Verify task_planner responds
ros2 topic echo /task/state
# Should transition: IDLE → SELECT → APPROACH → PICK
```

### Calibration
```bash
python3 scripts/calibrate_extrinsics.py --board 9x6 --square 0.025
# Output values go into full_stack.launch.py
```

### Model preparation
```bash
# Detection model
python3 scripts/download_model.py --model yolov8n --outdir /opt/cobot/models

# Language model
ollama pull llama3.1:8b

# Speech model
# Downloads automatically on first use via Whisper
```

---

## 22. Key Files Reference

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Auto-read by Claude Code — project context |
| `src/cobot_bringup/launch/full_stack.launch.py` | Starts entire stack |
| `src/cobot_bringup/config/safety.yaml` | ISO 10218 zone distances |
| `src/cobot_bringup/config/detection.yaml` | Pickable object classes |
| `src/cobot_bringup/config/perception.yaml` | Voxel resolution etc |
| `src/perception_fusion/src/sensor_fusion_node.py` | LiDAR + RGBD merge |
| `src/object_detection/src/detector_node.py` | YOLOv8 TensorRT inference |
| `src/human_safety/src/human_safety_node.py` | Skeleton + proximity |
| `src/scene_graph/src/scene_graph_node.py` | Kalman object tracker |
| `src/language_interface/src/language_node.py` | Voice/text → task plan |
| `src/task_planner/src/task_planner_node.py` | Pick/place state machine |
| `src/safety_monitor/src/safety_monitor_node.py` | ISO 10218 enforcement |
| `src/fleet_agent/src/experience_logger.py` | Log robot interactions |
| `src/fleet_agent/src/update_agent.py` | OTA model updates |
| `src/cobot_dashboard/src/dashboard_server.py` | Browser dashboard |
| `scripts/download_model.py` | Get YOLOv8 TensorRT model |
| `scripts/calibrate_extrinsics.py` | Sensor alignment |
| `scripts/03_verify_hardware.sh` | Hardware check on arrival |
| `docker/Dockerfile` | Full stack container |
| `.github/workflows/build_check.yml` | Auto CI on every push |

---

## 23. Useful Commands

### Build
```bash
cb                              # build all packages
cbp perception_fusion           # build single package
cbs                             # source the workspace
```

### Launch
```bash
launch                          # full stack
ros2 launch cobot_bringup full_stack.launch.py launch_dashboard:=true
```

### Monitor
```bash
ros2 topic list                 # all active topics
ros2 topic hz /topic/name       # publish rate
ros2 topic echo /safety/status  # read safety state
ros2 node list                  # all running nodes
ros2 node info /sensor_fusion   # node subscriptions
ros2 doctor                     # ROS2 health check
sudo jtop                       # Jetson GPU/CPU stats
```

### Language interface
```bash
ollama serve                    # start local LLM server
ollama list                     # installed models
ollama pull llama3.1:8b         # download model

# Test a command manually
ros2 topic pub /language/command std_msgs/String \
  "data: 'pick up the red bottle'"
```

### Bags (record/replay)
```bash
ros2 bag record -a              # record everything
ros2 bag record /lidar/points /cam0/color/image_raw
ros2 bag play --loop my_bag/    # replay for offline dev
```

### Git
```bash
git add .
git commit -m "description"
git push                        # save to GitHub
git pull                        # get latest
git checkout -b feature/name    # new branch
```

### Claude Code
```bash
claude                          # open in current directory
claude --version                # check version
claude update                   # upgrade to latest
/compact                        # compress context to save tokens
/model                          # switch between Sonnet/Opus
```

### Fleet
```bash
# Check experience logs
ls /opt/cobot/logs/

# Manual upload trigger
python3 src/fleet_agent/src/upload_agent.py

# Check for model updates
python3 src/fleet_agent/src/update_agent.py --check
```

---

## 24. VS Code & WSL Explained

### What the "WSL: Ubuntu" indicator means
The bottom-left corner of VS Code shows `WSL: Ubuntu` in blue/green. This
confirms VS Code is connected to and operating inside the Ubuntu Linux
environment running inside Windows.

```
Your Physical Laptop
├── Windows (normal desktop, browser, GitHub Desktop, VS Code app)
└── WSL: Ubuntu (full Linux living inside Windows)
        ├── ROS2 lives here
        ├── Claude Code lives here
        ├── colcon build runs here
        └── ~/cobot_ws  (all project code lives here)
```

### Why this matters
ROS2, Claude Code, and the entire robot stack require Linux. WSL provides
that Linux environment without needing a separate computer. VS Code bridges
both worlds — the app runs on Windows but the terminal and filesystem
operate inside Linux.

### What runs where
| Task | Runs on |
|------|---------|
| Browse GitHub | Windows |
| GitHub Desktop push/pull | Windows |
| VS Code app window | Windows |
| VS Code terminal commands | Ubuntu WSL |
| Claude Code | Ubuntu WSL |
| colcon build | Ubuntu WSL |
| ROS2 nodes (before Jetson) | Ubuntu WSL |
| ROS2 nodes (production) | Jetson |

### If WSL: Ubuntu disappears from the corner
Click the `><` icon bottom-left → **Connect to WSL** → reconnects.

---

## 25. GitHub Workflow (Practical)

### Pushing code — terminal method
```bash
# First time setup
git config --global user.name "Your Name"
git config --global user.email "your@email.com"

# SSH key for GitHub (one time)
ssh-keygen -t ed25519 -C "your@email.com"   # press Enter 3 times
cat ~/.ssh/id_ed25519.pub                    # copy this output
# Paste on GitHub: Settings → SSH Keys → New SSH Key

# Push project to GitHub
cd ~/cobot_ws
git init
git add .
git commit -m "feat: complete initial stack scaffold"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/cobot_ws.git
git push -u origin main
```

### Pushing code — GitHub Desktop method (easier)
1. Open GitHub Desktop
2. **File** → **Add Local Repository**
3. Path: `\\wsl$\Ubuntu\home\cobot\cobot_ws`
4. Click **Publish repository** → Private → Publish
5. Every day: changed files appear automatically
6. Write summary → **Commit to main** → **Push origin**

### Pulling code onto the Jetson
```bash
# First time
git clone git@github.com:YOUR_USERNAME/cobot_ws.git
cd cobot_ws
colcon build --symlink-install

# Every update
git pull
colcon build --symlink-install
source install/setup.bash
```

### Viewing GitHub code in VS Code
```bash
cd ~/cobot_ws
code .          # opens current folder in VS Code instantly
```

Or in VS Code: **File → Open Folder** → `\\wsl$\Ubuntu\home\cobot\cobot_ws`

---

## 26. Claude Code Token Usage

Claude Code consumes tokens from your Claude subscription — not a separate
API bill. The practical limits:

| Plan | Monthly Cost | Session behaviour on this project |
|------|-------------|----------------------------------|
| Pro | $20/mo | Hits limits mid-session on 11-package stack |
| Max 5x | $100/mo | Recommended — handles full build sessions |
| Max 20x | $200/mo | For full-time multi-agent use |

### Save tokens — use these habits
- Type `/compact` in Claude Code between phases — compresses history
- Build one package per session, not all at once
- Keep CLAUDE.md updated — avoids re-explaining architecture every session
- Use `cbp <package>` not `cb` — only rebuilds what changed

### GitHub vs Claude Code — which does what
GitHub alone cannot build this project. Claude Code is required.

| Capability | GitHub browser editor | Claude Code |
|-----------|----------------------|-------------|
| Edit single files | ✅ | ✅ |
| Edit multiple files simultaneously | ❌ | ✅ |
| Run colcon build | ❌ | ✅ |
| Fix build errors automatically | ❌ | ✅ |
| Understand full codebase context | ❌ | ✅ |
| Test ROS2 nodes | ❌ | ✅ |

**Use Claude Code in VS Code for building. Use GitHub for saving and sharing.**

---

## 27. Three-Way Development Workflow

### The golden rule
**Never develop directly on the Jetson.**
Write code on laptop → push to GitHub → Jetson pulls from GitHub.

### The three-way flow
```
Laptop WSL                  GitHub                    Jetson
(write & build)             (save & share)            (run on hardware)

Claude Code writes      →   GitHub Desktop push   →   git pull
colcon build & fix      →   commit history        →   colcon build
test logic              →   team collaboration    →   ros2 launch
```

### Daily laptop workflow (Jetson not yet connected)
```bash
# Open Claude Code in project
cd ~/cobot_ws
claude

# After Claude Code makes changes
# → GitHub Desktop: commit + push
# → Two clicks, done
```

### When Jetson arrives — first time setup
```bash
# On the Jetson (plug monitor in once)
git clone git@github.com:theodoresimpson/Ai-Collaborative-Robot-Prototype.git
cd Ai-Collaborative-Robot-Prototype
source /opt/ros/humble/setup.bash
rosdep install --from-paths src --ignore-src -r -y
colcon build --symlink-install
source install/setup.bash
```

### When Jetson arrives — every day after
```bash
# On the Jetson via SSH from laptop
cd ~/cobot_ws
git pull
colcon build --symlink-install
source install/setup.bash
ros2 launch cobot_bringup full_stack.launch.py
```

### Quick reference
| What | Where | How |
|------|-------|-----|
| Write code | Laptop WSL | VS Code + Claude Code |
| Save progress | GitHub | GitHub Desktop — commit + push |
| Deploy to robot | Jetson | `git pull` + `colcon build` |
| Debug hardware | Jetson via SSH | VS Code Remote SSH |
| Team collaboration | GitHub | Pull Requests |
| Roll back a mistake | GitHub | `git revert` or Desktop history |

---

## 28. Complete Build Prompt for Claude Code

The full 11-phase build prompt is stored in `COBOT_BUILD_PROMPT.md` in the
repo root. Summary of phases:

| Phase | What it builds | Who |
|-------|---------------|-----|
| 0 | Workspace scaffold — all 11 package stubs + CI | Everyone first |
| 1 | perception_fusion — LiDAR + RGBD merge | Person 1 |
| 2 | object_detection — YOLOv8 TensorRT | Person 1 |
| 3 | human_safety — skeleton + proximity zones | Person 2 |
| 4 | scene_graph — Kalman object tracker | Person 2 |
| 5 | safety_monitor — ISO 10218 enforcement | Person 2 |
| 6 | task_planner — pick/place state machine | Person 3 |
| 7 | language_interface — Llama offline NL control | Person 3 |
| 8 | fleet_agent — logging + OTA updates | Person 3 |
| 9 | cobot_bringup — launch files + URDF | Person 3 |
| 10 | cobot_dashboard — browser UI on :8080 | Person 3 |
| 11 | Integration verification — full stack test | Everyone |

### How to use
1. `cd ~/cobot_ws` → `claude`
2. Paste one phase at a time
3. Let Claude Code complete fully (build + fix errors) before next phase
4. Use `/compact` between phases to save tokens

### Day-to-day debug prompts
```
# Person 1
"The fused cloud is dropping to 8Hz. Read sensor_fusion_node.py
 and profile whether TF lookup or voxel filter is the bottleneck."

# Person 2
"The safety_monitor estop is not latching. When I pub proximity=0.2
 it goes true but immediately resets. Fix the latch logic."

# Person 3
"The task_planner is stuck in APPROACH. MoveIt2 not installed yet —
 make APPROACH log 'SIMULATED APPROACH to {target}' and proceed
 so the full loop can be tested without the arm."

# Anyone
"Run: ros2 topic echo /safety/status
 It shows estop=true permanently. Find which node is publishing
 that and why."
```

---

## 29. Jetson Setup — Session Log (May 4 2026)

### What Was Accomplished Today

**Connection established:**
- Jetson connected via WiFi to home network
- IP address: `192.168.1.246`
- Username: `teddy`
- SSH working from laptop PowerShell and VS Code

**System details discovered:**
- OS: Ubuntu 20.04.6 LTS
- Kernel: 5.10.120-tegra (aarch64)
- JetPack: 5.1.2 (R35 revision 4.1)
- Note: JetPack 6 / Ubuntu 22.04 preferred but not yet installed

**Ubuntu upgrade attempted:**
- Tried `do-release-upgrade` over SSH — failed
- Root cause: NVIDIA custom kernel conflicts with standard upgrade path
- SSH kept disconnecting during long operations
- Decision: Use Docker approach instead — more reliable for production

**Docker installed successfully:**
```
Docker version: 5:28.1.1
hello-world test: ✅ passed
NVIDIA container toolkit: ✅ installed
nvidia-ctk runtime configured: ✅
```

**ROS2 Humble Docker image pulled:**
```
Image: dustynv/ros:humble-ros-base-l4t-r35.4.1
Size: 10.8GB
ROS_DISTRO: humble ✅
ros2 topic list: /parameter_events, /rosout ✅
```

**Persistent workspace created:**
```
/home/teddy/cobot_ws    ← project code
/opt/cobot/models       ← AI models
/opt/cobot/logs         ← runtime logs
/opt/cobot/calibration  ← sensor calibration
```

**Persistent Docker container created:**
```
Container name: cobot_ros
Base image: dustynv/ros:humble-ros-base-l4t-r35.4.1
Mounts: cobot_ws, /opt/cobot, /dev
Network: host
Runtime: nvidia
```

**Code cloned to Jetson:**
```
Repo: Ai-Robotics-Prototype/V1
Location: /home/teddy/cobot_ws/V1/
Objects: 191
Status: ✅ cloned successfully
```

### Issues Encountered & Solutions

| Issue | Solution |
|-------|----------|
| No display output initially | Switched monitors — found HDMI port |
| USB connection failing | Port reset errors — skipped, used WiFi instead |
| Ubuntu upgrade failing | Used Docker approach instead |
| SSH disconnecting | Use tmux, PowerShell SSH more stable than VS Code terminal |
| VS Code terminal paste duplicating commands | Type manually or use PowerShell |
| `do-release-upgrade` stuck | Network issues with NVIDIA repos — Docker is better path |
| Git clone auth failing | Used HTTPS with token in URL |
| Docker nvidia runtime unknown | Fixed with `sudo nvidia-ctk runtime configure --runtime=docker` |

### Next Steps on Jetson
- [ ] Move cloned code from V1/ subfolder to workspace root
- [ ] Run first `colcon build` inside Docker container
- [ ] Verify all 11 packages build cleanly
- [ ] Set up SSH key for GitHub (avoid token in URL)
- [ ] Install Claude Code inside Docker container
- [ ] Test `ros2 launch cobot_bringup perception_only.launch.py`
- [ ] Record first sensor bag when hardware arrives

### Commands to Resume Work
```bash
# SSH into Jetson
ssh teddy@192.168.1.246

# Rejoin Docker container
sudo docker exec -it cobot_ros bash

# Inside container — move code to right place
mv /home/teddy/cobot_ws/V1/* /home/teddy/cobot_ws/
mv /home/teddy/cobot_ws/V1/.* /home/teddy/cobot_ws/ 2>/dev/null
rmdir /home/teddy/cobot_ws/V1

# First build
cd /home/teddy/cobot_ws
rosdep update
rosdep install --from-paths src --ignore-src -r -y
colcon build --symlink-install
```

---

## 30. Supplier Test Procedure

### Pre-Test Setup (laptop WSL — do before meeting)
```bash
docker pull osrf/ros:humble-desktop
docker run --rm osrf/ros:humble-desktop ros2 --version
# Expected: ros2 1.3.x (humble)
```

### The 7 Tests

**Test 1 — GitHub repo exists (Critical)**
- Repo is public with recent commits (< 12 months)
- Has humble branch
- Contains package.xml, CMakeLists.txt

**Test 2 — Driver installs on Humble (Critical)**
```bash
docker run -it --network=host osrf/ros:humble-desktop bash
git clone THEIR_REPO
colcon build
# Must complete with zero errors
```

**Test 3 — Fake hardware mode (Critical)**
```bash
ros2 launch THEIR_PKG THEIR_LAUNCH.py use_fake_hardware:=true
ros2 topic list
# Must show /joint_states
```

**Test 4 — Joint states at 50Hz+ (Critical)**
```bash
ros2 topic hz /joint_states
# Must show 50Hz minimum — ask live on video call
```

**Test 5 — ros2_control interface (Important)**
```bash
ros2 control list_controllers
# Must show joint_trajectory_controller [active]
```

**Test 6 — MoveIt2 planning works (Important)**
- Watch them plan and execute a motion live
- Robot must move to target position

**Test 7 — Safety & hardware questions (Bonus)**
- Joint torque sensors on all 6 joints?
- Harmonic drives on all joints?
- ISO 10218-1 certificate number?
- Maximum command frequency?
- EtherCAT or Modbus TCP?

### Red Flags
- No GitHub repo
- Says "ROS" not "ROS2 Humble"
- Can't demo within a week
- Last commit > 12 months ago
- No Humble branch
- Joint states below 50Hz
- No torque sensors
- No ISO certificate

### Supplier Test Tool
A complete interactive HTML test checklist was created: `cobot_supplier_test.html`
Open in any browser — works fully offline. Includes copy buttons, pass/fail
scoring, red flag checklist, and report export.

### AUBO i10 Assessment
- GitHub: github.com/AuboRobot/aubo_ros2_driver
- use_fake_hardware: ✅
- MoveIt2: ✅
- Last commit: ⚠️ 3 years ago
- Recommendation: Test build — if it compiles on Humble, viable choice

---

## 31. Company & Branding

### Company Name: NeuRobots Manufacturing

**Why NeuRobots:**
- Instantly understood in every language
- "Robo" = physical, "Ai" = intelligence — perfect merger
- Works in China — both syllables exist in Mandarin
- Scales from startup to enterprise
- Simple, direct, impossible to misunderstand

### Brand Direction
- **Primary colors**: Deep black + electric blue
- **Accent**: White + sharp cyan
- **Logo concept**: The "O" in ROBO as a robot eye / camera lens
- **Feel**: Premium tech, clean, confident

### Tagline Options
- *Robotics. Reimagined.*
- *Physical intelligence.*
- *Where robots think.*
- *The thinking robot.*

### Domain to Register
```
roboai.com
roboai.com.au
roboai.io
```
Check on namecheap.com — register immediately once confirmed available.

### App Name Structure
```
NeuRobots              ← main app
NeuRobots Operator     ← floor worker mode
NeuRobots Engineer     ← technical mode
NeuRobots Fleet        ← multi-robot dashboard
```

### Other Names Considered
| Name | Notes |
|------|-------|
| Arcevo Robotics | Strong — arc + evolve |
| Versai Robotics | Versatile + AI |
| Somatiq | Body + IQ |
| Flexiq | Flexible + IQ |
| Kinesix | Kinesis + six axis |

---

## 32. NeuRobots Control App

### Overview
A Progressive Web App (PWA) that controls the robot from any device.
Works online (cloud access) and offline (local WiFi to Jetson).

### Three Modes

**Mode 1 — Operator (floor workers)**
- Large GO / STOP / PAUSE buttons
- Big GREEN/YELLOW/RED safety indicator
- Voice command button
- Task library — pick saved routines
- Camera feed
- Emergency stop always visible
- No settings, no configuration

**Mode 2 — Engineer**
- Everything in Operator plus:
- Live 3D robot visualizer
- Manual joint control sliders
- ROS2 topic monitor
- Task builder — drag and drop
- Scene graph live table
- Sensor feeds
- Safety zone configuration
- System logs and performance metrics
- Record and replay tasks

**Mode 3 — Admin**
- Everything in Engineer plus:
- Multi-robot fleet dashboard
- Robot health monitoring
- OTA model update management
- User management
- System configuration
- Calibration tools

### Architecture
```
Phone/Tablet/Laptop
      │ WiFi (always)
      ▼
FastAPI + WebSocket (:8080) on Jetson
      │
      ├── /ws/operator   filtered topics
      ├── /ws/engineer   all topics
      └── /ws/admin      all topics + config
      │
      ▼
ROS2 Topics

      │ HTTPS (when available)
      ▼
Cloud Layer (Phase 2)
  ├── Fleet dashboard
  ├── Remote access (Tailscale)
  └── OTA updates
```

### Offline Capabilities
| Feature | Offline | Needs Cloud |
|---------|---------|-------------|
| Robot control | ✅ | — |
| Safety monitoring | ✅ | — |
| Voice commands | ✅ | — |
| Camera feeds | ✅ | — |
| Task library | ✅ | — |
| Fleet dashboard | ❌ | ✅ |
| Remote access | ❌ | ✅ |
| OTA updates | ❌ | ✅ |

### PWA Install for Operators
```
First time: Open browser → http://192.168.1.246:3000
            Tap "Add to Home Screen"
            App icon appears on phone
Every time: Tap icon → connects to Jetson automatically
```

### Build Plan
- Phase 1: React PWA — all three modes, local WiFi only
- Phase 2: Tailscale remote access + fleet dashboard
- Phase 3: Full cloud with OTA and fleet learning

### Tech Stack
- Frontend: React PWA
- Backend: FastAPI + WebSocket (already in cobot_dashboard)
- Remote access: Tailscale (free tier)
- Cloud: TBD (AWS / Azure / VPS)

---

## 33. Project Status

### Environment
- [x] WSL Ubuntu installed and working
- [x] VS Code with WSL extension
- [x] Claude Code installed and logged in
- [x] GitHub organisation: Ai-Robotics-Prototype
- [x] Active repo: V1 (Private)
- [x] GitHub Desktop installed

### Jetson
- [x] Jetson powered on and booted
- [x] SSH working over WiFi (192.168.1.246)
- [x] Docker installed and working
- [x] NVIDIA container toolkit installed
- [x] ROS2 Humble Docker image pulled (10.8GB)
- [x] Persistent Docker container created (cobot_ros)
- [x] Workspace directories created (/home/teddy/cobot_ws, /opt/cobot)
- [x] Code cloned from GitHub
- [ ] Code moved from V1/ subfolder to workspace root
- [ ] First colcon build completed
- [ ] All 11 packages building cleanly
- [ ] SSH key set up for GitHub on Jetson
- [ ] Claude Code installed in Docker container
- [ ] Jetson upgraded to JetPack 6 / Ubuntu 22.04 (deferred — using Docker)

### Code
- [x] Phase 0 — workspace scaffold complete
- [x] All 11 packages created with stub nodes
- [x] TCP/IP robot driver for Chinese cobots added
- [x] Gripper driver added (DH-Robotics, Robotiq)
- [x] Task planner rewritten
- [x] Docker with NVIDIA GPU acceleration added
- [ ] Phase 1 — perception_fusion verified
- [ ] Phase 2 — object_detection verified
- [ ] Phase 3 — human_safety verified
- [ ] Phase 4 — scene_graph verified
- [ ] Phase 5 — safety_monitor verified
- [ ] Phase 6 — task_planner verified
- [ ] Phase 7 — language_interface verified
- [ ] Phase 8 — fleet_agent verified
- [ ] Phase 9 — bringup & launch verified
- [ ] Phase 10 — dashboard live on :8080
- [ ] Phase 11 — full integration verified

### Hardware
- [ ] Jetson AGX Orin sensors arrived
- [ ] LiDAR mounted and driver verified
- [ ] Cameras mounted and drivers verified
- [ ] Cobot arm selected and ordered
- [ ] Cobot arm connected and driver verified
- [ ] Extrinsic calibration complete
- [ ] Safety zones tested manually
- [ ] First autonomous pick/place run

### Business
- [x] Company name: NeuRobots Manufacturing
- [ ] Domain registered (roboai.com)
- [ ] Logo designed
- [ ] NeuRobots app Phase 1 built
- [ ] Supplier shortlisted and tested
- [ ] First customer demo

### Key Decisions Made
- **Docker over OS upgrade** — JetPack 5.1.2 + Docker is more reliable than
  trying to upgrade to JetPack 6 over network
- **dustynv/ros:humble-ros-base-l4t-r35.4.1** — best ROS2 Humble image
  for JetPack 5 Jetson devices
- **WiFi over USB/Ethernet** — Jetson connects over WiFi at 192.168.1.246
- **PowerShell SSH** more reliable than VS Code terminal for long operations
- **tmux** essential for long-running operations over SSH
- **NeuRobots** chosen as company name
- **React PWA** chosen for control app — one codebase, all devices
- **Offline-first architecture** — full control without internet
- **AUBO i10** leading robot candidate — needs build test confirmation
- **China travel** — install VPN (Astrill recommended) before travelling
- **GitHub PAT** required for Jetson git access (HTTPS method)

---

*Last updated: May 4 2026*
*Covers: full stack architecture, Jetson setup session, Docker ROS2 setup,*
*Windows WSL workflow, GitHub, Claude Code, SSH, team collaboration,*
*cobot selection, ROS2 explanation, natural language control, fleet learning,*
*supplier test procedure, company branding (NeuRobots), control app design*

---

## 35. Jetson Setup — Session Log (May 18 2026)

### Overview
Full Jetson bring-up session. Starting from a stopped Docker container and code
in the wrong location, ending with all 14 ROS2 packages building cleanly, code
pushed to GitHub, Node.js 20 installed, and Claude Code running inside the
Docker container. RealSense camera driver install started but not yet complete.

---

### Claude Code — Switching Accounts
```bash
claude auth logout
claude auth login    # opens browser link — sign in with new account
claude auth status   # check which account is active
```

---

### Step-by-Step: What Was Done

**1. Move code from V1/ subfolder to workspace root**

Code had been cloned into `/home/teddy/cobot_ws/V1/` instead of directly into
`/home/teddy/cobot_ws/`. Fixed with:
```bash
sudo mv /home/teddy/cobot_ws/V1/* /home/teddy/cobot_ws/
sudo mv /home/teddy/cobot_ws/V1/.* /home/teddy/cobot_ws/ 2>/dev/null
sudo rm -rf /home/teddy/cobot_ws/V1
sudo chown -R teddy:teddy /home/teddy/cobot_ws
```
Result: `CLAUDE.md  colcon_defaults.yaml  docker  README.md  scripts  src` at root.

**2. Start Docker container and enter it**
```bash
sudo docker start cobot_ros
sudo docker exec -it cobot_ros bash
# Prompt changes to: root@Jetson:/#
```

**3. First colcon build attempt — failed: ament_cmake not found**

Root cause: ROS2 environment not sourced. The dustynv image uses a non-standard
path — `/opt/ros/humble/install/` not `/opt/ros/humble/`:
```bash
# Wrong (doesn't exist):
source /opt/ros/humble/setup.bash

# Correct:
source /opt/ros/humble/install/setup.bash
```
Found via: `find / -name "setup.bash" 2>/dev/null | grep ros`

**4. Second build attempt — failed: invalid email in package.xml**

All 14 `package.xml` files had `robot@cobot` which catkin_pkg rejects.
Fixed with one command:
```bash
find src -name "package.xml" -exec sed -i 's/robot@cobot/robot@roboai.com/g' {} \;
```

**5. Third build attempt — failed: invalid condition in occupancy_map/package.xml**

`$NVBLOX_ENABLED` is not valid ROS2 condition syntax for this version of catkin_pkg.
Fixed by removing the conditional dependency:
```bash
sed -i 's/<depend condition="\$NVBLOX_ENABLED">nvblox_ros<\/depend>/<!-- nvblox_ros optional - install separately when Isaac ROS available -->/' src/occupancy_map/package.xml
```

**6. All 14 packages building cleanly**
```
Summary: 14 packages finished
cobot_bringup ✅  cobot_dashboard ✅  cuda_pointcloud ✅  fleet_agent ✅
gripper_driver ✅  human_safety ✅  language_interface ✅  object_detection ✅
occupancy_map ✅  perception_fusion ✅  robot_driver ✅  safety_monitor ✅
scene_graph ✅  task_planner ✅
```

**7. Make ROS2 source permanent inside container**
```bash
echo 'source /opt/ros/humble/install/setup.bash' >> ~/.bashrc
```

**8. Push fixes to GitHub**

Git gave "dubious ownership" error (running as root, files owned by teddy):
```bash
git config --global --add safe.directory /home/teddy/cobot_ws
git add src/*/package.xml
git commit -m "fix: correct package.xml emails and remove invalid nvblox condition"
git push --set-upstream origin master
```
Remote URL had placeholder `YOUR_TOKEN` — updated with real PAT:
```bash
git remote set-url origin https://TOKEN@github.com/Ai-Robotics-Prototype/V1.git
```

**9. Install Node.js 20 inside Docker container**

`apt install nodejs` gives v10 (too old). ROS GPG key is expired so
`nodesource` setup script also fails. Solution — download tarball directly:
```bash
cd /tmp
wget https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-arm64.tar.xz
tar -xf node-v20.19.0-linux-arm64.tar.xz
cp -r node-v20.19.0-linux-arm64/* /usr/local/
hash -r
node --version   # v20.19.0 ✅
```

**10. Install Claude Code inside Docker container**
```bash
npm install -g @anthropic-ai/claude-code
cd /home/teddy/cobot_ws
claude
```

---

### Issues Encountered & Solutions

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Code in V1/ subfolder | Cloned into nested folder | `sudo mv` + `sudo chown` |
| Permission denied on mv | cobot_ws owned by root | Add `sudo` |
| Docker container not running | Container stopped between sessions | `sudo docker start cobot_ros` |
| `colcon: command not found` | Running outside container | Enter container first |
| `ament_cmake` not found | ROS2 env not sourced | `source /opt/ros/humble/install/setup.bash` |
| ROS2 at non-standard path | dustynv image layout | Path is `/opt/ros/humble/install/` |
| Invalid email in package.xml | Placeholder `robot@cobot` | `sed -i` across all package.xml files |
| `$NVBLOX_ENABLED` parse error | Old catkin_pkg can't parse env-var conditions | Remove conditional line |
| Git "dubious ownership" | Root user, teddy-owned files | `git config --global --add safe.directory` |
| Git remote `YOUR_TOKEN` placeholder | Never replaced at clone time | `git remote set-url origin https://TOKEN@...` |
| No upstream branch on push | First push from container | `git push --set-upstream origin master` |
| ROS2 apt GPG key expired | Key F42ED6FBAB17C654 expired | `apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys F42ED6FBAB17C654` (partial — apt still blocked) |
| `ros-humble-*` not found via apt | Broken GPG key blocks apt repo | Build all ROS deps from source |
| Node.js v10 too old | Ubuntu focal default | Download v20 tarball from nodejs.org |
| `nodesource` setup script fails | Broken ROS apt repo blocks `apt update` | Use tarball install instead |

---

### RealSense Camera Driver — In Progress

apt install not available. Building from source:
```bash
# Clone (already done):
cd /home/teddy/cobot_ws/src
git clone https://github.com/IntelRealSense/realsense-ros.git -b ros2-master

# Built successfully:
colcon build --packages-select realsense2_camera_msgs   ✅
colcon build --packages-select realsense2_description   ✅

# Failing — missing diagnostic_updater:
colcon build --packages-select realsense2_camera        ❌
# Error: Could not find package configuration file for "diagnostic_updater"
```

Next step — build diagnostic_updater from source:
```bash
cd /home/teddy/cobot_ws/src
git clone https://github.com/ros/diagnostics.git -b ros2
cd /home/teddy/cobot_ws
colcon build --packages-select diagnostic_updater
colcon build --packages-select realsense2_camera
```

---

### Ouster LiDAR Driver — Not Yet Started
Pending after RealSense is complete.

---

### Isaac ROS AI Stack — Not Yet Started
`scripts/install_isaac_ros.sh` already exists in the repo.
Pending after RealSense and Ouster are complete.

---

### What AI Stacks Are / Are Not Installed

**Already in the Docker image:**
- ROS2 Humble ✅
- Basic ROS2 packages ✅

**Not yet installed:**

| Component | Used by | How to get |
|-----------|---------|------------|
| RealSense ROS2 driver | cameras | Build from source (in progress) |
| Ouster LiDAR driver | lidar | Build from source |
| YOLOv8 TensorRT engine | object_detection | `scripts/download_model.py` + `scripts/export_trt.py` |
| MediaPipe / RTMPose | human_safety | pip install |
| Whisper | speech recognition | pip install |
| Ollama + Llama 3.1 8B | language_interface | ollama install script |
| Isaac ROS nvblox | occupancy_map | `scripts/install_isaac_ros.sh` |

---

### Claude Code Prompt — Complete Sensor + AI Stack Install
Paste into Claude Code (`claude`) inside the Docker container:

```
I'm running a ROS2 Humble cobot perception stack on a Jetson AGX Orin
(JetPack 5.1.2, Ubuntu 20.04, ARM64) inside a Docker container based on
dustynv/ros:humble-ros-base-l4t-r35.4.1.

ROS2 is installed at /opt/ros/humble/install/ (non-standard path).
Workspace: /home/teddy/cobot_ws — 14 packages already building cleanly.
The apt ROS2 repo is broken (expired GPG key) — build everything from source.

Already cloned in src/:
- realsense-ros (ros2-master branch) — needs diagnostic_updater dependency

Complete in order:

1. REALSENSE CAMERAS (Intel RealSense D435i x2)
   - Clone and build diagnostic_updater from source (ros/diagnostics ros2 branch)
   - Install librealsense2 SDK (build from source if needed)
   - Build realsense2_camera
   - Verify: ros2 launch realsense2_camera rs_launch.py --dry-run

2. OUSTER LIDAR (Ouster OS1-32)
   - Clone https://github.com/ouster-lidar/ouster-ros
   - Build all dependencies from source as needed
   - Verify package builds cleanly

3. NVIDIA ISAAC ROS AI STACK
   - Run scripts/install_isaac_ros.sh or install manually
   - Target: JetPack 5.1.2 / L4T r35.4.1 compatible versions
   - Install: isaac_ros_common, isaac_ros_nvblox, isaac_ros_object_detection

For each: source /opt/ros/humble/install/setup.bash before building,
run colcon build and fix all errors automatically.
```

---

### Resume Commands
```bash
# SSH into Jetson
ssh teddy@192.168.1.246

# Enter Docker container
sudo docker start cobot_ros
sudo docker exec -it cobot_ros bash

# Source ROS2 (if not in ~/.bashrc yet)
source /opt/ros/humble/install/setup.bash

# Go to workspace
cd /home/teddy/cobot_ws

# Open Claude Code
claude
```

---

### Key Decisions Made This Session
- **Build from source** — ROS2 apt repo GPG key is expired in this container;
  all ROS dependencies must be built from source until container is rebuilt
- **Node.js via tarball** — only reliable install method when apt is broken
- **Claude Code inside Docker** — gives Claude Code full access to ROS2
  environment, colcon, and all build tools in one place
- **master branch** — Jetson pushed to `master`; GitHub default may be `main`;
  align branches when next pushing from laptop

---

### Updated Project Status (May 18 2026)

| Item | Status |
|------|--------|
| WSL + VS Code + Claude Code (laptop) | ✅ Done |
| GitHub org: Ai-Robotics-Prototype, repo: V1 | ✅ Done |
| Jetson SSH over WiFi (192.168.1.246) | ✅ Done |
| Docker container `cobot_ros` running | ✅ Done |
| All 14 ROS2 packages building cleanly | ✅ Done |
| package.xml fixes pushed to GitHub | ✅ Done |
| Node.js 20 + Claude Code in container | ✅ Done |
| RealSense driver (realsense2_camera) | 🔄 In progress |
| Ouster LiDAR driver | ⏳ Not started |
| Isaac ROS AI stack | ⏳ Not started |
| First sensor bag recorded | ⏳ Not started |
| Safety zones tested | ⏳ Not started |
| Full autonomous loop | ⏳ Not started |

---

*Last updated: May 18 2026*
*Covers: Docker container restart, code reorganisation, all 14 packages building,*
*package.xml fixes, ROS2 non-standard path, GitHub push from container,*
*Node.js 20 tarball install, Claude Code install, RealSense driver in progress,*
*broken apt GPG key workarounds, Claude Code account switching*

---

## 36. Dashboard Session Log (May 19 2026)

### Overview
Full dashboard development and Jetson connectivity session. Starting from a working
14-package ROS2 build, this session built a complete browser-based robot controller
dashboard, diagnosed and fixed WebGL limitations, resolved Jetson network/sleep
issues, and configured the dashboard to auto-start permanently on boot.

---

### Dashboard Built — cobot_dashboard

**URL:** `http://192.168.1.246:8080`  
**Backend:** `src/cobot_dashboard/cobot_dashboard/dashboard_server.py` (FastAPI + WebSocket)  
**Frontend:** `src/cobot_dashboard/static/index.html`  
**Programs stored:** `/opt/cobot/programs/`  
**Saved points:** `/opt/cobot/calibration/saved_points.json`

#### Features Implemented
- FastAPI + WebSocket backend broadcasting at 10Hz
- MJPEG camera stream at `/stream/cam0`
- WebSocket broadcasts: safety_zone, speed_scale, estop, human_proximity,
  task_state, joint_positions, tcp_pose, detections, scene_objects, saved_points
- 4-panel grid layout: 3D Viewer, Teach Pendant, Camera Feed, Program Builder
- **Teach Pendant:** 6-axis joint jog (hold buttons), TCP Cartesian jog,
  saved points with Teach/Rename/Delete
- **Teach mode:** select point → jog robot → Confirm saves TCP pose
- **Point renaming:** inline edit, persisted to JSON via `/cmd/rename_point`
- **Program Builder:** drag-drop steps, Wait steps with configurable duration,
  Pick Variable step with object class dropdown
- **Program Library overlay:** create/run/edit/duplicate/delete programs, search, tags
- **Camera feed:** dual canvas overlay — green contour outlines + blue detection boxes
- Object detection list with "☆ Pick" button
- Scene graph table
- E-STOP in header and pendant
- Safety zone badge (GREEN/YELLOW/RED)
- Connection indicator
- Operator / Engineer / Admin mode tabs
- FPS counter

#### Key Commits
| Commit | Description |
|--------|-------------|
| `c30f7a8` | fix: correct package.xml emails and remove invalid nvblox condition |
| `13a0887` | feat: add sensor drivers and Isaac ROS AI stack |
| `0e18032` | feat: complete NeuRobots professional controller dashboard |
| `74e9e1a` | feat: fix 3D viewer, add rename/teach/wait/detection/variable-pick/library |
| `06462ca` | fix: replace Three.js WebGL viewer with Canvas 2D robot arm visualizer |
| `563b337` | feat: Three.js WebGL 3D viewer with 6-axis robot arm (with Canvas 2D fallback) |

---

### 3D Viewer — WebGL Investigation & Resolution

#### Problem
3D viewer panel showed blank / nothing rendering despite multiple implementation attempts.

#### Root Cause Diagnosed
`webgl_test.html` created at `src/cobot_dashboard/static/webgl_test.html` to diagnose.

Result when opened in **Firefox 136 on Jetson (Linux x86_64)**:
```
✗ WebGL 1: getContext returned null
✗ WebGL 1 (options): null
✗ WebGL 2: null
✓ Canvas 2D: WORKS
✗ OffscreenCanvas WebGL: null
Browser: Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0
Platform: Linux x86_64
```

**WebGL is completely unavailable in Firefox on the Jetson** because:
- Firefox running without GPU driver exposed to the browser
- Running in Docker container context without hardware acceleration
- No `$DISPLAY` / Xorg properly configured for GPU passthrough to browser

#### Solution Implemented
Two-layer approach:

**Layer 1 — Three.js WebGL viewer (for Chrome/Edge on laptop)**
- `three.min.js` and `OrbitControls.js` downloaded locally to `static/`
  (no CDN dependency)
- Proper 6-axis robot arm with UR5e proportions
- Joint hierarchy using `Object3D` parenting
- DH-parameter axis mapping:
  - `joint_positions[0]` → J1.rotation.y (base)
  - `joint_positions[1]` → J2.rotation.z (shoulder)
  - `joint_positions[2]` → J3.rotation.z (elbow)
  - `joint_positions[3]` → J4.rotation.x (wrist1)
  - `joint_positions[4]` → J5.rotation.z (wrist2)
  - `joint_positions[5]` → J6.rotation.x (wrist3)
- OrbitControls: drag to rotate, scroll to zoom
- Safety zone rings (green/yellow/red) on floor plane
- Workspace envelope wireframe sphere
- TCP trail (last 100 positions)
- Smooth joint interpolation (lerp factor 0.12)

**Layer 2 — Canvas 2D fallback (for Firefox on Jetson)**
- Automatic fallback when WebGL unavailable
- Side-view 2D arm using forward kinematics
- UR5e link lengths, 6 joints rendered as colored segments
- Safety zone half-circles, TCP trail, joint/TCP overlays

**How to get the 3D viewer:**
Open `http://192.168.1.246:8080` in **Chrome or Edge on your Windows laptop**.
Chrome has full hardware-accelerated WebGL. The 3D arm is visible and rotatable.
Firefox on the Jetson screen shows the Canvas 2D fallback — this is expected.

---

### Jetson Network & Sleep Issues — Fixed

#### Problem
Jetson repeatedly became unreachable over SSH and from laptop browser.
- `ping 192.168.1.246` → Request timed out
- `ssh teddy@192.168.1.246` → Connection timed out
- Dashboard unreachable from laptop

#### Root Cause
1. Jetson suspending/sleeping and dropping WiFi
2. Dashboard server not auto-starting after container restart

#### Fix 1 — Disable Sleep/Suspend Permanently
```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```
Result: 4 symlinks to `/dev/null` created — persists across reboots.

```bash
# Run on Jetson desktop (not in Docker) to disable screen blanking:
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout 0
gsettings set org.gnome.desktop.session idle-delay 0
```

#### Fix 2 — Dashboard Auto-Start on Boot

**Step 1:** Created startup script inside container:
```bash
cat > /usr/local/bin/start-dashboard.sh << 'EOF'
#!/bin/bash
source /opt/ros/humble/install/setup.bash
source /home/teddy/cobot_ws/install/setup.bash
export CYCLONEDDS_URI=file:///opt/cobot/cyclonedds.xml
cd /home/teddy/cobot_ws
exec python3 src/cobot_dashboard/cobot_dashboard/dashboard_server.py
EOF
chmod +x /usr/local/bin/start-dashboard.sh
```

**Step 2:** Committed startup script into container image:
```bash
sudo docker commit cobot_ros cobot_ros:latest
# SHA256: deb499a60b28617ffc6e9c3f627db414686e6d5ba10ebab2da0b9d406ecff7ba
```

**Step 3:** Recreated container with `--restart always`:
```bash
sudo docker stop cobot_ros
sudo docker rm cobot_ros
sudo docker run -d \
  --name cobot_ros \
  --restart always \
  --runtime nvidia \
  --privileged \
  --network host \
  -v /home/teddy/cobot_ws:/home/teddy/cobot_ws \
  -v /opt/cobot:/opt/cobot \
  -e CYCLONEDDS_URI=file:///opt/cobot/cyclonedds.xml \
  cobot_ros:latest \
  /usr/local/bin/start-dashboard.sh
# Container ID: 7dc3fde80e07...
```

**Verified:**
```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8080/
# HTTP 200 ✅
```

**Result:** Dashboard now starts automatically within ~3 seconds of Jetson boot.
No manual intervention ever required.

---

### Network Diagnostic — Laptop Cannot Reach Jetson

#### Symptoms
- `ping 192.168.1.246` → Request timed out from Windows laptop
- SSH → Connection timed out
- Chrome → "Site cannot be reached"
- But: Jetson confirmed online, port 8080 listening on `0.0.0.0`

#### Confirmed Working on Jetson Side
```bash
ss -tlnp | grep 8080
# LISTEN   0   2048   0.0.0.0:8080   0.0.0.0:*   ✅

sudo docker inspect cobot_ros | grep -i network
# NetworkMode: host  ✅

curl http://localhost:8080/
# HTTP 200  ✅
```

#### ARP Table (Windows Laptop)
```
Interface: 192.168.1.34 --- 0xb
  192.168.1.1     f4-05-95-94-32-f8  dynamic  (router)
  192.168.1.246   50-2e-91-95-b6-15  dynamic  (Jetson)
```
Jetson MAC `50-2e-91-95-b6-15` confirmed in ARP cache — device is visible on network.

#### Likely Cause
Windows Firewall or network profile (Public vs Private) blocking inbound
connections to the laptop's own outbound requests on port 8080.

#### Fix to Try
On Windows laptop, run in Command Prompt as Administrator:
```
netsh advfirewall firewall add rule name="Allow Jetson Dashboard" ^
  dir=in action=allow protocol=TCP localport=8080
```

Or switch WiFi network profile from Public to Private:
- Settings → Network & Internet → WiFi → your network → Set as Private network

---

### Issues & Solutions This Session

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| 3D viewer blank | WebGL unavailable in Firefox on Jetson | Canvas 2D fallback + Three.js for Chrome |
| Firefox WebGL disabled | No GPU driver exposed to browser in Docker | Use Chrome on laptop instead |
| "Site cannot be reached" on laptop | Dashboard server stopped | Recreated container with --restart always |
| Jetson unreachable via SSH/ping | Jetson suspended/sleeping | Masked systemd sleep targets |
| `ip`/`ifconfig` not found in container | Minimal Docker image | Used Python socket to confirm IP |
| gsettings failed in container | No `$DISPLAY` / no GNOME session | Run on Jetson desktop directly |
| docker commit/rm can't run in Claude Code | Would kill the container Claude runs in | Run manually on Jetson host terminal |

---

### Updated Project Status (May 19 2026)

| Item | Status |
|------|--------|
| WSL + VS Code + Claude Code (laptop) | ✅ Done |
| GitHub org: Ai-Robotics-Prototype, repo: V1 | ✅ Done |
| Jetson SSH over WiFi (192.168.1.246) | ✅ Done |
| Docker container `cobot_ros` running | ✅ Done |
| --restart always configured | ✅ Done |
| Dashboard auto-starts on boot | ✅ Done |
| Sleep/suspend permanently disabled | ✅ Done |
| All 14 ROS2 packages building cleanly | ✅ Done |
| Dashboard UI complete | ✅ Done |
| Three.js + OrbitControls downloaded locally | ✅ Done |
| 3D viewer (Chrome on laptop) | ✅ Built — needs laptop connectivity verified |
| Canvas 2D fallback viewer (Firefox/Jetson) | ✅ Done |
| webgl_test.html diagnostic page | ✅ Done |
| Camera feed (MJPEG) | ✅ Built — freeze fix pending verify |
| Program builder step library | ✅ Built — click fix pending verify |
| RealSense driver (realsense2_camera) | ✅ Done |
| Ouster LiDAR driver | ⏳ Not started |
| Isaac ROS AI stack | ⏳ Not started |
| First sensor bag recorded | ✅ Done (30s, 4.1 GiB) |
| Safety zones tested | ⏳ Not started |
| Full autonomous loop | ⏳ Not started |
| Laptop browser → dashboard working | ⏳ Pending WiFi fix |

### Key Decisions Made This Session
- **Chrome on laptop is the target browser** — Firefox on Jetson has no WebGL;
  the dashboard is designed to be accessed from a laptop/tablet, not the Jetson screen
- **Three.js served locally** — `three.min.js` + `OrbitControls.js` in `static/`
  so no internet required at runtime
- **Canvas 2D as automatic fallback** — viewer detects WebGL failure and falls
  back to 2D side-view automatically; no error shown to user
- **--restart always** — Docker container now self-heals after crashes and reboots
- **systemd sleep targets masked** — Jetson will never suspend again
- **Dashboard entrypoint baked into image** — `docker commit` captured the
  startup script so it survives container recreation

---

*Last updated: May 19 2026*
*Covers: Dashboard UI build, 3D viewer WebGL diagnosis, Canvas 2D fallback,*
*Three.js local hosting, Jetson sleep fix, Docker --restart always,*
*dashboard auto-start on boot, laptop connectivity investigation*

---

## 37. Session Log — May 21 2026
### NVIDIA AI Integration + Dashboard Visual Upgrade

**Last Updated**: May 21 2026  
**Covers**: NVIDIA AI stack integration strategy, Claude Code ↔ GitHub workflow, full codebase audit (cobot_ws_full_tar.gz), dashboard visual upgrade with object detection display, scene graph format bug fix, LiDAR object overlays, per-camera detection filtering, Livox MID360 support, three master Claude Code prompts (v1, v2, v3)

---

### Topics Discussed

#### NVIDIA AI Integration Strategy

Assessed the best NVIDIA software to incorporate with the cobot stack given the specific hardware (Jetson AGX Orin + LiDAR + RealSense + cobot arm).

**isaac_ros_nvblox** — GPU-accelerated TSDF mapping. Replaces CPU-based OctoMap in `occupancy_map` package. Rebuilds the 3D collision scene at 10Hz+ vs 2–3Hz on CPU. MoveIt2 gets a fresher collision scene so the robot can move faster without hitting things. Already cloned at `src/isaac_ros_nvblox/`.

**isaac_ros_object_detection** — YOLOv8 through TensorRT with INT8 quantization automatically. Reduces detection latency from ~80ms to ~15ms on Orin. Already cloned at `src/isaac_ros_object_detection/`.

**isaac_ros_pose_estimation (FoundationPose)** — Full 6DOF pose (position + orientation) rather than just XYZ position. Means gripper can approach at the correct angle automatically. Critical for non-symmetrical objects.

**CuVS / cuSpatial** — GPU point cloud operations. Moves voxel downsampling and merge in `perception_fusion` from CPU to GPU. Addresses the 8Hz dropout issue, target is stable 15Hz.

**NanoOWL** — Open-vocabulary detection. Lets language interface describe objects by name rather than needing pre-trained classes. When the LLM hears "grab the widget," NanoOWL finds "widget" visually. NVIDIA-optimised for Jetson at github.com/NVIDIA-AI-IOT/nanoowl.

**Recommended install order:**
1. Finish sensor drivers (RealSense, Ouster)
2. `scripts/install_isaac_ros.sh` — gets nvblox and image processing
3. isaac_ros_object_detection (replaces detector stub)
4. FoundationPose for 6DOF poses after first pick/place works
5. NanoOWL + language integration last

**The single biggest capability unlock:** FoundationPose + ros2_control speed scaling. Stack goes from "bottle at XYZ" to "bottle tilted 23° at XYZ" → MoveIt2 plans correct grasp angle first time → clean single pick → demo quality improves dramatically.

**Recommended pipeline:**
```
RealSense D435i
    ↓
isaac_ros_image_proc   ← GPU debayering + rectification
    ↓
isaac_ros_object_detection  ← YOLOv8 TensorRT ~15ms
isaac_ros_pose_estimation   ← FoundationPose 6DOF
    ↓
NanoOWL (optional)          ← open-vocabulary grounding
    ↓
scene_graph                 ← Kalman tracker, unchanged
    ↓
language_interface          ← "pick the blue wrench" → scene graph lookup
```

**Language + Vision integration loop:**
```
Voice → Whisper → text
    ↓
Llama 3.1 8B (reads scene_graph JSON)
    ↓  structured task plan: {target_class, color_hint, spatial_hint, action}
NanoOWL confirms visual match
FoundationPose gets 6DOF pose
    ↓
MoveIt2 plans approach + grasp angle
    ↓
robot moves
```

---

#### Claude Code ↔ GitHub Integration

**Question asked:** Is it possible to hook Claude Code up to GitHub to get code it needs?

**Answer:** Yes — Claude Code runs `git clone` directly as a bash command. You can tell it:

```
"Clone https://github.com/NVIDIA-AI-IOT/nanoowl into src/ and build it"
```

It runs the clone, reads the code, figures out dependencies, and builds. Most useful patterns:

```bash
# Clone a specific package it needs
"Clone the ouster-ros driver from github.com/ouster-lidar/ouster-ros
 into src/, check what branch supports ROS2 Humble, build it, fix any errors"

# Pull in a missing dependency mid-build
"The build is failing because diagnostic_updater is missing —
 clone it from github.com/ros/diagnostics ros2 branch and build that first"

# Chained dependency resolution (critical for broken apt repo)
"The apt ROS2 repo is broken. For each missing dependency,
 find the correct GitHub repo, clone it into src/,
 build it with colcon, then continue with the main build"
```

**SSH key setup inside Docker container** — required to avoid token-in-URL for every clone:
```bash
ssh-keygen -t ed25519 -C "robot@roboai.com"
cat ~/.ssh/id_ed25519.pub
# Add to github.com → Settings → SSH Keys
git remote set-url origin git@github.com:Ai-Robotics-Prototype/V1.git
```

---

#### Why ROS2 apt Repo is Broken — and Whether to Fix It

**What's broken:** The apt package repository GPG key (`F42ED6FBAB17C654`) expired in the `dustynv/ros:humble-ros-base-l4t-r35.4.1` Docker image. `apt install ros-humble-*` fails.

**What's NOT broken:** ROS2 itself, all 14 packages, colcon, the runtime — all fully functional.

**Do you need to fix it?** Probably not. The workaround is to clone all ROS dependencies from GitHub and build with colcon — which gives more control over versions. The real fix (upgrading to JetPack 6 / Ubuntu 22.04) was already deferred in May 4 session.

**If a hard-to-build package is needed:**
```bash
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys F42ED6FBAB17C654
# OR
curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key \
  | sudo apt-key add -
# Then docker commit to save
```

---

### Master Claude Code Prompt — v1

Created from the project conversation MD (no codebase upload). Covers 12 phases:

| Phase | What |
|-------|------|
| 0 | GitHub SSH key setup — one human step to add key to GitHub |
| 1 | Complete RealSense driver (diagnostic_updater dependency) |
| 2 | Ouster LiDAR driver from source |
| 3 | Isaac ROS core (nvblox + GPU image processing) |
| 4 | YOLOv8 TensorRT via Isaac ROS (~15ms inference) |
| 5 | FoundationPose for 6DOF grasp angles |
| 6 | NanoOWL for visual grounding of voice commands |
| 7 | RTMPose skeleton detection (replaces MediaPipe) |
| 8 | GPU perception fusion fix (stops 8Hz dropout) |
| 9 | Ollama + Llama 3.1 8B + Whisper fully wired |
| 10 | Dashboard laptop connectivity fix |
| 11 | All new nodes wired into launch files |
| 12 | Full build, verify, push to GitHub |

**Fallback rules baked in:** apt fails → clone from GitHub; colcon fails → clone missing dep; pip fails for ARM64 → find wheel directly; Isaac ROS CUDA mismatch → checkout compatible tag; model download fails → create stub.

**Saved as:** `roboai_claude_code_master_prompt.md`

---

### Codebase Upload 1 — V1-master_2_.zip

Full V1 repo uploaded. Audit revealed:

**Frontend structure (React + Vite + Zustand):**
- `src/cobot_dashboard/frontend/` — React app
- `src/cobot_dashboard/frontend/src/store/useStore.js` — Zustand store with WebSocket connection
- `src/cobot_dashboard/frontend/src/layouts/MonitorLayout.jsx` — main 3-column grid
- `src/cobot_dashboard/frontend/src/components/` — CameraPanel, LidarPanel, ArmViewer3D, ControlStrip, ProgramPanel, SafetyBanner, SafetyPanel, TopBar, SideNav

**Backend structure (FastAPI + WebSocket):**
- `dashboard_server.py` — serves React dist, WebSocket at `/ws/state`, MJPEG at `/stream/cam0`, `/stream/cam1`, `/stream/annotated`
- Already subscribes: `/perception/detections`, `/perception/scene_graph`, `/perception/annotated_image`, `/safety/status`, `/joint_states`, `/lidar/points`, cameras
- Already broadcasts: `detections[]`, `scene_graph{objects[]}`, `safety{}`, `joints{}`, `task{}`, `tcp_pose[]`, `gripper{}`, `program{}`, `robot{}`, `system{}`

**Gap analysis — what the stack produces vs what the dashboard shows:**

| Gap | Detail |
|-----|--------|
| scene_graph received but not displayed | `sceneGraph.objects` received in store but no panel shows it in MonitorLayout |
| Both cameras show same detections | No per-camera filtering in DetectionOverlay |
| Annotated stream unused | `/stream/annotated` served but no panel uses it |
| No task flow visualisation | `task.state` shown as tiny text pill only |
| No human proximity arc | Only shown in Configure tab SafetyPanel, not main monitor |
| No voice input UI | language_node exists but no text input anywhere |
| No inference latency display | detector publishes fps/ms but not shown |
| No detection class counts | Available in STATE but not displayed |
| LiDAR has no object overlays | Safety rings drawn but no detected object positions |
| Fleet data not surfaced | logs exist at /opt/cobot/logs/ but not shown |

---

### Master Claude Code Prompt — v2

Built from V1-master_2_.zip audit. Adds 5 new frontend components and enriches backend broadcast:

**Backend changes (Phase 1):**
- Adds `perception{detector_fps, detector_ms, detection_count, class_counts, tracker_count, fusion_hz, annotated_active}` to STATE broadcast
- Adds `language{last_command, last_response, ollama_online, command_count}` to broadcast
- Adds `fleet{log_count, last_upload, disk_used_mb}` to broadcast
- Enriches `_on_detections` to track fps, latency, class counts
- Enriches `_on_scene` to count tracked objects
- Adds `/cmd/voice_ros` POST endpoint → publishes to `/language/text_command`
- Adds `/api/fleet` endpoint reading `/opt/cobot/logs/`
- Adds `lang_pub` publisher on `DashboardNode`

**New frontend components:**

`SceneGraphPanel.jsx` — live tracked objects list with XYZ position bars, confidence %, age since last seen, Pick button per object, human badge for persons, perception health footer.

`TaskFlowPanel.jsx` — visual 9-step workflow (IDLE → SELECT_TARGET → APPROACH → DESCEND → PICK → LIFT → PLACE → RELEASE → HOME) with pulsing active step, done checkmarks, E-STOP and person-detected warnings.

`ProximityArc.jsx` — Canvas arc showing human distance and safety zone colour updating live. Fills from left as human approaches.

`VoiceCommandBar.jsx` — text input + 6 quick command pills, wired to `/cmd/voice_ros` → language_node, shows last command and LLM response.

**CameraPanel.jsx rewrite:**
- cam0: uses `/stream/annotated` (pre-drawn bboxes) when `annotated_active` is true
- cam1: raw stream + SVG detection overlay
- Inference stats badges (fps, ms, detection count) in cam0 header
- Class count pills overlaid at bottom of cam0 image

**LidarPanel.jsx upgrade:**
- Scene graph objects from `window.__roboai_objects` drawn as coloured dots with labels
- Person objects render as pulsing circles
- Object count added to header

**MonitorLayout.jsx rewrite:**
- 4 columns: cam0 | cam1 | lidar | right-column
- Right column: ProximityArc + TaskFlowPanel + VoiceCommandBar + SceneGraphPanel

**Saved as:** `roboai_master_prompt_v2.md`

---

### Codebase Upload 2 — cobot_ws_full_tar.gz (51 MB)

Full workspace uploaded (2,219 files). This is significantly larger than V1-master_2_.zip — includes all driver submodules, Isaac ROS, Livox, ouster-sdk, diagnostics, perception_pcl, pcl_msgs, negotiated.

**New packages present (not in previous zip):**
- `src/realsense-ros/` — full Intel RealSense ROS2 driver (complete C++ source)
- `src/ouster-ros/` — full Ouster driver with complete ouster-sdk embedded
- `src/livox_ros_driver2/` — Livox MID360 support
- `src/diagnostics/` — diagnostic_updater, diagnostic_aggregator, etc.
- `src/isaac_ros_common/` — NVIDIA Isaac ROS common interfaces
- `src/isaac_ros_object_detection/` — isaac_ros_detectnet + isaac_ros_yolov8
- `src/perception_pcl/` — PCL ROS2 integration
- `src/pcl_msgs/` — PCL message types
- `src/negotiated/` — negotiated topic transport

**New frontend components already present (from v2 prompt implementation):**
- `SceneGraphPanel.jsx` ✅
- `TaskFlowPanel.jsx` ✅
- `VoiceCommandBar.jsx` ✅

**MonitorLayout.jsx** — already updated to 4-column layout with right column containing SceneGraphPanel + TaskFlowPanel + VoiceCommandBar + ProgramPanel.

**useStore.js** — already contains `perception{}`, `language{}`, `fleet{}` keys wired from WebSocket.

**dashboard_server.py** — already has:
- `perception{fps, det_count, inference_ms, annotated_active, classes}` in STATE
- `language{last_text, last_response, listening, model_name}` in STATE  
- `fleet{enabled, upload_hour, last_upload, logs_mb}` in STATE
- `_on_detections` parsing `inference_ms`, `fps`, class counts
- `/cmd/voice_ros` endpoint publishing to `/language/text_command`
- `/stream/annotated` MJPEG endpoint

**Bugs found by codebase audit:**

**Bug 1 — Critical: scene_graph format mismatch**
`scene_graph_node.py` publishes a Python dict keyed by track UUID:
```json
{"abc-123": {"track_id": "abc-123", "class_id": "bottle", "position": {"x": 0.5, "y": 0.1, "z": 0.8}}}
```
But `useStore.js` reads `d.scene_graph.objects ?? []` expecting a list, and `SceneGraphPanel.jsx` expects `obj.position` as `[x, y, z]` array. Result: SceneGraphPanel always shows "No tracked objects" even when objects are detected.

**Bug 2 — LidarPanel has no object overlays**
`LidarPanel.jsx` draws point cloud and safety rings but has zero code for drawing scene graph objects on the top-down view.

**Bug 3 — CameraPanel shows all detections on both cameras**
DetectionOverlay renders all detections regardless of `cam` prop. No filtering by camera_id. Both panels show identical boxes.

**Bug 4 — Livox MID360 type mismatch**
Dashboard server subscribes to PointCloud2 topics. Livox `livox_ros_driver2` publishes `livox_ros_driver2/msg/CustomMsg` — a completely different message type. Livox point cloud silently never appears in dashboard.

---

### Master Claude Code Prompt — v3

Built from full cobot_ws_full_tar.gz audit. Does NOT recreate already-implemented components. Focuses on the four real bugs plus driver builds and AI stack.

**Phase 1 — Fix scene_graph format mismatch (critical)**

Server-side fix in `_on_scene`: converts `{track_id: {...}}` dict to `{objects: [...]}` list with normalised `[x, y, z]` position arrays:
```python
obj_list.append({
    'id':         track_id,
    'class_name': obj.get('class_id', ...),
    'score':      round(obj.get('confidence', 1.0), 3),
    'position':   [x, y, z],   # normalised from dict to array
    'last_seen':  obj.get('last_seen', 0.0),
    'pickable':   obj.get('class_id', '') not in ('person',),
})
```
Adds `tracker_count` to `perception{}` dict. Includes verification curl command to confirm objects appear.

**Phase 2 — LiDAR object overlays**

Adds `sceneObjects` from store to `LidarPanel.jsx` via `objsRef`. Draw loop renders:
- Objects: coloured 9×9 px squares with class label + confidence pill
- Persons: pulsing red circles with white border
- Correctly maps robot frame `[x, z]` → canvas `[cx + x*scale, cy - z*scale]`

**Phase 3 — Camera detection overlay fix**

- SVG overlay only on cam0 (detections come from cam0 YOLOv8)
- Inference stats badge (fps + ms) in cam0 header
- Class count pills overlaid on cam0 image bottom-left

**Phase 4 — Livox MID360 subscription**

Adds `_on_livox` method to DashboardNode using graceful import:
```python
try:
    from livox_ros_driver2.msg import CustomMsg as LivoxMsg
    self.create_subscription(LivoxMsg, '/livox/lidar', self._on_livox, 10)
except ImportError:
    pass  # degrades gracefully if driver not built
```
Converts `CustomMsg.points` to `{x, y, z, i}` list for WebSocket broadcast.

**Phase 5 — Build all drivers**

Sequential build order with fallback rules:
1. `diagnostic_updater` (required by realsense)
2. `realsense2_camera` (with librealsense2 SDK)
3. `pcl_msgs` + `pcl_conversions` + `pcl_ros`
4. `negotiated_interfaces` + `negotiated`
5. `ouster_ros`
6. `livox_ros_driver2` (requires `export ROS_EDITION=ROS2`)
7. `isaac_ros_common` (skip VPI-dependent packages)
8. Full workspace rebuild

**Phase 6 — NVIDIA AI stack**
- YOLOv8n TensorRT INT8 export → `/opt/cobot/models/yolov8n.engine`
- Ollama install + `llama3.1:8b` pull (5GB)
- Whisper base model install + verify

**Phase 7 — Frontend build + smoke test**

Includes API state verification commands to confirm scene_graph.objects is a list, perception keys present, voice_ros endpoint works.

**Phase 8 — Launch file wiring**

Adds `use_livox` and `use_ouster` launch args, conditional sensor launches, capability summary log.

**Phase 9 — Full commit to GitHub master**

**Phase 10 — CLAUDE.md update** with complete status, key decisions, and ROS2 topic → dashboard panel mapping table.

**Saved as:** `roboai_master_prompt_v3.md`

---

### ROS2 Topic → Dashboard Panel Mapping (Current)

| ROS2 Topic | Dashboard Location |
|------------|-------------------|
| `/perception/detections` | CameraPanel cam0 SVG overlay + inference stats badges + class count pills |
| `/perception/scene_graph` | SceneGraphPanel (right column) + LidarPanel object dots |
| `/perception/annotated_image` | CameraPanel cam0 MJPEG stream (when annotated_active=true) |
| `/lidar/points` OR `/livox/lidar` | LidarPanel top-down point cloud |
| `/safety/status` | SafetyBanner (top) + ControlStrip zone badge |
| `/safety/human_proximity` | Safety zone computation → speed scale |
| `/task/status` | TaskFlowPanel 9-step indicator (right column) |
| `/language/text_command` | VoiceCommandBar send → language_node |
| `/language/response` | VoiceCommandBar response display |
| `/joint_states` | ArmViewer3D (3D arm) + ControlStrip joint display |
| `/cam0/color/image_raw` | CameraPanel cam0 raw stream |
| `/cam1/color/image_raw` | CameraPanel cam1 raw stream + SVG overlay |

---

### Updated Project Status (May 21 2026)

| Item | Status |
|------|--------|
| WSL + VS Code + Claude Code (laptop) | ✅ Done |
| GitHub org: Ai-Robotics-Prototype, repo: V1 | ✅ Done |
| Jetson SSH over WiFi (192.168.1.246) | ✅ Done |
| Docker container cobot_ros — --restart always | ✅ Done |
| Dashboard auto-starts on boot | ✅ Done |
| Sleep/suspend permanently disabled | ✅ Done |
| All 14+ ROS2 packages building cleanly | ✅ Done |
| React frontend (Vite + Zustand) | ✅ Done |
| Dashboard backend — perception/language/fleet broadcast | ✅ Done |
| /cmd/voice_ros → /language/text_command | ✅ Done |
| SceneGraphPanel component | ✅ Done |
| TaskFlowPanel component | ✅ Done |
| VoiceCommandBar component | ✅ Done |
| CameraPanel — annotated stream + inference stats | ✅ Done |
| 4-column MonitorLayout | ✅ Done |
| scene_graph format mismatch bug fix | 🔄 In prompt v3 — not yet applied |
| LidarPanel object overlays | 🔄 In prompt v3 — not yet applied |
| Camera detection per-cam filtering | 🔄 In prompt v3 — not yet applied |
| Livox MID360 CustomMsg subscription | 🔄 In prompt v3 — not yet applied |
| RealSense driver built | 🔄 In prompt v3 — not yet applied |
| Ouster driver built | 🔄 In prompt v3 — not yet applied |
| Livox driver built | 🔄 In prompt v3 — not yet applied |
| YOLOv8n TensorRT .engine | 🔄 In prompt v3 — not yet applied |
| Ollama + Llama 3.1 8B | 🔄 In prompt v3 — not yet applied |
| Whisper base model | 🔄 In prompt v3 — not yet applied |
| First sensor bag with real hardware | ⏳ Needs hardware |
| Extrinsic calibration | ⏳ Needs hardware |
| Safety zone testing | ⏳ Needs hardware |
| First autonomous pick/place | ⏳ Needs hardware |

### Key Decisions Made This Session
- **Codebase audit before prompting** — v3 prompt was built by reading actual source files, finding four specific bugs rather than guessing. Avoids recreating already-implemented components.
- **scene_graph format normalised server-side** — converting dict→list in dashboard_server.py is cleaner than changing the frontend to handle both formats. scene_graph_node.py publishing format left unchanged.
- **Livox graceful import** — `try/except ImportError` in DashboardNode means the Livox subscription degrades silently if the driver isn't built yet, rather than crashing the whole server.
- **Detection overlay cam0-only** — detections come from YOLOv8 running on cam0. Showing them on cam1 is misleading. cam1 shows raw stream, cam0 gets the annotated stream or SVG overlay.
- **Driver build order matters** — `diagnostic_updater` must build before `realsense2_camera`. `negotiated` must build before Isaac ROS. `export ROS_EDITION=ROS2` required for `livox_ros_driver2`.
- **Claude Code ↔ GitHub** — Claude Code can clone repos directly during a session, making it the primary install method for all ROS packages when apt is broken.
- **tmux essential for long builds** — YOLOv8 TensorRT export, Ollama model pull (5GB), and nvblox build all take long enough that SSH dropout would kill the session.

---

*Last updated: May 21 2026*  
*Covers: NVIDIA AI integration strategy (nvblox, FoundationPose, NanoOWL, RTMPose), Claude Code ↔ GitHub workflow, ROS2 apt repo broken explanation, full codebase audit of V1-master_2_.zip and cobot_ws_full_tar.gz (51MB / 2219 files), four bugs found and fixed (scene_graph format mismatch, LiDAR object overlays, camera detection filtering, Livox CustomMsg type), three master Claude Code prompts generated (v1 from project MD, v2 from V1-master zip, v3 from full workspace tar)*

---

## 38. Session Log — May 22–26 2026
### JetPack 6 Flash, Full Stack Rebuild, Dashboard Overhaul

**Last Updated**: May 26 2026  
**Covers**: JetPack 6.2.2 flash via SDK Manager, full stack rebuild natively on JetPack 6, hardware status (cameras + LiDAR confirmed working), dashboard overhaul (light theme, production server, real sensor wiring), Claude Code workflow on Jetson, copy/paste fix

---

### Hardware Status — Confirmed Working

| Hardware | Status | Notes |
|----------|--------|-------|
| RealSense D435i (cam0) | ✅ Working | 30Hz color + depth, librealsense2 v2.57.7 built from source |
| RealSense D435i (cam1) | ✅ Connected | Same driver, second camera |
| Ouster OS1-32 LiDAR | ✅ Working | Powered on, Ethernet at 192.168.1.100, driver built |
| YOLOv8n TensorRT | ✅ Working | 86.4 FPS at 640×640 FP16, engine at /opt/cobot/models/yolov8n.engine |
| Object detection | ✅ Working | Cameras detecting objects before flash |
| Sensor bag recorded | ✅ Done | 4.1 GiB, /opt/cobot/bags/first_sensor_test.bag |

**Note:** All hardware was working on JetPack 5.1.2. The reason for flashing to JetPack 6 was to enable the full Isaac ROS / nvblox stack which requires JetPack 6 / CUDA 12.x.

---

### Why JetPack 6 Was Required

JetPack 5.1.2 had two blocking issues:
1. The `isaac_ros_nitros` and `gxf` packages ship CUDA 13.0 binaries — incompatible with JetPack 5's CUDA 11.4
2. The apt ROS2 GPG key had expired, blocking all `apt install ros-humble-*` operations

JetPack 6.2.2 resolves both: CUDA 12.6, working apt repo, Ubuntu 22.04, Isaac ROS 4.x support.

---

### JetPack 6.2.2 Flash — What Happened

**The VirtualBox driver problem:**  
Every flash attempt failed because an orphaned VirtualBox USB driver (`oem159.inf`, service `VBoxUSB`) was intercepting the Jetson's USB connection. This was the root cause of all "Flash of target hardware was skipped" failures. Fixed by:
```powershell
pnputil /delete-driver oem159.inf /uninstall /force
shutdown /r /t 0
```

**Flash method that worked:**  
SDK Manager 2.4.0 Windows GUI version (not WSL). After removing the VirtualBox driver, APX appeared cleanly under Windows Device Manager → Universal Serial Bus devices, and SDK Manager detected and flashed successfully.

**Flash details:**
- Tool: SDK Manager 2.4.0-13236 (Windows .exe)
- Version: JetPack 6.2.2 (L4T R36.5.0)
- Storage: eMMC (default)
- Username: teddy / Password: aicollabs12
- Result: Ubuntu 22.04, CUDA 12.6, R36.5.0 confirmed via `cat /etc/nv_tegra_release`

**Issues encountered during flash process:**
| Issue | Resolution |
|-------|-----------|
| SDK Manager .deb URL 404 | Downloaded from developer.nvidia.com manually |
| WSL USB connection dropping mid-flash | Switched to Windows SDK Manager GUI |
| VirtualBox USB driver intercepting device | `pnputil /delete-driver oem159.inf /uninstall /force` |
| APX showing in Persisted not Connected | Was using USB-A to USB-C cable — needed USB-C to USB-C |
| Blank password on first boot | Ran `sudo passwd teddy` to set aicollabs12 |
| GRUB not appearing on boot | Default GRUB_TIMEOUT=0 — not needed after password set |

---

### JetPack 6 Stack Rebuild — What Claude Code Did (46 min session)

After the flash, Claude Code ran the full setup prompt and completed:

| Component | Status | Notes |
|-----------|--------|-------|
| ROS2 Humble (native, no Docker) | ✅ | Installed via apt on Ubuntu 22.04 |
| All 14 packages colcon build | ✅ | Clean build (CUDA warnings only) |
| CUDA nvcc 12.6 | ✅ | /usr/local/cuda-12.6/bin/nvcc |
| cuFFT dev | ✅ | Required by cuda_pointcloud |
| Isaac ROS NITROS 3.2.5 | ✅ | Via apt release-3.0 component |
| Python stack (open3d, ultralytics, mediapipe) | ✅ | All installed |
| Ollama 0.24.0 + Llama 3.1 8B (4.9GB) | ✅ | Running on :11434 |
| Whisper base model | ✅ | Offline speech-to-text |
| YOLOv8n model | ✅ | /opt/cobot/models/yolov8n.pt (6.2MB) |
| Dashboard frontend (Vite build) | ✅ | Built to mock_server/static/ |
| Mock server health | ✅ | {"status":"ok","mock":true} |
| Docker + NVIDIA runtime | ✅ | Configured for GPU containers |
| ~/.bashrc | ✅ | ROS2, workspace, CUDA, ~/.local/bin sourced |

**Build fixes Claude Code made automatically:**
- `package.xml` emails `robot@cobot` → `robot@cobot.local` (rosdep rejected them)
- `$NVBLOX_ENABLED` condition in `occupancy_map/package.xml` removed (unsupported catkin_pkg syntax)
- Isaac ROS repo component `main` → `release-3.0`
- Colcon argument ordering bug: `CUDAToolkit_ROOT` moved into `colcon_defaults.yaml`

---

### ROS2 Path on JetPack 6

**Important change from JetPack 5:**

| Version | ROS2 source path |
|---------|-----------------|
| JetPack 5 (old) | `source /opt/ros/humble/install/setup.bash` (non-standard) |
| JetPack 6 (current) | `source /opt/ros/humble/setup.bash` (standard) |

The dustynv image on JetPack 5 used a non-standard install path. Native JetPack 6 install uses the standard path.

---

### Sensor Drivers on JetPack 6

All drivers rebuilt natively (no Docker):

```bash
# RealSense — working
ros2 launch realsense2_camera rs_launch.py \
  camera_namespace:=cam0 \
  align_depth.enable:=true \
  pointcloud.enable:=true
# /cam0/color/image_raw @ 30Hz ✅
# /cam0/depth/image_rect_raw @ 30Hz ✅

# Ouster LiDAR — working
# eth0 configured at 192.168.1.200/24
# Ouster at 192.168.1.100
python3 src/cobot_bringup/scripts/ouster_bridge.py
# /lidar/points (PointCloud2) ✅

# Object detection
ros2 run object_detection detector_node
# /perception/detections ✅
# /perception/annotated_image ✅ (Pillow-drawn boxes)
```

---

### Dashboard Status After JetPack 6 Rebuild

**Current state:** Mock server running on :8080. Frontend built and served. Mock server shows simulated data — not real sensor data.

**Root cause of simulation-only display:**  
The production `dashboard_server.py` only subscribes to 5 topics and has no camera subscriptions, no MJPEG endpoints, and no `/ws/lidar` WebSocket. The mock server (`mock_server/server.py`) has all these but is completely disconnected from ROS2.

**Dashboard overhaul prompt generated** (roboai_dashboard_overhaul_prompt.md) addresses:

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Camera feeds show black | Production server has no camera subscriptions | Added `/cam0/color/image_raw` and `/cam1/color/image_raw` subscriptions + PIL JPEG conversion |
| Bounding boxes float over black | No real camera feed behind them | Fixed by providing real MJPEG + annotated stream |
| Left nav buttons don't work | Tiny tap targets, no visual feedback | Larger buttons, active left-border indicator, mesh view added |
| LiDAR shows simulation | No `/ws/lidar` endpoint in production server | Added PointCloud2 subscription + 15Hz async broadcaster |
| No 3D reconstruction | nvblox publishes mesh but nothing subscribes | Added `/nvblox_node/mesh` subscription + `/ws/mesh` WebSocket + MeshViewer component |
| Dark theme | Default dark CSS variables | New light industrial theme (white panels, dark text, #1D6FD8 blue) |
| NVIDIA software not shown | Production server didn't subscribe to NVIDIA topics | Added detections, scene_graph, annotated image, nvblox mesh |

---

### Claude Code Copy/Paste Fix (Jetson Workflow)

**Problem:** After starting Claude Code on the Jetson, the terminal UI intercepts mouse events and blocks copy/paste between Firefox (Claude chat) and the terminal.

**Solution that works:**

Terminal 1 — run Claude Code with logging:
```bash
cd /home/teddy/cobot_ws
script -f ~/claude_output.log -c "claude --dangerously-skip-permissions"
```

Terminal 2 — copy output from:
```bash
tail -f ~/claude_output.log
```

Copy from Terminal 2 to Firefox: select text → **Ctrl+Shift+C** → paste in Firefox  
Copy from Firefox to Claude Code: **Ctrl+C** in Firefox → click Terminal 1 → **Ctrl+Shift+V**

**Other useful Claude Code settings:**
```bash
claude config set -g autoApprove true
claude config set -g skipPermissions true
```

**Passwordless sudo for Claude Code:**
```bash
echo "teddy ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/teddy-nopasswd
sudo chmod 440 /etc/sudoers.d/teddy-nopasswd
# Revoke when done: sudo rm /etc/sudoers.d/teddy-nopasswd
```

---

### Tools Installed on Jetson (JetPack 6)

| Tool | Install method | Purpose |
|------|---------------|---------|
| Terminator | `sudo apt install terminator` | Better terminal with split panes |
| Firefox | `sudo apt install firefox` | Browser for claude.ai on Jetson |
| Node.js v20.19.0 | tarball from nodejs.org | Required for Claude Code |
| Claude Code | `sudo npm install -g @anthropic-ai/claude-code` | AI coding assistant |
| xclip | `sudo apt install xclip` | Clipboard support |
| SSH server | `sudo apt install openssh-server` | Remote access from laptop |

---

### GitHub Token Note

**IMPORTANT:** The GitHub PAT `[REDACTED_GHP_TOKEN_1]` was accidentally exposed in a terminal session and should be considered compromised. Generate a new token at:  
GitHub → Settings → Developer Settings → Personal Access Tokens → Generate new token

---

### Current Codebase — V1-main (May 26 2026)

The latest uploaded codebase (`V1-main_1_.zip`) contains the following improvements over the original:

**New files:**
- `src/cobot_dashboard/mock_server/server.py` — zero-ROS2 mock server with full simulation
- `src/cobot_dashboard/mock_server/README.md`
- `PROJECT.md` — complete project reference document

**Bug fixes applied (from previous prompts):**
- `sensor_fusion_node.py` — `ApproximateTimeSynchronizer` replaced with timer-driven fusion (cameras optional)
- `scene_graph_node.py` — added `det_pos[2] <= 0.0` check for invalid depth
- `detection.yaml` — confidence_threshold lowered 0.5 → 0.35
- `perception.yaml` — voxel_size 0.025 → 0.05, publish_hz: 15.0 added
- `colcon_defaults.yaml` — CUDAToolkit_ROOT added for CUDA builds
- All `package.xml` files — emails fixed to `robot@cobot.local`

**Frontend (React + Vite + Zustand) — current components:**
- `LidarPanel.jsx` — full 3D point cloud using `@react-three/fiber` with orbit controls, safety zone rings, height colour ramp
- `CameraPanel.jsx` — MJPEG stream with SVG detection overlay, FPS badge
- `ArmViewer3D.jsx` — 3D robot arm visualization
- `MonitorLayout.jsx` — split cameras | lidar | arm | scene | safety views
- `SceneGraphPanel.jsx` — tracked objects table
- `ControlStrip.jsx` — run/pause/home/jog/gripper controls
- `SideNav.jsx` — view selector buttons
- `useStore.js` — Zustand store with WebSocket management, exponential backoff

---

### Start Commands (JetPack 6, Native ROS2)

```bash
# Source environment
source /opt/ros/humble/setup.bash
source /home/teddy/cobot_ws/install/setup.bash
source /home/teddy/cobot_ws/scripts/aliases.sh

# Launch cameras
ros2 launch realsense2_camera rs_launch.py \
  camera_namespace:=cam0 align_depth.enable:=true &
ros2 launch realsense2_camera rs_launch.py \
  camera_namespace:=cam1 align_depth.enable:=true &

# Launch LiDAR
python3 /home/teddy/cobot_ws/src/cobot_bringup/scripts/ouster_bridge.py &

# Launch object detection
ros2 run object_detection detector_node &

# Launch perception fusion
ros2 run perception_fusion sensor_fusion_node &

# Launch dashboard (production — real sensor data)
python3 /home/teddy/cobot_ws/src/cobot_dashboard/cobot_dashboard/dashboard_server.py &

# OR launch mock server (simulation — no hardware needed)
cd /home/teddy/cobot_ws/src/cobot_dashboard/mock_server
python3 server.py &

# Access dashboard from laptop Chrome:
# http://192.168.1.246:8080
```

---

### Updated Project Status (May 26 2026)

| Item | Status |
|------|--------|
| JetPack 6.2.2 (L4T R36.5.0) | ✅ Flashed and running |
| Ubuntu 22.04 | ✅ |
| CUDA 12.6 | ✅ |
| ROS2 Humble (native) | ✅ |
| All 14 packages building | ✅ |
| Isaac ROS NITROS 3.2.5 | ✅ Via apt |
| YOLOv8n TensorRT engine | ✅ /opt/cobot/models/yolov8n.engine |
| YOLOv8n .pt model | ✅ /opt/cobot/models/yolov8n.pt |
| Ollama + Llama 3.1 8B | ✅ Running on :11434 |
| Whisper base | ✅ |
| RealSense driver (both cameras) | ✅ Built from source |
| Ouster LiDAR driver | ✅ Built and powered |
| Object detection with bboxes | ✅ Working (was working before flash) |
| Sensor bag (4.1 GiB) | ✅ /opt/cobot/bags/first_sensor_test.bag |
| Dashboard mock server | ✅ Running on :8080 |
| Dashboard frontend built | ✅ React + Vite |
| 3D point cloud viewer | ✅ @react-three/fiber |
| Production server camera wiring | 🔄 Overhaul prompt generated |
| Production server LiDAR wiring | 🔄 Overhaul prompt generated |
| nvblox mesh in dashboard | 🔄 Overhaul prompt generated |
| Light theme | 🔄 Overhaul prompt generated |
| SSH from laptop | ⚠️ Needs openssh-server started |
| Safety zone testing | ⏳ |
| First autonomous pick/place | ⏳ |
| Cobot arm selected/connected | ⏳ Estun S10-140 under evaluation |

### Key Decisions Made This Session
- **No Docker** — JetPack 6 with native ROS2 is cleaner and simpler than Docker on JetPack 5
- **Windows SDK Manager GUI** for flashing — WSL USB was too unstable; Windows GUI handles USB natively
- **USB-C to USB-C cable required** for flashing — USB-A to USB-C was charge-only
- **VirtualBox driver was root cause** of all flash failures — orphaned `oem159.inf` intercepted USB
- **Mock server vs production server** — mock server runs for UI testing without ROS2; production server needed for real sensor data
- **script -f ~/claude_output.log** is the solution for Claude Code copy/paste on the Jetson
- **Passwordless sudo** required for Claude Code to install packages autonomously
- **Dashboard overhaul needed** — production server must replace mock server to show real camera/lidar data
- **Estun S10-140** cobot under evaluation — needs communication protocol document from supplier

---

*Last updated: May 26 2026*  
*Covers: JetPack 6.2.2 flash (VirtualBox driver fix, USB-C cable, SDK Manager Windows GUI), full stack rebuild natively (46min Claude Code session), all 14 packages building, Isaac ROS NITROS via apt, hardware confirmed working (both RealSense cameras, Ouster LiDAR, YOLOv8 TRT 86.4FPS), dashboard overhaul prompt (production server wiring, light theme, real camera/lidar feeds, nvblox mesh view), Claude Code copy/paste workflow fix (script -f), passwordless sudo setup*

---

## 39. Session Log — May 20–21 2026
### Robot Controller with Camera and LiDAR Visualization

**Last Updated**: May 21 2026  
**Covers**: Standard Bots-style controller design, full React dashboard build prompt, LiDAR pointcloud + YOLOv8 detection + annotated camera feeds, ouster UDP bridge, dashboard server rewrites, complete perception stack prompt

---

### Origin of This Session

Theodore requested a complete working robot controller accessible via IP address, running from the GitHub codebase on the Jetson, showing:
- What the cameras are seeing (both cameras)
- LiDAR and 2.5D camera visualization
- Recognized/detected objects
- Interface closely mimicking **Standard Bots** controller for iPad/tablet

---

### Standard Bots Interface Analysis

Standard Bots' key interface features identified for replication:
- Left navigation rail with icon tabs (Monitor, Program, 3D View, Sensors, Settings)
- E-Stop always visible in the nav rail / top-right header
- Clean dark chrome with very thin borders — no heavy UI chrome
- Program panel on the right — visual step list, not code
- Safety status always at top in a coloured band
- 3D robot arm viewer with live joint angles
- No-code visual programmer (drag-and-drop steps)
- Real camera + LiDAR feeds
- Tablet/mobile optimised layout

---

### Three Mode System Designed

```
┌─────────────────────────────────────────┐
│           COBOT CONTROL APP             │
├─────────────────────────────────────────┤
│  🟢 OPERATOR MODE  │ Simple, safe, fast │
│  🔵 ENGINEER MODE  │ Full control       │
│  🔴 ADMIN MODE     │ Config & fleet     │
└─────────────────────────────────────────┘
```

**Operator Mode** (floor workers):
- Large GO / STOP / PAUSE buttons
- Big GREEN/YELLOW/RED safety zone indicator
- Current task in plain English
- Voice command button
- Camera feed
- Task library — saved routines
- Emergency stop always visible
- No settings, no configuration

**Engineer Mode** (full control):
- Everything in Operator plus:
- Live 3D robot visualizer
- Manual joint jog controls
- ROS2 topic monitor
- Task builder drag-and-drop
- Scene graph live table
- Sensor feeds
- Safety zone configuration
- System logs and performance metrics
- Record and replay tasks

**Admin Mode**:
- Everything in Engineer plus:
- Multi-robot fleet dashboard
- OTA model update management
- User management
- Calibration tools

---

### Design System (Match Standard Bots Aesthetic)

```css
/* Dark theme primary */
--bg-app:       #0A0A0B
--bg-panel:     #141416
--bg-surface:   #1C1C1F
--bg-hover:     #242428
--border:       rgba(255,255,255,0.08)
--border-focus: rgba(255,255,255,0.20)
--text-primary: #F0F0F2
--text-secondary:#A0A0A8
--text-muted:   #5A5A62
--accent-blue:  #2F7FFF
--zone-green:   #00C47A
--zone-yellow:  #F5A623
--zone-red:     #FF3B3B
--zone-estop:   #FF0033

/* Typography */
Font: Inter (Google Fonts fallback → system-ui)
Base: 14px, line-height 1.5
Headings: 500 weight. No bold (700) anywhere.
Labels: 11px uppercase letter-spacing 0.08em

Layout: CSS Grid. No flexbox-only layouts.
Corners: 8px radius panels, 6px buttons, 4px inputs.
Transitions: 120ms ease state changes, 200ms panels.
```

---

### Codebase Audit Before Building (V1-master.zip)

Full audit of the uploaded codebase revealed:

**dashboard_server.py** — well-written, has:
- MJPEG camera streams `/stream/cam0`, `/stream/cam1`
- WebSocket `/ws/lidar` (with sim fallback)
- WebSocket `/ws/state` at 25Hz
- ROS2 node subscribing to safety, task, joint states
- PointCloud2 → JSON conversion helper
- BUT: camera topics were `/cam0/cam0/color/image_raw` (double namespace bug)

**detector_node.py** — exists and functional:
- YOLOv8n TensorRT FP16 engine at `/opt/cobot/models/yolov8n.engine`
- Fallback to `/opt/cobot/models/yolov8n.pt`
- cv2 stub already in place (cv2 broken in container)
- Publishes `/perception/detections` (JSON String)
- Publishes `/perception/annotated_image` (Pillow-drawn boxes)

**ouster_bridge.py** — not yet in repo, needed to be created:
- Ouster at 192.168.1.150 UDP port 56201
- eth0 must be configured at 192.168.1.200/24
- Auto-detects beam format
- Publishes `/lidar/points` (PointCloud2)

---

### Confirmed Hardware Facts (Before JetPack 6 Flash)

These facts were confirmed and used in all prompts:
```
Jetson AGX Orin JetPack 5.1.2 Ubuntu 20.04 ARM64
Docker container: cobot_ros
ROS2 at: /opt/ros/humble/install/setup.bash
Workspace: /home/teddy/cobot_ws (all packages built)
Camera 0: serial 134322070161, topic /cam0/cam0/color/image_raw
Camera 1: serial 101622073355, topic /cam1/cam1/color/image_raw
LiDAR: Ouster at 192.168.1.150, UDP port 56201
eth0: must be 192.168.1.200/24
cv2: BROKEN — cv2 stub already exists, do not remove
Isaac ROS: requires JetPack 6 — do not install on JetPack 5
YOLOv8: TRT engine at /opt/cobot/models/yolov8n.engine
Dashboard URL: http://192.168.1.246:8080
```

---

### What Needed to Be Fixed (from codebase audit)

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| LiDAR not producing detailed pointcloud | ouster_bridge.py not in repo | Create ouster bridge with UDP listener |
| Object detection not showing | detector_node not launched | Create cameras.launch.py + launch detector |
| Dashboard not showing real feeds | Double namespace `/cam0/cam0/` | Fix topic names in dashboard_server.py |
| No annotated stream | `/stream/annotated` endpoint missing | Add MJPEG endpoint for annotated image |
| Jog buttons non-functional | `RobotControls.jsx` wrong import path | Fix import `'../store'` → `'../store/useStore'` |
| Safety banner broken | `SafetyBanner.jsx` wrong import + phantom action | Fix import + remove `setPendingEstop` |

---

### Complete Perception Stack Prompt Generated

The final consolidated Claude Code prompt covered 11 steps:

**STEP 1 — OUSTER UDP BRIDGE**
Create `src/cobot_bringup/scripts/ouster_bridge.py`:
- Configure eth0 to 192.168.1.200/24
- Connect to Ouster at 192.168.1.150:56201 UDP
- Auto-detect beam format (OS1-32 = 32 beams)
- Publish `/lidar/points` as PointCloud2
- TCP config on port 7501 to set `udp_dest=192.168.1.200`

**STEP 2 — FIX DETECTOR TOPIC NAMES**
In `detector_node.py` fix subscriptions:
- `/cam0/cam0/color/image_raw` → `/cam0/cam0/color/image_raw` (was already correct in some versions)
- `/cam0/aligned_depth_to_color/image_raw`
- `/cam0/color/camera_info`
Note: cv2 stub must be preserved

**STEP 3 — CAMERAS LAUNCH FILE**
Create `src/cobot_bringup/launch/cameras.launch.py`:
- Launch cam0 RealSense with serial 134322070161
- Launch cam1 RealSense with serial 101622073355
- namespace: cam0 and cam1
- align_depth.enable: true, pointcloud.enable: true

**STEP 4 — FIX DASHBOARD SERVER**
Fix `dashboard_server.py`:
- Fix camera topic subscriptions (double namespace)
- Add `/stream/annotated` MJPEG endpoint
- Include detections and scene_graph in `/ws/state` broadcast
- PointCloud2 → JSON conversion for `/ws/lidar`
- Sim fallback when no real LiDAR data

**PointCloud2 → JSON conversion helper:**
```python
import struct

def pointcloud2_to_json(msg, max_points=3500):
    points = []
    point_step = msg.point_step
    data = msg.data
    total = len(data) // point_step
    if total > max_points:
        import random
        indices = random.sample(range(total), max_points)
    else:
        indices = range(total)
    for i in indices:
        offset = i * point_step
        try:
            x, y, z = struct.unpack_from('fff', data, offset)
            inten = struct.unpack_from('f', data, offset+12)[0]
            if not (abs(x) < 50 and abs(y) < 50 and abs(z) < 20):
                continue
            if x == 0.0 and y == 0.0 and z == 0.0:
                continue
            points.append({
                'x': round(x, 3), 'y': round(y, 3),
                'z': round(z, 3),
                'i': round(min(max(inten/255.0, 0), 1), 2)
            })
        except Exception:
            continue
    return points
```

**STEP 5 — FULL PERCEPTION LAUNCH FILE**
Create `src/cobot_bringup/launch/perception.launch.py`:
- cam0 realsense2_camera node
- cam1 realsense2_camera node (serial as argument)
- ouster lidar node (sensor_hostname as argument)
- detector_node (object_detection package)
  - engine_path: /opt/cobot/models/yolov8n_fp16.engine
  - camera_topic: /cam0/color/image_raw
  - depth_topic: /cam0/aligned_depth_to_color/image_raw
  - confidence_threshold: 0.45
  - publish_annotated: true
- scene_graph_node
- dashboard_server node

Launch arguments:
- cam1_serial (default: "")
- lidar_ip (default: "192.168.1.1")
- confidence (default: "0.45")
- use_lidar (default: "true") — skip lidar node if false

**STEP 6 — FIX FRONTEND IMPORTS**
Fix broken imports in:
- `RobotControls.jsx`: `'../store'` → `'../store/useStore'`
- `SafetyBanner.jsx`: fix import + remove `setPendingEstop` (phantom action)

**STEP 7 — BUILD**
```bash
colcon build --packages-select cobot_dashboard object_detection cobot_bringup \
  --cmake-args -DCMAKE_BUILD_TYPE=Release
source install/setup.bash
```

**STEP 8 — VERIFICATION**
```bash
# Verify all topics
timeout 6 ros2 topic hz /lidar/points
timeout 6 ros2 topic hz /perception/detections
timeout 6 ros2 topic hz /cam0/cam0/color/image_raw

# Verify dashboard endpoints
curl http://localhost:8080/health
curl http://localhost:8080/api/state
# Verify MJPEG streams return JPEG data
```

**STEP 9 — FALLBACK DIAGNOSTICS**
```bash
# If lidar no data:
ip addr show eth0 | grep "192.168.1.200"
ping -c 3 192.168.1.150
# Restart bridge: python3 src/cobot_bringup/scripts/ouster_bridge.py

# If cameras no topics:
cat /tmp/cameras.log | grep -E "ERROR|WARN|serial|Stream"
# Check blue USB3 ports are used

# If detector model load failure:
python3 -c "from ultralytics import YOLO; m=YOLO('/opt/cobot/models/yolov8n.pt'); print('model OK')"
```

**STEP 10 — COMMIT**
```bash
git add src/object_detection/ src/cobot_bringup/scripts/ \
        src/cobot_dashboard/ src/scene_graph/
git commit -m "feat: LiDAR pointcloud + YOLOv8 detection + annotated feeds all live on dashboard"
git push
```

---

### Perception Stack Status After This Session

```
## Object Detection
  Engine: /opt/cobot/models/yolov8n.engine (TRT FP16) or yolov8n.pt fallback
  Camera in:  /cam0/cam0/color/image_raw
  Depth in:   /cam0/aligned_depth_to_color/image_raw
  Output:     /perception/detections (JSON String — class, score, 3D pos, pickable)
  Annotated:  /perception/annotated_image (Pillow-drawn boxes, no cv2)
  Run: ros2 run object_detection detector_node

## LiDAR Bridge
  Sensor: Ouster at 192.168.1.150 UDP 56201
  eth0 must be 192.168.1.200/24 (auto-set by bridge at startup)
  TCP config: tries port 7501 to set udp_dest=192.168.1.200
  Output: /lidar/points (PointCloud2, auto-detected beam format)
  Run: python3 src/cobot_bringup/scripts/ouster_bridge.py

## Dashboard
  URL: http://192.168.1.246:8080
  /stream/cam0      — live RealSense cam0 MJPEG
  /stream/cam1      — live RealSense cam1 MJPEG
  /stream/annotated — cam0 with YOLOv8 bounding boxes
  /ws/lidar         — real PointCloud2 → 8000pt JSON (sim fallback)
  /ws/state         — robot state 25Hz

## Start All
  ros2 launch cobot_bringup cameras.launch.py &
  python3 src/cobot_bringup/scripts/ouster_bridge.py &
  ros2 run object_detection detector_node &
  python3 src/cobot_dashboard/cobot_dashboard/dashboard_server.py
```

---

### Commercial-Ready Controller Build Prompt (Full Version)

The complete prompt for building the full commercial controller covered:

**Backend additions to dashboard_server.py:**
- Speed override endpoint `POST /cmd/speed` (0.0–1.0)
- Teach point save/load (`/opt/cobot/calibration/saved_points.json`)
- Program save/load (`/opt/cobot/programs/`)
- Audit log endpoint `GET /api/log`
- Joint torque display (if available from robot driver)
- Fault recovery endpoint `POST /cmd/fault_reset`
- CycloneDDS config at `/opt/cobot/cyclonedds.xml` restricting to wlan0

**Frontend additions:**
- Speed override slider in ControlStrip
- Saved teach points panel (Teach/Rename/Delete)
- Teach mode: select point → jog robot → Confirm saves TCP pose
- Program save/load with search and tags
- Fault recovery panel
- Joint torque display
- Operator audit log view
- Proper 3D arm with UR5e proportions and DH parameter axis mapping

**DH parameter axis mapping for 3D arm:**
```javascript
joint_positions[0] → J1.rotation.y  (base)
joint_positions[1] → J2.rotation.z  (shoulder)
joint_positions[2] → J3.rotation.z  (elbow)
joint_positions[3] → J4.rotation.x  (wrist1)
joint_positions[4] → J5.rotation.z  (wrist2)
joint_positions[5] → J6.rotation.x  (wrist3)
```

**Browser verification checklist:**
```
✓ Dashboard loads with React UI
✓ Safety banner shows GREEN/YELLOW/RED cycling
✓ E-STOP button triggers overlay
✓ Switch to Engineer mode
✓ Enable jog — J1 +1° moves arm in 3D viewer
✓ Arm forms L-shape (not straight pole)
✓ Home button animates arm to home position
✓ Speed override slider changes speed scale
✓ TCP position shows in engineer mode
✓ Program: add a Move step using current position
✓ Program: save program, load it back
✓ Log tab shows all commands with timestamps
✓ Camera panels show MJPEG frames
✓ LiDAR panel shows point cloud
```

---

### Key Decisions Made This Session
- **Pillow (PIL) for annotation rendering** — cv2 is broken in the JetPack 5 container, Pillow draws bounding boxes instead
- **Sim fallback in dashboard** — `/ws/lidar` falls back to simulated scatter points when no real LiDAR data arrives, with LIVE/SIM badge
- **use_lidar launch arg** — perception.launch.py skips LiDAR node if `use_lidar:=false` so stack works camera-only
- **CycloneDDS config** — restricts ROS2 DDS to wlan0 only; configuring eth0 for LiDAR was breaking all ROS2 DDS communication
- **TRT engine FP16** — yolov8n_fp16.engine for best speed/accuracy tradeoff on Jetson Orin
- **confidence_threshold: 0.45** — balanced for detecting objects without too many false positives
- **3500 point max** for LiDAR JSON — keeps WebSocket payload small while showing useful density

---

*Last updated: May 21 2026*  
*Covers: Standard Bots-style controller design (3 modes: Operator/Engineer/Admin), design system tokens (dark theme), codebase audit (dashboard_server.py, detector_node.py, LidarPanel.jsx), confirmed hardware facts (camera serials, LiDAR IP/port, cv2 broken), complete perception stack prompt (ouster bridge, cameras launch, fix detector topics, fix frontend imports, annotated stream endpoint, PointCloud2→JSON helper), commercial-ready controller build prompt (speed override, teach points, program save/load, audit log, fault recovery)*

---

## 40. Session Log — May 20 2026
### AI Vision Use Cases + FANUC CRX Analysis + Estun S10-140 Selection

**Last Updated**: May 20 2026  
**Covers**: AI vision use cases for cobots, FANUC CRX ROS2 driver analysis, Estun S10-140 ECO selection and integration risk assessment

---

### AI Vision Use Cases for Collaborative Robots

Theodore asked: "What are the best use cases for implementing AI vision into our collaborative robots?"

The highest-value use cases ordered by impact:

**1. Safety & Human Monitoring** (already in stack as `human_safety`)  
Skeleton tracking via MediaPipe/RTMPose computing real-time distance from human keypoints to robot TCP, driving ISO 10218 speed-separation zones. Without this the robot can't legally operate near people.

**2. Object Detection & Pick Planning** (`object_detection` package, YOLOv8 TensorRT)  
Knowing object class, pose, and orientation lets the task planner choose the right grasp angle, approach vector, and gripper width. Fleet learning captures which grasp angles succeed — 10,000+ picks across fleet reveals which objects are hardest.

**3. 6DOF Pose Estimation** (FoundationPose in offline vision models table)  
Instead of "bottle at XYZ," the robot knows the bottle's exact 3D orientation. Particularly valuable for irregular or non-symmetric objects.

**4. Bin Picking / Clutter** (YOLOv8-seg + fused pointcloud)  
When objects are piled or partially occluded, pure RGB detection fails. Depth + segmentation lets planner find topmost graspable object and avoid collisions.

**5. Anomaly & Quality Detection** (not yet in stack — natural addition)  
After pick, a fixed overhead camera runs a vision check before placement: wrong orientation, missing component, surface defect. Reject rate data feeds fleet learning pipeline.

**6. Scene Graph Persistence** (`scene_graph` with Kalman filtering)  
Object re-identification after occlusion — if a box passes behind another object and reappears, the tracker maintains the same object ID. Prevents task planner from restarting pick attempt mid-task.

**7. Language-Grounded Object Referencing** (`language_interface` + scene graph)  
"Pick the blue box on the left" — language interface reads scene graph to find exact object matching the description.

---

### FANUC CRX ROS2 Driver Analysis

Theodore asked about the FANUC CRX driver. Full analysis:

**What it is:** Official FANUC ROS2 driver published by FANUC America Corp and FANUC CORPORATION in 2025-2026. Not a community port — the manufacturer's own driver.

**Compatibility note:** The `main` branch targets ROS2 Jazzy Jalisco. The `humble` branch at `github.com/FANUC-CORPORATION/fanuc_driver/tree/humble` is needed for the current stack.

**Key capabilities:**

| Feature | Detail |
|---------|--------|
| Hardware Interface | `fanuc_hardware_interface` implements `hardware_interface::SystemInterface` — slots directly into ros2_control pipeline |
| Update rate | 500Hz — 10x the 50Hz minimum required by safety_monitor |
| CollaborativeSpeedScaling | `fanuc_msgs/CollaborativeSpeedScaling.msg` with `float64 collaborative_speed_scaling` — maps directly to `/safety/speed_scale` |
| RobotStatus | Exposes `e_stopped`, `motion_possible`, `contact_stop_mode`, `in_error` as native ROS2 fields |
| Force/Torque broadcaster | Built in, publishes `geometry_msgs/WrenchStamped` |
| GPIO controller | `FanucGPIOController` for digital/analog I/O — gripper driver integration |
| MoveIt2 config | Included for CRX-3iA, CRX-5iA, CRX-10iA, CRX-10iA/L, CRX-20iA/L, CRX-30iA |
| Fake hardware mode | `use_fake_hardware:=true` supported |

**Verdict:** Integration risk near-zero. Trade-off: FANUC CRX likely $40-60k range.

---

### Estun S10-140 ECO — Selected Robot Arm

Theodore confirmed: **"We will be using the Estun S10-140 ECO collaborative robot."**

**Honest assessment of ROS2 integration risk:**

The Estun S10-140 ECO is a **significant ROS2 integration risk**. As of knowledge cutoff, Estun does not have an official manufacturer-published ROS2 Humble driver with full ros2_control support — unlike FANUC, UR, or AUBO. What exists is scattered community work, partial ROS1 packages, and some third-party bridges.

**Questions Theodore must ask Estun:**
1. GitHub repo URL for ROS2 Humble driver (public repo, recent commits — not a PDF)
2. Does it include a `ros2_control` hardware interface plugin?
3. Does `use_fake_hardware:=true` work for simulation?
4. What communication protocol — EtherCAT, Modbus TCP, or proprietary?
5. Maximum command frequency over that protocol? (must be 50Hz+)
6. Joint torque sensors on all 6 joints? (required for ISO/TS 15066)

**The one test that reveals everything:**
> "Can you run `ros2 topic hz /joint_states` and show me the output right now on a video call?"

**Fallback path if no official driver:**
The S10-140 almost certainly speaks Modbus TCP or a proprietary Ethernet protocol. The `robot_driver` package already has the Modbus TCP bridge pattern from Section 16. A working bridge can be built in a few days with the register map from Estun. Risk: command frequency — Modbus TCP typically caps 50-125Hz depending on controller.

**A link to Estun documentation (`https://www.kdocs.cn/l/cqlm2DOsjGRp`) was shared but could not be opened** — Theodore was asked to download and upload the file for full analysis.

**Joint state workaround options:**

| Option | Method | Frequency | Notes |
|--------|--------|-----------|-------|
| 1 | Estun Open API / Ethernet | 50Hz+ (ask) | Most likely path — TCP/IP register map |
| 2 | Modbus TCP | 50-125Hz | Already in robot_driver package |
| 3 | EtherCAT | 1000Hz+ | Best performance — ask if available on ECO model |
| 4 | Screen-scrape teach pendant | Variable | Last resort — ugly but works for prototyping |

**Three things to get from Estun:**
1. Communication protocol document (Modbus register map, TCP/IP spec, or EtherCAT PDO layout)
2. Maximum command frequency (must confirm 50Hz+)
3. Joint angle scaling factor (raw register value → radians conversion)

---

## 41. Session Log — May 20 2026
### Claude Connection Issue on Jetson

**Last Updated**: May 20 2026  
**Covers**: Debugging Claude Code connection failure on Jetson — diagnosed as Claude authentication issue, not network issue

---

Theodore reported: "Unable to connect to Claude on Jetson."

**Diagnosis questions asked:**
- What happens: SSH times out / SSH works but claude fails / Claude won't authenticate / Dashboard unreachable
- Where connecting from: Windows laptop / VS Code Remote SSH / WSL terminal / Directly on Jetson screen

This was a brief session — the connection issue was likely Claude Code authentication after the JetPack 5 Docker session. Resolution: `claude auth logout` then `claude auth login` to re-authenticate with correct account.

---

## 42. Session Log — May 22 2026
### NVIDIA Downloads for LiDAR Scene Reconstruction

**Last Updated**: May 22 2026  
**Covers**: NVIDIA package requirements for scene reconstruction with LiDAR on JetPack 5 vs JetPack 6

---

Theodore asked: "What NVIDIA downloads are needed for scene reconstruction with the use of a LiDAR?"

**Answer given (before JetPack 6 flash):**

**Core — Isaac ROS Nvblox**  
Primary scene reconstruction package. Fuses LiDAR + depth camera data into live TSDF/occupancy voxel map at 10Hz+ on GPU. Already cloned at `src/isaac_ros_nvblox/` in workspace.

Required packages:
- `isaac_ros_common` — base interfaces and CUDA utilities (already cloned)
- `isaac_ros_nvblox` — the reconstruction engine itself
- JetPack 5.1.2 / L4T r35.4.1 needs `release-3.0` branch or earlier — latest Isaac ROS targets JetPack 6

**Supporting NVIDIA components:**
- **CuPCL** — GPU-accelerated point cloud processing (voxel downsampling, ICP). Replaces CPU PCL in `perception_fusion`, stops 8Hz dropout. Part of CUDA toolkit on JetPack — no separate install needed.
- **cuSpatial** — GPU spatial operations for point cloud transforms. Available via `pip install cuspatial` (JetPack wheel).

**From NVIDIA NGC container registry:**  
`dustynv/isaac_ros:humble-l4t-r35.4.1` — nvblox pre-built, least painful path given broken apt repo.

**Practical build sequence inside Docker container:**
```bash
# Build isaac_ros_common first (already cloned)
colcon build --packages-select isaac_ros_common

# Then nvblox
colcon build --packages-select nvblox_ros

# Wire Ouster output into nvblox
# /lidar/points → nvblox depth integration
# /perception/fused_cloud → occupancy_map node
```

**What nvblox gives specifically:**  
Takes `/perception/fused_cloud` PointCloud2 and builds TSDF mesh + occupancy grid that MoveIt2 uses as collision scene. At 2.5cm voxel resolution (already in `perception.yaml`) it accurately represents objects on worktable so robot plans around them in real time. Collision scene updates go from 2-3Hz (CPU OctoMap) to 10Hz+ (GPU nvblox).

**Critical compatibility check:**  
Run `nvcc --version` inside container to confirm CUDA version matches nvblox tag. Mismatches are the most common failure point with Isaac ROS on JetPack 5.

**Note:** This question was asked while still on JetPack 5. The decision to flash to JetPack 6 came shortly after precisely because JetPack 6 / CUDA 12.x is required for the full Isaac ROS 4.x stack including nvblox v4.4.0.

---

*Last updated: May 26 2026*  
*Covers (Sections 40-42): AI vision use cases ranked by impact (safety, detection, 6DOF pose, bin picking, quality, scene graph, language grounding), FANUC CRX ROS2 driver full analysis (500Hz, CollaborativeSpeedScaling, MoveIt2 config), Estun S10-140 ECO selection and ROS2 integration risk assessment (no official driver, Modbus TCP fallback, joint state workaround options), Claude connection debugging on Jetson, NVIDIA nvblox requirements for LiDAR scene reconstruction (isaac_ros_nvblox release-3.0, CuPCL, cuSpatial, dustynv NGC image)*

---

## 43. Session Log — May 27 2026
### JetPack 6 Flash Complete, Isaac ROS GPU Detection Pipeline, Dashboard Fixes

**Last Updated**: May 27 2026  
**Covers**: JetPack 6.2.2 flash completion (VirtualBox driver root cause), full stack rebuild via Claude Code (46 min), Docker setup, GitHub clone, Isaac ROS NITROS GPU pipeline operational, TensorRT detection backend fix, dashboard bbox_px coordinate fix, systemd services, Claude Code copy/paste workflow (script -f method), SSH enabled, light theme requested

---

### JetPack 6.2.2 Flash — Finally Completed

**Root cause of all flash failures: VirtualBox USB driver**

The orphaned VirtualBox USB driver (`oem159.inf`, service `VBoxUSB`) was intercepting the Jetson's USB connection. Found in SDK Manager terminal log:
```
DeviceDesc: @oem159.inf,%vboxusb_drvdesc%;VirtualBox USB Driver
Service: VBoxUSB
```

VirtualBox was not installed — the driver was an orphan from a previous uninstall.

**Fix applied:**
```powershell
pnputil /delete-driver oem159.inf /uninstall /force
shutdown /r /t 0
```

**After Windows restart:**
- APX appeared cleanly in Device Manager under Universal Serial Bus devices
- SDK Manager detected the Jetson immediately
- Flash completed successfully on first attempt

**Flash details:**
- Tool: SDK Manager 2.4.0-13236 (Windows .exe GUI — NOT WSL)
- JetPack: 6.2.2 (L4T R36.5.0)
- Storage: eMMC
- Username: teddy
- Password: was blank on first boot, reset to `aicollabs12` via `sudo passwd teddy`

**What failed before the fix:**
| Attempt | Method | Result |
|---------|--------|--------|
| 1 | WSL CLI | USB dropped mid-flash |
| 2 | WSL CLI retry | USB dropped again |
| 3 | Windows GUI | "Flash of target hardware was skipped" — VBoxUSB intercepting |
| 4 | Windows GUI retry | "The target is in a bad state" |
| 5 | Windows GUI after VBoxUSB removed | ✅ Flash completed |

**Other issues resolved during flash:**
- USB-A to USB-C cable was charge-only — needed USB-C to USB-C for data
- APX showing in Persisted but not Connected in usbipd — needed to unbind old GUID
- JetPack 7.1 files in `C:\Users\Laptop\OneDrive\Desktop\Ai Robotics\JetPack 7.1\` — SDK Manager was downloading to this folder despite selecting 6.2.2

---

### JetPack 6 Verified

```bash
cat /etc/nv_tegra_release
# R36 (release), REVISION: 5.0, GCID: 43688277, BOARD: generic, EABI: aarch64
```

- Ubuntu 22.04 ✅
- CUDA 12.6 ✅
- ROS2 path: `/opt/ros/humble/setup.bash` (standard, not the non-standard JetPack 5 path)

---

### Post-Flash Setup Sequence

**Password issue:** First boot created blank password. Fixed with `sudo passwd teddy` → `aicollabs12`.

**Tools installed on fresh JetPack 6:**
```bash
sudo apt install -y curl firefox terminator openssh-server xclip
sudo systemctl enable ssh && sudo systemctl start ssh
```

**Node.js + Claude Code:**
```bash
cd /tmp
wget -q https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-arm64.tar.xz
tar -xf node-v20.19.0-linux-arm64.tar.xz
sudo cp -r node-v20.19.0-linux-arm64/* /usr/local/
sudo npm install -g @anthropic-ai/claude-code
```

**Docker + NVIDIA runtime:**
```bash
curl -fsSL https://get.docker.com | sh
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
sudo usermod -aG docker teddy
```

GPU verified: `nvidia-smi` shows CUDA 12.6, Orin nvgpu detected.

**GitHub cloned:**
```bash
mkdir -p /home/teddy/cobot_ws
cd /home/teddy/cobot_ws
git clone https://TOKEN@github.com/Ai-Robotics-Prototype/V1.git .
```

**Passwordless sudo for Claude Code:**
```bash
echo "teddy ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/teddy-nopasswd
sudo chmod 440 /etc/sudoers.d/teddy-nopasswd
```

---

### Claude Code 46-Minute Build Session

Claude Code ran the full JetPack 6 setup prompt and completed:

| Component | Status | Notes |
|-----------|--------|-------|
| ROS2 Humble (native) | ✅ | Via apt on Ubuntu 22.04 |
| All 14 packages colcon build | ✅ | Clean build (CUDA warnings only) |
| CUDA nvcc 12.6 | ✅ | /usr/local/cuda-12.6/bin/nvcc |
| cuFFT dev | ✅ | Required by cuda_pointcloud |
| Isaac ROS NITROS 3.2.5 | ✅ | Via apt release-3.0 component |
| Python stack | ✅ | open3d, ultralytics, mediapipe, fastapi, uvicorn |
| Ollama 0.24.0 + Llama 3.1 8B | ✅ | Running on :11434 |
| Whisper base model | ✅ | Offline speech-to-text |
| YOLOv8n .pt model | ✅ | /opt/cobot/models/yolov8n.pt (6.2MB) |
| Dashboard frontend (Vite build) | ✅ | Built to mock_server/static/ |
| Docker + NVIDIA runtime | ✅ | Configured for GPU containers |

**Build fixes Claude Code made automatically:**
- package.xml emails `robot@cobot` → `robot@cobot.local`
- `$NVBLOX_ENABLED` condition removed from occupancy_map/package.xml
- Isaac ROS repo component `main` → `release-3.0`
- CUDAToolkit_ROOT moved into colcon_defaults.yaml

---

### Claude Code Copy/Paste Fix — IMPORTANT

**Problem:** Claude Code's terminal UI intercepts mouse events and blocks copy/paste between Firefox (Claude chat) and the terminal on the Jetson.

**REMEMBER FOR ALL FUTURE CONVERSATIONS:** Theodore used the Jetson terminal and Claude in Firefox on the Jetson before the JetPack 6 flash and copy/paste worked fine. After flashing to JetPack 6 (Ubuntu 22.04), copy/paste inside Claude Code's UI broke.

**Solution that works:**

Terminal 1 — run Claude Code with logging:
```bash
cd /home/teddy/cobot_ws
script -f ~/claude_output.log -c "claude --dangerously-skip-permissions"
```

Terminal 2 — copy output from:
```bash
tail -f ~/claude_output.log
```

**Copy directions:**
- Terminal 2 → Firefox: select text → **Ctrl+Shift+C** → paste in Firefox with **Ctrl+V**
- Firefox → Terminal 1 (Claude Code): **Ctrl+C** in Firefox → click Terminal 1 → **Ctrl+Shift+V**

**Other methods tried that did NOT work:**
- `echo 'set enable-bracketed-paste off' >> ~/.inputrc`
- `gsettings set org.gnome.Terminal.Legacy.Settings copy-on-select true`
- `export TERM=xterm`
- `export COLORTERM=truecolor`
- `sudo apt install xclip xsel wl-clipboard`
- tmux copy mode
- xdotool

**Only the `script -f` method works.**

---

### SSH Enabled for Laptop Access

```bash
sudo apt install -y openssh-server
sudo systemctl enable ssh
sudo systemctl start ssh
```

After JetPack 6 flash, SSH key changed. Fix from laptop:
```powershell
ssh-keygen -R 192.168.1.246
ssh teddy@192.168.1.246
```

Password: `aicollabs12`

---

### Isaac ROS GPU Detection Pipeline — Operational

**The real blocker found by Claude Code:**

The detector had **never run at all** on JetPack 6. Three separate environment issues:

| Component | State | Problem |
|-----------|-------|---------|
| torch | 2.4.1, cuda.is_available()=False | CPU-only build — no GPU |
| torchvision | 0.27.0 | Wrong for torch 2.4 (needs ~0.19) → nms does not exist |
| ultralytics | 8.4.55 | Eagerly imports torchvision → crashes on import |
| tensorrt | 10.3.0 ✅ installed | pycuda missing → TRT path disabled |
| yolov8n.plan | exists ✅ | detector looks for .engine, not .plan |

**Resolution — TensorRT GPU path (Option 1):**
- Installed pycuda
- Broadened import guard so broken Ultralytics is non-fatal
- Wired _pil_callback to use TRT engine
- Fixed two bugs in trt_engine.py:
  - Missing `set_tensor_address` for TensorRT 10.x `execute_async_v3` API
  - Coordinate scaling error that multiplied boxes by 640×
- Symlinked `yolov8n.engine` → `yolov8n.plan`
- Proven on bus.jpg test image: 4 person + 1 bus detected correctly

**Then upgraded to full Isaac ROS NITROS pipeline:**

Isaac ROS packages installed via apt:
- ros-humble-isaac-ros-dnn-image-encoder
- ros-humble-isaac-ros-tensor-rt
- ros-humble-isaac-ros-yolov8
- ros-humble-isaac-ros-image-proc

Pipeline architecture:
```
Camera /cam0/cam0/color/image_raw
    ↓
isaac_ros_image_proc        ← GPU format conversion (bgr8 → rgb8)
    ↓
isaac_ros_dnn_image_encoder ← Resize + normalize to 640×640 float tensor
    ↓
isaac_ros_tensor_rt         ← TensorRT inference on yolov8n.onnx
    ↓
isaac_ros_yolov8            ← Decode tensor → Detection2DArray
    ↓
depth_detector_node         ← Lift 2D → 3D using depth + COCO name mapping
    ↓
/perception/detections_3d   ← Dashboard subscribes to this
/perception/annotated_image ← PIL-drawn boxes on camera frame
```

**Verified rates:**
- /detections_output: 17.9 Hz
- /perception/detections_3d: 10.8 Hz
- /perception/annotated_image: 14.8 Hz

---

### Dashboard Fixes Applied

**Fix 1 — Detection coordinate mismatch (bbox_px)**

The PIL callback puts PIXEL coordinates (e.g. 320, 240) into Detection3D position fields. The CameraPanel projected these as metres: `u = (615 × 320) / 1.0 + 320 = 197,100` — completely off screen.

Fixed in dashboard_server.py `_on_detections_3d`:
```python
# Detect pixel vs metric coordinates
if abs(pos.x) > 10 or abs(pos.y) > 10:
    # Pixel coordinates → store as bbox_px
    dets.append({
        "bbox_px": [pos.x - size.x/2, pos.y - size.y/2,
                    pos.x + size.x/2, pos.y + size.y/2],
        ...
    })
```

Fixed in CameraPanel.jsx DetectionOverlay:
```javascript
if (det.bbox_px && det.bbox_px.length === 4) {
    const [x1, y1, x2, y2] = det.bbox_px
    x0 = x1; y0 = y1; bw = x2 - x1; bh = y2 - y1
} else if (det.z > 0) {
    // Metric 3D coordinates — project through pinhole model
}
```

**Fix 2 — device cpu → cuda:0**

detection.yaml changed `device: "cpu"` → `device: "cuda:0"`

**Fix 3 — Target classes filter removed**

detector_node.py `target_classes` default changed from `['bottle','box','cup','tool','person']` to `[]` (empty = detect all 80 COCO classes).

**Fix 4 — Confidence threshold lowered**

Changed from 0.35 → 0.20 in:
- detection.yaml
- isaac_ros_full.launch.py yolov8_decoder

**Fix 5 — COCO class name mapping**

depth_detector_node.py already had `_COCO_CLASSES` list and `_id_to_label()` function. Maps numeric Isaac ROS class IDs (e.g. '0', '39') to human names ('person', 'bottle').

---

### Systemd Services Created

Three systemd services manage the perception stack:

| Service | What it runs | Restart policy |
|---------|-------------|----------------|
| `roboai-cameras` | cameras.launch.py (both RealSense) | always |
| `roboai-detector` | detector_node (TRT fallback, currently disabled) | always |
| `roboai-isaac` | isaac_ros_full.launch.py (full GPU pipeline) | always, RestartSec=10 |
| `roboai-dashboard` | dashboard_server.py | always |

**Isaac ROS service replaces the standalone detector:**
```bash
sudo systemctl disable roboai-detector  # TRT fallback, kept but disabled
sudo systemctl enable roboai-isaac      # Full Isaac ROS GPU pipeline
```

All services survive reboot automatically.

---

### GitHub Token Security Note

**TWO GitHub PATs were exposed during this session:**
1. `[REDACTED_GHP_TOKEN_1]` — first token, exposed when pasting git clone command
2. `[REDACTED_GHP_TOKEN_2]` — second token, exposed when setting remote URL

<!-- Original token strings redacted at ledger-split time (see frontmatter); GitHub secret-scanning refused the push. Both tokens revoked. -->


**Both must be rotated immediately.** Go to GitHub → Settings → Developer Settings → Personal Access Tokens → delete both → generate new one.

**Recommended permanent fix — SSH keys instead of tokens:**
```bash
ssh-keygen -t ed25519 -C "robot@roboai.com"
cat ~/.ssh/id_ed25519.pub
# Add to GitHub → Settings → SSH Keys → New SSH Key
git remote set-url origin git@github.com:Ai-Robotics-Prototype/V1.git
```

---

### Isaac ROS Launch File Updates (isaac_ros_full.launch.py)

**Runtime library check added:**
```python
def _so_available(*libs: str) -> bool:
    """Return True only if every named shared library resolves at runtime."""
    import ctypes
    for lib in libs:
        try:
            ctypes.CDLL(lib)
        except OSError:
            return False
    return True
```

Isaac ROS detection pipeline only activates when BOTH packages AND shared libraries resolve:
```python
isaac_ok = (
    _pkg_available('isaac_ros_dnn_image_encoder')
    and _pkg_available('isaac_ros_tensor_rt')
    and _pkg_available('isaac_ros_yolov8')
    and _so_available('libnvvpi.so.3', 'libnvToolsExt.so.1',
                      'libnvdla_compiler.so', 'libcvcuda.so.0')
)
```

**Additional TF frames added for nvblox:**
```python
# odom→base_link and map→odom identity transforms
Node(package='tf2_ros', executable='static_transform_publisher',
     name='odom_base_tf', arguments=['0','0','0','0','0','0','odom','base_link']),
Node(package='tf2_ros', executable='static_transform_publisher',
     name='map_odom_tf', arguments=['0','0','0','0','0','0','map','odom']),
```

---

### Ouster Bridge Updated

`ouster_bridge.py` updated for new ouster.sdk API:
```python
# Old (JetPack 5):
from ouster.sdk import client
sensor_config = client.SensorConfig()
with client.Sensor(self._host, 7502, 7503, config=sensor_config) as source:

# New (JetPack 6):
import ouster.sdk as ouster_sdk
from ouster.sdk.core import XYZLut
with ouster_sdk.open_source(self._host, sensor_idx=0) as source:
```

---

### Current Dashboard Status

**What's working:**
- Production dashboard server running on :8080
- Both camera MJPEG streams (/stream/cam0, /stream/cam1)
- Annotated stream (/stream/annotated) with PIL-drawn boxes
- LiDAR WebSocket (/ws/lidar) with sim fallback
- State WebSocket (/ws/state) at 10Hz
- All /cmd/* endpoints (estop, task, jog, gripper, voice)
- bbox_px coordinate handling for pixel-space detections
- Isaac ROS NITROS GPU detection pipeline at 17.9 Hz

**What's not yet working:**
- Cam0 intermittently freezes (RealSense USB timeout — restart fixes it)
- Detection boxes not appearing on some objects (investigating)
- Still dark theme (light theme code generated but not applied yet)
- nvblox mesh not wired to dashboard yet

**Open questions:**
- Objects need to be in COCO 80 classes to be detected by YOLOv8
- For detecting truly unknown objects: NanoOWL (NVIDIA open-vocabulary detector) planned
- Cam0 freeze requires camera service restart: `sudo systemctl restart roboai-cameras`

---

### NanoOWL — Planned for Unknown Object Detection

YOLOv8 only detects its 80 pre-trained COCO classes. For detecting ANY object without training, NanoOWL (NVIDIA open-vocabulary detector for Jetson) is planned:

```bash
cd /home/teddy/cobot_ws/src
git clone https://github.com/NVIDIA-AI-IOT/nanoowl.git
pip3 install --break-system-packages .
python3 -m nanoowl.build_image_encoder_engine data/owl_image_encoder_patch32.engine
```

NanoOWL uses text prompts ("detect everything on the table") to find arbitrary objects without pre-training. Combined with YOLOv8, this covers both known and unknown objects.

---

### Codebase Changes (V1-main, May 27 2026)

**Files changed from previous version:**

| File | Change |
|------|--------|
| detection.yaml | confidence 0.35→0.20, target_classes→[], device cpu→cuda:0 |
| detector_node.py | dual publisher (detections + detections_3d), empty target_classes default |
| trt_engine.py | TRT 10.x set_tensor_address API fix, coordinate scaling fix |
| isaac_ros_full.launch.py | _so_available() runtime check, odom/map TF frames |
| dashboard_server.py | bbox_px detection format, _THIS_DIR resolve() |
| CameraPanel.jsx | bbox_px rendering path + pinhole fallback |
| ouster_bridge.py | ouster.sdk.core.XYZLut API update |
| .gitignore | isaac_ros_assets/, *.pt, generated static/ |

**GitHub push:** Commit `be02569` on main branch.

**Note:** `.github/workflows/frontend_build.yml` NOT pushed — GitHub token lacked `workflow` scope. File exists on disk but is untracked.

---

### Updated Project Status (May 27 2026)

| Item | Status |
|------|--------|
| JetPack 6.2.2 (L4T R36.5.0) | ✅ Flashed and running |
| Ubuntu 22.04 | ✅ |
| CUDA 12.6 | ✅ |
| ROS2 Humble (native) | ✅ |
| All 14 packages building | ✅ |
| Isaac ROS NITROS 3.2.5 | ✅ Via apt |
| Isaac ROS detection pipeline | ✅ 17.9 Hz on GPU |
| TensorRT detection fallback | ✅ Disabled but available |
| YOLOv8n TRT engine | ✅ /opt/cobot/models/yolov8n.engine |
| YOLOv8n .pt model | ✅ /opt/cobot/models/yolov8n.pt |
| Ollama + Llama 3.1 8B | ✅ Running on :11434 |
| Whisper base | ✅ |
| RealSense driver (both cameras) | ✅ 30Hz each |
| Ouster LiDAR driver | ✅ Built, ouster.sdk API updated |
| Dashboard production server | ✅ Running on :8080 |
| Dashboard bbox_px fix | ✅ Pixel + metric coordinate handling |
| systemd services | ✅ cameras, isaac, dashboard — auto-start |
| SSH from laptop | ✅ Enabled |
| Claude Code on Jetson | ✅ script -f method for copy/paste |
| Docker + NVIDIA runtime | ✅ |
| Light theme | 🔄 Generated but not yet applied |
| nvblox mesh in dashboard | 🔄 Not yet wired |
| NanoOWL open-vocabulary detection | ⏳ Planned |
| Cam0 freeze issue | ⚠️ Intermittent USB timeout |
| Safety zone testing | ⏳ |
| First autonomous pick/place | ⏳ |

### Key Decisions Made This Session
- **No Docker for ROS2** — JetPack 6 native install is cleaner and simpler
- **TensorRT GPU over fixing torch/torchvision** — sidesteps broken Python ML env entirely
- **Isaac ROS NITROS pipeline** — full GPU zero-copy transport replaces standalone detector
- **systemd services** — three services manage the full stack with auto-restart
- **script -f for Claude Code** — only reliable copy/paste method on JetPack 6 Ubuntu 22.04
- **SSH keys recommended** — two GitHub PATs exposed in this session, SSH keys avoid this permanently
- **NanoOWL planned** — for detecting objects outside COCO 80 classes
- **Target classes filter removed** — all 80 COCO classes detected, confidence lowered to 0.20
- **VirtualBox driver was root cause** of every flash failure — removal fixed it permanently

---

*Last updated: May 27 2026*  
*Covers: JetPack 6.2.2 flash completion (VirtualBox USB driver root cause, 5 flash attempts), post-flash setup (password fix, tools, Docker, GitHub clone), Claude Code 46-min build session (14 packages, Isaac ROS NITROS, AI models), Claude Code copy/paste fix (script -f method — ONLY method that works), TensorRT detection backend fix (pycuda, trt_engine v10 API, coordinate scaling), Isaac ROS NITROS GPU detection pipeline operational (17.9 Hz), dashboard fixes (bbox_px coordinates, confidence 0.20, target_classes empty, COCO name mapping), systemd services (cameras, isaac, dashboard), SSH enabled, two GitHub PATs exposed and need rotation, NanoOWL planned for open-vocabulary detection*

---

## 44. Session Log — May 28 2026
### Depth Segmentation, 3D OBB, LiDAR Livox MID-360, Stereo Verification, GPU Reconstruction, Robot Model

**Last Updated**: May 28 2026  
**Covers**: Depth-based object detection (any object without ML), 3D oriented bounding boxes, OBB refinement (merge overlapping, hole filling, convex hull), LiDAR hardware correction (Livox MID-360 not Ouster OS1-32), dense point cloud accumulation, CPU TSDF reconstruction, camera-LiDAR alignment debugging, stereo camera verification, UR5e robot model with URDF loader, scene graph motion tracking, point cloud refresh rate optimization, nvblox GPU reconstruction

---

### CRITICAL HARDWARE CORRECTION: LiDAR Is Livox MID-360, NOT Ouster OS1-32

**All previous MD sections referencing "Ouster OS1-32" are incorrect.**

The actual LiDAR hardware is a **Livox MID-360**:

| Field | Old (Wrong) | Correct |
|-------|-------------|---------|
| Model | Ouster OS1-32 | Livox MID-360 |
| IP Address | 192.168.1.100 | **192.168.1.150** |
| Power | 24V PoE | **12V DC (9-27V range)** |
| Interface | UDP 56201 | Livox SDK2 UDP ports 56100-56500 |
| Driver | ouster-ros | **livox_ros_driver2** |
| Message type | PointCloud2 natively | CustomMsg (converted to PointCloud2) |
| Ethernet speed | Requires 1 Gbps | **100 Mbps is fine** |
| Scan pattern | Fixed rotating | **Non-repetitive (accumulates over time)** |
| Beam count | 32 fixed beams | Solid-state, ~200k pts/sec |
| MAC Address | unknown | 88:29:85:86:df:d9 |

**How it was discovered:** The ouster_bridge.py kept failing with TCP timeout to 192.168.1.100. Claude Code ran arp-scan on eno1 and found a single host at 192.168.1.150 with Livox OUI MAC address. Theodore confirmed: "This is a Livox MID-360. I was told it needs 12V."

**The 5-wire cable** (yellow/white/red/black/green) connected to the M8 union is the **Sync/GPIO/PPS timing cable** — not needed for basic operation. Left disconnected.

---

### Livox MID-360 Driver Setup

Claude Code installed and configured the Livox driver:

1. **Livox SDK2** cloned, cmake built, installed to /usr/local/{lib,include}
2. **livox_ros_driver2** cloned and built with `colcon build --cmake-args -DROS_EDITION=ROS2 -DDISTRO_ROS=humble`
   - Did NOT use upstream `build.sh` — it runs `rm -rf build/ install/ devel/` which would have wiped every other package
3. **MID360_config.json** patched:
   - host_net_info.*_ip = 192.168.1.200
   - lidar_configs[0].ip = 192.168.1.150
4. **xfer_format=0** set in launch file for native PointCloud2 output
5. **Remapping** added: `/livox/lidar` → `/lidar/points`

**Ethernet routing fix (SSH-safe):**
The Jetson's SSH session is on WiFi (192.168.1.246 via wlP1p1s0). Adding a /24 route on eno1 for the LiDAR would hijack the SSH return path. Fix:
```bash
# /32 host route — only routes to the LiDAR IP, doesn't affect WiFi
sudo ip addr add 192.168.1.200/32 dev eno1
sudo ip route add 192.168.1.150/32 dev eno1
```

**Note:** Kernel renamed eth0 to eno1 on JetPack 6.

**Verified working:**
- /lidar/points at 10.0 Hz
- ~5000 points per frame (before accumulation)
- /livox/imu at 200 Hz
- Dashboard: lidar_live: true, lidar_pts: 4992

**systemd service:**
```ini
[Unit]
Description=NeuRobots Livox MID-360 LiDAR
After=network.target
[Service]
Type=simple
User=teddy
ExecStartPre=+/bin/bash -c 'ip addr add 192.168.1.200/32 dev eno1 2>/dev/null; ip route add 192.168.1.150/32 dev eno1 2>/dev/null; true'
ExecStart=/bin/bash -c 'source /opt/ros/humble/setup.bash && source /home/teddy/cobot_ws/install/setup.bash && ros2 launch livox_ros_driver2 msg_MID360_launch.py'
Restart=always
RestartSec=5
```

---

### Depth Segmentation — Detect ANY Object Without ML

**Problem:** YOLOv8 only detects 80 COCO classes. Customer parts (gears, brackets, custom machined parts) are invisible.

**Solution:** Depth-based segmentation using the RealSense aligned depth image. No ML model, no training, no torch/torchvision dependency.

**Created:** `src/object_detection/object_detection/depth_segment_node.py`

**Algorithm:**
1. Convert depth to metres (16UC1 ÷ 1000)
2. Adaptive background: compute histogram of valid depth, find dominant peak (table surface)
3. Foreground mask: anything 1.5cm+ closer than background
4. Morphological cleaning: binary_closing (15×15 kernel) → binary_fill_holes → binary_erosion (2px) → binary_dilation (7px)
5. Depth gradient edges: scipy.ndimage.sobel → boundary_mask where gradient > 0.01
6. Split touching objects: remove boundary pixels from foreground mask before connected components
7. Connected components: scipy.ndimage.label
8. For each component > 100 pixels: compute bounding box, median depth, deproject to 3D

**Detection output format:**
- Detection3D with bbox.center.position = pixel coordinates (cx, cy, 1.0)
- bbox.size = pixel width and height
- results[0].hypothesis.class_id = "object"
- results[0].hypothesis.score = 0.9

**Annotated image:** PIL draws green bounding box + distance label + 3D OBB wireframe on each detected object.

**Parameters (ROS2):**
- max_depth_m: 2.0 → 3.0
- min_depth_m: 0.1
- min_object_area_px: 500 → 200 → 100 → 50 (progressively lowered for small parts)
- floor_tolerance_m: 0.03 → 0.015 (catches flat parts 1.5cm above surface)
- erode_size: 3 → 2
- dilate_size: 5 → 7 → 9
- publish_rate_hz: 15.0

**Both cameras:** Subscribes to both cam0 and cam1 depth + color topics. Publishes annotated images for both:
- /perception/annotated_image (cam0)
- /perception/annotated_image_cam1 (cam1)

**systemd service:** roboai-depth-segment (Restart=always, RestartSec=5)

---

### 3D Oriented Bounding Box (OBB) — Object Pose for Grasp Planning

Added to depth_segment_node.py after the initial detection:

**Algorithm:**
1. Extract 3D point cloud from depth within the 2D bounding box
2. Vectorized deprojection: X = (u-cx)*Z/fx, Y = (v-cy)*Z/fy
3. Statistical outlier removal: reject points > 1.5σ from centroid
4. Remove table surface points: reject points within 5mm of max depth in cluster
5. 2D PCA on XY plane for tabletop objects (yaw only, no roll/pitch)
6. Minimum area bounding rectangle from convex hull (rotating calipers)
7. Z extent from point range
8. Convert yaw to quaternion via scipy.spatial.transform.Rotation

**OBB data published in Detection3D:**
- bbox.center.position = centroid in metres
- bbox.center.orientation = quaternion from PCA
- bbox.size = dimensions in metres
- Annotated image: cyan wireframe (8 corners projected back to 2D) + label "0.54m 8×4cm yaw:23°"

**OBB refinement iterations:**
| Issue | Fix Applied |
|-------|-----------|
| Boxes too large (table leaking into mask) | binary_erosion(mask, iterations=2) before 3D extraction |
| Table surface points inflate PCA | Remove points within 5mm of max depth |
| Outlier points skew axes | Statistical outlier removal (1.5σ) |
| Multiple objects merged into one blob | Depth gradient splitting + merge overlapping with IoU > 0.15 |
| Ring-shaped object split into 5 pieces | binary_fill_holes + binary_closing(15×15) + post-detection merge |
| OBB larger than object (PCA overestimate) | Convex hull minimum area rectangle (rotating calipers) |
| Size sanity check | Max 30cm any dimension, min 5mm |
| Label clutter | Changed to "0.54m 8×4cm yaw:23°" format |

---

### Merge Overlapping Detections

Post-processing step after all connected components:

```python
def merge_overlapping_detections(detections, iou_threshold=0.15, distance_threshold_px=30):
    # For each pair: compute IoU and centroid distance
    # Merge if IoU > 0.15 OR (centroid distance < 30px AND depth_diff < 0.03m)
    # Combined bbox = union of all merged bboxes
    # Recompute OBB from combined point cloud
```

Also stores `_component_id` per detection to allow re-extraction of combined mask for OBB recomputation.

---

### Point Cloud Accumulation

**Created:** `src/cobot_bringup/scripts/pointcloud_accumulator.py`

The Livox MID-360 non-repetitive scan fills in gaps over time. Accumulator maintains rolling buffers:

| Zone | Range | Frames | Voxel | Result |
|------|-------|--------|-------|--------|
| Near | ≤ 1.0m | 20 → 50 → 15 frames | 0.005m (5mm) | ~30k-50k points |
| Far | > 1.0m | 5 → 3 frames | 0.03m (3cm) | ~5k-10k points |

Publishes /lidar/points_dense at 10Hz → 20Hz.

Dashboard server prefers /lidar/points_dense, falls back to /lidar/points.

**systemd service:** roboai-accumulator

---

### CPU TSDF Reconstruction

**Created:** `src/cobot_bringup/scripts/local_reconstruction.py`

Builds a solid 3D mesh from the accumulated point cloud:

- Grid: 150×150×150 voxels at 2cm resolution (3m cube, ~13MB)
- Update: exponential moving average (0.8 × old + 0.2 × new)
- Decay: 0.995 per frame for unobserved voxels
- Isolated voxel removal: kill voxels with < 3 occupied neighbors
- Surface extraction: face generation (marching cubes planned)
- Height-based vertex colors: grey (floor) → blue (low) → green (mid) → amber (high)
- Mesh decimation to 10k triangles for WebSocket bandwidth
- Publish rate: 2Hz → 1Hz

Published as JSON on /reconstruction/mesh_json, broadcast via /ws/mesh.

**systemd service:** roboai-reconstruction

---

### GPU Reconstruction — nvblox / CuPy

Prompt generated to use NVIDIA GPU acceleration:

**Priority 1 — nvblox (if installed):**
- GPU TSDF at 0.02m resolution
- Fuses LiDAR + camera depth
- Publishes nvblox_msgs/Mesh at 5Hz
- 10-100x faster than CPU

**Priority 2 — CuPy GPU arrays:**
- pip3 install cupy-cuda12x
- Replace numpy voxel operations with cupy equivalents
- 10-50x speedup for voxel grid updates

**Priority 3 — CPU with marching cubes:**
- scikit-image marching_cubes for smooth surfaces
- Better than current face extraction but still CPU

---

### Camera-LiDAR Alignment Debugging

**The core problem:** Camera detections and LiDAR point cloud use different coordinate frames. Objects appear at wrong heights in the 3D view.

**Attempts made:**

| Approach | Result |
|----------|--------|
| Static cam-to-lidar transform with quaternion [0.5, -0.5, 0.5, 0.5] | Some objects above, some below |
| Measure Z offset between table surface and detection Z | Overshoot — all boxes below |
| Split the difference on Z offset | Still some above, some below |
| Plane tilt regression (fit error = a*x + b*y + c) | Regression unstable — "85° pitch rotation would destroy alignment" |
| Floor-anchored boxes using LiDAR surface median | Visualization-only fix, doesn't fix underlying data |
| Shared rosToThree() function for points and detections | Necessary but not sufficient |

**Root cause identified by Claude Code:**
The OBB centroid Z is the geometric center of the visible point cloud with the table surface excluded. Different objects have different visible heights, so centroids are at different Z values — it's per-object variance, not camera tilt.

**Current best fix:** Floor-anchored visualization — for each box in the 3D view, scan LiDAR points within 8cm of the box's XY, take median Z, place box bottom there. This is visualization-only; the raw Detection3D data is unchanged.

**Proper solution (in progress):** Stereo verification + LiDAR surface anchoring.

---

### Stereo Camera Verification

**Created (prompt generated):** `src/object_detection/object_detection/stereo_verifier_node.py`

Both cameras see overlapping workspace. Cross-verification:

1. cam0 detects objects with depth → position in cam0 frame
2. cam1 detects objects with depth → position in cam1 frame  
3. Transform cam0 detection into cam1 image, find matching cam1 detection
4. If match (< 30px distance, < 5cm depth difference):
   - VERIFIED: weighted average position (inverse depth weighting)
   - Confidence boost: max(score0, score1) × 1.2
5. If no match: single-camera detection (lower confidence)

**Final placement:**
- XY position: from cameras (better horizontal resolution for small objects)
- Z position: from LiDAR surface at that XY (accurate surface height)
- Result: objects guaranteed to sit on the point cloud surface

**Published on:** /perception/verified_detections and /perception/placed_objects

**Dashboard display:**
- Camera feeds: green boxes = stereo verified, yellow = single camera only
- 3D view: green solid = verified, yellow wireframe = unverified

**systemd service:** roboai-stereo

---

### LiDAR-Primary Detection Pipeline

**Created:** `src/object_detection/object_detection/lidar_detector_node.py`

Detects objects directly in the LiDAR point cloud (ground-truth 3D positions):

1. RANSAC plane fitting → find table surface
2. Remove table points (within 1.5cm of plane)
3. Voxelize remaining points at 1cm resolution
4. 3D connected components (scipy.ndimage.label)
5. For each cluster ≥ 15 points: centroid, extents, OBB

**Published on:** /perception/lidar_detections (Detection3DArray, frame_id=livox_frame)

**Fusion with camera detections:** detection_fusion_node.py matches LiDAR clusters with camera detections by projecting LiDAR centroids into camera image space.

**systemd services:** roboai-lidar-detect, roboai-fusion

---

### Detection Fusion Node

**Created:** `src/object_detection/object_detection/detection_fusion_node.py`

Combines LiDAR positions (accurate) with camera details (OBB, size, orientation):

- LiDAR detection projected into cam0 image
- Nearest camera detection matched (< 50px distance)
- Fused result: position from LiDAR + size/orientation from camera
- Published on /perception/fused_detections

---

### UR5e Robot Model in Dashboard

**Installed:** ros-humble-ur-description (or cloned from source)

**Process:**
1. Generated URDF: `xacro ur.urdf.xacro ur_type:=ur5e` → /opt/cobot/models/ur5e.urdf
2. Converted DAE meshes to STL/GLB via trimesh
3. Extracted kinematic chain to JSON (6 joints, DH parameters)
4. Mesh files copied to frontend public/robot_model/
5. Fixed mesh paths in URDF: `package://ur_description/` → `/robot_model/`

**Initial attempt:** Manual DH kinematics in Three.js — links disconnected and floating (broken).

**Correct approach:** `urdf-loader` npm package reads the URDF directly and builds the proper kinematic chain:
```bash
npm install urdf-loader
```

**ArmViewer3D.jsx rewritten** to use URDFLoader:
- Loads /robot_model/ur5e.urdf
- Reads joint positions from Zustand store
- Updates joint angles every frame with smooth interpolation
- Proper shadows, materials, orbit controls

**Note:** This is a placeholder UR5e model. When the Estun S10-140 URDF is obtained from the supplier, swap the mesh files and DH parameters.

---

### Scene Graph — Motion Path and Orientation Tracking

**Added to scene_graph_node.py:**

Per-track data:
- path_history: list of [x, y, z, timestamp] — last 50 positions
- velocity: [vx, vy, vz] m/s from last 5 positions
- orientation_euler: [roll, pitch, yaw] degrees from OBB quaternion
- is_moving: boolean (speed > 0.005 m/s)

**Dashboard visualization:**
- Camera feeds: cyan arrow showing part orientation (yaw direction), motion trail as fading dots
- 3D view: orientation arrows (cyan cones), motion trails (fading line), velocity vectors (red arrows for moving objects)
- Scene graph panel: orientation angle, speed, direction, STATIC/MOVING status

**Label format on annotated image:**
```
0.54m 8×4cm ↗23° 0.02m/s
```

---

### Point Cloud Refresh Rate Optimization

**Bottlenecks identified:**
1. Accumulator publishing at 10Hz (slow)
2. JSON serialization of 15k points (large payload)
3. Frontend recreating geometry every frame (GC pressure)

**Fixes applied/planned:**

| Optimization | Before | After |
|-------------|--------|-------|
| Accumulator publish rate | 10 Hz | 20 Hz |
| Near accumulate frames | 50 | 15 |
| Far accumulate frames | 5 | 3 |
| JSON serialization | json.dumps() | orjson (5x faster) |
| Payload format | Array of {x,y,z,i} objects | Flat array [x,y,z,x,y,z,...] (60% smaller) |
| Max points per frame | 15000 | 8000 |
| Frontend buffer | Recreate every frame | Pre-allocated, update in-place |
| Binary WebSocket | Not used | Float32 ArrayBuffer (3-5x smaller than JSON) |

**Target:** 20Hz refresh, < 100KB per frame.

---

### Systemd Services — Complete List (May 28 2026)

| Service | What it runs | After |
|---------|-------------|-------|
| roboai-cameras | cameras.launch.py (both RealSense) | network |
| roboai-lidar | livox_ros_driver2 msg_MID360_launch.py | network |
| roboai-accumulator | pointcloud_accumulator.py | roboai-lidar |
| roboai-reconstruction | local_reconstruction.py | roboai-accumulator |
| roboai-depth-segment | depth_segment_node (both cameras) | roboai-cameras |
| roboai-lidar-detect | lidar_detector_node | roboai-accumulator |
| roboai-fusion | detection_fusion_node | roboai-lidar-detect, roboai-depth-segment |
| roboai-stereo | stereo_verifier_node | roboai-depth-segment, roboai-lidar |
| roboai-scene-graph | scene_graph_node | roboai-fusion |
| roboai-grasp | grasp_planner (approach poses) | roboai-depth-segment |
| roboai-tf | sensor_tf_publisher (static transforms) | network |
| roboai-isaac | isaac_ros_full.launch.py (disabled) | roboai-cameras |
| roboai-detector | detector_node TRT (disabled) | roboai-cameras |
| roboai-dashboard | dashboard_server.py | network |

---

### Extrinsic Calibration Infrastructure

**Created (prompt generated):**
- `src/cobot_bringup/scripts/calibrate_extrinsics.py` — AprilTag-based calibration
- `src/cobot_bringup/scripts/sensor_tf_publisher.py` — publishes static TFs from YAML
- `src/cobot_bringup/scripts/align_sensors.py` — interactive XYZ offset alignment tool
- `src/cobot_bringup/config/sensor_transforms.yaml` — stored transforms

**Calibration file format:**
```yaml
cam0_to_lidar:
  translation: [x, y, z]
  rotation: [qx, qy, qz, qw]  # [0.5, -0.5, 0.5, 0.5] = optical→ROS standard
cam1_to_lidar:
  translation: [x, y, z]
  rotation: [qx, qy, qz, qw]
workspace_to_robot_base:
  translation: [0, 0, 0]  # placeholder until robot connected
  rotation: [0, 0, 0, 1]
```

**AprilTag:** tag36h11 ID 0, printed at 10cm, saved to /opt/cobot/calibration/apriltag_36h11_id0.png

**Installed:** pupil-apriltags or dt-apriltags for detection

---

### Grasp Pose Generation

**Created:** `src/object_detection/object_detection/grasp_planner.py`

For each detection with valid 3D OBB:
1. **Approach direction:** top-down (−Z in camera frame)
2. **Pre-grasp:** 10cm above object center, gripper rotated to match object yaw
3. **Grasp:** 5mm above object center, same orientation
4. **Gripper width:** OBB short axis + 1cm margin (choose approach that requires less opening)
5. **Retreat:** lift 15cm straight up

**Published on:** /grasp/candidates (with pre_grasp, grasp, retreat poses + gripper_width_m)

**Parameters:**
- approach_offset_m: 0.10
- retreat_height_m: 0.15
- gripper_margin_m: 0.01
- max_gripper_width_m: 0.085

**systemd service:** roboai-grasp

---

### Dashboard State — All Views Working (May 28 2026)

| View | Status | Data source |
|------|--------|------------|
| Camera (split) | ✅ Live | /stream/cam0, /stream/cam1 with PIL annotations |
| Camera (single) | ✅ Live | MJPEG with green boxes, cyan OBB wireframes, orientation arrows |
| LiDAR 3D | ✅ Live | /ws/lidar, 5000-16000 pts, height coloring, safety rings |
| LiDAR mesh | ✅ Working | /ws/mesh from local_reconstruction |
| ARM | 🔄 In progress | UR5e URDF loading via urdf-loader |
| Scene graph | 🔄 In progress | Motion paths, orientation, velocity |
| Safety | ✅ Working | Zone rings, GREEN/YELLOW/RED status |
| Detected objects | ✅ Working | Bottom panel shows objects with depth |
| Controls | ✅ Working | Run/Pause/Home, speed slider, E-STOP |
| Program | ✅ Working | 5-step pick/place sequence |

---

### Updated Project Status (May 28 2026)

| Item | Status |
|------|--------|
| JetPack 6.2.2 | ✅ |
| ROS2 Humble native | ✅ |
| All 14 packages building | ✅ |
| Isaac ROS NITROS 3.2.5 | ✅ |
| Isaac ROS detection pipeline | ✅ (disabled, depth segment preferred) |
| Depth segmentation (any object) | ✅ Working on both cameras |
| 3D OBB with yaw | ✅ Working with convex hull fit |
| Livox MID-360 LiDAR | ✅ 10Hz, 5000 pts/frame |
| Point cloud accumulation | ✅ 15-20k dense pts |
| CPU TSDF reconstruction | ✅ 2Hz mesh updates |
| Camera-LiDAR alignment | ⚠️ Floor-anchored workaround, stereo fix in progress |
| Stereo camera verification | 🔄 Node created, testing |
| LiDAR-primary detection | 🔄 Node created, testing |
| Detection fusion | 🔄 Node created, testing |
| Extrinsic calibration | 🔄 Infrastructure created, not yet run |
| Grasp pose generation | ✅ Publishing approach/grasp/retreat poses |
| UR5e robot model | 🔄 URDF loaded, kinematic chain being fixed |
| Scene graph motion tracking | 🔄 Path history + orientation added |
| nvblox GPU reconstruction | ⏳ Prompt generated, not yet run |
| Dashboard light theme | ✅ Applied (except LiDAR view = dark by request) |
| Dashboard live at :8080 | ✅ |
| SSH from laptop | ✅ |
| systemd auto-start (14 services) | ✅ |
| Estun S10-140 arm driver | ⏳ Waiting on protocol document |
| MoveIt2 motion planning | ⏳ Needs arm driver first |
| Teaching function (CLIP embeddings) | ⏳ Planned after detection stabilized |
| NanoOWL open-vocabulary | ⏳ Planned |
| Safety zone testing with humans | ⏳ |
| First autonomous pick/place | ⏳ Needs arm driver |

### Key Decisions Made This Session

- **Depth segmentation over YOLOv8 for unknown objects** — ML model only knows 80 COCO classes; depth finds anything above the surface
- **Livox MID-360 confirmed** — all previous Ouster references in MD are wrong; IP is 192.168.1.150 not 192.168.1.100
- **12V power is correct** for Livox MID-360 (9-27V range)
- **/32 host route for LiDAR ethernet** — avoids WiFi SSH disruption from /24 subnet conflict
- **eno1 not eth0** — kernel renamed the ethernet interface on JetPack 6
- **livox_ros_driver2 build.sh is destructive** — it rm -rfs build/install/devel/, must build manually with colcon
- **2D PCA for tabletop OBB** — full 3D PCA is unstable for flat objects; yaw-only rotation is what the gripper needs
- **Convex hull minimum area rectangle** — tighter fit than PCA extents for OBB
- **Floor-anchored 3D boxes** — visualization workaround while stereo verification is being built
- **LiDAR-primary detection** — camera XY + LiDAR Z = best of both sensors
- **UR5e as placeholder model** — swap for Estun S10-140 when URDF available
- **urdf-loader over manual DH** — URDF loader handles the full kinematic chain correctly; manual DH was broken
- **Binary WebSocket planned** for point cloud — 3-5x smaller than JSON, eliminates parsing
- **LiDAR view stays dark background** — better point cloud visibility per user request

---

*Last updated: May 28 2026*  
*Covers: Livox MID-360 LiDAR correction (not Ouster, IP 192.168.1.150, 12V DC, livox_ros_driver2, /32 host route), depth segmentation for any-object detection (no ML), 3D oriented bounding boxes with PCA/convex hull, OBB refinement (merge overlapping, hole filling, outlier removal), point cloud accumulation (near 5mm / far 3cm voxel), CPU TSDF reconstruction (2Hz mesh), camera-LiDAR alignment debugging (floor-anchored workaround), stereo camera cross-verification node, LiDAR-primary detection (RANSAC plane + 3D clustering), detection fusion (LiDAR position + camera detail), extrinsic calibration infrastructure (AprilTag + sensor_transforms.yaml), grasp pose generation (pre-grasp/grasp/retreat), UR5e URDF robot model (urdf-loader), scene graph motion tracking (path history, velocity, orientation), point cloud refresh optimization (20Hz, flat arrays, binary WS), 14 systemd services auto-starting on boot*

---

## Sessions 45–68: June 1–2, 2026 — GPU Fusion, Adaptive Picking, Part Recognition

---

### Section 45: GPU Point Cloud Fusion — Complete

**Before:** LiDAR-only point cloud, 41k points at 4Hz
**After:** LiDAR + cam0 (284k) + cam1 (276k) = ~580k pre-voxel → 65k post-voxel at 1Hz

| Stage | Before | After |
|-------|--------|-------|
| TF lookup camera→livox | Failing (DDS late-join) | Bypassed — yaml read directly |
| cam0 in fused cloud | Dropped | 283,861 pts/cycle ✓ |
| cam1 in fused cloud | Not subscribed | 275,973 pts/cycle ✓ |
| sensor_tf_publisher | Static (single broadcast) | 0.5 Hz periodic re-broadcast |
| Fused cloud output | 41k pts at 4 Hz | 65k pts at 1 Hz |
| Dashboard WS | 41k pts/frame | 65,574 pts/frame, 786 KB |

**CuPy GPU voxel downsample:** 1M points in 41ms benchmark
**Near voxel:** Changed from 0.005 to 0.003 for maximum density

---

### Section 46: Camera-LiDAR Alignment

**Problem:** Camera point clouds projecting as vertical walls in 3D viewer instead of lying flat on table surface.

**Livox MID-360 coordinate frame confirmed:**
- X-axis (forward) points AWAY from the cable exit
- Y-axis: left (standing behind cable, looking forward)
- Z-axis: up
- Cable exit = back of the sensor

**Physical setup from top-down photo:**
- cam0: ~30cm forward, ~5cm left, ~25cm above LiDAR, pointing ~70° down
- cam1: ~10cm forward, ~15cm left, ~25cm above LiDAR, pointing ~70° down

**Interactive alignment tool created:** `src/cobot_bringup/scripts/interactive_align.py`
- Keyboard commands: x+/x-/y+/y-/z+/z- (1cm steps), R+/P+/W+ (10° steps)
- Saves to sensor_transforms.yaml, restarts roboai-fusion
- RPY correction applied on top of base optical→ROS rotation

**sensor_transforms.yaml updated with:**
```yaml
cam0_to_lidar:
  translation: [0.30, 0.05, 0.25]
  rpy_correction: [-20.0, 0.0, 0.0]
cam1_to_lidar:
  translation: [0.10, 0.15, 0.25]
  rpy_correction: [-20.0, 0.0, 0.0]
```

**Rotation fix for downward-pointing cameras:** Base rotation optical→ROS then pitch correction for camera mounting angle.

---

### Section 47: Camera Point Clouds Removed from 3D View

**Decision:** Camera point clouds removed from 3D viewer — too hard to align reliably, and not needed for object detection.

**Rationale:**
- Camera depth segmentation already works for object detection (2mm resolution)
- LiDAR provides 360° room geometry for safety/navigation
- nvblox fuses camera depth internally for mesh reconstruction
- Fused point cloud with misaligned camera data causes more confusion than benefit

**What each sensor is best for:**
- **Object detection:** Camera depth segmentation (DONE ✅)
- **3D environment model:** LiDAR + nvblox mesh
- **Object position for picking:** Camera depth + LiDAR surface anchoring

---

### Section 48: nvblox Sparse Mesh — Still Broken

**Status:** nvblox running but only producing 790 vertices / 1170 triangles
**Expected:** 50k+ vertices for a proper workspace mesh

**Likely causes identified:**
- Camera depth images not being received (QoS mismatch)
- TF tree incomplete (needs map→odom→base_link→camera_frame)
- nvblox needs depth IMAGE topics, not PointCloud2 topics

**Deferred:** Separate focused session needed

---

### Section 49: Autonomous Task Generation Architecture

**Created:** `src/task_planner/task_planner/auto_program_node.py`

**Architecture:**
1. Subscribe to `/perception/scene_graph` (tracked objects with positions, sizes, orientations)
2. Build structured scene description JSON from scene graph
3. Send to Ollama (Llama 3.1 8B on :11434) with system prompt
4. LLM generates structured pick-and-place program JSON
5. Validate each step (check target exists, is graspable, within reach)
6. Publish to `/task/auto_program` and `/task/status`

**Dashboard integration:**
- "Generate Program" button → POST /cmd/generate_program
- Program panel updates with auto-generated steps
- systemd service: roboai-auto-program

**System prompt instructs LLM to:**
- Only pick objects where graspable=true
- Approach each object from above (top-down grasp)
- Align gripper yaw with object's yaw_deg
- Pick closest objects first
- Return JSON array of steps with action/target_id/position

---

### Section 50: STEP File Upload System — Created

**STEP parser:** `src/object_detection/object_detection/step_parser.py`
- Uses trimesh + cascadio (only aarch64 STEP loader that works)
- cadquery OCP has no ARM wheel, gmsh has no aarch64 wheel, pythonocc-core same
- Extracts: centroid, bounds, extents, volume, surface area, principal axes
- Converts mm→m if extents > 10
- Exports STL and GLB copies
- Computes grasp features (width, depth, flat detection)

**Part library:** `src/object_detection/object_detection/part_library.py`
- Storage: `/opt/cobot/parts/{step,stl,glb,metadata,teach,silhouettes,templates}/`
- Index file: `/opt/cobot/parts/index.json`
- CRUD operations: add_part, get_all_parts, get_part, delete_part
- Size-based matching: match_detection_to_part()

**API endpoints added to dashboard_server.py:**

| Endpoint | Method | Function |
|----------|--------|----------|
| /api/parts/upload | POST | Upload .step/.stp file, parse, add to library |
| /api/parts | GET | List all parts with teach_count |
| /api/parts/{id} | GET | Full part metadata |
| /api/parts/{id} | DELETE | Remove part and all files |
| /api/parts/{id}/config | PUT | Save table surface, orientation, grasp settings |
| /api/parts/{id}/teach | POST | Teach a part (capture reference) |
| /api/parts/{id}/teach_clear | POST | Clear taught references |
| /api/parts/match | POST | Match detection to part by dimensions |
| /cmd/detection_mode | POST | Toggle All Objects / Library Parts mode |

**Static file serving:** /parts/glb and /parts/stl mounted for browser access

---

### Section 51: Adaptive Picking Tab — Created

**New top nav tab:** Monitor | Program | 3D View | Sensors | **Adaptive Picking** | Configure

**Page layout (AdaptivePicking.jsx):**
- **Left panel (280px):** Parts Library list, Upload STEP File button, drag-drop zone, filter tags
- **Center:** Interactive 3D part viewer (Three.js Canvas, white background)
- **Right panel:** Configuration options

**3D Viewer features:**
- Part model rendered from GLB via GLTFLoader (fallback to STLLoader)
- White background with grey grid floor
- Part always sits above grid regardless of orientation (Y-position recalculated after rotation)
- Metallic grey material (color: #A8B0C0, metalness: 0.5, roughness: 0.35)
- OrbitControls for rotate/zoom/pan
- Shadow under part for depth perception
- Axes helper in corner

**Parts uploaded:**
- BT225L24_a: 3.8 × 2.6 × 5.1 cm (4 taught samples initially)
- BT225L28_a: 3.8 × 2.8 × 5.1 cm (10 taught samples)
- BT225L13_a: 6.3 × 1.9 × 1.3 cm (8 taught samples)
- BT225L22_a: 1.9 × 2.2 × 18.4 cm (2 taught samples)

---

### Section 52: Part Configuration UI

**Table Surface selection (6 options):**
+Z up (top) | −Z up (bottom) | +X up (right) | −X up (left) | +Y up (front) | −Y up (back)
- Clicking a button rotates the 3D model to show that face down
- Model repositioned so bottom always touches Y=0 grid

**Front Direction (4 arrows):** ↑ → ↓ ←
- Sets yaw reference — which direction the "front" of the part faces
- Blue arrow on ground plane in 3D viewer

**Pick Direction — Face-click system:**
- Operator clicks a face on the 3D model
- Raycaster determines which face was hit
- Face normal becomes the pick approach direction
- Green arrow rendered pointing toward the clicked face
- Green circle highlights the selected face
- Replaces the Top Down / Side / Angled buttons (removed)

**Approach Height slider:** 0.5–15cm above part
- Controls how far the green arrow is from the surface
- Arrow moves in real-time as slider changes

**Save Configuration:** PUT /api/parts/{id}/config
- Saves table_surface, table_rotation, front_direction, front_angle_deg, pick_normal, pick_point, approach, pick_offset_cm
- Shows "✓ Saved!" confirmation
- Settings persist and reload when part is re-selected

---

### Section 53: Gripper Type Selection — Added then Removed

**Initially added:**
- Finger Gripper vs Suction Cup toggle buttons
- 3D visualization of selected gripper above part
- Finger gripper: parallel jaw visualization (two rectangular fingers + mount plate)
- Suction cup: bellows, lip ring, vacuum tube, manifold
- Settings: cup diameter, number of cups (1/2/4), vacuum threshold
- Gripper width slider, finger depth slider

**Later removed:** Per user request, simplified to face-click approach direction only. Gripper settings, operation tags, robot program dropdown, station field, priority slider, and notes box all removed as premature UI that adds clutter.

---

### Section 54: Detection Mode Toggle

**Toggle added to camera view:** "All Objects" | "Library Parts"

**All Objects mode (default):**
- Detect everything via depth segmentation
- Green boxes around any object
- Labels show distance + dimensions

**Library Parts mode:**
- Only show detections matching a library part
- Blue boxes with part names and match percentage
- Unknown objects hidden from camera feed and DETECTED OBJECTS panel
- Camera banner: "LIBRARY MODE — N parts matched"

**Implementation:**
- Frontend: Zustand store `detectionMode: 'all'`
- POST /cmd/detection_mode → publishes to /perception/detection_mode
- depth_segment_node subscribes, filters detections in library mode

---

### Section 55–60: Part Recognition — Multiple Approaches, Ongoing Issues

**Approach 1: CAD Silhouette Matching (generate_silhouettes in step_parser.py)**
- Renders STEP mesh from 12 top-down yaw angles = 12 silhouette PNGs per part
- Each carries: Hu moments (7), contour signature (36-bin radial distance), aspect ratio, solidity, area ratio
- Stored in /opt/cobot/parts/silhouettes/
- **Result:** Unreliable. Camera sees depth+shadows, CAD is clean geometry.

**Approach 2: Shape Matcher (shape_matcher.py match_geometry)**
- Extracts geometric features from STEP: hole count, height map 32×32, edge map 32×32, outline, aspect, symmetry
- Matches against camera detection features extracted in depth_segment_node
- Weighted: holes 25%, contour signature 30%, solidity 10%, aspect 10%, size 25%
- **Result:** False matches on flat/featureless parts. Hole detection fails (table depth fills holes).

**Approach 3: Teach-based depth matching**
- Operator teaches each part via teach wizard
- Captures depth crop + mask, normalized to 64×64
- NCC comparison against taught references
- **Result:** 64×64 normalization loses size information. 4cm and 6cm parts look identical.

**Approach 4: RGB + depth teach matching**
- Added color crop storage in teach captures
- Grayscale NCC weighted 45%, mask IoU 20%, depth 10%, size 25%
- **Result:** Small crops normalized to same size still produce false matches.

**Approach 5: Scale-aware teach matching**
- Store px_per_cm with each teach reference
- Resize detection to same physical scale as reference before comparing
- **Result:** Better but OBB dimensions from depth are inaccurate (±30%).

**Approach 6: STEP dimensions as absolute size gate**
- Use exact STEP file dimensions for first filter
- Aspect ratio comparison: BT225L28_a (1.35:1) vs BT225L13_a (3.32:1) → reject
- All dimensions must be within 50%, aspect within 50%
- Applied BEFORE any image comparison
- **Result:** Most effective fix. Eliminates most false positives.

**Approach 7: Multi-orientation CAD templates (FINAL — deployed)**
- Generates 6 orientations × 12 yaw angles = 72 templates per part
- Each template: binary mask, edge map, dimensions, aspect, fill ratio
- Orientations: top (+Z up, "pickable"), bottom (-Z up, "flipped"), 4 sides ("on_side")
- Template matching replaces teach + CAD geometry matching as sole recognition source
- Tags each detection with orientation: pickable / flipped / on_side
- **Color coding:** Blue = matched+pickable, Red = matched+flipped, Orange = matched+on_side, Green = unknown

**Key problems identified:**
- NCC on 64×64 normalized blobs matches everything (too abstract)
- Size gating must happen FIRST (STEP dimensions are exact)
- Holes rarely detected in camera (table depth fills hole area)
- Flat objects all look the same in depth (nearly zero height variation)
- Minimum detection size needed (1×1cm = table scratches, not parts)

---

### Section 61: Teach Wizard UI — Created

**Full-screen teaching overlay in Adaptive Picking page:**

**Wizard flow:**
- Step 0: Introduction — explains the process
- Steps 1–4: Capture at 0°, 90°, 180°, 270° yaw angles
- Step 5: Review — shows captured angles, done button

**Features:**
- Live camera feed (MJPEG stream from /stream/cam0)
- Clickable detection boxes on camera overlay (green boxes, blue when selected)
- Angle indicator circles (0° 90° 180° 270°) — green checkmark when captured
- "Capture Nearest Object" button — works without clicking a specific detection
- Green flash animation on successful capture
- Part orientation selector: Pickable | Flipped | Left Side | Right Side | Front | Back
- Capture sends orientation with the teach API call
- Summary of captures by orientation shown as colored pills
- Teach mode signal: POST /api/teach_mode/start suppresses recognition during teaching

**Teach mode in depth_segment_node:**
- When teach_mode=True, all detections marked as unknown (no part names)
- Camera shows clean green boxes only during teaching
- Recognition resumes when wizard closes

---

### Section 62: Bounding Box Accuracy Fixes

**Problem 1: Boxes jitter between frames**
- Fix: Temporal smoothing via EMA tracker (alpha=0.3)
- Each detection matched to previous frame tracks by IoU
- Box position, size, yaw smoothed across frames
- Missing tracks aged out after 5 frames

**Problem 2: Boxes larger than actual parts**
- Root cause found: `sub_fg = foreground[y0:y1, x0:x1]` used inflated foreground mask instead of tight clean single-component mask for OBB fitting
- Fix: Recompute clean single-component mask in the tight bbox coordinates before passing to _refine_object_points
- Padding reduced from 5px to 2px

**Problem 3: 3D OBB projects to wrong 2D position**
- Root cause: depth noise shifts 3D centroid, perspective projection amplifies error
- Fix: Draw 2D minimum-area rotated rectangle directly from mask pixels instead of projecting 3D corners
- New function: `_min_area_rect_2d()` — convex hull + rotating calipers in pixel space
- Box is always pixel-accurate — no 3D round-trip
- Replaces both the axis-aligned rectangle and the cyan wireframe

**Problem 4: Depth averaging for mask stability**
- 3-frame depth buffer averaged to reduce per-frame noise
- Morphological closing (5×5) stabilizes mask edges

**Annotation improvements:**
- Larger font: DejaVuSans-Bold 16px for matched parts, 13px regular for unknown
- Solid filled background rectangle behind text for contrast
- Box line width: 3px
- Label positioned at topmost point of rotated OBB

---

### Section 63: Minimum Detection Size

**Filter added:** Reject detections with both dimensions < 1.5cm
- Eliminates table scratches, dust, sensor noise
- Applied after OBB computation, before any matching

**Fill ratio filter:** Reject if mask fills < 15% of bounding box (mostly background)

---

### Section 64: Gantt Chart Generated

**Created:** roboai_gantt_chart.xlsx (3 sheets)

**Sheet 1 — Gantt Chart:**
- 10 phases, 79 tasks total
- 16-week timeline: May 18 – Sep 7, 2026
- Color coded: green=complete, amber=in progress, blue=planned, red=blocked
- Dependencies column, owner (Dev/CC/Estun)

**Sheet 2 — Summary:**
- Task counts per phase with completion percentages
- Key milestones with target dates

**Sheet 3 — Risk Register:**
- 8 risks: Estun driver (critical), torch broken (mitigated), nvblox sparse (active), alignment (active), PAT exposure (mitigated), USB bandwidth (monitoring), LiDAR sparse (accepted), code not committed (active)

---

### Section 65: Code Audit — Missing Files

**Critical finding:** Multiple files created by Claude Code on the Jetson were never committed to git.

**Files missing from repo (existed on Jetson only):**
- shape_matcher.py — never committed
- part_library.py — never committed
- step_parser.py — never committed
- AdaptivePicking.jsx — never created in repo
- Adaptive Picking tab — not in TopBar.jsx
- Parts API endpoints — not in dashboard_server.py
- Teach integration — not in depth_segment_node.py

**Resolution:** Comprehensive rebuild prompt created that recreates all files and forces git add/commit/push at the end.

**Lesson learned:** Always verify files are committed after Claude Code sessions. Use `git status` and `git diff` to confirm.

---

### Section 66: OAuth Token Exposure Incident

**Issue:** Claude Code redaction check used snake_case (access_token) but credentials file uses camelCase (accessToken). Raw OAuth tokens printed in conversation.

**Resolution:**
- Immediate /logout + /login to rotate tokens
- Tokens expired same day (expiresAt ~15:31 UTC)
- Auth type: claudeAiOauth, subscriptionType: team, rateLimitTier: default_raven

---

### Section 67: Lighting Recommendation

**Assessment:** Lighting is the single biggest non-software improvement for detection accuracy.

**Current issues caused by ambient lighting:**
- Shadows shift with time of day → depth mask shape changes between frames
- Metal parts → specular reflections → depth holes + RGB blowout
- Table similar color to parts → low contrast edges

**Recommendation: USB ring light ($30-50) mounted around cam0**
- Eliminates shadows (light from all directions around lens)
- Reduces specular reflections on metal (diffuse = no hot spots)
- Consistent lighting regardless of time of day
- Improves RealSense IR pattern reading → better depth accuracy

**Alternative options:**
- Backlight (under translucent table): perfect silhouettes, requires table change
- Diffuse dome light: best possible, expensive ($200+)

---

### Section 68: Dynamic Camera Alignment for Moving Cameras

**Discussion:** When cameras move to robot head, static transforms replaced by forward kinematics.

**Current (cameras on table):** Fixed transform from sensor_transforms.yaml
**Future (cameras on robot head):** URDF + /joint_states → robot_state_publisher → dynamic TF

**Scanning workflow:**
1. Robot moves to scan pose 1 → joint angles update → TF computes camera frame
2. Fusion transforms camera points using new TF → points added to accumulated cloud
3. Repeat for 5-8 poses → complete 360° workspace coverage

**What needs to exist when robot connects:**
1. Estun URDF (3D model with joint definitions)
2. Estun driver publishing /joint_states at 50Hz+
3. robot_state_publisher reading URDF
4. Camera-to-flange calibration (one-time)
5. Scan pose list (5-8 joint configurations)

---

### Updated Parts Library (June 2 2026)

| Part | Dimensions (cm) | Teach Refs | STEP Templates | Status |
|------|-----------------|------------|----------------|--------|
| BT225L24_a | 3.8 × 2.6 × 5.1 | 4 | 72 (6×12) | Taught |
| BT225L28_a | 3.8 × 2.8 × 5.1 | 10 | 72 (6×12) | Taught |
| BT225L13_a | 6.3 × 1.9 × 1.3 | 8 | 72 (6×12) | Taught |
| BT225L22_a | 1.9 × 2.2 × 18.4 | 2 | 72 (6×12) | Needs more teach angles |

---

### Updated systemd Services (June 2 2026)

| Service | Status | Notes |
|---------|--------|-------|
| roboai-cameras | ✅ Active | Both D435i cameras |
| roboai-lidar | ✅ Active | Livox MID-360 |
| roboai-accumulator | ✅ Active | Point cloud accumulator |
| roboai-reconstruction | ✅ Active | CPU TSDF mesh |
| roboai-depth-segment | ✅ Active | Depth segmentation + OBB + part recognition |
| roboai-lidar-detect | ❌ Disabled | 22 spurious clusters |
| roboai-fusion | ✅ Active | LiDAR-only (camera clouds removed) |
| roboai-stereo | ✅ Active | Camera cross-verification |
| roboai-scene-graph | ✅ Active | Kalman tracker |
| roboai-grasp | ✅ Active | Grasp pose generation |
| roboai-tf | ✅ Active | 0.5Hz periodic TF re-broadcast |
| roboai-isaac | ❌ Disabled | Isaac ROS pipeline (depth seg preferred) |
| roboai-detector | ❌ Disabled | TRT detector (depth seg preferred) |
| roboai-dashboard | ✅ Active | Production server :8080 |
| roboai-nvblox | ✅ Active | GPU mesh (790 verts — needs fix) |
| roboai-auto-program | ✅ Active | LLM task generation |

---

### Updated Dashboard Tabs (June 2 2026)

Monitor | Program | 3D View | Sensors | **Adaptive Picking** | Configure

| Tab | Status | Features |
|-----|--------|----------|
| Monitor | ✅ | Split/single camera, detection overlays, mode toggle |
| Program | ✅ | 5-step pick/place, Generate Program button |
| 3D View | ✅ | LiDAR point cloud, safety rings, height coloring |
| Sensors | ✅ | Camera streams, depth overlays |
| Adaptive Picking | ✅ | STEP upload, 3D viewer, face-click pick direction, teach wizard |
| Configure | ✅ | System settings |

---

### Key Decisions Made These Sessions

- **Camera point clouds removed from 3D view** — alignment too unreliable, cameras better for 2D detection
- **Template matching replaces teach + CAD geometry matching** as sole recognition source
- **STEP file dimensions as absolute size gate** — most effective filter against false matches
- **2D minimum-area rotated rectangle** for camera annotations (not projected 3D OBB)
- **Face-click for pick direction** — replaces Top Down / Side / Angled buttons
- **Gripper type UI removed** — premature, simplified to arrow only
- **Operation tags, robot program, station, priority, notes removed** — premature UI clutter
- **Teach mode suppresses recognition** — clean green boxes during teaching
- **6 orientation × 12 yaw = 72 templates per part** — covers all possible orientations
- **Ring light recommended** — single biggest non-software improvement for detection accuracy
- **LiDAR view stays dark background** — user preference maintained

---

### Key Pending Items (June 2 2026)

| Item | Priority | Blocker |
|------|----------|---------|
| Part recognition accuracy | HIGH | Size gating deployed, teach system rebuilt, needs validation |
| Teach BT225L22_a more angles | HIGH | Only 2 refs, needs 4+ |
| Ring light for camera | HIGH | Purchase needed |
| nvblox sparse mesh fix | MEDIUM | 790 verts, should be 50k+ |
| Estun S10-140 arm driver | CRITICAL | Waiting on protocol document from supplier |
| MoveIt2 configuration | HIGH | Blocked on arm driver |
| Extrinsic calibration (AprilTag) | MEDIUM | Infrastructure built, not yet run |
| Full autonomous task generation loop | MEDIUM | Needs arm + detection stability |
| NanoOWL open-vocabulary detection | LOW | Planned after detection stabilized |

---

*Last updated: June 2, 2026*
*Covers sessions 45-68: GPU point cloud fusion (CuPy, 65k pts), camera-LiDAR alignment (interactive tool, physical measurements), camera clouds removed from 3D view, nvblox sparse mesh diagnosis, autonomous task generation (Ollama/Llama 3.1 8B), STEP file upload system (trimesh+cascadio), GLB/STL conversion, Adaptive Picking tab (3D viewer, face-click pick direction, teach wizard), part recognition iterations (7 approaches: silhouettes → shape matcher → teach depth → teach RGB → scale-aware → STEP size gate → multi-orientation templates), bounding box accuracy (2D rotated rectangle from mask, temporal EMA smoothing, tight clean_mask fix), detection mode toggle, minimum detection size filter, Gantt chart (79 tasks, 16 weeks), code audit (missing files never committed), OAuth token rotation, lighting recommendation, 6-orientation teaching*

---

## Sessions 69–117: June 3, 2026 — Dashboard Overhaul, Program Editor, Wizard, Jog Controls, Monitor

---

### Section 69: Multi-Orientation STEP Templates for Flipped Parts

**Problem:** When parts are flipped upside down, the camera sees a completely different outline (e.g. flat bottom instead of holes/slots on top). The existing 36 templates (top-down only) cannot match flipped parts.

**Solution:** Generate templates from ALL 6 viewing directions:
- +Z up (normal/pickable) — camera looks down at top
- -Z up (flipped) — camera looks down at bottom
- +X up (right side) — resting on right
- -X up (left side) — resting on left
- +Y up (front up) — resting on front face
- -Y up (back up) — resting on back face

Each orientation gets 12 yaw angles = 6 × 12 = 72 templates per part.

**Each template tagged with orientation:**
- `orient_name`: top/bottom/right/left/front/back
- `orient_label`: pickable/flipped/on_side

**Annotation color coding:**
- Blue = matched + pickable orientation
- Red = matched + FLIPPED (needs turning over)
- Orange = matched + ON SIDE

**Decision:** Template matcher REPLACES teach + CAD geometry matching as sole recognition source.

---

### Section 70: Reliable Part Matching Rewrite

**Root cause analysis of 7 failed approaches:**

| Approach | Why it fails |
|----------|-------------|
| CAD silhouette matching | Camera sees depth+shadows, CAD is clean geometry |
| CAD height map NCC | Both flat parts are mostly zero — NCC matches everything |
| Teach depth NCC 64×64 | Normalizing to 64×64 loses all size information |
| Teach RGB NCC 64×64 | Same — 4cm and 6cm parts look identical at 64×64 |
| Size gating alone | OBB dimensions from depth inaccurate (±30%) |
| Multi-orient templates | CAD renders don't match real camera images |
| Scale-aware teach | Better but OBB still too inaccurate |

**New approach (3 pillars):**
1. STEP file → exact dimensions → strict size gate (eliminates 90% wrong matches)
2. Teach captures → FULL resolution RGB averaged over multiple frames
3. Match → resize detection to same pixels-per-cm as reference → raw pixel comparison

**Key changes:**
- Size gate using STEP dimensions BEFORE any image comparison
- Aspect ratio comparison: BT225L28_a (1.35:1) vs BT225L13_a (3.32:1) → reject
- OpenCV template matching at physical scale
- 5-frame depth averaging for mask stability
- Full resolution teach captures (not downsampled)

---

### Section 71: Lighting Recommendation

**Assessment:** Lighting is the single biggest non-software improvement for detection accuracy.

**Recommendation:** USB ring light ($30-50) mounted around cam0
- Eliminates shadows (light from all directions around lens)
- Reduces specular reflections on metal
- Consistent lighting regardless of time of day
- Improves RealSense IR pattern reading → better depth

---

### Section 72: 6-Orientation Teach Wizard

**Extended teach wizard with 6 orientation options:**
- Pickable (top up — correct for picking)
- Flipped (upside down — needs flipping)
- Left Side (resting on left)
- Right Side (resting on right)
- Front (resting on front face)
- Back (resting on back face)

**Wizard flow redesigned:**
- Step 1: Teach pickable orientation (capture multiple angles)
- Step 2: Teach additional orientations (flipped, sides — optional but recommended)
- Step 3: Review — shows capture counts per orientation as colored pills
- Orientation sent with each teach API call
- Free-form capture instead of forced 4-step

---

### Section 73: Program Library Tab Added

**New top nav tab:** Programs — shows library of all saved robot programs.

**Features:**
- List of saved programs from /opt/cobot/programs/
- Search by name or tag
- Click to see program details (steps, settings)
- Edit button → loads program into Program editor tab
- Duplicate and Delete buttons
- New Program button (later moved to Program tab)

**API endpoints:**
- GET /api/programs — list all saved programs
- GET /api/programs/{id} — get full program
- POST /api/programs — create new program
- PUT /api/programs/{id} — update existing
- DELETE /api/programs/{id} — delete
- POST /api/programs/{id}/duplicate — copy program
- POST /api/programs/{id}/run — execute program

**3 default programs created:** Pick and Place, Scan Workspace, Sort Parts by Type (later removed at user request — only user-created programs kept).

---

### Section 74: Dashboard Build/Deploy Issue

**Problem:** Dashboard changes not appearing after Claude Code edits.

**Root cause:** A `colcon build` ran WITHOUT `--symlink-install`, which COPIES files to `install/` instead of symlinking. Subsequent source edits invisible to the running server.

**Fix:** Always use:
```bash
rm -rf build/cobot_dashboard install/cobot_dashboard
colcon build --packages-select cobot_dashboard --symlink-install
sudo systemctl restart roboai-dashboard
```

---

### Section 75: I/O Panel Replacing Scene Graph

**Created:** IOPanel.jsx component replacing Scene Graph in Sensors tab.

**I/O Configuration:**
- 16 Digital Inputs (X0.0–X1.7): Gripper sensors, safety, conveyors
- 16 Digital Outputs (Y0.0–Y1.7): Gripper control, vacuum, signals
- 4 Analog Inputs (A0–A3): Force, pressure, temperature
- 2 Analog Outputs (DA0–DA1): Gripper force, conveyor speed

**Features:**
- LED indicators for input status (green ON, grey OFF)
- Toggle switches for digital outputs
- Bar graphs for analog inputs with value display
- Sliders for analog outputs
- Editable labels — click any signal name to rename inline
- Labels saved to /opt/cobot/io_config.json and persist across restarts
- Reset Labels button to restore defaults
- Labels always visible regardless of ON/OFF state (fixed bug where labels disappeared when toggled ON)

**API endpoints:**
- GET /api/io/state — poll I/O values at 4Hz
- POST /api/io/set — set output value
- GET /api/io/config — load custom labels
- PUT /api/io/config — save custom labels

---

### Section 76: Program Step Drag-and-Drop with Insertion Indicator

**Drag-and-drop reordering added to ProgramPanel:**
- Drag handle (:::) on each step
- Dragged step becomes semi-transparent (30% opacity)
- Bright blue insertion bar (4px) with glow shows exactly where step will land
- Top/bottom half detection on each step for precise insertion position
- Steps renumber automatically after drop
- Steps visually shift apart to show insertion point

**Also added:**
- Click step to select (blue highlight, one at a time)
- Click step name to edit inline (text input sized to content, not full width)
- Edit button opens full step editor (action type, all parameters)
- Delete button with confirmation

---

### Section 77: Program Wizard — Conversational Step-by-Step

**Created:** Full program wizard that walks operators through building a program one question at a time.

**Wizard pages (each asks ONE question):**
1. What operation? (Pick & Place, Sort, Machine Tend, Palletize, Inspect)
2. How to find parts? (Camera Auto, Library Part, Fixed Position)
3. Which part? (if Library Part selected — shows parts library)
4. Gripper type? (Finger, Vacuum, Magnetic)
5. Gripper settings (width, force, vacuum threshold)
6. Speed? (Slow/Medium/Fast or custom slider)
7. Approach height? (slider 20–300mm)
8. Where to place? (Fixed, Relative, Pallet Grid, Sort by Type)
9. Pallet config (if palletize — rows × columns)
10. Machine I/O (if machine tend — cycle start/done signals from I/O labels)
11. Repeat? (Once, Continuously, Set count)
12. Name the program
13. Review — shows all steps, settings, Save button

**Answer-driven navigation:** Each answer determines the next question. Skip irrelevant pages automatically. Back button with history.

**Program generation includes proper safety moves:**
- Every pick: approach → descend (≤30% speed) → grip → lift (≤40% speed)
- Every place: move above → descend (≤30% speed) → release → lift (≤40% speed)
- Machine tend descents at ≤20% (extra cautious near fixtures)
- Vacuum operations include blow-off sequence
- I/O cycle start cleared after machine wait

---

### Section 78: Program Save/Load Workflow

**Save button added to Program tab header:**
- Tracks programId (null for unsaved programs)
- Save creates new program (POST) or updates existing (PUT)
- Amber dot indicator for unsaved changes
- Green "Saved" confirmation flash
- Program name editable inline in header

**Load button:**
- Dropdown shows all saved programs from /api/programs
- Click to load into editor (sets programId, name, steps)

**Wizard integration:**
- Wizard saves via POST /api/programs → returns program with ID
- Program loads into editor with ID set
- Subsequent saves update the same program

---

### Section 79: Program Library Edit Button

**Edit button wired through Zustand store:**
- ProgramLibrary → fetch /api/programs/{id} → setLoadedProgram(prog) → setActiveTab('program')
- ProgramEditor → useEffect watches loadedProgram → loads steps/name/id → clears loadedProgram
- Both activeTab and loadedProgram in Zustand store (not local state)

---

### Section 80: Program State Persistence Across Tab Switches

**Problem:** Switching from Program to Programs tab and back reset the program name to "Untitled".

**Root cause:** ProgramPanel used local useState which resets on component unmount.

**Fix:** Moved all program state to Zustand store:
- currentProgram: { id, name, steps, unsaved }
- setCurrentProgram: merges updates
- Store persisted across tab switches and page reloads

---

### Section 81: Gripper I/O Port Linking

**Step editor enhanced for gripper actions:**
- open_gripper and close_gripper steps show I/O Port Assignment section
- Dropdowns for: Open signal (output), Open confirm (input), Close signal (output), Close confirm (input)
- Dropdowns populated from /api/io/config with custom label names
- Shows: "Y0.0 - Gripper Close" or "X0.1 - Gripper Open Sensor"
- Default I/O pre-assigned in wizard-generated programs
- set_io action also uses IOPortSelector dropdown
- Step detail line shows assigned I/O names (resolved from labels)

---

### Section 82: UI Cleanup

**Items removed/moved:**
- Default programs (pick_and_place, scan_workspace, sort_by_type) removed from /opt/cobot/programs/
- Auto-creation code for default programs removed from dashboard_server.py
- New Program button moved from Programs library to Program tab (alongside Wizard and Load)
- "+ Blank" button added for empty program creation
- "Adaptive Picking" renamed to "Part Recognition" in top nav

---

### Section 83: Split View Redesign

**SPLIT sidebar button view redesigned:**
- 2×2 grid: Cam 0 (top-left), Cam 1 (top-right), LiDAR (bottom, full width)
- Each panel has expand/collapse button
- Expand: panel fills entire area
- Collapse (X button): returns to 3-panel grid
- Cam 0 uses annotated stream (with detection overlays)
- All panels update in real time

---

### Section 84: Program Tab Layout Redesign

**Three-panel resizable layout:**
- LEFT: Program steps panel (resizable, min 380px, max 75% screen)
- RIGHT: 3D robot viewer (white background, ArmViewer3D with URDF)
- BOTTOM: Jog controls panel (resizable, min 280px, max 60% height)

**Resizable panels:**
- Vertical divider between program steps and 3D viewer (drag to resize)
- Horizontal divider above jog panel (drag to resize)
- Visual feedback: blue tint on drag handle, red tint at min/max limits
- Sizes stored in Zustand store → persist across tab switches

**3D Viewer:** White background (changed from dark #0a0a12)

---

### Section 85: Force Sensor Recommendation

**Top recommendation for Estun S10-140 ECO:**

| Sensor | Price | Interface | ROS2 Driver | Best For |
|--------|-------|-----------|-------------|----------|
| Bota SensONE | ~$2,500 | Ethernet | Native ROS2 Humble | Best value, recommended |
| OnRobot HEX-E/H | ~$4,000 | Ethernet | Community | Plug-and-play cobots |
| ATI Axia80 | ~$6,000 | EtherCAT | Community | Production-grade |
| Bota MiniONE | ~$1,500 | USB/SPI | ROS2 compatible | Budget/small cobots |

**Alibaba 6-axis sensor ($1,500) assessed:**
- Analog output only — needs external ADC ($200-500)
- No communication protocol (no Ethernet, no USB, no driver)
- Jetson has NO analog inputs — needs Arduino/Phidget/NI DAQ bridge
- New seller, no calibration certificate
- Total cost with electronics: ~$2,000-2,200 + weeks of driver work
- Recommendation: spend extra $1,000 for digital sensor (Bota SensONE)

**Force sensor enables:**
- Hand-guiding (lead-through teaching)
- Force-controlled assembly
- Collision detection (faster than joint torque monitoring)
- Grasp verification

---

### Section 86: Jog Controls Redesign

**Visual directional arrow pad layout:**

**XYZ (Cartesian) mode:**
- LEFT: Position D-pad (Y+, X-, X+, Y-) — colored arrows around center
- CENTER: Height column (Z+, Z-) — blue arrows
- RIGHT: Rotation D-pad (Rx+, Rz-, Rz+, Rx-) — purple/yellow arrows

**Joint mode:**
- 6 columns (J1–J6) with up arrow (green, +) and down arrow (red, -)

**Layout reorganized:** LEFT: mode buttons + settings | CENTER: arrow pads | RIGHT: Run/Pause/Stop/Home/Teach

**Tablet improvements:**
- Arrow buttons: 80×80px (110×110px when maximized)
- SVG arrows: 36px (48px maximized)
- Minimum 44px touch targets on all interactive elements
- Touch event handlers (onTouchStart/End/Cancel) on all jog buttons
- Hold-to-jog: continuous movement at 10Hz while finger held down
- No pinch-zoom (viewport meta: user-scalable=no)
- No text selection on long press (userSelect: none)
- Maximize button: jog panel fills entire Program tab area
- I/O toggle switches enlarged (44×24px)

---

### Section 87: Taught Position Indicators

**Every move step shows taught/untaught status:**

**TEACHABLE_ACTIONS:** move_home, move_joint, move_linear, approach, pick, place
**NOT teachable:** open_gripper, close_gripper, wait, detect, loop, set_io

**Visual indicators:**
- Green circle with "T" = position taught
- Red dashed circle with "!" = position NOT taught
- Detail line shows joint values and TCP in green when taught
- "NOT TAUGHT" in red when untaught

**Teach button on each move step:**
- Click "Teach" → records current robot joint positions and TCP from /api/state
- Button changes to "Re-teach" after teaching
- Stores: taught_joints, taught_tcp, taught_at, joints, position

**Warning banner:** "X positions not taught" with count

**Teach All sequential flow:**
- Steps through each untaught move step one by one
- "Record Position" / "Skip" / "Cancel" buttons
- Advances to next untaught step automatically

**Save Path button:** Active when all positions taught, saves motion path with program

---

### Section 88: Standard Bots UI Analysis

**Features adopted from Standard Bots interface:**

**1. Right-click context menu on each step:**
- Edit step, Add step above, Add step below, Copy, Rename, Resume from step, Delete
- Clean dividers between action groups
- Red text for Delete

**2. Categorized Add Step panel:**
- Motion: Move Home, Move Joint, Move Linear, Approach
- Pick and Place: Pick, Place, Open Gripper, Close Gripper
- Control: Loop, Wait, Detect, Set I/O
- 2-column grid with description text

**3. Lock Editing toggle:**
- Prevents accidental changes during production
- Hides Edit/Del/Teach buttons, disables drag, disables name editing
- Red "Locked" indicator when active

---

### Section 89: Edit Bug Fix — All Steps Opening in Edit Mode

**Bug:** Clicking Edit on one step opened ALL steps in edit mode.

**Root cause:** Steps from wizard or persisted store had no `id` field (all `undefined`). When Edit clicked:
- `setEditingId(step.id)` → `setEditingId(undefined)`
- `editingId === step.id` → `undefined === undefined` → TRUE for ALL steps

**Fix (3 layers):**
1. Safety renumber on load: if any step lacks numeric id, call `renumber()` to assign ids 1, 2, 3...
2. Guard on Edit click: reject if `step.id` is not a number
3. Guard on render condition: `editingId !== null && editingId !== undefined && editingId === step.id`

---

### Section 90: Sensors Tab Expand/Collapse

**Sensors tab panels with individual expand/collapse:**
- 2×2 grid: Cam 0 (top-left), Cam 1 (top-right), LiDAR (bottom-left), I/O (bottom-right)
- Expand button on each panel → fills entire area
- X button to collapse → returns to grid
- All panels functional in both views

---

### Section 91: I/O Tab Separated from Sensors

**New dedicated I/O top tab:**
- Full IOPanel component with all inputs, outputs, labels, toggles
- Removed from Sensors tab

**Sensors renamed to "Cameras & LiDAR":**
- Shows only: Cam 0, Cam 1, LiDAR 3D view
- 2×2 grid with LiDAR spanning bottom full width
- Each panel has expand/collapse

---

### Section 92: Safety Moved to Top Tab

**Safety button removed from left sidebar, added as top tab.**
- Placeholder page for safety zone configuration, speed limits, collision detection settings

---

### Section 93: Left Sidebar Removed

**Entire left sidebar removed.** All functionality moved to top tabs.
- SideNav component removed from layout
- Main content takes full screen width
- No left margin/padding offset

---

### Section 94: Monitor Dashboard Redesign

**Monitor tab redesigned as main operational dashboard:**

**Top section:**
- Robot status badge: IDLE / RUNNING / PAUSED / ERROR / HOMING (animated pulse when running)
- Current program name and description
- Current step indicator with step number and label
- Quick action buttons: Run (green) / Pause (yellow) / Stop (red) / Edit Program

**Camera feed:**
- Live annotated camera stream (400×280px)
- "LIVE" badge
- Detection count overlay

**Stats row (4 cards):**
- Speed (%), Cycle Count, Cycle Time (s), Objects Detected

**Pick counter:**
- Large today count (42pt font)
- Shift count and all-time total
- Hourly trend bar chart (last 12 hours)

**Cycle results:**
- Last cycle pass/fail indicator (large OK/NG circle)
- Pass/fail counts
- Last 20 cycles as colored dots (green=pass, red=fail)

**Time remaining:**
- Countdown timer and ETA for counted programs
- Cycles done / total with progress bar
- Percentage complete

**I/O summary:**
- Compact row of 8 key signals with green/red indicators
- Uses custom labels from I/O configuration

**Fault log:**
- Last 5 events with severity (error/warning/info), message, timestamp

**Program steps progress:**
- Color-coded progress bar (green=done, blue=current, grey=pending)
- Grid of all steps with status indicators

**No program loaded state:**
- "No program loaded" with buttons to Open Library or Create New

---

### Section 95: Monitor — Part Viewer, Pick Stats, Cycle Time Chart

**Part 3D Viewer on Monitor:**
- Shows the STEP file model of the part being picked in current program
- GLTFLoader (GLB) with STLLoader fallback
- Part dimensions and teach ref count shown below model
- "No part assigned" if program has no target part
- Part ID extracted from program config (wizard stores target_part)

**Program-specific Pick Performance:**
- Circular donut chart showing pass rate percentage
- Color coded: ≥90% green, ≥70% yellow, <70% red
- Pass/fail/total counts
- Failure reasons breakdown with horizontal bar chart
- Per-program stats (not global)

**Cycle Time History Chart:**
- SVG line chart of last 50 cycle times
- Average line (dashed blue)
- Fill area under curve
- Stats: Avg, Min, Max
- Updates every 5 seconds

**Backend endpoints:**
- GET /api/stats/program/{id} — pass/fail/total/fail_reasons per program
- GET /api/stats/program/{id}/cycle_times — historic cycle time data
- GET /api/stats/picks — today/shift/total/per_hour
- GET /api/stats/cycles — recent 20 cycle results
- GET /api/stats/events — recent 10 events

---

### Updated Dashboard Tabs (June 3, 2026)

Monitor | Programs | Program | 3D View | Cameras & LiDAR | I/O | Part Recognition | Configure | Safety

| Tab | Status | Features |
|-----|--------|----------|
| Monitor | ✅ | Status badge, program info, camera feed, stats, pick counter, cycle results, time remaining, I/O summary, fault log, part 3D viewer, pick performance, cycle time chart |
| Programs | ✅ | Program library, search, Edit/Duplicate/Delete |
| Program | ✅ | Step editor with drag-drop, teach indicators, wizard, jog controls, 3D robot viewer, resizable panels |
| 3D View | ✅ | LiDAR point cloud, height coloring |
| Cameras & LiDAR | ✅ | Cam 0, Cam 1, LiDAR with expand/collapse |
| I/O | ✅ | 16 DI, 16 DO, 4 AI, 2 AO with editable labels and toggles |
| Part Recognition | ✅ | STEP upload, 3D viewer, face-click pick direction, teach wizard |
| Configure | ✅ | System settings |
| Safety | ✅ | Placeholder for safety zone configuration |

---

### Updated Navigation (June 3, 2026)

**Left sidebar:** REMOVED — all functionality in top tabs
**Top tabs:** 9 tabs (Monitor, Programs, Program, 3D View, Cameras & LiDAR, I/O, Part Recognition, Configure, Safety)

---

### Key Decisions Made June 3, 2026

- **Template matcher as sole recognition source** — replaces teach + CAD geometry matching
- **STEP dimensions as absolute size gate** — first and strongest filter before image comparison
- **Conversational wizard** — one question per page, answer determines next question
- **All panel sizes in Zustand store** — persist across tab switches
- **Gripper steps NOT teachable** — only move steps (move_home, move_joint, move_linear, approach, pick, place)
- **I/O separated to own tab** — cleaner than combined with cameras
- **Sensors renamed to Cameras & LiDAR** — clearer purpose
- **Left sidebar removed** — all navigation via top tabs
- **Monitor as operational dashboard** — shows production status, not just camera feeds
- **Force sensor: Bota SensONE recommended** — native ROS2, $2,500, Ethernet direct to Jetson
- **Safety moves in all wizard programs** — lift after every pick, descend before every place

---

### Key Bugs Fixed June 3, 2026

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Dashboard not updating | colcon build without --symlink-install | Always use --symlink-install, rm build/install first |
| Top tabs shaking | Latency number changing width | fontVariantNumeric: 'tabular-nums', minWidth on dynamic values |
| I/O labels disappearing when ON | Active background color hiding text | Label color always #1a1a1a, never conditional |
| All steps opening in edit mode | Steps without numeric IDs → undefined === undefined | Safety renumber + guards on editingId |
| Program name resetting on tab switch | Local useState resets on unmount | Moved to Zustand store with persist |
| Green step highlight when idle | currentStep defaulting to 0 | Changed default to -1 (no step highlighted) |

---

### Key Pending Items (June 3, 2026)

| Item | Priority | Status |
|------|----------|--------|
| Part recognition accuracy | HIGH | Size gating + templates deployed, needs validation with ring light |
| Ring light for camera | HIGH | Purchase needed ($30-50 USB ring light) |
| Force sensor purchase | HIGH | Bota SensONE recommended ($2,500) |
| Estun S10-140 arm driver | CRITICAL | Waiting on protocol document from supplier |
| MoveIt2 configuration | HIGH | Blocked on arm driver |
| nvblox sparse mesh fix | MEDIUM | 790 verts, should be 50k+ |
| 3D motion path visualization | MEDIUM | Infrastructure built (taught positions), needs path rendering in viewer |
| Extrinsic calibration (AprilTag) | MEDIUM | Infrastructure built, not yet run |
| Hand-guide mode | MEDIUM | Needs force sensor + arm driver |
| Full autonomous task generation | MEDIUM | auto_program_node exists, needs arm |

---

*Last updated: June 3, 2026*
*Covers sessions 69-117: Multi-orientation STEP templates (6×12=72 per part), reliable part matching rewrite (STEP size gate + full-res teach), lighting recommendation, 6-orientation teach wizard, Program Library tab, colcon build symlink fix, I/O Panel (replacing Scene Graph, editable labels, toggle visibility fix), program drag-drop with insertion indicator, click-to-edit steps, inline step naming, conversational Program Wizard (13 pages, answer-driven navigation), wizard safety moves (lift/descend on all picks/places), program save/load/edit workflow, Zustand store for program state persistence, gripper I/O port linking in step editor, categorized Add Step panel, right-click context menu, Lock Editing toggle, editingId undefined bug fix, Split View redesign, Program tab 3-panel layout (steps + 3D viewer + jog controls), force sensor analysis (Bota SensONE recommended), jog controls redesign (visual arrow pads, tablet-friendly, hold-to-jog), taught position indicators on move steps, Teach All flow, Standard Bots UI analysis, I/O tab separated from Sensors, Cameras & LiDAR tab, Safety moved to top tab, left sidebar removed, Monitor dashboard (status badge, pick counter, cycle results, fault log, time remaining, I/O summary, part 3D viewer, program-specific pick stats, cycle time chart)*

---

## Sessions 118–160: June 4, 2026 — Estun API, Driver Build, Executor, STEP Model, Full System Integration

---

### Section 118: Estun Codroid API — Complete Analysis

**Document:** CodroidApi Interface Description (CodroidApi.md, 2025-07-08, 41 pages)
**Protocol:** WebSocket at ws://ROBOT_IP:9000 (default: ws://192.168.101.100:9000)
**Format:** JSON send and receive

**Complete API Command Map:**

| Category | Commands | Details |
|----------|----------|---------|
| Robot Control | sendUserCommand | Power On(1), Off(2), ToManual(3), ToAuto(5), ClearError(100) |
| Robot State | getRobotState, GetRobotStateFlag | Mode, safety, statusFlag bitmask |
| Position Read | getCurAPos (joint deg), getCurCPos (TCP mm/deg) | 6 joints + TCP x,y,z,a,b,c |
| Motion | mov (movj/movl/movC), movMulti (30 pts max) | Joint, linear, circular, multi-point |
| Jog | jointJog, tcpJog, keepjog (heartbeat <500ms), stopjog | Joint axes 1-6, TCP axes x,y,z,rx,ry,rz |
| Stop | stopMove | Immediate motion stop |
| Home | goHome | Move to home via MovJoint |
| I/O | getDI (port 0-15), setDO (port 16-31), getDIGroup, setDOGroup | Bitmask for group read/write |
| RS485 | rs485Init, rs485Write, rs485Read, rs485FlushReadBuffer | Gripper communication |
| Project | getProjectState, runProject, pauseProject, resumeProject, stopProject | IDLE/LOADING/RUNNING/PAUSE/ERROR |
| Multi-point | MovJSegments, MovLSegments | Continuous 30-point paths |

**Key Technical Details:**
- Jog requires keepjog heartbeat every <500ms with millisecond timestamp
- DI ports: 0-15 (+ modeSwitch:32, enableButton:33, flangeButtons:40-43, flangeDI:44-45)
- DO ports: 16-31 (offset by 16 from logical DO0-DO15) + flangeDO:46-47
- getDIGroup/setDOGroup return decimal bitmask → convert to binary for individual ports
- Joint angles in degrees (need deg→rad conversion for ROS2)
- TCP position in mm (need mm→m conversion for ROS2)
- Robot modes: PowerOff, Idle, Jogging, Dragging, ToPoint, AutoReady, AutoRunning, Rescue, Fault
- Safety modes: 0=Error, 1=Normal, 2=E-stop, 3=Rescue, 4=Reduced
- StatusFlag bits: 0=E-stop, 1=Power, 2=Dragging, 3=Moving, 8=Simulation, 9-10=Project state

**Assessment:** This is a **Type A API** (streaming joint commands with position feedback) — exactly what we need. Full control over joint positions, TCP, I/O, and motion. Modern JSON WebSocket — far easier than Modbus or EtherCAT.

---

### Section 119: Estun Pro vs Eco Decision

**Supplier confirmed:** Pro has 6 joint torque sensors (one of few domestic brands with this feature). Dual collision detection (motor current + torque sensor). Smoother drag teaching.

**Price difference:** $3,000 extra for Pro over Eco.

**Decision: UPGRADE TO PRO**

| Factor | ECO | PRO |
|--------|-----|-----|
| Torque sensors | None — motor current only | All 6 joints |
| Collision detection | Single (current loop, 20-50N) | Dual (current + torque, 5-10N) |
| Drag teaching | Resistive, rough | Smooth, responsive |
| External force sensor needed | Yes ($2,500 Bota SensONE) | No — built-in torque suffices |
| Force-controlled assembly | Not possible | Possible with torque data |
| ISO/TS 15066 PFL | Marginal | Full compliance |
| Net cost vs ECO + force sensor | Base + $2,600 | Base + $3,000 |

**Net cost difference: only $400 more** than ECO + external force sensor, for dramatically better capability.

**Questions sent to Estun:**
1. Can we read joint torque values via the WebSocket API?
2. Is the drag/freedrive API (section 8) available on current Pro firmware?
3. What firmware version ships with the Pro S10-140?
4. Does the Pro SDK include URDF or robot model files?
5. What platforms does the SDK support (Linux ARM64)?

---

### Section 120: Estun ROS2 Driver — Complete Build

**Created:** /home/teddy/cobot_ws/src/estun_driver/estun_driver/estun_driver_node.py

**Architecture:**
```
Dashboard (:8080) → HTTP/WebSocket → FastAPI → ROS2 topics → Estun Driver → ws://ROBOT_IP:9000 → Robot
```

**Driver capabilities:**
- WebSocket connection with auto-reconnect (2s retry)
- Background receive thread for async responses
- Message ID tracking for request/response correlation
- Thread-safe send with lock

**Publishers (from robot → ROS2):**
- /joint_states at 50Hz (JointState, deg→rad conversion)
- /estun/tcp_pose (PoseStamped, mm→m conversion)
- /estun/robot_mode (String: idle, jogging, moving, fault, etc.)
- /estun/safety_mode (String: normal, estop, rescue, reduced)
- /safety/estop (Bool)
- /estun/is_moving (Bool)
- /estun/status (String JSON: full robot state blob)

**Subscribers (from ROS2 → robot):**
- /estun/command → sendUserCommand (power, mode, home, stop, run/pause/resume)
- /estun/jog and /robot/jog_command → jointJog/tcpJog + keepjog heartbeat at 400ms
- /estun/move → mov (movj/movl) and movMulti (up to 30 waypoints)
- /robot/io_command → setDO with port offset mapping (DO0=port 16)

**Jog implementation:**
- jointJog: jogMode=1, jogIndex=1-6, jogSpeed=±1/±2/±3
- tcpJog: jogMode=2, jogIndex=1(x)/2(y)/3(z)/4(rx)/5(ry)/6(rz)
- keepjog: sends Robot/Control/commandHeart with millisecond timestamp every 400ms
- stopjog: sets jogMode/jogSpeed/jogIndex all to 0
- Safety: if WebSocket disconnects, keepjog stops → robot stops automatically

**Motion commands:**
- Single move: action="mov" with acc, speed, target (apos for joint, cpos for TCP), type (movj/movl)
- Multi-point: action="movMulti" with points array (max 30), each with target+speed+acc+zone
- Speed: percentage mapped to deg/s (sper) and mm/s (stcp)

**I/O mapping:**
- getDI: port 0-15 direct
- setDO: port number = DO_number + 16 (DO0→port 16, DO15→port 31)

**Systemd:** roboai-estun.service (After=network.target, Restart=always)

**Connection test script:** scripts/test_estun_connection.py — direct WebSocket test without ROS2

---

### Section 121: Program Executor Node — Complete Build

**Created:** /home/teddy/cobot_ws/src/estun_driver/estun_driver/program_executor_node.py

**Purpose:** Loads saved programs from /opt/cobot/programs/ and executes step-by-step via the Estun driver.

**State machine:**
```
IDLE → (run command) → RUNNING → (step complete) → RUNNING → ... → COMPLETE
                          ↓                                          ↑
                    WAITING_MOTION ──(motion done)──────────────────╯
                    WAITING_TIME ───(timer expired)─────────────────╯
                    WAITING_IO ────(I/O confirmed)──────────────────╯
                    WAITING_DETECT ─(detection done)────────────────╯
                          ↓
                       PAUSED ──(resume)── → RUNNING
                          ↓
                        ERROR
```

**Supported step actions:**
| Action | What it does | Waits for |
|--------|-------------|-----------|
| move_home | sends goHome | motion complete |
| move_joint | sends mov movj with taught_joints | motion complete |
| move_linear | sends mov movl with taught_tcp | motion complete |
| approach | sends mov movj to approach position | motion complete |
| pick | moves to pick position at slow speed | motion complete |
| place | moves to place position at slow speed | motion complete |
| open_gripper | setDO open=1, close=0 | 500ms |
| close_gripper | setDO close=1, open=0 | 500ms |
| wait | asyncio.sleep(duration_s) | timer |
| detect | trigger camera detection | 1s |
| set_io | setDO on specified port | 100ms |
| loop | jump back to goto step, count cycles | immediate |

**Stats tracking:**
- Per-program stats saved to /opt/cobot/stats/{program_id}.json
- Tracks: total picks, pass count, fail count, fail reasons, cycle times (last 500)
- Cycle time: measured from cycle start to loop step
- Stats accumulate across runs (load existing + merge)

**ROS2 interface:**
- Subscribes: /task/run_program (run/pause/resume/stop with program_id)
- Publishes: /task/state at 5Hz (JSON: state, program_id, program_name, current_step, total_steps, step_label, cycle_count, last_cycle_time, pick stats)
- Subscribes: /estun/status (robot connection status), /estun/is_moving (motion complete detection)
- Publishes to: /estun/command, /estun/move, /robot/io_command

**Systemd:** roboai-executor.service (After=roboai-estun.service, Restart=always)

---

### Section 122: Dashboard Wired to Real Robot

**Dashboard backend updated with Estun integration:**

| Endpoint | Wired to | Function |
|----------|----------|----------|
| GET /api/state | /estun/status + /task/state | Returns joints, TCP, mode, safety, task state |
| POST /api/jog | /robot/jog_command | Publishes jog commands to driver |
| POST /api/io/set | /robot/io_command | Publishes I/O commands to driver |
| POST /api/program/run | /task/run_program | Run/pause/resume/stop programs |
| GET /api/stats/program/{id} | /opt/cobot/stats/ | Per-program pick stats |
| GET /api/stats/program/{id}/cycle_times | /opt/cobot/stats/ | Cycle time history |
| GET /api/stats/picks | In-memory counters | Today/shift/total pick counts |
| GET /api/stats/cycles | In-memory buffer | Last 20 cycle results |
| GET /api/stats/events | In-memory buffer | Last 10 events |

**Full data flow for every user action documented:**
- Jog button → /api/jog → ROS2 /robot/jog_command → Estun driver → WebSocket → robot moves
- Run button → /api/program/run → ROS2 /task/run_program → executor loads program → executes steps
- Teach position → /api/state → reads live joints/TCP from Estun → saves to program step
- I/O toggle → /api/io/set → ROS2 /robot/io_command → Estun driver → setDO → output changes

---

### Section 123: Network Subnet Issue Identified

**Problem:** Jetson is on 192.168.1.x, Estun default is 192.168.101.100 — different subnets.

**Options:**
- A: Change Estun IP to 192.168.1.100 (ask if configurable on controller)
- B: Add second IP to Jetson: `sudo ip addr add 192.168.101.246/24 dev eno1`
- C: USB Ethernet adapter for separate interface to robot

**Status:** Need to confirm with Estun which option is supported.

---

### Section 124: Dashboard UI Refinements (June 4)

**Changes made:**
- Camera feed removed from Monitor tab (cameras have dedicated Cameras & LiDAR tab)
- "Programs" tab renamed to "Program Library"
- Tab buttons enlarged for tablet use (padding 10px 18px, fontSize 13, minHeight 44, borderRadius 8)
- Active tab: blue background #eff6ff with blue border
- Tab bar horizontally scrollable on narrow screens
- Tab order finalized: Monitor | Program Library | Program | 3D View | Cameras & LiDAR | Part Recognition | I/O | Safety | Configure
- Program step text enlarged (label 16px bold, detail 13px, tags 11px, buttons 12px)
- Program panel expand buttons on all 3 panels (steps, 3D viewer, jog) — fills entire area when expanded

---

### Section 125: Program Library — Folders and Details

**Folder system added:**
- Create/rename/delete folders
- Drag programs into folders (drag-and-drop)
- Drag programs out to unfiled area
- Folders expand/collapse
- Folder name editable with Rename button (single tap, not double-click)
- Program count shown per folder

**Program details:**
- Details button on each program card
- Shows: last edited timestamp, created date, step count, tags
- Edit/Duplicate/Delete buttons in details panel
- All UI elements tablet-friendly (44px+ touch targets, 14px+ text)

**Backend:**
- /api/folders GET/POST — list/create folders
- /api/folders/{id} PUT/DELETE — rename/delete folders
- /api/programs/{id}/folder PUT — move program to/from folder
- Folders stored in /opt/cobot/programs/_folders.json
- Programs store folder ID in their JSON file

---

### Section 126: Wizard Teach Bug Fix

**Bug:** TeachWithJog component worked on first teach page but broke on subsequent pages.

**Root cause:** React reused the same component instance when navigating between teach pages because no `key` prop was set. The `taught` and `position` useState values from the first page persisted into all subsequent pages.

**Fix:** Added unique `key` prop to all 6 TeachWithJog renders:
- key="home_point" on teach_home page
- key="pick_point" on teach_pick page
- key="place_point" on teach_place page
- key="machine_load_point" on teach_machine_load page
- key="unload_point" on teach_unload page
- key="inspect_point" on teach_inspect page

This forces React to create a fresh component instance (with reset state) for each teach page.

---

### Section 127: Estun S10-140 STEP File — Robot Model

**File:** S10-140_G2.STEP (138MB, SolidWorks 2025 assembly)
**Transferred via:** SCP from Windows laptop to Jetson

**Git LFS setup:**
- Installed git-lfs on Jetson
- Tracking: *.STEP, *.step, *.stp, *.glb, *.stl, *.engine
- LFS quota: ~75% of 1GB GitHub Free tier used

**Directory structure created:**
```
models/
  robots/
    estun_s10-140/
      S10-140_G2.STEP          ← Original CAD (138MB, LFS tracked)
      S10-140.glb              ← Converted for web viewer (114MB)
      S10-140_lite.glb         ← Decimated 10% (for browser loading)
      robot.json               ← Robot metadata
      links/
        z_distribution.json    ← Geometry analysis
        link0-6_*_lite.glb     ← Per-link meshes (attempted)
        links.json             ← Joint definitions (attempted)
    README.md                  ← Instructions for adding new robots
```

**Symlink:** /opt/cobot/models/robot → /home/teddy/cobot_ws/models/robots/estun_s10-140

**robot.json metadata:**
- Name: Estun S10-140 Pro
- Payload: 10kg, Reach: 1400mm, 6 joints, 0.03mm repeatability, 33.5kg
- API: WebSocket JSON at ws://ROBOT_IP:9000
- Joint limits: J1/J4/J6 ±360°, J2/J5 ±130°, J3 ±150°

**STEP conversion:**
- trimesh + cascadio loaded the 138MB STEP successfully on ARM64
- Exported GLB (114MB) and STL (243MB)
- Full geometry analysis: ~200+ parts, dominant axis Y (arm extends along Y)
- Created decimated lite GLB for browser loading

**Dashboard routes added:**
- GET /robot/model.glb — full GLB
- GET /robot/model_lite.glb — decimated GLB
- GET /robot/model.stl — full STL
- GET /robot/model.step — original STEP
- GET /robot/info — robot.json metadata
- GET /robot/links.json — link definitions
- GET /robot/links/{filename} — individual link files

---

### Section 128: Articulated Model — Attempted and Reverted

**Attempt:** Split the STEP file into 7 per-link meshes by Y-position boundaries for articulated 3D viewer.

**Result:** Failed. The geometry pieces overlap significantly — shoulder housing extends into upper arm range, internal motor parts span multiple joint boundaries, wrist cables run through several links. Automated splitting by Y-position produced a disjointed, broken model.

**Additional issue:** Material appeared nearly black (MeshStandardMaterial with high metalness + no environment map = black). Fixed by switching to MeshPhongMaterial.

**Decision: Reverted to static model.** The full S10-140 appears as one clean piece in the 3D viewer. Articulation will be done when:
1. Estun provides URDF (ideal — joint definitions included)
2. Estun provides 7 separate link STL files with joint coordinates
3. OR Estun Pro SDK includes model files
4. OR manual splitting in FreeCAD (30 min user effort)

**Current 3D viewer features:**
- Static GLB model (lite version for performance)
- Auto-orientation: detects tallest axis, rotates to stand upright
- MeshPhongMaterial: light grey (#C0C8D4), specular, shininess 30
- Lighting: ambient 0.8, directional from two angles, point light above
- Base sits on grid at Y=0
- OrbitControls (drag, zoom, pan)
- Live joint angle readout (J1-J6) polling /api/state at 5Hz
- Camera presets: Front, Side, Top, Iso

---

### Section 129: Ring Light Recommendation

**For RealSense D435i:**
- 6-inch USB ring light with clamp mount ($15-25)
- 5000-6500K daylight white (matches D435i IR wavelength)
- Adjustable brightness (metal parts need less to avoid glare)
- Diffused LEDs (not bare point LEDs)
- Must NOT block IR projector or IR cameras on D435i front face

**Specific recommendations:**
- Neewer 6" USB Ring Light (~$18) — clamp, 3 color modes, 10 brightness
- UBeesize 6.5" Ring Light (~$15) — gooseneck, USB, dimmable
- VIJIM CL06 Mini Ring Light (~$20) — cold shoe mount for camera bracket

**Mounting:** Ring light on same bracket as D435i, camera looks through center hole. Shadow-free illumination from all directions around lens.

---

### Section 130: Full System Integration Architecture Documented

**Complete data flow documented for every user action:**

**Jog flow:**
```
JogPanel button → fetch /api/jog → dashboard publishes /robot/jog_command
→ estun_driver maps axis/direction → WebSocket setparam jogMode/jogSpeed/jogIndex
→ starts keepjog heartbeat every 400ms → robot moves
→ estun_driver polls getCurAPos at 50Hz → publishes /joint_states
→ dashboard reads /estun/status → /api/state returns live joints
→ Monitor/ArmViewer3D polls /api/state → UI updates
```

**Program execution flow:**
```
Run button → POST /api/program/run → publishes /task/run_program
→ executor loads program JSON → iterates steps at 20Hz
→ each step publishes to /estun/command or /estun/move or /robot/io_command
→ estun_driver sends WebSocket commands → robot executes
→ executor watches /estun/is_moving → advances when motion complete
→ publishes /task/state at 5Hz → dashboard shows progress
→ saves stats to /opt/cobot/stats/ on completion
```

**Day 1 robot arrival checklist documented:**
1. Power on, connect Ethernet
2. Resolve subnet (192.168.1.x vs 192.168.101.x)
3. Run test_estun_connection.py
4. Update driver IP in systemd service
5. Check dashboard shows IDLE (not disconnected)
6. Test jog controls
7. Verify joint direction correctness
8. Teach home position
9. First pick-and-place at 15% speed

---

### Section 131: Estun Pro SDK Question

**Supplier mentioned Pro uses SDK.** Questions sent:
1. What language? (C++/Python/C#)
2. What platform? (Linux ARM64/x86/Windows)
3. Does it include URDF or robot model files?
4. Does it include DH parameters?
5. Is it in addition to the WebSocket API or a replacement?
6. Can we get the SDK package and documentation?

**If SDK includes URDF:** Solves 3D viewer articulation immediately.
**If SDK includes DH parameters:** Can build mathematically correct kinematic chain.
**If SDK is Windows-only C#:** Cannot use on Jetson, stick with WebSocket API.

---

### Section 132: Remaining Software Items Inventoried

**Still needs building:**

| Item | Priority | Blocker |
|------|----------|---------|
| Safety tab content | HIGH | Can build now |
| Pick position from detection | HIGH | Can build now |
| Camera-to-robot calibration | HIGH | Run when robot arrives (script exists) |
| RS485 gripper driver | MEDIUM | After gripper selected |
| Articulated 3D viewer | MEDIUM | Needs URDF from Estun |
| MoveIt2 configuration | MEDIUM | Needs URDF |

**Not needed until later:**
- NanoOWL open-vocabulary detection
- FoundationPose 6DOF pose estimation
- nvblox mesh fix (790 verts)
- Voice control (Whisper + Llama)
- Fleet management
- Motion path visualization

**Hardware to buy:**
- Ring light ($15-25) — buy immediately
- Gripper ($800-4000) — need to select type
- USB Ethernet adapter ($15) — backup for subnet issue

---

### Updated Dashboard Tabs (June 4, 2026)

Monitor | Program Library | Program | 3D View | Cameras & LiDAR | Part Recognition | I/O | Safety | Configure

| Tab | Status | Features |
|-----|--------|----------|
| Monitor | ✅ | Status badge, program info, stats, pick counter, cycle results, time remaining, I/O summary, fault log, part viewer, pick performance donut, cycle time chart |
| Program Library | ✅ | Folders (create/rename/delete), drag programs into folders, search, Details button, Edit/Duplicate/Delete, tablet-friendly |
| Program | ✅ | Step editor (drag-drop, edit, teach), wizard with inline teach+jog, jog controls (XYZ/Joint), 3D robot viewer, resizable panels with expand buttons |
| 3D View | ✅ | LiDAR point cloud, height coloring |
| Cameras & LiDAR | ✅ | Cam 0, Cam 1, LiDAR with expand/collapse |
| Part Recognition | ✅ | STEP upload, 3D viewer, face-click pick direction, 6-orientation teach wizard |
| I/O | ✅ | 16 DI, 16 DO, 4 AI, 2 AO with editable labels, toggles, persist |
| Safety | ⬜ Placeholder | Needs speed limits, collision config, E-STOP behavior, I/O mapping |
| Configure | ✅ | System settings |

---

### Updated Systemd Services (June 4, 2026)

Added to repo (src/cobot_bringup/systemd/):

| Service | Status | What it runs |
|---------|--------|-------------|
| roboai-estun | ✅ New | Estun WebSocket driver (estun_driver_node) |
| roboai-executor | ✅ New | Program executor (program_executor_node) |
| roboai-cameras | ✅ Active | Both D435i cameras |
| roboai-lidar | ✅ Active | Livox MID-360 |
| roboai-accumulator | ✅ Active | Point cloud accumulator |
| roboai-reconstruction | ✅ Active | CPU TSDF mesh |
| roboai-depth-segment | ✅ Active | Depth segmentation + OBB + part recognition |
| roboai-fusion | ✅ Active | LiDAR point cloud fusion |
| roboai-stereo | ✅ Active | Camera cross-verification |
| roboai-scene-graph | ✅ Active | Kalman tracker |
| roboai-grasp | ✅ Active | Grasp pose generation |
| roboai-tf | ✅ Active | Static TF publisher |
| roboai-dashboard | ✅ Active | Production server :8080 |
| roboai-nvblox | ✅ Active | GPU mesh (790 verts) |
| roboai-auto-program | ✅ Active | LLM task generation |

Total: 15 active services (+ 3 disabled: roboai-isaac, roboai-detector, roboai-lidar-detect)

---

### Key Decisions Made June 4, 2026

- **Estun Pro over Eco** — $3K extra, saves $2.5K on external force sensor, better in every way
- **WebSocket API is sufficient** — Type A (streaming commands), full control, modern JSON
- **Estun driver built against API manual** — complete implementation, waiting for robot to test
- **Program executor as separate ROS2 node** — clean separation from driver, publishes progress
- **Static 3D model (not articulated)** — STEP splitting failed, waiting for URDF from Estun
- **MeshPhongMaterial** — doesn't go black without environment map (unlike MeshStandardMaterial)
- **Git LFS for large files** — STEP, GLB, STL, TRT engine files tracked
- **Robot models directory** — models/robots/<manufacturer>_<model>/ with README for adding new robots
- **Symlink /opt/cobot/models/robot** — points to repo, swap robots by re-pointing symlink
- **Ask Estun for URDF/SDK** — only reliable path to articulated 3D viewer

---

### Key Bugs Fixed June 4, 2026

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Wizard teach breaks after first point | TeachWithJog missing key prop → React reuses instance | Added key={pointName} to all 6 teach pages |
| 3D robot model sideways | Model's dominant axis (Y) not aligned to viewer's up axis | Auto-detect tallest axis, rotate to stand upright |
| 3D robot model black | MeshStandardMaterial + high metalness + no envmap = black | Switched to MeshPhongMaterial with specular |
| Articulated model disjointed | STEP geometry pieces overlap joint boundaries | Reverted to static model, awaiting URDF |
| config undefined in wizard teach | Teach pages destructured {config} but wizard passes {answers} | Fixed prop names to match |

---

*Last updated: June 4, 2026*
*Covers sessions 118-160: Estun Codroid API full analysis (41-page manual, WebSocket JSON, complete command map), Estun Pro vs Eco decision ($3K upgrade, dual collision detection, built-in torque sensors), Estun ROS2 driver built (WebSocket connection, 50Hz joint read, jog with keepalive, motion commands, I/O with port offset, auto-reconnect), program executor node (step-by-step execution, state machine, stats tracking, cycle times), dashboard wired to real robot (all endpoints connected via ROS2 topics), network subnet issue identified (1.x vs 101.x), UI refinements (camera removed from monitor, tab rename, tablet sizing, expand buttons), Program Library folders (create/rename/delete, drag-drop), wizard teach key prop fix, S10-140 STEP file (138MB, converted to GLB/STL, geometry analysis), Git LFS setup, robot model directory structure, articulated model attempted and reverted (STEP splitting failed), static 3D viewer with MeshPhongMaterial, ring light recommendation, full system integration architecture documented, Estun Pro SDK inquiry, remaining software inventory*

---

## Sessions 161–210: June 5, 2026 — Teach Wizard Rewrite, Orientation Classifier, Scan & Identify, Detection Fixes

---

### Section 133: Git LFS Quota Management

**Problem:** GitHub LFS at ~75% of 1GB free quota after robot model push.

**Fix:** Removed full-size per-link GLBs and full STL from repo (lite versions retained for browser). The splitter script can regenerate full versions anytime from S10-140.glb.

**Files removed from LFS tracking:**
- links/link0-6_*.glb (full size per-link)
- S10-140.stl (243MB)

**Files retained:**
- S10-140_G2.STEP (138MB, source)
- S10-140.glb (114MB, full model for regeneration)
- All *_lite.glb files (browser loading)
- links.json, z_distribution.json, robot.json

---

### Section 134: 3D Viewer — Model Removed, Empty Scene

**Attempts to fix the articulated model failed:**
1. Link splitting produced disjointed pieces (geometry overlaps joint boundaries)
2. Static model loaded sideways (arm extends along Y, not standing upright)
3. Material appeared black (MeshStandardMaterial + high metalness + no environment map)

**Orientation fix attempted:** Auto-detect tallest axis, rotate to stand upright. Switched to MeshPhongMaterial for non-black rendering.

**Final decision:** Removed robot model entirely from the 3D viewer. The viewer now shows an empty 3D scene with grid, lights, orbit controls, joint angle readout, and camera preset buttons (Front, Side, Top, Iso). The model will be added back when Estun provides:
- URDF file (ideal — includes joint definitions)
- OR 7 separate link STL files with joint coordinates
- OR Pro SDK with model files
- OR DH parameters for mathematical kinematic chain

**Articulation requires information only Estun has.** Automated splitting of a monolithic STEP file cannot identify joint boundaries.

---

### Section 135: Compact Ring Light Options for Robot Wrist

**Requirement:** Compact light that mounts on robot wrist near camera, not a large ring light.

**Recommended options:**

| Option | Size | Weight | Power | Price |
|--------|------|--------|-------|-------|
| VIJIM VL66 LED Panel | 66×38×12mm | 40g | USB-C rechargeable | ~$20 |
| USB Microscope Ring Light | 40-60mm dia, 10mm thick | 20g | USB | ~$15-25 |
| Machine Vision Bar Lights (pair) | 100mm bars | 30g each | 24V from controller | ~$30-50 |

**Best pick:** VIJIM VL66 — credit card sized, 40g, rechargeable, adjustable brightness. Mount next to camera with cold shoe or tape.

**Color temperature:** 5000-5500K daylight white — machine vision industry standard. Best for RealSense D435i IR wavelength, neutral color reproduction, widest material compatibility.

---

### Section 136: Program Library — Block/Card Grid Layout

**Changed from vertical list to card grid layout:**
- Folders display as square cards in a responsive grid (repeat auto-fill, minmax 200px, 1fr)
- Each folder card: folder icon, name, program count, rename/delete buttons
- Programs display as cards with icon/letter, name, step count
- Click folder to open → shows breadcrumb navigation ("Program Library > My Folder")
- Back button to return to root
- Drag programs onto folder cards
- Empty state: centered icon + text
- All cards tablet-friendly (44px+ touch targets)

---

### Section 137: Defect Teaching Added to Part Recognition

**New feature:** After teaching normal orientations, operators can optionally teach defective versions of parts.

**Defect teach flow:**
1. "Would you like to teach defective parts?" → Yes/No
2. Enter defect type name (e.g. "Cracked", "Bent", "Missing hole")
3. Enter description (e.g. "Visible crack on top surface near left mounting hole")
4. Select severity: Reject (red) / Warning (yellow) / Cosmetic (grey)
5. Capture defective part from camera (same capture UI, red accent)
6. "Add another defect type?" → loop or finish

**Data storage:**
- Defect refs saved to /opt/cobot/parts/{id}/defect_refs/
- Each ref: JSON metadata + RGB image + depth
- Part.json updated with defect_types array

**Camera annotations for defects:**
- Red box with "DEFECT: Cracked (78%)" label
- Red background on label text

---

### Section 138: Scan & Identify — New Operation Type

**Added "Scan & Identify" to Program Wizard and Program Editor.**

**Concept:** Robot scans workspace by moving above each detected object for close-up identification. Wide shot at 0.5m = 50×50 pixels per part. Close-up at 0.15m = 300×300 pixels per part — 36x more data for matching.

**Scan sequence:**
1. Wide scan: camera at home position detects all object blobs
2. Sort by position (nearest first or left-to-right)
3. For each blob: move robot above at scan height (150-200mm), wait 500ms for camera stabilization, capture 5 frames averaged, run full part matching + orientation classification
4. Report results: part IDs, confidence, orientation, defect status, positions

**Wizard pages for Scan & Identify:**
- Scan height slider (80-300mm, default 150)
- What to do after scanning: Report Only / Pick Known Parts / Sort by Type / Remove Defects
- Wide scan position: Use Home / Teach a position

**New program step types:**
| Step | Description | Tag Color |
|------|-------------|-----------|
| scan_workspace | Camera detects all objects from current position | Purple |
| scan_identify_each | Robot moves above each object for close-up ID | Purple |
| sort_scanned | Pick and sort parts based on scan results | Purple |
| remove_defects | Pick defective parts, place in reject bin | Purple |

**Added "Scan" category in Program Editor Add Step panel** alongside Motion, Pick and Place, and Control.

**Step parameters:** scan height, speed, settle time (200-2000ms), capture frames (1-10), match threshold (50-95%).

**Executor implementation:** scan_workspace reads /api/detections, scan_identify_each iterates through results moving above each object. Full implementation requires camera-to-robot calibration (blocked until robot arrives).

---

### Section 139: Gemini 330 vs RealSense D435i Comparison

**Assessment:** Don't switch cameras.

| Factor | D435i | Gemini 330 | Winner |
|--------|-------|------------|--------|
| Depth range | 0.1-10m | 0.2-1.4m | D435i |
| Close-up scan at 0.15m | Works (>0.1m min) | Fails (<0.2m min) | D435i |
| RGB resolution | 1920×1080 | 1280×800 | D435i |
| Depth accuracy at 0.5m | Good | Better (±1mm) | Gemini |
| Our existing code/drivers | Fully built | Need to rebuild | D435i |
| ROS2 driver maturity | Stable | Newer, some bugs | D435i |
| Price | ~$280 | ~$200 | Gemini |
| Room awareness (2-3m) | Works | Max 1.4m | D435i |

**Key disqualifier for Gemini 330:** 0.2m minimum depth means the scan-and-identify approach (close-up at 0.15m) won't work. D435i's 0.1m minimum is essential.

---

### Section 140: Teach Wizard — Complete Step-by-Step Rewrite

**Part Recognition teach wizard rewritten as conversational step-by-step sequence:**

**Complete page flow:**
1. Part name (text input)
2. Part description (textarea)
3. STEP file? (Yes upload / No camera only)
4. STEP upload + 3D preview (if yes)
5. How many pickable orientations? (1-6 buttons)
6. Name pickable orientation 1 (text input)
7. Capture pickable orientation 1 (camera + capture button, 2+ required)
8. Repeat 6-7 for each additional pickable orientation
9. How many non-pickable orientations? (0-5)
10. Name non-pickable orientation 1 (text input)
11. Capture non-pickable orientation 1 (camera, red accent, 2+ required)
12. Repeat 10-11 for each non-pickable orientation
13. Teach defects? (Yes/No)
14. Defect name → description → severity → capture (if yes, loop for multiple)
15. Review (complete summary of all orientations and captures)
16. Save

**Start fresh vs Add more:** When re-teaching a part with existing refs, user chooses to clear all or append.

**CaptureView component:** Camera feed, capture button (accent-colored), counter with "X new (+ Y existing)" display, minimum 1-2 captures to advance.

---

### Section 141: Non-Pickable Orientation Bug Fix

**Bug:** Wizard skipped non-pickable orientation pages entirely, jumping from last pickable capture to defect question.

**Root cause:** Dynamic page skip conditions not properly evaluating non_pickable_count. Pages for non-pickable orientations had skip conditions that checked count < N, but the count value was stored as string or undefined before the page was reached.

**Fix:** Created explicit pages for up to 5 non-pickable orientations with proper skip conditions using number comparison. Ensured setAnswer stores numbers not strings. Non-pickable pages ordered correctly in PAGES array between pickable captures and defect question.

---

### Section 142: Capture Count Inflation Bug Fix

**Bug:** User captured 11 pictures but library showed 18 after saving.

**Root causes identified:**
1. Each teach capture saves multiple files (JSON + RGB + depth + mask) — count was based on total files, not captures
2. Old captures not cleared when re-teaching — new captures appended to old ones
3. Count function counted ALL files in teach_refs directory

**Fixes:**
- Count only .json metadata files: `len([f for f in os.listdir(refs_dir) if f.endswith('.json')])`
- Clear endpoint POST /api/parts/{id}/teach/clear uses shutil.rmtree to delete entire directory and recreate empty
- Update part.json teach_count after each save and clear
- Debug endpoint GET /api/parts/{id}/teach/debug shows total files, json count, png count, npy count

---

### Section 143: Bounding Box Color Coding

**Camera annotations now distinguish orientations visually:**

| Detection Type | Box Color | Marker | Label Format |
|---------------|-----------|--------|-------------|
| Pickable | GREEN (3px) | Checkmark ✓ | "Part Name - PICK OK: Label (XX%)" |
| Non-pickable | RED (3px) | X through box | "Part Name - NO PICK: Label (XX%)" |
| Defect | RED (3px) | Red bg label | "DEFECT: Name (XX%)" |
| Unknown | GREY (1px) | None | "Unknown (XX%)" |

---

### Section 144: React Render Error in Teach Wizard — Fixed

**Bug:** React render error when starting teach sequence.

**Root cause:** Accessing properties of undefined arrays — e.g. `answers.pickable_labels[0]` when pickable_labels wasn't initialized.

**Fix:** Initialize all answer fields with safe defaults (empty arrays, default numbers). All array access uses `(answers.fieldName || [])[index] || ''`. Every render function returns JSX or null, never undefined. Page safety guard: `if (!page || !page.render) return null`.

---

### Section 145: Clear Captures Fix

**Bug:** Clear/Start Fresh button not deleting old teach captures. New captures appended to old ones.

**Fix:** POST /api/parts/{id}/teach/clear endpoint now uses shutil.rmtree on both teach_refs and defect_refs directories, recreates them empty, resets part.json teach_count to 0 and defect_types to []. Frontend calls this endpoint before first capture when "Start Fresh" is selected.

---

### Section 146: Add More Captures Fix

**Bug:** "Add More" option in teach wizard didn't save new captures.

**Fix:** Teach endpoint finds next available ref number by counting existing .json files. New refs get incrementing IDs (ref_0005, ref_0006...) that don't overwrite existing. Frontend shows "X new (+ Y existing)" counter. Next button requires 1+ new capture when in Add More mode.

---

### Section 147: Orientation Classifier — Feature-Based RGB Matching

**Problem:** Both sides of the key fob have identical outline shape and size. The system matched by shape only, randomly assigning pickable vs non-pickable.

**Root cause:** The matching pipeline used STEP size gate (same for both sides) + template matching (same outline) + single highest-NCC reference (random winner when scores are similar).

**New orientation classifier built (numpy/scipy only, no cv2):**

After part type is identified (size gate + outline match), a SECOND matching step compares RGB content against all teach references grouped by orientation:

1. Group references by orientation key (is_pickable, orientation_number, orientation_label)
2. For each group, score = mean_NCC × 0.70 + mean_histogram_correlation × 0.30
3. Best-scoring group wins → determines pickable/non-pickable
4. Gap between best and second-best determines confidence

**_color_hist_corr method:** Numpy-only Pearson correlation between 16-bin per-channel RGB histograms. Captures surface color distribution differences (buttons vs flat back, textured vs smooth).

**Debug logging (ORIENT_MATCH, throttled to 3s):**
```
ORIENT_MATCH det=[6.4x3.7cm] →
  winner=PICK/"side" gap=0.05 |
  pick'side' ncc=0.40 hist=0.48 score=0.42 (7r) |
  NOpick'upsidedown' ncc=0.31 hist=0.44 score=0.35 (7r)
```

**Verified:** Correct orientation group selected with 0.05-0.08 gap between pickable and non-pickable groups.

**Recommendation for wider gap:** More teach captures per orientation (12-15 instead of 7), vary angles between captures, consider bumping histogram weight from 0.30 to 0.45 for parts where surface features are the primary distinguishing factor.

---

### Section 148: Key Fob Orientation Detection — Debugging

**Issue reported:** Key fob detected (bounding box visible) but no orientation label showing — no "PICK OK" or "NO PICK" result.

**Possible causes investigated:**
1. Part ID not matched (size gate rejecting) — no orientation classifier runs
2. Teach refs missing orientation metadata (is_pickable, orientation_label fields) — refs captured before new wizard
3. Orientation classifier not called in detection pipeline — conditional gate
4. RGB images (_rgb.png) not saved during teach — classifier has no images to compare
5. RGB crop not passed to classifier — function receives None

**Diagnostic steps:** Check teach ref JSON files for orientation fields, check for _rgb.png companion files, add DEBUG-ORIENT logging to trace pipeline, backfill script for refs missing metadata.

**Backfill script:** scripts/backfill_teach_orientation.py — sets default pickable=true on all refs missing the field. User should re-teach with new wizard for proper pickable/non-pickable labeling.

---

### Section 149: Detection Accuracy — Comprehensive Analysis

**Root cause analysis of detection inaccuracy:**

| Problem | Impact | Status |
|---------|--------|--------|
| No controlled lighting | CRITICAL | Compact light recommended, not yet purchased |
| Depth noise on shiny metal | HIGH | Partially mitigated (5-frame avg) |
| Table same color as parts | HIGH | White mat recommended, not yet used |
| Teach refs captured in bad light | HIGH | Need re-teach after lighting fixed |
| OBB dimensions ±30% inaccuracy | MEDIUM | STEP size gate helps |
| Flat parts invisible to depth | MEDIUM | Parts <3mm blend with table |
| Shadows create false edges | MEDIUM | Splits one part into two detections |
| Parts touching merge into one | MEDIUM | Depth gradient splitting imperfect |

**Accuracy estimates:**

| Setup | Accuracy |
|-------|----------|
| Current (ambient light, grey table) | ~25-30% |
| + Compact light | +30-40% |
| + White surface mat | +10-15% |
| + Re-teach after lighting | +15-20% |
| + Software parameter tuning | +5-10% |
| + Scan-and-identify (close-up) | +20-30% |
| All improvements combined | ~80-90% |

**Software parameter improvements recommended:**
- Increase depth averaging: 3 → 7 frames
- Lower floor_tolerance: 15mm → 10mm
- Increase morphological closing: 15×15 → 21×21
- Add bilateral filter on depth before segmentation
- Add adaptive histogram equalization on RGB
- Lower minimum detection area: 100px → 50px
- Add median blur (3×3) on depth mask
- Increase RANSAC iterations to 1000

---

### Updated Part Recognition Pipeline (June 5, 2026)

```
Detection:
  1. Depth frame → 7-frame average → bilateral filter → RANSAC table plane
  2. Above-table mask → morphological closing → contour extraction
  3. Size filter (>0.8cm both dims) → fill ratio filter (>15%)
  4. 2D minimum-area rotated rectangle → OBB dimensions

Part Identification:
  5. STEP size gate (exact dimensions, aspect ratio comparison)
  6. Template matching (72 templates per part, 6 orientations × 12 yaw)
  7. Teach reference NCC matching (full resolution RGB)

Orientation Classification (NEW):
  8. Group teach refs by orientation (pickable vs non-pickable)
  9. Score each group: NCC × 0.70 + histogram_correlation × 0.30
  10. Best group wins → determines is_pickable
  11. Gap between groups → confidence

Defect Detection:
  12. If defect refs exist, compare against defect references
  13. Flag if defect match > threshold

Annotation:
  14. GREEN box + ✓ for pickable
  15. RED box + X for non-pickable
  16. RED box + "DEFECT" label for defective
  17. GREY box for unknown
```

---

### Updated Dashboard Tabs (June 5, 2026)

Monitor | Program Library | Program | 3D View | Cameras & LiDAR | Part Recognition | I/O | Safety | Configure

**No changes to tab list from June 4.**

---

### Key Decisions Made June 5, 2026

- **Keep D435i cameras** — Gemini 330's 0.2m minimum depth disqualifies close-up scanning
- **Feature-based orientation matching** — NCC + histogram correlation, not outline-only
- **Orientation classifier as second pass** — runs AFTER part type identification
- **Scan & Identify as new operation type** — robot moves above each object for close-up
- **numpy/scipy only** for orientation classifier — no cv2/torch per codebase constraints
- **Clear teaches properly** — shutil.rmtree entire directory, not selective delete
- **Defect teaching optional** — name, description, severity per defect type
- **Block/card grid** for Program Library — not row/list layout
- **Empty 3D viewer** — model removed until URDF from Estun

---

### Key Bugs Fixed June 5, 2026

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Wizard crash on teach start | answers.home_point undefined → TeachWithJog reads config[pointName] | Fixed prop names: config→answers, setConfig→setAnswer |
| Non-pickable pages skipped | Skip conditions evaluated before count was set, string vs number comparison | Explicit pages with number comparison, correct PAGES order |
| Capture count inflated (11→18) | Counted all files not just .json, old refs not cleared | Count .json only, shutil.rmtree on clear, update part.json |
| React render error in teach | Array access on undefined (pickable_labels[0]) | Initialize all arrays, safe access with defaults |
| Clear not deleting old refs | Clear endpoint didn't physically delete files | shutil.rmtree entire teach_refs dir and recreate |
| Add More not saving | Refs overwriting same filenames | Find next available ref number, incrementing IDs |
| Orientation wrong (random) | Matched by outline only, same for both sides | Added orientation classifier: NCC + histogram per group |
| Key fob no orientation label | Teach refs missing is_pickable metadata | Backfill script, re-teach with new wizard |

---

*Last updated: June 5, 2026*
*Covers sessions 161-210: LFS quota management (removed full-size link GLBs), 3D viewer emptied (model removed, awaiting URDF), compact ring light options (VIJIM VL66 recommended), Program Library block/card grid, defect teaching (name, description, severity, capture), Scan & Identify operation type (scan_workspace + scan_identify_each steps), Gemini 330 vs D435i comparison (keep D435i), teach wizard complete step-by-step rewrite (part name → description → STEP → pickable count → name + capture each → non-pickable count → name + capture each → defects → review), non-pickable pages skipping fix, capture count inflation fix (count .json only), bounding box color coding (green pickable ✓, red non-pickable ✗), React render error fix (array initialization), clear captures fix (shutil.rmtree), add more captures fix (incrementing ref IDs), orientation classifier built (NCC 0.70 + histogram 0.30, numpy/scipy only, per-group scoring), key fob orientation debugging (missing metadata, backfill script), detection accuracy analysis (lighting = #1 issue, 25% → 90% with all improvements)*

---

## June 8, 2026 — Session Log

### Section 150: Estun Pro SDK — Supplier Confirms Document No Longer Available

**Context:** Supplier (Estun) shared a document claiming it was the "SDK version for the PRO." User uploaded it for verification.

**Finding:** The uploaded document is the same CodroidApi (WebSocket JSON, 41-page manual) analyzed in Session 118 — the same API the ROS2 driver was already built around. It is NOT a new or different SDK.

**Document covers:**
- Motion commands: movj, movl, multi-segment
- I/O: DI/DO
- RS485 passthrough
- Project execution
- Jogging with keepalive
- TCP/payload configuration

**Supplier then confirmed:** The SDK document is "no longer available."

**Key questions still unanswered from Estun (sent in Session 119):**
1. Can joint torque values be read via the WebSocket API?
2. Is the drag/freedrive API (section 8) available on current Pro firmware?
3. What firmware version ships with the Pro S10-140?
4. Does the Pro SDK include URDF or robot model files?
5. What platforms does the SDK support (Linux ARM64)?

---

### Section 151: Estun Pro vs Eco — Reconsideration After SDK Unavailability

**Question raised:** Should we go back to the Eco model given SDK is unavailable?

**Analysis:**

The SDK unavailability does not change the underlying hardware difference. The SDK question was primarily about two things:
1. URDF/DH parameters for the 3D viewer
2. Torque sensor data access

**If torque sensor data IS accessible via the CodroidApi WebSocket** (even without a named "SDK"), the Pro remains the correct choice — it still has 6 joint torque sensors and dual collision detection (current + torque, 5–10N threshold vs Eco's 20–50N).

**If torque sensor data is NOT exposed via WebSocket**, the Pro's primary advantage over the Eco disappears for this use case.

**Decision framework:**

| Scenario | Recommendation |
|----------|---------------|
| Torque data accessible via WebSocket | Stay with Pro — $400 net advantage over Eco + external force sensor |
| Torque data NOT accessible via WebSocket | Pro still has better collision detection hardware, but Eco becomes viable |
| URDF needed for 3D viewer | Source manually from Estun technical team, not SDK |

**Status:** Awaiting Estun response on torque sensor WebSocket access before making final call on Pro vs Eco reversal.

---

### Section 152: Half-Resolution Depth Processing — Broke cam0 Detection

**Problem:** A half-resolution depth processing optimization was added to `depth_segment_node.py` that broke cam0 detection entirely.

**Root cause of the change:** An attempt to reduce GPU/CPU load by processing depth at half resolution and upsampling back to full resolution. Variables added included: `_zoom_hr`, `_half_h`, `_half_w`, `depth_half`, `valid_half`, `X_h`, `Y_h`, `Z_h`, `u_h`, `v_h`, `fx_h`, `fy_h`, `cx_h`, `cy_h`, `plane_z_h`, `plane_fg_h`, `depth_filled_h`, `gmag_h`, `edge_fg_h`, `foreground_h`, `vy_h`, `vx_h`, `_rgb_frame_counter`, `_rgb_edge_fg_h`, `_valid_count`, `_plane_fg_count`, `_match_frame_counter`.

**Effect:** cam0 detections completely stopped — no bounding boxes, no part recognition output.

**Cause of failure:** Half-resolution foreground mask + upsample introduced enough pixel misalignment and noise that foreground segmentation produced no valid contours above the size threshold. The `_match_frame_counter` skip logic also reduced match frequency, compounding the detection dropout.

---

### Section 153: Full-Resolution Revert — Claude Code Prompt

**Resolution:** Revert `depth_segment_node.py` to full-resolution operation. The following Claude Code prompt was generated and run on the Jetson:

```
Read src/object_detection/object_detection/depth_segment_node.py IN FULL.

The half-resolution depth processing added today broke cam0 detection.
Revert _process() to full-resolution operation. Do exactly this:

1. Find and remove every line referencing:
   _zoom_hr, _half_h, _half_w, depth_half, valid_half,
   X_h, Y_h, Z_h, u_h, v_h, fx_h, fy_h, cx_h, cy_h,
   plane_z_h, plane_fg_h, depth_filled_h, gmag_h, edge_fg_h,
   foreground_h, vy_h, vx_h, _rgb_frame_counter, _rgb_edge_fg_h,
   _valid_count, _plane_fg_count, _match_frame_counter

2. Restore full-resolution foreground detection:

   plane_z = a * X + b * Y + c
   plane_fg = valid & (depth < (plane_z - self.floor_tol))
   depth_filled = np.where(valid, depth, plane_z).astype(np.float32)
   gmag = np.hypot(
       ndimage.sobel(depth_filled, axis=0, mode='nearest'),
       ndimage.sobel(depth_filled, axis=1, mode='nearest'))
   edge_fg = valid & (gmag > self.edge_thresh)
   foreground = plane_fg | edge_fg

3. Restore full-resolution RGB Sobel every frame:

   rgb = self._color_rgb
   if rgb is not None and rgb.shape[0] == h and rgb.shape[1] == w:
       gray = (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1]
               + 0.114 * rgb[:, :, 2]).astype(np.float32)
       rgb_gmag = np.hypot(
           ndimage.sobel(gray, axis=0, mode='nearest'),
           ndimage.sobel(gray, axis=1, mode='nearest'))
       rgb_edge_fg = valid & (rgb_gmag > self.rgb_edge_thresh)
       foreground = foreground | rgb_edge_fg

4. Restore morphology operating on full-res foreground
   with original kernel sizes (no _h suffix anywhere).

5. Remove the upsample step (foreground = _zoom_hr(...)).

6. In _emit(), restore direct matching:
   if not self._teach_mode:
       self._match_parts(stable)
   (Remove _match_frame_counter skipping)

Then:
   python3 -m py_compile \
     src/object_detection/object_detection/depth_segment_node.py
   sudo systemctl restart roboai-depth-segment

Print DONE when the service is back up.
```

**Expected outcome:** Detection restored to pre-optimization state. cam0 bounding boxes and part matching resume at normal frequency.

**Lesson recorded:** Half-resolution depth processing is not a safe optimization for this pipeline. The foreground segmentation is sensitive to pixel-level alignment between depth mask and RGB contours. Any future performance optimization must be validated against a known-good detection test before committing.

---

### Key Decisions Made June 8, 2026

- **Do not revert to Eco prematurely** — await Estun confirmation on torque sensor WebSocket access first
- **Full-resolution depth processing only** — half-res optimization breaks foreground segmentation
- **Read the actual file before writing any prompt** — confirm current state in code before generating fix prompts
- **One concrete fix per problem** — no back-and-forth iterative guessing

---

### Key Bugs Fixed June 8, 2026

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| cam0 detection stopped | Half-resolution depth processing introduced pixel misalignment + match frame skipping | Revert depth_segment_node.py to full-resolution, remove all _h suffix variables and _match_frame_counter |

---

*Last updated: June 8, 2026*
*Covers sessions 211–215: Estun Pro SDK confirmed same CodroidApi WebSocket document (41 pages, no new SDK), supplier stated SDK no longer available, Pro vs Eco reconsideration (awaiting torque sensor WebSocket confirmation), half-resolution depth processing broke cam0 detection, full-resolution revert prompt generated for Claude Code on Jetson, lesson: half-res depth optimization unsafe for this segmentation pipeline*

---

## June 9, 2026 — Session Log

### Sessions 216–230: FoundationPose Evaluation, Phase A Identification Fixes, Code Audit, Root Cause Analysis

**Last Updated**: June 9, 2026
**Covers**: Random object bin picking discussion, LiDAR role in bin picking clarified, FoundationPose environment verification, FoundationPose demo on sample data (mustard bottle), OBB-seeded pose search design, FoundationPose evaluation harness build with phased rollout plan, four spec/reality mismatches resolved, multi-mesh smoke test revealed volume bias (L22 wins regardless of ground truth), pivot to FP-for-pose-only architecture, geometric pickable check validated (PICK_OK and FLIP_NEEDED demonstrated cleanly), session communication failure (eval ran terminal-only but user expected dashboard integration), Phase A identification fixes attempted, code review of depth_segment_node.py revealed root cause of hex-ID label bug (orphan templates), ring light recommendation

---

### Section 216: Random Object Bin Picking — Demand Discussion

User asked: "Is random object bin picking going to be high demand for collaborative applications?"

**Answer:** Yes. Within the project's own AI vision use case ranking, bin picking with clutter sits at #4 (out of 7) because:

- Pure RGB detection fails when objects are piled or partially occluded
- Combination of depth + segmentation (YOLOv8-seg + fused pointcloud) is what makes it solvable
- 6DOF pose estimation goes further — robot knows exact 3D orientation, critical for reliable grasping of irregular or non-symmetric parts
- Cobots can work alongside humans without facility redesign, unlike caged industrial robots
- Fleet learning compounds advantage — grasp success rates improve over time

**The gap:** Reliable execution in cluttered, variable conditions. That's what the project's perception stack is targeting.

---

### Section 217: LiDAR Role in Bin Picking

User asked: "Will the LiDAR be of help in this?"

**Honest answer:** Limited direct value for bin picking specifically, but plays a supporting role.

**Cameras do the bin picking work:**
- Depth segmentation node (RealSense D435i depth + RGB) handles object detection, OBB estimation, orientation, grasp pose
- 15Hz with 2mm resolution
- LiDAR can't match cameras for close-range object detail inside a bin

**LiDAR does three things cameras can't:**
1. Workspace geometry / collision avoidance — 360° room model at range
2. Surface anchoring — LiDAR Z (RANSAC table plane) + camera XY = best of both sensors
3. Safety zones — ISO 10218 speed-separation monitoring

**Honest limitation:** Camera-LiDAR alignment was hard enough that camera point clouds were removed from fused 3D view entirely. Misaligned data caused more confusion than benefit.

---

### Section 218: FoundationPose Environment Verification

**Status confirmed:**

| Component | Version | Source |
|-----------|---------|--------|
| Python | 3.10.12 | system |
| torch | 2.5.0a0+872d972e41.nv24.08 | NVIDIA Jetson redist |
| torchvision | 0.20.0a0+afc54f7 | source build (v0.20.0, 10 min) |
| pytorch3d | 0.7.7 | source build (v0.7.7, 22 min) |
| nvdiffrast | 0.4.0 | source build (main, 4 min) |
| libcudnn9-cuda-12 | 9.3.0.75-1 | L4T r36.5 apt |
| cuda-cupti-12-6 | 12.6.68-1 | L4T r36.5 apt |
| libcusparselt0 | 0.7.1.0-1 | CUDA SBSA repo |

Total NVIDIA apt prereqs: ~634 MB. Disk: 9.9 GB free. Environment ready for FoundationPose demo on sample data.

---

### Section 219: FoundationPose Demo on Sample Data (Mustard Bottle)

**Results verbatim:**

```
REGISTER 20644 ms  score=57.938  src=det@(292,256,0.368m)  mask=7719 px
  t = [+0.000, +0.011, +0.369] m
track  5: 209 ms  t=[-0.000, +0.010, +0.368]
track 10: 204 ms  t=[+0.000, +0.010, +0.363]
...
track 40: 221 ms  t=[-0.000, +0.010, +0.363]

register: 20644 ms
track:    n=39 mean=217ms min=173 max=346  (= 4.6 Hz)
```

**Interpretation:**
- Registration 20s (too slow for production, but mustard bottle uses default 252 hypotheses)
- Tracking 217ms mean = 4.6 Hz (sufficient for static-table pick approach)
- Pose stability rock solid: X,Y locked at 0.000, 0.010; Z drifted only 6mm over 40 frames
- Score 57.938 (above 50 = confident registration)

**Demo artifacts saved:**
- 20 annotated PNGs at /home/teddy/foundationpose_eval/demo_debug/track_vis/
- 20 pose matrices at /home/teddy/foundationpose_eval/demo_debug/ob_in_cam/
- Headless runner script at /home/teddy/foundationpose_eval/run_demo_headless.py

---

### Section 220: How FoundationPose Actually Works

User asked if FP directly compares STEP model to image.

**Honest answer: It does NOT directly compare. It's render-and-compare.**

1. Renders the mesh from many hypothetical poses (synthetic images)
2. Scores how well each rendered view matches the actual camera image
3. Finds the best match — pose whose rendering best matches camera view becomes the estimated 6DOF pose
4. Tracks frame-to-frame after registration using depth + colour

**Why this works for shiny aluminium:** Existing NCC/histogram pipeline compares pixel textures — shiny surfaces reflect surroundings, textures change constantly. FoundationPose compares silhouettes and depth edges, not surface colour. Shiny vs matte aluminium look identical to FP.

**The catch for small similar parts:** FP needs depth segmentation bounding box to tell it where to look and which part to fit the mesh for. It won't distinguish BT225L24_a from BT225L28_a (nearly identical 2mm size delta) on its own. Existing size-gate pipeline still has to do that job first.

---

### Section 221: Registration Speed Analysis

**Symmetry-based hypothesis reduction table:**

| Part class | Recommended config | Hypos | Reg time |
|-----------|--------------------|-------|----------|
| Confirmed bilaterally symmetric (rods, nuts, cylinders) | inplane_step=180 | 84 | ~6 s |
| Mixed / asymmetric | inplane_step=120 | 126 | ~9 s |
| Maximum safety (e.g. labeled face matters) | inplane_step=60 (default) | 252 | ~20 s |

**Three options to speed up registration:**

1. **Reduce hypotheses by symmetry** — covered in table above
2. **OBB-seeded pose search** — use depth_segment OBB yaw estimate to constrain initial pose search. ~12-24 hypotheses, likely under 2s register. Requires modifying make_rotation_grid to accept seed orientation.
3. **TensorRT optimization** — FP already uses torch.cuda.amp.autocast (fp16). TRT would give roughly another 1.5-2× speedup. Multi-hour ONNX export effort.

**Decision: Option 2 (OBB-seeded).** Cleanest win, uses information already in the pipeline.

---

### Section 222: FoundationPose Evaluation Harness — Phased Plan

**Phased rollout plan agreed:**

```
Phase 1 (test prompt):  Prove FP works on YOUR parts in YOUR lighting
                        → Live cam0, multi-mesh identification, OBB-seeded
                        → Eval environment only, no production changes

Phase 2:  Build foundationpose_node.py — proper ROS2 node
          with topic interface (eval-grade → prod-grade code)

Phase 3:  Integrate into depth_segment_node as second-stage
          identifier, keep old pipeline as fallback flag

Phase 4:  Dashboard updates — show FP pose overlay, part name
          from FP scoring, side-by-side compare with old pipeline

Phase 5:  Validation period, then cutover — make FP the primary
          and remove the size-gate/template/NCC chain
```

**Phase 1 is the critical gate.** If FP correctly identifies BT225L24_a vs BT225L28_a vs BT225L13_a vs BT225L22_a from cam0 in lighting, the rest is engineering.

---

### Section 223: Four Spec/Reality Mismatches Flagged by Claude Code

Claude Code stopped after Part 1 (mesh prep — all 4 passed 10% tolerance) and flagged four mismatches before proceeding to Parts 2-5:

| # | Mismatch | Resolution |
|---|----------|------------|
| 1 | Rotation grid API: Claude Code's was seed_rot matrix, spec called for seed_yaw scalar | Keep matrix API. Add roll_pitch_range_deg=10, roll_pitch_step_deg=5 kwargs. Cap total hypotheses at 30. |
| 2 | Topic name: spec said /perception/detections, actual is /perception/detections_3d | Use /perception/detections_3d |
| 3 | 2D bbox derivation: spec said Detection3D has pixel bbox.center, actual publishes 3D in livox_frame | Project 3D OBB back through camera intrinsics. Expand by 15%, clip to image bounds, reject if <40px. |
| 4 | Metadata path: spec said /opt/cobot/parts/<part_id>/part.json, actual is /opt/cobot/parts/metadata/<id>.json keyed by hex ID. BT225L24_a missing from index.json (no pick_normal) | Use actual structure. For BT225L24_a (no metadata): log "GEOMETRIC_PICKABLE_SKIPPED" and report orientation=unknown. Print metadata status at evaluation start. |

**Additional instruction:** Single-part smoke test on BT225L24_a only before full 4-part sweep.

---

### Section 224: Mesh Preparation Results

**All 4 parts passed 10% tolerance.** STL files turned out to already be in metres (not mm as expected from STEP-default note) — no scaling needed, just centring on vertex centroid.

```
/home/teddy/foundationpose_eval/meshes/
  BT225L13_a.obj  (100.8 kB)
  BT225L22_a.obj  ( 27.3 kB)
  BT225L24_a.obj  ( 22.7 kB)
  BT225L28_a.obj  ( 29.5 kB)
```

---

### Section 225: Smoke Test Result — Volume Bias Discovered

**Pick_normal classification (geometric pickable check):**

```
BT225L24_a      DEFAULT     PICK_NORMAL_DEFAULT_DETECTED
BT225L28_a      DEFAULT     PICK_NORMAL_DEFAULT_DETECTED
BT225L13_a      DEFAULT     PICK_NORMAL_DEFAULT_DETECTED
BT225L22_a      DEFAULT     PICK_NORMAL_DEFAULT_DETECTED
summary: 0 taught, 4 default, 0 missing of 4 parts
```

All 7 detections correctly logged SKIPPED_DEFAULT for pickable.

**Verbose score logging worked.** Per-mesh times all ~1.0s. L24 occasionally hit 2.1s on frame 1 (CUDA kernel warmup, normal).

**Critical finding: L22 wins regardless of ground truth.**

This is a known weakness of FP when used naively for identification across parts of different sizes:
- L22 is 18.4cm long (long-rod outlier)
- Other parts are 3.8-6.3cm
- A long mesh has more surface area to score against
- Scorer sums fit quality across all rendered pixels
- More pixels = higher total score, even if each pixel fits worse

The mustard bottle demo worked because there was only one mesh.

---

### Section 226: Three Mitigation Options for Volume Bias

**Option 1: Normalize score by silhouette pixels**
- Architecturally correct fix
- Converts FP from "summed fit" to "average fit quality per pixel"
- Requires modifying FP internals
- Could take 1-2 sessions to get right

**Option 2: Drop L22 from candidate set**
- Removes most pathological case
- Doesn't fix underlying bias (L24 vs L13 still 2x volume difference)
- Bias weaker but still present

**Option 3: FP for pose only, not identity**
- Pragmatic option
- Existing pipeline IDs the part, FP determines 6DOF pose
- Orientation accuracy without forcing FP into wrong job
- FP's pose output already visually correct (wireframe wrapped real bracket)

**Decision: Option 3.** Reasoning:
- Identification problem is solvable through other means (size gating + lighting)
- Orientation problem has no good existing solution
- FP's pose output is already correct
- Use FP for what it's uniquely good at

---

### Section 227: Geometric Pickable Check — Validated End-to-End

**Pose-only smoke test on BT225L24_a with synthetic pick_normals:**

| Demo | Synthetic normal (part frame) | Angle vs -Z | Verdict |
|------|------------------------------|-------------|---------|
| Earlier run | [0, 0, +1] | 169.6° | FLIP_NEEDED ✓ |
| This run | [0, 0, -1] | 15.1° | PICK_OK ✓ |

**Same bracket, same physical orientation, opposite synthetic normal → verdict flipped cleanly.**

The geometric pickable pipeline is functionally complete; it just needs operator-taught pick_normal values to be useful in production.

**Annotated outputs preserved separately:**
- /home/teddy/foundationpose_eval/results/pose_only_annotated_plus_z/ — 20 frames, FLIP_NEEDED (168°-170°)
- /home/teddy/foundationpose_eval/results/pose_only_annotated_minus_z/ — 20 frames, PICK_OK (12°-15°)
- /home/teddy/foundationpose_eval/results/pose_only_BT225L24_a_plus_z.json and _minus_z.json — full pose logs

**Session summary saved to /home/teddy/foundationpose_eval/SESSION_SUMMARY.md**

---

### Section 228: Communication Failure — Eval vs Production

**The problem:** After the eval ran successfully, user looked at the production dashboard and said "it didn't actually improve anything."

**Root cause:** The eval ran as a manually-launched Python script that printed to terminal only. Saved annotated PNG files to a results folder. No service was started, no topic was published, no dashboard integration existed. FoundationPose was never connected to the production dashboard.

**The dashboard the user was looking at:** Running the production stack — roboai-* systemd services auto-started on boot, using depth_segment_node.py from /home/teddy/cobot_ws/, with the old pipeline (size gate + templates + NCC + histogram orientation classifier).

**Lesson:** "Evaluation mode" was unclear. From the user's perspective, "evaluation" reasonably meant "running and visible so I can watch it work." Should have explicitly said: "The eval runs in terminal only — to see results in the dashboard requires Phase 2 integration which we are deferring."

---

### Section 229: Phase A — Production Pipeline Fixes Attempted

**User goal:** Place a taught part in front of cam0, see consistent pickable/non-pickable verdict based on orientation.

**Three honest reality checks given:**
1. FoundationPose won't solve identification (volume bias)
2. Geometric pickable check needs taught pick_normals (currently all 4 are defaults)
3. To achieve user's goal, need three things working: identification + FP pose + taught pick_normal

**Phase A plan: Fix existing pipeline first (prerequisite to FP integration)**

Work items in Phase A prompt:
- Size gate tightening: 50% → 25% tolerance, lowest total dim error wins when multiple pass
- Hex ID label bug fix: lookup name from index.json, never show raw hex
- Re-teach support: verify Start Fresh works, orientation metadata saves, TEACH_READINESS check at startup

**Lighting confirmed:** User added overhead lights pointing down on parts.

**Result:** User reported "The identification didn't improve."

---

### Section 230: Code Review — Root Cause Found

**User uploaded V1-main.zip — current codebase.**

**Files reviewed:**
- src/object_detection/object_detection/depth_segment_node.py (4875 lines)
- src/object_detection/object_detection/part_library.py (170 lines)
- src/object_detection/object_detection/shape_matcher.py (325 lines)
- src/object_detection/object_detection/step_parser.py (669 lines)
- src/cobot_dashboard/cobot_dashboard/dashboard_server.py (2995 lines)

**Phase A status confirmed:**
- ✅ SIZE_GATE_RATIO_FLOOR = 0.75 at line 3844 (25% tolerance, as specified)
- ✅ SIZE_GATE_BEST_MATCH override at lines 4277-4295 (lowest dim error wins)
- ✅ _id_to_name at lines 2871-2918 has proper "UNKNOWN PART (xxxxxxxx)" fallback
- ✅ Five-signal blend orientation classifier (NCC + hist + spatial + depth + feature)

**ROOT CAUSE OF HEX-ID BUG FOUND:** depth_segment_node.py line 1837 in _load_templates:

```python
name = part_id                                    # ← BUG: fallback IS the hex
meta_path = os.path.join(mdir, f'{part_id}.json')
if os.path.isfile(meta_path):
    try:
        with open(meta_path) as fp:
            name = json.load(fp).get('name') or part_id
    except Exception:
        pass
self._templates[part_id] = {'name': name, 'templates': tpls}
```

**The template loader has its own name resolution that BYPASSES `_id_to_name`.** When metadata is missing or 'name' field absent, hex leaks through to the dashboard label.

**Worse:** Orphan templates (templates without matching metadata) can match real detections via the template fallback at line 4345 (score ≥ 0.55), causing real BT225L24_a brackets to be misidentified as the hex ID `1d4faaa265df`.

**The screenshot pattern that confirmed this:** Hex-ID part appeared in the SAME scene as correctly-identified BT225L24_a parts. One part shows as hex, others show correctly — that pattern is exactly what an orphan template would cause. A systemic identification problem would affect all parts equally.

---

### Section 231: Orphan Template Fix — Prompt Generated

**Fix specification given to Claude Code:**

1. In _load_templates (line 1801), skip orphan templates entirely with warning:
   - Log "TEMPLATE_ORPHAN_SKIPPED: <part_id_prefix>..."
   - Do NOT add orphan to self._templates
   - Prevents orphans from matching anything

2. List loaded templates at startup using proper _id_to_name resolution

3. Diagnostic at startup:
   - Scan /opt/cobot/parts/templates/ for *_templates.npz
   - For each: check if metadata/<part_id>.json exists
   - Print "ORPHAN: <part_id>" or "OK: <part_id> → <name>"
   - Summary: "templates: N loaded, M orphans skipped"

4. Sanity check on /opt/cobot/parts/index.json:
   - Verify metadata/<id>.json exists with 'name' field
   - Log mismatches: "INDEX_MISMATCH"

5. One-time cleanup pass — list orphan template file paths to stdout. DO NOT auto-delete.

**Constraints maintained:**
- Do NOT modify size gate (already correct at 0.75 floor)
- Do NOT modify _id_to_name (already correct)
- Do NOT modify dashboard
- Do NOT touch foundationpose_eval directory

---

### Section 232: Honest Limits of the Orphan Template Fix

**What this fix solves:**
- Hex ID label disappears
- Real parts won't get falsely matched to orphan templates
- That specific class of misidentification stops

**What this fix does NOT solve:**
1. Wrong orientation verdict (NCC + histogram classifier brittleness on similar parts)
2. Wrong part name from valid identification edge cases
3. Label overlap rendering

**Realistic path to "consistently identifies pickable or non-pickable":**

```
1. Re-teach all 4 parts under new lighting      (operator, 30 min)
2. Run orphan template fix                       (Claude Code, 15 min)
3. Test each part ALONE in front of cam0         (operator, 5 min)
   - Single part, clean background
   - Record: identification correct? Pickable correct?
4. If step 3 still shows orientation errors:
   NCC+histogram has hit its ceiling.
   FP integration becomes necessary (Phases B and C).
```

Steps 1-3 are the cheapest path. Steps 1 and 2 might get to "good enough" without ever needing FoundationPose in production. Won't know until isolated single-part testing is done.

---

### Section 233: Ring Light Recommendation

**For RealSense D435i overhead, small shiny aluminium brackets at 30-40cm working distance:**

**First choice: Neewer 10" or 12" Ring Light with diffuser ($30-50 on Amazon)**

Look for:
- USB or AC power (USB easier on a workbench)
- Adjustable brightness (will dial down for shiny parts to avoid blown-out highlights)
- Color temperature 5000-5500K (daylight)
- Built-in diffuser OR frosted plastic cover

Mount so camera lens sits in centre of ring, pointing down. Eliminates directional shadows that currently cause depth mask to undersize parts (screenshot showed 3×1cm for a 3.8×2.6cm bracket — shadow loss).

**Why a ring specifically:** Shiny aluminium creates specular reflections (bright spots that "move" as part rotates). Single light source = one moving hotspot. Ring light surrounds lens, reflections appear roughly symmetric and don't dominate. Also kills shadows.

**Tier 2 ($80-150): Godox LR150 or similar bi-color ring** — bigger ring, more even light distribution, bi-colour means tunable warm/cool

**Industrial tier ($200-500+): Effilux EFFI-Ring or Smart Vision Lights** — proper machine vision rings, flicker-free, tight beam control. Overkill for prototype, buy when past prototype stage.

**Setup tips:**
- Mount ring 5-10cm above lens, not flush (flush bounces light back from shiny surfaces into lens)
- When re-teaching after install: dim light down until brightest spots on bracket aren't fully white (no clipped pixels)
- Aim for shiny areas to look like medium-bright grey, not white
- Overexposure destroys surface texture that NCC classifier needs

---

### Updated Detection Pipeline Status (June 9, 2026)

```
Detection (depth_segment_node.py, 4875 lines):
  1. Depth frame → 7-frame average → bilateral filter → RANSAC table plane
  2. Above-table mask → morphological closing → contour extraction
  3. Size filter (>0.8cm both dims) → fill ratio filter (>15%)
  4. 2D minimum-area rotated rectangle → OBB dimensions

Part Identification:
  5. SIZE_GATE: 25% tolerance (RATIO_FLOOR=0.75) per dim and aspect
     Logs: "SIZE_GATE: det=[XxYcm] candidates: L24(pass, err=4.2%), L28(fail, err=12.8%)..."
  6. SIZE_GATE_BEST_MATCH override: lowest total dim error wins if multiple pass
  7. Template matching (72 templates per part, 6 orientations × 12 yaw)
     ⚠ Orphan templates without metadata leak hex IDs (FIX PENDING)
  8. Teach reference five-signal blend:
     - NCC × weights['ncc']
     - Color histogram correlation × weights['hist']
     - Spatial color grid × weights['spatial']
     - Depth geometry × weights['depth']
     - Harris keypoints + LBP × weights['feat']
  9. Nearest-centroid orientation classifier (per-part, trained on teach refs)
  10. CAD face feature anchor verification
  11. Four-branch combined score blend (size + group + CAD + classifier)
  12. Match threshold: 0.48

Orientation Classification:
  13. Group teach refs by (is_pickable, is_defect, orientation_number, orientation_label)
  14. Best-scoring group wins → determines is_pickable
  15. Classifier override if confidence ≥ 0.30

Annotation:
  16. GREEN box + ✓ PICK OK for pickable
  17. RED box + ✗ NO PICK for non-pickable
  18. RED box + ⚠ DEFECT for defective
  19. AMBER box for matched but orientation unknown
  20. GREY box for unknown
  ⚠ Label overlap not handled (multiple labels stack on top of each other)
```

---

### Updated Parts Library (June 9, 2026)

| Part | Dimensions (cm) | Teach Refs | STEP Templates | pick_normal | Status |
|------|-----------------|------------|----------------|-------------|--------|
| BT225L24_a | 3.8 × 2.6 × 5.1 | 4 | 72 | DEFAULT | Needs re-teach under new lighting |
| BT225L28_a | 3.8 × 2.8 × 5.1 | 10 | 72 | DEFAULT | Needs re-teach under new lighting |
| BT225L13_a | 6.3 × 1.9 × 1.3 | 8 | 72 | DEFAULT | Needs re-teach under new lighting |
| BT225L22_a | 1.9 × 2.2 × 18.4 | 2 | 72 | DEFAULT | Needs re-teach under new lighting |

⚠ **Orphan templates suspected** — at least one (id prefix `1d4faaa265df`) leaks hex into dashboard labels. Cleanup pending.

---

### Key Decisions Made June 9, 2026

- **FoundationPose for pose only, not identity** — volume bias makes naive FP scoring biased toward larger meshes (L22 wins regardless of ground truth). Architectural fix (silhouette normalization) deferred.
- **OBB-seeded rotation grid** — use depth segmentation's PCA yaw to seed FP, ~12-24 hypotheses, registration ~2s instead of 20s
- **Geometric pickable check from FP pose** — angle of pick_normal to camera -Z axis determines PICK_OK / FLIP_NEEDED. Validated cleanly with synthetic normals.
- **Eval environment kept separate** — /home/teddy/foundationpose_eval/ is isolated from /home/teddy/cobot_ws/, no production changes from eval work
- **Phase A before Phase B/C** — fix existing pipeline first (size gate, hex ID, re-teach under lighting) before integrating FP into production
- **Lighting CRITICAL** — user added overhead lights this session. Re-teach required to update teach refs to match new lighting conditions.
- **Ring light: Neewer 10" tier** — $30-50, USB, adjustable, 5000-5500K, diffuser required
- **Orphan template skip** — templates without matching metadata json must be skipped, not loaded with hex ID as fallback name
- **No mixed-scene testing for validation** — single part alone in cam0 view is the diagnostic test before multi-part bin picking

---

### Key Pending Items (June 9, 2026)

| Item | Priority | Blocker |
|------|----------|---------|
| Re-teach all 4 parts under new lighting | CRITICAL | Operator action (~30 min in dashboard wizard) |
| Orphan template fix | HIGH | Prompt generated, awaiting Claude Code execution |
| Isolated single-part testing | HIGH | Must follow re-teach + orphan fix |
| Ring light purchase | HIGH | Neewer 10" recommended, ~$30-50 |
| Label overlap rendering fix | MEDIUM | Dashboard cosmetic, doesn't affect accuracy |
| Phase B: pick_normal teaching workflow | MEDIUM | Required before FP integration |
| Phase C: foundationpose_node.py production integration | MEDIUM | Required if Phase A doesn't achieve target accuracy |
| Score normalization by silhouette pixels (FP for ID) | DEFERRED | Revisit only if Phase C inadequate |
| Texture/color discriminator for L24 vs L28 | DEFERRED | Revisit if size gating + lighting can't separate |
| ROS service to teach pick_normal | DEFERRED | Part of Phase B build |

---

### Key Bugs Identified June 9, 2026

| Bug | Root Cause | Fix Status |
|-----|-----------|-----------|
| Hex ID label (e.g. "1d4faaa265df — NO PICK") | _load_templates line 1837 uses `name = part_id` as fallback when metadata missing | Prompt generated, not deployed |
| Orphan templates matching real detections | Template fallback at line 4345 accepts any template with score ≥ 0.55, including those with no metadata | Same fix as above (skip orphans during load) |
| Communication failure: user expected FP in dashboard | Eval ran terminal-only, no service or topic, no dashboard integration | Process lesson — explicitly state "terminal-only" in future evals |
| Wrong orientation verdict on taught parts | NCC + histogram classifier brittleness on visually similar parts | Architectural — FP integration (Phase C) is the structural fix |
| Label overlap in dashboard | No collision avoidance in _publish_annotated label placement | Not yet addressed |

---

### FoundationPose Evaluation Artifacts (June 9, 2026)

**Workspace:** /home/teddy/foundationpose_eval/ (isolated from cobot_ws)

**Files in place:**
- meshes/BT225L{24,28,13,22}_a.obj — 4 verified meshes, in metres
- eval_utils.py — registry, transforms, classify_pick_normal, pickable_from_pose
- run_live_multi.py — multi-mesh scorer node (built but NOT used for ID per decision)
- run_eval.py — supports smoke, full, pose_only modes
- FoundationPose/estimater.py — OBB-seeded make_rotation_grid() with optional roll/pitch perturbations
- SESSION_SUMMARY.md — comprehensive summary for next session

**Result artifacts:**
- results/pose_only_BT225L24_a_plus_z.json — FLIP_NEEDED demo
- results/pose_only_BT225L24_a_minus_z.json — PICK_OK demo
- results/pose_only_annotated_plus_z/ — 20 annotated frames (FLIP_NEEDED)
- results/pose_only_annotated_minus_z/ — 20 annotated frames (PICK_OK)
- results/annotated/ — multi-mesh smoke test frames (showing volume bias)

**Constraints respected throughout:**
- /home/teddy/cobot_ws/ — untouched
- No roboai-* service restarts
- No new system packages
- Pure additive under /home/teddy/foundationpose_eval/

---

*Last updated: June 9, 2026*
*Covers sessions 216–233: Random object bin picking demand discussion (high demand, project's stack targets exactly this), LiDAR role clarified (supporting role for workspace geometry + surface anchoring + safety, cameras own the bin picking work), FoundationPose environment verified (torch 2.5 + pytorch3d 0.7.7 + nvdiffrast 0.4.0), FoundationPose demo on mustard bottle sample data (20s register, 4.6 Hz tracking, score 57.938), how FP works (render-and-compare, not direct STEP-to-image comparison), registration speed analysis (symmetry-based hypothesis reduction 84/126/252), OBB-seeded pose search chosen (Option 2), evaluation harness phased plan (Phase 1-5), four spec/reality mismatches resolved (rotation grid API, topic name, 2D bbox derivation, metadata path), mesh prep all 4 passed 10% tolerance (meshes already in metres), smoke test revealed volume bias (L22 wins regardless of ground truth — long mesh = more pixels to score = higher summed score), pivot to FP-for-pose-only architecture (Option 3, identification stays with existing pipeline + lighting), geometric pickable check validated end-to-end (synthetic [0,0,+1] → FLIP_NEEDED 169.6°; [0,0,-1] → PICK_OK 15.1° on same bracket same orientation), session communication failure (eval was terminal-only but user expected dashboard integration), Phase A identification fixes (size gate 25%, hex ID lookup, re-teach support — all confirmed implemented in current code), code review of depth_segment_node.py (4875 lines) revealed ROOT CAUSE of hex-ID label bug: _load_templates line 1837 uses `name = part_id` as fallback bypassing centralized _id_to_name function, orphan templates without metadata leak hex IDs and can falsely match real detections, ring light recommendation (Neewer 10" with diffuser, USB, 5000-5500K, $30-50), parts library status (all 4 brackets need re-teach under new lighting, all have DEFAULT pick_normal), key pending items prioritized (re-teach CRITICAL, orphan fix HIGH, isolated testing HIGH, ring light HIGH)*


---

## June 10, 2026 — Session Log

### Dashboard Build-Out, Vision Sensor Selection, Quality Inspection Architecture, LiDAR Motion Detection

**Last Updated**: June 10, 2026
**Covers**: Palletize and depalletize wizard build, gripper field cleanup, parts-finding source simplification, expand-button overlap fix, teach pendant fullscreen, jog button enlargement, programming wizard rename, custom gripper with STEP upload, monitor tab redesign with target part viewer, monitor section removal (I/O row, recent events, program steps), fullscreen teach overlay, Estun ECO arrival day-one checklist, URDF and DH parameters discussion, step row text-alignment fixes, detect step library-part dropdown, 3D camera market analysis (Photoneo alternatives, Mech-Eye lineup, Zivid comparison, Chinese alternatives, MotionCam alternatives), Mech-Eye NANO ULTRA-GL selected with environmental awareness architecture, ring light evaluation for Mech-Eye, Quality Inspection capability architected and built (three-tier inspection, dashboard tab, ROS2 package, executor integration), LiDAR motion detection + 3D bounding box capability architected and built (motion segmentation, oriented bounding boxes, multi-object tracking, safety zone integration).

---

### Section 234: Palletize Wizard Build — Initial Spec

**Decision made:** Build out palletize as a complete operation type in the Program Wizard.

**Wizard configuration choices (single-question elicitation):**
- Pallet positions defined by teaching **corner 1 only**, robot calculates rest from rows/cols/spacing
- **Multi-layer stacking support** required (teach layer 1, robot adds Z offset per layer)
- **Teach corners + pick position in the wizard itself** (not deferred to Program tab)

**Build scope:**
- 4 new wizard pages: pallet layout (rows × cols × layers + spacing + fill order), teach pick position, teach pallet corner, place approach settings
- Pallet config JSON structure with grid + corner_tcp + approach/retract heights
- generate_palletize_program() produces step list with move_to_pallet step using runtime-computed positions
- Executor changes: pallet_state counter, compute_pallet_position() helper, get_next_slot() with 4 fill orders (row_lr, row_rl, col, snake)
- Monitor tab pallet progress widget: grid visualization with green/blue/red status per slot, layer tabs, ETA estimate
- Step labels: "Pallet loop — N cycles (R×C×L)" with grid icon

---

### Section 235: Depalletize Combined into Same Operation Path

**Decision made:**
- For depalletize, parts are found via **fixed positions** (mirror of palletize grid, no camera needed)
- Depalletize is **combined with palletize** as a mode toggle on a new page 1b after operation selection

**Wizard flow:**
- Page 1b: PALLETIZE MODE — two large cards (Palletize ↓ / Depalletize ↑)
- Stores `answers.pallet_mode = 'palletize' | 'depalletize'`
- Source = 'camera_auto' for palletize, 'fixed_grid' for depalletize
- Skip "How to find parts?" and "Which part?" pages for both pallet modes

**Path divergence:**
- PALLETIZE path: teach pick position → teach pallet corner [1,1,1] → place approach settings
- DEPALLETIZE path: teach pallet corner [1,1,top layer] → teach place position → pick approach settings
- Both paths rejoin at speed → repeat (locked to rows×cols×layers) → name → review

**Step generation:**
- PALLETIZE: move_home → loop (detect/approach/pick/move_to_pallet/place) → move_home
- DEPALLETIZE: move_home → loop (move_to_pallet/pick/move_linear/place) → move_home
- Depalletize reverses layer order: `actual_layer = (total_layers - 1) - computed_layer` (top layer first)

**Executor file location resolved:** Executor lives at `src/estun_driver/estun_driver/program_executor_node.py` outside cobot_dashboard. Decision: **Option 1 — modify estun_driver directly** for clean runtime grid math, with build command updated to include both packages: `colcon build --packages-select cobot_dashboard estun_driver --symlink-install`. No service restarts.

**Single-prompt issue resolved:** Initial prompt had nested code fences (``` inside ```) which broke into multiple visual blocks. Fix: replace all inner code fences with indented plain text so the whole prompt is one continuous fenced block readable by Claude Code as one prompt.

---

### Section 236: Wizard Gripper Field Cleanup

**Change:** Remove gripper width and gripper force questions from the Program Wizard.

- For finger gripper: page becomes empty after removal → page removed entirely, wizard navigation skips it
- For magnetic gripper: same — page removed if empty
- For vacuum gripper: keep vacuum threshold only
- Back/forward navigation updated to bypass skipped pages in both directions

---

### Section 237: Parts-Finding Source Simplification

**Change:** Reduce parts-finding options on wizard page 2 from three to two.

**Before:** Camera Auto | Library Part | Fixed Position
**After:** Camera Detection | Fixed Position

- "Camera Auto" removed as standalone option
- "Library Part" renamed to "Camera Detection" with new subtitle: "Camera detects parts using taught references from the Part Recognition library"
- Stored value `source = 'camera_library'` (replaces 'camera_auto' and 'library_part')
- All downstream checks updated from old values to 'camera_library'
- "Camera Detection" still triggers the "Which part?" page (parts library picker)
- "Fixed Position" still skips that page

---

### Section 238: Expand Button Overlap Fix

**Bug:** Expand buttons on three Program tab panels (steps left, 3D viewer right, jog controls bottom) overlapping other buttons.

**Fix:** Consistent absolute positioning across all three panels:
- `position: absolute; top: 8px; right: 8px; z-index: 10`
- Parent panels have `position: relative; overflow: hidden`
- 32×32px icon-only buttons (Unicode ⛶ or SVG chevron)
- Panel content padding-top minimum 44px so first row never overlaps expand button
- Collapse buttons in expanded state use same top-right position

---

### Section 239: Teach Pendant Fullscreen Capability

**Change:** Teach pendant (jog arrow pads + joint sliders + Run/Stop/Home/Teach buttons) inside the bottom jog controls panel now has its own fullscreen expand button matching the other two panels.

**Behavior:**
- Same expand button style and position (top-right, 32×32px)
- When expanded: teach pendant fills the entire Program tab area, all other panels hidden
- Arrow buttons scale to fullscreen sizes when expanded
- Expanded state stored in Zustand store, persists across tab switches
- Only one panel can be expanded at a time

---

### Section 240: Jog Button Enlargement (Normal + Fullscreen)

**Issue:** Jog buttons too small and too clustered, lots of unused horizontal space in both normal panel and fullscreen views.

**Normal panel view sizes (from 80×80):**
- D-pad arrow buttons: 96×96px (up from 80×80)
- SVG arrow icons: 42px (up from 36px)
- Gap within D-pad: 10px
- Gap between groups (XYZ D-pad / Z column / rotation D-pad): 28px
- Action buttons (Run/Pause/Stop/Home/Teach): min height 52px, font 14px, min width 80px
- Mode toggle: min height 44px, font 13px

**Fullscreen view sizes (from 110×110):**
- D-pad arrow buttons: 140×140px
- SVG arrow icons: 60px
- Gap within D-pad: 14px
- Gap between groups: 40px
- Action buttons: min height 68px, font 17px, min width 100px
- Mode toggle: min height 56px, font 16px

**Layout:** Container uses `display: flex; justify-content: space-evenly; align-items: center; width: 100%; height: 100%; padding: 12px normal / 20px fullscreen` so buttons fill dead space rather than clustering in one corner.

Implementation: existing `isFullscreen` prop (or equivalent class) switches sizes conditionally.

---

### Section 241: Program Header Button Renames

**Change:** Program tab header buttons renamed for clarity.
- "+ Blank" → "New Program"
- "Wizard" → "New Program Wizard"

Label text only. No functionality or styling changes.

---

### Section 242: Custom Gripper with STEP Upload

**Change:** Replace "Magnetic" gripper option with "Custom Gripper" supporting STEP file upload and 3D preview.

**Wizard changes:**
- Gripper type page: third option renamed from "Magnetic" to "Custom Gripper"
- `gripper_type = 'magnetic'` → `gripper_type = 'custom'`
- All downstream checks updated

**Custom Gripper settings page layout (3 sections):**

1. **STEP File (optional):**
   - Drag-and-drop + Upload button
   - Accepts .step / .stp
   - POST to `/api/gripper/upload` (new endpoint)
   - Three.js viewer rendering converted GLB (white background, metallic grey #A8B0C0, OrbitControls)
   - Shows gripper name + dimensions (W×D×H cm) from STEP metadata
   - Remove button to clear

2. **Gripper Name:** text input pre-filled with STEP filename

3. **I/O Assignment (optional):**
   - Activate signal dropdown (DO labels from `/api/io/config`)
   - Confirm signal dropdown (DI labels)
   - Reuses existing IO port linking pattern

**Backend additions:**
- `POST /api/gripper/upload` — reuses existing `step_parser.py` pipeline (STEP → GLB + STL + metadata)
- Storage: `/opt/cobot/grippers/{gripper_id}/`
- `GET /api/gripper/list`, `DELETE /api/gripper/{id}`
- GLB served at `/grippers/glb/{gripper_id}.glb`

**Program config additions for custom gripper:**
- `gripper_type: 'custom'`, `gripper_name`, `gripper_model_id`, `gripper_glb_url`, `activate_signal`, `confirm_signal`

**3D viewer integration:** When loaded program has custom gripper with `gripper_model_id`, the gripper GLB renders below the robot flange (offset -0.05m on Z relative to tool0). Same metallic grey material as parts viewer. Small label "Custom Gripper: {name}" below viewer.

**Reuses existing infrastructure:** step_parser.py pipeline, Three.js viewer component from parts library, IO port dropdown from Section 81.

---

### Section 243: Monitor Tab Redesign — Change Program + Target Part Viewer

**Changes to Monitor tab top section:**

1. **Change Program button added** to the existing button row (Run/Pause/Stop/Edit Program).
   - Position: left of Edit Program
   - Style: secondary button (matches Edit Program)
   - Opens existing Program Library overlay (reuses component directly)
   - On selection: loads program via `GET /api/programs/{id}`, sets active on executor via `POST /api/program/run` with `action: 'load'` (does NOT auto-start), updates Monitor display, closes overlay
   - Cancel button on overlay to dismiss without changing

2. **Target Part 3D Viewer relocated to top section.**
   - Removed from Section 95 lower position (no duplicate)
   - New layout: left block (status badge + program name + description + step indicator + button row) and right block (target part viewer, 220px fixed width)
   - Right block shown ONLY when: a program is loaded AND program config has target_part AND `GET /api/parts/{target_part_id}` returns a part with GLB at `/parts/glb/{part_id}.glb`
   - Viewer specs: Three.js, 200×200px, white background, metallic grey material, OrbitControls enabled, auto-rotate (autoRotateSpeed 1.5), no grid floor, part name + dimensions below, "TARGET PART" label above
   - When not shown: right block hidden entirely, left block takes full width

---

### Section 244: Monitor Tab — Removed Sections

**Change:** Remove three sections from Monitor tab entirely.

1. **I/O summary row** (horizontal pills for Gripper Closed, Gripper Open Sensor, Safety Gate, E-Stop, Vacuum On, Conveyor Forward, etc.)
2. **Recent Events panel** (last 5 fault/event log entries)
3. **Program Steps panel** (color-coded progress bar + horizontal numbered step cards: Move to home, Open gripper, Approach object, Pick & close, Place at target, etc.)

Components, data fetching, and WebSocket subscriptions used solely by these three sections are removed. WebSocket fields used elsewhere in Monitor remain intact.

---

### Section 245: Consolidated Teach Sequence (then changed to Fullscreen Overlay)

**Initial approach (Section 245a):**
- Remove all teach pages from main wizard question flow (teach_home, teach_pick, teach_place, teach_machine_load, teach_unload, teach_inspect, PA1, PA2, DA1, DA2)
- Add dedicated TeachSequence as fullscreen overlay after Name page, before Review
- Position list derived from operation type (Pick & Place = 3 positions, Sort = 3-4, Machine Tend = 4, Palletize = 3, Depalletize = 3, Inspect = 3)
- Layout: dark backdrop, centered white panel 90vw × 90vh max 900px, header with "TEACHING POSITIONS Step N of M" + Skip All
- Per-position view: position name (24px bold), instruction text (16px muted), embedded JogControls fullscreen sizes (140×140px arrows), progress dots row, Back/Record Position/Skip buttons
- Skip All marks all remaining as skipped, advances to Review

**Refinement (Section 245b — visual issue feedback):**
- Existing teach banner was too small (small blue box at top with Record Position/Skip/Cancel)
- Replaced with **full-viewport fullscreen overlay** when teaching active
- Layout: header bar (60px, dark #141416) with step indicator + cancel; instruction band (48px, #1C1C1F); jog controls area (flex: 1, fills majority of screen, fullscreen 140×140 buttons); footer bar (100px) with Back / "RECORD POSITION" (72px tall, 280px wide minimum, font 20px bold, green #00C47A) / Skip; thin progress bar at bottom (4px)
- Touch event handlers (onTouchStart/End) not just onClick for tablet operation
- Body scroll locked while overlay open
- No backdrop click to dismiss (prevents accidental closure mid-teach)
- Triggered from Teach All flow OR individual step Teach button (single-position mode for individual button: no Back, Cancel exits)

---

### Section 246: Estun S10-140 ECO Day-One Checklist

**Confirmed:** NeuRobots moving forward with Estun S10-140 ECO mode (not Pro).

**Software readiness audit:**
- Estun ROS2 driver (`estun_driver_node.py`): complete (WebSocket, 50Hz joint polling, jog with keepjog heartbeat, motion movj/movl, I/O with port offset, auto-reconnect)
- Program executor: complete
- Dashboard fully wired via ROS2 topics
- All 15 systemd services configured with `Restart=always`

**ECO arrival physical steps (in order):**

1. **Resolve subnet conflict** — Jetson on 192.168.1.x, Estun defaults to 192.168.101.100. Three options:
   - Ask Estun to change robot IP to 192.168.1.100 (easiest if teach pendant allows)
   - Add second IP to Jetson eno1: `sudo ip addr add 192.168.101.246/24 dev eno1`
   - USB Ethernet adapter (~$15) as dedicated robot interface

2. **Update driver config** with real IP in `estun_driver_node.py`, then `sudo systemctl restart roboai-estun`

3. **Run connection test:** `python3 scripts/test_estun_connection.py` (should show WebSocket connected + joint angles streaming)

4. **Verify dashboard shows IDLE** at `http://192.168.1.246:8080` (not "Disconnected")

5. **Test jog controls** — jog each joint individually at low speed, verify direction matches convention

6. **Teach home position and do first run at 15% speed**

**ECO vs Pro impact:**
- WebSocket API identical → driver works as-is
- ECO has **no joint torque sensors** → collision detection relies on motor current only (less sensitive, 20-50N threshold vs Pro's 5-10N)
- External Bota SensONE force sensor (~$2,500) recommended later if force-controlled assembly or hand-guiding needed
- For basic pick-and-place and palletizing: ECO is sufficient

**Remaining software gaps (independent of ECO vs Pro):**
- Extrinsic calibration (`scripts/calibrate_extrinsics.py` — run after robot mounted, cameras fixed)
- **MoveIt2 config** — needs URDF from Estun (collision avoidance blocked until then; direct motion commands still work)
- Gripper RS485 driver (build once gripper selected)
- Safety tab placeholder (speed limits, zone config, E-stop behaviour, I/O mapping)
- Joint direction verification (some may be inverted vs convention — one test jog session fixes)

---

### Section 247: URDF and DH Parameters — What to Request from Estun

**URDF defined:** Unified Robot Description Format — XML file (`.urdf`) describing:
- Links (rigid bodies with mesh geometry)
- Joints (how links connect, pivot points, rotation limits)
- Collision geometry (simplified shapes for obstacle avoidance)

**Three paths to obtain URDF:**

1. **Ask Estun directly** (try first, costs nothing) — request URDF/xacro + 7 link mesh files (STL/DAE) + DH parameters table. S10-140 Pro and ECO share mechanical structure so either URDF would work.

2. **Build from existing STEP file** (`S10-140_G2.STEP` 138MB on Jetson). Manual approach in FreeCAD (~30-45 min):
   - Open STEP in FreeCAD on Windows laptop
   - Identify 7 bodies: base, shoulder, upper arm, forearm, wrist1, wrist2, flange
   - Export each as separate STL
   - Measure joint origin coordinates (X/Y/Z offsets between joints)
   - Provide Claude Code with the offsets to auto-generate URDF + MoveIt2 config

3. **Use proxy URDF** (UR5e currently loaded as placeholder) — sufficient for development before robot arrives.

**DH parameters request to Estun:** Yes, ask for them. DH (Denavit-Hartenberg) is a table of 4 numbers per joint (a, d, α, θ offset) that mathematically reconstructs the entire kinematic chain. Claude Code can generate URDF + MoveIt2 config directly from a DH table. **Either DH table or URDF is sufficient — take whatever Estun provides.**

---

### Section 248: Step Row Text Alignment Fixes

**Issue 1:** Step titles in Program tab not aligned — some bleeding left out of the middle section, sitting flush against tag column.

**Fix:** Enforce strict three-column layout on every step row regardless of which elements present:
- LEFT column (fixed, no shrink): drag handle, step number, taught/untaught circle, action type pill
- MIDDLE column (flex 1, min-width 0, padding-left 16px): title (margin 0, padding 0, width 100%) and detail row (flex space-between with detail text left + view-position-data link right)
- RIGHT column (fixed, no shrink): Edit, Re-teach (if applicable), Del buttons

All title left-edges must align vertically scanning down the column.

**Issue 2 (separate, earlier):** Step rows had positional data cluttering view (joint values, TCP coordinates, taught_at timestamps).

**Fix:**
- ALWAYS VISIBLE: action type tag, motion parameters (z+100mm | 50%), NOT TAUGHT warning, taught indicator
- HIDDEN BY DEFAULT: joint values (J1: 0.12 J2: -0.45 ...), TCP coordinates, taught_at, raw numeric position data
- Toggle: "▸ View position data" link (12px muted, underline on hover) at right end of detail line
- Expanded view: monospace block (11px), indented under step, slightly darker background, rounded corners

**Title sizing increase:** 17px, weight 500, letter-spacing 0.01em, flex: 1 to stretch to fill horizontal space between number/tag and action buttons (no truncation with ellipsis — wraps to second line if needed).

---

### Section 249: Detect Step — Library Part Dropdown

**Change:** In the detect step editor, replace the button labeled "Detect Library Parts" with:

1. **Section title (non-interactive label):** "Detect Library Parts" (13px weight 500, matches other section headings)

2. **Dropdown below title:**
   - Populated from `GET /api/parts`
   - First option (default): "Any library part" (value 'any')
   - Then one option per part: "{part.name}" e.g. "BT225L24_a", "BT225L28_a", "BT225L13_a", "BT225L22_a"
   - Empty library: single disabled option "No parts in library — add parts in Part Recognition tab"
   - Full-width styling matches other step editor dropdowns

3. **Storage:** `step.detect_target = 'any' | '{part_id}'`

4. **Step list detail line update:**
   - "detect | Any library part" — when 'any'
   - "detect | {part name}" — when specific (e.g. "detect | BT225L24_a")

5. **Loading state:** Show "Loading parts..." while fetching on mount. Cache result so reopening editor doesn't re-fetch unchanged data.

---

### Section 250: 3D Camera Market Analysis — Photoneo Alternatives

**Context:** Photoneo PhoXi M/L (~$8-15k+), MotionCam-3D (~$15-18k+) are gold-standard for industrial bin picking but expensive. Wanted to know cheaper alternatives.

**Industrial-grade ($1-5k) Photoneo alternatives:**

| Camera | Price | Strengths |
|--------|-------|-----------|
| **Zivid Two** | ~$4-5k | Industrial structured light, ±0.07mm, ROS2 native, bin picking focus |
| **Mech-Eye Nano / Pro S** | ~$3-4k | Direct Photoneo competitor (Chinese), real bin picking deployments |
| **LMI Gocator 3210/3506** | ~$5-8k | Snapshot 3D for inspection, sub-mm |
| **Roboception rc_visard** | ~$4-5k | Stereo with onboard processing, ROS2 native |

**Hobbyist-pro middle ground ($300-1000):**

| Camera | Price | Notes |
|--------|-------|-------|
| **Orbbec Femto Mega / Bolt** | ~$500-700 | ToF, 0.25-5.5m, ROS2 driver, struggles on shiny/dark |
| **Stereolabs ZED 2i** | ~$500 | Stereo + IMU, drops on textureless surfaces |
| **Intel D455** | ~$400 | Wider FoV, same metal-surface issues as D435i |
| **Microsoft Azure Kinect** | ~$400 (EOL 2023) | ToF, unsupported |
| **Orbbec Gemini 335L** | ~$300 | Larger Gemini 330, driver maturity unproven |

**Initial recommendation:** Test ring light first (Section 233), then consider Mech-Eye Nano (~$3k) as next step if D435i + lighting still insufficient.

---

### Section 251: Mech-Eye Lineup Comparison

**Reviewed Mech-Mind's full lineup spec sheet:**

| Model | Working Dist | Z accuracy | Resolution | Weight | Notes |
|-------|-------------|-----------|-----------|--------|-------|
| UHP-140-GL | 300±20mm | 2.6µm @0.3m | 3MP | 1.9kg | Metrology/inspection, tiny FoV |
| NANO-GL | 300-600mm | 0.1mm @0.5m | 1.3MP | 0.7kg | Compact, lower resolution |
| **NANO ULTRA-GL** | **250-800mm** | **0.1mm @0.6m** | **4.3MP** | **0.7kg** | **Selected** |
| PRO S-GL | 500-1000mm | 0.05mm @1m | 2.3MP | 1.6kg | Best long-term, too heavy for wrist |
| PRO M-GL | 1000-2000mm | 0.2mm @2m | 2.3MP | 1.9kg | Too far for bench cobot |
| LSR S/L/XL-GL | 500-3500mm | 0.2-1mm | 2.4MP | 1.9-4.5kg | Laser scanners, large objects |
| DEEP-GL | 1200-3500mm | 1mm @3m | 2MP | 2.4kg | Pallet picking, large objects |

**Initial recommendation:** NANO ULTRA-GL based on:
- Working range 250-800mm covers bench-top close-in to comfortable overhead
- 4.3MP highest resolution in lineup → texture detail for NCC/histograms
- 0.1mm Z accuracy on aluminium brackets (sub-mm orientation feasible)
- 0.5-0.9s capture time
- 125×46×76mm, 700g — smallest of viable options
- Blue LED 440nm light source (better than IR for shiny aluminium)

---

### Section 252: Wrist-Mounting Confirmed — NANO ULTRA Stronger Fit

**Decision:** Camera mounted on robot arm (eye-in-hand) for agility across workspaces.

**Wrist-mount reshapes the calculation:**

| Factor | Fixed overhead | Wrist-mounted |
|--------|---------------|---------------|
| Weight | Not critical | Critical (eats payload) |
| Capture time | Less critical | Critical (robot waits) |
| FoV at close range | Less important | Critical (robot moves in close) |
| Cable routing | Easy | Through wrist, flex-rated needed |
| Vibration | None | Robot motion settling required |

**Updated elimination:** PRO S-GL (1.6kg, 265mm long) too heavy + moment arm too large.

**Confirmed winner:** NANO ULTRA-GL — 0.7kg, 125mm body shortest of viable options, leaves ~9kg payload for gripper + part on S10-140's 10kg budget.

**Mounting plate plan:**
- Adapter machined or 3D printed for S10-140 flange
- Optical axis parallel to gripper approach direction, offset ~80-120mm
- This offset becomes "tool0 to camera" transform in TF tree
- Gigabit Ethernet + 24V power both flex-rated, route through hollow wrist if available, otherwise external with strain relief
- ~3m cable from flange to controller

**Hand-eye calibration mandatory:** AprilTag-based script already exists in codebase. Recalibrate any time camera removed/reattached.

**Mech-Mind questions to ask before purchase:** Settle time after motion before scan trigger, TF integration in ROS2, hand-eye calibration utility included?

---

### Section 253: D435i vs NANO ULTRA — Side-by-Side

| Spec | D435i | NANO ULTRA-GL |
|------|-------|---------------|
| Technology | Active stereo IR | Structured light (Blue LED 440nm) |
| Price | ~$280 | ~$4,000-5,000 |
| RGB resolution | 1920×1080 | 2400×1800 |
| Depth resolution | 1280×720 | 2400×1800 |
| Working distance | 0.1-10m | 0.25-0.8m |
| Z accuracy @0.5m | ±2-5mm | ±0.1mm |
| Z accuracy on shiny metal | Highly variable, often holes | ±0.1mm consistent |
| Point cloud density per frame | ~300k pts (with gaps) | ~4.3M pts (dense) |
| Frame rate | 30 FPS continuous | 1-2 FPS triggered |
| Capture time | 33ms | 500-900ms |
| Weight | 72g | 700g |
| Power | USB 5V (2.5W) | 24V DC, 3.75A (~90W) |
| Interface | USB 3.0 | Gigabit Ethernet |
| IP rating | None | IP65 |
| Use case | General-purpose depth | Industrial bin picking |

**Conclusion:** Keep D435is for continuous monitoring, person detection, scan & identify, parts teaching. Add NANO ULTRA for triggered precision bin scanning. They do different jobs.

---

### Section 254: NANO ULTRA vs Photoneo PhoXi M / MotionCam — Comparable Class

| Spec | NANO ULTRA-GL | Photoneo PhoXi M | Photoneo MotionCam-3D M+ |
|------|---------------|------------------|--------------------------|
| Price | ~$4-5k | ~$10-13k | ~$15-18k |
| Tech | Structured light (Blue LED) | Structured light (Red laser) | Parallel Structured Light |
| Working distance | 250-800mm | 458-1118mm | 366-1473mm |
| Z accuracy | ±0.1mm @0.6m | ±0.1mm @0.6m | ±0.5mm @1m |
| Point cloud | 4.3M pts (2400×1800) | 3.2M pts (2064×1544) | 2M pts (1680×1200) |
| Capture time | 500-900ms | 250-2750ms | 65-130ms (motion-tolerant) |
| Frame rate | 1-2 FPS | 1-4 FPS | 20 FPS |
| Weight | 700g | 950g | 1450g |
| Light source | Blue LED (eye-safe) | Red laser Class 2 | Red laser Class 2 |

**Verdict:** NANO ULTRA matches PhoXi M on depth accuracy + point cloud density (more pixels actually). Beats it decisively on size/weight (125mm vs 616mm long, 700g vs 950g) and price (one-third). PhoXi M physically too large to wrist-mount on most cobots. MotionCam wins only on motion tolerance (Parallel Structured Light patent moat) — irrelevant unless cycle times under 2s.

---

### Section 255: NANO ULTRA Alternatives — Other Candidates

Surveyed full competitive landscape:

**Direct competitors (sub-mm structured light, bin picking class):**
- **Zivid 2+ M60** — ~$5-6k — Norwegian, premium build, excellent ROS2 driver — closest peer
- **Zivid 2+ MR60** — ~$6-7k — higher resolution 5MP version
- **IDS Ensenso N35/N45/N46** — ~$4-7k — German, stereo + projector hybrid
- **Roboception rc_visard 65/160** — ~$4-5k — stereo with onboard compute, native ROS2
- **LMI Gocator 3210/3506** — ~$5-8k — snapshot 3D inspection
- **Sick Visionary-S** — ~$5-7k — industrial automation reliability
- **Cognex 3D-A1000** — ~$8-12k — Cognex ecosystem
- **Solomon SolScan** — ~$4-6k — Taiwan, bundled with AccuPick AI
- **Photoneo PhoXi Color XS** — ~$8-10k — smaller color Photoneo

**Time-of-Flight (continuous, lower accuracy):**
- **LUCID Helios2+** — ~$3,500 — industrial ToF, GigE Vision, 30 FPS continuous, ±5mm
- **Orbbec Femto Mega/Bolt** — ~$600-800 — Kinect replacement, ToF
- **Basler blaze** — ~$2,500-3,500 — industrial ToF
- **Stereolabs ZED X** — ~$1,000-1,500 — Jetson-native stereo, mobile robotics

**Chinese options (other than Mech-Mind):**
- **RVBUST RVC X Pro** — ~$4,500 — ex-Mech-Mind engineers, comparable to NANO ULTRA, 5MP, limited Western dist
- **RVBUST RVC X** — ~$3,500 — mid-tier
- **Percipio Atlas / Lacuna FS820** — ~$2,500-4,000 — budget structured light, lower accuracy
- **Hikvision MV-DT** — ~$2,000-4,000 — geopolitical concerns (US trade restriction)
- **Orbbec Gemini 335 / Femto Mega** — ~$300-700 — consumer-grade

---

### Section 256: MotionCam Alternatives — None Truly Equivalent

**Key finding:** Photoneo holds the patent on Parallel Structured Light (PSL) through 2035-2037. No other vendor delivers true continuous motion structured-light scanning at sub-mm accuracy on metal.

**Mid-tier "motion-tolerant" alternatives are all workarounds:**
1. **Faster sequential structured light** (capture so fast motion blur minimal) — Mech-Eye Pro M Enhanced (~$6k, 150-300ms), RVBUST RVC P (~$5k, 200-400ms), Smart Robotics 3D Sense Speed (~$5-7k, 250ms). All still require brief stops.
2. **ToF** (single-frame, naturally motion-tolerant) — Percipio Cobra (~$3k, 30 FPS continuous), but 2-5mm accuracy unsuitable for precision bin picking on metal.
3. **High-frame-rate stereo with projector** — Roboception rc_visard (~$5k, continuous), but stereo accuracy drops on textureless metal.

**Honest framework:**
- **True continuous motion capture:** Photoneo MotionCam-3D only
- **Fast stop-and-scan (150-300ms pause):** Mech-Eye Pro M, RVBUST P, Smart Robotics
- **Slow stop-and-scan (500-1000ms pause):** Most structured light cameras including NANO ULTRA
- **Continuous low-precision:** All ToF + stereo cameras

**Recommendation:** Don't chase MotionCam alternatives. If true continuous capture genuinely needed, buy real MotionCam. For NeuRobots project, stop-and-scan is fine because pick cycles include pauses anyway. Cycle time impact of 500-700ms scan vs MotionCam's 50ms is ~7-10% on a 5-7 second pick cycle — real but not transformative.

---

### Section 257: Zivid 2+ M60 vs NANO ULTRA — Direct Peer Comparison

| Spec | Zivid 2+ M60 | NANO ULTRA-GL | Winner |
|------|--------------|---------------|--------|
| Price | ~$5,500 | ~$4,500 | NANO |
| Technology | Blue LED structured light | Blue LED structured light | Tie |
| Working distance | 300-1500mm | 250-800mm | **Zivid (wider)** |
| Z accuracy | 0.1mm @0.6m | 0.1mm @0.6m | Tie |
| Depth resolution | 1944×1200 | 2400×1800 | **NANO (higher)** |
| RGB resolution | 1944×1200 | 2400×1800 | **NANO** |
| Color science | True-color calibrated | Standard | **Zivid** |
| HDR | Native automatic multi-exposure | Manual presets + smart HDR | **Zivid** |
| Polarization | Available accessory | None | **Zivid** |
| Capture time | 0.3-1.5s | 0.5-0.9s | Slight NANO edge |
| Weight | 940g | 700g | **NANO (-240g)** |
| Dimensions | 154×46×84mm | 125×46×76mm | **NANO** |
| ROS2 driver | Excellent (ROS-first) | Good (functional) | **Zivid** |
| SDK / desktop tool | Zivid Studio (best in class) | Mech-Eye Viewer (good) | **Zivid** |
| Country | Norway | China (Mech-Mind) | Depends |
| Production deployments | Thousands | Thousands | Tie |

**Decision matrix tilts toward Zivid on flexibility (working range, HDR, color science, ecosystem). Tilts toward Mech-Eye on resolution + form factor + price.**

**Initial Zivid recommendation rationale (environmental awareness goal):**
- 1500mm max working distance = ~4x scanning volume vs NANO ULTRA's 800mm
- Native HDR for varied materials in unknown workspaces
- Color-accurate RGB for semantic scene understanding
- ROS2-first vendor matches stack
- $1,000 delta is 1-2% of system cost

---

### Section 258: FINAL DECISION — Mech-Eye NANO ULTRA-GL

**Selected:** Mech-Eye NANO ULTRA-GL

**Rationale that flipped the recommendation:**
- Bin picking is THE current priority (everything else is future/supporting)
- Wrist-mount form factor priority (240g lighter, 30mm shorter)
- 2x resolution advantage (4.3MP vs Zivid's 2.3MP) directly addresses current orientation-classification problem on similar-looking parts (BT225L24 vs L28) which depends on texture detail
- $1,000 savings can fund mounting hardware, ring light if needed, AprilTag board
- 800mm working range still covers bench-top cobot work

**Tradeoffs accepted:**
- 800mm max working distance (vs Zivid's 1500mm)
- Manual HDR per material vs Zivid's automatic
- Less mature ROS2 ecosystem than Zivid

**Architecture confirmed:**
```
Livox MID-360 (fixed in cell)
  → 360° room awareness, safety zones, human awareness

D435i cam0 + cam1 (fixed in cell)
  → Continuous scene monitoring (30 FPS)
  → Wide scene context
  → Scan & identify on conveyor
  → Parts library teaching from multiple angles
  → Live operator view on dashboard

Mech-Eye NANO ULTRA-GL (wrist-mounted on S10-140)
  → Triggered precision scans (500-900ms each)
  → Dense cloud (~4.3M pts) for pose estimation
  → Bin contents identification and orientation
  → Workspace registration when robot moved to new cell
  → Quality inspection scans
```

**Hardware budget:**
- NANO ULTRA-GL camera: ~$4,500
- 24V DC power supply (3.75A min): ~$50
- Gigabit Ethernet cable (flex-rated, 3-5m): ~$60
- Wrist mount adapter (machined or 3D printed): ~$100-300
- AprilTag calibration board: ~$30
- **Total landed: ~$4,750-5,000**

**Pre-purchase questions to email Mech-Mind:**
1. ROS2 Humble driver — confirmed working on Jetson AGX Orin (ARM64 / JetPack 6 / CUDA 12.x)?
2. Driver package available via apt or just source build?
3. Eye-in-hand (wrist-mounted) — minimum settle time after robot motion before scan?
4. Hand-eye calibration utility included with SDK?
5. PointCloud2 + RGB Image both available simultaneously through ROS2 driver?
6. Service API for triggered scans (vs continuous publishing)?
7. Demo unit / 30-day evaluation available?
8. Lead time from order to delivery?
9. US/EU distributor for warranty and support?
10. Multiple-camera support if adding second unit (one wrist + one fixed)?

---

### Section 259: Integration Roadmap for NANO ULTRA

**Phase 1 — Driver and basic capture (1-2 days):**
1. Install Mech-Eye SDK on Jetson
2. Build mech_eye_ros2 driver in cobot_ws
3. Configure camera IP on separate subnet from Livox
4. Verify /mech_eye/depth and /mech_eye/color topics publishing
5. Visualize in RViz to confirm capture quality
6. Adjust capture parameters for aluminium brackets

**Phase 2 — Wrist mounting and calibration (1-2 days):**
1. Machine or 3D print mount adapter
2. Mount camera with optical axis parallel to gripper approach direction
3. Route Gigabit Ethernet + 24V power through wrist
4. Run hand-eye calibration with AprilTag board (15-20 robot poses, verify <1mm accuracy)
5. Add static TF: tool0 → mech_eye_optical_frame
6. Verify camera point cloud aligns with robot frame in RViz

**Phase 3 — Pipeline integration (3-5 days):**
1. Add Mech-Eye as input source in depth_segment_node.py alongside D435i input
2. Modify pipeline to handle higher resolution (4.3MP vs 1280×720)
3. Re-tune size gates and detection thresholds for new resolution
4. Re-teach all 4 parts using Mech-Eye instead of D435i
5. Run isolated single-part testing per Phase A plan
6. Benchmark orientation classification accuracy improvement
7. Verify FoundationPose evaluation now has dense enough input

**Phase 4 — Eye-in-hand workflow (2-3 days):**
1. Define scan pose for bin (~600mm above bin top, parallel)
2. Add scan trigger to program executor when reaching detect step
3. Implement settle time (200-300ms) before scan trigger
4. Process resulting cloud through existing pipeline
5. Test full pick cycle: move to scan → settle → scan → identify → pick
6. Measure cycle time and pick success rate

**Total integration: ~1.5-2 weeks focused work.**

**Realistic performance expectations after integration:**

| Metric | Current (D435i) | Expected (NANO ULTRA) |
|--------|----------------|----------------------|
| Orientation accuracy | ~60-70% | 90-95% |
| Part identification accuracy | ~70-80% | 95-99% |
| Pose estimation precision | ±5-10mm | ±0.5-1mm |
| Successful picks (autonomous) | Inconsistent | 95%+ |
| FoundationPose viability | Marginal | Robust |
| L24 vs L28 disambiguation | Frequently wrong | Reliable |

---

### Section 260: Ring Light Reconsidered — Skip for Mech-Eye

**Question:** Do we need the previously-recommended Neewer 10" ring light with Mech-Eye?

**Answer:** Probably not — Mech-Eye is self-illuminated.

**Why D435i needed ring lighting:**
- Weak IR projector + ambient-dependent RGB
- Shadows shift with time of day → depth mask shape changes
- Specular reflections on metal → depth holes + RGB blowout

**Why Mech-Eye doesn't:**
- Strong blue LED structured light projector dominates ambient at scan distance
- Depth measurement essentially independent of room lighting
- Blue wavelength (440nm) handles shiny aluminium better than IR
- Built-in LED supplements RGB

**When supplementary lighting still helps:**
- Highly reflective polished surfaces (chrome, mirror finish) — polarizing filter or diffuse fill
- Very dark workshop (<200 lux) — RGB image quality
- Color-critical applications (anodized colored parts)

**Practical recommendation:**
- **Skip the ring light purchase** — was a D435i workaround
- **If overall workshop lighting is genuinely poor:** upgrade to 5000K LED panels overhead (~$100-300) — helps everything (Mech-Eye RGB, D435i, operator visibility, monitoring video) not just one camera
- **Save the $30-50 budget** for AprilTag calibration board (~$30), better mount hardware, flex-rated cables
- **Evaluate after first scans** — test with current lighting before buying anything

---

### Section 261: Quality Inspection Capability — Architected

**Concept:** With Mech-Eye NANO ULTRA's 0.1mm Z accuracy, real dimensional inspection becomes viable. Sub-mm scanning enables genuine quality verification, not just pass/fail presence detection.

**Three-tier inspection model:**

| Tier | Capability | Implementation effort |
|------|-----------|----------------------|
| **Tier 1 — Geometric verification** | Dimensions, OBB, principal angles, aspect ratios, volume, centroid | ~70% already built into pipeline; add reference comparison + tolerance |
| **Tier 2 — Surface deviation analysis** | ICP alignment to reference + per-point distance map + defect clustering + heatmap visualization | Open3D handles ICP and distance natively; ~3-5 days |
| **Tier 3 — Feature-specific inspection** | Hole position/diameter, edge angle, flatness, step height, distance between features — plugin architecture | Custom per part; ~1-2 weeks per feature type |

**What you can reliably detect with Mech-Eye NANO ULTRA at 0.6m:**
- Bent parts (1mm+ deformation): Yes, easily
- Wrong size variant (2-5mm difference): Yes, easily
- Missing feature (broken corner, missing tab): Yes
- Wrong orientation/assembly: Yes
- Surface dent (0.5mm+ deep): Yes
- Surface scratch (visible to eye): Yes (RGB)
- Burr or chip (0.2mm+ size): Maybe
- Sub-0.1mm crack: No (need different tech)
- Threading: No (need dedicated thread inspection)
- Sub-50µm dimensional variation: No (beyond camera capability)

**Three reference types supported:**
1. **STEP-based** — STEP file converted to point cloud via Poisson disk sampling, matches scan density (~2-5M points). Pro: always have "perfect" reference. Con: real parts have manufacturing variation.
2. **Golden scan** — confirmed-good part scanned by Mech-Eye, saved as reference. Pro: accounts for normal variation. Con: maintenance burden, lose if damaged.
3. **Statistical** — N (30+) passing inspections aggregated. Pro: self-tuning, captures normal variation. Con: bootstrapping phase needed.

**Workflow examples:**
- **Inspect every picked part before placing:** ~2s added per cycle, worth it for high-value parts
- **Sample inspection (1 in N parts):** ongoing quality monitoring without inspecting every part
- **Dedicated inspection cell:** robot becomes flexible measurement system, multi-view 3D reconstruction per part

---

### Section 262: Quality Inspection Tab — Complete Build

**Built:** Full Quality Inspection capability across multiple layers (UI, backend, ROS2 package, executor integration).

**New tab position:** Between "Part Recognition" and "I/O"

New tab order:
```
Monitor | Program Library | Program | 3D View | Cameras & LiDAR
  | Part Recognition | Quality Inspection | I/O | Safety | Configure
```

**New ROS2 package: inspection_pipeline**

Structure:
```
src/inspection_pipeline/
  inspection_pipeline/
    inspection_node.py
    reference_manager.py
    tier1_dimensional.py
    tier2_surface.py
    tier3_features.py
    icp_alignment.py
    defect_detection.py
    report_generator.py
    statistics_aggregator.py
  launch/inspection.launch.py
  config/default_tolerances.yaml
  config/inspection_node_params.yaml
  msg/ (custom messages for inspection requests/results)
  test/ (synthetic data tests for each tier)
```

**Dependencies:** rclpy, sensor_msgs, std_msgs, geometry_msgs, std_srvs, open3d, numpy, scipy, scikit-image, reportlab (PDF), Pillow, trimesh, matplotlib

**Tier 1 algorithms (tier1_dimensional.py):**
- measure_oriented_bbox(cloud) → {length, width, height, principal_axes}
- measure_overall_dimensions(cloud) → {x_extent, y_extent, z_extent}
- measure_aspect_ratios(dims) → {l_w_ratio, l_h_ratio, w_h_ratio}
- measure_volume(cloud) → {convex_hull_volume, voxel_volume}
- measure_centroid(cloud) → {x, y, z}
- measure_principal_axes(cloud) → {axis1, axis2, axis3, angles}
- compare_to_tolerance(measured, tolerance) → {result, deviation, severity}

**Tier 2 algorithms (tier2_surface.py):**
- load_reference(part_id, reference_type) → open3d.PointCloud
- align_to_reference(measured, reference, initial_transform) → {aligned, transformation, fitness, rmse} — two-stage ICP (FPFH+RANSAC global + ICP refinement)
- compute_deviation_map(aligned, reference) → deviation_array (signed distances per point)
- classify_deviation_severity(deviations, warn_threshold, fail_threshold) → per-point classifications
- compute_deviation_statistics(deviations) → {max, min, mean, rms, std, p95, p99, percent_within_tolerance}
- identify_defect_regions(deviations, classifications, cloud) → list of defects (DBSCAN clusters)
- generate_heatmap_cloud(cloud, deviations) → RGB-encoded point cloud (green→yellow→red interpolation)

**Tier 3 plugin architecture (tier3_features.py):**
FeatureInspector base class with implementations: HolePositionInspector, HoleDiameterInspector, EdgeAngleInspector, FlatnessInspector, StepHeightInspector, DistanceBetweenFeaturesInspector. Registry pattern for runtime addition.

**Dashboard tab layout — 5 sub-tabs:**

1. **Overview** (default):
   - Top stats row: TODAY (inspections count, pass rate, avg deviation, trend), ACTIVE INSPECTION (live status or idle + Start button), ALERTS (last 5 failures)
   - Quick stats grid: per-part pass rates with sparkline trends
   - Recent inspections list (last 10)

2. **History:**
   - Filter bar: search, date range, part filter, result filter, tier filter
   - Sortable table: Timestamp, Part, Result badge, Max Dev, Mean Dev, Tier, Actions
   - Pagination 25/page
   - Click row → details panel

3. **Active:**
   - Only visible when inspection running
   - Live status, progress bar, ETA, current step
   - Live point cloud preview (Three.js)
   - Cancel button with confirmation

4. **Configure:**
   - Left nav: Tolerance Rules | Inspection Plans | References | Report Templates | Feature Inspectors | Retention Policy
   - Tolerance rules table per part with inline edit + bulk CSV import
   - Inspection plans visual builder
   - References: build from STEP / capture golden scan / build statistical reference per part
   - Report template visual editor with logo upload + section toggle
   - Retention selector (30d/90d/1y/indefinite) + storage usage chart

5. **Analytics:**
   - Date range + part selectors
   - Pass Rate Over Time (line chart)
   - Deviation Distribution (histogram with normal overlay + tolerance lines)
   - Defect Type Frequency (bar chart)
   - Process Capability (Cp, Cpk with traffic-light + control chart UCL/LCL)
   - Inspection Volume (stacked bar by result)
   - Export full analytics PDF

**Details panel (slide-in or modal):**
- LEFT 60%: 3D point cloud viewer (Three.js, 500px+ tall), loads heatmap.ply, color modes (Deviation/Original/Reference Overlay), view presets, color scale legend, point size slider, defect markers overlaid clickable
- RIGHT 40%: Result badge, metadata, sortable measurements table (click row → highlights region in 3D), defects list (click → centers 3D on defect), action buttons (Download PDF, Export PLY, Re-run, Mark False Positive, Notes, Compare to Previous)

**PDF report structure (reportlab):**
- Page 1: Cover (logo, title, part, date, overall PASS/FAIL badge, operator, inspection ID)
- Page 2: Summary (plan, reference, totals, pass rate, critical findings)
- Page 3: 3D visualization (multiple viewpoints with deviation heatmap, defects annotated)
- Page 4: Measurements table (Measurement/Reference/Measured/Tolerance/Deviation/Result)
- Page 5: Defects (location indicators, severity, magnitude, suggested action)
- Page 6: Statistical summary (distribution histograms, comparison to history, Cp/Cpk if statistical reference)
- Page 7: Traceability (robot/system IDs, camera serial + calibration date, reference hash + version, software version, full JSON appendix)

**Configurable:** company branding (logo, header, footer), template variants (full/summary/certificate), QR code linking to dashboard record, multi-language framework.

**Storage architecture:**
```
/opt/cobot/inspections/
  config/ (tolerances.json, plans.json, report_templates.json, feature_inspectors.json)
  references/ ({part_id}_step.ply, {part_id}_golden.ply, {part_id}_stat.ply, {part_id}_metadata.json)
  records/{YYYY}/{MM}/{DD}/{timestamp_id}/ (metadata.json, measurements.json, cloud.ply, cloud_rgb.png, heatmap.ply, screenshots, report.pdf, raw_data.npz)
  index.db (SQLite for fast queries)
  stats_cache.json
  audit_log.json
```

**Auto-archive:** records > 90 days compressed, configurable retention.

**Backend endpoints added:** Full CRUD for inspections, references, tolerances, plans, templates. Statistics endpoints with timeframe + part_id filters. WebSocket /ws/inspection for live updates. Export to CSV/PDF/JSON.

**Program wizard integration:**
- New operation type: "Inspect & Verify"
- Wizard pages: part selection → inspection plan → when to inspect (every / sample N / on-demand) → action on fail (reject bin / pause / log only / external alarm) → action on warning → inspection position teach
- New step types in executor: inspect_part, place_at_reject, alert_operator, log_inspection
- Executor branches based on inspection result

**Parts library integration:**
- New "Quality Inspection" section in each part detail view
- Actions: Configure tolerances, Build reference, View inspection history
- On part delete: prompt to archive inspection records
- On STEP update: prompt to rebuild STEP-based reference

**Monitor tab integration:**
- Inline inspection panel below program steps when active
- Live progress, current step, ETA
- Toast notification on completion (pass/fail badge)
- Prominent banner if inspection causes pause/fail with acknowledge/view/resume actions

**Performance targets:**
- Tier 1 inspection: < 2 seconds end-to-end
- Tier 2 inspection: < 5 seconds end-to-end
- Tier 3 inspection: < 10 seconds end-to-end
- PDF generation: < 3 seconds per report
- Dashboard list query (100 records): < 200ms
- Dashboard 3D viewer load: < 1 second
- Statistics aggregation update: < 5 seconds for 1000 records

**Rollout strategy:** All code built in disabled state. UI fully navigable. Backend returns empty/structured data. Inspection pipeline service exists but not started. Banner on tab: "Quality inspection requires Mech-Eye NANO ULTRA camera integration. UI is ready for configuration. Inspection execution will be available once camera is connected." When Mech-Eye integrated → enable systemd service → remove banner → fully operational.

**Systemd service:** roboai-inspection, requires Mech-Eye driver, Restart=always, installed but disabled until camera arrives.

---

### Section 263: LiDAR Motion Detection + 3D Bounding Boxes — Architected

**Question:** Can the LiDAR detect movement and show 3D bounding boxes around parts in the viewer?

**Yes — natural extension of current capabilities.** Combines:
- Existing point cloud streaming (Livox MID-360 at 10 Hz)
- Existing accumulator (15-50k dense points)
- Existing Kalman tracker (scene_graph_node.py)
- New: motion segmentation specifically (which points are moving vs static)
- New: LiDAR-native object detection (camera-based exists; LiDAR was disabled per MD due to 22 spurious clusters)
- New: proper 3D oriented bounding boxes from LiDAR clusters
- New: visualization layer with boxes, labels, motion vectors, trails

**Design decisions (single-question elicitation):**
- **Track all motion** (people, carts, robot arm, anything moving) — not filtered by size
- **Static objects also get bounding boxes** (parts on table, fixtures, walls — not just moving things)
- **Connect motion detection to Safety zones** (slow/stop robot if motion detected in zones)

---

### Section 264: LiDAR Perception — Complete Build

**Built:** Production-grade LiDAR motion detection + 3D bounding box + safety integration.

**New ROS2 package: lidar_perception**

Structure:
```
src/lidar_perception/
  lidar_perception/
    lidar_perception_node.py     (main, 11-stage pipeline)
    motion_detector.py           (frame-to-frame motion analysis)
    ground_segmentation.py       (RANSAC plane fitting)
    object_clusterer.py          (DBSCAN)
    bbox_computer.py             (oriented bounding boxes)
    object_tracker.py            (multi-object tracking with IDs)
    safety_zone_manager.py       (zone definitions and triggers)
  launch/lidar_perception.launch.py
  config/default_params.yaml
  config/default_zones.yaml
  msg/ (DetectedObject, DetectedObjectArray, SafetyZone, SafetyEvent)
  test/ (test_motion, test_clustering, test_tracking, test_safety_zones, test_bbox)
```

**Custom messages:**

DetectedObject.msg:
```
std_msgs/Header header
int32 id                          # persistent track ID
geometry_msgs/Point center        # OBB centroid in base_link
geometry_msgs/Vector3 dimensions  # L, W, H
geometry_msgs/Quaternion orientation
geometry_msgs/Vector3 velocity
float32 speed
string motion_state               # 'static' | 'slow' | 'fast'
string classification             # 'unknown' | 'person' | 'cart' | 'robot_arm_self' | 'small_object' | 'large_object'
float32 classification_confidence
int32 point_count
float32 cluster_density
float32 stable_duration_s
string safety_zone                # 'none' | 'green' | 'yellow' | 'red'
```

DetectedObjectArray.msg: header + objects[] + total_count + moving_count + static_count

SafetyZone.msg: name + color + radius_from_robot_base + height_min/max + motion_response + slow_to_pct + active

SafetyEvent.msg: header + event_type + zone_name + triggering_object + action_taken + speed_before_pct + speed_after_pct

**11-stage pipeline at 10 Hz:**

1. **Preprocessing** — transform cloud to base_link, crop to workspace (±5m XY, 0-3m Z)
2. **Ground segmentation** — RANSAC plane fitting, remove ground points
3. **Robot self-filtering** — URDF-based (when available) or fixed cylinder fallback (1.5m radius) to prevent robot arm being detected as moving
4. **Motion detection** — rolling 5-frame buffer, voxelize at 5cm, points in newly-occupied voxels = moving, consistently-occupied = static, per-point motion confidence smoothed across frames
5. **Clustering (DBSCAN)** — eps=0.15m, min_samples=10, separate clustering for moving vs static, reject clusters <0.05m³ or >5m³, density score per cluster
6. **Bounding box computation** — PCA on cluster, yaw-only rotation (top-down OBB preferred for picking), 2D minimum-area rectangle from convex hull projection, Z from min/max
7. **Tracking** — Hungarian assignment, lifecycle (NEW → CONFIRMED at 3+ frames → LOST at 10 frames missing → DEAD at 30 frames missing), linear motion prediction
8. **Motion classification** — static <0.05 m/s for 0.5s+, slow 0.05-0.5 m/s, fast >0.5 m/s, 3-frame smoothing before state changes
9. **Object classification** (heuristic, no ML):
   - person: 0.3-1.0m wide, 1.4-2.2m tall, moving
   - cart: 0.4-1.5m wide, 0.8-1.5m tall, moving or recently moving
   - robot_arm_self: failed self-filter (warn in logs)
   - small_object: <0.2m max dim, typically static (parts on table)
   - large_object: >1.0m, static (fixtures, walls)
   - unknown: doesn't match other categories
10. **Safety zone evaluation** — distance from robot base → smallest containing zone → emit SafetyEvent if moving object enters yellow/red, any object enters red, or speed exceeds threshold
11. **Publish** — DetectedObjectArray + SafetyEvent + RViz markers + WebSocket to dashboard

**Safety zones (default):**
- GREEN: 0 to 2.0m radius — full speed
- YELLOW: 2.0 to 3.5m radius — reduce to 30% (configurable)
- RED: outside YELLOW — pause robot

**Safety responses (4 actions):**
- **none**: log only, no robot action
- **slow_to_pct**: scale robot speed immediately
- **pause**: program paused, robot decelerates and holds, requires operator clear
- **stop**: emergency stop, aggressive deceleration, requires full reset

**Hysteresis:** Zone entry immediate, zone exit requires 0.5s confirmation before lifting restriction (prevents flickering).

**Executor integration:** Subscribes to /lidar_perception/safety_events, on event applies action via estun_driver speed scaling / executor pause / E-stop. Resume logic: auto-resume on zone clear (configurable), pause requires operator acknowledge, stop requires full reset.

**Dashboard 3D View modifications:**
- WebSocket /ws/detected_objects subscribes
- Per-object render: wireframe box (12 line segments, colored by motion state — grey static / amber slow / red fast — overridden by zone color when in yellow/red), label above (ID + classification + speed, billboard always facing camera), motion vector arrow for moving objects (length proportional to speed), optional trail (last 10 positions fading)
- Viewer control panel: toggles for Boxes/Labels/Vectors/Trails/Static/Moving/Safety Zones/Point Cloud
- Filter: classification dropdown + motion filter
- Statistics overlay bottom-left: total / moving / people / in zones
- Safety zones rendered as transparent cylinders (green tint with grid pattern on ground, amber wall for yellow, red wall for red, boundary highlighted on entry)

**Monitor tab — Environmental Awareness card:**
- ENVIRONMENT title with radar icon
- Left: object counts (N moving, M static, P people)
- Right: zone status circle (ALL CLEAR green / CAUTION amber with object in yellow / STOPPED red with object in red)
- Bottom: last safety event timestamp + mini bar chart of zone violations over last hour

**Safety tab (was placeholder, now built out):**

Left navigation: Zones | Events | Configuration | Statistics

**Zones section:**
- 2D top-down map view (robot at center, zone boundaries as colored rings, detected objects as dots, click zone to edit)
- Zone table: Name, Color, Type, Radius/Polygon, Height range, Motion response, Active, Actions
- Add Zone wizard: shape (cylinder/polygon) → geometry (radius+height or draw polygon) → motion response → speed % → name/color

**Events section:**
- Filterable table: Timestamp, Event type, Zone, Object class, Speed, Action taken, Acknowledged
- Click row → details modal with point cloud snapshot
- Export CSV/PDF

**Configuration section:**
- Detection parameters: voxel size (default 5cm), cluster min points (10), cluster min/max volume (0.05/5.0 m³), tracker confirmation (3 frames) / death (30 frames)
- Motion thresholds: static <0.05 m/s, slow <0.5 m/s, fast safety event >1.5 m/s
- Self-filter: method (URDF/fixed cylinder), radius (1.5m), buffer margin (10cm)
- Safety hysteresis: exit confirmation (0.5s), auto-resume toggle, require manual acknowledge after pause (ON), require manual reset after stop (ON)

**Statistics section:**
- Safety events per day (last 30 days)
- Zone violations by zone (bar)
- Detection counts by classification (pie)
- Average objects per hour (heatmap by time of day)

**Backend endpoints added:**
- /api/perception/objects (current snapshot)
- /api/perception/objects/{id} (track history)
- /api/safety/zones (CRUD)
- /api/safety/events (filtered list + details + acknowledge)
- /api/safety/config (read + hot-reload update)
- /api/safety/test_zone (test what would happen if object at position)
- /api/safety/statistics (aggregated for charts)
- /api/safety/reset (clear active triggers, requires confirmation token)
- WebSocket /ws/detected_objects (10 Hz updates)
- WebSocket /ws/safety_events (real-time events)

**Storage:**
```
/opt/cobot/safety/
  config/zones.yaml, detection_params.yaml
  events/{YYYY}/{MM}/{DD}/{timestamp_id}/ (event.json, cloud_snapshot.ply, objects.json)
  index.db (SQLite)
  stats_cache.json
```

**Performance targets (Jetson Orin, 10 Hz processing):**
- Preprocessing: <5ms, Ground seg: <10ms, Self-filter: <5ms
- Motion detection: <15ms, Clustering: <25ms, BBox: <5ms
- Tracking: <10ms, Classification: <5ms, Zone eval: <5ms, Publish: <5ms
- Buffer: 10ms → end-to-end <100ms target
- CPU <30% of one core, memory <500MB resident

**Reuse strategy:**
- Use existing Kalman tracker in scene_graph_node.py (invoke or extract to shared module)
- Use existing accumulator output /lidar/points_dense
- Use existing Three.js viewer infrastructure (add bounding box layer, don't rebuild)
- Use existing WebSocket pattern matching /ws/state etc.
- Use existing executor speed scaling

**Error handling:**
- LiDAR connection loss: detect missing data after 1s, publish empty array, log warning, retry, notify dashboard
- Configuration errors: validate at load, reject invalid, warn on conflicting zones (use most restrictive), use defaults if missing
- Tracking failures: ID collision → new ID + log, Hungarian solver failure → fallback to nearest-neighbor
- False positive mitigation: ignore list, operator right-click "Always ignore similar" → adds filter rule

**Rollout strategy (3 stages):**
1. **This build:** code complete, package compiles, service installed but NOT auto-started, default zones configured with safety actions set to 'log only'
2. **Operator validation:** operator starts service manually, observes detection accuracy + false positives, tunes parameters via Configure tab, verifies no false safety triggers in normal operation
3. **Enable actions:** operator enables actual safety responses, system goes live with motion-aware safety

This staged approach prevents the service from immediately stopping the robot due to untuned parameters on first activation.

**Systemd service:** roboai-lidar-perception, requires roboai-lidar + roboai-accumulator, Restart=always, enabled but not auto-started.

---

### Updated Dashboard Tabs (June 10, 2026)

```
Monitor | Program Library | Program | 3D View | Cameras & LiDAR
  | Part Recognition | Quality Inspection | I/O | Safety | Configure
```

| Tab | Status (June 10) | Notes |
|-----|-----------------|-------|
| Monitor | ✅ Updated | Change Program button added, target part viewer relocated to top, I/O row + Recent Events + Program Steps removed, Environmental Awareness card added |
| Program Library | ✅ Active | Block/card grid |
| Program | ✅ Updated | Palletize+Depalletize wizard built, gripper field cleanup, parts-finding simplified, expand button overlap fix, teach pendant fullscreen, jog buttons enlarged, header buttons renamed, fullscreen teach overlay, step row alignment, detect step dropdown, custom gripper with STEP upload |
| 3D View | ✅ Updated | Bounding box overlay added, viewer control panel, safety zones rendered |
| Cameras & LiDAR | ✅ Active | Cam 0, Cam 1, LiDAR with expand/collapse |
| Part Recognition | ✅ Active | STEP upload, 3D viewer, face-click pick direction, orientation teach wizard, Quality Inspection section added per part |
| **Quality Inspection** | ✅ **New** | Overview / History / Active / Configure / Analytics sub-tabs. Disabled-state banner until Mech-Eye integrated. |
| I/O | ✅ Active | 16 DI, 16 DO, 4 AI, 2 AO with editable labels |
| Safety | ✅ **Built out** | Zones / Events / Configuration / Statistics sub-tabs. Disabled-state until lidar_perception service activated. |
| Configure | ✅ Active | System settings |

---

### Updated Systemd Services (June 10, 2026)

| Service | Status | What it runs |
|---------|--------|-------------|
| roboai-estun | ✅ Ready | Estun WebSocket driver (waiting on robot arrival) |
| roboai-executor | ✅ Active | Program executor with palletize/depalletize/inspection/safety hooks |
| roboai-cameras | ✅ Active | Both D435i cameras |
| roboai-lidar | ✅ Active | Livox MID-360 |
| roboai-accumulator | ✅ Active | Point cloud accumulator |
| roboai-reconstruction | ✅ Active | CPU TSDF mesh |
| roboai-depth-segment | ✅ Active | Depth segmentation + OBB + part recognition |
| roboai-fusion | ✅ Active | LiDAR point cloud fusion |
| roboai-stereo | ✅ Active | Camera cross-verification |
| roboai-scene-graph | ✅ Active | Kalman tracker (now shared with lidar_perception) |
| roboai-grasp | ✅ Active | Grasp pose generation |
| roboai-tf | ✅ Active | Static TF publisher |
| roboai-dashboard | ✅ Active | Production server :8080 |
| roboai-nvblox | ✅ Active | GPU mesh |
| roboai-auto-program | ✅ Active | LLM task generation |
| **roboai-inspection** | ⚙️ **Installed, disabled** | Inspection pipeline (Tier 1/2/3) — waiting on Mech-Eye |
| **roboai-lidar-perception** | ⚙️ **Installed, disabled** | Motion + BBox + Safety — staged rollout, operator must enable |

Total: 15 active + 2 staged-disabled services.

---

### Key Decisions Made June 10, 2026

- **Palletize + Depalletize combined as one operation** with mode toggle on page 1b (not separate operations)
- **Pallet positions computed at runtime** by executor using config (not baked into steps at save time) — chose Option 1 (modify estun_driver) over baking absolute TCPs
- **Camera Detection from library + Fixed Position only** for parts-finding (removed standalone Camera Auto)
- **Custom Gripper replaces Magnetic** — supports STEP upload for 3D visualization
- **Mech-Eye NANO ULTRA-GL selected** over Zivid 2+ M60 — 2x resolution + wrist-mount form factor + price won over Zivid's working range advantage
- **D435is stay** — different jobs (continuous scene context, scan & identify, parts teaching, monitoring)
- **Livox stays for room awareness** — its actual job; Mech-Eye does precision picking
- **Ring light skipped for Mech-Eye** — self-illuminated, was a D435i workaround
- **No MotionCam alternative pursued** — Photoneo's PSL patent moat means real alternatives don't exist; if continuous motion ever needed, buy real MotionCam
- **Quality Inspection built as tier-1/2/3 framework** — STEP-based + golden scan + statistical references all supported
- **LiDAR motion detection wired to Safety zones** — visualization + safety integration, not just visualization
- **All new services installed disabled** — staged rollout prevents immediate robot stops or hardware-blocked failures
- **DH parameters OR URDF acceptable from Estun** — both work, take whatever provided
- **Fullscreen overlay pattern for teaching** — replaced small banners with full-viewport experience for tablet operation

---

### Key Bugs Fixed June 10, 2026

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Single-prompt outputting as split blocks | Nested code fences (``` inside ```) | Replace all inner code fences with indented plain text |
| Expand button overlap on Program tab panels | Inconsistent absolute positioning | Position: absolute top:8px right:8px z-index:10 + parent overflow:hidden + content padding-top 44px+ |
| Jog buttons too small/clustered | Sizes too conservative + clustering instead of filling space | Increase normal to 96×96, fullscreen to 140×140, use justify-content space-evenly with flex container |
| Step titles misaligned horizontally | Missing left padding on middle section + no width:100% on title | Three-column strict layout with middle column flex:1 + padding-left:16px + title width:100% margin:0 |
| Position data cluttering step list | All numeric data always visible | Toggle behind "▸ View position data" link with monospace expanded block |
| Teaching banner too small to use on tablet | Original was a small blue box at top of step list | Replaced with full-viewport overlay (dark header + instruction band + fullscreen jog + large 72px RECORD POSITION button) |
| Detect step library-part button unclear | Was a button labeled "Detect Library Parts" | Replaced with section title + dropdown populated from /api/parts, defaults to "Any library part" |

---

### Hardware Items Pending (Updated June 10, 2026)

| Item | Status | Notes |
|------|--------|-------|
| Estun S10-140 ECO | Ordered, awaiting arrival | Subnet conflict resolution plan in Section 246 |
| Mech-Eye NANO ULTRA-GL | Decision made, not yet ordered | Pre-purchase questions in Section 258 |
| 24V DC power supply (3.75A) for Mech-Eye | Pending | ~$50 |
| Gigabit Ethernet flex-rated cable | Pending | ~$60, 3-5m through wrist |
| Wrist mount adapter | Pending | $100-300 machined or 3D printed |
| AprilTag calibration board | Pending | ~$30, mandatory for hand-eye calibration |
| Gripper selection | Pending | Custom Gripper wizard supports STEP upload when ready |
| URDF from Estun OR DH parameter table | Requested | Either works; manual STEP-split in FreeCAD is fallback (Section 247) |
| Estun URDF for MoveIt2 collision avoidance | Blocking MoveIt2 full integration | Direct motion still works without it |
| Ring light | **CANCELLED** | Was D435i workaround, Mech-Eye is self-illuminated (Section 260) |

---

*Last updated: June 10, 2026*
*Covers sessions 234-264: Palletize+Depalletize wizard combined build, executor runtime grid math via Option 1 (modify estun_driver), gripper field cleanup (width/force removed, page collapsed when empty), parts-finding source simplification (Camera Detection + Fixed Position only), expand button overlap fix across three Program tab panels, teach pendant fullscreen capability matching other panels, jog button enlargement to 96/140px in normal/fullscreen views with space-evenly layout, "+ Blank" → "New Program" and "Wizard" → "New Program Wizard" rename, Custom Gripper replaces Magnetic with STEP upload + 3D viewer + I/O assignment (reuses step_parser.py and existing Three.js component), Monitor tab redesign with Change Program button + target part viewer relocated to top section + conditional rendering when target_part exists with GLB, Monitor I/O row + Recent Events + Program Steps removed entirely, consolidated teach sequence then upgraded to fullscreen overlay (dark header + instruction band + fullscreen jog 140×140 + 72px green RECORD POSITION button + thin progress bar), Estun ECO day-one checklist (subnet conflict resolution 3 options, driver config update, connection test, jog verification, first run at 15%), ECO vs Pro impact analysis (no torque sensors, motor-current-only collision detection, external Bota SensONE for force-controlled tasks later), URDF/DH parameters discussion (XML format explanation, three paths: ask Estun, build from STEP in FreeCAD, use UR5e proxy, DH table sufficient if URDF unavailable), step row text alignment fixes (three-column strict layout, padding-left on middle, title 17px weight 500), position data hidden behind toggle, detect step dropdown for library part selection, 3D camera market deep dive (Photoneo alternatives surveyed at $1-5k industrial tier, Mech-Eye full lineup comparison with UHP/NANO/NANO ULTRA/PRO S/PRO M/LSR/DEEP, wrist-mount changes calculation, D435i vs NANO ULTRA side-by-side, NANO ULTRA vs Photoneo PhoXi M comparable class, Zivid 2+ M60 vs NANO ULTRA direct peer comparison, Chinese alternatives RVBUST/Percipio/Hikvision/Solomon/Orbbec, MotionCam alternatives don't truly exist due to PSL patent moat through 2035-2037), Mech-Eye NANO ULTRA-GL selected with rationale (resolution + form factor + price + wrist-mount priority), architecture confirmed (Livox room awareness + D435i scene context + Mech-Eye precision picking), hardware budget ~$4,750-5,000 landed, integration roadmap 4 phases ~1.5-2 weeks, ring light cancelled (was D435i workaround, Mech-Eye self-illuminated), Quality Inspection capability architected (three-tier model: Tier 1 dimensional + Tier 2 surface deviation with ICP heatmap + Tier 3 feature-specific plugin), Quality Inspection complete build (new ROS2 package inspection_pipeline with Open3D + reportlab + scipy + sklearn, new dashboard tab Quality Inspection between Part Recognition and I/O with 5 sub-tabs Overview/History/Active/Configure/Analytics, three reference types STEP+golden+statistical, defect detection via DBSCAN clustering, PDF report generation with cover/summary/3D/measurements/defects/statistics/traceability pages, storage architecture with SQLite index + per-record directory + auto-archive, program wizard "Inspect & Verify" operation, executor branches on result, parts library integration, monitor inline panel, performance targets), LiDAR motion detection + 3D bounding boxes architected (motion segmentation + clustering + tracking + visualization + safety integration), LiDAR perception complete build (new ROS2 package lidar_perception with 11-stage pipeline at 10 Hz: preprocessing → ground seg → self-filter → motion detection → DBSCAN clustering → OBB computation → tracking → motion classification → object classification → safety zone eval → publish, custom messages DetectedObject/Array/SafetyZone/SafetyEvent, three default safety zones green/yellow/red with configurable responses, executor speed scaling integration with hysteresis, dashboard 3D View bounding box overlay with motion vectors and trails, viewer control panel toggles, Monitor Environmental Awareness card, Safety tab full build-out with Zones/Events/Configuration/Statistics sub-tabs, 2D top-down workspace map for zone editing, backend endpoints CRUD + WebSocket streaming, storage with per-event point cloud snapshots, staged rollout three stages preventing accidental robot stops on first activation), 17 sessions total covering wizard build, camera selection, quality inspection architecture, and LiDAR perception/safety integration.

---

## June 11, 2026 — Session Log

### Motion Optimization, LiDAR Object Identification, Camera Pricing Reality, and the Vision Recognition Debugging Saga

**Last Updated**: June 11, 2026
**Covers**: Teach pendant fullscreen jog expansion, removal of motion/speed controls from wizard, RealSense D435i issue catalog, motion path optimization tooling (TOPP-RA + MoveIt2 skeleton), placement design for motion controls, removal of motion balancing toggles from all UI, LiDAR dense point cloud + object identification build (nvblox fix + accumulator upgrade + parts-library matching), Estun controller readiness assessment, AprilTag explanation and sizing, Mech-Eye pricing shock ($16K reality vs assumed $4.5K), MotionCam Color evaluation, comprehensive 3D camera reconsideration, NVIDIA recognition stack discussion, and an extended multi-hour vision recognition debugging session that traced a misidentification bug to its true root cause (orphaned teach data + broken loader) through actual log analysis after multiple failed theory-driven fixes.

---

### Section 265: Teach Pendant Fullscreen Jog Expansion

**Change:** During the teaching wizard, the jog menu expands to fill the whole screen.

- Jog controls container fills entire area between instruction band and footer (width 100%, height 100%, flex column, centered, padding 24px, dark #0A0A0B background)
- isFullscreen={true} passed to JogControls for large button sizes (140×140px arrows, 60px SVG)
- Internal layout: control groups use flex:1 to spread across full width, justify-content space-evenly
- Responsive: >1400px screens scale buttons up to 160×160px / 72px arrows / 78px action buttons; <1100px stays at 140×140
- Vertical distribution: mode toggle + speed slider fixed, main control area flex:1, action buttons fixed
- Touch targets minimum 44px maintained

---

### Section 266: Remove Motion Control + Speed Selection from Wizard

**Change:** Removed the Speed page and Motion Profile page from the Program Wizard.

**Decision:** Use default speed (60% Medium) and default Balanced motion profile silently.

- Speed page removed (Slow 40% / Medium 60% / Fast 80% / custom slider)
- Motion Profile page removed (Conservative / Balanced / Aggressive / Custom cards)
- Silent defaults baked at save time: speed_pct=60, motion_profile_name="Balanced"
- Applied to all operation types
- Forward/backward navigation skips both pages, page counter reduced by 2
- Review page no longer shows speed/motion profile
- Program config schema unchanged (fields still present, populated with defaults)
- Executor logic unchanged (still reads speed_pct and motion_profile_name)
- Configure tab Motion section and Program tab motion card remained (at this point)

---

### Section 267: RealSense D435i Issue Catalog

**Comprehensive list of D435i problems — documented in project + general known issues:**

**Project-documented issues:**
1. Depth on shiny aluminium — IR speckle scatters unpredictably, depth holes, moving hotspots (the #1 problem, ~25-30% detection accuracy on BT225 brackets)
2. Lighting sensitivity — shadows shift through day, re-teach needed when lighting changes
3. OBB dimensions ±30% inaccurate — why size gate needs wide tolerance
4. Camera-LiDAR alignment failure — camera point clouds removed from 3D view (Section 47), 6+ failed approaches
5. Half-resolution optimization disaster — broke cam0 detection entirely (Section 152-153), full revert required
6. Multi-camera IR interference — two D435i projectors interfere
7. Cable/USB issues — >3m cables drop USB 3.0, random disconnects
8. Sparse depth — ~50-100 points per 4cm bracket (drove Mech-Eye decision)
9. Distance limits — 0.1m minimum, accuracy degrades past 3m
10. Detection drops unpredictably — small parameter changes break detection

**General known issues:**
11. Black/dark surface absorption (IR absorbed)
12. Specular/glossy surface failure (mirror finishes blind it)
13. Translucent material problems (sees through glass/clear plastic)
14. Outdoor/sunlight failure (IR overwhelmed)
15. Edge artifacts / flying pixels
16. Calibration drift with temperature
17. Firmware update regressions
18. RGB-depth misalignment (parallax)
19. Limited dynamic range (no depth HDR)
20. Frame rate vs resolution USB bandwidth tradeoffs

**Conclusion:** D435i issues are physical limitations, not code bugs. Right tool for general scene awareness, continuous monitoring, person detection, wide-angle context. Wrong tool for sub-mm accuracy, similar-part discrimination, orientation on shiny metal, production bin picking. Keep for what it's good at; dedicated structured-light sensor for the rest.

---

### Section 268: Motion Path Optimization Tooling — Architected and Built

**Question:** Have we implemented any motion path optimization tools?

**Finding:** Grasp pose generation exists (pre-grasp/grasp/retreat 3-pose), MoveIt2 framework architected but not configured (waiting on URDF), speed scaling wired. But NO trajectory smoothing, path optimization, velocity profiling, or cycle-time optimization.

**Three tiers identified:**
- Tier 1: TOPP-RA trajectory smoothing (works without URDF, ~15-30% cycle time gain)
- Tier 2: MoveIt2 + OMPL + CHOMP/STOMP collision-aware planning (needs URDF)
- Tier 3: TSP-style waypoint ordering for palletize (marginal, snake already near-optimal)

**Placement decision (where motion controls go in UI):**
- Configure tab → new Motion section: system-wide limits, profiles, MoveIt2 status (set-once values)
- Program Wizard → Motion Profile page: per-program tuning (Conservative/Balanced/Aggressive/Custom)
- Monitor tab → motion profile badge with cycle-time savings
- NOT in Safety tab (different concern), NOT per-step (too granular), NOT separate top-level tab

**Built: new ROS2 package motion_optimization**
- toppra_engine.py (TOPP-RA time-optimal parameterization)
- trajectory_smoother.py (spline, blend radius, jerk limiting)
- moveit_bridge.py (skeleton, returns fallback until URDF arrives)
- profile_manager.py (Conservative/Balanced/Aggressive presets + custom)
- kinematics_helper.py, collision_checker.py
- Custom msgs: MotionProfile, OptimizedTrajectory, MotionStatistics
- Custom srvs: OptimizeTrajectory, EstimateCycleTime, ValidateMotion
- Executor middleware: calls /motion/optimize_trajectory before sending to driver, 200ms timeout fallback to raw
- Configure tab Motion section, Program Wizard Motion Profile page, Program tab motion card, Monitor badge, 3D View trajectory overlay
- Default robot limits: Estun S10-140 ECO conservative (180°/s vel, 400°/s² accel, 4000°/s³ jerk)
- systemd roboai-motion-optimization, auto-starts (safe — optimization opt-in per program, graceful fallback)

---

### Section 269: Remove Motion Balancing Toggles from All UI

**Change:** Removed all motion optimization / profile toggles from the visible interface.

- Program tab motion profile card removed
- Monitor tab motion profile badge removed
- 3D View trajectory toggle + velocity overlay removed (other 3D toggles kept)
- Configure tab Motion section removed entirely (other Configure sections intact)

**Kept under the hood (backend, not UI):**
- motion_optimization ROS2 package and node keep running
- Executor middleware still calls /motion/optimize_trajectory
- TOPP-RA runs silently with Balanced profile default
- speed_pct and motion_profile_name remain in config (defaults)
- /api/motion/* endpoints remain (unused by UI)
- roboai-motion-optimization service keeps running

Motion optimization works under the hood with sensible defaults; no operator-facing motion tuning controls anywhere.

---

### Section 270: LiDAR Dense Point Cloud + Object Identification — Architected and Built

**Goal:** LiDAR generates a more detailed point cloud and identifies objects around it.

**Design decisions:**
- Track ALL motion (people, carts, robot arm, anything)
- Static objects ALSO get bounding boxes (not just moving)
- Connect motion detection to Safety zones (slow/stop robot)
- Fix broken nvblox mesh first (790 verts → target 50k+)
- LiDAR identifies parts by matching against parts library (STEP dimensions/shapes)
- KEEP LiDAR-only fusion (do NOT reintegrate camera depth — Section 47 stays)

**Built three integrated parts:**

PART A — nvblox fix:
- Diagnostic steps (check topics, QoS, TF tree, params)
- Configure for Livox LiDAR-only mode: use_lidar true, voxel 0.02, max_integration 5m, mesh rate 5Hz, proper FoV (6.28 horizontal, 1.05 vertical for MID-360)
- Fix QoS (BEST_EFFORT depth 10), TF tree completeness
- Target >30k vertices, ideally 50k-100k

PART B — accumulator upgrade for density:
- Near zone (≤1m): 60 frames @ 3mm voxel → 80-150k points (up from 15 frames @ 5mm)
- Mid zone (1-2m): 30 frames @ 1cm (new zone)
- Far zone (>2m): 10 frames @ 3cm
- Adaptive accumulation, voxel persistence noise suppression (keep voxel if in ≥3 of last 10 frames)
- New /lidar/points_filtered (noise-suppressed) + /lidar/density_stats
- Target 105-205k points total (vs 35-60k)

PART C — new ROS2 package lidar_object_identifier:
- 7-stage pipeline at 5Hz: preprocess → ground extract → workspace mask → Euclidean clustering → shape analysis → parts matching → persistence tracking
- Shape features: OBB, volume (convex hull + voxel), surface area, sphericity, flatness, elongation, compactness
- Parts matching: size pre-filter → volume → shape descriptors → multi-criteria confidence
- Multi-frame persistence (5+ consecutive confirmations) — structurally prevents the "22 spurious clusters" problem from previous attempt
- Custom msgs: IdentifiedObject, IdentifiedObjectArray, ObjectIdentificationStats
- Pre-computed STEP features cached, refreshed on parts library change
- Dashboard: 3D View identified-objects overlay, workspace mask configurator (Configure tab), Monitor identified objects card, Part Recognition LiDAR detection stats per part
- Coordinates with lidar_perception (motion/safety, separate) and depth_segment (camera, separate) without conflict — feeds scene_graph for unified multi-sensor tracking
- systemd roboai-lidar-identifier, auto-starts (read-only, doesn't control robot)

---

### Section 271: Estun Controller Readiness Assessment

**Question:** Is the controller ready to control the Estun robot when it arrives?

**Answer:** Yes, software is ready. Remaining items are physical/network tasks + a few software gaps.

**Complete and waiting:** Estun ROS2 driver, program executor, dashboard wired, connection test script, palletize/depalletize, quality inspection (disabled), lidar perception (disabled), motion optimization, all 17 systemd services.

**Arrival-day mandatory (90 min):** subnet conflict resolution, driver IP config, connection test, joint direction verification, teach home + first run at 15%, calibration prep.

**Prep work to do NOW (before arrival):**
1. Order AprilTag calibration board (~$30) — or print via scripts/generate_apriltag.py
2. Request from Estun: URDF/xacro, DH parameters, joint vel/accel/jerk limits, shipping firmware version, drag/freedrive API confirmation, torque-via-WebSocket confirmation
3. Decide + order gripper (1-3 week lead time)
4. Order Mech-Eye/camera (2-4 week lead, may exceed robot lead)
5. Design wrist mount adapter
6. Pre-populate parts library
7. Document shop floor obstacles for MoveIt2 collision scene

**Risk factors:** URDF availability critical (FreeCAD plan B), Pro SDK situation unclear, firmware version unknown (driver built against CodroidApi 41-page manual), gripper-robot timeline gap, mount adapter readiness.

---

### Section 272: AprilTag Explanation and Sizing

**What it is:** Printable visual fiducial marker (black-bordered square with unique ID pattern), like a robust QR code for robotics. Camera determines tag's 3D position + orientation to <0.5mm at working distance.

**Purpose for project:** Hand-eye calibration — finds exact camera-to-robot transform. Without it, cameras and robot disagree on where things are, picks fail.

**Procedure:** Mount tag visible to cameras, move robot to 15-20 poses, solve transform from (camera detection, robot pose) pairs. For wrist-mounted Mech-Eye: tag stays fixed, robot moves camera, finds camera-to-tool0 transform.

**Sizing decision: 100mm tag (tag36h11 family).**
- Works for all cameras: D435i at 0.5-1.5m, Mech-Eye at 0.3-0.8m
- 100mm = the black square only; total printed area ~140-160mm with white border
- Mount on rigid 200mm board (foam board / aluminium / plexiglass)
- Get pre-laminated (~$15-30) or print via scripts/generate_apriltag.py
- Order this week alongside camera and mount hardware

---

### Section 273: Mech-Eye Pricing Shock — $16K Reality

**MAJOR data point:** User talked to Mech-Eye directly — their price is $16K for the NANO (not the ~$4,500 previously assumed).

**This completely upends the camera recommendation.** At $16K, Mech-Eye NANO is no longer the "cheaper Chinese alternative" — it's MORE expensive than Zivid 2+ M60 (~$5,500) and competes directly with Photoneo.

**Corrected comparison:**

| Camera | Realistic price | Notes |
|--------|----------------|-------|
| Zivid 2+ M60 | ~$5,500 | NOW the price/value winner |
| Mech-Eye NANO-GL | ~$16,000 | Premium pricing, possibly bundled with Mech-Vision software |
| Photoneo PhoXi Color XS | ~$8-10K | Genuine Photoneo, less than Mech-Eye |
| RVBUST RVC X Pro | ~$4,500 | Chinese alternative, limited Western support |

**Revised recommendation:** Zivid 2+ M60 if direct quote is $5-7K (now wins on price, ecosystem, working range, materials). Get hard quotes from Mech-Eye (confirm camera-only vs software bundle), Zivid, and Photoneo before committing. Push back on the $16K Mech-Eye quote — ask for camera-only price, volume/startup pricing, hardware-only eval unit.

---

### Section 274: MotionCam Color 3D Evaluation

**Considered:** Photoneo MotionCam-3D Color M+ (~$18-22K) — flagship combining Parallel Structured Light (motion-tolerant) + co-aligned color RGB.

**Specs:** 366-1473mm range, 0.5mm @ 1m, 1680×1200 (2M pts), 20 FPS continuous motion capture, 65-130ms capture, 1.5kg, 660mm long, red laser Class 2.

**Verdict for project:**
- Wrist-mount dealbreaker: 660mm long, 1.5kg — designed for fixed overhead, not eye-in-hand
- Continuous motion capture not needed (cobot pick cycles include natural pauses)
- For bin picking on aluminium: NANO ULTRA / Zivid match it at typical bin distances
- Would force architecture change to fixed overhead
- Only worth it for high-throughput production (<2s cycle) or premium customer positioning
- Recommendation: don't pursue now; if continuous motion ever genuinely needed, buy real MotionCam at that point

---

### Section 275: NVIDIA Recognition Stack Discussion

**Question:** Can we use NVIDIA's part recognition stack?

**Answer:** Yes — and it's a better instinct than NCC+histogram. You're already on the hardware (Jetson Orin + Isaac ROS).

**NVIDIA offerings:**
- FoundationPose — 6DoF pose from RGB-D + CAD, model-based, no per-part training (already evaluated Sections 229+)
- Isaac ROS / Isaac Manipulator — full perception-to-motion stack (already on Isaac ROS Humble)
- DOPE — older CNN pose (superseded by FoundationPose)
- Isaac ROS nvblox — already running
- Isaac ROS object detection (DetectNet) — 2D detection/segmentation
- cuMotion / cuRobo — GPU motion planning
- Isaac Sim / Replicator — synthetic data from CAD to train detectors

**The catch:** FoundationPose IS the commercial-grade method, runs on the Jetson, already touched in eval. But documented problems: (1) volume bias (larger meshes win, silhouette-normalization fix deferred), (2) needs DENSE input depth — marginal on sparse D435i data.

**Honest conclusion:** NVIDIA's stack (FoundationPose + Isaac ROS) IS the commercial recognition path, not NCC+histogram. The missing piece isn't software (NVIDIA provides it, already started) — it's dense input data (Mech-Eye/Zivid). FoundationPose on D435i = marginal; on dense cloud = excellent. Two-stage commercial design: lightweight detector/CNN (trained on synthetic data via Isaac Replicator from CAD) for identity + FoundationPose for pose.

**Commercial reliability assessment:** NCC+histogram is NOT commercial-robust — fragile to rotation, lighting, occlusion, clutter, similar parts; no confidence calibration. Fine for prototype/distinct parts only. Commercial path = dense-3D sensor + 6DoF pose estimation (what all serious bin-picking vendors use).

---

### Section 276: The Vision Recognition Debugging Saga — Root Cause Found Through Logs

**THE central event of the session. A multi-hour debugging effort that traced a persistent misidentification bug to its true cause, after multiple failed theory-driven fixes.**

**Symptom:** A white delrin part (taught with camera images, pickable + non-pickable orientations) was being identified as BT225L24_a — an aluminium bracket that has only an uploaded STEP file and NO taught camera images. Visually completely different (white plastic with 3 holes vs metallic bracket).

**User's key observation:** "The part recognition hasn't been the same since the 5th of June." Recognition worked well June 5, then increasingly degraded.

**FAILED THEORY-DRIVEN FIXES (the anti-pattern):**
Multiple elaborate prompts were written WITHOUT reading the actual running code or logs:
1. "It's the scoring weights" — wrote a weight-rebalance fix. No change.
2. "It's the two-path STEP vs image-only split" — built that. No change.
3. "It's the STEP-only confidence penalty" — built that. No change.
4. "It's the STEP-feature extraction architecture" — designed full feature-detection system. No change.
5. Weight changes (NCC 0.70/0.30 → 0.55/0.30/0.15 → 0.40/0.15/0.45). Label remained byte-for-byte identical.

**The identical-output-every-time pattern was the real clue:** when a fix produces ZERO change, the fix isn't wrong — it isn't running, or it's not touching the actual failure path.

**Lesson re-learned (already recorded June 8):** "Read the actual file/data before writing prompts" and "one concrete fix per problem, no iterative guessing." These were violated repeatedly.

**THE BREAKTHROUGH — actual log analysis:**
Finally captured live MATCH_RESULT logs with the delrin in view. The table revealed:

| Entry | combined | group | ncc | hist | n_refs |
|-------|----------|-------|-----|------|--------|
| UNKNOWN PART (1d4faaa2) (orphan) | 0.645 | 0.72 | 0.80 | 0.69 | 2 |
| UNKNOWN PART (ca57d6ab) (orphan) | 0.54 | 0.57 | 0.61 | 0.51 | 3 |
| Delrin piece (named entry) | 0.403 | 0.35 | 0.50 | 0.00 | 26 |

**TRUE ROOT CAUSE (nothing to do with weights or algorithm):**
1. The fresh delrin re-teach (orphan 1d4faaa2, 2 refs, current lighting) matched correctly — ncc=0.80, hist=0.69, combined 0.645. But its metadata was deleted, so it loaded as an "orphan" with no name → resolved to "UNKNOWN PART (1d4faaa2)" → displayed as wrong part.
2. The named "Delrin piece" entry (c98e890b8f22, 26 refs) was STALE from old lighting — hist collapsed to 0.00, combined 0.403, below the 0.48 threshold.
3. The teach-ref loader warned about orphans but LOADED them and let them MATCH anyway — the deeper bug. The earlier orphan fix only covered *_templates.npz, not per-part teach dirs.

So: good teach data orphaned (matches but can't be named) + stale named data (named but doesn't match) + a loader that allowed orphan matching. Every weight change was treating a symptom three layers above the actual data/loader problem.

**THE REAL FIX (data hygiene + loader fix):**
- Backed up (moved, not deleted) the 4 orphan dirs to /opt/cobot/parts/_orphan_backup_<timestamp>/
- Archived the stale 26 delrin refs (c98e890b8f22_stale_26refs)
- Kept "Delrin piece" named entry but cleared stale refs (teach_count=0, ready for fresh re-teach)
- LOADER FIX in _load_teach_refs: any teach dir whose part_id is NOT in the parts library is SKIPPED entirely (SKIP_ORPHAN_TEACH log). Never loaded, never matched, never assigned fallback hex name. Structurally eliminates the "matches-but-shows-as-wrong-part" bug class forever.
- New startup summary: TEACH_LOAD: N parts loaded, M orphan dirs skipped, per-part ref counts
- Build clean, restart confirmed, behaviors verified live

**Post-fix state confirmed:** /opt/cobot/parts/teach/ contains exactly two dirs: 5f63d36cd800 (BT225L13_a, step_only, no refs) and c98e890b8f22 (Delrin piece, empty, ready for re-teach). Refs land automatically on next teach API call (no restart needed).

---

### Section 277: Post-Fix Tuning — Spatial Signal and Orientation Discrimination

**After data hygiene + re-teach, user reported "performing much better."** Then "both sides of the taught delrin parts are matching close to the same."

**Discussion — would text descriptions help?** No. The matcher compares pixels (NCC) and color (histogram); it has no language understanding. Text metadata is never read by the matching code.

**Why both sides match similarly:** Uniform white delrin — both faces present a similar white rectangle. NCC sees similar shape, histogram sees identical color (all white). This is the documented key-fob problem (similar-appearance sides).

**User confirmed: the two sides ARE clearly distinguishable to the human eye.** This means the difference is capturable — it's SPATIAL (where the holes are), which NCC (whole shape) and histogram (overall color) miss.

**Discovery:** The spatial color grid signal was INERT — hardcoded to 0.5, never actually computed. Claude Code's earlier weight change left it as a placeholder. So orientation discrimination was relying on NCC alone.

**Built _spatial_pattern_score:**
- 6×6 grayscale grid + 6×6 DEPTH grid, each Z-standardized, Pearson-correlated, 50/50 blended
- The DEPTH grid is the key: holes are physically recessed (farther from camera), so even on uniform-white parts the depth grid locates them geometrically regardless of color
- Wired into per-ref loop, real avg_spatial replaces hardcoded 0.5
- Reweighted: ncc 0.40, hist 0.15, spatial 0.45 (spatial now carries orientation decision)
- MATCH_RESULT log shows real spatial value per group

**Concern raised:** spatial at 0.45 weight is unverified — if _spatial_pattern_score returns low/zero, it could drag all scores below threshold and break recognition entirely.

---

### Section 278: Recognition Regression After Spatial Reweight

**Symptom:** After the spatial reweight, "still not recognizing parts in the camera view." Then a screenshot showed BOTH a delrin and another part being matched as BT225L28_a (PICK OK 68% / NO PICK 52%) — the delrin not recognized, matched to a STEP part instead.

**User's sharp observation:** "the bounding box is not being used to recognize size. It's not recognizing the delrin part."

**Suspected causes (unresolved at session end — pending log analysis):**
1. Delrin teach refs not loading again (back to loader/data issue)
2. Size gate too loose (35% tolerance + D435i ±30% noise letting delrin pass BT225L28 gate)
3. Spatial reweight (0.45) returning low values, dragging combined scores below threshold → fallback to BatchL28 template matching
4. Template fallback path firing (if not self._teach_refs → pure outline matching against STEP templates, ignores all weights and teach data)

**The SIZE_GATE log line directly answers the user's question** — it prints det=[XxXcm] candidates with pass/fail and dim_err% per candidate. One look tells whether the OBB size is gating correctly.

**Status at session end:** User uploading latest code for direct review. Decision made to STOP theory-driven fixes and read actual code + logs first. Four things to trace: (1) does delrin have teach refs loaded (TEACH_LOAD line), (2) is size gate actually gating (SIZE_GATE_RATIO_FLOOR + logic), (3) did spatial reweight break matching (low/zero spatial values), (4) is template fallback firing.

---

### Section 279: 3D Bounding Box Clarification

**Question:** Was using 3D bounding boxes helping part recognition?

**Answer:** No — they are NOT part of the recognition pipeline.

**Two separate bounding-box systems clarified:**
1. 2D OBB in depth_segment (camera recognition) — IS used. Rotated rectangle from depth segmentation, feeds size gate + defines crop for NCC/spatial matching. This matters.
2. 3D bounding boxes from lidar_perception/lidar_object_identifier — NOT used for recognition. For spatial awareness + safety on the sparse Livox cloud. Never touches the identity or pickable-orientation decision.

The delrin pickable/non-pickable problem lives entirely in the camera pipeline (2D OBB → size gate → NCC + spatial + histogram). The LiDAR 3D boxes contribute nothing to it. In a commercial dense-3D setup (Mech-Eye/Zivid + FoundationPose), 3D boxes from a dense cloud would give real 6DoF pose — but the Livox cloud is too sparse and FoundationPose isn't in production.

---

### Section 280: Label Clipping Fix

**Change:** Detection label text was being clipped at the camera frame's right edge (black letterbox) — "pickable sid..." cut off.

**Fix:** Allow label text to render into the black/letterbox space instead of being clipped at frame boundary. Draw labels after letterbox padding, expand drawing canvas to include black bars, clamp label X to full output canvas width (not active image region), reduce font or left-shift if still too wide. Applied to all label types (PICK OK, NO PICK, DEFECT, UNKNOWN).

---

### Updated Dashboard Tabs (June 11, 2026)

```
Monitor | Program Library | Program | 3D View | Cameras & LiDAR
  | Part Recognition | Quality Inspection | I/O | Safety | Configure
```

| Tab | Status (June 11) | Notes |
|-----|-----------------|-------|
| Monitor | Active | Motion badge removed; identified objects card added (LiDAR) |
| Program Library | Active | |
| Program | Updated | Speed + Motion Profile pages removed (silent defaults); motion card removed; teach pendant fullscreen jog |
| 3D View | Updated | Trajectory toggle removed; identified-objects overlay added |
| Cameras & LiDAR | Active | |
| Part Recognition | Updated | Label clipping fix; LiDAR detection stats per part; loader fix; spatial signal |
| Quality Inspection | New (disabled) | Awaiting Mech-Eye/dense camera |
| I/O | Active | |
| Safety | Built out (disabled) | Awaiting lidar_perception activation |
| Configure | Updated | Motion section removed; workspace mask configurator added (LiDAR) |

---

### Updated Systemd Services (June 11, 2026)

15 active + staged-disabled, plus new:
- roboai-motion-optimization (NEW, auto-starts — optimization opt-in, graceful fallback)
- roboai-lidar-identifier (NEW, auto-starts — read-only, doesn't control robot)
- roboai-inspection (installed, disabled — awaiting dense camera)
- roboai-lidar-perception (installed, disabled — staged rollout)

---

### Key Decisions Made June 11, 2026

- **Motion/speed controls removed from wizard** — silent defaults (60% / Balanced)
- **All motion balancing toggles removed from UI** — TOPP-RA runs silently under the hood
- **LiDAR-only fusion stays** — no camera depth reintegration; LiDAR identifies via STEP geometry matching with multi-frame persistence
- **Mech-Eye pricing is $16K, not $4.5K** — completely changes camera recommendation; Zivid 2+ M60 (~$5.5K) now the price/value winner; get hard quotes before committing
- **MotionCam Color not pursued** — wrist-mount dealbreaker (660mm/1.5kg), continuous motion not needed
- **NVIDIA FoundationPose is the commercial recognition path** — not NCC+histogram; needs dense input data (the missing piece is the camera, not the software)
- **NCC+histogram is prototype-only** — not commercial-robust (rotation/lighting/occlusion/similar-part fragility)
- **STOP theory-driven fixes; diagnose from logs and live camera output, never from documentation** — the central process lesson, re-learned the hard way
- **Spatial DEPTH grid for orientation** — holes are recessed, so depth grid locates them geometrically even on uniform-white parts
- **AprilTag 100mm tag36h11** for hand-eye calibration, order this week
- **Estun controller is software-ready** — remaining items are physical/network on arrival + URDF from Estun

---

### Key Bugs Fixed June 11, 2026

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Delrin identified as BT225L24/L28 (THE main saga) | Good fresh delrin teach data orphaned (metadata deleted) → matched but resolved to UNKNOWN/wrong-part; stale named refs scored hist=0.00; loader allowed orphan matching | Data hygiene (backup orphans, archive stale refs, clear named entry) + loader fix (skip teach dirs whose part_id not in library) — eliminates the bug class structurally |
| Inert spatial signal | spatial hardcoded to 0.5, never computed | Built _spatial_pattern_score (6×6 grayscale + depth grids, Z-standardized Pearson), wired into per-ref loop, reweighted to 0.45 |
| Label text clipped at frame edge | Labels drawn before letterbox, clamped to active image | Draw after padding, allow rendering into black bars, clamp to full canvas |
| nvblox 790 verts (broken mesh) | QoS/TF/topic-type/voxel config wrong for LiDAR-only mode | Configure for Livox LiDAR-only: voxel 0.02, proper FoV, QoS BEST_EFFORT, TF tree fix |
| Recognition regression after spatial reweight (UNRESOLVED at session end) | Suspected: spatial 0.45 returning low values dragging scores below threshold, OR loader/data issue resurfaced, OR size gate too loose | Pending log analysis — code uploaded for direct review |

---

### Key Pending Items (June 11, 2026)

| Item | Priority | Status |
|------|----------|--------|
| Resolve recognition regression after spatial reweight | CRITICAL | Code uploaded for review; need TEACH_LOAD + SIZE_GATE + MATCH_RESULT logs with delrin in view |
| Re-teach delrin both orientations (10+ each, current lighting) | HIGH | Named entry cleared and ready |
| Capture MATCH_RESULT gap (pickable vs non-pickable) | HIGH | The number that proves whether NCC+spatial distinguishes orientations |
| Get hard camera quotes (Mech-Eye camera-only, Zivid, Photoneo) | HIGH | Mech-Eye $16K shock requires re-quote before purchase |
| Verify build/deploy chain reaches running service | HIGH | Host vs docker container question — confirm edits actually execute |
| Order AprilTag 100mm board | MEDIUM | ~$30, mandatory for calibration |
| nvblox mesh fix verification | MEDIUM | Confirm >30k verts after Part A |
| FoundationPose volume-bias fix (silhouette normalization) | DEFERRED | Commercial recognition path |
| Estun URDF / DH parameters | BLOCKING MoveIt2 | Request from Estun before robot ships |

---

### THE PROCESS LESSON (June 11, 2026) — Recorded for Future Sessions

The vision recognition saga consumed hours because of a repeated anti-pattern: **writing elaborate fix prompts based on documentation descriptions rather than reading the actual running code and live logs.** Five increasingly sophisticated fixes produced zero change because none touched the actual failure path (orphaned teach data + a permissive loader).

The breakthrough came in five minutes once actual MATCH_RESULT logs were captured — the score table revealed the orphan/stale-data situation instantly.

**The discipline that should govern all future debugging:**
1. **See the logs first, always.** Never propose a fix for behavior not observed in live output.
2. **Identical output across changes = the change isn't running or isn't on the failure path.** Stop changing things; verify what's actually executing.
3. **Verify deploys.** Confirm build reaches the running service (host vs container path question).
4. **The SIZE_GATE / MATCH_RESULT / TEACH_LOAD logs are diagnostic gold** — they print exactly what the matcher sees and decides. One capture answers most questions.
5. **Eliminate by evidence, not theory.** Logs eliminate possibilities in one shot; theories multiply them.

This lesson was first recorded June 8 ("read the actual file before writing prompts; one concrete fix per problem") and re-learned the hard way June 11. It must govern the next session.

---

*Last updated: June 11, 2026*
*Covers sessions 265-280: teach pendant fullscreen jog, motion/speed controls removed from wizard (silent 60%/Balanced defaults), RealSense D435i issue catalog (20 issues — physical limitations not code bugs), motion path optimization tooling built (TOPP-RA engine + trajectory smoother + MoveIt2 skeleton + profile manager, Configure/Wizard/Monitor/3D-View UI, executor middleware, roboai-motion-optimization service), motion balancing toggles removed from all UI (backend keeps running silently), LiDAR dense point cloud + object identification built (nvblox fix for 790→50k+ verts, accumulator upgrade to 105-205k points with adaptive noise suppression, new lidar_object_identifier package with 7-stage pipeline + shape analysis + STEP parts matching + multi-frame persistence preventing the 22-spurious-cluster problem, dashboard overlays + workspace mask configurator), Estun controller readiness assessment (software ready, arrival-day 90min checklist, prep work list, URDF risk), AprilTag explanation + 100mm tag36h11 sizing decision, MAJOR Mech-Eye pricing shock ($16K direct quote vs assumed $4.5K — Zivid 2+ M60 now the price/value winner, get hard quotes before purchase), MotionCam Color evaluation (wrist-mount dealbreaker 660mm/1.5kg, continuous motion not needed), NVIDIA recognition stack discussion (FoundationPose IS the commercial path, needs dense data which is the missing piece not the software; NCC+histogram is prototype-only not commercial-robust), and THE central event: a multi-hour vision recognition debugging saga where a delrin part was misidentified as BT225L24/L28, traced through five FAILED theory-driven fixes (weight changes, two-path split, STEP penalty, feature architecture — all producing byte-for-byte identical wrong output) to its TRUE root cause found via actual MATCH_RESULT log analysis in five minutes: good fresh delrin teach data was ORPHANED (metadata deleted → matched correctly at ncc 0.80 but resolved to UNKNOWN/wrong-part) while the named entry held STALE refs (hist=0.00 from old lighting) and the teach-ref loader permissively allowed orphan matching — fixed via data hygiene (backup orphans, archive stale, clear named entry) + a permanent loader fix (skip any teach dir whose part_id is not in the parts library, eliminating the bug class structurally), then post-fix tuning built a real _spatial_pattern_score (6×6 grayscale + depth grids, Z-standardized Pearson, depth grid locating recessed holes geometrically on uniform-white parts) to replace the inert hardcoded-0.5 spatial signal and reweighted to ncc 0.40/hist 0.15/spatial 0.45 — which introduced a suspected regression (recognition stopped, delrin matched as BT225L28) UNRESOLVED at session end with code uploaded for direct review, and the overriding PROCESS LESSON re-learned and recorded: diagnose from live logs and actual code, never from documentation; identical output across changes means the change isn't running or isn't on the failure path; the SIZE_GATE/MATCH_RESULT/TEACH_LOAD logs are diagnostic gold that answer most questions in one capture.*

---

---
---

# ★★★ PROJECT VISION / NORTH STAR — THE ORGANIZING PRINCIPLE ★★★
*(Added June 15, 2026 — this section is the first-referenced organizing principle for all work. Elevated to the TOP of priorities. Everything below serves this.)*

## THE AUTONOMY NORTH-STAR

**NeuRobots is an AUTONOMOUS collaborative-robot platform. The robot sets itself up and generates its own tasks.** It arrives in a cell, perceives its environment continuously, builds a semantic 3D understanding of the workspace, recognizes parts (taught OR CAD-uploaded), derives their 6DoF pose, and generates collision-free programs — WITHOUT an operator hand-teaching positions or hand-building programs.

The wizard, teach sequences, and manual programming are **SCAFFOLDING** — the bridge that keeps the system usable while autonomy matures. They are NOT the end state. As autonomy capability grows, the manual scaffolding is progressively stripped away (this is why operations like Pick-and-Inspect/Inspect-&-Verify/Scan-&-Identify, motion controls, and speed controls have been removed from the wizard — the autonomous task generation supersedes them).

**"Remember the overarching goal"** — the user has stressed this repeatedly. Every build decision is evaluated against: does this advance autonomous self-setup and self-programming, or is it scaffolding we'll eventually discard?

### The Recognition-to-Pick Chain (core autonomous picking capability)
```
Continuous PSL 3D perception (MotionCam, during motion)
   → semantic workspace model (what's in the cell, where)
   → recognize taught-or-CAD parts (identity)
   → derive 6DoF pose
   → grasp from defined pick direction
   → auto-generated collision-free motion path
   → pick
   → close the loop (re-perceive, continue)
```

### The Three Keystone Capabilities
1. **The recognition-to-pick chain** (above) — gated on the MotionCam's dense data.
2. **`roboai-auto-program`** — LLM-driven task generation (the robot generates its own programs).
3. **Programming by Demonstration (PBD)** — video + voice → AI-generated program (the human shows intent, the system produces the program).

### The Critical-Path Insight
**The CAMERA, not the robot, is the critical path to autonomy.** The robot arm executes; the camera is what enables perception, recognition, scene understanding, and self-setup. Dense 3D perception is the prerequisite for everything in the north-star.

---

<!-- v46-content-end -->
