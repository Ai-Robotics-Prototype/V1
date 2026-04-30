# ─────────────────────────────────────────────────────────────────────────────
# Cobot Perception Stack — Jetson AGX Orin container
#
# Base: NVIDIA L4T JetPack 6.x (Ubuntu 22.04 + CUDA 12.2 + TensorRT 8.6)
# ROS:  ROS2 Humble
# Isaac ROS: nvblox, visual_slam, object_detection
#
# Build:
#   docker build -t cobot:latest -f docker/Dockerfile .
#
# Run:
#   docker run --runtime nvidia --network host \
#     -v /dev:/dev -v $(pwd):/cobot_ws \
#     --privileged cobot:latest
# ─────────────────────────────────────────────────────────────────────────────

ARG L4T_VERSION=r36.2.0
FROM nvcr.io/nvidia/l4t-jetpack:${L4T_VERSION}

ENV DEBIAN_FRONTEND=noninteractive \
    ROS_DISTRO=humble \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# ── System locale ─────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    locales curl gnupg2 lsb-release software-properties-common \
    && locale-gen en_US.UTF-8 && update-locale LANG=en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# ── ROS2 Humble ───────────────────────────────────────────────────────────────
RUN curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key \
      -o /usr/share/keyrings/ros-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) \
      signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] \
      http://packages.ros.org/ros2/ubuntu $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/ros2.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      ros-humble-ros-base \
      ros-humble-ament-cmake \
      ros-humble-ament-cmake-auto \
      ros-humble-rclcpp \
      ros-humble-rclpy \
      ros-humble-sensor-msgs \
      ros-humble-vision-msgs \
      ros-humble-geometry-msgs \
      ros-humble-nav-msgs \
      ros-humble-std-srvs \
      ros-humble-visualization-msgs \
      ros-humble-tf2-ros \
      ros-humble-tf2-sensor-msgs \
      ros-humble-cv-bridge \
      ros-humble-message-filters \
      ros-humble-robot-state-publisher \
      ros-humble-launch-ros \
      python3-colcon-common-extensions \
      python3-rosdep \
    && rm -rf /var/lib/apt/lists/*

# ── Isaac ROS apt repo ────────────────────────────────────────────────────────
RUN curl -sSL \
      https://isaac.download.nvidia.com/isaac-ros/repos/isaac_ros_common.repo \
      -o /etc/apt/sources.list.d/isaac_ros.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      ros-humble-isaac-ros-nvblox \
      ros-humble-isaac-ros-visual-slam \
      ros-humble-isaac-ros-object-detection \
      ros-humble-isaac-ros-dnn-image-encoder \
      ros-humble-isaac-ros-tensor-rt \
      ros-humble-isaac-ros-apriltag \
      ros-humble-isaac-ros-image-proc \
    && rm -rf /var/lib/apt/lists/* || true
    # `|| true` — graceful fallback if Isaac ROS not yet available for this L4T

# ── Python deps ───────────────────────────────────────────────────────────────
RUN pip3 install --no-cache-dir \
      cupy-cuda12x \
      filterpy \
      mediapipe \
      ultralytics \
      open3d \
      fastapi \
      uvicorn[standard] \
      pycuda \
      numpy \
      opencv-python-headless

# ── TensorRT Python bindings (ships with JetPack) ────────────────────────────
RUN pip3 install --no-cache-dir \
      tensorrt || true

# ── Workspace ─────────────────────────────────────────────────────────────────
WORKDIR /cobot_ws
COPY . /cobot_ws/

RUN /bin/bash -c "source /opt/ros/humble/setup.bash \
    && rosdep init || true \
    && rosdep update \
    && rosdep install --from-paths src --ignore-src -r -y"

RUN /bin/bash -c "source /opt/ros/humble/setup.bash \
    && colcon build --symlink-install \
      --cmake-args -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_CUDA_ARCHITECTURES=87"

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["ros2", "launch", "cobot_bringup", "isaac_ros_full.launch.py"]
