#!/usr/bin/env python3
"""LiDAR-primary 3D object detection.

Detect objects directly in the LiDAR point cloud — no camera frame, no
cam->lidar transform, no projection error. Output positions are exact
in livox_frame.

Pipeline:
    /lidar/points_dense   (PointCloud2)
          │
    RANSAC plane fit  (table / floor)
          │
    drop plane points + below-plane points + absurdly-high points
          │
    voxelise remaining points at 1 cm
          │
    scipy.ndimage.label   (26-connectivity 3D connected components)
          │
    per cluster: centroid, AABB, 2D-PCA OBB on XY plane, point count
          │
    /perception/lidar_detections   (vision_msgs/Detection3DArray, livox_frame)
    /perception/clustered_cloud    (PointCloud2 with per-cluster RGB)
"""
import math
import struct

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from scipy import ndimage
from scipy.spatial.transform import Rotation as R
from sensor_msgs.msg import PointCloud2, PointField
from vision_msgs.msg import (Detection3D, Detection3DArray,
                              ObjectHypothesisWithPose)


# ── PointCloud2 decode ──────────────────────────────────────────────────

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
        block = arr[:, ox:ox + 12].copy()
        return block.view(np.float32).reshape(n, 3)
    out = np.empty((n, 3), dtype=np.float32)
    for i in range(n):
        base = i * step
        out[i, 0] = struct.unpack_from('f', data, base + ox)[0]
        out[i, 1] = struct.unpack_from('f', data, base + oy)[0]
        out[i, 2] = struct.unpack_from('f', data, base + oz)[0]
    return out


# ── RANSAC plane fit ────────────────────────────────────────────────────

def _ransac_plane(points: np.ndarray, iterations: int, threshold: float):
    """Fit a plane via RANSAC; returns (normal[3], d, inlier_mask).

    Plane equation: normal · p + d = 0. After the inlier-refit step the
    normal is forced to point along +Z (since "up" in livox_frame is +Z
    and we want the half-space ABOVE the table to be positive)."""
    n = points.shape[0]
    if n < 3:
        return None
    rng = np.random.default_rng(0)
    best_count = 0
    best_normal = None
    best_d = 0.0
    best_mask = None
    for _ in range(iterations):
        idx = rng.choice(n, 3, replace=False)
        p1, p2, p3 = points[idx]
        normal = np.cross(p2 - p1, p3 - p1)
        nl = np.linalg.norm(normal)
        if nl < 1e-8:
            continue
        normal = normal / nl
        d = -float(np.dot(normal, p1))
        dists = np.abs(points @ normal + d)
        inliers = dists < threshold
        count = int(inliers.sum())
        if count > best_count:
            best_count = count
            best_normal = normal.copy()
            best_d = d
            best_mask = inliers
    if best_normal is None:
        return None

    # Refit on inliers via SVD for a precise plane (RANSAC's 3-point fit
    # is noisy). Standard approach: the inlier centroid is on the plane,
    # the smallest right-singular vector of the centred matrix is the
    # plane's normal.
    if best_mask.sum() >= 50:
        inl = points[best_mask]
        centroid = inl.mean(axis=0)
        centred = inl - centroid
        _, _, Vt = np.linalg.svd(centred, full_matrices=False)
        best_normal = Vt[-1]
        if best_normal[2] < 0:
            best_normal = -best_normal
        best_d = float(-np.dot(best_normal, centroid))
        best_mask = np.abs(points @ best_normal + best_d) < threshold
    else:
        if best_normal[2] < 0:
            best_normal = -best_normal
            best_d = -best_d
    return best_normal, best_d, best_mask


# ── 2D OBB on XY plane ──────────────────────────────────────────────────

