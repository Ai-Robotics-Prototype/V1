#!/usr/bin/env python3
"""
depth_segment_node — class-agnostic ("any object") detection from RealSense depth.

No ML model. Segments foreground objects out of the aligned depth image:

  1. depth -> metres (16UC1 / 1000, or 32FC1 as-is)
  2. background removal: drop depth <= 0 or >= max_depth_m
  3. adaptive background subtraction via a PLANAR model: least-squares plane fit
     (one inlier-refit pass) gives a per-pixel background depth that follows a
     tilted table/floor; foreground = pixels at least floor_tolerance_m nearer
     to the camera than that surface. (Generalises "objects closer than the
     dominant background depth" to angled surfaces.)
  4. morphological open (erode -> dilate) to clean noise / fill gaps
  5. multi-scale connected components: full resolution + 2x-downsampled (catches
     medium objects that fragment at full res); merge overlapping (IoU>0.5),
     keeping the tighter bbox
  6. temporal smoothing: an object must appear in >=2 of the last 3 frames to be
     published (rejects flicker; tolerates a 1-frame dropout)
  7. per object: tight bbox (+5px pad) + median depth -> deproject to 3D

Publishes (topics are parameters; one instance per camera):
  /perception/detections_3d   (vision_msgs/Detection3DArray, class_id="object")
  /perception/annotated_image (sensor_msgs/Image, boxes + distance labels)

Dependencies: numpy, scipy, PIL only. No cv2, no torch, no ultralytics.
"""
import collections
import math
import os
import numpy as np
import rclpy
import yaml
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image, CameraInfo
from vision_msgs.msg import Detection3DArray, Detection3D, ObjectHypothesisWithPose
from scipy import ndimage
from scipy.spatial.transform import Rotation as _SR
from PIL import Image as PILImage, ImageDraw

# 12 edges of a unit cube, as pairs of corner indices (binary xyz).
_CUBE_EDGES = ((0, 1), (0, 2), (0, 4), (1, 3), (1, 5), (2, 3),
               (2, 6), (3, 7), (4, 5), (4, 6), (5, 7), (6, 7))

# Standard optical -> ROS quaternion (xyzw) — matches sensor_tf_publisher.
_OPTICAL_TO_ROS_Q = (0.5, -0.5, 0.5, 0.5)

_SENSOR_YAML_CANDIDATES = [
    '/home/teddy/cobot_ws/install/cobot_bringup/share/cobot_bringup/config/sensor_transforms.yaml',
    '/home/teddy/cobot_ws/src/cobot_bringup/config/sensor_transforms.yaml',
]


def _load_cam_to_lidar(frame_id: str, logger):
    """Return (R[3,3], t[3]) that maps a point from `frame_id` (camera-
    optical) into livox_frame. Falls back to identity translation +
    standard optical-to-ROS rotation if the YAML is missing."""
    key = 'cam0_to_lidar' if 'cam0' in frame_id else (
          'cam1_to_lidar' if 'cam1' in frame_id else None)
    cfg = {}
    used = None
    for p in _SENSOR_YAML_CANDIDATES:
        if os.path.isfile(p):
            try:
                with open(p, 'r') as f:
                    cfg = yaml.safe_load(f) or {}
                used = p
                break
            except Exception as e:
                logger.warn(f'failed to read {p}: {e}')
    block = (cfg.get(key) or {}) if key else {}
    trans = block.get('translation') or [0.0, 0.0, 0.0]
    quat  = block.get('rotation')    or list(_OPTICAL_TO_ROS_Q)
    R_mat = _SR.from_quat(quat).as_matrix().astype(np.float64)
    t_vec = np.asarray(trans, dtype=np.float64).reshape(3)
    logger.info(
        f'cam_to_lidar({key!r}) from {used or "fallback"}: '
        f't={t_vec.tolist()} q={quat}')
    return R_mat, t_vec, np.asarray(quat, dtype=np.float64)


