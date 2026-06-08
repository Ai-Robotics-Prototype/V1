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
from scipy.stats import skew as _scipy_skew, kurtosis as _scipy_kurtosis
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


# Per-part orient-match cache. Updated by _match_part on each frame
# the part is matched. In-process only — depth_segment_node and
# dashboard_server run in SEPARATE processes, so the dashboard's
# /api/parts/<id>/orientation_debug endpoint reads from the
# .last_match.json sidecar this module writes (see _write_last_match).
# Other in-process consumers (debug nodes, future GUI) can still
# import this dict directly.
_last_orient_match: dict = {}


def _write_last_match(part_id: str, payload: dict) -> None:
    """Atomically write the part's latest orient-match payload to a
    sidecar JSON the dashboard process can read. Writes are throttled
    inside _match_part so we hit the FS at most ~2x/sec per part."""
    try:
        teach_dir = os.path.join('/opt/cobot/parts/teach', str(part_id))
        os.makedirs(teach_dir, exist_ok=True)
        path = os.path.join(teach_dir, '.last_match.json')
        tmp  = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        pass


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
        self._orient_classifiers = {}   # part_id -> nearest-centroid clf
                                        # (populated by _load_teach_refs)
        self._templates    = {}     # part_id -> {name, templates:[...]}
        # While the teach wizard is open the operator is showing the part
        # from different angles; the matcher would happily false-positive
        # off those frames, so we short-circuit recognition entirely until
        # the wizard tells us it's done.
        self._teach_mode   = False
        self._load_teach_refs()
        self._backfill_classifiers()
        self._load_templates()
        # Per-face CAD feature anchors (hole + boss centres for each
        # of top / bottom / right / left / front / back). Read once at
        # startup; the matcher uses these to verify the live crop
        # actually shows the features the CAD model says belong on
        # the winning face. Empty for camera-only parts (no STEP).
        self._cad_face_features = self._load_cad_face_features()
        if self._cad_face_features:
            self.get_logger().info(
                'cad face features: '
                + ', '.join(
                    f'{k[:8]}('
                    f'{sum(1 for v in self._cad_face_features[k].values() if v.get("has_features"))}'
                    f'/{len(self._cad_face_features[k])} faces)'
                    for k in self._cad_face_features))
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
        # Multi-shape cache. _process now asks for both full-res and
        # half-res grids on the same frame; a single-slot cache would
        # thrash between them and re-allocate ~2.4 MB of uv arrays
        # every frame. dict keyed by (h, w) gives O(1) reuse.
        if not isinstance(self._uv_cache, dict):
            self._uv_cache = {}
        key = (h, w)
        cached = self._uv_cache.get(key)
        if cached is None:
            u = np.arange(w, dtype=np.float32)[None, :].repeat(h, axis=0)
            v = np.arange(h, dtype=np.float32)[:, None].repeat(w, axis=1)
            self._uv_cache[key] = (u, v)
            return u, v
        return cached[0], cached[1]

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

        # ── Foreground detection at half resolution ───────────────────
        # All the expensive ops (plane fit, depth Sobel, morphology,
        # boundary carving, fill_holes) run on a 240×320 downsample —
        # ~4× fewer pixels for the same detection quality. A 2 cm
        # part at 0.5 m still spans ~20 px at half-res so component
        # extraction never loses anything we care about. The final
        # foreground mask is upsampled back to full-res before bbox
        # extraction; the per-bbox crops then use raw full-res depth
        # so OBB / matching downstream is unaffected.
        from scipy.ndimage import zoom as _zoom_hr
        _half_h = h // 2
        _half_w = w // 2
        # order=1 for depth (smooth gradients matter for the Sobel),
        # order=0 (nearest) for the valid mask (just a binary flag).
        depth_half = _zoom_hr(depth, 0.5, order=1)
        valid_half = _zoom_hr(valid.astype(np.float32), 0.5, order=0) > 0.5

        # Plane fit on the half-res grid. Scale intrinsics to match —
        # fx/fy are pixel-per-metre at the half-res sampling.
        fx_h = fx * 0.5; fy_h = fy * 0.5
        cx_h = cx * 0.5; cy_h = cy * 0.5
        u_h, v_h = self._uv_grids(_half_h, _half_w)
        Z_h = np.where(valid_half, depth_half, 0.0).astype(np.float32)
        X_h = (u_h - cx_h) * Z_h / fx_h
        Y_h = (v_h - cy_h) * Z_h / fy_h
        vy_h, vx_h = np.nonzero(valid_half)
        # Sample budget halved alongside the resolution — same
        # statistical power on a 4× smaller pixel grid.
        if vy_h.size > 2000:
            sel = np.random.choice(vy_h.size, 2000, replace=False)
            vy_h, vx_h = vy_h[sel], vx_h[sel]
        plane = self._fit_plane(
            X_h[vy_h, vx_h], Y_h[vy_h, vx_h], Z_h[vy_h, vx_h])
        if plane is None:
            self._history.append([])
            self._emit(h, w)
            return
        a, b, c = plane
        plane_z_h = a * X_h + b * Y_h + c
        # (a) planar background subtraction at half-res.
        plane_fg_h = valid_half & (depth_half < (plane_z_h - self.floor_tol))
        # (b) depth edges at half-res. depth_filled_h is reused
        # later by the boundary carving block (CHANGE 4) so we
        # compute it here once.
        depth_filled_h = np.where(
            valid_half, depth_half, plane_z_h).astype(np.float32)
        gmag_h = np.hypot(
            ndimage.sobel(depth_filled_h, axis=0, mode='nearest'),
            ndimage.sobel(depth_filled_h, axis=1, mode='nearest'))
        edge_fg_h = valid_half & (gmag_h > self.edge_thresh)
        foreground_h = plane_fg_h | edge_fg_h

        # (c) RGB edges: catches flat dark objects with minimal depth
        # difference from the surface but visible colour boundaries.
        # Run at HALF resolution, every OTHER frame — the depth path
        # already catches most objects every frame, so dropping the
        # RGB pass to ~7.5 Hz has no visible effect on detection and
        # saves ~9 ms/frame.
        if not hasattr(self, '_rgb_frame_counter'):
            self._rgb_frame_counter = 0
            self._rgb_edge_fg_h = None
        self._rgb_frame_counter += 1
        rgb = self._color_rgb
        if (rgb is not None
                and rgb.shape[0] == h
                and rgb.shape[1] == w
                and self._rgb_frame_counter % 2 == 0):
            gray_full = (0.299 * rgb[:, :, 0]
                         + 0.587 * rgb[:, :, 1]
                         + 0.114 * rgb[:, :, 2]).astype(np.float32)
            gray_h = _zoom_hr(gray_full, 0.5, order=1)
            rgb_gmag_h = np.hypot(
                ndimage.sobel(gray_h, axis=0, mode='nearest'),
                ndimage.sobel(gray_h, axis=1, mode='nearest'))
            self._rgb_edge_fg_h = (
                (_zoom_hr(valid.astype(np.float32), 0.5, order=0) > 0.5)
                & (rgb_gmag_h > self.rgb_edge_thresh))
        if self._rgb_edge_fg_h is not None:
            try:
                foreground_h = foreground_h | self._rgb_edge_fg_h
            except ValueError:
                # Resolution changed between frames — drop the stale
                # cached mask and pick up the new shape next pass.
                self._rgb_edge_fg_h = None

        # Closing (dilate->erode) fills gaps in/between fragments; fill
        # enclosed edge contours; THEN opening (erode->dilate) removes
        # speckle. All at HALF res — 4× fewer pixels, ~4× faster. Kernel
        # sizes halved to maintain the same physical coverage; the 5×5
        # bbox-stabilising closing drops to 3×3 for the same reason.
        _dk_h = max(1, self.dilate_k // 2)
        _ek_h = max(1, self.erode_k  // 2)
        foreground_h = self._erode(
            self._dilate(foreground_h, _dk_h), _dk_h)
        foreground_h = ndimage.binary_fill_holes(foreground_h)
        foreground_h = self._dilate(
            self._erode(foreground_h, _ek_h), _ek_h)
        foreground_h = ndimage.binary_closing(
            foreground_h,
            structure=np.ones((3, 3), dtype=bool), iterations=1)

        # Carve depth-discontinuity boundaries OUT of the foreground so
        # neighbouring objects whose 2D masks touch get split. Uses
        # true per-pixel depth derivatives (np.gradient), not sobel-
        # scaled values — threshold is "metres per pixel". All at
        # half-res; valid_half + depth_filled_h were computed in
        # CHANGE 1 above.
        gy_h, gx_h = np.gradient(depth_filled_h)
        boundary_h = (np.hypot(gx_h, gy_h) > self.split_thresh) & valid_half
        boundary_h = ndimage.binary_dilation(boundary_h, iterations=1)
        foreground_h = foreground_h & ~boundary_h
        # Re-fill enclosed holes that the carving just opened. For a
        # ring the inner depth edge gets carved, leaving the centre
        # disconnected; fill_holes only fills regions FULLY surrounded
        # by foreground, so two distinct objects with a carved gap
        # that touches the image border stay split — only ring-style
        # enclosed holes are restored.
        foreground_h = ndimage.binary_fill_holes(foreground_h)

        # Upsample the half-res foreground mask back to full resolution
        # for bbox extraction and per-object cropping downstream.
        # order=0 (nearest-neighbour) preserves sharp blob boundaries —
        # any smoothing would round corners off the silhouette. Trim
        # to (h, w) in case zoom over-shoots by 1 px on odd image dims.
        foreground = _zoom_hr(
            foreground_h.astype(np.float32), 2.0, order=0) > 0.5
        foreground = foreground[:h, :w]

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
                    # Keypoint descriptors are stored as a 2-D N×D
                    # array; the matcher expects a list of 1-D rows.
                    # Missing → empty list (matcher returns 0 for kp
                    # signal, LBP carries on if available).
                    if 'kp_descs' in files:
                        raw_kp = np.asarray(z['kp_descs'], dtype=np.float32)
                        kp_list = ([raw_kp[i] for i in range(raw_kp.shape[0])]
                                   if raw_kp.ndim == 2 else [])
                    else:
                        kp_list = []
                    lbp_arr = (np.asarray(z['lbp_hist'], dtype=np.float32)
                               if 'lbp_hist' in files
                               else np.zeros(64, dtype=np.float32))
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
                        # Keypoint+LBP features for the orientation
                        # classifier. Old refs without these fall back
                        # to empty list / zero vector, which the
                        # matcher scores as a 0.5 (neutral) feat.
                        'kp_descs':   kp_list,
                        'lbp_hist':   lbp_arr,
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

        # Load pre-trained orientation classifiers for each part.
        # Rebuilt every time refs change (via _on_teach_command +
        # _backfill_classifiers); this just re-hydrates the runtime
        # dict from the on-disk JSON sidecars.
        self._orient_classifiers = {}
        for _pid, _refs in self._teach_refs.items():
            _clf_path = os.path.join(base, _pid,
                                     'orientation_classifier.json')
            if not os.path.isfile(_clf_path):
                continue
            try:
                with open(_clf_path) as _fp:
                    _clf = json.load(_fp)
                if _clf.get('trained'):
                    self._orient_classifiers[_pid] = {
                        'pick_c':   np.array(
                            _clf['pick_centroid'],
                            dtype=np.float32),
                        'nopick_c': np.array(
                            _clf['nopick_centroid'],
                            dtype=np.float32),
                        'n_pick':   int(_clf.get('n_pick', 0)),
                        'n_nopick': int(_clf.get('n_nopick', 0)),
                    }
            except Exception:
                pass

    def _backfill_classifiers(self):
        """Build orientation_classifier.json for any part that has
        refs on disk but no saved classifier yet. Runs once at node
        startup so existing teach data is immediately usable without
        requiring the operator to re-teach."""
        base = '/opt/cobot/parts/teach'
        if not os.path.isdir(base):
            return
        for pid, refs in self._teach_refs.items():
            clf_path = os.path.join(base, pid,
                                    'orientation_classifier.json')
            if os.path.isfile(clf_path):
                continue
            clf = self._build_orientation_classifier(refs)
            try:
                with open(clf_path, 'w') as fp:
                    json.dump(clf, fp)
                if clf.get('trained'):
                    self._orient_classifiers[pid] = {
                        'pick_c':   np.array(
                            clf['pick_centroid'],
                            dtype=np.float32),
                        'nopick_c': np.array(
                            clf['nopick_centroid'],
                            dtype=np.float32),
                        'n_pick':   int(clf.get('n_pick', 0)),
                        'n_nopick': int(clf.get('n_nopick', 0)),
                    }
                self.get_logger().info(
                    f'BACKFILL {pid[:8]}: '
                    f'trained={clf.get("trained")} '
                    f'pick={clf.get("n_pick",0)} '
                    f'nopick={clf.get("n_nopick",0)}')
            except Exception as e:
                self.get_logger().warn(
                    f'backfill failed {pid}: {e}')

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

            # ── Keypoint descriptors + LBP histogram ─────────────────
            # Computed at teach time so runtime _match_part doesn't
            # have to rebuild them per frame. lbp_hist is always
            # saved (even zeros) so loaders don't need to special-
            # case its absence; kp_descs is only saved when at least
            # one corner survived the variance gate.
            kp_descs_teach = []
            lbp_hist_teach = np.zeros(64, dtype=np.float32)
            if ref_color is not None and ref_mask.any():
                gray_for_features = (
                    np.mean(ref_color.astype(np.float32), axis=2)
                    if ref_color.ndim == 3
                    else ref_color.astype(np.float32)
                )
                kp_descs_teach, lbp_hist_teach = self._extract_features(
                    gray_for_features, ref_mask)

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
            # Feature descriptors for the matcher's keypoint+LBP signal.
            save_data['lbp_hist'] = lbp_hist_teach.astype(np.float32)
            if kp_descs_teach:
                save_data['kp_descs'] = np.vstack(kp_descs_teach).astype(np.float32)

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

            # Rebuild nearest-centroid orientation classifier from
            # all refs for this part. Stored as a small JSON
            # alongside the refs so the next startup picks it up
            # without needing to recompute, and so the matcher can
            # cross-process diff the centroids if desired.
            try:
                all_refs  = self._teach_refs.get(part_id, [])
                clf       = self._build_orientation_classifier(all_refs)
                clf_path  = os.path.join(teach_dir,
                                         'orientation_classifier.json')
                with open(clf_path, 'w') as _fp:
                    json.dump(clf, _fp)
                # Refresh the in-memory copy too so the very next
                # frame uses the updated centroids.
                if clf.get('trained'):
                    self._orient_classifiers[part_id] = {
                        'pick_c':   np.array(
                            clf['pick_centroid'],
                            dtype=np.float32),
                        'nopick_c': np.array(
                            clf['nopick_centroid'],
                            dtype=np.float32),
                        'n_pick':   int(clf.get('n_pick', 0)),
                        'n_nopick': int(clf.get('n_nopick', 0)),
                    }
                else:
                    self._orient_classifiers.pop(part_id, None)
                self.get_logger().info(
                    f'CLASSIFIER {part_id[:8]}: '
                    f'pick={clf.get("n_pick",0)} '
                    f'nopick={clf.get("n_nopick",0)} '
                    f'trained={clf.get("trained",False)}')
            except Exception as _ce:
                self.get_logger().warn(
                    f'classifier rebuild failed: {_ce}')
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
        # Skip matching entirely in teach mode — the wizard is showing
        # the part from various angles and recognition is suppressed
        # anyway. The temporal filter returns the SAME dict instances
        # held in self._history, so a stale part_name from before teach
        # mode would otherwise persist and render a stale pill on top
        # of the green teach box; clear the matching fields here.
        if self._teach_mode:
            for o in stable:
                o['part_name']         = None
                o['part_id']           = None
                o['match_score']       = 0.0
                o['match_yaw']         = 0.0
                o['position_correct']  = None
                o['yaw_error_deg']     = 0.0
                o['surface_ok']        = None
                o['position_status']   = ''
                o['orientation']       = None
                o['is_pickable']       = None
                o['is_defect']         = False
                o['orientation_label'] = ''
                o['defect_name']       = ''
                o['_holes']            = []
                o['_match_reason']     = ''
                o['_match_source']     = ''
        else:
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

    def _load_cad_face_features(self) -> dict:
        """Load per-face CAD feature anchors from each part's metadata.

        Returns {part_id: {orient_name: {holes:[...], bosses:[...],
        has_features:bool}}} for every part whose metadata json
        carries a `face_features` block (produced by step_parser's
        extract_face_features). Camera-only parts (no STEP) yield
        no entry — the matcher will fall back to the legacy blend.

        Read once at startup; cheap enough not to need throttling.
        Hole / boss positions are normalised to [0, 1] of the face
        bounding box so they map directly onto the live crop."""
        out = {}
        mdir = '/opt/cobot/parts/metadata'
        if not os.path.isdir(mdir):
            return out
        for fn in os.listdir(mdir):
            if not fn.endswith('.json'):
                continue
            part_id = fn[:-5]
            try:
                with open(os.path.join(mdir, fn)) as fp:
                    meta = json.load(fp)
                ff = meta.get('face_features')
                if ff and isinstance(ff, dict):
                    out[part_id] = ff
            except Exception:
                continue
        return out

    @staticmethod
    def _match_cad_features(cad_face: dict,
                            det_color: np.ndarray,
                            det_mask: np.ndarray) -> float:
        """Score how well a live detection matches the CAD feature
        anchors expected for a specific face orientation.

        Returns 0..1, with 0.5 as a neutral "no CAD features here"
        fallback so flat faces don't penalise the combined score.
        Algorithm:
          1. Find dark blobs inside the mask (candidate holes).
          2. Find bright blobs (candidate bosses).
          3. For each CAD hole, take the nearest dark blob's distance;
             score 1 - dist/tol, tol = max(2·radius_norm, 0.15).
          4. Bosses: same but tol = 0.20 (bosses don't carry radius
             in the CAD record).
          5. Mean of all per-feature scores."""
        try:
            holes  = cad_face.get('holes')  or []
            bosses = cad_face.get('bosses') or []
            if not holes and not bosses:
                return 0.5   # neutral — no CAD features to verify

            if det_color is None or det_mask is None:
                return 0.5

            H, W = det_color.shape[:2]
            gray = (np.mean(det_color.astype(np.float32), axis=2)
                    if det_color.ndim == 3
                    else det_color.astype(np.float32))
            m = np.asarray(det_mask, dtype=bool)
            if int(m.sum()) < 30:
                return 0.5

            vals = gray[m]
            med = float(np.median(vals))
            std = float(vals.std())
            if std < 2.0:
                std = 2.0

            dark   = m & (gray < med - 1.0 * std)
            bright = m & (gray > med + 1.0 * std)

            def _centers(bm, min_px=8):
                labeled, n = ndimage.label(bm)
                centres = []
                for i in range(1, n + 1):
                    ys, xs = np.where(labeled == i)
                    if len(ys) >= min_px:
                        centres.append((
                            float(xs.mean()) / max(W, 1),
                            float(ys.mean()) / max(H, 1)))
                return centres

            dark_c   = _centers(dark)
            bright_c = _centers(bright)
            scores   = []

            for h in holes:
                cx = float(h['center'][0])
                cy = float(h['center'][1])
                r  = float(h.get('radius_norm', 0.05))
                tol = max(r * 2.0, 0.15)
                if not dark_c:
                    scores.append(0.0)
                    continue
                dist = min(
                    ((cx - dx) ** 2 + (cy - dy) ** 2) ** 0.5
                    for dx, dy in dark_c)
                scores.append(max(0.0, 1.0 - dist / tol))

            for b in bosses:
                cx = float(b['center'][0])
                cy = float(b['center'][1])
                if not bright_c:
                    scores.append(0.0)
                    continue
                dist = min(
                    ((cx - bx) ** 2 + (cy - by) ** 2) ** 0.5
                    for bx, by in bright_c)
                scores.append(max(0.0, 1.0 - dist / 0.20))

            return float(np.mean(scores)) if scores else 0.5
        except Exception:
            return 0.5

    def _load_step_dims(self):
        """Return {part_id: sorted_top_2_extents_m} parsed from
        /opt/cobot/parts/index.json. The STEP-derived extents are the
        EXACT ground-truth dimensions and feed the strict size gate.

        Camera-only parts (POST /api/parts, no STEP upload) carry
        extents_cm=[0,0,0]; emitting sd=[0,0] for them would make the
        size gate compute r0 = 0 / det_dim = 0.0 and `continue` past
        the part — the matcher would never see the fob's teach refs.
        Skip those so the matcher treats them as "no STEP record" and
        falls through to the neutral size_score=0.5 branch."""
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
                if top2[0] <= 0.0:
                    # Camera-only part — no usable STEP dimensions.
                    continue
                out[p['id']] = top2
        except Exception:
            pass
        return out

    @staticmethod
    def _load_orient_weights(part_id, defaults):
        """Read per-part orientation-classifier weights from the
        part's metadata json (key: 'orient_weights'). Re-normalises
        to sum=1.0 so the operator can supply unnormalised numbers
        and the classifier still produces a probability-like score.
        Falls back to `defaults` when the file is missing, the key
        absent, or any value invalid."""
        weights = dict(defaults)
        path = f'/opt/cobot/parts/metadata/{part_id}.json'
        if not os.path.isfile(path):
            return weights
        try:
            with open(path) as fp:
                meta = json.load(fp)
            w = meta.get('orient_weights') or {}
            if not isinstance(w, dict):
                return weights
            for k in list(weights.keys()):
                v = w.get(k)
                if isinstance(v, (int, float)) and float(v) >= 0:
                    weights[k] = float(v)
            total = sum(weights.values())
            if total > 0:
                weights = {k: v / total for k, v in weights.items()}
        except Exception:
            pass
        return weights

    @staticmethod
    def _color_hist_corr(rgb1, rgb2, bins=32, mask1=None, mask2=None):
        """Pearson correlation between two RGB images' per-channel
        histograms, optionally restricted to masked pixels. numpy-only
        — depth_segment_node has a hard no-cv2/no-skimage policy.

        One of three orientation tie-breakers. Returns 0..1; negative
        correlations are clamped to 0 (in scoring context "very
        different" and "uncorrelated" both mean "no signal"). bins=32
        + per-image masks give the granularity needed to discriminate
        a key fob's two faces."""
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

            # Restrict to masked pixels when masks are supplied — keeps
            # background out so two crops of the same part on different
            # tables still match.
            def _flatten(img, mask):
                if (mask is not None
                        and np.asarray(mask).shape[:2] == img.shape[:2]
                        and np.asarray(mask).any()):
                    return img[np.asarray(mask).astype(bool)]
                return img.reshape(-1, img.shape[-1])

            r1_use = _flatten(r1, mask1)
            r2_use = _flatten(r2, mask2)
            if r1_use.size == 0 or r2_use.size == 0:
                return 0.0

            parts = []
            for c in range(min(3, r1_use.shape[-1], r2_use.shape[-1])):
                h1, _ = np.histogram(r1_use[..., c], bins=bins, range=(0, 256))
                h2, _ = np.histogram(r2_use[..., c], bins=bins, range=(0, 256))
                h1 = h1.astype(np.float32)
                h2 = h2.astype(np.float32)
                s1, s2 = h1.sum(), h2.sum()
                if s1 > 0: h1 /= s1
                if s2 > 0: h2 /= s2
                parts.append((h1, h2))
            a = np.concatenate([p[0] for p in parts])
            b = np.concatenate([p[1] for p in parts])
            sa, sb = float(a.std()), float(b.std())
            if sa < 1e-9 or sb < 1e-9:
                return 0.0
            corr = float(np.mean((a - a.mean()) * (b - b.mean())) / (sa * sb))
            return max(0.0, min(1.0, corr))
        except Exception:
            return 0.0

    @staticmethod
    def _spatial_color_score(det_color, det_mask, ref_color, ref_mask):
        """4x4 spatial colour-grid cosine similarity.

        Two crops with identical outlines (key-fob front vs back)
        often tie on overall colour histograms AND grayscale NCC.
        This score breaks the tie by comparing colour PER SPATIAL
        CELL: each crop becomes a 48-dim vector (4x4 grid x mean
        R/G/B over the cell's masked pixels), then cosine similarity.
        Empty cells fall back to the overall masked-region mean so a
        tiny mask gap doesn't punish the score with a hard zero."""
        def _grid_vec(rgb, mask):
            if rgb is None:
                return None
            arr = np.asarray(rgb, dtype=np.float32)
            if arr.ndim == 2:
                arr = np.stack([arr, arr, arr], axis=-1)
            H, W = arr.shape[:2]
            if H < 4 or W < 4:
                return None
            if (mask is not None
                    and np.asarray(mask).shape[:2] == (H, W)):
                m = np.asarray(mask).astype(bool)
            else:
                m = np.ones((H, W), dtype=bool)
            if m.any():
                overall = arr[m].mean(axis=0)
            else:
                overall = np.array([0.0, 0.0, 0.0], dtype=np.float32)
            vec = []
            for gy in range(4):
                y0 = int(round(gy * H / 4.0))
                y1 = int(round((gy + 1) * H / 4.0)) if gy < 3 else H
                for gx in range(4):
                    x0 = int(round(gx * W / 4.0))
                    x1 = int(round((gx + 1) * W / 4.0)) if gx < 3 else W
                    cm = m[y0:y1, x0:x1]
                    cc = arr[y0:y1, x0:x1]
                    v = cc[cm].mean(axis=0) if cm.any() else overall
                    vec.extend([float(v[0]), float(v[1]), float(v[2])])
            v = np.asarray(vec, dtype=np.float32)
            v = np.nan_to_num(v, nan=0.0, posinf=0.0, neginf=0.0)
            n = float(np.linalg.norm(v))
            return (v / n) if n > 1e-9 else v

        try:
            v1 = _grid_vec(det_color, det_mask)
            v2 = _grid_vec(ref_color, ref_mask)
            if v1 is None or v2 is None or v1.size == 0 or v2.size == 0:
                return 0.0
            return float(max(0.0, min(1.0, float(np.dot(v1, v2)))))
        except Exception:
            return 0.0

    @staticmethod
    def _extract_features(gray, mask, max_corners=25, patch_size=16):
        """Per-crop feature extraction for orientation matching.

        Returns (keypoint_descs, lbp_hist):
          keypoint_descs : list of 1-D float32 arrays, each
                           patch_size**2 long (256 by default).
                           Empty list when no corners survive the
                           Harris response gate or variance gate.
          lbp_hist       : float32 array length 64, L1-normalised.
                           All zeros when the mask has <20 pixels.

        Numpy + scipy.ndimage only (no cv2 / skimage). All work is
        restricted to the masked region so background table pixels
        don't generate spurious keypoints or texture energy."""
        H, W = gray.shape[:2]
        if H < patch_size or W < patch_size:
            return [], np.zeros(64, dtype=np.float32)

        gray_f = gray.astype(np.float32)
        m_bool = np.asarray(mask).astype(bool)
        if m_bool.shape[:2] != (H, W):
            m_bool = np.ones((H, W), dtype=bool)

        # ── Harris corner detection on masked grayscale ──────────
        m_float = m_bool.astype(np.float32)
        masked_gray = gray_f * m_float
        try:
            smoothed = ndimage.gaussian_filter(masked_gray, sigma=1.0)
            dx = ndimage.sobel(smoothed, axis=1, mode='nearest')
            dy = ndimage.sobel(smoothed, axis=0, mode='nearest')
            Ixx = ndimage.gaussian_filter(dx * dx, 2.0)
            Iyy = ndimage.gaussian_filter(dy * dy, 2.0)
            Ixy = ndimage.gaussian_filter(dx * dy, 2.0)
            R = Ixx * Iyy - Ixy * Ixy - 0.05 * (Ixx + Iyy) ** 2
            # Only accept corners that lie ON the part (mask=True).
            R = np.where(m_bool, R, 0.0)
            R_max = float(R.max()) if R.size else 0.0
            thresh = max(R_max * 0.01, 1e-6) if R_max > 0 else float('inf')
            # Non-maximum suppression: a pixel must equal the max in
            # a 9x9 window AND clear the response threshold.
            R_nms = ndimage.maximum_filter(R, size=9)
            peaks_y, peaks_x = np.where((R == R_nms) & (R > thresh))
            # Sort by response strength so the strongest survive the
            # max_corners cap.
            if peaks_y.size:
                resp = R[peaks_y, peaks_x]
                order = np.argsort(-resp)
                peaks_y = peaks_y[order]
                peaks_x = peaks_x[order]
        except Exception:
            peaks_y = np.array([], dtype=int)
            peaks_x = np.array([], dtype=int)

        # ── Patch descriptors around each surviving corner ───────
        descs = []
        half = patch_size // 2
        for idx in range(min(int(peaks_y.size), int(max_corners))):
            y, x = int(peaks_y[idx]), int(peaks_x[idx])
            # Pad-with-zeros patch so corners near the border still
            # produce a valid descriptor.
            y0 = y - half
            x0 = x - half
            y1 = y0 + patch_size
            x1 = x0 + patch_size
            patch = np.zeros((patch_size, patch_size), dtype=np.float32)
            sy0, sx0 = max(0, -y0), max(0, -x0)
            cy0, cx0 = max(0,  y0), max(0,  x0)
            cy1, cx1 = min(H,  y1), min(W,  x1)
            h_take = cy1 - cy0
            w_take = cx1 - cx0
            if h_take > 0 and w_take > 0:
                patch[sy0:sy0 + h_take, sx0:sx0 + w_take] = (
                    gray_f[cy0:cy1, cx0:cx1])
            std = float(patch.std())
            if std < 0.5:
                # Featureless patch — skip rather than feed noise into
                # the matcher.
                continue
            normed = (patch - float(patch.mean())) / std
            descs.append(normed.astype(np.float32).ravel())

        # ── 8-neighbour LBP histogram on masked pixels ────────────
        if int(m_bool.sum()) < 20:
            return descs, np.zeros(64, dtype=np.float32)
        try:
            # 8 unit-radius neighbours; sin/cos rounded to ±1/0 so
            # we just index-roll the image rather than interpolating.
            angles = [i * math.pi / 4.0 for i in range(8)]
            lbp_code = np.zeros((H, W), dtype=np.int32)
            for i, ang in enumerate(angles):
                dy_off = int(round(math.sin(ang)))
                dx_off = int(round(math.cos(ang)))
                # np.roll wraps the array which is fine — edge pixels
                # under the mask will rarely be near the seam.
                neighbour = np.roll(
                    np.roll(gray_f, -dy_off, axis=0),
                    -dx_off, axis=1)
                lbp_code |= ((neighbour >= gray_f).astype(np.int32)) << i
            codes_in_mask = lbp_code[m_bool]
            lbp_hist, _ = np.histogram(
                codes_in_mask, bins=64, range=(0, 256))
            lbp_hist = lbp_hist.astype(np.float32)
            s = lbp_hist.sum()
            if s > 0:
                lbp_hist /= s
        except Exception:
            lbp_hist = np.zeros(64, dtype=np.float32)

        return descs, lbp_hist

    @staticmethod
    def _match_features(det_descs, det_lbp, ref_descs, ref_lbp):
        """Combined keypoint + LBP feature-match score in [0, 1].

        Two signals:
          0.60  Keypoint match ratio — for each det descriptor, the
                Lowe ratio test passes when best L2 distance to any
                ref descriptor is < 0.75 * second-best. The ratio of
                passing det descriptors to total det descriptors is
                the score. Returns 0 when either side has no
                descriptors.

          0.40  LBP histogram correlation — Pearson on the 64-vectors,
                mapped from [-1, 1] to [0, 1]. Returns 0.5 (neutral)
                when either histogram is all zeros (no signal)."""
        try:
            # Keypoint matching.
            if (not det_descs or not ref_descs
                    or len(det_descs) == 0 or len(ref_descs) == 0):
                keypoint_score = 0.0
            else:
                A = np.asarray(det_descs, dtype=np.float32)
                B = np.asarray(ref_descs, dtype=np.float32)
                if A.ndim != 2 or B.ndim != 2 or A.shape[1] != B.shape[1]:
                    keypoint_score = 0.0
                else:
                    # Pairwise L2 distance via squared-sum expansion —
                    # avoids the (N, M, D) intermediate that would
                    # blow up memory for big descriptor counts.
                    aa = np.sum(A * A, axis=1, keepdims=True)        # (N, 1)
                    bb = np.sum(B * B, axis=1, keepdims=True).T      # (1, M)
                    D2 = aa + bb - 2.0 * (A @ B.T)
                    D = np.sqrt(np.maximum(D2, 0.0))
                    good = 0
                    for i in range(D.shape[0]):
                        row = D[i]
                        if row.size < 2:
                            # With only one ref descriptor the Lowe
                            # ratio is undefined; treat as no-match
                            # rather than guessing.
                            continue
                        idx2 = np.argpartition(row, 1)[:2]
                        d1, d2 = float(row[idx2[0]]), float(row[idx2[1]])
                        if d1 > d2:
                            d1, d2 = d2, d1
                        if d2 > 1e-6 and d1 < 0.75 * d2:
                            good += 1
                    keypoint_score = good / max(int(A.shape[0]), 1)
                    keypoint_score = max(0.0, min(1.0, keypoint_score))

            # LBP histogram correlation.
            a = np.asarray(det_lbp, dtype=np.float32)
            b = np.asarray(ref_lbp, dtype=np.float32)
            if a.size == 0 or b.size == 0 or a.size != b.size:
                lbp_score = 0.5
            elif float(a.sum()) <= 0 or float(b.sum()) <= 0:
                lbp_score = 0.5
            else:
                sa, sb = float(a.std()), float(b.std())
                if sa < 1e-9 or sb < 1e-9:
                    lbp_score = 0.5
                else:
                    corr = float(np.mean(
                        (a - a.mean()) * (b - b.mean())) / (sa * sb))
                    lbp_score = max(0.0, min(1.0, (corr + 1.0) / 2.0))

            return float(keypoint_score * 0.60 + lbp_score * 0.40)
        except Exception:
            return 0.0

    @staticmethod
    def _depth_geometry_score(det_depth, det_mask, ref_depth, ref_mask):
        """Surface-geometry similarity between detection and ref.

        Returns 0..1. Returns 0.5 (neutral) when depth data is
        missing or thinner than 20 valid masked pixels on either
        side — that way a depth-less ref doesn't actively push the
        scoring one way or the other.

        Three numpy-only sub-signals (no cv2, no skimage):

          0.40  DEPTH PROFILE HISTOGRAM
                rel = depth[mask] - median(depth[mask]) for both
                sides, binned into 16 bins over [-15mm, +15mm].
                Pearson correlation between the two histograms.
                Captures whether the surface is convex, concave,
                flat, or carries raised features — depth-offset
                invariant.

          0.40  SPATIAL DEPTH GRID
                3x3 grid over the masked region; each cell holds
                the mean relative depth (cells with <3 masked
                pixels collapse to 0). Pearson-correlate the two
                9-vectors. Captures WHERE the height features sit
                (raised boss top-left vs bottom-right, holes at
                specific positions).

          0.20  HOLE SIGNATURE
                hole_fraction = (pixels deeper than median+8mm
                inside the mask) / mask_pixels. Score =
                1 - |fd - fr| / max(fd + fr, 1e-3). If both are
                near-zero (no holes either side) the score lands
                at 1.0 (they agree).

        ref_depth is scaled to det_depth.shape with scipy zoom
        (order=1, mask order=0) before any comparison, so the
        physical alignment matches what the RGB scoring already
        does.
        """
        try:
            if det_depth is None or ref_depth is None:
                return 0.5
            det_d = np.asarray(det_depth, dtype=np.float32)
            ref_d = np.asarray(ref_depth, dtype=np.float32)
            if det_d.size == 0 or ref_d.size == 0:
                return 0.5
            det_m = (np.asarray(det_mask).astype(bool)
                     if det_mask is not None
                     else np.ones(det_d.shape, dtype=bool))
            ref_m = (np.asarray(ref_mask).astype(bool)
                     if ref_mask is not None
                     else np.ones(ref_d.shape, dtype=bool))

            # Mask shape sanity — fall back to all-true if mismatched.
            if det_m.shape != det_d.shape:
                det_m = np.ones(det_d.shape, dtype=bool)
            if ref_m.shape != ref_d.shape:
                ref_m = np.ones(ref_d.shape, dtype=bool)

            # Scale ref to det dimensions so cell-by-cell comparisons
            # are physically aligned.
            if ref_d.shape != det_d.shape:
                H, W = det_d.shape
                rh, rw = max(ref_d.shape[0], 1), max(ref_d.shape[1], 1)
                try:
                    ref_d = ndimage.zoom(ref_d, (H / rh, W / rw), order=1)
                    ref_m = (ndimage.zoom(ref_m.astype(np.float32),
                                          (H / rh, W / rw), order=0)
                             > 0.5)
                except Exception:
                    return 0.5
                # zoom can land 1 px short — clip to det's shape
                ref_d = ref_d[:H, :W]
                ref_m = ref_m[:H, :W]
                if ref_d.shape != det_d.shape:
                    return 0.5

            # Valid masked pixels — must have positive finite depth.
            det_valid = det_m & (det_d > 0) & np.isfinite(det_d)
            ref_valid = ref_m & (ref_d > 0) & np.isfinite(ref_d)
            if det_valid.sum() < 20 or ref_valid.sum() < 20:
                return 0.5

            det_vals = det_d[det_valid]
            ref_vals = ref_d[ref_valid]
            det_med = float(np.median(det_vals))
            ref_med = float(np.median(ref_vals))

            # ── (1) Depth profile histogram (weight 0.40) ────────────
            edges = np.linspace(-0.015, 0.015, 17)
            h_det, _ = np.histogram(det_vals - det_med, bins=edges)
            h_ref, _ = np.histogram(ref_vals - ref_med, bins=edges)
            h_det = h_det.astype(np.float32)
            h_ref = h_ref.astype(np.float32)
            sd, sr = h_det.sum(), h_ref.sum()
            if sd > 0: h_det /= sd
            if sr > 0: h_ref /= sr
            sa, sb = float(h_det.std()), float(h_ref.std())
            if sa < 1e-9 or sb < 1e-9:
                hist_score = 0.5
            else:
                corr = float(np.mean(
                    (h_det - h_det.mean()) * (h_ref - h_ref.mean())
                ) / (sa * sb))
                hist_score = max(0.0, min(1.0, corr))

            # ── (2) Spatial depth grid (weight 0.40) ─────────────────
            H, W = det_d.shape
            det_rel = np.zeros_like(det_d)
            ref_rel = np.zeros_like(ref_d)
            det_rel[det_valid] = det_d[det_valid] - det_med
            ref_rel[ref_valid] = ref_d[ref_valid] - ref_med

            def _grid_means(rel, valid):
                out = []
                for gy in range(3):
                    y0 = int(round(gy * H / 3.0))
                    y1 = int(round((gy + 1) * H / 3.0)) if gy < 2 else H
                    for gx in range(3):
                        x0 = int(round(gx * W / 3.0))
                        x1 = int(round((gx + 1) * W / 3.0)) if gx < 2 else W
                        cv = valid[y0:y1, x0:x1]
                        cr = rel[y0:y1, x0:x1]
                        if int(cv.sum()) >= 3:
                            out.append(float(cr[cv].mean()))
                        else:
                            out.append(0.0)
                return np.asarray(out, dtype=np.float32)

            gv_det = _grid_means(det_rel, det_valid)
            gv_ref = _grid_means(ref_rel, ref_valid)
            sa, sb = float(gv_det.std()), float(gv_ref.std())
            if sa < 1e-9 or sb < 1e-9:
                spatial_score = 0.5
            else:
                corr = float(np.mean(
                    (gv_det - gv_det.mean()) * (gv_ref - gv_ref.mean())
                ) / (sa * sb))
                spatial_score = max(0.0, min(1.0, corr))

            # ── (3) Hole signature (weight 0.20) ─────────────────────
            det_hole_count = float(
                np.sum(det_valid & (det_d > (det_med + 0.008))))
            ref_hole_count = float(
                np.sum(ref_valid & (ref_d > (ref_med + 0.008))))
            det_total = float(max(int(det_m.sum()), 1))
            ref_total = float(max(int(ref_m.sum()), 1))
            fd = det_hole_count / det_total
            fr = ref_hole_count / ref_total
            denom = max(fd + fr, 1e-3)
            hole_score = 1.0 - abs(fd - fr) / denom
            # Special case: both near-zero (no holes on either side) →
            # full credit. The expression above already lands close to
            # 1.0 there but the denom guard can drift slightly under
            # noise.
            if fd < 1e-4 and fr < 1e-4:
                hole_score = 1.0
            hole_score = max(0.0, min(1.0, hole_score))

            return float(hist_score * 0.40
                         + spatial_score * 0.40
                         + hole_score * 0.20)
        except Exception:
            return 0.5

    @staticmethod
    def _detect_part_features(gray, mask):
        """Detect structural features inside a masked part crop.

        Used by the teach-mode annotation overlay to show the operator
        which surface features (holes, bosses, step edges) the system
        can actually see — these become the discriminating signals the
        classifier learns from.

        Numpy + scipy.ndimage only (CLAUDE.md policy). Returns a list
        of feature dicts; coordinates are in CROP space (relative to
        the supplied gray/mask), so the caller adds the bbox origin
        to draw them in full-frame coordinates.

        Each feature dict:
          type         e.g. 'circular_hole', 'slot_hole', 'edge_step'
          bbox         (x0, y0, x1, y1) in crop space
          center       (cx, cy)
          circularity  4·pi·area / perimeter² (1.0 = circle)
          aspect_ratio long_side / short_side
          confidence   blob size / 50, clamped to [0, 1]
        """
        try:
            H, W = gray.shape[:2]
            gray_f = gray.astype(np.float32)
            m = np.asarray(mask, dtype=bool)
            if int(m.sum()) < 100:
                return []

            # Interior only — drop the part outline so segmentation
            # noise on the boundary doesn't spam fake features.
            interior = ndimage.binary_erosion(m, iterations=3)
            if not interior.any():
                return []

            # Surface stats inside mask (NOT interior — we want the full
            # foreground's median brightness so thresholds key off the
            # actual surface tone rather than the eroded subset).
            vals = gray_f[m]
            med = float(np.median(vals))
            std = float(vals.std())
            if std < 2.0:
                std = 2.0  # floor — featureless surfaces still pass

            # Holes / recesses → significantly DARKER than surface median.
            dark_mask   = interior & (gray_f < med - 1.2 * std)
            # Bosses / raised features → significantly BRIGHTER.
            bright_mask = interior & (gray_f > med + 1.2 * std)

            # Interior edge ridges → step edges, chamfers, slot rims.
            smoothed = ndimage.gaussian_filter(gray_f, sigma=1.5)
            dx = ndimage.sobel(smoothed, axis=1)
            dy = ndimage.sobel(smoothed, axis=0)
            edge_mag = np.sqrt(dx * dx + dy * dy)
            edge_mag[~interior] = 0.0
            if interior.any():
                e_mean = float(edge_mag[interior].mean())
                e_std  = float(edge_mag[interior].std())
                edge_thresh = e_mean + 1.5 * e_std
            else:
                edge_thresh = 9999.0
            strong_edges = interior & (edge_mag > edge_thresh)

            features = []

            def _blobs_to_features(blob_mask, base_type):
                labeled, n = ndimage.label(blob_mask)
                for i in range(1, n + 1):
                    region = (labeled == i)
                    pixel_count = int(region.sum())
                    if pixel_count < 15:
                        continue
                    ys, xs = np.where(region)
                    x0_b = int(xs.min()); x1_b = int(xs.max())
                    y0_b = int(ys.min()); y1_b = int(ys.max())
                    w_b = x1_b - x0_b + 1
                    h_b = y1_b - y0_b + 1
                    cx = float(xs.mean())
                    cy = float(ys.mean())
                    # Circularity: 4·pi·area / (bounding-rect perimeter)².
                    # Using the bbox perimeter (not the actual contour
                    # perimeter) is an approximation but it lands close
                    # enough for shape-class tagging.
                    perim = 2.0 * (w_b + h_b)
                    circ = min(1.0, float(4.0 * np.pi * pixel_count
                                          / (perim * perim + 1e-9)))
                    aspect = (float(max(w_b, h_b))
                              / (min(w_b, h_b) + 1e-9))
                    if circ > 0.60:
                        shape = 'circular'
                    elif aspect > 2.5:
                        shape = 'slot'
                    else:
                        shape = 'rectangular'
                    features.append({
                        'type':         f'{shape}_{base_type}',
                        'bbox':         (x0_b, y0_b, x1_b, y1_b),
                        'center':       (cx, cy),
                        'circularity':  round(circ, 2),
                        'aspect_ratio': round(aspect, 2),
                        'confidence':   round(min(1.0, pixel_count / 50.0), 2),
                    })

            _blobs_to_features(dark_mask,   'hole')
            _blobs_to_features(bright_mask, 'boss')

            # Edge step regions — keep only elongated line-like blobs
            # (aspect > 2.5) so blob-shaped edge clusters don't double-
            # count things already caught by hole/boss detection.
            labeled_e, n_e = ndimage.label(strong_edges)
            for i in range(1, n_e + 1):
                region = (labeled_e == i)
                pixel_count = int(region.sum())
                if pixel_count < 20:
                    continue
                ys, xs = np.where(region)
                x0_b = int(xs.min()); x1_b = int(xs.max())
                y0_b = int(ys.min()); y1_b = int(ys.max())
                w_b = x1_b - x0_b + 1
                h_b = y1_b - y0_b + 1
                aspect = (float(max(w_b, h_b))
                          / (min(w_b, h_b) + 1e-9))
                if aspect < 2.5:
                    continue
                features.append({
                    'type':         'edge_step',
                    'bbox':         (x0_b, y0_b, x1_b, y1_b),
                    'center':       (float(xs.mean()), float(ys.mean())),
                    'circularity':  0.0,
                    'aspect_ratio': round(aspect, 2),
                    'confidence':   round(min(1.0, pixel_count / 30.0), 2),
                })

            return features
        except Exception:
            return []

    @staticmethod
    def _extract_orientation_fv(color, mask, depth=None):
        """Extract a 33-value feature vector for orientation
        classification using ALL available sensor data.

        Layout (concatenated):
          [0:9]   Interior edge density per 3x3 spatial grid
                  (L2-normalised). Captures WHERE the structural
                  features sit — holes, slots, chamfers, machined
                  edges. Interior only (3 px erosion drops outline).
          [9:18]  Per-cell relative brightness per 3x3 grid,
                  normalised by max abs value. Captures bright/dark
                  layout across the surface.
          [18:33] Colour blob signature: 5 colour classes × 3 values
                  (normalised blob count, centroid X, centroid Y of
                  the largest blob per class). Classes are red-,
                  green-, blue-dominant plus dark and bright. Pure
                  numpy channel comparison — no cv2, no HSV.

        Returns a zero vector (length 33) if the mask has fewer
        than 30 pixels or colour is None — keeps callers safe
        without a None branch.
        """
        try:
            if color is None or mask is None:
                return np.zeros(33, dtype=np.float32)
            m = np.asarray(mask, dtype=bool)
            if int(m.sum()) < 30:
                return np.zeros(33, dtype=np.float32)

            H, W = color.shape[:2]
            gray_f = (np.mean(color.astype(np.float32), axis=2)
                      if color.ndim == 3
                      else color.astype(np.float32))

            # Interior — exclude outline so segmentation noise on
            # the boundary doesn't contaminate the edge density.
            interior = ndimage.binary_erosion(m, iterations=3)
            if not interior.any():
                interior = m

            smoothed = ndimage.gaussian_filter(gray_f, sigma=1.0)
            dx = ndimage.sobel(smoothed, axis=1)
            dy = ndimage.sobel(smoothed, axis=0)
            edge_mag = np.sqrt(dx * dx + dy * dy)
            edge_mag_int = edge_mag.copy()
            edge_mag_int[~interior] = 0.0

            overall_mean = float(gray_f[m].mean())
            std_ = float(gray_f[m].std())
            if std_ < 1.0:
                std_ = 1.0

            ef = []   # [0:9]   edge density per 3x3 cell
            qb = []   # [9:18]  brightness per 3x3 cell

            for gy in range(3):
                y0 = int(round(gy * H / 3))
                y1 = int(round((gy + 1) * H / 3)) if gy < 2 else H
                for gx in range(3):
                    x0 = int(round(gx * W / 3))
                    x1 = int(round((gx + 1) * W / 3)) if gx < 2 else W
                    cm_int = interior[y0:y1, x0:x1]
                    ce     = edge_mag_int[y0:y1, x0:x1]
                    cm_all = m[y0:y1, x0:x1]
                    cg     = gray_f[y0:y1, x0:x1]
                    ef.append(float(ce[cm_int].mean())
                              if int(cm_int.sum()) >= 5 else 0.0)
                    qb.append(
                        (float(cg[cm_all].mean()) - overall_mean) / std_
                        if int(cm_all.sum()) >= 5 else 0.0)

            ef_v = np.array(ef, dtype=np.float32)
            ef_n = float(np.linalg.norm(ef_v))
            if ef_n > 1e-9:
                ef_v /= ef_n

            qb_v = np.array(qb, dtype=np.float32)
            qb_s = float(np.abs(qb_v).max())
            if qb_s > 1e-9:
                qb_v /= qb_s

            # Colour blob signature [18:33] — pure numpy channel
            # comparisons. R/G/B-dominant rules pick out coloured
            # labels and markings; dark/bright catch printed text
            # and reflective hardware regardless of hue.
            R = (color[:, :, 0].astype(np.float32)
                 if color.ndim == 3 else gray_f)
            G = (color[:, :, 1].astype(np.float32)
                 if color.ndim == 3 else gray_f)
            B = (color[:, :, 2].astype(np.float32)
                 if color.ndim == 3 else gray_f)
            brightness = (R + G + B) / 3.0
            med_b = float(np.median(brightness[m])) if m.any() else 128.0

            color_masks = [
                m & (R > G + 25) & (R > B + 25) & (R > 80),   # red
                m & (G > R + 25) & (G > B + 25) & (G > 80),   # green
                m & (B > R + 25) & (B > G + 20) & (B > 80),   # blue
                m & (brightness < med_b - 35),                # dark
                m & (brightness > med_b + 35),                # bright
            ]

            cb = []
            for bm in color_masks:
                labeled, n = ndimage.label(bm)
                if n == 0:
                    cb.extend([0.0, 0.5, 0.5])
                    continue
                sizes = [int((labeled == i).sum())
                         for i in range(1, n + 1)]
                biggest = int(np.argmax(sizes)) + 1
                ys, xs = np.where(labeled == biggest)
                if len(ys) < 5:
                    cb.extend([0.0, 0.5, 0.5])
                    continue
                cb.extend([
                    float(min(n, 5)) / 5.0,
                    float(xs.mean()) / max(W, 1),
                    float(ys.mean()) / max(H, 1),
                ])

            return np.concatenate([
                ef_v,
                qb_v,
                np.array(cb, dtype=np.float32),
            ]).astype(np.float32)
        except Exception:
            return np.zeros(33, dtype=np.float32)

    @staticmethod
    def _build_orientation_classifier(refs):
        """Train a nearest-centroid classifier from teach refs.

        Computes _extract_orientation_fv() for every ref with both
        colour + mask stored. Groups by class (defect refs collapse
        into non-pickable), computes the mean FV per class, and
        returns a JSON-safe dict the matcher can persist on disk.

        Returns
          {pick_centroid, nopick_centroid, n_pick, n_nopick,
           trained: True}
        or
          {trained: False}
        when either class has zero usable refs."""
        pick_fvs   = []
        nopick_fvs = []
        for ref in refs:
            color = ref.get('color')
            mask  = ref.get('mask')
            depth = ref.get('depth')
            if color is None or mask is None:
                continue
            is_defect   = bool(ref.get('is_defect', False))
            is_pickable = (bool(ref.get('is_pickable', True))
                           and not is_defect)
            fv = DepthSegmentNode._extract_orientation_fv(
                color, mask, depth)
            if is_pickable:
                pick_fvs.append(fv)
            else:
                nopick_fvs.append(fv)

        if not pick_fvs or not nopick_fvs:
            return {'trained': False}

        pick_c   = np.mean(
            np.vstack(pick_fvs),   axis=0).astype(np.float32)
        nopick_c = np.mean(
            np.vstack(nopick_fvs), axis=0).astype(np.float32)
        return {
            'pick_centroid':   pick_c.tolist(),
            'nopick_centroid': nopick_c.tolist(),
            'n_pick':          len(pick_fvs),
            'n_nopick':        len(nopick_fvs),
            'trained':         True,
        }

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
            info = ({'is_pickable': (o == 'pickable'), 'source': 'template'}
                    if o else {})
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

        # Default orientation weights. The operator can override these
        # per-part via /api/parts/<id>/orient_weights — useful when a
        # part is uniformly silver (lean on depth+features) vs visually
        # rich (lean on colour). 'feat' = Harris keypoint patches +
        # LBP histogram, the strongest discriminator for metal parts
        # where colour signals collapse. See _load_orient_weights.
        default_weights = {
            'ncc':     0.20,
            'hist':    0.10,
            'spatial': 0.10,
            'depth':   0.25,
            'feat':    0.35,
        }

        # Extract features from the live detection ONCE up here so
        # the per-ref loop only does the cheap match step.
        det_kp_descs = []
        det_lbp_hist = np.zeros(64, dtype=np.float32)
        if color_crop is not None and mask_crop is not None and mask_crop.any():
            det_gray_full = (
                np.mean(color_crop.astype(np.float32), axis=2)
                if color_crop.ndim == 3
                else color_crop.astype(np.float32)
            )
            det_kp_descs, det_lbp_hist = self._extract_features(
                det_gray_full, mask_crop)

        best_score = 0.0
        best_id    = None
        best_name  = 'unknown'

        # Classifier state — initialised once so the post-loop return
        # block can safely reference these even when the loop is empty
        # or no part_id passed the size gate.
        clf            = None
        clf_score      = 0.5     # neutral fallback
        clf_is_pick    = None
        clf_confidence = 0.0

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

            # ── Nearest-centroid orientation classifier ────────────────
            # If a trained classifier exists for this part, classify
            # the live detection against the two class centroids. This
            # supplements per-ref group scoring with a single decision
            # that's seen ALL training data at once and uses ALL signals
            # (colour + interior edge layout + brightness layout).
            clf = self._orient_classifiers.get(part_id)
            clf_score = 0.5
            clf_is_pick = None
            clf_confidence = 0.0
            if (clf is not None
                    and color_crop is not None
                    and mask_crop is not None
                    and mask_crop.any()):
                _fv = self._extract_orientation_fv(
                    color_crop, mask_crop, depth_crop)
                _d_pick   = float(np.linalg.norm(_fv - clf['pick_c']))
                _d_nopick = float(np.linalg.norm(_fv - clf['nopick_c']))
                _total_d  = _d_pick + _d_nopick + 1e-9
                clf_is_pick    = (_d_pick < _d_nopick)
                clf_confidence = float(abs(_d_nopick - _d_pick) / _total_d)
                clf_score      = clf_confidence

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

            # Per-part weight override. Falls back to defaults when the
            # metadata json has no orient_weights field.
            weights = self._load_orient_weights(part_id, default_weights)

            best_group_score = 0.0
            best_group_key   = None
            # (avg_ncc, avg_hist, avg_spatial, avg_depth, avg_feat, n_refs, best_ref)
            best_group_meta  = None
            group_dbg = []             # for the throttled log

            for gkey, grp_refs in groups.items():
                nccs     = []
                hists    = []
                spatials = []
                depths   = []
                features = []
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

                    # Colour-histogram tie-breaker (masked-pixel only).
                    ref_color = ref.get('color')
                    ref_mask  = ref.get('mask')
                    if ref_color is not None and color_crop is not None:
                        hists.append(self._color_hist_corr(
                            color_crop, ref_color,
                            mask1=mask_crop, mask2=ref_mask))
                        # 4x4 spatial colour grid — separates two faces
                        # of a key fob that score identically on outline
                        # + overall histogram.
                        spatials.append(self._spatial_color_score(
                            color_crop, mask_crop, ref_color, ref_mask))

                    # ── Signal 4: depth geometry ─────────────────────
                    # The discriminating signal for uniformly-coloured
                    # metal parts. Pre-scale ref to the per-ref
                    # physical resolution; _depth_geometry_score
                    # re-scales to match det_depth.shape internally
                    # if the shapes still differ.
                    ref_depth_arr = ref.get('depth')
                    if depth_crop is not None and ref_depth_arr is not None:
                        try:
                            zh = target_h / max(ref_depth_arr.shape[0], 1)
                            zw = target_w / max(ref_depth_arr.shape[1], 1)
                            ref_depth_sc = _zoom(
                                ref_depth_arr.astype(np.float32),
                                (zh, zw), order=1)
                            ref_mask_sc = (_zoom(
                                (ref_mask if ref_mask is not None
                                 else np.zeros(ref_depth_arr.shape,
                                               dtype=bool))
                                .astype(np.float32),
                                (zh, zw), order=0) > 0.5)
                        except Exception:
                            ref_depth_sc = None
                            ref_mask_sc  = None
                        if ref_depth_sc is not None:
                            depths.append(self._depth_geometry_score(
                                depth_crop, mask_crop,
                                ref_depth_sc, ref_mask_sc))

                    # ── Signal 5: Harris keypoints + LBP histogram ───
                    # The strongest discriminator on metal parts whose
                    # two faces share colour but differ in surface
                    # micro-features (stamped text, holes, chamfers).
                    ref_kp  = ref.get('kp_descs') or []
                    ref_lbp = ref.get('lbp_hist')
                    if ref_lbp is None:
                        ref_lbp = np.zeros(64, dtype=np.float32)
                    features.append(self._match_features(
                        det_kp_descs, det_lbp_hist, ref_kp, ref_lbp))

                if not nccs:
                    continue
                avg_ncc     = float(np.mean(nccs))
                avg_hist    = float(np.mean(hists))    if hists    else 0.5
                avg_spatial = float(np.mean(spatials)) if spatials else 0.5
                avg_depth   = float(np.mean(depths))   if depths   else 0.5
                avg_feat    = float(np.mean(features)) if features else 0.5
                # Five-signal score. Weights per-part overridable.
                # Defaults: features (0.35) lead, depth (0.25) second,
                # NCC (0.20), hist (0.10), spatial colour (0.10).
                group_score = (avg_ncc     * weights['ncc']
                               + avg_hist    * weights['hist']
                               + avg_spatial * weights['spatial']
                               + avg_depth   * weights['depth']
                               + avg_feat    * weights['feat'])

                group_dbg.append(
                    (gkey, avg_ncc, avg_hist, avg_spatial, avg_depth,
                     avg_feat, group_score, len(nccs)))

                if group_score > best_group_score:
                    best_group_score = group_score
                    best_group_key   = gkey
                    best_group_meta  = (avg_ncc, avg_hist, avg_spatial,
                                        avg_depth, avg_feat,
                                        len(nccs), best_in_group_ref)

            if best_group_meta is None:
                continue

            (best_ref_ncc, best_ref_hist, best_ref_spatial,
             best_ref_depth, best_ref_feat,
             n_refs, best_ref_for_part) = best_group_meta
            # ── CAD feature anchor verification ───────────────────────
            # The winning group says is_pickable=True/False. Map that
            # plus the operator's orientation_label to a CAD face name
            # (top / bottom / left / right / front / back) and verify
            # the live detection actually shows the holes + bosses the
            # CAD model says belong on that face. This converts a soft
            # texture similarity into a hard geometric check.
            #
            #   is_pickable=True  → 'top' (default)
            #   is_pickable=False → 'bottom' (flipped)
            #   on_side variants  → matched off the orientation_label
            #                       when it contains 'right'/'left'/
            #                       'front'/'back'
            cad_score = 0.5   # neutral default — no penalty when CAD
                              # has nothing to verify on this face
            part_face_features = self._cad_face_features.get(part_id)
            if part_face_features and best_group_key is not None:
                is_pick_winner = bool(best_group_key[0])
                orient_lbl_winner = str(best_group_key[3] or '').lower()
                face_name = None
                for candidate in ['top', 'bottom', 'right', 'left',
                                  'front', 'back']:
                    if candidate in orient_lbl_winner:
                        face_name = candidate
                        break
                if face_name is None:
                    face_name = 'top' if is_pick_winner else 'bottom'
                cad_face = part_face_features.get(face_name, {})
                if cad_face.get('has_features', False):
                    cad_score = self._match_cad_features(
                        cad_face, color_crop, mask_crop)
                # If CAD has no features for this face (flat surface),
                # cad_score stays 0.5 — neutral, no penalty.

            # Blend: size (30%) + group scoring (35%) + CAD features (35%).
            # When the part has no STEP file (no face_features), fall
            # back to the legacy 40/60 blend so camera-only parts
            # aren't degraded. CAD-equipped flat-faced parts land at
            # cad_score=0.5 which contributes 0.5·0.35 ≈ 0.18 — no
            # regression vs the legacy blend's implicit "neutral".
            if part_face_features:
                combined = (size_score        * 0.30
                            + best_group_score * 0.35
                            + cad_score        * 0.35)
            else:
                combined = size_score * 0.40 + best_group_score * 0.60

            # Per-group debug log so the operator can see WHY one
            # orientation won over another. Sorted by score desc.
            # Tuple layout: (gkey, ncc, hist, spat, depth, feat,
            #                score, n_refs).
            try:
                group_dbg.sort(key=lambda x: -x[6])
                gap = ((group_dbg[0][6] - group_dbg[1][6])
                       if len(group_dbg) >= 2 else float('nan'))
                summary = ' | '.join(
                    "{}'{}' ncc={:.2f} hist={:.2f} sp={:.2f} dep={:.2f} feat={:.2f} score={:.2f} ({}r)".format(
                        'pick' if k[0] else 'NOpick', k[3] or '?',
                        a, h, sp, dp, ft, sc, n
                    )
                    for (k, a, h, sp, dp, ft, sc, n) in group_dbg
                )
                # Classifier verdict appended so the operator can see
                # whether it agreed with the group-scoring winner.
                # "NA" when there's no trained classifier for this part.
                if clf_is_pick is None:
                    _clf_str = 'NA'
                elif clf_is_pick:
                    _clf_str = 'PICK'
                else:
                    _clf_str = 'NOPICK'
                self.get_logger().info(
                    f'ORIENT_MATCH {part_id[:8]} det=[{det_s[0]*100:.1f}x{det_s[1]*100:.1f}cm] '
                    f'size={size_score:.2f} → '
                    f'winner={"PICK" if best_group_key[0] else "NOpick"}/'
                    f'"{best_group_key[3] or "?"}" '
                    f'gap={gap:.2f} | {summary} '
                    f'clf_conf={clf_confidence:.2f} clf={_clf_str} '
                    f'cad={cad_score:.2f}',
                    throttle_duration_sec=3.0)
            except Exception:
                pass

            # Surface the winner's stats for /api/parts/<id>/orientation_debug.
            # In-memory dict for same-process consumers; sidecar JSON
            # (throttled to ~2 Hz per part to keep eMMC writes low) for
            # the dashboard's separate process.
            try:
                import time as _time
                payload = {
                    'winner_label':        str(best_group_key[3] or ''),
                    'winner_is_pickable':  bool(best_group_key[0]),
                    'winner_is_defect':    bool(best_group_key[1]),
                    'ncc':                 round(float(best_ref_ncc), 3),
                    'hist':                round(float(best_ref_hist), 3),
                    'spatial':             round(float(best_ref_spatial), 3),
                    'depth':               round(float(best_ref_depth), 3),
                    'feat':                round(float(best_ref_feat), 3),
                    'weights':             {k: round(float(v), 3)
                                            for k, v in weights.items()},
                    'group_score':         round(float(best_group_score), 3),
                    'size_score':          round(float(size_score), 3),
                    'combined':            round(float(combined), 3),
                    'gap':                 (None
                                            if not (len(group_dbg) >= 2)
                                            else round(float(group_dbg[0][6] - group_dbg[1][6]), 3)),
                    'n_refs_in_group':     int(n_refs),
                    'ts':                  _time.time(),
                }
                _last_orient_match[str(part_id)] = payload
                # Throttle disk writes — fires at the segment node's
                # ~15 Hz processing rate otherwise.
                last_disk_ts = (_last_orient_match
                                .get('__disk_ts__', {})
                                .get(str(part_id), 0.0))
                if (_time.time() - last_disk_ts) >= 0.5:
                    _write_last_match(part_id, payload)
                    _last_orient_match.setdefault('__disk_ts__', {})[str(part_id)] = _time.time()
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
            info = {'source': 'teach'}
            if best_ref_meta is not None:
                info.update({
                    'is_pickable':       bool(best_ref_meta.get('is_pickable', True)),
                    'is_defect':         bool(best_ref_meta.get('is_defect', False)),
                    'orientation_label': str(best_ref_meta.get('orientation_label') or ''),
                    'defect_name':       str(best_ref_meta.get('defect_name') or ''),
                })
            # If the classifier ran with high confidence on the
            # winning iteration, trust it over the group-scoring
            # ref's metadata — the classifier saw all training
            # examples while the group winner is just one ref.
            # Note: clf, clf_confidence, clf_is_pick, part_id all
            # carry their LAST loop iteration values here, so the
            # best_id == part_id guard only fires when the winner
            # happened to be processed last in the loop.
            if (clf is not None
                    and clf_confidence >= 0.30
                    and best_id == part_id):
                info['is_pickable']    = bool(clf_is_pick)
                info['clf_confidence'] = round(clf_confidence, 3)
            # BUG 1 fix: previously this returned orient='' for every
            # teach match, so _match_parts left position_correct /
            # surface_ok / position_status unset and the executor +
            # task planner couldn't tell pickable from non-pickable.
            # Derive the legacy orient string from the winning ref's
            # is_pickable so those downstream fields populate.
            derived_orient = ('pickable'
                              if info.get('is_pickable', True)
                              else 'flipped')
            return best_name, best_id, round(best_score, 3), derived_orient, info

        n, pid, s, _y, o = self._match_by_templates(
            mask_crop, obb_size, color_crop)
        if n and s >= 0.55:
            info = ({'is_pickable': (o == 'pickable'), 'source': 'template'}
                    if o else {'source': 'template'})
            return n, pid, s, (o or ''), info
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
            # (Defence-in-depth — _emit also guards the call site so
            # this branch normally won't fire.)
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

        # Frame-skip the expensive NCC/feat/CAD scoring when there are
        # many parts in the library. Detection still runs every frame;
        # an already-matched object reuses its previous-frame verdict
        # on the skipped frame (via the EMA tracker's dict-identity
        # carry-forward — the temporal filter returns the same object
        # instances from self._history). New objects (no part_name yet)
        # always run matching regardless of the skip.
        if not hasattr(self, '_match_frame_counter'):
            self._match_frame_counter = 0
        self._match_frame_counter += 1
        _do_orient = (len(self._teach_refs) <= 2
                      or self._match_frame_counter % 2 == 0)

        for o in objects:
            mask  = o.get('mask_2d')
            depth = o.get('depth_2d')
            sx, sy, sz = o.get('size_3d') or (0.05, 0.05, 0.05)
            size_m = [float(sx), float(sy), float(sz)]
            color_crop = o.get('color_crop')

            _is_new_object = not bool(o.get('part_name'))
            if _do_orient or _is_new_object:
                name, pid, score, orient, match_info = self._match_part(
                    mask, size_m, color_crop=color_crop, depth_crop=depth)
            else:
                # Reuse the cached match from the previous frame —
                # the object dict carries forward through the temporal
                # filter / EMA tracker, so its part_* fields are
                # already populated.
                name        = o.get('part_name') or 'unknown'
                pid         = o.get('part_id')
                score       = float(o.get('match_score') or 0.0)
                orient      = o.get('orientation') or ''
                match_info  = {
                    'is_pickable':       o.get('is_pickable'),
                    'is_defect':         bool(o.get('is_defect')),
                    'orientation_label': str(o.get('orientation_label') or ''),
                    'defect_name':       str(o.get('defect_name') or ''),
                    'source':            'cached',
                }
            matched = (name and name != 'unknown')

            o['_holes']        = []
            o['_match_reason'] = ''
            # Source comes from match_info now; orient alone can no
            # longer distinguish teach from template since BUG 1's fix
            # makes teach matches return a derived 'pickable'/'flipped'
            # string rather than ''.
            o['_match_source'] = (str(match_info.get('source') or '')
                                  if matched else '')
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

    @staticmethod
    def _draw_dashed_rect(draw, box, color, width, dash=8):
        """Draw a rectangle with a dashed border using PIL line calls.

        `box` accepts either a 4-tuple (x0, y0, x1, y1) for an
        axis-aligned box or a 4x2 array-like of corners for the
        rotated-rectangle output of _min_area_rect_2d.

        Dashes alternate `dash` px line / `dash` px gap along each
        edge; the last segment may be truncated when the edge length
        doesn't divide evenly. Used by _publish_annotated to make
        non-pickable bounding boxes visually distinct from solid-
        bordered pickable ones at a glance on a tablet."""
        # Resolve to 4 corner points
        try:
            if (hasattr(box, 'shape') and len(box.shape) == 2
                    and box.shape[0] == 4 and box.shape[1] == 2):
                corners = [(float(box[i][0]), float(box[i][1]))
                           for i in range(4)]
            else:
                x0, y0, x1, y1 = box
                corners = [(float(x0), float(y0)), (float(x1), float(y0)),
                           (float(x1), float(y1)), (float(x0), float(y1))]
        except Exception:
            return

        for i in range(4):
            p1 = corners[i]
            p2 = corners[(i + 1) % 4]
            dx, dy = p2[0] - p1[0], p2[1] - p1[1]
            length = (dx * dx + dy * dy) ** 0.5
            if length < 1.0:
                continue
            ux, uy = dx / length, dy / length
            pos = 0.0
            on  = True
            while pos < length:
                end = min(pos + dash, length)
                if on:
                    draw.line(
                        [(p1[0] + ux * pos, p1[1] + uy * pos),
                         (p1[0] + ux * end, p1[1] + uy * end)],
                        fill=color, width=width)
                pos = end
                on = not on

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
            # Five-state colour code. Teach mode wins outright — when
            # the operator is showing the part for capture we want a
            # bright, unambiguous green on every detected blob,
            # regardless of any stale matcher state that might leak in.
            #   teach_green  — teach mode active (top priority)
            #   green        — matched + pickable (operator approved)
            #   red          — matched + non-pickable OR defect (do NOT grasp)
            #   amber        — matched but orientation unknown
            #   grey         — no match (unknown object), runtime mode
            teach_green = (34, 197, 94)
            green = (22, 163, 74)
            red   = (220, 38, 38)
            amber = (202, 138, 4)
            grey  = (156, 163, 175)
            if self._teach_mode:
                col = teach_green
            elif matched and is_defect:
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

            # Thickness signals matched/unknown at a glance:
            #   teach mode          → 2 px solid (visible, not dominant —
            #                         feature boxes overlay inside)
            #   pickable matched    → 4 px solid
            #   non-pickable matched → 4 px dashed
            #   other matched (amber, defect) → 4 px solid
            #   unknown             → 1 px solid
            box_thick = 3 if self._teach_mode else (4 if matched else 1)
            dashed = bool(matched and is_pickable is False and not is_defect)
            if rect_corners is not None:
                if dashed:
                    self._draw_dashed_rect(draw, rect_corners, col, box_thick)
                else:
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
                if dashed:
                    self._draw_dashed_rect(
                        draw,
                        (x0 + 1, y0 + 1, x1 - 1, y1 - 1),
                        col, box_thick)
                else:
                    draw.rectangle(
                        [x0 + 1, y0 + 1, x1 - 1, y1 - 1],
                        outline=col, width=box_thick)
                top_y = y0
                left_x = x0
                cx_box = (x0 + x1) * 0.5
                cy_box = (y0 + y1) * 0.5
                bx0, by0, bx1, by1 = int(x0), int(y0), int(x1), int(y1)

            # Status pill INSIDE the top-left of the bbox (so it
            # doesn't get clipped at the image edge the way a badge
            # above the box would). The pill is the primary "is this
            # safe to grasp?" cue — colour + symbol + plain-English
            # word so an operator glancing at a tablet doesn't have to
            # rely on colour alone.
            #
            #   ✓ PICK OK      green    pickable, no defect
            #   ✗ NO PICK      red      non-pickable orientation
            #   ⚠ DEFECT       red      defect ref winner
            #   (none)         —        unknown / amber
            pill_text = None
            pill_bg   = None
            if matched and is_defect:
                pill_text = '⚠ ' + (defect_lbl.upper() if defect_lbl else 'DEFECT')
                pill_bg   = red
            elif matched and is_pickable is True:
                pill_text = '✓ ' + (orient_lbl.upper() if orient_lbl else 'PICK OK')
                pill_bg   = green
            elif matched and is_pickable is False:
                pill_text = '✗ ' + (orient_lbl.upper() if orient_lbl else 'NO PICK')
                pill_bg   = red

            if pill_text is not None:
                pill_font = _ANNOT_FONT
                ptxt_bbox = draw.textbbox((0, 0), pill_text, font=pill_font)
                pad_x = 8
                pw = (ptxt_bbox[2] - ptxt_bbox[0]) + pad_x * 2
                ph = 20
                px_pos = int(bx0) + 2
                py_pos = int(by0) + 2
                # Defensive: skip the pill if the box is too small for it
                # to fit cleanly (no point drawing a label that covers
                # the whole detection).
                box_w = max(0, bx1 - bx0)
                box_h = max(0, by1 - by0)
                if pw < box_w - 4 and ph < box_h - 4:
                    draw.rectangle(
                        [px_pos, py_pos, px_pos + pw, py_pos + ph],
                        fill=pill_bg)
                    # Vertical-centre the text inside the 20px pill.
                    txt_h = (ptxt_bbox[3] - ptxt_bbox[1])
                    txt_y = py_pos + max(0, (ph - txt_h) // 2 - 1)
                    draw.text(
                        (px_pos + pad_x, txt_y),
                        pill_text, fill=(255, 255, 255), font=pill_font)

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
            # Pill now sits INSIDE the box top-left, so the detail
            # label can drop back to its original position right above
            # the bbox (no more badge_offset stacking).
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

            # ── Feature detection overlay (teach mode only) ──────────
            # Show the operator which structural features the
            # classifier can actually see — holes, bosses, slots,
            # step edges. Each gets a small coloured box drawn
            # INSIDE the main green teach box plus a tiny
            # confidence label.
            if self._teach_mode:
                _color_crop = o.get('color_crop')
                _mask_2d    = o.get('mask_2d')
                _feat_gray  = None
                if _color_crop is not None:
                    _feat_gray = (
                        np.mean(_color_crop.astype(np.float32), axis=2)
                        if _color_crop.ndim == 3
                        else _color_crop.astype(np.float32))
                if _feat_gray is not None and _mask_2d is not None:
                    _feats = self._detect_part_features(
                        _feat_gray, _mask_2d)
                    # x0, y0 (unpacked from o['bbox_px'] at loop top)
                    # are the crop origin in full-frame coordinates.
                    # mask_2d + color_crop are sized to that bbox, so
                    # feature crop-coords convert to full-frame by
                    # adding (crop_x0, crop_y0).
                    _crop_x0 = max(0, int(x0))
                    _crop_y0 = max(0, int(y0))

                    _abbrev = {
                        'circular_hole':    'HOLE\u25cf',
                        'slot_hole':        'SLOT',
                        'rectangular_hole': 'RECESS',
                        'circular_boss':    'BOSS\u25cf',
                        'rectangular_boss': 'BOSS',
                        'edge_step':        'STEP',
                    }
                    try:
                        _ff = ImageFont.truetype(
                            '/usr/share/fonts/truetype/dejavu/'
                            'DejaVuSans-Bold.ttf', size=10)
                    except Exception:
                        _ff = ImageFont.load_default()

                    for _f in _feats:
                        _fx0, _fy0, _fx1, _fy1 = _f['bbox']
                        _ffx0 = _crop_x0 + _fx0
                        _ffy0 = _crop_y0 + _fy0
                        _ffx1 = _crop_x0 + _fx1
                        _ffy1 = _crop_y0 + _fy1
                        _ft = _f['type']
                        _fc = ((0, 190, 255)   if 'hole' in _ft
                               else (255, 140, 0)  if 'boss' in _ft
                               else (220, 220, 0)  if 'edge' in _ft
                               else (180, 180, 180))
                        draw.rectangle(
                            [_ffx0, _ffy0, _ffx1, _ffy1],
                            outline=_fc, width=1)
                        _lbl = (_abbrev.get(_ft, _ft[:6].upper())
                                + f' {int(_f["confidence"] * 100)}%')
                        if hasattr(draw, 'textlength'):
                            _tw = int(draw.textlength(_lbl, font=_ff))
                        else:
                            _tw = len(_lbl) * 6
                        _tx = max(0, _ffx0)
                        _ty = max(0, _ffy0 - 13)
                        draw.rectangle(
                            [_tx, _ty, _tx + _tw + 2, _ty + 11],
                            fill=_fc)
                        draw.text(
                            (_tx + 1, _ty + 1), _lbl,
                            fill=(0, 0, 0), font=_ff)

                # ── CAD anchor overlay (teach mode) ──────────────────
                # Show where the CAD model EXPECTS to find features on
                # the part's top face. Cyan thin circle = expected hole,
                # orange thin box = expected boss. Lets the operator
                # verify camera-vs-CAD alignment before accepting a
                # teach capture. Only fires when exactly one part has
                # CAD face features loaded (teach mode suppresses
                # recognition so we don't know which part_id is in
                # frame; if only one CAD part exists it's unambiguous).
                _part_ids_for_obj = list(self._cad_face_features.keys())
                if len(_part_ids_for_obj) == 1:
                    _show_part_id = _part_ids_for_obj[0]
                    _pff = self._cad_face_features.get(_show_part_id, {})
                    _top_face = _pff.get('top', {})
                    _crop_x0c, _crop_y0c, _crop_x1c, _crop_y1c = o['bbox_px']
                    _cw = max(1, int(_crop_x1c) - int(_crop_x0c))
                    _ch = max(1, int(_crop_y1c) - int(_crop_y0c))

                    for _hole in (_top_face.get('holes') or []):
                        _hcx = int(_crop_x0c + float(_hole['center'][0]) * _cw)
                        _hcy = int(_crop_y0c + float(_hole['center'][1]) * _ch)
                        _hr  = max(4, int(float(_hole.get('radius_norm', 0.05))
                                          * max(_cw, _ch)))
                        draw.ellipse(
                            [_hcx - _hr, _hcy - _hr,
                             _hcx + _hr, _hcy + _hr],
                            outline=(0, 255, 200), width=1)

                    for _boss in (_top_face.get('bosses') or []):
                        _bcx = int(_crop_x0c + float(_boss['center'][0]) * _cw)
                        _bcy = int(_crop_y0c + float(_boss['center'][1]) * _ch)
                        _br  = 8
                        draw.rectangle(
                            [_bcx - _br, _bcy - _br,
                             _bcx + _br, _bcy + _br],
                            outline=(255, 165, 0), width=1)

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
