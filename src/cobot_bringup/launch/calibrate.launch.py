"""Run AprilTag-based extrinsic calibration.

Assumes cameras are already streaming (roboai-cameras is up). The script
exits after writing /opt/cobot/calibration/extrinsics.yaml. Restart the
TF broadcaster (or the dashboard / nodes that read TFs) afterwards.
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess


def generate_launch_description():
    share = get_package_share_directory('cobot_bringup')
    script = os.path.join(share, 'scripts', 'calibrate_extrinsics.py')
    proc = ExecuteProcess(
        cmd=['python3', script],
        output='screen',
    )
    return LaunchDescription([proc])
