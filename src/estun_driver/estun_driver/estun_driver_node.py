#!/usr/bin/env python3
"""
Estun Codroid v2.3 ROS2 Driver — TELEMETRY MIRROR

Connects to the Estun robot controller via WebSocket (ws://ROBOT_IP:9000)
using the v2.3 publish/subscribe protocol (ty/db envelope). Mirrors the
proven handshake from scripts/posture.py exactly.

Publishes:
  /joint_states           sensor_msgs/JointState   joint_1..joint_6 (rad)
  /estun/tcp_pose         geometry_msgs/PoseStamped
  /estun/status           std_msgs/String  (JSON — dashboard mirror payload)
  /estun/robot_mode       std_msgs/String  ("idle"/"auto_running"/"disabled"/…)
  /estun/safety_mode      std_msgs/String
  /estun/is_moving        std_msgs/Bool
  /estun/enabled          std_msgs/Bool  (True iff RobotStatus.state == 2)
  /estun/mode             std_msgs/String  (heartbeat: monitor_only, ip, …)
  /estun/rejected         std_msgs/String  (per-rejection event, JSON)
  /safety/estop           std_msgs/Bool

Subscribes: /estun/command, /estun/move, /estun/jog, /estun/io,
            /robot/jog_command, /robot/io_command — ALL rejected in
            monitor_only mode (the driver's only mode until motion is
            explicitly gated back on).

Parameter sources — priority high → low:
  1. `-p key:=value` on the CLI
  2. --params-file (config/estun.yaml)
  3. ESTUN_ROBOT_IP / ESTUN_ROBOT_PORT env vars (IP + port only; env
     ALWAYS wins over YAML)
  4. declare_parameter() default baked below

Protocol reference: posture.py (2026-07-09 confirmed working from Jetson
against 192.168.2.136). Envelope: {ty, db, id}. Subscribe burst by
publishing publish/<Topic> for each topic of interest. Telemetry arrives
as publish/RobotPosture (db.joint[6] deg, db.end {x,y,z mm, a,b,c deg})
and publish/RobotStatus (db.state == 2 → controller enabled; the
RobotPosture stream is ONLY emitted while enabled — silence in the
disabled state is NORMAL).
"""

import datetime
import json
import math
import os
import threading
import time

import rclpy
from rclpy.node import Node

from sensor_msgs.msg import JointState
from geometry_msgs.msg import PoseStamped
from std_msgs.msg import String, Bool

try:
    import websockets
    import websockets.sync.client as ws_sync
except ImportError:
    websockets = None
    ws_sync = None

WS_LOG_DIR = '/opt/cobot/logs'

# v2.3 subscribe burst — matches posture.py exactly.
SUBSCRIBE_TOPICS = [
    'web', 'WebCommand', 'Error', 'ProjectState',
    'RobotStatus', 'RobotPosture', 'RobotCoordinate', 'ProjectStatus',
]


