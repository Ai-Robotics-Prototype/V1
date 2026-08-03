"""Isaac ROS YOLOv8 object detection — the sole part-detection path.

Composes the pipeline extracted from isaac_ros_full.launch.py so a
single detection unit can be included from both full_stack.launch.py
(the assembled workspace launch) and depth_detection.launch.py (the
per-service systemd unit the running system actually boots via
`roboai-depth-segment.service`).

Pipeline:
  /cam0/cam0/color/image_raw
     → ImageFormatConverter (bgr8 → rgb8)
     → DnnImageEncoder      (rgb8 → 640×640 float tensor)
     → TensorRTNode         (/opt/cobot/models/yolov8n.plan)
     → YoloV8DecoderNode    (/detections_output — Detection2DArray)
     → depth_detector_node  (bridges 2D+depth → Detection3DArray on
                              /perception/detections_3d — the exact
                              wire the dashboard already consumes)

Fallback: when Isaac ROS packages or CUDA/VPI runtime libs aren't
resolvable at launch time (typical of a fresh-flash or a bench
without the accelerator libs), the launch falls through to the
class-agnostic depth-segment path so detection keeps working. This
preserves boot on a developer laptop; the Orin has the libs.

D10-adjacent: the extrinsic used by depth_detector_node is the
provisional `cam0_link → base_link` transform in
`config/sensor_transforms.yaml` — 3D positions are `uncalibrated`
until the AprilTag calibration lands. The dashboard renders an
"Extrinsic uncalibrated" chip until then; message shapes unchanged.
"""

import os

from launch import LaunchDescription
from launch.actions import IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
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
    import ctypes
    for lib in libs:
        try:
            ctypes.CDLL(lib)
        except OSError:
            return False
    return True


def isaac_detection_actions():
    """The core action list — importable from other launch files so
    they don't have to instantiate a nested LaunchDescription just to
    wire in detection."""

    isaac_ok = (
        _pkg_available('isaac_ros_dnn_image_encoder')
        and _pkg_available('isaac_ros_tensor_rt')
        and _pkg_available('isaac_ros_yolov8')
        and _so_available('libnvvpi.so.3', 'libnvToolsExt.so.1',
                          'libnvdla_compiler.so', 'libcvcuda.so.0')
    )

    if not isaac_ok:
        # Fallback for bring-up without the accelerator libs. Keeps
        # boot alive on dev laptops; production Orin resolves isaac_ok
        # and never enters this branch. Note: this is the classical
        # class-agnostic depth-segment path being retired for
        # part-detection duty — kept ONLY as a safety net.
        bringup_dir = get_package_share_directory('cobot_bringup')
        return [IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(bringup_dir, 'launch',
                             'depth_detection_fallback.launch.py')),
        )] if os.path.isfile(os.path.join(
                bringup_dir, 'launch',
                'depth_detection_fallback.launch.py')) else [Node(
            package='object_detection',
            executable='depth_segment_node',
            name='depth_segment_node',
            output='screen',
        )]

    encoder_dir = get_package_share_directory('isaac_ros_dnn_image_encoder')

    fmt_converter = ComposableNode(
        name='image_format_converter',
        package='isaac_ros_image_proc',
        plugin='nvidia::isaac_ros::image_proc::ImageFormatConverterNode',
        parameters=[{'encoding_desired': 'rgb8',
                     'image_width': 640, 'image_height': 480}],
        remappings=[
            ('image_raw', '/cam0/cam0/color/image_raw'),
            ('image',     '/cam0/cam0/color/image_rgb'),
        ],
    )

    tensor_rt = ComposableNode(
        name='tensor_rt',
        package='isaac_ros_tensor_rt',
        plugin='nvidia::isaac_ros::dnn_inference::TensorRTNode',
        parameters=[{
            'model_file_path':      '/opt/cobot/models/yolov8n.onnx',
            'engine_file_path':     '/opt/cobot/models/yolov8n.plan',
            'input_tensor_names':   ['input_tensor'],
            'input_binding_names':  ['images'],
            'output_tensor_names':  ['output_tensor'],
            'output_binding_names': ['output0'],
            'verbose':              False,
            # 2026-08-03 (bench-verified): the stale `.plan` on disk
            # deserialized OK but produced silent zero-output — TRT
            # version mismatch, engine built ~10 weeks before the
            # current TRT toolchain. Setting `force_engine_update=True`
            # rebuilds the `.plan` from the ONNX on FIRST launch (or
            # any time the file is missing / stale). Adds ~90s to the
            # first-boot after a model swap; no cost on subsequent
            # boots (the plan cache hits).
            'force_engine_update':  True,
        }],
    )

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
        composable_node_descriptions=[fmt_converter, tensor_rt,
                                      yolov8_decoder],
        output='screen',
    )

    encoder_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(encoder_dir, 'launch',
                         'dnn_image_encoder.launch.py')),
        launch_arguments={
            'input_image_width':                    '640',
            'input_image_height':                   '480',
            'network_image_width':                  '640',
            'network_image_height':                 '640',
            'image_mean':                           '[0.0, 0.0, 0.0]',
            'image_stddev':                         '[1.0, 1.0, 1.0]',
            'attach_to_shared_component_container': 'True',
            'component_container_name':             'yolov8_container',
            'dnn_image_encoder_namespace':          'yolov8_encoder',
            'image_input_topic':                    '/cam0/cam0/color/image_rgb',
            'camera_info_input_topic':              '/cam0/cam0/color/camera_info',
            'tensor_output_topic':                  '/tensor_pub',
        }.items(),
    )

    # depth_detector_node bridges the Isaac decoder's Detection2DArray
    # to the Detection3DArray topic the dashboard subscribes to. Zero
    # forked consumers — the dashboard sees the same message shape it
    # always did, just from a new source.
    depth_detector = Node(
        package='object_detection',
        executable='depth_detector_node',
        name='depth_detector_node',
        remappings=[
            ('/detections',           '/detections_output'),
            ('/perception/detections','/perception/detections_3d'),
        ],
        output='screen',
    )

    return [container, encoder_launch, depth_detector]


def generate_launch_description():
    """Standalone entry — used by systemd (`roboai-detection.service`
    when the operator flips the unit) and by manual bring-up:
      ros2 launch cobot_bringup isaac_detection.launch.py
    """
    return LaunchDescription(isaac_detection_actions())
