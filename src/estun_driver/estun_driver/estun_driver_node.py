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
            /robot/jog_command, /robot/io_command, /robot/power_command —
            ALL rejected in monitor_only mode (the driver's only mode
            until motion is explicitly gated back on). /robot/power_command
            has its own second gate (allow_power) independent of allow_jog:
            power transitions are a distinct privilege from motion, and
            *safing* the arm (disable / clear_alarm) must never be gated
            harder than moving it — so those two work whenever allow_power
            is open, regardless of allow_jog.

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
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy, QoSDurabilityPolicy

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

        # Jog write path — second gate, must be paired with monitor_only=false.
        # env override ESTUN_ALLOW_JOG=1 wins over YAML (same precedence as IP).
        # Only the joint-jog subset is implemented here; every other write
        # path stays hard-rejected regardless of these flags.
        self.declare_parameter('allow_jog', False)
        # Cartesian (mode:2) jog stays hard-gated on this build — the shape
        # is captured but not yet validated. Independent flag so the joint
        # path can go live without exposing untested Cartesian motion.
        self.declare_parameter('allow_cartesian_jog', False)
        self.declare_parameter('jog_speed_cap', 0.15)          # |speed| ≤ 0.15 fraction-of-max
        self.declare_parameter('jog_heartbeat_s', 0.4)         # Robot/jogHeartbeat cadence
        self.declare_parameter('jog_freshness_timeout_s', 0.3) # deadman: no refresh → stopJog

        # Incremental (angle-bounded) jog — the driver owns the stop timer
        # so the browser never controls stop timing. Duration formula:
        #   duration_s = |delta_deg| / (jog_increment_speed_frac * max_joint_speed_degps[axis-1])
        # Freshness deadman + heartbeats still run underneath as safety
        # backups — see _on_jog_supervise.
        self.declare_parameter('jog_increment_speed_frac', 0.15)
        # Per-joint max angular speed from the Config→Safety screens.
        # J1-J3 = 150 °/s, J4-J6 = 180 °/s.
        self.declare_parameter('max_joint_speed_degps',
                               [150.0, 150.0, 150.0, 180.0, 180.0, 180.0])
        # Position clamp. J3 and J5 are ±166° per the safety screens; the
        # rest are ±200°. Clamp check applies |current + delta| <= limit - margin
        # so we never *command* motion into the last 2° of travel.
        self.declare_parameter('joint_limit_deg',
                               [200.0, 200.0, 166.0, 200.0, 166.0, 200.0])
        self.declare_parameter('joint_limit_margin_deg', 2.0)
        # Server should already validate |delta_deg| ≤ 5°; this is belt+braces.
        self.declare_parameter('jog_increment_max_delta_deg', 5.0)

        # Power write path — third gate, SEPARATE from allow_jog. Power
        # transitions are a distinct privilege: an operator may be
        # authorised to command motion under an already-enabled arm
        # without also holding the key to bring the arm up in the first
        # place, and vice-versa (safing an arm we shouldn't have brought
        # up is always allowed to whoever has this key). monitor_only
        # still master-gates all three commands. Env override
        # ESTUN_ALLOW_POWER=1 wins over YAML, same precedence as
        # allow_jog. NO code path anywhere calls enable except the
        # explicit operator command arriving on /robot/power_command:
        # no auto-enable-on-startup, no auto-enable-on-reconnect, no
        # retry-on-failure.
        self.declare_parameter('allow_power', False)

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

        self._allow_jog             = bool(self.get_parameter('allow_jog').value)
        self._allow_cartesian_jog   = bool(self.get_parameter('allow_cartesian_jog').value)
        self._allow_jog_source = 'param'
        self._allow_cart_source = 'param'
        env_allow = os.environ.get('ESTUN_ALLOW_JOG')
        if env_allow is not None:
            self._allow_jog = env_allow.strip().lower() in ('1', 'true', 'yes', 'on')
            self._allow_jog_source = 'ESTUN_ALLOW_JOG'
        env_cart = os.environ.get('ESTUN_ALLOW_CARTESIAN')
        if env_cart is not None:
            self._allow_cartesian_jog = env_cart.strip().lower() in ('1', 'true', 'yes', 'on')
            self._allow_cart_source = 'ESTUN_ALLOW_CARTESIAN'
        self._jog_speed_cap   = float(self.get_parameter('jog_speed_cap').value)
        self._jog_hb_s        = float(self.get_parameter('jog_heartbeat_s').value)
        self._jog_freshness_s = float(self.get_parameter('jog_freshness_timeout_s').value)
        self._jog_inc_speed_frac = float(self.get_parameter('jog_increment_speed_frac').value)
        self._max_joint_speed_degps = list(self.get_parameter('max_joint_speed_degps').value)
        self._joint_limit_deg = list(self.get_parameter('joint_limit_deg').value)
        self._joint_limit_margin_deg = float(self.get_parameter('joint_limit_margin_deg').value)
        self._jog_inc_max_delta_deg = float(self.get_parameter('jog_increment_max_delta_deg').value)

        self._allow_power = bool(self.get_parameter('allow_power').value)
        self._allow_power_source = 'param'
        env_power = os.environ.get('ESTUN_ALLOW_POWER')
        if env_power is not None:
            self._allow_power = env_power.strip().lower() in ('1', 'true', 'yes', 'on')
            self._allow_power_source = 'ESTUN_ALLOW_POWER'

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
        # RobotStatus.state observed values (2026-07-14 logs):
        #   0 = Disabled    1 = Enabling (transient)
        #   2 = Enabled     3 = Enabled (sub-state, still enabled)
        # 'enabled' is state ∈ {2, 3}; 'enabling' is state == 1 (used by
        # the dashboard banner for the "ENABLING…" transition state).
        self._state_code = -1
        self._state_name = ''
        self._enabled    = False
        self._enabling   = False
        self._is_estop   = False
        self._is_moving  = False
        # Alarm mirror. publish/Error carries db as a list of active
        # alarms — empty list = no alarms, non-empty = at least one
        # active. Populated by _on_error; consumed by the mode/status
        # blob so the dashboard banner can show ALARM before Enable.
        self._alarms     = []
        self._last_posture_ts = 0.0
        self._last_status_ts  = 0.0
        self._last_disabled_log = 0.0

        # Rejection accounting.
        self._rej_counts = {}
        self._rej_warned = set()

        # Jog write-path state (only used when both monitor_only=false and
        # allow_jog=true — otherwise every jog message hits _on_write_reject).
        # _jog_active: a Robot/jog has been sent and stopJog hasn't been sent yet.
        # _jog_last_cmd_ts: wall-clock of most recent accepted /robot/jog_command;
        # the supervise tick compares against this for the freshness deadman.
        # _jog_last_hb_ts: wall-clock of most recent Robot/jogHeartbeat frame;
        # supervise tick emits a heartbeat when age ≥ _jog_hb_s.
        self._jog_lock = threading.Lock()
        self._jog_active = False
        self._jog_mode = None            # None | 'velocity' | 'increment' | 'continuous' | 'continuous_cart'
        self._jog_index = 0
        self._jog_direction = 0          # ±1 for continuous
        self._jog_signed_speed = 0.0     # last commanded signed speed for continuous
        self._jog_last_cmd_ts = 0.0
        self._jog_last_hb_ts = 0.0
        self._jog_increment_end_ts = 0.0
        self._jog_increment_delta_deg = 0.0
        self._jog_supervise_timer = None
        # ── Session tracking for release-lag fix ────────────────────
        # Every browser press generates a fresh hold_id and increments a
        # per-session seq. Driver latches the current session's id and
        # highest seq processed. Any refresh with:
        #   - hold_id != _jog_active_hold_id  → stale (session was
        #     released; queued straggler cannot restart motion)
        #   - seq <= _jog_last_seq             → stale (out-of-order or
        #     duplicate)
        # ...is discarded silently and does NOT extend _jog_last_cmd_ts.
        # On stop, _jog_active_hold_id is cleared so the entire finished
        # session is dead — even if the very next message on the wire
        # is another refresh from that session.
        self._jog_active_hold_id = None
        self._jog_last_seq = 0
        # Latched on _stop_jog_locked so a straggler refresh with the
        # SAME hold_id (which was still in flight when release fired)
        # cannot resurrect the session on the "session inactive" code
        # path. Cleared only when a NEW hold_id starts a session.
        self._jog_released_hold_id = None
        # Precise one-shot for increment expiry — the primary stop
        # mechanism. threading.Timer schedules a real wall-clock fire in
        # its own thread, so the increment stop is not coupled to the
        # 50 ms supervise polling cadence. Supervise still runs as a
        # safety backstop (freshness deadman + heartbeats).
        self._jog_increment_stop_timer = None

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

        # ── Subscribers ────────────────────────────────────────
        # /robot/jog_command has a real handler that emits Robot/jog when
        # both gates (monitor_only=false AND allow_jog=true) are open;
        # otherwise it rejects like the others. Every remaining write
        # topic stays hard-rejected on this build.
        self.create_subscription(String, '/estun/command',      self._on_write_reject, 10)
        self.create_subscription(String, '/estun/move',         self._on_write_reject, 10)
        self.create_subscription(String, '/estun/jog',          self._on_write_reject, 10)
        self.create_subscription(String, '/estun/io',           self._on_write_reject, 10)
        # QoS: best-effort KEEP_LAST with a small buffer. Depth 5 is
        # enough to ride out ~500 ms of executor jitter (5× 100 ms
        # publish period) without dropping a run of refreshes that
        # would starve the 300 ms freshness deadman. Best-effort so
        # the publisher can't block on a slow subscriber, and
        # KEEP_LAST so the oldest refresh drops on overflow — the
        # latest state is always the right state. Combined with the
        # hold_id / seq guards below, a queued straggler still can't
        # restart a released session.
        _jog_qos = QoSProfile(
            depth=5,
            reliability=QoSReliabilityPolicy.BEST_EFFORT,
            history=QoSHistoryPolicy.KEEP_LAST,
            durability=QoSDurabilityPolicy.VOLATILE,
        )
        self.create_subscription(String, '/robot/jog_command',  self._on_jog_command,  _jog_qos)
        self.create_subscription(String, '/robot/io_command',   self._on_write_reject, 10)
        # Power transitions — one-shot commands (enable/disable/clear_alarm).
        # Reliable QoS, small depth: these are single infrequent user gestures,
        # not the ephemeral refresh stream that jog is.
        self.create_subscription(String, '/robot/power_command', self._on_power_command, 5)

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
        elif self._allow_jog:
            cart_note = (f'CARTESIAN ALSO ENABLED (source: {self._allow_cart_source})'
                         if self._allow_cartesian_jog
                         else 'Cartesian gate STILL CLOSED — set ESTUN_ALLOW_CARTESIAN=1 to open')
            self.get_logger().warn(
                f'JOG WRITE PATH ENABLED — monitor_only=false, '
                f'allow_jog=true (source: {self._allow_jog_source}). '
                f'{cart_note}. '
                f'/robot/jog_command will emit Robot/jog frames '
                f'(|speed|≤{self._jog_speed_cap:.2f}, heartbeat={self._jog_hb_s:.2f}s, '
                f'deadman={self._jog_freshness_s:.2f}s). All other write '
                f'paths still rejected.')
        else:
            self.get_logger().warn(
                'monitor_only=false but allow_jog=false — jog path still '
                'gated; set ESTUN_ALLOW_JOG=1 or allow_jog:true in YAML to open it.')
        if self._monitor_only:
            pass  # already covered by the monitor_only warn above
        elif self._allow_power:
            self.get_logger().warn(
                f'POWER WRITE PATH ENABLED — enable/disable/clear_alarm on '
                f'/robot/power_command will emit Robot/switchOn, Robot/switchOff, '
                f'and System/ClearError (source: {self._allow_power_source}). '
                f'No code path auto-enables — every enable requires an explicit '
                f'operator command.')
        else:
            self.get_logger().warn(
                'monitor_only=false but allow_power=false — power write path '
                'still gated; set ESTUN_ALLOW_POWER=1 or allow_power:true in YAML.')
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

    def _on_write_reject(self, msg):
        # Catch-all reject for every write topic OTHER than /robot/jog_command
        # and /robot/power_command (each has its own handler). monitor_only
        # closes the outer gate; no other write paths are implemented on
        # this branch regardless.
        family = 'write'
        if self._monitor_only:
            self._reject(family, 'monitor_only active',
                         extra={'payload': msg.data[:200]})
            return
        self._reject(family, 'non-jog/power write paths not implemented on this branch')

    # ── Power write path (enable / disable / clear_alarm) ──────────────

    # Captured verbs (single-arm S10-140; see PHASE 0 report):
    #   enable       →  {"ty": "Robot/switchOn"}
    #   disable      →  {"ty": "Robot/switchOff"}
    #   clear_alarm  →  {"ty": "System/ClearError"}
    # These are the "isarm==false" branches from useMultiarmWs — the
    # multi-arm shapes ({ty:"RobotCommand/..."} with a db array) do not
    # apply to this controller.
    _POWER_FRAMES = {
        'enable':      {'ty': 'Robot/switchOn'},
        'disable':     {'ty': 'Robot/switchOff'},
        'clear_alarm': {'ty': 'System/ClearError'},
    }

    def _on_power_command(self, msg):
        """Incoming /robot/power_command JSON: {"action": "enable" | "disable" |
        "clear_alarm"}.  Each is a one-shot with a fresh nonce.

        Gate matrix (monitor_only is the outer master gate on everything):
          - enable       : monitor_only=false AND allow_power=true
          - disable      : monitor_only=false AND allow_power=true
          - clear_alarm  : monitor_only=false AND allow_power=true
        Safing (disable, clear_alarm) is intentionally NOT additionally
        gated by allow_jog — an operator with jog closed but power open
        must still be able to bring an unexpectedly-enabled arm down and
        clear an alarm. Enable is the one command with no fallback path.

        Safety invariants (see module docstring):
          1. This function is the ONLY place that sends Robot/switchOn.
             No retry, no auto-enable-on-startup, no auto-enable-on-reconnect.
          2. Disable/clear_alarm reach the wire under the same gate;
             they are never rejected on jog-gate state.
          3. If a jog is active when disable arrives, stopJog first,
             then Robot/switchOff.
        """
        family = 'power'
        if self._monitor_only:
            self._reject(family, 'monitor_only active',
                         extra={'payload': msg.data[:200]})
            return
        if not self._allow_power:
            self._reject(family, 'allow_power gate closed',
                         extra={'payload': msg.data[:200]})
            return
        if not self._connected:
            self._reject(family, 'ws not connected')
            return

        try:
            d = json.loads(msg.data)
        except Exception as e:
            self._reject(family, f'invalid JSON: {e}')
            return

        action = str(d.get('action', '')).lower()
        frame_tmpl = self._POWER_FRAMES.get(action)
        if frame_tmpl is None:
            self._reject(family, f'unknown action {action!r} '
                                 f'(expected enable/disable/clear_alarm)')
            return

        # Invariant #3: safe motion before the disable frame reaches
        # the wire. stopJog is idempotent (no-op if no jog active).
        if action == 'disable':
            self._stop_jog(reason='disable command')

        frame = dict(frame_tmpl)
        frame['id'] = self._new_nonce()
        try:
            if not self._send(frame):
                self._reject(family, 'send returned False',
                             extra={'action': action})
                return
        except Exception as e:
            self.get_logger().warn(f'Robot/{action} send failed: {e}')
            self._reject(family, f'send raised: {e}', extra={'action': action})
            return
        self.get_logger().info(
            f'power {action}: {frame["ty"]} sent (id={frame["id"]}) — '
            f'state before={self._state_code}({self._state_name!r})')

    # ── Jog write path ─────────────────────────────────────────

    def _writes_allowed_for_jog(self):
        return (not self._monitor_only) and self._allow_jog

    def _new_nonce(self):
        # UI-style monotonic id: 'mrkno' + base36 ms timestamp + short random.
        # Fresh per frame; never reused within a session.
        ts_ms = int(time.time() * 1000)
        digits = '0123456789abcdefghijklmnopqrstuvwxyz'
        n, buf = ts_ms, ''
        while n:
            n, r = divmod(n, 36)
            buf = digits[r] + buf
        return f'mrkno{buf or "0"}{os.urandom(3).hex()}'

    def _on_jog_command(self, msg):
        """Incoming /robot/jog_command JSON. Four shapes accepted:
        - Incremental (angle-bounded, driver owns stop timing):
            {"mode":"joint","axis":<1-6>,"delta_deg":<±float, |x|≤5>}
        - Continuous hold (start OR refresh):
            {"mode":"joint"|"cartesian","axis":<1-6>,"direction":±1,
             "speed_pct":<1..100>,"hold":true}
        - Explicit release (also handled by staleness after 300 ms):
            {"hold":false}     or    {"stop":true}
        - Legacy velocity (kept for compat):
            {"mode":"joint","axis":<1-6>,"direction":±1,"speed":<1..100>,"step":<abs_rad>}
        Cartesian mode (mode:2) is gated behind allow_cartesian_jog."""
        family = 'jog'
        if self._monitor_only:
            self._reject(family, 'monitor_only active',
                         extra={'payload': msg.data[:200]})
            return
        if not self._allow_jog:
            self._reject(family, 'allow_jog gate closed',
                         extra={'payload': msg.data[:200]})
            return
        if not self._connected:
            self._reject(family, 'ws not connected')
            return

        try:
            d = json.loads(msg.data)
        except Exception as e:
            self._reject(family, f'invalid JSON: {e}')
            return

        # ── Release / stop path takes ABSOLUTE priority ─────────────
        # No session guards. A release always ends the current jog,
        # even if the hold_id / seq / client_ts don't parse. This is
        # the whole point of the "stop must preempt, not queue" fix.
        if d.get('hold') is False or d.get('stop') is True:
            with self._jog_lock:
                self._stop_jog_locked(reason='release cmd')
            return

        # ── Staleness for refresh messages ──────────────────────────
        # Client and driver run on different machines (browser vs
        # Jetson) with un-synchronised clocks — the earlier build
        # measured ~920 ms skew on the operator's tablet, and any
        # absolute cross-clock comparison silently drops legitimate
        # refreshes. Staleness protection is therefore done ONLY on
        # clock-free evidence:
        #   1. `seq`     — monotonic per session; ≤ last processed → drop.
        #   2. `hold_id` — released session's stragglers are dropped.
        #   3. The driver's own freshness deadman ticks on the driver's
        #      own clock (inter-arrival gap in _on_jog_supervise) and
        #      catches genuinely stalled sessions.
        # `client_ts_ms` is accepted for compatibility but never used
        # in a comparison against server time.
        is_hold_refresh = (d.get('hold') is True)

        # ── Session tracking for refresh messages ───────────────────
        # A refresh whose hold_id ≠ the driver's active hold_id is
        # from a released session — discard silently. A refresh with
        # seq ≤ last-processed is out-of-order or a duplicate — also
        # discard. Only enforced when a session is active AND the
        # inbound message declares a hold_id.
        hold_id = d.get('hold_id')
        try:
            seq_in = int(d.get('seq') or 0)
        except (TypeError, ValueError):
            seq_in = 0
        if is_hold_refresh and hold_id is not None:
            with self._jog_lock:
                active = self._jog_active_hold_id
                if active is not None and hold_id != active:
                    # From an old session — the current session was
                    # started under a different id. Ignore.
                    return
                if active is not None and seq_in <= self._jog_last_seq:
                    # Out-of-order / duplicate. Ignore.
                    return
                # Straggler-restart guard: after a session ends, some
                # refresh POSTs may already be in the frontend's HTTP
                # queue. When they arrive with the released hold_id
                # and active is None, the previous logic would treat
                # them as a fresh session start. Latch the released id
                # and reject.
                if active is None and hold_id == self._jog_released_hold_id:
                    return

        mode_s = str(d.get('mode', 'joint')).lower()
        if mode_s == 'cartesian':
            if not self._allow_cartesian_jog:
                self._reject(family, 'allow_cartesian_jog gate closed — cartesian pending validation')
                return
            if d.get('pulse') is True:
                self._start_cart_pulse(d)
            else:
                self._start_or_refresh_continuous(d, mode_s)
            return
        if mode_s != 'joint':
            self._reject(family, f'mode {mode_s!r} not implemented (joint or cartesian only)')
            return

        try:
            axis = int(d.get('axis', 0))
        except (TypeError, ValueError):
            self._reject(family, f'axis not int: {d.get("axis")!r}')
            return
        if not (1 <= axis <= 6):
            self._reject(family, f'axis out of range [1..6]: {axis}')
            return

        # Incremental (angle-bounded) path takes precedence when delta_deg
        # is present — this is what the IncrementalJogPanel publishes.
        if d.get('delta_deg') is not None:
            self._start_increment_jog(axis, d)
            return

        # Continuous hold path — 'hold':true, or the legacy velocity shape
        # (direction + speed_pct/speed).
        if d.get('hold') is True or ('direction' in d and ('speed_pct' in d or 'speed' in d)):
            self._start_or_refresh_continuous(d, mode_s)
            return

        # If we get here, the message was joint-mode but had neither
        # delta_deg nor hold/direction+speed — nothing to act on.
        self._reject(family, 'joint jog cmd missing delta_deg or hold/direction+speed_pct',
                     extra={'payload': msg.data[:200]})

    def _start_or_refresh_continuous(self, d, mode_s):
        """Continuous hold-to-jog. First fresh command sends Robot/jog and
        starts the supervise timer. Same-axis + same-direction refreshes
        only update _jog_last_cmd_ts (no new Robot/jog per tick). Axis or
        direction change: stopJog first, then new Robot/jog. Explicit
        release or 300 ms staleness ends the hold via _on_jog_supervise.
        mode_s is 'joint' (index 1..6 = J1..J6) or 'cartesian'
        (index 1..6 = X,Y,Z,RX,RY,RZ; gate-guarded upstream)."""
        family = 'jog'
        # Session metadata for stale-drop bookkeeping. Missing values
        # are fine — the caller may be a legacy client without the
        # session fields; the seq/hold_id updates below simply skip.
        hold_id = d.get('hold_id')
        try:
            seq_in = int(d.get('seq') or 0)
        except (TypeError, ValueError):
            seq_in = 0
        try:
            axis = int(d.get('axis', 0))
        except (TypeError, ValueError):
            self._reject(family, f'axis not int: {d.get("axis")!r}')
            return
        if not (1 <= axis <= 6):
            self._reject(family, f'axis out of range [1..6]: {axis}')
            return
        try:
            direction = int(d.get('direction', 0))
        except (TypeError, ValueError):
            direction = 0
        if direction not in (-1, 1):
            self._reject(family, f'direction not in {{-1,+1}}: {direction}')
            return
        # Accept both speed_pct (new) and speed (legacy 1..100) alongside
        # the legacy fractional 0..1 speed field if some future caller
        # sends it. speed_pct always wins if present.
        speed_pct = d.get('speed_pct', d.get('speed', 0.0))
        try:
            speed_pct = float(speed_pct)
        except (TypeError, ValueError):
            speed_pct = 0.0
        if 0.0 < speed_pct <= 1.0:
            # Fractional 0..1 → % (legacy quirk).
            speed_pct *= 100.0
        speed_pct = max(0.0, min(100.0, speed_pct))
        if speed_pct <= 0.0:
            with self._jog_lock:
                self._stop_jog_locked(reason='zero-speed hold cmd')
            return

        # Cap: effective speed frac = min(ui_pct/100, jog_speed_cap).
        effective_frac = min(speed_pct / 100.0, self._jog_speed_cap)
        signed_speed = direction * effective_frac

        # For joint mode: pre-emptive limit clamp using LIVE angle. Stop
        # commanding motion if this jog would carry us past limit − margin.
        if mode_s == 'joint':
            if self._last_posture_ts <= 0.0:
                self._reject(family, 'no posture reading yet — refusing to hold-jog blind')
                return
            current_deg = self._joint_deg[axis-1]
            limit = self._joint_limit_deg[axis-1]
            margin = self._joint_limit_margin_deg
            safe_edge = limit - margin
            # Direction-aware check: only reject when we'd be pushing PAST
            # the far edge in the commanded direction.
            if direction > 0 and current_deg >= safe_edge:
                self._reject(family,
                             f'clamp: J{axis} at {current_deg:+.2f}° already past +{safe_edge:.2f}° — hold rejected')
                return
            if direction < 0 and current_deg <= -safe_edge:
                self._reject(family,
                             f'clamp: J{axis} at {current_deg:+.2f}° already past -{safe_edge:.2f}° — hold rejected')
                return

        target_mode = 'continuous' if mode_s == 'joint' else 'continuous_cart'
        robot_jog_mode = 1 if mode_s == 'joint' else 2  # captured protocol values

        with self._jog_lock:
            now = time.time()

            # Refresh path — same mode/axis/direction → keep the jog alive
            # without re-sending Robot/jog. The captured protocol treats a
            # duplicate Robot/jog while active as an error ("100/robot
            # state is not ready" observed 2026-07-14); heartbeats are
            # what keep motion alive after the first frame.
            if (self._jog_active
                and self._jog_mode == target_mode
                and self._jog_index == axis
                and self._jog_direction == direction):
                self._jog_last_cmd_ts = now
                # Latch the highest seq we've processed for this session
                # so out-of-order refreshes get dropped upstream.
                if seq_in > self._jog_last_seq:
                    self._jog_last_seq = seq_in
                # If the speed slider changed enough to notice, roll it
                # in on the next frame — but we don't re-send Robot/jog
                # per tick (protocol constraint), so this only affects a
                # future direction/axis change.
                self._jog_signed_speed = signed_speed
                return

            # Different jog running → stop it first.
            if self._jog_active:
                self._stop_jog_locked(reason='hold transition')

            frame = {
                'ty': 'Robot/jog',
                'db': {
                    'mode':     robot_jog_mode,
                    'speed':    signed_speed,
                    'index':    axis,
                    # TODO Tool-frame; 0/0 = User Coord0 (captured default).
                    'coorType': 0,
                    'coorId':   0,
                },
                'id': self._new_nonce(),
            }
            try:
                if not self._send(frame):
                    self._reject(family, 'send returned False')
                    return
            except Exception as e:
                self.get_logger().warn(f'Robot/jog send failed: {e}')
                self._stop_jog_locked(reason='send failed')
                return
            self._jog_active = True
            self._jog_mode = target_mode
            self._jog_index = axis
            self._jog_direction = direction
            self._jog_signed_speed = signed_speed
            self._jog_last_cmd_ts = now
            self._jog_last_hb_ts = now
            # Latch this session's identity so future refreshes with
            # this hold_id + increasing seq are accepted, and stragglers
            # from a previous session (or refreshes arriving after this
            # session is later stopped) are silently dropped. A NEW
            # hold_id also clears the released-latch — the operator's
            # next press regenerates the id.
            self._jog_active_hold_id = hold_id
            self._jog_last_seq = seq_in
            self._jog_released_hold_id = None
            if self._jog_supervise_timer is None:
                self._jog_supervise_timer = self.create_timer(0.05, self._on_jog_supervise)
            self.get_logger().info(
                f'continuous hold: {mode_s} axis={axis} dir={direction:+d} '
                f'speed_frac={effective_frac:.3f} (ui {speed_pct:.0f}% capped at {self._jog_speed_cap:.2f}) '
                f'hold_id={hold_id} seq={seq_in}')

    def _start_cart_pulse(self, d):
        """Cartesian tap — fixed 150 ms pulse in mode:2. Justification:
        we have no measured TCP velocity yet, so mapping a step size (mm
        or deg) to a duration would compound unknowns. A fixed 150 ms
        pulse is bounded by driver+controller stopJog and gives a
        consistent nudge regardless of the UI step selection. The step
        chip stays visible in the pendant so the pattern is compatible
        with a future speed-cal upgrade — swap the constant for a
        step-size-derived duration then.

        Reuses the joint-increment plumbing: one-shot threading.Timer
        for the stop, supervise timer for heartbeat + freshness backup,
        and the same _stop_jog_locked teardown. The per-tick joint-
        limit clamp in _on_jog_supervise applies to 'continuous_cart'
        already, and this mode ('cart_pulse') shares that dispatch."""
        family = 'jog'
        try:
            axis = int(d.get('axis', 0))
        except (TypeError, ValueError):
            self._reject(family, f'axis not int: {d.get("axis")!r}')
            return
        if not (1 <= axis <= 6):
            self._reject(family, f'axis out of range [1..6]: {axis}')
            return
        try:
            direction = int(d.get('direction', 0))
        except (TypeError, ValueError):
            direction = 0
        if direction not in (-1, 1):
            self._reject(family, f'direction not in {{-1,+1}}: {direction}')
            return
        speed_pct = d.get('speed_pct', d.get('speed', 0.0))
        try:
            speed_pct = float(speed_pct)
        except (TypeError, ValueError):
            speed_pct = 0.0
        if 0.0 < speed_pct <= 1.0:
            speed_pct *= 100.0
        speed_pct = max(0.0, min(100.0, speed_pct))
        if speed_pct <= 0.0:
            self._reject(family, 'cart pulse: speed_pct ≤ 0')
            return
        effective_frac = min(speed_pct / 100.0, self._jog_speed_cap)
        signed_speed = direction * effective_frac
        duration_s = 0.150  # fixed pulse; see method docstring.

        # Pre-emptive limit check across all joints — we can't project
        # cartesian motion into joint space cheaply, so refuse when any
        # joint is already at its safe edge.
        if self._last_posture_ts <= 0.0:
            self._reject(family, 'cart pulse: no posture reading yet')
            return
        margin = self._joint_limit_margin_deg
        for i in range(6):
            safe_edge = self._joint_limit_deg[i] - margin
            if abs(self._joint_deg[i]) >= safe_edge:
                self._reject(family,
                             f'cart pulse clamp: J{i+1} at {self._joint_deg[i]:+.2f}° '
                             f'exceeds ±{safe_edge:.2f}° — refuse to pulse')
                return

        with self._jog_lock:
            if self._jog_active:
                self._reject(family,
                             f'busy — {self._jog_mode} jog on J{self._jog_index} still in flight')
                return

            frame = {
                'ty': 'Robot/jog',
                'db': {
                    'mode':     2,           # 2 = cartesian jog
                    'speed':    signed_speed,
                    'index':    axis,        # 1..6 = X,Y,Z,RX,RY,RZ
                    'coorType': 0,           # 0 = User frame
                    'coorId':   0,           # Coordinate0 (Tool frame TBD)
                },
                'id': self._new_nonce(),
            }
            now = time.time()
            try:
                if not self._send(frame):
                    self._reject(family, 'send returned False')
                    return
            except Exception as e:
                self.get_logger().warn(f'cart pulse Robot/jog send failed: {e}')
                self._stop_jog_locked(reason='send failed')
                return
            self._jog_active = True
            # Reuse 'continuous_cart' so the supervise tick's live-limit
            # clamp for cartesian applies during the pulse too.
            self._jog_mode = 'continuous_cart'
            self._jog_index = axis
            self._jog_direction = direction
            self._jog_signed_speed = signed_speed
            self._jog_last_cmd_ts = now
            self._jog_last_hb_ts = now
            self._jog_increment_end_ts = now + duration_s
            self._jog_increment_delta_deg = 0.0  # unused for cart
            if self._jog_supervise_timer is None:
                self._jog_supervise_timer = self.create_timer(0.05, self._on_jog_supervise)
            self._jog_increment_stop_timer = threading.Timer(
                duration_s, self._stop_jog_from_expiry)
            self._jog_increment_stop_timer.daemon = True
            self._jog_increment_stop_timer.start()
            axis_label = ['X', 'Y', 'Z', 'RX', 'RY', 'RZ'][axis - 1]
            self.get_logger().info(
                f'cart pulse: {axis_label}{"+" if direction > 0 else "-"} @ '
                f'speed_frac={effective_frac:.3f} for {duration_s*1000:.0f}ms')

    def _start_increment_jog(self, axis, d):
        """Incremental (angle-bounded) jog. Driver owns the stop timer;
        if the browser dies mid-move the freshness deadman + heartbeat
        starvation on the controller side still stop the arm."""
        family = 'jog'
        try:
            delta_deg = float(d.get('delta_deg'))
        except (TypeError, ValueError):
            self._reject(family, f'delta_deg not float: {d.get("delta_deg")!r}')
            return
        if not (abs(delta_deg) > 1e-3):
            self._reject(family, f'delta_deg ~ 0: {delta_deg}')
            return
        if abs(delta_deg) > self._jog_inc_max_delta_deg:
            self._reject(family,
                         f'|delta_deg| exceeds max ({self._jog_inc_max_delta_deg}°): {delta_deg}')
            return

        # Limit clamp: reject if commanded target would exit the safe
        # envelope (per-joint ±limit_deg with margin subtracted). The
        # commanded angle is *current* + delta_deg — reading current from
        # the most recent RobotPosture frame the mirror captured. If we
        # haven't seen posture yet (arm was disabled at connect), reject
        # rather than command blind.
        if self._last_posture_ts <= 0.0:
            self._reject(family, 'no posture reading yet — refusing to command blind')
            return
        current_deg = self._joint_deg[axis-1]
        target_deg = current_deg + delta_deg
        limit = self._joint_limit_deg[axis-1]
        margin = self._joint_limit_margin_deg
        if abs(target_deg) > (limit - margin):
            self._reject(family,
                         f'clamp: J{axis} target {target_deg:+.2f}° exceeds ±{limit-margin:.2f}° '
                         f'(limit ±{limit}, margin {margin})',
                         extra={'current_deg': current_deg, 'delta_deg': delta_deg})
            return

        # Busy check — only one jog at a time. Simpler than queueing.
        with self._jog_lock:
            if self._jog_active:
                self._reject(family,
                             f'busy — {self._jog_mode} jog on J{self._jog_index} still in flight')
                return

            speed_frac = min(self._jog_inc_speed_frac, self._jog_speed_cap)
            max_speed = self._max_joint_speed_degps[axis-1]
            duration_s = abs(delta_deg) / max(1e-3, speed_frac * max_speed)
            signed_speed = (1.0 if delta_deg > 0.0 else -1.0) * speed_frac

            # NOTE on sign: /joint_states is a straight deg→rad passthrough
            # of controller angles, and the URDF's J3/J5 axis flips render
            # the twin to match the physical arm under that convention.
            # So dashboard "+" ↔ controller "+" ↔ twin "+" — no per-joint
            # inversion here. (Same reasoning as the velocity path.)
            frame = {
                'ty': 'Robot/jog',
                'db': {
                    'mode':     1,
                    'speed':    signed_speed,
                    'index':    axis,
                    'coorType': 0,
                    'coorId':   0,
                },
                'id': self._new_nonce(),
            }
            now = time.time()
            try:
                if not self._send(frame):
                    self._reject(family, 'send returned False')
                    return
            except Exception as e:
                self.get_logger().warn(f'increment Robot/jog send failed: {e}')
                self._stop_jog_locked(reason='send failed')
                return
            self._jog_active = True
            self._jog_mode = 'increment'
            self._jog_index = axis
            self._jog_last_cmd_ts = now
            self._jog_last_hb_ts = now
            self._jog_increment_end_ts = now + duration_s
            self._jog_increment_delta_deg = delta_deg
            if self._jog_supervise_timer is None:
                self._jog_supervise_timer = self.create_timer(0.05, self._on_jog_supervise)
            # PRIMARY stop mechanism: one-shot wall-clock timer that
            # unconditionally fires _stop_jog at duration_s regardless
            # of the supervise tick's phase. The supervise timer's
            # end-check remains as a fallback in case this thread is
            # somehow blocked; the controller-side heartbeat starvation
            # is the third and final backup.
            self._jog_increment_stop_timer = threading.Timer(
                duration_s, self._stop_jog_from_expiry)
            self._jog_increment_stop_timer.daemon = True
            self._jog_increment_stop_timer.start()
            self.get_logger().info(
                f'increment jog: J{axis} {delta_deg:+.2f}° @ speed_frac={speed_frac:.2f} '
                f'(max {max_speed}°/s) → duration={duration_s*1000:.0f}ms, '
                f'current={current_deg:+.2f}° → target={target_deg:+.2f}°')

    def _stop_jog_from_expiry(self):
        """Fires from the threading.Timer scheduled by _start_increment_jog.
        Acquires _jog_lock via _stop_jog and sends Robot/stopJog. Safe
        to call even if _jog_active has already been cleared (double-stop
        is a no-op)."""
        self._stop_jog(reason=(f'increment expiry '
                                f'(J{self._jog_index} {self._jog_increment_delta_deg:+.2f}°)'))

    def _on_jog_supervise(self):
        """50 ms tick while a jog is active. Behavior depends on mode:
        - 'increment': primary stop is the wall-clock one-shot timer; this
          tick is a redundant fallback that also fires on freshness expiry.
        - 'continuous' / 'continuous_cart': 300 ms freshness deadman is
          the primary stop when the browser stops refreshing (browser
          crash / tab close / touch-cancel that didn't fire release).
          Live limit clamp: for joint mode, if the arm's current angle
          crosses (±limit − margin) in the commanded direction, stop.
        - 'velocity' (legacy): same freshness behavior as continuous.
        Heartbeats fire in all modes when age ≥ jog_heartbeat_s."""
        with self._jog_lock:
            if not self._jog_active:
                return
            now = time.time()
            if self._jog_mode == 'increment':
                if now >= self._jog_increment_end_ts:
                    self._stop_jog_locked(
                        reason=f'increment complete '
                               f'(J{self._jog_index} {self._jog_increment_delta_deg:+.2f}°, '
                               f'ran {(now - self._jog_last_cmd_ts)*1000:.0f}ms)')
                    return
                if (now - self._jog_last_cmd_ts) > self._jog_freshness_s:
                    self._stop_jog_locked(
                        reason=f'increment freshness fallback {now - self._jog_last_cmd_ts:.2f}s')
                    return
            else:
                # Continuous / velocity — freshness deadman is primary.
                if (now - self._jog_last_cmd_ts) > self._jog_freshness_s:
                    self._stop_jog_locked(
                        reason=f'hold staleness {now - self._jog_last_cmd_ts:.2f}s')
                    return
                # Live limit clamp during a joint or cartesian hold. In
                # cartesian mode the driver has no idea which joints are
                # moving, so it stops if ANY joint is within margin of
                # its ±limit — conservative but safe. /joint_states
                # streams throughout the motion so this check has fresh
                # data on every 50 ms tick.
                if self._jog_mode == 'continuous':
                    ax = self._jog_index
                    if 1 <= ax <= 6:
                        current = self._joint_deg[ax - 1]
                        limit = self._joint_limit_deg[ax - 1]
                        margin = self._joint_limit_margin_deg
                        safe_edge = limit - margin
                        if self._jog_direction > 0 and current >= safe_edge:
                            self._stop_jog_locked(
                                reason=f'limit approach J{ax} at {current:+.2f}° (+{safe_edge:.2f}°)')
                            return
                        if self._jog_direction < 0 and current <= -safe_edge:
                            self._stop_jog_locked(
                                reason=f'limit approach J{ax} at {current:+.2f}° (-{safe_edge:.2f}°)')
                            return
                elif self._jog_mode == 'continuous_cart':
                    for i in range(6):
                        current = self._joint_deg[i]
                        limit = self._joint_limit_deg[i]
                        margin = self._joint_limit_margin_deg
                        safe_edge = limit - margin
                        if abs(current) >= safe_edge:
                            self._stop_jog_locked(
                                reason=f'cart limit approach J{i+1} at {current:+.2f}° '
                                       f'(|>{safe_edge:.2f}°|)')
                            return
            if (now - self._jog_last_hb_ts) >= self._jog_hb_s:
                try:
                    self._send({'ty': 'Robot/jogHeartbeat', 'id': self._new_nonce()})
                    self._jog_last_hb_ts = now
                except Exception as e:
                    self.get_logger().warn(f'jogHeartbeat send failed: {e}')
                    self._stop_jog_locked(reason='hb send failed')

    def _stop_jog_locked(self, reason=''):
        """Send Robot/stopJog and tear down the supervise timer. Caller
        must hold self._jog_lock. Safe to call when no jog is active."""
        was_active = self._jog_active
        self._jog_active = False
        self._jog_mode = None
        self._jog_index = 0
        self._jog_direction = 0
        self._jog_signed_speed = 0.0
        self._jog_increment_end_ts = 0.0
        self._jog_increment_delta_deg = 0.0
        # Kill the session — any refresh still in flight from this
        # session that reaches _on_jog_command AFTER this stop is
        # dropped by the hold_id / seq guards. Latch the just-released
        # hold_id so a straggler with that id can't restart the session
        # via the "active is None" code path.
        if self._jog_active_hold_id is not None:
            self._jog_released_hold_id = self._jog_active_hold_id
        self._jog_active_hold_id = None
        self._jog_last_seq = 0
        # Cancel the one-shot expiry timer if we're stopping via any
        # other path (freshness deadman fallback, disconnect, shutdown,
        # zero-cmd, or a duplicate call). threading.Timer.cancel() is a
        # no-op if the timer already fired.
        if self._jog_increment_stop_timer is not None:
            try:
                self._jog_increment_stop_timer.cancel()
            except Exception:
                pass
            self._jog_increment_stop_timer = None
        if self._jog_supervise_timer is not None:
            try:
                self._jog_supervise_timer.cancel()
            except Exception:
                pass
            self._jog_supervise_timer = None
        if was_active and self._connected and self._ws is not None:
            try:
                self._send({'ty': 'Robot/stopJog', 'id': self._new_nonce()})
                self.get_logger().info(f'Robot/stopJog sent ({reason})')
            except Exception as e:
                self.get_logger().warn(f'Robot/stopJog send failed: {e}')

    def _stop_jog(self, reason=''):
        with self._jog_lock:
            self._stop_jog_locked(reason=reason)

    def _publish_mode(self):
        body = {
            'monitor_only':   self._monitor_only,
            'allow_jog':      self._allow_jog,
            'allow_jog_source': self._allow_jog_source,
            'allow_cartesian_jog': self._allow_cartesian_jog,
            'allow_cart_source': self._allow_cart_source,
            'allow_power':    self._allow_power,
            'allow_power_source': self._allow_power_source,
            'jog_speed_cap':  self._jog_speed_cap,
            'jog_heartbeat_s': self._jog_hb_s,
            'jog_freshness_s': self._jog_freshness_s,
            'jog_active':     self._jog_active,
            'jog_mode':       self._jog_mode,
            'jog_index':      self._jog_index,
            'jog_direction':  self._jog_direction,
            'allow_cartesian_jog': self._allow_cartesian_jog,
            'ws_log_raw':     self._ws_log_raw,
            'ws_log_path':    self._ws_log_path,
            'rejections':     dict(self._rej_counts),
            'ip':             self._robot_ip,
            'port':           self._robot_port,
            'origin':         f'http://{self._robot_ip}:{self._ui_origin_port}',
            'ip_source':      self._ip_source,
            'connected':      self._connected,
            'enabled':        self._enabled,
            'enabling':       self._enabling,
            'state_code':     self._state_code,
            'state_name':     self._state_name,
            'alarm':          len(self._alarms) > 0,
            'alarm_count':    len(self._alarms),
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
        # Best-effort stopJog on the still-open socket before we drop it —
        # if we're mid-motion and the WS dies, the controller's own
        # heartbeat deadman is the ultimate stop, but sending our own
        # stopJog shortens the window.
        try:
            self._stop_jog(reason='ws disconnect')
        except Exception:
            pass
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
        elif topic == 'Error':
            self._on_error(db)
        # Other topics (WebCommand, ProjectState, RobotCoordinate,
        # ProjectStatus, web) are captured in the raw log but not
        # otherwise processed in this telemetry mirror.

    def _on_error(self, db):
        """publish/Error — db is a list of active alarms (empty when none).
        Mirror the count and the raw list into telemetry so the dashboard
        banner can show 'ALARM — [Clear Alarm]' before offering Enable."""
        if isinstance(db, list):
            self._alarms = db
            self._publish_status_blob()

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
        self._state_name = str(db.get('stateName', ''))
        was_enabled = self._enabled
        # Both state 2 ("Enabled") and state 3 (sub-state, still enabled)
        # are treated as enabled. state 1 is "Enabling" — the transient
        # that the dashboard banner uses to show ENABLING…
        self._enabled  = (state_int in (2, 3))
        self._enabling = (state_int == 1)
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
        # State-code map (observed): 0=Disabled 1=Enabling 2/3=Enabled.
        if self._enabled:
            mode_s.data = 'enabled'
        elif self._enabling:
            mode_s.data = 'enabling'
        else:
            mode_s.data = f'disabled(state={state_int})'
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
        if self._enabled:
            robot_mode = 'enabled'
        elif self._enabling:
            robot_mode = 'enabling'
        else:
            robot_mode = f'disabled(state={self._state_code})'
        blob = {
            'connected':     self._connected,
            'robot_mode':    robot_mode,
            'safety_mode':   'estop' if self._is_estop else 'normal',
            'status_flag':   self._state_code,
            'state_code':    self._state_code,
            'state_name':    self._state_name,
            'estop':         self._is_estop,
            'moving':        self._is_moving,
            'enabled':       self._enabled,
            'enabling':      self._enabling,
            'alarm':         len(self._alarms) > 0,
            'alarm_count':   len(self._alarms),
            'allow_power':   self._allow_power,
            'joints_deg':    list(self._joint_deg),
            'joints_rad':    list(self._joint_rad),
            'tcp_mm':        list(self._tcp_mm),
            'tcp_m':         list(self._tcp_m),
            'monitor_only':  self._monitor_only,
            'allow_jog':     self._allow_jog,
            'allow_cartesian_jog': self._allow_cartesian_jog,
            'jog_active':    self._jog_active,
            'jog_mode':      self._jog_mode,
            'jog_index':     self._jog_index,
            'jog_direction': self._jog_direction,
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
        # Stop any live jog before we drop the socket — SIGINT lands here
        # via rclpy's KeyboardInterrupt path in main().
        try:
            self._stop_jog(reason='node shutdown')
        except Exception:
            pass
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
