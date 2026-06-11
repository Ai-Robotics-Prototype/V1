from launch import LaunchDescription
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        Node(
            package='motion_optimization',
            executable='motion_optimizer_node',
            name='motion_optimizer_node',
            output='screen',
            respawn=True,
            respawn_delay=2.0,
        ),
    ])
