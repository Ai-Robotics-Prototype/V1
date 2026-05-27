#!/usr/bin/env python3
"""
depth_segment_node — class-agnostic ("any object") detection from RealSense depth.

No ML model. Segments foreground objects out of the aligned depth image:

  1. depth -> metres (16UC1 / 1000, or 32FC1 as-is)
  2. background removal: drop depth <= 0 or >= max_depth_m
  3. dominant-plane (table/floor) removal: least-squares plane fit (with one
     inlier-refit pass), drop pixels within floor_tolerance_m of the plane;
     keep only pixels nearer to the camera than the plane (objects protrude)
  4. morphological open (erode -> dilate) to clean noise
  5. connected components (scipy.ndimage.label); regions > min_object_area_px
     become objects
  6. per object: bbox + median depth -> deproject centre to 3D camera coords

Publishes:
  /perception/detections_3d   (vision_msgs/Detection3DArray, class_id="object")
  /perception/annotated_image (sensor_msgs/Image, boxes drawn with PIL)

Dependencies: numpy, scipy, PIL only. No cv2, no torch, no ultralytics.
"""
import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image, CameraInfo
from vision_msgs.msg import Detection3DArray, Detection3D, ObjectHypothesisWithPose
from scipy import ndimage
from PIL import Image as PILImage, ImageDraw


