#!/usr/bin/env python3
"""Broadcast TFs from livox_frame to the camera optical frames.

Reads src/cobot_bringup/config/sensor_transforms.yaml (or the installed
copy under share/cobot_bringup/config/) on startup and publishes one
transform per camera. Missing or unreadable YAML falls back to the
standard optical->ROS rotation with zero translation so the rest of
the stack can still come up.

The transforms ARE physically static (cameras don't move), but this
node uses the dynamic TransformBroadcaster + a periodic timer rather
than StaticTransformBroadcaster. Reason: StaticTransformBroadcaster
publishes once on /tf_static with TRANSIENT_LOCAL durability, but the
local DDS implementation has been losing those messages for nodes that
subscribe after the publisher (perception_fusion was hitting this for
days). Re-broadcasting at 0.5 Hz on /tf is verbose but reliable.

TF tree:
    livox_frame ─┬─ cam0_color_optical_frame
                 └─ cam1_color_optical_frame
"""
import os

import rclpy
import yaml
from geometry_msgs.msg import TransformStamped
from rclpy.node import Node
from tf2_ros import TransformBroadcaster


# Standard optical -> ROS quaternion: rotation that takes a vector in the
# camera optical frame (X-right, Y-down, Z-forward) and re-expresses it
# in the ROS body frame (X-forward, Y-left, Z-up). This produces the
# rotation matrix [[0,0,1],[-1,0,0],[0,-1,0]]. Note the qw sign matters
# — (0.5,-0.5,0.5,+0.5) is a different rotation (cam X -> lidar +Z).
_OPTICAL_TO_ROS_Q = (0.5, -0.5, 0.5, -0.5)

_CONFIG_CANDIDATES = [
    '/home/teddy/cobot_ws/install/cobot_bringup/share/cobot_bringup/config/sensor_transforms.yaml',
    '/home/teddy/cobot_ws/src/cobot_bringup/config/sensor_transforms.yaml',
    os.path.expanduser('~/cobot_ws/src/cobot_bringup/config/sensor_transforms.yaml'),
]


def _load_config(logger):
    for path in _CONFIG_CANDIDATES:
        if os.path.isfile(path):
            try:
                with open(path, 'r') as f:
                    cfg = yaml.safe_load(f) or {}
                logger.info(f'loaded {path}')
                return cfg, path
            except Exception as e:
                logger.warn(f'failed to read {path}: {e}')
    logger.warn(
        'sensor_transforms.yaml not found — falling back to identity '
        'translation + standard optical-to-ROS rotation for both cameras')
    return {}, None


def _make_tf(stamp, child, translation, rotation) -> TransformStamped:
    t = TransformStamped()
    t.header.stamp    = stamp
    t.header.frame_id = 'livox_frame'
    t.child_frame_id  = child
    t.transform.translation.x = float(translation[0])
    t.transform.translation.y = float(translation[1])
    t.transform.translation.z = float(translation[2])
    t.transform.rotation.x    = float(rotation[0])
    t.transform.rotation.y    = float(rotation[1])
    t.transform.rotation.z    = float(rotation[2])
    t.transform.rotation.w    = float(rotation[3])
    return t


class SensorTFPublisher(Node):
    def __init__(self):
        super().__init__('sensor_tf_publisher')
        self._br = TransformBroadcaster(self)
        cfg, src = _load_config(self.get_logger())

        self._entries = []
        for key, child in [('cam0_to_lidar', 'cam0_color_optical_frame'),
                           ('cam1_to_lidar', 'cam1_color_optical_frame')]:
            block = cfg.get(key) or {}
            trans = block.get('translation') or [0.0, 0.0, 0.0]
            rot   = block.get('rotation')    or list(_OPTICAL_TO_ROS_Q)
            self._entries.append((child, trans, rot))
            self.get_logger().info(
                f'livox_frame -> {child}: '
                f't=[{trans[0]:+.3f},{trans[1]:+.3f},{trans[2]:+.3f}] '
                f'q=[{rot[0]:+.3f},{rot[1]:+.3f},{rot[2]:+.3f},{rot[3]:+.3f}]')

        # Re-broadcast every 2 s so late-joining subscribers receive the
        # transforms even when /tf_static didn't get through. Stamped
        # with current time on each tick so TF doesn't discard them as
        # stale.
        self._broadcast_now()
        self.create_timer(2.0, self._broadcast_now)
        self.get_logger().info(
            f'broadcasting {len(self._entries)} TF(s) at 0.5 Hz'
            + (f' from {src}' if src else ''))

    def _broadcast_now(self):
        stamp = self.get_clock().now().to_msg()
        tfs = [_make_tf(stamp, child, trans, rot)
               for child, trans, rot in self._entries]
        if tfs:
            self._br.sendTransform(tfs)


def main(args=None):
    rclpy.init(args=args)
    node = SensorTFPublisher()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
