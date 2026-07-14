"""Launch the Estun Codroid driver with config/estun.yaml as the params file.

The driver *also* consults ESTUN_ROBOT_IP and ESTUN_ROBOT_PORT env vars
at startup; those take precedence over the YAML defaults (see the
docstring in estun_driver_node.py).
"""

import os
from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    config = os.path.join(
        get_package_share_directory('estun_driver'),
        'config', 'estun.yaml',
    )
    return LaunchDescription([
        Node(
            package='estun_driver',
            executable='estun_driver_node',
            name='estun_driver',
            output='screen',
            parameters=[config],
        ),
    ])
