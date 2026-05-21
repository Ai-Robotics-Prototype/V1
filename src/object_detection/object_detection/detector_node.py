#!/usr/bin/env python3
"""
YOLOv8 detector node — Pillow + numpy only (no cv2/CvBridge).
Publishes JSON String to /perception/detections and annotated Image to
/perception/annotated_image.
"""
import io, json, math, os, sys, threading, time, types
import numpy as np

# ── cv2 stub (ultralytics imports cv2 at module level; cv2 is broken here) ─────
def _make_cv2_stub():
    # Must NOT override dunder attrs like __file__, __spec__, __loader__
    # because Python's inspect/importlib reads them as strings.
    class FakeCV2(types.ModuleType):
        def __getattr__(self, name):
            if name.startswith('__') and name.endswith('__'):
                raise AttributeError(name)
            return lambda *a, **k: None
    m = FakeCV2('cv2')
    m.__file__    = '/stub/cv2.so'
    m.__spec__    = None
    m.__loader__  = None
    m.__package__ = 'cv2'
    m.__path__    = []
    for attr in [
        'IMREAD_COLOR', 'INTER_LINEAR', 'INTER_NEAREST', 'INTER_AREA',
        'COLOR_BGR2RGB', 'COLOR_RGB2BGR', 'COLOR_BGR2GRAY', 'COLOR_GRAY2BGR',
        'FONT_HERSHEY_SIMPLEX', 'LINE_AA', 'FILLED', 'IMREAD_UNCHANGED',
        'IMWRITE_JPEG_QUALITY', 'CAP_PROP_FRAME_COUNT', 'CAP_PROP_FPS',
        'CAP_PROP_FRAME_WIDTH', 'CAP_PROP_FRAME_HEIGHT',
    ]:
        setattr(m, attr, 0)
    m.imencode = lambda *a, **k: (True, bytearray())
    m.imdecode  = lambda *a, **k: None
    sub = types.ModuleType('cv2.mat_wrapper')
    sub.__file__ = '/stub/cv2/mat_wrapper.so'
    sys.modules['cv2.mat_wrapper'] = sub
    sys.modules['cv2'] = m

_make_cv2_stub()

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import CameraInfo, Image
from std_msgs.msg import String

try:
    import torch
    TORCH_OK = True
except ImportError:
    TORCH_OK = False

try:
    from PIL import Image as PILImage, ImageDraw, ImageFont
    PIL_OK = True
except ImportError:
    PIL_OK = False

COCO_NAMES = {
    0:'person',1:'bicycle',2:'car',3:'motorcycle',4:'airplane',5:'bus',
    6:'train',7:'truck',8:'boat',9:'traffic light',10:'fire hydrant',
    39:'bottle',41:'cup',56:'chair',57:'couch',58:'potted plant',
    59:'bed',60:'dining table',63:'laptop',64:'mouse',65:'remote',
    66:'keyboard',67:'cell phone',73:'book',74:'clock',75:'vase',
    76:'scissors',77:'teddy bear',
}

BOX_COLORS = {
    'person':       (220,  50,  50),
    'bottle':       ( 50, 160,  50),
    'cup':          ( 50, 120, 220),
    'chair':        (200, 130,  30),
    'default':      ( 80, 160, 240),
}


def _iou(a, b):
    ix1 = max(a[0], b[0]); iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2]); iy2 = min(a[3], b[3])
    iw  = max(0, ix2 - ix1); ih = max(0, iy2 - iy1)
    inter = iw * ih
    ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter
    return inter / (ua + 1e-6)


def _nms(boxes, scores, iou_thr=0.45):
    """Simple NMS — boxes is (N,4) float32, scores is (N,) float32."""
    order = scores.argsort()[::-1]
    keep  = []
    while order.size:
        i = order[0]
        keep.append(i)
        ious = np.array([_iou(boxes[i], boxes[j]) for j in order[1:]])
        order = order[1:][ious < iou_thr]
    return keep


def _preprocess(rgb_np, size=640):
    """RGB HWC uint8 → torch NCHW float32 [0,1], returns (tensor, scale, pad_x, pad_y)."""
    h, w = rgb_np.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = int(w * scale), int(h * scale)
    pil = PILImage.fromarray(rgb_np, 'RGB').resize((nw, nh), PILImage.BILINEAR)
    canvas = PILImage.new('RGB', (size, size), (114, 114, 114))
    px = (size - nw) // 2
    py = (size - nh) // 2
    canvas.paste(pil, (px, py))
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    t   = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
    return t, scale, px, py


