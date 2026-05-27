"""
Launch Isaac ROS nvblox alongside the occupancy_map wrapper.

When isaac_ros_nvblox is installed on the Jetson this file composes:
  1. nvblox_ros/NvbloxNode   — GPU 3D reconstruction
  2. occupancy_map_node      — ROS2 relay / status publisher

Without isaac_ros_nvblox only the wrapper node launches (CPU fallback).
"""
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, GroupAction
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node, ComposableNodeContainer
from launch_ros.descriptions import ComposableNode
from ament_index_python.packages import get_package_share_directory

try:
    get_package_share_directory('nvblox_ros')
    NVBLOX_AVAILABLE = True
except Exception:
    NVBLOX_AVAILABLE = False


def generate_launch_description():
    occ_dir = get_package_share_directory('occupancy_map')
    config  = os.path.join(occ_dir, 'config', 'nvblox.yaml')

    actions = [
        DeclareLaunchArgument('use_color',    default_value='false'),
        DeclareLaunchArgument('publish_esdf', default_value='true'),
        DeclareLaunchArgument('voxel_size',   default_value='0.05'),

        # Always start the wrapper
        Node(
            package='occupancy_map',
            executable='occupancy_map_node',
            name='occupancy_map_node',
            parameters=[config],
            output='screen',
        ),
    ]

    if NVBLOX_AVAILABLE:
        # Run nvblox as a composable node for zero-copy data sharing
        nvblox_container = ComposableNodeContainer(
            name='nvblox_container',
            namespace='',
            package='rclcpp_components',
            executable='component_container',
            composable_node_descriptions=[
                ComposableNode(
                    package='nvblox_ros',
                    plugin='nvblox::NvbloxNode',
                    name='nvblox_node',
                    parameters=[config],
                    remappings=[
                        ('depth/image',       '/cam0/cam0/aligned_depth_to_color/image_raw'),
                        ('depth/camera_info', '/cam0/cam0/aligned_depth_to_color/camera_info'),
                        ('color/image',       '/cam0/cam0/color/image_raw'),
                        ('color/camera_info', '/cam0/cam0/color/camera_info'),
                        ('pointcloud',        '/perception/fused_cloud'),
                    ],
                ),
            ],
            output='screen',
        )
        actions.append(nvblox_container)

    return LaunchDescription(actions)
