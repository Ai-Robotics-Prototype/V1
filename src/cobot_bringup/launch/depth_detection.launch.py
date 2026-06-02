"""
Generic depth-segmentation object detection (class-agnostic), BOTH cameras.

Runs one object_detection/depth_segment_node per camera. Each detects ANY
object in its view from the RealSense aligned depth image — no ML model, no
class list.

  cam0 -> /perception/detections_3d       + /perception/annotated_image
  cam1 -> /perception/detections_3d_cam1   + /perception/annotated_image_cam1

The dashboard reads cam0 detections for its state/overlay and serves each
camera's annotated stream on /stream/cam0 and /stream/cam1.

Cameras must already be running (roboai-cameras) with depth enabled on both.

  ros2 launch cobot_bringup depth_detection.launch.py
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    args = [
        DeclareLaunchArgument('max_depth_m',        default_value='3.0'),
        DeclareLaunchArgument('min_object_area_px', default_value='50'),
        DeclareLaunchArgument('floor_tolerance_m',  default_value='0.015'),
        DeclareLaunchArgument('erode_kernel',       default_value='2'),
        DeclareLaunchArgument('dilate_kernel',      default_value='7'),
        DeclareLaunchArgument('publish_rate_hz',    default_value='15.0'),
    ]

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
