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

try:
    import numpy as _np
except ImportError:
    _np = None

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

# v2.3 subscribe burst — split into two phases to survive the
# controller-boot race. See connect_state.ConnectStateMachine.
#
# PROBE_TOPICS are safe to subscribe to WHILE the controller is still
# initializing: they don't touch the Robot plugin's joint-vector state,
# which is empty until EtherCAT slaves reach OP. Wire evidence (2026-07-
# controller-boot logs): subscribing to RobotPosture / RobotCoordinate
# ~16 ms after C2Control opens :9000 crashes firmware in Robot::step()
# via an empty Vector<double> index. RobotStatus is emitted directly by
# C2Control from the state machine, not from the RT loop, and is
# available immediately.
#
# FULL_TOPICS are added ONCE the readiness probe answers AND the grace
# period has elapsed. This is the topic set that used to be blasted
# unconditionally on connect.
PROBE_TOPICS = ['RobotStatus']
FULL_TOPICS = [
    'web', 'WebCommand', 'Error', 'ProjectState',
    'RobotPosture', 'RobotCoordinate', 'ProjectStatus',
]
# Kept for backward-compat with any importer.
SUBSCRIBE_TOPICS = PROBE_TOPICS + FULL_TOPICS

# ── Fitted DH table (standard convention) — Estun S10-140-ECO-V2 ──────
# Source: config/dh_fit_report.txt (stage-B fixed-xyz fit, pos RMS 0.025 mm
# on the held-out test set). Used only by SingularityGuard below to
# compute σ_min at live joint angles for the Cartesian-jog governor.
#
# Row per joint: (a_mm, alpha_deg, d_mm, theta_off_deg).
_FITTED_DH_STD = [
    (-0.00002,     90.00058,   325.89611, -179.99989),  # J1
    (-701.00394,    0.00028,  -579.68908,  -90.00022),  # J2
    (-538.58526,  180.00313,  -214.01833,   -0.00615),  # J3
    (-0.00374,    -89.99857, -1000.00000,  -90.00736),  # J4
    ( 0.00533,     89.99433,  -161.46726,  179.99693),  # J5
    (-0.00155,     -0.00674,   150.49959,    0.00152),  # J6
]
_FITTED_BASE_Z_MM = -139.89595


