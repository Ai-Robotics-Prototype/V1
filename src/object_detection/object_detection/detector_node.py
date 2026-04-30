import os
import rclpy
from rclpy.node import Node
import message_filters
from sensor_msgs.msg import Image, CameraInfo
from vision_msgs.msg import Detection3DArray, Detection3D, ObjectHypothesisWithPose
import numpy as np

try:
    from cv_bridge import CvBridge
    CV_BRIDGE_AVAILABLE = True
except ImportError:
    CV_BRIDGE_AVAILABLE = False

try:
    from ultralytics import YOLO
    ULTRALYTICS_AVAILABLE = True
except ImportError:
    ULTRALYTICS_AVAILABLE = False


class DetectorNode(Node):
    def __init__(self):
        super().__init__('detector_node')

        self.declare_parameter('model_path', '/opt/cobot/models/yolov8n.pt')
        self.declare_parameter('confidence_threshold', 0.5)
        self.declare_parameter('nms_threshold', 0.4)
        self.declare_parameter('target_classes', ['bottle', 'box', 'cup', 'tool', 'person'])
        self.declare_parameter('use_tensorrt', False)
        self.declare_parameter('device', 'cuda:0')

        self.model_path = self.get_parameter('model_path').value
        self.conf_thresh = self.get_parameter('confidence_threshold').value
        self.target_classes = self.get_parameter('target_classes').value
        self.device = self.get_parameter('device').value

        if self.model_path.endswith('.engine'):
            self.set_parameters([rclpy.parameter.Parameter(
                'use_tensorrt', rclpy.Parameter.Type.BOOL, True)])

        self.bridge = CvBridge() if CV_BRIDGE_AVAILABLE else None
        self.model = None
        self.camera_info = None
        self._load_model()

        self.det_pub = self.create_publisher(Detection3DArray, '/perception/detections', 10)

        rgb_sub = message_filters.Subscriber(self, Image, '/cam0/color/image_raw')
        depth_sub = message_filters.Subscriber(self, Image, '/cam0/depth/image_rect_raw')
        self.sync = message_filters.ApproximateTimeSynchronizer(
            [rgb_sub, depth_sub], queue_size=10, slop=0.05)
        self.sync.registerCallback(self.detection_callback)

        self.create_subscription(CameraInfo, '/cam0/color/camera_info',
                                 self._camera_info_cb, 10)

        self._det_count = 0
        self._last_log = self.get_clock().now()
        self._last_classes: list = []
        self.get_logger().info('detector_node started')

    def _load_model(self):
        if not ULTRALYTICS_AVAILABLE:
            self.get_logger().warn('ultralytics not installed — detections disabled')
            return
        if not os.path.exists(self.model_path):
            self.get_logger().warn(
                f'Model not found at {self.model_path} — run scripts/download_model.py')
            self.create_timer(5.0, self._retry_load)
            return
        try:
            self.model = YOLO(self.model_path)
            self.get_logger().info(f'YOLO model loaded from {self.model_path}')
        except Exception as e:
            self.get_logger().error(f'Failed to load model: {e}')

    def _retry_load(self):
        if self.model is not None:
            return
        if os.path.exists(self.model_path):
            self._load_model()

    def _camera_info_cb(self, msg: CameraInfo):
        self.camera_info = msg

    def _pixel_to_3d(self, cx, cy, depth_m):
        if self.camera_info is None:
            return None
        fx = self.camera_info.k[0]
        fy = self.camera_info.k[4]
        ppx = self.camera_info.k[2]
        ppy = self.camera_info.k[5]
        if fx == 0 or fy == 0:
            return None
        x = (cx - ppx) * depth_m / fx
        y = (cy - ppy) * depth_m / fy
        z = depth_m
        return (x, y, z)

    def detection_callback(self, rgb_msg: Image, depth_msg: Image):
        if self.model is None or not CV_BRIDGE_AVAILABLE:
            return

        try:
            rgb_img = self.bridge.imgmsg_to_cv2(rgb_msg, 'bgr8')
            depth_img = self.bridge.imgmsg_to_cv2(depth_msg, '32FC1')
        except Exception as e:
            self.get_logger().warn(f'cv_bridge error: {e}')
            return

        results = self.model(rgb_img, conf=self.conf_thresh, verbose=False)
        det_array = Detection3DArray()
        det_array.header.frame_id = 'cam0_link'
        det_array.header.stamp = self.get_clock().now().to_msg()

        detected_classes = []
        for result in results:
            if result.boxes is None:
                continue
            for box in result.boxes:
                cls_id = int(box.cls[0])
                cls_name = self.model.names.get(cls_id, str(cls_id))
                if self.target_classes and cls_name not in self.target_classes:
                    continue
                conf = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx = int((x1 + x2) / 2)
                cy = int((y1 + y2) / 2)

                h, w = depth_img.shape[:2]
                cx = max(0, min(cx, w - 1))
                cy = max(0, min(cy, h - 1))
                depth_val = float(depth_img[cy, cx])
                if np.isnan(depth_val) or depth_val <= 0:
                    depth_val = 1.0

                pos_3d = self._pixel_to_3d(cx, cy, depth_val)
                if pos_3d is None:
                    continue

                det = Detection3D()
                det.header = det_array.header
                hyp = ObjectHypothesisWithPose()
                hyp.hypothesis.class_id = cls_name
                hyp.hypothesis.score = conf
                hyp.pose.pose.position.x = pos_3d[0]
                hyp.pose.pose.position.y = pos_3d[1]
                hyp.pose.pose.position.z = pos_3d[2]
                det.results.append(hyp)

                bbox_w = (x2 - x1) * depth_val / max(
                    self.camera_info.k[0] if self.camera_info else 500, 1)
                bbox_h = (y2 - y1) * depth_val / max(
                    self.camera_info.k[4] if self.camera_info else 500, 1)
                det.bbox.center.position.x = pos_3d[0]
                det.bbox.center.position.y = pos_3d[1]
                det.bbox.center.position.z = pos_3d[2]
                det.bbox.size.x = bbox_w
                det.bbox.size.y = bbox_h
                det.bbox.size.z = 0.1

                det_array.detections.append(det)
                detected_classes.append(cls_name)

        self.det_pub.publish(det_array)
        self._det_count = len(det_array.detections)
        self._last_classes = detected_classes

        now = self.get_clock().now()
        dt = (now - self._last_log).nanoseconds / 1e9
        if dt >= 1.0:
            self.get_logger().info(
                f'Detected {self._det_count} objects: {self._last_classes}')
            self._last_log = now


def main(args=None):
    rclpy.init(args=args)
    node = DetectorNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
