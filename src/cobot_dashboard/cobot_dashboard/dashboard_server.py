"""Production RoboAi dashboard server — ROS2 bridge with cameras, LiDAR, and full state."""

import asyncio
import copy
import io
import json
import math
import os
import random
import struct
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import Image, JointState, PointCloud2
    from std_msgs.msg import Bool, Float32, String
    from std_srvs.srv import Trigger
    RCLPY_AVAILABLE = True
except ImportError:
    RCLPY_AVAILABLE = False
    Node = object

try:
    from PIL import Image as PilImage, ImageDraw
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

try:
    from fastapi import FastAPI, File, Request, UploadFile, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
    from fastapi.staticfiles import StaticFiles
    import uvicorn
    FASTAPI_AVAILABLE = True
except ImportError:
    FASTAPI_AVAILABLE = False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_START_TIME = time.time()
_THIS_DIR = Path(__file__).resolve().parent
_STATIC_DIR = _THIS_DIR.parent / "mock_server" / "static"

# ---------------------------------------------------------------------------
# Shared state — updated by ROS2 callbacks, read by FastAPI
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()

STATE = {
    "safety": {"zone": "GREEN", "speed_scale": 1.0, "estop": False, "human_proximity": 2.4},
    "joints": {
        "names": ["J1", "J2", "J3", "J4", "J5", "J6"],
        "positions": [0.0, -1.571, 0.785, -0.785, 0.0, 0.209],
        "velocities": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    },
    "task": {
        "state": "IDLE",
        "target": None,
        "program_step": 0,
        "program_total": 5,
        "running": False,
        "paused": False,
    },
    "detections": [],
    "lidar_objects": [],
    "placed_objects": [],
    "scene_graph": {"objects": []},
    "grasp_poses": [],
    "reconstruction": {"active": False, "voxels_occupied": 0, "mesh_triangles": 0},
    "gripper": {"state": "open", "position_mm": 85.0},
    "program": {
        # All steps start 'pending' — task.run resets them then marks
        # step 0 'active'; task.cancel / completion resets back. No
        # baked-in 'done'/'active' so the editor doesn't paint an
        # execution highlight when nothing's running.
        "steps": [
            {"id": 1, "type": "home",    "label": "Move to home",    "detail": "J: [0,−90,0,−90,0,0]°",     "status": "pending"},
            {"id": 2, "type": "gripper", "label": "Open gripper",    "detail": "Width: 85 mm · Speed: 80%", "status": "pending"},
            {"id": 3, "type": "move",    "label": "Approach object", "detail": "Target: auto · +150 mm Z",  "status": "pending"},
            {"id": 4, "type": "gripper", "label": "Pick & close",    "detail": "Descend 130 mm · close",    "status": "pending"},
            {"id": 5, "type": "move",    "label": "Place at target", "detail": "X: 0.30 Y: −0.20 Z: 0.40", "status": "pending"},
        ]
    },
    # LLM-generated pick/place program (populated by auto_program_node)
    "auto_program": {"steps": [], "scene_size": 0, "t": 0.0},
    "auto_status":  {"state": "IDLE", "error": None, "n_steps": 0, "t": 0.0},
    # Camera detection mode — broadcast to depth_segment_node, which
    # filters its detections accordingly. "all" emits every segment,
    # "library" emits only parts that matched the CAD library.
    "detection_mode": "all",
}

# Latest JPEG bytes per camera (None = no real frame yet)
_cam_frames: dict = {0: None, 1: None}
_cam_lock = threading.Lock()

# Latest annotated frame from detector (cam0 + cam1)
_annotated_frame: bytes = None
_annotated_frame_cam1: bytes = None
_annotated_lock = threading.Lock()

# Latest parsed LiDAR scan
_lidar_state: dict = {"pts": [], "live": False}
_lidar_lock = threading.Lock()

# Latest reconstruction mesh (JSON, forwarded verbatim to /ws/mesh)
_mesh_state: dict = {"payload": None, "n_tris": 0, "n_vertices": 0,
                     "n_occupied": 0, "t": 0.0}
_mesh_lock = threading.Lock()

# WebSocket client queues
_state_clients: dict = {}
_lidar_clients: dict = {}
_mesh_clients:  dict = {}
_ws_lock = threading.Lock()

# Program simulation state
_step_start_time: float = 0.0
_going_home: bool = False

# ---------------------------------------------------------------------------
# PIL helpers
# ---------------------------------------------------------------------------

_enc_warned: set = set()
_enc_error_count: int = 0


def _log_unknown_enc(enc: str):
    if enc not in _enc_warned:
        _enc_warned.add(enc)
        print(f"[dashboard] Unknown camera encoding: {enc!r} — frame dropped", flush=True)


def _log_encode_error(err: str):
    global _enc_error_count
    _enc_error_count += 1
    if _enc_error_count <= 5 or _enc_error_count % 100 == 0:
        print(f"[dashboard] Camera encode error #{_enc_error_count}: {err}", flush=True)


def _ros_image_to_jpeg(msg) -> bytes:
    if not PIL_AVAILABLE:
        return b""
    try:
        enc = msg.encoding
        w, h = msg.width, msg.height
        # Force a contiguous bytes copy — ROS2 data may be a memoryview
        raw = bytes(bytearray(msg.data))
        expected_rgb  = w * h * 3
        expected_mono = w * h

        if enc == "rgb8":
            if len(raw) < expected_rgb:
                return b""
            img = PilImage.frombytes("RGB", (w, h), raw[:expected_rgb])
        elif enc == "bgr8":
            if len(raw) < expected_rgb:
                return b""
            img = PilImage.frombytes("RGB", (w, h), raw[:expected_rgb])
            r, g, b = img.split()
            img = PilImage.merge("RGB", (b, g, r))
        elif enc in ("mono8", "8UC1"):
            if len(raw) < expected_mono:
                return b""
            img = PilImage.frombytes("L", (w, h), raw[:expected_mono]).convert("RGB")
        elif enc == "yuyv":
            try:
                import numpy as np
                arr = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 2)
                y = arr[:, :, 0].astype(np.float32)
                u = arr[:, :, 1].astype(np.float32) - 128
                r_ch = np.clip(y + 1.402 * u, 0, 255).astype(np.uint8)
                g_ch = np.clip(y - 0.344 * u, 0, 255).astype(np.uint8)
                b_ch = np.clip(y + 1.772 * u, 0, 255).astype(np.uint8)
                img = PilImage.fromarray(
                    __import__('numpy').stack([r_ch, g_ch, b_ch], axis=2), "RGB")
            except Exception:
                return b""
        else:
            _log_unknown_enc(enc)
            return b""

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()
    except Exception as e:
        _log_encode_error(str(e))
        return b""


def _sim_camera_frame(cam: int) -> bytes:
    if not PIL_AVAILABLE:
        return b""
    width, height = 640, 480
    img = PilImage.new("RGB", (width, height), color=(10, 13, 18))
    draw = ImageDraw.Draw(img)
    draw.polygon([(80, 380), (560, 380), (480, 240), (160, 240)], fill=(26, 26, 30))
    draw.text((8, height - 20), f"CAM{cam}  NO ROS2 SIGNAL", fill=(160, 50, 50))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return buf.getvalue()

# ---------------------------------------------------------------------------
# PointCloud2 helpers
# ---------------------------------------------------------------------------

try:
    import numpy as _np
except Exception:
    _np = None

try:
    import orjson as _orjson
    def _json_dumps(obj) -> str:
        # orjson serialises numpy floats natively (with OPT_SERIALIZE_NUMPY)
        # — used for the lidar payload's flat ndarray.
        return _orjson.dumps(obj, option=_orjson.OPT_SERIALIZE_NUMPY).decode()
except ImportError:
    def _json_dumps(obj) -> str:
        return json.dumps(obj)


def _parse_pointcloud2(msg, max_points: int = 80000):
    """Vectorised PointCloud2 decode → flat float32 ndarray (3N,) in
    interleaved XYZ order. Returns an empty ndarray on failure.

    The flat-array shape is consumed directly by _build_lidar_payload
    below; replacing the previous list-of-{x,y,z}-dicts cut both
    decode and JSON-serialise time by ~10x at 18k points.
    """
    if _np is None:
        return _parse_pointcloud2_legacy(msg, max_points)
    fields = {f.name: f for f in msg.fields}
    if not all(k in fields for k in ("x", "y", "z")):
        return _np.empty((0,), dtype=_np.float32)
    ox = fields["x"].offset
    oy = fields["y"].offset
    oz = fields["z"].offset
    step = msg.point_step
    if step <= 0:
        return _np.empty((0,), dtype=_np.float32)
    data = bytes(msg.data)
    n = len(data) // step
    if n == 0:
        return _np.empty((0,), dtype=_np.float32)
    if oy == ox + 4 and oz == ox + 8:
        arr = _np.frombuffer(data, dtype=_np.uint8).reshape(n, step)
        block = arr[:, ox:ox + 12].copy()
        xyz = block.view(_np.float32).reshape(n, 3)
    else:
        # Slow path — non-contiguous XYZ in the point struct.
        return _parse_pointcloud2_legacy(msg, max_points)
    # Drop NaNs and absurdly distant points.
    finite = _np.isfinite(xyz).all(axis=1)
    in_range = (
        (_np.abs(xyz[:, 0]) < 30.0) &
        (_np.abs(xyz[:, 1]) < 30.0) &
        (_np.abs(xyz[:, 2]) < 15.0)
    )
    xyz = xyz[finite & in_range]
    if xyz.shape[0] > max_points:
        stride = xyz.shape[0] // max_points
        xyz = xyz[::stride][:max_points]
    return xyz.reshape(-1).astype(_np.float32, copy=False).copy()


