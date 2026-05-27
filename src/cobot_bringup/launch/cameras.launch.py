"""
RoboAi — Launch both Intel RealSense D435i cameras.

Must be started BEFORE any perception stack launch.
Topics produced:
  /cam0/cam0/color/image_raw
  /cam0/cam0/aligned_depth_to_color/image_raw
  /cam0/cam0/depth/points
  /cam1/cam1/color/image_raw
  /cam1/cam1/aligned_depth_to_color/image_raw
  /cam1/cam1/depth/points

Usage:
  ros2 launch cobot_bringup cameras.launch.py
  ros2 launch cobot_bringup cameras.launch.py \
    cam0_serial:=134322070161 cam1_serial:=101622073355
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument(
            'cam0_serial', default_value='134322070161',
            description='Serial number for camera 0 (front)'),
        DeclareLaunchArgument(
            'cam1_serial', default_value='101622073355',
            description='Serial number for camera 1 (side/rear)'),

        # Camera 0 — node name=cam0 inside namespace cam0
        # → topics at /cam0/cam0/...
        # ParameterValue(..., value_type=str) prevents numeric serial from
        # being inferred as integer by the ROS2 param system.
        Node(
            package='realsense2_camera',
            executable='realsense2_camera_node',
            name='cam0',
            namespace='cam0',
            parameters=[{
                'serial_no':                       ParameterValue(LaunchConfiguration('cam0_serial'), value_type=str),
                'align_depth.enable':              True,
                'pointcloud.enable':               True,
                'depth_module.depth_profile':      '640x480x30',
                'rgb_camera.color_profile':        '640x480x30',
                # Disable the two 848x480x30 IR streams — they saturate the USB3
                # controller and starve the depth stream (depth never arrives).
                'enable_infra1':                   False,
                'enable_infra2':                   False,
                'enable_gyro':                     False,
                'enable_accel':                    False,
                'initial_reset':                   True,
            }],
            output='screen',
        ),

        # Camera 1 — node name=cam1 inside namespace cam1
        # → topics at /cam1/cam1/...
        Node(
            package='realsense2_camera',
            executable='realsense2_camera_node',
            name='cam1',
            namespace='cam1',
            parameters=[{
                'serial_no':                       ParameterValue(LaunchConfiguration('cam1_serial'), value_type=str),
                # cam1: colour + depth for detection. IR streams OFF (as on cam0)
                # so both cameras' depth fits on the shared USB3 controller.
                'align_depth.enable':              True,
                'pointcloud.enable':               False,
                'depth_module.depth_profile':      '640x480x30',
                'rgb_camera.color_profile':        '640x480x30',
                'enable_infra1':                   False,
                'enable_infra2':                   False,
                'enable_gyro':                     False,
                'enable_accel':                    False,
                'initial_reset':                   True,
            }],
            output='screen',
        ),
    ])
