"""nvblox GPU TSDF reconstruction + nvblox→/ws/mesh JSON adapter.

Pipeline (the accumulator + LiDAR driver are separate services):

    /lidar/points_dense                          (roboai-accumulator)
    /cam0/cam0/aligned_depth_to_color/image_raw  (roboai-cameras)
    /cam0/cam0/color/image_raw                   (roboai-cameras)
                  │
                  v
          nvblox_node  (GPU TSDF + marching cubes)
                  │
        /nvblox_node/mesh   (nvblox_msgs/Mesh)
                  │
                  v
        nvblox_mesh_adapter  (per-block flatten + height colours
                              + LiDAR-detection highlight + decimation)
                  │
        /reconstruction/mesh_json   (std_msgs/String)
                  │
                  v
          dashboard /ws/mesh  →  LidarPanel ReconstructionMesh

Static TFs published here are the missing parts of the tree:
    livox_frame -> base_link  (identity — LiDAR is on the robot base)
    map         -> livox_frame (identity — stationary setup, no odom)

The cam0/cam1 TFs are published by roboai-tf (sensor_tf_publisher.py);
DON'T duplicate them here or cam0 would have two parents.

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
    adapter_py = os.path.join(share, 'scripts', 'nvblox_mesh_adapter.py')

    nvblox = Node(
        package='nvblox_ros', executable='nvblox_node',
        name='nvblox_node', output='screen',
        parameters=[cfg],
        remappings=[
            ('pointcloud',                 '/lidar/points_dense'),
            ('camera_0/depth/image',       '/cam0/cam0/aligned_depth_to_color/image_raw'),
            ('camera_0/depth/camera_info', '/cam0/cam0/aligned_depth_to_color/camera_info'),
            ('camera_0/color/image',       '/cam0/cam0/color/image_raw'),
            ('camera_0/color/camera_info', '/cam0/cam0/color/camera_info'),
        ],
    )

    # Adapter converts the block-based nvblox mesh into the same JSON
    # payload the dashboard /ws/mesh already understands.
    adapter = ExecuteProcess(
        cmd=['python3', adapter_py, '--ros-args',
             '-p', 'mesh_topic:=/nvblox_node/mesh',
             '-p', 'output_topic:=/reconstruction/mesh_json',
             '-p', 'detections_topic:=/perception/lidar_detections',
             '-p', 'max_triangles_json:=10000',
             '-p', 'mesh_radius_m:=2.0',
             '-p', 'object_highlight_radius_m:=0.05'],
        output='screen',
    )

    return LaunchDescription([
        _static_tf('map',         'livox_frame'),
        _static_tf('livox_frame', 'base_link'),
        # RealSense publishes depth/color with header.frame_id =
        # "camera_color_optical_frame" (the driver's default, despite the
        # ROS namespace), but sensor_tf_publisher publishes the
        # prefixed cam0_color_optical_frame. Bridge them so nvblox can
        # resolve the depth frame against the TF tree — without this,
        # every depth frame is silently dropped.
        _static_tf('cam0_color_optical_frame', 'camera_color_optical_frame'),
        _static_tf('cam0_color_optical_frame', 'camera_depth_optical_frame'),
        nvblox,
        adapter,
    ])
