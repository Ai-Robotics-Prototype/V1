#!/bin/bash
echo "=== Cobot Hardware Verification ==="
echo "Checking topic rates (10 second test)..."
timeout 10 ros2 topic hz /lidar/points &
timeout 10 ros2 topic hz /cam0/color/image_raw &
timeout 10 ros2 topic hz /cam1/color/image_raw &
timeout 10 ros2 topic hz /joint_states &
wait
echo "=== Safety Topic Check ==="
ros2 topic echo /safety/status --once
echo "=== Done ==="