def _parse_pointcloud2_legacy(msg, max_points: int = 80000) -> list:
    """Original Python-loop decoder — kept for the unusual field layout
    or when numpy is unavailable. Still returns list-of-dicts for
    compatibility, but _build_lidar_payload normalises both shapes."""
    fields = {f.name: f for f in msg.fields}
    if not all(k in fields for k in ("x", "y", "z")):
        return []
    ox = fields["x"].offset
    oy = fields["y"].offset
    oz = fields["z"].offset
    oi_field = fields.get("intensity", fields.get("i"))
    step = msg.point_step
    data = bytes(msg.data)
    n = len(data) // step if step else 0
    stride = max(1, n // max_points)
    pts = []
    for idx in range(0, n, stride):
        base = idx * step
        if base + step > len(data):
            break
        x = struct.unpack_from("f", data, base + ox)[0]
        y = struct.unpack_from("f", data, base + oy)[0]
        z = struct.unpack_from("f", data, base + oz)[0]
        if x != x or y != y or z != z:  # NaN
            continue
        if abs(x) > 30 or abs(y) > 30 or abs(z) > 15:
            continue
        pt = {"x": round(x, 3), "y": round(y, 3), "z": round(z, 3)}
        if oi_field is not None:
            try:
                pt["i"] = round(struct.unpack_from("f", data, base + oi_field.offset)[0], 3)
            except Exception:
                pass
        pts.append(pt)
    return pts


def _sim_lidar_frame(t: float) -> list:
    pts = []
    for _ in range(200):
        pts.append({"x": round(random.uniform(-3, 3), 3),
                    "y": round(random.uniform(-3, 3), 3),
                    "z": round(random.uniform(-0.05, 0.05), 3)})
    for _ in range(80):
        a = random.uniform(0, 2 * math.pi)
        r = random.uniform(0.8, 2.5)
        pts.append({"x": round(r * math.cos(a), 3),
                    "y": round(r * math.sin(a), 3),
                    "z": round(random.uniform(0.0, 1.5), 3)})
    px, py = 1.5 * math.cos(t * 0.4), 1.5 * math.sin(t * 0.4)
    for _ in range(30):
        pts.append({"x": round(px + random.gauss(0, 0.05), 3),
                    "y": round(py + random.gauss(0, 0.05), 3),
                    "z": round(random.uniform(0.0, 1.7), 3)})
    return pts

# ---------------------------------------------------------------------------
# Scene-graph normalisation
# ---------------------------------------------------------------------------

def _normalise_scene_graph(raw) -> dict:
    """UUID-keyed dict or existing objects list → canonical objects array."""
    if not isinstance(raw, dict):
        return {"objects": []}
    if "objects" in raw:
        objs = []
        for o in raw["objects"]:
            pos = o.get("position") or o.get("pos") or [0, 0, 0]
            if isinstance(pos, dict):
                pos = [pos.get("x", 0), pos.get("y", 0), pos.get("z", 0)]
            objs.append({
                "id": o.get("id", ""),
                "class_name": o.get("class_name") or o.get("class") or o.get("class_id", ""),
                "score": o.get("score") or o.get("confidence", 0.0),
                "position": [round(float(p), 3) for p in pos],
                "last_seen_ms": int(o.get("last_seen_ms") or o.get("age_s", 0) * 1000),
            })
        return {"objects": objs}
    # UUID-keyed dict from scene_graph_node
    objs = []
    for uid, obj in raw.items():
        pos = obj.get("position", {})
        if isinstance(pos, dict):
            position = [pos.get("x", 0), pos.get("y", 0), pos.get("z", 0)]
        elif isinstance(pos, (list, tuple)):
            position = list(pos)
        else:
            position = [0, 0, 0]
        # Velocity may arrive as dict or list; flatten to list either way.
        vel_raw = obj.get("velocity", [0.0, 0.0, 0.0])
        if isinstance(vel_raw, dict):
            velocity = [vel_raw.get("x", 0), vel_raw.get("y", 0), vel_raw.get("z", 0)]
        elif isinstance(vel_raw, (list, tuple)):
            velocity = list(vel_raw)
        else:
            velocity = [0.0, 0.0, 0.0]
        out = {
            "id":          str(uid),
            "class_name":  obj.get("class_id") or obj.get("class_name") or obj.get("class", ""),
            "score":       obj.get("confidence", 0.0),
            "position":    [round(float(p), 3) for p in position],
            "last_seen_ms": int(obj.get("age_s", 0) * 1000),
            "velocity":    [round(float(v), 4) for v in velocity],
            "speed_mps":   round(float(obj.get("speed_mps", 0.0)), 4),
            "is_moving":   bool(obj.get("is_moving", False)),
        }
        # Optional motion+orientation fields (only present from the new node).
        if "size" in obj:
            out["size"] = [round(float(v), 4) for v in (obj["size"] or [0, 0, 0])]
        if "quat" in obj:
            out["quat"] = [round(float(v), 4) for v in (obj["quat"] or [0, 0, 0, 1])]
        if "orientation_deg" in obj:
            out["orientation"] = [round(float(v), 1) for v in (obj["orientation_deg"] or [0, 0, 0])]
        if "path" in obj:
            out["path"] = [
                [round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3)]
                for p in (obj["path"] or [])
            ]
        objs.append(out)
    return {"objects": objs}

# ---------------------------------------------------------------------------
# ROS2 node
# ---------------------------------------------------------------------------

