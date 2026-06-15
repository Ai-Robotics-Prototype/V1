"""MotionCam-3D Color S+ integration for the dashboard.

Self-contained module: real ROS2 subscriptions when the Photoneo driver
publishes, otherwise a synthetic data generator that lets the UI be
exercised end-to-end before the camera physically arrives.

Public surface (imported by dashboard_server):
    MotionCamState  — thread-safe latest-frame snapshot + scene accumulator
    SyntheticSource — synthesizes live point clouds + recognized parts
    pack_cloud_payload(frame)         -> bytes  for /ws/motioncam_cloud
    pack_recognition_payload(items)   -> str    for /ws/motioncam_recognition
    DEFAULT_TOPIC_CONFIG              — overrideable real-camera topic names

The real source is wired in dashboard_server's DashboardServer node via
the topics in DEFAULT_TOPIC_CONFIG. If those topics are silent we fall
back to "not connected" — the synthetic source is enabled separately by
the dashboard's mock_enabled flag.
"""
from __future__ import annotations

import math
import random
import struct
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# Defaults follow the standard phoxi_camera ROS topic layout. Override at
# runtime via /api/motioncam/topics if Photoneo confirms different names.
DEFAULT_TOPIC_CONFIG: Dict[str, str] = {
    "points":     "/photoneo_center/pointcloud",
    "color":      "/photoneo_center/color_image",
    "depth":      "/photoneo_center/depth_map",
    "confidence": "/photoneo_center/confidence_map",
    "normals":    "/photoneo_center/normal_map",
}


# ---------------------------------------------------------------------------
# Frame packing
# ---------------------------------------------------------------------------

# Wire format for /ws/motioncam_cloud (binary):
#   header (24 bytes)
#     uint32 magic = 0x4D43414D  ("MCAM")
#     uint32 version = 1
#     uint32 n_points
#     uint32 flags         (bit0 = has_color, bit1 = has_confidence)
#     float32 fps
#     float32 mean_conf_mm
#   payload (n_points float32 triplets XYZ in metres)
#     n_points * 12 bytes
#   optional colors (if flags bit0)
#     n_points * 3 bytes  (RGB uint8)
#   optional confidence (if flags bit1)
#     n_points * 4 bytes  (float32 mm)
_MAGIC = 0x4D43414D


def pack_cloud_payload(frame: Dict[str, Any]) -> bytes:
    pts  = frame.get("points")
    cols = frame.get("colors")
    conf = frame.get("confidence")
    fps  = float(frame.get("fps", 0.0))
    mean_conf = float(frame.get("mean_conf_mm", 0.0))
    if pts is None:
        return struct.pack("<IIIIff", _MAGIC, 1, 0, 0, fps, mean_conf)
    # Caller-provided n wins; only infer it for typed sequences (float
    # lists / ndarrays). Treating raw bytes as `len(pts) // 3` gives the
    # byte count divided by three, which is 4x the real point count.
    n = frame.get("n")
    if n is None:
        if isinstance(pts, (bytes, bytearray, memoryview)):
            n = len(pts) // 12     # 3 floats per point
        else:
            n = len(pts) // 3
    n = int(n)
    flags = 0
    if cols is not None:
        col_len = len(cols)
        if col_len >= n * 3:
            flags |= 0x1
    if conf is not None:
        # Float confidence can be raw bytes (4 bytes per value) or a list.
        if isinstance(conf, (bytes, bytearray, memoryview)):
            if len(conf) >= n * 4:
                flags |= 0x2
        elif len(conf) >= n:
            flags |= 0x2
    head = struct.pack("<IIIIff", _MAGIC, 1, n, flags, fps, mean_conf)
    body = bytes(memoryview(pts).cast("B"))[: n * 12]
    out = [head, body]
    if flags & 0x1:
        out.append(bytes(memoryview(cols).cast("B"))[: n * 3])
    if flags & 0x2:
        out.append(bytes(memoryview(conf).cast("B"))[: n * 4])
    return b"".join(out)


