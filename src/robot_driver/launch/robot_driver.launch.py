from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
import os


def generate_launch_description():
    pkg    = get_package_share_directory('robot_driver')
    config = os.path.join(pkg, 'config', 'robot_driver.yaml')

    return LaunchDescription([
        DeclareLaunchArgument('brand',    default_value='generic'),
        DeclareLaunchArgument('robot_ip', default_value='192.168.1.100'),

        Node(
            package='robot_driver',
            executable='robot_driver_node',
            name='robot_driver_node',
            parameters=[
                config,
                {'brand':    LaunchConfiguration('brand')},
                {'robot_ip': LaunchConfiguration('robot_ip')},
            ],
            output='screen',
        ),
    ])
