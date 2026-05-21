"""Launch all physical sensors: 2x RealSense D435i (cam0, cam1) + Livox MID-360 LiDAR."""
import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch_ros.actions import Node


def generate_launch_description():
    bringup_dir = get_package_share_directory('cobot_bringup')
    config_path  = os.path.join(bringup_dir, 'config', 'mid360_config.json')

    cameras = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(bringup_dir, 'launch', 'cameras.launch.py')
        ),
    )

    lidar = Node(
        package='livox_ros_driver2',
        executable='livox_ros_driver2_node',
        name='livox_lidar_publisher',
        output='screen',
        parameters=[
            {'xfer_format': 0},          # PointCloud2 (sensor_msgs/PointCloud2)
            {'multi_topic': 0},
            {'data_src': 0},
            {'publish_freq': 10.0},
            {'output_data_type': 0},
            {'frame_id': 'lidar_frame'},
            {'user_config_path': config_path},
        ],
        remappings=[('/livox/lidar', '/ouster/points')],
    )

    return LaunchDescription([
        cameras,
        lidar,
    ])
