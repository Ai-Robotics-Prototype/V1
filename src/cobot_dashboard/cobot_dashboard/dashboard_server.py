"""
RoboAi Dashboard Server v2 — Commercial production build.
Works with ROS2 on Jetson and standalone (simulation mode) for development.
"""
import asyncio, collections, json, math, os, random, struct, threading, time
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    import rclpy
    from rclpy.node import Node
    from std_msgs.msg import String, Bool, Float32
    from sensor_msgs.msg import JointState, PointCloud2, Image
    from geometry_msgs.msg import PoseStamped
    ROS2 = True
except ImportError:
    ROS2 = False
    Node = object

try:
    from livox_ros_driver2.msg import CustomMsg as LivoxCustomMsg
    LIVOX = True
except ImportError:
    LIVOX = False

try:
    import numpy as np
    from PIL import Image as PILImage
    import io as _io
    IMAGING = True
except Exception:
    IMAGING = False

THIS_DIR     = os.path.dirname(os.path.abspath(__file__))
DIST_DIR     = os.path.normpath(os.path.join(THIS_DIR, '..', 'frontend', 'dist'))
INDEX_HTML   = os.path.join(DIST_DIR, 'index.html')
PROGRAMS_DIR = '/opt/cobot/programs'
POINTS_FILE  = '/opt/cobot/calibration/saved_points.json'
os.makedirs(PROGRAMS_DIR, exist_ok=True)
os.makedirs(os.path.dirname(POINTS_FILE), exist_ok=True)

JOINT_LIMITS = [
    (-3.14159,  3.14159), (-3.14159, 0.0),
    (-2.35619,  2.35619), (-3.14159, 3.14159),
    (-2.09440,  2.09440), (-6.28318, 6.28318),
]
HOME        = [0.0, -1.5708, 0.0, -1.5708, 0.0, 0.0]
MAX_TORQUES = [150, 150, 150, 28, 28, 28]

ERROR_MESSAGES = {
    0: 'No fault',           1: 'Joint limit exceeded',
    2: 'Collision detected', 3: 'Communication timeout',
    4: 'Overheat',           5: 'Power fault',
}


def _load_points():
    try:
        if os.path.exists(POINTS_FILE):
            with open(POINTS_FILE) as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
            # Migrate old dict format {pick, place, waypoints} → flat list
            pts = []
            if isinstance(data, dict):
                for key in ('pick', 'place'):
                    v = data.get(key)
                    if v and isinstance(v, dict):
                        pts.append({'name': v.get('name', key), 'joint_positions': [], 'tcp_pose': v.get('pose'), 'created_at': time.time()})
                for wp in data.get('waypoints', []):
                    pts.append({'name': wp.get('name', 'wp'), 'joint_positions': [], 'tcp_pose': wp.get('pose'), 'created_at': time.time()})
            return pts
    except Exception:
        pass
    return []


def _save_points(pts):
    try:
        with open(POINTS_FILE, 'w') as f:
            json.dump(pts, f, indent=2)
    except Exception:
        pass


def _default_state():
    return {
        't': 0,
        'safety': {
            'zone': 'GREEN', 'speed_scale': 1.0,
            'estop': False,  'human_proximity': 2.4,
        },
        'joints': {
            'names':      ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'],
            'positions':  list(HOME),
            'velocities': [0.0] * 6,
            'torques':    [0.0] * 6,
        },
        'task': {
            'state': 'IDLE', 'target': None,
            'program_step': 0, 'program_total': 0,
            'running': False, 'paused': False,
            'task_count': 0,  'success_count': 0,
        },
        'tcp_pose':    [0.0, 0.0, 0.5, 0.0, 0.0, 0.0],
        'detections':  [],
        'scene_graph': {'objects': []},
        'gripper':     {'state': 'open', 'position_mm': 85.0},
        'program':     {'steps': [], 'name': 'Program 1'},
        'robot': {
            'connected': False, 'brand': 'generic',
            'ip': '192.168.1.10', 'error_code': 0, 'mode': 'idle',
        },
        'saved_points': _load_points(),
        'system': {
            'ros2': ROS2, 'mock': not ROS2,
            'uptime_s': 0, 'start_time': time.time(),
        },
        'speed_override': 100,
        'perception': {
            'fps': 0.0, 'det_count': 0, 'inference_ms': 0.0,
            'annotated_active': False, 'classes': {}, 'tracker_count': 0,
        },
        'language': {
            'last_text': '', 'last_response': '', 'listening': False,
            'model_name': 'llama3.1:8b',
        },
        'fleet': {
            'enabled': False, 'upload_hour': 2, 'last_upload': None, 'logs_mb': 0.0,
        },
    }


STATE      = _default_state()
STATE_LOCK = threading.Lock()
START_TIME = time.time()
_state_qs: list = []
_lidar_qs: list = []
_ws_lock         = threading.Lock()
_event_log       = collections.deque(maxlen=500)
_event_loop      = None
_sim_t           = 0.0
_cam_frames      = {0: None, 1: None}
_cam_lock        = threading.Lock()
_annotated_frame = None
_lidar_pts: list = []
_lidar_lock      = threading.Lock()


