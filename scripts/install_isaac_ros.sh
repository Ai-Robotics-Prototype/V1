#!/bin/bash
# Install Isaac ROS packages on Jetson AGX Orin (JetPack 6.x / ROS2 Humble)
# Run once after flashing JetPack. Requires internet access.
# Usage: bash scripts/install_isaac_ros.sh

set -e

ROS_DISTRO=${ROS_DISTRO:-humble}
echo "=== Isaac ROS Installation (ROS2 ${ROS_DISTRO}) ==="

# ── Prerequisites ─────────────────────────────────────────────────────────────
sudo apt-get update && sudo apt-get install -y \
  curl gnupg2 lsb-release

# ── NVIDIA apt repo ───────────────────────────────────────────────────────────
if [ ! -f /etc/apt/sources.list.d/isaac_ros.list ]; then
  echo "Adding Isaac ROS apt repo..."
  curl -sSL \
    https://isaac.download.nvidia.com/isaac-ros/repos/isaac_ros_common.repo \
    | sudo tee /etc/apt/sources.list.d/isaac_ros.list
  sudo apt-get update
fi

# ── Isaac ROS packages ────────────────────────────────────────────────────────
echo "Installing Isaac ROS packages..."
sudo apt-get install -y \
  ros-${ROS_DISTRO}-isaac-ros-nvblox \
  ros-${ROS_DISTRO}-isaac-ros-visual-slam \
  ros-${ROS_DISTRO}-isaac-ros-object-detection \
  ros-${ROS_DISTRO}-isaac-ros-dnn-image-encoder \
  ros-${ROS_DISTRO}-isaac-ros-tensor-rt \
  ros-${ROS_DISTRO}-isaac-ros-triton \
  ros-${ROS_DISTRO}-isaac-ros-apriltag \
  ros-${ROS_DISTRO}-isaac-ros-image-proc \
  ros-${ROS_DISTRO}-isaac-ros-stereo-image-proc \
  ros-${ROS_DISTRO}-isaac-ros-common

# ── Python deps ───────────────────────────────────────────────────────────────
echo "Installing Python dependencies..."
pip3 install --no-cache-dir \
  cupy-cuda12x \
  filterpy \
  mediapipe \
  ultralytics \
  open3d \
  fastapi \
  "uvicorn[standard]" \
  pycuda

# ── Create model dirs ─────────────────────────────────────────────────────────
sudo mkdir -p /opt/cobot/models /opt/cobot/logs
sudo chown -R $USER:$USER /opt/cobot

# ── Download YOLOv8 model ─────────────────────────────────────────────────────
echo "Downloading YOLOv8n model..."
python3 "$(dirname "$0")/download_model.py"

# ── Export TensorRT engine ────────────────────────────────────────────────────
echo ""
echo "To export YOLOv8 to TensorRT (FP16, recommended):"
echo "  python3 scripts/export_trt.py --fp16"
echo ""
echo "=== Isaac ROS installation complete ==="
echo "Rebuild workspace:"
echo "  source /opt/ros/${ROS_DISTRO}/setup.bash && cd ~/cobot_ws && colcon build --symlink-install"