def _fit_obb_xy(points: np.ndarray):
    """2D PCA in (X, Y); returns (centroid_xy[2], size_xy[2], yaw_rad).

    size[0] is the longer XY extent, size[1] the shorter. Yaw is the
    rotation about lidar Z (the only meaningful angle for top-down picks).
    """
    pxy = points[:, :2]
    centroid = pxy.mean(axis=0)
    centred = pxy - centroid
    if centred.shape[0] < 3:
        mn = pxy.min(axis=0); mx = pxy.max(axis=0)
        return (mn + mx) * 0.5, mx - mn, 0.0
    cov = np.cov(centred.T)
    evals, evecs = np.linalg.eigh(cov)
    evecs = evecs[:, np.argsort(evals)[::-1]]
    proj = centred @ evecs
    mn = proj.min(axis=0)
    mx = proj.max(axis=0)
    size = mx - mn
    centroid = centroid + evecs @ ((mn + mx) * 0.5)
    yaw = math.atan2(float(evecs[1, 0]), float(evecs[0, 0]))
    if size[0] < size[1]:
        size = size[::-1]
        yaw += math.pi / 2.0
    return centroid, size, yaw


# ── Node ────────────────────────────────────────────────────────────────

class LidarDetector(Node):
    def __init__(self):
        super().__init__('lidar_detector')

        self.declare_parameter('input_topic',                '/lidar/points_dense')
        self.declare_parameter('detections_topic',           '/perception/lidar_detections')
        self.declare_parameter('clustered_cloud_topic',      '/perception/clustered_cloud')
        self.declare_parameter('plane_ransac_iterations',    100)
        self.declare_parameter('plane_distance_threshold_m', 0.015)
        self.declare_parameter('min_cluster_points',         15)
        self.declare_parameter('voxel_size_m',               0.01)
        self.declare_parameter('max_detection_height_m',     0.5)
        self.declare_parameter('max_range_m',                1.5)
        self.declare_parameter('publish_hz',                 5.0)
        self.declare_parameter('frame_id',                   'livox_frame')

        input_topic       = self.get_parameter('input_topic').value
        det_topic         = self.get_parameter('detections_topic').value
        cloud_topic       = self.get_parameter('clustered_cloud_topic').value
        self.ransac_iters = int(self.get_parameter('plane_ransac_iterations').value)
        self.plane_thresh = float(self.get_parameter('plane_distance_threshold_m').value)
        self.min_pts      = int(self.get_parameter('min_cluster_points').value)
        self.voxel        = float(self.get_parameter('voxel_size_m').value)
        self.max_height   = float(self.get_parameter('max_detection_height_m').value)
        self.max_range    = float(self.get_parameter('max_range_m').value)
        self.frame_id     = str(self.get_parameter('frame_id').value)
        rate              = float(self.get_parameter('publish_hz').value)

        self._latest_pts = None
        self._latest_stamp = None
        self._log_count = 0

        self.create_subscription(PointCloud2, input_topic, self._on_cloud,
                                 qos_profile_sensor_data)
        self._det_pub   = self.create_publisher(Detection3DArray, det_topic, 5)
        self._cloud_pub = self.create_publisher(PointCloud2, cloud_topic, 2)
        self.create_timer(1.0 / max(rate, 0.5), self._process)

        self.get_logger().info(
            f'lidar_detector: {input_topic} -> {det_topic} | '
            f'RANSAC iters={self.ransac_iters} thresh={self.plane_thresh}m '
            f'min_pts={self.min_pts} voxel={self.voxel}m '
            f'max_height={self.max_height}m rate={rate}Hz')

    def _on_cloud(self, msg: PointCloud2):
        self._latest_pts = _decode_xyz(msg)
        self._latest_stamp = msg.header.stamp

    # ── Main timer ──────────────────────────────────────────────────────

    def _process(self):
        pts = self._latest_pts
        stamp = self._latest_stamp
        if pts is None or pts.size == 0 or stamp is None:
            return

        # Clip to the workspace radius before doing anything else. Without
        # this the cloud includes walls and ceiling at 5–10 m which all
        # land "above the plane" after RANSAC and blow up the voxel grid
        # to hundreds of millions of cells.
        r2 = pts[:, 0] ** 2 + pts[:, 1] ** 2 + pts[:, 2] ** 2
        in_range = r2 < (self.max_range * self.max_range)
        pts = pts[in_range]
        if pts.shape[0] < 50:
            return

        # Subsample for RANSAC if the cloud is very dense — more than 8k
        # points doesn't sharpen the plane fit, only slows it.
        if pts.shape[0] > 8000:
            rng = np.random.default_rng(0)
            sub = rng.choice(pts.shape[0], 8000, replace=False)
            ransac_pts = pts[sub]
        else:
            ransac_pts = pts
        plane = _ransac_plane(ransac_pts, self.ransac_iters, self.plane_thresh)
        if plane is None:
            self._publish_empty(stamp)
            return
        normal, d, _ = plane

        # Signed distance to the plane for ALL points (normal points up).
        signed = pts @ normal + d
        # Keep points strictly above the plane band, and not unreasonably
        # high (avoids the ceiling or wall returns dominating).
        above = (signed > self.plane_thresh) & (signed < self.max_height)
        objs = pts[above]
        heights = signed[above]
        if objs.shape[0] < self.min_pts:
            self._publish_empty(stamp)
            return

        # Voxelise to a 3D bool grid bounded by the AABB of `objs`.
        mn = objs.min(axis=0)
        idx = np.floor((objs - mn) / self.voxel).astype(np.int32)
        gx = int(idx[:, 0].max()) + 1
        gy = int(idx[:, 1].max()) + 1
        gz = int(idx[:, 2].max()) + 1
        if gx * gy * gz > 30_000_000:
            self.get_logger().warn(
                f'voxel grid too large ({gx}x{gy}x{gz}); skipping frame')
            return
        grid = np.zeros((gx, gy, gz), dtype=bool)
        grid[idx[:, 0], idx[:, 1], idx[:, 2]] = True

        labeled, n_labels = ndimage.label(grid, structure=np.ones((3, 3, 3)))
        if n_labels == 0:
            self._publish_empty(stamp)
            return

        # Look up the cluster ID of every point.
        point_labels = labeled[idx[:, 0], idx[:, 1], idx[:, 2]]

        arr = Detection3DArray()
        arr.header.stamp = stamp
        arr.header.frame_id = self.frame_id

        cloud_pts = []
        cloud_cols = []
        kept = 0

        for label in range(1, n_labels + 1):
            mask = point_labels == label
            count = int(mask.sum())
            if count < self.min_pts:
                continue
            cluster = objs[mask]
            cluster_heights = heights[mask]

            centroid = cluster.mean(axis=0)
            mn3 = cluster.min(axis=0)
            mx3 = cluster.max(axis=0)
            cent_xy, size_xy, yaw = _fit_obb_xy(cluster)
            obb_size = np.array([float(size_xy[0]),
                                 float(size_xy[1]),
                                 float(max(mx3[2] - mn3[2], 0.005))],
                                dtype=np.float32)
            quat = R.from_euler('z', yaw).as_quat()  # xyzw
            height_above_table = float(cluster_heights.max())
            confidence = float(min(1.0, count / 100.0))

            det = Detection3D()
            det.header = arr.header
            hyp = ObjectHypothesisWithPose()
            hyp.hypothesis.class_id = 'lidar_object'
            hyp.hypothesis.score = confidence
            hyp.pose.pose.position.x = float(centroid[0])
            hyp.pose.pose.position.y = float(centroid[1])
            hyp.pose.pose.position.z = float(centroid[2])
            hyp.pose.pose.orientation.x = float(quat[0])
            hyp.pose.pose.orientation.y = float(quat[1])
            hyp.pose.pose.orientation.z = float(quat[2])
            hyp.pose.pose.orientation.w = float(quat[3])
            det.results.append(hyp)

            # bbox.center uses the OBB-derived XY centre and the AABB Z
            # midpoint, which is what a top-down gripper actually needs.
            det.bbox.center.position.x    = float(cent_xy[0])
            det.bbox.center.position.y    = float(cent_xy[1])
            det.bbox.center.position.z    = float((mn3[2] + mx3[2]) * 0.5)
            det.bbox.center.orientation.x = float(quat[0])
            det.bbox.center.orientation.y = float(quat[1])
            det.bbox.center.orientation.z = float(quat[2])
            det.bbox.center.orientation.w = float(quat[3])
            det.bbox.size.x = float(obb_size[0])
            det.bbox.size.y = float(obb_size[1])
            det.bbox.size.z = float(obb_size[2])
            arr.detections.append(det)

            # Coloured point cloud — each cluster gets a deterministic RGB
            # derived from its label so the same physical object keeps
            # roughly the same colour across frames.
            r = ((label * 73)  % 256) / 255.0
            g = ((label * 151) % 256) / 255.0
            b = ((label * 211) % 256) / 255.0
            cloud_pts.append(cluster)
            cloud_cols.append(np.tile([r, g, b], (cluster.shape[0], 1)))
            kept += 1

        self._det_pub.publish(arr)
        if cloud_pts:
            self._publish_cloud(stamp,
                                np.concatenate(cloud_pts, axis=0),
                                np.concatenate(cloud_cols, axis=0))
        else:
            self._publish_empty_cloud(stamp)

        self._log_count += 1
        if self._log_count % 10 == 0:
            self.get_logger().info(
                f'plane normal={normal.round(3).tolist()} d={d:+.3f}m | '
                f'object pts={objs.shape[0]} | clusters above thresh={kept}')

    # ── Publishing helpers ──────────────────────────────────────────────

    def _empty_msg(self, stamp):
        msg = PointCloud2()
        msg.header.stamp = stamp
        msg.header.frame_id = self.frame_id
        msg.height = 1
        msg.width = 0
        msg.point_step = 16
        msg.row_step = 0
        msg.is_dense = True
        msg.is_bigendian = False
        msg.fields = [
            PointField(name='x',   offset=0,  datatype=PointField.FLOAT32, count=1),
            PointField(name='y',   offset=4,  datatype=PointField.FLOAT32, count=1),
            PointField(name='z',   offset=8,  datatype=PointField.FLOAT32, count=1),
            PointField(name='rgb', offset=12, datatype=PointField.FLOAT32, count=1),
        ]
        msg.data = b''
        return msg

    def _publish_empty(self, stamp):
        arr = Detection3DArray()
        arr.header.stamp = stamp
        arr.header.frame_id = self.frame_id
        self._det_pub.publish(arr)
        self._publish_empty_cloud(stamp)

    def _publish_empty_cloud(self, stamp):
        self._cloud_pub.publish(self._empty_msg(stamp))

    def _publish_cloud(self, stamp, pts: np.ndarray, cols: np.ndarray):
        n = pts.shape[0]
        msg = self._empty_msg(stamp)
        msg.width = n
        msg.row_step = msg.point_step * n
        # Pack RGB as 0x00RRGGBB in float32 — the ROS rviz convention.
        r = (cols[:, 0] * 255).astype(np.uint32)
        g = (cols[:, 1] * 255).astype(np.uint32)
        b = (cols[:, 2] * 255).astype(np.uint32)
        rgb_packed = (r << 16) | (g << 8) | b
        rgb_float = rgb_packed.view(np.float32)
        buf = np.zeros(n, dtype=[('x', np.float32), ('y', np.float32),
                                  ('z', np.float32), ('rgb', np.float32)])
        buf['x']   = pts[:, 0]
        buf['y']   = pts[:, 1]
        buf['z']   = pts[:, 2]
        buf['rgb'] = rgb_float
        msg.data = buf.tobytes()
        self._cloud_pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = LidarDetector()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