def log_event(etype, detail, user='operator'):
    _event_log.appendleft({
        'ts': time.time(), 'time': time.strftime('%H:%M:%S'),
        'type': etype, 'detail': detail, 'user': user,
    })


def _sim_tick():
    global _sim_t
    _sim_t += 0.04
    with STATE_LOCK:
        if STATE['safety']['estop']:
            return
        prox = 1.2 + math.sin(_sim_t / 8.0) * 1.0
        STATE['safety']['human_proximity'] = round(prox, 3)
        ovr = STATE['speed_override'] / 100.0
        if prox > 1.2:
            STATE['safety']['zone'] = 'GREEN'
            STATE['safety']['speed_scale'] = round(1.0 * ovr, 3)
        elif prox > 0.6:
            STATE['safety']['zone'] = 'YELLOW'
            STATE['safety']['speed_scale'] = round(0.25 * ovr, 3)
        else:
            STATE['safety']['zone'] = 'RED'
            STATE['safety']['speed_scale'] = 0.0
        if not STATE['task']['running']:
            for i in range(6):
                b = HOME[i]
                d = math.sin(_sim_t * (0.3 + i * 0.1)) * 0.04
                lo, hi = JOINT_LIMITS[i]
                STATE['joints']['positions'][i] = round(max(lo, min(hi, b + d)), 4)
            STATE['joints']['torques'] = [
                round(math.sin(_sim_t * (i + 1)) * 5, 2) for i in range(6)
            ]
        j = STATE['joints']['positions']
        STATE['tcp_pose'] = [
            round(math.cos(j[0]) * (0.42 * math.cos(j[1]) + 0.38 * math.cos(j[1] + j[2])), 3),
            round(0.16 + 0.42 * (-math.sin(j[1])) + 0.38 * (-math.sin(j[1] + j[2])), 3),
            round(math.sin(j[0]) * (0.42 * math.cos(j[1]) + 0.38 * math.cos(j[1] + j[2])), 3),
            0.0, 0.0, 0.0,
        ]
        STATE['system']['uptime_s'] = round(time.time() - START_TIME, 1)
        STATE['t'] = int(time.time() * 1000)


app = FastAPI(title='RoboAi Dashboard', version='2.0.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'], allow_methods=['*'], allow_headers=['*'],
)


# ── Pydantic models ────────────────────────────────────────────────────────────
class EstopCmd(BaseModel):
    active: bool
    override: bool = False

class TaskCmd(BaseModel):
    command: str

class JogCmd(BaseModel):
    joint: int
    delta: float

class JointsCmd(BaseModel):
    positions: list

class GripperCmd(BaseModel):
    action: str
    width_mm: Optional[float] = None

class VoiceCmd(BaseModel):
    text: str

class TeachPointCmd(BaseModel):
    name: str
    joint_positions: list
    tcp_pose: Optional[dict] = None

class GoToPointCmd(BaseModel):
    name: str

class SpeedCmd(BaseModel):
    percent: int

class ProgramSaveCmd(BaseModel):
    name: str
    steps: list


# ── Internal helpers ──────────────────────────────────────────────────────────
def _push_to_queues(qs, payload):
    with _ws_lock:
        queues = list(qs)
    if _event_loop:
        for q in queues:
            try:
                _event_loop.call_soon_threadsafe(q.put_nowait, payload)
            except Exception:
                pass


def _encode_jpeg(rgb_bytes, w, h):
    buf = _io.BytesIO()
    PILImage.frombytes('RGB', (w, h), rgb_bytes).save(buf, 'JPEG', quality=75)
    return buf.getvalue()


def _gen_placeholder_frame(cam_id):
    if not IMAGING:
        return None
    arr = np.full((480, 640, 3), (18, 13, 10), dtype=np.uint8)
    img = PILImage.fromarray(arr, 'RGB')
    buf = _io.BytesIO()
    img.save(buf, 'JPEG', quality=60)
    return buf.getvalue()


async def _mjpeg(cam_id):
    while True:
        with _cam_lock:
            frame_data = _cam_frames.get(cam_id)
        if frame_data is not None:
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n'
                   + frame_data + b'\r\n')
        else:
            data = _gen_placeholder_frame(cam_id)
            if data:
                yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + data + b'\r\n'
        await asyncio.sleep(1 / 15)


async def _mjpeg_annotated():
    while True:
        with _cam_lock:
            frame_data = _annotated_frame
        if frame_data is not None:
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n'
                   + frame_data + b'\r\n')
        else:
            # Fall back to cam0 raw
            with _cam_lock:
                raw = _cam_frames.get(0)
            data = raw or _gen_placeholder_frame(0)
            if data:
                yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + data + b'\r\n'
        await asyncio.sleep(1 / 15)