def pack_recognition_payload(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Recognition results travel as JSON — small payloads, low rate."""
    return {"objects": list(items), "t": time.time()}


# ---------------------------------------------------------------------------
# State container
# ---------------------------------------------------------------------------

@dataclass
class _Frame:
    points: Any = None       # bytes or array of float32 XYZ (metres)
    colors: Any = None       # bytes/array uint8 RGB triples
    confidence: Any = None   # array float32 mm
    color_jpeg: Optional[bytes] = None
    depth_png:  Optional[bytes] = None
    n: int = 0
    fps: float = 0.0
    mean_conf_mm: float = 0.0
    mode: str = "camera"     # "camera" (dynamic) or "scanner" (static)
    t: float = 0.0


class MotionCamState:
    """Thread-safe holder for the latest MotionCam frame + accumulated scene."""

    SCENE_DIR = Path("/opt/cobot/scenes")
    # Browser-side cap. Server downsamples below this regardless of source.
    MAX_STREAM_POINTS = 120000
    # Voxel size for scene accumulation (metres).
    SCENE_VOXEL_M = 0.0025

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frame = _Frame()
        self._connected = False
        self._mock_enabled = False
        self._mock_last_real_ts = 0.0   # tracks when we last saw a real frame
        self._fps_window: List[float] = []

        self._scene_active = False
        self._scene_started_at: Optional[float] = None
        self._scene_points: List[float] = []      # flat XYZ
        self._scene_colors: List[int]   = []      # flat RGB uint8
        self._scene_frames = 0
        self._scene_voxel_index: Dict[Tuple[int, int, int], int] = {}

        self._mode = "camera"
        self._recognitions: List[Dict[str, Any]] = []
        self._topics = dict(DEFAULT_TOPIC_CONFIG)

    # ---- mode + mock toggle ----
    def set_mode(self, mode: str) -> None:
        if mode in ("camera", "scanner"):
            with self._lock:
                self._mode = mode

    def get_mode(self) -> str:
        with self._lock:
            return self._mode

    def set_mock(self, enabled: bool) -> None:
        with self._lock:
            self._mock_enabled = bool(enabled)
            if not enabled:
                # Drop the most recent synthetic frame so the UI doesn't
                # keep showing the simulated cloud when we toggle off.
                if not self._connected:
                    self._frame = _Frame()

    def get_mock(self) -> bool:
        with self._lock:
            return self._mock_enabled

    # ---- topic config ----
    def get_topics(self) -> Dict[str, str]:
        with self._lock:
            return dict(self._topics)

    def set_topics(self, topics: Dict[str, str]) -> None:
        with self._lock:
            for k, v in topics.items():
                if k in self._topics and isinstance(v, str) and v:
                    self._topics[k] = v

    # ---- ingest ----
    def update_real_frame(self, frame: _Frame) -> None:
        now = time.time()
        with self._lock:
            self._connected = True
            self._mock_last_real_ts = now
            # FPS averaged over a 10-frame sliding window.
            self._fps_window.append(now)
            if len(self._fps_window) > 10:
                self._fps_window.pop(0)
            if len(self._fps_window) >= 2:
                span = self._fps_window[-1] - self._fps_window[0]
                if span > 0:
                    frame.fps = (len(self._fps_window) - 1) / span
            frame.t = now
            frame.mode = self._mode
            self._frame = frame
            if self._scene_active:
                self._fuse_into_scene(frame)

    def update_mock_frame(self, frame: _Frame) -> None:
        with self._lock:
            if self._connected and time.time() - self._mock_last_real_ts < 1.0:
                return
            self._mock_enabled and None  # documented gate; caller checks too
            frame.t = time.time()
            frame.mode = self._mode
            self._frame = frame
            if self._scene_active:
                self._fuse_into_scene(frame)

    def update_recognitions(self, items: List[Dict[str, Any]]) -> None:
        with self._lock:
            self._recognitions = list(items or [])

    def mark_disconnected(self) -> None:
        with self._lock:
            self._connected = False
            self._fps_window.clear()

    # ---- queries ----
    def snapshot_frame(self) -> _Frame:
        with self._lock:
            return self._frame

    def snapshot_status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "connected":    bool(self._connected),
                "mock_enabled": bool(self._mock_enabled),
                "mode":         self._mode,
                "fps":          round(self._frame.fps, 1),
                "point_count":  int(self._frame.n),
                "mean_confidence_mm": round(self._frame.mean_conf_mm, 2),
                "scene": {
                    "active": self._scene_active,
                    "frames": self._scene_frames,
                    "points": len(self._scene_points) // 3,
                    "duration_s": (time.time() - self._scene_started_at)
                                   if self._scene_started_at else 0.0,
                },
            }

    def snapshot_recognitions(self) -> List[Dict[str, Any]]:
        with self._lock:
            return list(self._recognitions)

    # ---- scene control ----
    def scene_start(self) -> None:
        with self._lock:
            self._scene_active = True
            if self._scene_started_at is None:
                self._scene_started_at = time.time()

    def scene_stop(self) -> None:
        with self._lock:
            self._scene_active = False

    def scene_clear(self) -> None:
        with self._lock:
            self._scene_active = False
            self._scene_started_at = None
            self._scene_points = []
            self._scene_colors = []
            self._scene_voxel_index = {}
            self._scene_frames = 0

    def scene_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            pts = list(self._scene_points)
            cols = list(self._scene_colors)
            return {
                "points": pts,
                "colors": cols,
                "n": len(pts) // 3,
                "frames": self._scene_frames,
                "active": self._scene_active,
                "duration_s": (time.time() - self._scene_started_at)
                              if self._scene_started_at else 0.0,
            }

    def scene_save(self) -> Path:
        """Persist the accumulated scene cloud to disk.

        Writes a tiny JSON envelope plus a raw float32 XYZRGB binary so the
        next iteration can reload without serialising 100k+ floats as JSON.
        """
        import json as _json
        ts = time.strftime("%Y%m%d_%H%M%S")
        target = self.SCENE_DIR / ts
        target.mkdir(parents=True, exist_ok=True)
        with self._lock:
            pts  = list(self._scene_points)
            cols = list(self._scene_colors)
            frames = self._scene_frames
            duration = ((time.time() - self._scene_started_at)
                        if self._scene_started_at else 0.0)
        meta = {
            "n_points": len(pts) // 3,
            "frames": frames,
            "duration_s": duration,
            "voxel_size_m": self.SCENE_VOXEL_M,
            "saved_at": ts,
        }
        (target / "meta.json").write_text(_json.dumps(meta, indent=2))
        if pts:
            with (target / "cloud.bin").open("wb") as f:
                f.write(struct.pack("<I", len(pts) // 3))
                for v in pts:
                    f.write(struct.pack("<f", float(v)))
                for c in cols:
                    f.write(struct.pack("<B", int(c) & 0xFF))
        return target

    # ---- internal: scene fusion ----
    def _fuse_into_scene(self, frame: _Frame) -> None:
        """Voxel-downsampled accumulator. Caller holds self._lock."""
        v = self.SCENE_VOXEL_M
        pts_in  = frame.points
        cols_in = frame.colors
        if pts_in is None or frame.n == 0:
            return
        n = int(frame.n)
        # Normalise the buffer to a homogeneous sequence of floats. The
        # synthetic source emits raw bytes (struct-packed) for cheap WS
        # transport; real ROS frames can hand us a list/ndarray instead.
        if isinstance(pts_in, (bytes, bytearray, memoryview)):
            import struct as _st
            try:
                pts = _st.unpack("<%df" % (n * 3), bytes(pts_in)[: n * 12])
            except Exception:
                return
        else:
            pts = pts_in
        cols = None
        if cols_in is not None:
            if isinstance(cols_in, (bytes, bytearray, memoryview)):
                cols = bytes(cols_in)[: n * 3]
            else:
                cols = cols_in

        # Sample-iter — if the frame is huge we stride to keep the scene
        # accumulator from exploding on a single dump.
        stride = max(1, n // 30000)
        for i in range(0, n, stride):
            x = float(pts[i * 3])
            y = float(pts[i * 3 + 1])
            z = float(pts[i * 3 + 2])
            key = (int(x / v), int(y / v), int(z / v))
            if key in self._scene_voxel_index:
                continue
            idx = len(self._scene_points) // 3
            self._scene_voxel_index[key] = idx
            self._scene_points.extend((x, y, z))
            if cols is not None and len(cols) >= (i + 1) * 3:
                self._scene_colors.extend((cols[i * 3], cols[i * 3 + 1], cols[i * 3 + 2]))
            else:
                self._scene_colors.extend((200, 200, 200))
            # Hard cap to keep the browser usable. Coverage estimate
            # plateaus once the workspace is filled in anyway.
            if len(self._scene_points) // 3 >= 400000:
                break
        self._scene_frames += 1


# ---------------------------------------------------------------------------
# Synthetic source — replaces real MotionCam frames when mock_enabled is true
# ---------------------------------------------------------------------------

class SyntheticSource:
    """Generates a workspace-like point cloud + recognized parts.

    Scene: a flat table plane at z~0.91m (camera "sweet spot") plus a handful
    of simple box-shaped objects on top, each lightly jittered so the live
    view visibly updates. The "BT225L24_a" part walks on the table to also
    exercise the recognition overlay's pose-change path.
    """

    PLANE_WIDTH_M = 0.40
    PLANE_DEPTH_M = 0.30
    SAMPLES_PLANE = 9000
    Z_TABLE = 0.910

    def __init__(self) -> None:
        self._t0 = time.time()
        self._fps_window: List[float] = []
        random.seed(7)
        # Static object descriptors — positions in metres relative to the
        # plane centre (which sits at the camera frame's "sweet spot").
        self._objects = [
            {"id": 1, "name": "BT225L24_a", "match_source": "taught",
             "confidence": 0.91, "size": (0.060, 0.040, 0.030),
             "x0": -0.060, "y0": -0.020, "color": (220, 170, 60)},
            {"id": 2, "name": "BT225L24_a", "match_source": "taught",
             "confidence": 0.84, "size": (0.060, 0.040, 0.030),
             "x0":  0.080, "y0":  0.040, "color": (180, 200, 90)},
            {"id": 3, "name": "M6_bolt_hex", "match_source": "cad",
             "confidence": 0.72, "size": (0.020, 0.020, 0.045),
             "x0":  0.020, "y0": -0.060, "color": (160, 160, 180)},
            {"id": 4, "name": None, "match_source": None,
             "confidence": 0.42, "size": (0.025, 0.025, 0.025),
             "x0": -0.110, "y0":  0.080, "color": (140, 140, 145)},
        ]

    # ---- public ----
    def step(self) -> _Frame:
        now = time.time()
        t = now - self._t0

        pts: List[float]  = []
        cols: List[int]   = []
        conf: List[float] = []

        # Table plane samples (random scatter so it dithers a little each frame).
        for _ in range(self.SAMPLES_PLANE):
            x = (random.random() - 0.5) * self.PLANE_WIDTH_M
            y = (random.random() - 0.5) * self.PLANE_DEPTH_M
            z = self.Z_TABLE + random.gauss(0, 0.0006)   # 0.6 mm noise
            pts += (x, y, z)
            # Subtle wood-grain colour gradient.
            r = 180 + int(30 * math.sin(x * 25))
            g = 130 + int(20 * math.cos(y * 18))
            b = 70 + int(10 * math.sin((x + y) * 12))
            cols += (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
            conf.append(0.4 + random.random() * 0.2)     # 0.4-0.6 mm

        # Objects — one drifts so the recognition overlay also moves.
        recognitions: List[Dict[str, Any]] = []
        for obj in self._objects:
            ox = obj["x0"]
            oy = obj["y0"]
            if obj["id"] == 1:
                ox += 0.03 * math.sin(t * 0.7)
            sx, sy, sz = obj["size"]
            # Sample faces of the box (top + four sides) to look like a real
            # cluster. Bottom is on the table so we skip it.
            n_top   = 220
            n_side  = 80
            for _ in range(n_top):
                px = ox + (random.random() - 0.5) * sx
                py = oy + (random.random() - 0.5) * sy
                pz = self.Z_TABLE - sz   # box top above the table
                pts += (px, py, pz + random.gauss(0, 0.0004))
                cols += obj["color"]
                conf.append(0.45 + random.random() * 0.15)
            for face in range(4):
                for _ in range(n_side):
                    u = random.random() - 0.5
                    h = random.random() * sz
                    if face == 0:    px, py = ox + u * sx, oy + sy / 2
                    elif face == 1:  px, py = ox + u * sx, oy - sy / 2
                    elif face == 2:  px, py = ox + sx / 2, oy + u * sy
                    else:            px, py = ox - sx / 2, oy + u * sy
                    pz = self.Z_TABLE - h
                    pts += (px, py, pz + random.gauss(0, 0.0004))
                    cols += obj["color"]
                    conf.append(0.5 + random.random() * 0.2)
            # Emit recognition for the named objects (skip the unknown clutter,
            # which still appears in the cloud so the eye can pick it out).
            if obj["name"] and obj["confidence"] >= 0.5:
                recognitions.append(_make_recognition(obj, ox, oy, sx, sy, sz,
                                                     z_table=self.Z_TABLE))
            elif obj["confidence"] >= 0.3:
                recognitions.append(_make_recognition(obj, ox, oy, sx, sy, sz,
                                                     z_table=self.Z_TABLE,
                                                     tentative=True))

        # Convert to bytes for efficient packing. Python list-of-floats is fine
        # for ~12k points — keeps the mock generator dependency-free.
        # FPS estimate over a sliding window.
        self._fps_window.append(now)
        if len(self._fps_window) > 12:
            self._fps_window.pop(0)
        fps = 0.0
        if len(self._fps_window) >= 2:
            span = self._fps_window[-1] - self._fps_window[0]
            if span > 0:
                fps = (len(self._fps_window) - 1) / span

        n = len(pts) // 3
        mean_conf = sum(conf) / max(1, len(conf))

        # Pack the point + color + confidence buffers as raw bytes so the
        # wire format never has to re-translate from python lists.
        pt_bytes  = struct.pack("<%df" % (n * 3), *pts)
        col_bytes = struct.pack("<%dB" % (n * 3), *cols)
        cf_bytes  = struct.pack("<%df" % n, *conf)

        frame = _Frame(
            points=pt_bytes,
            colors=col_bytes,
            confidence=cf_bytes,
            n=n,
            fps=fps,
            mean_conf_mm=mean_conf,
            t=now,
        )

        self._last_recognitions = recognitions
        return frame

    def recognitions(self) -> List[Dict[str, Any]]:
        return list(getattr(self, "_last_recognitions", []))


def _make_recognition(obj, ox, oy, sx, sy, sz, *, z_table, tentative=False) -> Dict[str, Any]:
    """Build a recognition message matching the documented shape."""
    # Identity orientation — quaternion (x, y, z, w). Real recognition will
    # emit the actual 6DoF pose; mock keeps it axis-aligned.
    return {
        "id": int(obj["id"]),
        "part_id": obj["name"] or "unknown",
        "part_name": obj["name"],
        "confidence": float(obj["confidence"]) * (0.85 if tentative else 1.0),
        "match_source": obj["match_source"],   # "taught" | "cad" | None
        "pose": {
            "position":    {"x": float(ox), "y": float(oy),
                            "z": float(z_table - sz / 2)},
            "orientation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
        },
        "dimensions":     {"x": float(sx), "y": float(sy), "z": float(sz)},
        "pick_direction": {"x": 0.0, "y": 0.0, "z": -1.0},
        "tentative": bool(tentative),
    }


# ---------------------------------------------------------------------------
# Pack helpers tied to the binary wire format (also used by the mock path)
# ---------------------------------------------------------------------------

def pack_mock_cloud(frame: _Frame) -> bytes:
    return pack_cloud_payload({
        "points":     frame.points,
        "colors":     frame.colors,
        "confidence": frame.confidence,
        "fps":        frame.fps,
        "mean_conf_mm": frame.mean_conf_mm,
        "n":          frame.n,
    })
