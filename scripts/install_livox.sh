#!/usr/bin/env bash
# Clone, build and configure Livox-SDK2 + livox_ros_driver2 for the
# MID-360 on this workspace. Idempotent: re-running is safe.
#
# Sensor IP and host IP are baked in — change here if your unit differs.
set -euo pipefail

SENSOR_IP="${SENSOR_IP:-192.168.2.150}"
HOST_IP="${HOST_IP:-192.168.2.246}"

WS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$WS_ROOT/src"

echo ">> Livox-SDK2"
if [[ ! -d "$SRC/Livox-SDK2" ]]; then
  git clone --depth=1 https://github.com/Livox-SDK/Livox-SDK2.git "$SRC/Livox-SDK2"
fi
touch "$SRC/Livox-SDK2/COLCON_IGNORE"
mkdir -p "$SRC/Livox-SDK2/build"
( cd "$SRC/Livox-SDK2/build" && cmake .. && make -j"$(nproc)" && sudo make install )

echo ">> livox_ros_driver2"
if [[ ! -d "$SRC/livox_ros_driver2" ]]; then
  git clone --depth=1 https://github.com/Livox-SDK/livox_ros_driver2.git "$SRC/livox_ros_driver2"
fi

# Per the upstream README, ROS2 builds require these two files in place.
# We do NOT use the upstream build.sh — it deletes ws-wide build/install dirs.
cp -f "$SRC/livox_ros_driver2/package_ROS2.xml" "$SRC/livox_ros_driver2/package.xml"
cp -rf "$SRC/livox_ros_driver2/launch_ROS2/." "$SRC/livox_ros_driver2/launch/"

echo ">> patch MID360_config.json: sensor=$SENSOR_IP host=$HOST_IP"
python3 - "$SRC/livox_ros_driver2/config/MID360_config.json" "$SENSOR_IP" "$HOST_IP" <<'PY'
import json, sys
path, sensor, host = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    cfg = json.load(f)
for k in ("cmd_data_ip", "push_msg_ip", "point_data_ip", "imu_data_ip"):
    cfg["MID360"]["host_net_info"][k] = host
cfg["lidar_configs"][0]["ip"] = sensor
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PY

echo ">> patch msg_MID360_launch.py: xfer_format=0 + remap /livox/lidar → /lidar/points"
for f in "$SRC/livox_ros_driver2/launch/msg_MID360_launch.py" \
         "$SRC/livox_ros_driver2/launch_ROS2/msg_MID360_launch.py"; do
  sed -i 's/^xfer_format[[:space:]]*=[[:space:]]*1\b/xfer_format   = 0/' "$f"
  grep -q "remappings=\[('/livox/lidar', '/lidar/points')\]" "$f" || \
    sed -i "s|parameters=livox_ros2_params$|parameters=livox_ros2_params,\n        remappings=[('/livox/lidar', '/lidar/points')],|" "$f"
done

echo ">> colcon build"
( cd "$WS_ROOT" && colcon build --packages-select livox_ros_driver2 --symlink-install \
    --cmake-args -DROS_EDITION=ROS2 -DDISTRO_ROS=humble )

echo "OK"
