"""
Launch both RealSense D435i cameras with correct serial numbers.

Node name=cam0 inside namespace=cam0 produces /cam0/cam0/... topics.
Run BEFORE full_stack or perception_only.

Usage:
    ros2 launch cobot_bringup cameras.launch.py
    ros2 launch cobot_bringup cameras.launch.py cam0_serial:=134322070161 cam1_serial:=101622073355
"""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('cam0_serial', default_value='134322070161',
                              description='Serial number for camera 0 (front)'),
        DeclareLaunchArgument('cam1_serial', default_value='101622073355',
                              description='Serial number for camera 1 (side/rear)'),
        DeclareLaunchArgument('align_depth', default_value='true',
                              description='Align depth to colour frame'),
        DeclareLaunchArgument('pointcloud', default_value='true',
                              description='Enable point cloud output'),

        # Camera 0 — front
        # name=cam0 + namespace=cam0 → topics at /cam0/cam0/color/image_raw etc.
        Node(
            package='realsense2_camera',
            executable='realsense2_camera_node',
            name='cam0',
            namespace='cam0',
            parameters=[{
                'serial_no':                  LaunchConfiguration('cam0_serial'),
                'align_depth.enable':         LaunchConfiguration('align_depth'),
                'pointcloud.enable':          LaunchConfiguration('pointcloud'),
                'depth_module.depth_profile': '640x480x30',
                'rgb_camera.color_profile':   '640x480x30',
                'enable_gyro':                False,
                'enable_accel':               False,
            }],
            output='screen',
        ),

        # Camera 1 — side/rear
        Node(
            package='realsense2_camera',
            executable='realsense2_camera_node',
            name='cam1',
            namespace='cam1',
            parameters=[{
                'serial_no':                  LaunchConfiguration('cam1_serial'),
                'align_depth.enable':         LaunchConfiguration('align_depth'),
                'pointcloud.enable':          LaunchConfiguration('pointcloud'),
                'depth_module.depth_profile': '640x480x30',
                'rgb_camera.color_profile':   '640x480x30',
                'enable_gyro':                False,
                'enable_accel':               False,
            }],
            output='screen',
        ),
    ])