class DashboardServer(Node if RCLPY_AVAILABLE else object):
    def __init__(self):
        if RCLPY_AVAILABLE:
            super().__init__("dashboard_server")
        self._have_fused = False
        self._task_pub = None
        self._voice_pub = None
        self._estop_client = None

        if not RCLPY_AVAILABLE:
            return

        # Publishers
        self._task_pub = self.create_publisher(String, "/task/command", 10)
        self._voice_pub = self.create_publisher(String, "/task/voice_command", 10)
        self._generate_program_pub = self.create_publisher(
            String, "/task/generate_program", 5)
        self._detection_mode_pub = self.create_publisher(
            String, "/perception/detection_mode", 5)
        self._teach_cmd_pub = self.create_publisher(
            String, "/perception/teach_command", 10)

        # Auto-program subscriber (LLM-generated pick/place steps)
        self.create_subscription(String, "/task/auto_program",
                                 self._on_auto_program, 5)
        self.create_subscription(String, "/task/auto_status",
                                 self._on_auto_status, 5)

        # Service client
        self._estop_client = self.create_client(Trigger, "/safety/reset_estop")

        # Safety
        self.create_subscription(String,  "/safety/status",          self._on_safety_status,  10)
        self.create_subscription(Float32, "/safety/human_proximity", self._on_proximity,       10)
        self.create_subscription(String,  "/safety/zone",            self._on_zone,            10)
        self.create_subscription(Float32, "/safety/speed_scale",     self._on_speed_scale,     10)
        self.create_subscription(Bool,    "/safety/estop",           self._on_estop,           10)

        # Task + perception
        self.create_subscription(String,    "/task/status",              self._on_task_status,    10)
        self.create_subscription(String,    "/perception/scene_graph",   self._on_scene_graph,    10)
        # String fallback — scene_graph_node may republish detections as JSON
        self.create_subscription(String,    "/perception/detections",    self._on_detections_str, 10)
        # Detection sources are now SEPARATE:
        #   STATE["lidar_objects"]  <- /perception/lidar_detections    (3D view)
        #   STATE["detections"]     <- /perception/detections_3d       (camera feeds)
        # Camera detections used to bleed into the 3D view; transforming them
        # from cam frame to lidar frame was never accurate enough. The 3D
        # view now reads lidar_objects exclusively — those are extracted
        # FROM the same cloud being displayed, so they align by construction.
        try:
            from vision_msgs.msg import Detection3DArray
            self.create_subscription(Detection3DArray, "/perception/lidar_detections",
                                     self._on_detections_lidar, 5)
            self.create_subscription(Detection3DArray, "/perception/detections_3d",
                                     self._on_detections_3d, 5)
            self.get_logger().info(
                "Detection3DArray subs ready: lidar->STATE.lidar_objects, "
                "cam->STATE.detections (3D view reads lidar_objects only)")
        except ImportError:
            self.get_logger().warn("vision_msgs not available — detection3d subscription skipped")
        self.create_subscription(JointState, "/joint_states",            self._on_joint_states,   10)

        # Grasp planner output (JSON String — full per-candidate metadata).
        self.create_subscription(String, "/grasp/candidates",
                                 self._on_grasp_candidates, 5)

        # Stereo-verified objects with LiDAR-anchored Z (JSON String).
        self.create_subscription(String, "/perception/placed_objects",
                                 self._on_placed_objects, 5)

        # Annotated image from detector (cam0 + cam1)
        self.create_subscription(Image, "/perception/annotated_image",
                                 self._on_annotated, 2)
        self.create_subscription(Image, "/perception/annotated_image_cam1",
                                 self._on_annotated_cam1, 2)

        # Cameras — double namespace because realsense2_camera is launched with
        # name=cam0 inside namespace cam0, producing /cam0/cam0/... topics.
        # Confirmed from session log May 21 2026.
        self.create_subscription(Image, "/cam0/cam0/color/image_raw",
                                 lambda m: self._on_camera(0, m), 2)
        self.create_subscription(Image, "/cam1/cam1/color/image_raw",
                                 lambda m: self._on_camera(1, m), 2)

        # LiDAR priority: dense > accumulated > fused > raw. Lower-priority
        # handlers bail out if any higher-priority source produced data in
        # the last second.
        self._lidar_last = {"dense": 0.0, "acc": 0.0, "fused": 0.0, "raw": 0.0}
        self.create_subscription(PointCloud2, "/lidar/points_dense",
                                 self._on_lidar_dense, 2)
        self.create_subscription(PointCloud2, "/lidar/points_accumulated",
                                 self._on_lidar_accum, 2)
        self.create_subscription(PointCloud2, "/perception/fused_cloud",
                                 self._on_lidar_fused, 2)
        self.create_subscription(PointCloud2, "/lidar/points",
                                 self._on_lidar_raw, 2)

        # Local TSDF reconstruction mesh — JSON String from local_reconstruction.
        self.create_subscription(String, "/reconstruction/mesh_json",
                                 self._on_mesh_json, 2)

        self.get_logger().info("DashboardServer ready")

    # ---- Safety ----

    def _on_safety_status(self, msg):
        try:
            d = json.loads(msg.data)
            with _state_lock:
                s = STATE["safety"]
                if "zone"         in d: s["zone"]            = d["zone"]
                if "proximity_m"  in d: s["human_proximity"] = d["proximity_m"]
                if "speed_scale"  in d: s["speed_scale"]     = d["speed_scale"]
                if "estop"        in d: s["estop"]            = d["estop"]
        except Exception:
            pass

    def _on_proximity(self, msg):
        with _state_lock:
            STATE["safety"]["human_proximity"] = round(msg.data, 3)

    def _on_zone(self, msg):
        with _state_lock:
            STATE["safety"]["zone"] = msg.data

    def _on_speed_scale(self, msg):
        with _state_lock:
            STATE["safety"]["speed_scale"] = round(msg.data, 3)

    def _on_estop(self, msg):
        with _state_lock:
            STATE["safety"]["estop"] = bool(msg.data)

    # ---- Task / perception ----

    def _on_task_status(self, msg):
        try:
            d = json.loads(msg.data)
            with _state_lock:
                t = STATE["task"]
                for key in ("state", "target", "running", "paused",
                            "program_step", "program_total"):
                    if key in d:
                        t[key] = d[key]
        except Exception:
            pass

    def _on_scene_graph(self, msg):
        try:
            raw = json.loads(msg.data)
            normalised = _normalise_scene_graph(raw)
            with _state_lock:
                STATE["scene_graph"] = normalised
        except Exception:
            pass

    def _on_detections_str(self, msg):
        """JSON String fallback — some nodes republish detections as JSON."""
        try:
            dets = json.loads(msg.data)
            with _state_lock:
                STATE["detections"] = dets if isinstance(dets, list) else []
        except Exception:
            pass

    def _on_detections_lidar(self, msg):
        """LiDAR detector callback — disabled.

        The lidar_detector node over-segments noise into 22 spurious
        clusters per cycle. The service is stopped + disabled at the
        systemd level (roboai-lidar-detect); this callback is a no-op
        as belt+suspenders in case anything else publishes the topic.
        STATE['lidar_objects'] stays at its initial [].
        """
        return
        import math as _m
        out = []
        for det in msg.detections:
            if not det.results:
                continue
            res = det.results[0]
            p = det.bbox.center.position
            s = det.bbox.size
            ori = det.bbox.center.orientation
            score = float(res.hypothesis.score)
            if score < 0.5:
                continue
            if not (_m.isfinite(p.x) and _m.isfinite(p.y) and _m.isfinite(p.z)):
                continue
            if abs(p.x) > 5.0 or abs(p.y) > 5.0 or abs(p.z) > 5.0:
                continue
            out.append({
                "id":         str(id(det)),
                "class_name": str(res.hypothesis.class_id),
                "score":      round(float(res.hypothesis.score), 3),
                "x":          round(float(p.x), 4),
                "y":          round(float(p.y), 4),
                "z":          round(float(p.z), 4),
                # Box bottom/top derived from the publisher's convention.
                "min_z":      round(float(p.z) - float(s.z) / 2.0, 4),
                "max_z":      round(float(p.z) + float(s.z) / 2.0, 4),
                "w":          round(float(s.x), 4),
                "h":          round(float(s.y), 4),
                "d":          round(float(s.z), 4),
                "quat":       [round(float(ori.x), 4), round(float(ori.y), 4),
                               round(float(ori.z), 4), round(float(ori.w), 4)],
            })
        with _state_lock:
            STATE["lidar_objects"] = out

    def _on_detections_3d(self, msg):
        """Camera-based detector — stays in STATE['detections'] for the
        camera-feed overlays. NOT used by the 3D LiDAR view."""
        self._publish_detections(msg)

    def _publish_detections(self, msg):
        """Parse Detection3DArray into STATE['detections'] (camera path)."""
        import math as _m
        dets = []
        for det in msg.detections:
            if not det.results:
                continue
            result = det.results[0]
            class_name = str(result.hypothesis.class_id)
            score = float(result.hypothesis.score)
            # depth_segment_node encodes part-library matches as
            # "part:NAME:STATUS:YAW_ERR" where STATUS is C (correct),
            # M (misaligned), or U (unverified — no metadata to check
            # against). Parse them back into top-level detection
            # fields the frontend can branch on.
            part_name        = None
            match_score      = 0.0
            position_correct = None
            yaw_error_deg    = 0.0
            if class_name.startswith('part:'):
                parts_split = class_name.split(':', 3)
                part_name   = parts_split[1] if len(parts_split) > 1 else None
                status_ch   = parts_split[2] if len(parts_split) > 2 else 'U'
                try:
                    yaw_error_deg = float(parts_split[3]) if len(parts_split) > 3 else 0.0
                except ValueError:
                    yaw_error_deg = 0.0
                position_correct = {'C': True, 'M': False}.get(status_ch)  # None for 'U'
                match_score = score
                class_name  = 'part'
            pos = det.bbox.center.position
            ori = det.bbox.center.orientation
            size = det.bbox.size
            # Pixel-coord legacy detections (|x|/|y| > 10) only carry 2D info.
            # Metric detections carry full OBB (quaternion + 3D size).
            if abs(pos.x) > 10 or abs(pos.y) > 10:
                dets.append({
                    "id":          str(id(det)),
                    "class_name":  class_name,
                    "score":       round(score, 3),
                    "part_name":        part_name,
                    "match_score":      round(match_score, 3) if part_name else 0,
                    "position_correct": position_correct,
                    "yaw_error_deg":    round(yaw_error_deg, 1) if part_name else 0,
                    "bbox_px": [
                        round(pos.x - size.x / 2, 1),
                        round(pos.y - size.y / 2, 1),
                        round(pos.x + size.x / 2, 1),
                        round(pos.y + size.y / 2, 1),
                    ],
                    "x": 0, "y": 0, "z": 1.0,
                    "w":          round(size.x, 3),
                    "h":          round(size.y, 3),
                })
            else:
                # Quaternion (xyzw) -> ZYX intrinsic Tait-Bryan (roll/pitch/yaw).
                qx, qy, qz, qw = ori.x, ori.y, ori.z, ori.w
                # R[2,0] = 2(qx*qz - qw*qy);  R[2,1] = 2(qy*qz + qw*qx)
                # R[2,2] = 1 - 2(qx*qx + qy*qy)
                # R[1,0] = 2(qx*qy + qw*qz);  R[0,0] = 1 - 2(qy*qy + qz*qz)
                r20 = 2.0 * (qx * qz - qw * qy)
                r21 = 2.0 * (qy * qz + qw * qx)
                r22 = 1.0 - 2.0 * (qx * qx + qy * qy)
                r10 = 2.0 * (qx * qy + qw * qz)
                r00 = 1.0 - 2.0 * (qy * qy + qz * qz)
                pitch = _m.asin(max(-1.0, min(1.0, -r20)))
                roll  = _m.atan2(r21, r22)
                yaw   = _m.atan2(r10, r00)
                roll_deg, pitch_deg, yaw_deg = (
                    _m.degrees(roll), _m.degrees(pitch), _m.degrees(yaw)
                )
                dets.append({
                    "id":          str(id(det)),
                    "class_name":  class_name,
                    "score":       round(score, 3),
                    "part_name":        part_name,
                    "match_score":      round(match_score, 3) if part_name else 0,
                    "position_correct": position_correct,
                    "yaw_error_deg":    round(yaw_error_deg, 1) if part_name else 0,
                    "x":          round(pos.x, 4),
                    "y":          round(pos.y, 4),
                    "z":          round(pos.z, 4),
                    "w":          round(size.x, 4),
                    "h":          round(size.y, 4),
                    "d":          round(size.z, 4),
                    "roll":       round(roll_deg, 1),
                    "pitch":      round(pitch_deg, 1),
                    "yaw":        round(yaw_deg, 1),
                    "quat":       [round(qx, 4), round(qy, 4),
                                   round(qz, 4), round(qw, 4)],
                    "size_3d":    [round(size.x, 4), round(size.y, 4),
                                   round(size.z, 4)],
                })
        with _state_lock:
            STATE["detections"] = dets

    def _on_placed_objects(self, msg):
        """Stereo-verified, LiDAR-anchored objects (JSON String from
        stereo_verifier_node). Stored as-is in STATE so the dashboard
        can render verified/unverified with different styling."""
        try:
            payload = json.loads(msg.data)
        except Exception:
            return
        objs = payload.get('objects', []) or []
        # Keep only the fields the frontend needs (pass through most).
        out = []
        for o in objs:
            out.append({
                'id':              o.get('id'),
                'source':          o.get('source'),
                'verified':        bool(o.get('verified', False)),
                'position_lidar':  o.get('position_lidar') or [0, 0, 0],
                'position_cam0':   o.get('position_cam0'),
                'position_cam1':   o.get('position_cam1'),
                'surface_z':       o.get('surface_z'),
                'surface_unknown': bool(o.get('surface_unknown', False)),
                'size':            o.get('size') or [0.05, 0.05, 0.05],
                'orientation':     o.get('orientation') or [0, 0, 0],
                'quat':            o.get('quat') or [0, 0, 0, 1],
                'class_name':      o.get('class_name'),
                'confidence':      o.get('confidence', 0.0),
            })
        with _state_lock:
            STATE['placed_objects'] = out

    def _on_auto_program(self, msg):
        """LLM-generated pick/place steps from auto_program_node."""
        try:
            payload = json.loads(msg.data) if msg.data else {}
        except json.JSONDecodeError:
            return
        steps = payload.get('steps') or []
        if not isinstance(steps, list):
            return
        with _state_lock:
            STATE['auto_program'] = {
                'steps':      steps,
                'scene_size': int(payload.get('scene_size', 0)),
                't':          float(payload.get('t', time.time())),
            }

    def _on_auto_status(self, msg):
        try:
            payload = json.loads(msg.data) if msg.data else {}
        except json.JSONDecodeError:
            return
        with _state_lock:
            STATE['auto_status'] = {
                'state':   str(payload.get('state', 'IDLE')),
                'error':   payload.get('error'),
                'n_steps': int(payload.get('n_steps', 0)),
                't':       float(payload.get('t', time.time())),
            }

    def _on_grasp_candidates(self, msg):
        """Parse grasp_planner JSON and reshape for the dashboard store."""
        try:
            payload = json.loads(msg.data)
        except Exception:
            return
        out = []
        for c in payload.get('candidates', []) or []:
            pg = c.get('pre_grasp', {})
            gr = c.get('grasp', {})
            pos = gr.get('position') or [0, 0, 0]
            pre = pg.get('position') or pos
            quat = gr.get('orientation') or [0, 0, 0, 1]
            out.append({
                'object_id':       c.get('object_id'),
                'class_name':      c.get('class_name'),
                'confidence':      c.get('confidence'),
                'x':               round(float(pos[0]), 4),
                'y':               round(float(pos[1]), 4),
                'z':               round(float(pos[2]), 4),
                'pre_x':           round(float(pre[0]), 4),
                'pre_y':           round(float(pre[1]), 4),
                'pre_z':           round(float(pre[2]), 4),
                'quat':            [round(float(q), 4) for q in quat],
                'gripper_width_m': c.get('gripper_width_m'),
                'object_yaw_rad':  c.get('object_yaw_rad'),
                'grasp_yaw_rad':   c.get('grasp_yaw_rad'),
                'approach_along_long': c.get('approach_along_long'),
            })
        with _state_lock:
            STATE['grasp_poses'] = out

    def _on_annotated(self, msg):
        jpeg = _ros_image_to_jpeg(msg)
        if jpeg:
            global _annotated_frame
            with _annotated_lock:
                _annotated_frame = jpeg

    def _on_annotated_cam1(self, msg):
        jpeg = _ros_image_to_jpeg(msg)
        if jpeg:
            global _annotated_frame_cam1
            with _annotated_lock:
                _annotated_frame_cam1 = jpeg

    def _on_joint_states(self, msg):
        with _state_lock:
            STATE["joints"]["names"]      = list(msg.name)
            STATE["joints"]["positions"]  = list(msg.position)
            STATE["joints"]["velocities"] = list(msg.velocity) if msg.velocity else [0.0] * len(msg.name)

    # ---- Cameras ----

    def _on_camera(self, cam_id: int, msg):
        jpeg = _ros_image_to_jpeg(msg)
        if jpeg:
            with _cam_lock:
                _cam_frames[cam_id] = jpeg
            attr = f"_cam{cam_id}_logged"
            if not getattr(self, attr, False):
                setattr(self, attr, True)
                self.get_logger().info(
                    f"Camera {cam_id} first frame: "
                    f"{msg.width}x{msg.height} enc={msg.encoding} "
                    f"jpeg={len(jpeg)}B"
                )
        else:
            attr = f"_cam{cam_id}_fail_logged"
            if not getattr(self, attr, False):
                setattr(self, attr, True)
                self.get_logger().warn(
                    f"Camera {cam_id} encode failed: "
                    f"{msg.width}x{msg.height} enc={msg.encoding} "
                    f"data_len={len(msg.data)}"
                )

    # ---- LiDAR ----

    def _lidar_stale(self, key: str, max_age_s: float = 1.0) -> bool:
        return (time.time() - self._lidar_last[key]) > max_age_s

    @staticmethod
    def _pts_not_empty(pts):
        if _np is not None and isinstance(pts, _np.ndarray):
            return pts.size > 0
        return bool(pts)

    # Priority: fused (LiDAR + cameras, ~80k pts) > dense (LiDAR-only
    # accumulator, ~50k pts) > accumulated > raw. Each lower tier only
    # writes if every higher tier is stale.
    def _on_lidar_fused(self, msg):
        pts = _parse_pointcloud2(msg, max_points=80000)
        if self._pts_not_empty(pts):
            self._lidar_last["fused"] = time.time()
            with _lidar_lock:
                _lidar_state["pts"]  = pts
                _lidar_state["live"] = True

    def _on_lidar_dense(self, msg):
        if not self._lidar_stale("fused"):
            return
        pts = _parse_pointcloud2(msg, max_points=80000)
        if self._pts_not_empty(pts):
            self._lidar_last["dense"] = time.time()
            with _lidar_lock:
                _lidar_state["pts"]  = pts
                _lidar_state["live"] = True

    def _on_lidar_accum(self, msg):
        if not (self._lidar_stale("fused") and self._lidar_stale("dense")):
            return
        pts = _parse_pointcloud2(msg, max_points=80000)
        if self._pts_not_empty(pts):
            self._lidar_last["acc"] = time.time()
            with _lidar_lock:
                _lidar_state["pts"]  = pts
                _lidar_state["live"] = True

    def _on_lidar_raw(self, msg):
        if not (self._lidar_stale("fused") and self._lidar_stale("dense")
                and self._lidar_stale("acc")):
            return
        pts = _parse_pointcloud2(msg, max_points=80000)
        if self._pts_not_empty(pts):
            self._lidar_last["raw"] = time.time()
            with _lidar_lock:
                _lidar_state["pts"]  = pts
                _lidar_state["live"] = True

    def _on_mesh_json(self, msg):
        """Cache the latest reconstruction mesh for /ws/mesh broadcasts."""
        try:
            payload = json.loads(msg.data)
        except Exception:
            return
        with _mesh_lock:
            _mesh_state["payload"]   = msg.data         # forward verbatim
            _mesh_state["n_tris"]    = int(payload.get("n_tris", 0))
            _mesh_state["n_vertices"] = int(payload.get("n_vertices", 0))
            _mesh_state["n_occupied"] = int(payload.get("n_occupied", 0))
            _mesh_state["t"]         = time.time()
        with _state_lock:
            STATE["reconstruction"] = {
                "active":          True,
                "voxels_occupied": _mesh_state["n_occupied"],
                "mesh_triangles":  _mesh_state["n_tris"],
            }

    # ---- Service helpers ----

    def call_reset_estop(self):
        def _run():
            if not self._estop_client:
                return
            if self._estop_client.wait_for_service(timeout_sec=0.5):
                self._estop_client.call_async(Trigger.Request())
        threading.Thread(target=_run, daemon=True).start()

    def publish_task_command(self, cmd: str):
        if self._task_pub:
            m = String()
            m.data = json.dumps({"command": cmd})
            self._task_pub.publish(m)

    def publish_voice_command(self, text: str):
        if self._voice_pub:
            m = String()
            m.data = text
            self._voice_pub.publish(m)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