def _postprocess(preds, scale, pad_x, pad_y, orig_w, orig_h,
                 conf_thr=0.45, iou_thr=0.45, target_ids=None):
    """
    preds: torch.Tensor [1, 84, 8400]  (cx,cy,w,h, 80 class scores)
    Returns list of dicts: {class_id, class_name, score, bbox_px [x1,y1,x2,y2]}
    """
    p = preds[0].cpu().numpy()   # 84 × 8400
    p = p.T                       # 8400 × 84
    cx, cy, bw, bh = p[:, 0], p[:, 1], p[:, 2], p[:, 3]
    cls_scores = p[:, 4:]         # 8400 × 80

    max_cls = cls_scores.max(axis=1)
    max_id  = cls_scores.argmax(axis=1)
    mask    = max_cls >= conf_thr

    if target_ids is not None:
        mask &= np.isin(max_id, target_ids)

    cx = cx[mask]; cy = cy[mask]
    bw = bw[mask]; bh = bh[mask]
    scores  = max_cls[mask]
    cls_ids = max_id[mask]

    if len(scores) == 0:
        return []

    # Convert to pixel coords (undo letterbox padding + scale)
    x1 = ((cx - bw / 2) - pad_x) / scale
    y1 = ((cy - bh / 2) - pad_y) / scale
    x2 = ((cx + bw / 2) - pad_x) / scale
    y2 = ((cy + bh / 2) - pad_y) / scale

    x1 = np.clip(x1, 0, orig_w); x2 = np.clip(x2, 0, orig_w)
    y1 = np.clip(y1, 0, orig_h); y2 = np.clip(y2, 0, orig_h)
    boxes_arr = np.stack([x1, y1, x2, y2], axis=1).astype(np.float32)

    keep = _nms(boxes_arr, scores.astype(np.float32), iou_thr)
    results = []
    for idx in keep:
        cid  = int(cls_ids[idx])
        name = COCO_NAMES.get(cid, str(cid))
        results.append({
            'class_id':   cid,
            'class_name': name,
            'score':      float(scores[idx]),
            'bbox_px':    [float(boxes_arr[idx, 0]), float(boxes_arr[idx, 1]),
                           float(boxes_arr[idx, 2]), float(boxes_arr[idx, 3])],
        })
    return results


def _annotate(rgb_np, detections):
    """Draw bounding boxes + labels on a PIL image, return JPEG bytes."""
    img  = PILImage.fromarray(rgb_np, 'RGB')
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default()
    except Exception:
        font = None

    for det in detections:
        x1, y1, x2, y2 = det['bbox_px']
        name   = det['class_name']
        score  = det['score']
        color  = BOX_COLORS.get(name, BOX_COLORS['default'])
        draw.rectangle([x1, y1, x2, y2], outline=color, width=2)
        label  = f'{name} {score:.2f}'
        draw.rectangle([x1, y1 - 14, x1 + len(label) * 7, y1], fill=color)
        draw.text((x1 + 2, y1 - 13), label, fill=(255, 255, 255), font=font)

    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=75)
    return buf.getvalue()


def _jpeg_to_image_msg(jpeg_bytes, frame_id, stamp):
    """Wrap JPEG bytes as a sensor_msgs/Image (bgr8 encoding for compatibility)."""
    msg = Image()
    msg.header.stamp    = stamp
    msg.header.frame_id = frame_id
    pil = PILImage.open(io.BytesIO(jpeg_bytes)).convert('RGB')
    arr = np.asarray(pil, dtype=np.uint8)
    msg.height   = arr.shape[0]
    msg.width    = arr.shape[1]
    msg.encoding = 'rgb8'
    msg.step     = arr.shape[1] * 3
    msg.data     = arr.tobytes()
    return msg


