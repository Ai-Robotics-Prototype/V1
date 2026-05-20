"""Launch both RealSense cameras (cam0 + cam1) with depth-aligned point clouds."""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():

    def _cam_params(name: str, serial_no_cfg) -> dict:
        return {
            'camera_name':                  name,
            'camera_namespace':             name,
            'serial_no':                    serial_no_cfg,
            'enable_color':                 'true',
            'enable_depth':                 'true',
            'rgb_camera.color_profile':     '640,480,30',
            'depth_module.depth_profile':   '640,480,30',
            'pointcloud.enable':            'true',
            'align_depth.enable':           'true',
            'publish_tf':                   'true',
            'tf_publish_rate':              '0.0',
        }

    serial0 = LaunchConfiguration('serial_no_cam0')
    serial1 = LaunchConfiguration('serial_no_cam1')

    cam0_node = Node(
        package='realsense2_camera',
        namespace='cam0',
        name='cam0',
        executable='realsense2_camera_node',
        parameters=[_cam_params('cam0', serial0)],
        output='screen',
        emulate_tty=True,
    )

    cam1_node = Node(
        package='realsense2_camera',
        namespace='cam1',
        name='cam1',
        executable='realsense2_camera_node',
        parameters=[_cam_params('cam1', serial1)],
        output='screen',
        emulate_tty=True,
    )

    return LaunchDescription([
        DeclareLaunchArgument(
            'serial_no_cam0', default_value="''",
            description='Serial number of cam0 (empty = first available)'),
        DeclareLaunchArgument(
            'serial_no_cam1', default_value="''",
            description='Serial number of cam1 (empty = second available)'),
        cam0_node,
        cam1_node,
    ])
