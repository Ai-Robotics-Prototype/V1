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
        self.declare_parameter('dilate_kernel',      7)
        self.declare_parameter('edge_threshold_m',   0.05)
        self.declare_parameter('rgb_edge_threshold', 30.0)
        self.declare_parameter('merge_edge_dist_px', 20)
        self.declare_parameter('merge_iou_thr',      0.1)
        self.declare_parameter('split_threshold_m',  0.01)
        self.declare_parameter('max_bbox_area_px',   40000)
        self.declare_parameter('publish_rate_hz',    15.0)
        self.declare_parameter('bbox_pad_px',        2)
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
        self._depth_buffer = collections.deque(maxlen=3)  # temporal noise-reduce raw depth

        # Per-detection EMA tracker — matches new detections to a track from
        # the previous frame by IoU and smooths bbox / pos / size / yaw so
        # the annotation stops bouncing across small depth-noise changes.
        self._tracks = {}          # track_id -> {bbox, pos, size_3d, yaw, missing_count}
        self._next_track_id = 0
        self._ema_alpha = 0.3      # 70% old + 30% new
        self._track_iou_thr = 0.3
        self._track_max_missing = 5

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
        self._templates    = {}     # part_id -> {name, templates:[...]}
        # While the teach wizard is open the operator is showing the part
        # from different angles; the matcher would happily false-positive
        # off those frames, so we short-circuit recognition entirely until
        # the wizard tells us it's done.
        self._teach_mode   = False
        self._load_teach_refs()
        self._load_templates()
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
        # Average the last few raw depth frames so per-pixel speckle
        # doesn't flicker pixels in and out of the foreground mask.
        # Invalid samples (<= 0 or NaN) are excluded per-pixel.
        self._depth_buffer.append(d)
        if len(self._depth_buffer) >= 2:
            stack = np.stack(list(self._depth_buffer), axis=0)
            ok = np.isfinite(stack) & (stack > 0.0)
            cnt = ok.sum(axis=0)
            num = np.where(ok, stack, 0.0).sum(axis=0)
            avg = np.where(cnt > 0, num / np.maximum(cnt, 1), 0.0).astype(np.float32)
            self._depth_m = avg
        else:
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

    def _update_tracks(self, detections):
        """Match detections to existing tracks by IoU and exponential-
        moving-average smooth bbox / pos / size / yaw across frames.

        Each frame's segmentation is independent and small depth noise
        shifts the bbox by several pixels; without this stage the
        annotation jitters even when the scene is static. Tracks are
        kept for `_track_max_missing` empty frames before being culled
        so a single bad frame doesn't drop the track.
        """
        used_tracks = set()
        a = self._ema_alpha

        for det in detections:
            bbox = det.get('bbox_px')
            if not bbox or len(bbox) < 4:
                continue
            x1, y1, x2, y2 = [float(b) for b in bbox]

            # Best IoU match against unclaimed tracks.
            best_tid = None
            best_iou = self._track_iou_thr
            for tid, track in self._tracks.items():
                if tid in used_tracks:
                    continue
                tb = track['bbox']
                ix1 = max(x1, tb[0]); iy1 = max(y1, tb[1])
                ix2 = min(x2, tb[2]); iy2 = min(y2, tb[3])
                inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
                if inter <= 0:
                    continue
                area_a = (x2 - x1) * (y2 - y1)
                area_b = (tb[2] - tb[0]) * (tb[3] - tb[1])
                union = area_a + area_b - inter
                iou = inter / max(union, 1e-6)
                if iou > best_iou:
                    best_iou = iou
                    best_tid = tid

            if best_tid is None:
                # Initialise a fresh track from the current detection.
                tid = self._next_track_id
                self._next_track_id += 1
                eu = det.get('euler') or (0.0, 0.0, 0.0)
                self._tracks[tid] = {
                    'bbox':    (x1, y1, x2, y2),
                    'pos':     det.get('pos') or (0.0, 0.0, 0.0),
                    'size_3d': det.get('size_3d') or (0.05, 0.05, 0.05),
                    'yaw':     float(eu[2]),
                    'missing_count': 0,
                }
                det['_track_id'] = tid
                used_tracks.add(tid)
                continue

            # Smooth into the existing track.
            track = self._tracks[best_tid]
            ob = track['bbox']
            sm_bbox = (
                ob[0] * (1 - a) + x1 * a,
                ob[1] * (1 - a) + y1 * a,
                ob[2] * (1 - a) + x2 * a,
                ob[3] * (1 - a) + y2 * a,
            )
            track['bbox'] = sm_bbox
            track['missing_count'] = 0

            if det.get('pos'):
                op = track.get('pos') or det['pos']
                np_pos = det['pos']
                track['pos'] = tuple(
                    o * (1 - a) + n * a for o, n in zip(op, np_pos))

            if det.get('size_3d'):
                os3 = track.get('size_3d') or det['size_3d']
                ns3 = det['size_3d']
                track['size_3d'] = tuple(
                    o * (1 - a) + n * a for o, n in zip(os3, ns3))

            eu = det.get('euler') or (0.0, 0.0, 0.0)
            old_yaw = track.get('yaw', float(eu[2]))
            diff = float(eu[2]) - old_yaw
            # Wrap to (-pi, pi] so smoothing doesn't tear at the seam.
            while diff > math.pi:  diff -= 2.0 * math.pi
            while diff < -math.pi: diff += 2.0 * math.pi
            track['yaw'] = old_yaw + diff * a

            # Push smoothed values back onto the detection so everything
            # downstream — matching, publishing, drawing — sees them.
            det['bbox_px'] = tuple(int(round(v)) for v in sm_bbox)
            det['pos']     = track['pos']
            det['size_3d'] = track['size_3d']
            det['euler']   = (eu[0], eu[1], track['yaw'])
            det['_track_id'] = best_tid

            # Rebuild corners + quat from the smoothed yaw so the
            # rotated 2D bbox we draw and the 3D pose we publish are
            # consistent with the smoothed state.
            cy_, sy_ = math.cos(track['yaw']), math.sin(track['yaw'])
            R_s = np.array([
                [cy_, -sy_, 0.0],
                [sy_,  cy_, 0.0],
                [0.0,  0.0, 1.0],
            ], dtype=np.float32)
            centroid_s = np.asarray(track['pos'], dtype=np.float32)
            size_s     = np.asarray(track['size_3d'], dtype=np.float32)
            det['corners'] = self._obb_corners(centroid_s, size_s, R_s)
            quat_s, _ = self._rmat_to_quat_euler(R_s)
            det['quat'] = tuple(float(q) for q in quat_s)

            used_tracks.add(best_tid)

        # Age out tracks that didn't get a match this frame.
        to_remove = []
        for tid, track in self._tracks.items():
            if tid in used_tracks:
                continue
            track['missing_count'] = track.get('missing_count', 0) + 1
            if track['missing_count'] > self._track_max_missing:
                to_remove.append(tid)
        for tid in to_remove:
            del self._tracks[tid]

        return detections

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
        # Stabilise mask edges: a small 5x5 closing fills 1-2 px gaps that
        # appear and disappear across frames and otherwise wobble the bbox.
        foreground = ndimage.binary_closing(
            foreground, structure=np.ones((5, 5), dtype=bool), iterations=1)

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
            # Recover the largest connected component within the (possibly
            # merged) bbox, then clean it with a 3x3 opening + closing so
            # speckle pixels don't inflate the box. The bbox finally
            # reported is the *cleaned* mask's extent, not the raw
            # component-stats slice.
            sub_fg_initial = foreground[y0:y1, x0:x1]
            if not sub_fg_initial.any():
                continue
            sub_labeled, sub_count = ndimage.label(sub_fg_initial)
            if sub_count == 0:
                continue
            if sub_count > 1:
                sizes = ndimage.sum(
                    sub_fg_initial, sub_labeled, range(1, sub_count + 1))
                largest = int(np.argmax(sizes)) + 1
                component_mask = sub_labeled == largest
            else:
                component_mask = sub_fg_initial.astype(bool)

            clean_mask = ndimage.binary_opening(
                component_mask, structure=np.ones((3, 3), dtype=bool),
                iterations=1)
            clean_mask = ndimage.binary_closing(
                clean_mask, structure=np.ones((3, 3), dtype=bool),
                iterations=1)

            sub_labeled2, sub_count2 = ndimage.label(clean_mask)
            if sub_count2 == 0:
                continue
            if sub_count2 > 1:
                sizes2 = ndimage.sum(
                    clean_mask, sub_labeled2, range(1, sub_count2 + 1))
                largest2 = int(np.argmax(sizes2)) + 1
                clean_mask = sub_labeled2 == largest2

            obj_pixels_y, obj_pixels_x = np.where(clean_mask)
            if obj_pixels_y.size == 0:
                continue
            tight_pad = 3
            xmin_img = x0 + int(obj_pixels_x.min())
            ymin_img = y0 + int(obj_pixels_y.min())
            xmax_img = x0 + int(obj_pixels_x.max()) + 1
            ymax_img = y0 + int(obj_pixels_y.max()) + 1
            x0 = max(0, xmin_img - tight_pad)
            y0 = max(0, ymin_img - tight_pad)
            x1 = min(w, xmax_img + tight_pad)
            y1 = min(h, ymax_img + tight_pad)
            sub_d = depth[y0:y1, x0:x1]
            # Recompute the single-component clean mask in the *tight*
            # bbox so the deprojection only sees this object's pixels —
            # not morphological inflation, not neighbouring blobs that
            # leak in via foreground's dilate/fill_holes steps.
            sub_fg_raw = foreground[y0:y1, x0:x1]
            sub_labeled_t, sub_count_t = ndimage.label(sub_fg_raw)
            if sub_count_t == 0:
                continue
            if sub_count_t > 1:
                sizes_t = ndimage.sum(
                    sub_fg_raw, sub_labeled_t, range(1, sub_count_t + 1))
                sub_fg = sub_labeled_t == (int(np.argmax(sizes_t)) + 1)
            else:
                sub_fg = sub_fg_raw.astype(bool)
            sub_fg = ndimage.binary_opening(
                sub_fg, structure=np.ones((3, 3), dtype=bool), iterations=1)
            sub_fg = ndimage.binary_closing(
                sub_fg, structure=np.ones((3, 3), dtype=bool), iterations=1)
            if not sub_fg.any():
                sub_fg = sub_fg_raw.astype(bool)
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

        # Drop detections smaller than 1.5 cm on their longest XY axis.
        # Below that they're table scratches / noise, not pickable parts.
        def _big_enough(o):
            sx, sy, _ = o.get('size_3d') or (0.0, 0.0, 0.0)
            return max(float(sx), float(sy)) >= 0.015
        objects = [o for o in objects if _big_enough(o)]

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
        """Read every /opt/cobot/parts/teach/<id>/*.npz back into memory.

        The new teach format stores full-resolution color, depth, mask,
        a binary edge map, a 200-point contour, hole count + positions,
        the OBB size, and the operator-supplied orientation tag. The
        matcher uses the edge + contour + size triple as hard gates."""
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
                    z = np.load(os.path.join(pdir, fn), allow_pickle=True)
                    files = set(z.files)
                    color_arr = (np.asarray(z['color'], dtype=np.uint8)
                                 if 'color' in files else None)
                    if 'gray' in files:
                        gray_arr = np.asarray(z['gray'], dtype=np.float32)
                    elif color_arr is not None:
                        gray_arr = (np.mean(color_arr.astype(np.float32), axis=2)
                                    if color_arr.ndim == 3
                                    else color_arr.astype(np.float32))
                    else:
                        gray_arr = None
                    # Legacy refs (pre-conversational-wizard) only stored
                    # the orientation string. Derive is_pickable from it
                    # so the new colouring scheme still works on them.
                    orientation_str = (str(z['orientation'])
                                       if 'orientation' in files
                                       else 'pickable')
                    ref = {
                        'size_m':   np.asarray(z['size_m'], dtype=np.float32)
                                    if 'size_m' in files
                                    else np.array([0.05, 0.05, 0.05], dtype=np.float32),
                        'mask':     np.asarray(z['mask'], dtype=bool)
                                    if 'mask' in files else None,
                        'depth':    np.asarray(z['depth'], dtype=np.float32)
                                    if 'depth' in files else None,
                        'edges':    np.asarray(z['edges'], dtype=np.uint8)
                                    if 'edges' in files else None,
                        'contour':  np.asarray(z['contour'], dtype=np.float32)
                                    if 'contour' in files else None,
                        'color':    color_arr,
                        'gray':     gray_arr,
                        'num_holes': int(z['num_holes'])
                                     if 'num_holes' in files else 0,
                        'orientation':        orientation_str,
                        'orientation_number': int(z['orientation_number'])
                                              if 'orientation_number' in files else 0,
                        'orientation_label':  str(z['orientation_label'])
                                              if 'orientation_label' in files else '',
                        'is_pickable':        bool(z['is_pickable'])
                                              if 'is_pickable' in files
                                              else (orientation_str == 'pickable'),
                        'is_defect':          bool(z['is_defect'])
                                              if 'is_defect' in files else False,
                        'defect_name':        str(z['defect_name'])
                                              if 'defect_name' in files else '',
                        'distance_m': float(z['distance_m'])
                                      if 'distance_m' in files else 0.5,
                        'px_per_cm':  float(z['px_per_cm'])
                                      if 'px_per_cm' in files else 10.0,
                    }
                    refs.append(ref)
                except Exception:
                    continue
            if refs:
                self._teach_refs[pid] = refs
        if self._teach_refs:
            self.get_logger().info(
                'teach refs: '
                + ', '.join(
                    f'{k}({len(v)} refs, edges='
                    f'{"y" if any(r.get("edges") is not None for r in v) else "n"})'
                    for k, v in self._teach_refs.items())
            )

    def _on_teach_command(self, msg):
        """Capture the selected detection as a teach reference.

        Stores FULL-resolution crops (no 64x64 downsample) plus a Sobel
        edge map, a 200-point normalized contour, and depth-based hole
        count + positions. The matcher relies on edge + contour for
        discrimination — the old grayscale-NCC-on-tiny-blobs approach
        matched anything that was vaguely the right colour."""
        try:
            cmd = json.loads(msg.data) if msg.data else {}
        except Exception:
            return
        action = cmd.get('action')
        if action == 'reload':
            self._load_teach_refs()
            return
        if action == 'start_teach':
            self._teach_mode = True
            self.get_logger().info('TEACH MODE ON — recognition suppressed')
            return
        if action == 'stop_teach':
            self._teach_mode = False
            self.get_logger().info('TEACH MODE OFF — recognition resumed')
            return
        if action != 'teach':
            return

        try:
            part_id = cmd.get('part_id')
            if not part_id:
                self.get_logger().warn('teach: missing part_id')
                return
            # The launch file starts one depth_segment_node per camera
            # (cam0 = primary, cam1 = secondary). Both subscribe to
            # /perception/teach_command — if both write a .npz, every
            # operator capture lands as TWO refs on disk and the
            # library's teach_count reads as 2× the wizard's session
            # count. Gate writes to the primary instance only.
            if self.get_name() != 'depth_segment_node':
                return
            if not self._last_objects:
                self.get_logger().warn('teach: no recent detections')
                return
            det_idx = int(cmd.get('detection_index') or 0)
            if det_idx < 0 or det_idx >= len(self._last_objects):
                det_idx = 0
            orientation        = str(cmd.get('orientation') or 'pickable')
            # Rich orientation metadata from the conversational wizard.
            # Defaults preserve the legacy {pickable=True} semantics.
            orientation_number = int(cmd.get('orientation_number') or 0)
            orientation_label  = str(cmd.get('orientation_label') or '').strip()
            is_pickable        = bool(cmd.get('is_pickable',
                                              orientation == 'pickable'))
            is_defect          = bool(cmd.get('is_defect', False))
            defect_name        = str(cmd.get('defect_name') or '').strip()

            det = self._last_objects[det_idx]
            mask_crop  = det.get('mask_2d')
            depth_crop = det.get('depth_2d')
            color_crop = det.get('color_crop')
            size_3d    = det.get('size_3d') or (0.05, 0.05, 0.05)

            if mask_crop is None or not np.any(mask_crop):
                self.get_logger().warn('teach: detection has no mask')
                return

            crop_h, crop_w = mask_crop.shape[:2]
            if crop_h < 30 or crop_w < 30:
                self.get_logger().warn('teach: crop too small')
                return

            size_m  = np.asarray(size_3d, dtype=np.float32)
            yaw_deg = 0.0
            euler = det.get('euler')
            if euler:
                yaw_deg = float(euler[2]) * 180.0 / np.pi

            from scipy.ndimage import (
                sobel as _sobel, gaussian_filter, binary_erosion,
                label as _label, binary_fill_holes, zoom as _zoom,
            )

            # Physical scale of the reference: pixels-per-cm at the
            # distance the part was taught from. Combined with the crop's
            # native pixel dims this lets the matcher rescale a new
            # detection to the SAME physical resolution before comparing
            # — the crucial step that distinguishes a 3.8 cm block from
            # a 6.3 cm block even when both crops look identical after
            # a naive 64x64 normalisation.
            depth_valid_for_scale = (
                (mask_crop & (depth_crop > 0))
                if depth_crop is not None else None)
            if (depth_valid_for_scale is not None
                    and depth_valid_for_scale.any()):
                depth_median = float(np.median(depth_crop[depth_valid_for_scale]))
            else:
                depth_median = 0.5
            fx_val = self._K[0] if self._K else 600.0
            px_per_m = fx_val / max(depth_median, 1e-3)
            px_per_cm = px_per_m / 100.0

            # Cap reference crop size at 128 on the long side so refs
            # don't bloat the npz when a part fills the frame.
            max_ref_size = 128
            if max(crop_h, crop_w) > max_ref_size:
                scale_factor = max_ref_size / float(max(crop_h, crop_w))
            else:
                scale_factor = 1.0
            if scale_factor < 1.0:
                ref_mask = _zoom(
                    mask_crop.astype(np.float32), scale_factor, order=0) > 0.5
                ref_depth = (_zoom(depth_crop.astype(np.float32),
                                   scale_factor, order=1)
                             if depth_crop is not None else None)
                if color_crop is not None:
                    ref_color = _zoom(
                        color_crop.astype(np.float32),
                        (scale_factor, scale_factor, 1),
                        order=1).astype(np.uint8)
                else:
                    ref_color = None
            else:
                ref_mask = mask_crop.copy()
                ref_depth = (depth_crop.copy()
                             if depth_crop is not None else None)
                ref_color = (color_crop.copy()
                             if color_crop is not None else None)
            ref_h, ref_w = ref_mask.shape[:2]

            # ── Edge map (Sobel on smoothed grayscale, thresholded) ──
            edge_binary = None
            if ref_color is not None and ref_color.size > 0:
                gray = (np.mean(ref_color.astype(np.float32), axis=2)
                        if ref_color.ndim == 3
                        else ref_color.astype(np.float32))
                gray_smooth = gaussian_filter(gray, sigma=1.0)
                ex = _sobel(gray_smooth, axis=1)
                ey = _sobel(gray_smooth, axis=0)
                edges = np.sqrt(ex * ex + ey * ey)
                e_max = float(edges.max())
                if e_max > 0:
                    edges = edges / e_max
                edge_binary = (edges > 0.15).astype(np.uint8)

            # ── Contour: mask outline as a normalised 200-point cloud ──
            contour_points = None
            if ref_mask.any():
                eroded = binary_erosion(ref_mask, iterations=1)
                contour_mask = ref_mask & ~eroded
                cy, cx = np.where(contour_mask)
                if len(cy) > 10:
                    contour_points = np.column_stack([
                        cx.astype(np.float32) / max(ref_w, 1),
                        cy.astype(np.float32) / max(ref_h, 1),
                    ]).astype(np.float32)
                    if len(contour_points) > 200:
                        idx = np.linspace(0, len(contour_points) - 1, 200, dtype=int)
                        contour_points = contour_points[idx]

            # ── Hole features from depth (deep regions inside mask) ──
            num_holes = 0
            hole_positions = []
            if ref_depth is not None:
                valid_h = ref_mask & (ref_depth > 0) & np.isfinite(ref_depth)
                if valid_h.any():
                    obj_median = float(np.median(ref_depth[valid_h]))
                    deep = ref_mask & (ref_depth > obj_median + 0.01) & (ref_depth > 0)
                    filled = binary_fill_holes(ref_mask)
                    hole_candidates = filled & (~ref_mask | deep)
                    labeled, n = _label(hole_candidates)
                    for h in range(1, n + 1):
                        hy, hx = np.where(labeled == h)
                        area = len(hy)
                        if area > 30:
                            num_holes += 1
                            hole_positions.append([
                                float(np.mean(hx)) / max(ref_w, 1),
                                float(np.mean(hy)) / max(ref_h, 1),
                                float(np.sqrt(area / np.pi)) / max(ref_w, ref_h),
                            ])

            teach_dir = self._teach_dir(part_id)
            os.makedirs(teach_dir, exist_ok=True)
            existing = sum(1 for f in os.listdir(teach_dir) if f.endswith('.npz'))
            ref_id = existing

            save_data = {
                'size_m':             size_m,
                'yaw_deg':            np.float32(yaw_deg),
                'orientation':        orientation,
                'orientation_number': np.int32(orientation_number),
                'orientation_label':  orientation_label,
                'is_pickable':        np.bool_(is_pickable),
                'is_defect':          np.bool_(is_defect),
                'defect_name':        defect_name,
                'crop_shape':         np.array([ref_h, ref_w], dtype=np.int32),
                'num_holes':          np.int32(num_holes),
                'distance_m':         np.float32(depth_median),
                'px_per_cm':          np.float32(px_per_cm),
                'scale_factor':       np.float32(scale_factor),
            }
            if ref_color is not None:
                save_data['color'] = ref_color.astype(np.uint8)
                # Grayscale at full reference resolution — used for
                # physical-scale NCC by the simple _match_part path.
                gray_ref = (np.mean(ref_color.astype(np.float32), axis=2)
                            if ref_color.ndim == 3
                            else ref_color.astype(np.float32))
                save_data['gray'] = gray_ref.astype(np.float32)
            if ref_depth is not None:
                save_data['depth'] = ref_depth.astype(np.float32)
            save_data['mask'] = ref_mask.astype(bool)
            if edge_binary is not None:
                save_data['edges'] = edge_binary.astype(np.uint8)
            if contour_points is not None:
                save_data['contour'] = contour_points
            if hole_positions:
                save_data['hole_positions'] = np.array(hole_positions, dtype=np.float32)

            out_path = os.path.join(teach_dir, f'ref_{ref_id:03d}.npz')
            np.savez_compressed(out_path, **save_data)

            # Save a PNG preview alongside for sanity-checking from disk.
            if ref_color is not None:
                try:
                    PILImage.fromarray(ref_color).save(
                        os.path.join(teach_dir, f'ref_{ref_id:03d}.png'))
                except Exception:
                    pass

            self.get_logger().info(
                f'TAUGHT {part_id} ref#{ref_id}: {ref_w}x{ref_h}px '
                f'@ {depth_median:.2f}m ({px_per_cm:.1f}px/cm), '
                f'size={[round(float(s) * 100, 1) for s in size_m]}cm, '
                f'holes={num_holes}, orientation={orientation}')

            self._load_teach_refs()
        except Exception as e:
            self.get_logger().error(f'teach failed: {e}')
            import traceback
            traceback.print_exc()

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

    # ── CAD recognition templates (6 orientations × 12 yaws) ───────────

    def _load_templates(self):
        """Load /opt/cobot/parts/templates/<part_id>_templates.npz files.

        Each file holds N templates (default 72 = 6 orientations × 12
        yaws). Mapping is keyed by part_id (hash) and includes the part
        name resolved from the metadata json.
        """
        self._templates = {}
        tdir = '/opt/cobot/parts/templates'
        mdir = '/opt/cobot/parts/metadata'
        if not os.path.isdir(tdir):
            return
        for fn in sorted(os.listdir(tdir)):
            if not fn.endswith('_templates.npz'):
                continue
            part_id = fn[:-len('_templates.npz')]
            try:
                z = np.load(os.path.join(tdir, fn), allow_pickle=True)
                n = int(z['num_templates'])
                tpls = []
                for i in range(n):
                    tpls.append({
                        'orient_name':  str(z[f't{i}_orient']),
                        'orient_label': str(z[f't{i}_label']),
                        'yaw_deg':      float(z[f't{i}_yaw']),
                        'mask':         np.asarray(z[f't{i}_mask'], dtype=bool),
                        'edges':        np.asarray(z[f't{i}_edges'], dtype=np.uint8),
                        'width_m':      float(z[f't{i}_width_m']),
                        'height_m':     float(z[f't{i}_height_m']),
                        'aspect':       float(z[f't{i}_aspect']),
                    })
            except Exception as e:
                self.get_logger().warn(
                    f'template load failed for {part_id}: {e}', once=True)
                continue
            # Look up the part name from metadata json (falls back to id).
            name = part_id
            meta_path = os.path.join(mdir, f'{part_id}.json')
            if os.path.isfile(meta_path):
                try:
                    with open(meta_path) as fp:
                        name = json.load(fp).get('name') or part_id
                except Exception:
                    pass
            self._templates[part_id] = {'name': name, 'templates': tpls}
        if self._templates:
            self.get_logger().info(
                'templates: '
                + ', '.join(f'{v["name"]}({len(v["templates"])})'
                            for v in self._templates.values()))

    def _match_by_templates(self, mask_crop, obb_size, color_crop=None):
        """Match a detection against all CAD-derived templates.

        Returns (part_name, part_id, score, yaw_deg, orient_label).
        orient_label is 'pickable', 'flipped', 'on_side', or None.
        """
        if not self._templates:
            return None, None, 0.0, 0.0, None
        if mask_crop is None or mask_crop.shape[0] < 20 or mask_crop.shape[1] < 20:
            return None, None, 0.0, 0.0, None
        if not np.any(mask_crop):
            return None, None, 0.0, 0.0, None
        det_max_dim = (max(float(obb_size[0]), float(obb_size[1]))
                       if obb_size is not None and len(obb_size) >= 2 else 0.0)
        if det_max_dim < 0.015:
            return None, None, 0.0, 0.0, None

        from scipy.ndimage import (
            sobel as _sobel, gaussian_filter, zoom as _zoom)

        det_edges = None
        if color_crop is not None and color_crop.size > 0:
            gray = (np.mean(color_crop.astype(np.float32), axis=2)
                    if color_crop.ndim == 3
                    else color_crop.astype(np.float32))
            gs = gaussian_filter(gray, sigma=1.0)
            emag = np.sqrt(_sobel(gs, axis=0) ** 2 + _sobel(gs, axis=1) ** 2)
            emax = float(emag.max())
            det_edges = ((emag / emax > 0.15).astype(np.float32)
                         if emax > 0 else np.zeros_like(gray, dtype=np.float32))

        det_h, det_w = mask_crop.shape[:2]
        det_s_sorted = sorted(
            [float(obb_size[0]), float(obb_size[1])], reverse=True)
        det_asp = det_s_sorted[0] / max(det_s_sorted[1], 0.001)

        best_score  = 0.0
        best_part_id = None
        best_name   = None
        best_yaw    = 0.0
        best_orient = None
        best_bd     = (0.0, 0.0, 0.0)

        for part_id, entry in self._templates.items():
            name = entry['name']
            for t in entry['templates']:
                ref_s = sorted(
                    [float(t['width_m']), float(t['height_m'])], reverse=True)
                if ref_s[0] < 1e-4:
                    continue
                r0 = (min(det_s_sorted[0], ref_s[0])
                      / max(det_s_sorted[0], ref_s[0], 0.001))
                r1 = (min(det_s_sorted[1], ref_s[1])
                      / max(det_s_sorted[1], ref_s[1], 0.001))
                if r0 < 0.55 or r1 < 0.55:
                    continue
                ref_asp = ref_s[0] / max(ref_s[1], 0.001)
                asp_r = (min(det_asp, ref_asp)
                         / max(det_asp, ref_asp, 0.001))
                if asp_r < 0.55:
                    continue
                size_score = (r0 + r1 + asp_r) / 3.0

                ref_mask = t['mask']
                ref_h, ref_w = ref_mask.shape[:2]
                fy = ref_h / max(det_h, 1)
                fx = ref_w / max(det_w, 1)
                try:
                    det_mask_scaled = (_zoom(mask_crop.astype(np.float32),
                                             (fy, fx), order=0) > 0.5)
                except Exception:
                    continue

                # Best of 4 rotations; templates already cover 12 yaws so
                # a 4-rotation sweep is enough to align with any one of them.
                mask_iou = 0.0
                for rot in range(4):
                    rm = np.rot90(det_mask_scaled, rot)
                    mh = min(rm.shape[0], ref_mask.shape[0])
                    mw = min(rm.shape[1], ref_mask.shape[1])
                    rm_c = rm[:mh, :mw]
                    rf_c = ref_mask[:mh, :mw]
                    inter = float(np.sum(rm_c & rf_c))
                    union = float(np.sum(rm_c | rf_c))
                    iou = inter / max(union, 1.0)
                    if iou > mask_iou:
                        mask_iou = iou

                edge_score = 0.0
                ref_edges = t['edges']
                if det_edges is not None and ref_edges is not None:
                    try:
                        de_scaled = _zoom(det_edges, (fy, fx), order=0)
                        re = ref_edges.astype(np.float32)
                        for rot in range(4):
                            dr = np.rot90(de_scaled, rot)
                            mh = min(dr.shape[0], re.shape[0])
                            mw = min(dr.shape[1], re.shape[1])
                            a = re[:mh, :mw].flatten()
                            b = dr[:mh, :mw].flatten()
                            if a.size < 100 or a.size != b.size:
                                continue
                            a_m, a_s = float(a.mean()), float(a.std())
                            b_m, b_s = float(b.mean()), float(b.std())
                            if a_s > 0.02 and b_s > 0.02:
                                ncc = float(np.mean(
                                    (a - a_m) * (b - b_m)
                                ) / (a_s * b_s))
                                if ncc > edge_score:
                                    edge_score = max(0.0, ncc)
                    except Exception:
                        pass

                score = (size_score * 0.40
                         + mask_iou  * 0.30
                         + edge_score * 0.30)
                if score > best_score:
                    best_score   = score
                    best_part_id = part_id
                    best_name    = name
                    best_yaw     = t['yaw_deg']
                    best_orient  = t['orient_label']
                    best_bd      = (size_score, mask_iou, edge_score)

        if best_part_id is not None and best_score > 0.30:
            sz, iou, ed = best_bd
            self.get_logger().info(
                f'TEMPLATE_MATCH: {best_name} score={best_score:.2f} '
                f'orient={best_orient} yaw={best_yaw:.0f}° '
                f'size={sz:.2f} iou={iou:.2f} edges={ed:.2f}',
                throttle_duration_sec=2.0)
        if best_score < 0.55:
            return None, None, 0.0, 0.0, None
        return (best_name, best_part_id, round(best_score, 3),
                best_yaw, best_orient)

    def _match_by_teach(self, depth_crop, mask_crop, obb_size, color_crop=None):
        """Scale-aware teach matching.

        The old version normalised every crop to 64x64 before comparing,
        which threw away the only signal that distinguishes a 3.8 cm
        block from a 6.3 cm block. This version:

          1. Hard size gate first (each XY dim within 55%, aspect within
             55%) — cheap arithmetic that eliminates impossible refs.
          2. Resizes the live detection's mask + edges to each
             reference's native pixel dims so the silhouettes are
             compared at the SAME physical resolution.
          3. Best-of-4-rotations mask IoU + edge NCC at that scale.
          4. Combined score (size 0.40, IoU 0.30, edges 0.30) must
             clear 0.60 to win.
        """
        if not self._teach_refs:
            return 'unknown', None, 0

        if mask_crop is None or mask_crop.shape[0] < 20 or mask_crop.shape[1] < 20:
            return 'unknown', None, 0
        if not np.any(mask_crop):
            return 'unknown', None, 0

        det_max_dim = (max(float(obb_size[0]), float(obb_size[1]))
                       if obb_size is not None and len(obb_size) >= 2 else 0.0)
        if det_max_dim < 0.015:
            return 'unknown', None, 0

        from scipy.ndimage import (
            sobel as _sobel, gaussian_filter, zoom as _zoom,
        )

        # ── Detection edge map at native resolution ────────────────────
        det_edges = None
        if color_crop is not None and color_crop.size > 0:
            gray = (np.mean(color_crop.astype(np.float32), axis=2)
                    if color_crop.ndim == 3
                    else color_crop.astype(np.float32))
            gs = gaussian_filter(gray, sigma=1.0)
            emag = np.sqrt(_sobel(gs, axis=0) ** 2 + _sobel(gs, axis=1) ** 2)
            emax = float(emag.max())
            det_edges = ((emag / emax > 0.15).astype(np.float32)
                         if emax > 0 else np.zeros_like(gray, dtype=np.float32))

        det_h, det_w = mask_crop.shape[:2]

        best_name = 'unknown'
        best_id   = None
        best_score = 0.0
        best_bd = (0.0, 0.0, 0.0)  # size, iou, edge

        for part_id, refs in self._teach_refs.items():
            for ref in refs:
                ref_size = ref.get('size_m')
                if ref_size is None:
                    continue
                rs = (ref_size.tolist()
                      if hasattr(ref_size, 'tolist') else list(ref_size))

                # ── SIZE GATE ─────────────────────────────────────────
                det_s = sorted([float(obb_size[0]), float(obb_size[1])],
                               reverse=True)
                ref_s = sorted([float(rs[0]), float(rs[1])], reverse=True)
                r0 = min(det_s[0], ref_s[0]) / max(det_s[0], ref_s[0], 0.001)
                r1 = min(det_s[1], ref_s[1]) / max(det_s[1], ref_s[1], 0.001)
                if r0 < 0.55 or r1 < 0.55:
                    continue
                det_asp = det_s[0] / max(det_s[1], 0.001)
                ref_asp = ref_s[0] / max(ref_s[1], 0.001)
                asp_r = (min(det_asp, ref_asp)
                         / max(det_asp, ref_asp, 0.001))
                if asp_r < 0.55:
                    continue
                size_score = (r0 + r1 + asp_r) / 3.0

                # ── SCALE-AWARE COMPARISON ────────────────────────────
                ref_mask = ref.get('mask')
                if ref_mask is None:
                    continue
                ref_h, ref_w = ref_mask.shape[:2]
                fy = ref_h / max(det_h, 1)
                fx = ref_w / max(det_w, 1)
                try:
                    det_mask_scaled = _zoom(
                        mask_crop.astype(np.float32),
                        (fy, fx), order=0) > 0.5
                except Exception:
                    continue

                mask_iou = 0.0
                for rot in range(4):
                    rm = np.rot90(det_mask_scaled, rot)
                    mh = min(rm.shape[0], ref_mask.shape[0])
                    mw = min(rm.shape[1], ref_mask.shape[1])
                    rm_c = rm[:mh, :mw]
                    rf_c = ref_mask[:mh, :mw]
                    inter = float(np.sum(rm_c & rf_c))
                    union = float(np.sum(rm_c | rf_c))
                    iou = inter / max(union, 1.0)
                    if iou > mask_iou:
                        mask_iou = iou

                edge_score = 0.0
                ref_edges = ref.get('edges')
                if det_edges is not None and ref_edges is not None:
                    try:
                        det_e_scaled = _zoom(
                            det_edges, (fy, fx), order=0)
                        ref_e = ref_edges.astype(np.float32)
                        for rot in range(4):
                            re = np.rot90(det_e_scaled, rot)
                            mh = min(re.shape[0], ref_e.shape[0])
                            mw = min(re.shape[1], ref_e.shape[1])
                            a = ref_e[:mh, :mw].flatten()
                            b = re[:mh, :mw].flatten()
                            if a.size < 100 or a.size != b.size:
                                continue
                            a_m, a_s = float(a.mean()), float(a.std())
                            b_m, b_s = float(b.mean()), float(b.std())
                            if a_s > 0.02 and b_s > 0.02:
                                ncc = float(np.mean(
                                    (a - a_m) * (b - b_m)
                                ) / (a_s * b_s))
                                if ncc > edge_score:
                                    edge_score = max(0.0, ncc)
                    except Exception:
                        pass

                score = (size_score * 0.40
                         + mask_iou   * 0.30
                         + edge_score * 0.30)

                if size_score > 0.5:
                    self.get_logger().info(
                        f'MATCH_CMP: part={part_id[:8]} '
                        f'det=[{det_s[0]*100:.1f}x{det_s[1]*100:.1f}cm] '
                        f'asp={det_asp:.1f} '
                        f'ref=[{ref_s[0]*100:.1f}x{ref_s[1]*100:.1f}cm] '
                        f'asp={ref_asp:.1f} '
                        f'size={size_score:.2f} iou={mask_iou:.2f} '
                        f'edge={edge_score:.2f} total={score:.2f}',
                        throttle_duration_sec=5.0)

                if score > best_score:
                    best_score = score
                    best_id    = part_id
                    best_bd    = (size_score, mask_iou, edge_score)
                    meta_path  = f'/opt/cobot/parts/metadata/{part_id}.json'
                    if os.path.exists(meta_path):
                        try:
                            with open(meta_path) as fp:
                                best_name = json.load(fp).get('name') or part_id
                        except Exception:
                            best_name = part_id
                    else:
                        best_name = part_id

        if best_score > 0.30:
            sz, iou, ed = best_bd
            self.get_logger().info(
                f'TEACH_MATCH: {best_name} score={best_score:.2f} '
                f'size={sz:.2f} iou={iou:.2f} edges={ed:.2f}',
                throttle_duration_sec=3.0)

        if best_score < 0.60:
            return 'unknown', None, 0
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
        # IoU-based tracker smooths bbox / pos / size / yaw so the
        # annotation doesn't bounce while the scene is static.
        stable = self._update_tracks(stable)
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

    def _load_step_dims(self):
        """Return {part_id: sorted_top_2_extents_m} parsed from
        /opt/cobot/parts/index.json. The STEP-derived extents are the
        EXACT ground-truth dimensions and feed the strict size gate."""
        out = {}
        path = '/opt/cobot/parts/index.json'
        if not os.path.isfile(path):
            return out
        try:
            with open(path) as f:
                idx = json.load(f)
            for p in idx.get('parts', []):
                ext = p.get('extents_cm') or []
                if len(ext) < 2:
                    continue
                top2 = sorted([float(ext[0]) / 100.0,
                               float(ext[1]) / 100.0,
                               (float(ext[2]) / 100.0 if len(ext) >= 3 else 0.0)],
                              reverse=True)[:2]
                out[p['id']] = top2
        except Exception:
            pass
        return out

    @staticmethod
    def _color_hist_corr(rgb1, rgb2, bins=16):
        """Pearson correlation between two RGB images' per-channel
        histograms. numpy-only — depth_segment_node has a hard
        no-cv2/no-skimage policy.

        Used as an orientation tie-breaker: two refs with identical
        outline (a key-fob front vs back) often produce near-identical
        NCC scores, but the surface texture / colour distribution
        differs and shows up in the histogram. Returns 0..1; values
        below 0 are clamped (negative correlation means "very different
        distributions" — equivalent to 0 for our scoring purposes)."""
        try:
            if rgb1 is None or rgb2 is None:
                return 0.0
            r1 = np.asarray(rgb1)
            r2 = np.asarray(rgb2)
            if r1.size == 0 or r2.size == 0:
                return 0.0
            if r1.ndim == 2:
                r1 = np.stack([r1, r1, r1], axis=-1)
            if r2.ndim == 2:
                r2 = np.stack([r2, r2, r2], axis=-1)
            parts = []
            for c in range(min(3, r1.shape[-1], r2.shape[-1])):
                h1, _ = np.histogram(r1[..., c], bins=bins, range=(0, 256))
                h2, _ = np.histogram(r2[..., c], bins=bins, range=(0, 256))
                h1 = h1.astype(np.float32)
                h2 = h2.astype(np.float32)
                s1, s2 = h1.sum(), h2.sum()
                if s1 > 0: h1 /= s1
                if s2 > 0: h2 /= s2
                parts.append((h1, h2))
            # Concatenate per-channel histograms into one vector and
            # Pearson-correlate.
            a = np.concatenate([p[0] for p in parts])
            b = np.concatenate([p[1] for p in parts])
            sa, sb = float(a.std()), float(b.std())
            if sa < 1e-9 or sb < 1e-9:
                return 0.0
            corr = float(np.mean((a - a.mean()) * (b - b.mean())) / (sa * sb))
            return max(0.0, min(1.0, corr))
        except Exception:
            return 0.0

    def _match_part(self, mask_crop, obb_size, color_crop=None,
                    depth_crop=None):
        """Reliable per-detection matcher.

        Two stages:
          1) STEP-file dimension gate — exact ground-truth extents from
             /opt/cobot/parts/index.json. Each XY dim must be within 50%
             of the part's two largest CAD extents and aspect within 50%.
             Eliminates impossible candidates before any image work.
          2) Grayscale NCC at the SAME physical resolution as each teach
             reference, best of 4 rotations.

        Final score is `size * 0.50 + ncc * 0.50`. Threshold 0.60.

        Falls back to CAD-template matching when no teach refs exist
        (or none for a given part_id) — that path also supplies the
        orientation tag (pickable / flipped / on_side).

        Returns (name|'unknown', id|None, score, orientation|'', info_dict).
        info_dict carries is_pickable / is_defect / orientation_label /
        defect_name extracted from the matched ref so the renderer can
        colour the bounding box appropriately.
        """
        empty_info = {}
        # If absolutely no teach refs anywhere, lean entirely on templates.
        if not self._teach_refs:
            n, pid, s, _y, o = self._match_by_templates(
                mask_crop, obb_size, color_crop)
            # Template matches use legacy orientation tags
            # (pickable / flipped / on_side); derive is_pickable.
            info = {'is_pickable': (o == 'pickable')} if o else {}
            return (n or 'unknown'), pid, s, (o or ''), info

        if mask_crop is None or color_crop is None:
            return 'unknown', None, 0.0, '', empty_info
        crop_h, crop_w = mask_crop.shape[:2]
        if crop_h < 25 or crop_w < 25:
            return 'unknown', None, 0.0, '', empty_info

        det_max_dim = (max(float(obb_size[0]), float(obb_size[1]))
                       if obb_size is not None and len(obb_size) >= 2 else 0.0)
        if det_max_dim < 0.015:
            return 'unknown', None, 0.0, '', empty_info

        det_s = sorted([float(obb_size[0]), float(obb_size[1])], reverse=True)
        det_asp = det_s[0] / max(det_s[1], 0.001)
        # Track the ref that drove the best score so we can return its
        # is_pickable / is_defect / orientation_label downstream.
        best_ref_meta = None

        # Detection grayscale at native resolution.
        if color_crop.ndim == 3:
            det_gray = np.mean(color_crop.astype(np.float32), axis=2)
        else:
            det_gray = color_crop.astype(np.float32)

        # Physical scale of THIS detection. Median depth over the mask
        # → fx / depth = px/m → /100 = px/cm.
        if (depth_crop is not None and mask_crop is not None
                and np.any(mask_crop)):
            valid = mask_crop & (depth_crop > 0) & np.isfinite(depth_crop)
            if valid.any():
                det_distance = float(np.median(depth_crop[valid]))
            else:
                det_distance = 0.5
        else:
            det_distance = 0.5
        fx_val = self._K[0] if self._K else 600.0
        det_px_per_cm = (fx_val / max(det_distance, 1e-3)) / 100.0

        step_dims = self._load_step_dims()

        from scipy.ndimage import zoom as _zoom

        best_score = 0.0
        best_id    = None
        best_name  = 'unknown'

        for part_id, refs in self._teach_refs.items():
            # ── Size gate from STEP dimensions ─────────────────────────
            sd = step_dims.get(part_id)
            if sd is not None:
                r0 = min(det_s[0], sd[0]) / max(det_s[0], sd[0], 0.001)
                r1 = min(det_s[1], sd[1]) / max(det_s[1], sd[1], 0.001)
                step_asp = sd[0] / max(sd[1], 0.001)
                asp_r = (min(det_asp, step_asp)
                         / max(det_asp, step_asp, 0.001))
                if r0 < 0.50 or r1 < 0.50 or asp_r < 0.50:
                    continue
                size_score = (r0 + r1 + asp_r) / 3.0
            else:
                size_score = 0.5  # no STEP record — neutral

            # ── Orientation-aware ref matching ─────────────────────────
            #
            # Group refs by orientation key (is_pickable, is_defect,
            # orientation_number, orientation_label). Compute the MEAN
            # NCC and MEAN colour-histogram correlation per group, then
            # pick the highest-scoring group. The "best ref" inside
            # that group supplies the metadata.
            #
            # Why this matters: a key fob's front and back have nearly
            # identical outlines, so any single ref's NCC can win at
            # random under noise. Averaging per-group + adding colour
            # histogram correlation breaks the tie based on actual
            # surface differences (buttons vs flat back).
            groups = {}
            for ref in refs:
                gkey = (
                    bool(ref.get('is_pickable', True)),
                    bool(ref.get('is_defect', False)),
                    int(ref.get('orientation_number', 0)),
                    str(ref.get('orientation_label') or ''),
                )
                groups.setdefault(gkey, []).append(ref)

            best_group_score = 0.0
            best_group_key   = None
            best_group_meta  = None    # (avg_ncc, avg_hist, n_refs, best_ref)
            group_dbg = []             # for the throttled log

            for gkey, grp_refs in groups.items():
                nccs   = []
                hists  = []
                best_in_group_ncc = 0.0
                best_in_group_ref = None

                for ref in grp_refs:
                    ref_gray = ref.get('gray')
                    ref_px_per_cm = float(ref.get('px_per_cm', 10.0) or 10.0)
                    if ref_gray is None or ref_px_per_cm <= 0:
                        continue
                    ref_h, ref_w = ref_gray.shape[:2]

                    # Scale detection so 1 cm on the part takes the same
                    # pixel count as it does in the reference.
                    phys_scale = ref_px_per_cm / max(det_px_per_cm, 0.1)
                    target_h = int(round(crop_h * phys_scale))
                    target_w = int(round(crop_w * phys_scale))
                    if (target_h < 20 or target_w < 20
                            or target_h > 300 or target_w > 300):
                        continue
                    try:
                        det_scaled = _zoom(
                            det_gray,
                            (target_h / crop_h, target_w / crop_w), order=1)
                    except Exception:
                        continue

                    best_rot_ncc = 0.0
                    for rot in range(4):
                        dr = np.rot90(det_scaled, rot) if rot else det_scaled
                        mh = min(dr.shape[0], ref_h)
                        mw = min(dr.shape[1], ref_w)
                        if mh < 15 or mw < 15:
                            continue
                        a = ref_gray[:mh, :mw].flatten()
                        b = dr[:mh, :mw].flatten()
                        if a.size != b.size or a.size < 100:
                            continue
                        a_m, a_s = float(a.mean()), float(a.std())
                        b_m, b_s = float(b.mean()), float(b.std())
                        if a_s < 1.0 or b_s < 1.0:
                            continue  # flat / featureless — can't trust
                        ncc = float(np.mean(
                            (a - a_m) * (b - b_m)
                        ) / (a_s * b_s))
                        ncc = max(0.0, ncc)
                        if ncc > best_rot_ncc:
                            best_rot_ncc = ncc
                    if best_rot_ncc > 0:
                        nccs.append(best_rot_ncc)
                        if best_rot_ncc > best_in_group_ncc:
                            best_in_group_ncc = best_rot_ncc
                            best_in_group_ref = ref

                    # Colour-histogram tie-breaker. Only counts when
                    # both detection and ref carry colour pixels.
                    ref_color = ref.get('color')
                    if ref_color is not None and color_crop is not None:
                        hists.append(self._color_hist_corr(color_crop, ref_color))

                if not nccs:
                    continue
                avg_ncc  = float(np.mean(nccs))
                avg_hist = float(np.mean(hists)) if hists else 0.5
                # Weighted: NCC dominates (texture/shape correlation is
                # the primary signal); histogram supplies the tie-break
                # when two groups have similar NCC but different
                # surface colours.
                group_score = avg_ncc * 0.70 + avg_hist * 0.30

                group_dbg.append((gkey, avg_ncc, avg_hist, group_score, len(nccs)))

                if group_score > best_group_score:
                    best_group_score = group_score
                    best_group_key   = gkey
                    best_group_meta  = (avg_ncc, avg_hist, len(nccs), best_in_group_ref)

            if best_group_meta is None:
                continue

            best_ref_ncc, best_ref_hist, n_refs, best_ref_for_part = best_group_meta
            combined = size_score * 0.50 + best_group_score * 0.50

            # Per-group debug log so the operator can see WHY one
            # orientation won over another. Sorted by score desc.
            try:
                group_dbg.sort(key=lambda x: -x[3])
                gap = (group_dbg[0][3] - group_dbg[1][3]) if len(group_dbg) >= 2 else float('nan')
                summary = ' | '.join(
                    "{}'{}' ncc={:.2f} hist={:.2f} score={:.2f} ({}r)".format(
                        'pick' if k[0] else 'NOpick', k[3] or '?',
                        a, h, s, n
                    )
                    for (k, a, h, s, n) in group_dbg
                )
                self.get_logger().info(
                    f'ORIENT_MATCH {part_id[:8]} det=[{det_s[0]*100:.1f}x{det_s[1]*100:.1f}cm] '
                    f'size={size_score:.2f} → '
                    f'winner={"PICK" if best_group_key[0] else "NOpick"}/'
                    f'"{best_group_key[3] or "?"}" '
                    f'gap={gap:.2f} | {summary}',
                    throttle_duration_sec=3.0)
            except Exception:
                pass

            if combined > best_score:
                best_score = combined
                best_id    = part_id
                best_ref_meta = best_ref_for_part
                meta_path  = f'/opt/cobot/parts/metadata/{part_id}.json'
                if os.path.isfile(meta_path):
                    try:
                        with open(meta_path) as fp:
                            best_name = json.load(fp).get('name') or part_id
                    except Exception:
                        best_name = part_id
                else:
                    best_name = part_id

        # If we found a teach match, return it with the rich orientation
        # metadata from the winning ref. Falls back to the template path
        # if the teach score is below threshold so CAD-only parts still
        # match (template path returns the legacy pickable/flipped/on_side
        # orientation string).
        if best_score >= 0.60 and best_id is not None:
            info = {}
            if best_ref_meta is not None:
                info = {
                    'is_pickable':       bool(best_ref_meta.get('is_pickable', True)),
                    'is_defect':         bool(best_ref_meta.get('is_defect', False)),
                    'orientation_label': str(best_ref_meta.get('orientation_label') or ''),
                    'defect_name':       str(best_ref_meta.get('defect_name') or ''),
                }
            return best_name, best_id, round(best_score, 3), '', info

        n, pid, s, _y, o = self._match_by_templates(
            mask_crop, obb_size, color_crop)
        if n and s >= 0.55:
            return n, pid, s, (o or ''), {'is_pickable': (o == 'pickable')} if o else {}
        return 'unknown', None, 0.0, '', empty_info

    def _match_parts(self, objects):
        """Two-stage recognition: STEP dimension gate + physical-scale
        NCC against teach refs, with CAD-template matching as fallback
        for parts the operator hasn't taught."""
        if not objects:
            return
        if self._teach_mode:
            # Wizard is showing the part from various angles — suppress
            # recognition entirely so the operator sees clean green boxes.
            for o in objects:
                o['part_name']        = None
                o['part_id']          = None
                o['match_score']      = 0.0
                o['match_yaw']        = 0.0
                o['position_correct'] = None
                o['yaw_error_deg']    = 0.0
                o['surface_ok']       = None
                o['position_status']  = ''
                o['orientation']      = None
                o['is_pickable']      = None
                o['is_defect']        = False
                o['orientation_label']= ''
                o['defect_name']      = ''
                o['_holes']           = []
                o['_match_reason']    = ''
                o['_match_source']    = ''
            return
        for o in objects:
            mask  = o.get('mask_2d')
            depth = o.get('depth_2d')
            sx, sy, sz = o.get('size_3d') or (0.05, 0.05, 0.05)
            size_m = [float(sx), float(sy), float(sz)]
            color_crop = o.get('color_crop')

            name, pid, score, orient, match_info = self._match_part(
                mask, size_m, color_crop=color_crop, depth_crop=depth)
            matched = (name and name != 'unknown')

            o['_holes']        = []
            o['_match_reason'] = ''
            o['_match_source'] = ('teach' if matched and not orient
                                  else ('template' if matched else ''))
            o['orientation']   = orient or None
            # Rich orientation metadata from the matched teach ref so
            # _publish_annotated can colour boxes (green pickable / red
            # non-pickable / red defect) and the dashboard can surface
            # the operator-supplied label.
            o['is_pickable']       = bool(match_info.get('is_pickable', True)) if matched else None
            o['is_defect']         = bool(match_info.get('is_defect', False)) if matched else False
            o['orientation_label'] = str(match_info.get('orientation_label') or '')
            o['defect_name']       = str(match_info.get('defect_name') or '')

            if not matched:
                o['part_name']         = None
                o['part_id']           = None
                o['match_score']       = 0.0
                o['match_yaw']         = 0.0
                o['position_correct']  = None
                o['yaw_error_deg']     = 0.0
                o['surface_ok']        = None
                o['position_status']   = ''
                o['is_pickable']       = None
                o['is_defect']         = False
                o['orientation_label'] = ''
                o['defect_name']       = ''
                continue

            o['part_name']   = str(name)
            o['part_id']     = str(pid) if pid else None
            o['match_score'] = float(round(score, 3))
            o['match_yaw']   = 0.0
            # When the template path supplied orient, encode the
            # pickable / flipped / on_side verdict. Teach-only matches
            # have no orientation info — treat as unknown.
            o['position_correct'] = (orient == 'pickable') if orient else None
            o['yaw_error_deg']    = 0.0
            o['surface_ok']       = (orient == 'pickable') if orient else None
            o['position_status']  = (
                'PICKABLE' if orient == 'pickable'
                else ('FLIPPED' if orient == 'flipped'
                      else ('ON_SIDE' if orient == 'on_side' else '')))

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
                      fill=color, width=3)

    @staticmethod
    def _min_area_rect_2d(mask, offset_x=0, offset_y=0):
        """Minimum-area rotated rectangle around a 2D binary mask.

        Returns 4 corner points (4x2) in full-image coordinates, or None
        if the mask is too sparse / degenerate. Computed in pixel space
        via convex hull + rotating calipers — no 3D projection, so no
        depth-noise offset between box and actual silhouette.
        """
        from scipy.spatial import ConvexHull
        from scipy.spatial.qhull import QhullError

        ys, xs = np.where(mask)
        if xs.size < 5:
            return None
        pts = np.column_stack(
            [xs + offset_x, ys + offset_y]).astype(np.float64)
        try:
            hull = ConvexHull(pts)
        except (QhullError, ValueError):
            return None
        hpts = pts[hull.vertices]
        if len(hpts) < 3:
            return None

        best_area = float('inf')
        best_corners = None
        n_h = len(hpts)
        for i in range(n_h):
            edge = hpts[(i + 1) % n_h] - hpts[i]
            angle = math.atan2(float(edge[1]), float(edge[0]))
            ca = math.cos(-angle)
            sa = math.sin(-angle)
            rotated = np.column_stack([
                hpts[:, 0] * ca - hpts[:, 1] * sa,
                hpts[:, 0] * sa + hpts[:, 1] * ca,
            ])
            mn = rotated.min(axis=0)
            mx = rotated.max(axis=0)
            area = float((mx[0] - mn[0]) * (mx[1] - mn[1]))
            if area > 0 and area < best_area:
                best_area = area
                corners_rot = np.array([
                    [mn[0], mn[1]],
                    [mx[0], mn[1]],
                    [mx[0], mx[1]],
                    [mn[0], mx[1]],
                ])
                ca_back = math.cos(angle)
                sa_back = math.sin(angle)
                best_corners = np.column_stack([
                    corners_rot[:, 0] * ca_back - corners_rot[:, 1] * sa_back,
                    corners_rot[:, 0] * sa_back + corners_rot[:, 1] * ca_back,
                ])
        return best_corners

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
            matched     = bool(o.get('part_name'))
            is_pickable = o.get('is_pickable')      # True / False / None
            is_defect   = bool(o.get('is_defect'))
            orient_lbl  = str(o.get('orientation_label') or '')
            defect_lbl  = str(o.get('defect_name') or '')
            # Legacy template-matcher orientation (pickable/flipped/on_side)
            # still informs is_pickable when the matcher didn't set it.
            orientation = o.get('orientation')
            if matched and is_pickable is None and orientation:
                is_pickable = (orientation == 'pickable')
            # Four-state colour code keyed on is_pickable + is_defect:
            #   green  — matched + pickable (operator approved this view)
            #   red    — matched + non-pickable OR defect (do NOT grasp)
            #   amber  — matched but orientation unknown
            #   grey   — no match (unknown object)
            green = (22, 163, 74)
            red   = (220, 38, 38)
            amber = (202, 138, 4)
            grey  = (156, 163, 175)
            if matched and is_defect:
                col = red
            elif matched and is_pickable is True:
                col = green
            elif matched and is_pickable is False:
                col = red
            elif matched:
                col = amber
            else:
                col = grey

            # Pixel-space minimum-area rotated rectangle around the
            # cleaned mask. Drawing from mask pixels (not from projected
            # 3D corners) means the box always sits exactly on the
            # silhouette regardless of depth noise. The 3D OBB is still
            # what gets published for grasp planning.
            mask_2d = o.get('mask_2d')
            rect_corners = None
            if mask_2d is not None and mask_2d.any():
                rect_corners = self._min_area_rect_2d(
                    mask_2d, offset_x=x0, offset_y=y0)

            # Thickness signals "is this object known?" at a glance —
            # matched parts get a 3px border, unknowns get 1px.
            box_thick = 3 if matched else 1
            if rect_corners is not None:
                for i in range(4):
                    p1 = (int(round(rect_corners[i][0])),
                          int(round(rect_corners[i][1])))
                    p2 = (int(round(rect_corners[(i + 1) % 4][0])),
                          int(round(rect_corners[(i + 1) % 4][1])))
                    draw.line([p1, p2], fill=col, width=box_thick)
                top_y = int(np.min(rect_corners[:, 1]))
                left_x = int(np.min(rect_corners[:, 0]))
                cx_box = float(np.mean(rect_corners[:, 0]))
                cy_box = float(np.mean(rect_corners[:, 1]))
                bx0 = int(np.min(rect_corners[:, 0]))
                by0 = int(np.min(rect_corners[:, 1]))
                bx1 = int(np.max(rect_corners[:, 0]))
                by1 = int(np.max(rect_corners[:, 1]))
            else:
                draw.rectangle(
                    [x0 + 1, y0 + 1, x1 - 1, y1 - 1],
                    outline=col, width=box_thick)
                top_y = y0
                left_x = x0
                cx_box = (x0 + x1) * 0.5
                cy_box = (y0 + y1) * 0.5
                bx0, by0, bx1, by1 = int(x0), int(y0), int(x1), int(y1)

            # NON-PICKABLE / DEFECT: draw a red X across the box so the
            # operator's eye catches "do not grasp" without reading text.
            if matched and (is_defect or is_pickable is False):
                draw.line([(bx0, by0), (bx1, by1)], fill=red, width=2)
                draw.line([(bx1, by0), (bx0, by1)], fill=red, width=2)

            # PICKABLE: small green checkmark in the top-left corner.
            if matched and is_pickable is True and not is_defect:
                cx_check, cy_check = bx0 + 6, by0 + 14
                draw.line([(cx_check, cy_check),
                           (cx_check + 4, cy_check + 4)], fill=green, width=2)
                draw.line([(cx_check + 4, cy_check + 4),
                           (cx_check + 12, cy_check - 6)], fill=green, width=2)

            # Cyan orientation arrow at the rect centre, pointing along
            # the OBB yaw (rotation about cam-Z = optical axis).
            yaw_deg = yaw * 180.0 / math.pi
            arrow_len = max(x1 - x0, y1 - y0) * 0.35
            ex = cx_box + arrow_len * math.cos(yaw)
            ey = cy_box + arrow_len * math.sin(yaw)
            cyan = (0, 220, 255)
            draw.line([(cx_box, cy_box), (ex, ey)], fill=cyan, width=2)
            head = max(5.0, arrow_len * 0.18)
            for a in (yaw + 2.6, yaw - 2.6):
                draw.line([(ex, ey),
                           (ex - head * math.cos(a), ey - head * math.sin(a))],
                          fill=cyan, width=2)

            w_cm = int(round(sx * 100))
            h_cm = int(round(sy * 100))
            holes = o.get('_holes') or []
            n_holes = len(holes)
            if matched:
                pct = int(round(float(o.get('match_score') or 0) * 100))
                hole_tag = f' [{n_holes}h]' if n_holes else ''
                if is_defect:
                    tag = defect_lbl or 'defect'
                    label = f"DEFECT: {tag} — {o['part_name']} ({pct}%){hole_tag}"
                elif is_pickable is True:
                    suffix = f' — {orient_lbl}' if orient_lbl else ''
                    label = f"{o['part_name']}{suffix} — PICK OK ({pct}%){hole_tag}"
                elif is_pickable is False:
                    tag = orient_lbl or 'non-pickable'
                    label = f"{o['part_name']} — NO PICK: {tag} ({pct}%){hole_tag}"
                elif orientation == 'flipped':
                    label = f"{o['part_name']} ({pct}%){hole_tag} ⚠ FLIPPED"
                elif orientation == 'on_side':
                    label = f"{o['part_name']} ({pct}%){hole_tag} ⚠ ON SIDE"
                else:
                    label = f"{o['part_name']} ({pct}%){hole_tag} {pz:.2f}m"
            else:
                label = f'{pz:.2f}m {w_cm}×{h_cm}cm yaw:{yaw_deg:+.0f}°'
            label_font = _ANNOT_FONT if matched else _ANNOT_FONT_SMALL
            bbox_text = draw.textbbox((0, 0), label, font=label_font)
            tw = bbox_text[2] - bbox_text[0] + 8
            th = bbox_text[3] - bbox_text[1] + 6
            label_x = max(0, int(left_x))
            label_y = max(0, int(top_y) - th - 2)
            draw.rectangle([label_x, label_y, label_x + tw, label_y + th],
                           fill=col)
            draw.text((label_x + 4, label_y + 2), label,
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
