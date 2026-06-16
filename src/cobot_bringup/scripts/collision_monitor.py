#!/usr/bin/env python3
"""collision_monitor — capsule-vs-bbox proximity check between the live
robot pose and the LiDAR-detected objects.

INPUTS
  /lidar_objects/identified  (lidar_object_identifier_msgs/IdentifiedObjectArray)
  /joint_states              (sensor_msgs/JointState)        — optional; default home pose if absent

OUTPUTS
  /collision/objects         (std_msgs/String — JSON, ~10 Hz)
  /collision/status          (std_msgs/String — JSON, ~10 Hz)

JSON payload on /collision/objects:
{
  "objects": [
    {"id": int, "name": "...", "static": bool,
     "center": {x,y,z}, "dimensions": {x,y,z}, "orientation": {x,y,z,w},
     "min_distance_m": float, "nearest_link": "...",
     "status": "clear" | "warning" | "collision"},
    ...
  ]
}

/collision/status:  {"status": "clear"|"warning"|"collision", "count": int,
                    "min_distance_m": float}

Thresholds / reach (configurable via ROS params):
  reach_radius_m       1.4         Estun S10-140 horizontal reach
  reach_z_max_m        2.5         vertical cap of the monitored cylinder
  warn_distance_m      0.150       capsule-to-bbox below this → warning
  critical_distance_m  0.050       capsule-to-bbox below this → collision
  process_rate_hz      10.0
"""

from __future__ import annotations

import json
import math
import os
from typing import List, Optional

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import String

from lidar_object_identifier_msgs.msg import IdentifiedObjectArray


# ───────────────────────────────────────────────────────────────────────
# S10-140 kinematic chain (matches /robot/urdf as of 2026-06-16)
#   Joint origins are parent-frame translations applied BEFORE the
#   axis-aligned rotation by the joint angle.
# ───────────────────────────────────────────────────────────────────────

# Per-joint (translation, axis) — index 0 is J1 (base yaw).
JOINT_CHAIN = [
    # parent_xyz                 axis      label              radius_m
    ((0.0,   0.0,    0.186),  (0, 0, 1), 'base/shoulder',  0.150),
    ((0.0,   0.221,  0.0),    (0, 1, 0), 'upper_arm',      0.115),
    ((0.0,   0.0,    0.700),  (0, 1, 0), 'forearm',        0.090),
    ((0.0,   0.175,  0.700),  (0, 0, 1), 'wrist1',         0.075),
    ((0.0,   0.0,    0.1615), (0, 1, 0), 'wrist2',         0.065),
    ((0.0,   0.0,    0.1505), (0, 0, 1), 'flange/tool',    0.080),
]

# Default joint angles (radians) — straight up at zero pose.
HOME_POSE = [0.0] * 6
EXPECTED_JOINT_NAMES = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6']


def axis_angle_matrix(axis, theta):
    """Right-handed rotation matrix for the given URDF axis at angle theta."""
    ax, ay, az = axis
    c, s = math.cos(theta), math.sin(theta)
    t = 1.0 - c
    return np.array([
        [t * ax * ax + c,       t * ax * ay - s * az, t * ax * az + s * ay],
        [t * ax * ay + s * az,  t * ay * ay + c,      t * ay * az - s * ax],
        [t * ax * az - s * ay,  t * ay * az + s * ax, t * az * az + c     ],
    ], dtype=np.float64)


def forward_kinematics(joint_positions):
    """Walk JOINT_CHAIN to produce a list of world-frame link origin points
    in the order: [base, J1, J2, J3, J4, J5, J6/tool]. The capsule for
    link i is the segment from points[i] to points[i+1]."""
    R = np.eye(3)
    p = np.array([0.0, 0.0, 0.0])
    points = [p.copy()]
    for i, (xyz, axis, _label, _r) in enumerate(JOINT_CHAIN):
        # Translate in current frame
        p = p + R @ np.array(xyz)
        # Rotate by joint angle around the local axis
        theta = float(joint_positions[i]) if i < len(joint_positions) else 0.0
        R = R @ axis_angle_matrix(axis, theta)
        points.append(p.copy())
    return points  # length 7


def closest_point_on_segment(a, b, p):
    """Closest point on segment a→b to point p."""
    ab = b - a
    denom = float(np.dot(ab, ab))
    if denom < 1e-12:
        return a.copy()
    t = float(np.dot(p - a, ab) / denom)
    t = max(0.0, min(1.0, t))
    return a + t * ab


def aabb_clamp(p, c, half):
    """Closest point on an axis-aligned bbox (center c, half-extents 'half') to p."""
    return np.array([
        min(max(p[0], c[0] - half[0]), c[0] + half[0]),
        min(max(p[1], c[1] - half[1]), c[1] + half[1]),
        min(max(p[2], c[2] - half[2]), c[2] + half[2]),
    ])


def capsule_to_aabb_distance(seg_a, seg_b, radius, center, dims):
    """Approximate min distance from a capsule (segment + radius) to an
    AABB (center + dims). Sample the segment at SAMPLES points, take the
    minimum of (point→nearest-aabb-point) distances, subtract radius."""
    SAMPLES = 7
    half = (np.array(dims) * 0.5)
    c = np.array(center)
    seg_a = np.array(seg_a)
    seg_b = np.array(seg_b)
    best = float('inf')
    for k in range(SAMPLES):
        t = k / (SAMPLES - 1) if SAMPLES > 1 else 0.5
        pk = seg_a + (seg_b - seg_a) * t
        q  = aabb_clamp(pk, c, half)
        d  = float(np.linalg.norm(pk - q))
        if d < best:
            best = d
    return max(0.0, best - radius)


