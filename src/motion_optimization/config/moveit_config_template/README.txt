MoveIt2 config skeleton — populated when Estun URDF arrives.

Expected sequence:
  1. Place URDF at /opt/cobot/models/estun_s10_140.urdf
  2. Run scripts/setup_moveit_config.sh
  3. This directory will be populated with:
       config/estun_s10_140.srdf
       config/kinematics.yaml
       config/joint_limits.yaml
       config/ompl_planning.yaml
       config/chomp_planning.yaml
       config/stomp_planning.yaml
  4. The generated config will then be installed at /opt/cobot/moveit_config/
  5. Restart roboai-motion-optimization to pick it up.

Until then, MoveItBridge.is_available() returns False and motion
optimization falls through to TOPP-RA alone.
