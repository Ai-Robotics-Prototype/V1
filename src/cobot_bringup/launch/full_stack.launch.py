import os
from launch import LaunchDescription
from launch.actions import (
    DeclareLaunchArgument, GroupAction, IncludeLaunchDescription,
    LogInfo, OpaqueFunction,
)
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.conditions import IfCondition, UnlessCondition
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution, PythonExpression
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    bringup_dir = get_package_share_directory('cobot_bringup')
    config_dir = os.path.join(bringup_dir, 'config')

    return LaunchDescription([
        DeclareLaunchArgument('robot_model',       default_value='generic'),
        DeclareLaunchArgument('robot_brand',       default_value='generic'),
        DeclareLaunchArgument('robot_ip',          default_value='192.168.1.10'),
        DeclareLaunchArgument('use_fake_hardware',  default_value='false'),
        DeclareLaunchArgument('launch_dashboard',   default_value='true'),
        DeclareLaunchArgument('launch_fleet',       default_value='false'),
        DeclareLaunchArgument('log_level',          default_value='info'),
        # LiDAR source: set use_ouster:=true OR use_livox:=true (mutually exclusive)
        DeclareLaunchArgument('use_ouster',  default_value='false',
                              description='Launch Ouster OS1 bridge (UDP 56201)'),
        DeclareLaunchArgument('use_livox',   default_value='false',
                              description='Launch Livox MID-360 driver'),
        # Camera bringup
        DeclareLaunchArgument('use_cameras', default_value='true',
                              description='Launch RealSense cameras'),

        LogInfo(msg=[
            'RoboAi full stack — sensors: '
            'ouster=', LaunchConfiguration('use_ouster'),
            ' livox=', LaunchConfiguration('use_livox'),
            ' cameras=', LaunchConfiguration('use_cameras'),
            ' dashboard=', LaunchConfiguration('launch_dashboard'),
            ' fleet=', LaunchConfiguration('launch_fleet'),
        ]),

        # ── Ouster OS1 bridge (use_ouster:=true) ────────────────────────────
        Node(
            package='cobot_bringup', executable='ouster_bridge',
            name='ouster_bridge', output='screen',
            condition=IfCondition(LaunchConfiguration('use_ouster')),
        ),

        # ── Livox MID-360 driver (use_livox:=true) ──────────────────────────
        Node(
            package='livox_ros_driver2', executable='livox_ros_driver2_node',
            name='livox_lidar_publisher', output='screen',
            condition=IfCondition(LaunchConfiguration('use_livox')),
            parameters=[
                {'xfer_format': 0},
                {'multi_topic': 0},
                {'data_src': 0},
                {'publish_freq': 10.0},
                {'output_data_type': 0},
                {'frame_id': 'lidar_link'},
                {'user_config_path': os.path.join(config_dir, 'mid360_config.json')},
            ],
            remappings=[('/livox/lidar', '/lidar/points')],
        ),

        # ── RealSense cameras (use_cameras:=true) ───────────────────────────
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(bringup_dir, 'launch', 'cameras.launch.py')),
            condition=IfCondition(LaunchConfiguration('use_cameras')),
        ),

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
        # ── Robot driver (TCP/IP to physical arm) ────────────────────────────
        Node(
            package='robot_driver', executable='robot_driver_node',
            name='robot_driver_node', output='screen',
            parameters=[os.path.join(config_dir, 'robot_driver.yaml')],
        ),
        # ── Gripper driver ───────────────────────────────────────────────────
        Node(
            package='gripper_driver', executable='gripper_node',
            name='gripper_node', output='screen',
            parameters=[os.path.join(config_dir, 'gripper.yaml')],
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
