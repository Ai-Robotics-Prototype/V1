import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    bringup_dir = get_package_share_directory('cobot_bringup')
    config_dir = os.path.join(bringup_dir, 'config')

    return LaunchDescription([
        DeclareLaunchArgument('use_fake_hardware', default_value='false'),
        DeclareLaunchArgument('log_level', default_value='info'),

        Node(
            package='tf2_ros', executable='static_transform_publisher',
            name='lidar_tf', output='screen',
            arguments=['0', '0', '0.5', '0', '0', '0', 'base_link', 'lidar_link'],
        ),
        Node(
            package='tf2_ros', executable='static_transform_publisher',
            name='cam0_tf', output='screen',
            arguments=['0.3', '0.1', '0.4', '0', '0.3', '0', 'base_link', 'cam0_link'],
        ),
        Node(
            package='tf2_ros', executable='static_transform_publisher',
            name='cam1_tf', output='screen',
            arguments=['0.3', '-0.1', '0.4', '0', '0.3', '0', 'base_link', 'cam1_link'],
        ),

        Node(
            package='perception_fusion', executable='sensor_fusion_node',
            name='sensor_fusion_node', output='screen',
            parameters=[os.path.join(config_dir, 'perception.yaml')],
        ),
        Node(
            package='object_detection', executable='detector_node',
            name='detector_node', output='screen',
            parameters=[os.path.join(config_dir, 'detection.yaml')],
        ),
        Node(
            package='scene_graph', executable='scene_graph_node',
            name='scene_graph_node', output='screen',
        ),
    ])