class DetectorNode(Node):
    def __init__(self):
        super().__init__('detector_node')

        self.declare_parameter('model_path',           '/opt/cobot/models/yolov8n.pt')
        self.declare_parameter('confidence_threshold', 0.35)
        self.declare_parameter('nms_threshold',        0.45)
        self.declare_parameter('device',               'cuda:0')

        self._pt_path   = self.get_parameter('model_path').value
        self._conf_thr  = self.get_parameter('confidence_threshold').value
        self._nms_thr   = self.get_parameter('nms_threshold').value
        self._device    = self.get_parameter('device').value

        self._model     = None
        self._names     = {}
        self._ready     = False
        self._det_id    = 0

        self._det_pub  = self.create_publisher(String, '/perception/detections',     10)
        self._ann_pub  = self.create_publisher(Image,  '/perception/annotated_image', 10)

        self.create_subscription(Image, '/cam0/cam0/color/image_raw',         self._on_rgb,   5)
        self.create_subscription(Image, '/cam0/cam0/aligned_depth_to_color/image_raw',
                                 self._on_depth, 5)
        self.create_subscription(CameraInfo, '/cam0/cam0/color/camera_info',
                                 self._on_camera_info, 1)

        self._depth_arr = None
        self._depth_fx  = 615.0
        self._depth_fy  = 615.0
        self._depth_cx  = 320.0
        self._depth_cy  = 240.0
        self._intrinsics_set = False

        self._last_log  = time.time()
        self._frame_cnt = 0

        threading.Thread(target=self._load, daemon=True).start()
        self.get_logger().info('detector_node starting (model load in background)')

    # ── Model loading ──────────────────────────────────────────────────────────
    def _load(self):
        if not TORCH_OK or not PIL_OK:
            self.get_logger().error('torch or PIL not available')
            return
        try:
            from ultralytics import YOLO
            engine_path = self._pt_path.replace('.pt', '.engine')
            loaded_path = self._pt_path
            model = None

            # Try TRT engine first; validate that model.model is a usable nn.Module
            if os.path.exists(engine_path):
                try:
                    m = YOLO(engine_path)
                    net_test = m.model
                    net_test.eval()  # raises if TRT returns a non-Module (e.g. str)
                    model = m
                    loaded_path = engine_path
                    self.get_logger().info(f'TRT engine validated: {engine_path}')
                except Exception as e:
                    self.get_logger().warn(f'TRT engine unusable ({e}), falling back to .pt')

            if model is None:
                model = YOLO(self._pt_path)

            self._names = model.names
            net = model.model
            net.eval()
            if torch.cuda.is_available():
                net = net.to(self._device)
            self._model = net
            self._ready = True
            self.get_logger().info(
                f'YOLOv8 loaded from {loaded_path} on {self._device} — {len(self._names)} classes')
        except Exception as e:
            self.get_logger().error(f'Model load failed: {e}')

    # ── ROS callbacks ──────────────────────────────────────────────────────────
    def _on_camera_info(self, msg):
        if not self._intrinsics_set:
            k = msg.k  # row-major 3x3
            self._depth_fx = float(k[0])
            self._depth_fy = float(k[4])
            self._depth_cx = float(k[2])
            self._depth_cy = float(k[5])
            self._intrinsics_set = True

    def _on_depth(self, msg):
        try:
            enc = msg.encoding
            raw = bytes(msg.data)
            h, w = msg.height, msg.width
            if enc in ('16UC1', 'mono16'):
                arr = np.frombuffer(raw, dtype=np.uint16).reshape(h, w).astype(np.float32)
                self._depth_arr = arr / 1000.0
            elif enc == '32FC1':
                self._depth_arr = np.frombuffer(raw, dtype=np.float32).reshape(h, w).copy()
        except Exception:
            pass

    def _on_rgb(self, msg):
        if not self._ready:
            return
        try:
            enc = msg.encoding
            raw = bytes(msg.data)
            h, w = msg.height, msg.width

            if enc == 'rgb8':
                rgb = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            elif enc == 'bgr8':
                bgr = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
                rgb = bgr[:, :, ::-1].copy()
            elif enc == 'mono8':
                gray = np.frombuffer(raw, dtype=np.uint8).reshape(h, w)
                rgb  = np.stack([gray, gray, gray], axis=2)
            else:
                return

            self._infer(rgb, msg.header.stamp)
        except Exception as e:
            self.get_logger().warn(f'rgb decode: {e}')

    # ── Inference ──────────────────────────────────────────────────────────────
    def _infer(self, rgb_np, stamp):
        try:
            t, scale, pad_x, pad_y = _preprocess(rgb_np)
            t = t.to(self._device)

            with torch.no_grad():
                preds = self._model(t)

            raw_preds = preds[0] if isinstance(preds, (list, tuple)) else preds
            h, w = rgb_np.shape[:2]
            dets = _postprocess(raw_preds, scale, pad_x, pad_y, w, h,
                                self._conf_thr, self._nms_thr)

            # Enrich with depth
            for det in dets:
                x1, y1, x2, y2 = det['bbox_px']
                cx = int((x1 + x2) / 2)
                cy = int((y1 + y2) / 2)
                depth_m = self._sample_depth(cx, cy)
                pos_3d  = self._deproject(cx, cy, depth_m)
                det['id']         = self._det_id
                det['depth_m']    = depth_m
                det['pos_3d']     = pos_3d
                det['distance_m'] = round(math.sqrt(sum(v**2 for v in pos_3d)), 3)
                det['pickable']   = det['class_name'] not in ('person',) and depth_m < 1.5
                det['timestamp']  = time.time()
                self._det_id += 1

            # Publish detection JSON
            payload = json.dumps({'detections': dets, 'count': len(dets)})
            smsg = String(); smsg.data = payload
            self._det_pub.publish(smsg)

            # Publish annotated image
            if self._ann_pub.get_subscription_count() > 0 or True:
                jpeg = _annotate(rgb_np, dets)
                imsg = _jpeg_to_image_msg(jpeg, 'cam0_link', stamp)
                self._ann_pub.publish(imsg)

            self._frame_cnt += 1
            now = time.time()
            if now - self._last_log >= 2.0:
                fps = self._frame_cnt / (now - self._last_log)
                self.get_logger().info(
                    f'[detector] {len(dets)} dets  {fps:.1f} fps')
                self._frame_cnt = 0
                self._last_log  = now

        except Exception as e:
            self.get_logger().warn(f'infer: {e}')

    def _sample_depth(self, px, py):
        d = self._depth_arr
        if d is None:
            return 1.0
        h, w = d.shape
        px = max(0, min(px, w - 1))
        py = max(0, min(py, h - 1))
        val = float(d[py, px])
        if not math.isfinite(val) or val <= 0:
            return 1.0
        return round(val, 3)

    def _deproject(self, px, py, depth_m):
        x = (px - self._depth_cx) * depth_m / self._depth_fx
        y = (py - self._depth_cy) * depth_m / self._depth_fy
        return [round(x, 3), round(y, 3), round(depth_m, 3)]


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


if __name__ == '__main__':
    main()
