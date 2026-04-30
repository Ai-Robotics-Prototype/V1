from launch import LaunchDescription
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory
import os


def generate_launch_description():
    pkg = get_package_share_directory('cuda_pointcloud')
    config = os.path.join(pkg, 'config', 'cuda_pointcloud.yaml')

    return LaunchDescription([
        Node(
            package='cuda_pointcloud',
            executable='cuda_pointcloud_node',
            name='cuda_pointcloud_node',
            parameters=[config],
            output='screen',
        ),
    ])
