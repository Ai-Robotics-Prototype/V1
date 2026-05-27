"""
Depth-lift bridge: Detection2DArray + aligned depth → Detection3DArray.

Subscribes to the Isaac ROS YOLOv8 decoder output and aligned depth to
project each 2D bounding-box centre into 3D camera space, then publishes
to the topics that scene_graph and the dashboard expect.
"""

import threading

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy

from sensor_msgs.msg import Image, CameraInfo
from vision_msgs.msg import (
    Detection2DArray, Detection3DArray, Detection3D,
    ObjectHypothesisWithPose,
)
from geometry_msgs.msg import Pose, Point, Quaternion, Vector3
from std_msgs.msg import Header

try:
    from cv_bridge import CvBridge
    _BRIDGE = CvBridge()
    _CV_OK = True
except ImportError:
    _BRIDGE = None
    _CV_OK = False

try:
    from PIL import Image as PILImage, ImageDraw, ImageFont
    _PIL_OK = True
except ImportError:
    _PIL_OK = False

# Depth QoS — RealSense publishes with BEST_EFFORT reliability
_DEPTH_QOS = QoSProfile(
    depth=5,
    reliability=ReliabilityPolicy.BEST_EFFORT,
    durability=DurabilityPolicy.VOLATILE,
)

_COCO_CLASSES = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train',
    'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign',
    'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep',
    'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
    'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard',
    'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard',
    'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork',
    'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
    'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv',
    'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave',
    'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
    'scissors', 'teddy bear', 'hair drier', 'toothbrush',
]


def _id_to_label(class_id: int) -> str:
    if 0 <= class_id < len(_COCO_CLASSES):
        return _COCO_CLASSES[class_id]
    return f'class_{class_id}'