def _sim_lidar():
    pts = []
    for _ in range(2800):
        a = random.uniform(0, math.pi * 2)
        r = 0.3 + random.random() ** 0.6 * 2.2
        pts.append({
            'x': round(r * math.cos(a), 3),
            'y': round(random.uniform(0, 0.05), 3),
            'z': round(r * math.sin(a), 3),
            'i': round(random.random(), 2),
        })
    return pts


async def _sim_broadcast():
    while True:
        _sim_tick()
        with STATE_LOCK:
            payload = json.dumps(STATE)
        with _ws_lock:
            qs = list(_state_qs)
        for q in qs:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except Exception:
                    pass
        await asyncio.sleep(0.04)


# ── ROS2 node (skipped when ROS2 unavailable) ─────────────────────────────────
_ros_node = None

if ROS2:
    class DashboardNode(Node):
        def __init__(self):
            super().__init__('dashboard_server')
            for topic, mtype, cb in [
                ('/safety/status',       String,     self._on_safety),
                ('/task/status',         String,     self._on_task),
                ('/perception/scene_graph', String,  self._on_scene),
                ('/perception/detections',  String,  self._on_detections),
                ('/language/response',   String,     self._on_lang_response),
            ]:
                self.create_subscription(mtype, topic, cb, 10)
            self._lang_pub = self.create_publisher(String, '/language/text_command', 10)
            self.create_subscription(JointState, '/joint_states',      self._on_joints,  10)
            self.create_subscription(Bool,        '/safety/estop',      self._on_estop,   10)
            self.create_subscription(Float32,     '/safety/speed_scale',self._on_speed,   10)
            self.create_subscription(PointCloud2, '/perception/fused_cloud', self._on_lidar, 10)
            self.create_subscription(PointCloud2, '/ouster/points',          self._on_lidar, 10)
            self.create_subscription(PointCloud2, '/lidar/points',           self._on_lidar, 10)
            if LIVOX:
                self.create_subscription(LivoxCustomMsg, '/livox/lidar',
                                         self._on_livox, 10)
            self.create_subscription(Image, '/cam0/cam0/color/image_raw',
                                     lambda msg: self._on_camera(msg, 0), 10)
            self.create_subscription(Image, '/cam1/cam1/color/image_raw',
                                     lambda msg: self._on_camera(msg, 1), 10)
            self.create_subscription(Image, '/perception/annotated_image',
                                     self._on_annotated, 5)
            self.task_pub  = self.create_publisher(String, '/task/command', 10)
            self.estop_pub = self.create_publisher(Bool,   '/safety/estop', 10)
            self.create_timer(0.04, self._broadcast)
            self.get_logger().info('DashboardNode running on :8080')

        def _on_safety(self, msg):
            try:
                d = json.loads(msg.data)
                with STATE_LOCK:
                    s = STATE['safety']
                    s.update({k: d[k] for k in ['zone', 'speed_scale', 'estop'] if k in d})
                    if 'proximity_m' in d:
                        s['human_proximity'] = d['proximity_m']
            except Exception:
                pass

        def _on_task(self, msg):
            try:
                d = json.loads(msg.data)
                with STATE_LOCK:
                    t = STATE['task']
                    for k in ['state', 'target', 'task_count', 'success_count']:
                        if k in d: t[k] = d[k]
                    t['running'] = d.get('state') == 'RUNNING'
                    t['paused']  = d.get('state') == 'PAUSED'
            except Exception:
                pass

        def _on_scene(self, msg):
            try:
                raw = json.loads(msg.data)
                # scene_graph_node publishes a dict keyed by track_id — convert to list
                if isinstance(raw, dict) and 'objects' not in raw:
                    obj_list = []
                    for track_id, obj in raw.items():
                        pos = obj.get('position', {})
                        if isinstance(pos, dict):
                            pos_arr = [round(pos.get('x', 0.0), 3),
                                       round(pos.get('y', 0.0), 3),
                                       round(pos.get('z', 0.0), 3)]
                        elif isinstance(pos, (list, tuple)) and len(pos) >= 3:
                            pos_arr = [round(float(pos[i]), 3) for i in range(3)]
                        else:
                            pos_arr = [0.0, 0.0, 0.0]
                        obj_list.append({
                            'id':        track_id,
                            'class_name': obj.get('class_id', obj.get('class_name', 'object')),
                            'score':     round(obj.get('confidence', obj.get('score', 1.0)), 3),
                            'position':  pos_arr,
                            'last_seen': obj.get('last_seen', 0.0),
                            'pickable':  obj.get('class_id', '') not in ('person',),
                        })
                    with STATE_LOCK:
                        STATE['scene_graph'] = {'objects': obj_list}
                        STATE['perception']['tracker_count'] = len(obj_list)
                else:
                    objects = raw.get('objects', []) if isinstance(raw, dict) else []
                    with STATE_LOCK:
                        STATE['scene_graph'] = {'objects': objects}
                        STATE['perception']['tracker_count'] = len(objects)
            except Exception:
                pass

        def _on_detections(self, msg):
            try:
                data = json.loads(msg.data)
                dets = data.get('detections', [])
                classes = {}
                for d in dets:
                    cn = d.get('class_name', 'unknown')
                    classes[cn] = classes.get(cn, 0) + 1
                with STATE_LOCK:
                    STATE['detections'] = dets
                    STATE['perception']['det_count'] = len(dets)
                    STATE['perception']['classes']   = classes
                    if data.get('inference_ms'):
                        STATE['perception']['inference_ms'] = data['inference_ms']
                    if data.get('fps'):
                        STATE['perception']['fps'] = data['fps']
            except Exception:
                pass

        def _on_lang_response(self, msg):
            with STATE_LOCK:
                STATE['language']['last_response'] = msg.data
                STATE['language']['listening'] = False

        def _on_joints(self, msg):
            with STATE_LOCK:
                j = STATE['joints']
                j['names']     = list(msg.name)
                j['positions'] = list(msg.position)
                if msg.velocity: j['velocities'] = list(msg.velocity)
                if msg.effort:   j['torques']    = list(msg.effort)
                STATE['robot']['connected'] = True

        def _on_estop(self, msg):
            with STATE_LOCK:
                STATE['safety']['estop'] = msg.data
                if msg.data: STATE['safety']['speed_scale'] = 0.0

        def _on_speed(self, msg):
            with STATE_LOCK:
                STATE['safety']['speed_scale'] = msg.data

        def _on_camera(self, msg, cam_id):
            if not IMAGING:
                return
            try:
                enc  = msg.encoding
                h, w = msg.height, msg.width
                raw  = bytes(msg.data)
                if enc == 'rgb8':
                    jpeg = _encode_jpeg(raw, w, h)
                elif enc == 'bgr8':
                    arr  = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
                    jpeg = _encode_jpeg(arr[:, :, ::-1].tobytes(), w, h)
                elif enc == 'mono8':
                    arr  = np.frombuffer(raw, dtype=np.uint8).reshape(h, w)
                    rgb  = np.stack([arr, arr, arr], axis=2).tobytes()
                    jpeg = _encode_jpeg(rgb, w, h)
                else:
                    return
                with _cam_lock:
                    _cam_frames[cam_id] = jpeg
            except Exception:
                pass

        def _on_annotated(self, msg):
            global _annotated_frame
            if not IMAGING:
                return
            try:
                enc = msg.encoding
                raw = bytes(msg.data)
                h, w = msg.height, msg.width
                if enc == 'rgb8':
                    jpeg = _encode_jpeg(raw, w, h)
                elif enc == 'bgr8':
                    arr  = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
                    jpeg = _encode_jpeg(arr[:, :, ::-1].tobytes(), w, h)
                else:
                    return
                with _cam_lock:
                    _annotated_frame = jpeg
                with STATE_LOCK:
                    STATE['perception']['annotated_active'] = True
            except Exception:
                pass

        def _on_lidar(self, msg):
            global _lidar_pts
            pts = _pc2_to_list(msg)
            with _lidar_lock:
                _lidar_pts = pts
            # Only push to WS clients when we have real data (motor spinning)
            if len(pts) >= 50:
                payload = json.dumps({'points': pts})
                _push_to_queues(_lidar_qs, payload)

        def _on_livox(self, msg):
            global _lidar_pts
            try:
                pts = []
                for p in msg.points:
                    if p.x == 0.0 and p.y == 0.0 and p.z == 0.0:
                        continue
                    pts.append([round(float(p.x), 3),
                                 round(float(p.y), 3),
                                 round(float(p.z), 3),
                                 float(p.reflectivity) / 255.0])
                if len(pts) > 8000:
                    step = len(pts) // 8000
                    pts  = pts[::step]
                with _lidar_lock:
                    _lidar_pts = pts
                payload = json.dumps({'points': pts})
                _push_to_queues(_lidar_qs, payload)
            except Exception:
                pass

        def _broadcast(self):
            with STATE_LOCK:
                STATE['t'] = int(time.time() * 1000)
                payload = json.dumps(STATE)
            _push_to_queues(_state_qs, payload)

        def pub_estop(self, v):
            msg = Bool(); msg.data = v
            self.estop_pub.publish(msg)

        def pub_task(self, data):
            msg = String(); msg.data = json.dumps(data)
            self.task_pub.publish(msg)


