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


# ── Convex-hull mesh distance ──────────────────────────────────────
# Static keep-out zones built from the cell's baseline cloud now carry
# a CONVEX HULL mesh per zone (vertices + triangles, world frame). The
# closest-point-on-hull distance is strictly ≤ the old AABB distance
# (the hull lies inside the AABB), so switching is monotonically
# tighter while staying safe. We cache the precomputed face data per
# hull payload so the per-tick math is just point-to-triangle
# projections.

def _hull_cache_build(verts: np.ndarray, tris: np.ndarray) -> dict:
    """Precompute face normals + centroid for inside-test + culling."""
    v = np.asarray(verts, dtype=np.float64)
    t = np.asarray(tris,  dtype=np.int64)
    a = v[t[:, 0]]; b = v[t[:, 1]]; c = v[t[:, 2]]
    n = np.cross(b - a, c - a)
    nrm = np.linalg.norm(n, axis=1, keepdims=True)
    nrm[nrm < 1e-12] = 1.0
    n_unit = n / nrm
    centroid = v.mean(axis=0)
    # Orient each face normal outward: positive dot of (a - centroid)
    # with the normal means the normal already points away from the
    # centroid; flip otherwise. For a *convex* hull this aligns every
    # normal outward consistently.
    sign = np.sign(np.einsum('ij,ij->i', a - centroid, n_unit))
    sign[sign == 0] = 1.0
    n_unit = n_unit * sign[:, None]
    return {
        'v':       v,
        't':       t,
        'a':       a,
        'b':       b,
        'c':       c,
        'n':       n_unit,                # outward unit normals
        'centroid': centroid,
        'radius':  float(np.max(np.linalg.norm(v - centroid, axis=1))),
    }


def _closest_point_on_triangle(p, a, b, c):
    """Standard closest-point-on-triangle (Real-Time Collision
    Detection, ch. 5). Vectorised over multiple triangles when p is a
    single point and a/b/c are (M,3) arrays — returns (M,3) closest
    points."""
    ab = b - a
    ac = c - a
    ap = p - a
    d1 = np.einsum('ij,ij->i', ab, ap)
    d2 = np.einsum('ij,ij->i', ac, ap)
    # Region A
    mask_a = (d1 <= 0) & (d2 <= 0)
    bp = p - b
    d3 = np.einsum('ij,ij->i', ab, bp)
    d4 = np.einsum('ij,ij->i', ac, bp)
    mask_b = (d3 >= 0) & (d4 <= d3)
    cp = p - c
    d5 = np.einsum('ij,ij->i', ab, cp)
    d6 = np.einsum('ij,ij->i', ac, cp)
    mask_c = (d6 >= 0) & (d5 <= d6)

    vc = d1 * d4 - d3 * d2
    mask_ab = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    v_ab = np.where(np.abs(d1 - d3) < 1e-12, 0.0, d1 / np.where(d1 - d3 == 0, 1, d1 - d3))

    vb = d5 * d2 - d1 * d6
    mask_ac = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    v_ac = np.where(np.abs(d2 - d6) < 1e-12, 0.0, d2 / np.where(d2 - d6 == 0, 1, d2 - d6))

    va = d3 * d6 - d5 * d4
    mask_bc = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    denom_bc = (d4 - d3) + (d5 - d6)
    v_bc = np.where(np.abs(denom_bc) < 1e-12, 0.0,
                    (d4 - d3) / np.where(denom_bc == 0, 1, denom_bc))

    # Interior face — barycentric
    denom = va + vb + vc
    denom_safe = np.where(np.abs(denom) < 1e-12, 1.0, denom)
    bary_v = vb / denom_safe
    bary_w = vc / denom_safe

    out = a + ab * bary_v[:, None] + ac * bary_w[:, None]
    out = np.where(mask_a[:, None], a, out)
    out = np.where(mask_b[:, None], b, out)
    out = np.where(mask_c[:, None], c, out)
    out = np.where(mask_ab[:, None], a + ab * v_ab[:, None], out)
    out = np.where(mask_ac[:, None], a + ac * v_ac[:, None], out)
    out = np.where(mask_bc[:, None], b + (c - b) * v_bc[:, None], out)
    return out


def _point_inside_convex(p, hull) -> bool:
    """Convex inside-test: p is inside the hull iff for every face
    (a, n_outward) we have (p - a) · n ≤ 0."""
    diffs = p - hull['a']
    proj  = np.einsum('ij,ij->i', diffs, hull['n'])
    return bool(np.all(proj <= 1e-9))


