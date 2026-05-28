"""LiDAR bringup: Livox MID-360 driver + point cloud accumulator.

  /lidar/points (Livox, ~20k pts @ 10 Hz)
       |
       v
  pointcloud_accumulator (5-frame ring buffer + 0.02 m voxel dedup)
       |
       v
  /lidar/points_accumulated  (~60k unique pts @ ~10 Hz)
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource


def generate_launch_description():
    share = get_package_share_directory('cobot_bringup')
    livox_share = get_package_share_directory('livox_ros_driver2')
    # Upstream installs its launch files under launch_ROS2/, not launch/.
    livox_launch = os.path.join(livox_share, 'launch_ROS2', 'msg_MID360_launch.py')

    livox = IncludeLaunchDescription(PythonLaunchDescriptionSource(livox_launch))

    accumulator = ExecuteProcess(
        cmd=['python3',
             os.path.join(share, 'scripts', 'pointcloud_accumulator.py'),
             '--ros-args',
             '-p', 'input_topic:=/lidar/points',
             '-p', 'output_topic:=/lidar/points_accumulated',
             '-p', 'window_size:=5',
             '-p', 'voxel_size_m:=0.02',
             '-p', 'publish_rate_hz:=10.0'],
        output='screen',
    )

    return LaunchDescription([livox, accumulator])