class DepthDetectorNode(Node):

    def __init__(self):
        super().__init__('depth_detector_node')

        self._lock = threading.Lock()
        self._depth_img: np.ndarray | None = None
        self._depth_header: Header | None = None
        self._camera_info: CameraInfo | None = None
        self._latest_color: bytes | None = None       # JPEG bytes for annotation
        self._latest_color_shape: tuple | None = None  # (H, W)

        # Publishers
        self._pub3d  = self.create_publisher(Detection3DArray, '/perception/detections', 10)
        self._pub_ann = self.create_publisher(Image, '/perception/annotated_image', 5)

        # Subscribers
        self.create_subscription(
            Detection2DArray, '/detections', self._on_detections, 10)
        self.create_subscription(
            Image, '/cam0/cam0/aligned_depth_to_color/image_raw',
            self._on_depth, _DEPTH_QOS)
        self.create_subscription(
            CameraInfo, '/cam0/cam0/aligned_depth_to_color/camera_info',
            self._on_camera_info, 10)
        self.create_subscription(
            Image, '/cam0/cam0/color/image_raw', self._on_color, 5)

        self.get_logger().info('depth_detector_node ready')

    # ── Depth ──────────────────────────────────────────────────────────────

    def _on_depth(self, msg: Image):
        if not _CV_OK:
            return
        try:
            arr = _BRIDGE.imgmsg_to_cv2(msg, desired_encoding='passthrough')
        except Exception as e:
            self.get_logger().warn(f'depth decode failed: {e}', throttle_duration_sec=5)
            return
        with self._lock:
            self._depth_img = arr.astype(np.float32) * 0.001  # mm → m
            self._depth_header = msg.header

    def _on_camera_info(self, msg: CameraInfo):
        with self._lock:
            self._camera_info = msg

    def _on_color(self, msg: Image):
        if not _PIL_OK:
            return
        try:
            arr = _BRIDGE.imgmsg_to_cv2(msg, 'rgb8') if _CV_OK else None
            if arr is None:
                return
            h, w = arr.shape[:2]
            with self._lock:
                self._latest_color = arr
                self._latest_color_shape = (h, w)
        except Exception:
            pass

    # ── Main callback ────────────────────────────────────────────────────────

    def _on_detections(self, msg: Detection2DArray):
        with self._lock:
            depth = self._depth_img
            info  = self._camera_info
            color = self._latest_color
            color_shape = self._latest_color_shape

        arr3d = Detection3DArray()
        arr3d.header = msg.header

        for det2d in msg.detections:
            cx = det2d.bbox.center.position.x
            cy = det2d.bbox.center.position.y
            bw = det2d.bbox.size_x
            bh = det2d.bbox.size_y

            # Unproject centre pixel to 3D
            z = self._get_depth(depth, info, cx, cy)

            det3d = Detection3D()
            det3d.header = msg.header
            det3d.bbox.size = Vector3(x=bw * 0.001, y=bh * 0.001, z=0.05)

            if z is not None and info is not None:
                fx = info.k[0]; fy = info.k[4]
                px = info.k[2]; py = info.k[5]
                X = (cx - px) * z / fx
                Y = (cy - py) * z / fy
                det3d.bbox.center.position = Point(x=X, y=Y, z=z)
            else:
                det3d.bbox.center.position = Point(x=cx * 0.001, y=cy * 0.001, z=1.0)

            det3d.bbox.center.orientation = Quaternion(w=1.0)

            hyp = ObjectHypothesisWithPose()
            if det2d.results:
                r = det2d.results[0]
                hyp.hypothesis.class_id = str(r.hypothesis.class_id)
                hyp.hypothesis.score    = r.hypothesis.score
            hyp.pose.pose = det3d.bbox.center
            det3d.results.append(hyp)
            arr3d.detections.append(det3d)

        self._pub3d.publish(arr3d)

        # Annotated image
        if color is not None and _PIL_OK:
            self._publish_annotated(color, color_shape, msg, arr3d.header)

    def _get_depth(self, depth, info, cx, cy):
        if depth is None or info is None:
            return None
        h, w = depth.shape[:2]
        ix = int(cx)
        iy = int(cy)
        if not (0 <= ix < w and 0 <= iy < h):
            return None
        # Sample a 5×5 patch and take median of valid values
        x0 = max(0, ix - 2); x1 = min(w, ix + 3)
        y0 = max(0, iy - 2); y1 = min(h, iy + 3)
        patch = depth[y0:y1, x0:x1]
        valid = patch[patch > 0.1]
        if valid.size == 0:
            return None
        return float(np.median(valid))

    def _publish_annotated(self, color_arr, shape, det2d_msg, header):
        try:
            h, w = shape
            img = PILImage.fromarray(color_arr)
            draw = ImageDraw.Draw(img)

            for det in det2d_msg.detections:
                cx = det.bbox.center.position.x
                cy = det.bbox.center.position.y
                bw = det.bbox.size_x / 2
                bh = det.bbox.size_y / 2
                x0, y0 = max(0, cx - bw), max(0, cy - bh)
                x1, y1 = min(w, cx + bw), min(h, cy + bh)

                label = ''
                score = 0.0
                if det.results:
                    r = det.results[0]
                    try:
                        class_id = int(r.hypothesis.class_id)
                    except (ValueError, TypeError):
                        class_id = -1
                    label = _id_to_label(class_id)
                    score = r.hypothesis.score

                color = (0, 220, 0) if label != 'person' else (220, 60, 0)
                draw.rectangle([x0, y0, x1, y1], outline=color, width=2)
                draw.text((x0 + 2, y0 + 2), f'{label} {score:.2f}', fill=color)

            import io
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=80)
            jpeg = buf.getvalue()

            out = Image()
            out.header = header
            out.encoding = 'jpeg'
            out.data = list(jpeg)
            self._pub_ann.publish(out)
        except Exception as e:
            self.get_logger().warn(f'annotate failed: {e}', throttle_duration_sec=5)


def main(args=None):
    rclpy.init(args=args)
    node = DepthDetectorNode()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()
