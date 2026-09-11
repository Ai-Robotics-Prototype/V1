"""Part-detection launch — Isaac ROS YOLOv8 primary (2026-08-03).

Boot path unit: `roboai-depth-segment.service` still points at this
file, so switching the engine here transparently retires the
classical class-agnostic depth-segmentation detector without a
systemd unit change. The `depth-segment` name is preserved as-is
for continuity; the service's actual DETECTION ENGINE is now Isaac
ROS TensorRT YOLOv8, per the operator's architecture directive.

Behavior:
  * Primary: Isaac ROS YOLOv8 pipeline (see
    `isaac_detection.launch.py`) on cam0's RGB, with
    `depth_detector_node` doing the 2D → 3D bridge via aligned
    depth. Publishes `/perception/detections_3d` — the exact wire
    the dashboard, task_planner, and detect-step consumer already
    read. Zero forked consumers.
  * Fallback (dev laptop / missing accelerator libs): the
    class-agnostic `depth_segment_node` still runs cam0 + cam1 the
    way it used to, so bring-up on a bench without CUDA/VPI keeps
    detection alive during development. Production Orin resolves
    the Isaac path and never enters the fallback branch.

Extrinsic status (D10-adjacent): the cam0→base_link transform is
provisional (`config/sensor_transforms.yaml`, rpy_correction=70°
pitch, no AprilTag calibration yet). Detections carry the
'uncalibrated' status via `STATE.detections_calibrated=false` — the
Camera panel renders an "Extrinsic uncalibrated" chip until the
AprilTag pipeline lands.

Cam1 detection stays on the class-agnostic depth-segment path in
the fallback branch — Isaac's YOLO instance is single-camera for
now; cam1 is used for occlusion resolution rather than as a
primary detection input.

  ros2 launch cobot_bringup depth_detection.launch.py
"""

import os
import sys

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from ament_index_python.packages import get_package_share_directory


def generate_launch_description():
    args = [
        # Retained for backward compat with the systemd unit's
        # DeclareLaunchArgument callers; the Isaac primary path
        # ignores these (YoloV8Decoder + depth_detector_node have
        # their own thresholds), but the fallback path consumes them.
        DeclareLaunchArgument('max_depth_m',        default_value='3.0'),
        DeclareLaunchArgument('min_object_area_px', default_value='50'),
        DeclareLaunchArgument('floor_tolerance_m',  default_value='0.015'),
        DeclareLaunchArgument('erode_kernel',       default_value='2'),
        DeclareLaunchArgument('dilate_kernel',      default_value='7'),
        DeclareLaunchArgument('publish_rate_hz',    default_value='15.0'),
    ]

    bringup_dir = get_package_share_directory('cobot_bringup')
    launch_dir  = os.path.join(bringup_dir, 'launch')
    sys.path.insert(0, launch_dir)
    try:
        from isaac_detection import (
            isaac_detection_actions, _pkg_available, _so_available,
        )
    finally:
        try:
            sys.path.remove(launch_dir)
        except ValueError:
            pass

    isaac_available = (
        _pkg_available('isaac_ros_dnn_image_encoder')
        and _pkg_available('isaac_ros_tensor_rt')
        and _pkg_available('isaac_ros_yolov8')
        and _so_available('libnvvpi.so.3', 'libnvToolsExt.so.1',
                          'libnvdla_compiler.so', 'libcvcuda.so.0')
    )

    if isaac_available:
        # Retire path — Isaac ROS is the sole part-detection engine.
        # Cam1 fallback is intentionally not activated: cam0's Isaac
        # detection is the single source of truth for part poses.
        return LaunchDescription(args + isaac_detection_actions())

    # ── Fallback (retained, parked): class-agnostic depth-segment
    #    on both cameras. Boot-preserving branch for dev laptops
    #    without CUDA/VPI. Retired for part-detection duty on the
    #    Orin — the primary Isaac branch above handles everything.
    common = {
        'max_depth_m':        LaunchConfiguration('max_depth_m'),
        'min_object_area_px': LaunchConfiguration('min_object_area_px'),
        'floor_tolerance_m':  LaunchConfiguration('floor_tolerance_m'),
        'erode_kernel':       LaunchConfiguration('erode_kernel'),
        'dilate_kernel':      LaunchConfiguration('dilate_kernel'),
        'publish_rate_hz':    LaunchConfiguration('publish_rate_hz'),
    }
    cam0 = Node(
        package='object_detection', executable='depth_segment_node',
        name='depth_segment_node', output='screen',
        parameters=[{
            **common,
            'depth_topic':      '/cam0/cam0/aligned_depth_to_color/image_raw',
            'color_topic':      '/cam0/cam0/color/image_raw',
            'info_topic':       '/cam0/cam0/color/camera_info',
            'detections_topic': '/perception/detections_3d',
            'annotated_topic':  '/perception/annotated_image',
            'frame_id':         'cam0_color_optical_frame',
        }],
    )
    cam1 = Node(
        package='object_detection', executable='depth_segment_node',
        name='depth_segment_node_cam1', output='screen',
        parameters=[{
            **common,
            'depth_topic':      '/cam1/cam1/aligned_depth_to_color/image_raw',
            'color_topic':      '/cam1/cam1/color/image_raw',
            'info_topic':       '/cam1/cam1/color/camera_info',
            'detections_topic': '/perception/detections_3d_cam1',
            'annotated_topic':  '/perception/annotated_image_cam1',
            'frame_id':         'cam1_color_optical_frame',
        }],
    )
    return LaunchDescription(args + [cam0, cam1])
