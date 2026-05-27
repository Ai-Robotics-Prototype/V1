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
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.descriptions import ComposableNode
from ament_index_python.packages import get_package_share_directory


def _pkg_available(pkg: str) -> bool:
    try:
        get_package_share_directory(pkg)
        return True
    except Exception:
        return False


def _so_available(*libs: str) -> bool:
    """Return True only if every named shared library resolves at runtime."""
    import ctypes
    for lib in libs:
        try:
            ctypes.CDLL(lib)
        except OSError:
            return False
    return True


def _detection_nodes(config_dir: str) -> list:
    """Return Isaac ROS composable pipeline, or fall back to plain detector_node."""
    # Packages must be installed AND their CUDA/VPI runtime libs must resolve.
    isaac_ok = (
        _pkg_available('isaac_ros_dnn_image_encoder')
        and _pkg_available('isaac_ros_tensor_rt')
        and _pkg_available('isaac_ros_yolov8')
        and _so_available('libnvvpi.so.3', 'libnvToolsExt.so.1',
                          'libnvdla_compiler.so', 'libcvcuda.so.0')
    )

    if not isaac_ok:
        return [Node(
            package='object_detection',
            executable='detector_node',
            name='detector_node',
            parameters=[os.path.join(config_dir, 'detection.yaml')],
            output='screen',
        )]

    encoder_dir = get_package_share_directory('isaac_ros_dnn_image_encoder')

    # 1. ImageFormatConverter: bgr8 → rgb8
    fmt_converter = ComposableNode(
        name='image_format_converter',
        package='isaac_ros_image_proc',
        plugin='nvidia::isaac_ros::image_proc::ImageFormatConverterNode',
        parameters=[{'encoding_desired': 'rgb8', 'image_width': 640, 'image_height': 480}],
        remappings=[
            ('image_raw', '/cam0/cam0/color/image_raw'),
            ('image', '/cam0/cam0/color/image_rgb'),
        ],
    )

    # 2. TensorRT inference
    tensor_rt = ComposableNode(
        name='tensor_rt',
        package='isaac_ros_tensor_rt',
        plugin='nvidia::isaac_ros::dnn_inference::TensorRTNode',
        parameters=[{
            'model_file_path':    '/opt/cobot/models/yolov8n.onnx',
            'engine_file_path':   '/opt/cobot/models/yolov8n.plan',
            'input_tensor_names':  ['input_tensor'],
            'input_binding_names': ['images'],
            'output_tensor_names':  ['output_tensor'],
            'output_binding_names': ['output0'],
            'verbose':             False,
            'force_engine_update': False,
        }],
    )

    # 3. YOLOv8 decoder → /detections (Detection2DArray)
    yolov8_decoder = ComposableNode(
        name='yolov8_decoder_node',
        package='isaac_ros_yolov8',
        plugin='nvidia::isaac_ros::yolov8::YoloV8DecoderNode',
        parameters=[{
            'confidence_threshold': 0.20,
            'nms_threshold':        0.45,
        }],
    )

    container = ComposableNodeContainer(
        name='yolov8_container',
        namespace='',
        package='rclcpp_components',
        executable='component_container_mt',
        composable_node_descriptions=[fmt_converter, tensor_rt, yolov8_decoder],
        output='screen',
    )

    # DNN image encoder: resizes rgb8 → 640×640 float tensor
    encoder_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(encoder_dir, 'launch', 'dnn_image_encoder.launch.py')),
        launch_arguments={
            'input_image_width':  '640',
            'input_image_height': '480',
            'network_image_width':  '640',
            'network_image_height': '640',
            'image_mean':   '[0.0, 0.0, 0.0]',
            'image_stddev': '[1.0, 1.0, 1.0]',
            'attach_to_shared_component_container': 'True',
            'component_container_name': 'yolov8_container',
            'dnn_image_encoder_namespace': 'yolov8_encoder',
            'image_input_topic':    '/cam0/cam0/color/image_rgb',
            'camera_info_input_topic': '/cam0/cam0/color/camera_info',
            'tensor_output_topic':  '/tensor_pub',
        }.items(),
    )

    # 4. depth_detector_node: Detection2DArray + depth → Detection3DArray
    # Wire it to the Isaac decoder (which publishes /detections_output) and to
    # the dashboard's Detection3DArray topic (/perception/detections_3d).
    depth_detector = Node(
        package='object_detection',
        executable='depth_detector_node',
        name='depth_detector_node',
        remappings=[
            ('/detections', '/detections_output'),
            ('/perception/detections', '/perception/detections_3d'),
        ],
        output='screen',
    )

    return [container, encoder_launch, depth_detector]


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
        # odom→base_link identity keeps nvblox happy when SLAM is not running
        Node(package='tf2_ros', executable='static_transform_publisher',
             name='odom_base_tf', output='screen',
             arguments=['0','0','0','0','0','0','odom','base_link']),
        Node(package='tf2_ros', executable='static_transform_publisher',
             name='map_odom_tf', output='screen',
             arguments=['0','0','0','0','0','0','map','odom']),
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

        # ── Object detection ─────────────────────────────────────────────────
        # Isaac ROS GPU pipeline when packages available; fallback to CPU node.
        *_detection_nodes(config_dir),

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

        # ── Robot driver (TCP/IP to physical arm) ────────────────────────────
        Node(
            package='robot_driver',
            executable='robot_driver_node',
            name='robot_driver_node',
            parameters=[os.path.join(config_dir, 'robot_driver.yaml')],
            output='screen',
        ),

        # ── Gripper driver ───────────────────────────────────────────────────
        Node(
            package='gripper_driver',
            executable='gripper_node',
            name='gripper_node',
            parameters=[os.path.join(config_dir, 'gripper.yaml')],
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
                ('stereo_camera/left/image',  '/cam0/cam0/color/image_raw'),
                ('stereo_camera/right/image', '/cam1/cam1/color/image_raw'),
                ('stereo_camera/left/camera_info',  '/cam0/cam0/color/camera_info'),
                ('stereo_camera/right/camera_info', '/cam1/cam1/color/camera_info'),
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
                ('image', '/cam0/cam0/color/image_raw'),
                ('camera_info', '/cam0/cam0/color/camera_info'),
            ],
            output='screen',
        ))

    return LaunchDescription(actions)
