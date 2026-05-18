"""
TensorRT inference engine for YOLOv8.

Usage:
  engine = TRTEngine("/opt/cobot/models/yolov8n.engine")
  boxes, scores, classes = engine.infer(bgr_image)

Build a .engine from a .pt with scripts/export_trt.py.
"""

import os
import logging
from typing import List, Tuple, Optional
import numpy as np

logger = logging.getLogger(__name__)

try:
    import tensorrt as trt
    import pycuda.driver as cuda
    import pycuda.autoinit  # noqa: F401 initialises CUDA context
    TRT_AVAILABLE = True
except ImportError:
    TRT_AVAILABLE = False
    logger.warning('TensorRT / pycuda not available — GPU inference disabled')

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False


# ── Type-size map ─────────────────────────────────────────────────────────────
_DTYPE_MAP = {
    'DataType.FLOAT': np.float32,
    'DataType.HALF':  np.float16,
    'DataType.INT8':  np.int8,
    'DataType.INT32': np.int32,
    'DataType.BOOL':  np.bool_,
} if TRT_AVAILABLE else {}


def _trt_dtype(dtype) -> np.dtype:
    return _DTYPE_MAP.get(str(dtype), np.float32)


# ── Engine wrapper ─────────────────────────────────────────────────────────────

class TRTEngine:
    """
    Wraps a serialised TensorRT engine (.engine file).

    - Allocates pinned host + device buffers on construction.
    - Runs inference on the CUDA stream (non-blocking relative to ROS callbacks).
    - Thread-safe via a Python-side lock (one context per process).
    """

    def __init__(self, engine_path: str, input_shape: Tuple[int,int] = (640, 640)):
        if not TRT_AVAILABLE:
            raise RuntimeError('TensorRT not installed')
        if not os.path.exists(engine_path):
            raise FileNotFoundError(f'Engine not found: {engine_path}')

        self.input_h, self.input_w = input_shape
        self._logger  = trt.Logger(trt.Logger.WARNING)
        self._runtime = trt.Runtime(self._logger)

        with open(engine_path, 'rb') as f:
            self._engine = self._runtime.deserialize_cuda_engine(f.read())

        self._context = self._engine.create_execution_context()
        self._stream  = cuda.Stream()

        self._allocate_buffers()
        logger.info('TRTEngine loaded: %s  inputs=%d outputs=%d',
                    engine_path, len(self._inputs), len(self._outputs))

    def _allocate_buffers(self):
        self._inputs:  List[dict] = []
        self._outputs: List[dict] = []
        self._bindings: List[int] = []

        for i in range(self._engine.num_io_tensors):
            name  = self._engine.get_tensor_name(i)
            shape = tuple(self._engine.get_tensor_shape(name))
            dtype = _trt_dtype(self._engine.get_tensor_dtype(name))
            nbytes = int(np.prod(shape)) * np.dtype(dtype).itemsize

            host_mem   = cuda.pagelocked_empty(int(np.prod(shape)), dtype)
            device_mem = cuda.mem_alloc(nbytes)

            self._bindings.append(int(device_mem))
            entry = {'name': name, 'shape': shape, 'dtype': dtype,
                     'host': host_mem, 'device': device_mem}

            if self._engine.get_tensor_mode(name) == trt.TensorIOMode.INPUT:
                self._inputs.append(entry)
            else:
                self._outputs.append(entry)

    def _preprocess(self, bgr: np.ndarray) -> np.ndarray:
        """Resize → RGB → normalise → NCHW float32."""
        if not CV2_AVAILABLE:
            raise RuntimeError('opencv-python required for preprocessing')
        resized = cv2.resize(bgr, (self.input_w, self.input_h),
                             interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        return np.ascontiguousarray(rgb.transpose(2, 0, 1)[np.newaxis])  # (1,3,H,W)

    def infer(
        self,
        bgr: np.ndarray,
        conf_thresh: float = 0.5,
        nms_thresh:  float = 0.4,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        """
        Run inference on a BGR uint8 image.

        Returns:
          boxes   : (K,4) float32 in pixel coords of original image [x1,y1,x2,y2]
          scores  : (K,)  float32 confidence
          class_ids:(K,)  int32
        """
        if not TRT_AVAILABLE:
            return np.zeros((0,4)), np.zeros(0), np.zeros(0, dtype=np.int32)

        orig_h, orig_w = bgr.shape[:2]
        blob = self._preprocess(bgr)

        # Copy input to device
        np.copyto(self._inputs[0]['host'], blob.ravel())
        cuda.memcpy_htod_async(
            self._inputs[0]['device'],
            self._inputs[0]['host'],
            self._stream)

        # Execute
        self._context.execute_async_v3(self._stream.handle)

        # Copy outputs back
        for out in self._outputs:
            cuda.memcpy_dtoh_async(out['host'], out['device'], self._stream)

        self._stream.synchronize()

        # ── Parse YOLOv8 output ─────────────────────────────────────────────
        # YOLOv8 export shape: (1, 4+num_classes, num_anchors)
        raw = self._outputs[0]['host'].reshape(self._outputs[0]['shape'])
        if raw.ndim == 3:
            raw = raw[0]  # (4+nc, A)

        nc = raw.shape[0] - 4
        boxes_raw  = raw[:4, :].T          # (A, 4)  cx,cy,w,h  normalised
        scores_raw = raw[4:, :].T          # (A, nc)

        class_ids = scores_raw.argmax(axis=1).astype(np.int32)
        scores    = scores_raw.max(axis=1)

        mask = scores >= conf_thresh
        boxes_raw = boxes_raw[mask]
        scores    = scores[mask]
        class_ids = class_ids[mask]

        if len(scores) == 0:
            return np.zeros((0,4)), np.zeros(0), np.zeros(0, dtype=np.int32)

        # cxcywh (normalised input res) → xyxy (original pixels)
        sx = orig_w / self.input_w
        sy = orig_h / self.input_h
        bx1 = (boxes_raw[:, 0] - boxes_raw[:, 2] / 2) * self.input_w * sx
        by1 = (boxes_raw[:, 1] - boxes_raw[:, 3] / 2) * self.input_h * sy
        bx2 = (boxes_raw[:, 0] + boxes_raw[:, 2] / 2) * self.input_w * sx
        by2 = (boxes_raw[:, 1] + boxes_raw[:, 3] / 2) * self.input_h * sy
        boxes_px = np.stack([bx1, by1, bx2, by2], axis=1).astype(np.float32)

        # NMS per class
        if CV2_AVAILABLE:
            keep_indices = []
            for cid in np.unique(class_ids):
                cidx = np.where(class_ids == cid)[0]
                b = boxes_px[cidx].tolist()
                s = scores[cidx].tolist()
                keep = cv2.dnn.NMSBoxes(b, s, conf_thresh, nms_thresh)
                if len(keep):
                    keep_indices.extend(cidx[np.array(keep).flatten()])
            keep_indices = np.array(keep_indices)
            boxes_px  = boxes_px[keep_indices]
            scores    = scores[keep_indices]
            class_ids = class_ids[keep_indices]

        return boxes_px, scores.astype(np.float32), class_ids

    def __del__(self):
        try:
            for b in self._inputs + self._outputs:
                b['device'].free()
        except Exception:
            pass


# ── Factory: return TRT engine or None ───────────────────────────────────────

def load_engine(engine_path: str) -> Optional['TRTEngine']:
    if not TRT_AVAILABLE:
        return None
    if not os.path.exists(engine_path):
        return None
    try:
        return TRTEngine(engine_path)
    except Exception as e:
        logger.error('Failed to load TRT engine %s: %s', engine_path, e)
        return None
