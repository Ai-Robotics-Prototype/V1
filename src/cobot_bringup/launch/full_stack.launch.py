import os
from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument, GroupAction, IncludeLaunchDescription,
    LogInfo, OpaqueFunction,
)
from launch.conditions import IfCondition
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    bringup_dir = get_package_share_directory('cobot_bringup')
    config_dir = os.path.join(bringup_dir, 'config')

    return LaunchDescription([
        DeclareLaunchArgument('robot_model', default_value='ur5e'),
        DeclareLaunchArgument('use_fake_hardware', default_value='false'),
        DeclareLaunchArgument('launch_dashboard', default_value='true'),
        DeclareLaunchArgument('launch_fleet', default_value='false'),
        DeclareLaunchArgument('log_level', default_value='info'),

        # Static transforms (placeholder identity)
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
            package='human_safety', executable='human_safety_node',
            name='human_safety_node', output='screen',
            parameters=[os.path.join(config_dir, 'safety.yaml')],
        ),
        Node(
            package='scene_graph', executable='scene_graph_node',
            name='scene_graph_node', output='screen',
        ),
        Node(
            package='safety_monitor', executable='safety_monitor_node',
            name='safety_monitor_node', output='screen',
            parameters=[os.path.join(config_dir, 'safety.yaml')],
        ),
        Node(
            package='task_planner', executable='task_planner_node',
            name='task_planner_node', output='screen',
            parameters=[os.path.join(config_dir, 'task_planner.yaml')],
        ),
        Node(
            package='language_interface', executable='language_node',
            name='language_node', output='screen',
            parameters=[os.path.join(config_dir, 'language.yaml')],
        ),
        Node(
            package='cobot_dashboard', executable='dashboard_server',
            name='dashboard_server', output='screen',
            condition=IfCondition(LaunchConfiguration('launch_dashboard')),
        ),
        Node(
            package='fleet_agent', executable='experience_logger_node',
            name='experience_logger_node', output='screen',
            condition=IfCondition(LaunchConfiguration('launch_fleet')),
        ),
        Node(
            package='fleet_agent', executable='upload_agent_node',
            name='upload_agent_node', output='screen',
            condition=IfCondition(LaunchConfiguration('launch_fleet')),
        ),
        Node(
            package='fleet_agent', executable='update_agent_node',
            name='update_agent_node', output='screen',
            condition=IfCondition(LaunchConfiguration('launch_fleet')),
        ),
    ])
