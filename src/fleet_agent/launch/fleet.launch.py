from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
import os


def generate_launch_description():
    pkg = get_package_share_directory('fleet_agent')
    config = os.path.join(pkg, 'config', 'fleet.yaml')

    return LaunchDescription([
        Node(
            package='fleet_agent',
            executable='experience_logger_node',
            name='experience_logger_node',
            parameters=[config],
            output='screen',
        ),
        Node(
            package='fleet_agent',
            executable='upload_agent_node',
            name='upload_agent_node',
            parameters=[config],
            output='screen',
        ),
        Node(
            package='fleet_agent',
            executable='update_agent_node',
            name='update_agent_node',
            parameters=[config],
            output='screen',
        ),
    ])