class DepthSegmentNode(Node):
    def __init__(self):
        super().__init__('depth_segment_node')

        self.declare_parameter('max_depth_m',        3.0)
        self.declare_parameter('min_object_area_px', 50)
        self.declare_parameter('floor_tolerance_m',  0.015)
        self.declare_parameter('erode_kernel',       2)
        self.declare_parameter('dilate_kernel',      9)
        self.declare_parameter('edge_threshold_m',   0.05)
        self.declare_parameter('rgb_edge_threshold', 30.0)
        self.declare_parameter('merge_edge_dist_px', 20)
        self.declare_parameter('merge_iou_thr',      0.1)
        self.declare_parameter('split_threshold_m',  0.01)
        self.declare_parameter('max_bbox_area_px',   40000)
        self.declare_parameter('publish_rate_hz',    15.0)
        self.declare_parameter('bbox_pad_px',        5)
        # Per-camera topics so one node can serve cam0 and another cam1
        self.declare_parameter('depth_topic',      '/cam0/cam0/aligned_depth_to_color/image_raw')
        self.declare_parameter('color_topic',      '/cam0/cam0/color/image_raw')
        self.declare_parameter('info_topic',       '/cam0/cam0/color/camera_info')
        self.declare_parameter('detections_topic', '/perception/detections_3d')
        self.declare_parameter('annotated_topic',  '/perception/annotated_image')
        self.declare_parameter('frame_id',         'cam0_color_optical_frame')

        self.max_depth   = float(self.get_parameter('max_depth_m').value)
        self.min_area    = int(self.get_parameter('min_object_area_px').value)
        self.floor_tol   = float(self.get_parameter('floor_tolerance_m').value)
        self.erode_k     = int(self.get_parameter('erode_kernel').value)
        self.dilate_k    = int(self.get_parameter('dilate_kernel').value)
        self.edge_thresh = float(self.get_parameter('edge_threshold_m').value)
        self.rgb_edge_thresh = float(self.get_parameter('rgb_edge_threshold').value)
        self.merge_edge_px = int(self.get_parameter('merge_edge_dist_px').value)
        self.merge_iou_thr = float(self.get_parameter('merge_iou_thr').value)
        self.split_thresh  = float(self.get_parameter('split_threshold_m').value)
        self.max_bbox_area = int(self.get_parameter('max_bbox_area_px').value)
        self.pad         = int(self.get_parameter('bbox_pad_px').value)
        rate             = float(self.get_parameter('publish_rate_hz').value)
        depth_topic      = self.get_parameter('depth_topic').value
        color_topic      = self.get_parameter('color_topic').value
        info_topic       = self.get_parameter('info_topic').value
        det_topic        = self.get_parameter('detections_topic').value
        ann_topic        = self.get_parameter('annotated_topic').value
        self.frame_id    = self.get_parameter('frame_id').value

        # Latest inputs (written by callbacks, read by the timer)
        self._depth_m   = None     # HxW float32 metres
        self._depth_hdr = None
        self._color_rgb = None     # HxW x3 uint8 RGB
        self._K         = None     # (fx, fy, cx, cy)
        self._uv_cache  = None     # cached pixel grids keyed by (h, w)
        self._history   = collections.deque(maxlen=3)  # last 3 frames of detections

        # RealSense images are BEST_EFFORT — must match QoS or no frames arrive
        self.create_subscription(Image, depth_topic, self._on_depth, qos_profile_sensor_data)
        self.create_subscription(Image, color_topic, self._on_color, qos_profile_sensor_data)
        self.create_subscription(CameraInfo, info_topic, self._on_info, qos_profile_sensor_data)

        self.det_pub = self.create_publisher(Detection3DArray, det_topic, 10)
        self.ann_pub = self.create_publisher(Image, ann_topic, 5)

        # Camera-optical -> LiDAR transform. Centroids and OBB rotations are
        # converted with this before publishing Detection3D so consumers
        # (dashboard, grasp planner) see a single coherent frame.
        self._R_lc, self._t_lc, self._q_lc = _load_cam_to_lidar(
            self.frame_id, self.get_logger())
        self._lidar_frame_id = 'livox_frame'

        self.create_timer(1.0 / max(rate, 1.0), self._process)
        self._log_count = 0
        self.get_logger().info(
            f'depth_segment_node started | max_depth={self.max_depth}m '
            f'min_area={self.min_area}px erode={self.erode_k} dilate={self.dilate_k} '
            f'floor_tol={self.floor_tol}m rate={rate}Hz '
            f'publishing in {self._lidar_frame_id}')

    # ── Callbacks ───────────────────────────────────────────────────────────

    def _on_depth(self, msg: Image):
        raw = bytes(msg.data)
        if msg.encoding == '16UC1':
            d = np.frombuffer(raw, np.uint16).reshape(msg.height, msg.width).astype(np.float32) / 1000.0
        elif msg.encoding == '32FC1':
            d = np.frombuffer(raw, np.float32).reshape(msg.height, msg.width).copy()
        else:
            self.get_logger().warn(f'unexpected depth encoding: {msg.encoding}', once=True)
            return
        self._depth_m = d
        self._depth_hdr = msg.header

    def _on_color(self, msg: Image):
        raw = bytes(msg.data)
        n = msg.width * msg.height * 3
        if len(raw) < n:
            return
        arr = np.frombuffer(raw, np.uint8)[:n].reshape(msg.height, msg.width, 3)
        if msg.encoding == 'bgr8':
            arr = arr[:, :, ::-1]
        self._color_rgb = arr.copy()

    def _on_info(self, msg: CameraInfo):
        k = msg.k
        if k[0] > 0 and k[4] > 0:
            self._K = (k[0], k[4], k[2], k[5])  # fx, fy, cx, cy

    # ── Geometry helpers ──────────────────────────────────────────────────────

    def _uv_grids(self, h, w):
        if self._uv_cache is None or self._uv_cache[0] != (h, w):
            u = np.arange(w, dtype=np.float32)[None, :].repeat(h, axis=0)
            v = np.arange(h, dtype=np.float32)[:, None].repeat(w, axis=1)
            self._uv_cache = ((h, w), u, v)
        return self._uv_cache[1], self._uv_cache[2]

    @staticmethod
    def _iou(a, b):
        ax0, ay0, ax1, ay1 = a
        bx0, by0, bx1, by1 = b
        ix0, iy0 = max(ax0, bx0), max(ay0, by0)
        ix1, iy1 = min(ax1, bx1), min(ay1, by1)
        iw, ih = max(0, ix1 - ix0), max(0, iy1 - iy0)
        inter = iw * ih
        if inter == 0:
            return 0.0
        area_a = (ax1 - ax0) * (ay1 - ay0)
        area_b = (bx1 - bx0) * (by1 - by0)
        return inter / float(area_a + area_b - inter)

    @staticmethod
    def _fit_plane(X, Y, Z):
        """Least-squares plane Z = aX + bY + c with one inlier-refit pass."""
        if X.size < 50:
            return None
        def solve(xx, yy, zz):
            A = np.column_stack([xx, yy, np.ones_like(xx)])
            coef, *_ = np.linalg.lstsq(A, zz, rcond=None)
            return coef
        coef = solve(X, Y, Z)
        resid = Z - (coef[0] * X + coef[1] * Y + coef[2])
        mad = np.median(np.abs(resid - np.median(resid))) + 1e-6
        inl = np.abs(resid) < 3.0 * mad
        if inl.sum() >= 50:
            coef = solve(X[inl], Y[inl], Z[inl])
        return float(coef[0]), float(coef[1]), float(coef[2])

    # ── Component extraction (single scale) ────────────────────────────────────

    def _dilate(self, mask, k):
        # iterations with the default 3x3 structuring element ≈ k-px growth, but
        # much cheaper than a single (k x k) structure on a full frame.
        return ndimage.binary_dilation(mask, iterations=max(1, k // 2))

    def _erode(self, mask, k):
        return ndimage.binary_erosion(mask, iterations=max(1, k // 2))

    def _components(self, mask, scale):
        """Return list of full-resolution bboxes (x0,y0,x1,y1) from a binary mask.
        `scale` = downsample factor the mask was taken at (bbox coords *scale)."""
        labeled, n = ndimage.label(mask)
        if n == 0:
            return []
        areas = np.bincount(labeled.ravel())
        slices = ndimage.find_objects(labeled)
        min_a = max(1, self.min_area // (scale * scale))
        out = []
        for lid in range(1, n + 1):
            if areas[lid] < min_a:
                continue
            sl = slices[lid - 1]
            if sl is None:
                continue
            ys, xs = sl
            out.append((xs.start * scale, ys.start * scale,
                        xs.stop * scale, ys.stop * scale))
        return out

    def _merge_iou(self, bboxes, thr=0.5):
        """Dedup overlapping bboxes, keeping the tighter (smaller-area) one."""
        bboxes = sorted(bboxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
        kept = []
        for b in bboxes:
            if all(self._iou(b, k) <= thr for k in kept):
                kept.append(b)
        return kept

    @staticmethod
    def _edge_dist(a, b):
        """Minimum edge-to-edge separation between two bboxes (0 if overlapping)."""
        ax0, ay0, ax1, ay1 = a
        bx0, by0, bx1, by1 = b
        dx = max(0, max(bx0 - ax1, ax0 - bx1))
        dy = max(0, max(by0 - ay1, ay0 - by1))
        return (dx * dx + dy * dy) ** 0.5

    def _merge_nearby(self, bboxes):
        """Union-merge bboxes that overlap (IoU > merge_iou_thr) or whose edges
        are within merge_edge_px of each other. Fixes single objects fragmented
        into multiple components."""
        boxes = [list(b) for b in bboxes]
        changed = True
        while changed:
            changed = False
            i = 0
            while i < len(boxes):
                j = i + 1
                while j < len(boxes):
                    if (self._iou(boxes[i], boxes[j]) > self.merge_iou_thr or
                            self._edge_dist(boxes[i], boxes[j]) < self.merge_edge_px):
                        boxes[i] = [min(boxes[i][0], boxes[j][0]),
                                    min(boxes[i][1], boxes[j][1]),
                                    max(boxes[i][2], boxes[j][2]),
                                    max(boxes[i][3], boxes[j][3])]
                        del boxes[j]
                        changed = True
                    else:
                        j += 1
                i += 1
        return [tuple(b) for b in boxes]

    # ── OBB extraction ──────────────────────────────────────────────────────

    @staticmethod
    def _deproject_mask(depth, mask, fx, fy, cx, cy):
        """Vectorised deprojection of every masked pixel with valid depth.

        depth and mask have the same HxW shape (already cropped to a bbox).
        Returns Nx3 float32 of (X, Y, Z) in the camera frame; empty if none.
        """
        valid = mask & np.isfinite(depth) & (depth > 0.0)
        ys, xs = np.nonzero(valid)
        if ys.size == 0:
            return np.empty((0, 3), dtype=np.float32)
        z = depth[ys, xs].astype(np.float32)
        x = (xs.astype(np.float32) - cx) * z / fx
        y = (ys.astype(np.float32) - cy) * z / fy
        return np.stack([x, y, z], axis=1)

    # OBB sanity limits (metres) for tabletop objects.
    _OBB_MIN_DIM = 0.005
    _OBB_MAX_DIM = 0.30

    @staticmethod
    def _refine_object_points(sub_d: np.ndarray, sub_fg: np.ndarray,
                              fx: float, fy: float, cx_loc: float, cy_loc: float):
        """Erode mask, deproject, drop table-plane points, drop outliers.

        Returns the Nx3 cleaned cloud (may be empty). All operations are
        defensive — every shrinking step falls back if it would leave
        too few points for the next stage.
        """
        # FIX 1: erode 2 px to drop edge-contamination pixels that often
        # straddle the object / table boundary.
        tight = ndimage.binary_erosion(sub_fg, iterations=2)
        if tight.sum() < 5:
            tight = sub_fg
        pts = DepthSegmentNode._deproject_mask(
            sub_d, tight.astype(bool), fx, fy, cx_loc, cy_loc,
        )
        if pts.shape[0] < 5:
            return pts

        # FIX 2: drop points within 5 mm of the deepest pixel (those are
        # the table itself peeking through), AND drop points further than
        # median + 2 cm (background behind the object).
        z = pts[:, 2]
        max_z = float(z.max())
        median_z = float(np.median(z))
        keep = (z < (max_z - 0.005)) & (z < (median_z + 0.02))
        if keep.sum() >= 5:
            pts = pts[keep]

        # FIX 3: statistical outlier removal — distance from centroid
        # above median + 1.5σ is dropped.
        if pts.shape[0] >= 5:
            c = pts.mean(axis=0)
            d = np.linalg.norm(pts - c, axis=1)
            mdist = float(np.median(d))
            sdist = float(d.std()) + 1e-9
            inl = d < (mdist + 1.5 * sdist)
            if inl.sum() >= 5:
                pts = pts[inl]
        return pts

    @classmethod
    def _fit_obb(cls, points: np.ndarray):
        """Yaw-only OBB for tabletop scenes via convex hull + rotating calipers.

        On the 2D (X,Y) projection of the cleaned cloud, the minimum-area
        bounding rectangle aligned with one of the hull's edges gives the
        tightest possible rectangle. Z extent is the cloud's depth range.
        R is a pure rotation about camera Z; roll = pitch = 0.

        Degenerate inputs (too few or collinear points) fall back to an
        axis-aligned bbox. Dimensions are clamped to [_OBB_MIN_DIM,
        _OBB_MAX_DIM] in the same fallback path. Returns
        (centroid[3], size[3], R[3,3]).
        """
        from scipy.spatial import ConvexHull
        from scipy.spatial.qhull import QhullError

        def _aabb_fallback():
            mn3, mx3 = points.min(axis=0), points.max(axis=0)
            c = ((mn3 + mx3) * 0.5).astype(np.float32)
            s = (mx3 - mn3).astype(np.float32)
            s = np.clip(s, cls._OBB_MIN_DIM, cls._OBB_MAX_DIM)
            return c, s, np.eye(3, dtype=np.float32)

        if points.shape[0] < 10:
            return _aabb_fallback()

        pxy = points[:, :2]
        try:
            hull = ConvexHull(pxy)
        except (QhullError, ValueError):
            return _aabb_fallback()
        hpts = pxy[hull.vertices]
        if len(hpts) < 3:
            return _aabb_fallback()

        # Rotating calipers: each candidate orientation is aligned with one
        # of the hull's edges; the minimum-area AABB over hpts in that
        # rotated frame defines the rectangle.
        best_area = float('inf')
        best = None
        n_h = len(hpts)
        for i in range(n_h):
            edge = hpts[(i + 1) % n_h] - hpts[i]
            angle = math.atan2(float(edge[1]), float(edge[0]))
            ca = math.cos(-angle); sa = math.sin(-angle)
            rot_into_local = np.array([[ca, -sa], [sa, ca]], dtype=np.float64)
            # row-vector convention: local = world @ rot_into_local.T
            rotated = hpts @ rot_into_local.T
            mn = rotated.min(axis=0)
            mx = rotated.max(axis=0)
            area = float((mx[0] - mn[0]) * (mx[1] - mn[1]))
            if area < best_area:
                best_area = area
                best = (angle, mn, mx)

        angle, mn_loc, mx_loc = best
        # Recover centroid in world XY from the rectangle's local centre.
        centroid_local = (mn_loc + mx_loc) * 0.5
        ca = math.cos(angle); sa = math.sin(angle)
        centroid_xy = np.array([
            ca * centroid_local[0] - sa * centroid_local[1],
            sa * centroid_local[0] + ca * centroid_local[1],
        ])

        size_xy = mx_loc - mn_loc
        # Convention: first dim = longer XY extent.
        if size_xy[0] < size_xy[1]:
            size_xy = size_xy[::-1]
            angle += math.pi / 2.0

        z = points[:, 2]
        z_min, z_max = float(z.min()), float(z.max())
        size_z = max(z_max - z_min, 0.005)
        centroid_z = 0.5 * (z_min + z_max)

        centroid = np.array([centroid_xy[0], centroid_xy[1], centroid_z], dtype=np.float32)
        size_3d = np.array([size_xy[0], size_xy[1], size_z], dtype=np.float32)

        cy_, sy_ = math.cos(angle), math.sin(angle)
        R = np.array([
            [cy_, -sy_, 0.0],
            [sy_,  cy_, 0.0],
            [0.0,  0.0, 1.0],
        ], dtype=np.float32)

        # Sanity-clamp: ridiculous extents trip the AABB fallback so we
        # never publish a 40 cm "object".
        if (size_3d > cls._OBB_MAX_DIM).any() or (size_3d < cls._OBB_MIN_DIM).any():
            return _aabb_fallback()

        return centroid, size_3d, R

    @staticmethod
    def _rmat_to_quat_euler(R: np.ndarray):
        """Convert 3x3 rotation matrix to (quat_xyzw, (roll, pitch, yaw)) in radians.

        Euler convention matches the task spec: ZYX intrinsic / XYZ extrinsic.
            pitch = asin(-R[2,0])
            roll  = atan2(R[2,1], R[2,2])
            yaw   = atan2(R[1,0], R[0,0])
        """
        quat = _SR.from_matrix(R).as_quat()  # xyzw
        # Clamp to avoid NaN from numerical drift outside [-1, 1]
        sin_pitch = max(-1.0, min(1.0, float(-R[2, 0])))
        pitch = math.asin(sin_pitch)
        # If pitch is near ±π/2 the other two angles couple; fall back to yaw=0.
        if abs(abs(pitch) - math.pi / 2) < 1e-3:
            roll = math.atan2(-R[1, 2], R[1, 1])
            yaw = 0.0
        else:
            roll = math.atan2(float(R[2, 1]), float(R[2, 2]))
            yaw  = math.atan2(float(R[1, 0]), float(R[0, 0]))
        return quat.astype(np.float32), (roll, pitch, yaw)

    @staticmethod
    def _kmeans_split(pts: np.ndarray, bbox_area: int):
        """Split an oversized cloud into <=5 clusters via XY-plane k-means.

        Returns (cluster_pts_list, fitted) where each element is an Nx3
        sub-cloud. Returns ([], False) if scipy.cluster.vq is unavailable
        or kmeans fails / would leave empty clusters; the caller should
        then fall back to single-OBB handling.
        """
        try:
            from scipy.cluster.vq import kmeans2
        except ImportError:
            return [], False
        k = max(2, bbox_area // 15000)
        k = min(k, 5)
        if pts.shape[0] < k * 5:
            return [], False
        try:
            _, labels = kmeans2(pts[:, :2].astype(np.float64), k,
                                minit='points', seed=0)
        except Exception:
            return [], False
        clusters = [pts[labels == kid] for kid in range(k)]
        clusters = [c for c in clusters if c.shape[0] >= 10]
        return clusters, len(clusters) >= 2

    @classmethod
    def _build_obj_from_cluster(cls, cluster: np.ndarray,
                                fx: float, fy: float, cx: float, cy: float,
                                w: int, h: int):
        """Build a detection dict from a 3D point cluster (used by k-means
        split). Reconstructs bbox_px by projecting cluster points back to
        the image plane. Returns None if the cluster is too sparse."""
        if cluster.shape[0] < 5:
            return None
        # Project to pixel coordinates for bbox_px.
        z = cluster[:, 2]
        z_safe = np.where(z > 0.01, z, 0.01)
        us = fx * cluster[:, 0] / z_safe + cx
        vs = fy * cluster[:, 1] / z_safe + cy
        bx0 = int(max(0, math.floor(float(us.min()))))
        by0 = int(max(0, math.floor(float(vs.min()))))
        bx1 = int(min(w, math.ceil(float(us.max()))))
        by1 = int(min(h, math.ceil(float(vs.max()))))
        if bx1 <= bx0 or by1 <= by0:
            return None
        if cluster.shape[0] < 20:
            centroid = cluster.mean(axis=0)
            extents = cluster.max(axis=0) - cluster.min(axis=0)
            return {
                'bbox_px':  (bx0, by0, bx1, by1),
                'pos':      tuple(float(v) for v in centroid),
                'size_3d':  tuple(float(v) for v in extents.clip(0.005, None)),
                'quat':     (0.0, 0.0, 0.0, 1.0),
                'euler':    (0.0, 0.0, 0.0),
                'corners':  None,
                'obb':      False,
            }
        centroid, size_3d, R = cls._fit_obb(cluster)
        quat, euler = cls._rmat_to_quat_euler(R)
        corners = cls._obb_corners(centroid, size_3d, R)
        return {
            'bbox_px':  (bx0, by0, bx1, by1),
            'pos':      (float(centroid[0]), float(centroid[1]), float(centroid[2])),
            'size_3d':  (float(size_3d[0]), float(size_3d[1]), float(size_3d[2])),
            'quat':     tuple(float(q) for q in quat),
            'euler':    euler,
            'corners':  corners,
            'obb':      True,
        }

    @staticmethod
    def _obb_corners(centroid: np.ndarray, size: np.ndarray, R: np.ndarray):
        """Return the 8 corners (8x3) of the OBB defined by (centroid, size, R)."""
        h = size * 0.5
        signs = np.array([(sx, sy, sz)
                          for sx in (-1.0, 1.0)
                          for sy in (-1.0, 1.0)
                          for sz in (-1.0, 1.0)], dtype=np.float32)
        # local-frame corners → world-frame: c + R @ (sign * h)
        local = signs * h
        world = local @ R.T + centroid
        return world

    def _temporal_filter(self):
        """Keep objects present in >=2 of the last 3 frames (flicker + dropout)."""
        frames = list(self._history)
        tagged = [(fi, det) for fi, fl in enumerate(frames) for det in fl]
        used = [False] * len(tagged)
        out = []
        for i in range(len(tagged)):
            if used[i]:
                continue
            cluster = [i]
            used[i] = True
            for j in range(i + 1, len(tagged)):
                if not used[j] and self._iou(tagged[i][1]['bbox_px'], tagged[j][1]['bbox_px']) > 0.5:
                    cluster.append(j)
                    used[j] = True
            if len({tagged[k][0] for k in cluster}) >= 2:
                best = max(cluster, key=lambda k: tagged[k][0])  # most recent
                out.append(tagged[best][1])
        return out

    # ── Main processing (timer) ─────────────────────────────────────────────

    def _process(self):
        depth = self._depth_m
        K = self._K
        if depth is None or K is None:
            return
        fx, fy, cx, cy = K
        h, w = depth.shape
        u, v = self._uv_grids(h, w)

        valid = np.isfinite(depth) & (depth > 0.0) & (depth < self.max_depth)
        if valid.sum() < self.min_area:
            self._history.append([])
            self._emit(h, w)
            return

        Z = np.where(valid, depth, 0.0).astype(np.float32)
        X = (u - cx) * Z / fx
        Y = (v - cy) * Z / fy

        # Adaptive (planar) background fit on a random valid subsample
        vy, vx = np.nonzero(valid)
        if vy.size > 4000:
            sel = np.random.choice(vy.size, 4000, replace=False)
            vy, vx = vy[sel], vx[sel]
        plane = self._fit_plane(X[vy, vx], Y[vy, vx], Z[vy, vx])
        if plane is None:
            self._history.append([])
            self._emit(h, w)
            return
        a, b, c = plane
        plane_z = a * X + b * Y + c
        # (a) planar background subtraction: pixels nearer than the surface
        plane_fg = valid & (depth < (plane_z - self.floor_tol))
        # (b) depth edges: a sharp depth discontinuity marks an object boundary
        # even when the height above the surface is tiny. Fill invalid pixels
        # with the plane depth first, so data holes don't create spurious edges.
        depth_filled = np.where(valid, depth, plane_z).astype(np.float32)
        gmag = np.hypot(ndimage.sobel(depth_filled, axis=0, mode='nearest'),
                        ndimage.sobel(depth_filled, axis=1, mode='nearest'))
        edge_fg = valid & (gmag > self.edge_thresh)
        foreground = plane_fg | edge_fg

        # (c) RGB edges: catches flat dark objects that have minimal depth
        # difference from the surface but visible colour/texture boundaries.
        rgb = self._color_rgb
        if rgb is not None and rgb.shape[0] == h and rgb.shape[1] == w:
            gray = (0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1]
                    + 0.114 * rgb[:, :, 2]).astype(np.float32)
            rgb_gmag = np.hypot(ndimage.sobel(gray, axis=0, mode='nearest'),
                                ndimage.sobel(gray, axis=1, mode='nearest'))
            rgb_edge_fg = valid & (rgb_gmag > self.rgb_edge_thresh)
            foreground = foreground | rgb_edge_fg

        # Closing (dilate->erode) fills gaps in/between fragments; fill enclosed
        # edge contours; THEN opening (erode->dilate) removes speckle noise.
        foreground = self._erode(self._dilate(foreground, self.dilate_k), self.dilate_k)
        foreground = ndimage.binary_fill_holes(foreground)
        foreground = self._dilate(self._erode(foreground, self.erode_k), self.erode_k)

        # Carve depth-discontinuity boundaries OUT of the foreground so
        # neighbouring objects whose 2D masks touch get split. Uses true
        # per-pixel depth derivatives (np.gradient), not sobel-scaled
        # values — threshold is "metres per pixel".
        gy, gx = np.gradient(depth_filled)
        boundary = (np.hypot(gx, gy) > self.split_thresh) & valid
        boundary = ndimage.binary_dilation(boundary, iterations=1)
        foreground = foreground & ~boundary

        # Multi-scale connected components: full res + 2x block-OR downsample
        bboxes = self._components(foreground, scale=1)
        h2, w2 = h // 2, w // 2
        fg2 = foreground[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2).any(axis=(1, 3))
        bboxes += self._components(fg2, scale=2)
        bboxes = self._merge_iou(bboxes, thr=0.5)
        # Coalesce fragments of the same object (overlap OR near-touching edges)
        bboxes = self._merge_nearby(bboxes)

        # Build per-object detections (tight bbox + pad, 3D OBB via PCA)
        objects = []
        for (x0, y0, x1, y1) in bboxes:
            x0 = max(0, x0 - self.pad); y0 = max(0, y0 - self.pad)
            x1 = min(w, x1 + self.pad); y1 = min(h, y1 + self.pad)
            sub_d = depth[y0:y1, x0:x1]
            sub_fg = foreground[y0:y1, x0:x1]
            bbox_area = (x1 - x0) * (y1 - y0)

            # Vectorised deprojection of every foreground pixel in the bbox
            # whose depth is valid, *after* mask erosion (to drop edge
            # contamination), table-plane removal, and a 1.5σ outlier
            # cull. Indices are local to the bbox, so cx/cy are offset by
            # (x0, y0) to keep coordinates in the full image.
            pts3d = self._refine_object_points(
                sub_d, sub_fg.astype(bool), fx, fy, cx - x0, cy - y0,
            )

            # FIX B: oversized bbox — try k-means split before treating
            # it as one object. If splitting yields >=2 reasonable
            # clusters, emit each as its own detection and skip the
            # single-object handling below.
            if bbox_area > self.max_bbox_area and pts3d.shape[0] >= 40:
                clusters, ok = self._kmeans_split(pts3d, bbox_area)
                if ok:
                    for c in clusters:
                        d = self._build_obj_from_cluster(c, fx, fy, cx, cy, w, h)
                        if d is not None:
                            objects.append(d)
                    continue
            # Cheap fallback for nearly-empty masks: use any valid depth
            # in the bbox so we still emit a 2D detection.
            if pts3d.shape[0] < 5:
                rd = sub_d[(sub_d > 0) & np.isfinite(sub_d)]
                if rd.size == 0:
                    continue
                zc = float(np.median(rd))
                ucen, vcen = (x0 + x1) * 0.5, (y0 + y1) * 0.5
                objects.append({
                    'bbox_px':  (int(x0), int(y0), int(x1), int(y1)),
                    'pos':      (float((ucen - cx) * zc / fx),
                                 float((vcen - cy) * zc / fy), zc),
                    'size_3d':  (float((x1 - x0) * zc / fx),
                                 float((y1 - y0) * zc / fy), 0.05),
                    'quat':     (0.0, 0.0, 0.0, 1.0),
                    'euler':    (0.0, 0.0, 0.0),
                    'corners':  None,
                    'obb':      False,
                })
                continue

            # Fewer than 20 points => OBB will be noisy; degrade to an
            # axis-aligned bbox derived from the same point set.
            if pts3d.shape[0] < 20:
                centroid = pts3d.mean(axis=0)
                extents = pts3d.max(axis=0) - pts3d.min(axis=0)
                objects.append({
                    'bbox_px':  (int(x0), int(y0), int(x1), int(y1)),
                    'pos':      tuple(float(v) for v in centroid),
                    'size_3d':  tuple(float(v) for v in extents.clip(0.01, None)),
                    'quat':     (0.0, 0.0, 0.0, 1.0),
                    'euler':    (0.0, 0.0, 0.0),
                    'corners':  None,
                    'obb':      False,
                })
                continue

            centroid, size_3d, R = self._fit_obb(pts3d)
            quat, euler = self._rmat_to_quat_euler(R)
            corners = self._obb_corners(centroid, size_3d, R)
            objects.append({
                'bbox_px':  (int(x0), int(y0), int(x1), int(y1)),
                'pos':      (float(centroid[0]), float(centroid[1]), float(centroid[2])),
                'size_3d':  (float(size_3d[0]), float(size_3d[1]), float(size_3d[2])),
                'quat':     tuple(float(q) for q in quat),
                'euler':    euler,
                'corners':  corners,
                'obb':      True,
            })

        self._history.append(objects)
        self._emit(h, w)

        self._log_count += 1
        if self._log_count % 30 == 0:
            self.get_logger().info(f'{len(self._temporal_filter())} object(s) detected')

    def _emit(self, h, w):
        """Apply temporal smoothing, then publish detections + annotated image."""
        stable = self._temporal_filter()
        self._publish(stable, h, w)

    # ── Publishing ────────────────────────────────────────────────────────────

    def _cam_to_lidar(self, pos_cam, quat_cam_xyzw):
        """Transform a (position, quaternion) pair from this node's camera-
        optical frame into the LiDAR frame using the loaded R_lc / t_lc."""
        p_cam = np.asarray(pos_cam, dtype=np.float64).reshape(3)
        p_lid = (self._R_lc @ p_cam) + self._t_lc
        # World rotation = R_lc * R_obj  (the OBB's orientation expressed
        # in the LiDAR frame). Compose quaternions via scipy.
        q_lid = (_SR.from_quat(self._q_lc) * _SR.from_quat(quat_cam_xyzw)).as_quat()
        return p_lid, q_lid

    def _publish(self, objects, h, w):
        stamp = self._depth_hdr.stamp if self._depth_hdr else self.get_clock().now().to_msg()
        arr = Detection3DArray()
        arr.header.stamp = stamp
        # Detections are reframed into livox_frame so the dashboard /
        # grasp planner / any other consumer see a single coherent
        # world frame. The annotated image still uses cam-frame data
        # for projection (kept in `corners`).
        arr.header.frame_id = self._lidar_frame_id
        for o in objects:
            det = Detection3D()
            det.header = arr.header
            hyp = ObjectHypothesisWithPose()
            hyp.hypothesis.class_id = 'object'
            hyp.hypothesis.score = 1.0
            p_lid, q_lid = self._cam_to_lidar(o['pos'], o['quat'])
            px, py, pz = float(p_lid[0]), float(p_lid[1]), float(p_lid[2])
            qx, qy, qz, qw = (float(q_lid[0]), float(q_lid[1]),
                              float(q_lid[2]), float(q_lid[3]))
            sx, sy, sz = o['size_3d']
            hyp.pose.pose.position.x = px
            hyp.pose.pose.position.y = py
            hyp.pose.pose.position.z = pz
            hyp.pose.pose.orientation.x = qx
            hyp.pose.pose.orientation.y = qy
            hyp.pose.pose.orientation.z = qz
            hyp.pose.pose.orientation.w = qw
            det.results.append(hyp)
            det.bbox.center.position.x    = px
            det.bbox.center.position.y    = py
            det.bbox.center.position.z    = pz
            det.bbox.center.orientation.x = qx
            det.bbox.center.orientation.y = qy
            det.bbox.center.orientation.z = qz
            det.bbox.center.orientation.w = qw
            det.bbox.size.x = float(sx)
            det.bbox.size.y = float(sy)
            det.bbox.size.z = float(sz)
            arr.detections.append(det)
        self.det_pub.publish(arr)
        self._publish_annotated(objects, h, w)

    @staticmethod
    def _dist_color(z):
        return (0, 255, 0)  # consistent green (#00FF00) for every box + label

    def _project(self, pts3d: np.ndarray, w: int, h: int):
        """Project Nx3 camera-frame points to (u, v) pixels. Returns Nx2."""
        if self._K is None or pts3d.size == 0:
            return None
        fx, fy, cx, cy = self._K
        z = pts3d[:, 2]
        # Behind-camera points produce huge garbage; clamp to a small +ve depth.
        z_safe = np.where(z > 0.01, z, 0.01)
        u = fx * pts3d[:, 0] / z_safe + cx
        v = fy * pts3d[:, 1] / z_safe + cy
        return np.stack([u, v], axis=1)

    def _draw_obb_wireframe(self, draw, corners_2d, color):
        for a, b in _CUBE_EDGES:
            u0, v0 = corners_2d[a]
            u1, v1 = corners_2d[b]
            draw.line([(float(u0), float(v0)), (float(u1), float(v1))],
                      fill=color, width=2)

    def _publish_annotated(self, objects, h, w):
        rgb = self._color_rgb
        if rgb is None or rgb.shape[0] != h or rgb.shape[1] != w:
            return
        img = PILImage.fromarray(rgb.copy(), 'RGB')
        draw = ImageDraw.Draw(img)
        for o in objects:
            x0, y0, x1, y1 = o['bbox_px']
            px, py, pz = o['pos']
            sx, sy, sz = o['size_3d']
            roll, pitch, yaw = o['euler']
            col = self._dist_color(pz)

            # 2D bbox in green
            draw.rectangle([x0, y0, x1, y1], outline=col, width=2)

            # Cyan OBB wireframe (projected from the 8 3D corners).
            if o.get('obb') and o.get('corners') is not None:
                proj = self._project(o['corners'], w, h)
                if proj is not None:
                    self._draw_obb_wireframe(draw, proj, (0, 220, 255))

            # Yaw is the only meaningful rotation (yaw-only OBB); size
            # collapsed to the two XY dims for a top-down read.
            yaw_deg = yaw * 180.0 / math.pi
            w_cm = int(round(sx * 100))
            h_cm = int(round(sy * 100))
            label = f'{pz:.2f}m  {w_cm}×{h_cm}cm  yaw:{yaw_deg:+.0f}°'
            tw = len(label) * 6 + 6
            draw.rectangle([x0, max(0, y0 - 13), x0 + tw, y0], fill=col)
            draw.text((x0 + 2, max(0, y0 - 12)), label, fill=(255, 255, 255))

        msg = Image()
        msg.header.stamp = self._depth_hdr.stamp if self._depth_hdr else self.get_clock().now().to_msg()
        msg.header.frame_id = self.frame_id
        msg.height = h
        msg.width = w
        msg.encoding = 'rgb8'
        msg.step = w * 3
        msg.data = img.tobytes()
        self.ann_pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = DepthSegmentNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
