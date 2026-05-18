import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    bringup_dir = get_package_share_directory('cobot_bringup')
    config_dir = os.path.join(bringup_dir, 'config')

    return LaunchDescription([
        DeclareLaunchArgument('log_level', default_value='info'),

        Node(
            package='human_safety', executable='human_safety_node',
            name='human_safety_node', output='screen',
            parameters=[os.path.join(config_dir, 'safety.yaml')],
        ),
        Node(
            package='safety_monitor', executable='safety_monitor_node',
            name='safety_monitor_node', output='screen',
            parameters=[os.path.join(config_dir, 'safety.yaml')],
        ),
    ])
