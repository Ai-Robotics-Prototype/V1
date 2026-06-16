#!/usr/bin/env python3
"""nanoowl_node — Open-vocabulary part detection on /cam0/cam0/color/image_raw.

Subscribes to the D435i color stream, runs NanoOWL's OWL-ViT detector against a
runtime-mutable list of text prompts, fetches depth at each box center from
/cam0/cam0/aligned_depth_to_color/image_raw + camera_info, and publishes
detections (with an APPROXIMATE 3D point from D435i depth) as
JSON-over-std_msgs/String on /perception/openvocab_detections.

Prompts are mutable at runtime via a std_msgs/String JSON message on
/perception/openvocab/prompts ({"prompts": ["metal bracket", ...]}). The
dashboard pushes this whenever the operator edits the prompt list.

Stale-frame detection: if no color frame arrives for >2.0s, the node publishes
{"stalled": true, ...} so the dashboard can surface a "camera stalled" banner.

INTENTIONAL LIMITS (label honestly):
  - D435i aligned depth is COARSE and sparse near object edges. The published
    `approx_xyz_cam` is a single-pixel depth lookup at the box center, not a
    pick-grade 6DOF pose. The dashboard labels this "approx (D435i)".
  - We run on the PyTorch path (no TRT engine); expect 5-15 FPS on Orin.
  - Sampling: process every Nth color frame (default N=3 ~= 10 Hz inference)
    to keep CPU+GPU headroom for the rest of the stack.

Configuration via ROS params (or the override yaml in /etc/):
  color_topic              /cam0/cam0/color/image_raw
  depth_topic              /cam0/cam0/aligned_depth_to_color/image_raw
  caminfo_topic            /cam0/cam0/color/camera_info
  output_topic             /perception/openvocab_detections
  prompts_topic            /perception/openvocab/prompts
  initial_prompts          comma-separated list (default empty)
  process_every_nth        3
  conf_threshold           0.10
  stalled_after_s          2.0
  model_name               google/owlvit-base-patch32
"""

from __future__ import annotations

import json
import time
import threading
from typing import List, Optional, Tuple

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import Image, CameraInfo
from std_msgs.msg import String


# Heavy ML imports are deferred until after rclpy.init() so import errors
# surface as a clear log line + status message rather than a silent crash
# before the publishers exist.
_torch = None
_transformers = None
_owl_model = None
_owl_processor = None
_owl_device = 'cpu'


def _lazy_load_owl(model_name: str, logger):
    """Import torch + transformers + OWL-ViT exactly once. Raise on failure."""
    global _torch, _transformers, _owl_model, _owl_processor, _owl_device
    if _owl_model is not None:
        return
    import torch  # noqa: WPS433
    from transformers import OwlViTProcessor, OwlViTForObjectDetection  # noqa: WPS433
    _torch = torch
    _transformers = (OwlViTProcessor, OwlViTForObjectDetection)
    _owl_device = 'cuda' if torch.cuda.is_available() else 'cpu'
    logger.info(f'NanoOWL loading {model_name} on {_owl_device}…')
    _owl_processor = OwlViTProcessor.from_pretrained(model_name)
    _owl_model = OwlViTForObjectDetection.from_pretrained(model_name).to(_owl_device)
    _owl_model.eval()
    logger.info(f'NanoOWL ready (device={_owl_device})')


def _decode_image_rgb(msg: Image) -> Optional[np.ndarray]:
    """Decode sensor_msgs/Image (rgb8 or bgr8 or 16UC1) to a uint8 HxWx3 RGB
    array. Returns None on unrecognised encoding."""
    enc = (msg.encoding or '').lower()
    if enc in ('rgb8', 'bgr8'):
        arr = np.frombuffer(bytes(msg.data), dtype=np.uint8) \
                .reshape(msg.height, msg.width, 3)
        if enc == 'bgr8':
            arr = arr[..., ::-1]
        return arr.copy()
    if enc == 'rgba8':
        arr = np.frombuffer(bytes(msg.data), dtype=np.uint8) \
                .reshape(msg.height, msg.width, 4)[..., :3]
        return arr.copy()
    return None


def _decode_depth_uint16_mm(msg: Image) -> Optional[np.ndarray]:
    if msg.encoding != '16UC1':
        return None
    arr = np.frombuffer(bytes(msg.data), dtype=np.uint16) \
            .reshape(msg.height, msg.width)
    return arr


def _approx_xyz_from_depth(depth_mm: np.ndarray, fx: float, fy: float,
                           cx: float, cy: float,
                           u: int, v: int) -> Optional[Tuple[float, float, float]]:
    """Sample a 5x5 median around (u,v) for robustness; reject if all zero."""
    h, w = depth_mm.shape
    u0 = max(0, u - 2); u1 = min(w, u + 3)
    v0 = max(0, v - 2); v1 = min(h, v + 3)
    patch = depth_mm[v0:v1, u0:u1]
    valid = patch[patch > 0]
    if valid.size == 0:
        return None
    z_m = float(np.median(valid)) / 1000.0
    x_m = (u - cx) * z_m / fx
    y_m = (v - cy) * z_m / fy
    return (x_m, y_m, z_m)


