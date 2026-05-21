"""Launch both RealSense cameras (cam0 + cam1) with depth-aligned point clouds."""
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, TimerAction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():

    def _cam_params(name: str, serial_no_cfg) -> dict:
        return {
            'camera_name':                  name,
            'camera_namespace':             name,
            'serial_no':                    serial_no_cfg,
            'enable_color':                 True,
            'enable_depth':                 True,
            'rgb_camera.color_profile':     '640,480,30',
            'depth_module.depth_profile':   '640,480,30',
            'pointcloud.enable':            True,
            'align_depth.enable':           True,
            'publish_tf':                   True,
            'tf_publish_rate':              0.0,
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
            'serial_no_cam0', default_value="'134322070161'",
            description='Serial number of cam0 D435i'),
        DeclareLaunchArgument(
            'serial_no_cam1', default_value="'101622073355'",
            description='Serial number of cam1 D435i'),
        cam0_node,
        TimerAction(period=5.0, actions=[cam1_node]),
    ])
