"""LiDAR-perception bringup: point cloud accumulator + nvblox TSDF/mesh.

Pipeline:
    /lidar/points (Livox MID-360)
        |
        v
    pointcloud_accumulator  ->  /lidar/points_accumulated
        |
        v
    nvblox_node  ->  /nvblox_node/mesh, /nvblox_node/static_esdf_pointcloud

Static TFs are identity placeholders. Replace once the rig is extrinsically
calibrated. The robot is stationary, so map = base_link.

    ros2 launch cobot_bringup nvblox.launch.py
"""
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess
from launch_ros.actions import Node


def _static_tf(parent: str, child: str) -> Node:
    return Node(
        package='tf2_ros', executable='static_transform_publisher',
        arguments=['0', '0', '0', '0', '0', '0', parent, child],
        output='screen',
    )


def generate_launch_description():
    share = get_package_share_directory('cobot_bringup')
    cfg = os.path.join(share, 'config', 'nvblox.yaml')
    accumulator_py = os.path.join(share, 'scripts', 'pointcloud_accumulator.py')

    # cobot_bringup is ament_cmake (not a Python package), so scripts/ is
    # installed under share/ rather than as a ROS executable. Invoke via
    # python3 with the absolute path.
    accumulator = ExecuteProcess(
        cmd=['python3', accumulator_py, '--ros-args',
             '-p', 'input_topic:=/lidar/points',
             '-p', 'output_topic:=/lidar/points_accumulated',
             '-p', 'window_size:=5',
             '-p', 'voxel_size_m:=0.02',
             '-p', 'publish_rate_hz:=10.0'],
        output='screen',
    )

    nvblox = Node(
        package='nvblox_ros', executable='nvblox_node',
        name='nvblox_node', output='screen',
        parameters=[cfg],
        remappings=[
            ('pointcloud',                 '/lidar/points_accumulated'),
            ('camera_0/depth/image',       '/cam0/cam0/aligned_depth_to_color/image_raw'),
            ('camera_0/depth/camera_info', '/cam0/cam0/color/camera_info'),
            ('camera_0/color/image',       '/cam0/cam0/color/image_raw'),
            ('camera_0/color/camera_info', '/cam0/cam0/color/camera_info'),
            ('camera_1/depth/image',       '/cam1/cam1/aligned_depth_to_color/image_raw'),
            ('camera_1/depth/camera_info', '/cam1/cam1/color/camera_info'),
            ('camera_1/color/image',       '/cam1/cam1/color/image_raw'),
            ('camera_1/color/camera_info', '/cam1/cam1/color/camera_info'),
        ],
    )

    return LaunchDescription([
        accumulator,
        _static_tf('map',        'base_link'),
        _static_tf('base_link',  'livox_frame'),
        _static_tf('base_link',  'cam0_color_optical_frame'),
        _static_tf('base_link',  'cam1_color_optical_frame'),
        nvblox,
    ])