_ros_node: DashboardServer = None

if FASTAPI_AVAILABLE:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(_broadcast_loop())
        yield
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    app = FastAPI(title="RoboAi Dashboard", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])

    # ------------------------------------------------------------------
    # Broadcast loop — pushes state + lidar to WebSocket queues at Hz
    # ------------------------------------------------------------------

    async def _broadcast_loop():
        state_hz  = 25
        lidar_hz  = 10
        mesh_hz   = 2
        state_dt  = 1.0 / state_hz
        lidar_dt  = 1.0 / lidar_hz
        mesh_dt   = 1.0 / mesh_hz
        next_state = time.time()
        next_lidar = time.time()
        next_mesh  = time.time()
        _last_mesh_t = 0.0

        while True:
            now = time.time()

            if now >= next_mesh:
                with _mesh_lock:
                    payload = _mesh_state["payload"]
                    mesh_t  = _mesh_state["t"]
                if payload and mesh_t > _last_mesh_t:
                    _last_mesh_t = mesh_t
                    with _ws_lock:
                        clients = list(_mesh_clients.items())
                    for ws, q in clients:
                        if q.qsize() < 2:
                            try:
                                await q.put(payload)
                            except Exception:
                                pass
                next_mesh = now + mesh_dt

            if now >= next_state:
                with _state_lock:
                    payload = copy.deepcopy(STATE)
                payload["t"] = now * 1000
                txt = json.dumps(payload)
                with _ws_lock:
                    clients = list(_state_clients.items())
                for ws, q in clients:
                    if q.qsize() < 2:
                        try:
                            await q.put(txt)
                        except Exception:
                            pass
                next_state = now + state_dt

            if now >= next_lidar:
                with _lidar_lock:
                    pts  = _lidar_state["pts"]   # no copy — readers can't mutate
                # Binary wire format: 4-byte LE uint32 count + N*12 bytes of
                # interleaved float32 XYZ. ~3x smaller than the JSON flat
                # array at 40k points (480 KB vs ~1.5 MB).
                if _np is not None and isinstance(pts, _np.ndarray):
                    n = pts.size // 3
                    arr = pts[:n * 3].astype(_np.float32, copy=False)
                elif pts:
                    arr = _np.asarray(
                        [c for p in pts for c in (p["x"], p["y"], p["z"])],
                        dtype=_np.float32,
                    ) if _np is not None else None
                    n = (len(arr) // 3) if arr is not None else 0
                else:
                    sim = _sim_lidar_frame(now - _START_TIME)
                    arr = _np.asarray(
                        [c for p in sim for c in (p["x"], p["y"], p["z"])],
                        dtype=_np.float32,
                    ) if _np is not None else None
                    n = (len(arr) // 3) if arr is not None else 0
                if arr is None or n == 0:
                    lidar_payload = struct.pack('<I', 0)
                else:
                    lidar_payload = struct.pack('<I', n) + arr.tobytes()
                with _ws_lock:
                    clients = list(_lidar_clients.items())
                for ws, q in clients:
                    if q.qsize() < 2:
                        try:
                            await q.put(('binary', lidar_payload))
                        except Exception:
                            pass
                next_lidar = now + lidar_dt

            await asyncio.sleep(0.005)

    # ------------------------------------------------------------------
    # WebSocket endpoints
    # ------------------------------------------------------------------

    @app.websocket("/ws/state")
    async def ws_state(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _state_clients[websocket] = q
        try:
            while True:
                txt = await q.get()
                await websocket.send_text(txt)
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _state_clients.pop(websocket, None)

    @app.websocket("/ws/lidar")
    async def ws_lidar(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _lidar_clients[websocket] = q
        try:
            while True:
                item = await q.get()
                if isinstance(item, tuple) and item and item[0] == 'binary':
                    await websocket.send_bytes(item[1])
                else:
                    await websocket.send_text(item)
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _lidar_clients.pop(websocket, None)

    @app.websocket("/ws/mesh")
    async def ws_mesh(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _mesh_clients[websocket] = q
        # Immediately push the latest cached mesh if we have one so the
        # client doesn't have to wait for the next reconstruction tick.
        with _mesh_lock:
            cached = _mesh_state["payload"]
        if cached:
            try:
                await websocket.send_text(cached)
            except Exception:
                pass
        try:
            while True:
                txt = await q.get()
                await websocket.send_text(txt)
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _mesh_clients.pop(websocket, None)

    # ------------------------------------------------------------------
    # MJPEG camera streams
    # ------------------------------------------------------------------

    async def _mjpeg_gen(cam: int):
        while True:
            try:
                with _cam_lock:
                    frame = _cam_frames.get(cam)
                if not frame:
                    frame = _sim_camera_frame(cam)
                if frame:
                    yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                           + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                await asyncio.sleep(1 / 15)
            except Exception:
                break

    @app.get("/stream/cam0")
    async def stream_cam0():
        async def _gen():
            while True:
                try:
                    with _annotated_lock:
                        frame = _annotated_frame
                    if not frame:
                        with _cam_lock:
                            frame = _cam_frames.get(0)
                    if not frame:
                        frame = _sim_camera_frame(0)
                    if frame:
                        yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                               + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                    await asyncio.sleep(1 / 15)
                except Exception:
                    break
        return StreamingResponse(_gen(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/stream/cam1")
    async def stream_cam1():
        async def _gen():
            while True:
                try:
                    with _annotated_lock:
                        frame = _annotated_frame_cam1
                    if not frame:
                        with _cam_lock:
                            frame = _cam_frames.get(1)
                    if not frame:
                        frame = _sim_camera_frame(1)
                    if frame:
                        yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                               + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                    await asyncio.sleep(1 / 15)
                except Exception:
                    break
        return StreamingResponse(_gen(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/stream/annotated")
    async def stream_annotated():
        async def _gen():
            while True:
                try:
                    with _annotated_lock:
                        frame = _annotated_frame
                    if not frame:
                        with _cam_lock:
                            frame = _cam_frames.get(0)
                    if not frame:
                        frame = _sim_camera_frame(0)
                    if frame:
                        yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                               + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                    await asyncio.sleep(1 / 15)
                except Exception:
                    break
        return StreamingResponse(_gen(), media_type="multipart/x-mixed-replace; boundary=frame")

    # ------------------------------------------------------------------
    # Command endpoints
    # ------------------------------------------------------------------

    @app.post("/cmd/estop")
    async def cmd_estop(request: Request):
        body = await request.json()
        active   = bool(body.get("active", True))
        override = bool(body.get("override", False))
        if active:
            with _state_lock:
                STATE["safety"]["estop"]      = True
                STATE["safety"]["speed_scale"] = 0.0
                if STATE["task"]["running"]:
                    STATE["task"]["running"] = False
                    STATE["task"]["state"]   = "PAUSED"
            with _state_lock:
                return {"ok": True, "safety": copy.deepcopy(STATE["safety"])}
        # Release
        with _state_lock:
            zone = STATE["safety"]["zone"]
        if zone != "GREEN" and not override:
            return JSONResponse({"error": f"Cannot release estop: zone is {zone}"}, status_code=400)
        with _state_lock:
            STATE["safety"]["estop"] = False
            if zone == "GREEN":
                STATE["safety"]["speed_scale"] = 1.0
        if _ros_node:
            _ros_node.call_reset_estop()
        with _state_lock:
            return {"ok": True, "override": override, "safety": copy.deepcopy(STATE["safety"])}

    @app.post("/cmd/task")
    async def cmd_task(request: Request):
        global _step_start_time, _going_home
        body = await request.json()
        command = body.get("command", "")
        with _state_lock:
            estop = STATE["safety"]["estop"]
        if command == "run":
            if estop:
                return JSONResponse({"error": "Cannot run: estop active"}, status_code=400)
            with _state_lock:
                if STATE["task"]["running"]:
                    return JSONResponse({"error": "Already running"}, status_code=400)
                STATE["task"].update({"running": True, "paused": False,
                                      "state": "APPROACH", "program_step": 0})
                for s in STATE["program"]["steps"]:
                    s["status"] = "pending"
                if STATE["program"]["steps"]:
                    STATE["program"]["steps"][0]["status"] = "active"
            _step_start_time = time.time() - _START_TIME
        elif command == "pause":
            with _state_lock:
                STATE["task"].update({"paused": True, "state": "PAUSED"})
        elif command == "resume":
            if estop:
                return JSONResponse({"error": "Cannot resume: estop active"}, status_code=400)
            with _state_lock:
                STATE["task"].update({"paused": False, "state": "APPROACH"})
        elif command == "home":
            with _state_lock:
                STATE["task"].update({"running": False, "paused": False, "state": "HOME"})
            _going_home = True
        elif command in ("cancel", "stop"):
            with _state_lock:
                STATE["task"].update({"running": False, "paused": False, "state": "IDLE"})
                for s in STATE["program"]["steps"]:
                    s["status"] = "pending"
            _going_home = False
        if _ros_node:
            _ros_node.publish_task_command(command)
        with _state_lock:
            return {"ok": True, "task": copy.deepcopy(STATE["task"])}

    @app.post("/cmd/detection_mode")
    async def cmd_detection_mode(request: Request):
        """Switch depth_segment between 'all' and 'library'."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        mode = str(body.get("mode") or "all")
        if mode not in ("all", "library"):
            return JSONResponse({"error": f"unknown mode {mode!r}"}, status_code=400)
        if _ros_node is None or _ros_node._detection_mode_pub is None:
            return JSONResponse({"error": "ROS node not ready"}, status_code=503)
        m = String()
        m.data = json.dumps({"detection_mode": mode})
        _ros_node._detection_mode_pub.publish(m)
        with _state_lock:
            STATE["detection_mode"] = mode
        return {"ok": True, "mode": mode}

    @app.post("/cmd/generate_program")
    async def cmd_generate_program(request: Request):
        """Trigger auto_program_node to scan the scene and call the LLM."""
        if _ros_node is None or _ros_node._generate_program_pub is None:
            return JSONResponse({"error": "ROS node not ready"}, status_code=503)
        m = String()
        m.data = "generate"
        _ros_node._generate_program_pub.publish(m)
        with _state_lock:
            return {"ok": True, "status": "generating",
                    "auto_status": copy.deepcopy(STATE.get("auto_status", {}))}

    @app.post("/cmd/jog")
    async def cmd_jog(request: Request):
        body = await request.json()
        with _state_lock:
            if STATE["safety"]["estop"]:
                return JSONResponse({"error": "Cannot jog: estop active"}, status_code=400)
            if STATE["safety"]["zone"] != "GREEN":
                return JSONResponse({"error": "Cannot jog: zone not GREEN"}, status_code=400)
        joint = int(body.get("joint", 0))
        delta = float(body.get("delta", 0.0))
        if abs(delta) > 0.175:
            return JSONResponse({"error": "Delta too large (max 10°)"}, status_code=400)
        if not (0 <= joint <= 5):
            return JSONResponse({"error": "Invalid joint index"}, status_code=400)
        with _state_lock:
            STATE["joints"]["positions"][joint] += delta
            return {"ok": True, "joints": copy.deepcopy(STATE["joints"])}

    @app.post("/cmd/gripper")
    async def cmd_gripper(request: Request):
        body = await request.json()
        with _state_lock:
            if STATE["safety"]["estop"]:
                return JSONResponse({"error": "Cannot move gripper: estop active"}, status_code=400)
        action   = body.get("action", "open")
        width_mm = body.get("width_mm")
        with _state_lock:
            STATE["gripper"]["state"] = "moving"
            if width_mm is not None:
                STATE["gripper"]["position_mm"] = float(width_mm)

        async def _finish():
            await asyncio.sleep(0.8)
            with _state_lock:
                if action == "open":
                    STATE["gripper"].update({"state": "open",
                                             "position_mm": float(width_mm or 85.0)})
                else:
                    STATE["gripper"].update({"state": "closed",
                                             "position_mm": float(width_mm or 0.0)})

        asyncio.create_task(_finish())
        with _state_lock:
            return {"ok": True, "gripper": copy.deepcopy(STATE["gripper"])}

    @app.post("/cmd/voice")
    async def cmd_voice(request: Request):
        body = await request.json()
        text = body.get("text", "").lower().strip()
        if _ros_node:
            _ros_node.publish_voice_command(text)
        action = f"Received: {text}"
        if "estop" in text or "emergency" in text:
            with _state_lock:
                STATE["safety"].update({"estop": True, "speed_scale": 0.0})
            action = "Emergency stop triggered"
        elif "home" in text:
            with _state_lock:
                STATE["task"].update({"running": False, "state": "HOME"})
            action = "Moving to home"
        elif "run" in text or "start" in text:
            with _state_lock:
                if not STATE["safety"]["estop"]:
                    STATE["task"].update({"running": True, "state": "APPROACH"})
                    action = "Program started"
                else:
                    action = "Cannot start: estop active"
        elif "stop" in text or "cancel" in text:
            with _state_lock:
                STATE["task"].update({"running": False, "state": "IDLE"})
            action = "Program stopped"
        return {"ok": True, "response": action}

    @app.post("/cmd/program/add")
    async def cmd_program_add(request: Request):
        body = await request.json()
        with _state_lock:
            steps = STATE["program"]["steps"]
            next_id = max((s["id"] for s in steps), default=0) + 1
            steps.append({"id": next_id, "type": body.get("type", "move"),
                           "label": body.get("label", "New step"),
                           "detail": body.get("detail", ""), "status": "pending"})
            return {"ok": True, "program": copy.deepcopy(STATE["program"])}

    @app.post("/cmd/program/remove")
    async def cmd_program_remove(request: Request):
        body = await request.json()
        step_id = int(body.get("id", -1))
        with _state_lock:
            target = next((s for s in STATE["program"]["steps"] if s["id"] == step_id), None)
            if target is None:
                return JSONResponse({"error": f"Step {step_id} not found"}, status_code=404)
            if target["status"] == "active":
                return JSONResponse({"error": "Cannot remove active step"}, status_code=400)
            STATE["program"]["steps"] = [s for s in STATE["program"]["steps"] if s["id"] != step_id]
            return {"ok": True, "program": copy.deepcopy(STATE["program"])}

    @app.post("/cmd/program/reorder")
    async def cmd_program_reorder(request: Request):
        body = await request.json()
        ids = body.get("ids", [])
        with _state_lock:
            id_map = {s["id"]: s for s in STATE["program"]["steps"]}
            reordered = [id_map[i] for i in ids if i in id_map]
            included = set(ids)
            reordered += [s for s in STATE["program"]["steps"] if s["id"] not in included]
            STATE["program"]["steps"] = reordered
            return {"ok": True, "program": copy.deepcopy(STATE["program"])}

    @app.post("/cmd/program/set")
    async def cmd_program_set(request: Request):
        """Replace the entire active program. Used by the wizard's
        "Save & Load" flow — the wizard generates a step list and we
        swap it in wholesale, assigning fresh sequential ids."""
        body = await request.json()
        in_steps = body.get("steps") or []
        if not isinstance(in_steps, list):
            return JSONResponse({"error": "steps must be a list"}, status_code=400)
        normalized = []
        for i, s in enumerate(in_steps, start=1):
            if not isinstance(s, dict):
                continue
            t = s.get("type") or "move"
            normalized.append({
                "id":     i,
                "type":   t,
                "label":  s.get("label") or s.get("action") or t,
                "detail": s.get("detail", ""),
                "status": "pending",
                # Carry through any extra wizard-emitted fields so the
                # editor can read them (action, position, joints, ...).
                **{k: v for k, v in s.items()
                   if k not in {"id", "type", "label", "detail", "status"}},
            })
        with _state_lock:
            STATE["program"]["steps"] = normalized
            return {"ok": True, "program": copy.deepcopy(STATE["program"])}

    @app.post("/cmd/program/update")
    async def cmd_program_update(request: Request):
        """Merge a patch into a single step. Body: {id, patch: {...}}.
        Refuses to touch the 'id' or 'status' fields — those are owned by
        the runtime, not the editor."""
        body = await request.json()
        try:
            step_id = int(body.get("id", -1))
        except (TypeError, ValueError):
            return JSONResponse({"error": "invalid id"}, status_code=400)
        patch = body.get("patch") or {}
        if not isinstance(patch, dict):
            return JSONResponse({"error": "patch must be an object"}, status_code=400)
        patch.pop("id", None)
        patch.pop("status", None)
        with _state_lock:
            target = next((s for s in STATE["program"]["steps"] if s["id"] == step_id), None)
            if target is None:
                return JSONResponse({"error": f"Step {step_id} not found"}, status_code=404)
            target.update(patch)
            return {"ok": True, "program": copy.deepcopy(STATE["program"])}

    # ------------------------------------------------------------------
    # Info endpoints
    # ------------------------------------------------------------------

    @app.get("/health")
    async def health():
        with _ws_lock:
            ns  = len(_state_clients)
            nl  = len(_lidar_clients)
            nm  = len(_mesh_clients)
        with _cam_lock:
            have_cam0 = _cam_frames[0] is not None
            have_cam1 = _cam_frames[1] is not None
        with _lidar_lock:
            lidar_live = _lidar_state["live"]
            _pts = _lidar_state["pts"]
            if _np is not None and isinstance(_pts, _np.ndarray):
                lidar_pts = int(_pts.size // 3)
            else:
                lidar_pts = len(_pts)
        with _mesh_lock:
            mesh_age = round(time.time() - _mesh_state["t"], 2) \
                if _mesh_state["t"] > 0 else None
            mesh_tris = _mesh_state["n_tris"]
        return {
            "status": "ok", "ros": RCLPY_AVAILABLE, "mock": False,
            "uptime_s": round(time.time() - _START_TIME, 1),
            "clients_state": ns, "clients_lidar": nl, "clients_mesh": nm,
            "cam0_live": have_cam0, "cam1_live": have_cam1,
            "lidar_live": lidar_live, "lidar_pts": lidar_pts,
            "mesh_age_s": mesh_age, "mesh_tris": mesh_tris,
        }

    @app.get("/api/state")
    async def api_state():
        with _state_lock:
            return copy.deepcopy(STATE)

    # ------------------------------------------------------------------
    # Parts library — STEP file upload + metadata
    # ------------------------------------------------------------------

    @app.post("/api/parts/upload")
    async def api_parts_upload(file: UploadFile = File(...)):
        """Accept a .step/.stp upload, parse it, persist metadata, and
        copy a rendered .stl into the dashboard's static dir so the
        browser can fetch it for 3D preview."""
        import tempfile
        if not file.filename or not file.filename.lower().endswith(('.step', '.stp')):
            return JSONResponse(
                {"error": "Only .step / .stp files accepted"},
                status_code=400)

        suffix = os.path.splitext(file.filename)[1] or '.step'
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
        # Rename so the .stl that the parser writes lands next to a
        # human-friendly name, not a tempfile prefix.
        nice_path = os.path.join(
            os.path.dirname(tmp_path),
            os.path.basename(file.filename))
        try:
            os.replace(tmp_path, nice_path)
        except OSError:
            nice_path = tmp_path

        try:
            from object_detection.step_parser import parse_step_file
            from object_detection.part_library import add_part
            part_data = parse_step_file(nice_path)
            add_part(nice_path, part_data)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        finally:
            for p in (nice_path, os.path.splitext(nice_path)[0] + '.stl'):
                try:
                    if os.path.exists(p):
                        os.remove(p)
                except OSError:
                    pass

        # No static-dir copy. STL is served directly from
        # /opt/cobot/parts/stl/<file> via the /parts route below — a
        # static-dir copy would get wiped by every `npm run build`
        # (vite clears its outDir before writing).

        return {
            "ok":           True,
            "part_id":      part_data['id'],
            "name":         part_data['name'],
            "extents_cm":   part_data['extents_cm'],
            "grasp":        part_data['grasp'],
            "vertices":     part_data['vertices'],
            "faces":        part_data['faces'],
            "stl_url":      f"/parts/{part_data['stl_file']}",
        }

    @app.get("/api/parts")
    async def api_parts_list():
        from object_detection.part_library import get_all_parts
        parts = get_all_parts()
        # Annotate each entry with its current taught-sample count so
        # the library UI can show "Not taught yet" / "N taught samples".
        teach_base = '/opt/cobot/parts/teach'
        for p in parts:
            d = os.path.join(teach_base, p.get('id') or '')
            try:
                p['teach_count'] = sum(
                    1 for f in os.listdir(d) if f.endswith('.npz')
                ) if os.path.isdir(d) else 0
            except OSError:
                p['teach_count'] = 0
        return {"parts": parts}

    @app.post("/api/parts/{part_id}/teach")
    async def api_parts_teach(part_id: str, request: Request):
        """Tell depth_segment_node to grab the latest detection (or
        the one at detection_index) and store it as a teach reference
        for this part. Body: {"detection_index": int (optional)}.

        Waits ~600 ms after publishing so we can count the .npz files
        on disk and return the new count — the wizard uses this to
        confirm the capture actually landed instead of trusting the
        202-style ack alone."""
        meta_path = f'/opt/cobot/parts/metadata/{part_id}.json'
        if not os.path.isfile(meta_path):
            return JSONResponse({"error": "part not found"}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        det_idx = int(body.get('detection_index') or 0)
        orientation = str(body.get('orientation') or 'pickable')
        if orientation not in ('pickable', 'flipped', 'on_side'):
            orientation = 'pickable'
        if _ros_node is None or _ros_node._teach_cmd_pub is None:
            return JSONResponse({"error": "ROS node not ready"}, status_code=503)

        teach_dir = f'/opt/cobot/parts/teach/{part_id}'
        def _count():
            try:
                return sum(1 for f in os.listdir(teach_dir) if f.endswith('.npz'))
            except OSError:
                return 0
        before = _count()

        _ros_node.get_logger().info(
            f'TEACH: part_id={part_id} detection_index={det_idx} '
            f'orientation={orientation} (before={before})'
        )
        m = String()
        m.data = json.dumps({
            'action':           'teach',
            'part_id':          part_id,
            'detection_index':  det_idx,
            'orientation':      orientation,
        })
        _ros_node._teach_cmd_pub.publish(m)

        # Give depth_segment_node a moment to write the .npz.
        import asyncio as _asyncio
        await _asyncio.sleep(0.6)
        after = _count()
        return {
            "ok":          True,
            "status":      "captured" if after > before else "no_capture",
            "part_id":     part_id,
            "teach_count": after,
            "captured":    after > before,
        }

    @app.post("/api/teach_mode/start")
    async def api_teach_mode_start():
        """Tell depth_segment_node to suppress recognition while the
        teach wizard is open. Returns 200 even when ROS isn't ready —
        the wizard still works, recognition just keeps running."""
        if _ros_node and _ros_node._teach_cmd_pub:
            m = String()
            m.data = json.dumps({'action': 'start_teach'})
            _ros_node._teach_cmd_pub.publish(m)
        return {"ok": True, "teach_mode": True}

    @app.post("/api/teach_mode/stop")
    async def api_teach_mode_stop():
        """Re-enable recognition after the teach wizard closes."""
        if _ros_node and _ros_node._teach_cmd_pub:
            m = String()
            m.data = json.dumps({'action': 'stop_teach'})
            _ros_node._teach_cmd_pub.publish(m)
        return {"ok": True, "teach_mode": False}

    @app.post("/api/parts/{part_id}/teach_clear")
    async def api_parts_teach_clear(part_id: str):
        """Delete every taught reference for this part."""
        import shutil as _sh
        teach_dir = f'/opt/cobot/parts/teach/{part_id}'
        if os.path.isdir(teach_dir):
            _sh.rmtree(teach_dir, ignore_errors=True)
        # Notify depth_segment_node so it can reload its in-memory cache
        if _ros_node and _ros_node._teach_cmd_pub:
            m = String()
            m.data = json.dumps({'action': 'reload'})
            _ros_node._teach_cmd_pub.publish(m)
        return {"ok": True}

    @app.get("/api/parts/{part_id}")
    async def api_parts_get(part_id: str):
        from object_detection.part_library import get_part
        part = get_part(part_id)
        if not part:
            return JSONResponse({"error": "part not found"}, status_code=404)
        return part

    @app.delete("/api/parts/{part_id}")
    async def api_parts_delete(part_id: str):
        from object_detection.part_library import delete_part
        ok = delete_part(part_id)
        if not ok:
            return JSONResponse({"error": "part not found"}, status_code=404)
        return {"ok": True}

    @app.post("/api/parts/match")
    async def api_parts_match(request: Request):
        from object_detection.part_library import match_detection_to_part
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        size = body.get("size_m") or body.get("extents_m") or []
        match, score = match_detection_to_part(list(size))
        if match is None:
            return {"matched": False}
        return {"matched": True, "part": match, "score": score}

    @app.put("/api/parts/{part_id}/tags")
    async def api_parts_tags(part_id: str, request: Request):
        """Update operation tags, program link, station, priority, notes."""
        meta_path = f'/opt/cobot/parts/metadata/{part_id}.json'
        if not os.path.isfile(meta_path):
            return JSONResponse({"error": "part not found"}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        with open(meta_path) as f:
            part = json.load(f)

        ops = body.get('operations') or []
        if not isinstance(ops, list):
            ops = []
        part['operations']   = [str(o) for o in ops]
        part['program_id']   = body.get('program_id') or None
        part['program_name'] = str(body.get('program_name') or '')
        part['station']      = str(body.get('station') or '')
        try:
            prio = int(body.get('priority') or 3)
        except (TypeError, ValueError):
            prio = 3
        part['priority'] = max(1, min(5, prio))
        part['notes']    = str(body.get('notes') or '')

        with open(meta_path, 'w') as f:
            json.dump(part, f, indent=2)

        # Mirror into the compact index entry
        try:
            from object_detection.part_library import LIBRARY_INDEX
            with open(LIBRARY_INDEX) as f:
                idx = json.load(f) or {'parts': []}
            for p in idx.get('parts') or []:
                if p.get('id') == part_id:
                    p['operations']   = part['operations']
                    p['program_id']   = part['program_id']
                    p['program_name'] = part['program_name']
                    p['station']      = part['station']
                    p['priority']     = part['priority']
                    break
            with open(LIBRARY_INDEX, 'w') as f:
                json.dump(idx, f, indent=2)
        except Exception:
            pass

        return {"ok": True, "part": part}

    # Path-traversal guard for /api/programs/{prog_id} routes. Slugs are
    # produced by the POST endpoint as [a-z0-9_]+ so we mirror that here.
    import re as _prog_re
    _PROG_DIR = '/opt/cobot/programs'
    _PROG_ID_RE = _prog_re.compile(r'^[a-z0-9_]+$')

    def _prog_path(prog_id: str):
        if not _PROG_ID_RE.match(prog_id or ''):
            return None
        return os.path.join(_PROG_DIR, prog_id + '.json')

    def _now_stamp():
        return time.strftime('%Y-%m-%d %H:%M')

    @app.get("/api/programs")
    async def api_programs_list():
        """List robot programs available to link parts to. Includes a
        small set of built-in defaults plus any JSON in /opt/cobot/programs/."""
        defaults = [
            {'id': 'pick_and_place',   'name': 'Pick and Place',   'steps': 5, 'builtin': True},
            {'id': 'pick_and_sort',    'name': 'Pick and Sort',    'steps': 7, 'builtin': True},
            {'id': 'pick_and_inspect', 'name': 'Pick and Inspect', 'steps': 6, 'builtin': True},
            {'id': 'assembly_insert',  'name': 'Assembly Insert',  'steps': 8, 'builtin': True},
            {'id': 'palletize',        'name': 'Palletize',        'steps': 4, 'builtin': True},
            {'id': 'depalletize',      'name': 'Depalletize',      'steps': 4, 'builtin': True},
        ]
        programs = list(defaults)
        try:
            os.makedirs(_PROG_DIR, exist_ok=True)
            for fn in sorted(os.listdir(_PROG_DIR)):
                if not fn.endswith('.json'):
                    continue
                try:
                    with open(os.path.join(_PROG_DIR, fn)) as fp:
                        prog = json.load(fp)
                    programs.append({
                        'id':          fn[:-5],
                        'name':        prog.get('name') or fn[:-5],
                        'description': prog.get('description') or '',
                        'steps':       len(prog.get('steps') or []),
                        'tags':        prog.get('tags') or [],
                        'created':     prog.get('created') or '',
                        'updated':     prog.get('updated') or '',
                        'builtin':     False,
                    })
                except Exception:
                    continue
        except Exception:
            pass
        return {"programs": programs}

    @app.post("/api/programs")
    async def api_programs_save(request: Request):
        """Persist a wizard-generated program to /opt/cobot/programs as a
        JSON file. Slug is derived from the name; collisions get a _2,
        _3, ... suffix so we never silently overwrite."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        name = str(body.get("name") or "").strip()
        if not name:
            return JSONResponse({"error": "name required"}, status_code=400)
        steps = body.get("steps") or []
        if not isinstance(steps, list):
            return JSONResponse({"error": "steps must be a list"}, status_code=400)
        base = _prog_re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_') or 'program'
        try:
            os.makedirs(_PROG_DIR, exist_ok=True)
        except Exception as e:
            return JSONResponse({"error": f"cannot create {_PROG_DIR}: {e}"}, status_code=500)
        slug = base
        n = 2
        while os.path.exists(os.path.join(_PROG_DIR, slug + '.json')):
            slug = f"{base}_{n}"
            n += 1
        ts = _now_stamp()
        program = {
            "id":          slug,
            "name":        name,
            "description": str(body.get("description") or ""),
            "tags":        list(body.get("tags") or []),
            "config":      body.get("config") or {},
            "steps":       steps,
            "created":     ts,
            "updated":     ts,
        }
        try:
            with open(os.path.join(_PROG_DIR, slug + '.json'), 'w') as f:
                json.dump(program, f, indent=2)
        except Exception as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        return {"ok": True, "program": program}

    @app.get("/api/programs/{prog_id}")
    async def api_programs_get(prog_id: str):
        path = _prog_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            with open(path) as f:
                return json.load(f)
        except Exception as e:
            return JSONResponse({"error": f"read failed: {e}"}, status_code=500)

    @app.put("/api/programs/{prog_id}")
    async def api_programs_update(prog_id: str, request: Request):
        """Merge an update into the existing program file. Preserves the
        original id and created timestamp; bumps updated. Accepts the
        same shape as POST minus the auto-slugging."""
        path = _prog_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        if "steps" in body and not isinstance(body["steps"], list):
            return JSONResponse({"error": "steps must be a list"}, status_code=400)
        try:
            with open(path) as f:
                prog = json.load(f)
        except Exception as e:
            return JSONResponse({"error": f"read failed: {e}"}, status_code=500)
        for k in ("name", "description", "tags", "config", "steps"):
            if k in body:
                prog[k] = body[k]
        # id is owned by the filename — never let a client change it.
        prog["id"] = prog_id
        prog["updated"] = _now_stamp()
        if "created" not in prog:
            prog["created"] = prog["updated"]
        try:
            with open(path, 'w') as f:
                json.dump(prog, f, indent=2)
        except Exception as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        return {"ok": True, "program": prog}

    @app.delete("/api/programs/{prog_id}")
    async def api_programs_delete(prog_id: str):
        path = _prog_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            os.remove(path)
        except Exception as e:
            return JSONResponse({"error": f"delete failed: {e}"}, status_code=500)
        return {"ok": True}

    # ------------------------------------------------------------------
    # I/O state (Estun S10-140 digital/analog inputs and outputs).
    # In-memory until the robot driver subscribes to /robot/io_command
    # and reports back via /robot/io_state; labels are persisted to
    # /opt/cobot/io_config.json so an installer can rename them.
    # ------------------------------------------------------------------
    _IO_STATE: dict = {}

    @app.get("/api/io/state")
    async def api_io_state():
        return {"io": _IO_STATE}

    @app.post("/api/io/set")
    async def api_io_set(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        io_id = body.get('id')
        if not io_id:
            return JSONResponse({"error": "missing 'id'"}, status_code=400)
        value = body.get('value', 0)
        # Coerce: digitals are 0/1, analogs are floats. Trust the id prefix.
        if isinstance(io_id, str) and io_id.startswith(('DO', 'DI')):
            value = 1 if value else 0
        else:
            try:
                value = float(value)
            except (TypeError, ValueError):
                return JSONResponse({"error": "invalid 'value'"}, status_code=400)
        _IO_STATE[io_id] = value

        # Forward to ROS so the robot driver can actuate the real signal.
        if _ros_node is not None:
            try:
                if not hasattr(_ros_node, '_io_pub'):
                    _ros_node._io_pub = _ros_node.create_publisher(
                        String, "/robot/io_command", 10)
                m = String()
                m.data = json.dumps({"io_id": io_id, "value": value})
                _ros_node._io_pub.publish(m)
            except Exception:
                pass
        return {"ok": True, "id": io_id, "value": value}

    # Factory-default port labels — mirrors IOPanel's IO_CONFIG so any
    # consumer (IOPortSelector dropdowns, program-step detail lines)
    # gets a meaningful name even when the operator hasn't renamed
    # anything. Operator overrides win.
    _IO_FACTORY_LABELS = {
        'DI0':  'Gripper Closed Sensor', 'DI1':  'Gripper Open Sensor',
        'DI2':  'Part Present Sensor',   'DI3':  'Conveyor Running',
        'DI4':  'Safety Gate Closed',    'DI5':  'Light Curtain Clear',
        'DI6':  'Air Pressure OK',       'DI7':  'Cycle Start Button',
        'DI8':  'Emergency Stop Chain',  'DI9':  'Fixture Clamped',
        'DI10': 'Spare Input 10',        'DI11': 'Spare Input 11',
        'DI12': 'Spare Input 12',        'DI13': 'Spare Input 13',
        'DI14': 'Spare Input 14',        'DI15': 'Spare Input 15',
        'DO0':  'Gripper Close',         'DO1':  'Gripper Open',
        'DO2':  'Vacuum On',             'DO3':  'Vacuum Blow Off',
        'DO4':  'Conveyor Forward',      'DO5':  'Conveyor Reverse',
        'DO6':  'Signal Light Green',    'DO7':  'Signal Light Red',
        'DO8':  'Fixture Clamp',         'DO9':  'Fixture Unclamp',
        'DO10': 'Spare Output 10',       'DO11': 'Spare Output 11',
        'DO12': 'Spare Output 12',       'DO13': 'Spare Output 13',
        'DO14': 'Spare Output 14',       'DO15': 'Spare Output 15',
        'AI0':  'Force Sensor',          'AI1':  'Pressure Sensor',
        'AI2':  'Temperature',           'AI3':  'Spare Analog 3',
        'AO0':  'Gripper Force',         'AO1':  'Conveyor Speed',
    }

    @app.get("/api/io/config")
    async def api_io_config_get():
        """Return I/O port labels. Always merges factory defaults with
        any operator overrides on disk so every port has a label."""
        custom = {}
        path = '/opt/cobot/io_config.json'
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    saved = data.get('labels') or {}
                    if isinstance(saved, dict):
                        custom = {k: v for k, v in saved.items() if isinstance(v, str) and v.strip()}
            except Exception:
                pass
        return {"labels": {**_IO_FACTORY_LABELS, **custom}}

    @app.put("/api/io/config")
    async def api_io_config_put(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        path = '/opt/cobot/io_config.json'
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w') as f:
                json.dump(body, f, indent=2)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        return {"ok": True}

    @app.put("/api/parts/{part_id}/config")
    async def api_parts_config(part_id: str, request: Request):
        """Update part orientation, surface choice, and grasp settings."""
        import numpy as _np
        meta_path = f'/opt/cobot/parts/metadata/{part_id}.json'
        if not os.path.isfile(meta_path):
            return JSONResponse({"error": "part not found"}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        with open(meta_path) as f:
            part = json.load(f)

        # Persist the operator-chosen configuration
        part['name']            = str(body.get('name') or part.get('name'))
        part['table_surface']   = str(body.get('table_surface') or '+Z up')
        part['table_rotation']  = list(body.get('table_rotation') or [0.0, 0.0, 0.0])
        part['front_direction'] = str(body.get('front_direction') or '↑ Forward')
        part['front_angle_deg'] = float(body.get('front_angle_deg') or 0.0)
        grasp_in = body.get('grasp') or {}
        prev = part.get('grasp') or {}
        merged = {
            **prev,
            'approach':       str(grasp_in.get('approach') or prev.get('approach') or 'top_down'),
            'pick_offset_cm': float(grasp_in.get('pick_offset_cm') or prev.get('pick_offset_cm') or 2.0),
        }
        # Face-click pick direction — three-floats or None
        for key in ('pick_normal', 'pick_point'):
            v = grasp_in.get(key, prev.get(key))
            if isinstance(v, (list, tuple)) and len(v) == 3:
                merged[key] = [float(v[0]), float(v[1]), float(v[2])]
            elif v is None:
                merged.pop(key, None)
        part['grasp'] = merged

        # Derive footprint + standing height under the chosen rotation.
        rot = part['table_rotation']
        cr, sr = _np.cos(rot[0]), _np.sin(rot[0])
        cp, sp = _np.cos(rot[1]), _np.sin(rot[1])
        cy, sy = _np.cos(rot[2]), _np.sin(rot[2])
        Rx = _np.array([[1,0,0],[0,cr,-sr],[0,sr,cr]])
        Ry = _np.array([[cp,0,sp],[0,1,0],[-sp,0,cp]])
        Rz = _np.array([[cy,-sy,0],[sy,cy,0],[0,0,1]])
        R = Rz @ Ry @ Rx
        ex = part.get('extents_m') or [0.0, 0.0, 0.0]
        corners = _np.array([
            [sx*ex[0]/2, sy*ex[1]/2, sz*ex[2]/2]
            for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
        rotated = corners @ R.T
        part['table_height_m'] = round(float(rotated[:, 2].ptp()), 4)
        part['footprint_cm']   = [
            round(float(rotated[:, 0].ptp()) * 100, 1),
            round(float(rotated[:, 1].ptp()) * 100, 1),
        ]

        with open(meta_path, 'w') as f:
            json.dump(part, f, indent=2)

        # Also update the compact index entry's name
        try:
            from object_detection.part_library import LIBRARY_INDEX
            with open(LIBRARY_INDEX) as f:
                idx = json.load(f) or {'parts': []}
            for p in idx.get('parts') or []:
                if p.get('id') == part_id:
                    p['name'] = part['name']
                    p['grasp'] = part['grasp']
                    break
            with open(LIBRARY_INDEX, 'w') as f:
                json.dump(idx, f, indent=2)
        except Exception:
            pass

        return {"ok": True, "part": part}

    @app.get("/api/config")
    async def api_config():
        return {
            "robot": {"brand": "generic", "dof": 6, "payload_kg": 5.0, "reach_mm": 850},
            "cameras": [{"id": 0, "topic": "/cam0/cam0/color/image_raw", "fps": 15},
                        {"id": 1, "topic": "/cam1/cam1/color/image_raw", "fps": 15}],
            "safety": {"zone_red_m": 0.3, "zone_yellow_m": 0.6, "zone_green_m": 1.2},
            "version": "1.0.0-production",
        }

    # ------------------------------------------------------------------
    # Static file serving (React SPA)
    # ------------------------------------------------------------------

    _static = str(_STATIC_DIR)
    _assets  = os.path.join(_static, "assets")
    if os.path.isdir(_assets):
        app.mount("/assets", StaticFiles(directory=_assets), name="assets")

    # index.html must never be cached by the browser — its content-hashed
    # asset URLs are how new bundles get picked up. A cached shell pins
    # the old hash and the user never sees any rebuild.
    _NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}

    @app.get("/")
    async def serve_index():
        idx = os.path.join(_static, "index.html")
        if os.path.isfile(idx):
            return FileResponse(idx, headers=_NO_CACHE)
        return JSONResponse({"detail": "Frontend not built — run: cd frontend && npm run build"}, status_code=404)

    @app.get("/parts/{filename:path}")
    async def serve_part_asset(filename: str):
        """Serve uploaded part files (.stl, .step) from /opt/cobot/parts.
        Looking up by extension keeps the route URL stable — the
        frontend just fetches /parts/<file>.stl regardless of where it
        lives on disk."""
        if '..' in filename or filename.startswith('/'):
            return JSONResponse({"detail": "bad path"}, status_code=400)
        ext = os.path.splitext(filename)[1].lower().lstrip('.')
        subdir = {'stl': 'stl', 'step': 'step', 'stp': 'step'}.get(ext)
        if not subdir:
            return JSONResponse({"detail": "unsupported"}, status_code=415)
        path = os.path.join('/opt/cobot/parts', subdir, filename)
        if not os.path.isfile(path):
            return JSONResponse({"detail": "not found"}, status_code=404)
        return FileResponse(path)

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith(("api/", "cmd/", "ws/", "stream/", "health", "assets/")):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = os.path.join(_static, full_path)
        if os.path.isfile(candidate):
            return FileResponse(candidate)
        idx = os.path.join(_static, "index.html")
        if os.path.isfile(idx):
            return FileResponse(idx, headers=_NO_CACHE)
        return JSONResponse({"detail": "Not found"}, status_code=404)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _spin_ros(node):
    rclpy.spin(node)


def main(args=None):
    global _ros_node

    if not FASTAPI_AVAILABLE:
        print("FastAPI/uvicorn not installed. Run: pip3 install fastapi uvicorn")
        return

    if RCLPY_AVAILABLE:
        rclpy.init(args=args)
        _ros_node = DashboardServer()
        ros_thread = threading.Thread(target=_spin_ros, args=(_ros_node,), daemon=True)
        ros_thread.start()
    else:
        print("WARNING: rclpy not available — running without ROS2 (simulation mode)")

    try:
        uvicorn.run(app, host="0.0.0.0", port=8080, log_level="warning")
    except KeyboardInterrupt:
        pass
    finally:
        if _ros_node and RCLPY_AVAILABLE:
            _ros_node.destroy_node()
            rclpy.shutdown()


if __name__ == "__main__":
    main()
