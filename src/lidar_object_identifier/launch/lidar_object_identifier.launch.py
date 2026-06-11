from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
import os


def generate_launch_description():
    cfg = os.path.join(
        get_package_share_directory('lidar_object_identifier'),
        'config', 'identifier_params.yaml')
    return LaunchDescription([
        Node(
            package='lidar_object_identifier',
            executable='identifier_node',
            name='lidar_object_identifier',
            output='screen',
            respawn=True,
            respawn_delay=3.0,
            parameters=[cfg],
        ),
    ])
