"""Launch file for the inspection pipeline.

Loads node params from config/inspection_node_params.yaml. The pipeline
is *disabled* on the cobot until the Mech-Eye camera is wired in — the
roboai-inspection systemd unit ships disabled.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    pkg_share = get_package_share_directory('inspection_pipeline')
    params = os.path.join(pkg_share, 'config', 'inspection_node_params.yaml')
    return LaunchDescription([
        Node(
            package='inspection_pipeline',
            executable='inspection_node',
            name='inspection_node',
            output='screen',
            parameters=[params],
        ),
    ])