def _pc2_to_list(msg, max_pts=8000):
    fo = {f.name: f.offset for f in msg.fields}
    ox = fo.get('x', 0)
    oy = fo.get('y', 4)
    oz = fo.get('z', 8)
    oi = fo.get('intensity', fo.get('i', fo.get('signal', 12)))
    pts, step, data = [], msg.point_step, msg.data
    total = len(data) // step
    for i in random.sample(range(total), min(max_pts, total)):
        try:
            x = struct.unpack_from('f', data, i * step + ox)[0]
            y = struct.unpack_from('f', data, i * step + oy)[0]
            z = struct.unpack_from('f', data, i * step + oz)[0]
            inten = struct.unpack_from('f', data, i * step + oi)[0]
            if not all(math.isfinite(v) for v in [x, y, z]): continue
            if abs(x) > 50 or abs(y) > 50 or abs(z) > 50:   continue
            if x == 0 and y == 0 and z == 0:                  continue
            pts.append({
                'x': round(x, 3), 'y': round(y, 3), 'z': round(z, 3),
                'i': round(min(max(inten / 255.0, 0.0), 1.0), 2),
            })
        except Exception:
            continue
    return pts


# ── Startup ────────────────────────────────────────────────────────────────────
@app.on_event('startup')
async def _startup():
    # _event_loop and sim broadcast are wired in main()/_run().
    # This hook is kept as an extension point.
    pass


