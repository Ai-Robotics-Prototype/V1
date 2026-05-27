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
    from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
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
_THIS_DIR = Path(__file__).parent
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
    "scene_graph": {"objects": []},
    "gripper": {"state": "open", "position_mm": 85.0},
    "program": {
        "steps": [
            {"id": 1, "type": "home",    "label": "Move to home",    "detail": "J: [0,−90,0,−90,0,0]°",     "status": "done"},
            {"id": 2, "type": "gripper", "label": "Open gripper",    "detail": "Width: 85 mm · Speed: 80%", "status": "active"},
            {"id": 3, "type": "move",    "label": "Approach object", "detail": "Target: auto · +150 mm Z",  "status": "pending"},
            {"id": 4, "type": "gripper", "label": "Pick & close",    "detail": "Descend 130 mm · close",    "status": "pending"},
            {"id": 5, "type": "move",    "label": "Place at target", "detail": "X: 0.30 Y: −0.20 Z: 0.40", "status": "pending"},
        ]
    },
}

# Latest JPEG bytes per camera (None = no real frame yet)
_cam_frames: dict = {0: None, 1: None}
_cam_lock = threading.Lock()

# Latest annotated frame from detector
_annotated_frame: bytes = None
_annotated_lock = threading.Lock()

# Latest parsed LiDAR scan
_lidar_state: dict = {"pts": [], "live": False}
_lidar_lock = threading.Lock()

# WebSocket client queues
_state_clients: dict = {}
_lidar_clients: dict = {}
_ws_lock = threading.Lock()

# Program simulation state
_step_start_time: float = 0.0
_going_home: bool = False

# ---------------------------------------------------------------------------
# PIL helpers
# ---------------------------------------------------------------------------

def _ros_image_to_jpeg(msg) -> bytes:
    if not PIL_AVAILABLE:
        return b""
    try:
        enc = msg.encoding
        raw = bytes(msg.data)
        if enc == "rgb8":
            img = PilImage.frombytes("RGB", (msg.width, msg.height), raw)
        elif enc == "bgr8":
            img = PilImage.frombytes("RGB", (msg.width, msg.height), raw)
            r, g, b = img.split()
            img = PilImage.merge("RGB", (b, g, r))
        elif enc in ("mono8", "8UC1"):
            img = PilImage.frombytes("L", (msg.width, msg.height), raw).convert("RGB")
        else:
            return b""
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75)
        return buf.getvalue()
    except Exception:
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

