"""
RoboAi Controller Dashboard — Professional Backend
FastAPI + WebSocket + ROS2
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import Image, JointState
from std_msgs.msg import Bool, Float32, String

try:
    import numpy as np
    import cv2
    _CV2 = True
except ImportError:
    _CV2 = False

try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.requests import Request
    from fastapi.responses import JSONResponse, StreamingResponse
    from fastapi.staticfiles import StaticFiles
    import uvicorn
    _FASTAPI = True
except ImportError:
    _FASTAPI = False

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-7s  %(name)s  %(message)s',
)
log = logging.getLogger('dashboard')

# ── Paths ─────────────────────────────────────────────────────────────────────
_HERE = Path(os.path.dirname(os.path.abspath(__file__)))
_DATA_DIR = Path('/opt/cobot/dashboard')
_DATA_DIR.mkdir(parents=True, exist_ok=True)
_WAYPOINTS_FILE = _DATA_DIR / 'waypoints.json'
_PROGRAMS_FILE  = _DATA_DIR / 'programs.json'

# ── Shared state ──────────────────────────────────────────────────────────────
_state: Dict[str, Any] = {
    'safety_zone':      'UNKNOWN',
    'speed_scale':       0.0,
    'estop':             True,
    'human_proximity':   99.0,
    'task_state':       'IDLE',
    'joint_positions':  [0.0] * 6,
    'joint_velocities': [0.0] * 6,
    'joint_names':      [f'joint_{i+1}' for i in range(6)],
    'tcp_pose':         {'x': 0.0, 'y': 0.0, 'z': 300.0,
                         'rx': 0.0, 'ry': 0.0, 'rz': 0.0},
    'detections':       [],
    'scene_objects':    [],
}
_state_lock = threading.Lock()

_latest_frame: bytes = b''
_frame_lock = threading.Lock()
_camera_active = False

_ros_node: 'DashboardNode | None' = None

# ── Persistent data ───────────────────────────────────────────────────────────
def _load_json(path: Path, default):
    try:
        if path.exists():
            return json.loads(path.read_text())
    except Exception:
        pass
    return default

_waypoints: Dict[str, Any] = _load_json(_WAYPOINTS_FILE, {})
_programs:  Dict[str, List] = _load_json(_PROGRAMS_FILE,  {})
_data_lock = threading.Lock()

def _save_waypoints():
    try:
        with _data_lock:
            _WAYPOINTS_FILE.write_text(json.dumps(_waypoints, indent=2))
    except Exception as e:
        log.warning(f'save_waypoints: {e}')

def _save_programs():
    try:
        with _data_lock:
            _PROGRAMS_FILE.write_text(json.dumps(_programs, indent=2))
    except Exception as e:
        log.warning(f'save_programs: {e}')

# ── QoS ───────────────────────────────────────────────────────────────────────
_CAM_QOS = QoSProfile(
    depth=1,
    reliability=ReliabilityPolicy.BEST_EFFORT,
    durability=DurabilityPolicy.VOLATILE,
)

# ── Forward kinematics (UR5e DH parameters) ───────────────────────────────────
# Returns TCP pose {x,y,z in mm, rx,ry,rz in degrees}
def _compute_tcp_pose(joints: List[float]) -> Dict[str, float]:
    a     = [0.0,    -0.4250, -0.3922, 0.0,    0.0,    0.0]
    d     = [0.1625,  0.0,     0.0,    0.1333, 0.0997, 0.0996]
    alpha = [math.pi/2, 0.0, 0.0, math.pi/2, -math.pi/2, 0.0]

    def dh_matrix(theta: float, a_i: float, d_i: float, alpha_i: float):
        ct, st = math.cos(theta), math.sin(theta)
        ca, sa = math.cos(alpha_i), math.sin(alpha_i)
        return [
            [ct, -st*ca,  st*sa, a_i*ct],
            [st,  ct*ca, -ct*sa, a_i*st],
            [0.0, sa,     ca,    d_i],
            [0.0, 0.0,    0.0,   1.0],
        ]

    def mat4_mul(A, B):
        C = [[0.0]*4 for _ in range(4)]
        for i in range(4):
            for j in range(4):
                for k in range(4):
                    C[i][j] += A[i][k] * B[k][j]
        return C

    q = list(joints[:6]) + [0.0] * max(0, 6 - len(joints))
    T = [[1.0,0,0,0],[0,1.0,0,0],[0,0,1.0,0],[0,0,0,1.0]]
    for i in range(6):
        T = mat4_mul(T, dh_matrix(q[i], a[i], d[i], alpha[i]))

    x, y, z = T[0][3], T[1][3], T[2][3]
    r11, r21, r31 = T[0][0], T[1][0], T[2][0]
    r32, r33 = T[2][1], T[2][2]
    ry = math.atan2(-r31, math.sqrt(r11**2 + r21**2))
    cos_ry = math.cos(ry)
    if abs(cos_ry) > 1e-6:
        rz = math.atan2(r21 / cos_ry, r11 / cos_ry)
        rx = math.atan2(r32 / cos_ry, r33 / cos_ry)
    else:
        rz, rx = 0.0, math.atan2(-T[1][2], T[1][1])

    return {
        'x':  round(x * 1000, 1),
        'y':  round(y * 1000, 1),
        'z':  round(z * 1000, 1),
        'rx': round(math.degrees(rx), 2),
        'ry': round(math.degrees(ry), 2),
        'rz': round(math.degrees(rz), 2),
    }


# ── ROS2 node ─────────────────────────────────────────────────────────────────
class DashboardNode(Node):
    def __init__(self) -> None:
        super().__init__('dashboard_server')

        self._estop_pub = self.create_publisher(Bool,   '/safety/estop',  10)
        self._task_pub  = self.create_publisher(String, '/task/command',   10)

        self.create_subscription(Image,      '/cam0/color/image_raw',    self._on_image,     _CAM_QOS)
        self.create_subscription(String,     '/safety/zone',             self._on_zone,      10)
        self.create_subscription(Float32,    '/safety/speed_scale',      self._on_speed,     10)
        self.create_subscription(Bool,       '/safety/estop',            self._on_estop_rx,  10)
        self.create_subscription(Float32,    '/safety/human_proximity',  self._on_proximity, 10)
        self.create_subscription(String,     '/task/state',              self._on_task,      10)
        self.create_subscription(JointState, '/joint_states',            self._on_joints,    10)
        self.create_subscription(String,     '/perception/detections',   self._on_detections,10)
        self.create_subscription(String,     '/perception/scene_graph',  self._on_scene,     10)

        self.get_logger().info('Dashboard node ready')

    # ── image ──
    def _on_image(self, msg: Image) -> None:
        global _latest_frame, _camera_active
        if not _CV2:
            return
        try:
            channels = len(msg.data) // (msg.height * msg.width)
            img = np.frombuffer(bytes(msg.data), dtype=np.uint8).reshape(
                msg.height, msg.width, channels)
            enc = msg.encoding.lower()
            if enc == 'rgb8':
                img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            elif enc == 'rgba8':
                img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGR)
            elif enc == 'bgra8':
                img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
            elif enc == 'mono8':
                img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
            ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok:
                with _frame_lock:
                    _latest_frame = bytes(buf)
                    _camera_active = True
        except Exception as exc:
            self.get_logger().debug(f'image encode: {exc}')

    # ── simple topic callbacks ──
    def _on_zone(self, msg: String) -> None:
        with _state_lock:
            _state['safety_zone'] = msg.data.strip().upper()

    def _on_speed(self, msg: Float32) -> None:
        with _state_lock:
            _state['speed_scale'] = float(msg.data)

    def _on_estop_rx(self, msg: Bool) -> None:
        with _state_lock:
            _state['estop'] = bool(msg.data)

    def _on_proximity(self, msg: Float32) -> None:
        with _state_lock:
            _state['human_proximity'] = float(msg.data)

    def _on_task(self, msg: String) -> None:
        with _state_lock:
            _state['task_state'] = msg.data.strip()

    def _on_joints(self, msg: JointState) -> None:
        positions  = list(msg.position)
        velocities = list(msg.velocity) if msg.velocity else [0.0] * len(positions)
        tcp = _compute_tcp_pose(positions)
        with _state_lock:
            _state['joint_names']      = list(msg.name)
            _state['joint_positions']  = positions
            _state['joint_velocities'] = velocities
            _state['tcp_pose']         = tcp

    def _on_detections(self, msg: String) -> None:
        try:
            parsed = json.loads(msg.data)
            with _state_lock:
                _state['detections'] = parsed if isinstance(parsed, list) else []
        except Exception:
            pass

    def _on_scene(self, msg: String) -> None:
        try:
            parsed = json.loads(msg.data)
            objs = parsed if isinstance(parsed, list) else parsed.get('objects', [])
            with _state_lock:
                _state['scene_objects'] = objs
        except Exception:
            pass

    # ── publishers ──
    def publish_estop(self, active: bool) -> None:
        b = Bool()
        b.data = active
        self._estop_pub.publish(b)
        with _state_lock:
            _state['estop'] = active
        self.get_logger().warning(f'E-STOP {"TRIGGERED" if active else "CLEARED"} via dashboard')

    def publish_task(self, command: str) -> None:
        s = String()
        s.data = command
        self._task_pub.publish(s)


# ── FastAPI application ───────────────────────────────────────────────────────
if _FASTAPI:

    _ws_clients: Set[WebSocket] = set()

    async def _broadcast_loop() -> None:
        """10 Hz state broadcast to all connected WebSocket clients."""
        while True:
            if _ws_clients:
                with _state_lock:
                    payload = json.dumps({
                        'safety_zone':      _state['safety_zone'],
                        'speed_scale':      _state['speed_scale'],
                        'estop':            _state['estop'],
                        'human_proximity':  _state['human_proximity'],
                        'task_state':       _state['task_state'],
                        'joint_positions':  _state['joint_positions'],
                        'joint_velocities': _state['joint_velocities'],
                        'tcp_pose':         _state['tcp_pose'],
                        'detections':       _state['detections'],
                        'scene_objects':    _state['scene_objects'],
                        'timestamp':        time.time(),
                    })
                dead: Set[WebSocket] = set()
                for ws in list(_ws_clients):
                    try:
                        await ws.send_text(payload)
                    except Exception:
                        dead.add(ws)
                _ws_clients.difference_update(dead)
            await asyncio.sleep(0.1)

    @asynccontextmanager
    async def _lifespan(application: FastAPI):
        asyncio.create_task(_broadcast_loop())
        log.info('Broadcast loop started (10 Hz)')
        yield

    app = FastAPI(title='RoboAi Dashboard', lifespan=_lifespan,
                  docs_url=None, redoc_url=None)

    # ── Health / config ────────────────────────────────────────────────────────

    @app.get('/health')
    async def health():
        with _frame_lock:
            cam = _camera_active
        return JSONResponse({'status': 'ok', 'camera': cam, 'ros': _ros_node is not None})

    @app.get('/api/robot/config')
    async def robot_config():
        with _data_lock:
            wp = dict(_waypoints)
            pg = list(_programs.keys())
        return JSONResponse({
            'robot_name': 'Cobot 01',
            'dof': 6,
            'waypoints': wp,
            'programs': pg,
        })

    # ── MJPEG stream ───────────────────────────────────────────────────────────

    @app.get('/stream/cam0')
    async def stream_cam0():
        async def _mjpeg():
            try:
                while True:
                    with _frame_lock:
                        frame = _latest_frame
                    if frame:
                        yield (b'--frame\r\n'
                               b'Content-Type: image/jpeg\r\n\r\n'
                               + frame + b'\r\n')
                    await asyncio.sleep(0.067)   # ~15 fps
            except GeneratorExit:
                pass
        return StreamingResponse(
            _mjpeg(),
            media_type='multipart/x-mixed-replace; boundary=frame',
            headers={
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma':        'no-cache',
                'Connection':    'keep-alive',
                'X-Accel-Buffering': 'no',
            },
        )

    # ── Commands ───────────────────────────────────────────────────────────────

    @app.post('/cmd/estop')
    async def cmd_estop():
        if not _ros_node:
            return JSONResponse({'status': 'error', 'detail': 'ROS not ready'}, status_code=503)
        _ros_node.publish_estop(True)
        return JSONResponse({'status': 'ok', 'estop': True})

    @app.post('/cmd/resume')
    async def cmd_resume():
        if not _ros_node:
            return JSONResponse({'status': 'error', 'detail': 'ROS not ready'}, status_code=503)
        _ros_node.publish_estop(False)
        return JSONResponse({'status': 'ok', 'estop': False})

    @app.post('/cmd/task')
    async def cmd_task(request: Request):
        body = await request.json()
        cmd = str(body.get('command', '')).strip()
        if not cmd:
            return JSONResponse({'status': 'error', 'detail': 'command required'}, status_code=400)
        if _ros_node:
            _ros_node.publish_task(cmd)
        return JSONResponse({'status': 'ok', 'command': cmd})

    @app.post('/cmd/jog')
    async def cmd_jog(request: Request):
        body = await request.json()
        joint     = int(body.get('joint', 0))
        direction = float(body.get('direction', 0))
        speed     = float(body.get('speed', 0.05))
        if _ros_node:
            _ros_node.publish_task(json.dumps({
                'type': 'jog_joint', 'joint': joint,
                'direction': direction, 'speed': speed,
            }))
        return JSONResponse({'status': 'ok'})

    @app.post('/cmd/move_tcp')
    async def cmd_move_tcp(request: Request):
        body = await request.json()
        if _ros_node:
            _ros_node.publish_task(json.dumps({'type': 'move_tcp', **body}))
        return JSONResponse({'status': 'ok'})

    @app.post('/cmd/home')
    async def cmd_home():
        if _ros_node:
            _ros_node.publish_task('HOME')
        return JSONResponse({'status': 'ok'})

    @app.post('/cmd/set_pick')
    async def cmd_set_pick():
        with _state_lock:
            tcp = dict(_state['tcp_pose'])
        with _data_lock:
            _waypoints['pick'] = tcp
        _save_waypoints()
        return JSONResponse({'status': 'ok', 'pick': tcp})

    @app.post('/cmd/set_place')
    async def cmd_set_place():
        with _state_lock:
            tcp = dict(_state['tcp_pose'])
        with _data_lock:
            _waypoints['place'] = tcp
        _save_waypoints()
        return JSONResponse({'status': 'ok', 'place': tcp})

    @app.post('/cmd/add_waypoint')
    async def cmd_add_waypoint(request: Request):
        body = await request.json()
        name = str(body.get('name', '')).strip()
        if not name:
            return JSONResponse({'status': 'error', 'detail': 'name required'}, status_code=400)
        with _state_lock:
            tcp = dict(_state['tcp_pose'])
        with _data_lock:
            _waypoints[name] = tcp
        _save_waypoints()
        return JSONResponse({'status': 'ok', 'name': name, 'tcp': tcp})

    @app.post('/cmd/run_program')
    async def cmd_run_program(request: Request):
        body = await request.json()
        program = body.get('program', [])
        if _ros_node:
            _ros_node.publish_task(json.dumps({'type': 'run_program', 'steps': program}))
        return JSONResponse({'status': 'ok', 'steps': len(program)})

    @app.post('/cmd/save_program')
    async def cmd_save_program(request: Request):
        body = await request.json()
        name    = str(body.get('name', 'default')).strip() or 'default'
        program = body.get('program', [])
        with _data_lock:
            _programs[name] = program
        _save_programs()
        return JSONResponse({'status': 'ok', 'name': name, 'steps': len(program)})

    @app.post('/cmd/voice')
    async def cmd_voice(request: Request):
        body = await request.json()
        text = str(body.get('text', '')).strip()
        if _ros_node and text:
            _ros_node.publish_task(json.dumps({'type': 'voice', 'text': text}))
        return JSONResponse({'status': 'ok', 'text': text})

    # ── WebSocket ──────────────────────────────────────────────────────────────

    @app.websocket('/ws')
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        _ws_clients.add(ws)
        try:
            while True:
                try:
                    raw = await asyncio.wait_for(ws.receive_text(), timeout=30.0)
                    try:
                        msg = json.loads(raw)
                        if msg.get('type') == 'ping':
                            await ws.send_text(json.dumps({'type': 'pong'}))
                    except Exception:
                        pass
                except asyncio.TimeoutError:
                    pass
        except WebSocketDisconnect:
            pass
        except Exception:
            pass
        finally:
            _ws_clients.discard(ws)

    # ── Static files (mount LAST so API routes take precedence) ───────────────
    _STATIC = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'static'))

    if os.path.isdir(_STATIC):
        app.mount('/', StaticFiles(directory=_STATIC, html=True), name='static')
        log.info(f'Static files → {_STATIC}')
    else:
        log.warning(f'Static dir not found: {_STATIC}')

        @app.get('/')
        async def no_frontend():
            return JSONResponse({'error': 'frontend missing',
                                 'hint': f'create {_STATIC}/index.html'})


# ── Entry point ───────────────────────────────────────────────────────────────

def _spin_ros(node: Node) -> None:
    rclpy.spin(node)


def main(args=None) -> None:
    global _ros_node

    if not _FASTAPI:
        print('Install: pip install fastapi "uvicorn[standard]"')
        return

    if not _CV2:
        log.warning('cv2 unavailable — camera stream will be empty')

    if 'CYCLONEDDS_URI' not in os.environ:
        cdds = '/opt/cobot/cyclonedds.xml'
        if os.path.exists(cdds):
            os.environ['CYCLONEDDS_URI'] = f'file://{cdds}'
            log.info(f'CYCLONEDDS_URI → {os.environ["CYCLONEDDS_URI"]}')

    rclpy.init(args=args)
    _ros_node = DashboardNode()

    ros_thread = threading.Thread(target=_spin_ros, args=(_ros_node,),
                                  daemon=True, name='ros-spin')
    ros_thread.start()
    log.info('ROS2 spin thread started')
    log.info('Dashboard at http://0.0.0.0:8080')

    try:
        uvicorn.run(app, host='0.0.0.0', port=8080, log_level='warning',
                    access_log=False)
    except KeyboardInterrupt:
        pass
    finally:
        _ros_node.destroy_node()
        rclpy.shutdown()
        log.info('Dashboard stopped')


if __name__ == '__main__':
    main()
