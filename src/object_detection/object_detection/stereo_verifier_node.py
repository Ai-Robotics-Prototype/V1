#!/usr/bin/env python3
"""Cross-verify cam0 + cam1 detections, anchor each to the LiDAR surface.

Both cam0 and cam1 Detection3DArray streams are already in livox_frame
(depth_segment_node applies the cam->lidar transform), so verification
collapses to a 3D nearest-neighbour match. For each pair of estimates
of the same object we keep the cameras' XY (better lateral resolution
than the LiDAR for small targets) and replace Z with the LiDAR surface
height at that (X, Y) — so every placed object visibly sits on the
point cloud.

Subscribes:
    /perception/detections_3d        (cam0, vision_msgs/Detection3DArray)
    /perception/detections_3d_cam1   (cam1, vision_msgs/Detection3DArray)
    /lidar/points_dense              (sensor_msgs/PointCloud2)

Publishes:
    /perception/placed_objects       (std_msgs/String — JSON)

Each placed object carries enough info for the dashboard to render
verified vs single-camera objects differently:
    source           "stereo_verified" | "cam0_only" | "cam1_only"
    verified         bool
    position_lidar   [x, y, z]     (the surface-anchored estimate)
    position_cam0    [x, y, z]     (or null if cam0 didn't see it)
    position_cam1    [x, y, z]     (or null if cam1 didn't see it)
    surface_z        float         (the LiDAR-derived floor at XY)
    size             [w, h, d]
    orientation      [r, p, y]     (degrees, ZYX intrinsic)
    quat             [x, y, z, w]
    confidence       float
"""
import json
import math
import struct
import time

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2
from std_msgs.msg import String
from vision_msgs.msg import Detection3DArray


# ── PointCloud2 decode (shared shape) ─────────────────────────────────

def _decode_xyz(msg: PointCloud2) -> np.ndarray:
    fields = {f.name: f for f in msg.fields}
    if not all(k in fields for k in ('x', 'y', 'z')):
        return np.empty((0, 3), dtype=np.float32)
    step = msg.point_step
    if step <= 0:
        return np.empty((0, 3), dtype=np.float32)
    data = bytes(msg.data)
    n = len(data) // step
    if n == 0:
        return np.empty((0, 3), dtype=np.float32)
    ox, oy, oz = fields['x'].offset, fields['y'].offset, fields['z'].offset
    if oy == ox + 4 and oz == ox + 8:
        arr = np.frombuffer(data, dtype=np.uint8).reshape(n, step)
        return arr[:, ox:ox + 12].copy().view(np.float32).reshape(n, 3)
    out = np.empty((n, 3), dtype=np.float32)
    for i in range(n):
        base = i * step
        out[i, 0] = struct.unpack_from('f', data, base + ox)[0]
        out[i, 1] = struct.unpack_from('f', data, base + oy)[0]
        out[i, 2] = struct.unpack_from('f', data, base + oz)[0]
    return out


def _quat_to_euler_deg(qx, qy, qz, qw):
    """xyzw -> roll/pitch/yaw in degrees, gimbal-safe."""
    r20 = 2.0 * (qx * qz - qw * qy)
    r21 = 2.0 * (qy * qz + qw * qx)
    r22 = 1.0 - 2.0 * (qx * qx + qy * qy)
    r10 = 2.0 * (qx * qy + qw * qz)
    r00 = 1.0 - 2.0 * (qy * qy + qz * qz)
    pitch = math.asin(max(-1.0, min(1.0, -r20)))
    if abs(abs(pitch) - math.pi / 2) < 1e-3:
        roll = math.atan2(-2.0 * (qx * qy - qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz))
        yaw  = 0.0
    else:
        roll = math.atan2(r21, r22)
        yaw  = math.atan2(r10, r00)
    return [math.degrees(roll), math.degrees(pitch), math.degrees(yaw)]


def _det_to_dict(det):
    """Extract our common per-detection fields from a Detection3D."""
    if not det.results:
        return None
    res = det.results[0]
    p = det.bbox.center.position
    o = det.bbox.center.orientation
    s = det.bbox.size
    return {
        'class_name': str(res.hypothesis.class_id),
        'score':      float(res.hypothesis.score),
        'pos':        np.array([float(p.x), float(p.y), float(p.z)], dtype=np.float32),
        'quat':       (float(o.x), float(o.y), float(o.z), float(o.w)),
        'size':       (float(s.x), float(s.y), float(s.z)),
    }