class NanoOWLNode(Node):
    def __init__(self):
        super().__init__('nanoowl_node')

        self.declare_parameter('color_topic',       '/cam0/cam0/color/image_raw')
        self.declare_parameter('depth_topic',       '/cam0/cam0/aligned_depth_to_color/image_raw')
        self.declare_parameter('caminfo_topic',     '/cam0/cam0/color/camera_info')
        self.declare_parameter('output_topic',      '/perception/openvocab_detections')
        self.declare_parameter('prompts_topic',     '/perception/openvocab/prompts')
        self.declare_parameter('initial_prompts',   '')
        self.declare_parameter('process_every_nth', 3)
        self.declare_parameter('conf_threshold',    0.10)
        self.declare_parameter('stalled_after_s',   2.0)
        self.declare_parameter('model_name',        'google/owlvit-base-patch32')

        def p(name): return self.get_parameter(name).value
        self.color_topic     = str(p('color_topic'))
        self.depth_topic     = str(p('depth_topic'))
        self.caminfo_topic   = str(p('caminfo_topic'))
        self.output_topic    = str(p('output_topic'))
        self.prompts_topic   = str(p('prompts_topic'))
        self.process_n       = max(1, int(p('process_every_nth')))
        self.conf_threshold  = float(p('conf_threshold'))
        self.stalled_after   = float(p('stalled_after_s'))
        self.model_name      = str(p('model_name'))

        initial = str(p('initial_prompts') or '')
        self.prompts: List[str] = [t.strip() for t in initial.split(',') if t.strip()]

        self._lock = threading.Lock()
        self._latest_color: Optional[np.ndarray] = None
        self._latest_color_stamp: float = 0.0
        self._latest_depth: Optional[np.ndarray] = None
        self._latest_caminfo: Optional[CameraInfo] = None
        self._frame_seq = 0
        self._proc_seq = 0
        self._inference_ms = 0.0
        self._fps_window: List[float] = []
        self._last_publish_t = time.time()
        self._stalled = False
        self._model_ready = False
        self._model_error: Optional[str] = None

        self.create_subscription(Image,      self.color_topic,
                                 self._on_color,    qos_profile_sensor_data)
        self.create_subscription(Image,      self.depth_topic,
                                 self._on_depth,    qos_profile_sensor_data)
        self.create_subscription(CameraInfo, self.caminfo_topic,
                                 self._on_caminfo,  qos_profile_sensor_data)
        self.create_subscription(String,     self.prompts_topic,
                                 self._on_prompts,  10)

        self.det_pub = self.create_publisher(String, self.output_topic, 5)

        # 10 Hz inference timer + 2 Hz watchdog so a frozen camera surfaces
        # even when no new color frames arrive to trigger _on_color.
        self.create_timer(0.10, self._tick_infer)
        self.create_timer(0.50, self._tick_watchdog)

        self.get_logger().info(
            f'nanoowl_node booting. model={self.model_name} '
            f'color={self.color_topic} depth={self.depth_topic} '
            f'process_every_nth={self.process_n} '
            f'initial_prompts={self.prompts}')

        # Load the model from the same thread; emit a clear failure status
        # if it can't be loaded so the dashboard surfaces it.
        try:
            _lazy_load_owl(self.model_name, self.get_logger())
            self._model_ready = True
        except Exception as e:
            self._model_error = str(e)
            self.get_logger().error(f'NanoOWL model load failed: {e}')

    # ── subscriptions ─────────────────────────────────────────────────

    def _on_color(self, msg: Image):
        arr = _decode_image_rgb(msg)
        if arr is None:
            return
        with self._lock:
            self._latest_color = arr
            self._latest_color_stamp = time.time()
            self._frame_seq += 1
            self._stalled = False

    def _on_depth(self, msg: Image):
        arr = _decode_depth_uint16_mm(msg)
        if arr is None:
            return
        with self._lock:
            self._latest_depth = arr

    def _on_caminfo(self, msg: CameraInfo):
        with self._lock:
            self._latest_caminfo = msg

    def _on_prompts(self, msg: String):
        try:
            j = json.loads(msg.data) if msg.data else {}
        except Exception:
            return
        prompts = j.get('prompts')
        if isinstance(prompts, list):
            cleaned = [str(x).strip() for x in prompts if str(x).strip()]
            with self._lock:
                if cleaned != self.prompts:
                    self.prompts = cleaned
                    self.get_logger().info(f'prompts updated → {self.prompts}')

    # ── watchdog ──────────────────────────────────────────────────────

    def _tick_watchdog(self):
        with self._lock:
            now = time.time()
            stalled = (now - self._latest_color_stamp) > self.stalled_after \
                      if self._latest_color_stamp > 0 else True
            self._stalled = stalled
        # When stalled, publish a status frame so the dashboard refreshes
        # the banner. Empty detections list keeps the overlay clean.
        if stalled:
            self._publish_status(detections=[], stalled=True)

    # ── inference ─────────────────────────────────────────────────────

    def _tick_infer(self):
        if not self._model_ready:
            self._publish_status(detections=[], stalled=False,
                                 error=self._model_error or 'model not loaded')
            return
        with self._lock:
            seq = self._frame_seq
            img = self._latest_color
            depth = self._latest_depth
            caminfo = self._latest_caminfo
            prompts = list(self.prompts)
            stamp = self._latest_color_stamp
            stalled = self._stalled
        # Frame-rate gate
        if img is None or not prompts or stalled:
            if not prompts and img is not None:
                self._publish_status(detections=[], stalled=False)
            return
        # Sample at process_every_nth
        if seq == self._proc_seq:
            return
        if (seq - self._proc_seq) < self.process_n:
            return
        self._proc_seq = seq

        t0 = time.monotonic()
        detections = self._run_owlvit(img, prompts, depth, caminfo)
        self._inference_ms = (time.monotonic() - t0) * 1000.0
        # Rolling FPS over the last 10 inferences
        now = time.time()
        self._fps_window.append(now)
        self._fps_window = [t for t in self._fps_window if now - t <= 5.0]
        self._publish_status(detections=detections, stalled=False)

    def _run_owlvit(self, img_rgb: np.ndarray, prompts: List[str],
                    depth: Optional[np.ndarray],
                    caminfo: Optional[CameraInfo]) -> list:
        torch = _torch
        OwlViTProcessor, _ = _transformers  # noqa: F841
        proc = _owl_processor
        model = _owl_model
        from PIL import Image as PILImage
        pil = PILImage.fromarray(img_rgb)
        with torch.no_grad():
            inputs = proc(text=[prompts], images=pil, return_tensors='pt').to(_owl_device)
            outputs = model(**inputs)
            target_sizes = torch.tensor([pil.size[::-1]], device=_owl_device)
            results = proc.post_process_object_detection(
                outputs=outputs, target_sizes=target_sizes,
                threshold=self.conf_threshold)
        r0 = results[0]
        boxes  = r0['boxes'].cpu().numpy()
        scores = r0['scores'].cpu().numpy()
        labels = r0['labels'].cpu().numpy()

        fx = fy = cx = cy = None
        if caminfo is not None:
            try:
                fx = float(caminfo.k[0]); fy = float(caminfo.k[4])
                cx = float(caminfo.k[2]); cy = float(caminfo.k[5])
            except Exception:
                pass

        out = []
        for box, score, label in zip(boxes, scores, labels):
            x1, y1, x2, y2 = [int(round(v)) for v in box.tolist()]
            cx_px = (x1 + x2) // 2
            cy_px = (y1 + y2) // 2
            entry = {
                'prompt': prompts[int(label)] if 0 <= int(label) < len(prompts) else '?',
                'confidence': float(score),
                'bbox_px':    {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
                'center_px':  {'x': cx_px, 'y': cy_px},
                'approx_xyz_cam': None,
                'approx_xyz_source': 'd435i_aligned_depth',
            }
            if depth is not None and fx is not None and fy is not None:
                xyz = _approx_xyz_from_depth(depth, fx, fy, cx, cy, cx_px, cy_px)
                if xyz is not None:
                    entry['approx_xyz_cam'] = {'x': xyz[0], 'y': xyz[1], 'z': xyz[2]}
            out.append(entry)
        # sort highest-confidence first
        out.sort(key=lambda d: d['confidence'], reverse=True)
        return out

    # ── publishing ────────────────────────────────────────────────────

    def _publish_status(self, detections, stalled, error: Optional[str] = None):
        now = time.time()
        fps = (len(self._fps_window) / 5.0) if self._fps_window else 0.0
        payload = {
            'stalled':        bool(stalled),
            'error':          error,
            'model':          self.model_name,
            'device':         _owl_device,
            'prompts':        list(self.prompts),
            'inference_ms':   round(self._inference_ms, 2),
            'fps':            round(fps, 2),
            'detections':     detections,
            'image_topic':    self.color_topic,
            'image_w':        self._latest_color.shape[1] if self._latest_color is not None else 0,
            'image_h':        self._latest_color.shape[0] if self._latest_color is not None else 0,
            'stale_after_s':  self.stalled_after,
            'frame_age_s':    round(now - self._latest_color_stamp, 2) if self._latest_color_stamp else None,
        }
        self.det_pub.publish(String(data=json.dumps(payload)))


def main():
    rclpy.init()
    try:
        node = NanoOWLNode()
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        rclpy.shutdown()


if __name__ == '__main__':
    main()
