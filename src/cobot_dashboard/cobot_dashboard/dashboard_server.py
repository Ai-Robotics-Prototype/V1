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
from datetime import datetime
from pathlib import Path

# Dual-import shim — matches inspection_helpers below. The systemd unit
# runs this file as a script (no parent package), so relative imports
# fail; the ROS2 entry-point path has a parent package and prefers them.
try:
    from . import motioncam as _mc
except ImportError:
    import sys as _sys_for_mc
    _this_dir = str(Path(__file__).resolve().parent)
    if _this_dir not in _sys_for_mc.path:
        _sys_for_mc.path.insert(0, _this_dir)
    import motioncam as _mc

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
    "openvocab": {
        "enabled":      False,            # toggled by frontend; gates ROS publishing of prompts
        "prompts":      [],               # text prompts the operator wants detected
        "detections":   [],               # last detection set from the node (status & objects)
        "stalled":      False,
        "frame_age_s":  None,
        "inference_ms": 0.0,
        "fps":          0.0,
        "device":       "",
        "image_w":      0,
        "image_h":      0,
        "image_topic":  "",
        "model":        "",
        "error":        None,
    },
    "collision": {
        "status": "clear",         # clear | warning | collision
        "min_distance_m": None,
        "objects": [],             # ordered nearest-first
        "have_joints": False,
        "reach_radius_m": 1.4,
        "warn_distance_m": 0.150,
        "critical_distance_m": 0.050,
        "mock_objects": [],        # synthetic AABBs from /api/collision/mock
    },
    "placed_objects": [],
    "scene_graph": {"objects": []},
    "grasp_poses": [],
    "reconstruction": {"active": False, "voxels_occupied": 0, "mesh_triangles": 0},
    "gripper": {"state": "open", "position_mm": 85.0},
    # Real-robot mirror — populated by /estun/status when the driver is
    # connected. Kept distinct from "joints" so the sim path keeps working
    # when the driver is offline; when present, robot.connected=true means
    # joints/tcp_pose in STATE are real readings.
    "robot": {
        "connected": False,
        "mode": "disconnected",
        "safety_mode": "unknown",
        "status_flag": 0,
        "moving": False,
    },
    "tcp_pose": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    "program": {
        # All steps start 'pending' — task.run resets them then marks
        # step 0 'active'; task.cancel / completion resets back. No
        # baked-in 'done'/'active' so the editor doesn't paint an
        # execution highlight when nothing's running. Each step carries
        # both 'type' (legacy schema) and 'action' (richer wizard
        # schema) so the editor's teach-gate works on the defaults.
        "steps": [
            {"id": 1, "type": "home",    "action": "move_home",    "label": "Move to home",    "detail": "J: [0,−90,0,−90,0,0]°",     "status": "pending"},
            {"id": 2, "type": "gripper", "action": "open_gripper", "label": "Open gripper",    "detail": "Width: 85 mm · Speed: 80%", "status": "pending"},
            {"id": 3, "type": "move",    "action": "approach",     "label": "Approach object", "detail": "Target: auto · +150 mm Z",  "status": "pending"},
            {"id": 4, "type": "gripper", "action": "pick",         "label": "Pick & close",    "detail": "Descend 130 mm · close",    "status": "pending"},
            {"id": 5, "type": "move",    "action": "place",        "label": "Place at target", "detail": "X: 0.30 Y: −0.20 Z: 0.40", "status": "pending"},
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
_insp_clients:  dict = {}   # /ws/inspection — live inspection status
_motioncam_cloud_clients: dict = {}
_motioncam_reco_clients:  dict = {}
_ws_lock = threading.Lock()

# MotionCam state — single shared instance for the dashboard server.
# The synthetic generator only ticks when STATE.motioncam_state.get_mock()
# is True; otherwise we wait for real driver topics.
_motioncam = _mc.MotionCamState()
_motioncam_synth = _mc.SyntheticSource()

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
        # Collision monitor (capsule-vs-bbox proximity from the LiDAR identifier).
        # Both topics are JSON over std_msgs/String so we can stay schema-free
        # while iterating; can be upgraded to typed msgs later.
        self.create_subscription(String, "/collision/objects", self._on_collision_objects, 5)
        self.create_subscription(String, "/collision/status",  self._on_collision_status,  5)
        # NanoOWL open-vocabulary detector — JSON status over /perception/openvocab_detections
        self.create_subscription(String, "/perception/openvocab_detections",
                                 self._on_openvocab, 5)
        # Outbound prompts channel for the NanoOWL node (frontend updates → node)
        self._openvocab_prompts_pub = self.create_publisher(
            String, "/perception/openvocab/prompts", 5)

        # Estun driver status (publishes robot mode, joints, TCP pose as JSON).
        # When connected, this overwrites the sim joints — real wins.
        self.create_subscription(String, "/estun/status", self._on_estun_status, 10)

        # Program executor state (richer than /task/status: step labels,
        # cycle stats, executor-state strings like 'waiting_motion').
        self.create_subscription(String, "/task/state", self._on_task_state, 10)

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

    def _on_openvocab(self, msg):
        """Mirror /perception/openvocab_detections (JSON over String) into
        STATE['openvocab']. Frontend reads this via /ws/state to render the
        overlay + side panel + stalled banner."""
        try:
            payload = json.loads(msg.data) if msg.data else {}
        except Exception:
            return
        with _state_lock:
            ov = STATE["openvocab"]
            ov["detections"]   = list(payload.get("detections") or [])
            ov["stalled"]      = bool(payload.get("stalled"))
            ov["frame_age_s"]  = payload.get("frame_age_s")
            ov["inference_ms"] = float(payload.get("inference_ms") or 0.0)
            ov["fps"]          = float(payload.get("fps") or 0.0)
            ov["device"]       = str(payload.get("device") or "")
            ov["image_w"]      = int(payload.get("image_w") or 0)
            ov["image_h"]      = int(payload.get("image_h") or 0)
            ov["image_topic"]  = str(payload.get("image_topic") or "")
            ov["model"]        = str(payload.get("model") or "")
            ov["error"]        = payload.get("error")
            # NanoOWL echoes back the prompts it's currently running with —
            # we don't trust this as authoritative (frontend owns the list)
            # but it's useful for diagnosing.
            ov["prompts_echo"] = list(payload.get("prompts") or [])

    def publish_openvocab_prompts(self, prompts):
        """Send a fresh prompt list to the NanoOWL node over the ROS topic
        the node subscribes to. Called by the /api/openvocab/prompts POST
        handler whenever the operator edits the prompt list. When the panel
        is disabled (or the prompt list is empty), the node receives [] and
        publishes empty detections."""
        if self._openvocab_prompts_pub is None:
            return
        try:
            msg = String()
            msg.data = json.dumps({'prompts': list(prompts or [])})
            self._openvocab_prompts_pub.publish(msg)
        except Exception as e:
            self.get_logger().warn(f'openvocab prompt publish failed: {e}')

    def _on_collision_objects(self, msg):
        """Mirror /collision/objects (JSON over String) into STATE['collision'].
        Mock objects (from /api/collision/mock) are re-classified using the
        current thresholds and merged with the real list, then sorted
        nearest-first so the frontend can render both interchangeably."""
        try:
            payload = json.loads(msg.data) if msg.data else {}
        except Exception:
            return
        real_objects = list(payload.get("objects") or [])
        with _state_lock:
            c = STATE["collision"]
            c["reach_radius_m"]     = float(payload.get("reach_radius_m", c.get("reach_radius_m", 1.4)))
            c["warn_distance_m"]    = float(payload.get("warn_distance_m", c.get("warn_distance_m", 0.150)))
            c["critical_distance_m"] = float(payload.get("critical_distance_m", c.get("critical_distance_m", 0.050)))
            c["have_joints"]        = bool(payload.get("have_joints", c.get("have_joints", False)))
            mocks = c.get("mock_objects") or []
            for m in mocks:
                _classify_mock_entry(m, c)
            merged = real_objects + list(mocks)
            merged.sort(key=lambda r: r.get("min_distance_m") or 1e9)
            c["objects"] = merged

    def _on_collision_status(self, msg):
        try:
            payload = json.loads(msg.data) if msg.data else {}
        except Exception:
            return
        with _state_lock:
            c = STATE["collision"]
            real_status = str(payload.get("status") or "clear")
            real_min    = payload.get("min_distance_m")
            worst = real_status
            min_d = real_min if real_min is not None else float('inf')
            for m in (c.get("mock_objects") or []):
                _classify_mock_entry(m, c)
                if m["status"] == "collision":
                    worst = "collision"
                elif m["status"] == "warning" and worst != "collision":
                    worst = "warning"
                if m["min_distance_m"] < min_d:
                    min_d = m["min_distance_m"]
            c["status"]         = worst
            c["min_distance_m"] = (min_d if min_d != float('inf') else None)

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

    def _on_task_state(self, msg):
        """Merge the program executor's state into STATE.task. Maps the
        executor's 'state' string onto the running/paused booleans the
        existing UI reads, and adds the richer fields (step_label,
        cycle_count, etc.) for the Monitor dashboard."""
        try:
            d = json.loads(msg.data)
        except Exception:
            return
        exec_state = d.get("state", "idle")
        running_states = {"running", "waiting_motion", "waiting_io",
                          "waiting_detect", "waiting_time"}
        paused = (exec_state == "paused")
        running = paused or (exec_state in running_states)
        with _state_lock:
            t = STATE["task"]
            t["running"] = running
            t["paused"]  = paused
            t["state"]   = exec_state
            cur = d.get("current_step", -1)
            tot = d.get("total_steps", 0)
            if isinstance(cur, int) and cur >= 0:
                t["program_step"] = cur
            t["program_total"]   = int(tot) if isinstance(tot, int) else t.get("program_total", 0)
            # Richer passthrough fields the Monitor consumes directly.
            for k in ("program_id", "program_name", "step_label", "step_action",
                      "cycle_count", "last_cycle_time", "total_picks",
                      "pick_passes", "pick_fails",
                      "scan_results", "scan_count", "identified_count",
                      "pallet_mode", "pallet_cycle", "pallet_total",
                      "pallet_row", "pallet_col", "pallet_layer"):
                if k in d:
                    t[k] = d[k]

    def _on_estun_status(self, msg):
        """Mirror the Estun driver's status blob into STATE."""
        try:
            d = json.loads(msg.data)
        except Exception:
            return
        with _state_lock:
            r = STATE.setdefault("robot", {})
            r["connected"]   = bool(d.get("connected", False))
            r["mode"]        = d.get("robot_mode", "unknown")
            r["safety_mode"] = d.get("safety_mode", "unknown")
            r["status_flag"] = int(d.get("status_flag", 0))
            r["moving"]      = bool(d.get("moving", False))
            # Joints (rad) — only overwrite if the driver gave us real data.
            jr = d.get("joints_rad")
            if isinstance(jr, list) and len(jr) == 6:
                STATE["joints"]["positions"] = list(jr)
            # TCP pose (m / rad)
            tcp = d.get("tcp_m")
            if isinstance(tcp, list) and len(tcp) == 6:
                STATE["tcp_pose"] = list(tcp)
            # Estop — real robot is authoritative when connected
            if r["connected"] and "estop" in d:
                STATE["safety"]["estop"] = bool(d["estop"])
            # Task running mirror — only when not driven by the project runner
            if r["connected"] and not STATE["task"].get("running", False):
                STATE["task"]["running"] = bool(d.get("moving", False))

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
        motioncam_hz = 10
        motioncam_reco_hz = 4
        state_dt  = 1.0 / state_hz
        lidar_dt  = 1.0 / lidar_hz
        mesh_dt   = 1.0 / mesh_hz
        motioncam_dt = 1.0 / motioncam_hz
        motioncam_reco_dt = 1.0 / motioncam_reco_hz
        next_state = time.time()
        next_lidar = time.time()
        next_mesh  = time.time()
        next_motioncam = time.time()
        next_motioncam_reco = time.time()
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

            if now >= next_motioncam:
                # Tick the synthetic source when mock is on; the real path
                # (DashboardServer node) writes frames directly into _motioncam
                # via update_real_frame, so we only need to package the latest
                # snapshot for clients here.
                if _motioncam.get_mock():
                    try:
                        sframe = _motioncam_synth.step()
                        _motioncam.update_mock_frame(sframe)
                        _motioncam.update_recognitions(_motioncam_synth.recognitions())
                    except Exception as e:
                        print(f"[motioncam] synth error: {e}", flush=True)
                frame = _motioncam.snapshot_frame()
                payload = _mc.pack_mock_cloud(frame) if frame.n else None
                if payload is not None:
                    with _ws_lock:
                        clients = list(_motioncam_cloud_clients.items())
                    for ws, q in clients:
                        if q.qsize() < 2:
                            try:
                                await q.put(('binary', payload))
                            except Exception:
                                pass
                next_motioncam = now + motioncam_dt

            if now >= next_motioncam_reco:
                items = _motioncam.snapshot_recognitions()
                txt = json.dumps(_mc.pack_recognition_payload(items))
                with _ws_lock:
                    clients = list(_motioncam_reco_clients.items())
                for ws, q in clients:
                    if q.qsize() < 2:
                        try:
                            await q.put(txt)
                        except Exception:
                            pass
                next_motioncam_reco = now + motioncam_reco_dt

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

    @app.websocket("/ws/motioncam_cloud")
    async def ws_motioncam_cloud(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _motioncam_cloud_clients[websocket] = q
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
                _motioncam_cloud_clients.pop(websocket, None)

    @app.websocket("/ws/motioncam_recognition")
    async def ws_motioncam_recognition(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _motioncam_reco_clients[websocket] = q
        try:
            while True:
                txt = await q.get()
                await websocket.send_text(txt)
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _motioncam_reco_clients.pop(websocket, None)

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
            # Mirror to Estun driver: project commands plus home/stop pass-through.
            try:
                if not hasattr(_ros_node, "_estun_cmd_pub"):
                    _ros_node._estun_cmd_pub = _ros_node.create_publisher(
                        String, "/estun/command", 10)
                action_map = {"run": "run", "pause": "pause", "resume": "resume",
                              "home": "home", "stop": "stop", "cancel": "stop"}
                est_action = action_map.get(command)
                if est_action:
                    m = String()
                    m.data = json.dumps({"action": est_action})
                    _ros_node._estun_cmd_pub.publish(m)
            except Exception:
                pass
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
            joints_snapshot = copy.deepcopy(STATE["joints"])
        # Forward to Estun driver — the sim update above keeps the UI
        # responsive when the driver isn't connected; when it is, the
        # driver's /estun/status feedback will overwrite STATE.joints.
        if _ros_node is not None:
            try:
                if not hasattr(_ros_node, "_estun_jog_pub"):
                    _ros_node._estun_jog_pub = _ros_node.create_publisher(
                        String, "/robot/jog_command", 10)
                speed_pct = abs(delta) / 0.175 * 100.0  # delta -> 0..100
                m = String()
                m.data = json.dumps({
                    "mode":      "joint",
                    "axis":      joint + 1,         # Estun uses 1-indexed joints
                    "direction": 1 if delta >= 0 else -1,
                    "speed":     int(max(1, min(100, speed_pct))),
                    "step":      float(abs(delta)),
                })
                _ros_node._estun_jog_pub.publish(m)
            except Exception:
                pass
        return {"ok": True, "joints": joints_snapshot}

    @app.post("/cmd/jog_cartesian")
    async def cmd_jog_cartesian(request: Request):
        """Cartesian-space jog. The sim has no IK so the arm doesn't
        visibly move here — we just publish the command on a ROS topic
        for a real driver to consume. Same safety gates as joint jog."""
        body = await request.json()
        with _state_lock:
            if STATE["safety"]["estop"]:
                return JSONResponse({"error": "Cannot jog: estop active"}, status_code=400)
            if STATE["safety"]["zone"] != "GREEN":
                return JSONResponse({"error": "Cannot jog: zone not GREEN"}, status_code=400)
        if _ros_node is not None:
            try:
                if not hasattr(_ros_node, '_jog_cart_pub'):
                    _ros_node._jog_cart_pub = _ros_node.create_publisher(
                        String, "/robot/jog_cartesian", 10)
                m = String()
                m.data = json.dumps({
                    "axis":      str(body.get("axis", "")),
                    "direction": int(body.get("direction", 1)),
                    "step":      float(body.get("step", 1.0)),
                    "speed":     int(body.get("speed", 20)),
                })
                _ros_node._jog_cart_pub.publish(m)
            except Exception:
                pass
        return {"ok": True}

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
        mc_status = _motioncam.snapshot_status()
        return {
            "status": "ok", "ros": RCLPY_AVAILABLE, "mock": False,
            "uptime_s": round(time.time() - _START_TIME, 1),
            "clients_state": ns, "clients_lidar": nl, "clients_mesh": nm,
            "cam0_live": have_cam0, "cam1_live": have_cam1,
            "lidar_live": lidar_live, "lidar_pts": lidar_pts,
            "mesh_age_s": mesh_age, "mesh_tris": mesh_tris,
            "motioncam": {
                "connected":    mc_status["connected"],
                "mock_enabled": mc_status["mock_enabled"],
                "point_count":  mc_status["point_count"],
                "fps":          mc_status["fps"],
            },
        }

    @app.get("/api/state")
    async def api_state():
        with _state_lock:
            return copy.deepcopy(STATE)

    # ------------------------------------------------------------------
    # Collision monitor — mock-injection endpoints
    # ------------------------------------------------------------------
    # The collision pipeline runs in roboai-collision-monitor against the
    # LiDAR identifier's real detections. These endpoints let the operator
    # inject a synthetic AABB at a chosen position to verify the
    # green→yellow→red threshold transitions without staging a real
    # object on the bench. The dashboard treats mock entries identically
    # to real ones when rendering the 3D scene + side panel.

    def _classify_mock_entry(entry, thresholds):
        """Recompute distance + status for one mock object using a
        simplified "vertical base capsule at origin, radius 0.15 m"
        kinematic — good enough for testing thresholds with no robot
        present. Mutates the entry in place."""
        cx = float(entry.get('center', {}).get('x') or 0.0)
        cy = float(entry.get('center', {}).get('y') or 0.0)
        dx = float(entry.get('dimensions', {}).get('x') or 0.0)
        dy = float(entry.get('dimensions', {}).get('y') or 0.0)
        # Closest point on AABB to (0,0) in the XY plane, minus base radius.
        clx = max(-dx / 2.0, min(0 - cx, dx / 2.0)) + cx
        cly = max(-dy / 2.0, min(0 - cy, dy / 2.0)) + cy
        d = math.hypot(clx, cly) - 0.15
        d = max(0.0, d)
        warn = float(thresholds.get('warn_distance_m', 0.15))
        crit = float(thresholds.get('critical_distance_m', 0.05))
        if d < crit:    status = 'collision'
        elif d < warn:  status = 'warning'
        else:           status = 'clear'
        entry['min_distance_m'] = d
        entry['status']         = status
        entry['nearest_link']   = 'base (mock)'
        entry['mock']           = True
        return entry

    def _rebuild_collision_state():
        """Recompute mock statuses and re-derive overall status. Called
        whenever mocks change so the operator sees instant feedback even
        before the next /collision/objects tick arrives."""
        with _state_lock:
            c = STATE["collision"]
            mocks = c.get("mock_objects") or []
            for m in mocks:
                _classify_mock_entry(m, c)
            # Worst-of-all overall status
            worst = c.get("status") or "clear"
            for m in mocks:
                if m["status"] == "collision":
                    worst = "collision"; break
                if m["status"] == "warning" and worst != "collision":
                    worst = "warning"
            c["status"] = worst

    @app.post("/api/collision/mock")
    async def api_collision_mock_post(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        cx = float((body.get("center") or {}).get("x") or 0.0)
        cy = float((body.get("center") or {}).get("y") or 0.0)
        cz = float((body.get("center") or {}).get("z") or 0.3)
        dx = float((body.get("dimensions") or {}).get("x") or 0.12)
        dy = float((body.get("dimensions") or {}).get("y") or 0.12)
        dz = float((body.get("dimensions") or {}).get("z") or 0.20)
        import uuid as _uuid
        entry = {
            "id":         -abs(hash(_uuid.uuid4().hex)) % 99999 - 1,  # negative id flags it as mock
            "name":       str(body.get("name") or "mock"),
            "identified_as": "mock",
            "confidence": 0.0,
            "static":     False,
            "frames_observed": 0,
            "center":     {"x": cx, "y": cy, "z": cz},
            "dimensions": {"x": dx, "y": dy, "z": dz},
            "orientation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
        }
        replace = bool(body.get("replace", True))
        with _state_lock:
            c = STATE["collision"]
            if replace:
                c["mock_objects"] = [entry]
            else:
                c["mock_objects"].append(entry)
        _rebuild_collision_state()
        with _state_lock:
            return {"ok": True, "mock_objects": list(STATE["collision"]["mock_objects"])}

    @app.delete("/api/collision/mock")
    async def api_collision_mock_clear():
        with _state_lock:
            STATE["collision"]["mock_objects"] = []
        _rebuild_collision_state()
        return {"ok": True}

    @app.get("/api/collision")
    async def api_collision_get():
        with _state_lock:
            return copy.deepcopy(STATE["collision"])

    # ------------------------------------------------------------------
    # NanoOWL open-vocabulary detection — prompt management
    # ------------------------------------------------------------------
    # The dashboard does NOT run OWL-ViT itself — that lives in
    # roboai-nanoowl. We just store the operator's intent (prompts +
    # enabled flag) in STATE["openvocab"] and push the prompts to the
    # node over the ROS topic the node subscribes to. The frontend
    # reads STATE["openvocab"] via /ws/state for detection results.

    @app.get("/api/openvocab")
    async def api_openvocab_get():
        with _state_lock:
            return copy.deepcopy(STATE["openvocab"])

    @app.post("/api/openvocab/prompts")
    async def api_openvocab_prompts(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        prompts_in = body.get("prompts") or []
        if not isinstance(prompts_in, list):
            return JSONResponse({"error": "'prompts' must be a list"}, status_code=400)
        prompts = [str(p).strip() for p in prompts_in if str(p).strip()]
        enabled = bool(body.get("enabled", True))
        with _state_lock:
            STATE["openvocab"]["prompts"] = prompts
            STATE["openvocab"]["enabled"] = enabled
        # Push to the node. If the panel is disabled OR the list is empty,
        # we explicitly publish [] so the node clears its detections instead
        # of carrying on with the last-known prompts.
        outgoing = prompts if enabled else []
        try:
            if _ros_node is not None:
                _ros_node.publish_openvocab_prompts(outgoing)
        except Exception as e:
            return JSONResponse({"error": f"prompt publish failed: {e}"},
                                status_code=500)
        return {"ok": True, "prompts": prompts, "enabled": enabled}

    # ------------------------------------------------------------------
    # MotionCam-3D Color S+ — status, mode, scene control
    # ------------------------------------------------------------------

    @app.get("/api/motioncam/status")
    async def api_motioncam_status():
        s = _motioncam.snapshot_status()
        s["topics"] = _motioncam.get_topics()
        return s

    @app.post("/api/motioncam/mode")
    async def api_motioncam_mode(request: Request):
        body = await request.json()
        mode = body.get("mode", "")
        if mode not in ("scanner", "camera"):
            return JSONResponse({"error": "mode must be 'scanner' or 'camera'"},
                                status_code=400)
        _motioncam.set_mode(mode)
        # Real driver hook: if a driver client lives elsewhere, switch its
        # capture mode here. The Photoneo driver service name isn't yet
        # confirmed — leaving this as a stub so the UI is exercisable.
        return {"ok": True, "mode": mode}

    @app.post("/api/motioncam/mock")
    async def api_motioncam_mock(request: Request):
        body = await request.json()
        enabled = bool(body.get("enabled", False))
        _motioncam.set_mock(enabled)
        return {"ok": True, "mock_enabled": enabled}

    @app.post("/api/motioncam/topics")
    async def api_motioncam_topics(request: Request):
        body = await request.json()
        topics = body.get("topics") if isinstance(body, dict) else None
        if not isinstance(topics, dict):
            return JSONResponse({"error": "expected {topics: {...}}"},
                                status_code=400)
        _motioncam.set_topics(topics)
        return {"ok": True, "topics": _motioncam.get_topics()}

    @app.post("/api/motioncam/scene/start")
    async def api_motioncam_scene_start():
        _motioncam.scene_start()
        return {"ok": True, "status": _motioncam.snapshot_status()["scene"]}

    @app.post("/api/motioncam/scene/stop")
    async def api_motioncam_scene_stop():
        _motioncam.scene_stop()
        return {"ok": True, "status": _motioncam.snapshot_status()["scene"]}

    @app.post("/api/motioncam/scene/clear")
    async def api_motioncam_scene_clear():
        _motioncam.scene_clear()
        return {"ok": True, "status": _motioncam.snapshot_status()["scene"]}

    @app.post("/api/motioncam/scene/save")
    async def api_motioncam_scene_save():
        try:
            target = _motioncam.scene_save()
            return {"ok": True, "path": str(target)}
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @app.get("/api/motioncam/scene")
    async def api_motioncam_scene():
        snap = _motioncam.scene_snapshot()
        # Keep the JSON payload bounded — return a stride-decimated view of
        # the scene cloud rather than the raw accumulator dump.
        max_pts = 80000
        n = snap["n"]
        pts = snap["points"]
        cols = snap["colors"]
        if n > max_pts:
            stride = max(1, n // max_pts)
            stripped_pts = []
            stripped_cols = []
            for i in range(0, n, stride):
                stripped_pts.extend(pts[i * 3:i * 3 + 3])
                if len(cols) >= (i + 1) * 3:
                    stripped_cols.extend(cols[i * 3:i * 3 + 3])
            snap["points"] = stripped_pts
            snap["colors"] = stripped_cols
            snap["n"] = len(stripped_pts) // 3
            snap["downsampled_from"] = n
        return snap

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

    # ------------------------------------------------------------------
    # Custom gripper upload / library
    # ------------------------------------------------------------------
    _GRIPPERS_DIR = '/opt/cobot/grippers'

    def _gripper_root(gid: str) -> str:
        """Return the per-gripper directory under /opt/cobot/grippers,
        guarding against `..` traversal in the id."""
        if not gid or '/' in gid or '..' in gid:
            return ''
        return os.path.join(_GRIPPERS_DIR, gid)

    def _read_gripper_meta(gid: str) -> dict:
        root = _gripper_root(gid)
        if not root:
            return {}
        path = os.path.join(root, 'metadata.json')
        if not os.path.isfile(path):
            return {}
        try:
            with open(path) as f:
                return json.load(f) or {}
        except Exception:
            return {}

    @app.post("/api/gripper/upload")
    async def api_gripper_upload(file: UploadFile = File(...)):
        """Accept a .step/.stp gripper model. Reuses the parts step
        parser to load + scale + extract bounds + export .stl; adds a
        .glb export on top via trimesh so the dashboard's 3D viewer
        can render it directly. Saves everything under
        /opt/cobot/grippers/{id}/ keyed by the file's md5 hash so
        re-uploading the same STEP is idempotent."""
        import tempfile, shutil, hashlib
        if not file.filename or not file.filename.lower().endswith(('.step', '.stp')):
            return JSONResponse(
                {"error": "Only .step / .stp files accepted"},
                status_code=400)

        suffix   = os.path.splitext(file.filename)[1] or '.step'
        raw_name = os.path.basename(file.filename)
        base_name = os.path.splitext(raw_name)[0]
        try:
            os.makedirs(_GRIPPERS_DIR, exist_ok=True)
        except Exception as e:
            return JSONResponse({"error": f"cannot create {_GRIPPERS_DIR}: {e}"}, status_code=500)

        # Save the upload to a temp file. parse_step_file writes a
        # sibling .stl which we'll move into the gripper dir alongside
        # the source .step.
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        try:
            with open(tmp_path, 'rb') as f:
                gid = hashlib.md5(f.read()).hexdigest()[:12]
            target_dir = os.path.join(_GRIPPERS_DIR, gid)
            os.makedirs(target_dir, exist_ok=True)
            step_dest = os.path.join(target_dir, gid + '.step')
            stl_dest  = os.path.join(target_dir, gid + '.stl')
            glb_dest  = os.path.join(target_dir, gid + '.glb')

            # Move uploaded step into target dir with the canonical name.
            shutil.copy2(tmp_path, step_dest)

            # Reuse the existing parts pipeline for load + scale +
            # extents + STL export. parse_step_file also generates
            # silhouettes/templates in /opt/cobot/parts — they're
            # harmless orphans for a gripper file and dedupe on hash.
            try:
                from object_detection.step_parser import parse_step_file
                import trimesh
            except Exception as e:
                return JSONResponse({"error": f"parser unavailable: {e}"}, status_code=500)
            try:
                meta = parse_step_file(step_dest)
            except Exception as e:
                return JSONResponse({"error": f"STEP parse failed: {e}"}, status_code=500)

            # parse_step_file writes the .stl alongside the .step with
            # the same basename — move it to its canonical id.stl path.
            parsed_stl = os.path.splitext(step_dest)[0] + '.stl'
            try:
                if os.path.exists(parsed_stl) and parsed_stl != stl_dest:
                    shutil.move(parsed_stl, stl_dest)
            except Exception:
                pass

            # Re-load the STL to export as GLB. trimesh's GLB export
            # bundles the mesh into a single-binary gltf the Three.js
            # GLTFLoader reads directly. STL → GLB keeps the pipeline
            # parser-agnostic (no second STEP parse).
            try:
                mesh = trimesh.load(stl_dest if os.path.exists(stl_dest) else step_dest, force='mesh')
                if isinstance(mesh, trimesh.Scene):
                    mesh = mesh.dump(concatenate=True)
                mesh.export(glb_dest, file_type='glb')
            except Exception as e:
                return JSONResponse({"error": f"GLB export failed: {e}"}, status_code=500)

            extents_cm = list(meta.get('extents_cm') or [0, 0, 0])
            display_name = base_name or meta.get('name', gid)
            metadata = {
                'id':         gid,
                'name':       display_name,
                'source_file': raw_name,
                'glb_url':    f'/grippers/glb/{gid}.glb',
                'stl_url':    f'/grippers/stl/{gid}.stl',
                'dimensions': {
                    'w_cm': float(extents_cm[0]) if len(extents_cm) > 0 else 0.0,
                    'd_cm': float(extents_cm[1]) if len(extents_cm) > 1 else 0.0,
                    'h_cm': float(extents_cm[2]) if len(extents_cm) > 2 else 0.0,
                },
                'uploaded_at': _now_stamp(),
            }
            try:
                with open(os.path.join(target_dir, 'metadata.json'), 'w') as f:
                    json.dump(metadata, f, indent=2)
            except Exception:
                pass
            return metadata
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass

    @app.get("/api/gripper/list")
    async def api_gripper_list():
        """List every uploaded gripper model."""
        out = []
        try:
            if os.path.isdir(_GRIPPERS_DIR):
                for gid in sorted(os.listdir(_GRIPPERS_DIR)):
                    meta = _read_gripper_meta(gid)
                    if meta and meta.get('id'):
                        out.append(meta)
        except Exception:
            pass
        return {"grippers": out}

    @app.delete("/api/gripper/{gid}")
    async def api_gripper_delete(gid: str):
        import shutil
        root = _gripper_root(gid)
        if not root:
            return JSONResponse({"error": "bad id"}, status_code=400)
        if not os.path.isdir(root):
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            shutil.rmtree(root)
        except Exception as e:
            return JSONResponse({"error": f"delete failed: {e}"}, status_code=500)
        return {"ok": True, "id": gid}

    @app.get("/grippers/{kind}/{filename:path}")
    async def serve_gripper_asset(kind: str, filename: str):
        """Serve the GLB / STL / STEP assets for a stored gripper.
        URL shape: /grippers/glb/{id}.glb (also /stl/, /step/)."""
        if '..' in filename or filename.startswith('/'):
            return JSONResponse({"detail": "bad path"}, status_code=400)
        if kind not in ('glb', 'stl', 'step'):
            return JSONResponse({"detail": "unsupported"}, status_code=415)
        gid = os.path.splitext(filename)[0]
        root = _gripper_root(gid)
        if not root:
            return JSONResponse({"detail": "bad id"}, status_code=400)
        path = os.path.join(root, filename)
        if not os.path.isfile(path):
            return JSONResponse({"detail": "not found"}, status_code=404)
        media = {
            'glb':  'model/gltf-binary',
            'stl':  'application/sla',
            'step': 'application/step',
        }[kind]
        return FileResponse(path, media_type=media)

    # ── STEP features (new architecture) ─────────────────────────────
    # The STEP feature dictionary + per-orientation signatures live at
    # /opt/cobot/parts/features/{id}_{features,orientation_signatures}.json.
    # They're written by step_parser at upload time and rewritten here
    # when the operator picks a pick direction.
    _FEATURES_DIR = '/opt/cobot/parts/features'

    def _features_paths(part_id: str):
        return (
            os.path.join(_FEATURES_DIR, f'{part_id}_features.json'),
            os.path.join(_FEATURES_DIR, f'{part_id}_orientation_signatures.json'),
        )

    def _load_features_doc(part_id: str) -> dict:
        fp, _ = _features_paths(part_id)
        if not os.path.isfile(fp):
            return {}
        try:
            with open(fp) as f:
                return json.load(f) or {}
        except Exception:
            return {}

    def _load_orientation_signatures(part_id: str) -> dict:
        _, sp = _features_paths(part_id)
        if not os.path.isfile(sp):
            return {}
        try:
            with open(sp) as f:
                return json.load(f) or {}
        except Exception:
            return {}

    def _recompute_orientation_signatures(part_id: str, pick_normal) -> dict:
        """Rewrite the orientation signatures for `part_id` using the
        operator's pick direction. Returns the new signatures doc; an
        empty dict on failure.
        """
        from object_detection.step_parser import (
            compute_orientation_signatures, write_features_artifacts,
            _face_from_normal,
        )
        feats = _load_features_doc(part_id)
        if not feats:
            return {}
        pick_face = _face_from_normal(pick_normal) if pick_normal else 'top'
        sig = compute_orientation_signatures(feats, pick_face)
        write_features_artifacts(part_id, feats, sig)
        return sig

    def _load_defect_types(part_id: str) -> list:
        """Read defects.json for a part and return the list shaped for
        the public API. Returns [] when the file is missing/unreadable.
        Tolerates the legacy 'captures' field by mapping it to
        'capture_count' on read."""
        path = f'/opt/cobot/parts/teach/{part_id}/defects.json'
        if not os.path.isfile(path):
            return []
        try:
            with open(path) as f:
                data = json.load(f) or {}
        except Exception:
            return []
        out = []
        for d in (data.get('defects') or []):
            if not isinstance(d, dict):
                continue
            out.append({
                'name':          str(d.get('name') or ''),
                'description':   str(d.get('description') or ''),
                'severity':      str(d.get('severity') or 'reject'),
                'capture_count': int(d.get('capture_count', d.get('captures', 0))),
            })
        return out

    @app.post("/api/parts")
    async def api_parts_create(request: Request):
        """Create a part record from name + description, no STEP
        file required. The conversational teach wizard uses this so
        the operator can teach a brand-new part from the camera
        alone, then call /api/parts/<id>/teach against the new id."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        name = str(body.get('name') or '').strip()
        if not name:
            return JSONResponse({"error": "name required"}, status_code=400)
        description = str(body.get('description') or '').strip()
        try:
            from object_detection.part_library import create_part_no_step
            part_data = create_part_no_step(name=name, description=description)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        return {
            "ok":      True,
            "part_id": part_data['id'],
            "name":    part_data['name'],
        }

    @app.get("/api/parts")
    async def api_parts_list():
        from object_detection.part_library import (
            get_all_parts, identification_basis, has_teach_images,
            get_teach_image_count, has_step_file,
        )
        parts = get_all_parts()
        # Annotate each entry with its current taught-sample count and
        # any defect types the operator taught via the wizard. The UI
        # uses teach_count for the "Taught" pill and defect_types for
        # a red defect-count badge.
        teach_base = '/opt/cobot/parts/teach'
        for p in parts:
            pid = p.get('id') or ''
            d = os.path.join(teach_base, pid)
            try:
                # Exclude any defect sidecar files (defects.json today;
                # the filter also guards against any future
                # `defects*.npz` that would inflate the count beyond
                # what the operator actually captured this session).
                p['teach_count'] = sum(
                    1 for f in os.listdir(d)
                    if f.endswith('.npz') and not f.startswith('defects')
                ) if os.path.isdir(d) else 0
            except OSError:
                p['teach_count'] = 0
            p['defect_types'] = _load_defect_types(pid)
            # Identification-basis annotation: lets the dashboard warn
            # operators about parts that can only be identified by STEP
            # outline (high false-match rate on flat / rectangular parts).
            p['identification_basis'] = identification_basis(pid)
            p['has_teach_images'] = has_teach_images(pid)
            p['teach_image_count'] = get_teach_image_count(pid)
            p['has_step_file'] = has_step_file(pid)
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
        if orientation not in ('pickable', 'flipped', 'on_side', 'non_pickable'):
            orientation = 'pickable'
        # New conversational wizard adds rich orientation metadata. Pass
        # through unchanged — depth_segment_node ignores unknown keys
        # today but the metadata is stored in the .npz sidecar.
        orientation_number = int(body.get('orientation_number') or 0)
        orientation_label  = str(body.get('orientation_label') or '').strip()
        is_pickable        = bool(body.get('is_pickable', orientation == 'pickable'))
        is_defect          = bool(body.get('is_defect') or False)
        defect_name        = str(body.get('defect_name') or '').strip()
        defect_description = str(body.get('defect_description') or '').strip()
        defect_severity    = str(body.get('defect_severity') or 'reject')
        if defect_severity not in ('reject', 'warning', 'cosmetic'):
            defect_severity = 'reject'
        if is_defect and not defect_name:
            return JSONResponse({"error": "defect_name required when is_defect=true"}, status_code=400)

        if _ros_node is None or _ros_node._teach_cmd_pub is None:
            return JSONResponse({"error": "ROS node not ready"}, status_code=503)

        teach_dir = f'/opt/cobot/parts/teach/{part_id}'
        def _count():
            # Same filter as api_parts_list — exclude defect sidecars
            # so the wizard's per-capture count reflects what the
            # operator just taught.
            try:
                return sum(
                    1 for f in os.listdir(teach_dir)
                    if f.endswith('.npz') and not f.startswith('defects')
                )
            except OSError:
                return 0
        before = _count()

        _ros_node.get_logger().info(
            f'TEACH: part_id={part_id} detection_index={det_idx} '
            f'orientation={orientation} is_defect={is_defect} '
            f'defect_name={defect_name!r} (before={before})'
        )
        m = String()
        payload = {
            'action':              'teach',
            'part_id':             part_id,
            'detection_index':     det_idx,
            'orientation':         orientation,
            'orientation_number':  orientation_number,
            'orientation_label':   orientation_label,
            'is_pickable':         is_pickable,
        }
        if is_defect:
            # Pass defect fields to depth_segment_node so it can route
            # the capture if/when it learns to. Today the node ignores
            # the extra keys; the metadata lives in defects.json below.
            payload.update({
                'is_defect':           True,
                'defect_name':         defect_name,
                'defect_description':  defect_description,
                'defect_severity':     defect_severity,
            })
        m.data = json.dumps(payload)
        _ros_node._teach_cmd_pub.publish(m)

        # Give depth_segment_node a moment to write the .npz.
        import asyncio as _asyncio
        await _asyncio.sleep(0.6)
        after = _count()
        captured = after > before

        # On a successful defect capture, fold the defect metadata
        # into a per-part defects.json. Same name → captures++; new
        # name → append. The matcher will learn to consult this when
        # the defect-aware path is wired.
        if is_defect and captured:
            try:
                os.makedirs(teach_dir, exist_ok=True)
                defects_path = os.path.join(teach_dir, 'defects.json')
                data = {'defects': []}
                if os.path.isfile(defects_path):
                    with open(defects_path) as f:
                        try: data = json.load(f) or {'defects': []}
                        except Exception: data = {'defects': []}
                defects = data.get('defects') or []
                now = datetime.now().isoformat(timespec='seconds')
                hit = None
                for d in defects:
                    if str(d.get('name', '')).lower() == defect_name.lower():
                        hit = d; break
                if hit is not None:
                    hit['capture_count'] = int(hit.get('capture_count', hit.get('captures', 0))) + 1
                    hit['last_captured'] = now
                    if defect_description:
                        hit['description'] = defect_description
                    hit['severity'] = defect_severity
                else:
                    defects.append({
                        'name':           defect_name,
                        'description':    defect_description,
                        'severity':       defect_severity,
                        'capture_count':  1,
                        'first_captured': now,
                        'last_captured':  now,
                    })
                data['defects'] = defects
                with open(defects_path, 'w') as f:
                    json.dump(data, f, indent=2)
            except Exception as e:
                _ros_node.get_logger().warn(f'defects.json update failed: {e}')

        return {
            "ok":          True,
            "status":      "captured" if captured else "no_capture",
            "part_id":     part_id,
            "teach_count": after,
            "captured":    captured,
            "is_defect":   is_defect,
        }

    # ── Tablet-camera "STEP + Video Teach" scan endpoints ─────────────
    # The tablet has no depth, so scale is anchored to the part's STEP
    # geometry (extents_cm in metadata). The full pipeline lives in
    # scan_capture.py — endpoints are thin JSON wrappers.

    async def _read_jpeg_body(request: Request) -> bytes | None:
        """Accept either a raw JPEG (application/octet-stream / image/jpeg)
        or a multipart form with a `frame` file field. Returns the JPEG
        bytes or None when nothing usable came through."""
        ct = (request.headers.get('content-type') or '').lower()
        if ct.startswith('multipart/'):
            try:
                form = await request.form()
                f = form.get('frame') or form.get('file')
                if hasattr(f, 'read'):
                    return await f.read()
            except Exception:
                return None
            return None
        # Raw body — image/jpeg, application/octet-stream, or unspecified.
        try:
            body = await request.body()
        except Exception:
            return None
        return body if body else None

    @app.post("/api/parts/{part_id}/scan/bg")
    async def api_parts_scan_bg(part_id: str, request: Request):
        """Capture the empty-surface background frame the scan loop
        will diff against. Body is multipart/form-data with field
        `frame` carrying a JPEG, OR raw application/octet-stream
        JPEG bytes. Returns frame dimensions on success."""
        if not os.path.isfile(f'/opt/cobot/parts/metadata/{part_id}.json'):
            return JSONResponse({"error": "part not found"}, status_code=404)
        try:
            from . import scan_capture
        except ImportError:
            import scan_capture  # type: ignore
        jpeg = await _read_jpeg_body(request)
        if jpeg is None:
            return JSONResponse({"error": "no JPEG body"}, status_code=400)
        return scan_capture.set_background(part_id, jpeg)

    @app.post("/api/parts/{part_id}/scan/frame")
    async def api_parts_scan_frame(part_id: str, request: Request,
                                   orientation: str = 'pickable',
                                   orientation_number: int = 0,
                                   orientation_label: str = '',
                                   is_pickable: bool = True):
        """Ingest one tablet-camera frame. Backend runs the full scan
        pipeline (blur reject, bg subtract, STEP-aspect cross-check,
        yaw dedup) and on a kept frame writes a standard ref_NNN.npz
        the existing matcher loader picks up. Returns the verdict +
        running counters for the wizard's live UI."""
        if not os.path.isfile(f'/opt/cobot/parts/metadata/{part_id}.json'):
            return JSONResponse({"error": "part not found"}, status_code=404)
        try:
            from . import scan_capture
        except ImportError:
            import scan_capture  # type: ignore
        jpeg = await _read_jpeg_body(request)
        if jpeg is None:
            return JSONResponse({"error": "no JPEG body"}, status_code=400)
        if orientation not in ('pickable', 'flipped', 'on_side', 'non_pickable'):
            orientation = 'pickable'
        try:
            return scan_capture.ingest_frame(
                part_id, jpeg, orientation,
                int(orientation_number), str(orientation_label or ''),
                bool(is_pickable))
        except Exception as e:
            return JSONResponse({"error": f"scan failed: {e}"}, status_code=500)

    @app.get("/api/parts/{part_id}/scan/status")
    async def api_parts_scan_status(part_id: str):
        try:
            from . import scan_capture
        except ImportError:
            import scan_capture  # type: ignore
        return scan_capture.session_status(part_id)

    @app.post("/api/parts/{part_id}/scan/reset")
    async def api_parts_scan_reset(part_id: str):
        try:
            from . import scan_capture
        except ImportError:
            import scan_capture  # type: ignore
        scan_capture.reset_session(part_id)
        return {"ok": True, "part_id": part_id}

    @app.get("/api/detections")
    async def api_detections():
        """Current detections snapshot — used by the executor's
        scan_workspace step to enumerate objects on the table."""
        with _state_lock:
            dets = list(STATE.get('detections', []))
        return {"count": len(dets), "objects": dets}

    @app.get("/api/parts/{part_id}/defects")
    async def api_parts_defects(part_id: str):
        """Read the per-part defects.json so the teach wizard can show
        previously-captured defects when the operator re-opens it."""
        return {"defects": _load_defect_types(part_id)}

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

    def _do_teach_clear(part_id: str) -> dict:
        """Rmtree the part's teach directory, blocking until the
        filesystem actually reports it gone, and tell depth_segment_node
        to drop its in-memory cache. Returns counts so the caller can
        verify the operation worked end-to-end (the wizard surfaces
        `remaining` to confirm 0 refs remain before the first capture)."""
        import shutil as _sh
        teach_dir = f'/opt/cobot/parts/teach/{part_id}'
        before = 0
        if os.path.isdir(teach_dir):
            try:
                before = sum(1 for f in os.listdir(teach_dir)
                             if f.endswith('.npz'))
            except OSError:
                before = 0
            _sh.rmtree(teach_dir, ignore_errors=True)
        # Notify depth_segment_node so it can reload its in-memory cache
        if _ros_node and _ros_node._teach_cmd_pub:
            m = String()
            m.data = json.dumps({'action': 'reload', 'part_id': part_id})
            _ros_node._teach_cmd_pub.publish(m)
        remaining = 0
        if os.path.isdir(teach_dir):
            try:
                remaining = sum(1 for f in os.listdir(teach_dir)
                                if f.endswith('.npz'))
            except OSError:
                remaining = 0
        return {
            'ok':         True,
            'cleared':    before,
            'remaining':  remaining,
            'part_id':    part_id,
        }

    @app.post("/api/parts/{part_id}/teach_clear")
    async def api_parts_teach_clear(part_id: str):
        """Delete every taught reference for this part."""
        return _do_teach_clear(part_id)

    @app.post("/api/parts/{part_id}/teach/clear")
    async def api_parts_teach_clear_slash(part_id: str):
        """Alias for /teach_clear with a slash separator. Matches the
        REST shape the wizard's "Start Fresh" button expects on some
        client builds; both routes resolve to the same code."""
        return _do_teach_clear(part_id)

    @app.get("/api/parts/{part_id}/teach/debug")
    async def api_parts_teach_debug(part_id: str):
        """List the actual files in the part's teach directory so
        operators can verify the wizard's count matches reality."""
        teach_dir = f'/opt/cobot/parts/teach/{part_id}'
        if not os.path.isdir(teach_dir):
            return {
                'part_id':     part_id,
                'path':        teach_dir,
                'exists':      False,
                'total_files': 0,
                'npz_files':   0,
                'png_files':   0,
                'files':       [],
            }
        try:
            files = sorted(os.listdir(teach_dir))
        except OSError as e:
            return JSONResponse({'error': str(e)}, status_code=500)
        return {
            'part_id':     part_id,
            'path':        teach_dir,
            'exists':      True,
            'total_files': len(files),
            'npz_files':   len([f for f in files if f.endswith('.npz')]),
            'png_files':   len([f for f in files if f.endswith('.png')]),
            'files':       files[:200],
        }

    @app.get("/api/parts/{part_id}/orientation_debug")
    async def api_parts_orientation_debug(part_id: str):
        """Surface the live orientation-classifier state for a part.

        Lists the part's teach refs grouped by orientation key
        (is_pickable + orientation_label), with the .png preview
        filenames the wizard can render side-by-side.

        Also returns the latest match scores: NCC, hist, spatial,
        gap, winner label. Those come from a sidecar
        .last_match.json the depth_segment_node writes (throttled to
        ~2 Hz per part). dashboard_server and depth_segment_node run
        as separate processes — they can't share an in-process dict
        — so the file is the cross-process surface."""
        import numpy as _np
        teach_dir = f'/opt/cobot/parts/teach/{part_id}'
        if not os.path.isdir(teach_dir):
            return {
                'part_id':    part_id,
                'groups':     [],
                'last_match': None,
            }

        # Group refs by (is_pickable, orientation_label).
        groups: dict = {}
        try:
            for fn in sorted(os.listdir(teach_dir)):
                if not fn.endswith('.npz') or fn.startswith('defects'):
                    continue
                full = os.path.join(teach_dir, fn)
                try:
                    z = _np.load(full, allow_pickle=True)
                    files = set(z.files)
                    is_pick = (bool(z['is_pickable'])
                               if 'is_pickable' in files
                               else (str(z['orientation']) == 'pickable'
                                     if 'orientation' in files else True))
                    label = (str(z['orientation_label'])
                             if 'orientation_label' in files else '')
                except Exception:
                    continue
                key = (is_pick, label)
                png_name = fn[:-4] + '.png'
                if not os.path.isfile(os.path.join(teach_dir, png_name)):
                    png_name = None
                grp = groups.setdefault(key, {
                    'is_pickable':       is_pick,
                    'orientation_label': label,
                    'ref_count':         0,
                    'previews':          [],
                })
                grp['ref_count'] += 1
                if png_name is not None:
                    grp['previews'].append(png_name)
        except OSError:
            pass

        last_match = None
        last_match_path = os.path.join(teach_dir, '.last_match.json')
        if os.path.isfile(last_match_path):
            try:
                with open(last_match_path) as f:
                    last_match = json.load(f)
            except Exception:
                last_match = None

        return {
            'part_id':    part_id,
            'groups':     list(groups.values()),
            'last_match': last_match,
        }

    _ORIENT_WEIGHT_DEFAULTS = {
        'ncc': 0.25, 'hist': 0.20, 'spatial': 0.20, 'depth': 0.35,
    }

    def _orient_weights_for(part_id: str) -> dict:
        """Read + normalise weights from the part's metadata json.
        Mirrors DepthSegmentNode._load_orient_weights so the
        dashboard and the matcher report the same values."""
        weights = dict(_ORIENT_WEIGHT_DEFAULTS)
        meta_path = f'/opt/cobot/parts/metadata/{part_id}.json'
        if not os.path.isfile(meta_path):
            return weights
        try:
            with open(meta_path) as f:
                meta = json.load(f) or {}
            w = meta.get('orient_weights') or {}
            if isinstance(w, dict):
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

    @app.get("/api/parts/{part_id}/orient_weights")
    async def api_parts_orient_weights_get(part_id: str):
        """Current orientation-classifier weights for a part,
        normalised to sum=1.0. Returns the defaults when the part
        has no orient_weights field saved."""
        meta_path = f'/opt/cobot/parts/metadata/{part_id}.json'
        if not os.path.isfile(meta_path):
            return JSONResponse({"error": "part not found"}, status_code=404)
        return {
            'part_id':  part_id,
            'weights':  _orient_weights_for(part_id),
            'defaults': _ORIENT_WEIGHT_DEFAULTS,
        }

    @app.post("/api/parts/{part_id}/orient_weights")
    async def api_parts_orient_weights_set(part_id: str, request: Request):
        """Persist per-part orientation-classifier weights.
        Body must carry every key (ncc / hist / spatial / depth) as a
        non-negative number. Values are re-normalised to sum=1.0 then
        written under orient_weights in the part's metadata json.
        depth_segment_node picks the new weights up on its next
        _match_part call (the metadata file is reread per-frame)."""
        meta_path = f'/opt/cobot/parts/metadata/{part_id}.json'
        if not os.path.isfile(meta_path):
            return JSONResponse({"error": "part not found"}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        required = ('ncc', 'hist', 'spatial', 'depth')
        raw = {}
        for k in required:
            v = body.get(k)
            if not isinstance(v, (int, float)) or float(v) < 0:
                return JSONResponse(
                    {"error": f"weight '{k}' must be a non-negative number"},
                    status_code=400)
            raw[k] = float(v)
        total = sum(raw.values())
        if total <= 0:
            return JSONResponse(
                {"error": "at least one weight must be > 0"}, status_code=400)
        normalised = {k: v / total for k, v in raw.items()}
        try:
            with open(meta_path) as f:
                meta = json.load(f) or {}
            meta['orient_weights'] = normalised
            tmp = meta_path + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(meta, f, indent=2)
            os.replace(tmp, meta_path)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        return {'ok': True, 'part_id': part_id, 'weights': normalised}

    @app.get("/api/parts/{part_id}")
    async def api_parts_get(part_id: str):
        from object_detection.part_library import (
            get_part, identification_basis, has_teach_images,
            get_teach_image_count, has_step_file,
        )
        part = get_part(part_id)
        if not part:
            return JSONResponse({"error": "part not found"}, status_code=404)
        part['defect_types'] = _load_defect_types(part_id)
        part['identification_basis'] = identification_basis(part_id)
        part['has_teach_images'] = has_teach_images(part_id)
        part['teach_image_count'] = get_teach_image_count(part_id)
        part['has_step_file'] = has_step_file(part_id)
        return part

    @app.get("/api/parts/{part_id}/features")
    async def api_parts_features(part_id: str):
        """Return the STEP feature dictionary + per-orientation
        signatures for a part. Empty doc when the part has no STEP
        file."""
        feats = _load_features_doc(part_id)
        sig = _load_orientation_signatures(part_id)
        return {
            'part_id':                 part_id,
            'features':                feats.get('features') or [],
            'faces':                   feats.get('faces') or {},
            'orientation_signatures':  sig or {},
        }

    @app.get("/api/parts/{part_id}/feature_correlation")
    async def api_parts_feature_correlation(part_id: str):
        """Placeholder until teach-time STEP↔image correlation is wired
        up (Part C of the live-boost work). Returns an empty result
        with status='not_computed' so the dashboard can show a stable
        shape today and light up later when the correlator lands."""
        return {
            'part_id': part_id,
            'status':  'not_computed',
            'note':    'STEP/image correlation not yet implemented '
                       '(see Part C of the new STEP architecture).',
            'per_orientation': [],
        }

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

    # ------------------------------------------------------------------
    # Production-stats endpoints used by MonitorDashboard. Backed by an
    # in-memory dict for now; the real numbers will arrive once the
    # robot driver publishes /robot/cycle_done + /robot/events. The
    # endpoints exist so the dashboard panels render with empty state
    # instead of network errors until then.
    # ------------------------------------------------------------------
    _stats: dict = {
        'picks_today':  0,
        'picks_shift':  0,
        'picks_total':  0,
        'per_hour':     [0] * 12,    # rolling 12-hour bucket
        'recent_cycles': [],          # [{'result': 'pass'|'fail', 'message': str, 'ts': str}]
        'events':        [],          # [{'severity': 'info'|'warning'|'error', 'message', 'timestamp'}]
        'cycle_time':    0.0,
        'repeat_count':  0,
    }

    @app.get("/api/stats/picks")
    async def api_stats_picks():
        return {
            'today':    _stats['picks_today'],
            'shift':    _stats['picks_shift'],
            'total':    _stats['picks_total'],
            'per_hour': list(_stats['per_hour']),
        }

    @app.get("/api/stats/cycles")
    async def api_stats_cycles():
        return {'recent': list(_stats['recent_cycles'][-20:])}

    @app.get("/api/stats/events")
    async def api_stats_events():
        return {'events': list(_stats['events'][-10:])}

    # Per-program rolling stats — same in-memory shape as the global
    # stats dict, but keyed by program id so the Monitor tab can show
    # pass/fail + cycle-time history for the currently-loaded program.
    _program_stats: dict = {}

    _STATS_DIR = '/opt/cobot/stats'

    def _load_disk_stats(prog_id: str) -> dict:
        """Read program_executor_node's stats blob from disk. Returns {}
        on any error so the in-memory fallback can take over."""
        try:
            path = os.path.join(_STATS_DIR, f'{prog_id}.json')
            if os.path.isfile(path):
                with open(path) as f:
                    return json.load(f) or {}
        except Exception:
            pass
        return {}

    @app.get("/api/stats/program/{prog_id}")
    async def api_stats_program(prog_id: str):
        # Disk (executor-written) wins when present; otherwise fall back
        # to the in-memory mock stats.
        disk = _load_disk_stats(prog_id)
        s = disk if disk else _program_stats.get(prog_id, {})
        return {
            'total':        s.get('total', 0),
            'pass':         s.get('pass', 0),
            'fail':         s.get('fail', 0),
            'fail_reasons': list(s.get('fail_reasons', [])),
            'last_run':     s.get('last_run'),
        }

    @app.get("/api/stats/program/{prog_id}/cycle_times")
    async def api_stats_program_cycle_times(prog_id: str):
        disk = _load_disk_stats(prog_id)
        s = disk if disk else _program_stats.get(prog_id, {})
        return {'cycle_times': list(s.get('cycle_times', []))}

    @app.post("/api/program/run")
    async def api_program_run(request: Request):
        """Dispatch run/pause/resume/stop/home to the program executor.
        Body: {action, program_id?}. Without program_id, the executor
        resumes / re-runs whatever it currently has loaded.
        action='load' is a frontend-facing 'set active program' verb —
        the executor doesn't currently have a load-only path, so we
        forward the message (executor ignores unknown actions) and let
        the Monitor UI take care of displaying the program. The next
        Run will pick it up via the normal load+run path."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        action = str(body.get('action', 'run'))
        prog_id = body.get('program_id')
        if action not in ('run', 'pause', 'resume', 'stop', 'home', 'load'):
            return JSONResponse({'error': f'unknown action {action!r}'}, status_code=400)
        if _ros_node is not None:
            try:
                if not hasattr(_ros_node, '_run_program_pub'):
                    _ros_node._run_program_pub = _ros_node.create_publisher(
                        String, '/task/run_program', 10)
                payload = {'action': action}
                if prog_id:
                    payload['program_id'] = str(prog_id)
                m = String()
                m.data = json.dumps(payload)
                _ros_node._run_program_pub.publish(m)
            except Exception as e:
                return JSONResponse({'error': str(e)}, status_code=500)
        return {'ok': True, 'action': action, 'program_id': prog_id}

    # Folder index — sibling JSON to the program files. Underscored so
    # it's ignored by the program-list scan and by the slug regex.
    _FOLDERS_FILE = os.path.join(_PROG_DIR, '_folders.json')

    def _load_folders():
        if os.path.isfile(_FOLDERS_FILE):
            try:
                with open(_FOLDERS_FILE) as f:
                    data = json.load(f)
                if isinstance(data, dict) and 'folders' in data:
                    return data
            except Exception:
                pass
        return {'folders': []}

    def _save_folders(data):
        os.makedirs(_PROG_DIR, exist_ok=True)
        with open(_FOLDERS_FILE, 'w') as f:
            json.dump(data, f, indent=2)

    @app.get("/api/programs")
    async def api_programs_list():
        """List user-created robot programs from /opt/cobot/programs/.
        No built-in templates — every entry corresponds to a file on
        disk and is fully editable / deletable."""
        programs = []
        try:
            os.makedirs(_PROG_DIR, exist_ok=True)
            for fn in sorted(os.listdir(_PROG_DIR)):
                if not fn.endswith('.json') or fn.startswith('_'):
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
                        'updated':     prog.get('updated') or prog.get('created') or '',
                        'folder':      prog.get('folder'),
                        'cell_id':     prog.get('cell_id'),
                    })
                except Exception:
                    continue
        except Exception:
            pass
        return {"programs": programs}

    @app.get("/api/folders")
    async def api_folders_list():
        return _load_folders()

    @app.post("/api/folders")
    async def api_folders_create(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get('name') or 'New Folder').strip() or 'New Folder'
        data = _load_folders()
        import uuid as _uuid
        folder = {
            'id':      _uuid.uuid4().hex[:8],
            'name':    name,
            'created': _now_stamp(),
        }
        data['folders'].append(folder)
        _save_folders(data)
        return {'ok': True, 'folder': folder}

    @app.put("/api/folders/{folder_id}")
    async def api_folders_rename(folder_id: str, request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({'error': 'invalid JSON body'}, status_code=400)
        name = str(body.get('name') or '').strip()
        if not name:
            return JSONResponse({'error': 'name required'}, status_code=400)
        data = _load_folders()
        for f in data['folders']:
            if f['id'] == folder_id:
                f['name'] = name
                _save_folders(data)
                return {'ok': True, 'folder': f}
        return JSONResponse({'error': 'not found'}, status_code=404)

    @app.delete("/api/folders/{folder_id}")
    async def api_folders_delete(folder_id: str):
        data = _load_folders()
        before = len(data['folders'])
        data['folders'] = [f for f in data['folders'] if f['id'] != folder_id]
        if len(data['folders']) == before:
            return JSONResponse({'error': 'not found'}, status_code=404)
        _save_folders(data)
        # Unassign every program that pointed at this folder so the
        # deletion doesn't orphan them behind an invalid id.
        try:
            for fn in os.listdir(_PROG_DIR):
                if not fn.endswith('.json') or fn.startswith('_'):
                    continue
                p = os.path.join(_PROG_DIR, fn)
                try:
                    with open(p) as fp:
                        prog = json.load(fp)
                    if prog.get('folder') == folder_id:
                        prog['folder'] = None
                        with open(p, 'w') as fp:
                            json.dump(prog, fp, indent=2)
                except Exception:
                    continue
        except Exception:
            pass
        return {'ok': True}

    @app.put("/api/programs/{prog_id}/folder")
    async def api_programs_set_folder(prog_id: str, request: Request):
        path = _prog_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({'error': 'not found'}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({'error': 'invalid JSON body'}, status_code=400)
        folder_id = body.get('folder_id')  # null/None to unassign
        try:
            with open(path) as f:
                prog = json.load(f)
            prog['folder'] = folder_id
            prog['updated'] = _now_stamp()
            with open(path, 'w') as f:
                json.dump(prog, f, indent=2)
        except Exception as e:
            return JSONResponse({'error': f'write failed: {e}'}, status_code=500)
        return {'ok': True, 'folder': folder_id}

    @app.post("/api/programs/{prog_id}/duplicate")
    async def api_programs_duplicate(prog_id: str):
        """Create a copy of an existing program with a new id (slug
        with collision suffix) and " (copy)" appended to the name."""
        src = _prog_path(prog_id)
        if not src or not os.path.isfile(src):
            return JSONResponse({'error': 'not found'}, status_code=404)
        try:
            with open(src) as f:
                prog = json.load(f)
        except Exception as e:
            return JSONResponse({'error': f'read failed: {e}'}, status_code=500)
        base_slug = prog_id
        slug = base_slug + '_copy'
        n = 2
        while os.path.isfile(os.path.join(_PROG_DIR, slug + '.json')):
            slug = base_slug + f'_copy_{n}'
            n += 1
        ts = _now_stamp()
        new_prog = dict(prog)
        new_prog['id']      = slug
        new_prog['name']    = (prog.get('name') or prog_id) + ' (copy)'
        new_prog['created'] = ts
        new_prog['updated'] = ts
        try:
            with open(os.path.join(_PROG_DIR, slug + '.json'), 'w') as f:
                json.dump(new_prog, f, indent=2)
        except Exception as e:
            return JSONResponse({'error': f'write failed: {e}'}, status_code=500)
        return {'ok': True, 'program': new_prog}

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
            "cell_id":     body.get("cell_id") or None,
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
        for k in ("name", "description", "tags", "config", "steps", "cell_id"):
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
    # Programming by Demonstration (/api/pbd/*).
    #
    # Wires the dashboard to programming_by_demonstration.pipeline which
    # does the real work (transcribe + understand + compose + store).
    # The pipeline is built lazily on first use so dashboard startup
    # doesn't crash when faster-whisper / anthropic aren't installed.
    # ------------------------------------------------------------------

    _PBD_UPLOAD_DIR = '/opt/cobot/demonstrations/_uploads'
    _PBD_DEMOS_DIR  = '/opt/cobot/demonstrations'

    try:
        os.makedirs(_PBD_UPLOAD_DIR, exist_ok=True)
    except Exception:
        pass

    _pbd_lock = threading.Lock()
    _pbd_pipeline_holder: dict = {'pipeline': None, 'last_error': None}

    def _pbd_parts_provider():
        """Hand the pipeline the same parts list the wizard sees so it
        grounds part_ids to the real library, not invented ones."""
        try:
            from object_detection.part_library import get_all_parts
            return get_all_parts() or []
        except Exception:
            return []

    def _pbd_pipeline():
        """Build (or reuse) the pipeline. Failures are surfaced to the
        caller with the actionable install hint rather than 500s."""
        with _pbd_lock:
            if _pbd_pipeline_holder['pipeline'] is not None:
                return _pbd_pipeline_holder['pipeline'], None
            try:
                from programming_by_demonstration.pipeline import (
                    Pipeline, PipelineConfig,
                )
            except Exception as e:
                msg = (f'programming_by_demonstration import failed: {e}. '
                       'Source install/setup.bash and rebuild the package.')
                _pbd_pipeline_holder['last_error'] = msg
                return None, msg
            cfg = PipelineConfig(
                demonstrations_dir=_PBD_DEMOS_DIR,
                programs_dir=_PROG_DIR,
                backend=os.environ.get('ROBOAI_PBD_BACKEND', 'api'),
                backend_params={
                    'model':               os.environ.get('ROBOAI_PBD_API_MODEL', 'claude-opus-4-7'),
                    'max_tokens':          int(os.environ.get('ROBOAI_PBD_MAX_TOKENS', '4096')),
                    'request_timeout_s':   float(os.environ.get('ROBOAI_PBD_TIMEOUT_S', '120')),
                    # ZDR is opt-in per workspace and Anthropic now strict-
                    # validates the anthropic-beta header — leaving it True
                    # on a non-enrolled workspace triggers HTTP 400. Default
                    # OFF; set ROBOAI_PBD_ZERO_DATA_RETENTION=1 (read inside
                    # AnthropicClaudeBackend) once ZDR is enrolled.
                    'zero_data_retention': False,
                },
            )
            pipeline = Pipeline(cfg, parts_provider=_pbd_parts_provider)
            _pbd_pipeline_holder['pipeline'] = pipeline
            return pipeline, None

    def _pbd_store():
        """A lightweight read-only handle on the store — used by stats
        and the /api/pbd/{demo_id} fetch even if the full pipeline
        can't initialise (e.g. SDKs not installed)."""
        from programming_by_demonstration.learning_store import LearningStore
        return LearningStore(_PBD_DEMOS_DIR)

    @app.post("/api/pbd/upload")
    async def api_pbd_upload(file: UploadFile = File(...)):
        """Accept a video upload, return a demo_id ready for /generate.
        Stored under _PBD_UPLOAD_DIR until the pipeline copies it into
        the demonstration's permanent directory."""
        try:
            from programming_by_demonstration.utils import mint_demo_id
        except Exception as e:
            return JSONResponse(
                {"ok": False, "error": f"PBD package not installed: {e}"},
                status_code=500,
            )
        demo_id = mint_demo_id()
        # Constrain to a small allowlist to avoid weird .exe uploads.
        orig = (file.filename or 'upload.mp4')
        ext  = os.path.splitext(orig)[1].lower()
        if ext not in ('.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'):
            return JSONResponse(
                {"ok": False, "error": f"unsupported video extension: {ext}"},
                status_code=415,
            )
        target = os.path.join(_PBD_UPLOAD_DIR, demo_id + ext)
        try:
            with open(target, 'wb') as out:
                while True:
                    chunk = await file.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"upload write failed: {e}"},
                                status_code=500)
        return {"ok": True, "demo_id": demo_id,
                "video_path": target,
                "filename": orig}

    def _pbd_run_sync(video_path: str, demo_id: str,
                      backend_override: str | None) -> dict:
        pipeline, err = _pbd_pipeline()
        if pipeline is None:
            return {"ok": False, "error": err, "demo_id": demo_id}
        res = pipeline.run_from_upload(
            video_path,
            demo_id=demo_id,
            backend_override=(backend_override or None),
        )
        return {
            "ok":         res.ok,
            "error":      res.error,
            "demo_id":    res.demo_id,
            "intent":     res.intent.to_dict() if res.intent else None,
            "draft":      res.draft.to_program_payload() if res.draft else None,
            "transcript": res.transcript_text,
            "used_examples": res.used_examples,
            "backend_id": res.backend_id,
            "transited_externally": res.transited_externally,
            "stages_done": res.stages_done,
        }

    @app.post("/api/pbd/generate")
    async def api_pbd_generate(request: Request):
        """Run the full pipeline for an already-uploaded demo. Body:
            { demo_id: <returned by /upload>, video_path?: <override>,
              backend?: 'api'|'local' }
        Long-running — the dashboard shows a progress spinner."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "invalid JSON body"}, status_code=400)
        from programming_by_demonstration.utils import safe_demo_id
        demo_id = safe_demo_id(str(body.get('demo_id') or '')) or ''
        if not demo_id:
            return JSONResponse({"ok": False, "error": "demo_id required"}, status_code=400)
        video_path = str(body.get('video_path') or '').strip()
        # If the client didn't echo the upload path back, fish it out of
        # the upload dir by demo_id prefix.
        if not video_path:
            for fn in os.listdir(_PBD_UPLOAD_DIR):
                if fn.startswith(demo_id + '.'):
                    video_path = os.path.join(_PBD_UPLOAD_DIR, fn)
                    break
        if not os.path.isfile(video_path):
            return JSONResponse(
                {"ok": False, "error": f"video not found: {video_path}"},
                status_code=404,
            )
        backend_override = str(body.get('backend') or '').strip() or None
        # Heavy work — drop off the event loop.
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, _pbd_run_sync, video_path, demo_id, backend_override,
        )

    @app.get("/api/pbd/list")
    async def api_pbd_list():
        try:
            store = _pbd_store()
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return {"demos": store.list_demos(limit=200)}

    @app.get("/api/pbd/{demo_id}")
    async def api_pbd_get(demo_id: str):
        from programming_by_demonstration.utils import safe_demo_id
        did = safe_demo_id(demo_id)
        if not did:
            return JSONResponse({"ok": False, "error": "bad demo_id"}, status_code=400)
        try:
            store = _pbd_store()
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return store.load_all_files(did)

    @app.post("/api/pbd/{demo_id}/correct")
    async def api_pbd_correct(demo_id: str, request: Request):
        """Operator accepted the (possibly edited) draft. Body:
            { program: <full program payload — same shape as POST /api/programs>,
              save_to_library: true }
        We save through the existing /api/programs path internally so
        the saved file ends up identical to a wizard-saved program, then
        write human_corrected.json (the gold training signal) into the
        learning store."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "invalid JSON body"}, status_code=400)
        program = body.get('program') or {}
        if not program.get('name'):
            return JSONResponse({"ok": False, "error": "program.name required"}, status_code=400)
        from programming_by_demonstration.utils import safe_demo_id
        did = safe_demo_id(demo_id)
        if not did:
            return JSONResponse({"ok": False, "error": "bad demo_id"}, status_code=400)

        program_id = None
        if body.get('save_to_library', True):
            # Mint a slug using the same convention as POST /api/programs.
            name = str(program.get('name')).strip()
            base = _prog_re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_') or 'program'
            try:
                os.makedirs(_PROG_DIR, exist_ok=True)
            except Exception as e:
                return JSONResponse({"ok": False,
                                     "error": f"cannot create {_PROG_DIR}: {e}"},
                                    status_code=500)
            slug = base
            n = 2
            while os.path.exists(os.path.join(_PROG_DIR, slug + '.json')):
                slug = f"{base}_{n}"
                n += 1
            ts = _now_stamp()
            saved = {
                "id":          slug,
                "name":        name,
                "description": str(program.get('description') or ''),
                "tags":        list(program.get('tags') or []) + ['from_demonstration'],
                "config":      program.get('config') or {},
                "steps":       list(program.get('steps') or []),
                "created":     ts,
                "updated":     ts,
            }
            try:
                with open(os.path.join(_PROG_DIR, slug + '.json'), 'w') as f:
                    json.dump(saved, f, indent=2)
            except Exception as e:
                return JSONResponse({"ok": False, "error": f"write failed: {e}"},
                                    status_code=500)
            program_id = slug

        # Write human_corrected.json — the highest-value signal for
        # future training of the local model. The body MAY include
        # `scene` (the operator-corrected scene block) and `intent`
        # (the full intent the operator confirmed) — both are
        # persisted alongside the program as separate training
        # targets.
        corrected_scene  = body.get('scene')  if isinstance(body.get('scene'),  dict) else None
        corrected_intent = body.get('intent') if isinstance(body.get('intent'), dict) else None
        try:
            store = _pbd_store()
            store.save_correction(
                did, program,
                program_id=program_id,
                corrected_scene=corrected_scene,
                corrected_intent=corrected_intent,
            )
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"save_correction failed: {e}"},
                                status_code=500)
        return {"ok": True, "demo_id": did, "program_id": program_id}

    @app.get("/api/pbd/dataset/stats")
    async def api_pbd_stats():
        try:
            store = _pbd_store()
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return store.stats()

    @app.get("/api/pbd/dataset/export")
    async def api_pbd_export():
        """Export the corrected corpus as JSONL — the training-ready
        bundle for fine-tuning the future local model on a GPU
        machine."""
        try:
            store = _pbd_store()
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        out_path = os.path.join(_PBD_DEMOS_DIR,
                                f'training_export_{_now_stamp()}.jsonl')
        info = store.export_training_bundle(out_path)
        return FileResponse(out_path, media_type='application/jsonl',
                            filename=os.path.basename(out_path),
                            headers={'X-Examples': str(info['examples'])})

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

        # Open-vocabulary detection prompts (the panel that used to
        # live in Cameras & LiDAR now lives in Part Recognition and
        # is scoped to THIS part). Stored as a list of strings; the
        # Test Detection control in the frontend posts the live
        # subset to /api/openvocab/prompts so the NanoOWL node can
        # pick it up immediately.
        if 'openvocab_prompts' in body:
            raw = body.get('openvocab_prompts') or []
            if isinstance(raw, list):
                cleaned = []
                for p in raw:
                    s = str(p).strip()
                    if s and len(s) < 200:
                        cleaned.append(s)
                # De-dup while preserving order so the operator sees
                # their chip order on the next load.
                seen = set()
                deduped = []
                for s in cleaned:
                    k = s.lower()
                    if k in seen:
                        continue
                    seen.add(k)
                    deduped.append(s)
                part['openvocab_prompts'] = deduped[:16]

        # New architecture: when the pick direction is set, recompute
        # per-orientation feature signatures from the cached STEP
        # features doc. The signatures feed (future) orientation
        # boost — identity still comes from taught images + size.
        try:
            _recompute_orientation_signatures(part_id, merged.get('pick_normal'))
        except Exception as _exc:
            pass

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

    # PWA manifest. The catch-all SPA handler would also serve this file,
    # but FileResponse infers application/json from the .json extension.
    # Chrome accepts that, but the spec-preferred type is
    # application/manifest+json — declare it explicitly so any picky
    # client (or future devtools lint) sees the right MIME.
    @app.get("/manifest.json")
    async def serve_manifest():
        path = os.path.join(_static, "manifest.json")
        if os.path.isfile(path):
            return FileResponse(path, media_type="application/manifest+json")
        return JSONResponse({"detail": "manifest missing"}, status_code=404)

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

    # Robot model assets. /opt/cobot/models/robot is a symlink to the
    # active per-robot dir under models/robots/<id>/ in the repo. The
    # routes exist whether or not link STLs have been authored — a 404
    # on /robot/links.json is the sentinel the ArmViewer3D uses to
    # fall back to the static GLB.
    _ROBOT_MODEL_DIR = '/opt/cobot/models/robot'

    def _resolve_robot_asset(filename: str) -> str:
        path = os.path.realpath(os.path.join(_ROBOT_MODEL_DIR, filename))
        # Guard against `..` escapes — resolved path must stay under
        # the active robot dir (after dereferencing the symlink).
        base = os.path.realpath(_ROBOT_MODEL_DIR)
        if not path.startswith(base + os.sep) and path != base:
            return ''
        return path

    def _serve_robot_asset(filename: str, media_type: str):
        path = _resolve_robot_asset(filename)
        if not path or not os.path.isfile(path):
            return JSONResponse({"detail": "robot asset not available"}, status_code=404)
        return FileResponse(path, media_type=media_type)

    @app.get("/robot/model.glb")
    async def robot_model_glb():
        return _serve_robot_asset('S10-140.glb', 'model/gltf-binary')

    @app.get("/robot/model_lite.glb")
    async def robot_model_lite_glb():
        # Decimated to ~150k faces by scripts/decimate_robot_glb.py.
        # ArmViewer3D loads this first; the full GLB is the fallback.
        return _serve_robot_asset('S10-140_lite.glb', 'model/gltf-binary')

    @app.get("/robot/assembly.glb")
    async def robot_assembly_glb():
        # Single-file assembled model — every link already in its
        # correct world-space position from the SolidWorks export.
        # ArmViewer3D loads THIS instead of the URDF + per-link GLBs
        # because the per-link split scattered on the dashboard
        # (origins baked into world space, not per-link). Once the
        # official Estun URDF + per-link meshes arrive we'll move
        # back to the articulated path.
        #
        # Preferred file: s10-140_tablet.glb — produced by
        # `gltf-transform weld → simplify --ratio 0.08 --error 0.01
        #  → draco` from the 294 k-triangle ECO source. The result
        # is 26.7 k triangles (~9 % of the ECO), 192 KB on the wire,
        # which the ONN 11" tablet GPU can hold without OOM. Falls
        # back to S10-140_lite.glb then the ECO source if the tablet
        # build is missing. `Content-Encoding: identity` blocks any
        # future gzip middleware from corrupting the Draco payload.
        for name in ('s10-140_tablet.glb',
                     'S10-140_lite.glb',
                     's10-140_-eco_.glb'):
            path = _resolve_robot_asset(name)
            if path and os.path.isfile(path):
                return FileResponse(
                    path,
                    media_type='model/gltf-binary',
                    headers={'Content-Encoding': 'identity'},
                )
        return JSONResponse({"detail": "assembly not available"},
                            status_code=404)

    @app.get("/robot/model.stl")
    async def robot_model_stl():
        return _serve_robot_asset('S10-140.stl', 'application/sla')

    @app.get("/robot/model.step")
    async def robot_model_step():
        return _serve_robot_asset('S10-140_G2.STEP', 'application/step')

    @app.get("/robot/parts_inventory.json")
    async def robot_parts_inventory():
        return _serve_robot_asset('parts_inventory.json', 'application/json')

    @app.get("/robot/info")
    async def robot_info():
        return _serve_robot_asset('robot.json', 'application/json')

    @app.get("/robot/links.json")
    async def robot_links_json():
        # Lives under links/ to keep the articulation files grouped.
        return _serve_robot_asset('links/links.json', 'application/json')

    @app.get("/robot/urdf")
    async def robot_urdf():
        # The URDF references its meshes with package:// URIs that the
        # frontend's urdf-loader resolves via a packages map pointing
        # at /robot/, so this single route is enough — meshes ride on
        # the existing /robot/links/{filename} endpoint below.
        # The "provisional" file is the manual-derived URDF with the
        # corrected §9.1 zero-pose offsets (J3/J5 rpy −π/2) and the
        # 231 mm elbow lateral. Swap back to s10-140.urdf if the older
        # geometry needs to be reproduced for comparison.
        return _serve_robot_asset('s10-140-provisional.urdf', 'application/xml')

    @app.get("/robot/links/{filename}")
    async def robot_link_file(filename: str):
        if '..' in filename or '/' in filename:
            return JSONResponse({"detail": "bad path"}, status_code=400)
        ext = os.path.splitext(filename)[1].lower()
        media = {
            '.json': 'application/json',
            '.stl':  'application/sla',
            '.glb':  'model/gltf-binary',
        }.get(ext, 'application/octet-stream')
        return _serve_robot_asset(f'links/{filename}', media)

    # ------------------------------------------------------------------
    # Quality Inspection endpoints (PART H)
    #
    # The pipeline runs in a separate ROS2 node (inspection_pipeline).
    # Until the Mech-Eye camera is integrated the node ships disabled,
    # but every endpoint below is structurally complete so the UI can
    # render properly and configuration can be edited in advance.
    # File-backed storage at /opt/cobot/inspections (see PART F).
    # ------------------------------------------------------------------

    # Tolerate both module-run (`python -m cobot_dashboard.dashboard_server`)
    # and direct-script-run (`python dashboard_server.py`, what the systemd
    # unit does). The relative import only resolves when there's a parent
    # package — fall back to a path-based absolute import otherwise.
    try:
        from .inspection_helpers import InspectionHelpers as _InspectionHelpers
    except ImportError:
        import sys as _sys
        if str(_THIS_DIR) not in _sys.path:
            _sys.path.insert(0, str(_THIS_DIR))
        from inspection_helpers import InspectionHelpers as _InspectionHelpers
    _insp = _InspectionHelpers()  # bundles all the disk/SQLite helpers

    @app.get("/api/inspections")
    async def api_inspections_list(
        start_date: float | None = None,
        end_date:   float | None = None,
        part_id:    str | None = None,
        result:     str | None = None,
        tier:       int | None = None,
        page:       int = 1,
        per_page:   int = 25,
        sort:       str = '-timestamp',
    ):
        return _insp.list_records(
            start_date=start_date, end_date=end_date, part_id=part_id,
            result=result, tier=tier, page=page, per_page=per_page,
            sort=sort)

    @app.get("/api/inspections/stats")
    async def api_inspections_stats(timeframe: str = '24h',
                                    part_id: str | None = None):
        return _insp.get_stats(timeframe=timeframe, part_id=part_id)

    @app.get("/api/inspections/stats/timeseries")
    async def api_inspections_timeseries(
        metric:       str = 'max_deviation',
        timeframe:    str = '7d',
        part_id:      str | None = None,
        granularity:  str = 'day',
    ):
        return _insp.timeseries(metric=metric, timeframe=timeframe,
                                 part_id=part_id, granularity=granularity)

    @app.get("/api/inspections/stats/distribution")
    async def api_inspections_distribution(
        metric:    str = 'max_deviation',
        timeframe: str = '7d',
        part_id:   str | None = None,
        bins:      int = 30,
    ):
        return _insp.distribution(metric=metric, timeframe=timeframe,
                                   part_id=part_id, bins=bins)

    @app.get("/api/inspections/storage")
    async def api_inspections_storage():
        return _insp.storage_summary()

    @app.post("/api/inspections/cleanup")
    async def api_inspections_cleanup(request: Request):
        body = await request.json()
        return _insp.cleanup(dry_run=bool(body.get('dry_run', True)),
                              before_date=body.get('before_date'))

    @app.get("/api/inspections/tolerances")
    async def api_inspections_tolerances_all():
        return _insp.load_tolerances()

    @app.get("/api/inspections/tolerances/{part_id}")
    async def api_inspections_tolerances_one(part_id: str):
        return _insp.load_tolerances().get(part_id, {})

    @app.post("/api/inspections/tolerances")
    async def api_inspections_tolerances_save(request: Request):
        body = await request.json()
        return _insp.save_tolerance_rule(body)

    @app.delete("/api/inspections/tolerances/{rule_id}")
    async def api_inspections_tolerances_delete(rule_id: str):
        return _insp.delete_tolerance_rule(rule_id)

    @app.get("/api/inspections/plans")
    async def api_inspections_plans_all():
        return _insp.load_plans()

    @app.get("/api/inspections/plans/{plan_id}")
    async def api_inspections_plans_one(plan_id: str):
        p = _insp.load_plans().get(plan_id)
        if p is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        return p

    @app.post("/api/inspections/plans")
    async def api_inspections_plans_save(request: Request):
        body = await request.json()
        return _insp.save_plan(body)

    @app.delete("/api/inspections/plans/{plan_id}")
    async def api_inspections_plans_delete(plan_id: str):
        return _insp.delete_plan(plan_id)

    @app.post("/api/inspections/plans/{plan_id}/validate")
    async def api_inspections_plan_validate(plan_id: str):
        return _insp.validate_plan(plan_id)

    @app.get("/api/inspections/references/{part_id}")
    async def api_inspections_refs_list(part_id: str):
        return _insp.list_references(part_id)

    @app.post("/api/inspections/references/{part_id}/build_from_step")
    async def api_inspections_refs_build_step(part_id: str, request: Request):
        body = await request.json()
        return _insp.build_reference_from_step(
            part_id=part_id,
            step_path=body.get('step_path'),
            sample_points=int(body.get('sample_points', 1_000_000)))

    @app.post("/api/inspections/references/{part_id}/capture_golden")
    async def api_inspections_refs_capture_golden(part_id: str, request: Request):
        body = await request.json() if request.headers.get('content-length') else {}
        return _insp.capture_golden_reference(part_id=part_id,
                                               metadata=body or {})

    @app.post("/api/inspections/references/{part_id}/build_statistical")
    async def api_inspections_refs_build_stat(part_id: str, request: Request):
        body = await request.json()
        return _insp.build_statistical_reference(
            part_id=part_id,
            min_samples=int(body.get('min_samples', 30)))

    @app.post("/api/inspections/references/{part_id}/set_active")
    async def api_inspections_refs_set_active(part_id: str, request: Request):
        body = await request.json()
        return _insp.set_active_reference(
            part_id=part_id, ref_type=body.get('type', ''))

    @app.get("/api/inspections/templates")
    async def api_inspections_templates_all():
        return _insp.load_templates()

    @app.post("/api/inspections/templates")
    async def api_inspections_templates_save(request: Request):
        body = await request.json()
        return _insp.save_template(body)

    @app.post("/api/inspections/export")
    async def api_inspections_export(request: Request):
        body = await request.json()
        return _insp.export(format=body.get('format', 'csv'),
                             filters=body.get('filters', {}),
                             date_range=body.get('date_range', {}))

    @app.post("/api/inspections/start")
    async def api_inspections_start(request: Request):
        body = await request.json()
        return _insp.start_inspection(_ros_node, body)

    # ── per-id endpoints (registered after the static-prefixed ones so
    # FastAPI's path resolver doesn't match e.g. /stats here) ────────
    @app.get("/api/inspections/{inspection_id}")
    async def api_inspections_one(inspection_id: str):
        rec = _insp.load_record(inspection_id)
        if rec is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        return rec

    @app.get("/api/inspections/{inspection_id}/cloud")
    async def api_inspections_cloud(inspection_id: str):
        path = _insp.record_file_path(inspection_id, 'cloud.ply')
        if not path:
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, media_type='application/octet-stream')

    @app.get("/api/inspections/{inspection_id}/heatmap")
    async def api_inspections_heatmap(inspection_id: str):
        path = _insp.record_file_path(inspection_id, 'heatmap.ply')
        if not path:
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, media_type='application/octet-stream')

    @app.get("/api/inspections/{inspection_id}/report")
    async def api_inspections_report(inspection_id: str):
        path = _insp.ensure_report(inspection_id)
        if not path:
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, media_type='application/pdf',
                            filename=f'inspection_{inspection_id}.pdf')

    @app.get("/api/inspections/{inspection_id}/screenshot/{view}")
    async def api_inspections_screenshot(inspection_id: str, view: str):
        path = _insp.record_file_path(
            inspection_id, f'screenshot_{view}.png')
        if not path:
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, media_type='image/png')

    @app.post("/api/inspections/{inspection_id}/cancel")
    async def api_inspections_cancel(inspection_id: str):
        return _insp.cancel_inspection(_ros_node, inspection_id)

    @app.post("/api/inspections/{inspection_id}/mark_false_positive")
    async def api_inspections_mark_fp(inspection_id: str, request: Request):
        body = await request.json()
        return _insp.mark_false_positive(
            inspection_id=inspection_id,
            reason=body.get('reason', ''),
            defects_to_unflag=body.get('defects_to_unflag', []))

    @app.post("/api/inspections/{inspection_id}/notes")
    async def api_inspections_notes(inspection_id: str, request: Request):
        body = await request.json()
        return _insp.add_notes(inspection_id, body.get('notes', ''))

    @app.post("/api/inspections/{inspection_id}/re_run")
    async def api_inspections_re_run(inspection_id: str):
        return _insp.re_run_inspection(_ros_node, inspection_id)

    @app.websocket("/ws/inspection")
    async def ws_inspection(websocket: WebSocket):
        """Live inspection status. Pushes whatever the ROS node emits
        on /inspection/status and /inspection/result so the dashboard
        Active sub-tab can render a progress bar.
        """
        await websocket.accept()
        q = asyncio.Queue(maxsize=4)
        with _ws_lock:
            _insp_clients[websocket] = q
        try:
            while True:
                txt = await q.get()
                await websocket.send_text(txt)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            with _ws_lock:
                _insp_clients.pop(websocket, None)

    # ------------------------------------------------------------------
    # Motion optimization endpoints
    #
    # Profiles + robot limits live at /opt/cobot/motion/. The dashboard
    # owns the on-disk schema (so the Configure tab can edit without a
    # ROS round-trip); the motion_optimizer_node reads the same files at
    # service-call time. Heavy work (cycle-time estimation, trajectory
    # optimization preview) is delegated to the ROS service when it's
    # up, with sane file-only fallbacks so the UI never blocks on it.
    # ------------------------------------------------------------------
    _MOTION_DIR             = '/opt/cobot/motion'
    _MOTION_CONFIG_DIR      = os.path.join(_MOTION_DIR, 'config')
    _MOTION_STATS_DIR       = os.path.join(_MOTION_DIR, 'statistics')
    _MOTION_LIMITS_PATH     = os.path.join(_MOTION_CONFIG_DIR, 'robot_limits.yaml')
    _MOTION_PROFILES_PATH   = os.path.join(_MOTION_CONFIG_DIR, 'profiles.json')
    _MOTION_DEFAULT_PATH    = os.path.join(_MOTION_CONFIG_DIR, 'system_default.json')

    _MOTION_DEFAULT_LIMITS = {
        'joint_velocity_limits_dps':      [180.0] * 6,
        'joint_acceleration_limits_dps2': [400.0] * 6,
        'joint_jerk_limits_dps3':         [4000.0] * 6,
        'tcp_linear_velocity_mps':        1.5,
        'tcp_linear_acceleration_mps2':   5.0,
        'tcp_angular_velocity_dps':       180.0,
    }
    _MOTION_BUILTINS = {
        'Conservative': {
            'name': 'Conservative',
            'description': 'Slow and smooth. Maximum safety. Use during '
                           'teaching and initial program verification.',
            'velocity_scale_pct': 40, 'acceleration_scale_pct': 30,
            'jerk_scale_pct': 25, 'blend_radius_mm': 5,
            'toppra_enabled': False, 'moveit_enabled': False,
            'smoothing_method': 'spline',
            'approach_speed_pct': 30, 'retreat_speed_pct': 40,
            'created_by_user': False, 'created_at': '',
        },
        'Balanced': {
            'name': 'Balanced',
            'description': 'Default profile. Good balance of cycle time '
                           'and smoothness for production work.',
            'velocity_scale_pct': 70, 'acceleration_scale_pct': 60,
            'jerk_scale_pct': 50, 'blend_radius_mm': 15,
            'toppra_enabled': True, 'moveit_enabled': False,
            'smoothing_method': 'toppra',
            'approach_speed_pct': 40, 'retreat_speed_pct': 60,
            'created_by_user': False, 'created_at': '',
        },
        'Aggressive': {
            'name': 'Aggressive',
            'description': 'Maximum cycle-time optimization. Use for '
                           'high-volume production after verifying '
                           'behavior at Balanced.',
            'velocity_scale_pct': 95, 'acceleration_scale_pct': 90,
            'jerk_scale_pct': 80, 'blend_radius_mm': 25,
            'toppra_enabled': True, 'moveit_enabled': True,
            'smoothing_method': 'toppra',
            'approach_speed_pct': 50, 'retreat_speed_pct': 80,
            'created_by_user': False, 'created_at': '',
        },
    }
    _MOTION_BUILTIN_NAMES = set(_MOTION_BUILTINS.keys())

    def _motion_ensure_dirs():
        os.makedirs(_MOTION_CONFIG_DIR, exist_ok=True)
        os.makedirs(_MOTION_STATS_DIR, exist_ok=True)

    def _motion_load_limits():
        _motion_ensure_dirs()
        if os.path.isfile(_MOTION_LIMITS_PATH):
            try:
                import yaml as _yaml
                with open(_MOTION_LIMITS_PATH) as fp:
                    return dict(_yaml.safe_load(fp) or {})
            except Exception:
                pass
        return dict(_MOTION_DEFAULT_LIMITS)

    def _motion_save_limits(body: dict):
        _motion_ensure_dirs()
        out = dict(_MOTION_DEFAULT_LIMITS)
        out.update({k: v for k, v in (body or {}).items() if k in _MOTION_DEFAULT_LIMITS})
        try:
            import yaml as _yaml
            tmp = _MOTION_LIMITS_PATH + '.tmp'
            with open(tmp, 'w') as fp:
                _yaml.safe_dump(out, fp)
            os.replace(tmp, _MOTION_LIMITS_PATH)
        except Exception as e:
            return None, str(e)
        return out, None

    def _motion_load_customs():
        _motion_ensure_dirs()
        if os.path.isfile(_MOTION_PROFILES_PATH):
            try:
                with open(_MOTION_PROFILES_PATH) as fp:
                    return dict(json.load(fp) or {})
            except Exception:
                pass
        return {}

    def _motion_save_customs(customs: dict):
        _motion_ensure_dirs()
        tmp = _MOTION_PROFILES_PATH + '.tmp'
        with open(tmp, 'w') as fp:
            json.dump(customs, fp, indent=2)
        os.replace(tmp, _MOTION_PROFILES_PATH)

    def _motion_get_default_name():
        _motion_ensure_dirs()
        if os.path.isfile(_MOTION_DEFAULT_PATH):
            try:
                with open(_MOTION_DEFAULT_PATH) as fp:
                    return (json.load(fp) or {}).get('profile', 'Balanced')
            except Exception:
                pass
        return 'Balanced'

    def _motion_set_default_name(name: str):
        _motion_ensure_dirs()
        tmp = _MOTION_DEFAULT_PATH + '.tmp'
        with open(tmp, 'w') as fp:
            json.dump({'profile': name}, fp, indent=2)
        os.replace(tmp, _MOTION_DEFAULT_PATH)

    def _motion_all_profiles():
        customs = _motion_load_customs()
        default = _motion_get_default_name()
        out = []
        for name, body in _MOTION_BUILTINS.items():
            entry = dict(body)
            entry['name'] = name
            entry['is_builtin'] = True
            entry['is_default'] = (name == default)
            out.append(entry)
        for name, body in customs.items():
            entry = dict(body)
            entry['name'] = name
            entry['is_builtin'] = False
            entry['is_default'] = (name == default)
            out.append(entry)
        return out

    def _motion_quick_estimate(profile: dict, steps_count: int = 6):
        # Conservative-but-fast estimator: a canonical 6-step cycle takes
        # ~8s unoptimized on this arm. Scale by velocity_scale_pct (with
        # ~10% irreducible overhead) and the step count. Matches the
        # toppra_engine.estimate_duration ballpark within ~15%.
        v = max(float(profile.get('velocity_scale_pct') or 70.0), 1.0)
        baseline_per_step = 1.3  # seconds at velocity_scale_pct=100
        overhead = 0.2 * steps_count
        return overhead + steps_count * (baseline_per_step * 100.0 / v)

    def _motion_validate_profile(body: dict):
        for fname in ('velocity_scale_pct', 'acceleration_scale_pct',
                      'jerk_scale_pct', 'approach_speed_pct',
                      'retreat_speed_pct'):
            v = body.get(fname)
            if v is None:
                continue
            try:
                v = float(v)
            except (TypeError, ValueError):
                return f'{fname} must be numeric'
            if v < 0 or v > 100:
                return f'{fname} must be in [0, 100]'
        if 'blend_radius_mm' in body:
            try:
                br = float(body['blend_radius_mm'])
                if br < 0 or br > 200:
                    return 'blend_radius_mm must be in [0, 200]'
            except (TypeError, ValueError):
                return 'blend_radius_mm must be numeric'
        if 'smoothing_method' in body and body['smoothing_method'] not in (
                'none', 'spline', 'toppra', 'moveit'):
            return 'smoothing_method must be none/spline/toppra/moveit'
        return None

    @app.get("/api/motion/limits")
    async def api_motion_get_limits():
        return _motion_load_limits()

    @app.post("/api/motion/limits")
    async def api_motion_set_limits(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        out, err = _motion_save_limits(body)
        if err:
            return JSONResponse({"ok": False, "error": err}, status_code=400)
        return {"ok": True, "limits": out}

    @app.post("/api/motion/limits/reset")
    async def api_motion_reset_limits():
        out, err = _motion_save_limits(_MOTION_DEFAULT_LIMITS)
        if err:
            return JSONResponse({"ok": False, "error": err}, status_code=500)
        return {"ok": True, "limits": out}

    @app.get("/api/motion/profiles")
    async def api_motion_list_profiles():
        return {"profiles": _motion_all_profiles(),
                "default": _motion_get_default_name()}

    @app.get("/api/motion/profiles/{name}")
    async def api_motion_get_profile(name: str):
        for p in _motion_all_profiles():
            if p['name'] == name:
                return p
        return JSONResponse({"error": f"profile '{name}' not found"},
                            status_code=404)

    @app.post("/api/motion/profiles")
    async def api_motion_create_profile(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = (body.get('name') or '').strip()
        if not name:
            return JSONResponse({"ok": False, "error": "name is required"},
                                status_code=400)
        if name in _MOTION_BUILTIN_NAMES:
            return JSONResponse(
                {"ok": False,
                 "error": f"'{name}' is built-in; duplicate it under a new name"},
                status_code=400)
        err = _motion_validate_profile(body)
        if err:
            return JSONResponse({"ok": False, "error": err}, status_code=400)
        customs = _motion_load_customs()
        if name in customs and not body.get('overwrite'):
            return JSONResponse(
                {"ok": False, "error": f"profile '{name}' already exists"},
                status_code=409)
        body['name'] = name
        body['created_by_user'] = True
        body.setdefault('created_at', datetime.utcnow().isoformat(timespec='seconds') + 'Z')
        customs[name] = {k: v for k, v in body.items() if k != 'overwrite'}
        _motion_save_customs(customs)
        return {"ok": True, "profile": customs[name]}

    @app.put("/api/motion/profiles/{name}")
    async def api_motion_update_profile(name: str, request: Request):
        if name in _MOTION_BUILTIN_NAMES:
            return JSONResponse(
                {"ok": False, "error": f"'{name}' is built-in and read-only"},
                status_code=400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        err = _motion_validate_profile(body)
        if err:
            return JSONResponse({"ok": False, "error": err}, status_code=400)
        customs = _motion_load_customs()
        if name not in customs:
            return JSONResponse({"ok": False, "error": "profile not found"},
                                status_code=404)
        existing = customs[name]
        existing.update({k: v for k, v in body.items() if k != 'name'})
        existing['name'] = name
        existing['created_by_user'] = True
        customs[name] = existing
        _motion_save_customs(customs)
        return {"ok": True, "profile": existing}

    @app.delete("/api/motion/profiles/{name}")
    async def api_motion_delete_profile(name: str):
        if name in _MOTION_BUILTIN_NAMES:
            return JSONResponse(
                {"ok": False, "error": "built-in profiles cannot be deleted"},
                status_code=400)
        customs = _motion_load_customs()
        if name not in customs:
            return JSONResponse({"ok": False, "error": "profile not found"},
                                status_code=404)
        del customs[name]
        _motion_save_customs(customs)
        if _motion_get_default_name() == name:
            _motion_set_default_name('Balanced')
        return {"ok": True}

    @app.post("/api/motion/profiles/{name}/set_default")
    async def api_motion_set_default(name: str):
        if name not in _MOTION_BUILTIN_NAMES and name not in _motion_load_customs():
            return JSONResponse({"ok": False, "error": "profile not found"},
                                status_code=404)
        _motion_set_default_name(name)
        return {"ok": True, "default": name}

    @app.post("/api/motion/estimate")
    async def api_motion_estimate(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        profile_name = body.get('profile_name') or _motion_get_default_name()
        program_id = body.get('program_id')
        # Pull step count from on-disk program if provided; otherwise
        # assume a 6-step canonical cycle.
        steps_count = 6
        if program_id:
            path = _prog_path(program_id)
            if path and os.path.isfile(path):
                try:
                    with open(path) as fp:
                        prog = json.load(fp)
                    steps_count = max(2, len(prog.get('steps') or []))
                except Exception:
                    pass
        profile = next((p for p in _motion_all_profiles()
                        if p['name'] == profile_name), None)
        if not profile:
            return JSONResponse({"ok": False, "error": "profile not found"},
                                status_code=404)
        baseline = {'velocity_scale_pct': 100.0}
        opt = _motion_quick_estimate(profile, steps_count)
        unopt = _motion_quick_estimate(baseline, steps_count)
        return {
            "ok": True,
            "profile_name": profile_name,
            "program_id": program_id,
            "step_count": steps_count,
            "estimated_duration_s": round(opt, 2),
            "unoptimized_duration_s": round(unopt, 2),
            "estimated_savings_s": round(max(0.0, unopt - opt), 2),
            "estimated_savings_pct": round(
                100.0 * max(0.0, unopt - opt) / max(unopt, 1e-3), 1),
        }

    @app.post("/api/motion/test")
    async def api_motion_test_profile(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        profile_name = body.get('profile_name') or _motion_get_default_name()
        profile = next((p for p in _motion_all_profiles()
                        if p['name'] == profile_name), None)
        if not profile:
            return JSONResponse({"ok": False, "error": "profile not found"},
                                status_code=404)
        # No real trajectory plumbing in the preview; we return the
        # numbers the profile editor cares about (peak velocity proxy +
        # ETA delta) so the live preview can update without running TOPP-RA.
        eta = _motion_quick_estimate(profile, 6)
        baseline = _motion_quick_estimate({'velocity_scale_pct': 100.0}, 6)
        peak_v = (max(_motion_load_limits().get('joint_velocity_limits_dps') or [180.0])
                  * profile['velocity_scale_pct'] / 100.0)
        return {
            "ok": True,
            "profile_name": profile_name,
            "preview": {
                "estimated_cycle_s": round(eta, 2),
                "baseline_cycle_s": round(baseline, 2),
                "savings_pct": round(100.0 * max(0.0, baseline - eta) / max(baseline, 1e-3), 1),
                "peak_joint_velocity_dps": round(peak_v, 1),
            },
        }

    @app.get("/api/motion/statistics")
    async def api_motion_statistics(program_id: str = '', timeframe: str = 'today'):
        # Read the executor's per-program stats file and synthesize a
        # motion-statistics view. Until /motion_optimization/statistics
        # is populated by live cycles, we surface what we have.
        out = {
            "program_id": program_id,
            "timeframe": timeframe,
            "cycles": [],
            "average_cycle_s": 0.0,
            "best_cycle_s": 0.0,
            "worst_cycle_s": 0.0,
            "time_saved_today_s": 0.0,
        }
        if not program_id:
            return out
        stats_path = os.path.join('/opt/cobot/stats', f'{program_id}.json')
        if not os.path.isfile(stats_path):
            return out
        try:
            with open(stats_path) as fp:
                doc = json.load(fp)
        except Exception:
            return out
        cycles = [c for c in (doc.get('cycle_times') or [])
                  if isinstance(c, dict) and c.get('time')]
        out['cycles'] = cycles[-20:]
        if cycles:
            times = [float(c['time']) for c in cycles]
            out['average_cycle_s'] = round(sum(times) / len(times), 2)
            out['best_cycle_s'] = round(min(times), 2)
            out['worst_cycle_s'] = round(max(times), 2)
            # Use the program's stored "unoptimized" baseline if present;
            # otherwise estimate using the system default profile.
            baseline = doc.get('baseline_cycle_s')
            if baseline is None:
                baseline = _motion_quick_estimate(
                    {'velocity_scale_pct': 100.0}, max(1, len(times)))
            saved_per = max(0.0, baseline - out['average_cycle_s'])
            out['time_saved_today_s'] = round(saved_per * len(times), 2)
        return out

    @app.get("/api/motion/moveit_status")
    async def api_motion_moveit_status():
        urdf = '/opt/cobot/models/estun_s10_140.urdf'
        moveit_cfg = '/opt/cobot/moveit_config'
        srdf = os.path.join(moveit_cfg, 'config', 'estun_s10_140.srdf')
        kin = os.path.join(moveit_cfg, 'config', 'kinematics.yaml')
        urdf_exists = os.path.isfile(urdf)
        srdf_exists = os.path.isfile(srdf)
        cfg_valid = urdf_exists and srdf_exists and os.path.isfile(kin)
        return {
            "available": cfg_valid,
            "urdf_path": urdf,
            "urdf_exists": urdf_exists,
            "srdf_path": srdf,
            "srdf_exists": srdf_exists,
            "kinematics_yaml_exists": os.path.isfile(kin),
            "config_valid": cfg_valid,
            "default_planner": "RRTConnect",
            "collision_scene_active": False,
            "next_step": (
                "Drop URDF at /opt/cobot/models/estun_s10_140.urdf, "
                "then run scripts/setup_moveit_config.sh"
                if not urdf_exists else
                "Run scripts/setup_moveit_config.sh to generate SRDF + kinematics.yaml"
                if not srdf_exists else
                "MoveIt2 ready — enable it via the Aggressive profile or a custom profile."
            ),
        }

    @app.post("/api/motion/moveit_setup")
    async def api_motion_moveit_setup():
        urdf = '/opt/cobot/models/estun_s10_140.urdf'
        if not os.path.isfile(urdf):
            return JSONResponse({
                "ok": False,
                "error": "URDF not present at /opt/cobot/models/estun_s10_140.urdf",
            }, status_code=400)
        return {"ok": True,
                "message": "Setup script staged. Run scripts/setup_moveit_config.sh "
                           "as cobot to populate /opt/cobot/moveit_config/."}

    @app.get("/api/programs/{prog_id}/motion_profile")
    async def api_program_motion_profile_get(prog_id: str):
        path = _prog_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "program not found"}, status_code=404)
        try:
            with open(path) as fp:
                prog = json.load(fp)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        return {
            "program_id": prog_id,
            "profile_name": prog.get('motion_profile_name') or _motion_get_default_name(),
            "motion_optimization_enabled":
                bool(prog.get('motion_optimization_enabled', True)),
            "motion_profile_override_enabled":
                bool(prog.get('motion_profile_override_enabled', False)),
        }

    @app.put("/api/programs/{prog_id}/motion_profile")
    async def api_program_motion_profile_set(prog_id: str, request: Request):
        path = _prog_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "program not found"}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        profile_name = (body.get('profile_name') or '').strip()
        if not profile_name:
            return JSONResponse({"ok": False, "error": "profile_name required"},
                                status_code=400)
        if (profile_name not in _MOTION_BUILTIN_NAMES
                and profile_name not in _motion_load_customs()):
            return JSONResponse({"ok": False, "error": "profile not found"},
                                status_code=404)
        try:
            with open(path) as fp:
                prog = json.load(fp)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)
        prog['motion_profile_name'] = profile_name
        if 'motion_optimization_enabled' in body:
            prog['motion_optimization_enabled'] = bool(body['motion_optimization_enabled'])
        if 'motion_profile_override_enabled' in body:
            prog['motion_profile_override_enabled'] = bool(
                body['motion_profile_override_enabled'])
        prog['updated'] = _now_stamp()
        tmp = path + '.tmp'
        with open(tmp, 'w') as fp:
            json.dump(prog, fp, indent=2)
        os.replace(tmp, path)
        return {"ok": True,
                "profile_name": profile_name,
                "motion_optimization_enabled":
                    prog.get('motion_optimization_enabled', True)}

    _motion_stats_clients: set = set()
    _motion_setup_clients: set = set()

    @app.websocket("/ws/motion_statistics")
    async def ws_motion_statistics(websocket: WebSocket):
        await websocket.accept()
        _motion_stats_clients.add(websocket)
        try:
            while True:
                # Push the latest snapshot once per second. Clients
                # primarily care about cycle deltas, not high-frequency
                # updates.
                payload = {
                    "ts": datetime.utcnow().isoformat(timespec='seconds') + 'Z',
                    "active_profile": _motion_get_default_name(),
                    "last_cycle_s": STATE.get('task', {}).get('last_cycle_time') or 0.0,
                }
                await websocket.send_text(json.dumps(payload))
                await asyncio.sleep(1.0)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            _motion_stats_clients.discard(websocket)

    @app.websocket("/ws/motion_moveit_setup")
    async def ws_motion_moveit_setup(websocket: WebSocket):
        await websocket.accept()
        _motion_setup_clients.add(websocket)
        try:
            # The setup script is run out-of-band by the operator. We
            # push the current MoveIt2 status every 2s so the dashboard
            # progress UI can transition red → yellow → green as files
            # appear on disk.
            while True:
                urdf = '/opt/cobot/models/estun_s10_140.urdf'
                srdf = '/opt/cobot/moveit_config/config/estun_s10_140.srdf'
                payload = {
                    "ts": datetime.utcnow().isoformat(timespec='seconds') + 'Z',
                    "urdf_present": os.path.isfile(urdf),
                    "srdf_present": os.path.isfile(srdf),
                    "phase": ("ready" if os.path.isfile(srdf)
                              else "needs_setup" if os.path.isfile(urdf)
                              else "needs_urdf"),
                }
                await websocket.send_text(json.dumps(payload))
                await asyncio.sleep(2.0)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            _motion_setup_clients.discard(websocket)

    # ------------------------------------------------------------------
    # LiDAR object identifier endpoints
    #
    # The identifier node owns the live identified-objects state; this
    # FastAPI layer mirrors the on-disk configuration (workspace mask,
    # ignore list, confidence thresholds, operator corrections) and
    # exposes a snapshot of what the node last published.
    # ------------------------------------------------------------------
    _LIDAR_DIR = '/opt/cobot/lidar'
    _LIDAR_CONFIG_DIR = os.path.join(_LIDAR_DIR, 'config')
    _LIDAR_HISTORY_DIR = os.path.join(_LIDAR_DIR, 'history')
    _LIDAR_WORKSPACE_MASK = os.path.join(_LIDAR_CONFIG_DIR, 'workspace_mask.yaml')
    _LIDAR_IGNORE_LIST = os.path.join(_LIDAR_CONFIG_DIR, 'ignore_list.json')
    _LIDAR_CORRECTIONS = os.path.join(_LIDAR_CONFIG_DIR, 'corrections.jsonl')
    _LIDAR_CONFIDENCE_THRESHOLDS = os.path.join(_LIDAR_CONFIG_DIR,
                                                'confidence_thresholds.json')

    _LIDAR_LATEST = {
        "objects": [],
        "stats": {
            "avg_confidence": 0.0,
            "identification_rate_per_sec": 0.0,
            "known_parts_in_library": 0,
            "unique_objects_today": 0,
            "false_positives_filtered": 0,
        },
        "updated_at": None,
    }
    _LIDAR_LATEST_LOCK = threading.Lock()

    def _lidar_ensure_dirs():
        os.makedirs(_LIDAR_CONFIG_DIR, exist_ok=True)
        os.makedirs(_LIDAR_HISTORY_DIR, exist_ok=True)

    def _lidar_load_mask():
        if not os.path.isfile(_LIDAR_WORKSPACE_MASK):
            return None
        try:
            import yaml as _yaml
            with open(_LIDAR_WORKSPACE_MASK) as fp:
                doc = _yaml.safe_load(fp) or {}
            verts = doc.get('polygon') or []
            return [[float(v[0]), float(v[1])] for v in verts
                    if isinstance(v, (list, tuple)) and len(v) >= 2]
        except Exception:
            return None

    def _lidar_save_mask(polygon):
        _lidar_ensure_dirs()
        import yaml as _yaml
        tmp = _LIDAR_WORKSPACE_MASK + '.tmp'
        with open(tmp, 'w') as fp:
            _yaml.safe_dump({'polygon': [list(map(float, v)) for v in polygon]}, fp)
        os.replace(tmp, _LIDAR_WORKSPACE_MASK)

    def _lidar_load_ignore():
        if not os.path.isfile(_LIDAR_IGNORE_LIST):
            return []
        try:
            with open(_LIDAR_IGNORE_LIST) as fp:
                return list(json.load(fp) or [])
        except Exception:
            return []

    def _lidar_save_ignore(entries):
        _lidar_ensure_dirs()
        tmp = _LIDAR_IGNORE_LIST + '.tmp'
        with open(tmp, 'w') as fp:
            json.dump(entries, fp, indent=2)
        os.replace(tmp, _LIDAR_IGNORE_LIST)

    def _lidar_append_correction(entry):
        _lidar_ensure_dirs()
        with open(_LIDAR_CORRECTIONS, 'a') as fp:
            fp.write(json.dumps(entry) + '\n')

    def _lidar_history_paths():
        if not os.path.isdir(_LIDAR_HISTORY_DIR):
            return []
        files = []
        for y in sorted(os.listdir(_LIDAR_HISTORY_DIR)):
            ydir = os.path.join(_LIDAR_HISTORY_DIR, y)
            if not os.path.isdir(ydir):
                continue
            for m in sorted(os.listdir(ydir)):
                mdir = os.path.join(ydir, m)
                ipath = os.path.join(mdir, 'identifications.jsonl')
                if os.path.isfile(ipath):
                    files.append(ipath)
        return files

    if RCLPY_AVAILABLE and _ros_node is not None:
        # Lazy bind: the dashboard ROS node creates subscribers in its
        # __init__. We attach the lidar identifier streams here without
        # touching the node class — easier to add over time.
        try:
            from lidar_object_identifier_msgs.msg import (
                IdentifiedObjectArray as _LidarObjArrayMsg,
                ObjectIdentificationStats as _LidarStatsMsg,
            )

            def _ident_array_cb(msg):
                with _LIDAR_LATEST_LOCK:
                    _LIDAR_LATEST['objects'] = [
                        {
                            'id': int(o.id),
                            'identified_as': o.identified_as,
                            'identified_name': o.identified_name,
                            'confidence': float(o.identification_confidence),
                            'center': {'x': o.center.x, 'y': o.center.y, 'z': o.center.z},
                            'dimensions': {'x': o.dimensions.x, 'y': o.dimensions.y,
                                           'z': o.dimensions.z},
                            'orientation': {
                                'x': o.orientation.x, 'y': o.orientation.y,
                                'z': o.orientation.z, 'w': o.orientation.w,
                            },
                            'volume_m3': float(o.volume_m3),
                            'point_count': float(o.point_count),
                            'sphericity': float(o.sphericity),
                            'flatness': float(o.flatness),
                            'size_match_score': float(o.size_match_score),
                            'shape_match_score': float(o.shape_match_score),
                            'overall_match_score': float(o.overall_match_score),
                            'frames_observed': int(o.frames_observed),
                            'stability_score': float(o.stability_score),
                            'alternatives': list(zip(
                                list(o.alternative_matches),
                                [float(s) for s in o.alternative_scores])),
                        }
                        for o in msg.objects
                    ]
                    _LIDAR_LATEST['updated_at'] = datetime.utcnow().isoformat(
                        timespec='seconds') + 'Z'

            def _ident_stats_cb(msg):
                with _LIDAR_LATEST_LOCK:
                    _LIDAR_LATEST['stats'] = {
                        'avg_confidence': float(msg.avg_confidence),
                        'identification_rate_per_sec':
                            float(msg.identification_rate_per_sec),
                        'known_parts_in_library': int(msg.known_parts_in_library),
                        'unique_objects_today': int(msg.unique_objects_today),
                        'false_positives_filtered': int(msg.false_positives_filtered),
                    }

            _ros_node.create_subscription(
                _LidarObjArrayMsg, '/lidar_objects/identified',
                _ident_array_cb, 5)
            _ros_node.create_subscription(
                _LidarStatsMsg, '/lidar_objects/stats',
                _ident_stats_cb, 5)
        except Exception as _exc:
            # Identifier msgs not built yet — endpoints still work, just
            # serve the empty snapshot.
            pass

    @app.get("/api/lidar_objects/identified")
    async def api_lidar_objects():
        with _LIDAR_LATEST_LOCK:
            return {
                'objects': list(_LIDAR_LATEST['objects']),
                'updated_at': _LIDAR_LATEST['updated_at'],
                'stats': dict(_LIDAR_LATEST['stats']),
            }

    @app.get("/api/lidar_objects/{obj_id}")
    async def api_lidar_object_detail(obj_id: int):
        with _LIDAR_LATEST_LOCK:
            for o in _LIDAR_LATEST['objects']:
                if int(o['id']) == int(obj_id):
                    return o
        return JSONResponse({"error": "not found"}, status_code=404)

    @app.get("/api/lidar_objects/stats")
    async def api_lidar_objects_stats(timeframe: str = 'today'):
        with _LIDAR_LATEST_LOCK:
            stats = dict(_LIDAR_LATEST['stats'])
        # Adds quick history-derived counters (cheap, single pass).
        unique_seen = set()
        total = 0
        for path in _lidar_history_paths():
            try:
                with open(path) as fp:
                    for line in fp:
                        try:
                            doc = json.loads(line)
                        except Exception:
                            continue
                        total += 1
                        pid = doc.get('identified_as')
                        if pid:
                            unique_seen.add(pid)
            except Exception:
                continue
        stats['historical_identifications'] = total
        stats['unique_parts_seen'] = len(unique_seen)
        stats['timeframe'] = timeframe
        return stats

    @app.get("/api/lidar_objects/by_part/{part_id}")
    async def api_lidar_objects_by_part(part_id: str):
        # Returns the in-memory matches first (most useful), then
        # appends history file lines that mention this part.
        with _LIDAR_LATEST_LOCK:
            live = [o for o in _LIDAR_LATEST['objects']
                    if o.get('identified_as') == part_id]
        history = []
        for path in _lidar_history_paths():
            try:
                with open(path) as fp:
                    for line in fp:
                        try:
                            doc = json.loads(line)
                        except Exception:
                            continue
                        if doc.get('identified_as') == part_id:
                            history.append(doc)
            except Exception:
                continue
        return {"live": live, "history": history[-100:]}

    @app.post("/api/lidar_objects/{obj_id}/override")
    async def api_lidar_object_override(obj_id: int, request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        correct = (body.get('correct_part_id') or '').strip()
        if not correct:
            return JSONResponse({"ok": False, "error": "correct_part_id required"},
                                status_code=400)
        with _LIDAR_LATEST_LOCK:
            current = next((o for o in _LIDAR_LATEST['objects']
                            if int(o['id']) == int(obj_id)), None)
        _lidar_append_correction({
            "ts": datetime.utcnow().isoformat(timespec='seconds') + 'Z',
            "object_id": int(obj_id),
            "previous_part_id": current.get('identified_as') if current else None,
            "correct_part_id": correct,
        })
        return {"ok": True}

    @app.post("/api/lidar_objects/ignore")
    async def api_lidar_ignore_add(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        center = body.get('center')
        radius = body.get('radius')
        if (not isinstance(center, (list, tuple)) or len(center) < 2
                or not isinstance(radius, (int, float)) or radius <= 0):
            return JSONResponse({"ok": False,
                                 "error": "center=[x,y] and radius>0 required"},
                                status_code=400)
        entries = _lidar_load_ignore()
        entries.append({
            "center": [float(center[0]), float(center[1])],
            "radius": float(radius),
            "reason": str(body.get('reason') or ''),
            "ts": datetime.utcnow().isoformat(timespec='seconds') + 'Z',
        })
        _lidar_save_ignore(entries)
        return {"ok": True, "entries": entries}

    @app.get("/api/lidar_workspace_mask")
    async def api_lidar_mask_get():
        return {"polygon": _lidar_load_mask() or []}

    @app.post("/api/lidar_workspace_mask")
    async def api_lidar_mask_set(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        polygon = body.get('polygon') or []
        if not isinstance(polygon, list) or len(polygon) < 3:
            return JSONResponse({"ok": False,
                                 "error": "polygon must have ≥3 vertices"},
                                status_code=400)
        try:
            _lidar_save_mask(polygon)
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return {"ok": True, "polygon": polygon}

    @app.post("/api/lidar_workspace_mask/clear")
    async def api_lidar_mask_clear():
        if os.path.isfile(_LIDAR_WORKSPACE_MASK):
            try:
                os.remove(_LIDAR_WORKSPACE_MASK)
            except Exception as e:
                return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        return {"ok": True}

    @app.get("/api/lidar_objects/confidence_calibration")
    async def api_lidar_confidence_calibration():
        # Per-part confidence distribution from history files.
        per_part = {}
        for path in _lidar_history_paths():
            try:
                with open(path) as fp:
                    for line in fp:
                        try:
                            doc = json.loads(line)
                        except Exception:
                            continue
                        pid = doc.get('identified_as')
                        c = float(doc.get('confidence') or 0.0)
                        if not pid:
                            continue
                        bucket = per_part.setdefault(pid, [])
                        bucket.append(c)
            except Exception:
                continue
        out = {}
        for pid, vals in per_part.items():
            if not vals:
                continue
            out[pid] = {
                "samples": len(vals),
                "mean": sum(vals) / len(vals),
                "min": min(vals),
                "max": max(vals),
            }
        return out

    _lidar_ws_clients: set = set()
    _lidar_event_clients: set = set()

    @app.websocket("/ws/lidar_objects")
    async def ws_lidar_objects(websocket: WebSocket):
        await websocket.accept()
        _lidar_ws_clients.add(websocket)
        try:
            while True:
                with _LIDAR_LATEST_LOCK:
                    payload = {
                        'objects': list(_LIDAR_LATEST['objects']),
                        'stats': dict(_LIDAR_LATEST['stats']),
                        'updated_at': _LIDAR_LATEST['updated_at'],
                    }
                await websocket.send_text(json.dumps(payload))
                await asyncio.sleep(0.2)  # 5 Hz
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            _lidar_ws_clients.discard(websocket)

    @app.websocket("/ws/lidar_object_events")
    async def ws_lidar_events(websocket: WebSocket):
        await websocket.accept()
        _lidar_event_clients.add(websocket)
        # Track which (id, identified_as) pairs we've seen so we can emit
        # confirmed/lost/identity_changed events when the state changes.
        seen: dict = {}
        try:
            while True:
                with _LIDAR_LATEST_LOCK:
                    objects = list(_LIDAR_LATEST['objects'])
                events = []
                current = {}
                for o in objects:
                    oid = int(o['id'])
                    current[oid] = o.get('identified_as')
                    prev = seen.get(oid)
                    if prev is None:
                        events.append({'event': 'new', 'object': o})
                    elif prev != o.get('identified_as'):
                        events.append({'event': 'identity_changed',
                                       'object': o,
                                       'previous_part_id': prev})
                for prev_id in list(seen.keys()):
                    if prev_id not in current:
                        events.append({'event': 'lost', 'id': prev_id})
                seen = current
                if events:
                    await websocket.send_text(json.dumps({
                        'ts': datetime.utcnow().isoformat(timespec='seconds') + 'Z',
                        'events': events,
                    }))
                await asyncio.sleep(0.5)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            _lidar_event_clients.discard(websocket)

    # ------------------------------------------------------------------
    # Cell profiles (Setup / Commissioning Wizard)
    # ------------------------------------------------------------------
    # A "cell" is a commissioned robot workspace. Stored on disk under
    # /opt/cobot/cells/{cell_id}/. The index file tracks ordering and
    # which cell is currently active.
    _CELLS_DIR  = '/opt/cobot/cells'
    _CELLS_INDEX = os.path.join(_CELLS_DIR, 'index.json')
    _cell_lock = threading.Lock()
    _baseline_sessions: dict = {}
    _baseline_lock = threading.Lock()

    def _cells_load_index():
        try:
            os.makedirs(_CELLS_DIR, exist_ok=True)
        except Exception:
            pass
        if not os.path.isfile(_CELLS_INDEX):
            return {'active_cell_id': None, 'cells': []}
        try:
            with open(_CELLS_INDEX) as f:
                data = json.load(f)
            if not isinstance(data, dict): return {'active_cell_id': None, 'cells': []}
            data.setdefault('active_cell_id', None)
            data.setdefault('cells', [])
            return data
        except Exception:
            return {'active_cell_id': None, 'cells': []}

    def _cells_save_index(data):
        os.makedirs(_CELLS_DIR, exist_ok=True)
        tmp = _CELLS_INDEX + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, _CELLS_INDEX)

    def _cell_dir(cell_id: str) -> str:
        return os.path.join(_CELLS_DIR, cell_id)

    def _cell_profile_path(cell_id: str) -> str:
        return os.path.join(_cell_dir(cell_id), 'profile.json')

    def _cell_load_profile(cell_id: str):
        path = _cell_profile_path(cell_id)
        if not os.path.isfile(path): return None
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            return None

    def _cell_save_profile(profile: dict):
        cid = profile['cell_id']
        os.makedirs(_cell_dir(cid), exist_ok=True)
        tmp = _cell_profile_path(cid) + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(profile, f, indent=2)
        os.replace(tmp, _cell_profile_path(cid))

    def _cell_default_profile(name: str) -> dict:
        # LiDAR is rigidly mounted on the robot base — the LiDAR↔base
        # transform is a code constant, not a per-cell value, so the
        # profile no longer carries robot_base_position. The robot
        # base IS the world origin.
        import uuid as _uuid
        ts = datetime.utcnow().isoformat(timespec='seconds') + 'Z'
        return {
            'cell_id':      _uuid.uuid4().hex[:12],
            'name':         name,
            'created_at':   ts,
            'updated_at':   ts,
            'workspace_bounds':    {'x_min': -0.6, 'x_max': 0.6,
                                    'y_min': -0.6, 'y_max': 0.6,
                                    'z_min': 0.0,  'z_max': 0.8},
            'baseline_captured':   False,
            'baseline_point_count': 0,
            'baseline_path':       'baseline_cloud.pcd',
            'calibration':         {'hand_eye_done': False},
            'commissioning_complete': False,
            'steps_completed':     [],
        }

    def _cell_program_count(cell_id: str) -> int:
        try:
            n = 0
            if not os.path.isdir(_PROG_DIR): return 0
            for fn in os.listdir(_PROG_DIR):
                if not fn.endswith('.json') or fn.startswith('_'):
                    continue
                try:
                    with open(os.path.join(_PROG_DIR, fn)) as fp:
                        prog = json.load(fp)
                    if prog.get('cell_id') == cell_id:
                        n += 1
                except Exception:
                    continue
            return n
        except Exception:
            return 0

    @app.get("/api/cells")
    async def api_cells_list():
        idx = _cells_load_index()
        out = []
        for cell_id in idx.get('cells', []):
            prof = _cell_load_profile(cell_id)
            if prof:
                out.append({
                    'cell_id':                prof.get('cell_id'),
                    'name':                   prof.get('name'),
                    'created_at':             prof.get('created_at'),
                    'updated_at':             prof.get('updated_at'),
                    'baseline_captured':      bool(prof.get('baseline_captured')),
                    'baseline_point_count':   int(prof.get('baseline_point_count') or 0),
                    'commissioning_complete': bool(prof.get('commissioning_complete')),
                    'is_active':              prof.get('cell_id') == idx.get('active_cell_id'),
                    'program_count':          _cell_program_count(prof.get('cell_id')),
                })
        return {'active_cell_id': idx.get('active_cell_id'), 'cells': out}

    @app.get("/api/cells/{cell_id}/programs")
    async def api_cells_programs(cell_id: str):
        """List every program tagged with this cell_id. Lightweight
        projection of the existing /api/programs listing — cell membership
        is just the cell_id field on the program JSON."""
        if not _cell_load_profile(cell_id):
            return JSONResponse({'error': 'cell not found'}, status_code=404)
        out = []
        try:
            if os.path.isdir(_PROG_DIR):
                for fn in sorted(os.listdir(_PROG_DIR)):
                    if not fn.endswith('.json') or fn.startswith('_'):
                        continue
                    try:
                        with open(os.path.join(_PROG_DIR, fn)) as fp:
                            prog = json.load(fp)
                    except Exception:
                        continue
                    if prog.get('cell_id') != cell_id:
                        continue
                    out.append({
                        'id':          fn[:-5],
                        'name':        prog.get('name') or fn[:-5],
                        'description': prog.get('description') or '',
                        'steps':       len(prog.get('steps') or []),
                        'tags':        prog.get('tags') or [],
                        'updated':     prog.get('updated') or prog.get('created') or '',
                        'folder':      prog.get('folder'),
                    })
        except Exception:
            pass
        return {'cell_id': cell_id, 'programs': out}

    @app.get("/api/cells/active")
    async def api_cells_active():
        idx = _cells_load_index()
        cid = idx.get('active_cell_id')
        if not cid:
            return {'active_cell_id': None, 'cell': None}
        prof = _cell_load_profile(cid)
        return {'active_cell_id': cid, 'cell': prof}

    @app.post("/api/cells")
    async def api_cells_create(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        name = str(body.get('name') or '').strip() or 'Untitled Cell'
        prof = _cell_default_profile(name)
        with _cell_lock:
            _cell_save_profile(prof)
            idx = _cells_load_index()
            if prof['cell_id'] not in idx['cells']:
                idx['cells'].append(prof['cell_id'])
            if idx.get('active_cell_id') is None:
                idx['active_cell_id'] = prof['cell_id']
            _cells_save_index(idx)
        return {'ok': True, 'cell': prof}

    @app.get("/api/cells/{cell_id}")
    async def api_cells_get(cell_id: str):
        prof = _cell_load_profile(cell_id)
        if not prof:
            return JSONResponse({'error': 'not found'}, status_code=404)
        idx = _cells_load_index()
        prof = dict(prof)
        prof['is_active'] = prof.get('cell_id') == idx.get('active_cell_id')
        return prof

    @app.put("/api/cells/{cell_id}")
    async def api_cells_update(cell_id: str, request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({'error': 'invalid JSON body'}, status_code=400)
        with _cell_lock:
            prof = _cell_load_profile(cell_id)
            if not prof:
                return JSONResponse({'error': 'not found'}, status_code=404)
            for k in ('name', 'workspace_bounds',
                      'calibration', 'steps_completed',
                      'commissioning_complete'):
                if k in body:
                    prof[k] = body[k]
            prof['cell_id']    = cell_id
            prof['updated_at'] = datetime.utcnow().isoformat(timespec='seconds') + 'Z'
            _cell_save_profile(prof)
        return {'ok': True, 'cell': prof}

    @app.delete("/api/cells/{cell_id}")
    async def api_cells_delete(cell_id: str):
        with _cell_lock:
            idx = _cells_load_index()
            if cell_id not in idx.get('cells', []):
                return JSONResponse({'error': 'not found'}, status_code=404)
            idx['cells'] = [c for c in idx['cells'] if c != cell_id]
            if idx.get('active_cell_id') == cell_id:
                idx['active_cell_id'] = idx['cells'][0] if idx['cells'] else None
            _cells_save_index(idx)
            try:
                import shutil
                shutil.rmtree(_cell_dir(cell_id), ignore_errors=True)
            except Exception:
                pass
        with _baseline_lock:
            _baseline_sessions.pop(cell_id, None)
        return {'ok': True, 'active_cell_id': idx.get('active_cell_id')}

    @app.post("/api/cells/{cell_id}/activate")
    async def api_cells_activate(cell_id: str):
        with _cell_lock:
            prof = _cell_load_profile(cell_id)
            if not prof:
                return JSONResponse({'error': 'not found'}, status_code=404)
            idx = _cells_load_index()
            idx['active_cell_id'] = cell_id
            _cells_save_index(idx)
        return {'ok': True, 'active_cell_id': cell_id}

    # Baseline capture — subscribes (read-only) to the latest /lidar/points_dense
    # snapshot accumulated by the dashboard's own LidarNode, accumulates across
    # the requested duration, voxel-downsamples with open3d if available, and
    # writes baseline_cloud.pcd into the cell directory.
    def _baseline_capture_worker(cell_id: str, duration_s: float, voxel_m: float):
        sess = _baseline_sessions.get(cell_id)
        if sess is None: return
        sess['status']   = 'capturing'
        sess['started']  = time.time()
        sess['duration'] = duration_s
        sess['frames']   = 0
        sess['pts_collected'] = 0
        accumulated: list = []
        last_seen_id = None
        deadline = sess['started'] + duration_s
        try:
            while time.time() < deadline:
                with _lidar_lock:
                    pts = _lidar_state.get('pts')
                if pts is not None:
                    seen_id = id(pts)
                    if seen_id != last_seen_id:
                        if _np is not None and isinstance(pts, _np.ndarray):
                            arr = pts.reshape(-1, 3) if pts.ndim == 1 else pts
                            accumulated.append(arr.astype('float32', copy=False))
                            sess['frames'] += 1
                            sess['pts_collected'] += int(arr.shape[0])
                        last_seen_id = seen_id
                sess['progress'] = min(1.0, (time.time() - sess['started']) / max(0.001, duration_s))
                time.sleep(0.1)
            if not accumulated:
                sess['status'] = 'error'
                sess['error']  = 'no LiDAR frames received (is /lidar/points_dense publishing?)'
                return
            sess['status'] = 'saving'
            combined = _np.concatenate(accumulated, axis=0) if _np is not None else None
            final_path = os.path.join(_cell_dir(cell_id), 'baseline_cloud.pcd')
            final_pts  = int(combined.shape[0]) if combined is not None else 0
            voxeled_count = final_pts
            try:
                import open3d as _o3d
                pcd = _o3d.geometry.PointCloud()
                pcd.points = _o3d.utility.Vector3dVector(combined.astype('float64'))
                voxeled = pcd.voxel_down_sample(voxel_m) if voxel_m > 0 else pcd
                voxeled_count = len(voxeled.points)
                os.makedirs(_cell_dir(cell_id), exist_ok=True)
                _o3d.io.write_point_cloud(final_path, voxeled, write_ascii=False)
            except Exception as e:
                # fallback: write ASCII PCD by hand if open3d failed
                try:
                    os.makedirs(_cell_dir(cell_id), exist_ok=True)
                    n = int(combined.shape[0])
                    with open(final_path, 'w') as f:
                        f.write('# .PCD v0.7 - Point Cloud Data file format\n')
                        f.write('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\n')
                        f.write('TYPE F F F\nCOUNT 1 1 1\n')
                        f.write(f'WIDTH {n}\nHEIGHT 1\n')
                        f.write('VIEWPOINT 0 0 0 1 0 0 0\n')
                        f.write(f'POINTS {n}\nDATA ascii\n')
                        for r in combined:
                            f.write(f'{r[0]} {r[1]} {r[2]}\n')
                except Exception as e2:
                    sess['status'] = 'error'
                    sess['error']  = f'PCD write failed: {e}; fallback failed: {e2}'
                    return
            # Update the cell profile with baseline metadata
            with _cell_lock:
                prof = _cell_load_profile(cell_id)
                if prof:
                    prof['baseline_captured']    = True
                    prof['baseline_point_count'] = int(voxeled_count)
                    prof['baseline_path']        = 'baseline_cloud.pcd'
                    prof['updated_at']           = datetime.utcnow().isoformat(timespec='seconds') + 'Z'
                    if 'baseline' not in prof.get('steps_completed', []):
                        prof.setdefault('steps_completed', []).append('baseline')
                    _cell_save_profile(prof)

            # Auto-build static keep-out zones from the freshly-saved
            # baseline so a commissioned (or recaptured) cell already
            # has obstacles in the 3D view + capsule check without the
            # operator having to click "Build zones". Best-effort: any
            # failure (no scipy at runtime, empty cluster set, etc.)
            # gets logged on sess so the wizard can surface it but
            # does NOT block the baseline 'done' status.
            try:
                try:
                    from . import static_zones as _sz
                except ImportError:
                    import static_zones as _sz  # type: ignore
                zr = _sz.build_zones_from_pcd(final_path)
                _sz.save_zones(cell_id, zr)
                sess['zones_built'] = int(zr.get('n_zones', 0))
                sess['zones_built_at'] = zr.get('built_at')
                # Tell collision_monitor to reload — it only re-reads
                # zones for the ACTIVE cell, so this is a no-op for an
                # inactive recapture but cheap either way.
                try:
                    if _ros_node is not None:
                        m = String()
                        m.data = json.dumps({'action': 'reload', 'cell_id': cell_id,
                                             'reason': 'auto_build_after_baseline'})
                        pub = getattr(_ros_node, '_collision_reload_pub', None)
                        if pub is None:
                            pub = _ros_node.create_publisher(String, '/collision/reload', 5)
                            _ros_node._collision_reload_pub = pub
                        pub.publish(m)
                except Exception:
                    pass
            except Exception as ze:
                # Don't block the baseline result — the operator can
                # still hit "Rebuild zones" manually from Configure.
                sess['zones_error'] = str(ze)

            sess['status']    = 'done'
            sess['final_count'] = int(voxeled_count)
        except Exception as e:
            sess['status'] = 'error'
            sess['error']  = f'baseline capture crashed: {e}'

    @app.post("/api/cells/{cell_id}/baseline")
    async def api_cells_baseline_start(cell_id: str, request: Request):
        prof = _cell_load_profile(cell_id)
        if not prof:
            return JSONResponse({'error': 'cell not found'}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        duration_s = float(body.get('duration_s') or 10.0)
        duration_s = max(2.0, min(60.0, duration_s))
        voxel_m    = float(body.get('voxel_m') or 0.01)
        with _baseline_lock:
            existing = _baseline_sessions.get(cell_id)
            if existing and existing.get('status') in ('capturing', 'saving'):
                return JSONResponse({'error': 'capture already in progress',
                                     'session': existing}, status_code=409)
            sess = {'status': 'starting', 'cell_id': cell_id,
                    'duration': duration_s, 'voxel_m': voxel_m,
                    'frames': 0, 'pts_collected': 0, 'progress': 0.0,
                    'final_count': 0, 'started': time.time(), 'error': None}
            _baseline_sessions[cell_id] = sess
        t = threading.Thread(target=_baseline_capture_worker,
                             args=(cell_id, duration_s, voxel_m), daemon=True)
        t.start()
        return {'ok': True, 'session': sess}

    @app.get("/api/cells/{cell_id}/baseline/cloud")
    async def api_cells_baseline_cloud(cell_id: str, max_points: int = 50000):
        """Return the saved baseline point cloud for in-browser rendering.
        Loaded from baseline_cloud.pcd, voxel-downsampled to keep the
        response small enough for the SPA's PointCloud component. The
        payload uses the same {n, p:[x0,y0,z0,...]} shape that the
        live /ws/lidar broadcast already speaks."""
        prof = _cell_load_profile(cell_id)
        if not prof:
            return JSONResponse({'error': 'cell not found'}, status_code=404)
        pcd_name = prof.get('baseline_path') or 'baseline_cloud.pcd'
        path = os.path.join(_cell_dir(cell_id), pcd_name)
        if not os.path.isfile(path):
            return JSONResponse({'error': 'baseline not captured',
                                 'baseline_captured': False}, status_code=404)
        max_points = max(1000, min(int(max_points), 200000))
        try:
            import open3d as _o3d
            pcd = _o3d.io.read_point_cloud(path)
            pts = _np.asarray(pcd.points, dtype='float32') if _np is not None else None
            if pts is None or pts.size == 0:
                return {'cell_id': cell_id, 'n': 0, 'p': [], 'source': 'baseline_cloud.pcd'}
            if pts.shape[0] > max_points:
                voxel = float(prof.get('baseline_voxel_m') or 0.01)
                tries = 0
                while pts.shape[0] > max_points and tries < 6:
                    voxel *= 1.6
                    pcd2 = _o3d.geometry.PointCloud()
                    pcd2.points = _o3d.utility.Vector3dVector(pts.astype('float64'))
                    pcd2 = pcd2.voxel_down_sample(voxel)
                    pts = _np.asarray(pcd2.points, dtype='float32')
                    tries += 1
            return {
                'cell_id':           cell_id,
                'n':                 int(pts.shape[0]),
                'p':                 pts.flatten().tolist(),
                'total_in_file':     int(prof.get('baseline_point_count') or 0),
                'captured_at':       prof.get('updated_at'),
                'source':            'baseline_cloud.pcd',
            }
        except Exception as e:
            return JSONResponse({'error': f'pcd read failed: {e}'}, status_code=500)

    @app.get("/api/cells/{cell_id}/baseline/status")
    async def api_cells_baseline_status(cell_id: str):
        sess = _baseline_sessions.get(cell_id)
        if sess is None:
            return {'status': 'idle', 'cell_id': cell_id}
        out = dict(sess)
        if sess.get('started'):
            out['elapsed_s'] = round(time.time() - sess['started'], 2)
        return out

    # ── Static keep-out zones (built from the cell's saved baseline) ──
    # Reuses the live LiDAR clustering / OBB code; see static_zones.py.

    def _import_static_zones():
        try:
            from . import static_zones as _sz  # type: ignore
        except ImportError:
            import static_zones as _sz  # type: ignore
        return _sz

    @app.post("/api/cells/{cell_id}/collision_zones/build")
    async def api_cells_zones_build(cell_id: str, request: Request):
        """Cluster the cell's baseline cloud into static keep-out
        boxes and persist them. Body (optional JSON) lets the
        operator override the default cluster tolerance / margin /
        thresholds; omitted fields fall back to DEFAULTS."""
        _sz = _import_static_zones()
        pcd_path = _sz.baseline_pcd_path(cell_id)
        if not os.path.isfile(pcd_path):
            return JSONResponse({
                'ok': False,
                'reason': 'no_baseline',
                'message': 'This cell has no saved baseline. Capture one in the wizard first.',
            }, status_code=400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        params = body if isinstance(body, dict) else {}
        try:
            result = _sz.build_zones_from_pcd(pcd_path, params=params)
        except Exception as e:
            return JSONResponse({
                'ok': False, 'reason': 'build_failed', 'message': str(e),
            }, status_code=500)
        try:
            _sz.save_zones(cell_id, result)
        except Exception as e:
            return JSONResponse({
                'ok': False, 'reason': 'save_failed', 'message': str(e),
            }, status_code=500)
        # Notify the collision_monitor so the new boxes start flowing
        # through /collision/objects on the next tick. Best-effort —
        # if the publisher isn't wired we still saved the file.
        try:
            if _ros_node is not None:
                m = String()
                m.data = json.dumps({'action': 'reload', 'cell_id': cell_id})
                # Lazily create the publisher on first use; cached on
                # the node so subsequent reloads reuse it.
                pub = getattr(_ros_node, '_collision_reload_pub', None)
                if pub is None:
                    pub = _ros_node.create_publisher(String, '/collision/reload', 5)
                    _ros_node._collision_reload_pub = pub
                pub.publish(m)
        except Exception:
            pass
        return {
            'ok':         True,
            'cell_id':    cell_id,
            'n_zones':    result.get('n_zones', 0),
            'built_at':   result.get('built_at'),
            'elapsed_s':  result.get('elapsed_s'),
            'diag':       {k: v for k, v in result.items()
                           if k not in ('zones', 'params')},
        }

    @app.get("/api/cells/{cell_id}/collision_zones")
    async def api_cells_zones_get(cell_id: str):
        _sz = _import_static_zones()
        data = _sz.load_zones(cell_id)
        if data is None:
            return {'ok': True, 'cell_id': cell_id, 'has_zones': False,
                    'zones': []}
        data.setdefault('ok', True)
        data['has_zones'] = True
        return data

    @app.delete("/api/cells/{cell_id}/collision_zones")
    async def api_cells_zones_clear(cell_id: str):
        _sz = _import_static_zones()
        removed = _sz.clear_zones(cell_id)
        try:
            if _ros_node is not None:
                m = String()
                m.data = json.dumps({'action': 'reload', 'cell_id': cell_id})
                pub = getattr(_ros_node, '_collision_reload_pub', None)
                if pub is None:
                    pub = _ros_node.create_publisher(String, '/collision/reload', 5)
                    _ros_node._collision_reload_pub = pub
                pub.publish(m)
        except Exception:
            pass
        return {'ok': True, 'cell_id': cell_id, 'removed': removed}

    @app.get("/api/collision/static_zones")
    async def api_collision_static_zones():
        """Return the active cell's persisted static zones. Used by
        the 3D viewer + diagnostics so they can fall back to the
        on-disk source when collision_monitor's /collision/objects
        feed isn't yet streaming static boxes (e.g. headless dev)."""
        _sz = _import_static_zones()
        idx = _cells_load_index()
        cid = idx.get('active_cell_id')
        if not cid:
            return {'ok': True, 'cell_id': None, 'has_zones': False, 'zones': []}
        data = _sz.load_zones(cid)
        if data is None:
            return {'ok': True, 'cell_id': cid, 'has_zones': False, 'zones': []}
        return {
            'ok':       True,
            'cell_id':  cid,
            'has_zones': True,
            'built_at': data.get('built_at'),
            'n_zones':  data.get('n_zones', len(data.get('zones', []))),
            'zones':    data.get('zones', []),
        }

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith(("api/", "cmd/", "ws/", "stream/", "health", "assets/")):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = os.path.join(_static, full_path)
        if os.path.isfile(candidate):
            return FileResponse(candidate)
        # If the request looks like an asset (has a file extension on
        # its last segment) AND the file doesn't exist, return 404
        # instead of falling through to index.html. Otherwise the
        # client can't distinguish "this file exists" from "the SPA
        # absorbed my missing-asset probe" — which broke the
        # ArmViewer3D links.json check.
        last = full_path.rsplit('/', 1)[-1]
        if '.' in last:
            return JSONResponse({"detail": "Not found"}, status_code=404)
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

    # ── TLS configuration ─────────────────────────────────────────
    # The dashboard SHOULD serve HTTPS so browsers grant the
    # getUserMedia / MediaRecorder permissions the Program-from-
    # Demonstration recorder relies on (Chrome and Firefox refuse
    # those APIs on plain HTTP for LAN IPs).
    #
    # Behaviour:
    #   - If both cert + key files exist at the configured paths,
    #     uvicorn binds with TLS — serves https://… on the same
    #     port (default 8080). Mixed-content: any WebSocket the
    #     frontend opens auto-upgrades to wss:// because the page
    #     origin is https.
    #   - If either file is missing, we DON'T hard-fail. The dashboard
    #     comes up on plain HTTP with a loud warning so the operator
    #     still has the UI; live recording in the wizard simply won't
    #     work until the cert is generated (scripts/generate_dashboard_cert.sh).
    #
    # Override locations with env vars for non-Jetson dev machines.
    ssl_certfile = os.environ.get(
        'ROBOAI_DASHBOARD_CERT', '/opt/cobot/certs/dashboard_cert.pem')
    ssl_keyfile  = os.environ.get(
        'ROBOAI_DASHBOARD_KEY',  '/opt/cobot/certs/dashboard_key.pem')
    port         = int(os.environ.get('ROBOAI_DASHBOARD_PORT', '8080'))
    uvicorn_kwargs = {
        'host':      '0.0.0.0',
        'port':      port,
        'log_level': 'warning',
    }
    if os.path.isfile(ssl_certfile) and os.path.isfile(ssl_keyfile):
        uvicorn_kwargs['ssl_certfile'] = ssl_certfile
        uvicorn_kwargs['ssl_keyfile']  = ssl_keyfile
        print(f'[dashboard] HTTPS enabled on :{port} '
              f'(cert={ssl_certfile})')
    else:
        print(f'[dashboard] WARNING: TLS cert not found at {ssl_certfile}; '
              f'serving plain HTTP on :{port}. '
              f'Live recording (getUserMedia) will be blocked by the browser '
              f'over the LAN. Generate the cert with: '
              f'sudo scripts/generate_dashboard_cert.sh')

    try:
        uvicorn.run(app, **uvicorn_kwargs)
    except KeyboardInterrupt:
        pass
    finally:
        if _ros_node and RCLPY_AVAILABLE:
            _ros_node.destroy_node()
            rclpy.shutdown()


if __name__ == "__main__":
    main()