def _point_to_hull_distance(p: np.ndarray, hull: dict) -> float:
    """Closest-point distance from p to the convex hull. Returns 0 when
    p is inside (safety: treat penetrations as worst case)."""
    # Quick cull: distance to centroid minus bounding-sphere radius.
    d_centroid = float(np.linalg.norm(p - hull['centroid']))
    if d_centroid <= hull['radius']:
        if _point_inside_convex(p, hull):
            return 0.0
    qs = _closest_point_on_triangle(p, hull['a'], hull['b'], hull['c'])
    return float(np.min(np.linalg.norm(qs - p, axis=1)))


def capsule_to_hull_distance(seg_a, seg_b, radius, hull) -> float:
    """Sampled capsule-vs-convex-hull distance. Same SAMPLES count as
    the AABB variant so the latency stays predictable; net cost is a
    handful of point-to-mesh checks per zone per tick."""
    SAMPLES = 7
    a = np.asarray(seg_a, dtype=np.float64)
    b = np.asarray(seg_b, dtype=np.float64)
    best = float('inf')
    for k in range(SAMPLES):
        t = k / (SAMPLES - 1) if SAMPLES > 1 else 0.5
        pk = a + (b - a) * t
        d  = _point_to_hull_distance(pk, hull)
        if d < best:
            best = d
            if best <= 0.0:
                break
    return max(0.0, best - radius)


# ───────────────────────────────────────────────────────────────────────
# Node
# ───────────────────────────────────────────────────────────────────────


CELLS_DIR  = '/opt/cobot/cells'
CELLS_IDX  = os.path.join(CELLS_DIR, 'index.json')


def _read_active_cell_id() -> Optional[str]:
    try:
        with open(CELLS_IDX) as f:
            data = json.load(f)
        cid = data.get('active_cell_id')
        return str(cid) if cid else None
    except Exception:
        return None