# ── Node ──────────────────────────────────────────────────────────────

class StereoVerifier(Node):
    def __init__(self):
        super().__init__('stereo_verifier')

        self.declare_parameter('cam0_topic',         '/perception/detections_3d')
        self.declare_parameter('cam1_topic',         '/perception/detections_3d_cam1')
        self.declare_parameter('lidar_topic',        '/lidar/points_dense')
        self.declare_parameter('output_topic',       '/perception/placed_objects')
        # 10 cm gives generous room for cam-to-lidar transform error +
        # per-camera depth noise (2-5 cm each). Tighten once the rig is
        # extrinsically calibrated via the AprilTag tool.
        self.declare_parameter('match_distance_m',   0.10)
        self.declare_parameter('staleness_s',        0.5)
        self.declare_parameter('surface_radius_m',   0.08)
        self.declare_parameter('surface_min_pts',    5)
        self.declare_parameter('publish_hz',         10.0)
        self.declare_parameter('frame_id',           'livox_frame')

        cam0_topic    = self.get_parameter('cam0_topic').value
        cam1_topic    = self.get_parameter('cam1_topic').value
        lidar_topic   = self.get_parameter('lidar_topic').value
        out_topic     = self.get_parameter('output_topic').value
        self.match_d  = float(self.get_parameter('match_distance_m').value)
        self.stale    = float(self.get_parameter('staleness_s').value)
        self.surf_r   = float(self.get_parameter('surface_radius_m').value)
        self.surf_min = int(self.get_parameter('surface_min_pts').value)
        rate          = float(self.get_parameter('publish_hz').value)
        self.frame_id = str(self.get_parameter('frame_id').value)

        self._cam0 = []          # list of dicts (latest cam0 batch)
        self._cam1 = []
        self._cam0_t = 0.0
        self._cam1_t = 0.0
        self._lidar_xyz = None   # Nx3 cached latest cloud
        self._n_publishes = 0

        self.create_subscription(Detection3DArray, cam0_topic,
                                  self._on_cam0, qos_profile_sensor_data)
        self.create_subscription(Detection3DArray, cam1_topic,
                                  self._on_cam1, qos_profile_sensor_data)
        self.create_subscription(PointCloud2, lidar_topic,
                                  self._on_lidar, qos_profile_sensor_data)
        self._pub = self.create_publisher(String, out_topic, 5)
        self.create_timer(1.0 / max(rate, 0.5), self._publish)

        self.get_logger().info(
            f'stereo_verifier: cam0={cam0_topic} cam1={cam1_topic} '
            f'lidar={lidar_topic} -> {out_topic} '
            f'match={self.match_d}m surf_r={self.surf_r}m rate={rate}Hz')

    # ── callbacks ────────────────────────────────────────────────────

    def _on_cam0(self, msg: Detection3DArray):
        self._cam0 = [d for d in (_det_to_dict(x) for x in msg.detections) if d is not None]
        self._cam0_t = time.time()

    def _on_cam1(self, msg: Detection3DArray):
        self._cam1 = [d for d in (_det_to_dict(x) for x in msg.detections) if d is not None]
        self._cam1_t = time.time()

    def _on_lidar(self, msg: PointCloud2):
        self._lidar_xyz = _decode_xyz(msg)

    # ── verification + surface anchoring ─────────────────────────────

    def _surface_z(self, x: float, y: float):
        cloud = self._lidar_xyz
        if cloud is None or cloud.shape[0] == 0:
            return None
        dx = cloud[:, 0] - x
        dy = cloud[:, 1] - y
        mask = (dx * dx + dy * dy) < (self.surf_r * self.surf_r)
        near = cloud[mask]
        if near.shape[0] < self.surf_min:
            return None
        # Mode of Z via histogram — robust to a few stray object points
        # in the neighbourhood.
        zs = near[:, 2]
        hist, edges = np.histogram(zs, bins=20)
        peak = int(np.argmax(hist))
        return float((edges[peak] + edges[peak + 1]) * 0.5)

    def _publish(self):
        now = time.time()
        cam0 = self._cam0 if (now - self._cam0_t) < self.stale else []
        cam1 = self._cam1 if (now - self._cam1_t) < self.stale else []

        # Greedy nearest-neighbour matching by 3D distance.
        matches = []          # list of (i0, i1)
        cam0_used = set()
        cam1_used = set()
        # Build all candidate pairs, sort by distance, accept greedily.
        candidates = []
        for i, a in enumerate(cam0):
            for j, b in enumerate(cam1):
                d = float(np.linalg.norm(a['pos'] - b['pos']))
                if d < self.match_d:
                    candidates.append((d, i, j))
        candidates.sort()
        for d, i, j in candidates:
            if i in cam0_used or j in cam1_used:
                continue
            matches.append((i, j))
            cam0_used.add(i); cam1_used.add(j)

        objects = []

        # Verified pairs — average position, take the higher-confidence
        # OBB metadata.
        for (i, j) in matches:
            a, b = cam0[i], cam1[j]
            pos = ((a['pos'] + b['pos']) * 0.5).astype(np.float32)
            # Pick the higher-score's orientation + size — it's a
            # better fit by definition.
            best = a if a['score'] >= b['score'] else b
            entry = self._build_entry(
                source='stereo_verified', verified=True,
                cam0_pos=a['pos'], cam1_pos=b['pos'],
                xy_pos=pos, size=best['size'], quat=best['quat'],
                class_name=best['class_name'],
                confidence=min(1.0, max(a['score'], b['score']) * 1.2),
                track_idx=len(objects),
            )
            if entry is not None:
                objects.append(entry)

        for i, a in enumerate(cam0):
            if i in cam0_used:
                continue
            entry = self._build_entry(
                source='cam0_only', verified=False,
                cam0_pos=a['pos'], cam1_pos=None,
                xy_pos=a['pos'], size=a['size'], quat=a['quat'],
                class_name=a['class_name'], confidence=a['score'],
                track_idx=len(objects),
            )
            if entry is not None:
                objects.append(entry)

        for j, b in enumerate(cam1):
            if j in cam1_used:
                continue
            entry = self._build_entry(
                source='cam1_only', verified=False,
                cam0_pos=None, cam1_pos=b['pos'],
                xy_pos=b['pos'], size=b['size'], quat=b['quat'],
                class_name=b['class_name'], confidence=b['score'],
                track_idx=len(objects),
            )
            if entry is not None:
                objects.append(entry)

        payload = {'frame_id': self.frame_id, 'objects': objects}
        msg = String(); msg.data = json.dumps(payload)
        self._pub.publish(msg)

        self._n_publishes += 1
        if self._n_publishes % 30 == 0:
            verified = sum(1 for o in objects if o['verified'])
            self.get_logger().info(
                f'placed: {len(objects)}  verified: {verified}  '
                f'(cam0 in={len(cam0)} cam1 in={len(cam1)})')

    def _build_entry(self, *, source, verified, cam0_pos, cam1_pos,
                     xy_pos, size, quat, class_name, confidence, track_idx):
        """Anchor the (X, Y) position to the local LiDAR surface and
        construct a JSON-friendly object record. Returns None if the
        surface can't be resolved (no LiDAR coverage nearby)."""
        surface_z = self._surface_z(float(xy_pos[0]), float(xy_pos[1]))
        if surface_z is None:
            # Fall back to keeping the cameras' Z so the object still appears.
            surface_z_val = float(xy_pos[2]) - float(size[2]) / 2.0
            surface_unknown = True
        else:
            surface_z_val = surface_z
            surface_unknown = False
        # Object centre Z = surface Z + half height. Box bottom sits on
        # the LiDAR surface by construction.
        height = max(0.005, float(size[2]))
        pos_lidar = [float(xy_pos[0]), float(xy_pos[1]),
                      float(surface_z_val + height / 2.0)]
        return {
            'id':              f'placed_{track_idx:03d}',
            'source':          source,
            'verified':        bool(verified),
            'surface_unknown': bool(surface_unknown),
            'position_lidar':  [round(v, 4) for v in pos_lidar],
            'position_cam0':   ([round(float(v), 4) for v in cam0_pos]
                                if cam0_pos is not None else None),
            'position_cam1':   ([round(float(v), 4) for v in cam1_pos]
                                if cam1_pos is not None else None),
            'surface_z':       round(float(surface_z_val), 4),
            'size':            [round(float(v), 4) for v in size],
            'orientation':     [round(v, 1) for v in _quat_to_euler_deg(*quat)],
            'quat':            [round(float(v), 4) for v in quat],
            'class_name':      class_name,
            'confidence':      round(float(confidence), 3),
        }


def main(args=None):
    rclpy.init(args=args)
    node = StereoVerifier()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
