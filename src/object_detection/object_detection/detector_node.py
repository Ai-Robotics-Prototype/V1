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

# ── Backend selection: TensorRT → Ultralytics → warn ─────────────────────────
try:
    from object_detection.trt_engine import TRTEngine, TRT_AVAILABLE, load_engine
except ImportError:
    TRT_AVAILABLE = False
    load_engine = lambda _: None  # noqa: E731

try:
    from ultralytics import YOLO
    ULTRALYTICS_AVAILABLE = True
except ImportError:
    ULTRALYTICS_AVAILABLE = False


class DetectorNode(Node):
    def __init__(self):
        super().__init__('detector_node')

        self.declare_parameter('model_path',            '/opt/cobot/models/yolov8n.pt')
        self.declare_parameter('engine_path',           '/opt/cobot/models/yolov8n.engine')
        self.declare_parameter('confidence_threshold',  0.5)
        self.declare_parameter('nms_threshold',         0.4)
        self.declare_parameter('target_classes',        ['bottle','box','cup','tool','person'])
        self.declare_parameter('device',                'cuda:0')
        self.declare_parameter('input_width',           640)
        self.declare_parameter('input_height',          640)

        self.model_path    = self.get_parameter('model_path').value
        self.engine_path   = self.get_parameter('engine_path').value
        self.conf_thresh   = self.get_parameter('confidence_threshold').value
        self.nms_thresh    = self.get_parameter('nms_threshold').value
        self.target_classes= self.get_parameter('target_classes').value
        self.device        = self.get_parameter('device').value
        iw = self.get_parameter('input_width').value
        ih = self.get_parameter('input_height').value

        self.bridge       = CvBridge() if CV_BRIDGE_AVAILABLE else None
        self.trt_engine   = None
        self.yolo_model   = None
        self.camera_info  = None
        self._backend     = 'none'

        self._load_model(iw, ih)

        self.det_pub = self.create_publisher(Detection3DArray, '/perception/detections_3d', 10)
        self.ann_pub = self.create_publisher(Image, '/perception/annotated_image', 5)

        if CV_BRIDGE_AVAILABLE:
            rgb_sub   = message_filters.Subscriber(self, Image, '/cam0/color/image_raw')
            depth_sub = message_filters.Subscriber(self, Image, '/cam0/depth/image_rect_raw')
            self.sync = message_filters.ApproximateTimeSynchronizer(
                [rgb_sub, depth_sub], queue_size=10, slop=0.05)
            self.sync.registerCallback(self.detection_callback)
        else:
            self.get_logger().warn(
                'cv_bridge not available — using PIL fallback (RGB only, no depth)')
            self.create_subscription(
                Image, '/cam0/color/image_raw', self._pil_callback, 5)

        self.create_subscription(CameraInfo, '/cam0/color/camera_info',
                                 self._camera_info_cb, 10)

        self._last_log    = self.get_clock().now()
        self._last_classes: list = []
        self.get_logger().info(f'detector_node started | backend={self._backend}')

    # ── Model loading ─────────────────────────────────────────────────────────

    def _load_model(self, iw: int, ih: int):
        # 1. Try TensorRT .engine first
        if TRT_AVAILABLE and os.path.exists(self.engine_path):
            try:
                self.trt_engine = TRTEngine(self.engine_path, (ih, iw))
                self._backend   = 'tensorrt'
                self.get_logger().info(f'TensorRT engine loaded: {self.engine_path}')
                return
            except Exception as e:
                self.get_logger().warn(f'TRT load failed ({e}) — falling back to Ultralytics')

        # 2. Try Ultralytics .pt
        if ULTRALYTICS_AVAILABLE and os.path.exists(self.model_path):
            try:
                self.yolo_model = YOLO(self.model_path)
                self._backend   = 'ultralytics'
                self.get_logger().info(f'Ultralytics YOLO loaded: {self.model_path}')
                return
            except Exception as e:
                self.get_logger().error(f'YOLO load failed: {e}')

        # 3. Neither available
        hint = (
            f'No model found. '
            f'TRT: run scripts/export_trt.py → {self.engine_path}  '
            f'or  PT: run scripts/download_model.py → {self.model_path}'
        )
        self.get_logger().warn(hint)
        self.create_timer(10.0, self._retry_load_timer)

    def _retry_load_timer(self):
        if self._backend != 'none':
            return
        if TRT_AVAILABLE and os.path.exists(self.engine_path):
            self._load_model(640, 640)
        elif ULTRALYTICS_AVAILABLE and os.path.exists(self.model_path):
            self._load_model(640, 640)

    # ── Inference ─────────────────────────────────────────────────────────────

    def _run_inference(self, bgr_img) -> list:
        """Returns list of (class_name, conf, x1, y1, x2, y2)."""
        results = []

        if self._backend == 'tensorrt' and self.trt_engine:
            boxes, scores, class_ids = self.trt_engine.infer(
                bgr_img, self.conf_thresh, self.nms_thresh)
            # TRT class IDs are raw integers — map via COCO names
            coco_names = self._coco_names()
            for box, sc, cid in zip(boxes, scores, class_ids):
                name = coco_names.get(int(cid), str(cid))
                if self.target_classes and name not in self.target_classes:
                    continue
                results.append((name, float(sc),
                                 box[0], box[1], box[2], box[3]))

        elif self._backend == 'ultralytics' and self.yolo_model:
            preds = self.yolo_model(bgr_img, conf=self.conf_thresh, verbose=False)
            for pred in preds:
                if pred.boxes is None:
                    continue
                for box in pred.boxes:
                    cls_name = self.yolo_model.names[int(box.cls[0])]
                    if self.target_classes and cls_name not in self.target_classes:
                        continue
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    results.append((cls_name, float(box.conf[0]),
                                    x1, y1, x2, y2))
        return results

    # ── ROS callback ──────────────────────────────────────────────────────────

    def _camera_info_cb(self, msg: CameraInfo):
        self.camera_info = msg

    def _pixel_to_3d(self, cx, cy, depth_m):
        if self.camera_info is None:
            return None
        fx = self.camera_info.k[0]; fy = self.camera_info.k[4]
        ppx = self.camera_info.k[2]; ppy = self.camera_info.k[5]
        if fx == 0 or fy == 0:
            return None
        return (
            (cx - ppx) * depth_m / fx,
            (cy - ppy) * depth_m / fy,
            depth_m,
        )

    def detection_callback(self, rgb_msg: Image, depth_msg: Image):
        if self._backend == 'none' or self.bridge is None:
            return

        try:
            bgr   = self.bridge.imgmsg_to_cv2(rgb_msg,   'bgr8')
            depth = self.bridge.imgmsg_to_cv2(depth_msg, '32FC1')
        except Exception as e:
            self.get_logger().warn(f'cv_bridge: {e}')
            return

        det_list = self._run_inference(bgr)

        arr = Detection3DArray()
        arr.header.frame_id = 'cam0_link'
        arr.header.stamp    = self.get_clock().now().to_msg()
        detected_classes    = []

        h_img, w_img = depth.shape[:2]
        fx = self.camera_info.k[0] if self.camera_info else 500.0
        fy = self.camera_info.k[4] if self.camera_info else 500.0

        for cls_name, conf, x1, y1, x2, y2 in det_list:
            cx = int((x1 + x2) / 2)
            cy = int((y1 + y2) / 2)
            cx = max(0, min(cx, w_img - 1))
            cy = max(0, min(cy, h_img - 1))

            dv = float(depth[cy, cx])
            if not np.isfinite(dv) or dv <= 0:
                dv = 1.0

            pos = self._pixel_to_3d(cx, cy, dv)
            if pos is None:
                continue

            det = Detection3D()
            det.header = arr.header
            hyp = ObjectHypothesisWithPose()
            hyp.hypothesis.class_id = cls_name
            hyp.hypothesis.score    = conf
            hyp.pose.pose.position.x = pos[0]
            hyp.pose.pose.position.y = pos[1]
            hyp.pose.pose.position.z = pos[2]
            det.results.append(hyp)

            bw = (x2 - x1) * dv / fx
            bh = (y2 - y1) * dv / fy
            det.bbox.center.position.x = pos[0]
            det.bbox.center.position.y = pos[1]
            det.bbox.center.position.z = pos[2]
            det.bbox.size.x = float(bw)
            det.bbox.size.y = float(bh)
            det.bbox.size.z = 0.1

            arr.detections.append(det)
            detected_classes.append(cls_name)

        self.det_pub.publish(arr)

        now = self.get_clock().now()
        if (now - self._last_log).nanoseconds / 1e9 >= 1.0:
            self.get_logger().info(
                f'[{self._backend}] Detected {len(arr.detections)}: {detected_classes}')
            self._last_log = now

    def _pil_callback(self, rgb_msg: Image):
        """PIL-based detection callback used when cv_bridge is unavailable."""
        try:
            from PIL import Image as PILImage, ImageDraw
            raw = bytes(rgb_msg.data)
            enc = rgb_msg.encoding
            w, h = rgb_msg.width, rgb_msg.height

            if enc == 'rgb8':
                pil_img = PILImage.frombytes('RGB', (w, h), raw)
            elif enc == 'bgr8':
                pil_img = PILImage.frombytes('RGB', (w, h), raw)
                r, g, b = pil_img.split()
                pil_img = PILImage.merge('RGB', (b, g, r))
            else:
                return

            img_np = np.array(pil_img)
            boxes_list = []
            if self.yolo_model is not None:
                results = self.yolo_model(img_np, conf=self.conf_thresh, verbose=False)
                if results and len(results) > 0:
                    r = results[0]
                    if r.boxes is not None:
                        for box in r.boxes:
                            x1, y1, x2, y2 = box.xyxy[0].tolist()
                            sc = float(box.conf[0])
                            cid = int(box.cls[0])
                            cname = r.names.get(cid, str(cid))
                            if self.target_classes and cname not in self.target_classes:
                                continue
                            if sc >= self.conf_thresh:
                                boxes_list.append((cname, sc, x1, y1, x2, y2))

            arr = Detection3DArray()
            arr.header.stamp = rgb_msg.header.stamp
            arr.header.frame_id = 'cam0_color_optical_frame'
            for cname, sc, x1, y1, x2, y2 in boxes_list:
                det = Detection3D()
                det.header = arr.header
                hyp = ObjectHypothesisWithPose()
                hyp.hypothesis.class_id = cname
                hyp.hypothesis.score = sc
                cx_px = (x1 + x2) / 2
                cy_px = (y1 + y2) / 2
                hyp.pose.pose.position.x = cx_px
                hyp.pose.pose.position.y = cy_px
                hyp.pose.pose.position.z = 1.0
                det.results.append(hyp)
                det.bbox.center.position.x = cx_px
                det.bbox.center.position.y = cy_px
                det.bbox.center.position.z = 1.0
                det.bbox.size.x = float(x2 - x1)
                det.bbox.size.y = float(y2 - y1)
                det.bbox.size.z = 0.1
                arr.detections.append(det)
            self.det_pub.publish(arr)

            # Annotated image
            draw = ImageDraw.Draw(pil_img)
            COLOR_MAP = {'person': (239, 68, 68), 'bottle': (59, 130, 246),
                         'box': (34, 197, 94), 'cup': (234, 179, 8)}
            for cname, sc, x1, y1, x2, y2 in boxes_list:
                col = COLOR_MAP.get(cname, (155, 155, 155))
                draw.rectangle([x1, y1, x2, y2], outline=col, width=2)
                draw.rectangle([x1, y1 - 14, x1 + len(cname) * 7 + 35, y1], fill=col)
                draw.text((x1 + 2, y1 - 13), f'{cname} {sc:.0%}', fill=(255, 255, 255))

            ann_raw = pil_img.tobytes()
            ann_msg = Image()
            ann_msg.header = rgb_msg.header
            ann_msg.height = h
            ann_msg.width = w
            ann_msg.encoding = 'rgb8'
            ann_msg.step = w * 3
            ann_msg.data = list(ann_raw)
            self.ann_pub.publish(ann_msg)

        except Exception as e:
            self.get_logger().debug(f'PIL callback error: {e}')

    @staticmethod
    def _coco_names() -> dict:
        return {
            0:'person',1:'bicycle',2:'car',3:'motorcycle',4:'airplane',5:'bus',
            6:'train',7:'truck',8:'boat',39:'bottle',41:'cup',56:'chair',
            57:'couch',58:'potted plant',59:'bed',60:'dining table',
            63:'laptop',64:'mouse',65:'remote',66:'keyboard',67:'cell phone',
            73:'book',74:'clock',75:'vase',76:'scissors',77:'teddy bear',
        }


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