# ── WebSockets ─────────────────────────────────────────────────────────────────
@app.websocket('/ws/state')
async def ws_state(ws: WebSocket):
    await ws.accept()
    q = asyncio.Queue(maxsize=4)
    with _ws_lock: _state_qs.append(q)
    try:
        with STATE_LOCK:
            await ws.send_text(json.dumps(STATE))
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=2.0)
                await ws.send_text(msg)
            except asyncio.TimeoutError:
                await ws.send_text('{"ping":true}')
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        with _ws_lock:
            if q in _state_qs: _state_qs.remove(q)


@app.websocket('/ws/lidar')
async def ws_lidar(ws: WebSocket):
    await ws.accept()
    q = asyncio.Queue(maxsize=3)
    with _ws_lock: _lidar_qs.append(q)
    try:
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), timeout=1.0)
                await ws.send_text(msg)
            except asyncio.TimeoutError:
                with _lidar_lock:
                    cached = list(_lidar_pts)
                # Use real data only if it has enough points to be useful;
                # otherwise fall back to simulation so the map is never blank
                if len(cached) >= 50:
                    await ws.send_text(json.dumps({'points': cached}))
                else:
                    await ws.send_text(json.dumps({'points': _sim_lidar()}))
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        with _ws_lock:
            if q in _lidar_qs: _lidar_qs.remove(q)