class EstunCodroidDriver(Node):
    """v2.3 telemetry mirror driver for Estun Codroid controllers."""

    JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']

    def __init__(self):
        super().__init__('estun_driver')

        # ── Parameters ─────────────────────────────────────────
        self.declare_parameter('robot_ip',   '192.168.2.136')
        self.declare_parameter('robot_port', 9000)
        self.declare_parameter('ui_origin_port', 9198)
        self.declare_parameter('auto_connect', True)

        # Safety gates — monitor_only is a hard gate; nothing besides
        # this driver flips it. Keep it True until motion enablement is
        # explicitly reviewed.
        self.declare_parameter('monitor_only', True)
        self.declare_parameter('ws_log_raw', True)

        # Cadence knobs.
        self.declare_parameter('recv_timeout_s', 5.0)   # matches posture.py
        self.declare_parameter('ping_on_timeout', True)
        self.declare_parameter('reconnect_backoff_s', 2.0)

        # Rate-limit the "waiting for stream" log so a disabled robot
        # doesn't spam. In seconds.
        self.declare_parameter('disabled_log_period_s', 15.0)

        self._robot_ip     = str(self.get_parameter('robot_ip').value)
        self._robot_port   = int(self.get_parameter('robot_port').value)
        self._ui_origin_port = int(self.get_parameter('ui_origin_port').value)
        self._auto_connect = bool(self.get_parameter('auto_connect').value)
        self._monitor_only = bool(self.get_parameter('monitor_only').value)
        self._ws_log_raw   = bool(self.get_parameter('ws_log_raw').value)
        self._recv_timeout = float(self.get_parameter('recv_timeout_s').value)
        self._ping_on_to   = bool(self.get_parameter('ping_on_timeout').value)
        self._reconn_backoff = float(self.get_parameter('reconnect_backoff_s').value)
        self._disabled_log_period = float(self.get_parameter('disabled_log_period_s').value)

        # Env override — ALWAYS wins so systemd can retarget without rebuild.
        env_ip = os.environ.get('ESTUN_ROBOT_IP')
        env_port = os.environ.get('ESTUN_ROBOT_PORT')
        self._ip_source = 'param'
        if env_ip:
            self._robot_ip = env_ip.strip()
            self._ip_source = 'ESTUN_ROBOT_IP'
        if env_port:
            try:
                self._robot_port = int(env_port)
                self._ip_source += '+ESTUN_ROBOT_PORT'
            except ValueError:
                self.get_logger().warn(
                    f'ESTUN_ROBOT_PORT={env_port!r} not an int — ignored')

        # ── WebSocket state ────────────────────────────────────
        self._ws = None
        self._connected = False
        self._recv_thread = None
        self._send_lock = threading.Lock()

        # ── Robot state ────────────────────────────────────────
        self._joint_deg = [0.0] * 6
        self._joint_rad = [0.0] * 6
        self._tcp_mm    = [0.0] * 6   # x,y,z (mm), a,b,c (deg, fixed-XYZ)
        self._tcp_m     = [0.0] * 6   # x,y,z (m),  a,b,c (rad)
        self._state_code = -1         # RobotStatus.state; 2 == enabled
        self._enabled    = False
        self._is_estop   = False
        self._is_moving  = False
        self._last_posture_ts = 0.0
        self._last_status_ts  = 0.0
        self._last_disabled_log = 0.0

        # Rejection accounting.
        self._rej_counts = {}
        self._rej_warned = set()

        # ── WS raw log ─────────────────────────────────────────
        self._ws_log_path = None
        self._ws_log_fh   = None
        self._ws_log_lock = threading.Lock()
        if self._ws_log_raw:
            self._open_ws_log()

        # ── Publishers ─────────────────────────────────────────
        self._pub_joint_state = self.create_publisher(JointState, '/joint_states', 10)
        self._pub_tcp_pose    = self.create_publisher(PoseStamped, '/estun/tcp_pose', 10)
        self._pub_robot_mode  = self.create_publisher(String, '/estun/robot_mode', 10)
        self._pub_safety_mode = self.create_publisher(String, '/estun/safety_mode', 10)
        self._pub_estop       = self.create_publisher(Bool,   '/safety/estop', 10)
        self._pub_moving      = self.create_publisher(Bool,   '/estun/is_moving', 10)
        self._pub_enabled     = self.create_publisher(Bool,   '/estun/enabled', 10)
        self._pub_status      = self.create_publisher(String, '/estun/status', 10)
        self._pub_mode        = self.create_publisher(String, '/estun/mode', 10)
        self._pub_rejected    = self.create_publisher(String, '/estun/rejected', 10)

        # ── Subscribers — writes are refused in monitor_only ───
        self.create_subscription(String, '/estun/command',      self._on_write, 10)
        self.create_subscription(String, '/estun/move',         self._on_write, 10)
        self.create_subscription(String, '/estun/jog',          self._on_write, 10)
        self.create_subscription(String, '/estun/io',           self._on_write, 10)
        self.create_subscription(String, '/robot/jog_command',  self._on_write, 10)
        self.create_subscription(String, '/robot/io_command',   self._on_write, 10)

        # ── Timers ─────────────────────────────────────────────
        self._mode_timer    = self.create_timer(1.0, self._publish_mode)
        self._connect_timer = self.create_timer(self._reconn_backoff, self._try_connect)

        self.get_logger().info(
            f'Estun v2.3 driver initialized — '
            f'target ws://{self._robot_ip}:{self._robot_port}  '
            f'origin=http://{self._robot_ip}:{self._ui_origin_port}  '
            f'(ip source: {self._ip_source})')
        if self._monitor_only:
            self.get_logger().warn(
                'MONITOR-ONLY mode — all inbound motion/IO/command writes '
                'are rejected. This is a read-only telemetry mirror.')
        self._publish_mode()

    # ── WS raw log ────────────────────────────────────────

    def _open_ws_log(self):
        try:
            os.makedirs(WS_LOG_DIR, exist_ok=True)
            ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
            self._ws_log_path = os.path.join(WS_LOG_DIR, f'estun_ws_{ts}.jsonl')
            self._ws_log_fh = open(self._ws_log_path, 'a', buffering=1)
            self.get_logger().info(f'ws_log_raw ON → {self._ws_log_path}')
        except Exception as e:
            self._ws_log_fh = None
            self._ws_log_path = None
            self.get_logger().warn(f'Could not open WS log: {e}')

    def _log_ws(self, direction, payload):
        if not self._ws_log_fh:
            return
        try:
            entry = {'ts': time.time(), 'dir': direction, 'payload': payload}
            with self._ws_log_lock:
                self._ws_log_fh.write(json.dumps(entry) + '\n')
        except Exception:
            pass

    def _close_ws_log(self):
        with self._ws_log_lock:
            if self._ws_log_fh:
                try:
                    self._ws_log_fh.flush()
                    self._ws_log_fh.close()
                except Exception:
                    pass
                self._ws_log_fh = None

    # ── Rejection accounting ──────────────────────────────

    def _reject(self, family, reason, extra=None):
        self._rej_counts[family] = self._rej_counts.get(family, 0) + 1
        if family not in self._rej_warned:
            self._rej_warned.add(family)
            self.get_logger().warn(
                f'{family}: {reason} — rejected (subsequent {family} '
                'rejections counted, not warned)')
        evt = {
            'ts': time.time(),
            'family': family,
            'reason': reason,
            'monitor_only': self._monitor_only,
            'count': self._rej_counts[family],
        }
        if extra:
            evt.update(extra)
        m = String(); m.data = json.dumps(evt)
        self._pub_rejected.publish(m)

    def _on_write(self, msg):
        # Every subscription in this driver is a write path.
        family = 'write'
        if self._monitor_only:
            self._reject(family, 'monitor_only active',
                         extra={'payload': msg.data[:200]})
            return
        # Non-monitor path is intentionally not implemented in this build;
        # motion command paths must be re-added deliberately behind an
        # explicit safety review before this branch is taken.
        self._reject(family, 'write paths disabled in v2.3 telemetry mirror')

    def _publish_mode(self):
        body = {
            'monitor_only':   self._monitor_only,
            'ws_log_raw':     self._ws_log_raw,
            'ws_log_path':    self._ws_log_path,
            'rejections':     dict(self._rej_counts),
            'ip':             self._robot_ip,
            'port':           self._robot_port,
            'origin':         f'http://{self._robot_ip}:{self._ui_origin_port}',
            'ip_source':      self._ip_source,
            'connected':      self._connected,
            'enabled':        self._enabled,
            'state_code':     self._state_code,
            'last_posture_age_s': (time.time() - self._last_posture_ts) if self._last_posture_ts else None,
            'last_status_age_s':  (time.time() - self._last_status_ts)  if self._last_status_ts  else None,
        }
        m = String(); m.data = json.dumps(body)
        self._pub_mode.publish(m)

    # ── WebSocket lifecycle ───────────────────────────────

    def _try_connect(self):
        if self._connected:
            return
        if ws_sync is None:
            self.get_logger().warn(
                'websockets library not installed — pip install websockets')
            return
        url = f'ws://{self._robot_ip}:{self._robot_port}/'
        origin = f'http://{self._robot_ip}:{self._ui_origin_port}'
        try:
            self._ws = ws_sync.connect(url, open_timeout=5, origin=origin)
        except Exception as e:
            self.get_logger().warn(f'Cannot connect {url} (origin={origin}): {e}')
            self._ws = None
            self._connected = False
            return

        self._connected = True
        self.get_logger().info(
            f'Connected {url} (origin={origin}) — sending v2.3 subscribe burst')

        # Subscribe burst — mirrors posture.py exactly.
        try:
            for t in SUBSCRIBE_TOPICS:
                self._send({'ty': f'publish/{t}'})
        except Exception as e:
            self.get_logger().warn(f'Subscribe burst failed: {e}')
            self._disconnect()
            return

        self._recv_thread = threading.Thread(target=self._recv_loop, daemon=True)
        self._recv_thread.start()

    def _disconnect(self):
        self._connected = False
        self._enabled = False
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

    def _send(self, obj):
        """Send a compact JSON frame — matches posture.py serialization."""
        if not self._ws:
            return False
        text = json.dumps(obj, separators=(',', ':'))
        with self._send_lock:
            self._ws.send(text)
        self._log_ws('tx', text)
        return True

    def _send_raw(self, text):
        if not self._ws:
            return False
        with self._send_lock:
            self._ws.send(text)
        self._log_ws('tx', text)
        return True

    def _recv_loop(self):
        while self._connected and self._ws is not None:
            try:
                m = self._ws.recv(timeout=self._recv_timeout)
            except TimeoutError:
                if self._ping_on_to:
                    try:
                        self._send_raw('ping')
                    except Exception as e:
                        self.get_logger().warn(f'ping send failed: {e}')
                        self._disconnect()
                        return
                continue
            except Exception as e:
                # websockets connection-closed and friends surface here.
                self.get_logger().warn(f'recv failed: {e}')
                self._disconnect()
                return

            if m is None:
                continue

            # Text control frames from posture.py's protocol.
            if m == 'ping':
                try:
                    self._send_raw('pong')
                except Exception:
                    self._disconnect()
                    return
                continue
            if m == 'pong':
                continue

            self._log_ws('rx', m if isinstance(m, str) else m.decode('utf-8', 'replace'))
            try:
                obj = json.loads(m)
            except Exception:
                # Non-JSON frame — log already captured raw payload.
                continue
            self._handle_frame(obj)

    # ── Frame dispatch ────────────────────────────────────

    def _handle_frame(self, obj):
        ty = obj.get('ty', '')
        db = obj.get('db')
        if not ty.startswith('publish/'):
            return
        topic = ty[len('publish/'):]
        if topic == 'RobotPosture':
            self._on_posture(db)
        elif topic == 'RobotStatus':
            self._on_status(db)
        # Other topics (WebCommand, ProjectState, Error, RobotCoordinate,
        # ProjectStatus, web) are captured in the raw log but not
        # otherwise processed in this telemetry mirror.

    def _on_posture(self, db):
        """publish/RobotPosture — db.joint[6] (deg), db.end {x,y,z mm, a,b,c deg}."""
        if not isinstance(db, dict):
            return
        joints = db.get('joint')
        if isinstance(joints, list) and len(joints) >= 6:
            # Vectorized-ish parse: single pass, deg → rad in place.
            self._joint_deg = [float(joints[i]) for i in range(6)]
            self._joint_rad = [math.radians(v) for v in self._joint_deg]

            js = JointState()
            js.header.stamp = self.get_clock().now().to_msg()
            js.name = self.JOINT_NAMES
            js.position = list(self._joint_rad)
            js.velocity = [0.0] * 6
            js.effort   = [0.0] * 6
            self._pub_joint_state.publish(js)

        end = db.get('end')
        if isinstance(end, dict):
            # x,y,z mm; a,b,c deg (fixed-XYZ per v2.3 protocol).
            xmm = float(end.get('x', 0.0))
            ymm = float(end.get('y', 0.0))
            zmm = float(end.get('z', 0.0))
            adeg = float(end.get('a', 0.0))
            bdeg = float(end.get('b', 0.0))
            cdeg = float(end.get('c', 0.0))
            self._tcp_mm = [xmm, ymm, zmm, adeg, bdeg, cdeg]
            self._tcp_m  = [xmm / 1000.0, ymm / 1000.0, zmm / 1000.0,
                            math.radians(adeg), math.radians(bdeg), math.radians(cdeg)]

            ps = PoseStamped()
            ps.header.stamp = self.get_clock().now().to_msg()
            ps.header.frame_id = 'base_link'
            ps.pose.position.x = self._tcp_m[0]
            ps.pose.position.y = self._tcp_m[1]
            ps.pose.position.z = self._tcp_m[2]
            # Orientation left as identity — RPY→quat conversion belongs
            # to a downstream consumer that knows the fixed-XYZ convention
            # and any base-frame rotation. Not needed for the twin, which
            # tracks joint angles directly.
            self._pub_tcp_pose.publish(ps)

        self._last_posture_ts = time.time()
        self._publish_status_blob()

    def _on_status(self, db):
        """publish/RobotStatus — db.state (2 == enabled)."""
        if not isinstance(db, dict):
            return
        state = db.get('state')
        try:
            state_int = int(state)
        except Exception:
            state_int = -1
        self._state_code = state_int
        was_enabled = self._enabled
        self._enabled = (state_int == 2)
        self._last_status_ts = time.time()

        # Best-effort status field parsing — unknown fields go through
        # the raw log. estop/moving fields aren't standardized in v2.3
        # docs seen so far; treat them as optional passthroughs.
        estop = db.get('estop')
        if isinstance(estop, bool):
            self._is_estop = estop
        moving = db.get('moving')
        if isinstance(moving, bool):
            self._is_moving = moving

        # Publish enabled + mode string.
        m = Bool(); m.data = self._enabled
        self._pub_enabled.publish(m)
        mode_s = String()
        # Map the state code to something human — 2==enabled, others
        # collectively 'disabled' until we've documented the full set.
        mode_s.data = 'enabled' if self._enabled else f'disabled(state={state_int})'
        self._pub_robot_mode.publish(mode_s)

        est = Bool(); est.data = self._is_estop
        self._pub_estop.publish(est)
        mv = Bool(); mv.data = self._is_moving
        self._pub_moving.publish(mv)

        if not self._enabled:
            now = time.time()
            if now - self._last_disabled_log > self._disabled_log_period:
                self._last_disabled_log = now
                self.get_logger().info(
                    f'RobotStatus.state={state_int} — controller not enabled; '
                    'RobotPosture will resume when the operator enables the arm.')
        elif not was_enabled:
            self.get_logger().info('RobotStatus.state=2 — controller ENABLED; posture stream should start.')

        self._publish_status_blob()

    def _publish_status_blob(self):
        blob = {
            'connected':     self._connected,
            'robot_mode':    'enabled' if self._enabled else f'disabled(state={self._state_code})',
            'safety_mode':   'estop' if self._is_estop else 'normal',
            'status_flag':   self._state_code,
            'estop':         self._is_estop,
            'moving':        self._is_moving,
            'enabled':       self._enabled,
            'joints_deg':    list(self._joint_deg),
            'joints_rad':    list(self._joint_rad),
            'tcp_mm':        list(self._tcp_mm),
            'tcp_m':         list(self._tcp_m),
            'monitor_only':  self._monitor_only,
            'rejections':    dict(self._rej_counts),
            'ip':            self._robot_ip,
            'ip_source':     self._ip_source,
        }
        # Also publish a plain safety mode string for legacy consumers.
        sm = String(); sm.data = 'estop' if self._is_estop else 'normal'
        self._pub_safety_mode.publish(sm)

        s = String(); s.data = json.dumps(blob)
        self._pub_status.publish(s)

    # ── Shutdown ──────────────────────────────────────────

    def destroy_node(self):
        self._disconnect()
        self._close_ws_log()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = EstunCodroidDriver()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
