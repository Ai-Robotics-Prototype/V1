"""
Generic depth-segmentation object detection (class-agnostic).

Runs object_detection/depth_segment_node, which detects ANY object in cam0's
view from the RealSense aligned depth image — no ML model, no class list.

It publishes /perception/detections_3d and /perception/annotated_image, the
same topics the dashboard reads. Run this INSTEAD of the Isaac/YOLOv8 detector
(both publish those topics — running both at once produces two publishers and
flickering). Cameras must already be running (roboai-cameras).

  ros2 launch cobot_bringup depth_detection.launch.py
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('max_depth_m',        default_value='2.0'),
        DeclareLaunchArgument('min_object_area_px', default_value='500'),
        DeclareLaunchArgument('floor_tolerance_m',  default_value='0.02'),
        DeclareLaunchArgument('erode_kernel',       default_value='3'),
        DeclareLaunchArgument('dilate_kernel',      default_value='5'),
        DeclareLaunchArgument('publish_rate_hz',    default_value='15.0'),

        Node(
            package='object_detection',
            executable='depth_segment_node',
            name='depth_segment_node',
            output='screen',
            parameters=[{
                'max_depth_m':        LaunchConfiguration('max_depth_m'),
                'min_object_area_px': LaunchConfiguration('min_object_area_px'),
                'floor_tolerance_m':  LaunchConfiguration('floor_tolerance_m'),
                'erode_kernel':       LaunchConfiguration('erode_kernel'),
                'dilate_kernel':      LaunchConfiguration('dilate_kernel'),
                'publish_rate_hz':    LaunchConfiguration('publish_rate_hz'),
            }],
        ),
    ])
