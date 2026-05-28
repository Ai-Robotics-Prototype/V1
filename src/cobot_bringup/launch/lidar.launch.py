"""LiDAR bringup: Livox MID-360 driver only.

  /lidar/points (Livox, ~20k pts @ 10 Hz)

Accumulation is now a separate service (roboai-accumulator) so it can be
restarted independently and so its rolling buffers survive a Livox
driver restart with a slightly stale tail rather than disappearing.
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource


def generate_launch_description():
    livox_share = get_package_share_directory('livox_ros_driver2')
    # Upstream installs its launch files under launch_ROS2/, not launch/.
    livox_launch = os.path.join(livox_share, 'launch_ROS2', 'msg_MID360_launch.py')
    livox = IncludeLaunchDescription(PythonLaunchDescriptionSource(livox_launch))
    return LaunchDescription([livox])