class DepthSegmentNode(Node):
    def __init__(self):
        super().__init__('depth_segment_node')

        self.declare_parameter('max_depth_m',        2.0)
        self.declare_parameter('min_object_area_px', 500)
        self.declare_parameter('floor_tolerance_m',  0.02)
        self.declare_parameter('erode_kernel',       3)
        self.declare_parameter('dilate_kernel',      5)
        self.declare_parameter('publish_rate_hz',    15.0)
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

        # RealSense images are BEST_EFFORT — must match QoS or no frames arrive
        self.create_subscription(Image, depth_topic, self._on_depth, qos_profile_sensor_data)
        self.create_subscription(Image, color_topic, self._on_color, qos_profile_sensor_data)
        self.create_subscription(CameraInfo, info_topic, self._on_info, qos_profile_sensor_data)

        self.det_pub = self.create_publisher(Detection3DArray, det_topic, 10)
        self.ann_pub = self.create_publisher(Image, ann_topic, 5)

        self.create_timer(1.0 / max(rate, 1.0), self._process)
        self._log_count = 0
        self.get_logger().info(
            f'depth_segment_node started | max_depth={self.max_depth}m '
            f'min_area={self.min_area}px floor_tol={self.floor_tol}m rate={rate}Hz')

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

    # ── Main processing (timer) ─────────────────────────────────────────────

    def _uv_grids(self, h, w):
        if self._uv_cache is None or self._uv_cache[0] != (h, w):
            u = np.arange(w, dtype=np.float32)[None, :].repeat(h, axis=0)
            v = np.arange(h, dtype=np.float32)[:, None].repeat(w, axis=1)
            self._uv_cache = ((h, w), u, v)
        return self._uv_cache[1], self._uv_cache[2]

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
            self._publish([], h, w)
            return

        # Deproject every valid pixel to 3D camera coords
        Z = np.where(valid, depth, 0.0).astype(np.float32)
        X = (u - cx) * Z / fx
        Y = (v - cy) * Z / fy

        # Dominant-plane fit Z ≈ a*X + b*Y + c on a random valid subsample
        vy, vx = np.nonzero(valid)
        if vy.size > 4000:
            sel = np.random.choice(vy.size, 4000, replace=False)
            vy, vx = vy[sel], vx[sel]
        plane = self._fit_plane(X[vy, vx], Y[vy, vx], Z[vy, vx])
        if plane is None:
            self._publish([], h, w)
            return
        a, b, c = plane
        plane_z = a * X + b * Y + c
        # Objects sit ON the surface → nearer to camera than the plane
        foreground = valid & (depth < (plane_z - self.floor_tol))

        # Morphological open: erode then dilate
        if self.erode_k > 1:
            foreground = ndimage.binary_erosion(
                foreground, structure=np.ones((self.erode_k, self.erode_k)))
        if self.dilate_k > 1:
            foreground = ndimage.binary_dilation(
                foreground, structure=np.ones((self.dilate_k, self.dilate_k)))

        # Connected components
        labeled, n = ndimage.label(foreground)
        objects = []
        if n > 0:
            areas = np.bincount(labeled.ravel())
            slices = ndimage.find_objects(labeled)
            for lid in range(1, n + 1):
                if areas[lid] < self.min_area:
                    continue
                sl = slices[lid - 1]
                if sl is None:
                    continue
                ys, xs = sl
                y0, y1 = ys.start, ys.stop
                x0, x1 = xs.start, xs.stop
                region_mask = labeled[sl] == lid
                region_depth = depth[sl][region_mask]
                region_depth = region_depth[(region_depth > 0) & np.isfinite(region_depth)]
                if region_depth.size == 0:
                    continue
                zc = float(np.median(region_depth))
                ucen = (x0 + x1) * 0.5
                vcen = (y0 + y1) * 0.5
                Xc = (ucen - cx) * zc / fx
                Yc = (vcen - cy) * zc / fy
                objects.append({
                    'bbox_px': (int(x0), int(y0), int(x1), int(y1)),
                    'pos': (float(Xc), float(Yc), zc),
                    'size_m': ((x1 - x0) * zc / fx, (y1 - y0) * zc / fy),
                    'area': int(areas[lid]),
                })

        self._publish(objects, h, w)

        self._log_count += 1
        if self._log_count % 30 == 0:
            self.get_logger().info(f'{len(objects)} object(s) detected')

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
        # keep inliers within 3x median abs deviation (robust to the objects)
        mad = np.median(np.abs(resid - np.median(resid))) + 1e-6
        inl = np.abs(resid) < 3.0 * mad
        if inl.sum() >= 50:
            coef = solve(X[inl], Y[inl], Z[inl])
        return float(coef[0]), float(coef[1]), float(coef[2])

    # ── Publishing ────────────────────────────────────────────────────────────

    def _publish(self, objects, h, w):
        stamp = self._depth_hdr.stamp if self._depth_hdr else self.get_clock().now().to_msg()
        arr = Detection3DArray()
        arr.header.stamp = stamp
        arr.header.frame_id = self.frame_id
        for o in objects:
            det = Detection3D()
            det.header = arr.header
            hyp = ObjectHypothesisWithPose()
            hyp.hypothesis.class_id = 'object'
            hyp.hypothesis.score = 1.0
            px, py, pz = o['pos']
            hyp.pose.pose.position.x = px
            hyp.pose.pose.position.y = py
            hyp.pose.pose.position.z = pz
            det.results.append(hyp)
            det.bbox.center.position.x = px
            det.bbox.center.position.y = py
            det.bbox.center.position.z = pz
            det.bbox.size.x = float(o['size_m'][0])
            det.bbox.size.y = float(o['size_m'][1])
            det.bbox.size.z = 0.05
            arr.detections.append(det)
        self.det_pub.publish(arr)
        self._publish_annotated(objects, h, w)

    def _publish_annotated(self, objects, h, w):
        rgb = self._color_rgb
        if rgb is None or rgb.shape[0] != h or rgb.shape[1] != w:
            return
        img = PILImage.fromarray(rgb.copy(), 'RGB')
        draw = ImageDraw.Draw(img)
        for i, o in enumerate(objects):
            x0, y0, x1, y1 = o['bbox_px']
            col = (34, 197, 94)
            draw.rectangle([x0, y0, x1, y1], outline=col, width=2)
            label = f'object {o["pos"][2]:.2f}m'
            draw.rectangle([x0, max(0, y0 - 13), x0 + len(label) * 6 + 6, y0], fill=col)
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