class SingularityGuard:
    """Computes σ_min of the 6×6 geometric Jacobian from live joint angles,
    and derives a speed scale for the Cartesian-jog governor.

    σ_min tracks how far the arm is from a singular configuration —
    smaller = closer to singularity, where a bounded TCP command demands
    unbounded joint velocity. Concretely, in the current wire capture of
    alarm 2015 the arm ran σ_min = 0.180 five seconds before the alarm,
    0.021 at 100 ms before, and 0.003 at the alarm itself — a ~60×
    degradation. Joint 1 was commanded at 1.57 rad/s (10× our
    speed_frac=0.15 cap) at that pose. The governor uses σ_min so we can
    stop the Cartesian jog BEFORE the controller's IK explodes joint
    velocity past its own acceleration limit and latches the 2015 alarm.

    Thresholds (soft / hard) come from the driver config; scale() returns
    1.0 when σ_min ≥ soft, 0.0 when σ_min ≤ hard, and a linear
    interpolation in between."""

    def __init__(self, dh_std=_FITTED_DH_STD, base_z_mm=_FITTED_BASE_Z_MM):
        self._dh = dh_std
        self._base_z_mm = base_z_mm

    def _dh_T(self, theta, d_mm, a_mm, alpha):
        # Standard DH: T = Rz(θ) · Tz(d) · Tx(a) · Rx(α).
        ct = math.cos(theta); st = math.sin(theta)
        ca = math.cos(alpha); sa = math.sin(alpha)
        return [
            [ct, -st*ca,  st*sa, a_mm*ct],
            [st,  ct*ca, -ct*sa, a_mm*st],
            [0.0,    sa,     ca, d_mm  ],
            [0.0,   0.0,    0.0, 1.0   ],
        ]

    def _matmul(self, A, B):
        return [[sum(A[i][k]*B[k][j] for k in range(4)) for j in range(4)] for i in range(4)]

    def _identity_with_base(self):
        T = [[1.0,0,0,0],[0,1.0,0,0],[0,0,1.0,self._base_z_mm],[0,0,0,1.0]]
        return T

    def sigma_min(self, q_deg):
        """Returns σ_min of the 6×6 geometric Jacobian at q_deg. Returns
        None if numpy isn't available (guard is then disabled — the
        driver falls back to the reactive joint-velocity backstop)."""
        if _np is None:
            return None
        # Forward-kinematics chain; store intermediate frames T_0..T_6
        # so we can extract each joint's z axis and origin for the
        # geometric Jacobian.
        T = self._identity_with_base()
        Ts = [T]
        for i in range(6):
            a_mm, alpha_deg, d_mm, theta_off_deg = self._dh[i]
            theta = math.radians(q_deg[i] + theta_off_deg)
            Ti = self._dh_T(theta, d_mm, a_mm, math.radians(alpha_deg))
            T = self._matmul(T, Ti)
            Ts.append(T)
        # End-effector position (mm)
        p_ee = [Ts[6][k][3] for k in range(3)]
        # Build Jacobian in meters (for linear part) and rad (for angular)
        J = [[0.0]*6 for _ in range(6)]
        for i in range(6):
            z  = [Ts[i][k][2] for k in range(3)]
            p  = [Ts[i][k][3] for k in range(3)]
            dp = [(p_ee[k] - p[k]) / 1000.0 for k in range(3)]   # to meters
            # cross(z, dp)
            J[0][i] = z[1]*dp[2] - z[2]*dp[1]
            J[1][i] = z[2]*dp[0] - z[0]*dp[2]
            J[2][i] = z[0]*dp[1] - z[1]*dp[0]
            J[3][i] = z[0]
            J[4][i] = z[1]
            J[5][i] = z[2]
        try:
            return float(_np.linalg.svd(_np.asarray(J), compute_uv=False).min())
        except Exception:
            return None

    @staticmethod
    def scale(sigma, soft, hard):
        """Linear ramp: 1.0 at ≥soft, 0.0 at ≤hard, linear between.
        Returns 1.0 when sigma is None (guard disabled) so we never
        accidentally freeze motion because the model can't compute."""
        if sigma is None:
            return 1.0
        if sigma >= soft:
            return 1.0
        if sigma <= hard:
            return 0.0
        return max(0.0, min(1.0, (sigma - hard) / (soft - hard)))


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
        # Two-tier speed cap. `jog_speed_cap` is the hardware-derived
        # upper bound: the point past which the DERIVED safety margins
        # (limit clamp, collision stop_mm, sigma governor) would no
        # longer keep worst-case stop-distance under a supervise-tick
        # budget. `operator_speed_limit` is the operationally-allowed
        # ceiling that the OPERATOR is permitted to reach today —
        # normally lower than the hardware cap so we roll speed up in
        # controlled steps. Effective_cap = min(jog_speed_cap,
        # operator_speed_limit). See YAML for the raise-condition
        # (Test B complete + one week clean at 0.25).
        self.declare_parameter('jog_speed_cap',        0.50)   # hardware-safe upper bound
        self.declare_parameter('operator_speed_limit', 0.25)   # operationally-allowed ceiling
        self.declare_parameter('jog_heartbeat_s', 0.4)         # Robot/jogHeartbeat cadence
        # Freshness deadman: no refresh within this window → Robot/stopJog.
        # 2026-07-17: bumped 0.3 → 0.5 to tolerate observed 672 ms
        # dashboard-side GIL stalls (json.dumps of the 10 KB state blob
        # starved the keepalive native thread mid-hold).
        # 2026-07-20: reverted 0.5 → 0.3 after the source-side fixes
        # landed (deepcopy+json.dumps offloaded onto a thread executor,
        # state broadcast dropped to 8 Hz while a jog hold is active).
        # With the stall source removed the tighter deadman is what we
        # want; the 0.5 loosening was a workaround, not a design
        # choice. The layered safety chain is UNCHANGED: browser
        # release → server publishes explicit stopJog (immediate);
        # server crash → this deadman fires; network stall → this
        # deadman fires.
        self.declare_parameter('jog_freshness_timeout_s', 0.3)
        # Latency and safety-factor inputs to the SPEED-SCALED margin
        # formulas below. Values chosen from wire measurements:
        #   - posture RX → guard reaction takes ~150 ms (three 50 ms
        #     supervise ticks worst case)
        #   - safety factor 1.5 as an engineering headroom
        self.declare_parameter('safety_latency_s', 0.150)
        self.declare_parameter('safety_factor', 1.5)
        # Anchor speed_frac at which the STATIC baseline margins (the
        # legacy 2 mm limit margin, 30 mm collision stop, 60 mm sigma
        # soft) were originally tuned. Dynamic margins scale linearly
        # in (speed_frac - baseline_speed_frac).
        self.declare_parameter('baseline_speed_frac', 0.15)

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

        # ── Cartesian-jog singularity + overspeed governor ──────────────
        # Wire evidence (alarm 2015 on 2026-07-15): a Cartesian X hold at
        # our speed_frac=0.15 drove the controller's IK to command Joint1
        # at 1.57 rad/s (≈10× our cap) as the arm approached a wrist
        # singularity — σ_min collapsed from 0.180 (5 s pre-alarm) → 0.021
        # (100 ms pre-alarm) → 0.003 (alarm). The governor stops or
        # scales the Cartesian jog before that final collapse. Applies
        # to continuous_cart and cart_pulse; joint-mode holds are
        # untouched (their per-joint cap already governs velocity).
        # Thresholds are logarithmic-ish (soft ≈ 3× hard); tuned so the
        # -100 ms danger point lands just above sigma_hard.
        self.declare_parameter('cart_sigma_soft', 0.060)  # begin scaling
        self.declare_parameter('cart_sigma_hard', 0.020)  # hard stop
        # Reactive backstop — if the controller's live joint velocity
        # spikes past this during OUR Cartesian hold, stop with reason
        # 'joint overspeed guard J<n>'. 1.5 rad/s is a compromise: below
        # the 2 rad/s that produced alarm 2015, and above what a bench
        # Cartesian jog at speed_frac=0.15 in a healthy region produces
        # (measured 0.3–0.5 rad/s peak-per-joint in the same session).
        self.declare_parameter('cart_joint_velocity_cap_radps', 1.5)
        # Mid-hold speed changes ramp, not step. Delta hysteresis avoids
        # spamming stop+restart cycles; up-ramp is capped per tick so a
        # pose that briefly re-opens (σ_min bounces back) can't
        # instantly slam speed to 100%.
        self.declare_parameter('cart_speed_change_min_delta', 0.10)   # 10%
        self.declare_parameter('cart_speed_up_ramp_per_tick', 0.25)   # 25%

        # ── Self-collision guard ────────────────────────────────────────
        # Capsule model of the arm + ground plane, distances checked per
        # supervise tick during ANY active jog (joint or cartesian).
        # Applied AFTER the per-joint limit clamp and the cartesian
        # singularity governor — this is the closest-approach guard.
        # Wire evidence (2026-07-14): the operator-side lockouts we've
        # seen have all been controller-side alarms; this guard is
        # preventive so we never even ask the controller to command a
        # motion that puts two links in contact. Direction-aware: a
        # jog moving AWAY from the closest pair is NOT stopped —
        # otherwise the operator gets wedged with every direction
        # refused when clearance is already thin.
        # Thresholds calibrated from the random-pose validation:
        #   warn=80 mm  — surfaces "SELF-COLLISION WARNING" toast;
        #                 amber tint on the offending pair in the twin;
        #                 jog continues.
        #   stop=30 mm  — stopJog with reason
        #                 'self-collision guard <a>-<b> at <d>mm';
        #                 red tint; recovery copy in the modal.
        self.declare_parameter('collision_warn_distance_mm', 80.0)
        self.declare_parameter('collision_stop_distance_mm', 30.0)
        # Env thresholds — separate from self/ground so the two can
        # diverge. Wire evidence 2026-07-15: env-guard was firing on
        # phantom geometry because the DH-FK misplaced intermediate
        # link frames; after the URDF-FK fix, env distances agree with
        # collision_monitor (raw-LiDAR arithmetic) within a few mm.
        # Tighter thresholds (env warn=50, stop=25) because the arm
        # moves through the workspace and 80mm was overzealous.
        self.declare_parameter('env_warn_distance_mm', 50.0)
        self.declare_parameter('env_stop_distance_mm', 25.0)
        # Config file lives beside the YAML params — resolved at init.
        self.declare_parameter('collision_capsules_yaml',
            '/home/teddy/cobot_ws/config/self_collision_capsules.yaml')
        self.declare_parameter('collision_enabled', True)
        # Ground plane z (mm) in the driver's base_link frame. The URDF
        # base_link is the base flange; a mounted arm sits some
        # distance above the physical floor. z=0 in base frame is the
        # flange, NOT the floor — that was today's wedge (the guard
        # thought every normal pose was at 87 mm from the "ground").
        # Default -300 mm assumes a 300 mm stand; fit an exact number
        # for your cell with scripts/fit_ground_plane.py and override
        # via the YAML params file.
        self.declare_parameter('ground_z_mm', -300.0)
        # DISABLE ground plane check by default until the Y-up / Z-up
        # frame convention mismatch between the URDF (Y-up) and the
        # ground half-space model (Z-up) is properly resolved. Wire
        # evidence 2026-07-15: after switching to URDF-native FK, the
        # startup sanity line reported -80mm ground clearance because
        # URDF-frame link Z values do not represent "height above the
        # floor" as the ground model assumed. Env-obstacle checks are
        # not affected — they compare capsule world coords directly
        # against zone OBB world coords in the same URDF frame.
        self.declare_parameter('ground_check_enabled', False)
        # Fallback override: when the escape-direction model finds NO
        # single-axis escape (deep pocket, or the model itself is
        # wrong), allow any joint-mode jog at this reduced speed. The
        # operator has an e-stop in hand and outranks a geometry model.
        # Logs LOUDLY on every override so we can review after the fact.
        self.declare_parameter('collision_fallback_speed_frac', 0.03)
        # Speed cap while in the warn / stop zone. Escape jogs go
        # through this cap so a slip never becomes a slam.
        self.declare_parameter('collision_escape_speed_frac', 0.06)

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

        # Program-execution write path (Part 2c, B1). Fourth gate,
        # SEPARATE from allow_jog and allow_power. Opens the family:
        #   - HTTP save (POST /api/robotcode + /api/robotjson/...)
        #   - project/run, /stop, /pause, /resume, /runStep,
        #     /setStartLine, /clearStartLine, /setBreakpoint,
        #     /clearBreakpoint
        #   - Robot/toAuto, Robot/toManual, Robot/setManualMoveRate,
        #     Robot/setAutoMoveRate  (mode switches + program speed cap)
        #   - System/ClearError  (also allowed under allow_power for the
        #     jog-side clear_alarm command — clearing an error is a
        #     safing action, not a moving one, but on the program path
        #     it appears here because the sequence is start-run-clear-run)
        # monitor_only stays the master gate. See PART_2C_ARCHITECTURE.md.
        self.declare_parameter('allow_move', False)

        # Cadence knobs.
        self.declare_parameter('recv_timeout_s', 5.0)   # matches posture.py
        self.declare_parameter('ping_on_timeout', True)
        self.declare_parameter('reconnect_backoff_s', 2.0)

        # ── Controller-boot race guards ────────────────────────────
        # We used to hammer the controller with the full subscribe
        # burst 16 ms after :9000 opened, which crashed firmware
        # during its own EtherCAT init — see connect_state.py header
        # for the full story. These knobs govern the fix:
        #   * grace_period_s: floor between WS-open and full subscribe
        #   * probe_interval_s: cadence of the lightweight readiness
        #     probe DURING the grace window
        #   * reconnect_backoff_max_s: cap on the exponential retry
        #     backoff (initial = reconnect_backoff_s above)
        #   * reconnect_healthy_reset_s: seconds a session must stay
        #     READY before we reset backoff to initial (short healthy
        #     sessions don't reset — the whole hazard was that we
        #     reconnected instantly on every restart)
        #   * crashloop_threshold / _window_s / _cooldown_s: N cycles
        #     inside window trigger a longer cool-down and a loud log
        self.declare_parameter('grace_period_s', 5.0)
        self.declare_parameter('probe_interval_s', 1.0)
        self.declare_parameter('reconnect_backoff_max_s', 30.0)
        self.declare_parameter('reconnect_healthy_reset_s', 60.0)
        self.declare_parameter('crashloop_threshold', 3)
        self.declare_parameter('crashloop_window_s', 120.0)
        self.declare_parameter('crashloop_cooldown_s', 120.0)

        # Rate-limit the "waiting for stream" log so a disabled robot
        # doesn't spam. In seconds.
        self.declare_parameter('disabled_log_period_s', 15.0)

        self._robot_ip     = str(self.get_parameter('robot_ip').value)
        self._robot_port   = int(self.get_parameter('robot_port').value)
        self._ui_origin_port = int(self.get_parameter('ui_origin_port').value)
        self._auto_connect = bool(self.get_parameter('auto_connect').value)
        self._monitor_only = bool(self.get_parameter('monitor_only').value)
        # Env override — mirrors ESTUN_ALLOW_JOG so the drop-in file at
        # /etc/default/roboai-estun can drive both gates from one place.
        # The systemd unit stays DISABLED at boot; when the operator
        # brings the driver up for a session, the env file supplies
        # both ESTUN_MONITOR_ONLY=false and ESTUN_ALLOW_JOG=1 and
        # motion is permitted for that session only.
        self._monitor_source = 'param'
        env_monitor = os.environ.get('ESTUN_MONITOR_ONLY')
        if env_monitor is not None:
            self._monitor_only = env_monitor.strip().lower() in ('1', 'true', 'yes', 'on')
            self._monitor_source = 'ESTUN_MONITOR_ONLY'
        self._ws_log_raw   = bool(self.get_parameter('ws_log_raw').value)
        self._recv_timeout = float(self.get_parameter('recv_timeout_s').value)
        self._ping_on_to   = bool(self.get_parameter('ping_on_timeout').value)
        self._reconn_backoff = float(self.get_parameter('reconnect_backoff_s').value)
        self._disabled_log_period = float(self.get_parameter('disabled_log_period_s').value)

        self._grace_period_s        = float(self.get_parameter('grace_period_s').value)
        self._probe_interval_s      = float(self.get_parameter('probe_interval_s').value)
        self._reconnect_backoff_max_s = float(self.get_parameter('reconnect_backoff_max_s').value)
        self._reconnect_healthy_reset_s = float(self.get_parameter('reconnect_healthy_reset_s').value)
        self._crashloop_threshold   = int(self.get_parameter('crashloop_threshold').value)
        self._crashloop_window_s    = float(self.get_parameter('crashloop_window_s').value)
        self._crashloop_cooldown_s  = float(self.get_parameter('crashloop_cooldown_s').value)

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
        self._jog_speed_cap        = float(self.get_parameter('jog_speed_cap').value)
        self._operator_speed_limit = float(self.get_parameter('operator_speed_limit').value)
        # Effective ceiling — the operator can never command past this.
        # Displayed as "capped at X%" in the UI slider.
        self._effective_speed_cap  = min(self._jog_speed_cap,
                                         self._operator_speed_limit)
        self._jog_hb_s        = float(self.get_parameter('jog_heartbeat_s').value)
        self._jog_freshness_s = float(self.get_parameter('jog_freshness_timeout_s').value)
        self._jog_inc_speed_frac = float(self.get_parameter('jog_increment_speed_frac').value)
        self._max_joint_speed_degps = list(self.get_parameter('max_joint_speed_degps').value)
        self._joint_limit_deg = list(self.get_parameter('joint_limit_deg').value)
        self._joint_limit_margin_deg = float(self.get_parameter('joint_limit_margin_deg').value)
        self._jog_inc_max_delta_deg = float(self.get_parameter('jog_increment_max_delta_deg').value)
        # Inputs to the SPEED-SCALED margin formulas.
        self._safety_latency_s     = float(self.get_parameter('safety_latency_s').value)
        self._safety_factor        = float(self.get_parameter('safety_factor').value)
        self._baseline_speed_frac  = float(self.get_parameter('baseline_speed_frac').value)

        self._cart_sigma_soft   = float(self.get_parameter('cart_sigma_soft').value)
        self._cart_sigma_hard   = float(self.get_parameter('cart_sigma_hard').value)
        self._cart_joint_v_cap  = float(self.get_parameter('cart_joint_velocity_cap_radps').value)
        self._cart_speed_min_delta   = float(self.get_parameter('cart_speed_change_min_delta').value)
        self._cart_speed_up_per_tick = float(self.get_parameter('cart_speed_up_ramp_per_tick').value)

        self._coll_warn_mm   = float(self.get_parameter('collision_warn_distance_mm').value)
        self._coll_stop_mm   = float(self.get_parameter('collision_stop_distance_mm').value)
        self._env_warn_mm    = float(self.get_parameter('env_warn_distance_mm').value)
        self._env_stop_mm    = float(self.get_parameter('env_stop_distance_mm').value)
        self._coll_yaml_path = str(self.get_parameter('collision_capsules_yaml').value)
        self._coll_enabled   = bool(self.get_parameter('collision_enabled').value)
        self._ground_z_mm    = float(self.get_parameter('ground_z_mm').value)
        self._ground_check_enabled = bool(self.get_parameter('ground_check_enabled').value)
        self._coll_fallback_frac = float(self.get_parameter('collision_fallback_speed_frac').value)
        self._coll_escape_frac   = float(self.get_parameter('collision_escape_speed_frac').value)

        self._allow_power = bool(self.get_parameter('allow_power').value)
        self._allow_power_source = 'param'
        env_power = os.environ.get('ESTUN_ALLOW_POWER')
        if env_power is not None:
            self._allow_power = env_power.strip().lower() in ('1', 'true', 'yes', 'on')
            self._allow_power_source = 'ESTUN_ALLOW_POWER'

        self._allow_move = bool(self.get_parameter('allow_move').value)
        self._allow_move_source = 'param'
        env_move = os.environ.get('ESTUN_ALLOW_MOVE')
        if env_move is not None:
            self._allow_move = env_move.strip().lower() in ('1', 'true', 'yes', 'on')
            self._allow_move_source = 'ESTUN_ALLOW_MOVE'

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
        # Connection-lifecycle state machine. Owns the grace-period /
        # readiness-probe / exponential-backoff / crash-loop rules
        # that keep us from re-crashing a controller that's still
        # coming up. Fully unit-tested in test/test_connect_state.py.
        from estun_driver.connect_state import ConnectStateMachine
        self._conn_sm = ConnectStateMachine(
            grace_period_s=self._grace_period_s,
            probe_interval_s=self._probe_interval_s,
            backoff_initial_s=self._reconn_backoff,
            backoff_max_s=self._reconnect_backoff_max_s,
            backoff_reset_healthy_s=self._reconnect_healthy_reset_s,
            crashloop_threshold=self._crashloop_threshold,
            crashloop_window_s=self._crashloop_window_s,
            crashloop_cooldown_s=self._crashloop_cooldown_s,
        )
        # Rate-limit the "controller appears to be restarting" log so
        # it fires once per crash-loop entry, not every tick.
        self._crashloop_logged = False

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
        # alarms. Each entry (from wire captures) is
        #   [severity:int, code:int, ts:float, text:str]
        # Observed codes (2026-07 logs):
        #   2000  "Joint<n> servo status error, error code: 0x<hex>."
        #   2002  "Joint<n> exceeded limit."               ← the operator's case
        #   2006  "Emergency stop button pressed."
        #   2023  "Singular position."
        #   9012  "Power disconnection detected."
        #   13046 "Emergency stop pressed."
        # _alarms holds the raw list from the last non-empty frame; empty
        # frames arrive continuously as heartbeats between real alarms
        # and MUST NOT clear the mirror (the controller re-emits only on
        # state change, and an empty followed by a non-empty is normal).
        # _alarm_active is set to the newest non-empty entry so the
        # status blob can surface a single most-relevant alarm to the
        # dashboard banner.
        self._alarms     = []
        self._alarm_active = None    # dict {severity, code, ts, text} or None
        # Latest stop reason for the dashboard's "why did jog stop?" line.
        # Populated by every _stop_jog_locked path (staleness / limit /
        # release / expiry / send-fail / disconnect / shutdown). The
        # dashboard shows this transiently when last_stop_ts is recent.
        self._last_stop_reason = ''
        self._last_stop_ts     = 0.0
        self._last_posture_ts = 0.0
        self._last_status_ts  = 0.0
        self._last_disabled_log = 0.0

        # Part 2c program-execution state, updated from publish/ProjectState.
        # None values mean "no info yet"; a state==0 ProjectState frame
        # after a run clears line/task/is_step but preserves last_project_id
        # so the dashboard can still show "just ran <that project>".
        self._prog_state       = 0        # 0=idle, 2=running (wire values)
        self._prog_project_id  = None
        self._prog_task        = None
        self._prog_line        = None
        self._prog_is_step     = False
        self._prog_last_update_ts = 0.0
        # publish/Error dedup — the ~3 Hz reflood collapses to one
        # event per unique (code, unix_ts) key. See program_ops.ErrorDedup.
        from estun_driver.program_ops import ErrorDedup
        self._prog_err_dedup = ErrorDedup()
        self._prog_last_error = None      # last observed entry or None

        # Rejection accounting.
        self._rej_counts = {}
        self._rej_warned = set()

        # Cartesian-jog governor state.
        self._sing_guard = SingularityGuard()
        # Self-collision guard — loads capsule YAML at init. If the
        # YAML is missing or malformed, we WARN and disable the guard
        # rather than refuse to start the driver.
        self._coll_model = None
        if self._coll_enabled:
            try:
                from .collision import CollisionModel
                self._coll_model = CollisionModel(self._coll_yaml_path)
                self._coll_model.ground_z_mm = (
                    self._ground_z_mm if self._ground_check_enabled else None)
                self.get_logger().info(
                    f'Self-collision guard loaded: {len(self._coll_model.capsules)} '
                    f'capsules, {len(self._coll_model.pairs)} pairs from '
                    f'{self._coll_yaml_path}  warn={self._coll_warn_mm:.0f}mm '
                    f'stop={self._coll_stop_mm:.0f}mm  '
                    f'ground_z={self._ground_z_mm:.0f}mm')
            except Exception as e:
                self.get_logger().warn(
                    f'Self-collision guard DISABLED — could not load '
                    f'{self._coll_yaml_path}: {e}')
                self._coll_model = None
        # Latest guard telemetry — dashboard mirror reads these.
        self._coll_min_pair = None      # tuple (link_a, link_b) or None
        self._coll_min_dist_mm = None   # float or None
        self._coll_warning_active = False
        # Environment (static-zone) subscription. We poll the dashboard's
        # /api/collision/static_zones endpoint at low rate (they're
        # static — no need for real-time updates). Zone fetch runs on
        # its own thread to avoid blocking the ROS executor.
        self._env_zones_url = 'https://127.0.0.1:8080/api/collision/static_zones'
        self._env_zone_refresh_s = 30.0
        self._env_last_refresh_ts = 0.0
        # Escape-direction cache — published only when an env pair is
        # within warn distance. list of dicts {joint, direction,
        # projected_mm, current_mm}, sorted best-first.
        self._env_escape_dirs = []
        # Latest env pair specifically (self-collision pair can also
        # be the overall winner; keep them separate so the popup only
        # fires on environment collision, not self).
        self._env_min_pair = None
        self._env_min_dist_mm = None
        # Unified guard state (drives the guard popup — covers self,
        # ground, and env in one blob).
        self._guard_active = False
        self._guard_kind   = None       # 'self' | 'ground' | 'env' | None
        self._guard_pair   = None
        self._guard_min_dist_mm = None
        self._guard_escapes = []
        # Rate-limit for the 13× evaluate() escape probe. 0 == never
        # computed yet; refresh at ≤2 Hz on the posture callback.
        self._guard_escapes_ts = 0.0
        self._guard_warn_effective_mm = self._coll_warn_mm
        self._guard_stop_effective_mm = self._coll_stop_mm
        # Mesh-refresh worker (~5 Hz on its own thread). Populates
        # CollisionModel._mesh_cache so posture / supervise ticks read
        # mesh-mesh distances from cache instead of paying the 6 ms/
        # query cost inline. The worker is what keeps the 50 ms
        # supervise budget under 5 ms even at the J3=122° fold.
        self._mesh_worker_stop = threading.Event()
        self._mesh_worker = None
        if self._coll_model is not None and self._coll_model.mesh_pairs:
            self._mesh_worker = threading.Thread(
                target=self._mesh_refresh_loop,
                name='mesh-refresh', daemon=True)
            self._mesh_worker.start()
        # Environment-zone refresher thread.
        self._env_stop = threading.Event()
        if self._coll_model is not None:
            self._env_refresh_thread = threading.Thread(
                target=self._env_refresh_thread_loop,
                name='env-zone-refresh', daemon=True)
            self._env_refresh_thread.start()
        self._prev_joint_deg = None      # for reactive velocity backstop
        self._prev_joint_ts  = 0.0
        # Latest σ_min sample and effective scale — surfaced in status.
        self._last_sigma_min = None
        self._last_sing_scale = 1.0
        # For mid-hold ramp: what did we last actually send on the wire?
        # (Signed fraction, matching Robot/jog's `speed` field.)
        self._cart_last_sent_speed = 0.0
        # Commanded (unscaled) magnitude of the current hold, used as
        # the ceiling the governor scales down from.
        self._cart_commanded_frac = 0.0

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
        # Part 2c program-execution status. Updated from publish/ProjectState
        # frames (state, project id, current task, current line, isStep)
        # and from publish/Error transitions (new fault, cleared) after
        # dedup by (code, unix_ts) — see program_ops.ErrorDedup.
        self._pub_program     = self.create_publisher(String, '/estun/program_status', 10)

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

        # Program execution — save (HTTP) + run/stop/pause/... (WS).
        # Gate = monitor_only=false AND allow_move=true.
        # Queue depth 16: /api/estun/program/run publishes a 6-op burst
        # (save → to_auto → set_auto_rate → set_breakpoint →
        # clear_start_line → project/run) and `save` itself blocks the
        # executor thread for up to ~12s (four HTTP POSTs at 3s each),
        # so the queue must hold the whole tail without any risk of
        # KEEP_LAST dropping the head. Depth 5 was too tight — grew to
        # 16 to match the dashboard publisher.
        self.create_subscription(String, '/estun/program', self._on_program_command, 16)

        # ── Timers ─────────────────────────────────────────────
        self._mode_timer    = self.create_timer(1.0, self._publish_mode)
        # Connection lifecycle tick — polls the state machine at 2 Hz
        # to decide whether to attempt a connect, send a probe, or
        # promote to the full subscribe burst. Cheap enough to run
        # constantly; the SM does the actual gating (backoff / grace /
        # cooldown).
        self._connect_timer = self.create_timer(0.5, self._conn_tick)

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
        if self._monitor_only:
            pass
        elif self._allow_move:
            self.get_logger().warn(
                f'MOVE WRITE PATH ENABLED — monitor_only=false, '
                f'allow_move=true (source: {self._allow_move_source}). '
                f'/estun/program will emit project/* + Robot/toAuto|toManual '
                f'+ Robot/setManualMoveRate + System/ClearError and HTTP-save '
                f'to :{self._ui_origin_port}. SOURCE-ONLY verbs (stop/pause/'
                f'resume/runStep/clearBreakpoint/setAutoMoveRate) are '
                f'behind-shape-not-behavior — see PART_2C_ARCHITECTURE.md §5.')
        else:
            self.get_logger().warn(
                'monitor_only=false but allow_move=false — program write '
                'path still gated; set ESTUN_ALLOW_MOVE=1 or allow_move:true '
                'in YAML.')
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
        if self._conn_sm.state != self._conn_sm.READY:
            # Writes during INITIALIZING can hit the same joint-vector
            # crash path we're avoiding with the deferred subscribe.
            self._reject(family, f'controller {self._conn_sm.state} — writes gated until READY')
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

    # ── Program write path (Part 2c, B1) ───────────────────────
    #
    # /estun/program accepts a JSON envelope { "op": "<verb>", ... }.
    # The gate is monitor_only=false AND allow_move=true (checked FIRST,
    # before any argument parsing, so a gate-closed run publishes
    # rejections without touching the wire). See PART_2C_ARCHITECTURE.md
    # for the full verb catalog and the SOURCE-ONLY status of the
    # stop/pause/resume/runStep/clearBreakpoint family.
    #
    # Verbs whose shape / behavior is confirmed from the HAR are marked
    # CAPTURED. Verbs mined from assets_entry_as-D2dla8D6.js only are
    # marked SOURCE-ONLY — their shape matches the confirmed no-db
    # family but behavior needs live wire proof (see the validation
    # ladder in PART_2C_ARCHITECTURE.md §5).
    #
    # HTTP save (op="save") uses program_ops.save_project — POST to
    # /api/robotcode/ (Lua source) + /api/robotjson/... (varspoint,
    # project.json, projectlist). Response codes surface via the
    # rejection channel on failure.

    def _writes_allowed_for_move(self):
        return (not self._monitor_only) and self._allow_move

    def _ws_verb(self, ty, db=None):
        """Send a single ty[/db] envelope, id-tagged. Returns True on
        wire success (which does NOT mean the controller accepted —
        only that the frame reached the socket). Rejection surfaces
        through the family-typed logger + /estun/rejected on the
        CALLER'S side."""
        frame = {'ty': ty}
        if db is not None:
            frame['db'] = db
        frame['id'] = self._new_nonce()
        return self._send(frame)

    def _on_program_command(self, msg):
        """Program-family command dispatcher. One family per op so
        rejections stay attributable in /estun/rejected.

        Op catalog (see PART_2C_ARCHITECTURE.md for shape references):
          save          — HTTP: Lua source + varspoint + project.json + projectlist
          run           — WS   {ty:"project/run",         db:{id,task}}    (CAPTURED)
          runStep       — WS   {ty:"project/runStep",     db:{id,task}}    (SOURCE-ONLY)
          stop          — WS   {ty:"project/stop"}                          (SOURCE-ONLY)
          pause         — WS   {ty:"project/pause"}                         (SOURCE-ONLY)
          resume        — WS   {ty:"project/resume"}                        (SOURCE-ONLY)
          set_start_line   — WS {ty:"project/setStartLine",  db:<int line>} (CAPTURED)
          clear_start_line — WS {ty:"project/clearStartLine"}               (CAPTURED)
          set_breakpoint   — WS {ty:"project/setBreakpoint", db:{task:[…]}} (CAPTURED)
          clear_breakpoint — WS {ty:"project/clearBreakpoint"}              (SOURCE-ONLY)
          to_auto       — WS   {ty:"Robot/toAuto"}                          (CAPTURED)
          to_manual     — WS   {ty:"Robot/toManual"}                        (CAPTURED)
          set_move_rate — WS   {ty:"Robot/setManualMoveRate", db:<int %>}   (CAPTURED)
          set_auto_rate — WS   {ty:"Robot/setAutoMoveRate",   db:<int %>}   (SOURCE-ONLY)
          clear_error   — WS   {ty:"System/ClearError"}                     (CAPTURED)

        Every op above requires monitor_only=false AND allow_move=true.
        (clear_error is available separately on /robot/power_command as
        'clear_alarm', which is gated on allow_power — that path stays
        for the jog/power UI and is unchanged.)
        """
        family = 'program'
        # ─ Gate: the FIRST check, before we touch the payload. This
        #   is what makes the gate-closed proof airtight — a rejected
        #   op never emits a wire frame.
        if self._monitor_only:
            self._reject(family, 'monitor_only active',
                         extra={'payload': msg.data[:200]})
            return
        if not self._allow_move:
            self._reject(family, 'allow_move gate closed',
                         extra={'payload': msg.data[:200]})
            return
        if not self._connected:
            self._reject(family, 'ws not connected',
                         extra={'payload': msg.data[:200]})
            return
        if self._conn_sm.state != self._conn_sm.READY:
            self._reject(family, f'controller {self._conn_sm.state} — writes gated until READY',
                         extra={'payload': msg.data[:200]})
            return

        try:
            d = json.loads(msg.data)
        except Exception as e:
            self._reject(family, f'invalid JSON: {e}')
            return

        op = str(d.get('op', '')).lower()
        try:
            handler = _PROGRAM_OP_HANDLERS.get(op)
            if handler is None:
                self._reject(family, f'unknown op {op!r}')
                return
            handler(self, d)
        except Exception as e:
            self.get_logger().warn(f'program op {op!r} failed: {e}')
            self._reject(family, f'op {op!r} raised: {e}')

    # ── /estun/program op handlers ─────────────────────────────
    #
    # Each handler enforces its own argument shape but assumes the
    # gate check in _on_program_command has already succeeded — do
    # NOT call these directly from any other path.

    def _op_save(self, d):
        """HTTP save. Required fields:
          program_id, task_id, name, task_name,
          points: {name: {joint:[6 floats]}}  (POSTed as varspoint)
          lua_source: <str>

        The caller (usually a codegen script or the dashboard) supplies
        the FINAL Lua text and points dict; this handler just POSTs
        them. Codegen lives in program_ops.codegen_lua_from_program
        so a caller can produce these fields from a taught-program IR
        without duplicating logic here.
        """
        from estun_driver import program_ops
        required = ('program_id', 'task_id', 'lua_source', 'points')
        for k in required:
            if d.get(k) is None:
                self._reject('program', f'save: missing {k!r}')
                return
        try:
            steps = program_ops.save_project(
                self._robot_ip, self._ui_origin_port,
                project_id=str(d['program_id']),
                task_id=str(d['task_id']),
                project_display=str(d.get('name', d['program_id'])),
                task_display=str(d.get('task_name', d['task_id'])),
                lua_source=str(d['lua_source']),
                varspoint=dict(d['points']),
            )
        except Exception as e:
            self._reject('program', f'save: HTTP failed: {e}')
            return
        # Emit a status frame so the dashboard/test scripts see the
        # exact per-step response chain. Uses a compact schema.
        m = String()
        m.data = json.dumps({
            'event': 'save',
            'project_id': d['program_id'],
            'task_id': d['task_id'],
            'steps': steps,
            'ts': time.time(),
        }, separators=(',', ':'))
        self._pub_program.publish(m)
        self.get_logger().info(
            f'program save: {d["program_id"]}/{d["task_id"]} — '
            f'{len(steps)} HTTP calls, '
            f'{sum(1 for s in steps if s.get("http_status")==200)} 200-OK')

    def _op_run(self, d):
        pid = str(d.get('program_id', ''))
        tid = str(d.get('task_id', ''))
        if not pid or not tid:
            self._reject('program', 'run: missing program_id/task_id')
            return
        ok = self._ws_verb('project/run', {'id': pid, 'task': tid})
        self.get_logger().info(f'project/run sent pid={pid!r} tid={tid!r} ok={ok}')

    def _op_runstep(self, d):
        # runStep has TWO wire shapes with distinct semantics, mined
        # from the factory UI bundle:
        #
        #   1. Initial step (from idle, with program_id + task_id supplied):
        #        {ty:"project/runStep", db:{id:<prid>, task:<tkid>}}
        #      Called from the run popup "Step" button (JS: runSubmit(2)
        #      → runStep(1)). Enters step mode.
        #
        #   2. Advance step (from paused-in-step, no program_id supplied):
        #        {ty:"project/runStep", id:"1"}   (no db)
        #      Called from the RunBar "Step" button while isStep=true
        #      (JS: runStep(0)). Advances one step through the paused
        #      program.
        #
        # We differentiate by presence of program_id in the /estun/program
        # payload so callers can express both without a new op name.
        pid = str(d.get('program_id', '')) if d.get('program_id') else ''
        tid = str(d.get('task_id', '')) if d.get('task_id') else ''
        if pid and tid:
            # Initial: full envelope.
            ok = self._ws_verb('project/runStep', {'id': pid, 'task': tid})
            self.get_logger().info(
                f'project/runStep(initial) db={{id:{pid!r},task:{tid!r}}} ok={ok}')
        else:
            # Advance: no db, id="1" (matches the wsSend variant used by
            # the RunBar step button — the id="1" is a literal from the
            # JS bundle, not our nonce).
            frame = {'ty': 'project/runStep', 'id': '1'}
            ok = self._send(frame)
            self.get_logger().info(
                f'project/runStep(advance) no-db ok={ok}')

    def _op_stop(self, _d):
        # SOURCE-ONLY. This is the verb that stops an autonomously-
        # running program without touching motor power. Behavior
        # validation is the FIRST live test in the Part 2c ladder
        # (PART_2C_ARCHITECTURE.md §5).
        ok = self._ws_verb('project/stop')
        self.get_logger().info(f'project/stop sent (SOURCE-ONLY) ok={ok}')

    def _op_pause(self, _d):
        # SOURCE-ONLY.
        ok = self._ws_verb('project/pause')
        self.get_logger().info(f'project/pause sent (SOURCE-ONLY) ok={ok}')

    def _op_resume(self, _d):
        # SOURCE-ONLY.
        ok = self._ws_verb('project/resume')
        self.get_logger().info(f'project/resume sent (SOURCE-ONLY) ok={ok}')

    def _op_set_start_line(self, d):
        try:
            line = int(d.get('line', 1))
        except (TypeError, ValueError):
            self._reject('program', 'set_start_line: invalid line')
            return
        ok = self._ws_verb('project/setStartLine', line)
        self.get_logger().info(f'project/setStartLine db={line} ok={ok}')

    def _op_clear_start_line(self, _d):
        ok = self._ws_verb('project/clearStartLine')
        self.get_logger().info(f'project/clearStartLine ok={ok}')

    def _op_set_breakpoint(self, d):
        task = d.get('task_id') or d.get('task')
        lines = d.get('lines') or []
        if not task:
            self._reject('program', 'set_breakpoint: missing task_id')
            return
        db = {str(task): list(lines)}
        ok = self._ws_verb('project/setBreakpoint', db)
        self.get_logger().info(f'project/setBreakpoint db={db} ok={ok}')

    def _op_clear_breakpoint(self, _d):
        # SOURCE-ONLY. (An alternative would be to send
        # project/setBreakpoint with db={task:[]} — captured behavior
        # — but this dedicated verb from the JS bundle is a cleaner
        # global clear.)
        ok = self._ws_verb('project/clearBreakpoint')
        self.get_logger().info(f'project/clearBreakpoint sent (SOURCE-ONLY) ok={ok}')

    def _op_to_auto(self, _d):
        ok = self._ws_verb('Robot/toAuto')
        self.get_logger().info(f'Robot/toAuto ok={ok}')

    def _op_to_manual(self, _d):
        ok = self._ws_verb('Robot/toManual')
        self.get_logger().info(f'Robot/toManual ok={ok}')

    def _op_set_move_rate(self, d):
        # setManualMoveRate is the MANUAL-mode override (jogs); the
        # AUTO-mode program-speed knob is setAutoMoveRate below.
        try:
            pct = int(d.get('pct', d.get('rate', 0)))
        except (TypeError, ValueError):
            self._reject('program', 'set_move_rate: invalid pct')
            return
        pct = max(1, min(100, pct))
        ok = self._ws_verb('Robot/setManualMoveRate', pct)
        self.get_logger().info(f'Robot/setManualMoveRate db={pct}%% ok={ok}')

    def _op_set_auto_rate(self, d):
        # SOURCE-ONLY.
        try:
            pct = int(d.get('pct', d.get('rate', 0)))
        except (TypeError, ValueError):
            self._reject('program', 'set_auto_rate: invalid pct')
            return
        pct = max(1, min(100, pct))
        ok = self._ws_verb('Robot/setAutoMoveRate', pct)
        self.get_logger().info(f'Robot/setAutoMoveRate db={pct}%% (SOURCE-ONLY) ok={ok}')

    def _op_clear_error(self, _d):
        # CAPTURED via HAR (used to stop the ~3 Hz publish/Error
        # reflood mid-capture). Symmetric to /robot/power_command
        # action=clear_alarm, but stays on this move-gate path so
        # program flows can clear + retry without also being
        # allowed to switchOn.
        ok = self._ws_verb('System/ClearError')
        self.get_logger().info(f'System/ClearError sent (program-path) ok={ok}')

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

    # ── SPEED-SCALED SAFETY MARGINS ─────────────────────────────────
    #
    # The static baseline margins (2° limit, 30 mm collision stop,
    # σ_soft=0.060) were tuned at jog_speed_cap=0.15. Raising the
    # cap invalidates those numbers: worst-case overrun distance
    # scales linearly with commanded speed_frac. Below we express
    # each margin as `base + extra × (speed_frac - baseline)`
    # (clamped to `base` at low speeds) so the geometry that made
    # 0.15 safe stays safe at 0.50.
    #
    # Values on file (safety_latency_s, safety_factor,
    # baseline_speed_frac) are declared ROS parameters so a specific
    # cell can retune from YAML without a code change.
    #
    #                       WORKED MATH
    # ──────────────────────────────────────────────────────────────
    # Limit clamp margin, per joint j:
    #   margin_j(f) = max(base,
    #                     max_joint_speed_degps[j] × f × latency × K)
    # where K = safety_factor. Example at f=0.15 (J1, 150°/s):
    #   150 × 0.15 × 0.150 × 1.5 = 5.06° → matches the ~5° we've
    #   been running as an implicit assumption. At f=0.50:
    #   150 × 0.50 × 0.150 × 1.5 = 16.9° → the "17°" the safety
    #   pass calls for.
    #
    # Collision guard stop distance:
    #   stop_mm(f) = base_stop_mm + max(0, f - baseline_speed_frac)
    #                             × TIP_SPEED_MMPS × latency × K
    # TIP_SPEED_MMPS is the worst-case link-tip speed at f=1.0.
    # ~1500 mm/s bounds the flange-tip speed at max joint speed and
    # a typical 1 m radius from the driving joint on this S10-140.
    # Result at f=0.15: 30 mm (unchanged). At f=0.50: 30 + 118 = 148 mm.
    #
    # Singularity governor:
    #   sigma_soft(f) = base_soft × max(1.0, f / baseline_speed_frac)
    # Wire evidence (alarm 2015 on 2026-07-15): IK amplification
    # collapsed σ from 0.180 → 0.021 over ~5 s at f=0.15. That rate
    # is proportional to commanded TCP speed; at f=0.50 the same
    # collapse fits inside ~1.5 s. Scaling σ_soft up (more
    # conservative) preserves the 5 s reaction window. σ_hard
    # stays at the physical stop threshold.
    _TIP_SPEED_MMPS = 1500.0    # worst-case flange-tip speed at f=1.0

    def _dyn_limit_margin_deg(self, joint_idx0, speed_frac):
        """Dynamic joint-limit margin (deg) at commanded speed_frac.
        joint_idx0 is 0..5. Returns MAX(static base, dynamic)."""
        base = self._joint_limit_margin_deg
        vmax = self._max_joint_speed_degps[joint_idx0]
        dyn = vmax * speed_frac * self._safety_latency_s * self._safety_factor
        return max(base, dyn)

    def _dyn_collision_stop_mm(self, speed_frac):
        """Dynamic collision stop distance (mm). At f≤baseline the
        returned value equals the static base; above baseline it grows
        linearly in (f - baseline) × TIP_SPEED_MMPS × latency × K."""
        base = self._coll_stop_mm
        extra_f = max(0.0, speed_frac - self._baseline_speed_frac)
        return base + extra_f * self._TIP_SPEED_MMPS * self._safety_latency_s * self._safety_factor

    def _dyn_env_stop_mm(self, speed_frac):
        base = self._env_stop_mm
        extra_f = max(0.0, speed_frac - self._baseline_speed_frac)
        return base + extra_f * self._TIP_SPEED_MMPS * self._safety_latency_s * self._safety_factor

    def _dyn_sigma_soft(self, speed_frac):
        """Speed-scaled σ_soft — never drops below the static base."""
        if self._baseline_speed_frac <= 0:
            return self._cart_sigma_soft
        scale = max(1.0, speed_frac / self._baseline_speed_frac)
        return self._cart_sigma_soft * scale

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
        if self._conn_sm.state != self._conn_sm.READY:
            # Writes during INITIALIZING can hit the same joint-vector
            # crash path we're avoiding with the deferred subscribe.
            self._reject(family, f'controller {self._conn_sm.state} — writes gated until READY')
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

        # Cap: effective speed frac = min(ui_pct/100, effective_cap)
        # where effective_cap = min(jog_speed_cap, operator_speed_limit).
        # Two-tier staged cap: jog_speed_cap is the hardware-derived
        # ceiling (0.50); operator_speed_limit is the operationally
        # allowed ceiling (0.25 today). See safety pass 2026-07-16 for
        # margin math backing the raise from 0.15 → 0.50 hardware cap.
        effective_frac = min(speed_pct / 100.0, self._effective_speed_cap)
        signed_speed = direction * effective_frac

        # For joint mode: pre-emptive limit clamp using LIVE angle. Stop
        # commanding motion if this jog would carry us past limit − margin.
        # Margin is SPEED-SCALED — see _dyn_limit_margin_deg. Formula
        # derivation lives in the comment block above _on_jog_command.
        if mode_s == 'joint':
            if self._last_posture_ts <= 0.0:
                self._reject(family, 'no posture reading yet — refusing to hold-jog blind')
                return
            current_deg = self._joint_deg[axis-1]
            limit = self._joint_limit_deg[axis-1]
            margin = self._dyn_limit_margin_deg(axis-1, effective_frac)
            safe_edge = limit - margin
            # Direction-aware check: only reject when we'd be pushing PAST
            # the far edge in the commanded direction.
            if direction > 0 and current_deg >= safe_edge:
                self._reject(family,
                             f'clamp: J{axis} at {current_deg:+.2f}° already past '
                             f'+{safe_edge:.2f}° (dyn margin {margin:.2f}° @ f={effective_frac:.2f}) '
                             f'— hold rejected')
                return
            if direction < 0 and current_deg <= -safe_edge:
                self._reject(family,
                             f'clamp: J{axis} at {current_deg:+.2f}° already past '
                             f'-{safe_edge:.2f}° (dyn margin {margin:.2f}° @ f={effective_frac:.2f}) '
                             f'— hold rejected')
                return

        target_mode = 'continuous' if mode_s == 'joint' else 'continuous_cart'
        robot_jog_mode = 1 if mode_s == 'joint' else 2  # captured protocol values

        # ── Collision guard command-time gate (joint mode) ────────────
        # THE WEDGE FIX. Evaluate the COMMANDED direction with an FK
        # projection now (before we send anything), so a fresh command
        # in the opposite direction from the last one gets a clean
        # answer. Three cases:
        #   1. current clearance > warn:            allow full-speed
        #   2. current ≤ warn, projection OPENS:    escape → cap at 6%
        #   3. current ≤ stop, projection CLOSES:   REFUSE (with reason)
        #   4. current ≤ warn (not stop), CLOSES:   allow, log warning
        #   5. no escape direction found at all AND current ≤ stop:
        #      fallback → allow at 3% with LOUD log (operator has e-stop)
        # Cartesian is left permissive here — the σ_min governor + the
        # per-tick check handle it after motion begins.
        override_used = False
        if (self._coll_model is not None and mode_s == 'joint'
                and self._last_posture_ts > 0.0):
            try:
                (pair, cur_min) = self._coll_model.min_distance_at(self._joint_deg)
                # Honor per-pair YAML overrides so pairs with a design
                # floor (link3↔link5, ~46 mm mechanical minimum) don't
                # trip the closing-throttle every jog. Env pairs stay on
                # the global env warn/stop.
                is_env_pair = False
                if pair and isinstance(pair, tuple):
                    a, b = pair
                    is_env_pair = ((isinstance(a, str) and a.startswith('zone#'))
                                or (isinstance(b, str) and b.startswith('zone#')))
                if is_env_pair:
                    warn_thr = self._env_warn_mm
                    stop_thr = self._dyn_env_stop_mm(effective_frac)
                else:
                    warn_thr, base_stop, overridden = \
                        self._coll_model.thresholds_for_ex(
                            pair, self._coll_warn_mm, self._coll_stop_mm)
                    if overridden:
                        # Per-pair YAML entry is authoritative — represents
                        # a design-floor number (e.g. link3↔link5's mesh-
                        # bounded ~46 mm floor) that must NOT be scaled by
                        # the speed formula. Scaling would push stop_thr
                        # above the mechanical floor and permanently deny
                        # jog in a legitimate pose.
                        stop_thr = base_stop
                    else:
                        # Global default — speed-scale as usual.
                        stop_thr = base_stop + max(0.0, effective_frac - self._baseline_speed_frac) \
                                              * self._TIP_SPEED_MMPS * self._safety_latency_s \
                                              * self._safety_factor
                if cur_min <= warn_thr:
                    # Project the commanded direction 5° ahead.
                    proj = list(self._joint_deg)
                    proj[axis-1] += 5.0 * (1.0 if direction > 0 else -1.0)
                    _, proj_min = self._coll_model.min_distance_at(proj)
                    opening = proj_min > cur_min + 0.5
                    if opening:
                        # Escape motion. Cap speed at 6% and let it go.
                        cap = self._coll_escape_frac
                        if effective_frac > cap:
                            self.get_logger().info(
                                f'guard: escape cap {effective_frac:.2f} → {cap:.2f} '
                                f'(J{axis}{"+" if direction>0 else "-"}, '
                                f'{cur_min:.0f}mm → {proj_min:.0f}mm, pair={pair})')
                            effective_frac = cap
                            signed_speed = direction * effective_frac
                    else:
                        # Closing motion.
                        if cur_min <= stop_thr:
                            # Delegate the "does any direction open?"
                            # question to the collision model — it knows
                            # whether the pair is mesh-mesh (needs a
                            # wider probe step) or capsule.
                            has_escape = self._coll_model.has_any_escape(
                                self._joint_deg, pair)
                            if has_escape:
                                self._reject(family,
                                    f'collision guard: J{axis}{"+" if direction>0 else "-"} '
                                    f'closes {pair} from {cur_min:.0f}mm '
                                    f'(current ≤ stop {stop_thr:.0f}mm). '
                                    f'Use an escape direction from the popup.')
                                return
                            # FALLBACK — no direction opens per model; let the
                            # operator override at 3% cap. This is the "model
                            # wrong / geometry approximate" safety valve.
                            cap = self._coll_fallback_frac
                            if effective_frac > cap:
                                self.get_logger().warn(
                                    f'guard FALLBACK OVERRIDE: no escape direction '
                                    f'per model at {pair} dist={cur_min:.0f}mm — '
                                    f'allowing J{axis}{"+" if direction>0 else "-"} '
                                    f'at {cap:.2f} cap (operator has e-stop)')
                                effective_frac = cap
                                signed_speed = direction * effective_frac
                                override_used = True
                        else:
                            # In warn zone but not stop. Under the new
                            # tiered policy (2026-07-16) the warn band
                            # is presentational only — no speed throttle,
                            # no direction block. The 3D view chip
                            # surfaces the proximity; the operator
                            # decides. Leaving this branch as a no-op
                            # keeps the gate readable if we ever want
                            # to reinstate a per-pair throttle.
                            pass
            except Exception as e:
                if not getattr(self, '_coll_warned_bad', False):
                    self._coll_warned_bad = True
                    self.get_logger().warn(f'guard gate error (suppressed): {e}')

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
            # Governor bookkeeping — commanded magnitude (unscaled) and
            # the actual speed we last put on the wire. Only meaningful
            # for continuous_cart, but harmless to set for joint holds.
            self._cart_commanded_frac  = abs(signed_speed)
            self._cart_last_sent_speed = signed_speed
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
                f'speed_frac={effective_frac:.3f} '
                f'(ui {speed_pct:.0f}% capped at {self._effective_speed_cap:.2f} '
                f'= min(jog_speed_cap={self._jog_speed_cap:.2f}, '
                f'operator_speed_limit={self._operator_speed_limit:.2f})) '
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
        effective_frac = min(speed_pct / 100.0, self._effective_speed_cap)
        signed_speed = direction * effective_frac
        duration_s = 0.150  # fixed pulse; see method docstring.

        # Pre-emptive limit check across all joints — we can't project
        # cartesian motion into joint space cheaply, so refuse when any
        # joint is already at its speed-scaled safe edge. Per-joint
        # margin because J1-3 (150°/s) and J4-6 (180°/s) differ.
        if self._last_posture_ts <= 0.0:
            self._reject(family, 'cart pulse: no posture reading yet')
            return
        for i in range(6):
            margin = self._dyn_limit_margin_deg(i, effective_frac)
            safe_edge = self._joint_limit_deg[i] - margin
            if abs(self._joint_deg[i]) >= safe_edge:
                self._reject(family,
                             f'cart pulse clamp: J{i+1} at {self._joint_deg[i]:+.2f}° '
                             f'exceeds ±{safe_edge:.2f}° '
                             f'(dyn margin {margin:.2f}° @ f={effective_frac:.2f}) '
                             f'— refuse to pulse')
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
            self._cart_commanded_frac  = abs(signed_speed)
            self._cart_last_sent_speed = signed_speed
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

        # Self-collision pre-check for increments — project the FINAL
        # pose that the step will land at, reject if it crosses the
        # stop threshold. Mirrors the joint-limit clamp above, using
        # the same reason string convention. Continuous jogs run the
        # per-tick guard in supervise; this pre-check is the discrete
        # counterpart so a "tap" can't jump us into contact.
        if self._coll_model is not None:
            projected = list(self._joint_deg)
            projected[axis-1] = target_deg
            try:
                pres = self._coll_model.evaluate(projected)
                if pres:
                    pa, pb, pd = pres[0]
                    if pd <= self._coll_stop_mm:
                        self._reject(family,
                            f'self-collision guard {pa}-{pb} at {pd:.0f}mm '
                            f'(projected after J{axis} {delta_deg:+.2f}° step)')
                        return
            except Exception as e:
                if not getattr(self, '_coll_warned_bad', False):
                    self._coll_warned_bad = True
                    self.get_logger().warn(
                        f'collision pre-check error (suppressed): {e}')

        # Busy check — only one jog at a time. Simpler than queueing.
        with self._jog_lock:
            if self._jog_active:
                self._reject(family,
                             f'busy — {self._jog_mode} jog on J{self._jog_index} still in flight')
                return

            speed_frac = min(self._jog_inc_speed_frac, self._effective_speed_cap)
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

    def _refresh_env_zones(self):
        """Fetch static-zone OBBs from the dashboard's collision API.
        Runs on a dedicated thread — never blocks the ROS executor.
        Static zones don't change at run-time (cell setup only), so
        we poll infrequently (30 s). Silently no-op on any fetch error;
        the guard just runs with the previously-known zones. If the
        model isn't loaded (yaml missing), do nothing."""
        if self._coll_model is None:
            return
        try:
            import urllib.request, ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(
                    self._env_zones_url, context=ctx, timeout=3) as r:
                payload = json.loads(r.read())
            from .collision import parse_static_zones
            zones = parse_static_zones(payload)
            prev_n = self._coll_model.env_zone_count
            self._coll_model.set_env_zones(zones)
            self._env_last_refresh_ts = time.time()
            if len(zones) != prev_n:
                self.get_logger().info(
                    f'env zones refreshed: {prev_n} → {len(zones)} '
                    f'from {self._env_zones_url}')
        except Exception as e:
            if not getattr(self, '_env_zone_fetch_warned', False):
                self._env_zone_fetch_warned = True
                self.get_logger().warn(
                    f'env-zone fetch failed (retrying every '
                    f'{self._env_zone_refresh_s:.0f}s): {e}')

    def _env_refresh_thread_loop(self):
        """Runs in a daemon thread — polls _refresh_env_zones at the
        configured interval. Started from __init__ if collision is
        enabled. Immediate first call so the guard has zones as soon
        as possible after startup; subsequent calls at the interval."""
        while not getattr(self, '_env_stop', threading.Event()).is_set():
            self._refresh_env_zones()
            # threading.Event.wait is interruptible for clean shutdown.
            self._env_stop.wait(timeout=self._env_zone_refresh_s)

    def _mesh_refresh_loop(self):
        """Off-loop mesh-mesh distance refresher. Runs at ~5 Hz
        (200 ms cadence) so the supervise/posture hot paths can read
        link3↔link5 mesh-mesh distance from cache instead of paying the
        3-6 ms/query cost on the single-threaded ROS executor. Skips
        computation until we have at least one posture sample (nothing
        to compute against). Terminates cleanly on `_mesh_worker_stop`."""
        MESH_REFRESH_PERIOD_S = 0.2
        while not self._mesh_worker_stop.is_set():
            if self._coll_model is not None and self._last_posture_ts > 0.0:
                try:
                    self._coll_model.refresh_mesh_cache(list(self._joint_deg))
                except Exception as e:
                    if not getattr(self, '_mesh_worker_warned', False):
                        self._mesh_worker_warned = True
                        self.get_logger().warn(
                            f'mesh-refresh worker error (suppressed after 1st): {e}')
            self._mesh_worker_stop.wait(timeout=MESH_REFRESH_PERIOD_S)

    def _check_collision_locked(self):
        """Evaluate self-collision at live joint angles. Returns True
        iff we stopped the jog. Also updates self._coll_min_pair /
        self._coll_min_dist_mm / self._coll_warning_active for the
        status blob so the dashboard can render live clearance.

        Direction-aware: if the current joint-velocity projection
        shows the closest-pair distance INCREASING (opening up),
        we suppress the stop even when distance is below the stop
        threshold — otherwise the operator gets wedged with every
        direction refused. Warning is issued regardless of direction.
        Caller must hold self._jog_lock."""
        try:
            res = self._coll_model.evaluate(self._joint_deg)
        except Exception as e:
            # Model bug → fall silent, keep motion. Log first hit.
            if not getattr(self, '_coll_warned_bad', False):
                self._coll_warned_bad = True
                self.get_logger().warn(f'collision guard error (suppressed): {e}')
            return False
        if not res:
            return False
        a, b, d = res[0]
        self._coll_min_pair = (a, b)
        self._coll_min_dist_mm = d

        # Warning zone: log once when it becomes active, once when clears.
        # Dynamic stop-distance for the CURRENT hold's speed_frac.
        # Higher speed → longer stop distance (see _dyn_collision_stop_mm
        # math block). Per-pair YAML overrides are authoritative — they
        # represent design-floor numbers (link3↔link5 mesh floor at
        # ~46 mm) that must NOT be raised by the speed formula.
        cur_frac = abs(self._jog_signed_speed) if self._jog_signed_speed else self._effective_speed_cap
        _, base_stop_for_pair, overridden = self._coll_model.thresholds_for_ex(
            (a, b), self._coll_warn_mm, self._coll_stop_mm)
        if overridden:
            dyn_stop_mm = base_stop_for_pair
        else:
            dyn_stop_mm = self._dyn_collision_stop_mm(cur_frac)

        in_warn = d <= self._coll_warn_mm
        if in_warn and not self._coll_warning_active:
            self.get_logger().warn(
                f'SELF-COLLISION WARNING: {a}-{b} at {d:.0f}mm '
                f'(warn threshold {self._coll_warn_mm:.0f}mm, '
                f'stop {dyn_stop_mm:.0f}mm dyn @ f={cur_frac:.2f})')
            self._coll_warning_active = True
        elif not in_warn and self._coll_warning_active:
            self.get_logger().info(
                f'self-collision warning cleared: {a}-{b} now at {d:.0f}mm')
            self._coll_warning_active = False

        if d > dyn_stop_mm:
            return False

        # Below stop threshold — check direction using the COMMANDED
        # jog direction (not observed velocity from posture-diff).
        # THIS IS THE WEDGE FIX: the old code took (joint_deg -
        # prev_joint_deg)/dt as the velocity vector, but when the arm
        # is stopped (right after a guard stop, or on the first tick
        # of a fresh command that hasn't moved anything yet), that
        # velocity is ≈ 0. `projected == joint_deg` ⇒ same clearance
        # ⇒ opening=False ⇒ STOP loops forever. The commanded
        # direction is what we ACTUALLY intend, so use that.
        opening = False
        if self._jog_mode == 'continuous' and 1 <= self._jog_index <= 6:
            projected = list(self._joint_deg)
            step = 5.0 * (1.0 if self._jog_direction > 0 else -1.0)
            projected[self._jog_index - 1] += step
            try:
                res2 = self._coll_model.evaluate(projected)
                for a2, b2, d2 in res2:
                    if (a2, b2) == (a, b):
                        opening = d2 > d + 0.5
                        break
            except Exception:
                opening = False
        # Cartesian mode: we don't have an FK-forward projection for
        # cartesian direction (that requires IK). Fall back to the
        # older posture-diff heuristic — but only when we HAVE fresh
        # posture-derived motion. If posture hasn't moved (freshly
        # started), assume opening (trust the operator's fresh
        # command in cartesian mode). The command-time gate in
        # _start_or_refresh_continuous does the real work for cart.
        elif self._jog_mode == 'continuous_cart':
            pj = self._prev_joint_deg
            pt = self._prev_joint_ts
            if pj is not None and pt > 0.0 and self._last_posture_ts > pt:
                dt = self._last_posture_ts - pt
                if dt > 1e-4:
                    projected = [self._joint_deg[i]
                                 + (self._joint_deg[i] - pj[i]) / dt * 0.04
                                 for i in range(6)]
                    try:
                        res2 = self._coll_model.evaluate(projected)
                        for a2, b2, d2 in res2:
                            if (a2, b2) == (a, b):
                                opening = d2 > d + 0.5
                                break
                    except Exception:
                        opening = False
            else:
                opening = True   # first-tick trust in commanded cart dir

        if opening:
            # Motion is moving away — don't stop, but keep the warning.
            return False

        # STOP. Reason string distinguishes env obstacle from self-
        # collision so the dashboard can pick the right modal copy.
        is_env = (isinstance(a, str) and a.startswith('zone#')) or \
                 (isinstance(b, str) and b.startswith('zone#'))
        kind = 'obstacle' if is_env else 'self-collision'
        # Normalize order — put the link name first for readability.
        if isinstance(a, str) and a.startswith('zone#'):
            a, b = b, a
        self._stop_jog_locked(
            reason=f'{kind} guard {a} vs {b} at {d:.0f}mm')
        return True

    def _apply_governor_scale_locked(self, sigma, scale):
        """Emit a fresh Robot/jog at the governor-scaled speed when the
        change from the last-sent speed exceeds the hysteresis. Upward
        ramp is capped per tick so a σ_min that briefly re-opens can't
        instantly slam us back to full speed. Caller must hold
        self._jog_lock."""
        cmd  = self._cart_commanded_frac         # unscaled magnitude
        sign = 1.0 if self._jog_direction >= 0 else -1.0
        target_signed = sign * cmd * scale
        last = self._cart_last_sent_speed
        # Rate-limit upward changes. Downward changes propagate immediately.
        if abs(target_signed) > abs(last):
            cap_up = abs(last) + cmd * self._cart_speed_up_per_tick
            if abs(target_signed) > cap_up:
                target_signed = sign * min(abs(target_signed), cap_up)
        # Hysteresis — only push a fresh frame when the change is
        # material relative to the commanded magnitude. Avoids spam.
        if abs(target_signed - last) < cmd * self._cart_speed_min_delta:
            return
        # Issue: stopJog + fresh Robot/jog. Preserve session identity —
        # this is a speed change within the SAME hold, not a new one, so
        # hold_id / seq bookkeeping stays put.
        try:
            self._send({'ty': 'Robot/stopJog', 'id': self._new_nonce()})
        except Exception as e:
            self.get_logger().warn(f'governor: stopJog send failed: {e}')
            return
        # Robot/jog with the new signed speed. index / coorType / coorId
        # unchanged — we're only ramping magnitude.
        frame = {
            'ty': 'Robot/jog',
            'db': {
                'mode':     2,
                'speed':    target_signed,
                'index':    self._jog_index,
                'coorType': 0,
                'coorId':   0,
            },
            'id': self._new_nonce(),
        }
        try:
            if not self._send(frame):
                self.get_logger().warn('governor: Robot/jog send returned False')
                return
        except Exception as e:
            self.get_logger().warn(f'governor: Robot/jog send failed: {e}')
            return
        self._cart_last_sent_speed = target_signed
        self._jog_signed_speed = target_signed
        self.get_logger().info(
            f'governor scale {scale:.2f}: σ_min={sigma:.4f}  '
            f'speed {last:+.3f} → {target_signed:+.3f}')

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
                # Effective speed_frac for the CURRENT hold — used for
                # dynamic-margin sizing. Falls back to effective cap
                # when signed_speed hasn't been set yet.
                cur_frac = abs(self._jog_signed_speed) if self._jog_signed_speed else self._effective_speed_cap
                if self._jog_mode == 'continuous':
                    ax = self._jog_index
                    if 1 <= ax <= 6:
                        current = self._joint_deg[ax - 1]
                        limit = self._joint_limit_deg[ax - 1]
                        margin = self._dyn_limit_margin_deg(ax - 1, cur_frac)
                        safe_edge = limit - margin
                        if self._jog_direction > 0 and current >= safe_edge:
                            self._stop_jog_locked(
                                reason=f'limit approach J{ax} at {current:+.2f}° '
                                       f'(+{safe_edge:.2f}°, dyn margin {margin:.2f}° @ f={cur_frac:.2f})')
                            return
                        if self._jog_direction < 0 and current <= -safe_edge:
                            self._stop_jog_locked(
                                reason=f'limit approach J{ax} at {current:+.2f}° '
                                       f'(-{safe_edge:.2f}°, dyn margin {margin:.2f}° @ f={cur_frac:.2f})')
                            return
                elif self._jog_mode == 'continuous_cart':
                    for i in range(6):
                        current = self._joint_deg[i]
                        limit = self._joint_limit_deg[i]
                        margin = self._dyn_limit_margin_deg(i, cur_frac)
                        safe_edge = limit - margin
                        if abs(current) >= safe_edge:
                            self._stop_jog_locked(
                                reason=f'cart limit approach J{i+1} at {current:+.2f}° '
                                       f'(|>{safe_edge:.2f}°|, dyn margin {margin:.2f}° @ f={cur_frac:.2f})')
                            return
                    # ── Singularity + overspeed governor (cart only) ──
                    # Compute σ_min at live joint angles; scale/stop the
                    # cartesian jog before the controller's IK explodes.
                    # σ_soft is speed-scaled — at higher speed_frac the
                    # IK amplification arrives sooner in wall time, so
                    # engage the governor earlier. σ_hard stays at the
                    # physical stop threshold.
                    if self._last_posture_ts > 0.0:
                        sigma = self._sing_guard.sigma_min(self._joint_deg)
                        self._last_sigma_min = sigma
                        dyn_soft = self._dyn_sigma_soft(cur_frac)
                        scale = SingularityGuard.scale(
                            sigma, dyn_soft, self._cart_sigma_hard)
                        self._last_sing_scale = scale
                        if sigma is not None and sigma <= self._cart_sigma_hard:
                            self._stop_jog_locked(
                                reason=f'singularity guard (σ_min={sigma:.4f} '
                                       f'≤ hard={self._cart_sigma_hard:.3f})')
                            return
                        # Reactive backstop — the sole line of defense
                        # when the DH model is off, or when the incident
                        # is IK-controller-side rather than kinematics-
                        # side. Finite-difference velocity from the last
                        # two posture samples.
                        pj = self._prev_joint_deg
                        pt = self._prev_joint_ts
                        if (pj is not None and pt > 0.0
                                and self._last_posture_ts > pt):
                            dt = self._last_posture_ts - pt
                            if dt > 1e-4:
                                for i in range(6):
                                    dq_dps = (self._joint_deg[i] - pj[i]) / dt
                                    dq_rps = math.radians(dq_dps)
                                    if abs(dq_rps) > self._cart_joint_v_cap:
                                        self._stop_jog_locked(
                                            reason=f'joint overspeed guard J{i+1} '
                                                   f'{dq_rps:+.2f} rad/s '
                                                   f'(cap {self._cart_joint_v_cap:.2f})')
                                        return
                        # If σ is in the scaling zone, ramp the commanded
                        # speed. The captured protocol rejects a fresh
                        # Robot/jog while active only sometimes (the
                        # "100/robot state is not ready" case was seen at
                        # state=0, not during a good hold), so we go via
                        # stopJog + fresh Robot/jog when the change is
                        # meaningful — hysteresis at 10 %, up-ramp capped
                        # per tick. If a downward change wanted, apply
                        # immediately; upward changes rate-limit.
                        if scale < 1.0 and sigma is not None:
                            self._apply_governor_scale_locked(sigma, scale)

                # ── Self-collision guard (both joint and cartesian) ──
                # Applied AFTER the limit clamp + singularity governor
                # so those stops keep their existing reason strings.
                # Direction-aware: only stop if the commanded motion is
                # REDUCING the min-pair distance. Uses a 40 ms look-ahead
                # from the current joint velocity to project the next
                # pose and re-evaluate.
                if (self._coll_model is not None
                        and self._last_posture_ts > 0.0
                        and self._jog_mode in ('continuous', 'continuous_cart')):
                    if self._check_collision_locked():
                        return   # stopped
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
        # Latch the reason regardless of active/inactive — the operator
        # still wants to know when a rejected start or a redundant stop
        # happened. Downstream dashboards decide staleness themselves
        # via _last_stop_ts.
        self._last_stop_reason = reason
        self._last_stop_ts     = time.time()
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
            'allow_move':     self._allow_move,
            'allow_move_source': self._allow_move_source,
            'program_state':  self._prog_state,
            'program_project_id': self._prog_project_id,
            'program_task':   self._prog_task,
            'program_line':   self._prog_line,
            'program_is_step': self._prog_is_step,
            'jog_speed_cap':         self._jog_speed_cap,
            'operator_speed_limit':  self._operator_speed_limit,
            'effective_speed_cap':   self._effective_speed_cap,
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
            'conn':           self._conn_sm.status_snapshot(),
            'enabled':        self._enabled,
            'enabling':       self._enabling,
            'state_code':     self._state_code,
            'state_name':     self._state_name,
            'alarm':          self._alarm_active is not None,
            'alarm_count':    len(self._alarms),
            'active_alarm':   self._alarm_active,
            'last_stop_reason': self._last_stop_reason,
            'last_stop_ts':     self._last_stop_ts,
            'last_posture_age_s': (time.time() - self._last_posture_ts) if self._last_posture_ts else None,
            'last_status_age_s':  (time.time() - self._last_status_ts)  if self._last_status_ts  else None,
        }
        m = String(); m.data = json.dumps(body)
        self._pub_mode.publish(m)

    # ── WebSocket lifecycle ───────────────────────────────

    def _conn_tick(self):
        """Periodic tick that drives the ConnectStateMachine forward.

        Runs at 2 Hz. Handles three orthogonal responsibilities:
          1. If DISCONNECTED and backoff/cooldown elapsed → attempt
             a new WS connection.
          2. If INITIALIZING and a probe is due → emit one.
          3. If INITIALIZING and both probe answered + grace elapsed
             → send the FULL subscribe burst and transition to READY.
        """
        sm = self._conn_sm

        # 1) Attempt-connect gate.
        if sm.state in (sm.DISCONNECTED, sm.COOLDOWN):
            ok, _reason = sm.can_attempt_connect()
            if ok:
                self._try_connect()
                return  # a successful connect already sent the probe

        # 2) Probe tick during grace.
        if sm.state == sm.INITIALIZING and self._connected:
            if sm.should_send_probe():
                self._send_probe()
                sm.note_probe_sent()
            # 3) Promotion to READY.
            if sm.should_subscribe_full():
                self._finalize_full_subscribe()

    def _try_connect(self):
        """Open the WS and send the PROBE-ONLY subscribe. This does
        NOT send the full topic set — that waits on the readiness
        probe answering. The state-machine handles all timing;
        callers just invoke this when the SM says an attempt is due."""
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
            self._conn_sm.on_connect_failure()
            return

        self._connected = True
        self._conn_sm.on_connect_success()
        self._crashloop_logged = False
        self.get_logger().info(
            f'Connected {url} (origin={origin}) — INITIALIZING '
            f'(grace={self._grace_period_s:.1f}s, probe only until '
            f'controller responds)')

        # PROBE-ONLY subscribe. RobotStatus is safe: emitted by
        # C2Control directly, not from the crash-prone RT loop.
        try:
            for t in PROBE_TOPICS:
                self._send({'ty': f'publish/{t}'})
        except Exception as e:
            self.get_logger().warn(f'Probe subscribe failed: {e}')
            self._disconnect()
            return

        # First probe fires immediately.
        try:
            self._send_probe()
            self._conn_sm.note_probe_sent()
        except Exception as e:
            self.get_logger().warn(f'Readiness probe send failed: {e}')

        self._recv_thread = threading.Thread(target=self._recv_loop, daemon=True)
        self._recv_thread.start()

    def _send_probe(self):
        """Send the readiness probe. IOManager/GetIOInfo is the
        lightweight system query mined from the Codroid UI bundle —
        we don't have wire-log confirmation it exists on this
        firmware, so the driver ALSO accepts any well-formed
        publish/RobotStatus frame as evidence the controller is
        responsive (see _handle_frame). Either signal graduates us
        out of the grace state."""
        try:
            self._send({'ty': 'IOManager/GetIOInfo',
                        'id': self._new_nonce()})
        except Exception as e:
            self.get_logger().warn(f'probe send failed: {e}')

    def _finalize_full_subscribe(self):
        """Grace passed + probe answered → send the full topic burst
        and promote to READY. This is the ONLY path that subscribes
        to RobotPosture / RobotCoordinate (the topics that crashed
        the controller when subscribed too early)."""
        try:
            for t in FULL_TOPICS:
                self._send({'ty': f'publish/{t}'})
        except Exception as e:
            self.get_logger().warn(f'Full subscribe burst failed: {e}')
            self._disconnect()
            return
        self._conn_sm.on_subscribed_full()
        self.get_logger().info(
            f'Controller READY — full subscribe burst sent '
            f'({len(FULL_TOPICS)} topics). Telemetry mirror active.')

    def _disconnect(self):
        # Best-effort stopJog on the still-open socket before we drop it —
        # if we're mid-motion and the WS dies, the controller's own
        # heartbeat deadman is the ultimate stop, but sending our own
        # stopJog shortens the window.
        try:
            self._stop_jog(reason='ws disconnect')
        except Exception:
            pass
        was_connected = self._connected
        self._connected = False
        self._enabled = False
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None
        if was_connected:
            result = self._conn_sm.on_disconnect()
            if result == 'crashloop' and not self._crashloop_logged:
                self._crashloop_logged = True
                self.get_logger().warn(
                    f'controller appears to be restarting — backing off '
                    f'{self._crashloop_cooldown_s:.0f}s '
                    f'(≥{self._crashloop_threshold} disconnects inside '
                    f'{self._crashloop_window_s:.0f}s window). Dashboard '
                    f'System Check will show Controller: '
                    f'"initializing — waiting".')

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
        # ANY id-tagged reply during INITIALIZING counts as a valid
        # readiness answer — this covers the IOManager/GetIOInfo probe
        # regardless of whether the firmware ships that verb (unknown
        # verbs still round-trip an id echo on some Codroid builds).
        if (obj.get('id') is not None
                and self._conn_sm.state == self._conn_sm.INITIALIZING):
            self._conn_sm.note_probe_response()
        if not ty.startswith('publish/'):
            return
        topic = ty[len('publish/'):]
        if topic == 'RobotPosture':
            self._on_posture(db)
        elif topic == 'RobotStatus':
            self._on_status(db)
        elif topic == 'Error':
            self._on_error(db)
            # Dedup + publish on transitions. See program_ops.ErrorDedup
            # docstring — the ~3 Hz reflood collapses to one event per
            # unique (code, unix_ts) key.
            evt = self._prog_err_dedup.observe(db)
            if evt.get('changed'):
                self._prog_last_error = evt.get('entry')
                self._publish_program_status(source='error_' + evt['kind'])
        elif topic == 'ProjectState':
            self._on_project_state(db)
        # Other topics (WebCommand, RobotCoordinate, ProjectStatus, web)
        # are captured in the raw log but not otherwise processed in
        # this telemetry mirror.

    def _on_project_state(self, db):
        """publish/ProjectState — see program_ops.parse_project_state
        for the shape parser. Two frame variants inside state==2:
        the first carries the project id, subsequent frames blank it
        and carry scripts.{task}.line instead. We persist the id
        across the transition so the dashboard sees a stable
        program_id for the whole run."""
        from estun_driver.program_ops import parse_project_state
        parsed, new_prev = parse_project_state(db, self._prog_project_id)
        if not parsed:
            return
        self._prog_project_id = new_prev
        prev_state = self._prog_state
        self._prog_state = parsed['state']
        self._prog_task = parsed['task'] or self._prog_task
        self._prog_line = parsed['line'] if parsed['line'] is not None else self._prog_line
        self._prog_is_step = parsed['is_step']
        self._prog_last_update_ts = time.time()
        if prev_state != self._prog_state:
            self.get_logger().info(
                f'ProjectState: state {prev_state} → {self._prog_state} '
                f'(project={self._prog_project_id!r} task={self._prog_task!r} '
                f'line={self._prog_line} isStep={self._prog_is_step})')
            # State-transition frames are the interesting ones — line-tick
            # frames within a running program get published too but as
            # incremental updates that the dashboard can dedup by line.
        self._publish_program_status(source='projectstate')

    def _publish_program_status(self, source: str = ''):
        """Emit a snapshot of the program-execution state to
        /estun/program_status. Called on ProjectState transitions and
        Error dedup events."""
        m = String()
        m.data = json.dumps({
            'event': 'status',
            'source': source,
            'state': self._prog_state,
            'project_id': self._prog_project_id,
            'task': self._prog_task,
            'line': self._prog_line,
            'is_step': self._prog_is_step,
            'error': self._prog_last_error,
            'ts': time.time(),
        }, separators=(',', ':'))
        self._pub_program.publish(m)

    def _on_error(self, db):
        """publish/Error — db is a list of active alarms (empty when none).
        Each entry: [severity, code, ts, text] (wire-captured shape).
        We mirror the raw list AND parse the newest entry into a structured
        active_alarm blob so the dashboard can render cause + recovery text.

        Note on empty frames: the controller re-emits Error on state
        change but also keeps publishing at ~3 Hz; empty payloads DO
        actively mean "no active alarms" once the alarm has cleared.
        The dashboard's own "recent stop reason" surface is what
        preserves cause after the alarm goes away."""
        if not isinstance(db, list):
            return
        self._alarms = db
        newest = None
        for entry in db:
            if not isinstance(entry, list) or len(entry) < 4:
                continue
            try:
                sev  = int(entry[0])
                code = int(entry[1])
                ts   = float(entry[2])
                text = str(entry[3])
            except (TypeError, ValueError):
                continue
            if newest is None or ts > newest['ts']:
                newest = {'severity': sev, 'code': code, 'ts': ts, 'text': text}
        # Set/clear active alarm. Empty db → active clears immediately;
        # non-empty → newest entry wins.
        prev = self._alarm_active
        self._alarm_active = newest
        # Log alarm transitions (append + clear) once, don't spam per frame.
        if newest is not None and (prev is None or prev.get('code') != newest['code']
                                                 or prev.get('text') != newest['text']):
            self.get_logger().warn(
                f'ALARM active: code={newest["code"]} '
                f'text={newest["text"]!r}')
        elif newest is None and prev is not None:
            self.get_logger().info(
                f'ALARM cleared (was code={prev.get("code")} '
                f'text={prev.get("text")!r})')
        self._publish_status_blob()

    def _on_posture(self, db):
        """publish/RobotPosture — db.joint[6] (deg), db.end {x,y,z mm, a,b,c deg}."""
        if not isinstance(db, dict):
            return
        joints = db.get('joint')
        if isinstance(joints, list) and len(joints) >= 6:
            # Vectorized-ish parse: single pass, deg → rad in place.
            new_deg = [float(joints[i]) for i in range(6)]
            # Snapshot the previous sample BEFORE overwriting — the
            # supervise-tick reactive backstop reads this pair as its
            # finite-difference joint velocity estimate.
            self._prev_joint_deg = list(self._joint_deg)
            self._prev_joint_ts  = self._last_posture_ts
            self._joint_deg = new_deg
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
        # Passive collision evaluation — refresh min-pair distance on
        # EVERY posture update so the 3D view's "min clearance" chip
        # stays live. mesh-mesh pairs are served from `_mesh_cache`,
        # populated by the mesh-refresh worker below (5 Hz off-loop) —
        # keeps the posture callback under ~6 ms even at the J3=122°
        # fold. No stop action here; stops only fire in
        # _check_collision_locked (jog-active path).
        if self._coll_model is not None:
            try:
                res = self._coll_model.evaluate(self._joint_deg)
                if res:
                    a, b, d = res[0]
                    self._coll_min_pair = (a, b)
                    self._coll_min_dist_mm = d
                # Separate the closest ENV pair — the escape popup
                # fires only on environment contact, not self.
                env = [(a, b, d) for a, b, d in res
                       if isinstance(a, str) and isinstance(b, str)
                       and (a.startswith('zone#') or b.startswith('zone#'))]
                if env:
                    a, b, d = env[0]
                    self._env_min_pair = (a, b)
                    self._env_min_dist_mm = d
                else:
                    self._env_min_pair = None
                    self._env_min_dist_mm = None
                # ── UNIFIED GUARD STATE ────────────────────────────────
                # Whichever pair (self / ground / env) is closest wins
                # and drives the guard popup. `guard_kind` picks the
                # right modal copy; `guard_escapes` is the operator's
                # live escape menu regardless of collision type.
                if res:
                    a, b, d = res[0]
                    is_ground = (a == '__ground__' or b == '__ground__')
                    is_env    = (isinstance(a, str) and a.startswith('zone#')) \
                              or (isinstance(b, str) and b.startswith('zone#'))
                    if is_ground: kind = 'ground'
                    elif is_env:  kind = 'env'
                    else:         kind = 'self'
                    self._guard_kind = kind
                    self._guard_pair = (a, b)
                    self._guard_min_dist_mm = d
                    # Threshold selection: env uses env_warn/stop; self+ground
                    # use collision_warn/stop. Per-pair YAML overrides win
                    # for pairs with a design floor (link3↔link5).
                    default_warn = self._env_warn_mm if kind == 'env' else self._coll_warn_mm
                    default_stop = self._env_stop_mm if kind == 'env' else self._coll_stop_mm
                    if kind == 'env':
                        warn_mm, stop_mm = default_warn, default_stop
                    else:
                        warn_mm, stop_mm = self._coll_model.thresholds_for(
                            (a, b), default_warn, default_stop)
                    self._guard_warn_effective_mm = warn_mm
                    self._guard_stop_effective_mm = stop_mm
                    self._guard_active = d <= warn_mm
                    # Escape probe table is 13× evaluate() (~78 ms). We
                    # can't afford it in the posture callback (25 Hz).
                    # Recompute only when d ≤ stop AND at most 2 Hz;
                    # otherwise reuse the last computed set. Popup UI
                    # only shows in stop band anyway (tiered policy),
                    # so this matches when the escapes are needed.
                    now_t = time.time()
                    if d <= stop_mm:
                        if now_t - self._guard_escapes_ts >= 0.5:
                            self._guard_escapes = \
                                self._coll_model.escape_directions_any(
                                    self._joint_deg, (a, b))
                            self._guard_escapes_ts = now_t
                    else:
                        # Cheap path: clear escapes when out of stop band.
                        if self._guard_escapes:
                            self._guard_escapes = []
                        self._guard_escapes_ts = 0.0
                # Env-specific escape publish (legacy consumers).
                self._env_escape_dirs = list(self._guard_escapes) if (
                    self._env_min_dist_mm is not None
                    and self._env_stop_mm is not None
                    and self._env_min_dist_mm <= self._env_stop_mm
                ) else []
            except Exception:
                pass
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
        # RobotStatus with a parseable state field is our fallback
        # readiness signal — proves the controller is publishing
        # state and the WS message pump is alive. The primary probe
        # (IOManager/GetIOInfo) may or may not be answered by this
        # firmware; either signal graduates us out of INITIALIZING.
        if state_int >= 0 and self._conn_sm.state == self._conn_sm.INITIALIZING:
            self._conn_sm.note_probe_response()
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
            # Ground-plane sanity check — the first time posture goes
            # live after enable, compute the minimum ground clearance
            # implied by the current pose and the configured
            # ground_z_mm. If ANY ground pair reports a NEGATIVE
            # distance (i.e. the model thinks a link is below the
            # physical floor), the configured value is wrong — WARN
            # loudly. This is the 2026-07-15 wedge signature: with
            # ground_z=0 default and normal pose, elbow was 87 mm
            # "above" but really 400+ mm above the actual floor.
            if (self._coll_model is not None
                    and self._last_posture_ts > 0.0):
                try:
                    res = self._coll_model.evaluate(self._joint_deg)
                    ground_res = [(a, b, d) for a, b, d in res
                                  if a == '__ground__' or b == '__ground__']
                    if ground_res:
                        _, _, min_d = ground_res[0]
                        if min_d < -50.0:   # 50 mm below "floor" is impossible
                            self.get_logger().warn(
                                f'GROUND SANITY FAIL: min ground clearance '
                                f'{min_d:.0f} mm at current pose with '
                                f'ground_z_mm={self._ground_z_mm:.0f}. The '
                                f'physical floor cannot be above the arm — '
                                f'check ground_z_mm in estun.yaml (should be '
                                f'-stand_height_mm).')
                        else:
                            self.get_logger().info(
                                f'ground clearance at enable pose: {min_d:.0f} mm '
                                f'(configured ground_z_mm={self._ground_z_mm:.0f})')
                except Exception:
                    pass

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
            'alarm':         self._alarm_active is not None,
            'alarm_count':   len(self._alarms),
            # Structured active alarm — {severity, code, ts, text} or None.
            # Dashboard banner uses text + code to render cause + recovery
            # guidance; specific codes (2002 joint-limit, 2006/13046 e-stop,
            # 2023 singular, 9012 power) get bespoke copy.
            'active_alarm':  self._alarm_active,
            # Latest stop reason surface — dashboard shows this as a
            # transient toast/banner line when last_stop_ts is recent.
            'last_stop_reason': self._last_stop_reason,
            'last_stop_ts':     self._last_stop_ts,
            'allow_power':   self._allow_power,
            'joints_deg':    list(self._joint_deg),
            'joints_rad':    list(self._joint_rad),
            # Cartesian-jog governor telemetry. sigma_min is None when
            # numpy isn't available (guard disabled — only the reactive
            # backstop remains). cart_scale is what the last supervise
            # tick applied to the commanded speed (1.0 = unchanged).
            'sigma_min':       self._last_sigma_min,
            'cart_scale':      self._last_sing_scale,
            'cart_sigma_soft': self._cart_sigma_soft,
            'cart_sigma_hard': self._cart_sigma_hard,
            # Self-collision guard telemetry. Dashboard uses `collision_pair`
            # + `collision_min_mm` to render an amber/red tint on the two
            # offending links plus a live "min clearance" readout when
            # any pair is under 2× warn.
            'collision_enabled':   self._coll_model is not None,
            'collision_pair':      (list(self._coll_min_pair)
                                    if self._coll_min_pair else None),
            'collision_min_mm':    self._coll_min_dist_mm,
            'collision_warn_mm':   self._coll_warn_mm,
            'collision_stop_mm':   self._coll_stop_mm,
            'collision_warning':   self._coll_warning_active,
            # Environment (static-obstacle) telemetry — separate from
            # self-collision so the dashboard can trigger the escape
            # popup only on env contact. Same warn/stop thresholds as
            # self today; keys are separate so they can diverge.
            'env_zone_count':      (self._coll_model.env_zone_count
                                    if self._coll_model else 0),
            'env_pair':            (list(self._env_min_pair)
                                    if self._env_min_pair else None),
            'env_min_mm':          self._env_min_dist_mm,
            'env_escape_dirs':     list(self._env_escape_dirs),
            # env_warn_mm/env_stop_mm are set in the guard block below;
            # do not add them here.
            # Unified guard state — one blob whatever the collision
            # kind. The frontend popup keys off `guard_active`;
            # `guard_kind` picks the headline copy.
            'guard_active':        self._guard_active,
            'guard_kind':          self._guard_kind,
            'guard_pair':          (list(self._guard_pair)
                                    if self._guard_pair else None),
            'guard_min_mm':        self._guard_min_dist_mm,
            'guard_warn_mm':       self._guard_warn_effective_mm,
            'guard_stop_mm':       self._guard_stop_effective_mm,
            'guard_escapes':       list(self._guard_escapes),
            # Env-specific thresholds (dashboard reads separately from
            # self/ground so it can label them).
            'env_warn_mm':         self._env_warn_mm,
            'env_stop_mm':         self._env_stop_mm,
            'ground_z_mm':         self._ground_z_mm,
            # Per-joint limit evaluation — one dict per joint so the
            # dashboard can render a live joint-limit recovery guide.
            # `out_of_range` means the joint is PAST its controller
            # limit — the state that latches the 2002 alarm. Since our
            # driver never emits Robot/jog while alarmed / disabled,
            # the operator must jog the joint back on the factory UI;
            # this field lets the dashboard render live guidance and
            # a progress readout as they do so. `near_limit` is the
            # softer "within margin" warning used pre-emptively by
            # the jog clamp.
            'joint_limits':  [
                {
                    'joint':         i + 1,
                    'current_deg':   self._joint_deg[i],
                    'limit_deg':     self._joint_limit_deg[i],
                    'margin_deg':    self._joint_limit_margin_deg,
                    'out_of_range':  abs(self._joint_deg[i]) > self._joint_limit_deg[i],
                    'near_limit':    abs(self._joint_deg[i]) > (self._joint_limit_deg[i] - self._joint_limit_margin_deg),
                    # Signed distance from the edge, for the recovery
                    # progress bar — negative = past limit (magnitude
                    # = degrees to bring the joint back INSIDE), positive
                    # = margin remaining.
                    'headroom_deg':  self._joint_limit_deg[i] - abs(self._joint_deg[i]),
                }
                for i in range(6)
            ],
            'tcp_mm':        list(self._tcp_mm),
            'tcp_m':         list(self._tcp_m),
            'monitor_only':  self._monitor_only,
            'allow_jog':     self._allow_jog,
            'allow_cartesian_jog': self._allow_cartesian_jog,
            'jog_active':    self._jog_active,
            'jog_mode':      self._jog_mode,
            'jog_index':     self._jog_index,
            'jog_direction': self._jog_direction,
            # Two-tier speed cap so the UI can render slider ceiling +
            # "capped" marker without a separate /estun/mode fetch.
            'jog_speed_cap':        self._jog_speed_cap,
            'operator_speed_limit': self._operator_speed_limit,
            'effective_speed_cap':  self._effective_speed_cap,
            'rejections':    dict(self._rej_counts),
            'ip':            self._robot_ip,
            'ip_source':     self._ip_source,
        }
        # Controller-boot-race state — dashboard System Check reads
        # `controller_init` for the "initializing — waiting" copy.
        # See connect_state.ConnectStateMachine + the driver's boot-race
        # comment block for the reasons this exists.
        sm_snap = self._conn_sm.status_snapshot()
        blob['controller_init'] = (
            'initializing' if sm_snap['conn_state'] == 'initializing'
            else 'cooldown'   if sm_snap['conn_state'] == 'cooldown'
            else 'ready'      if sm_snap['conn_state'] == 'ready'
            else 'disconnected'
        )
        blob['conn'] = sm_snap
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
        try:
            self._mesh_worker_stop.set()
        except Exception:
            pass
        self._disconnect()
        self._close_ws_log()
        super().destroy_node()