# ───────────────────────────────────────────────────────────────────────
# Node
# ───────────────────────────────────────────────────────────────────────


class CollisionMonitor(Node):
    def __init__(self):
        super().__init__('collision_monitor')

        self.declare_parameter('reach_radius_m',     1.4)
        self.declare_parameter('reach_z_max_m',      2.5)
        self.declare_parameter('warn_distance_m',    0.150)
        self.declare_parameter('critical_distance_m', 0.050)
        self.declare_parameter('process_rate_hz',    10.0)

        self.reach_r   = float(self.get_parameter('reach_radius_m').value)
        self.reach_z   = float(self.get_parameter('reach_z_max_m').value)
        self.warn_d    = float(self.get_parameter('warn_distance_m').value)
        self.crit_d    = float(self.get_parameter('critical_distance_m').value)
        rate           = float(self.get_parameter('process_rate_hz').value)

        self.joints: List[float] = list(HOME_POSE)
        self.latest_objs: List = []
        self.have_joints = False
        self.last_obj_stamp: Optional[float] = None

        self.create_subscription(
            IdentifiedObjectArray, '/lidar_objects/identified',
            self._on_objects, 5)
        self.create_subscription(
            JointState, '/joint_states', self._on_joints, 5)

        self.objects_pub = self.create_publisher(String, '/collision/objects', 5)
        self.status_pub  = self.create_publisher(String, '/collision/status', 5)

        self.create_timer(1.0 / max(rate, 1.0), self._tick)

        self.get_logger().info(
            f'collision_monitor ready. reach={self.reach_r:.2f} m, '
            f'warn={self.warn_d*1000:.0f} mm, crit={self.crit_d*1000:.0f} mm, '
            f'process_rate={rate} Hz')

    def _on_joints(self, msg: JointState):
        # Honor URDF joint ordering; fall back to positional if the names
        # don't match what we expect.
        idx_by_name = {n: i for i, n in enumerate(msg.name or [])}
        if all(jn in idx_by_name for jn in EXPECTED_JOINT_NAMES):
            self.joints = [float(msg.position[idx_by_name[jn]]) for jn in EXPECTED_JOINT_NAMES]
        else:
            n = min(6, len(msg.position))
            self.joints = [float(msg.position[i]) for i in range(n)] + [0.0] * (6 - n)
        self.have_joints = True

    def _on_objects(self, msg: IdentifiedObjectArray):
        self.latest_objs = list(msg.objects)
        self.last_obj_stamp = self.get_clock().now().nanoseconds * 1e-9

    def _tick(self):
        points = forward_kinematics(self.joints)
        # Capsules: pair (point[i], point[i+1], radius_i)
        capsules = [(points[i], points[i + 1], JOINT_CHAIN[i][3]) for i in range(6)]
        capsule_labels = [c[2] for c in JOINT_CHAIN]

        out = []
        overall_min = float('inf')
        for o in self.latest_objs:
            cx, cy, cz = o.center.x, o.center.y, o.center.z
            dx, dy, dz = o.dimensions.x, o.dimensions.y, o.dimensions.z
            # Reach filter — quick reject in the XY plane + Z cap.
            footprint_r = math.hypot(cx, cy)
            if footprint_r - max(dx, dy) * 0.5 > self.reach_r:
                continue
            if cz - dz * 0.5 > self.reach_z:
                continue
            # Capsule-to-AABB distances (orientation approximation: AABB)
            best_d = float('inf')
            best_link = ''
            for (a, b, r), label in zip(capsules, capsule_labels):
                d = capsule_to_aabb_distance(a, b, r, (cx, cy, cz), (dx, dy, dz))
                if d < best_d:
                    best_d = d
                    best_link = label
            if best_d < self.crit_d:
                status = 'collision'
            elif best_d < self.warn_d:
                status = 'warning'
            else:
                status = 'clear'
            overall_min = min(overall_min, best_d)
            out.append({
                'id':              int(o.id),
                'name':            str(o.identified_name or ''),
                'identified_as':   str(o.identified_as or 'unknown'),
                'confidence':      float(o.identification_confidence),
                'frames_observed': int(o.frames_observed),
                'static':          bool(o.frames_observed > 30),
                'center':          {'x': float(cx), 'y': float(cy), 'z': float(cz)},
                'dimensions':      {'x': float(dx), 'y': float(dy), 'z': float(dz)},
                'orientation':     {
                    'x': float(o.orientation.x), 'y': float(o.orientation.y),
                    'z': float(o.orientation.z), 'w': float(o.orientation.w),
                },
                'min_distance_m':  float(best_d),
                'nearest_link':    best_link,
                'status':          status,
            })

        out.sort(key=lambda r: r['min_distance_m'])
        overall_status = 'clear'
        if any(r['status'] == 'collision' for r in out):
            overall_status = 'collision'
        elif any(r['status'] == 'warning' for r in out):
            overall_status = 'warning'

        self.objects_pub.publish(String(data=json.dumps({
            'objects': out,
            'reach_radius_m':    self.reach_r,
            'warn_distance_m':   self.warn_d,
            'critical_distance_m': self.crit_d,
            'have_joints':       self.have_joints,
        })))
        self.status_pub.publish(String(data=json.dumps({
            'status': overall_status,
            'count':  len(out),
            'min_distance_m': (overall_min if overall_min != float('inf') else None),
        })))


def main():
    rclpy.init()
    try:
        node = CollisionMonitor()
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.shutdown()


if __name__ == '__main__':
    main()
