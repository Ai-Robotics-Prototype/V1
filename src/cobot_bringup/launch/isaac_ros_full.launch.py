"""
Full stack launch with Isaac ROS GPU acceleration.

Adds over full_stack.launch.py:
  - cuda_pointcloud_node  (GPU fusion replaces Python sensor_fusion)
  - nvblox_node           (GPU 3D reconstruction)
  - isaac_ros_visual_slam (GPU visual SLAM, if installed)
  - isaac_ros_apriltag    (fiducial detection, if installed)
"""
import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def _pkg_available(pkg: str) -> bool:
    try:
        get_package_share_directory(pkg)
        return True
    except Exception:
        return False


def generate_launch_description():
    bringup_dir = get_package_share_directory('cobot_bringup')
    occ_dir     = get_package_share_directory('occupancy_map')
    cuda_dir    = get_package_share_directory('cuda_pointcloud')
    config_dir  = os.path.join(bringup_dir, 'config')

    actions = [
        DeclareLaunchArgument('use_fake_hardware',  default_value='false'),
        DeclareLaunchArgument('launch_dashboard',   default_value='true'),
        DeclareLaunchArgument('launch_fleet',       default_value='false'),
        DeclareLaunchArgument('launch_slam',        default_value='false'),
        DeclareLaunchArgument('log_level',          default_value='info'),

        # ── Static transforms ────────────────────────────────────────────────
        Node(package='tf2_ros', executable='static_transform_publisher',
             name='lidar_tf', output='screen',
             arguments=['0','0','0.5','0','0','0','base_link','lidar_link']),
        Node(package='tf2_ros', executable='static_transform_publisher',
             name='cam0_tf', output='screen',
             arguments=['0.3','0.1','0.4','0','0.3','0','base_link','cam0_link']),
        Node(package='tf2_ros', executable='static_transform_publisher',
             name='cam1_tf', output='screen',
             arguments=['0.3','-0.1','0.4','0','0.3','0','base_link','cam1_link']),

        # ── GPU point cloud fusion (replaces Python sensor_fusion_node) ──────
        Node(
            package='cuda_pointcloud',
            executable='cuda_pointcloud_node',
            name='cuda_pointcloud_node',
            parameters=[os.path.join(cuda_dir, 'config', 'cuda_pointcloud.yaml')],
            output='screen',
        ),

        # ── Object detection (TRT or Ultralytics) ────────────────────────────
        Node(
            package='object_detection',
            executable='detector_node',
            name='detector_node',
            parameters=[os.path.join(config_dir, 'detection.yaml')],
            output='screen',
        ),

        # ── Human safety ─────────────────────────────────────────────────────
        Node(
            package='human_safety',
            executable='human_safety_node',
            name='human_safety_node',
            parameters=[os.path.join(config_dir, 'safety.yaml')],
            output='screen',
        ),

        # ── Scene graph ──────────────────────────────────────────────────────
        Node(
            package='scene_graph',
            executable='scene_graph_node',
            name='scene_graph_node',
            output='screen',
        ),

        # ── nvblox 3D map ────────────────────────────────────────────────────
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(occ_dir, 'launch', 'nvblox.launch.py')),
        ),

        # ── Safety monitor ───────────────────────────────────────────────────
        Node(
            package='safety_monitor',
            executable='safety_monitor_node',
            name='safety_monitor_node',
            parameters=[os.path.join(config_dir, 'safety.yaml')],
            output='screen',
        ),

        # ── Task planner ─────────────────────────────────────────────────────
        Node(
            package='task_planner',
            executable='task_planner_node',
            name='task_planner_node',
            parameters=[os.path.join(config_dir, 'task_planner.yaml')],
            output='screen',
        ),

        # ── Language interface ───────────────────────────────────────────────
        Node(
            package='language_interface',
            executable='language_node',
            name='language_node',
            parameters=[os.path.join(config_dir, 'language.yaml')],
            output='screen',
        ),

        # ── Dashboard ────────────────────────────────────────────────────────
        Node(
            package='cobot_dashboard',
            executable='dashboard_server',
            name='dashboard_server',
            output='screen',
            condition=IfCondition(LaunchConfiguration('launch_dashboard')),
        ),
    ]

    # ── Optional: Isaac ROS Visual SLAM ─────────────────────────────────────
    if _pkg_available('isaac_ros_visual_slam'):
        actions.append(Node(
            package='isaac_ros_visual_slam',
            executable='visual_slam_node',
            name='visual_slam_node',
            parameters=[{
                'enable_image_denoising': False,
                'rectified_images': True,
                'enable_slam_visualization': True,
                'enable_landmarks_view': True,
                'enable_debug_mode': False,
                'map_frame': 'map',
                'odom_frame': 'odom',
                'base_frame': 'base_link',
            }],
            remappings=[
                ('stereo_camera/left/image',  '/cam0/color/image_raw'),
                ('stereo_camera/right/image', '/cam1/color/image_raw'),
                ('stereo_camera/left/camera_info',  '/cam0/color/camera_info'),
                ('stereo_camera/right/camera_info', '/cam1/color/camera_info'),
            ],
            output='screen',
            condition=IfCondition(LaunchConfiguration('launch_slam')),
        ))

    # ── Optional: Isaac ROS AprilTag ─────────────────────────────────────────
    if _pkg_available('isaac_ros_apriltag'):
        actions.append(Node(
            package='isaac_ros_apriltag',
            executable='isaac_ros_apriltag',
            name='apriltag_node',
            parameters=[{
                'family': '36h11',
                'size': 0.162,
            }],
            remappings=[
                ('image', '/cam0/color/image_raw'),
                ('camera_info', '/cam0/color/camera_info'),
            ],
            output='screen',
        ))

    return LaunchDescription(actions)
