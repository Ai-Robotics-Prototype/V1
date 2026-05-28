#!/usr/bin/env python3
"""Top-down grasp pose generator from Detection3DArray.

Each detected object with a non-degenerate OBB yields three poses:
    pre_grasp  — `approach_offset_m` above the object, oriented to its yaw
    grasp      — at the object centre (slightly above to avoid collision)
    retreat    — `retreat_height_m` above the grasp

Approach is always top-down in the camera frame (the +Z axis points into
the scene for our optical-frame conventions; "above" is -Z). The gripper
opening is set to the OBB's NARROWER XY extent + `gripper_margin_m`; that
makes the gripper jaws span the short side, which is the more stable
grasp. Yaw is rotated 90° so the jaws are perpendicular to the long axis.

Publishes:
    /grasp/poses        geometry_msgs/PoseArray   — pre_grasp per object
    /grasp/candidates   std_msgs/String           — JSON with everything
                                                     dashboard needs

Once the arm is wired up and workspace_to_robot_base is filled in by
eye-hand calibration, a downstream node can transform these poses from
the camera/workspace frame to the robot base frame for execution.
"""
import json
import math

import rclpy
from geometry_msgs.msg import Pose, PoseArray
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from scipy.spatial.transform import Rotation as R
from std_msgs.msg import String
from vision_msgs.msg import Detection3DArray


def _grasp_quaternion(yaw_rad: float):
    """Top-down grasp orientation aligned to object yaw.

    In camera-optical convention the gripper points along +Z. The only
    free axis is the rotation about Z (the jaws' opening direction).
    Returns [x, y, z, w].
    """
    return R.from_euler('z', yaw_rad).as_quat()


def _pose_msg(x, y, z, qx, qy, qz, qw) -> Pose:
    p = Pose()
    p.position.x = float(x); p.position.y = float(y); p.position.z = float(z)
    p.orientation.x = float(qx); p.orientation.y = float(qy)
    p.orientation.z = float(qz); p.orientation.w = float(qw)
    return p


class GraspPlanner(Node):
    def __init__(self):
        super().__init__('grasp_planner')

        self.declare_parameter('approach_offset_m',   0.10)
        self.declare_parameter('grasp_above_m',       0.005)
        self.declare_parameter('retreat_height_m',    0.15)
        self.declare_parameter('gripper_margin_m',    0.01)
        self.declare_parameter('max_gripper_width_m', 0.085)
        self.declare_parameter('min_confidence',      0.5)
        self.declare_parameter('detections_topic',    '/perception/detections_3d')

        self.approach_off  = float(self.get_parameter('approach_offset_m').value)
        self.grasp_above   = float(self.get_parameter('grasp_above_m').value)
        self.retreat_h     = float(self.get_parameter('retreat_height_m').value)
        self.margin        = float(self.get_parameter('gripper_margin_m').value)
        self.max_width     = float(self.get_parameter('max_gripper_width_m').value)
        self.min_conf      = float(self.get_parameter('min_confidence').value)
        det_topic          = self.get_parameter('detections_topic').value

        self.create_subscription(Detection3DArray, det_topic,
                                 self._on_detections, qos_profile_sensor_data)

        self._pose_pub = self.create_publisher(PoseArray, '/grasp/poses', 5)
        self._cand_pub = self.create_publisher(String,   '/grasp/candidates', 5)

        self._log_count = 0
        self.get_logger().info(
            f'grasp_planner: approach_off={self.approach_off}m '
            f'retreat={self.retreat_h}m max_width={self.max_width}m '
            f'min_conf={self.min_conf}')

    @staticmethod
    def _quat_to_yaw(qx, qy, qz, qw) -> float:
        """Yaw component of a quaternion under ZYX intrinsic Euler."""
        # yaw = atan2(2(wz + xy), 1 - 2(y^2 + z^2))
        s = 2.0 * (qw * qz + qx * qy)
        c = 1.0 - 2.0 * (qy * qy + qz * qz)
        return math.atan2(s, c)

    def _on_detections(self, msg: Detection3DArray):
        pose_arr = PoseArray()
        pose_arr.header = msg.header
        candidates = []
        skipped = 0

        for det in msg.detections:
            if not det.results:
                skipped += 1; continue
            res = det.results[0]
            score = float(res.hypothesis.score)
            if score < self.min_conf:
                skipped += 1; continue

            pos = det.bbox.center.position
            ori = det.bbox.center.orientation
            size = det.bbox.size

            # Reject the legacy pixel-coordinate detections (huge |x|/|y|);
            # only metric-3D OBBs become grasps.
            if abs(pos.x) > 10 or abs(pos.y) > 10:
                skipped += 1; continue
            # Reject zero-extent fallbacks.
            if size.x <= 0 or size.y <= 0:
                skipped += 1; continue

            # OBB convention from depth_segment_node: size.x is the longer
            # XY extent, size.y the shorter. The jaws should grip across
            # the SHORT axis — that's a more stable grasp and a smaller
            # opening means a tighter hold.
            long_dim  = float(size.x)
            short_dim = float(size.y)
            gripper_width = short_dim + self.margin
            approach_along_long = True
            # If the short side is too wide, try gripping the other way.
            if gripper_width > self.max_width:
                gripper_width = long_dim + self.margin
                approach_along_long = False
            if gripper_width > self.max_width:
                # Object is wider than the gripper either way — emit the
                # pose anyway and let the planner reject it downstream.
                gripper_width = self.max_width

            yaw = self._quat_to_yaw(ori.x, ori.y, ori.z, ori.w)
            # Jaws perpendicular to the long axis when approaching across.
            if approach_along_long:
                grasp_yaw = yaw + math.pi / 2.0
            else:
                grasp_yaw = yaw
            qx, qy, qz, qw = _grasp_quaternion(grasp_yaw)

            # Camera-optical: -Z is "above" the table.
            pre_x, pre_y, pre_z = pos.x, pos.y, pos.z - self.approach_off
            gx,    gy,    gz    = pos.x, pos.y, pos.z - self.grasp_above
            rx,    ry,    rz    = gx,    gy,    gz   - self.retreat_h

            pose_arr.poses.append(_pose_msg(pre_x, pre_y, pre_z, qx, qy, qz, qw))

            candidates.append({
                'object_id':           str(id(det)),
                'class_name':          str(res.hypothesis.class_id),
                'confidence':          round(score, 3),
                'pre_grasp': {
                    'position':    [pre_x, pre_y, pre_z],
                    'orientation': [qx, qy, qz, qw],
                },
                'grasp': {
                    'position':    [gx, gy, gz],
                    'orientation': [qx, qy, qz, qw],
                },
                'retreat': {
                    'position':    [rx, ry, rz],
                    'orientation': [qx, qy, qz, qw],
                },
                'gripper_width_m':     round(gripper_width, 4),
                'approach_direction':  'top_down',
                'approach_along_long': approach_along_long,
                'object_yaw_rad':      round(yaw, 4),
                'grasp_yaw_rad':       round(grasp_yaw, 4),
            })

        self._pose_pub.publish(pose_arr)
        cand_msg = String()
        cand_msg.data = json.dumps({
            'frame_id':   msg.header.frame_id,
            'candidates': candidates,
        })
        self._cand_pub.publish(cand_msg)

        self._log_count += 1
        if self._log_count % 30 == 0:
            self.get_logger().info(
                f'{len(candidates)} grasp(s), skipped={skipped}')


def main(args=None):
    rclpy.init(args=args)
    node = GraspPlanner()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