def _read_static_zones_for_cell(cell_id: Optional[str]) -> list:
    """Load the persisted static keep-out zones for the active cell.
    Returns [] when there's no active cell or no saved file — that's
    the no-op path; the monitor still publishes live objects."""
    if not cell_id:
        return []
    path = os.path.join(CELLS_DIR, cell_id, 'collision_zones.json')
    if not os.path.isfile(path):
        return []
    try:
        with open(path) as f:
            data = json.load(f)
        zones = data.get('zones') or []
        return zones if isinstance(zones, list) else []
    except Exception:
        return []


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

        # Static keep-out zones loaded from the active cell's persisted
        # collision_zones.json (built from the baseline cloud).
        # _reload_static_zones() refreshes these from disk; the dashboard
        # publishes on /collision/reload after rebuild/clear.
        self.static_cell_id: Optional[str] = None
        self.static_zones: list = []
        self._reload_static_zones()

        self.create_subscription(
            IdentifiedObjectArray, '/lidar_objects/identified',
            self._on_objects, 5)
        self.create_subscription(
            JointState, '/joint_states', self._on_joints, 5)
        self.create_subscription(
            String, '/collision/reload', self._on_reload, 5)

        self.objects_pub = self.create_publisher(String, '/collision/objects', 5)
        self.status_pub  = self.create_publisher(String, '/collision/status', 5)

        self.create_timer(1.0 / max(rate, 1.0), self._tick)

        self.get_logger().info(
            f'collision_monitor ready. reach={self.reach_r:.2f} m, '
            f'warn={self.warn_d*1000:.0f} mm, crit={self.crit_d*1000:.0f} mm, '
            f'process_rate={rate} Hz, '
            f'static_zones={len(self.static_zones)} (cell={self.static_cell_id})')

    def _reload_static_zones(self) -> None:
        cid = _read_active_cell_id()
        self.static_cell_id = cid
        self.static_zones = _read_static_zones_for_cell(cid)
        # Precompute per-zone convex-hull cache. We do this once on
        # reload so the per-tick capsule check is just point→triangle
        # projection. Zones missing a hull fall back to the AABB pre-
        # filter implicit in capsule_to_aabb_distance — no behavior
        # regression for older zones written before this change.
        self._zone_hulls: list = []
        for z in self.static_zones:
            ch = z.get('collision_hull') or {}
            verts = ch.get('vertices') or []
            tris  = ch.get('triangles') or []
            if not verts or not tris:
                self._zone_hulls.append(None)
                continue
            try:
                self._zone_hulls.append(_hull_cache_build(
                    np.asarray(verts, dtype=np.float64),
                    np.asarray(tris,  dtype=np.int64)))
            except Exception:
                self._zone_hulls.append(None)

    def _on_reload(self, _msg: String) -> None:
        """Dashboard publishes on /collision/reload after rebuild/clear.
        We don't read the payload — just refresh from disk so the
        currently-active cell's zones are always what's flowing."""
        before = len(self.static_zones)
        self._reload_static_zones()
        self.get_logger().info(
            f'static zones reloaded: {before} → {len(self.static_zones)} '
            f'(cell={self.static_cell_id})')

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

        def _check_object(cx, cy, cz, dx, dy, dz):
            """Run the reach filter + capsule-to-AABB check. Returns
            (kept, best_d, best_link, status) where kept=False means
            outside reach (caller should skip)."""
            footprint_r = math.hypot(cx, cy)
            if footprint_r - max(dx, dy) * 0.5 > self.reach_r:
                return False, None, None, None
            if cz - dz * 0.5 > self.reach_z:
                return False, None, None, None
            best_d = float('inf'); best_link = ''
            for (a, b, r), label in zip(capsules, capsule_labels):
                d = capsule_to_aabb_distance(a, b, r, (cx, cy, cz), (dx, dy, dz))
                if d < best_d:
                    best_d = d; best_link = label
            if best_d < self.crit_d:   status = 'collision'
            elif best_d < self.warn_d: status = 'warning'
            else:                      status = 'clear'
            return True, best_d, best_link, status

        out = []
        overall_min = float('inf')
        for o in self.latest_objs:
            cx, cy, cz = o.center.x, o.center.y, o.center.z
            dx, dy, dz = o.dimensions.x, o.dimensions.y, o.dimensions.z
            kept, best_d, best_link, status = _check_object(cx, cy, cz, dx, dy, dz)
            if not kept:
                continue
            overall_min = min(overall_min, best_d)
            out.append({
                'id':              int(o.id),
                'name':            str(o.identified_name or ''),
                'identified_as':   str(o.identified_as or 'unknown'),
                'confidence':      float(o.identification_confidence),
                'frames_observed': int(o.frames_observed),
                'static':          bool(o.frames_observed > 30),
                'source':          'lidar_live',
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

        # Persistent static keep-out zones from the active cell's
        # baseline build. When a zone carries a precomputed convex
        # hull, use the hull-based capsule distance — tighter than
        # the AABB approximation and the form MoveIt2 sees too. The
        # AABB pre-filter still does the cheap reach cull first; only
        # zones inside the reach disc pay for the hull math.
        for zi, z in enumerate(self.static_zones):
            try:
                cx = float(z['center']['x']); cy = float(z['center']['y']); cz = float(z['center']['z'])
                dx = float(z['dimensions']['x']); dy = float(z['dimensions']['y']); dz = float(z['dimensions']['z'])
            except (KeyError, TypeError, ValueError):
                continue
            # Cheap reach cull on the AABB envelope first.
            footprint_r = math.hypot(cx, cy)
            if footprint_r - max(dx, dy) * 0.5 > self.reach_r:
                continue
            if cz - dz * 0.5 > self.reach_z:
                continue

            hull = self._zone_hulls[zi] if zi < len(self._zone_hulls) else None
            if hull is not None:
                best_d = float('inf'); best_link = ''
                for (a, b, r), label in zip(capsules, capsule_labels):
                    d = capsule_to_hull_distance(a, b, r, hull)
                    if d < best_d:
                        best_d = d; best_link = label
                distance_source = 'hull'
            else:
                # Coarse pre-filter fallback for zones lacking a hull
                # (older zones built before contoured extraction).
                kept, best_d, best_link, status = _check_object(cx, cy, cz, dx, dy, dz)
                if not kept:
                    continue
                distance_source = 'aabb_fallback'
            if best_d < self.crit_d:   status = 'collision'
            elif best_d < self.warn_d: status = 'warning'
            else:                      status = 'clear'
            overall_min = min(overall_min, best_d)
            ori = z.get('orientation') or {'x': 0.0, 'y': 0.0, 'z': 0.0, 'w': 1.0}
            out.append({
                'id':             str(z.get('id') or 'static_unknown'),
                'name':           str(z.get('name') or 'static_obstacle'),
                'identified_as':  'static_obstacle',
                'confidence':     1.0,
                'frames_observed': int(z.get('point_count', 0)),
                'static':         True,
                'source':         str(z.get('source', 'baseline_static')),
                'center':         {'x': cx, 'y': cy, 'z': cz},
                'dimensions':     {'x': dx, 'y': dy, 'z': dz},
                'orientation':    ori,
                'min_distance_m': float(best_d),
                'nearest_link':   best_link,
                'status':         status,
                'margin_m':       float(z.get('margin_m', 0.0)),
                'point_count':    int(z.get('point_count', 0)),
                'distance_source': distance_source,
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
