#!/usr/bin/env python3
"""Broadcast static TFs from /opt/cobot/calibration/extrinsics.yaml.

Reads the YAML produced by calibrate_extrinsics.py on startup and publishes
the workspace→camera/lidar/base_link transforms. Missing or unreadable YAML
falls back to identity transforms so the rest of the stack can still come
up (useful before calibration has been run).

TF layout:
    workspace ─┬─ cam0_color_optical_frame
               ├─ cam1_color_optical_frame
               ├─ livox_frame
               └─ base_link
"""
import os

import rclpy
from geometry_msgs.msg import TransformStamped
from rclpy.node import Node
from tf2_ros import StaticTransformBroadcaster

import yaml

CAL_YAML = "/opt/cobot/calibration/extrinsics.yaml"


def _invert_quat_trans(quat_xyzw, trans):
    """Return (q_inv, t_inv) for the inverse rigid transform."""
    from scipy.spatial.transform import Rotation as R
    Rm = R.from_quat(quat_xyzw).as_matrix()
    Ri = Rm.T
    ti = -Ri @ trans
    qi = R.from_matrix(Ri).as_quat()
    return qi, ti


def _identity():
    return ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0])


def _parse(node):
    """Yield (parent, child, translation, rotation) tuples from the YAML."""
    import numpy as np
    from scipy.spatial.transform import Rotation as R

    cfg = {}
    if os.path.isfile(CAL_YAML):
        try:
            with open(CAL_YAML, "r") as f:
                cfg = yaml.safe_load(f) or {}
            node.get_logger().info(f"loaded {CAL_YAML}")
        except Exception as e:
            node.get_logger().warn(f"failed to read {CAL_YAML}: {e}; using identity")
    else:
        node.get_logger().warn(
            f"{CAL_YAML} not found — broadcasting identity TFs until "
            "calibration has been run")

    # Pull each transform with an identity fallback.
    def get(key):
        block = cfg.get(key) or {}
        t = block.get("translation") or [0.0, 0.0, 0.0]
        q = block.get("rotation")    or [0.0, 0.0, 0.0, 1.0]
        return list(t), list(q)

    t_c0_ws,  q_c0_ws  = get("cam0_to_workspace")
    t_c0_c1,  q_c0_c1  = get("cam0_to_cam1")
    t_c0_lid, q_c0_lid = get("cam0_to_lidar")
    t_ws_bl,  q_ws_bl  = get("workspace_to_robot_base")

    # The calibration YAML is camera-centric: cam0_to_workspace gives the
    # tag pose in camera coordinates. The TF tree wants workspace as
    # parent, so invert it.
    q_ws_c0, t_ws_c0 = _invert_quat_trans(q_c0_ws, np.array(t_c0_ws))

    # workspace -> cam1 = workspace -> cam0 -> cam1
    Rm_ws_c0 = R.from_quat(q_ws_c0).as_matrix()
    Rm_c0_c1 = R.from_quat(q_c0_c1).as_matrix()
    Rm_ws_c1 = Rm_ws_c0 @ Rm_c0_c1
    t_ws_c1  = (Rm_ws_c0 @ np.array(t_c0_c1)) + np.array(t_ws_c0)
    q_ws_c1  = R.from_matrix(Rm_ws_c1).as_quat()

    # workspace -> lidar = workspace -> cam0 -> lidar
    Rm_c0_lid = R.from_quat(q_c0_lid).as_matrix()
    Rm_ws_lid = Rm_ws_c0 @ Rm_c0_lid
    t_ws_lid  = (Rm_ws_c0 @ np.array(t_c0_lid)) + np.array(t_ws_c0)
    q_ws_lid  = R.from_matrix(Rm_ws_lid).as_quat()

    return [
        ("workspace", "cam0_color_optical_frame", t_ws_c0,  q_ws_c0),
        ("workspace", "cam1_color_optical_frame", t_ws_c1,  q_ws_c1),
        ("workspace", "livox_frame",              t_ws_lid, q_ws_lid),
        ("workspace", "base_link",                t_ws_bl,  q_ws_bl),
    ]


def _make_tf(stamp, parent, child, t, q):
    msg = TransformStamped()
    msg.header.stamp    = stamp
    msg.header.frame_id = parent
    msg.child_frame_id  = child
    msg.transform.translation.x = float(t[0])
    msg.transform.translation.y = float(t[1])
    msg.transform.translation.z = float(t[2])
    msg.transform.rotation.x    = float(q[0])
    msg.transform.rotation.y    = float(q[1])
    msg.transform.rotation.z    = float(q[2])
    msg.transform.rotation.w    = float(q[3])
    return msg


class TFBroadcaster(Node):
    def __init__(self):
        super().__init__("tf_broadcaster_extrinsics")
        self._bcast = StaticTransformBroadcaster(self)
        tfs = _parse(self)
        stamp = self.get_clock().now().to_msg()
        msgs = [_make_tf(stamp, p, c, t, q) for (p, c, t, q) in tfs]
        self._bcast.sendTransform(msgs)
        for p, c, t, q in tfs:
            self.get_logger().info(
                f"{p} -> {c}: t={['{:+.3f}'.format(x) for x in t]} "
                f"q={['{:+.3f}'.format(x) for x in q]}")


def main(args=None):
    rclpy.init(args=args)
    node = TFBroadcaster()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