# Dispatch table for /estun/program ops. Populated after the class is
# defined so each entry references a bound method on the instance
# (called as handler(self, d) — see _on_program_command).
_PROGRAM_OP_HANDLERS = {
    'save':              EstunCodroidDriver._op_save,
    'run':               EstunCodroidDriver._op_run,
    'step':              EstunCodroidDriver._op_runstep,
    'runstep':           EstunCodroidDriver._op_runstep,
    'stop':              EstunCodroidDriver._op_stop,
    'pause':             EstunCodroidDriver._op_pause,
    'resume':            EstunCodroidDriver._op_resume,
    'set_start_line':    EstunCodroidDriver._op_set_start_line,
    'clear_start_line':  EstunCodroidDriver._op_clear_start_line,
    'set_breakpoint':    EstunCodroidDriver._op_set_breakpoint,
    'set_breakpoints':   EstunCodroidDriver._op_set_breakpoint,
    'clear_breakpoint':  EstunCodroidDriver._op_clear_breakpoint,
    'clear_breakpoints': EstunCodroidDriver._op_clear_breakpoint,
    'to_auto':           EstunCodroidDriver._op_to_auto,
    'to_manual':         EstunCodroidDriver._op_to_manual,
    'set_move_rate':     EstunCodroidDriver._op_set_move_rate,
    'set_manual_rate':   EstunCodroidDriver._op_set_move_rate,
    'set_auto_rate':     EstunCodroidDriver._op_set_auto_rate,
    'clear_error':       EstunCodroidDriver._op_clear_error,
}


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
