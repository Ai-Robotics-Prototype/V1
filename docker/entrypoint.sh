#!/bin/bash
set -e

source /opt/ros/humble/setup.bash
if [ -f /cobot_ws/install/setup.bash ]; then
  source /cobot_ws/install/setup.bash
fi

exec "$@"
