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
import json
import math
import os
import numpy as np
import rclpy
import yaml
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image, CameraInfo
from std_msgs.msg import String
from vision_msgs.msg import Detection3DArray, Detection3D, ObjectHypothesisWithPose

try:
    from object_detection.shape_matcher import match_geometry as _match_geometry
    _MATCHER_OK = True
except ImportError:
    _MATCHER_OK = False
    def _match_geometry(*_a, **_kw):
        return None, 0.0, ''
from scipy import ndimage
from scipy.spatial.transform import Rotation as _SR
from PIL import Image as PILImage, ImageDraw, ImageFont

try:
    _ANNOT_FONT = ImageFont.truetype(
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 16)
    _ANNOT_FONT_SMALL = ImageFont.truetype(
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 13)
except Exception:
    _ANNOT_FONT = ImageFont.load_default()
    _ANNOT_FONT_SMALL = _ANNOT_FONT

# 12 edges of a unit cube, as pairs of corner indices (binary xyz).
_CUBE_EDGES = ((0, 1), (0, 2), (0, 4), (1, 3), (1, 5), (2, 3),
               (2, 6), (3, 7), (4, 5), (4, 6), (5, 7), (6, 7))

# Standard optical -> ROS quaternion (xyzw) — matches sensor_tf_publisher.
# Produces R = [[0,0,1],[-1,0,0],[0,-1,0]] which maps cam X->lidar -Y,
# cam Y->lidar -Z, cam Z->lidar +X. The qw sign matters: +0.5 yields a
# different rotation (cam X->lidar +Z) that treats the camera as
# pointing DOWN, not forward.
_OPTICAL_TO_ROS_Q = (0.5, -0.5, 0.5, -0.5)

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

        # Detection-mode toggle (published by dashboard /cmd/detection_mode).
        # "all" passes every stable segment through; "library" drops
        # everything that didn't match a CAD part.
        self._detection_mode = 'all'
        self.create_subscription(
            String, '/perception/detection_mode',
            self._on_detection_mode, 10)

        # Teach-mode: operator presses "teach as <part>" against a live
        # detection; depth_segment captures the cropped depth + mask
        # of that detection and persists it under
        # /opt/cobot/parts/teach/<part_id>/ref_NNN.npz. _match_by_teach
        # then uses real captured profiles instead of synthetic CAD
        # silhouettes.
        self._last_objects = []     # latest stable detection list (with crops)
        self._teach_refs   = {}     # part_id -> [ {depth, mask, size_m} ]
        self._load_teach_refs()
        self.create_subscription(
            String, '/perception/teach_command',
            self._on_teach_command, 10)

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
                '_pts3d':   cluster,
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
            '_pts3d':   cluster,
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

    def _merge_overlapping_detections(self, dets, w_img, h_img,
                                      iou_thr: float = 0.15,
                                      dist_thr_px: float = 30.0,
                                      depth_thr_m: float = 0.06):
        """Coalesce post-OBB detections that visibly cover the same object.

        Two detections are linked when EITHER their 2D bboxes overlap
        (IoU > iou_thr) OR their pixel centroids are within dist_thr_px
        AND their depths are within depth_thr_m. The depth gate stops
        stacked-at-different-ranges objects from collapsing into one.
        Links are resolved transitively via union-find so a long chain of
        ring arcs (A overlaps B overlaps C ...) all end up in the same
        group. Each group's bbox becomes the union and the OBB is
        re-fitted on the concatenated source point cloud.
        """
        n = len(dets)
        if n <= 1:
            return dets

        # Pre-compute pixel centroids and centred-z values.
        bb = [d['bbox_px'] for d in dets]
        cen = [((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5) for b in bb]
        zs  = [d['pos'][2] for d in dets]

        # Union-find for transitive merging.
        parent = list(range(n))
        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        for i in range(n):
            for j in range(i + 1, n):
                if find(i) == find(j):
                    continue
                iou = self._iou(bb[i], bb[j])
                dist = ((cen[i][0] - cen[j][0]) ** 2
                        + (cen[i][1] - cen[j][1]) ** 2) ** 0.5
                depth_diff = abs(zs[i] - zs[j])
                if iou > iou_thr or (dist < dist_thr_px and depth_diff < depth_thr_m):
                    union(i, j)

        groups = {}
        for i in range(n):
            groups.setdefault(find(i), []).append(i)

        merged = []
        for group in groups.values():
            if len(group) == 1:
                merged.append(dets[group[0]])
                continue
            clouds = [dets[g].get('_pts3d') for g in group]
            clouds = [c for c in clouds if c is not None and c.shape[0] > 0]
            bx0 = max(0,     min(dets[g]['bbox_px'][0] for g in group))
            by0 = max(0,     min(dets[g]['bbox_px'][1] for g in group))
            bx1 = min(w_img, max(dets[g]['bbox_px'][2] for g in group))
            by1 = min(h_img, max(dets[g]['bbox_px'][3] for g in group))
            if clouds:
                combined = np.concatenate(clouds, axis=0)
                centroid, size_3d, R = self._fit_obb(combined)
                quat, euler = self._rmat_to_quat_euler(R)
                corners = self._obb_corners(centroid, size_3d, R)
                # Carry mask_2d / depth_2d forward from the largest
                # input so the merged detection still has a per-object
                # crop available to the teach-capture and shape
                # matchers. Picks the member with the most foreground
                # pixels.
                src_idx = max(
                    group,
                    key=lambda g: int(np.sum(dets[g].get('mask_2d')))
                    if isinstance(dets[g].get('mask_2d'), np.ndarray) else 0,
                )
                merged.append({
                    'bbox_px':       (int(bx0), int(by0), int(bx1), int(by1)),
                    'pos':           (float(centroid[0]), float(centroid[1]), float(centroid[2])),
                    'size_3d':       (float(size_3d[0]), float(size_3d[1]), float(size_3d[2])),
                    'quat':          tuple(float(q) for q in quat),
                    'euler':         euler,
                    'corners':       corners,
                    'obb':           True,
                    '_pts3d':        combined,
                    '_merged_from':  len(group),
                    'mask_2d':       dets[src_idx].get('mask_2d'),
                    'depth_2d':      dets[src_idx].get('depth_2d'),
                })
            else:
                base = dict(dets[group[0]])
                base['bbox_px']      = (int(bx0), int(by0), int(bx1), int(by1))
                base['_merged_from'] = len(group)
                merged.append(base)
        return merged

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
        # Re-fill enclosed holes that the carving just opened. For a ring
        # the inner depth edge gets carved, leaving the centre disconnected;
        # fill_holes only fills regions FULLY surrounded by foreground, so
        # two distinct objects with a carved gap that touches the image
        # border stay split — only ring-style enclosed holes are restored.
        foreground = ndimage.binary_fill_holes(foreground)

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
                    'mask_2d':  np.ascontiguousarray(sub_fg, dtype=bool),
                    'depth_2d': np.ascontiguousarray(sub_d, dtype=np.float32),
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
                    '_pts3d':   pts3d,
                    'mask_2d':  np.ascontiguousarray(sub_fg, dtype=bool),
                    'depth_2d': np.ascontiguousarray(sub_d, dtype=np.float32),
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
                '_pts3d':   pts3d,
                'mask_2d':  np.ascontiguousarray(sub_fg, dtype=bool),
                'depth_2d': np.ascontiguousarray(sub_d,  dtype=np.float32),
            })

        # Final safety net: merge any remaining overlapping or near-coincident
        # detections, re-fitting the OBB on the union of their point clouds.
        # Catches ring/donut shapes where the depth-gap carving still splits
        # the annulus into arcs despite the post-carving fill_holes.
        objects = self._merge_overlapping_detections(objects, w, h)

        # Attach RGB crops once for every detection (used by teach
        # capture + matching). Doing it here covers all build paths
        # (main OBB, small-points fallback, kmeans clusters, merged).
        rgb_full = self._color_rgb
        if rgb_full is not None and rgb_full.shape[0] == h and rgb_full.shape[1] == w:
            for o in objects:
                bx0, by0, bx1, by1 = o['bbox_px']
                bx0 = max(0, int(bx0)); by0 = max(0, int(by0))
                bx1 = min(w, int(bx1)); by1 = min(h, int(by1))
                if bx1 > bx0 and by1 > by0:
                    o['color_crop'] = rgb_full[by0:by1, bx0:bx1].copy()

        self._history.append(objects)
        self._emit(h, w)

        self._log_count += 1
        if self._log_count % 30 == 0:
            self.get_logger().info(f'{len(self._temporal_filter())} object(s) detected')

    # ── Teach-mode helpers ──────────────────────────────────────────────────

    def _teach_dir(self, part_id):
        return os.path.join('/opt/cobot/parts/teach', str(part_id))

    def _load_teach_refs(self):
        """Read every /opt/cobot/parts/teach/<id>/*.npz back into memory."""
        self._teach_refs = {}
        base = '/opt/cobot/parts/teach'
        if not os.path.isdir(base):
            return
        for pid in os.listdir(base):
            pdir = os.path.join(base, pid)
            if not os.path.isdir(pdir):
                continue
            refs = []
            for fn in sorted(os.listdir(pdir)):
                if not fn.endswith('.npz'):
                    continue
                try:
                    z = np.load(os.path.join(pdir, fn))
                    ref = {
                        'depth':  np.asarray(z['depth'],  dtype=np.float32),
                        'mask':   np.asarray(z['mask'],   dtype=bool),
                        'size_m': np.asarray(z['size_m'], dtype=np.float32),
                        'gray':   None,
                    }
                    if 'gray' in z.files:
                        ref['gray'] = np.asarray(z['gray'], dtype=np.float32)
                    refs.append(ref)
                except Exception:
                    continue
            if refs:
                self._teach_refs[pid] = refs
        if self._teach_refs:
            self.get_logger().info(
                'teach refs loaded: '
                + ', '.join(
                    f'{k}({len(v)}, rgb={"yes" if any(r["gray"] is not None for r in v) else "no"})'
                    for k, v in self._teach_refs.items())
            )

    def _on_teach_command(self, msg):
        try:
            cmd = json.loads(msg.data) if msg.data else {}
        except Exception:
            return
        action = cmd.get('action')
        if action == 'reload':
            self._load_teach_refs()
            return
        if action != 'teach':
            return
        part_id = cmd.get('part_id')
        if not part_id:
            self.get_logger().warn('teach: missing part_id')
            return
        if not self._last_objects:
            self.get_logger().warn('teach: no recent detections')
            return
        idx = int(cmd.get('detection_index') or 0)
        if idx < 0 or idx >= len(self._last_objects):
            idx = 0
        det = self._last_objects[idx]
        mask  = det.get('mask_2d')
        depth = det.get('depth_2d')
        color = det.get('color_crop')
        size  = det.get('size_3d') or (0.05, 0.05, 0.05)
        if mask is None or depth is None or not np.any(mask):
            self.get_logger().warn('teach: detection has no mask/depth')
            return
        try:
            d_std, m_std = self._normalise_for_match(depth, mask)
        except Exception as e:
            self.get_logger().error(f'teach: normalise failed: {e}')
            return

        # RGB is far more distinctive than depth on small metal parts.
        # Resize to 64x64, take grayscale, normalise to [0,1] per-crop so
        # lighting drift across teach sessions doesn't blow up the NCC.
        gray_64 = None
        color_64 = None
        if color is not None and color.size > 0:
            try:
                from scipy.ndimage import zoom as _zoom
                ch, cw = color.shape[:2]
                if ch > 0 and cw > 0:
                    fy = 64.0 / float(ch); fx = 64.0 / float(cw)
                    if color.ndim == 3:
                        color_64 = _zoom(color.astype(np.float32), (fy, fx, 1), order=1)
                        gray_64  = color_64.mean(axis=2)
                    else:
                        gray_64  = _zoom(color.astype(np.float32), (fy, fx), order=1)
                    g_min = float(gray_64.min()); g_max = float(gray_64.max())
                    if g_max > g_min:
                        gray_64 = (gray_64 - g_min) / (g_max - g_min)
                    else:
                        gray_64 = np.zeros_like(gray_64)
            except Exception as e:
                self.get_logger().warn(f'teach: gray prep failed: {e}')
                gray_64 = None
                color_64 = None

        os.makedirs(self._teach_dir(part_id), exist_ok=True)
        existing = sum(1 for f in os.listdir(self._teach_dir(part_id)) if f.endswith('.npz'))
        out_path = os.path.join(self._teach_dir(part_id), f'ref_{existing:03d}.npz')
        try:
            save_kwargs = {
                'depth':  d_std.astype(np.float32),
                'mask':   m_std.astype(bool),
                'size_m': np.asarray(size, dtype=np.float32),
            }
            if gray_64 is not None:
                save_kwargs['gray'] = gray_64.astype(np.float32)
            if color_64 is not None:
                save_kwargs['color'] = np.clip(color_64, 0, 255).astype(np.uint8)
            np.savez_compressed(out_path, **save_kwargs)
        except Exception as e:
            self.get_logger().error(f'teach: save failed: {e}')
            return
        self._load_teach_refs()
        n = len(self._teach_refs.get(part_id, []))
        has_rgb = 'yes' if gray_64 is not None else 'no'
        self.get_logger().info(
            f'teach: saved {out_path} (part now has {n} refs, rgb={has_rgb})')

    @staticmethod
    def _normalise_for_match(depth_crop, mask_crop, target=64):
        """Resize crop to target x target, normalise depth within the
        mask to [0, 1]. Returns (depth_std, mask_std)."""
        from scipy.ndimage import zoom
        h, w = mask_crop.shape[:2]
        if h == 0 or w == 0:
            return (np.zeros((target, target), dtype=np.float32),
                    np.zeros((target, target), dtype=bool))
        fy = target / float(h); fx = target / float(w)
        d  = zoom(depth_crop.astype(np.float32), (fy, fx), order=1)
        m  = zoom(mask_crop.astype(np.float32),  (fy, fx), order=1) > 0.5
        valid = m & np.isfinite(d) & (d > 0)
        if valid.any():
            dmin = float(d[valid].min())
            dmax = float(d[valid].max())
            if dmax > dmin:
                d = (d - dmin) / (dmax - dmin)
            else:
                d = np.zeros_like(d)
        d[~m] = 0.0
        return d.astype(np.float32), m

    def _match_by_teach(self, depth_crop, mask_crop, obb_size, color_crop=None):
        """Match against taught references. RGB grayscale NCC dominates
        because depth on small metal parts is too noisy to discriminate;
        mask IoU + depth NCC + size act as supporting signals. Each
        candidate is scored across 4 mask/RGB rotations to absorb yaw
        ambiguity from the OBB fit. Returns (name, id, score) or
        ('unknown', None, 0); threshold 0.55."""
        if not self._teach_refs:
            return 'unknown', None, 0.0
        if depth_crop is None or mask_crop is None or not np.any(mask_crop):
            return 'unknown', None, 0.0

        try:
            det_d, det_m = self._normalise_for_match(depth_crop, mask_crop)
        except Exception:
            return 'unknown', None, 0.0

        # Per-crop grayscale, normalised to [0,1] so lighting drift
        # between teach and runtime doesn't dominate the NCC.
        det_g = None
        if color_crop is not None and color_crop.size > 0:
            try:
                from scipy.ndimage import zoom as _zoom
                ch, cw = color_crop.shape[:2]
                if ch > 0 and cw > 0:
                    fy = 64.0 / float(ch); fx = 64.0 / float(cw)
                    if color_crop.ndim == 3:
                        g = color_crop.astype(np.float32).mean(axis=2)
                    else:
                        g = color_crop.astype(np.float32)
                    g64 = _zoom(g, (fy, fx), order=1)
                    g_min = float(g64.min()); g_max = float(g64.max())
                    if g_max > g_min:
                        det_g = (g64 - g_min) / (g_max - g_min)
                    else:
                        det_g = np.zeros_like(g64)
            except Exception:
                det_g = None

        det_sorted = sorted([float(s) for s in obb_size], reverse=True)

        best_name, best_id, best_score = 'unknown', None, 0.0
        best_breakdown = (0.0, 0.0, 0.0, 0.0)  # gray, iou, depth, size
        for pid, refs in self._teach_refs.items():
            for ref in refs:
                ref_sorted = sorted([float(s) for s in ref['size_m']], reverse=True)
                size_ratios = [min(d, r) / max(d, r, 1e-3)
                               for d, r in zip(det_sorted, ref_sorted)]
                if any(r < 0.5 for r in size_ratios):
                    continue
                size_score = sum(size_ratios) / 3.0

                ref_m = ref['mask']
                if ref_m.shape != det_m.shape:
                    continue
                ref_d = ref['depth']
                ref_g = ref.get('gray')

                # Try all 4 rotations of the DETECTION crops against the
                # fixed reference. The OBB fit can flip yaw 90°/180° on
                # symmetric parts, so picking the best rotation prevents
                # a correct match from being thrown out.
                mask_iou_best = 0.0
                depth_best    = 0.0
                gray_best     = 0.0
                for rot in range(4):
                    m_rot = np.rot90(det_m, rot)
                    d_rot = np.rot90(det_d, rot)
                    inter = int(np.sum(m_rot & ref_m))
                    union = int(np.sum(m_rot | ref_m))
                    if union == 0:
                        continue
                    iou = inter / union
                    if iou > mask_iou_best:
                        mask_iou_best = iou

                    overlap = m_rot & ref_m
                    if int(np.sum(overlap)) >= 100:
                        a = d_rot[overlap]; b = ref_d[overlap]
                        a_s = float(a.std()); b_s = float(b.std())
                        if a_s > 0.01 and b_s > 0.01:
                            ncc = float(np.mean(
                                (a - float(a.mean())) * (b - float(b.mean()))
                            ) / (a_s * b_s))
                            if ncc > depth_best:
                                depth_best = ncc

                    if det_g is not None and ref_g is not None:
                        g_rot = np.rot90(det_g, rot)
                        a = g_rot.ravel(); b = ref_g.ravel()
                        a_s = float(a.std()); b_s = float(b.std())
                        if a_s > 0.02 and b_s > 0.02:
                            ncc = float(np.mean(
                                (a - float(a.mean())) * (b - float(b.mean()))
                            ) / (a_s * b_s))
                            if ncc > gray_best:
                                gray_best = ncc

                depth_score = max(0.0, depth_best)
                gray_score  = max(0.0, gray_best)

                if det_g is not None and ref_g is not None:
                    # RGB available on both sides — weight it heavily;
                    # depth is the least-reliable channel for small parts.
                    score = (gray_score   * 0.45 +
                             mask_iou_best * 0.20 +
                             depth_score   * 0.10 +
                             size_score    * 0.25)
                else:
                    # Legacy ref (or detection has no colour) — fall back
                    # to the original depth+mask+size blend.
                    score = (mask_iou_best * 0.35 +
                             depth_score   * 0.30 +
                             size_score    * 0.35)

                if score > best_score:
                    best_score = score
                    best_id    = pid
                    best_breakdown = (gray_score, mask_iou_best, depth_score, size_score)
                    meta_path  = f'/opt/cobot/parts/metadata/{pid}.json'
                    try:
                        with open(meta_path) as fp:
                            best_name = json.load(fp).get('name') or pid
                    except Exception:
                        best_name = pid

        if best_score > 0.30:
            g, m, d, sz = best_breakdown
            self.get_logger().info(
                f'TEACH_MATCH: {best_name} score={best_score:.2f} '
                f'gray={g:.2f} mask_iou={m:.2f} depth={d:.2f} size={sz:.2f}',
                throttle_duration_sec=3.0)

        if best_score < 0.55:
            return 'unknown', None, 0.0
        return best_name, best_id, round(best_score, 3)

    def _on_detection_mode(self, msg):
        try:
            data = json.loads(msg.data) if msg.data else {}
            mode = str(data.get('detection_mode') or 'all')
            if mode in ('all', 'library') and mode != self._detection_mode:
                self._detection_mode = mode
                self.get_logger().info(f'detection mode -> {mode}')
        except Exception:
            pass

    def _emit(self, h, w):
        """Apply temporal smoothing, match against the parts library,
        then publish detections + annotated image."""
        stable = self._temporal_filter()
        self._match_parts(stable)
        # Keep the latest stable list around so a teach command can
        # capture the user's chosen detection without needing the
        # caller to ship the full mask + depth crops over HTTP.
        self._last_objects = stable
        self._publish(stable, h, w)

    # ── Library matching helpers ──────────────────────────────────────────────

    @staticmethod
    def _load_library_parts():
        """List of full metadata dicts from /opt/cobot/parts/metadata/.
        Re-reads on every call — tiny library, negligible cost."""
        try:
            from object_detection.part_library import get_all_parts
        except Exception:
            return []
        parts = []
        for entry in get_all_parts():
            mp = f"/opt/cobot/parts/metadata/{entry.get('id', '')}.json"
            if os.path.isfile(mp):
                try:
                    with open(mp) as f:
                        parts.append(json.load(f))
                except Exception:
                    pass
        return parts

    @staticmethod
    def _match_by_size(obb_size_m, library_parts):
        """Rank parts by per-dimension ratio (sorted-dim, so the
        part's orientation in the camera doesn't matter). HARD floor:
        every individual ratio must clear 0.70 or the candidate is
        rejected — otherwise an 8x4x2 cm part trivially "matches" a
        3x2x1 cm part on the average. Final mean ratio must clear
        0.75 to be returned."""
        det = sorted([float(s) for s in obb_size_m], reverse=True)
        best_part, best_score = None, 0.0
        for part in library_parts:
            ext = [e / 100.0 for e in (part.get('extents_cm') or [0, 0, 0])]
            if not all(e > 0.001 for e in ext):
                continue
            part_sorted = sorted(ext, reverse=True)
            ratios = [min(d, p) / max(d, p) for d, p in zip(det, part_sorted)]
            if any(r < 0.70 for r in ratios):
                continue
            s = sum(ratios) / 3.0
            if s > best_score:
                best_score = s
                best_part  = part
        if best_part and best_score >= 0.75:
            return best_part.get('name'), best_part.get('id'), round(best_score, 3)
        return None, None, 0.0

    @staticmethod
    def _match_by_depth_profile(depth_crop, mask_crop, obb_size_m, library_parts):
        """Use the depth range of the object (its standing height) plus
        the sorted-dim size comparison. Independent of camera yaw and
        robust to mild lighting changes."""
        if depth_crop is None or mask_crop is None:
            return None, None, 0.0
        try:
            valid = mask_crop & (depth_crop > 0.0) & np.isfinite(depth_crop)
            if not valid.any():
                return None, None, 0.0
            obj_depths = depth_crop[valid]
            height = float(obj_depths.max() - obj_depths.min())
            if height < 0.002:
                return None, None, 0.0
        except Exception:
            return None, None, 0.0

        det_sorted = sorted([float(s) for s in obb_size_m], reverse=True)
        best_part, best_score = None, 0.0
        for part in library_parts:
            ext = [e / 100.0 for e in (part.get('extents_cm') or [0, 0, 0])]
            if not all(e > 0.001 for e in ext):
                continue
            part_height = min(ext)
            h_ratio = min(height, part_height) / max(height, part_height)
            part_sorted = sorted(ext, reverse=True)
            sz_ratios = [min(d, p) / max(d, p) for d, p in zip(det_sorted, part_sorted)]
            sz_score = sum(sz_ratios) / 3.0
            # Hard size floor mirrors _match_by_size — depth profile
            # alone can't rescue a poor dimensional match.
            sz_ratios = [min(d, p) / max(d, p) for d, p in zip(det_sorted, part_sorted)]
            if any(r < 0.70 for r in sz_ratios):
                continue
            s = h_ratio * 0.4 + sz_score * 0.6
            if s > best_score:
                best_score = s
                best_part  = part
        if best_part and best_score >= 0.70:
            return best_part.get('name'), best_part.get('id'), round(best_score, 3)
        return None, None, 0.0

    @staticmethod
    def _verify_position(part_meta, yaw_rad, obb_size_m):
        """Compare detected yaw + standing height against the part's
        saved configuration. Returns (position_correct, yaw_err_deg,
        surface_ok). Tolerant defaults when the operator hasn't yet
        configured the part (front_angle_deg / table_height_m missing)."""
        try:
            yaw_deg = (math.degrees(float(yaw_rad)) + 180.0) % 180.0
        except Exception:
            yaw_deg = 0.0
        try:
            expected_yaw = float(part_meta.get('front_angle_deg') or 0.0) % 180.0
        except Exception:
            expected_yaw = 0.0
        yaw_err = abs(yaw_deg - expected_yaw)
        if yaw_err > 90.0:
            yaw_err = 180.0 - yaw_err
        yaw_ok = yaw_err < 20.0

        ext_m = part_meta.get('extents_m') or []
        expected_height = float(
            part_meta.get('table_height_m')
            or (min(ext_m) if ext_m else 0.0)
            or 0.0
        )
        actual_height = float(min(obb_size_m)) if obb_size_m else 0.0
        if expected_height < 1e-4 or actual_height < 1e-4:
            surface_ok = True  # no reference -> don't penalise
        else:
            h_ratio = min(actual_height, expected_height) / max(actual_height, expected_height)
            surface_ok = h_ratio > 0.7
        return (yaw_ok and surface_ok), round(yaw_err, 1), surface_ok

    @staticmethod
    def _extract_detection_features(depth_crop, mask_crop):
        """Same geometric fingerprint extract_geometric_features() builds
        from a CAD mesh — but starting from a camera depth crop.

        Camera depth gets flipped before normalising (smaller depth =
        closer to camera = higher physical surface), so the resulting
        height-map shares its sign convention with the CAD top-down
        height-map. Without the flip the NCC against the CAD reference
        is negative and the geometry matcher truncates it to 0.
        """
        from scipy.ndimage import (
            sobel as _sobel,
            binary_fill_holes as _fill,
            label as _label,
            zoom as _zoom,
        )

        features: dict = {}
        if depth_crop is None or mask_crop is None:
            return features
        if mask_crop.shape[0] < 5 or mask_crop.shape[1] < 5:
            return features

        valid = mask_crop & (depth_crop > 0) & np.isfinite(depth_crop)
        if not valid.any():
            return features

        d_min = float(depth_crop[valid].min())
        d_max = float(depth_crop[valid].max())
        height_range = d_max - d_min

        if height_range < 0.001:
            norm_depth = np.zeros_like(depth_crop, dtype=np.float32)
        else:
            # Invert: nearest-to-camera (smallest depth) maps to 1,
            # furthest to 0 — matches the CAD top-down convention.
            norm_depth = ((d_max - depth_crop) / height_range).astype(np.float32)
            norm_depth[~valid] = 0.0

        # 1) Holes from internal voids in the mask.
        filled = _fill(mask_crop)
        internal_voids = filled & ~mask_crop
        labeled_holes, num_holes = _label(internal_voids)
        holes = []
        for h in range(1, int(num_holes) + 1):
            hy, hx = np.where(labeled_holes == h)
            area = int(len(hy))
            cy = float(np.mean(hy)) / mask_crop.shape[0]
            cx = float(np.mean(hx)) / mask_crop.shape[1]
            radius = float(np.sqrt(area / np.pi)) / max(mask_crop.shape)
            holes.append({
                'center':      [round(cx, 3), round(cy, 3)],
                'radius_norm': round(radius, 4),
                'area_norm':   round(area / max(mask_crop.size, 1), 4),
            })
        features['holes'] = holes
        features['num_holes'] = int(num_holes)

        # 1b) Depth-discontinuity hole detection — a through-hole shows
        # up as the table surface peeking through the object outline,
        # i.e. a sharp depth increase relative to the object median.
        # The mask alone misses these because the depth there is valid.
        if valid.any() and height_range > 0.003:
            obj_median_depth = float(np.median(depth_crop[valid]))
            deep_mask = (mask_crop
                         & (depth_crop > obj_median_depth + 0.015)
                         & (depth_crop > 0))
            deep_filled = _fill(mask_crop)
            deep_voids = deep_filled & deep_mask

            if deep_voids.any():
                labeled_deep, num_deep = _label(deep_voids)
                for h in range(1, int(num_deep) + 1):
                    hy, hx = np.where(labeled_deep == h)
                    area = int(len(hy))
                    if area < 20:
                        continue
                    cy = float(np.mean(hy)) / mask_crop.shape[0]
                    cx = float(np.mean(hx)) / mask_crop.shape[1]
                    radius = float(np.sqrt(area / np.pi)) / max(mask_crop.shape)

                    is_dup = False
                    for existing in holes:
                        ec = existing['center']
                        dist = ((cx - ec[0]) ** 2 + (cy - ec[1]) ** 2) ** 0.5
                        if dist < 0.1:
                            is_dup = True
                            break
                    if is_dup:
                        continue
                    holes.append({
                        'center':      [round(cx, 3), round(cy, 3)],
                        'radius_norm': round(radius, 4),
                        'area_norm':   round(area / max(mask_crop.size, 1), 4),
                    })
                    num_holes += 1

            features['holes'] = holes
            features['num_holes'] = int(num_holes)

        # 2) Pad to a square BEFORE resizing to 32x32 so the camera crop
        # keeps its aspect ratio (the CAD side also pads to square). A
        # rectangular crop zoomed straight to 32x32 stretches the part
        # and tanks the height-map NCC.
        h_crop, w_crop = mask_crop.shape[:2]
        max_dim = max(h_crop, w_crop)
        pad_y = (max_dim - h_crop) // 2
        pad_x = (max_dim - w_crop) // 2

        norm_depth_sq = np.zeros((max_dim, max_dim), dtype=np.float32)
        norm_depth_sq[pad_y:pad_y + h_crop, pad_x:pad_x + w_crop] = norm_depth
        mask_sq = np.zeros((max_dim, max_dim), dtype=bool)
        mask_sq[pad_y:pad_y + h_crop, pad_x:pad_x + w_crop] = mask_crop

        fy = 32.0 / max_dim
        fx = 32.0 / max_dim
        try:
            height_32 = _zoom(norm_depth_sq, (fy, fx), order=1)
            features['height_map_32'] = height_32
        except Exception:
            pass

        # 3) Edge map (depth discontinuities) — same as CAD side.
        try:
            edge_x = _sobel(norm_depth_sq, axis=1)
            edge_y = _sobel(norm_depth_sq, axis=0)
            edge_mag = np.sqrt(edge_x ** 2 + edge_y ** 2)
            edge_32 = _zoom(edge_mag, (fy, fx), order=1)
            features['edge_map_32'] = edge_32
        except Exception:
            pass

        # 4) Outline at 32x32 for downstream debug / future use.
        try:
            outline_32 = _zoom(mask_sq.astype(float), (fy, fx), order=0) > 0.5
            features['outline_32'] = outline_32
        except Exception:
            pass

        heights = depth_crop[valid]
        features['height_std']   = round(float(np.std(heights)), 4)
        features['height_range'] = round(float(height_range), 4)

        rows = np.any(mask_crop, axis=1)
        cols = np.any(mask_crop, axis=0)
        if rows.any() and cols.any():
            rh = int(np.where(rows)[0][-1] - np.where(rows)[0][0] + 1)
            rw = int(np.where(cols)[0][-1] - np.where(cols)[0][0] + 1)
            features['aspect_ratio'] = round(rw / max(rh, 1), 3)
            lr = np.fliplr(mask_crop)
            lr_sym = float(np.sum(mask_crop == lr)) / max(int(np.sum(mask_crop | lr)), 1)
            features['symmetry_lr'] = round(lr_sym, 3)

        return features

    def _match_parts(self, objects):
        """CAD-geometry recognition against the parts library, with
        teach-mode references as a parallel matcher; whichever scores
        higher wins. Geometry comparison is on hole count + pattern,
        top-down height profile, edge profile, size and aspect — the
        same features extract_geometric_features() computed when the
        STEP file was uploaded."""
        if not objects:
            return
        library_parts = self._load_library_parts()
        for o in objects:
            mask  = o.get('mask_2d')
            depth = o.get('depth_2d')
            bbox  = o.get('bbox_px') or (0, 0, 0, 0)
            bw    = max(1, bbox[2] - bbox[0])
            bh    = max(1, bbox[3] - bbox[1])
            aspect = float(bw) / float(bh)
            sx, sy, sz = o.get('size_3d') or (0.05, 0.05, 0.05)
            size_m = [float(sx), float(sy), float(sz)]

            # 1) Geometry match against CAD library.
            det_features = self._extract_detection_features(depth, mask)
            geo_name, geo_id, geo_score, geo_reason = None, None, 0.0, ''
            if _MATCHER_OK and det_features:
                try:
                    match, score, reason = _match_geometry(det_features, size_m)
                    if match is not None:
                        geo_name   = match.get('name')
                        geo_id     = match.get('id')
                        geo_score  = float(score)
                        geo_reason = str(reason)
                except Exception as e:
                    self.get_logger().warn(f'match_geometry failed: {e}', once=True)

            # 2) Teach-mode match — kept as a parallel matcher because
            # an operator capture often beats CAD on noisy small parts.
            # Pass the RGB crop so the matcher's gray NCC fires.
            teach_name, teach_id, teach_score = self._match_by_teach(
                depth, mask, size_m, color_crop=o.get('color_crop'))

            # Higher score wins. CAD is preferred on ties to bias toward
            # the structurally-defined match when both fire equally.
            if geo_score >= teach_score and geo_name:
                best_name, best_id, best_score = geo_name, geo_id, geo_score
                match_source = 'cad'
            elif teach_score > 0 and teach_name != 'unknown':
                best_name, best_id, best_score = teach_name, teach_id, teach_score
                match_source = 'teach'
            else:
                best_name, best_id, best_score = None, None, 0.0
                match_source = ''

            # Diagnostic logging — anything that even comes close is
            # worth logging so we can see WHY false positives happen.
            if best_score > 0.3:
                gf_holes = 0
                if best_id:
                    pm = next((p for p in library_parts
                               if p.get('id') == best_id), None)
                    if pm:
                        gf_holes = int(
                            (pm.get('geometric_features') or {})
                            .get('num_holes', 0) or 0
                        )
                self.get_logger().info(
                    f'MATCH: {best_name} score={best_score:.2f} '
                    f'src={match_source} '
                    f'holes:{det_features.get("num_holes", 0)}vs{gf_holes} '
                    f'size:{[round(s * 100, 1) for s in size_m]}cm '
                    f'reason:{geo_reason}',
                    throttle_duration_sec=2.0,
                )

            # Stash hole list + reason for annotation drawing.
            o['_holes']        = det_features.get('holes', []) if det_features else []
            o['_match_reason'] = geo_reason
            o['_match_source'] = match_source

            if best_name is None or best_score < 0.50:
                o['part_name']        = None
                o['part_id']          = None
                o['match_score']      = 0.0
                o['match_yaw']        = 0.0
                o['position_correct'] = None
                o['yaw_error_deg']    = 0.0
                o['surface_ok']       = None
                o['position_status']  = ''
                continue

            o['part_name']   = str(best_name)
            o['part_id']     = str(best_id) if best_id else None
            o['match_score'] = float(round(best_score, 3))
            o['match_yaw']   = 0.0

            # Position verification against the operator-saved config.
            part_meta = next((p for p in library_parts if p.get('id') == best_id), None)
            if part_meta is not None:
                _roll, _pitch, yaw_rad = o.get('euler') or (0.0, 0.0, 0.0)
                ok, yaw_err, surf_ok = self._verify_position(part_meta, yaw_rad, size_m)
                o['position_correct'] = bool(ok)
                o['yaw_error_deg']    = float(yaw_err)
                o['surface_ok']       = bool(surf_ok)
                o['position_status']  = 'CORRECT' if ok else 'MISALIGNED'
            else:
                o['position_correct'] = None
                o['yaw_error_deg']    = 0.0
                o['surface_ok']       = None
                o['position_status']  = ''

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
        # Detection-mode gate: "library" drops everything that didn't
        # match a CAD entry; "all" keeps every stable detection.
        if getattr(self, '_detection_mode', 'all') == 'library':
            objects = [o for o in objects
                       if o.get('part_name')
                       and float(o.get('match_score') or 0.0) >= 0.70]
        for o in objects:
            det = Detection3D()
            det.header = arr.header
            hyp = ObjectHypothesisWithPose()
            if o.get('part_name'):
                # Encode "part:NAME:C|M|U:yaw_err" — single string the
                # dashboard parses back into part_name/position_correct/
                # yaw_error_deg, since Detection3D has no spare fields.
                pos = o.get('position_correct')
                status = 'C' if pos is True else ('M' if pos is False else 'U')
                yaw_err = float(o.get('yaw_error_deg') or 0.0)
                hyp.hypothesis.class_id = f"part:{o['part_name']}:{status}:{yaw_err:.1f}"
                hyp.hypothesis.score    = float(o.get('match_score') or 0.0)
            else:
                hyp.hypothesis.class_id = 'object'
                hyp.hypothesis.score    = 1.0
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
            matched   = bool(o.get('part_name'))
            pos_ok    = o.get('position_correct')
            # Three-way colour code: blue = matched + correctly placed,
            # orange = matched but yaw/surface off, green = unknown.
            if matched and pos_ok:
                col = (59, 130, 246)    # blue
            elif matched:
                col = (249, 115, 22)    # orange
            else:
                col = self._dist_color(pz)

            # 2D bbox
            draw.rectangle([x0, y0, x1, y1], outline=col, width=3)

            # Cyan OBB wireframe (projected from the 8 3D corners).
            if o.get('obb') and o.get('corners') is not None:
                proj = self._project(o['corners'], w, h)
                if proj is not None:
                    self._draw_obb_wireframe(draw, proj, (0, 220, 255))

            # Cyan orientation arrow at the bbox centre, pointing along
            # the OBB's yaw. Image-frame angle = the OBB's yaw component
            # (rotation about cam-Z = optical axis = image normal).
            yaw_deg = yaw * 180.0 / math.pi
            cx_box = (x0 + x1) * 0.5
            cy_box = (y0 + y1) * 0.5
            arrow_len = max(x1 - x0, y1 - y0) * 0.4
            ex = cx_box + arrow_len * math.cos(yaw)
            ey = cy_box + arrow_len * math.sin(yaw)
            cyan = (0, 220, 255)
            draw.line([(cx_box, cy_box), (ex, ey)], fill=cyan, width=2)
            head = max(6.0, arrow_len * 0.20)
            for a in (yaw + 2.6, yaw - 2.6):
                draw.line([(ex, ey),
                           (ex - head * math.cos(a), ey - head * math.sin(a))],
                          fill=cyan, width=2)

            # Yaw is the only meaningful rotation (yaw-only OBB); size
            # collapsed to the two XY dims for a top-down read.
            w_cm = int(round(sx * 100))
            h_cm = int(round(sy * 100))
            holes = o.get('_holes') or []
            n_holes = len(holes)
            if matched:
                pct = int(round(float(o.get('match_score') or 0) * 100))
                hole_tag = f' [{n_holes} holes]' if n_holes else ''
                if pos_ok:
                    label = f"{o['part_name']} ({pct}%){hole_tag} ✓  {pz:.2f}m"
                else:
                    yaw_err = float(o.get('yaw_error_deg') or 0.0)
                    label = (f"{o['part_name']} ({pct}%){hole_tag} "
                             f"⚠ yaw:{yaw_err:.0f}° off")
            else:
                label = f'{pz:.2f}m  {w_cm}×{h_cm}cm  yaw:{yaw_deg:+.0f}°'
            # Matched parts get the bigger bold font; unknown objects use
            # a slightly smaller regular font. Both labels sit in a
            # solid-filled rectangle so they read against any background.
            label_font = _ANNOT_FONT if matched else _ANNOT_FONT_SMALL
            bbox_text = draw.textbbox((0, 0), label, font=label_font)
            tw = bbox_text[2] - bbox_text[0] + 8
            th = bbox_text[3] - bbox_text[1] + 6
            label_y = max(0, y0 - th - 2)
            draw.rectangle([x0, label_y, x0 + tw, label_y + th], fill=col)
            draw.text((x0 + 4, label_y + 2), label,
                      fill=(255, 255, 255), font=label_font)

            # Hole markers — small cyan circles at each detected hole.
            # Hole coordinates are normalised to the detection mask
            # crop, so project them onto the 2D bbox.
            if matched and holes:
                bw_px = max(1, x1 - x0)
                bh_px = max(1, y1 - y0)
                for hole in holes:
                    c = hole.get('center') or [0.5, 0.5]
                    r = float(hole.get('radius_norm') or 0.02)
                    hx = x0 + float(c[0]) * bw_px
                    hy = y0 + float(c[1]) * bh_px
                    rr = max(3.0, r * max(bw_px, bh_px))
                    draw.ellipse([hx - rr, hy - rr, hx + rr, hy + rr],
                                 outline=(0, 220, 255), width=2)

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
