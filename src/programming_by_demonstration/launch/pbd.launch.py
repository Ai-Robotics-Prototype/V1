"""Launch the Programming-by-Demonstration node with parameters from
config/pbd_params.yaml. The node is request-driven (the dashboard
triggers work via /api/pbd/*); the launch is here mainly so it slots
into ros2 launch / systemd cleanly."""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    params = os.path.join(
        get_package_share_directory('programming_by_demonstration'),
        'config', 'pbd_params.yaml',
    )
    return LaunchDescription([
        Node(
            package='programming_by_demonstration',
            executable='pbd_node',
            name='pbd_node',
            parameters=[params],
            output='screen',
        ),
    ])
