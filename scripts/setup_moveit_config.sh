#!/usr/bin/env bash
# Skeleton MoveIt2 config setup script.
# Activate once /opt/cobot/models/estun_s10_140.urdf exists.
set -euo pipefail

URDF=/opt/cobot/models/estun_s10_140.urdf
CONFIG_OUT=/opt/cobot/moveit_config

if [[ ! -f "$URDF" ]]; then
  echo "URDF not found at $URDF — drop the Estun-provided URDF there first."
  exit 1
fi

sudo mkdir -p "$CONFIG_OUT/config"

cat <<'EOF'
Once the URDF is present, run:
  ros2 launch moveit_setup_assistant setup_assistant.launch.py
to walk through SRDF / joint-limits / kinematics generation.
The generated config should land at $CONFIG_OUT/config/.
After that, restart roboai-motion-optimization to pick up the change.
EOF