# ── MJPEG streams ──────────────────────────────────────────────────────────────
@app.get('/stream/cam0')
async def stream_cam0():
    return StreamingResponse(
        _mjpeg(0),
        media_type='multipart/x-mixed-replace; boundary=frame',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@app.get('/stream/cam1')
async def stream_cam1():
    return StreamingResponse(
        _mjpeg(1),
        media_type='multipart/x-mixed-replace; boundary=frame',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


@app.get('/stream/annotated')
async def stream_annotated():
    return StreamingResponse(
        _mjpeg_annotated(),
        media_type='multipart/x-mixed-replace; boundary=frame',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


# ── Health / state ─────────────────────────────────────────────────────────────
@app.get('/health')
async def health():
    with STATE_LOCK:
        return {
            'status': 'ok', 'ros': ROS2, 'mock': not ROS2,
            'uptime_s': STATE['system']['uptime_s'],
            'state_clients': len(_state_qs), 'lidar_clients': len(_lidar_qs),
        }


@app.get('/api/state')
async def api_state():
    with STATE_LOCK:
        return dict(STATE)


@app.get('/api/config')
async def api_config():
    with STATE_LOCK:
        return {'robot': dict(STATE['robot']), 'safety': dict(STATE['safety'])}


@app.get('/api/saved_points')
async def api_saved_points():
    with STATE_LOCK:
        return STATE['saved_points']


@app.get('/api/log')
async def api_log():
    return list(_event_log)


@app.get('/api/programs')
async def api_programs():
    result = []
    for f in os.listdir(PROGRAMS_DIR):
        if f.endswith('.json'):
            try:
                with open(os.path.join(PROGRAMS_DIR, f)) as fp:
                    d = json.load(fp)
                result.append({
                    'name': d.get('name', f[:-5]),
                    'step_count': len(d.get('steps', [])),
                    'file': f,
                })
            except Exception:
                pass
    return result


@app.get('/api/programs/{name}')
async def api_program_load(name: str):
    path = os.path.join(PROGRAMS_DIR, f'{name}.json')
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={'error': 'Not found'})
    with open(path) as f:
        return json.load(f)


# ── Commands ───────────────────────────────────────────────────────────────────
@app.post('/cmd/estop')
async def cmd_estop(body: EstopCmd):
    with STATE_LOCK:
        if body.active:
            STATE['safety']['estop']       = True
            STATE['safety']['speed_scale'] = 0.0
            STATE['task']['running']       = False
            STATE['task']['state']         = 'PAUSED'
        else:
            zone = STATE['safety']['zone']
            if zone != 'GREEN' and not body.override:
                return JSONResponse(
                    status_code=400,
                    content={'ok': False, 'error': f'Zone is {zone} — must be GREEN to release'},
                )
            STATE['safety']['estop'] = False
            if zone == 'GREEN':
                STATE['safety']['speed_scale'] = STATE['speed_override'] / 100.0
        safety = dict(STATE['safety'])
    if _ros_node: _ros_node.pub_estop(body.active)
    log_event('ESTOP', f'active={body.active}')
    return {'ok': True, 'safety': safety}


@app.post('/cmd/resume')
async def cmd_resume():
    return await cmd_estop(EstopCmd(active=False))


@app.post('/cmd/task')
async def cmd_task(body: TaskCmd):
    cmd = body.command.lower()
    with STATE_LOCK:
        if STATE['safety']['estop'] and cmd not in ('cancel', 'stop', 'home'):
            return JSONResponse(status_code=400, content={'ok': False, 'error': 'E-Stop active'})
        t = STATE['task']
        if cmd in ('run', 'go'):
            if t['running'] and not t['paused']:
                return JSONResponse(status_code=400, content={'ok': False, 'error': 'Already running'})
            t['running'] = True; t['paused'] = False; t['state'] = 'APPROACH'
        elif cmd == 'pause':
            t['paused'] = True; t['state'] = 'PAUSED'
        elif cmd == 'resume':
            if STATE['safety']['estop']:
                return JSONResponse(status_code=400, content={'ok': False, 'error': 'E-Stop active'})
            t['paused'] = False; t['state'] = 'APPROACH'
        elif cmd == 'home':
            t['running'] = False; t['paused'] = False; t['state'] = 'HOME'
            STATE['joints']['positions'] = list(HOME)
        elif cmd in ('cancel', 'stop'):
            t['running'] = False; t['paused'] = False; t['state'] = 'IDLE'
        task = dict(t)
    if _ros_node: _ros_node.pub_task({'command': body.command})
    log_event('TASK', f'command={body.command}')
    return {'ok': True, 'task': task}


@app.post('/cmd/home')
async def cmd_home():
    return await cmd_task(TaskCmd(command='home'))


@app.post('/cmd/jog')
async def cmd_jog(body: JogCmd):
    with STATE_LOCK:
        if STATE['safety']['estop']:
            return JSONResponse(status_code=400, content={'ok': False, 'error': 'E-Stop active'})
        if STATE['safety']['zone'] not in ('GREEN', 'YELLOW'):
            return JSONResponse(
                status_code=400,
                content={'ok': False, 'error': f"Zone is {STATE['safety']['zone']} — jog requires GREEN"},
            )
        if not (0 <= body.joint <= 5):
            return JSONResponse(status_code=400, content={'ok': False, 'error': f'Invalid joint {body.joint}'})
        if abs(body.delta) > 0.5236:
            return JSONResponse(status_code=400, content={'ok': False, 'error': 'Delta too large (max 30°)'})
        lo, hi = JOINT_LIMITS[body.joint]
        cur = STATE['joints']['positions'][body.joint]
        new = round(max(lo, min(hi, cur + body.delta)), 4)
        STATE['joints']['positions'][body.joint] = new
        positions = list(STATE['joints']['positions'])
    if _ros_node: _ros_node.pub_task({'type': 'jog_joint', 'joint': body.joint, 'position': new})
    log_event('JOG', f'J{body.joint + 1} delta={body.delta:.4f} new={new:.4f}')
    return {'ok': True, 'joints': {'positions': positions}, 'joint': body.joint, 'new_position': new}


@app.post('/cmd/joints')
async def cmd_joints(body: JointsCmd):
    if len(body.positions) != 6:
        return JSONResponse(status_code=400, content={'ok': False, 'error': 'Need 6 positions'})
    clamped = [
        round(max(JOINT_LIMITS[i][0], min(JOINT_LIMITS[i][1], float(p))), 4)
        for i, p in enumerate(body.positions)
    ]
    with STATE_LOCK:
        if STATE['safety']['estop']:
            return JSONResponse(status_code=400, content={'ok': False, 'error': 'E-Stop active'})
        STATE['joints']['positions'] = clamped
    if _ros_node: _ros_node.pub_task({'type': 'move_joints', 'positions': clamped})
    log_event('JOINTS', f'positions={clamped}')
    return {'ok': True, 'joints': {'positions': clamped}}


@app.post('/cmd/gripper')
async def cmd_gripper(body: GripperCmd):
    with STATE_LOCK:
        if STATE['safety']['estop']:
            return JSONResponse(status_code=400, content={'ok': False, 'error': 'E-Stop active'})
        if body.action == 'open':
            STATE['gripper'] = {'state': 'open', 'position_mm': 85.0}
        elif body.action == 'close':
            STATE['gripper'] = {'state': 'closed', 'position_mm': 0.0}
        elif body.width_mm is not None:
            mm = max(0.0, min(85.0, float(body.width_mm)))
            STATE['gripper'] = {'state': 'open' if mm > 5 else 'closed', 'position_mm': mm}
        gripper = dict(STATE['gripper'])
    log_event('GRIPPER', f'action={body.action}')
    return {'ok': True, 'gripper': gripper}


@app.post('/cmd/voice')
async def cmd_voice(body: VoiceCmd):
    text     = body.text.lower().strip()
    response = 'Command received'
    if 'estop' in text or 'emergency' in text:
        await cmd_estop(EstopCmd(active=True));          response = 'E-Stop triggered'
    elif 'home' in text:
        await cmd_task(TaskCmd(command='home'));          response = 'Moving to home'
    elif 'pause' in text:
        await cmd_task(TaskCmd(command='pause'));         response = 'Paused'
    elif 'resume' in text or 'continue' in text:
        await cmd_task(TaskCmd(command='resume'));        response = 'Resuming'
    elif 'run' in text or 'start' in text or 'go' in text:
        await cmd_task(TaskCmd(command='run'));           response = 'Running'
    elif 'stop' in text or 'cancel' in text:
        await cmd_task(TaskCmd(command='cancel'));        response = 'Stopped'
    elif 'open' in text and 'gripper' in text:
        await cmd_gripper(GripperCmd(action='open'));    response = 'Gripper opened'
    elif 'close' in text and 'gripper' in text:
        await cmd_gripper(GripperCmd(action='close'));   response = 'Gripper closed'
    if _ros_node: _ros_node.pub_task({'type': 'voice', 'text': body.text})
    log_event('VOICE', f'"{body.text}" → {response}')
    return {'ok': True, 'response': response, 'input': body.text}


@app.post('/cmd/voice_ros')
async def cmd_voice_ros(body: VoiceCmd):
    with STATE_LOCK:
        STATE['language']['last_text'] = body.text
        STATE['language']['listening'] = True
    if _ros_node and hasattr(_ros_node, '_lang_pub'):
        msg = String(); msg.data = body.text
        _ros_node._lang_pub.publish(msg)
    log_event('VOICE_ROS', f'"{body.text}"')
    return {'ok': True, 'text': body.text}


@app.get('/api/fleet')
async def api_fleet():
    logs_mb = 0.0
    try:
        log_dir = '/opt/cobot/logs'
        if os.path.isdir(log_dir):
            for fn in os.listdir(log_dir):
                fp = os.path.join(log_dir, fn)
                if os.path.isfile(fp):
                    logs_mb += os.path.getsize(fp)
            logs_mb = round(logs_mb / (1024 * 1024), 2)
    except Exception:
        pass
    with STATE_LOCK:
        STATE['fleet']['logs_mb'] = logs_mb
        return dict(STATE['fleet'])


@app.post('/cmd/speed_override')
async def cmd_speed_override(body: SpeedCmd):
    pct = max(0, min(100, body.percent))
    with STATE_LOCK:
        STATE['speed_override'] = pct
        if not STATE['safety']['estop'] and STATE['safety']['zone'] == 'GREEN':
            STATE['safety']['speed_scale'] = pct / 100.0
    log_event('SPEED_OVERRIDE', f'{pct}%')
    return {'ok': True, 'speed_override': pct}


@app.post('/cmd/teach_point')
async def cmd_teach_point(body: TeachPointCmd):
    with STATE_LOCK:
        pts = [p for p in STATE['saved_points'] if p.get('name') != body.name]
        pt  = {
            'name': body.name, 'joint_positions': body.joint_positions,
            'tcp_pose': body.tcp_pose, 'created_at': time.time(),
        }
        pts.append(pt)
        STATE['saved_points'] = pts
    _save_points(pts)
    log_event('TEACH_POINT', f'saved "{body.name}"')
    return {'ok': True, 'point': pt, 'total': len(pts)}


@app.post('/cmd/go_to_point')
async def cmd_go_to_point(body: GoToPointCmd):
    with STATE_LOCK:
        pts = STATE['saved_points']
    pt = next((p for p in pts if p.get('name') == body.name), None)
    if not pt:
        return JSONResponse(status_code=404, content={'ok': False, 'error': f'Point {body.name!r} not found'})
    joints = pt.get('joint_positions')
    if joints and len(joints) == 6:
        log_event('GO_TO_POINT', f'"{body.name}"')
        return await cmd_joints(JointsCmd(positions=joints))
    return JSONResponse(status_code=400, content={'ok': False, 'error': 'No joint positions saved for this point'})


@app.delete('/cmd/saved_point/{name}')
async def delete_saved_point(name: str):
    with STATE_LOCK:
        pts = [p for p in STATE['saved_points'] if p.get('name') != name]
        STATE['saved_points'] = pts
    _save_points(pts)
    return {'ok': True, 'remaining': len(pts)}


@app.post('/cmd/pick')
async def cmd_pick(body: dict):
    with STATE_LOCK:
        if STATE['safety']['estop']:
            return JSONResponse(status_code=400, content={'ok': False, 'error': 'E-Stop active'})
        STATE['task']['state']  = 'SELECT_TARGET'
        STATE['task']['target'] = body.get('class_name', 'unknown')
    if _ros_node:
        _ros_node.pub_task({'command': 'pick', 'object_id': body.get('object_id'),
                            'class_name': body.get('class_name')})
    log_event('PICK', f"class={body.get('class_name')} id={body.get('object_id')}")
    return {'ok': True}


@app.post('/cmd/clear_error')
async def cmd_clear_error():
    with STATE_LOCK:
        STATE['robot']['error_code'] = 0
    log_event('CLEAR_ERROR', 'error cleared')
    return {'ok': True}


@app.post('/cmd/program/save')
async def program_save(body: ProgramSaveCmd):
    path = os.path.join(PROGRAMS_DIR, f'{body.name}.json')
    data = {'name': body.name, 'steps': body.steps, 'saved_at': time.time()}
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    with STATE_LOCK:
        STATE['program']['name']  = body.name
        STATE['program']['steps'] = body.steps
    log_event('PROGRAM_SAVE', f'"{body.name}" {len(body.steps)} steps')
    return {'ok': True, 'name': body.name, 'step_count': len(body.steps)}


@app.post('/cmd/program/load/{name}')
async def program_load(name: str):
    path = os.path.join(PROGRAMS_DIR, f'{name}.json')
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={'ok': False, 'error': 'Not found'})
    with open(path) as f:
        data = json.load(f)
    with STATE_LOCK:
        STATE['program']['name']  = data.get('name', name)
        STATE['program']['steps'] = data.get('steps', [])
    log_event('PROGRAM_LOAD', f'"{name}"')
    return {'ok': True, 'program': dict(STATE['program'])}


@app.post('/cmd/program/add')
async def program_add(body: dict):
    with STATE_LOCK:
        steps   = STATE['program']['steps']
        new_id  = max((s['id'] for s in steps), default=0) + 1
        step    = {
            'id': new_id, 'type': body.get('type', 'move'),
            'label': body.get('label', 'Step'), 'detail': body.get('detail', ''),
            'status': 'pending',
        }
        steps.append(step)
        program = dict(STATE['program'])
    return {'ok': True, 'program': program}


@app.post('/cmd/program/remove')
async def program_remove(body: dict):
    sid = body.get('id')
    with STATE_LOCK:
        STATE['program']['steps'] = [s for s in STATE['program']['steps'] if s['id'] != sid]
        program = dict(STATE['program'])
    return {'ok': True, 'program': program}


@app.post('/cmd/program/reorder')
async def program_reorder(body: dict):
    ids = body.get('ids', [])
    with STATE_LOCK:
        by_id = {s['id']: s for s in STATE['program']['steps']}
        STATE['program']['steps'] = [by_id[i] for i in ids if i in by_id]
        program = dict(STATE['program'])
    return {'ok': True, 'program': program}


# ── Run program ────────────────────────────────────────────────────────────────
@app.post('/cmd/run_program')
async def cmd_run_program(body: dict):
    prog_name = body.get('name', '')
    with STATE_LOCK:
        steps = STATE['program']['steps']
    if _ros_node:
        _ros_node.pub_task({'type': 'run_program', 'steps': steps})
    log_event('PROGRAM_RUN', f'"{prog_name}" {len(steps)} steps')
    return {'ok': True, 'steps': len(steps)}


# ── Static file serving (SPA) ──────────────────────────────────────────────────
_assets_dir = os.path.join(DIST_DIR, 'assets')
if os.path.isdir(_assets_dir):
    app.mount('/assets', StaticFiles(directory=_assets_dir), name='assets')


@app.get('/{full_path:path}')
async def spa(full_path: str):
    candidate = os.path.join(DIST_DIR, full_path)
    if os.path.isfile(candidate):
        return FileResponse(candidate)
    if os.path.isfile(INDEX_HTML):
        return FileResponse(INDEX_HTML)
    return JSONResponse(
        status_code=503,
        content={'error': 'Frontend not built', 'fix': 'cd frontend && npm run build'},
    )


# ── Entry point ────────────────────────────────────────────────────────────────
def _spin(node):
    rclpy.spin(node)


def main(args=None):
    global _ros_node, _event_loop
    import uvicorn

    if ROS2:
        rclpy.init(args=args)
        _ros_node = DashboardNode()
        threading.Thread(target=_spin, args=(_ros_node,), daemon=True).start()
    else:
        print('[RoboAi] ROS2 not available — simulation mode')

    config = uvicorn.Config(app, host='0.0.0.0', port=8080, log_level='info', loop='asyncio')
    server = uvicorn.Server(config)

    async def _run():
        global _event_loop
        _event_loop = asyncio.get_running_loop()
        if not ROS2:
            asyncio.create_task(_sim_broadcast())
        elif _ros_node:
            _ros_node._loop = _event_loop
        await server.serve()

    asyncio.run(_run())


if __name__ == '__main__':
    main()