def _parse_pointcloud2(msg, max_points: int = 4096) -> list:
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
        objs.append({
            "id": str(uid),
            "class_name": obj.get("class_id") or obj.get("class_name") or obj.get("class", ""),
            "score": obj.get("confidence", 0.0),
            "position": [round(float(p), 3) for p in position],
            "last_seen_ms": int(obj.get("age_s", 0) * 1000),
        })
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
        # Real Detection3DArray from detector_node
        try:
            from vision_msgs.msg import Detection3DArray
            self.create_subscription(Detection3DArray, "/perception/detections_3d",
                                     self._on_detections_3d, 5)
            self.get_logger().info("Detection3DArray subscription ready")
        except ImportError:
            self.get_logger().warn("vision_msgs not available — detection3d subscription skipped")
        self.create_subscription(JointState, "/joint_states",            self._on_joint_states,   10)

        # Annotated image from detector
        self.create_subscription(Image, "/perception/annotated_image",
                                 self._on_annotated, 2)

        # Cameras (small queue — only latest frame matters)
        self.create_subscription(Image, "/cam0/color/image_raw",
                                 lambda m: self._on_camera(0, m), 2)
        self.create_subscription(Image, "/cam1/color/image_raw",
                                 lambda m: self._on_camera(1, m), 2)

        # LiDAR — prefer fused cloud; fall back to raw
        self.create_subscription(PointCloud2, "/perception/fused_cloud",
                                 self._on_lidar_fused, 2)
        self.create_subscription(PointCloud2, "/lidar/points",
                                 self._on_lidar_raw, 2)

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

    def _on_detections_3d(self, msg):
        """Parse Detection3DArray from detector_node into dashboard format."""
        dets = []
        for det in msg.detections:
            if not det.results:
                continue
            result = det.results[0]
            class_name = str(result.hypothesis.class_id)
            score = float(result.hypothesis.score)
            pos = det.bbox.center.position
            size = det.bbox.size
            dets.append({
                "id":         str(id(det)),
                "class_name": class_name,
                "score":      round(score, 3),
                "x":          round(pos.x, 3),
                "y":          round(pos.y, 3),
                "z":          round(pos.z, 3),
                "w":          round(size.x, 3),
                "h":          round(size.y, 3),
            })
        with _state_lock:
            STATE["detections"] = dets

    def _on_annotated(self, msg):
        jpeg = _ros_image_to_jpeg(msg)
        if jpeg:
            global _annotated_frame
            with _annotated_lock:
                _annotated_frame = jpeg

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

    # ---- LiDAR ----

    def _on_lidar_fused(self, msg):
        pts = _parse_pointcloud2(msg)
        if pts:
            with _lidar_lock:
                _lidar_state["pts"]  = pts
                _lidar_state["live"] = True
            self._have_fused = True

    def _on_lidar_raw(self, msg):
        if self._have_fused:
            return
        pts = _parse_pointcloud2(msg)
        if pts:
            with _lidar_lock:
                _lidar_state["pts"]  = pts
                _lidar_state["live"] = True

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
        lidar_hz  = 15
        state_dt  = 1.0 / state_hz
        lidar_dt  = 1.0 / lidar_hz
        next_state = time.time()
        next_lidar = time.time()

        while True:
            now = time.time()

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
                    pts  = list(_lidar_state["pts"])
                    live = _lidar_state["live"]
                if not pts:
                    pts  = _sim_lidar_frame(now - _START_TIME)
                    live = False
                lidar_txt = json.dumps({"points": pts, "live": live,
                                        "count": len(pts), "t": now * 1000})
                with _ws_lock:
                    clients = list(_lidar_clients.items())
                for ws, q in clients:
                    if q.qsize() < 2:
                        try:
                            await q.put(lidar_txt)
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
                txt = await q.get()
                await websocket.send_text(txt)
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _lidar_clients.pop(websocket, None)

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
        return StreamingResponse(_mjpeg_gen(0),
                                  media_type="multipart/x-mixed-replace; boundary=frame")

    @app.get("/stream/cam1")
    async def stream_cam1():
        return StreamingResponse(_mjpeg_gen(1),
                                  media_type="multipart/x-mixed-replace; boundary=frame")

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

    # ------------------------------------------------------------------
    # Info endpoints
    # ------------------------------------------------------------------

    @app.get("/health")
    async def health():
        with _ws_lock:
            ns = len(_state_clients)
            nl = len(_lidar_clients)
        with _cam_lock:
            have_cam0 = _cam_frames[0] is not None
            have_cam1 = _cam_frames[1] is not None
        with _lidar_lock:
            lidar_live = _lidar_state["live"]
            lidar_pts  = len(_lidar_state["pts"])
        return {
            "status": "ok", "ros": RCLPY_AVAILABLE, "mock": False,
            "uptime_s": round(time.time() - _START_TIME, 1),
            "clients_state": ns, "clients_lidar": nl,
            "cam0_live": have_cam0, "cam1_live": have_cam1,
            "lidar_live": lidar_live, "lidar_pts": lidar_pts,
        }

    @app.get("/api/state")
    async def api_state():
        with _state_lock:
            return copy.deepcopy(STATE)

    @app.get("/api/config")
    async def api_config():
        return {
            "robot": {"brand": "generic", "dof": 6, "payload_kg": 5.0, "reach_mm": 850},
            "cameras": [{"id": 0, "topic": "/cam0/color/image_raw", "fps": 15},
                        {"id": 1, "topic": "/cam1/color/image_raw", "fps": 15}],
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

    @app.get("/")
    async def serve_index():
        idx = os.path.join(_static, "index.html")
        if os.path.isfile(idx):
            return FileResponse(idx)
        return JSONResponse({"detail": "Frontend not built — run: cd frontend && npm run build"}, status_code=404)

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith(("api/", "cmd/", "ws/", "stream/", "health", "assets/")):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = os.path.join(_static, full_path)
        if os.path.isfile(candidate):
            return FileResponse(candidate)
        idx = os.path.join(_static, "index.html")
        if os.path.isfile(idx):
            return FileResponse(idx)
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
