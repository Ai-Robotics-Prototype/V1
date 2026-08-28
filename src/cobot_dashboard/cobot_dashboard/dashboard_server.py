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
from datetime import datetime, timezone
from pathlib import Path

try:
    from . import breadcrumbs as _breadcrumbs
except ImportError:
    import breadcrumbs as _breadcrumbs  # type: ignore
BreadcrumbCollector     = _breadcrumbs.BreadcrumbCollector
thin_waypoints          = _breadcrumbs.thin_waypoints
is_stale                = _breadcrumbs.is_stale
effector_state_at_end   = _breadcrumbs.effector_state_at_end

# 2026-08-05 unified event log — one writer, daily rotation,
# 90-day retention. Fork registry: `event_log`. Every error/
# warning/info that the operator sees (or the platform emits
# internally) routes through `event_log.emit(...)` — no per-
# component log files.
try:
    from . import event_log as _event_log
except ImportError:
    import event_log as _event_log  # type: ignore

# 2026-08-05 per-device UI context — refresh-persistence. Fork
# registry: page_context_persistence. Server-owns which program
# is open on each device; browser localStorage carries none of
# this state.
try:
    from . import ui_context as _ui_context
except ImportError:
    import ui_context as _ui_context  # type: ignore

# 2026-08-05 disk watchdog + enforced retention. Fork registry:
# disk_watchdog. ONE place that caps every writable directory;
# ONE surface (/api/disk_status) the footer reads. Started at
# lifespan bring-up below.
try:
    from . import disk_watchdog as _disk_watchdog
except ImportError:
    import disk_watchdog as _disk_watchdog  # type: ignore

# Always-on joint flight recorder + excursion analyzer. Isolated
# modules so a recorder crash never touches the state pipeline.
try:
    from . import joint_recorder as _joint_recorder_mod
    from . import joint_excursions as _joint_excursions_mod
    from . import trajectory_fk as _trajectory_fk_mod
except ImportError:
    import joint_recorder as _joint_recorder_mod          # type: ignore
    import joint_excursions as _joint_excursions_mod       # type: ignore
    import trajectory_fk as _trajectory_fk_mod             # type: ignore
JointRecorder = _joint_recorder_mod.JointRecorder

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
    from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSHistoryPolicy, QoSDurabilityPolicy
    from sensor_msgs.msg import CameraInfo, Image, JointState, PointCloud2
    from geometry_msgs.msg import TransformStamped as _TFStamped
    try:
        from tf2_ros import StaticTransformBroadcaster as _StaticTFBroadcaster
    except ImportError:
        _StaticTFBroadcaster = None
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
    from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
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
_STATIC_DIR = _THIS_DIR.parent / "frontend" / "dist"
# Same path as _STATIC_DIR now — the historic mock_server/static override
# was retired (vite.config outputs directly to dist/, we serve from dist/).
# Kept as a named reference because System Check reads both; comparison
# is now trivially equal, so its stale-drift detection is effectively a
# no-op self-check. Legacy field, ripe for retirement in a follow-up.
_BUILT_FRONTEND_DIR = _STATIC_DIR


def _assert_frontend_coherent(static_dir):
    """Fail loud at module load if the serve dir is present but incoherent.

    Closes the stale-serving class (L497): index.html references a
    /assets/index-<hash>.js chunk; if that chunk isn't on disk in the
    same dir, the browser gets 404 for its main JS and shows a stub
    forever. Better to refuse startup so systemd escalates than to
    silently serve a broken shell.

    Missing dir → warn only (allows test imports in throwaway checkouts).
    Present dir + missing index.html → RuntimeError.
    Present index.html + missing referenced chunk → RuntimeError.
    All present → log the reconciled asset hash for the boot log.
    """
    import re as _re
    import logging as _lg
    log = _lg.getLogger("dashboard.bootcheck")
    if not static_dir.exists():
        log.warning("frontend dir missing: %s (skipping coherence check)", static_dir)
        return None
    index_path = static_dir / "index.html"
    if not index_path.is_file():
        raise RuntimeError(
            f"Frontend coherence FAIL: {index_path} not found. "
            f"Run `cd frontend && npm run build` before starting the dashboard."
        )
    html = index_path.read_text(encoding="utf-8", errors="replace")
    m = _re.search(r"/assets/(index-[A-Za-z0-9_-]+\.js)", html)
    if not m:
        raise RuntimeError(
            f"Frontend coherence FAIL: {index_path} has no /assets/index-*.js "
            f"reference. Bundle build produced no entry chunk."
        )
    chunk_name = m.group(1)
    chunk_path = static_dir / "assets" / chunk_name
    if not chunk_path.is_file():
        raise RuntimeError(
            f"Frontend coherence FAIL: index.html references {chunk_name} "
            f"but {chunk_path} does not exist on disk. Served bundle would 404 "
            f"on its main chunk. Rebuild: `cd frontend && npm run build`."
        )
    log.warning(  # WARN level so it lands in the systemd journal at default filter
        "frontend coherence OK: %s -> %s", static_dir, chunk_name)
    print(f"[dashboard] frontend coherence OK: {chunk_name} from {static_dir}",
          flush=True)
    return chunk_name


# Enforce at import — if the operator managed to install a broken frontend
# (missing index.html, missing referenced chunk), fail here so systemd's
# Restart=on-failure loops loudly instead of quietly serving a broken shell.
_SERVED_ASSET_AT_BOOT = _assert_frontend_coherent(_STATIC_DIR)

# Timestamp of the last /estun/status frame received (monotonic seconds
# via time.time()). Read by /api/systemcheck to compute controller
# freshness — a stale value means the driver went silent.
_last_estun_status_ts = [0.0]
# CRI-proxy state for JOG_BACKEND=ros2: /joint_states arrival is our
# arm-liveness signal when the WS estun_driver is intentionally down.
# _on_joint_states stamps this on every message; the proxy path in
# _on_joint_states populates STATE['robot'] fields the ArmEnableControl
# chip renders. Fresh > 200 ms = "ENABLED (CRI)", stale = "DISCONNECTED".
_last_joint_states_mono = [0.0]
# Read once at module load — matches the pattern used near main() but
# module-level so callback paths on the DashboardServer class can gate
# without re-reading env each frame.
_JOG_BACKEND_ENV = os.environ.get("JOG_BACKEND", "ws").strip().lower()
if _JOG_BACKEND_ENV not in ("ws", "ros2"):
    _JOG_BACKEND_ENV = "ws"

# ── PHANTOM-FEEDBACK CLASS FIX (2026-08-27, twin flicker-to-zero) ──
# Two writers to STATE.joints.positions can race:
#   1. _on_joint_states  — ROS /joint_states (canonical Joint1..Joint6)
#   2. _on_estun_status  — WS driver mirror `joints_rad`
# Under JOG_BACKEND=ws, roboai-estun publishes /joint_states with
# joint_1..joint_6 (lowercase). The canonical Joint1..Joint6 lookup in
# handler #1 misses every slot → `.get(n, 0.0)` fills all zeros → the
# twin flickers to home when handler #1 fires after handler #2.
# Structural fix: bind feedback consumption to JOG_BACKEND (each mode
# has ONE authoritative source; the other feed is IGNORED and counted).
# Safety net: quarantine ANY exact-all-zeros frame while the wire says
# the arm is enabled — that pose is impossible telemetry.
_twin_source_ignored: dict = {}
_phantom_zero_frames: dict = {}


def _is_all_zeros_positions(positions) -> bool:
    """True iff every joint position is within noise floor of 0.0.
    Noise floor: 4× upper-bound encoder LSB (5e-5 rad ≈ 0.003°), same
    threshold as the jog adapter's idle deadband."""
    try:
        return all(abs(float(p)) < 5.0e-5 for p in positions)
    except (TypeError, ValueError):
        return False


def _wire_arm_is_enabled() -> bool:
    """Read STATE.robot for the driver's most recent wire-observed
    RobotStatus.state. `state == 2` = physically enabled. Under any
    state != 2 (idle, disabling, faulted), the driver stops emitting
    RobotPosture — a zero frame at that point is a stale-frame race,
    not phantom feedback. Only quarantine when the arm is genuinely
    enabled per the wire."""
    with _state_lock:
        r = STATE.get("robot", {}) or {}
        st = r.get("state") if isinstance(r.get("state"), int) else None
    return st == 2
# Camera opt-out (2026-08-19 F1.4 rung-3 root-cause fix): under
# CAMERAS_DISABLED=1, skip Image/CameraInfo subscriptions + the PIL
# encode thread pool. py-spy proved cam-encode is the GIL hog whose
# ≥1 s stalls used to trigger the CRI-proxy disconnected flip. F1
# testing sessions don't need camera streams; keep them off. F3 owns
# the real fix (turbojpeg native / off-process encode).
_CAMERAS_DISABLED = os.environ.get("CAMERAS_DISABLED", "0").strip() == "1"
# Flap-detection bookkeeping for the CRI-proxy staleness loop. Exposed
# on /health so operators can see "arm chip is flapping — GIL stalls"
# without spelunking through logs. Zero-cost unless the loop fires.
_cri_proxy_stats = {
    "flips_down": 0,            # times we flipped connected → disconnected
    "flips_up":   0,            # times we flipped back to connected
    "last_flip_ts": 0.0,        # wall time of last flip
    "last_flip_kind": None,     # 'up' | 'down' | None
    "consecutive_stale_ticks": 0,  # current stale-tick counter
}


def _apply_cri_proxy_authority(r):
    """Under JOG_BACKEND=ros2, cri_proxy owns the arm-authority fields
    regardless of what estun_driver reports on /estun/status or /estun/mode.

    Called at the end of _on_joint_states, _on_estun_status, and _on_estun_mode
    so whichever handler ran last, the authority fields stay coherent. Without
    this, estun_driver in monitor_only (ESTUN_ALLOW_JOG=0, needed so jog_bridge
    stays authoritative) would leak allow_jog=false into STATE and trip the
    'JOG GATE CLOSED — set ESTUN_ALLOW_JOG=1' banner on JogControls.jsx:736 —
    the very banner F1.4 sessions kept hitting.

    No-op under JOG_BACKEND=ws so the legacy WS-authoritative path is
    unchanged.
    """
    if _JOG_BACKEND_ENV != "ros2":
        return
    r["connected"]            = True
    r["enabled"]              = True
    r["enabling"]             = False
    r["mode"]                 = "AUTO"
    r["safety_mode"]          = "normal"
    r["moving"]               = False
    r["jog_active"]           = False
    r["jog_mode"]             = None
    r["jog_index"]            = 0
    r["jog_direction"]        = 0
    r["allow_jog"]            = True
    r["allow_cartesian_jog"]  = False
    r["allow_power"]          = True
    r["allow_move"]           = True
    r["allow_io"]             = False
    r["alarm"]                = False
    r["alarm_count"]          = 0
    r["state_code"]           = 0
    r["status_flag"]          = 0
    r["monitor_only"]         = False
    r["jog_heartbeat_s"]      = 0.100
    r["jog_freshness_s"]      = 0.300
    r["jog_speed_cap"]        = 0.15
    r["operator_speed_limit"] = 0.25
    r["effective_speed_cap"]  = 0.15
    r["allow_jog_source"]     = "cri_proxy"
    r["allow_cart_source"]    = "f1_scope_refuses_cartesian"
    r["allow_power_source"]   = "cri_launch_manages_enable"
    r["allow_move_source"]    = "cri_proxy"
    r["arm_source"]           = "cri_ros2"
    r["arm_source_note"]      = ("Arm state proxied from /joint_states "
                                 "liveness — WS driver inactive under "
                                 "JOG_BACKEND=ros2; enable is managed "
                                 "by the CRI launch.")


# ---------------------------------------------------------------------------
# Shared state — updated by ROS2 callbacks, read by FastAPI
# ---------------------------------------------------------------------------

_state_lock = threading.RLock()  # 2026-08-28: reentrant to avoid the
# _on_estun_status (line 2131) → _wire_arm_is_enabled (line 229)
# self-deadlock introduced by the twin phantom-feedback fix (commit
# 09f3158). Fires under JOG_BACKEND=ws when the driver reports all-
# zero joints — deadlock froze the FastAPI event loop, tying up the
# accept queue on :8080. All 89 sites use `with _state_lock:` and
# none rely on non-reentrant semantics, so RLock is drop-in safe.

# COCO class-id → human-readable name (2026-08-03). Populated at
# import from src/cobot_bringup/config/coco_labels.txt so the file
# stays the ground truth for both the label list AND anything that
# needs to name a numeric COCO id (Isaac YOLOv8 decoder emits raw
# indices). Missing file falls back to the string id — safe, no
# crash.
_COCO_CLASS_NAMES: dict[int, str] = {}
try:
    _coco_path = '/home/teddy/cobot_ws/src/cobot_bringup/config/coco_labels.txt'
    if os.path.isfile(_coco_path):
        with open(_coco_path) as _fh:
            for _i, _line in enumerate(_fh.read().splitlines()):
                _name = _line.strip()
                if _name:
                    _COCO_CLASS_NAMES[_i] = _name
except Exception:
    _COCO_CLASS_NAMES = {}


STATE = {
    "safety": {"zone": "GREEN", "speed_scale": 1.0, "estop": False, "human_proximity": 2.4},
    "joints": {
        "names": ["J1", "J2", "J3", "J4", "J5", "J6"],
        # Zeros = URDF export pose (L-shape) for the Estun S10-140. The
        # prior [0, -1.571, 0.785, -0.785, 0, 0.209] were UR5e leftovers
        # from the mock server; they contorted this URDF. Real
        # /joint_states replace these once the robot is connected.
        "positions": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
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
    # D10-adjacent (2026-08-03): 3D detection positions come from
    # cam0's depth sampled at the YOLO bbox centroid, transformed to
    # base_link via the provisional `cam0→base_link` extrinsic in
    # config/sensor_transforms.yaml. The extrinsic is un-refined
    # (no AprilTag calibration yet), so absolute 3D positions carry
    # a "few centimeters" bias. Camera panel renders an "Extrinsic
    # uncalibrated" chip while this is False; flips to True when the
    # AprilTag calibration pipeline lands.
    "detections_calibrated": False,
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
        "allow_power": False,
        "enabled": False,
        "enabling": False,
        "alarm": False,
        "alarm_count": 0,
        "state_code": 0,
        "state_name": "",
        "active_alarm": None,
        "last_stop_reason": "",
        "last_stop_ts": 0.0,
        # 2026-08-04: structured cause snapshot from the driver
        # (_build_stop_cause_locked). See _jog_stop_cause_operator_copy
        # for the tag → operator-copy translator. Frontend renders the
        # translated {title, detail, technical} strings from
        # `stop_cause_copy`, never re-parsing this dict.
        "last_stop_cause": None,
        # Dashboard-composed operator copy for the latest stop. Set by
        # the /estun/mode subscriber whenever `last_stop_cause` changes.
        # Shape: {title, detail, technical, tag, ts}.
        "stop_cause_copy": None,
        # Live cart-mode joint-limit approach softening state (driver
        # side). None outside the soft zone; a dict while scaling.
        "cart_softening": None,
        "joint_limits": [],
        # None sentinel — the first driver-published state is ALWAYS
        # a transition (None → bool), so the event-log observation
        # fires on boot regardless of which side of the kill switch
        # the driver came up on. Any consumer reading this before the
        # first driver frame must treat None as "unknown, guards NOT
        # yet observed active" — same UX as boot-time uncertainty.
        "collision_enabled": None,
        "collision_pair": None,
        "collision_min_mm": None,
        "collision_warn_mm": 80.0,
        "collision_stop_mm": 30.0,
        "collision_warning": False,
        "env_zone_count": 0,
        "env_pair": None,
        "env_min_mm": None,
        "env_warn_mm": 80.0,
        "env_stop_mm": 30.0,
        "env_escape_dirs": [],
        "guard_active": False,
        "guard_kind": None,
        "guard_pair": None,
        "guard_min_mm": None,
        "guard_warn_mm": 80.0,
        "guard_stop_mm": 30.0,
        "guard_escapes": [],
        "ground_z_mm": -300.0,
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

# Raw cam0 color bytes + shape + intrinsics — populated by dedicated
# subscriptions so the AprilTag calibrator can detect on the ACTUAL
# raw pixels (not the JPEG cache above which discards the bytes after
# encoding). Only cam0 is captured this way — the calibration flow is
# cam0-only and we don't want to double the memory footprint just to
# keep cam1 raw around for the same purpose. Populated on every
# frame; a stale copy is fine (the operator sees the live JPEG stream
# and captures on demand).
#
# Shape: (H, W, 3) uint8, RGB. Intrinsics: (fx, fy, cx, cy). None
# until the first frame + first camera_info arrive.
_cam0_raw:   dict = {'rgb': None, 'ts': 0.0, 'width': 0, 'height': 0}
_cam0_intr:  dict = {'fx': None, 'fy': None, 'cx': None, 'cy': None}
_cam0_raw_lock = threading.Lock()

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

# WebSocket client queues. `_state_clients` is now a dict of ws → per-
# client dict {latest_txt, latest_seq, new_event, ack_event,
# last_acked_seq, ...}. See the /ws/state sender + broadcast loop for
# the ACK-gated protocol that bounds in-flight to one frame and
# prevents OS TCP-buffer backlog on slow tabs. Prior version held an
# asyncio.Queue per client and did drain-to-latest at put time; that
# did NOT bound in-flight because send_text returns after starlette
# accepts the bytes, not after they've been drained by the client.
_state_clients: dict = {}
_state_seq_counter = [0]   # single-elem list so nested funcs can bump
_lidar_clients: dict = {}
_mesh_clients:  dict = {}
_insp_clients:  dict = {}   # /ws/inspection — live inspection status
_motioncam_cloud_clients: dict = {}
_motioncam_reco_clients:  dict = {}
_ws_lock = threading.Lock()
# Rolling latency + inflight histogram for /health. Ring of the last
# 200 (server_broadcast_ts, client_ack_ts) pairs so ops can spot the
# growing-queue pattern quickly. Populated by _sender when an ack
# arrives.
_state_perf = {"acks": [], "inflight_ms_max": 0.0, "sends": 0, "ack_timeouts": 0}
_state_perf_lock = threading.Lock()

# ── Per-program revision + cross-client change events ────────────────
# Bug 1 fix (2026-07-27). Before this, program mutations (teach, link,
# save, rename, point CRUD) never notified other connected clients —
# a tablet teaching a step left the PC's editor showing the pre-teach
# state until manual reload. The design here piggybacks a lightweight
# event ring onto the periodic /ws/state broadcast:
#   1. Every mutation endpoint calls _bump_prog_rev(prog_id) which
#      returns a monotonically-increasing integer and stashes it into
#      prog['rev'] before write.
#   2. Every mutation endpoint also calls _emit_program_changed(...)
#      with the source_client id from the X-Client-Id header (or
#      empty string when the client didn't send one — old builds).
#   3. _emit_program_changed appends {type, program_id, rev,
#      source_client, ts_ms} to _prog_event_ring. The next /ws/state
#      broadcast serialises the last N events (aged out after
#      _PROG_EVENT_TTL_S) into STATE['program_events'] and clients
#      match against their local rev + source_client to decide whether
#      to refetch.
# Aged-out entries are dropped on each broadcast tick. The ring lives
# under _prog_event_lock; a state-broadcast reader snapshots the list
# with the lock held (~2 µs) so mutation writers never contend.
_prog_revs: dict[str, int] = {}
_prog_event_ring: list[dict] = []
_prog_event_lock = threading.Lock()
_PROG_EVENT_RING_MAX = 64
_PROG_EVENT_TTL_S    = 15.0

# 2026-07-31 CONVERGENCE FIX (operator-hit twice today, both
# directions): on server restart, _prog_revs was empty. Any client
# still holding a rev from the previous process saw the first
# post-restart event's rev come in LOWER than its held cp.rev, so
# `ev.rev > cp.rev` was FALSE and the refetch never fired. The
# tablet-vs-PC diverged and stayed diverged.
#
# Fix: seed the rev counter from every program's on-disk rev at
# startup so the first bump after restart always advances beyond
# what any live client could hold. Every mutation persists rev to
# disk (see _save_prog_with_event), so on-disk is the source of
# truth across restarts.
def _seed_prog_revs_from_disk() -> None:
    """Walk the programs directory and seed _prog_revs with each
    program's on-disk rev. Runs once at server startup so post-
    restart revs never regress below any live client's held value."""
    try:
        # The programs dir constant is defined inside the FastAPI
        # setup function (later in this module); default to the
        # canonical path used by every deploy.
        prog_dir = os.environ.get("COBOT_PROG_DIR") or "/opt/cobot/programs"
        if not os.path.isdir(prog_dir):
            return
        seeded = 0
        for name in os.listdir(prog_dir):
            if not name.endswith(".json"):
                continue
            if name.startswith("_"):
                continue        # _folders.json etc.
            path = os.path.join(prog_dir, name)
            try:
                with open(path) as f:
                    p = json.load(f)
                prog_id = p.get("id") or name[:-5]
                rev = int(p.get("rev") or 0)
                with _prog_event_lock:
                    prev = _prog_revs.get(prog_id)
                    # Seed even when rev is 0: the revs endpoint must
                    # report EVERY known program so clients can detect
                    # a "held rev higher than server-truth" case (which
                    # happens after a restart resets in-memory state
                    # while a client still holds a pre-restart rev).
                    if prev is None or rev > prev:
                        _prog_revs[prog_id] = rev
                        seeded += 1
            except Exception:
                continue
        if seeded:
            # log() may not be initialised yet at import; use print
            # so the seed count reaches journalctl on startup.
            print(f"[dashboard] _prog_revs seeded from disk: "
                  f"{seeded} program(s)")
    except Exception:
        pass

def _bump_prog_rev(prog_id: str) -> int:
    with _prog_event_lock:
        r = int(_prog_revs.get(prog_id, 0)) + 1
        _prog_revs[prog_id] = r
        return r

def _snapshot_prog_revs() -> dict:
    """Copy the full {id: rev} map so the state broadcast can carry
    it without holding the lock across json.dumps. Small (< 100
    programs typical) so copying every tick is cheap."""
    with _prog_event_lock:
        return dict(_prog_revs)

def _emit_program_changed(program_id: str, rev: int, source_client: str,
                          kind: str = "mutation") -> None:
    """Append a program_changed event to the ring for the next
    /ws/state broadcast to fan out. Non-blocking. `kind` is a free-
    form tag (teach / save / points / rename / delete) surfaced to
    the client for optional finer-grained UI (toast text)."""
    if not program_id:
        return
    entry = {
        "type":          "program_changed",
        "program_id":    program_id,
        "rev":           int(rev),
        "source_client": str(source_client or ""),
        "kind":          str(kind or "mutation"),
        "ts_ms":         int(time.time() * 1000),
    }
    with _prog_event_lock:
        _prog_event_ring.append(entry)
        if len(_prog_event_ring) > _PROG_EVENT_RING_MAX:
            del _prog_event_ring[:len(_prog_event_ring) - _PROG_EVENT_RING_MAX]

def _snapshot_program_events() -> list[dict]:
    """Return non-expired events for inclusion in the STATE broadcast.
    Copies out under the lock so the broadcaster never holds it across
    a json.dumps call."""
    now_ms = time.time() * 1000
    cutoff = now_ms - (_PROG_EVENT_TTL_S * 1000)
    with _prog_event_lock:
        # Age-out in-place so the ring doesn't grow unbounded when
        # no one is watching. This is the only place we prune; the
        # append path caps at _PROG_EVENT_RING_MAX as a hard ceiling.
        while _prog_event_ring and _prog_event_ring[0]["ts_ms"] < cutoff:
            _prog_event_ring.pop(0)
        return list(_prog_event_ring)


# ── Bounded per-client queue with drop-oldest backpressure ────────────
# Part E fix (2026-07-22). Previous pattern was `if q.qsize() < 2:
# await q.put(...)` — drop-NEWEST when full, so a slow client saw
# STALE data while the newest telemetry was silently discarded.
# Drop-oldest is the correct choice for live streams: whenever the
# queue is full, evict the oldest queued item to make room for the
# new one. Freshness beats completeness for telemetry.
#
# Records the number of drops per broadcast channel so /health can
# surface a backpressure trend without needing SIGUSR1 dumps.
_ws_drops = {"state": 0, "lidar": 0, "mesh": 0,
             "motioncam_cloud": 0, "motioncam_reco": 0}
_ws_drops_lock = threading.Lock()


def _put_drop_oldest(q, payload, channel: str) -> None:
    """Enqueue `payload` on `q`, dropping the oldest queued item first
    if the queue is at its maxsize. Increments `_ws_drops[channel]`
    when an eviction happens. Never blocks; returns synchronously.

    Called from the async broadcaster where the queue is already an
    asyncio.Queue on the same event loop, so put_nowait / get_nowait
    are the right calls (they don't context-switch)."""
    try:
        q.put_nowait(payload)
        return
    except asyncio.QueueFull:
        pass
    # Full — evict oldest, then put. If a concurrent consumer beat us
    # to it, put_nowait may succeed on the second try; otherwise we
    # retry the evict+put once more before giving up (avoids an
    # infinite loop under pathological contention).
    for _ in range(2):
        try:
            q.get_nowait()
            with _ws_drops_lock:
                _ws_drops[channel] = _ws_drops.get(channel, 0) + 1
        except asyncio.QueueEmpty:
            pass
        try:
            q.put_nowait(payload)
            return
        except asyncio.QueueFull:
            continue
    # Give up rather than block.
    with _ws_drops_lock:
        _ws_drops[channel] = _ws_drops.get(channel, 0) + 1

def _state_perf_snapshot():
    """Read-only snapshot for /health. p50/p95 over the last ~200 acks;
    inflight_ms_max is the peak broadcast→send-complete gap observed
    since server start. High p95 with rising inflight_ms_max is the
    signature the sender's ack gate is falling behind — i.e., the
    twin will feel laggy on the offending tab."""
    with _state_perf_lock:
        acks = list(_state_perf['acks'])
        sends = _state_perf['sends']
        ack_timeouts = _state_perf['ack_timeouts']
        inflight_max = _state_perf['inflight_ms_max']
    if acks:
        s = sorted(acks)
        p50 = s[len(s)//2]
        p95 = s[min(len(s)-1, int(len(s)*0.95))]
    else:
        p50 = p95 = None
    return {
        "sends": sends,
        "ack_timeouts": ack_timeouts,
        "acks_seen": len(acks),
        "ack_lat_ms_p50": (round(p50, 1) if p50 is not None else None),
        "ack_lat_ms_p95": (round(p95, 1) if p95 is not None else None),
        "inflight_ms_max": round(inflight_max, 1),
    }

# WS backpressure protection. Prior defect: a slow tablet's TCP send
# buffer accumulated multi-MB backlogs and the consumer coroutine spent
# most of its time blocked in `await send_text`, dragging /cmd/jog POST
# latency past the driver's 300 ms freshness deadman and turning
# continuous jog into step mode. Fix: every per-client send is wrapped
# in `asyncio.wait_for(..., timeout=WS_SEND_TIMEOUT_S)`. A client whose
# send hasn't drained in that window gets its socket closed — the
# broadcaster stops fanning frames to it and the fast path stays fast.
# 0.5 s is generous for a state-broadcast frame (~9 KB): loopback sends
# complete sub-ms, LAN wifi tablets round-trip in <100 ms. Anything past
# 500 ms means the client's TCP receive window is stuck (tab throttled,
# laptop closed, wifi dead) — kicking it protects the fast path. The
# reconnect loop already backs off exponentially, so a truly healthy
# client that hits a brief blip gets a graceful reconnect.
WS_SEND_TIMEOUT_S = 0.5
# Cumulative kicks per stream, exposed on /health for observability.
_ws_kicked = {"state": 0, "lidar": 0, "mesh": 0,
              "motioncam_cloud": 0, "motioncam_reco": 0}

# Camera-encode worker pool. Wire evidence (2026-07-15 continuous jog
# session): the ROS executor thread's synchronous PIL JPEG encode was
# holding the GIL long enough in bursts that the asyncio loop's WS
# receive latency crossed the driver's 300 ms freshness deadman about
# 5 % of intervals, firing "hold staleness" mid-hold. Moving the
# encode off the ROS callback (encode runs in this pool; the callback
# returns after the submit) both frees the ROS executor for
# subsequent frames and reduces GIL contention with the asyncio loop.
# Small pool (2 workers = one per camera): the encode itself releases
# GIL inside PIL's native code, so more threads wouldn't help and
# would only add scheduler churn.
import concurrent.futures as _futures
_cam_encode_pool = _futures.ThreadPoolExecutor(
    max_workers=2, thread_name_prefix='cam-encode')
# Drop-latest: if a previous encode is still in flight for a camera,
# skip this frame rather than queue. Freshness > completeness for
# telemetry cameras; the operator sees the newest frame within one
# encode wall time. _cam_encode_busy[cam_id] is a bool the ROS thread
# consults before submitting.
_cam_encode_busy = {0: False, 1: False}
_cam_encode_busy_lock = threading.Lock()

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
# Guided recovery — event journal (Lesson 165 extension, 2026-08-05)
# ---------------------------------------------------------------------------
# When a joint enters / exits the escape-only zone, append a JSON line
# to /opt/cobot/logs/recovery_events.jsonl. Source material for the
# commissioning wizard: which joint, at what angle, how long the
# operator lingered, whether they recovered via the dialog or manually.
#
# Best-effort. A failed write never blocks the state-message pipeline
# or the driver's clamp behavior — the safety action already happened.

_RECOVERY_EVENTS_PATH = '/opt/cobot/logs/recovery_events.jsonl'


def _write_recovery_events_from_jl(prev_jl, new_jl) -> None:
    """Emit `past_escape_only_entered` / `past_escape_only_exited`
    events by comparing successive joint_limits snapshots. `prev_jl`
    and `new_jl` are both lists of dicts with 'joint',
    'past_escape_only', 'current_deg', 'limit_deg',
    'escape_only_edge_deg'. Silently skips when the shapes don't
    line up."""
    if not isinstance(new_jl, list) or not new_jl:
        return
    prev_by_j = {}
    if isinstance(prev_jl, list):
        for j in prev_jl:
            try:
                prev_by_j[int(j.get('joint'))] = bool(j.get('past_escape_only'))
            except (TypeError, ValueError, AttributeError):
                continue
    lines = []
    ts = time.time()
    for j in new_jl:
        try:
            jn = int(j.get('joint'))
        except (TypeError, ValueError, AttributeError):
            continue
        now = bool(j.get('past_escape_only'))
        was = prev_by_j.get(jn, False)
        if now == was:
            continue
        lines.append({
            'ts':          ts,
            'kind':        'past_escape_only_entered' if now else 'past_escape_only_exited',
            'joint':       jn,
            'current_deg': j.get('current_deg'),
            'limit_deg':   j.get('limit_deg'),
            'escape_only_edge_deg': j.get('escape_only_edge_deg'),
            'headroom_deg': j.get('headroom_deg'),
        })
    if not lines:
        return
    try:
        os.makedirs(os.path.dirname(_RECOVERY_EVENTS_PATH), exist_ok=True)
        with open(_RECOVERY_EVENTS_PATH, 'a') as fh:
            for entry in lines:
                fh.write(json.dumps(entry) + '\n')
    except Exception:
        # Recovery journal is best-effort — a full disk or permission
        # error must not block the state pipeline.
        pass


# ---------------------------------------------------------------------------
# Jog stop-cause operator copy (Lesson 165 / directive 2026-08-04)
# ---------------------------------------------------------------------------
# Fork registry canonical: this function is the SINGLE translator from
# the driver's structured `last_stop_cause` dict → operator-language
# {title, detail, technical} triple. The frontend renders these strings
# verbatim and MUST NOT re-parse the raw reason text on its own.
# Registered in `tools/fork_registry.yaml` under
# `jog_stop_cause_propagation`.
#
# 267108a register: title/detail carry operator language only. Banned
# tokens (dyn margin, cart limit approach, mm2mAndDeg2rad, exitProcess,
# firmware bug, v.size(), σ_min, sigma_soft, freshness deadman) live
# in `technical` if anywhere. Positive phrasing tells the operator
# WHAT to do to recover.

_JOG_STOP_CAUSE_BANNED_TOKENS = (
    'dyn margin', 'cart limit approach', 'limit approach J',
    'mm2mAndDeg2rad', 'v.size()', 'exitProcess', 'firmware bug',
    'σ_min', 'sigma_soft', 'sigma_hard', 'freshness deadman',
    'hold staleness', 'hb send failed',
)


def _jog_stop_cause_operator_copy(cause: dict, joint_limits: list) -> dict:
    """Translate the driver's structured stop_cause into operator copy.
    Returns {title, detail, technical, tag, ts}. The frontend renders
    title + detail on the jog surface; `technical` is stashed for the
    log/monitor readout only.

    joint_limits is the driver-published per-joint list (each entry
    has current_deg / limit_deg / margin_deg / etc.), used to render
    the absolute joint limit ("of ±200°") the operator sees.
    """
    if not isinstance(cause, dict):
        cause = {}
    tag = str(cause.get('tag') or 'other')
    ts  = float(cause.get('ts') or 0.0)
    raw = str(cause.get('raw') or '')
    joint_i1 = cause.get('joint_index_1based')
    joint_deg = cause.get('joint_deg')
    joint_limit_deg = cause.get('joint_limit_deg')
    jog_mode = cause.get('jog_mode')

    def _joint_limit_display(idx1):
        # Prefer the fresh driver-published limit; fall back to the
        # cause snapshot's limit_deg.
        try:
            if isinstance(joint_limits, list) and 1 <= idx1 <= len(joint_limits):
                jl = joint_limits[idx1 - 1]
                lim = jl.get('limit_deg')
                if isinstance(lim, (int, float)) and lim > 0:
                    return f'±{lim:.0f}°'
        except Exception:
            pass
        if isinstance(joint_limit_deg, (int, float)) and joint_limit_deg > 0:
            return f'±{joint_limit_deg:.0f}°'
        return 'its limit'

    def _out(title, detail, technical=None):
        return {
            'title':      title,
            'detail':     detail,
            'technical':  technical or raw,
            'tag':        tag,
            'ts':         ts,
        }

    # Route by tag. joint_limit gets bespoke operator copy for cart
    # vs joint mode. release_cmd is suppressed by the frontend (it's
    # the operator's own gesture), but we still return a triple so a
    # log reader can see the tag.
    if tag == 'joint_limit' or tag == 'joint_limit_deeper':
        if joint_i1 and isinstance(joint_deg, (int, float)):
            lim_s = _joint_limit_display(joint_i1)
            # Escape direction: reduces abs(joint_deg). If joint is at
            # negative angle, escape is +; if positive, escape is -.
            escape_sym = '+' if joint_deg < 0 else '-'
            if jog_mode == 'continuous_cart':
                return _out(
                    f'Jog stopped — J{joint_i1} past its limit.',
                    (f'J{joint_i1} is at {joint_deg:+.0f}° of {lim_s}. '
                     f'Switch to Joint mode and jog {escape_sym}J{joint_i1} '
                     f'to recover, then retry cart.'),
                )
            # Joint-mode: name the exact button that works.
            return _out(
                f'Jog stopped — J{joint_i1} past its limit.',
                (f'J{joint_i1} is at {joint_deg:+.0f}° of {lim_s}. '
                 f'Jog {escape_sym}J{joint_i1} to recover.'),
            )
        return _out(
            'Jog stopped — a joint is past its limit.',
            'Jog the opposite direction to recover.',
        )

    if tag == 'freshness_deadman':
        return _out(
            'Jog stopped — connection jitter.',
            'The keep-alive from the browser was interrupted. '
            'Release and press again to continue.',
        )

    if tag == 'collision_guard':
        # 2026-08-05 (operator directive: clearance warnings OFF).
        # Warn tier is disabled everywhere; the ONLY collision
        # signal left is this hard-stop copy. Split by guard_kind
        # so the operator sees language that matches what the arm
        # actually did: bumped itself vs bumped the floor vs
        # bumped an environment obstacle. Distance is embedded so
        # the operator gets an at-a-glance sanity read on how
        # close the arm actually got before halting.
        guard_kind = str(cause.get('guard_kind') or '')
        dist_mm    = cause.get('dist_mm')
        dist_s     = f'{int(dist_mm)} mm' if isinstance(dist_mm, (int, float)) else '—'
        if guard_kind == 'self':
            return _out(
                f'Jog stopped — arm too close to itself, {dist_s}.',
                'The 15 mm hard-stop guard fired. Jog the arm away '
                'from itself to continue.',
            )
        if guard_kind == 'ground':
            return _out(
                f'Jog stopped — arm too close to the floor, {dist_s}.',
                'The ground-plane hard limit fired. Jog the arm up '
                'to continue.',
            )
        # env / unknown — keep the pre-directive phrasing. The
        # workspace-obstacle path is a distinct hazard the
        # operator has not asked to reshape.
        return _out(
            'Jog stopped — approaching an obstacle.',
            'Motion got within the safety distance of a nearby '
            'surface. Jog away from it or check the workspace clearance.',
        )

    if tag == 'zero_speed':
        return _out(
            'Jog stopped — zero speed commanded.',
            'Speed slider is at 0. Raise it and press again.',
        )

    if tag == 'hold_transition':
        return _out(
            'Jog switched — new direction.',
            'The previous jog was ended when a different direction '
            'was pressed. Release and re-press to continue.',
        )

    if tag == 'send_failed' or tag == 'hb_send_failed':
        return _out(
            'Jog stopped — controller unreachable.',
            'The link to the arm dropped. Wait for the DRIVER '
            'indicator to turn green, then press again.',
        )

    if tag == 'increment_end':
        return _out(
            'Increment complete.',
            'The step increment finished normally.',
        )

    if tag == 'release_cmd':
        # Frontend suppresses this one (it's the operator's own gesture),
        # but we still surface it to the log reader.
        return _out(
            'Jog released.',
            'Motion ended when the button was released.',
        )

    # Fallback — 'other'. Operator sees a generic line; the raw wire
    # text goes into `technical` for the log.
    return _out(
        'Jog stopped.',
        'Motion ended. Check the driver logs for the specific cause.',
    )


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
        # Records program-execution joint waypoints so Return Home
        # can retrace the proven path rather than improvise a direct
        # move through unproven space. See breadcrumbs.py.
        self._breadcrumbs = BreadcrumbCollector()

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

        # Driver mode heartbeat — carries the allow_move/allow_jog/allow_power
        # gates + program-execution live fields (program_state, program_line,
        # is_step, active project_id). Monitor "Run" needs these to render
        # the confirm modal's gate warning and the live line indicator.
        self.create_subscription(String, "/estun/mode", self._on_estun_mode, 5)
        # Program lifecycle events from the driver — save (HTTP result set),
        # status (ProjectState snapshots), error (deduped publish/Error).
        self.create_subscription(String, "/estun/program_status",
                                 self._on_estun_program_status, 10)
        # Driver rejections — surface gate-closed and other refusals to the UI
        # so the Run modal shows exactly WHY nothing happened when it didn't.
        self.create_subscription(String, "/estun/rejected",
                                 self._on_estun_rejected, 10)
        # I/O bridge — driver polls IOManager/GetIOValue + GetIOInfo and
        # publishes the merged snapshot here. /api/io/live re-exposes it.
        self.create_subscription(String, "/estun/io",
                                 self._on_estun_io, 10)
        # Write path for manual DO / DI-force actions — dashboard's
        # /api/io/force publishes here and the driver gates on allow_io.
        self._estun_io_set_pub = self.create_publisher(
            String, "/robot/io_set", 5)
        # Publisher for the /estun/program op-envelope. Created EAGERLY at
        # node construction so DDS discovery completes long before the
        # operator hits Run. The old lazy-init raced with discovery:
        # /api/estun/program/run publishes save→to_auto→…→run in a tight
        # burst, and the FIRST call was the one that created the
        # publisher — so the driver's subscriber was still being
        # discovered when the `save` op fired and RELIABLE+VOLATILE
        # dropped it, while the later ops (to_auto through project/run)
        # made it. Result: controller received `project/run testwizard`
        # against a projectlist that had never been updated → alarm
        # 10001 "Project <testwizard> does not exist." Depth grows from
        # 5 → 16 so the 6-op burst can never pressure the subscriber's
        # queue either.
        self._estun_program_pub = self.create_publisher(
            String, "/estun/program", 16)

        # SEAM A fanout publisher for JOG_BACKEND='ros2'. Created EAGERLY
        # here so DDS discovery matches with jog_bridge's subscriber long
        # before the operator's first press. Previously lazy-created in
        # _publish_ros2_jog_event on the first jog event — that lost the
        # DDS discovery race under RELIABLE+VOLATILE, and the first press
        # after a dashboard or jog_bridge restart silently dropped: no
        # error, no toast, arm just didn't move. Same eager-init fix that
        # closed the /estun/program 6-op burst race above; both are
        # instances of the [[cobot-dds-lazy-publisher-hazard]] class.
        # QoS matches jog_bridge's expected profile exactly.
        self._dashboard_jog_events_pub = self.create_publisher(
            String, "/dashboard/jog_session_events",
            QoSProfile(
                depth=10,
                reliability=QoSReliabilityPolicy.RELIABLE,
                history=QoSHistoryPolicy.KEEP_LAST,
                durability=QoSDurabilityPolicy.VOLATILE,
            ))
        # Peer state for _publish_ros2_jog_event's kind derivation +
        # refresh coalescing. Initialized empty here so the fanout
        # function can assume they exist without a hasattr dance.
        self._jog_session_seen = set()          # hold_ids seen at least once
        self._jog_last_refresh_mono = {}        # hold_id -> monotonic ts of last refresh

        # Program executor state (richer than /task/status: step labels,
        # cycle stats, executor-state strings like 'waiting_motion').
        self.create_subscription(String, "/task/state", self._on_task_state, 10)

        # Grasp planner output (JSON String — full per-candidate metadata).
        self.create_subscription(String, "/grasp/candidates",
                                 self._on_grasp_candidates, 5)

        # Stereo-verified objects with LiDAR-anchored Z (JSON String).
        self.create_subscription(String, "/perception/placed_objects",
                                 self._on_placed_objects, 5)

        # CAMERAS_DISABLED=1 skips ALL Image/CameraInfo subscriptions +
        # the PIL encode thread pool never gets work. Root-cause fix
        # for the F1.4 rung-3 fingerprint: py-spy proved cam-encode is
        # the GIL hog whose >1 s stalls flipped the CRI proxy to
        # DISCONNECTED, killing jog. F1 sessions don't need video; F3
        # will land the real turbojpeg/off-process fix.
        if _CAMERAS_DISABLED:
            self.get_logger().warn(
                "CAMERAS_DISABLED=1 — skipping cam0/cam1 Image subscriptions "
                "and the /perception/annotated_image* taps. No camera "
                "streaming this session. F3 owns the real fix.")
        else:
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
            # Raw cam0 tap for AprilTag calibration. Separate sub so the
            # JPEG-encode drop-latest guard on _on_camera doesn't cost us
            # detection frames — we take the raw bytes fresh regardless
            # of the encoder's state. camera_info gives fx/fy/cx/cy the
            # detector needs.
            self.create_subscription(Image, "/cam0/cam0/color/image_raw",
                                     self._on_cam0_raw, 2)
            self.create_subscription(CameraInfo, "/cam0/cam0/color/camera_info",
                                     self._on_cam0_info, 2)

        # Static TF broadcaster used by the cam0 extrinsic calibration
        # save endpoint. Kept as a lazy None until _broadcast_cam0_
        # extrinsic() first needs it — importing tf2_ros at module
        # load is optional (typed as None when unavailable) so the
        # dashboard boots even on a rig without tf2_ros installed.
        self._static_tf_bcast = None

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

        # CRI-proxy staleness watchdog: under JOG_BACKEND=ros2 with the WS
        # estun_driver intentionally down, _on_joint_states populates the
        # ArmEnableControl chip fields from JS liveness. But if JS stops
        # (arm faulted / launch died), no _on_joint_states means no update
        # — chip would keep showing ENABLED forever. This daemon flips the
        # chip to DISCONNECTED after 1.0 s of no JS. Silent per §285: a
        # stopped arm should NEVER read as ENABLED.
        threading.Thread(target=self._cri_proxy_staleness_loop,
                          name="cri-proxy-staleness",
                          daemon=True).start()

        self.get_logger().info("DashboardServer ready")

    def _cri_proxy_staleness_loop(self):
        """5 Hz staleness watchdog with HYSTERESIS (2026-08-19 F1.4 fix).

        Pre-fix: single-tick decision at js_age > 1.0 s flipped
        STATE['robot'] to DISCONNECTED, which the frontend reads as
        jogGateOk=false — every jog press dies silently in the browser.
        Under JOG_BACKEND=ros2 estun_stale is ALWAYS true (WS driver
        down by design), so any single >1 s GIL stall (PIL cam-encode
        is the known repeat offender, py-spy proven) instantly killed
        jog until the NEXT fresh JS.

        Post-fix: require 3 CONSECUTIVE stale ticks at threshold=3.0s
        (~3.6 s sustained silence, not just one bad tick) before
        flipping DOWN. Any fresh JS resets the counter to 0; the
        _on_joint_states callback populates the fresh 'connected'/
        'enabled' state on every message (natural flip-up). This loop
        only handles the DOWN edge + flap bookkeeping.

        Decision logic is in cobot_dashboard.staleness so unit tests
        can exercise the state machine with a fake clock.
        """
        from .staleness import staleness_decide  # local import — avoid module-time coupling
        is_disconnected = False
        while True:
            try:
                if _JOG_BACKEND_ENV == "ros2":
                    now_mono = time.monotonic()
                    js_age = (now_mono - _last_joint_states_mono[0]
                              if _last_joint_states_mono[0] > 0 else 1e9)
                    estun_age = time.time() - _last_estun_status_ts[0]
                    new_stale, new_disc, flip = staleness_decide(
                        js_age_s=js_age,
                        estun_age_s=estun_age,
                        consecutive_stale_ticks=_cri_proxy_stats["consecutive_stale_ticks"],
                        is_disconnected=is_disconnected,
                    )
                    _cri_proxy_stats["consecutive_stale_ticks"] = new_stale
                    if flip == "down":
                        with _state_lock:
                            r = STATE.setdefault("robot", {})
                            r["connected"]    = False
                            r["enabled"]      = False
                            r["enabling"]     = False
                            r["mode"]         = "unknown"
                            r["safety_mode"]  = "unknown"
                            r["moving"]       = False
                            r["allow_jog"]    = False
                            r["allow_cartesian_jog"] = False
                            r["allow_power"]  = False
                            r["allow_move"]   = False
                            r["alarm"]        = False
                            r["state_code"]   = 0
                            r["status_flag"]  = 0
                            # Safe-side: undefined monitor_only defaults to
                            # "on" in frontend gating — explicitly True on
                            # DOWN keeps the safe-until-proven-live semantic.
                            r["monitor_only"] = True
                            r["arm_source"]   = "cri_ros2"
                            r["arm_source_note"] = (
                                f"/joint_states stale {js_age:.1f}s — "
                                f"CRI stream absent or arm faulted (flip "
                                f"#{_cri_proxy_stats['flips_down'] + 1}). "
                                "Enable managed by the CRI launch; check "
                                "the launch tmux for errors.")
                        _cri_proxy_stats["flips_down"] += 1
                        _cri_proxy_stats["last_flip_ts"] = time.time()
                        _cri_proxy_stats["last_flip_kind"] = "down"
                    elif flip == "up":
                        # _on_joint_states already populated fresh state on
                        # the fresh JS callback — this branch is bookkeeping
                        # only. Flap count is what operators watch.
                        _cri_proxy_stats["flips_up"] += 1
                        _cri_proxy_stats["last_flip_ts"] = time.time()
                        _cri_proxy_stats["last_flip_kind"] = "up"
                    is_disconnected = new_disc
            except Exception:
                pass
            time.sleep(0.2)

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
            # 2026-08-03 — Isaac YOLOv8 decoder emits class_id as the
            # RAW COCO index (e.g. '39'='bottle', '61'='dining table').
            # The classical `depth_segment_node` we retired used to
            # emit human-readable strings, so the frontend expects
            # names. Map numeric ids → COCO string names here so the
            # overlay reads "bowl" instead of "45".
            if class_name.isdigit():
                class_name = _COCO_CLASS_NAMES.get(
                    int(class_name), class_name)
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
        now_mono = time.monotonic()
        _last_joint_states_mono[0] = now_mono
        # ── PHANTOM-FEEDBACK CLASS FIX (2026-08-27, twin flicker-to-zero) ──
        # Under JOG_BACKEND=ws the WS driver's /estun/status mirror is the
        # authoritative source for STATE.joints.positions (it carries
        # joints_rad from RobotPosture). The ROS /joint_states topic the
        # driver ALSO publishes uses lowercase names (joint_1..joint_6);
        # this handler was originally written for the CRI-JSB naming
        # convention (Joint1..Joint6, capitalized). Under ws the canonical
        # lookup misses every slot → the fallback 0.0 fills the twin →
        # racing with the real writer, the twin flickers to zero.
        # Structural fix: under ws, IGNORE this feed entirely.
        if _JOG_BACKEND_ENV == "ws":
            _twin_source_ignored["ws_joint_states"] = (
                _twin_source_ignored.get("ws_joint_states", 0) + 1)
            return
        # Normalize to canonical [Joint1..Joint6] order. JSB in the live CRI
        # launch is publishing names in [Joint2, Joint3, Joint1, Joint4, Joint5,
        # Joint6] because the spawner isn't honoring joint_state_broadcaster.
        # yaml's `joints:` param at runtime (see the yaml's own head comment:
        # "顺序会变成 2,3,1…"). Frontend indexes joints.positions[] by slot,
        # not by name — under the raw order, positions[0..2] would go to
        # Joint1/2/3's twin slots as Joint2/3/1's values, scrambling the
        # base/shoulder/elbow render. Normalize here so every consumer
        # (RobotControls, ArmViewer3D, StandaloneRobot) sees the correct
        # index→joint mapping. Root-cause fix (JSB spawner param) queued for F3.
        pos_by_name = dict(zip(msg.name, msg.position))
        vel_by_name = dict(zip(msg.name, msg.velocity)) if msg.velocity else {}
        canonical = ["Joint1", "Joint2", "Joint3", "Joint4", "Joint5", "Joint6"]
        ordered_pos = [float(pos_by_name.get(n, 0.0)) for n in canonical]
        ordered_vel = [float(vel_by_name.get(n, 0.0)) for n in canonical]
        # ── All-zeros quarantine (phantom-feedback safety net). Even under
        # the CRI-JSB path, an exact-all-zeros frame while the arm is
        # actually enabled is impossible telemetry — quarantine + count.
        if _is_all_zeros_positions(ordered_pos) and _wire_arm_is_enabled():
            _phantom_zero_frames["cri_joint_states"] = (
                _phantom_zero_frames.get("cri_joint_states", 0) + 1)
            return
        with _state_lock:
            STATE["joints"]["names"]      = list(canonical)
            STATE["joints"]["positions"]  = ordered_pos
            STATE["joints"]["velocities"] = ordered_vel
            # CRI proxy is authoritative for arm-authority fields whenever
            # JOG_BACKEND=ros2. Previously gated on /estun/status staleness
            # (>3s) to avoid stepping on a live WS driver — but under ros2
            # the WS driver is passive by design and its estun_driver mirror
            # (allow_jog=false in monitor_only) must not shadow cri_proxy's
            # allow_jog=true. Helper is idempotent + also called from
            # _on_estun_status / _on_estun_mode so last-writer-wins races
            # can't flip authority.
            r = STATE.setdefault("robot", {})
            _apply_cri_proxy_authority(r)
            # Under ros2, also keep robot.joints_deg fresh from the same
            # canonical joint_states — otherwise it stays frozen at whatever
            # estun_driver last mirrored (potentially before the driver was
            # stopped), and any UI reading joints_deg instead of joints.
            # positions renders stale-forever.
            if _JOG_BACKEND_ENV == "ros2":
                r["joints_deg"] = [math.degrees(p) for p in ordered_pos]
        # Feed the breadcrumb collector so it can tag each ProjectState
        # transition with the joints the arm was at right then. Fires
        # ~25 Hz; the collector only holds the latest sample so this
        # is O(1) and cheap. Pass the canonical-ordered positions so
        # breadcrumb timestamps line up with what the UI shows.
        try:
            self._breadcrumbs.on_joint_states(ordered_pos)
        except Exception:
            pass

    def _on_task_state(self, msg):
        """Merge the program executor's state into STATE.task. Maps the
        executor's 'state' string onto the running/paused booleans the
        existing UI reads, and adds the richer fields (step_label,
        cycle_count, etc.) for the Monitor dashboard."""
        try:
            d = json.loads(msg.data)
        except Exception:
            return
        # Tell the breadcrumb collector about pause transitions so it
        # can tag mid-step pauses on the trail's last waypoint.
        try:
            self._breadcrumbs.on_task_state(d)
        except Exception:
            pass
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
        _last_estun_status_ts[0] = time.time()
        with _state_lock:
            r = STATE.setdefault("robot", {})
            r["connected"]   = bool(d.get("connected", False))
            r["mode"]        = d.get("robot_mode", "unknown")
            r["safety_mode"] = d.get("safety_mode", "unknown")
            r["status_flag"] = int(d.get("status_flag", 0))
            r["moving"]      = bool(d.get("moving", False))
            # Jog state — IncrementalJogPanel disables its buttons while
            # any driver-side jog is in flight.
            r["jog_active"]  = bool(d.get("jog_active", False))
            r["jog_mode"]    = d.get("jog_mode")   # None | 'velocity' | 'increment' | 'continuous' | 'continuous_cart'
            r["jog_index"]   = int(d.get("jog_index", 0))
            r["jog_direction"] = int(d.get("jog_direction", 0))
            r["allow_jog"]   = bool(d.get("allow_jog", False))
            r["allow_cartesian_jog"] = bool(d.get("allow_cartesian_jog", False))
            # Two-tier speed cap. UI slider ceiling + "capped" marker
            # both derive from these; passed through untouched so the
            # driver stays the single source of truth for the limits.
            for k in ("jog_speed_cap", "operator_speed_limit",
                      "effective_speed_cap"):
                if k in d:
                    r[k] = float(d[k])
            # Power gate + telemetry — dashboard banner shows Enable/
            # Disable/Clear-Alarm affordances driven by these fields.
            r["allow_power"] = bool(d.get("allow_power", False))
            # I/O bridge gate — /api/io/live and the frontend toggle
            # switches read this. Driver is authoritative.
            r["allow_io"]    = bool(d.get("allow_io", False))
            r["enabled"]     = bool(d.get("enabled", False))
            r["enabling"]    = bool(d.get("enabling", False))
            r["alarm"]       = bool(d.get("alarm", False))
            r["alarm_count"] = int(d.get("alarm_count", 0))
            r["state_code"]  = int(d.get("state_code", 0))
            # Cabinet mode-selector key state (0=AUTO, 1=MANUAL, -1=unknown).
            # DO writes go through project/run → require AUTO. UI reads
            # this to grey out DO toggles when the key blocks the write
            # instead of round-tripping through a guaranteed alarm.
            try:
                r["robot_mode_code"] = int(d.get("robot_mode_code", -1))
            except (TypeError, ValueError):
                r["robot_mode_code"] = -1
            r["state_name"]  = d.get("state_name", "")
            # Structured active alarm (or None) + latest stop reason.
            # Passed through untouched — the dashboard banner formats
            # cause + recovery text from these fields.
            r["active_alarm"]      = d.get("active_alarm")
            prev_stop_ts           = float(r.get("last_stop_ts") or 0.0)
            r["last_stop_reason"]  = d.get("last_stop_reason", "")
            r["last_stop_ts"]      = float(d.get("last_stop_ts") or 0.0)
            # 2026-08-04 (Lesson 165 propagation): structured cause +
            # dashboard-composed operator copy. Frontend consumes
            # `stop_cause_copy` exclusively — no regex fork on the raw
            # reason string. Fork registry: `jog_stop_cause_propagation`.
            cause = d.get("last_stop_cause")
            r["last_stop_cause"] = cause if isinstance(cause, dict) else None
            r["cart_softening"]  = d.get("cart_softening") \
                if isinstance(d.get("cart_softening"), dict) else None
            # Re-translate whenever last_stop_ts advanced OR the tag
            # changed since the last snapshot. Uses joint_limits (also
            # driver-side) to compute the absolute limit value the
            # operator sees ("±200°").
            _jl = d.get("joint_limits") if isinstance(d.get("joint_limits"), list) else None
            if r["last_stop_ts"] > 0.0 and (
                    r["last_stop_ts"] != prev_stop_ts
                    or r.get("stop_cause_copy") is None):
                r["stop_cause_copy"] = _jog_stop_cause_operator_copy(
                    r["last_stop_cause"] or {}, _jl or [])
                # Persist the raw text as the technicalDetail fallback
                # if the translator didn't set one (e.g. tag='other').
                if r["stop_cause_copy"] and not r["stop_cause_copy"].get("technical"):
                    r["stop_cause_copy"]["technical"] = r["last_stop_reason"]
                # Unified event log — every stop cause lands as one
                # event. Fires only on last_stop_ts ADVANCE (not on
                # every state broadcast) so we get one line per
                # actual driver stop, no duplicates.
                if r["last_stop_ts"] != prev_stop_ts:
                    _cause = r["last_stop_cause"] or {}
                    _tag   = str(_cause.get('tag') or 'unknown')
                    _sev   = 'error' if _tag in ('joint_limit', 'joint_limit_deeper',
                                                 'collision_guard', 'send_failed') \
                                     else 'warning'
                    try:
                        _event_log.emit(
                            severity=_sev,
                            source='driver',
                            code=f'stop_jog:{_tag}',
                            operator_message=(r["stop_cause_copy"] or {}).get(
                                'title', f'Jog stopped ({_tag})'),
                            technical_detail=str(r["last_stop_reason"] or ''),
                            context={
                                'tag':                _tag,
                                'joint_index_1based': _cause.get('joint_index_1based'),
                                'joint_deg':          _cause.get('joint_deg'),
                                'joint_limit_deg':    _cause.get('joint_limit_deg'),
                                'jog_mode':           _cause.get('jog_mode'),
                                'stop_ts':            r["last_stop_ts"],
                            },
                        )
                    except Exception:
                        pass
            # Per-joint limit evaluation — a list of six dicts (one per
            # joint) each with current_deg/limit_deg/out_of_range/etc.
            # Passed through untouched; dashboard interprets to render
            # the live joint-limit recovery guide.
            jl = d.get("joint_limits")
            if isinstance(jl, list):
                prev_jl = r.get("joint_limits") or []
                r["joint_limits"] = jl
                # 2026-08-05 (guided recovery, Lesson 165 extension):
                # detect past_escape_only True<->False transitions per
                # joint and append a JSONL entry to
                # /opt/cobot/logs/recovery_events.jsonl. Bounded — a
                # single line per transition, per joint, at driver
                # publish rate. Non-fatal if the write fails (the
                # user experience isn't affected).
                _write_recovery_events_from_jl(prev_jl, jl)
            # Self-collision guard telemetry (pair + distance + thresholds).
            # Dashboard uses these to tint the offending link pair
            # amber/red in the twin and render a live clearance readout.
            # 2026-08-06: `collision_enabled` now means the RUNTIME
            # kill switch is on. `collision_guard_active` is the
            # boolean flag; `collision_model_loaded` is whether the
            # capsule YAML parsed. The Configure surface + the event
            # log key off `collision_enabled`.
            prev_coll_en = r.get("collision_enabled")
            r["collision_enabled"]       = bool(d.get("collision_enabled", False))
            r["collision_guard_active"]  = bool(d.get("collision_guard_active", False))
            r["collision_model_loaded"]  = bool(d.get("collision_model_loaded", False))
            r["collision_pair"]    = d.get("collision_pair")
            r["collision_min_mm"]  = d.get("collision_min_mm")
            r["collision_warn_mm"] = float(d.get("collision_warn_mm") or 0.0)
            r["collision_stop_mm"] = float(d.get("collision_stop_mm") or 0.0)
            r["collision_warning"] = bool(d.get("collision_warning", False))
            # 2026-08-06 (operator directive): every transition of the
            # runtime kill switch lands in the event log. The initial
            # observation (prev_coll_en is None) also emits so the
            # boot state is on record. Warning severity on OFF; info
            # on ON.
            if prev_coll_en != r["collision_enabled"]:
                try:
                    if r["collision_enabled"]:
                        _event_log.emit(
                            severity='info',
                            source='estun_driver',
                            code='collision_guard_active',
                            operator_message='Self-collision guard is ACTIVE.',
                            technical_detail=(
                                f'guard_active={r["collision_guard_active"]} '
                                f'model_loaded={r["collision_model_loaded"]}'),
                            context={'enabled': True})
                    else:
                        _event_log.emit(
                            severity='warning',
                            source='estun_driver',
                            code='collision_guard_inactive',
                            operator_message=(
                                'Self-collision guard is OFF. Nothing in '
                                'software prevents a link-on-link or link-'
                                'on-table crash.'),
                            technical_detail=(
                                f'guard_active={r["collision_guard_active"]} '
                                f'model_loaded={r["collision_model_loaded"]}'),
                            context={'enabled': False,
                                     'first_observation': prev_coll_en is None})
                except Exception:
                    pass
            # Environment obstacle guard — separate keys from self-collision.
            # env_pair is [link, "zone#<id>"]; env_escape_dirs is a list of
            # {joint, direction, projected_mm, current_mm} sorted best-first.
            r["env_zone_count"]  = int(d.get("env_zone_count") or 0)
            r["env_pair"]        = d.get("env_pair")
            r["env_min_mm"]      = d.get("env_min_mm")
            r["env_warn_mm"]     = float(d.get("env_warn_mm") or 0.0)
            r["env_stop_mm"]     = float(d.get("env_stop_mm") or 0.0)
            r["env_escape_dirs"] = d.get("env_escape_dirs") or []
            # Unified guard state — used by the guard popup for any
            # collision kind (self / ground / env).
            r["guard_active"]  = bool(d.get("guard_active", False))
            r["guard_kind"]    = d.get("guard_kind")
            r["guard_pair"]    = d.get("guard_pair")
            r["guard_min_mm"]  = d.get("guard_min_mm")
            r["guard_warn_mm"] = float(d.get("guard_warn_mm") or 0.0)
            r["guard_stop_mm"] = float(d.get("guard_stop_mm") or 0.0)
            r["guard_escapes"] = d.get("guard_escapes") or []
            r["ground_z_mm"]   = d.get("ground_z_mm")
            # Joints (rad) — only overwrite if the driver gave us real data.
            # ── PHANTOM-FEEDBACK CLASS FIX (2026-08-27, twin flicker-to-zero) ──
            # Under JOG_BACKEND=ros2 the CRI-JSB /joint_states is the
            # authoritative source; ignore the WS mirror's joints so the
            # two writers can't race. Under ws this branch IS the source.
            # In either mode, quarantine exact-all-zeros while the arm is
            # actually enabled (impossible telemetry → phantom-feedback).
            jr = d.get("joints_rad")
            if isinstance(jr, list) and len(jr) == 6:
                if _JOG_BACKEND_ENV == "ros2":
                    _twin_source_ignored["ros2_estun_status_joints"] = (
                        _twin_source_ignored.get("ros2_estun_status_joints", 0) + 1)
                elif _is_all_zeros_positions(jr) and _wire_arm_is_enabled():
                    _phantom_zero_frames["ws_estun_status"] = (
                        _phantom_zero_frames.get("ws_estun_status", 0) + 1)
                else:
                    STATE["joints"]["positions"] = list(jr)
            # TCP pose (m / rad)
            tcp = d.get("tcp_m")
            if isinstance(tcp, list) and len(tcp) == 6:
                STATE["tcp_pose"] = list(tcp)
            # Mirror the display-friendly units (deg / mm) into STATE.robot
            # so the frontend Points panel and the Teach-current-pose flow
            # can read them straight without a rad→deg conversion. Both
            # are computed driver-side from the same source (fitted DH →
            # tcp_mm, controller-published joints → joints_deg).
            jd = d.get("joints_deg")
            if isinstance(jd, list) and len(jd) == 6:
                r["joints_deg"] = list(jd)
            tm = d.get("tcp_mm")
            if isinstance(tm, list) and len(tm) == 6:
                r["tcp_mm"] = list(tm)
            # Estop — real robot is authoritative when connected
            if r["connected"] and "estop" in d:
                STATE["safety"]["estop"] = bool(d["estop"])
            # Task running mirror — only when not driven by the project runner
            if r["connected"] and not STATE["task"].get("running", False):
                STATE["task"]["running"] = bool(d.get("moving", False))
            # Under JOG_BACKEND=ros2 cri_proxy owns the arm-authority fields;
            # re-assert after estun mirroring so ESTUN_ALLOW_JOG=0 in
            # monitor_only can't leak allow_jog=false into the UI.
            _apply_cri_proxy_authority(r)

    # ---- Estun /estun/mode: gates + program live state ----

    def _on_estun_mode(self, msg):
        """Mirror /estun/mode into STATE.robot. Adds the fields /estun/status
        doesn't carry: the four gates (with sources), the effective jog
        heartbeat + freshness deadman, and the live program-execution
        state (from publish/ProjectState) — project_state, task, line,
        is_step, active project_id."""
        try:
            d = json.loads(msg.data)
        except Exception:
            return
        with _state_lock:
            r = STATE.setdefault("robot", {})
            for k in (
                "monitor_only", "allow_jog", "allow_jog_source",
                "allow_cartesian_jog", "allow_cart_source",
                "allow_power", "allow_power_source",
                "allow_move", "allow_move_source",
                "jog_heartbeat_s", "jog_freshness_s",
                # 2026-07-31 jog-stop bench instrumentation. Forward
                # the driver's per-hold inter-arrival gap histogram
                # + summary so the client + bench script can build
                # the "is the channel gapping past 200 ms?" answer.
                "jog_hold_gaps_ms", "jog_hold_gaps_summary",
                "jog_last_hold_gaps_ms", "jog_last_hold_gaps_summary",
            ):
                if k in d:
                    r[k] = d[k]
            # Program-execution fields — driven by the driver's
            # publish/ProjectState mirror.
            prog = r.setdefault("program", {})
            prog["state"]      = int(d.get("program_state", 0))
            prog["project_id"] = d.get("program_project_id")
            prog["task"]       = d.get("program_task")
            prog["line"]       = d.get("program_line")
            prog["is_step"]    = bool(d.get("program_is_step", False))
            # Under JOG_BACKEND=ros2 cri_proxy owns the arm-authority fields;
            # re-assert after /estun/mode mirroring so allow_jog=false there
            # (ESTUN_ALLOW_JOG=0) can't leak into the UI.
            _apply_cri_proxy_authority(r)

    # ---- Estun /estun/program_status: save/status/error events ----

    def _on_estun_program_status(self, msg):
        """Bridge the driver's program-status events to STATE.robot.program.
        Events are one of:
          event=save   — payload includes steps[] (per-HTTP-call outcomes)
          event=status — a ProjectState snapshot (state/line/is_step/error)
          (source prefix "error_" indicates an ErrorDedup transition)
        We keep the LAST save event under program.last_save, and a small
        rolling window of status events under program.recent so the UI
        can render both the confirm modal (post-save) and the live
        line indicator (post-run) from one place."""
        try:
            d = json.loads(msg.data)
        except Exception:
            return
        with _state_lock:
            r = STATE.setdefault("robot", {})
            prog = r.setdefault("program", {})
            ev = d.get("event")
            if ev == "save":
                prog["last_save"] = d
            elif ev == "status":
                # Feed the breadcrumb collector so it can snapshot the
                # arm's joints at each step transition and finalise
                # the trail on stop/complete. Called under _state_lock
                # but the collector uses its own lock and doesn't
                # touch STATE — nesting is safe.
                try:
                    self._breadcrumbs.on_program_status(d)
                except Exception:
                    pass
                # Track the latest error tuple (first-appearance, deduped
                # by the driver's ErrorDedup). Cleared when driver reports
                # None.
                err = d.get("error")
                prog["error"] = err
                prog["source"] = d.get("source", "")
                # Amendment 2 — auto-retry counter for project/stop.
                # Client's wedge banner reads these to switch to
                # evidence-based copy ("stop sent twice, controller
                # not confirming") after the retry also fails.
                prog["stop_retry_count"] = int(d.get("stop_retry_count") or 0)
                prog["stop_retry_ts"]    = float(d.get("stop_retry_ts") or 0)
                # Keep the last N status frames for a mini-timeline in the
                # UI. Cap at 32 — enough to show a run's state trajectory,
                # small enough to send inline in the /ws/state broadcast.
                recent = prog.setdefault("recent", [])
                recent.append({
                    "ts":       d.get("ts"),
                    "state":    d.get("state"),
                    "is_step":  d.get("is_step"),
                    "task":     d.get("task"),
                    "line":     d.get("line"),
                    "source":   d.get("source"),
                })
                if len(recent) > 32:
                    del recent[:-32]

    def _on_estun_rejected(self, msg):
        """Mirror driver rejections into STATE.robot.rejected (ring buffer).
        The Monitor Run modal reads the newest entry with family='program'
        to render the exact reason — 'allow_move gate closed', 'ws not
        connected', etc. — instead of just a generic failure."""
        try:
            d = json.loads(msg.data)
        except Exception:
            return
        with _state_lock:
            r = STATE.setdefault("robot", {})
            rej = r.setdefault("rejected", [])
            rej.append(d)
            if len(rej) > 32:
                del rej[:-32]
        # 2026-08-05 unified event log: every FRESH driver rejection
        # lands in /opt/cobot/event_log/events_YYYYMMDD.jsonl.
        # Best-effort — the emit call NEVER raises, so this can't
        # block the broadcast pipeline.
        #
        # Coalescing: the driver already dedupes same-reason bursts
        # by attaching a `count` field that increments on each
        # repeat (2, 3, ...). Only emit when count is 1 (fresh
        # transition) — otherwise we'd write thousands of
        # duplicate records per shift for background chatter like
        # "non-jog/power write paths not implemented on this branch"
        # (2369 records observed in 20 minutes of the first deploy
        # before this guard landed).
        try:
            count = int(d.get('count') or 1)
            if count == 1:
                reason = str(d.get('reason') or '')
                family = str(d.get('family') or 'driver')
                _event_log.emit(
                    severity='warning' if family == 'jog' else 'error',
                    source='driver',
                    code=f'driver_reject:{family}',
                    operator_message=f'Driver rejected {family}: {reason[:120]}',
                    technical_detail=reason,
                    context={'family': family, 'raw': d},
                )
        except Exception:
            pass

    def _on_estun_io(self, msg):
        """Mirror the merged /estun/io snapshot into STATE.io_live so
        the /api/io/live GET returns it without another ROS hop. Shape
        matches what the driver publishes — see
        estun_driver_node._publish_io_snapshot."""
        try:
            d = json.loads(msg.data)
        except Exception:
            return
        with _state_lock:
            STATE['io_live'] = d

    # ---- Estun /estun/program publisher + op helper ----

    def _estun_publish_op(self, op: str, **payload):
        """Publish a single /estun/program op envelope. Returns True if
        the frame reached the topic (does NOT mean the driver accepted
        or ran it — the driver's gate + rejection stream is the source
        of truth for that). Publisher is created eagerly in __init__.
        A count_subscribers()==0 check logs a warning so we notice if
        the driver isn't up — but does NOT block the publish (there's
        no producer we can hand the message off to)."""
        if self._estun_program_pub.get_subscription_count() == 0:
            self.get_logger().warn(
                f'/estun/program op={op!r} publishing with 0 discovered '
                f'subscribers — driver may be down; op will be dropped '
                f'by RELIABLE+VOLATILE QoS')
        body = dict(payload); body["op"] = op
        m = String(); m.data = json.dumps(body)
        self._estun_program_pub.publish(m)
        return True

    # ---- Cameras ----

    def _on_camera(self, cam_id: int, msg):
        # Off-load JPEG encode to the dedicated worker pool so the ROS
        # executor thread (which holds the GIL through PIL's Python-side
        # bytecode) returns fast and stops competing with the asyncio
        # loop for GIL windows. Drop-latest: if the previous frame for
        # this camera is still encoding, skip this one — freshness
        # beats completeness for the telemetry viewer, and queuing
        # would only re-introduce the backlog we're trying to eliminate.
        with _cam_encode_busy_lock:
            if _cam_encode_busy.get(cam_id):
                # Prior encode still in flight; drop this frame.
                return
            _cam_encode_busy[cam_id] = True
        # Freeze the fields the encoder needs — the ROS msg is
        # thread-safe to read here, but capture them explicitly so the
        # worker doesn't hold a reference longer than needed.
        w, h, enc = msg.width, msg.height, msg.encoding
        raw = bytes(bytearray(msg.data))
        first = not getattr(self, f"_cam{cam_id}_logged", False)

        class _Msg:
            width = w; height = h; encoding = enc; data = raw
        stub = _Msg()

        def _encode_task():
            try:
                jpeg = _ros_image_to_jpeg(stub)
            finally:
                with _cam_encode_busy_lock:
                    _cam_encode_busy[cam_id] = False
            if jpeg:
                with _cam_lock:
                    _cam_frames[cam_id] = jpeg
                if first:
                    setattr(self, f"_cam{cam_id}_logged", True)
                    self.get_logger().info(
                        f"Camera {cam_id} first frame: {w}x{h} enc={enc} "
                        f"jpeg={len(jpeg)}B (encoded off-loop)")
            else:
                attr = f"_cam{cam_id}_fail_logged"
                if not getattr(self, attr, False):
                    setattr(self, attr, True)
                    self.get_logger().warn(
                        f"Camera {cam_id} encode failed: {w}x{h} enc={enc} "
                        f"data_len={len(raw)}")

        _cam_encode_pool.submit(_encode_task)

    def _on_cam0_raw(self, msg):
        """Store the latest cam0 color frame as a raw RGB uint8 array
        for the AprilTag calibrator to consume synchronously. Called
        at the camera frame rate (~15 Hz). Handles rgb8 and bgr8;
        anything else is ignored (with a one-time warn) so a mis-
        configured stream never breaks this path."""
        if _np is None:
            return
        try:
            enc = msg.encoding
            w, h = int(msg.width), int(msg.height)
            n = w * h * 3
            if n <= 0 or n > len(msg.data):
                return
            buf = _np.frombuffer(bytes(msg.data), dtype=_np.uint8, count=n)
            if enc == 'rgb8':
                rgb = buf.reshape(h, w, 3)
            elif enc == 'bgr8':
                rgb = buf.reshape(h, w, 3)[:, :, ::-1]
            else:
                if not getattr(self, '_cam0_raw_enc_warned', False):
                    self._cam0_raw_enc_warned = True
                    self.get_logger().warn(
                        f'cam0 raw tap: unsupported encoding {enc!r} — '
                        f'calibration will not detect until this is rgb8/bgr8')
                return
            with _cam0_raw_lock:
                _cam0_raw['rgb']    = rgb.copy()
                _cam0_raw['width']  = w
                _cam0_raw['height'] = h
                _cam0_raw['ts']     = time.time()
        except Exception as e:
            if not getattr(self, '_cam0_raw_err_logged', False):
                self._cam0_raw_err_logged = True
                self.get_logger().warn(f'cam0 raw tap failed: {e}')

    def _on_cam0_info(self, msg):
        """Latest cam0 intrinsics (fx, fy, cx, cy). The calibrator
        pulls this at capture time — no per-frame processing here."""
        try:
            k = msg.k
            if len(k) >= 6 and k[0] > 0 and k[4] > 0:
                with _cam0_raw_lock:
                    _cam0_intr['fx'] = float(k[0])
                    _cam0_intr['fy'] = float(k[4])
                    _cam0_intr['cx'] = float(k[2])
                    _cam0_intr['cy'] = float(k[5])
        except Exception:
            pass

    def _broadcast_cam0_extrinsic(self):
        """Publish the freshly-saved cam0_extrinsic.yaml as a static
        TF (cam0_color_optical_frame → base_link) so consumers see it
        without needing a tf_broadcaster restart. Called by the save
        endpoint after a successful persist; silent no-op when tf2_ros
        or the saved YAML is missing."""
        if _StaticTFBroadcaster is None:
            return
        try:
            from . import cam0_calibration as _cam0_calib_mod
        except ImportError:
            import cam0_calibration as _cam0_calib_mod  # type: ignore
        payload = _cam0_calib_mod.load()
        if not payload:
            return
        R = payload.get('R')
        t = payload.get('t')
        if not (isinstance(R, list) and len(R) == 3 and isinstance(t, list) and len(t) == 3):
            return
        # Rotation matrix → quaternion (xyzw).
        try:
            import numpy as _np2
            R_mat = _np2.asarray(R, dtype=float).reshape(3, 3)
            # scipy.spatial.transform.Rotation is already imported
            # somewhere in the codebase; use it if available.
            from scipy.spatial.transform import Rotation as _Rot
            q = _Rot.from_matrix(R_mat).as_quat()   # xyzw
        except Exception as e:
            print(f'[calib] cannot build quaternion for TF: {e}',
                  flush=True)
            return
        if self._static_tf_bcast is None:
            self._static_tf_bcast = _StaticTFBroadcaster(self)
        msg = _TFStamped()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = str(payload.get('frame_to', 'base_link'))
        msg.child_frame_id  = str(payload.get('frame_from', 'cam0_color_optical_frame'))
        msg.transform.translation.x = float(t[0])
        msg.transform.translation.y = float(t[1])
        msg.transform.translation.z = float(t[2])
        msg.transform.rotation.x    = float(q[0])
        msg.transform.rotation.y    = float(q[1])
        msg.transform.rotation.z    = float(q[2])
        msg.transform.rotation.w    = float(q[3])
        self._static_tf_bcast.sendTransform([msg])
        self.get_logger().info(
            f'cam0 extrinsic TF published: {msg.child_frame_id} → '
            f'{msg.header.frame_id}  t=[{t[0]:+.3f}, {t[1]:+.3f}, {t[2]:+.3f}]  '
            f'rms={payload.get("rms_mm", "?")} mm')

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

# Global joint recorder — instantiated at lifespan startup, torn down
# on shutdown. Stays None on the module until then; endpoints null-
# check it for the small window between import and startup.
_joint_recorder = None

def _joint_recorder_snapshot():
    """Snapshot provider passed into JointRecorder. Reads STATE under
    _state_lock, returns None when joints haven't been published yet
    (arm not connected / driver still initialising). The recorder's
    per-tick loop calls this and skips writes on None."""
    with _state_lock:
        joints = STATE.get('joints') or {}
        positions = list(joints.get('positions') or [])
        robot = STATE.get('robot') or {}
        prog = robot.get('program') or {}
        prog_state = prog.get('state')
        prog_line  = prog.get('line')
        prog_id    = prog.get('project_id')
    if not positions or len(positions) < 6:
        return None
    joints_deg = [round((v * 180.0 / math.pi), 3) for v in positions[:6]]
    return {
        't':             time.time(),
        'joints_deg':    joints_deg,
        'program_id':    prog_id,
        'program_name':  prog_id,   # name lookup would need file I/O — id is stable
        'program_state': int(prog_state or 0),
        'program_line':  prog_line,
        'is_step':       bool((prog or {}).get('is_step', False)),
    }

if FASTAPI_AVAILABLE:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # main() has run by this point, so _ros_node is populated.
        # Register any subscriptions that were declared at module scope
        # but needed to wait for _ros_node to exist.
        try:
            _register_lidar_identifier_subs()
        except NameError:
            # Registration function not defined yet (rare — early
            # import failure). Endpoints will just serve empty data.
            pass
        # 2026-07-31 CONVERGENCE FIX: seed _prog_revs from every
        # program's on-disk rev BEFORE the /ws/state broadcast loop
        # starts. Without this, the first post-restart mutation
        # collapses rev to 1 while clients still hold higher revs
        # from the previous process — every subsequent event's
        # `ev.rev > cp.rev` compare fails silently.
        try:
            _seed_prog_revs_from_disk()
        except Exception as _e:
            print(f'[dashboard] _seed_prog_revs_from_disk failed: {_e}',
                  flush=True)
        task = asyncio.create_task(_broadcast_loop())
        # Server-side hold keepalive — drives /robot/jog_command at a
        # steady 100 ms cadence. Runs on a dedicated NATIVE thread, not
        # the asyncio loop — the loop's callback-dispatch drift measured
        # 50–300 ms under normal load (camera streams + state broadcast
        # + WS traffic), and even ONE stack-up of that drift crosses
        # the driver's freshness deadman. A native thread with
        # time.sleep-based scheduling is unaffected by loop load;
        # rclpy publishers are thread-safe so calling _publish_estun_jog
        # from here is fine.
        _keepalive_stop.clear()
        keepalive_thread = threading.Thread(
            target=_keepalive_thread_loop,
            name='hold-keepalive',
            daemon=True)
        keepalive_thread.start()
        # Always-on joint flight recorder. Ticks at 25 Hz, gzip'd
        # segments under /opt/cobot/joint_history/, 2 GB / 14 d hard
        # retention. Failure-isolated — a recorder crash never
        # touches STATE or the broadcast loop.
        global _joint_recorder
        try:
            _joint_recorder = JointRecorder(_joint_recorder_snapshot)
            _joint_recorder.start()   # sync — spawns a native thread
        except Exception as _e:
            print(f'[dashboard] joint recorder failed to start: {_e}',
                  flush=True)
            _joint_recorder = None
        # 2026-08-05 disk watchdog — enforced retention on
        # /opt/cobot/logs, joint_history, event_log. Runs a prune
        # sweep every 60 s. First sweep at boot cleans any pre-
        # existing overrun.
        try:
            _disk_watchdog.enforce_all()
            _disk_watchdog.start_watchdog_thread(period_s=60.0)
            print('[dashboard] disk watchdog started (60s cadence, '
                  '2GB caps on logs/joint_history, 500MB on event_log)',
                  flush=True)
        except Exception as _e:
            print(f'[dashboard] disk watchdog failed to start: {_e}',
                  flush=True)
        yield
        task.cancel()
        _keepalive_stop.set()
        keepalive_thread.join(timeout=1.0)
        if _joint_recorder is not None:
            try:
                _joint_recorder.stop()
            except Exception as _e:
                print(f'[dashboard] joint recorder shutdown error: {_e}',
                      flush=True)
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
        # 2026-07-17: state rate is 25 Hz at idle but DROPS to 8 Hz
        # while any jog hold is active. Rationale: at 25 Hz the loop
        # spent ~15% of the GIL on deepcopy + json.dumps of the 10 KB
        # state blob, occasionally starving the native keepalive thread
        # for up to 672 ms (past the driver's freshness deadman → phantom
        # staleness stops mid-hold on both the Program tab and 3D View
        # jog screens). 8 Hz keeps the twin visually responsive (Twin
        # follower uses exponential smoothing so update rate isn't
        # visually critical) while freeing GIL for the keepalive.
        state_hz_idle = 25
        state_hz_hold = 8
        lidar_hz  = 10
        mesh_hz   = 2
        motioncam_hz = 10
        motioncam_reco_hz = 4
        state_dt_idle  = 1.0 / state_hz_idle
        state_dt_hold  = 1.0 / state_hz_hold
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
                        _put_drop_oldest(q, payload, 'mesh')
                next_mesh = now + mesh_dt

            if now >= next_state:
                # Skip the deep-copy + json.dumps (both non-trivial on
                # a state blob this size) when no one is listening.
                # The next_state cursor still advances so we don't spin.
                with _ws_lock:
                    n_clients = len(_state_clients)
                # Adaptive rate — 8 Hz while a jog hold is active, 25 Hz otherwise.
                with _active_holds_lock:
                    hold_active = len(_active_holds) > 0
                state_dt = state_dt_hold if hold_active else state_dt_idle
                if n_clients == 0:
                    next_state = now + state_dt
                    await asyncio.sleep(state_dt)
                    continue
                # Root-caused 2026-07-17: deepcopy + json.dumps of the
                # ~10 KB STATE blob was executing inside the asyncio
                # loop's task and holding the GIL for 5-10 ms per
                # broadcast. Under 25 Hz that's ~15% GIL occupancy on
                # THIS thread — enough to starve the native keepalive
                # thread (max_tick_gap_ms measured at 622 ms in a
                # single stall, twice the driver's 300 ms freshness
                # deadman → driver fires stopJog mid-hold → chattery
                # jog on BOTH the Program and 3D View screens because
                # they share the same transport). Fix: run the
                # deepcopy+json.dumps in the default thread executor
                # (concurrent futures pool) so the asyncio loop
                # RELEASES the GIL while json runs its C-side work,
                # and the keepalive native thread gets scheduled.
                loop = asyncio.get_running_loop()
                def _snapshot_and_serialize():
                    with _state_lock:
                        payload = copy.deepcopy(STATE)
                    _state_seq_counter[0] += 1
                    payload["t"]   = now * 1000
                    payload["seq"] = _state_seq_counter[0]
                    # Program-change events (last _PROG_EVENT_TTL_S sec).
                    # Latest-wins broadcast means an individual frame
                    # may be skipped by a slow client, but every event
                    # rides multiple frames within its TTL so the
                    # client is guaranteed to see it.
                    events = _snapshot_program_events()
                    if events:
                        payload["program_events"] = events
                    # 2026-07-31 CONVERGENCE: include the full
                    # {program_id: rev} snapshot in every state
                    # frame. Clients rev-gap-check their held
                    # currentProgram against server-truth on each
                    # frame and refetch immediately when they're
                    # behind — heals missed events (event ring
                    # TTL 15s can age out during long backgrounds)
                    # without waiting for the next mutation.
                    revs = _snapshot_prog_revs()
                    if revs:
                        payload["program_revs"] = revs
                    return json.dumps(payload), _state_seq_counter[0]
                txt, seq = await loop.run_in_executor(None, _snapshot_and_serialize)
                # Sequence + broadcast time. The seq lets the ACK-gated
                # sender coalesce: if the client hasn't yet acked frame
                # N, we overwrite `latest_payload` in place and only
                # send AFTER the ack arrives. This bounds in-flight to
                # one frame regardless of OS TCP send buffer depth.
                with _ws_lock:
                    clients = list(_state_clients.items())
                for ws, client in clients:
                    # Latest-wins: overwrite in place. The sender only
                    # pulls at ack time, so the newest txt at ack time
                    # is what ships next — never a chain of stale frames.
                    client['latest_txt'] = txt
                    client['latest_seq'] = seq
                    client['latest_broadcast_ts'] = now * 1000
                    client['new_event'].set()
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
                    _put_drop_oldest(q, ('binary', lidar_payload), 'lidar')
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
                        _put_drop_oldest(q, ('binary', payload), 'motioncam_cloud')
                next_motioncam = now + motioncam_dt

            if now >= next_motioncam_reco:
                items = _motioncam.snapshot_recognitions()
                txt = json.dumps(_mc.pack_recognition_payload(items))
                with _ws_lock:
                    clients = list(_motioncam_reco_clients.items())
                for ws, q in clients:
                    _put_drop_oldest(q, txt, 'motioncam_reco')
                next_motioncam_reco = now + motioncam_reco_dt

            await asyncio.sleep(0.005)

    # ------------------------------------------------------------------
    # WS client→server message router
    # ------------------------------------------------------------------
    #
    # /ws/state is now bidirectional. Server → client is the periodic
    # state broadcast; client → server carries jog + power commands over
    # the same persistent channel so a single hold session doesn't pay
    # per-message TLS handshake / TCP connection cost, and messages
    # arrive in order (which HTTP/1.1 does not guarantee across parallel
    # connections). The HTTP endpoints (/cmd/jog, /cmd/jog_cartesian,
    # /cmd/power) remain as-is; the frontend falls back to them if the
    # WS is down. Every message just funnels back into the same
    # _publish_estun_jog / _publish_estun_power helpers — the driver
    # sees identical /robot/jog_command traffic either way, and the
    # hold_id/seq semantics are unchanged.
    #
    # Wire format (JSON, one message per frame):
    #   {"type": "jog",           "payload": {...jog body as /cmd/jog...}}
    #   {"type": "jog_cartesian", "payload": {...as /cmd/jog_cartesian...}}
    #   {"type": "power",         "payload": {"action": "enable"|"disable"|"clear_alarm"}}
    #
    # Server does NOT reply — this is fire-and-forget, matching the
    # HTTP endpoints. Errors are swallowed so a bad message from one
    # client cannot tear down the connection.

    _WS_JOG_ACTIONS = {"jog", "jog_cartesian", "power"}

    # ── Server-side hold keepalive ────────────────────────────────────
    #
    # The dashboard now maintains the freshness heartbeat to the driver
    # on the server's own event loop. Wire evidence (2026-07-15 cont-jog
    # session): under normal camera + WS load, browser→server refresh
    # inter-arrival at the driver hit ~5 % > 300 ms — enough to trip
    # the driver's freshness deadman mid-hold and turn Cartesian jog
    # into step. Root cause was GIL-holding JPEG encode; that's fixed
    # above by moving encode to a worker pool. This keepalive is the
    # structural fix — the dashboard has all the state (open WS,
    # hold_id, last browser refresh time), so it can maintain a
    # rock-steady 100 ms cadence to the driver regardless of browser
    # jitter, while preserving every safety property:
    #
    #   • WS disconnects (browser closed / laptop lid / network lost)
    #     → keepalive drops the session → driver's 300 ms deadman fires
    #     → Robot/stopJog on the wire.
    #   • Explicit release from browser → we send hold:false immediately
    #     and drop the session.
    #   • Browser silent > 400 ms (finger genuinely lifted, or all WS
    #     messages lost) → keepalive drops the session → driver deadman
    #     ~300 ms later.
    #
    # The operator's finger remains the deadman; we just stop network
    # jitter from impersonating a release. The driver's own 300 ms
    # deadman remains the ultimate safety backstop.
    # 60 ms interval (not 100) — the keepalive runs on a native thread
    # but still shares the GIL with the asyncio loop; measured on-Jetson
    # under normal load, GIL bursts occasionally hold 200–250 ms, so a
    # 100 ms interval + one drifted tick can just cross the driver's
    # 300 ms deadman. At 60 ms we get five ticks per deadman window —
    # even TWO consecutive drifted ticks stay under 300 ms driver-side.
    HOLD_KEEPALIVE_INTERVAL_S = 0.06
    HOLD_BROWSER_TIMEOUT_S    = 0.4

    # Backend selector — SEAM A of Phase F1 (2026-08-18; see
    # cobot-cri-planner-intent, jog_bridge package in
    # ~/cri_eval_ws/CodroidROS2/src/jog_bridge/). Read once at module load —
    # no runtime switching. §282 gate-banner: announce at startup.
    #   'ws'   (default) — publish to /robot/jog_command as before;
    #                       estun_driver runs the jog gate.
    #   'ros2'          — publish to /dashboard/jog_session_events;
    #                       jog_bridge runs the JTC-side jog gate; nothing
    #                       lands on /robot/jog_command (estun_driver stays
    #                       fully passive).
    # Mutual exclusion with estun_driver.allow_jog is enforced by
    # jog_bridge's /estun/mode drift-check at 5 s cadence.
    # Fanout rate-limits ONLY 'refresh' events at 90 ms/hold_id (the SM's
    # 200 ms horizon needs ~5 refreshes/sec, so 60 ms keepalive cadence
    # would otherwise churn the action layer at ~10 preempts/sec).
    # 'start' and 'stop' always pass immediately (dead-man-by-finger, §286).
    _JOG_BACKEND = os.environ.get("JOG_BACKEND", "ws").strip().lower()
    if _JOG_BACKEND not in ("ws", "ros2"):
        print(f"[dashboard] JOG_BACKEND={_JOG_BACKEND!r} not in {{'ws','ros2'}}; "
              f"defaulting to 'ws'.", flush=True)
        _JOG_BACKEND = "ws"
    print(f"[dashboard] JOG_BACKEND = {_JOG_BACKEND!r}", flush=True)
    _JOG_REFRESH_COALESCE_S = 0.090   # 90 ms per hold_id (refresh only)


    class _HoldSession:
        """Bookkeeping for a single active jog hold. Owned by the
        server keepalive loop; refreshed by inbound browser messages."""
        __slots__ = ('hold_id', 'ws', 'driver_payload_template',
                     'last_browser_ts', 'server_seq', 'mode')
        def __init__(self, hold_id, ws, tpl, mode):
            self.hold_id = hold_id
            self.ws = ws
            self.driver_payload_template = tpl  # dict WITHOUT seq/hold
            self.last_browser_ts = time.monotonic()
            # Start server_seq high (ms since epoch) so it dominates any
            # browser seq the driver might have latched from an earlier
            # session — monotonic across the whole day.
            self.server_seq = int(time.time() * 1000)
            self.mode = mode

    _active_holds = {}          # hold_id -> _HoldSession
    _active_holds_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Motion arbiter (JOG-11, 2026-08-27) — jog and program-run are
    # mutually exclusive. Reason: the CRI stack and the WS driver
    # coexist (F1.0 proved hybrid) but only ONE may command motion at
    # any instant. Any motion-initiating call MUST be gated on the
    # other channel being idle. Release / stop calls are ALWAYS
    # allowed so they can never strand a dangling hold when a
    # program starts. Doctrine test: test_motion_arbiter.py.
    # ------------------------------------------------------------------
    _PROGRAM_RUNNING_STATES = (2, 3)

    def _arbiter_probe_program_running():
        """Return (running: bool, info: dict). Reads STATE.robot.program.
        program_state ∈ {2, 3} = running; 0 = idle. info carries the
        project_id/line for the operator-copy dialog."""
        with _state_lock:
            prog = STATE.get("robot", {}).get("program", {}) or {}
            st = int(prog.get("state", 0) or 0)
            pid = prog.get("project_id")
            line = prog.get("line")
        if st in _PROGRAM_RUNNING_STATES:
            return True, {
                "program_state": st,
                "project_id": pid,
                "line": line,
            }
        return False, {}

    def _arbiter_probe_jog_active():
        """Return (active: bool, info: dict). Reads _active_holds; ANY
        hold session counts as active jog. info lists up to 8 hold_ids."""
        with _active_holds_lock:
            n = len(_active_holds)
            hids = list(_active_holds.keys())[:8]
        if n:
            return True, {"n_active_holds": n, "hold_ids": hids}
        return False, {}

    def _arbiter_refuse_jog_if_running(body):
        """Returns None if the jog request may proceed; else a
        JSONResponse(409) with reason_code='program_running' and an
        operator_copy title/detail suitable for the toast. Release /
        stop bodies are always allowed."""
        if body.get("hold") is False or body.get("stop") is True:
            return None
        running, info = _arbiter_probe_program_running()
        if not running:
            return None
        return JSONResponse(
            {"error": "Cannot jog: a program is currently running.",
             "reason_code": "program_running",
             "program": info,
             "operator_copy": {
                 "title": "Program is running",
                 "detail": ("Stop the program (or wait for it to finish) "
                            "before jogging."),
             }},
            status_code=409,
        )

    def _arbiter_refuse_run_if_jogging():
        """Returns None if a program-run may proceed; else a
        JSONResponse(409) with reason_code='jog_active' + operator_copy."""
        active, info = _arbiter_probe_jog_active()
        if not active:
            return None
        return JSONResponse(
            {"error": "Cannot run: a jog session is active.",
             "reason_code": "jog_active",
             "jog": info,
             "operator_copy": {
                 "title": "Jog session active",
                 "detail": ("Release the jog control (both button and "
                            "touch) before starting the program."),
             }},
            status_code=409,
        )

    def _build_driver_payload(t, payload):
        """Shared payload shaping — mirrors the HTTP endpoints' translations
        (joint → axis, letter-axis → 1..6). Used by both the initial-hold
        publish path and the keepalive loop. Returns the dict WITHOUT
        seq/hold_id/hold — the caller adds those as appropriate."""
        mode = "cartesian" if t == "jog_cartesian" else "joint"
        out = dict(payload)
        out.setdefault("mode", mode)
        if "axis" not in out and "joint" in out:
            try:
                out["axis"] = int(out.pop("joint"))
            except (TypeError, ValueError):
                return None
        if mode == "cartesian" and isinstance(out.get("axis"), str):
            axis_map = {"x": 1, "y": 2, "z": 3, "rx": 4, "ry": 5, "rz": 6}
            n = axis_map.get(out["axis"].lower())
            if n is not None:
                out["axis"] = n
        # Strip fields the keepalive will manage on its own.
        for k in ("seq", "hold", "client_ts_ms"):
            out.pop(k, None)
        return out

    def _handle_ws_client_msg(raw: str, ws=None):
        try:
            msg = json.loads(raw)
        except Exception:
            return
        # Diagnostic: count every inbound message that hits this router.
        # Bumps a global so /health can show whether the silence-test
        # sim is truly silent (bumps stop) or something is coming in.
        _keepalive_stats.setdefault('ws_msgs_in', 0)
        _keepalive_stats['ws_msgs_in'] += 1
        t = msg.get("type")
        if t not in _WS_JOG_ACTIONS:
            return
        payload = msg.get("payload") or {}
        if not isinstance(payload, dict):
            return
        if t == "power":
            action = str(payload.get("action", "")).lower()
            if action not in _POWER_ACTIONS:
                return
            _publish_estun_power({"action": action})
            return

        hold_id = payload.get("hold_id")
        # Release path takes absolute priority. Publish release
        # immediately and drop any tracked session for this hold_id.
        if payload.get("hold") is False or payload.get("stop") is True:
            mode = "cartesian" if t == "jog_cartesian" else "joint"
            out = {"mode": mode, "hold": False}
            for k in ("hold_id", "seq", "client_ts_ms"):
                if payload.get(k) is not None:
                    out[k] = payload[k]
            _publish_estun_jog(out)
            if hold_id is not None:
                with _active_holds_lock:
                    _active_holds.pop(hold_id, None)
            return

        # Non-hold jog shapes (delta_deg increments, cart pulse) — pass
        # through, no keepalive tracking needed. The driver runs its own
        # time-boxed stop for those.
        if payload.get("hold") is not True:
            tpl = _build_driver_payload(t, payload)
            if tpl is None: return
            # For increments: re-attach delta_deg / pulse fields that
            # _build_driver_payload didn't strip (only seq/hold/client_ts).
            _publish_estun_jog(tpl)
            return

        # hold:true — register / refresh the session. The keepalive loop
        # will drive the actual /robot/jog_command traffic from here on.
        tpl = _build_driver_payload(t, payload)
        if tpl is None: return
        mode = tpl.get("mode", "joint")
        now = time.monotonic()
        with _active_holds_lock:
            hs = _active_holds.get(hold_id) if hold_id is not None else None
            if hs is None:
                # New session — publish the first frame IMMEDIATELY so
                # the driver's session-tracking state gets set up before
                # our first keepalive tick. Subsequent keepalive ticks
                # will refresh at 100 ms cadence.
                hs = _HoldSession(hold_id, ws, tpl, mode)
                _active_holds[hold_id] = hs
                initial = True
            else:
                # Refresh — just update the freshness timestamp; the
                # keepalive loop is already publishing.
                hs.last_browser_ts = now
                # Guard: if the caller mutated the payload (e.g. cart
                # direction change on the same hold_id — shouldn't happen
                # from HoldButton but browsers can surprise us), refresh
                # the template so the keepalive uses the latest.
                hs.driver_payload_template = tpl
                initial = False
        if initial:
            frame = dict(tpl); frame['hold'] = True
            frame['hold_id'] = hold_id
            frame['seq'] = hs.server_seq
            _publish_estun_jog(frame)

    # Keepalive runs on a DEDICATED THREAD, not the asyncio loop.
    # Rationale: measured on-Jetson, `await asyncio.sleep(0.1)` drifts
    # 50–300 ms under normal load (camera streams, ROS callbacks, state
    # broadcast, arbitrary WS traffic) — even with drift-corrected
    # scheduling — because the loop's next-callback dispatch has to
    # wait for the currently-executing coroutine to `await` again. A
    # single 300+ ms drift crosses the driver's freshness deadman.
    # rclpy publishers are thread-safe; `time.sleep()` in a native
    # thread is scheduled by the kernel and unaffected by asyncio load.
    # The dashboard's ROS publisher (`_publish_estun_jog`) is invoked
    # from this thread directly. The only asyncio-touching field is
    # `ws.client_state`, a simple int enum read that's safe cross-thread.
    _keepalive_thread = None
    _keepalive_stop = threading.Event()
    _keepalive_stats = {"ticks": 0, "publishes": 0, "expired": 0,
                        "last_tick_gap_ms": 0.0, "max_tick_gap_ms": 0.0}
    _keepalive_last_tick_mono = 0.0

    def _keepalive_thread_loop():
        interval = HOLD_KEEPALIVE_INTERVAL_S
        next_fire = time.monotonic() + interval
        while not _keepalive_stop.is_set():
            delay = next_fire - time.monotonic()
            if delay > 0:
                # threading.Event.wait is interruptible by set() — clean shutdown.
                _keepalive_stop.wait(timeout=delay)
                if _keepalive_stop.is_set():
                    return
            now = time.monotonic()
            next_fire += interval
            if next_fire < now:
                next_fire = now + interval
            try:
                _keepalive_tick(now)
            except Exception as e:
                # Never let a tick exception kill the keepalive thread —
                # log once and continue.
                print(f'[keepalive] tick error: {e}', flush=True)

    def _keepalive_tick(now):
        nonlocal_stats = _keepalive_stats
        # Track scheduling jitter: gap between successive tick entries.
        # Useful for confirming the native thread ISN'T being throttled
        # by GIL (visible on /health under ws_kicked → keepalive_max_ms).
        global _keepalive_last_tick_mono
        prev = _keepalive_last_tick_mono
        _keepalive_last_tick_mono = now
        if prev > 0:
            gap_ms = (now - prev) * 1000
            nonlocal_stats["last_tick_gap_ms"] = gap_ms
            if gap_ms > nonlocal_stats["max_tick_gap_ms"]:
                nonlocal_stats["max_tick_gap_ms"] = gap_ms
        nonlocal_stats["ticks"] += 1
        expired = []
        with _active_holds_lock:
            items = list(_active_holds.items())
        for hold_id, hs in items:
            # WS connection health — if the WS is closed / gone,
            # drop the session. Starlette WebSocket exposes
            # client_state and application_state; both must be
            # CONNECTED for the ws to be usable.
            ws_ok = True
            if hs.ws is not None:
                # Compare via `.value` — WebSocketState is a plain Enum,
                # not IntEnum, so `int(state)` raises TypeError. The
                # earlier "int(cs) != 1" version was silently expiring
                # every session (TypeError → except → ws_ok=False) so
                # keepalive never actually republished — /health showed
                # publishes=0 while expired grew unbounded.
                try:
                    cs = getattr(hs.ws, 'client_state', None)
                    if cs is not None:
                        # Treat DISCONNECTED (2) as dead. CONNECTING (0)
                        # or CONNECTED (1) or RESPONSE (3) → alive.
                        val = getattr(cs, 'value', None)
                        if val is not None and val >= 2:
                            ws_ok = False
                except Exception:
                    ws_ok = False
            if not ws_ok:
                expired.append((hold_id, 'ws disconnected'))
                continue
            # Browser silence — if no refresh in HOLD_BROWSER_TIMEOUT_S,
            # the finger is genuinely gone (or the last N messages
            # were lost). Drop; driver deadman is next.
            if now - hs.last_browser_ts > HOLD_BROWSER_TIMEOUT_S:
                expired.append((hold_id, 'browser silent >{:.0f}ms'.format(
                    HOLD_BROWSER_TIMEOUT_S * 1000)))
                continue
            # Republish. Advance the server-side seq so the driver's
            # monotonic check accepts.
            hs.server_seq += 1
            frame = dict(hs.driver_payload_template)
            frame['hold'] = True
            frame['hold_id'] = hold_id
            frame['seq'] = hs.server_seq
            _publish_estun_jog(frame)
            nonlocal_stats["publishes"] += 1
        if expired:
            with _active_holds_lock:
                for hid, reason in expired:
                    _active_holds.pop(hid, None)
            nonlocal_stats["expired"] += len(expired)

    # ------------------------------------------------------------------
    # WebSocket endpoints
    # ------------------------------------------------------------------

    @app.websocket("/ws/state")
    async def ws_state(websocket: WebSocket):
        await websocket.accept()
        # ACK-gated per-client sender state — see comment at
        # _state_clients declaration. `new_event` fires when the
        # broadcaster overwrites `latest_txt`; `ack_event` fires when
        # the client sends `{type:"state_ack",seq:N}` with N ≥ our
        # latest_seq. `ACK_TIMEOUT_S` is the fallback so a client that
        # never acks (older frontend, JS deadlock) still receives
        # frames — just at a slower rate.
        ACK_TIMEOUT_S = 0.3
        client = {
            'latest_txt':          None,
            'latest_seq':          0,
            'latest_broadcast_ts': 0.0,
            'last_acked_seq':      0,
            'new_event':           asyncio.Event(),
            'ack_event':           asyncio.Event(),
        }
        with _ws_lock:
            _state_clients[websocket] = client
        try:
            async def _sender():
                # Send the very first payload immediately when it
                # arrives — no ack gate on the initial send.
                while True:
                    if client['latest_txt'] is None:
                        await client['new_event'].wait()
                        client['new_event'].clear()
                    txt_to_send = client['latest_txt']
                    seq_to_send = client['latest_seq']
                    broadcast_ts = client['latest_broadcast_ts']
                    # Consume the "new" signal (broadcaster may have
                    # set it repeatedly while we were awaiting ack;
                    # only the current latest matters).
                    client['new_event'].clear()
                    send_start = time.time() * 1000.0
                    try:
                        await asyncio.wait_for(
                            websocket.send_text(txt_to_send),
                            timeout=WS_SEND_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        _ws_kicked["state"] += 1
                        return
                    send_done = time.time() * 1000.0
                    with _state_perf_lock:
                        _state_perf['sends'] += 1
                        if send_done - broadcast_ts > _state_perf['inflight_ms_max']:
                            _state_perf['inflight_ms_max'] = send_done - broadcast_ts
                    # Wait for the client to ack this seq (bounded).
                    # After ack, loop; if broadcaster has posted a
                    # newer payload we send it next iteration.
                    # Timeout guarantees liveness for pre-ACK frontends.
                    try:
                        while client['last_acked_seq'] < seq_to_send:
                            await asyncio.wait_for(
                                client['ack_event'].wait(),
                                timeout=ACK_TIMEOUT_S)
                            client['ack_event'].clear()
                    except asyncio.TimeoutError:
                        with _state_perf_lock:
                            _state_perf['ack_timeouts'] += 1
                        # Fall through — send next frame anyway.
                    # If nothing newer is queued, block until broadcaster
                    # sets new_event.
                    if client['latest_seq'] <= seq_to_send:
                        await client['new_event'].wait()
                        client['new_event'].clear()

            async def _receiver():
                while True:
                    msg = await websocket.receive_text()
                    # ACK path — never dispatch these to
                    # _handle_ws_client_msg (they're not commands).
                    try:
                        if msg and msg[0] == '{' and 'state_ack' in msg[:40]:
                            try:
                                d = json.loads(msg)
                            except Exception:
                                d = None
                            if isinstance(d, dict) and d.get('type') == 'state_ack':
                                seq = int(d.get('seq') or 0)
                                if seq > client['last_acked_seq']:
                                    client['last_acked_seq'] = seq
                                    # Record ack latency for /health.
                                    with _state_perf_lock:
                                        acks = _state_perf['acks']
                                        acks.append(time.time() * 1000.0 - client['latest_broadcast_ts'])
                                        if len(acks) > 200:
                                            del acks[:len(acks) - 200]
                                client['ack_event'].set()
                                continue
                    except Exception:
                        pass
                    try:
                        _handle_ws_client_msg(msg, ws=websocket)
                    except Exception:
                        pass
            done, pending = await asyncio.wait(
                [asyncio.create_task(_sender()),
                 asyncio.create_task(_receiver())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _state_clients.pop(websocket, None)
            try:
                await websocket.close()
            except Exception:
                pass

    @app.websocket("/ws/lidar")
    async def ws_lidar(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _lidar_clients[websocket] = q
        try:
            while True:
                item = await q.get()
                try:
                    if isinstance(item, tuple) and item and item[0] == 'binary':
                        await asyncio.wait_for(
                            websocket.send_bytes(item[1]),
                            timeout=WS_SEND_TIMEOUT_S)
                    else:
                        await asyncio.wait_for(
                            websocket.send_text(item),
                            timeout=WS_SEND_TIMEOUT_S)
                except asyncio.TimeoutError:
                    _ws_kicked["lidar"] += 1
                    break
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _lidar_clients.pop(websocket, None)
            try:
                await websocket.close()
            except Exception:
                pass

    @app.websocket("/ws/motioncam_cloud")
    async def ws_motioncam_cloud(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _motioncam_cloud_clients[websocket] = q
        try:
            while True:
                item = await q.get()
                try:
                    if isinstance(item, tuple) and item and item[0] == 'binary':
                        await asyncio.wait_for(
                            websocket.send_bytes(item[1]),
                            timeout=WS_SEND_TIMEOUT_S)
                    else:
                        await asyncio.wait_for(
                            websocket.send_text(item),
                            timeout=WS_SEND_TIMEOUT_S)
                except asyncio.TimeoutError:
                    _ws_kicked["motioncam_cloud"] += 1
                    break
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _motioncam_cloud_clients.pop(websocket, None)
            try:
                await websocket.close()
            except Exception:
                pass

    @app.websocket("/ws/motioncam_recognition")
    async def ws_motioncam_recognition(websocket: WebSocket):
        await websocket.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=2)
        with _ws_lock:
            _motioncam_reco_clients[websocket] = q
        try:
            while True:
                txt = await q.get()
                try:
                    await asyncio.wait_for(websocket.send_text(txt),
                                           timeout=WS_SEND_TIMEOUT_S)
                except asyncio.TimeoutError:
                    _ws_kicked["motioncam_reco"] += 1
                    break
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _motioncam_reco_clients.pop(websocket, None)
            try:
                await websocket.close()
            except Exception:
                pass

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
                await asyncio.wait_for(websocket.send_text(cached),
                                       timeout=WS_SEND_TIMEOUT_S)
            except Exception:
                pass
        try:
            while True:
                txt = await q.get()
                try:
                    await asyncio.wait_for(websocket.send_text(txt),
                                           timeout=WS_SEND_TIMEOUT_S)
                except asyncio.TimeoutError:
                    _ws_kicked["mesh"] += 1
                    break
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            with _ws_lock:
                _mesh_clients.pop(websocket, None)
            try:
                await websocket.close()
            except Exception:
                pass

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

    def _publish_ros2_jog_event(payload):
        """SEAM A fanout — forward the jog frame to /dashboard/jog_session_events
        for the jog_bridge node to consume. Called only when JOG_BACKEND='ros2';
        best-effort (swallows exceptions) matching _publish_estun_jog's contract.

        Emits shape: {kind, hold_id, seq, server_ts, joint, direction, speed_pct, mode}.
        'kind' derivation:
          - first frame for a hold_id with hold=true → 'start'
          - subsequent frames with hold=true → 'refresh'
          - hold=false → 'stop' (and hold_id removed from seen-set)

        Rate-limiting: 'refresh' events are coalesced at
        _JOG_REFRESH_COALESCE_S (90 ms) per hold_id. 'start' and 'stop'
        always pass immediately — never rate-limited (§286 dead-man-by-finger).
        The SM's silence deadman still measures REAL browser silence because
        90 ms < 300 ms with 3× margin.
        """
        if _ros_node is None:
            return
        try:
            # Publisher + peer state are created eagerly in DashboardServer
            # __init__ (see comment there), so first-press events never race
            # with DDS discovery. No hasattr dance here.
            hold = payload.get("hold", False)
            hold_id = payload.get("hold_id")
            if not hold:
                kind = "stop"
            elif hold_id and hold_id in _ros_node._jog_session_seen:
                kind = "refresh"
            else:
                kind = "start"
                if hold_id:
                    _ros_node._jog_session_seen.add(hold_id)
            # Rate-limit refresh only. start/stop always pass.
            if kind == "refresh" and hold_id:
                _now = time.monotonic()
                _last = _ros_node._jog_last_refresh_mono.get(hold_id, 0.0)
                if (_now - _last) < _JOG_REFRESH_COALESCE_S:
                    return  # coalesce — swallow this refresh
                _ros_node._jog_last_refresh_mono[hold_id] = _now
            # Field-name reconciliation: `_build_driver_payload` upstream pops
            # `joint` and renames it to `axis` for the WS-driver's wire
            # protocol. jog_bridge (the ros2-side consumer) still expects
            # `joint`. Read `axis` as a fallback so the event isn't published
            # with `joint: null` — that crashes jog_bridge on
            # `int(evt.get("joint", 0))` (default `0` doesn't help when the
            # value IS the string None). Same fix for `direction` /
            # `speed_pct` defensively even though the current builder doesn't
            # rename them, so a future rename doesn't reintroduce this class
            # of "silently sends null → consumer crashes on int(None)" bug.
            _joint = payload.get("joint")
            if _joint is None:
                _joint = payload.get("axis")
            _direction = payload.get("direction")
            _speed_pct = payload.get("speed_pct")
            evt = {
                "kind": kind,
                "hold_id": hold_id,
                "seq": payload.get("seq"),
                "server_ts": time.monotonic(),
                "joint":     _joint if _joint is not None else 0,
                "direction": _direction if _direction is not None else 0,
                "speed_pct": _speed_pct if _speed_pct is not None else 0.0,
                "mode": payload.get("mode", "joint"),
            }
            m = String(); m.data = json.dumps(evt, separators=(",", ":"))
            _ros_node._dashboard_jog_events_pub.publish(m)
            if kind == "stop" and hold_id:
                _ros_node._jog_session_seen.discard(hold_id)
                _ros_node._jog_last_refresh_mono.pop(hold_id, None)
        except Exception:
            pass

    def _publish_estun_jog(payload):
        """Publish a single frame on /robot/jog_command. Best-effort;
        swallows exceptions so a transient publisher issue doesn't 500
        the HTTP call — the driver's own gates + safety layers are what
        actually decides whether motion happens."""
        # SEAM A of Phase F1 (2026-08-18): when JOG_BACKEND='ros2', fanout
        # to /dashboard/jog_session_events and DO NOT publish to
        # /robot/jog_command — estun_driver stays fully passive on jog.
        if _JOG_BACKEND == "ros2":
            _publish_ros2_jog_event(payload)
            return
        # Backend 'ws' (default): existing behavior, byte-identical from here.
        if _ros_node is None:
            return
        try:
            if not hasattr(_ros_node, "_estun_jog_pub"):
                # Depth 5 best-effort — jog refreshes are ephemeral so
                # KEEP_LAST + best-effort drops old ones rather than
                # blocking the publisher (which is what the old
                # depth-10 reliable default did, building the backlog
                # that caused release lag). Depth 5 gives ~500 ms of
                # tolerance to subscriber-side jitter so the 300 ms
                # freshness deadman doesn't fire mid-hold when the
                # single-threaded driver executor stalls briefly on
                # a WS heartbeat send. The driver's hold_id + seq
                # guards handle any straggler that survives the drop.
                qos = QoSProfile(
                    depth=5,
                    reliability=QoSReliabilityPolicy.BEST_EFFORT,
                    history=QoSHistoryPolicy.KEEP_LAST,
                    durability=QoSDurabilityPolicy.VOLATILE,
                )
                _ros_node._estun_jog_pub = _ros_node.create_publisher(
                    String, "/robot/jog_command", qos)
            m = String(); m.data = json.dumps(payload)
            _ros_node._estun_jog_pub.publish(m)
        except Exception:
            pass

    @app.post("/cmd/jog")
    async def cmd_jog(request: Request):
        """Joint jog dispatcher. Three shapes accepted:
        - Incremental (angle-bounded, driver time-boxes the move):
            {"joint": 1..6, "delta_deg": ±1..±5}
        - Continuous hold (start or refresh at ~7 Hz from HoldButton):
            {"joint": 1..6, "direction": ±1, "speed_pct": 1..100, "hold": true}
        - Release (also emitted on touch-cancel / mouse-leave / unmount):
            {"hold": false}
        Legacy `{joint: 0..5, delta: <rad>}` from now-dead ControlStrip
        callers is still accepted and mapped to an increment."""
        body = await request.json()
        # JOG-11 arbiter: refuse if a program is running (release/stop
        # bodies always pass so an in-flight hold can be cleared).
        _refused = _arbiter_refuse_jog_if_running(body)
        if _refused is not None:
            return _refused
        with _state_lock:
            if STATE["safety"]["estop"]:
                return JSONResponse({"error": "Cannot jog: estop active"}, status_code=400)
            if STATE["safety"]["zone"] != "GREEN":
                return JSONResponse({"error": "Cannot jog: zone not GREEN"}, status_code=400)

        # Release — no joint/direction required. Forward session
        # metadata (hold_id/seq/client_ts_ms) so the driver can enforce
        # session tracking and drop stale queued refreshes.
        # 2026-08-05 (jog_hold_heartbeat regression fix): also drop the
        # server-side _HoldSession so the keepalive thread stops
        # republishing on release. Pre-fix, HTTP-fallback releases
        # left ghost sessions in _active_holds that either kept the
        # motion alive OR only got cleaned up by ws-disconnect / TTL.
        if body.get("hold") is False or body.get("stop") is True:
            payload = {"mode": "joint", "hold": False}
            for k in ("hold_id", "seq", "client_ts_ms"):
                if body.get(k) is not None: payload[k] = body[k]
            _publish_estun_jog(payload)
            _hid = body.get("hold_id")
            if _hid is not None:
                with _active_holds_lock:
                    _active_holds.pop(_hid, None)
            return {"ok": True, "action": "release"}

        raw_joint = body.get("joint")
        try:
            joint_int = int(raw_joint)
        except (TypeError, ValueError):
            return JSONResponse({"error": f"Invalid joint: {raw_joint!r}"}, status_code=400)

        # Continuous hold path — start or refresh.
        if body.get("hold") is True:
            if not (1 <= joint_int <= 6):
                return JSONResponse({"error": "joint must be 1..6"}, status_code=400)
            try:
                direction = int(body.get("direction", 0))
            except (TypeError, ValueError):
                return JSONResponse({"error": "direction not an int"}, status_code=400)
            if direction not in (-1, 1):
                return JSONResponse({"error": "direction must be ±1"}, status_code=400)
            try:
                speed_pct = float(body.get("speed_pct", body.get("speed", 0)))
            except (TypeError, ValueError):
                return JSONResponse({"error": "speed_pct not a number"}, status_code=400)
            if not (0 < speed_pct <= 100):
                return JSONResponse({"error": "speed_pct must be in (0, 100]"}, status_code=400)
            payload = {
                "mode":      "joint",
                "axis":      joint_int,
                "direction": direction,
                "speed_pct": speed_pct,
                "hold":      True,
            }
            for k in ("hold_id", "seq", "client_ts_ms"):
                if body.get(k) is not None: payload[k] = body[k]
            # 2026-08-05 (jog_hold_heartbeat regression fix): register
            # this hold in _active_holds so the keepalive thread
            # republishes at 60ms cadence — same as the WS path does
            # in _handle_ws_client_msg. Pre-fix, HTTP-fallback holds
            # (which fire after any WS drop) published ONE frame and
            # then the driver's 200ms freshness deadman clamped them
            # 200-250ms later. Result: 28 spurious freshness_deadman
            # stops in a 15-minute window on 2026-08-05. See
            # fork registry entry `jog_hold_heartbeat`.
            _hid = body.get("hold_id")
            if _hid is not None:
                _now = time.monotonic()
                with _active_holds_lock:
                    _hs = _active_holds.get(_hid)
                    if _hs is None:
                        _hs = _HoldSession(_hid, None, payload, "joint")
                        _active_holds[_hid] = _hs
                    else:
                        _hs.last_browser_ts = _now
                        _hs.driver_payload_template = payload
            _publish_estun_jog(payload)
            return {"ok": True, "action": "hold"}

        if "delta_deg" in body:
            # Incremental path — 1-based joint, degrees.
            try:
                delta_deg = float(body.get("delta_deg", 0.0))
            except (TypeError, ValueError):
                return JSONResponse({"error": "delta_deg not a number"}, status_code=400)
            if not (1 <= joint_int <= 6):
                return JSONResponse({"error": "joint must be 1..6"}, status_code=400)
            if abs(delta_deg) > 5.0 + 1e-9:
                return JSONResponse({"error": "|delta_deg| exceeds 5°"}, status_code=400)
            if abs(delta_deg) < 0.01:
                return JSONResponse({"error": "delta_deg ~ 0"}, status_code=400)
            axis_1based = joint_int
            joint_0based = joint_int - 1
            step_rad = delta_deg * math.pi / 180.0
        else:
            # Legacy shape: joint 0-5, delta in radians.
            try:
                delta = float(body.get("delta", 0.0))
            except (TypeError, ValueError):
                return JSONResponse({"error": "delta not a number"}, status_code=400)
            if not (0 <= joint_int <= 5):
                return JSONResponse({"error": "joint must be 0..5 (legacy)"}, status_code=400)
            if abs(delta) > 0.175:
                return JSONResponse({"error": "Delta too large (max 10°)"}, status_code=400)
            delta_deg = delta * 180.0 / math.pi
            if abs(delta_deg) > 5.0:
                return JSONResponse({"error": "|delta| exceeds 5° after conversion"}, status_code=400)
            axis_1based = joint_int + 1
            joint_0based = joint_int
            step_rad = delta

        with _state_lock:
            # Optimistic sim update so the UI reflects the intended target
            # even if the driver isn't connected. Real driver feedback via
            # /estun/status overwrites this once telemetry catches up.
            STATE["joints"]["positions"][joint_0based] += step_rad
            joints_snapshot = copy.deepcopy(STATE["joints"])

        _publish_estun_jog({
            "mode":      "joint",
            "axis":      axis_1based,
            "delta_deg": delta_deg,
        })
        return {"ok": True, "joints": joints_snapshot, "delta_deg": delta_deg,
                "action": "increment"}

    @app.post("/cmd/jog_cartesian")
    async def cmd_jog_cartesian(request: Request):
        """Cartesian-space hold-to-jog. Same shape as /cmd/jog but with a
        letter axis ('x','y','z','rx','ry','rz'). Publishes to the SAME
        /robot/jog_command topic with mode:cartesian so the driver's
        continuous-jog state machine handles it (gated by
        allow_cartesian_jog on the driver — refused today by default)."""
        body = await request.json()
        # JOG-11 arbiter: same refusal as joint jog.
        _refused = _arbiter_refuse_jog_if_running(body)
        if _refused is not None:
            return _refused
        with _state_lock:
            if STATE["safety"]["estop"]:
                return JSONResponse({"error": "Cannot jog: estop active"}, status_code=400)
            if STATE["safety"]["zone"] != "GREEN":
                return JSONResponse({"error": "Cannot jog: zone not GREEN"}, status_code=400)

        if body.get("hold") is False or body.get("stop") is True:
            payload = {"mode": "cartesian", "hold": False}
            for k in ("hold_id", "seq", "client_ts_ms"):
                if body.get(k) is not None: payload[k] = body[k]
            _publish_estun_jog(payload)
            # 2026-08-05 (jog_hold_heartbeat regression fix, cart side):
            # drop the ghost _HoldSession so the keepalive thread
            # stops republishing on release.
            _hid = body.get("hold_id")
            if _hid is not None:
                with _active_holds_lock:
                    _active_holds.pop(_hid, None)
            return {"ok": True, "action": "release"}

        axis_letter = str(body.get("axis", "")).lower()
        axis_map = {"x": 1, "y": 2, "z": 3, "rx": 4, "ry": 5, "rz": 6}
        axis_1based = axis_map.get(axis_letter)
        if axis_1based is None:
            return JSONResponse({"error": f"cartesian axis must be one of {list(axis_map)}"},
                                status_code=400)
        try:
            direction = int(body.get("direction", 0))
        except (TypeError, ValueError):
            return JSONResponse({"error": "direction not an int"}, status_code=400)
        if direction not in (-1, 1):
            return JSONResponse({"error": "direction must be ±1"}, status_code=400)
        try:
            speed_pct = float(body.get("speed_pct", body.get("speed", 20)))
        except (TypeError, ValueError):
            return JSONResponse({"error": "speed_pct not a number"}, status_code=400)
        if not (0 < speed_pct <= 100):
            return JSONResponse({"error": "speed_pct must be in (0, 100]"}, status_code=400)

        if body.get("pulse") is True:
            _publish_estun_jog({
                "mode":      "cartesian",
                "axis":      axis_1based,
                "direction": direction,
                "speed_pct": speed_pct,
                "pulse":     True,
            })
            return {"ok": True, "action": "pulse"}

        payload = {
            "mode":      "cartesian",
            "axis":      axis_1based,
            "direction": direction,
            "speed_pct": speed_pct,
            "hold":      True,
        }
        for k in ("hold_id", "seq", "client_ts_ms"):
            if body.get(k) is not None: payload[k] = body[k]
        # 2026-08-05 (jog_hold_heartbeat regression fix, cart side):
        # register the hold in _active_holds so the keepalive thread
        # republishes at 60ms cadence. Prior to this fix, HTTP-
        # fallback cart holds died at the 200ms driver deadman.
        _hid = body.get("hold_id")
        if _hid is not None:
            _now = time.monotonic()
            with _active_holds_lock:
                _hs = _active_holds.get(_hid)
                if _hs is None:
                    _hs = _HoldSession(_hid, None, payload, "cartesian")
                    _active_holds[_hid] = _hs
                else:
                    _hs.last_browser_ts = _now
                    _hs.driver_payload_template = payload
        _publish_estun_jog(payload)
        return {"ok": True, "action": "hold"}

    def _publish_estun_power(payload):
        """Publish a single frame on /robot/power_command. Reliable QoS,
        depth 5 — these are single infrequent commands, unlike jog which
        needs best-effort/volatile. Best-effort try/except keeps the HTTP
        call from 500-ing on a transient publisher hiccup; the driver's
        allow_power gate is the real safety layer."""
        if _ros_node is None:
            return
        try:
            if not hasattr(_ros_node, "_estun_power_pub"):
                _ros_node._estun_power_pub = _ros_node.create_publisher(
                    String, "/robot/power_command", 5)
            m = String(); m.data = json.dumps(payload)
            _ros_node._estun_power_pub.publish(m)
        except Exception:
            pass

    _POWER_ACTIONS = {"enable", "disable", "clear_alarm"}

    @app.post("/cmd/power")
    async def cmd_power(request: Request):
        """Robot power transition dispatcher. Body: {"action": "enable" |
        "disable" | "clear_alarm"}. This endpoint is a thin publisher onto
        /robot/power_command — every safety decision (monitor_only,
        allow_power, connection, jog-preempt on disable) is enforced in
        the driver. Deliberately does NOT check estop or safety zone:
        (a) disable must always be reachable to safe the arm, and
        (b) enable is guarded by the driver's allow_power gate + the
        operator's explicit confirmation in the UI."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        action = str(body.get("action", "")).lower()
        if action not in _POWER_ACTIONS:
            return JSONResponse(
                {"error": f"unknown action {action!r}; expected one of "
                          f"{sorted(_POWER_ACTIONS)}"},
                status_code=400,
            )
        # Under JOG_BACKEND=ros2, the WS estun_driver is intentionally down
        # this session. Publishing /robot/power_command goes to a subscriber
        # that isn't there and the button hangs from the frontend's side.
        # Honest refusal per §285: no silent dead controls. Arm is already
        # enabled by cri_tcp_setup_node's Robot/switchOn step 3/5 at launch;
        # full CRI-TCP wiring of this button is F3-scope.
        if _JOG_BACKEND == "ros2":
            msg = ("Enable is managed by the CRI launch this session. "
                   "The arm is switched on by cri_tcp_setup_node during "
                   "launch (Robot/switchOn, step 3/5). Under "
                   "JOG_BACKEND=ros2 the WS estun_driver is inactive by "
                   "design; this button is not wired to the CRI TCP path "
                   "in F1 scope (F3 will address).")
            return JSONResponse(
                {"ok": False, "action": action, "backend": "ros2",
                 "no_op": True, "error": msg, "message": msg},
                status_code=409,
            )
        _publish_estun_power({"action": action})
        return {"ok": True, "action": action}

    # ── Self-collision guard runtime kill switch ──────────
    #
    # 2026-08-06 (operator directive: ENTIRE self-collision +
    # ground-plane guard OFF). Single authoritative kill switch,
    # exposed here so Configure can render it. The driver's
    # `collision_enabled` parameter is the boot default (also
    # False); this endpoint flips the runtime flag via a
    # /robot/collision_guard_set publish. Fork registry:
    # collision_guard_kill_switch.

    def _publish_collision_guard_set(enabled: bool) -> None:
        """Publish a Bool onto /robot/collision_guard_set. Reliable
        QoS, depth 5 — single infrequent command like power."""
        if _ros_node is None:
            return
        try:
            from std_msgs.msg import Bool as _Bool
            if not hasattr(_ros_node, "_coll_guard_pub"):
                _ros_node._coll_guard_pub = _ros_node.create_publisher(
                    _Bool, "/robot/collision_guard_set", 5)
            m = _Bool(); m.data = bool(enabled)
            _ros_node._coll_guard_pub.publish(m)
        except Exception:
            pass

    @app.get("/api/collision_guard")
    async def api_collision_guard_get():
        with _state_lock:
            r = STATE.get("robot") or {}
            return {
                "ok":               True,
                "enabled":          bool(r.get("collision_enabled")),
                "guard_active":     bool(r.get("collision_guard_active")),
                "model_loaded":     bool(r.get("collision_model_loaded")),
            }

    @app.post("/api/collision_guard")
    async def api_collision_guard_set(request: Request):
        """Body: {"enabled": bool}. Publishes to the driver's
        /robot/collision_guard_set topic and writes an event-log
        entry so every toggle is on record. Deliberately does NOT
        gate on any UI confirmation — the Configure surface owns
        the "are you sure?" prompt; this endpoint is the wire."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        if "enabled" not in body or not isinstance(body["enabled"], bool):
            return JSONResponse(
                {"error": "'enabled' (bool) required"}, status_code=400)
        enabled = bool(body["enabled"])
        _publish_collision_guard_set(enabled)
        # Forensic event — operator's explicit informed choice per
        # the 2026-08-06 directive. Severity=warning on OFF so the
        # event log makes the disabled state visible at a glance.
        try:
            if enabled:
                _event_log.emit(
                    severity='info',
                    source='dashboard',
                    code='collision_guard_enabled',
                    operator_message='Self-collision guard turned ON.',
                    technical_detail='POST /api/collision_guard {enabled:true}',
                    context={'enabled': True})
            else:
                _event_log.emit(
                    severity='warning',
                    source='dashboard',
                    code='collision_guard_disabled',
                    operator_message=(
                        'Self-collision guard turned OFF. All software '
                        'collision guards are disabled — link-on-link '
                        'and link-on-table crashes are possible.'),
                    technical_detail='POST /api/collision_guard {enabled:false}',
                    context={'enabled': False})
        except Exception:
            pass
        return {"ok": True, "enabled": enabled}

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
            # Snapshot per-channel queue depths — sum + max across all
            # clients on each channel. Used by System Check to spot the
            # zombie-WS pattern (queues holding steady > 0 while
            # ws_drops climbs → clients are alive but not draining fast
            # enough → backpressure is doing its job).
            def _depth(clients):
                depths = [c.qsize() for c in clients.values()
                          if hasattr(c, 'qsize')]
                return {
                    'n':    len(depths),
                    'sum':  sum(depths),
                    'max':  max(depths) if depths else 0,
                }
            ws_depth = {
                'state':           {'n': ns, 'sum': 0, 'max': 0},  # ACK-gated slot, no queue
                'lidar':           _depth(_lidar_clients),
                'mesh':            _depth(_mesh_clients),
                'motioncam_cloud': _depth(_motioncam_cloud_clients),
                'motioncam_reco':  _depth(_motioncam_reco_clients),
            }
        with _ws_drops_lock:
            ws_drops_snap = dict(_ws_drops)
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
            # Cumulative WS backpressure kicks per stream. Nonzero means at
            # least one client's send stalled past WS_SEND_TIMEOUT_S — the
            # broadcaster force-closed the socket to protect the event loop.
            "ws_kicked": dict(_ws_kicked),
            # Cumulative drop-oldest counter per channel — nonzero means a
            # bounded queue was full and the oldest payload got evicted to
            # make room for the fresh one (Part E fix). Steady growth =
            # a client is alive but not draining fast enough → the
            # backpressure is working; a client-side lag investigation
            # is warranted, not an outage.
            "ws_drops": ws_drops_snap,
            # Live queue depths per channel — {n=clients, sum, max}. Steady
            # sum > 0 with rising ws_drops is the zombie-WS signature.
            "ws_depth": ws_depth,
            "ws_send_timeout_s": WS_SEND_TIMEOUT_S,
            "state_perf": _state_perf_snapshot(),
            "hold_keepalive": dict(_keepalive_stats),
            "active_holds": len(_active_holds),
            # CRI-proxy flap surface (F1.4 rung-3 fix). last_flip_age_s
            # is derived from last_flip_ts so operators / dashboards can
            # spot flapping without polling the epoch stamp.
            "cri_proxy": {
                **dict(_cri_proxy_stats),
                "last_flip_age_s": (time.time() - _cri_proxy_stats["last_flip_ts"])
                                    if _cri_proxy_stats["last_flip_ts"] > 0 else None,
                "backend": _JOG_BACKEND_ENV,
                "cameras_disabled": _CAMERAS_DISABLED,
            },
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
    # System Check — read-only readiness aggregator
    #
    # Five checks, reported flat: robot / controller / software /
    # services / safety. Purely observational — never enables the arm,
    # opens a gate, or restarts anything on its own. The optional
    # /api/systemcheck/service/restart endpoint is operator-triggered
    # and restricted to a small allowlist that excludes any
    # arm-touching service.
    # ------------------------------------------------------------------
    _SYSTEMCHECK_SERVICES = ("roboai-estun", "roboai-dashboard")
    _SYSTEMCHECK_RESTART_ALLOWLIST = {"roboai-dashboard"}
    _CONTROLLER_STALE_S = 3.0

    def _sha256_file(path: str) -> str:
        import hashlib
        try:
            h = hashlib.sha256()
            with open(path, 'rb') as fp:
                for chunk in iter(lambda: fp.read(65536), b''):
                    h.update(chunk)
            return h.hexdigest()
        except Exception:
            return ''

    def _bundle_hash_for(dir_path: Path) -> str:
        """Hash of the served/built bundle. We hash index.html because
        every content-hashed asset URL is embedded there — any change
        to the app forces a new index.html digest even if the assets
        keep the same names in-flight."""
        idx = dir_path / "index.html"
        return _sha256_file(str(idx)) if idx.is_file() else ''

    def _bundle_asset_hash_for(dir_path: Path) -> str:
        """Extract Vite's content-hash from the served JS asset filename
        (e.g. `assets/index-CpW0QB4a.js` → `CpW0QB4a`). This is the
        SAME string the frontend footer reads from
        document.querySelector('script[src*=\"/assets/index-\"]'), so
        the two views are directly comparable. Returns '' if the
        pattern doesn't match."""
        idx = dir_path / "index.html"
        if not idx.is_file():
            return ''
        try:
            with open(idx, 'r') as f:
                html = f.read()
            import re as _re2
            m = _re2.search(r'/assets/index-([A-Za-z0-9_-]+)\.js', html)
            return m.group(1) if m else ''
        except Exception:
            return ''

    def _service_active(name: str) -> bool:
        import subprocess
        try:
            r = subprocess.run(
                ['systemctl', 'is-active', name],
                capture_output=True, text=True, timeout=1.5)
            return r.stdout.strip() == 'active'
        except Exception:
            return False

    def _check_robot(robot: dict) -> dict:
        if not robot.get('connected'):
            return {'level': 'red',   'state': 'Offline',
                    'detail': 'Driver is not publishing /estun/status. '
                              'Check the roboai-estun service and the '
                              'controller network link.'}
        if robot.get('alarm'):
            aa = robot.get('active_alarm') or {}
            code = aa.get('code') if isinstance(aa, dict) else None
            msg = aa.get('message') if isinstance(aa, dict) else None
            detail = f"Controller alarm {code}: {msg}" if code else \
                     "Controller reports an active alarm."
            return {'level': 'red', 'state': 'Alarm', 'detail': detail}
        if not robot.get('enabled'):
            return {'level': 'amber', 'state': 'Disabled',
                    'detail': 'Arm is connected but disabled. Enable '
                              'from the toolbar when ready.'}
        return {'level': 'green', 'state': 'Ready', 'detail': None}

    def _check_controller() -> dict:
        with _ws_lock:
            n_state = len(_state_clients)
        last_ts = _last_estun_status_ts[0]
        if last_ts <= 0.0:
            return {'level': 'red', 'state': 'Disconnected',
                    'detail': 'No /estun/status frame has been received '
                              'since the dashboard started.'}
        age = time.time() - last_ts
        if age > _CONTROLLER_STALE_S:
            return {'level': 'red', 'state': 'Disconnected',
                    'detail': f'Last /estun/status was {age:.1f}s ago '
                              f'(threshold {_CONTROLLER_STALE_S:.0f}s). '
                              f'Driver has gone silent.'}
        return {'level': 'green', 'state': 'Connected',
                'detail': (f'Last frame {age:.1f}s ago · '
                           f'{n_state} client(s)') if n_state == 0 else None}

    def _check_software() -> dict:
        served = _bundle_hash_for(_STATIC_DIR)
        built  = _bundle_hash_for(_BUILT_FRONTEND_DIR)
        # asset_hash is the Vite content-hash from the JS filename —
        # this is the SAME string the frontend footer reads at runtime
        # from document.querySelector('script[src*="/assets/index-"]').
        # System Check and the footer therefore always agree on which
        # bundle the tab is running.
        asset_hash = _bundle_asset_hash_for(_STATIC_DIR)
        if not served:
            return {'level': 'red', 'state': 'Missing',
                    'detail': f'Served bundle not found under {_STATIC_DIR}.',
                    'served_hash': '', 'built_hash': built[:12],
                    'served_asset_hash': asset_hash}
        if not built:
            # No built dist to compare against → we CANNOT prove the
            # served bundle is up to date. Do NOT return green. This
            # closes the gap that let 2026-07-30 land a stale served
            # bundle while System Check still said "Up to date".
            return {'level': 'amber', 'state': 'Cannot verify',
                    'detail': ('served asset present but no built dist '
                               'on disk to compare against — '
                               '`npm run build` + rsync then reload '
                               f'(served asset {asset_hash})'
                               if asset_hash else
                               'served asset present but no built dist '
                               'on disk to compare against — '
                               '`npm run build` + rsync then reload'),
                    'served_hash': served[:12], 'built_hash': '',
                    'served_asset_hash': asset_hash}
        if served != built:
            return {'level': 'amber', 'state': 'Refresh needed',
                    'detail': (f'Served bundle differs from the latest '
                               f'build on disk. Copy frontend/dist over '
                               f'mock_server/static and reload the tab.'),
                    'served_hash': served[:12], 'built_hash': built[:12],
                    'served_asset_hash': asset_hash}
        return {'level': 'green', 'state': 'Up to date',
                'detail': f'served asset {asset_hash}' if asset_hash else None,
                'served_hash': served[:12], 'built_hash': built[:12],
                'served_asset_hash': asset_hash}

    def _check_services() -> dict:
        results = {name: _service_active(name)
                   for name in _SYSTEMCHECK_SERVICES}
        down = [n for n, ok in results.items() if not ok]
        if not down:
            return {'level': 'green', 'state': 'All running',
                    'detail': None, 'services': results}
        return {'level': 'red',
                'state': f'{len(down)} down',
                'detail': 'Down: ' + ', '.join(down),
                'services': results}

    def _check_safety(robot: dict) -> dict:
        missing = []
        # Joint limits are considered present if EITHER the operator's
        # per-cell override (/opt/cobot/motion/config/robot_limits.yaml)
        # OR the shipped package default (default_robot_limits.yaml
        # under motion_optimization's share dir) exists — ProfileManager
        # falls back to the default if the override is missing, so the
        # cell IS running with valid limits either way.
        limits_paths = [
            os.path.join('/opt/cobot/motion/config', 'robot_limits.yaml'),
            os.path.join(
                '/home/teddy/cobot_ws/install/motion_optimization/share/'
                'motion_optimization/config', 'default_robot_limits.yaml'),
            os.path.join(
                '/home/teddy/cobot_ws/src/motion_optimization/'
                'config', 'default_robot_limits.yaml'),
        ]
        limits_present = any(os.path.isfile(p) for p in limits_paths)
        if not limits_present:
            missing.append('joint limits')
        # Guards are considered "loaded" when the driver has any
        # non-zero collision/env stop threshold. Zero on both is the
        # signature of a driver that never received guard config.
        guard_stop = float(robot.get('guard_stop_mm') or 0.0)
        coll_stop  = float(robot.get('collision_stop_mm') or 0.0)
        env_stop   = float(robot.get('env_stop_mm') or 0.0)
        if guard_stop <= 0 and coll_stop <= 0 and env_stop <= 0:
            missing.append('collision guards')
        if robot.get('ground_z_mm') is None:
            missing.append('ground_z')
        # LiDAR zones — the collision monitor loads zone configuration
        # at boot. If it's not active there's no zone monitoring; if it
        # IS active, we trust the loaded config.
        if not _service_active('roboai-collision-monitor'):
            missing.append('lidar zones')
        # Safety-row detail always includes the operator speed cap so
        # the operator has one place to see the ceiling that governs
        # every AUTO/program write. Doesn't gate the level — the cap
        # being high isn't itself a safety fault; the row goes amber
        # only for missing config.
        op_cap_pct = robot.get('operator_speed_limit_pct')
        if op_cap_pct is None:
            op_frac = robot.get('operator_speed_limit')
            if op_frac is not None:
                try:
                    op_cap_pct = int(round(float(op_frac) * 100))
                except (TypeError, ValueError):
                    op_cap_pct = None
        jog_eff_pct = robot.get('effective_speed_cap_pct')
        if jog_eff_pct is None:
            eff = robot.get('effective_speed_cap')
            if eff is not None:
                try:
                    jog_eff_pct = int(round(float(eff) * 100))
                except (TypeError, ValueError):
                    jog_eff_pct = None
        hs_thresh = robot.get('high_speed_confirm_threshold_pct')
        cap_detail_bits = []
        if op_cap_pct is not None:
            cap_detail_bits.append(f'operator cap {op_cap_pct}% (AUTO/program ceiling)')
        if jog_eff_pct is not None:
            cap_detail_bits.append(f'jog effective {jog_eff_pct}%')
        if hs_thresh is not None:
            cap_detail_bits.append(f'mid-run high-speed confirm above {hs_thresh}%')
        cap_detail = ' · '.join(cap_detail_bits) if cap_detail_bits else None

        if missing:
            detail = 'Missing: ' + ', '.join(missing)
            if cap_detail:
                detail += '. ' + cap_detail
            return {'level': 'amber', 'state': 'Check config', 'detail': detail}
        return {'level': 'green',
                'state': (f'Loaded · cap {op_cap_pct}%'
                          if op_cap_pct is not None else 'Loaded'),
                'detail': cap_detail}

    def _check_codegen() -> dict:
        """Report boot-time vs on-disk sha for estun_driver.program_ops.
        Amber-and-inform when they differ — the running dashboard is
        emitting Lua from stale in-memory code and a restart of
        roboai-dashboard + roboai-estun is required to load the disk
        version. Never blocks — the operator can still Run; but the
        Program page banner + Run-confirm modal + run-complete toast
        all surface this state so it can't be silently skipped again
        (2026-07-30 fourth staleness episode motivated this check)."""
        try:
            from estun_driver import program_ops as _po
        except Exception as e:
            return {'level': 'red', 'state': 'Import failed',
                    'detail': f'program_ops import: {e}',
                    'boot_sha': '', 'disk_sha': '', 'stale': False}
        boot = (_po.CODEGEN_VERSION.get('src_sha256') or '')[:12]
        disk = _po.current_disk_src_sha256()[:12]
        stale = (bool(boot) and bool(disk)
                 and boot != disk and disk != 'unknown')
        if stale:
            return {
                'level':    'amber',
                'state':    'Restart required',
                'detail':   ('Code updated on disk — restart required '
                             'to apply (roboai-dashboard, roboai-estun). '
                             f'boot={boot} disk={disk}. '
                             'Runs pressed in this state will use the OLD '
                             'in-memory codegen; the run manifest will '
                             'stamp codegen_stale=true.'),
                'boot_sha': boot, 'disk_sha': disk, 'stale': True,
            }
        return {
            'level':    'green',
            'state':    'In sync',
            'detail':   f'boot={boot} == disk={disk}',
            'boot_sha': boot, 'disk_sha': disk, 'stale': False,
        }

    @app.get("/api/codegen/status")
    async def api_codegen_status():
        """Cheap poll endpoint for the Program page banner. Returns
        the same {stale, boot_sha, disk_sha, ...} shape the System
        Check codegen row carries — one source of truth."""
        return _check_codegen()

    @app.get("/api/systemcheck")
    async def api_systemcheck():
        with _state_lock:
            robot = copy.deepcopy(STATE.get('robot') or {})
        checks = [
            {'key': 'robot',      'label': 'Robot',      **_check_robot(robot)},
            {'key': 'controller', 'label': 'Controller', **_check_controller()},
            {'key': 'software',   'label': 'Software',   **_check_software()},
            {'key': 'codegen',    'label': 'Codegen',    **_check_codegen()},
            {'key': 'services',   'label': 'Services',   **_check_services()},
            {'key': 'safety',     'label': 'Safety',     **_check_safety(robot)},
        ]
        levels = {c['level'] for c in checks}
        ready = 'red' not in levels and 'amber' not in levels
        return {
            'ready':   ready,
            'summary': 'READY' if ready else 'NOT READY',
            'checks':  checks,
            't':       round(time.time(), 3),
        }

    @app.post("/api/systemcheck/service/restart")
    async def api_systemcheck_service_restart(request: Request):
        """Operator-initiated systemctl restart for a small allowlist of
        non-arm services. NEVER touches roboai-estun (motion) — the
        operator restarts the driver from a different, more deliberate
        surface. Returns the systemctl exit code + stderr so the UI
        can surface a permission failure clearly."""
        import subprocess
        try:
            body = await request.json()
        except Exception:
            body = {}
        service = str(body.get('service') or '')
        if service not in _SYSTEMCHECK_RESTART_ALLOWLIST:
            return JSONResponse(
                {'error': f'service {service!r} not in allowlist',
                 'allowed': sorted(_SYSTEMCHECK_RESTART_ALLOWLIST)},
                status_code=400,
            )
        try:
            r = subprocess.run(
                ['systemctl', 'restart', service],
                capture_output=True, text=True, timeout=8.0)
        except Exception as e:
            return JSONResponse({'error': str(e)}, status_code=500)
        return {
            'ok':      r.returncode == 0,
            'service': service,
            'rc':      r.returncode,
            'stderr':  (r.stderr or '').strip()[:400],
        }

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

    # Path-traversal guard for /api/programs/{prog_id} routes. Slugs
    # produced by POST are LOWERCASE ALPHANUMERIC ONLY — no underscore
    # or dash — because the Estun controller's URL parser (:9198)
    # splits `projectlua_<id>` on '_' into nested path segments.
    # A program id `new_program_2` gets stored at
    # `projectlua/new/program/2/…` on the controller but projectlist
    # still keys it as `new_program_2`, so save reports 4×200-OK yet
    # project/run resolves the id to a non-existent path and emits
    # controller alarm 10001 "Project <…> does not exist." Wire-proof:
    # 2026-07-20 13:02:10 log. Fixed by keeping our ids single-segment
    # so no URL-parser split can turn a valid save into an unrunnable
    # project.
    import re as _prog_re
    _PROG_DIR = '/opt/cobot/programs'
    # Strict slug rule for CREATION only. New programs authored via POST
    # /api/programs get a controller-safe slug (lowercase-alphanum, no
    # underscore) — see the URL-parser-split rationale on that endpoint.
    _PROG_ID_RE = _prog_re.compile(r'^[a-z0-9]+$')
    # Relaxed regex for read/update/delete routes. Older files may
    # carry underscores in their slug (the wizard used to produce
    # `new_program.json`); every route that has to REACH an existing
    # file must accept those, otherwise the operator gets a 404 on a
    # program the list is happily showing. Traversal still bounded —
    # the character class is [a-z0-9_-] with no dots or slashes, so
    # `_prog_read_path` always returns a path inside _PROG_DIR.
    _PROG_READ_ID_RE = _prog_re.compile(r'^[a-z0-9_-]+$')

    def _prog_path(prog_id: str):
        if not _PROG_ID_RE.match(prog_id or ''):
            return None
        return os.path.join(_PROG_DIR, prog_id + '.json')

    def _prog_read_path(prog_id: str):
        """Read/update/delete path resolver. Accepts the underscore/
        hyphen shape older files carry so the operator can delete or
        migrate a legacy `new_program.json` — the strict slug rule
        stays enforced on creation via _prog_path."""
        if not _PROG_READ_ID_RE.match(prog_id or ''):
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

    # ─── Estun-arm program pipeline (ladder-proven, commit d059207) ─────
    #
    # This is the REAL-ARM run path — distinct from /api/program/run
    # (which dispatches to the sim/executor). Sequence per press:
    #
    #   1. Read /opt/cobot/programs/{id}.json   (fresh every press — no
    #      stale controller-stored copy is trusted; see §Staleness below)
    #   2. Codegen Lua + varspoint via program_ops.codegen_lua_from_program
    #      — hard-caps speed_pct at the driver's operator_speed_limit
    #   3. Publish {op:save, …}                 → driver POSTs 4 HTTP
    #      calls (source + varspoint + project.json + projectlist)
    #   4. Publish {op:to_auto}
    #   5. Publish {op:set_auto_rate, pct:<eff>}
    #   6. Publish {op:set_breakpoint, task_id:'main', lines:[]}
    #   7. Publish {op:clear_start_line}
    #   8. Publish {op:run, program_id, task_id:'main'}
    #
    # Each op passes through the driver's monitor_only + allow_move gate.
    # A closed gate → rejection on /estun/rejected → surfaced to the UI
    # via STATE.robot.rejected. We DELIBERATELY do NOT pre-check the
    # gate here: the operator's requirement is that pressing Run with
    # the gate closed still surfaces the driver's own refusal, proving
    # the whole pipeline is wired end-to-end.
    #
    # Staleness: the frontend re-fetches the program from /api/programs
    # before opening the confirm modal, and this endpoint re-reads the
    # disk copy on every call — so a taught-poses edit made in the same
    # session ships to the controller before run. The controller's
    # varspoint / robotcode / projectlist are unconditionally OVER-
    # WRITTEN on every press (see program_ops.save_project — its
    # projectlist MERGE preserves other projects but always rewrites
    # our entry with the fresh codegen output).

    @app.post("/api/estun/program/run")
    async def api_estun_program_run(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        # JOG-11 arbiter: refuse if a jog session is active. Fires
        # BEFORE program_id validation so the operator sees the jog
        # conflict rather than a generic 400.
        _refused = _arbiter_refuse_run_if_jogging()
        if _refused is not None:
            return _refused
        prog_id = str(body.get("program_id") or "").strip()
        if not prog_id:
            return JSONResponse({"error": "program_id required"}, status_code=400)
        # Task id is fixed to "main" for the B1 shape. Multi-task programs
        # come with the multi-task saveAll flow (deferred, tracked in the
        # architecture doc).
        task_id = "main"

        path = _prog_path(prog_id)
        if not os.path.isfile(path):
            return JSONResponse({"error": f"program {prog_id!r} not on disk"},
                                status_code=404)
        try:
            with open(path) as f:
                program = json.load(f)
        except Exception as e:
            return JSONResponse({"error": f"program read: {e}"}, status_code=500)

        # Codegen. operator_speed_limit is a driver-side parameter — mirrored
        # into STATE.robot from /estun/mode. It's a FRACTION (0..1) there;
        # program_ops takes an integer percent. If we don't have a live
        # /estun/mode snapshot yet (driver not up), fall back to a very
        # conservative 25% cap.
        with _state_lock:
            r = STATE.get("robot", {})
            op_frac = float(r.get("operator_speed_limit", 0.25))
            allow_move = bool(r.get("allow_move", False))
            monitor_only = bool(r.get("monitor_only", True))
        operator_cap_pct = max(1, min(100, int(round(op_frac * 100))))

        # Speed selection. The Monitor Run box overrides
        # program.config.speed_pct — we clone the program in-memory and
        # patch speed_pct so program_ops.codegen_lua_from_program's
        # capping math (min(requested, operator_cap)) does the rest.
        # Invalid values clamp to [1..100] with a note; the driver's
        # operator_speed_limit still enforces the hard cap after that.
        override_pct = None
        raw_speed = body.get("run_speed_pct")
        speed_note = None
        if raw_speed is not None:
            try:
                override_pct = int(raw_speed)
            except Exception:
                speed_note = f"run_speed_pct not an integer ({raw_speed!r}); using program default"
                override_pct = None
            if override_pct is not None:
                if override_pct < 1:
                    speed_note = f"run_speed_pct {override_pct} < 1; clamped to 1"
                    override_pct = 1
                elif override_pct > 100:
                    speed_note = f"run_speed_pct {override_pct} > 100; clamped to 100"
                    override_pct = 100
        if override_pct is not None:
            program = dict(program)  # shallow copy
            cfg = dict(program.get("config") or {})
            cfg["speed_pct"] = override_pct
            program["config"] = cfg

        try:
            from estun_driver import program_ops  # ladder-proven module
        except Exception as e:
            return JSONResponse({"error": f"program_ops import: {e}"},
                                status_code=500)

        # D14 pending-pose gate (2026-08-04) — runs BEFORE codegen so
        # a program with untaught anchors never even reaches Lua
        # emission. Firmware bug #3 (three holepartpalletize kills
        # 2026-08-03/04 on movJCoorRel → mm2mAndDeg2rad v.size()>=6
        # → exitProcess) is silent on the wire: no /rejected frame,
        # no error toast — the arm just freezes and C2Control dies.
        # This gate is the operator-facing quarantine: teach the
        # missing positions in the Program Editor and try again.
        try:
            _pending = program_ops.check_program_pending_poses(program)
        except Exception as _pe:
            print(f'[run] WARN pending-pose check raised: {_pe}',
                  flush=True)
            _pending = []
        if _pending:
            _preview = _pending[:5]
            _step_summary = ', '.join(
                f'step {p["step_idx"] + 1} ({p.get("action","?")})'
                for p in _preview)
            _more = (f' and {len(_pending) - 5} more'
                     if len(_pending) > 5 else '')
            return JSONResponse({
                "ok": False,
                "error": (
                    f'known controller-crashing codegen — regenerate '
                    f'required: {len(_pending)} motion step(s) have '
                    f'untaught positions ({_step_summary}{_more}). '
                    f'Teach the missing positions in the Program '
                    f'Editor before running (firmware bug #3, '
                    f'mm2mAndDeg2rad v.size()>=6).'),
                "outcome": {
                    "kind": "pending_poses",
                    "count": len(_pending),
                    "findings": _pending,
                },
                "program_id": prog_id,
            }, status_code=400)

        try:
            lua, points, eff_pct = program_ops.codegen_lua_from_program(
                program, operator_speed_limit_pct=operator_cap_pct)
        except AssertionError as e:
            # D14 codegen post-emit assertion tripped. This is defense
            # in depth behind the pending-pose gate above — a bug that
            # slipped past the pre-codegen scan would still be caught
            # here rather than reaching the controller.
            return JSONResponse({
                "ok": False,
                "error": (
                    f'codegen refused to emit — mov* arity assertion '
                    f'failed: {e}'),
                "outcome": {
                    "kind": "arity_assertion_failed",
                    "reason": str(e),
                },
                "program_id": prog_id,
            }, status_code=400)
        except Exception as e:
            return JSONResponse({"error": f"codegen: {e}"}, status_code=500)

        # Codegen-source freshness self-check. If program_ops.py on disk
        # differs from the sha the running module captured at import, the
        # in-memory codegen is stale relative to disk — a restart would
        # produce different Lua. The 2026-07-28 bowl-run investigation
        # burned hours because there was no signal for this. We don't
        # block the run (the operator may be mid-cycle and expects the
        # button to work), but we LOG the mismatch and stamp the
        # comparison into the run manifest so /api/runs makes it visible.
        codegen_boot_sha  = program_ops.CODEGEN_VERSION.get('src_sha256', '')
        codegen_disk_sha  = program_ops.current_disk_src_sha256()
        codegen_is_stale  = (codegen_boot_sha != codegen_disk_sha
                             and codegen_disk_sha != 'unknown'
                             and codegen_boot_sha != 'unknown')
        if codegen_is_stale:
            print(f'[run] WARN codegen source changed since boot — '
                  f'in-memory sha={codegen_boot_sha[:12]} '
                  f'disk sha={codegen_disk_sha[:12]}. '
                  f'This run uses the IN-MEMORY (boot-time) codegen. '
                  f'Restart roboai-dashboard to load disk version.',
                  flush=True)

        # Fresh-Lua identity assertion. The Lua we're about to hash for
        # the byte-verify below MUST be exactly what codegen just
        # returned — anything else would mean local corruption between
        # here and the save publish. This is a hash-of-hash sanity
        # check rather than a real guard (the two operands come from
        # the same variable), but a future refactor that splits
        # regenerate from push would immediately trip this assertion.
        import hashlib as _hashlib_run_assert
        _push_sha = _hashlib_run_assert.sha256(lua.encode('utf-8')).hexdigest()

        # Empty-program guard — VERB-AGNOSTIC (2026-08-03).
        # Routes through `program_ops.has_valid_motion` so this gate
        # and the home-set gate below share ONE predicate. A valid
        # all-cartesian program (only movL(pN)) MUST pass this
        # gate; the pre-fix wording was movJ-only, which read
        # incorrectly under verb-fidelity + all-cartesian columns
        # (many legal programs emit zero movJ).
        has_motion, _motion_counts = program_ops.has_valid_motion(lua)
        if not has_motion:
            # Per-verb breakdown from the catalogue set — omit the
            # verbose full list of 13 zero counts and just show the
            # non-zero ones (or "all zero" when everything is 0).
            _nz = {k: v for k, v in _motion_counts.items()
                   if k not in ('total', 'motion_verbs_checked')
                   and isinstance(v, int) and v > 0}
            _detail = (', '.join(f'{k}={v}' for k, v in sorted(_nz.items()))
                       if _nz else 'all mov* verbs = 0')
            return JSONResponse({
                "error": ("program has no runnable motion — teach at "
                          "least one point (or bind a pallet frame) "
                          "before running"),
                "ok": False,
                "outcome": {
                    "kind":   "empty_program",
                    "reason": (f"codegen produced zero motion-verb "
                               f"emissions ({_detail})"),
                    "motion_counts": _motion_counts,
                },
                "program_id": prog_id,
                "requested_pct":  int(program.get("config", {}).get(
                    "speed_pct") or program.get("speed_pct") or 10),
                "effective_pct":  int(eff_pct),
            }, status_code=400)

        # ── LINT GATE (2026-07-30 §2-§3) ─────────────────────────
        # Every emitted call is checked against luaenginelib.json
        # (168-verb authoritative catalogue) BEFORE a single byte
        # reaches the controller. This is the invariant that lets us
        # promise "the robot will never again be the first thing to
        # notice an invalid line" — the waitCondition(false,N) reject
        # on 2026-07-30 08:40 is the incident that motivates it.
        # Findings are refused with a structured payload the UI
        # surfaces per-line.
        try:
            lint_findings = program_ops.lint_lua_source(lua)
        except Exception as _le:
            return JSONResponse({
                "ok": False,
                "error": f"lint failed to run: {type(_le).__name__}: {_le}",
                "outcome": {"kind": "lint_infrastructure_error",
                            "reason": str(_le)},
                "program_id": prog_id,
            }, status_code=500)
        if lint_findings:
            first = lint_findings[0]
            return JSONResponse({
                "ok": False,
                "error": (f"lint blocked push: {len(lint_findings)} finding(s); "
                          f"first at line {first.get('line')} verb "
                          f"{first.get('verb')!r}: {first.get('reason')}"),
                "outcome": {"kind": "lint_failed",
                            "count": len(lint_findings),
                            "findings": lint_findings},
                "program_id": prog_id,
                "codegen": {
                    "boot_sha": program_ops.CODEGEN_VERSION.get(
                        'src_sha256','')[:12],
                    "disk_sha": program_ops.current_disk_src_sha256()[:12],
                },
            }, status_code=400)

        # Controller-id underscore-split guard. If our program id
        # contains anything other than [a-z0-9], the controller's
        # `projectlua_<id>` URL parser will split on the separator
        # and store the project at a path that doesn't round-trip
        # (2026-07-20 wire-proof: `new_program_2` → files land at
        # `projectlua/new/program/2/…`, project/run then can't
        # resolve back to the id → alarm 10001). Refuse the run
        # rather than emit a save that runs OK on paper but fails
        # at start.
        if not _PROG_ID_RE.match(prog_id):
            return JSONResponse({
                "error": f"program id {prog_id!r} contains characters the "
                         "controller can't round-trip (only [a-z0-9] "
                         "allowed). Rename the program and try again.",
                "ok": False,
                "outcome": {"kind": "id_not_controller_safe",
                            "reason": f"id {prog_id!r} would collide with "
                                      "controller URL-parser separator"},
            }, status_code=400)

        # Hash the source so the UI can display an upload-fingerprint —
        # helps the operator visually confirm two presses in a row shipped
        # DIFFERENT programs (or the same one) when they edit between runs.
        import hashlib
        src_hash = hashlib.sha256(lua.encode("utf-8")).hexdigest()[:12]

        # Snapshot the rejection ring so we can attribute any refusals
        # that arrive DURING this endpoint's op sequence back to this
        # specific press.
        with _state_lock:
            r = STATE.get("robot", {})
            rej_before = len(r.get("rejected", []))

        if _ros_node is None:
            return JSONResponse({"error": "ros not available"}, status_code=503)
        # Part G byte-verify (2026-07-22): publish `save` FIRST alone,
        # wait for the driver's save event, GET the stored Lua from the
        # controller, and compare its sha256 to what codegen emitted.
        # Only if the two agree do we publish the rest of the run
        # sequence — otherwise we refuse the run with a readable error.
        # Prevents the class of failure where a network stall dropped
        # one of the 4 save POSTs; without this check we'd blindly run
        # a partially-updated program.
        try:
            _ros_node._estun_publish_op(
                "save",
                program_id=prog_id, task_id=task_id,
                name=str(program.get("name") or prog_id),
                task_name="main",
                points=points, lua_source=lua)
        except Exception as e:
            return JSONResponse({"error": f"publish save: {e}"}, status_code=500)

        # Wait up to 4s for the driver to publish a save event with all
        # 4 HTTP-POST steps green.
        save_event = None
        save_deadline = time.time() + 4.0
        while time.time() < save_deadline:
            await asyncio.sleep(0.05)
            with _state_lock:
                r = STATE.get("robot", {})
                new_rej = r.get("rejected", [])[rej_before:]
                prog_state = r.get("program", {})
                save_event = prog_state.get("last_save")
            program_rejects = [x for x in new_rej if x.get("family") == "program"]
            if program_rejects:
                rej0 = program_rejects[0]
                reason = rej0.get("reason") or ""
                # Reason-code aware kind (2026-08-04). Prefer the
                # driver-supplied reason_code (added at
                # estun_driver_node.py:1288 for the WS gate) so the
                # frontend maps to the operator message "Controller
                # link down — program NOT loaded" rather than the
                # generic save-rejected. Fall back to reason-string
                # match for driver builds that predate the code.
                rcode = rej0.get("reason_code")
                if rcode == "transport_down" or "ws not connected" in reason:
                    kind = "transport_down"
                else:
                    kind = "save_rejected"
                outcome = {"kind": kind, "reason": reason}
                if rcode:
                    outcome["reason_code"] = rcode
                return JSONResponse({
                    "ok": False,
                    "error": reason,
                    "outcome": outcome,
                }, status_code=400)
            if save_event and all(s.get("http_status") == 200
                                  for s in save_event.get("steps", [])):
                break
        if not (save_event and all(s.get("http_status") == 200
                                   for s in save_event.get("steps", []))):
            # Final drain (2026-08-28): the inner loop can time out
            # a hair before the driver's reject event lands in
            # STATE["robot"]["rejected"]. Test100 hit this — driver
            # rejected at 09:10:29.824 with "allow_move gate closed",
            # dashboard classified at 09:10:33.874, exactly 4 s later,
            # and the operator saw the generic "transient network
            # hiccup" toast for what was really a gate-closed refusal.
            # Re-check the rejected list once before defaulting.
            with _state_lock:
                r = STATE.get("robot", {})
                new_rej = r.get("rejected", [])[rej_before:]
            program_rejects = [x for x in new_rej
                               if x.get("family") == "program"]
            if program_rejects:
                rej0 = program_rejects[0]
                reason = rej0.get("reason") or ""
                rcode = rej0.get("reason_code")
                if rcode == "transport_down" or "ws not connected" in reason:
                    kind = "transport_down"
                else:
                    kind = "save_rejected"
                outcome = {"kind": kind, "reason": reason}
                if rcode:
                    outcome["reason_code"] = rcode
                return JSONResponse({
                    "ok": False,
                    "error": reason,
                    "outcome": outcome,
                }, status_code=400)
            return JSONResponse({
                "ok": False,
                "error": ("save did not complete cleanly (some POSTs "
                          "did not return 200) — refusing to run"),
                "outcome": {"kind": "save_failed", "save": save_event},
            }, status_code=502)

        # GET stored Lua + byte-verify. Uses http_get_lua added in
        # Part B; runs off-loop in a thread so we don't block asyncio.
        import hashlib
        sent_sha = hashlib.sha256(lua.encode('utf-8')).hexdigest()
        try:
            stored = await asyncio.wait_for(
                asyncio.to_thread(
                    program_ops.http_get_lua,
                    "192.168.2.136", 9198,
                    project_id=prog_id, task_id=task_id),
                timeout=4.0)
            stored_sha = hashlib.sha256(stored.encode('utf-8')).hexdigest()
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"post-save byte-verify GET failed: {e}",
                "outcome": {"kind": "byte_verify_get_failed",
                            "reason": str(e)},
            }, status_code=502)
        if stored_sha != sent_sha:
            return JSONResponse({
                "ok": False,
                "error": (f"post-save byte-verify MISMATCH: sent "
                          f"sha256={sent_sha[:12]} but controller "
                          f"has {stored_sha[:12]}. Refusing to run — "
                          f"the stored Lua is not what codegen produced."),
                "outcome": {"kind": "byte_verify_mismatch",
                            "sent_sha":   sent_sha[:12],
                            "stored_sha": stored_sha[:12]},
            }, status_code=502)

        # Byte-verify passed. Stamp the codegen version + push sha into
        # the recorder so the NEXT run manifest carries the attribution.
        # Handed off BEFORE publishing the run op — the recorder starts
        # the manifest on the controller's state=2 transition, which
        # lands after our publish, so metadata must be pre-staged.
        try:
            if _joint_recorder is not None:
                _joint_recorder.attach_pending_metadata({
                    'codegen_version':   dict(program_ops.CODEGEN_VERSION),
                    'codegen_disk_sha':  codegen_disk_sha[:12],
                    'codegen_stale':     bool(codegen_is_stale),
                    'pushed_lua_sha256': _push_sha,
                    'pushed_lua_sha12':  _push_sha[:12],
                    'stored_lua_sha256': stored_sha,
                    'stored_lua_sha12':  stored_sha[:12],
                    'requested_pct':     int(program.get('config', {}).get(
                        'speed_pct') or program.get('speed_pct') or 10),
                    'effective_pct':     int(eff_pct),
                    'operator_cap_pct':  int(operator_cap_pct),
                })
        except Exception as e:
            print(f'[run] attach_pending_metadata failed: {e}', flush=True)
        # D9 line_map wire (2026-08-03) — mirror the resident program's
        # codegen sha into STATE.robot.program so the Monitor's live
        # step highlight can compare against `/api/programs/{id}/
        # line_map` and honor the honesty guard (mismatch → no
        # highlight + "line map unavailable" note).
        try:
            with _state_lock:
                pg = STATE.setdefault("robot", {}).setdefault("program", {})
                pg["codegen_sha"] = program_ops.CODEGEN_VERSION.get(
                    'src_sha256', '')[:12]
                pg["codegen_git"] = program_ops.CODEGEN_VERSION.get(
                    'git_sha', '')
                pg["pushed_lua_sha12"] = _push_sha[:12]
                pg["stored_lua_sha12"] = stored_sha[:12]
                pg["resident_program_id"] = prog_id
        except Exception as e:
            print(f'[run] resident program state mirror failed: {e}',
                  flush=True)
        # D9 line_map sidecar refresh (2026-08-03) — the push path
        # was mirroring codegen_sha to STATE.robot.program but NOT
        # regenerating the sidecar at /opt/cobot/programs/{id}.
        # line_map.json. After a deploy that bumps codegen_sha,
        # the sidecar stayed pinned to the sha AT LAST /api/programs
        # save, so `wire codegen_sha != sidecar codegen_sha` and
        # the Monitor honesty guard fired every run. The push IS
        # the moment the resident becomes current — regenerate the
        # sidecar here so the sha stamp AND the line_map both
        # reflect the Lua we just pushed. Best-effort — a sidecar
        # write failure never blocks the run.
        try:
            _compute_and_save_line_map(program)
        except Exception as e:
            print(f'[run] sidecar refresh failed: {e}', flush=True)

        # Push-only shortcut (2026-08-03) — the LOAD action from the
        # Program Library reaches this endpoint with `push_only:True`
        # so a load actually PUSHES the program to the controller
        # (rather than only setting dashboard state). Everything up
        # to this point already ran: codegen + save + byte-verify +
        # STATE mirror + sidecar refresh. Skipping the to_auto/run
        # publish here means the resident IS updated but the arm
        # does NOT move — the same guarantee the operator gets from
        # a manual pre-run push, wired to a normal library click.
        if bool(body.get("push_only")):
            return {"ok": True,
                    "outcome":       {"kind": "pushed"},
                    "program_id":    prog_id,
                    "pushed_lua_sha12": _push_sha[:12],
                    "stored_lua_sha12": stored_sha[:12],
                    "effective_pct": int(eff_pct)}

        try:
            _ros_node._estun_publish_op("to_auto")
            # at_run_start bypasses the driver's mid-run high-speed
            # confirm requirement — the Run modal already ran the
            # operator through its own confirm before this op fired.
            _ros_node._estun_publish_op(
                "set_auto_rate", pct=int(eff_pct), at_run_start=True)
            _ros_node._estun_publish_op(
                "set_breakpoint", task_id=task_id, lines=[])
            _ros_node._estun_publish_op("clear_start_line")
            _ros_node._estun_publish_op(
                "run", program_id=prog_id, task_id=task_id)
        except Exception as e:
            return JSONResponse({"error": f"publish run: {e}"}, status_code=500)

        # Give the driver a short window to publish either a save event
        # OR a rejection so the response reflects the real outcome, not
        # just "we published, don't know what happened."
        deadline = time.time() + 1.5
        outcome = None
        while time.time() < deadline:
            await asyncio.sleep(0.05)
            with _state_lock:
                r = STATE.get("robot", {})
                new_rej = r.get("rejected", [])[rej_before:]
                prog_state = r.get("program", {})
            program_rejects = [x for x in new_rej if x.get("family") == "program"]
            if program_rejects:
                outcome = {"kind": "rejected",
                           "reason": program_rejects[0].get("reason"),
                           "payload_head": program_rejects[0].get("payload", "")[:120]}
                break
            # Any save event with a per-step failure counts as save-failed;
            # otherwise we consider run-published a success once we see
            # program_state != 0 (2 or 3) or when we've exhausted the
            # window and see no rejection.
            save = prog_state.get("last_save")
            if save and any(s.get("http_status") != 200 for s in save.get("steps", [])):
                outcome = {"kind": "save_failed", "save": save}
                break
        if outcome is None:
            outcome = {"kind": "published"}

        return {
            "ok": outcome["kind"] in ("published",),
            "program_id": prog_id,
            "task_id":    task_id,
            "requested_pct":  int(program.get("config", {}).get(
                "speed_pct") or program.get("speed_pct") or 10),
            "override_pct":   override_pct,
            "speed_note":     speed_note,
            "operator_cap_pct": operator_cap_pct,
            "effective_pct":  int(eff_pct),
            "points":     list(points.keys()),
            "source_hash": src_hash,
            "gate": {"allow_move": allow_move, "monitor_only": monitor_only},
            "codegen": {
                "git_sha":    program_ops.CODEGEN_VERSION.get('git_sha'),
                "git_dirty":  program_ops.CODEGEN_VERSION.get('git_dirty'),
                "boot_sha":   codegen_boot_sha[:12],
                "disk_sha":   codegen_disk_sha[:12],
                "stale":      bool(codegen_is_stale),
            },
            "outcome": outcome,
        }

    # ── Return Home — wire-verified path via /estun/program ────────
    #
    # The frontend's homeRobot() used to publish {action:'home'} to
    # /task/run_program, which the executor forwarded to /estun/command;
    # /estun/command is bound to _on_write_reject on the driver (see
    # estun_driver_node.py:851 — "non-jog/power write paths not
    # implemented on this branch"), so every press was silently
    # rejected and never reached the arm. On top of that,
    # roboai-executor.service is inactive on this deployment, so
    # /task/run_program had no subscriber at all — double break.
    #
    # This endpoint bypasses both problems by synthesising a one-step
    # `move_home` program in memory from /opt/cobot/home.json (the
    # single-source-of-truth home pose) and dispatching it through
    # the wire-verified /estun/program save→run pipeline the Run
    # button already uses. No new controller verbs, no new codegen
    # syntax; every op emitted here is one the ladder already proves.
    # Silent failure is impossible — every early exit returns a JSON
    # body with `ok:false` + a specific `outcome.kind` the UI surfaces
    # as a toast.
    _HOME_FILE = '/opt/cobot/home.json'
    _HOME_PROG_ID = 'roboaihome'
    _HOME_TASK_ID = 'main'

    @app.get("/api/robot/home/preview")
    async def api_robot_home_preview():
        """Return everything the Return Home confirm dialog needs to
        pick between a proven-path retrace and a direct move: whether
        a home pose is configured, whether there's a fresh breadcrumb
        trail from the current or most-recent program run, its
        thinned length, the effector state at the interruption point,
        and the current gate. NO side effects — pure read. The
        frontend fetches this on the confirm dialog's mount."""
        # Home configured?
        home_present = os.path.isfile(_HOME_FILE)
        home_source  = None
        if home_present:
            try:
                with open(_HOME_FILE) as f:
                    home = json.load(f)
                home_source = home.get('source')
            except Exception:
                home_present = False

        # Trail lookup. Prefer the active trail (in-flight or paused
        # run); otherwise the last finalised trail (a program that
        # completed a moment ago is still meaningful).
        collector = _ros_node._breadcrumbs if _ros_node is not None else None
        raw_trail = collector.latest_trail() if collector else None
        current_joints_deg = collector.latest_joints_deg() if collector else None
        prog_steps = collector.active_program_steps() if collector else None

        trail_payload = {"available": False}
        if raw_trail and raw_trail.get('waypoints'):
            wps = raw_trail['waypoints']
            thinned = thin_waypoints(wps)
            stale = is_stale(raw_trail, current_joints_deg)
            # Effector state — walk the program's steps up to the last
            # completed step. If the collector's cached step list is
            # gone (finalised trail; steps not reloaded), fall back to
            # re-reading from disk here.
            if not prog_steps:
                pid = raw_trail.get('program_id') or ''
                try:
                    with open(os.path.join(_PROG_DIR, f'{pid}.json')) as f:
                        prog_steps = (json.load(f) or {}).get('steps') or []
                except Exception:
                    prog_steps = []
            eff = effector_state_at_end(raw_trail, prog_steps)
            trail_payload = {
                "available":              True,
                "program_id":             raw_trail.get('program_id'),
                "program_name":           raw_trail.get('program_name'),
                "achieved_at":            raw_trail.get('run_finished_at')
                                          or (wps[-1].get('ts') if wps else None),
                "waypoint_count":         len(wps),
                "waypoint_count_thinned": len(thinned),
                "last_step_index":        wps[-1].get('step_index'),
                "paused_mid_step":        bool(wps[-1].get('paused_mid_step')),
                "finalized":              bool(raw_trail.get('finalized')),
                "finish_reason":          raw_trail.get('finish_reason'),
                "is_stale":               stale,
                "effector_state":         eff,
            }

        with _state_lock:
            r = STATE.get("robot", {})
            s = STATE.get("safety", {})
            gate = {
                "connected":    bool(r.get("connected", False)),
                "allow_move":   bool(r.get("allow_move", False)),
                "monitor_only": bool(r.get("monitor_only", True)),
                "estop":        bool(s.get("estop", False)),
            }
        return {
            "ok":              True,
            "home_configured": bool(home_present),
            "home_source":     home_source,
            "trail":           trail_payload,
            "gate":            gate,
        }

    @app.post("/api/robot/home")
    async def api_robot_home():
        if not os.path.isfile(_HOME_FILE):
            return JSONResponse({
                "ok": False,
                "error": "No home pose configured. Store one at "
                         + _HOME_FILE + " ({\"taught_joints\": [...] in "
                         "degrees}).",
                "outcome": {"kind": "not_configured"},
            }, status_code=404)
        try:
            with open(_HOME_FILE) as f:
                home = json.load(f)
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"{_HOME_FILE} read failed: {e}",
                "outcome": {"kind": "home_read_failed"},
            }, status_code=500)
        tj = home.get("taught_joints") or []
        if not (isinstance(tj, list) and len(tj) == 6
                and all(isinstance(v, (int, float)) for v in tj)):
            return JSONResponse({
                "ok": False,
                "error": f"{_HOME_FILE} taught_joints missing or invalid "
                         "(need 6 numeric degrees).",
                "outcome": {"kind": "home_invalid"},
            }, status_code=400)

        with _state_lock:
            r = STATE.get("robot", {})
            op_frac      = float(r.get("operator_speed_limit", 0.25))
            allow_move   = bool(r.get("allow_move", False))
            monitor_only = bool(r.get("monitor_only", True))
            connected    = bool(r.get("connected", False))
        # Surface every gate on the response so the UI's toast tells
        # the operator what to fix, instead of a generic "no motion".
        if not connected:
            return JSONResponse({
                "ok": False,
                "error": "Driver not connected — home refused.",
                "outcome": {"kind": "gate_closed", "reason": "not_connected"},
                "gate": {"connected": False, "allow_move": allow_move,
                         "monitor_only": monitor_only},
            }, status_code=503)
        if monitor_only:
            return JSONResponse({
                "ok": False,
                "error": "monitor_only is active — driver refuses moves.",
                "outcome": {"kind": "gate_closed", "reason": "monitor_only"},
                "gate": {"connected": True, "allow_move": allow_move,
                         "monitor_only": True},
            }, status_code=403)
        if not allow_move:
            return JSONResponse({
                "ok": False,
                "error": "allow_move is false — driver refuses moves.",
                "outcome": {"kind": "gate_closed", "reason": "allow_move_off"},
                "gate": {"connected": True, "allow_move": False,
                         "monitor_only": False},
            }, status_code=403)

        operator_cap_pct = max(1, min(100, int(round(op_frac * 100))))
        # Home is intentionally slow — cap at 25% (or operator's cap,
        # whichever is lower). Not user-tunable from this endpoint;
        # rushing home is a known collision mode.
        home_speed_pct = min(operator_cap_pct, 25)

        program = {
            "id":     _HOME_PROG_ID,
            "name":   "Return Home",
            "config": {"speed_pct": home_speed_pct},
            "steps": [{
                "action":        "move_home",
                "label":         "Move to unified home",
                "taught":        True,
                "taught_joints": [float(v) for v in tj],
                "taught_tcp":    home.get("taught_tcp") or None,
                "position_role": "home",
                "step":          1,
            }],
        }
        try:
            from estun_driver import program_ops
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"program_ops import: {e}",
                "outcome": {"kind": "codegen_import_failed"},
            }, status_code=500)
        try:
            lua, points, eff_pct = program_ops.codegen_lua_from_program(
                program, operator_speed_limit_pct=operator_cap_pct)
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"codegen failed: {e}",
                "outcome": {"kind": "codegen_failed"},
            }, status_code=500)
        # Shared predicate (2026-08-03): use has_valid_motion so
        # this home-set gate and the run gate above agree on
        # "runnable" semantics — verb-agnostic, no fork.
        _home_has_motion, _home_motion_counts = program_ops.has_valid_motion(lua)
        if not _home_has_motion:
            return JSONResponse({
                "ok": False,
                "error": (f"codegen produced no runnable motion — "
                          f"{_HOME_FILE} taught_joints may be "
                          f"malformed (motion_counts="
                          f"{_home_motion_counts})."),
                "outcome": {"kind": "codegen_empty",
                            "motion_counts": _home_motion_counts},
            }, status_code=500)

        # Lint gate — same permanent check the program run endpoint uses.
        # Home is a 1-step move_home so findings would be surprising, but
        # if a future refactor drifts the emission we want the same hard
        # block here rather than silently pushing an invalid line.
        try:
            _home_lint = program_ops.lint_lua_source(lua)
        except Exception as _le:
            return JSONResponse({
                "ok": False,
                "error": f"lint failed to run: {type(_le).__name__}: {_le}",
                "outcome": {"kind": "lint_infrastructure_error"},
            }, status_code=500)
        if _home_lint:
            first = _home_lint[0]
            return JSONResponse({
                "ok": False,
                "error": (f"lint blocked home preset: {len(_home_lint)} "
                          f"finding(s); first at line {first.get('line')} "
                          f"verb {first.get('verb')!r}: {first.get('reason')}"),
                "outcome": {"kind": "lint_failed",
                            "findings": _home_lint},
            }, status_code=400)

        if _ros_node is None:
            return JSONResponse({
                "ok": False,
                "error": "ros not available",
                "outcome": {"kind": "ros_down"},
            }, status_code=503)

        # save → to_auto → set_auto_rate → set_breakpoint →
        # clear_start_line → run — the same sequence /api/estun/program/
        # run uses. Byte-verify is skipped (~4s of latency vs a one-
        # step program that codegen produces deterministically); the
        # driver's own save-event stream still surfaces failures via
        # STATE.robot.rejected.
        try:
            _ros_node._estun_publish_op(
                "save",
                program_id=_HOME_PROG_ID, task_id=_HOME_TASK_ID,
                name="Return Home", task_name="main",
                points=points, lua_source=lua)
            await asyncio.sleep(0.4)   # let the save complete
            _ros_node._estun_publish_op("to_auto")
            _ros_node._estun_publish_op(
                "set_auto_rate", pct=int(eff_pct), at_run_start=True)
            _ros_node._estun_publish_op(
                "set_breakpoint", task_id=_HOME_TASK_ID, lines=[])
            _ros_node._estun_publish_op("clear_start_line")
            _ros_node._estun_publish_op(
                "run", program_id=_HOME_PROG_ID, task_id=_HOME_TASK_ID)
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"publish sequence failed: {e}",
                "outcome": {"kind": "publish_failed"},
            }, status_code=500)

        return {
            "ok":            True,
            "outcome":       {"kind": "published"},
            "gate":          {"connected": True, "allow_move": True,
                              "monitor_only": False},
            "effective_pct": int(eff_pct),
            "home_source":   home.get("source"),
        }

    @app.post("/api/estun/program/stop")
    async def api_estun_program_stop():
        if _ros_node is None:
            return JSONResponse({"error": "ros not available"}, status_code=503)
        _ros_node._estun_publish_op("stop")
        return {"ok": True}

    @app.post("/api/estun/program/pause")
    async def api_estun_program_pause():
        # SOURCE-ONLY behavior — the UI keeps the pause button labelled
        # as such until pause/resume are wire-proven in a future ladder.
        if _ros_node is None:
            return JSONResponse({"error": "ros not available"}, status_code=503)
        _ros_node._estun_publish_op("pause")
        return {"ok": True, "source_only": True}

    @app.post("/api/estun/program/resume")
    async def api_estun_program_resume():
        """Ladder-verb resume — publishes op:resume to /estun/program.
        The driver's _op_resume then sends project/resume on the
        WS (SOURCE-ONLY, same posture as pause).

        Motivation (2026-08-04): the frontend's resumeProgram()
        was calling /api/estun/program/run — which does codegen +
        save + byte-verify + full run publish. That's re-run from
        step 1, NOT resume from the paused line. A pause at line
        47 in a 100-step program came back at line 1. This
        endpoint mirrors pause and gives the frontend a real
        ladder-verb call site."""
        if _ros_node is None:
            return JSONResponse({"error": "ros not available"}, status_code=503)
        _ros_node._estun_publish_op("resume")
        return {"ok": True, "source_only": True}

    @app.post("/api/estun/program/clear_error")
    async def api_estun_program_clear_error():
        if _ros_node is None:
            return JSONResponse({"error": "ros not available"}, status_code=503)
        _ros_node._estun_publish_op("clear_error")
        return {"ok": True}

    # Mid-run auto-mode speed change. The driver clamps against
    # operator_speed_limit (single-source policy cap in
    # config/estun.yaml) and rejects an INCREASE above
    # high_speed_confirm_threshold_pct without confirmed_high_speed=true.
    # This endpoint mirrors the driver's own contract so the UI can
    # decide up-front whether it needs to show the strong confirm.
    # Body: {pct:int 1..100, confirmed_high_speed?:bool}
    @app.post("/api/estun/program/speed")
    async def api_estun_program_speed(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        try:
            pct = int(body.get("pct"))
        except (TypeError, ValueError):
            return JSONResponse({"error": "pct required (integer 1..100)"},
                                status_code=400)
        pct = max(1, min(100, pct))
        confirmed = bool(body.get("confirmed_high_speed", False))
        with _state_lock:
            r = STATE.get("robot", {})
            op_frac = float(r.get("operator_speed_limit", 0.25))
            threshold_pct = int(r.get("high_speed_confirm_threshold_pct", 40))
        operator_cap_pct = max(1, min(100, int(round(op_frac * 100))))
        eff_pct = max(1, min(operator_cap_pct, pct))
        capped = pct > operator_cap_pct
        needs_confirm = (eff_pct > threshold_pct) and not confirmed
        if needs_confirm:
            return JSONResponse({
                "ok": False,
                "needs_confirm": True,
                "reason": (f"Mid-run speed {eff_pct}% exceeds high-speed "
                           f"threshold {threshold_pct}%. Re-submit with "
                           f"confirmed_high_speed:true."),
                "effective_pct":     eff_pct,
                "operator_cap_pct":  operator_cap_pct,
                "threshold_pct":     threshold_pct,
                "capped":            capped,
            }, status_code=409)
        if _ros_node is None:
            return JSONResponse({"error": "ros not available"}, status_code=503)
        _ros_node._estun_publish_op(
            "set_auto_rate", pct=int(eff_pct),
            confirmed_high_speed=bool(confirmed))
        return {
            "ok": True,
            "effective_pct":     eff_pct,
            "operator_cap_pct":  operator_cap_pct,
            "threshold_pct":     threshold_pct,
            "capped":            capped,
        }

    # ──────────────────────────────────────────────────────────────
    # Joint-log capture. Bounded high-rate sampler for targeted
    # investigation only. For NORMAL post-run analysis, prefer the
    # always-on flight recorder + /api/runs/{run_id}/excursions —
    # you don't need to pre-arm anything; every run's motion data
    # is already on disk. Use this endpoint when you need a higher
    # sample rate (up to 100 Hz) or a labeled ad-hoc window that
    # doesn't correspond to a program run (jog testing etc.).
    # Cap at 60 s so a runaway request can't fill disk during a
    # busy shift.
    # ──────────────────────────────────────────────────────────────
    _JOINT_LOG_DIR = '/tmp/joint_logs'

    @app.post("/api/estun/joint_log")
    async def api_estun_joint_log(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        try:
            duration_s = float(body.get('duration_s', 20.0))
        except (TypeError, ValueError):
            return JSONResponse({'error': 'duration_s must be a number'},
                                status_code=400)
        duration_s = max(1.0, min(60.0, duration_s))
        try:
            rate_hz = float(body.get('rate_hz', 50.0))
        except (TypeError, ValueError):
            rate_hz = 50.0
        rate_hz = max(5.0, min(100.0, rate_hz))
        label = str(body.get('label') or 'joint_log')
        # Filename-safe: keep letters/digits/dash/underscore only.
        label_safe = ''.join(c if c.isalnum() or c in '-_' else '_'
                             for c in label)[:40] or 'joint_log'
        try:
            os.makedirs(_JOINT_LOG_DIR, exist_ok=True)
        except Exception as e:
            return JSONResponse({'error': f'cannot create log dir: {e}'},
                                status_code=500)
        ts = time.strftime('%Y%m%dT%H%M%S')
        fname = f'{label_safe}_{ts}.jsonl'
        fpath = os.path.join(_JOINT_LOG_DIR, fname)

        # Fire-and-forget sampler task. Writes an OPEN meta line, then
        # one sample per period, then a CLOSE meta line so a partial
        # (server-killed) log is still trivially detectable.
        period = 1.0 / rate_hz
        async def _sampler():
            samples_written = 0
            t_start = time.time()
            try:
                with open(fpath, 'w', buffering=1) as f:
                    f.write(json.dumps({
                        'meta':        'open',
                        'ts':          t_start,
                        'duration_s':  duration_s,
                        'rate_hz':     rate_hz,
                        'label':       label_safe,
                        'note':        ('joints=degrees, program.line = '
                                        'controller ProjectState line; '
                                        'step_index = 0-based when '
                                        'inferable, else null'),
                    }) + '\n')
                    t_stop = t_start + duration_s
                    prev_line = None
                    step_index = -1
                    while True:
                        now = time.time()
                        if now >= t_stop:
                            break
                        with _state_lock:
                            joints = STATE.get('joints') or {}
                            positions = list(joints.get('positions') or [])
                            robot = STATE.get('robot') or {}
                            prog = robot.get('program') or {}
                            prog_line = prog.get('line')
                            prog_state = prog.get('state')
                            prog_is_step = prog.get('is_step')
                        # Radians → degrees for readability.
                        joints_deg = [
                            round((v * 180.0 / math.pi), 3)
                            for v in positions[:6]
                        ] if positions else []
                        # Coarse step index: bump on each program.line
                        # change. Not the true step id (that needs the
                        # program dict → line-to-step map) but keeps
                        # the log usable without that lookup.
                        if prog_line is not None and prog_line != prev_line:
                            step_index += 1
                            prev_line = prog_line
                        f.write(json.dumps({
                            't':             round(now - t_start, 3),
                            'joints_deg':    joints_deg,
                            'program_line':  prog_line,
                            'program_state': prog_state,
                            'is_step':       prog_is_step,
                            'step_index':    step_index if step_index >= 0 else None,
                        }) + '\n')
                        samples_written += 1
                        # Yield to the loop; drift-corrected next-tick.
                        next_t = t_start + samples_written * period
                        sleep_s = max(0.0, next_t - time.time())
                        if sleep_s > 0:
                            await asyncio.sleep(sleep_s)
                        else:
                            await asyncio.sleep(0)
                    f.write(json.dumps({
                        'meta':      'close',
                        'ts':        time.time(),
                        'samples':   samples_written,
                        'duration_actual_s': round(time.time() - t_start, 3),
                    }) + '\n')
            except Exception as e:
                print(f'[joint_log] sampler failed: {type(e).__name__}: {e}',
                      flush=True)

        asyncio.create_task(_sampler())
        return {
            'ok': True,
            'path': fpath,
            'duration_s': duration_s,
            'rate_hz': rate_hz,
            'label': label_safe,
            'note': ('Sampling started. Poll file mtime or wait '
                     '`duration_s` seconds, then run '
                     'scripts/joint_log_excursions.py <path>.'),
        }

    @app.get("/api/estun/joint_log/list")
    async def api_estun_joint_log_list():
        try:
            entries = []
            if os.path.isdir(_JOINT_LOG_DIR):
                for fn in sorted(os.listdir(_JOINT_LOG_DIR), reverse=True):
                    if not fn.endswith('.jsonl'):
                        continue
                    p = os.path.join(_JOINT_LOG_DIR, fn)
                    try:
                        st = os.stat(p)
                        entries.append({
                            'name': fn, 'path': p,
                            'size': st.st_size, 'mtime': st.st_mtime,
                        })
                    except Exception:
                        continue
            return {'ok': True, 'logs': entries}
        except Exception as e:
            return JSONResponse({'ok': False, 'error': str(e)},
                                status_code=500)

    # ──────────────────────────────────────────────────────────────
    # cam0 → base_link EXTRINSIC CALIBRATION.
    #
    # Touch-point correspondence using a printed AprilTag as the
    # camera-side ground truth. Workflow (see cam0_calibration.py
    # for the math + persistence contract):
    #
    #   1. Operator places the tag anywhere in cam0's view.
    #   2. Jog the TCP down until the cup touches the tag centre.
    #   3. POST /api/calib/cam0/capture — records the pair.
    #   4. Move the tag, jog again, capture again. 4-6 spread.
    #   5. POST /api/calib/cam0/solve — Umeyama fit + RMS.
    #   6. RMS < 3 mm → POST /api/calib/cam0/save persists the
    #      transform to /opt/cobot/calibration/cam0_extrinsic.yaml
    #      AND publishes a fresh static TF (cam0_color_optical_frame
    #      → base_link) so consumers see it without restarting
    #      tf_broadcaster.
    # ──────────────────────────────────────────────────────────────
    try:
        from . import cam0_calibration as _cam0_calib_mod
    except ImportError:
        import cam0_calibration as _cam0_calib_mod   # type: ignore

    _calib_session = _cam0_calib_mod.CalibrationSession()
    _calib_lock = threading.Lock()

    # Import guard: the AprilTag detector may not be installed on
    # every dev image. Endpoints return a helpful 503 explaining the
    # missing package rather than blowing up on import at request
    # time. The rest of the dashboard stays up.
    try:
        from dt_apriltags import Detector as _ATDetector
        _at_detector = _ATDetector(
            families='tag36h11', nthreads=2,
            quad_decimate=1.0, refine_edges=True)
    except Exception as _e:
        _at_detector = None
        _at_import_err = str(_e)
    else:
        _at_import_err = None

    def _current_tcp_base_m():
        """Snapshot the arm's TCP position in base_link frame (metres).
        Returns None when the driver hasn't published yet. Uses
        STATE['tcp_pose'] which the /estun/status handler keeps
        current — that field is documented as meters (see the
        _on_estun_status handler)."""
        with _state_lock:
            tcp = STATE.get('tcp_pose')
        if not (isinstance(tcp, list) and len(tcp) >= 3):
            return None
        try:
            return [float(tcp[0]), float(tcp[1]), float(tcp[2])]
        except (TypeError, ValueError):
            return None

    def _detect_apriltag_center():
        """Detect the largest tag36h11 in the current cam0 raw frame,
        return (cam_frame_translation_m, corners_px, tag_id). None
        if no tag, no frame, or detector unavailable."""
        if _at_detector is None:
            return None
        with _cam0_raw_lock:
            rgb   = _cam0_raw.get('rgb')
            intr  = dict(_cam0_intr)
            w, h  = _cam0_raw.get('width'), _cam0_raw.get('height')
            ts    = _cam0_raw.get('ts')
        if rgb is None or intr.get('fx') is None:
            return None
        # dt_apriltags wants uint8 grayscale.
        if _np is None:
            return None
        rgb_arr = _np.asarray(rgb, dtype=_np.uint8)
        gray = (0.299 * rgb_arr[:, :, 0]
                + 0.587 * rgb_arr[:, :, 1]
                + 0.114 * rgb_arr[:, :, 2]).astype(_np.uint8)
        # Assume the operator's printed sheet is 100 mm edge — matches
        # the existing calibrate_extrinsics.py default. Bad tag_size
        # scales the translation linearly; if the operator prints at
        # a different size the YAML metadata records what was assumed.
        dets = _at_detector.detect(
            gray, estimate_tag_pose=True,
            camera_params=(intr['fx'], intr['fy'], intr['cx'], intr['cy']),
            tag_size=float(os.environ.get('CALIB_TAG_SIZE_M', '0.10')))
        if not dets:
            return None
        # Prefer the largest tag (by corner-bbox area) if the operator
        # somehow has multiple in view; single-tag flow is the norm.
        def _area(d):
            c = _np.asarray(d.corners)
            return (c[:, 0].max() - c[:, 0].min()) * (c[:, 1].max() - c[:, 1].min())
        d = max(dets, key=_area)
        cam_t = _np.asarray(d.pose_t, dtype=_np.float64).reshape(3).tolist()
        corners = _np.asarray(d.corners, dtype=_np.float64).tolist()
        return {
            'cam_t':    cam_t,
            'corners':  corners,
            'tag_id':   int(d.tag_id),
            'frame_ts': ts,
        }

    @app.get("/api/calib/cam0/status")
    async def api_calib_cam0_status():
        with _calib_lock:
            sess = _calib_session.to_dict()
        # Also surface some liveness for the UI.
        with _cam0_raw_lock:
            have_frame = _cam0_raw.get('rgb') is not None
            have_intr  = _cam0_intr.get('fx') is not None
            frame_age  = round(time.time() - _cam0_raw.get('ts', 0.0), 2) \
                         if _cam0_raw.get('ts') else None
        saved = _cam0_calib_mod.load()
        return {
            'ok':           True,
            'session':      sess,
            'have_frame':   bool(have_frame),
            'have_intr':    bool(have_intr),
            'frame_age_s':  frame_age,
            'detector_ok':  _at_detector is not None,
            'detector_err': _at_import_err,
            'accept_rms_mm': _cam0_calib_mod.RMS_ACCEPT_MM,
            'min_points':    _cam0_calib_mod.MIN_POINTS,
            'persisted':     saved,
        }

    @app.post("/api/calib/cam0/start")
    async def api_calib_cam0_start():
        with _calib_lock:
            _calib_session.clear()
        return {'ok': True, 'session': _calib_session.to_dict()}

    @app.get("/api/calib/cam0/tag_preview")
    async def api_calib_cam0_tag_preview():
        """UI-facing tag detection state — no capture side-effect.
        Called in a slow poll (~2 Hz) so the operator sees whether
        the tag is currently detected before pressing Capture."""
        det = _detect_apriltag_center()
        if det is None:
            return {'ok': True, 'detected': False}
        return {'ok': True, 'detected': True, **det}

    @app.post("/api/calib/cam0/capture")
    async def api_calib_cam0_capture(request: Request):
        if _at_detector is None:
            return JSONResponse({
                'ok': False,
                'error': 'AprilTag detector unavailable — dt_apriltags '
                         'not installed. pip3 install dt-apriltags on '
                         'the dashboard host.'},
                status_code=503)
        try:
            body = await request.json()
        except Exception:
            body = {}
        label = str(body.get('label') or '')
        det = _detect_apriltag_center()
        if det is None:
            return JSONResponse({
                'ok': False,
                'error': 'no AprilTag detected in cam0. Ensure the '
                         'tag is fully in view and well-lit.'},
                status_code=400)
        tcp = _current_tcp_base_m()
        if tcp is None:
            return JSONResponse({
                'ok': False,
                'error': 'no TCP pose from the arm. Enable the driver '
                         'and confirm /estun/status is publishing.'},
                status_code=503)
        with _calib_lock:
            p = _calib_session.add_point(
                tcp_base=tcp, cam_pt=det['cam_t'],
                label=label or time.strftime('%H:%M:%S'))
        return {'ok': True,
                'point': _cam0_calib_mod.asdict(p),
                'tag': {'id': det['tag_id'], 'corners': det['corners']},
                'session_count': len(_calib_session.points)}

    @app.get("/api/calib/cam0/points")
    async def api_calib_cam0_points():
        with _calib_lock:
            return {'ok': True, 'session': _calib_session.to_dict()}

    @app.delete("/api/calib/cam0/point/{idx}")
    async def api_calib_cam0_point_delete(idx: int):
        with _calib_lock:
            ok = _calib_session.remove_point(int(idx))
        if not ok:
            return JSONResponse({'ok': False, 'error': 'point not found'},
                                status_code=404)
        return {'ok': True, 'session': _calib_session.to_dict()}

    @app.post("/api/calib/cam0/solve")
    async def api_calib_cam0_solve():
        with _calib_lock:
            try:
                res = _cam0_calib_mod.solve(_calib_session)
            except ValueError as e:
                return JSONResponse({'ok': False, 'error': str(e)},
                                    status_code=400)
            sess = _calib_session.to_dict()
        return {'ok': True,
                'result':        _cam0_calib_mod.asdict(res),
                'session':       sess,
                'meets_accept':  res.rms_mm < _cam0_calib_mod.RMS_ACCEPT_MM,
                'accept_rms_mm': _cam0_calib_mod.RMS_ACCEPT_MM}

    @app.post("/api/calib/cam0/save")
    async def api_calib_cam0_save():
        with _calib_lock:
            try:
                path = _cam0_calib_mod.save(_calib_session)
            except ValueError as e:
                return JSONResponse({'ok': False, 'error': str(e)},
                                    status_code=400)
        # Publish the fresh TF now so downstream consumers pick it up
        # without needing to restart tf_broadcaster (the historical
        # startup-only reader). Non-fatal on failure — the file is
        # already saved and the next tf_broadcaster start will use it.
        try:
            if _ros_node is not None:
                _ros_node._broadcast_cam0_extrinsic()
        except Exception as e:
            print(f'[calib] TF broadcast failed after save: {e}', flush=True)
        return {'ok': True, 'path': path,
                'session': _calib_session.to_dict()}

    # ──────────────────────────────────────────────────────────────
    # Always-on joint recorder — /api/runs endpoints.
    #
    # Every program execution the dashboard sees on /joint_states +
    # ProjectState transitions gets its own run manifest under
    # /opt/cobot/joint_history/manifests/. GET /api/runs lists them
    # newest-first. /api/runs/{id}/joints stitches the sample
    # segments back together for download; /api/runs/{id}/excursions
    # runs the same analysis the one-shot CLI uses, over the run's
    # samples. No pre-arming — investigate any past run after the
    # fact.
    # ──────────────────────────────────────────────────────────────
    @app.get("/api/runs")
    async def api_runs_list():
        try:
            manifests = _joint_recorder_mod._list_manifests_sorted()
        except Exception as e:
            return JSONResponse({'ok': False, 'error': str(e)},
                                status_code=500)
        rec_stats = None
        if _joint_recorder is not None:
            try:
                rec_stats = _joint_recorder.stats()
            except Exception:
                rec_stats = None
        return {'ok': True,
                'runs':      manifests,
                'recorder':  rec_stats}

    def _run_segment_paths(run_id):
        """Resolve a run's manifest → list of absolute paths on disk.
        Filters entries whose file has been pruned (retention may
        have swept an old run's early segments while its manifest
        still records them). Returns (manifest, [paths])."""
        m = _joint_recorder_mod._load_manifest(run_id)
        if m is None:
            return None, None
        seg_dir = _joint_recorder_mod._segment_dir()
        paths = []
        for name in (m.get('segments') or []):
            p = os.path.join(seg_dir, name)
            if os.path.isfile(p):
                paths.append(p)
        return m, paths

    @app.get("/api/runs/{run_id}/joints")
    async def api_run_joints(run_id: str, format: str = 'json'):
        """Return the raw samples from a run. `format=jsonl` streams
        a decompressed .jsonl download; `format=json` (default)
        returns a JSON object with meta + samples for the UI."""
        # Path validation: run_ids come from _start_run's slugifier
        # so they're already [a-zA-Z0-9_-]. Belt-and-braces here.
        import re as _re
        if not _re.match(r'^[A-Za-z0-9_.\-]+$', run_id or ''):
            return JSONResponse({'ok': False, 'error': 'bad run_id'},
                                status_code=400)
        m, paths = _run_segment_paths(run_id)
        if m is None:
            return JSONResponse({'ok': False, 'error': 'run not found'},
                                status_code=404)
        samples = _joint_excursions_mod.load_samples_from_gzip_segments(paths)
        # Trim to the run's actual time window — segments may include
        # samples from adjacent idle time.
        t0 = m.get('t_start') or 0.0
        t1 = m.get('t_end')
        if t1 is not None:
            samples = [s for s in samples
                       if s.get('t') is not None
                       and t0 - 0.5 <= s['t'] <= t1 + 0.5]
        # Convert absolute timestamps to run-relative for readability
        # + JSONL output. Keep absolute in a companion field so joint-
        # log_excursions.py stays a drop-in analyzer.
        for s in samples:
            if s.get('t') is not None:
                s['t_run'] = round(s['t'] - t0, 3)
        if format == 'jsonl':
            body = ''.join(json.dumps(s) + '\n' for s in samples)
            return PlainTextResponse(
                body,
                media_type='application/jsonl',
                headers={'Content-Disposition':
                         f'attachment; filename="{run_id}.jsonl"'})
        return {'ok': True,
                'run':     m,
                'samples': samples,
                'count':   len(samples)}

    @app.get("/api/runs/{run_id}/excursions")
    async def api_run_excursions(run_id: str,
                                 threshold_deg: float = 10.0):
        """Per-step per-joint excursion table for a completed run.
        Uses the same analyzer the one-shot CLI does so the numbers
        agree byte-for-byte with a parallel /api/estun/joint_log
        capture over the same window."""
        import re as _re
        if not _re.match(r'^[A-Za-z0-9_.\-]+$', run_id or ''):
            return JSONResponse({'ok': False, 'error': 'bad run_id'},
                                status_code=400)
        m, paths = _run_segment_paths(run_id)
        if m is None:
            return JSONResponse({'ok': False, 'error': 'run not found'},
                                status_code=404)
        samples = _joint_excursions_mod.load_samples_from_gzip_segments(paths)
        t0 = m.get('t_start') or 0.0
        t1 = m.get('t_end')
        if t1 is not None:
            samples = [s for s in samples
                       if s.get('t') is not None
                       and t0 - 0.5 <= s['t'] <= t1 + 0.5]
        # infer step_index from consecutive program_line changes so
        # the analyzer's step-grouping works even if the manifest's
        # segments don't carry step-index metadata (the on-disk
        # sample schema is program_line only — step_index is a
        # derived label the excursion table uses).
        prev_line = None
        step_idx = -1
        for s in samples:
            ln = s.get('program_line')
            if ln is not None and ln != prev_line:
                step_idx += 1
                prev_line = ln
            s['step_index'] = step_idx if step_idx >= 0 else None
        analysis = _joint_excursions_mod.analyze(
            samples, threshold_deg=float(threshold_deg))
        # Per-step TCP path deviations. Runs FK over each step's samples
        # and folds max line-deviation (mm) and max orientation-
        # deviation (deg) into the matching row so the summary table can
        # flag a step for PATH wander even when the joint swing is tame.
        try:
            _attach_tcp_deviations(samples, analysis)
        except Exception as e:                                     # noqa: BLE001
            analysis['tcp_dev_error'] = str(e)
        return {'ok': True, 'run': m, 'analysis': analysis}

    def _attach_tcp_deviations(samples, analysis):
        """Mutate analysis['rows'] to add tcp_line_dev_max_mm and
        tcp_orient_dev_max_deg per step (best-effort; missing URDF or a
        one-sample step leaves the field null)."""
        import numpy as np
        if not _trajectory_fk_mod.urdf_available():
            return
        rows = analysis.get('rows') or []
        if not rows:
            return
        # Group samples by the same key the analyzer used.
        key = analysis.get('grouped_by') or 'step_index'
        buckets = {}
        for s in samples:
            k = s.get(key)
            if k is None:
                k = '(no-line)'
            buckets.setdefault(k, []).append(s)
        chain = _trajectory_fk_mod.get_chain()
        for row in rows:
            grp = buckets.get(row.get('step_key')) or []
            q = np.asarray(
                [g.get('joints_deg') for g in grp if len(g.get('joints_deg') or []) == 6],
                dtype=float)
            if q.shape[0] < 2:
                row['tcp_line_dev_max_mm']    = None
                row['tcp_orient_dev_max_deg'] = None
                continue
            p, rpy = chain.fk_batch(np.deg2rad(q))
            _, ld_max, _ = _trajectory_fk_mod.line_deviation(p)
            _, od_max, _ = _trajectory_fk_mod.orientation_deviation(rpy)
            row['tcp_line_dev_max_mm']    = round(ld_max * 1000.0, 2)
            row['tcp_orient_dev_max_deg'] = round(od_max, 2)

    @app.get("/api/runs/{run_id}/trajectory")
    async def api_run_trajectory(run_id: str, step: str | None = None):
        """Per-step joint timeseries + FK'd TCP path for a completed run.

        `step` (optional) filters to a single step_index; without it the
        response includes the full timeseries and a `steps` catalog the
        UI uses to populate a step selector."""
        import numpy as np
        import re as _re
        if not _re.match(r'^[A-Za-z0-9_.\-]+$', run_id or ''):
            return JSONResponse({'ok': False, 'error': 'bad run_id'},
                                status_code=400)
        m, paths = _run_segment_paths(run_id)
        if m is None:
            return JSONResponse({'ok': False, 'error': 'run not found'},
                                status_code=404)
        samples = _joint_excursions_mod.load_samples_from_gzip_segments(paths)
        t0 = m.get('t_start') or 0.0
        t1 = m.get('t_end')
        if t1 is not None:
            samples = [s for s in samples
                       if s.get('t') is not None
                       and t0 - 0.5 <= s['t'] <= t1 + 0.5]
        # Derive step_index the same way the excursions endpoint does.
        prev_line = None
        step_idx = -1
        for s in samples:
            ln = s.get('program_line')
            if ln is not None and ln != prev_line:
                step_idx += 1
                prev_line = ln
            s['step_index'] = step_idx if step_idx >= 0 else None
            if s.get('t') is not None:
                s['t_run'] = round(s['t'] - t0, 3)
        # Catalog every step (index + program_line + sample count).
        steps_catalog = []
        seen = {}
        for s in samples:
            k = s.get('step_index')
            if k is None:
                continue
            if k not in seen:
                seen[k] = {
                    'step_index':   k,
                    'program_line': s.get('program_line'),
                    'samples':      0,
                    't_start':      s.get('t_run'),
                    't_end':        s.get('t_run'),
                }
                steps_catalog.append(seen[k])
            e = seen[k]
            e['samples']  += 1
            e['t_end']     = s.get('t_run')
        if not _trajectory_fk_mod.urdf_available():
            return JSONResponse({
                'ok': False,
                'error': f'URDF not available at {_trajectory_fk_mod.DEFAULT_URDF}',
            }, status_code=503)
        # Filter to the requested step, or use everything.
        step_index = None
        if step is not None and step != '':
            try:
                step_index = int(step)
            except ValueError:
                return JSONResponse({'ok': False, 'error': 'bad step'},
                                    status_code=400)
            filt = [s for s in samples if s.get('step_index') == step_index]
        else:
            filt = list(samples)
        filt = [s for s in filt if len(s.get('joints_deg') or []) == 6]
        if not filt:
            return {'ok': True,
                    'run':   m,
                    'step':  step_index,
                    'steps': steps_catalog,
                    'samples': 0,
                    'joints':  {'t': [], 'q_deg': []},
                    'tcp':     {'t': [], 'xyz': [], 'rpy_deg': []},
                    'line_deviation':        None,
                    'orientation_deviation': None}
        q_deg = np.asarray([s['joints_deg'] for s in filt], dtype=float)
        t_run = np.asarray([s.get('t_run', 0.0) for s in filt], dtype=float)
        chain = _trajectory_fk_mod.get_chain()
        xyz, rpy = chain.fk_batch(np.deg2rad(q_deg))
        _, ld_max, ld_rms = _trajectory_fk_mod.line_deviation(xyz)
        _, od_max, od_rms = _trajectory_fk_mod.orientation_deviation(rpy)
        # Downsample the timeseries for wire economy (25 Hz over a full
        # run can be a few thousand samples). Keep the deviation
        # statistics computed on the full-rate signal.
        MAX_POINTS = 800
        if q_deg.shape[0] > MAX_POINTS:
            stride = int(np.ceil(q_deg.shape[0] / MAX_POINTS))
            sel = np.arange(0, q_deg.shape[0], stride)
        else:
            sel = np.arange(q_deg.shape[0])
        return {
            'ok':    True,
            'run':   m,
            'step':  step_index,
            'steps': steps_catalog,
            'samples': int(q_deg.shape[0]),
            'joints': {
                't':     [round(float(x), 3) for x in t_run[sel]],
                'q_deg': [[round(float(v), 3) for v in q_deg[i]] for i in sel],
            },
            'tcp': {
                't':       [round(float(x), 3) for x in t_run[sel]],
                'xyz':     [[round(float(v), 5) for v in xyz[i]] for i in sel],
                'rpy_deg': [[round(float(v), 3) for v in np.degrees(rpy[i])] for i in sel],
            },
            'line_deviation': {
                'max_mm': round(ld_max * 1000.0, 3),
                'rms_mm': round(ld_rms * 1000.0, 3),
            },
            'orientation_deviation': {
                'max_deg': round(od_max, 3),
                'rms_deg': round(od_rms, 3),
            },
            'urdf': _trajectory_fk_mod.DEFAULT_URDF,
        }

    @app.post("/api/program/run")
    async def api_program_run(request: Request):
        """Dispatch run/pause/resume/stop/home to the program executor.
        Body: {action, program_id?}. Without program_id, the executor
        resumes / re-runs whatever it currently has loaded.

        action='load' is RETIRED (2026-08-04). It was a frontend-facing
        'set active program' verb the executor silently ignored — it
        never reached the controller, and became the fork that let a
        load appear to succeed while the resident program was
        something else entirely. Program-selection state may now only
        be written by /api/estun/program/run (with push_only:true for
        a load, or without for a full run). Requests with
        action='load' get 410 Gone with a pointer at the replacement.
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        action = str(body.get('action', 'run'))
        prog_id = body.get('program_id')
        if action == 'load':
            return JSONResponse({
                'ok': False,
                'error': ("action='load' on /api/program/run is retired. "
                          "Use POST /api/estun/program/run with "
                          "push_only:true instead — that path actually "
                          "pushes the program to the controller so the "
                          "resident becomes current."),
                'outcome': {'kind': 'load_verb_retired',
                            'replacement':
                                '/api/estun/program/run push_only=true'},
            }, status_code=410)
        if action not in ('run', 'pause', 'resume', 'stop', 'home'):
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

    @app.get("/api/programs/revs")
    async def api_programs_revs():
        """Return {program_id: rev} for every known program — cheap
        endpoint clients hit on WS (re)connect + visibilitychange
        resume to detect any program whose held rev is behind
        server-truth. Complements the /ws/state broadcast's
        program_revs field for reconciles that can't wait for the
        next state tick.

        Any program known on disk but not yet in _prog_revs is
        seeded from its file rev here so a fresh restart doesn't
        report None for programs that haven't been touched yet
        this process."""
        _seed_prog_revs_from_disk()          # idempotent
        return {"revs": _snapshot_prog_revs()}

    # ── /api/jog_stop_log (2026-07-31 jog-stop instrumentation) ──
    # Client-side jog-stop cause ring. Every tab's HoldButton pushes
    # here via fire-and-forget POST when a jog stops. Bench-script
    # GETs the aggregate to compute the cause distribution across
    # devices without having to inspect each browser's devtools.
    #
    # Ring capped at 1024 entries. Non-persistent (dies with the
    # dashboard process). Small, cheap, and DELETE clears it for a
    # fresh bench-test window.
    _jog_stop_log_ring: list = []
    _JOG_STOP_LOG_MAX = 1024

    # ── /api/deploy_status (2026-07-31 auto-deploy directive) ─────
    # Reads /opt/cobot/deploy_log.jsonl and returns a compact view:
    # the latest entry + whether it's still "waiting" or "building",
    # plus the previous "ok" for age computation.
    #
    # The footer banner reads this to render one of:
    #   green    "current (hash, age)"
    # ── Unified event log (2026-08-05, fork registry: event_log) ──
    # Every error/warning/info the platform surfaces lands as one
    # JSONL line in /opt/cobot/event_log/events_YYYYMMDD.jsonl.
    # These endpoints expose the log to the operator:
    #   POST /api/event_log/append   → frontend toast capture
    #   GET  /api/event_log/list     → list available dates
    #   GET  /api/event_log/day/{d}  → JSON array (interface page)
    #   GET  /api/event_log/download/{d}.jsonl  → raw JSONL
    #   GET  /api/event_log/download/{d}.csv    → human CSV
    #   GET  /api/event_log/download/last7.zip  → 7-day bundle
    #
    # Dismissing a toast NEVER deletes the record — the JSONL is
    # append-only; the interface page reads it as-is.

    # ── Per-device UI context (refresh persistence, 2026-08-05) ──
    #   GET  /api/ui_context/{device_id}  → {ok, context}
    #   POST /api/ui_context/{device_id}  body: {open_program_id?, active_tab?}
    #                                       → {ok, context}
    # Fork registry: page_context_persistence. No client-side
    # localStorage for these fields — the Jetson is the source of
    # truth for which program is open on each device.
    @app.get("/api/ui_context/{device_id}")
    async def api_ui_context_get(device_id: str):
        ctx = _ui_context.get(device_id) or {}
        return {'ok': True, 'context': ctx}

    @app.post("/api/ui_context/{device_id}")
    async def api_ui_context_set(device_id: str, request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        result = _ui_context.set(device_id, body if isinstance(body, dict) else {})
        if result is None:
            return JSONResponse({'ok': False,
                                 'error': 'bad_device_id_or_payload'},
                                status_code=400)
        return {'ok': True, 'context': result}

    # ── Disk status (footer widget + operator diagnostics) ─────
    # 2026-08-05: single source of truth for "how much space is
    # free" + "how much each capped dir is using". Fork registry:
    # disk_watchdog.
    @app.get("/api/disk_status")
    async def api_disk_status():
        return _disk_watchdog.status()

    @app.post("/api/event_log/append")
    async def api_event_log_append(request: Request):
        """Append a frontend-originated event to the daily JSONL.
        Body: {severity, source, code, operator_message,
               technical_detail, context}. All fields optional
        except severity + code + operator_message.
        Non-frontend sources (driver, watcher, validator) route
        through _event_log.emit directly inside the dashboard
        process — this endpoint is the browser's on-ramp."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        rec = _event_log.emit(
            severity=str(body.get('severity') or 'info'),
            source=str(body.get('source') or 'dashboard'),
            code=str(body.get('code') or ''),
            operator_message=str(body.get('operator_message') or ''),
            technical_detail=str(body.get('technical_detail') or ''),
            context=body.get('context') if isinstance(body.get('context'), dict) else {},
        )
        return {'ok': bool(rec), 'record': rec}

    @app.get("/api/event_log/list")
    async def api_event_log_list():
        """Return the list of dates available on disk, newest first.
        Used by the interface page's date picker."""
        return {'days': _event_log.list_days()}

    @app.get("/api/event_log/day/{date_str}")
    async def api_event_log_day(date_str: str, limit: int = 2000):
        """Return one day's records as a JSON array (oldest first).
        `limit` caps the tail — default 2000, cap 10000 — enough
        for a busy shift day without exhausting the browser."""
        if not (date_str.isdigit() and len(date_str) == 8):
            return JSONResponse({'error': 'date must be YYYYMMDD'},
                                status_code=400)
        limit = max(1, min(int(limit), 10000))
        return {'date': date_str,
                'records': _event_log.read_day(date_str, limit=limit)}

    @app.get("/api/event_log/download/{filename}")
    async def api_event_log_download(filename: str):
        """Downloads: `<YYYYMMDD>.jsonl`, `<YYYYMMDD>.csv`, or
        `last7.zip`. Anything else → 404."""
        if filename == 'last7.zip':
            import io as _io
            import zipfile as _zf
            days = _event_log.list_days()[:7]
            buf = _io.BytesIO()
            with _zf.ZipFile(buf, 'w', compression=_zf.ZIP_DEFLATED) as zf:
                for d in days:
                    path = _event_log.path_for_date(d)
                    try:
                        with open(path, 'rb') as fh:
                            zf.writestr(f'events_{d}.jsonl', fh.read())
                    except FileNotFoundError:
                        continue
            buf.seek(0)
            filename_out = f'cobot_events_last7_{time.strftime("%Y%m%d")}.zip'
            return StreamingResponse(
                buf, media_type='application/zip',
                headers={'Content-Disposition':
                         f'attachment; filename="{filename_out}"'})
        # <YYYYMMDD>.jsonl | .csv
        if not (len(filename) >= 13 and filename[:8].isdigit()
                and filename[8] == '.'):
            return JSONResponse({'error': 'bad filename'}, status_code=404)
        date_str = filename[:8]
        ext      = filename[9:]
        path = _event_log.path_for_date(date_str)
        if not os.path.exists(path):
            return JSONResponse({'error': f'no log for {date_str}'},
                                status_code=404)
        if ext == 'jsonl':
            return FileResponse(
                path, media_type='application/x-ndjson',
                filename=f'events_{date_str}.jsonl')
        if ext == 'csv':
            # Render CSV in-memory from the JSONL. Column order
            # matches the operator's forensic priority: time first,
            # severity, source, code, message. technical + context
            # last (widest). Values are CSV-escaped by the csv
            # module — no manual quoting.
            import csv as _csv
            import io as _io
            recs = _event_log.read_day(date_str)
            buf = _io.StringIO()
            w = _csv.writer(buf)
            w.writerow(['ts_utc', 'ts_local', 'severity', 'source',
                        'code', 'operator_message',
                        'technical_detail', 'context_json'])
            for r in recs:
                w.writerow([
                    r.get('ts_utc', ''), r.get('ts_local', ''),
                    r.get('severity', ''), r.get('source', ''),
                    r.get('code', ''), r.get('operator_message', ''),
                    r.get('technical_detail', ''),
                    json.dumps(r.get('context') or {},
                               ensure_ascii=False),
                ])
            return StreamingResponse(
                iter([buf.getvalue()]),
                media_type='text/csv',
                headers={'Content-Disposition':
                         f'attachment; filename="events_{date_str}.csv"'})
        return JSONResponse({'error': 'unsupported extension'},
                            status_code=404)

    #   spinning "deploying…"
    #   amber    "deploy waiting for idle"
    #   red      "DEPLOY FAILED: <step>"
    @app.get("/api/deploy_status")
    async def api_deploy_status():
        path = "/opt/cobot/deploy_log.jsonl"
        try:
            with open(path) as f:
                # Tail the last ~64 entries (deploy log grows slowly;
                # keep the read cheap without loading the whole file).
                lines = f.readlines()[-64:]
        except FileNotFoundError:
            return {"state": "unknown", "detail": "no deploy_log.jsonl yet"}
        except Exception as e:
            return {"state": "unknown", "detail": f"read failed: {e}"}
        entries = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        if not entries:
            return {"state": "unknown", "detail": "empty log"}
        # Determine the *current* state:
        #   * if the latest entry is `ok` OR the process is dormant
        #     (no `start`/`waiting`/`building` more recent than the
        #     last `ok`/`fail`) → state = 'current' with the ok hash
        #   * if latest is `fail` → state = 'failed'
        #   * if latest is `waiting` → state = 'waiting'
        #   * if latest is `building` OR `start` → state = 'deploying'
        latest = entries[-1]
        phase = latest.get("phase")
        # 2026-08-06 (silent-frontend-rebuild-skip class, refined
        # per operator directive to a WARNING rather than FAILED):
        # phase=frontend_stale maps to a new state='stale' which the
        # DeployStatusBanner renders as an amber warning. Build
        # succeeded and the disk is healthy — the served asset just
        # didn't advance for a commit that touched frontend/src.
        # Distinct from state='failed' (deploy actually broke).
        state = {
            "ok":              "current",
            "fail":            "failed",
            "frontend_stale":  "stale",
            "waiting":         "waiting",
            "building":        "deploying",
            "start":           "deploying",
        }.get(phase, "unknown")
        # Find the most recent successful deploy for the "current
        # served" hash + age. Even when phase='waiting' or 'failed'
        # the served bundle still corresponds to the LAST ok entry.
        last_ok = None
        for e in reversed(entries):
            if e.get("phase") == "ok":
                last_ok = e
                break
        return {
            "state":  state,
            "latest": latest,
            "last_ok": last_ok,
            # Small history slice for the debug panel if the operator
            # wants to inspect the trail (kept small so this endpoint
            # stays cheap).
            "history_tail": entries[-8:],
        }

    @app.post("/api/jog_stop_log")
    async def api_jog_stop_log_push(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        entry = {
            "srv_ts": time.time(),
            "cause":  str(body.get("cause") or "unknown"),
            "client_ts": body.get("ts"),
            "extras": {k: v for k, v in body.items()
                       if k not in ("ts", "cause")},
        }
        _jog_stop_log_ring.append(entry)
        if len(_jog_stop_log_ring) > _JOG_STOP_LOG_MAX:
            del _jog_stop_log_ring[:len(_jog_stop_log_ring) - _JOG_STOP_LOG_MAX]
        return {"ok": True}

    @app.get("/api/jog_stop_log")
    async def api_jog_stop_log_get():
        return {"stops": list(_jog_stop_log_ring)}

    @app.delete("/api/jog_stop_log")
    async def api_jog_stop_log_clear():
        _jog_stop_log_ring.clear()
        return {"ok": True, "cleared": True}

    @app.get("/api/build_id")
    async def api_build_id():
        """Return the currently-served frontend bundle's asset hash.
        Client compares to its build-time __BUILD_ID__ and shows a
        "new version — refresh" toast on mismatch.

        Reads mock_server/static/index.html (the canonical served-
        bundle location — same directory the deploy script checks)
        for the /assets/index-<hash>.js link. Falls back to
        'unknown' when the file isn't present."""
        try:
            index = str(_STATIC_DIR / "index.html")
            if not os.path.isfile(index):
                return {"bundle_id": "unknown"}
            with open(index) as f:
                src = f.read()
            import re as _rx
            m = _rx.search(r"/assets/index-([A-Za-z0-9_-]+)\.js", src)
            return {"bundle_id": (m.group(1) if m else "unknown")}
        except Exception:
            return {"bundle_id": "unknown"}

    @app.get("/api/programs")
    async def api_programs_list():
        """List user-created robot programs from /opt/cobot/programs/.
        No built-in templates — every entry corresponds to a file on
        disk and is fully editable / deletable.

        Reconcile pass (2026-07-27): only emit entries whose id can
        be reached by the read/update/delete routes. A file whose
        stem fails _PROG_READ_ID_RE would be a listed-but-unreachable
        ghost — the operator would click Delete and get 404 forever
        (that WAS the bug that motivated this pass on the underscore
        case; the read-path regex was tightened here at the same
        time so the delete route can now reach `new_program`, but
        the reconcile stays as a belt for future oddballs — dotfiles,
        weirdly-cased names, whatever).
        """
        programs = []
        skipped_unreachable = 0
        try:
            os.makedirs(_PROG_DIR, exist_ok=True)
            for fn in sorted(os.listdir(_PROG_DIR)):
                if not fn.endswith('.json') or fn.startswith('_'):
                    continue
                stem = fn[:-5]
                if not _PROG_READ_ID_RE.match(stem):
                    # Route-unreachable — dead entry. Print once per
                    # boot in case there really is something odd on
                    # disk that the operator wants to see.
                    if not getattr(api_programs_list, '_warned_stems', set()) or \
                            stem not in api_programs_list._warned_stems:
                        try:
                            if not hasattr(api_programs_list, '_warned_stems'):
                                api_programs_list._warned_stems = set()
                            api_programs_list._warned_stems.add(stem)
                            print(f'[programs] hidden (unreachable) stem: {stem!r}',
                                  flush=True)
                        except Exception:
                            pass
                    skipped_unreachable += 1
                    continue
                try:
                    with open(os.path.join(_PROG_DIR, fn)) as fp:
                        prog = json.load(fp)
                    programs.append({
                        'id':          stem,
                        'name':        prog.get('name') or stem,
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
        path = _prog_read_path(prog_id)
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
        src = _prog_read_path(prog_id)
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

    # Program-provenance canonical values. The `source` field on
    # /opt/cobot/programs/{id}.json records WHICH write path created
    # the file — the Monitor screen renders a provenance badge from
    # this so an operator can tell at a glance whether a program
    # started life as a PBD demo, a hand-built manual build, or an
    # imported file. Set at creation and preserved on update. If a
    # program predates the field, _infer_source() below classifies
    # it from surviving evidence (config.pbd_metadata, tags).
    _PROG_SOURCES = ('demonstration', 'manual', 'imported')

    def _infer_source(prog: dict) -> str:
        """Read-time backfill for programs saved before the `source`
        field existed. Classification order matters — a program with
        pbd_metadata was authored by the PBD composer even if it
        later got hand-edited, so demonstration wins over manual.
        """
        cfg = prog.get('config') or {}
        tags = prog.get('tags') or []
        if isinstance(cfg.get('pbd_metadata'), dict):
            return 'demonstration'
        if any(t in tags for t in ('pbd', 'from_demonstration')):
            return 'demonstration'
        return 'manual'

    # Steps whose `action` doesn't require a pose. The wizard authors
    # programs with these actions alongside motion steps; treating them
    # as "untaught" was the root cause of testwizard.json falsely
    # reporting has_taught_poses=false.
    _NON_MOTION_ACTIONS = frozenset({
        'set_io', 'wait', 'wait_input', 'loop', 'gripper',
        'gripper_close', 'gripper_open', 'pause', 'comment', 'end',
        'vacuum_on', 'vacuum_off',
        # 2026-07-31: camera / config-driven verbs. Added after the
        # operator caught `detect` showing up in a Teach All queue —
        # these actions don't take a per-step pose, so `_has_taught_poses`
        # must not treat them as untaught gaps. Kept in sync with the
        # frontend's NON_MOTION_ACTIONS set in lib/programTruth.js.
        'detect',
        'scan_workspace', 'scan_identify_each', 'sort_scanned', 'remove_defects',
        'move_to_pallet',
    })

    def _has_taught_poses(prog: dict) -> bool:
        """A program has REAL taught poses when every step's pose
        requirement is satisfied. Sources counted as taught:
          (a) `point_name` resolves in program.points with 6-el joints,
          (b) a 6-element `taught_joints` with `taught=True` (legacy),
          (c) `derived_from` role referring to another step that IS
              taught inline (the executor resolves anchor + offset at
              runtime — the derived step is authored, not a gap),
          (d) non-motion actions (set_io/wait/loop/gripper/…) which
              don't take a pose at all,
          (e) the legacy `type == 'gripper'` marker.

        Used to strip the stale "poses pending perception" caveat from
        a description when the operator has finished teaching."""
        steps = prog.get('steps') or []
        if not steps:
            # Empty programs with an empty point table aren't
            # considered "taught" — matches the previous behaviour.
            return False
        points = prog.get('points') or {}
        # Pre-pass: which position roles are taught inline in this
        # program? A derived step is only counted (c) if its anchor
        # role is actually present.
        taught_roles = set()
        for s in steps:
            role = s.get('position_role')
            j = s.get('taught_joints')
            if role and isinstance(j, list) and len(j) == 6 \
                    and s.get('taught') is True:
                taught_roles.add(role)
        for s in steps:
            if s.get('type') in ('gripper',):
                continue
            action = str(s.get('action') or '').lower()
            if action in _NON_MOTION_ACTIONS:
                continue
            pn = s.get('point_name')
            if pn and pn in points:
                p = points[pn]
                if isinstance(p.get('joints'), list) and len(p['joints']) == 6:
                    continue
            j = s.get('taught_joints')
            if (isinstance(j, list) and len(j) == 6
                    and s.get('taught') is True):
                continue
            df = s.get('derived_from')
            if df and df in taught_roles:
                continue
            return False
        return True

    def _validate_move_home_consistency(steps):
        """Return a list of warnings — one per move_home step whose
        taught_joints differ from the FIRST move_home step's joints by
        more than 5° in any axis. Returns an empty list when everything
        is aligned OR when there's only one move_home step.

        Matches the FIX C threshold in
        program_ops.codegen_lua_from_program — codegen normalizes
        silently at Lua-emit time, but we warn the operator here so
        drift shows up at save time rather than being noticed only in
        the emitted Lua footer.

        Reason to keep as a WARNING (not a save-blocker): the codegen
        normalization means the arm won't actually visit the drifted
        pose. The warning is informational + a nudge to re-teach so the
        on-disk record matches the emitted program.
        """
        THRESHOLD_DEG = 5.0
        warnings = []
        anchor_idx = None
        anchor_joints = None
        for i, s in enumerate(steps):
            if not isinstance(s, dict):
                continue
            if str(s.get('action') or '').lower() != 'move_home':
                continue
            tj = s.get('taught_joints')
            if not (isinstance(tj, list) and len(tj) == 6
                    and all(isinstance(v, (int, float)) for v in tj)):
                continue
            if anchor_joints is None:
                anchor_idx = i
                anchor_joints = [float(v) for v in tj]
                continue
            deltas = [abs(float(a) - float(b))
                      for a, b in zip(tj, anchor_joints)]
            max_d = max(deltas)
            if max_d > THRESHOLD_DEG:
                warnings.append({
                    "step_index": i,
                    "step_label": s.get("label") or "move_home",
                    "anchor_step_index": anchor_idx,
                    "anchor_step_label":
                        steps[anchor_idx].get("label") or "move_home",
                    "max_joint_delta_deg": round(max_d, 2),
                    "per_axis_delta_deg": [round(d, 2) for d in deltas],
                    "reason": (
                        f"move_home step {i+1} joints differ from "
                        f"step {anchor_idx+1} by up to "
                        f"{max_d:.2f}° (threshold {THRESHOLD_DEG:.1f}°). "
                        "Codegen normalizes silently to the first "
                        "move_home, but re-teach one of them so the "
                        "on-disk record matches."
                    ),
                })
        return warnings

    _RELEASE_ACTIONS_MACHINE_GUARD = frozenset({'open_gripper'})
    _RELEASE_IO_ROLES_MACHINE_GUARD = frozenset({'vacuum', 'magnet'})
    _RELEASE_LABEL_TOKENS_MACHINE_GUARD = (
        'release', 'gripper off', 'disengage vacuum', 'disengage magnet',
    )

    def _is_clamp_step(s):
        if not isinstance(s, dict): return False
        if str(s.get('io_role') or '').lower() == 'machine_clamp' \
                and s.get('value') == 1: return True
        return str(s.get('label') or '').lower() == 'clamp workpiece'

    def _is_clamp_verify(s):
        if not isinstance(s, dict): return False
        if str(s.get('action') or '').lower() != 'verify_input': return False
        return (str(s.get('io_role') or '').lower() == 'clamp_confirmed'
                and s.get('expect') == 1)

    def _is_release_step_machine_guard(s):
        if not isinstance(s, dict): return False
        act = str(s.get('action') or '').lower()
        if act in _RELEASE_ACTIONS_MACHINE_GUARD: return True
        if act == 'set_io' and s.get('value') == 0:
            role = str(s.get('io_role') or '').lower()
            if role in _RELEASE_IO_ROLES_MACHINE_GUARD: return True
            lab = str(s.get('label') or '').lower()
            if any(t in lab for t in _RELEASE_LABEL_TOKENS_MACHINE_GUARD):
                return True
        return False

    def _validate_machine_tending_ordering(steps):
        """Machine-tending clamp→verify→release ordering guard —
        Python mirror of lib/effectorVocab.validateMachineTendingOrdering.
        Both sides must agree; a divergence would be exactly the fork
        the no-fork-truth guard was built to prevent. Kept in this
        file so the save endpoint can block violations at HTTP time,
        BEFORE the program lands on disk.

        Rule fires ONLY when a Verify clamp engaged step exists
        somewhere after the clamp — that's the operator's declared
        intent that they want a verified clamp. If no verify exists
        downstream, either the operator opted out (no Clamp
        confirmed DI assigned) or edited it away; the rule doesn't
        second-guess that choice.

        Returns a list of {step_index, clamp_step_index, reason}
        dicts. Empty list = safe."""
        out = []
        arr = list(steps or [])
        for i in range(len(arr)):
            if not _is_clamp_step(arr[i]):
                continue
            verify_idx = -1
            for j in range(i + 1, len(arr)):
                if _is_clamp_verify(arr[j]):
                    verify_idx = j
                    break
            if verify_idx < 0:
                continue
            for j in range(i + 1, verify_idx):
                s = arr[j]
                if _is_release_step_machine_guard(s):
                    lbl = s.get('label') or s.get('action') or f'step {j+1}'
                    out.append({
                        'step_index':       j,
                        'clamp_step_index': i,
                        'reason': (
                            f'Step {j+1} ({lbl!r}) releases the robot\'s '
                            f'grip AFTER the clamp at step {i+1} but '
                            f'BEFORE the attached "Verify clamp '
                            f'engaged" at step {verify_idx+1}. A failed '
                            f'clamp with the grip released drops the '
                            f'part — reorder so the verify runs first, '
                            f'or remove the release from between them.'),
                    })
                    break
        return out

    def _line_map_sidecar_path(prog_id):
        return os.path.join(_PROG_DIR, f'{prog_id}.line_map.json')


    def _compute_and_save_line_map(program):
        """Run codegen (dry) with `line_map_sink`, then persist the
        map + codegen sha to `<prog_id>.line_map.json` alongside the
        program JSON. Returns the sidecar dict. Best-effort — if the
        codegen fails (usually a taught-joints gap on a draft), we
        write an empty map with the failure reason so the frontend's
        honesty guard still fires. Called from POST and PUT
        /api/programs so every saved program carries a fresh map."""
        prog_id = str(program.get('id') or '').strip()
        if not prog_id:
            return None
        # Local import — same pattern as _d11_block_findings (see
        # commit fd25a67). Owning the import at the call site
        # eliminates the NameError-in-waiting class of bug.
        try:
            from estun_driver import program_ops as _po
        except Exception as e:
            return {
                'program_id':    prog_id,
                'line_map':      [],
                'codegen_sha':   '',
                'codegen_git':   '',
                'effective_pct': None,
                'generated_ts':  _now_stamp(),
                'error':         f'program_ops import: {e}',
            }
        sink = []
        try:
            _lua, _pts, eff_pct = _po.codegen_lua_from_program(
                program, operator_speed_limit_pct=100,
                line_map_sink=sink)
            sidecar = {
                'program_id':   prog_id,
                'line_map':     sink,
                'codegen_sha':  _po.CODEGEN_VERSION.get(
                    'src_sha256', '')[:12],
                'codegen_git':  _po.CODEGEN_VERSION.get(
                    'git_sha', ''),
                'effective_pct': int(eff_pct),
                'generated_ts': _now_stamp(),
                'error':        None,
            }
        except Exception as e:
            sidecar = {
                'program_id':   prog_id,
                'line_map':     [],
                'codegen_sha':  _po.CODEGEN_VERSION.get(
                    'src_sha256', '')[:12],
                'codegen_git':  _po.CODEGEN_VERSION.get(
                    'git_sha', ''),
                'effective_pct': None,
                'generated_ts': _now_stamp(),
                'error':        f'{type(e).__name__}: {e}',
            }
        try:
            with open(_line_map_sidecar_path(prog_id), 'w') as f:
                json.dump(sidecar, f, indent=2)
        except Exception as e:
            print(f'[line_map] sidecar write failed for {prog_id}: {e}',
                  flush=True)
        return sidecar


    def _d11_block_findings(program):
        """Run the motion analyzer over `program` and return
        (block_findings, validator_error_findings). block findings
        refuse the save (a program problem); validator_error
        findings are OUR bug (a check that raised) — the save
        proceeds and the error is auto-filed alongside the
        program's findings as 'inconclusive' so the operator sees
        it but isn't blocked by it.

        The distinction matters (2026-08-03 operator directive):
        never let a validator-crash read as the program being
        wrong. Prior code stuffed the crash into severity='block',
        which made a NameError read as a program-lint failure and
        blocked editing. That is our failure, not the operator's.
        """
        # Local import — Python re-imports are near-free after the
        # first hit; this makes the reference explicit at the call
        # site so a NameError-in-waiting can never appear again
        # (each function that touches program_ops owns its import).
        try:
            from estun_driver import program_ops as _po
        except Exception as e:
            # Can't import → validator itself is broken. NOT a
            # program problem; surface as an inconclusive advisory
            # so the operator can still save/edit.
            return [], [{
                'rule':             'validator_import_error',
                'severity':         'validator_error',
                'message':          f'validator could not import '
                                    f'program_ops: {e}. This is a '
                                    f'BUG in the validator, not a '
                                    f'problem with your program. '
                                    f'Save will proceed.',
                'step_idx':         -1,
                'step_label':       '',
                'step_action':      '',
                'suggested_action': None,
                'metrics':          {'exception_type': type(e).__name__},
            }]
        try:
            rep = _po.analyze_program(program)
        except Exception as e:
            return [], [{
                'rule':             'validator_check_error',
                'severity':         'validator_error',
                'message':          f'analyzer raised '
                                    f'{type(e).__name__}: {e}. This '
                                    f'is a BUG in the validator, '
                                    f'not a problem with your '
                                    f'program. Save will proceed.',
                'step_idx':         -1,
                'step_label':       '',
                'step_action':      '',
                'suggested_action': None,
                'metrics':          {'exception_type': type(e).__name__},
            }]
        blocks = [f for f in (rep.get('findings') or [])
                  if str(f.get('severity') or '') == 'block']
        return blocks, []


    def _validate_step_point_refs(steps, points):
        """Return a per-step message list for any step whose point_name
        doesn't resolve in the program's points table. Empty list on
        success. Used by BOTH POST and PUT so a save that would produce
        a program that can't run also can't slip past the write.

        Rule: a step CAN carry a point_name; if it does, that name MUST
        appear in points with a 6-element joints array. A step with no
        point_name AND no taught_joints is a legitimate placeholder
        (operator hasn't taught it yet — that's captured by
        has_taught_poses:false on read, not blocked here)."""
        issues = []
        pts = points or {}
        for i, s in enumerate(steps):
            if not isinstance(s, dict):
                continue
            pn = s.get("point_name")
            if not pn:
                continue
            p = pts.get(pn)
            joints = (p or {}).get("joints")
            if not (isinstance(joints, list) and len(joints) == 6):
                issues.append({
                    "step_index": i,
                    "step_label": s.get("label") or s.get("action") or f"step {i+1}",
                    "point_name": pn,
                    "reason": f"references point {pn!r} which is not taught "
                              f"in this program's points table",
                    "hint": "Either teach it (Points panel → 📌 Teach current pose "
                            f"then rename to {pn!r}) OR repoint this step to a "
                            "taught point.",
                })
        return issues

    @app.post("/api/programs")
    async def api_programs_save(request: Request):
        """Persist a wizard-generated program to /opt/cobot/programs as a
        JSON file. Slug is derived from the name; collisions get a 2/3/…
        digit suffix (NO underscore separator — see _PROG_ID_RE for the
        controller-underscore-split rationale)."""
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
        # Step→point reference validation. A step that names a point but
        # the point isn't in the program's points{} table blocks the save
        # with a specific, actionable error listing which step + which
        # missing point + how to fix. The blocked message replaces the
        # generic frontend "Error" badge with human-readable text.
        points_in = body.get("points") or {}
        step_issues = _validate_step_point_refs(steps, points_in)
        if step_issues:
            return JSONResponse({
                "error": (
                    "This program has steps that reference untaught points. "
                    + "; ".join(
                        f"Step {it['step_index']+1} ({it['step_label']}) "
                        f"references point {it['point_name']!r} which has "
                        "not been taught"
                        for it in step_issues)
                    + ". Teach those points (Points panel → 📌 Teach current "
                      "pose then rename) or repoint the steps."
                ),
                "step_issues": step_issues,
            }, status_code=422)
        # Machine-tending clamp→verify→release ordering guard.
        # Blocks any program that would release the robot's grip on
        # a workpiece BEFORE the attached "Verify clamp engaged"
        # confirms the fixture has actually latched (2026-07-30
        # machine-tending vocabulary work).
        machine_issues = _validate_machine_tending_ordering(steps)
        if machine_issues:
            return JSONResponse({
                "error": (
                    "This program's clamp/verify/release ordering is "
                    "unsafe: " + "; ".join(it['reason'] for it in machine_issues)
                ),
                "machine_tending_issues": machine_issues,
            }, status_code=422)
        # move_home drift: warn (don't block) — codegen silently
        # normalizes to the first move_home, but the operator should
        # know so they can re-teach the on-disk pose to match.
        home_warnings = _validate_move_home_consistency(steps)
        # Slug: lowercase alnum only. "New Program" → "newprogram";
        # "My Palletize Task 3" → "mypalletizetask3". Collisions get
        # a numeric suffix ("newprogram2") without an underscore
        # separator — the controller would otherwise treat that
        # underscore as a path segment boundary and lose the id.
        base = _prog_re.sub(r'[^a-z0-9]+', '', name.lower()) or 'program'
        try:
            os.makedirs(_PROG_DIR, exist_ok=True)
        except Exception as e:
            return JSONResponse({"error": f"cannot create {_PROG_DIR}: {e}"}, status_code=500)
        slug = base
        n = 2
        while os.path.exists(os.path.join(_PROG_DIR, slug + '.json')):
            slug = f"{base}{n}"
            n += 1
        ts = _now_stamp()
        # Provenance: POST /api/programs is the MANUAL builder's write
        # path (ProgramEditor.jsx handleSave). Stamp source="manual"
        # unless the caller explicitly supplied one (imports may set
        # "imported"; the /api/pbd/{demo_id}/correct path stamps
        # "demonstration" through the branch below).
        source = str(body.get("source") or "manual")
        if source not in _PROG_SOURCES:
            source = "manual"

        # Defense-in-depth against the ProgramEditor "New Program" merge
        # leak (see 2026-07-20 bug: hand-created programs inherited the
        # previously-loaded PBD draft's config.pbd_metadata + tags +
        # description because the frontend's setCurrentProgram is a
        # partial merge). Any program whose source is NOT "demonstration"
        # gets its PBD-provenance markers scrubbed at ingress:
        #   - config.pbd_metadata dropped
        #   - tags 'pbd' / 'from_demonstration' / 'draft' removed
        # A frontend already-fixed to send blank tags is unaffected;
        # an older frontend or an out-of-band POST still can't smuggle
        # PBD provenance into a manual save.
        _PBD_TAG_MARKERS = {'pbd', 'from_demonstration', 'draft'}
        cfg_in = body.get("config") or {}
        tags_in = list(body.get("tags") or [])
        if source != "demonstration":
            if isinstance(cfg_in, dict) and 'pbd_metadata' in cfg_in:
                cfg_in = {k: v for k, v in cfg_in.items() if k != 'pbd_metadata'}
            tags_in = [t for t in tags_in if t not in _PBD_TAG_MARKERS]

        # 2026-07-30 §430 — persist routines[] alongside steps.
        # Representation-only (codegen never reads it), but the
        # editor + review UIs fold on it to render "×N" chips
        # instead of unrolled iterations. Only well-shaped entries
        # are accepted; malformed rows are dropped silently.
        _routines_raw = body.get("routines") or []
        _routines_clean = []
        if isinstance(_routines_raw, list):
            for r in _routines_raw:
                if not isinstance(r, dict):
                    continue
                rid = str(r.get("id") or "").strip()
                if not rid:
                    continue
                _routines_clean.append({
                    "id":          rid,
                    "name":        str(r.get("name") or ""),
                    "iterations":  int(r.get("iterations") or 1),
                    "operation_indices":     list(r.get("operation_indices") or []),
                    "step_indices_per_iter": list(r.get("step_indices_per_iter") or []),
                    "per_iteration_deltas":  list(r.get("per_iteration_deltas") or []),
                    "single_iteration_signature": dict(r.get("single_iteration_signature") or {}),
                })
        program = {
            "id":          slug,
            "name":        name,
            "description": str(body.get("description") or ""),
            "tags":        tags_in,
            "config":      cfg_in,
            "steps":       steps,
            "routines":    _routines_clean,
            "cell_id":     body.get("cell_id") or None,
            "source":      source,
            "created":     ts,
            "updated":     ts,
        }
        # D11 save gate (2026-08-03) — 'block' findings from the
        # analyzer refuse the save (program problem). 'validator_
        # error' findings are OUR bug (analyzer raised) — save
        # proceeds; the crash is auto-filed as inconclusive so the
        # operator sees it. Never let a validator crash read as a
        # program error.
        block, validator_errors = _d11_block_findings(program)
        if block:
            return JSONResponse({
                "error": ("D11 column orientation lock: "
                          + "; ".join(f['message'] for f in block)),
                "d11_block_findings": block,
                "validator_errors":   validator_errors,
            }, status_code=422)
        try:
            with open(os.path.join(_PROG_DIR, slug + '.json'), 'w') as f:
                json.dump(program, f, indent=2)
        except Exception as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        # Line-map sidecar (D9 · 2026-08-03) — every saved program
        # gets a fresh line_map for the Monitor's live step highlight.
        sidecar = _compute_and_save_line_map(program)
        return {"ok": True, "program": program,
                "line_map":  (sidecar or {}).get("line_map"),
                "codegen_sha": (sidecar or {}).get("codegen_sha"),
                "validator_errors": validator_errors,
                "warnings": {"move_home_drift": home_warnings}
                            if home_warnings else {}}

    @app.get("/api/programs/{prog_id}")
    async def api_programs_get(prog_id: str):
        path = _prog_read_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            with open(path) as f:
                prog = json.load(f)
        except Exception as e:
            return JSONResponse({"error": f"read failed: {e}"}, status_code=500)
        # Provenance backfill for programs saved before the field
        # existed. Non-persistent — a subsequent PUT with the correct
        # source will overwrite it. `has_taught_poses` is a derived
        # readonly hint the Monitor uses to suppress the stale
        # "poses pending perception" caveat when the operator has
        # finished teaching PBD-drafted placeholders.
        if not prog.get("source"):
            prog["source"] = _infer_source(prog)
        prog["has_taught_poses"] = _has_taught_poses(prog)
        # Rev normalisation — client always gets a numeric rev, never
        # None. Read authoritative rev from _prog_revs (seeded from
        # disk at startup + updated by every _bump_prog_rev). Programs
        # that have never been mutated report 0, not None, so client-
        # side ev.rev > cp.rev comparisons behave predictably.
        with _prog_event_lock:
            authoritative = _prog_revs.get(prog_id)
        if authoritative is None:
            # First read of a program the seeder didn't cover; seed
            # from the file's own rev (or 0) so subsequent broadcasts
            # + bumps stay consistent.
            authoritative = int(prog.get("rev") or 0)
            with _prog_event_lock:
                _prog_revs[prog_id] = max(
                    authoritative, _prog_revs.get(prog_id, 0))
        prog["rev"] = int(authoritative)
        return prog

    @app.put("/api/programs/{prog_id}")
    async def api_programs_update(prog_id: str, request: Request):
        """Merge an update into the existing program file. Preserves the
        original id and created timestamp; bumps updated. Accepts the
        same shape as POST minus the auto-slugging."""
        path = _prog_read_path(prog_id)
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
        # Same step→point validation as POST. Uses the merged view of
        # steps + points (incoming overrides existing) so a PUT that
        # ADDS a bad point_name reference is blocked with the specific
        # message.
        merged_steps  = body.get("steps",  prog.get("steps")  or [])
        merged_points = body.get("points", prog.get("points") or {})
        step_issues = _validate_step_point_refs(merged_steps, merged_points)
        if step_issues:
            return JSONResponse({
                "error": (
                    "This update would leave steps referencing untaught points. "
                    + "; ".join(
                        f"Step {it['step_index']+1} ({it['step_label']}) → "
                        f"point {it['point_name']!r} not taught"
                        for it in step_issues)
                    + ". Teach those points or repoint the steps."
                ),
                "step_issues": step_issues,
            }, status_code=422)
        # Machine-tending ordering guard — same rule the POST path
        # applies (block clamp/verify/release out-of-order edits).
        merged_machine_issues = _validate_machine_tending_ordering(merged_steps)
        if merged_machine_issues:
            return JSONResponse({
                "error": (
                    "This update would leave the clamp/verify/release "
                    "ordering unsafe: "
                    + "; ".join(it['reason'] for it in merged_machine_issues)
                ),
                "machine_tending_issues": merged_machine_issues,
            }, status_code=422)
        # move_home drift check on the merged view (same threshold as
        # POST and program_ops FIX C).
        home_warnings_put = _validate_move_home_consistency(merged_steps)
        for k in ("name", "description", "tags", "config", "steps", "cell_id", "routines"):
            if k in body:
                prog[k] = body[k]
        # id is owned by the filename — never let a client change it.
        prog["id"] = prog_id
        prog["updated"] = _now_stamp()
        if "created" not in prog:
            prog["created"] = prog["updated"]
        # Provenance is preserved across updates. If missing (older
        # file), backfill from the inference rules. The `source` field
        # is only WRITABLE via update if the client explicitly sends
        # one AND it's a canonical value — imports may need to override
        # from "manual" to "imported", but a stray body field never
        # relabels a demonstration as manual.
        incoming_source = body.get("source")
        if incoming_source and str(incoming_source) in _PROG_SOURCES:
            prog["source"] = str(incoming_source)
        elif not prog.get("source"):
            prog["source"] = _infer_source(prog)

        # Same PBD-marker scrub as POST (see comment there). Fires
        # when the EFFECTIVE source is not demonstration — preserves
        # config.pbd_metadata + PBD tags on genuine demo programs
        # across edits (steps/name/description can still be edited
        # on a PBD program without losing its provenance).
        _PBD_TAG_MARKERS = {'pbd', 'from_demonstration', 'draft'}
        if prog.get("source") != "demonstration":
            cfg = prog.get("config") or {}
            if isinstance(cfg, dict) and 'pbd_metadata' in cfg:
                prog["config"] = {k: v for k, v in cfg.items() if k != 'pbd_metadata'}
            tags = prog.get("tags") or []
            prog["tags"] = [t for t in tags if t not in _PBD_TAG_MARKERS]
        # D11 save gate (2026-08-03) — see POST path for context.
        # Validator crashes never block; only real 'block' findings do.
        block, validator_errors = _d11_block_findings(prog)
        if block:
            return JSONResponse({
                "error": ("D11 column orientation lock: "
                          + "; ".join(f['message'] for f in block)),
                "d11_block_findings": block,
                "validator_errors":   validator_errors,
            }, status_code=422)
        try:
            # Bug 1 fix (2026-07-27): route the PUT write through the
            # rev+broadcast helper so every step edit, teach, link, or
            # save is seen by other connected clients within ~1 /ws/state
            # tick. The originating client's own echo is suppressed via
            # source_client match on the receive side.
            new_rev = _save_prog_with_event(
                prog, path, prog_id,
                _client_id_of(request), "program_put")
        except Exception as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        sidecar = _compute_and_save_line_map(prog)
        return {"ok": True, "program": prog, "rev": new_rev,
                "validator_errors": validator_errors,
                "line_map":  (sidecar or {}).get("line_map"),
                "codegen_sha": (sidecar or {}).get("codegen_sha"),
                "warnings": {"move_home_drift": home_warnings_put}
                            if home_warnings_put else {}}

    @app.delete("/api/programs/{prog_id}")
    async def api_programs_delete(prog_id: str, request: Request):
        # Delete has to reach existing files whose id contains the
        # underscore/hyphen shape older wizards produced; the strict
        # slug rule stays on CREATION via _prog_path. Contract: 404
        # is reserved for "file genuinely doesn't exist on disk" —
        # never for id-form mismatch on a listed entry.
        path = _prog_read_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            os.remove(path)
        except Exception as e:
            return JSONResponse({"error": f"delete failed: {e}"}, status_code=500)
        # Fan out to other connected clients so the row disappears
        # from their library within one /ws/state tick. Uses the
        # program-changed ring from the 2026-07-27 sync fix.
        try:
            rev = _bump_prog_rev(prog_id)
            _emit_program_changed(prog_id, rev,
                                  _client_id_of(request), 'deleted')
        except Exception as e:
            # Broadcast failure must never block the delete itself —
            # the file is gone; other clients will notice on next
            # refresh even without the event.
            print(f'[programs] delete-broadcast failed for {prog_id!r}: '
                  f'{type(e).__name__}: {e}', flush=True)
        return {"ok": True}

    @app.post("/api/programs/{prog_id}/rename")
    async def api_programs_rename(prog_id: str, request: Request):
        """Migrate a program to a controller-safe slug. Body: {new_name}.
        The new slug is derived from new_name via the same regex the
        POST endpoint uses (lowercase-alnum only, no underscore); the
        endpoint refuses if the target already exists.

        Preserves steps + points + config + source + tags + created
        timestamp. Bumps updated. Rewrites the id field. Deletes the
        old file only on successful new-file write (atomic-ish; a
        crash between the two calls leaves BOTH files present but
        with the same content, which is safe to clean up manually).

        Also supports reaching an underscored old file that
        /api/programs/{id} routes normally can't reach — we bypass
        _prog_path here and open the raw candidate path so the
        operator can migrate programs stuck under the old naming
        scheme (rare cleanup path).
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        new_name = str(body.get("new_name") or "").strip()
        if not new_name:
            return JSONResponse({"error": "new_name required"}, status_code=400)

        # Uses the shared _prog_read_path resolver (relaxed regex
        # ^[a-z0-9_-]+$) so migrating an old underscored slug
        # traverses the same path validation every read/delete route
        # uses. Traversal safety: the resolver never emits a path
        # outside _PROG_DIR since the character class excludes dots
        # and slashes.
        src = _prog_read_path(prog_id)
        if not src:
            return JSONResponse({"error": "invalid source id"}, status_code=400)
        if not os.path.isfile(src):
            return JSONResponse({"error": "not found"}, status_code=404)

        new_slug = _prog_re.sub(r'[^a-z0-9]+', '', new_name.lower()) or 'program'
        n = 2
        candidate = new_slug
        while os.path.exists(os.path.join(_PROG_DIR, candidate + '.json')):
            if candidate == prog_id:
                # Target IS the source (name didn't actually change).
                return JSONResponse({"error": "new_name resolves to the same slug"},
                                    status_code=409)
            candidate = f"{new_slug}{n}"
            n += 1
        dst = os.path.join(_PROG_DIR, candidate + '.json')

        try:
            with open(src) as f:
                prog = json.load(f)
        except Exception as e:
            return JSONResponse({"error": f"read failed: {e}"}, status_code=500)
        prog["id"] = candidate
        prog["name"] = new_name
        prog["updated"] = _now_stamp()

        try:
            with open(dst, 'w') as f:
                json.dump(prog, f, indent=2)
        except Exception as e:
            return JSONResponse({"error": f"write failed: {e}"}, status_code=500)
        try:
            os.remove(src)
        except Exception:
            # Non-fatal: the new file exists, the operator can clean up
            # the old one manually. Preferable to a rollback that
            # deletes the new file after a successful write.
            pass
        return {"ok": True, "old_id": prog_id, "new_id": candidate,
                "program": prog}

    # ------------------------------------------------------------------
    # Point table — teach + manage taught poses per program.
    #
    # Points live under a new top-level `points` dict on the program
    # JSON:
    #   points: {
    #     "p1": {joints:[6 deg], tcp:[x,y,z,a,b,c mm/deg],
    #            label:"Home", taught_at:"…Z"},
    #     ...
    #   }
    # Steps can reference points by `point_name`; the ladder-proven
    # program_ops.codegen_lua_from_program prefers this dict when
    # present, falling back to steps[].taught_joints for backward
    # compatibility with programs authored before this schema.
    #
    # SAFETY: teaching only RECORDS a pose. It never publishes to
    # /estun/program, never opens a WS write, never touches the arm.
    # No allow_move gate is required. The move-gate still governs Run
    # exclusively — teach and run are separate authorities on purpose,
    # so an integrator can shape a program with the gate closed and
    # only open it when the operator is at the cell.
    _POINT_NAME_RE = _prog_re.compile(r'^[A-Za-z][A-Za-z0-9_]{0,30}$')

    def _snapshot_current_pose():
        """Atomic pose snapshot from the driver's /estun/status mirror.
        Returns (joints_deg, tcp_mm) or (None, None) if the driver has
        never published — the endpoint refuses to teach in that case
        rather than record zeros as a pose."""
        with _state_lock:
            r = STATE.get("robot") or {}
            jd = r.get("joints_deg")
            tm = r.get("tcp_mm")
        if not (isinstance(jd, list) and len(jd) == 6
                and all(isinstance(v, (int, float)) for v in jd)):
            return None, None
        # tcp is optional — the point table stores it for display
        # only. movJ codegen uses joints only.
        if not (isinstance(tm, list) and len(tm) == 6):
            tm = None
        else:
            tm = [float(v) for v in tm]
        return [float(v) for v in jd], tm

    def _load_prog(prog_id):
        # Read-path resolver (relaxed regex) so points endpoints reach
        # existing files whose id contains _ / - from an earlier
        # naming scheme. Creation still routes through _prog_path.
        path = _prog_read_path(prog_id)
        if not path or not os.path.isfile(path):
            return None, None
        try:
            with open(path) as f:
                return json.load(f), path
        except Exception:
            return None, None

    def _save_prog(prog, path):
        prog["updated"] = _now_stamp()
        with open(path, 'w') as f:
            json.dump(prog, f, indent=2)

    def _client_id_of(request) -> str:
        """Read the caller's X-Client-Id header (a UUID minted per page
        load on the browser). Empty string when older builds are still
        running. Only used for echo-suppression on the receive side —
        an empty source_client never matches a real client id so those
        events fire on every client (worst case: originator refetches
        once, harmless)."""
        try:
            return (request.headers.get("x-client-id") or "").strip()
        except Exception:
            return ""

    def _save_prog_with_event(prog, path, prog_id, source_client, kind):
        """Bump the program's revision, stash it into the file, save,
        and emit a program_changed event onto the /ws/state ring so
        every other client sees the mutation. Wire evidence: PUT
        /programs/{id} + POST/PUT/DELETE /programs/{id}/points all
        route through this — the editor's cross-client 'tablet teaches,
        PC updates' contract lives on this call site.

        Seed the in-memory rev counter from the on-disk `rev` field so
        a service restart doesn't reset a program's revision back to 1
        when clients still hold higher local revs from before the
        restart (their `rev > local` check would then never fire even
        though the file did change)."""
        with _prog_event_lock:
            if prog_id not in _prog_revs:
                _prog_revs[prog_id] = int(prog.get("rev") or 0)
        rev = _bump_prog_rev(prog_id)
        prog["rev"] = rev
        _save_prog(prog, path)
        _emit_program_changed(prog_id, rev, source_client, kind)
        return rev

    def _next_point_name(points):
        """p1, p2, ... — skip any already taken so a renamed point
        doesn't reappear as the next auto-name."""
        n = 1
        while f'p{n}' in points:
            n += 1
        return f'p{n}'

    def _points_in_use(prog, name):
        """Return the list of step indices that reference this point by
        `point_name` (new schema). Used by DELETE to refuse removals
        that would leave dangling references."""
        used = []
        for i, s in enumerate(prog.get("steps") or []):
            if isinstance(s, dict) and s.get("point_name") == name:
                used.append(i)
        return used

    def _bump_has_taught_poses(prog):
        """No-op — has_taught_poses is a derived read-time flag on GET.
        Kept as a named function so future authors don't inline
        recompute-and-store logic here (which would silently drift)."""
        return

    @app.post("/api/programs/{prog_id}/points")
    async def api_program_teach_point(prog_id: str, request: Request):
        """Snapshot the arm's live pose and record it as a taught
        point on the program. Body:
            { label?: str, name?: str }
        `name` auto-mints p1/p2/... if absent. `label` is a human
        display string (rendered in the Points panel next to the
        auto-name). If a name collides with an existing point, the
        response is 409 — retach uses PUT."""
        prog, path = _load_prog(prog_id)
        if prog is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        try:
            body = await request.json()
        except Exception:
            body = {}

        joints, tcp = _snapshot_current_pose()
        if joints is None:
            return JSONResponse(
                {"error": "no live pose — driver hasn't published joints_deg yet"},
                status_code=503)

        points = dict(prog.get("points") or {})
        name = str(body.get("name") or "").strip() or _next_point_name(points)
        if not _POINT_NAME_RE.match(name):
            return JSONResponse(
                {"error": f"invalid point name {name!r} — expected letters/digits/_ starting with a letter"},
                status_code=400)
        if name in points:
            return JSONResponse(
                {"error": f"point {name!r} already exists — use PUT to re-teach"},
                status_code=409)

        label = body.get("label")
        if label is not None:
            label = str(label)[:80]

        points[name] = {
            "joints":   joints,
            "tcp":      tcp,           # may be None
            "label":    label,
            "taught_at": datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        }
        prog["points"] = points
        new_rev = _save_prog_with_event(
            prog, path, prog_id, _client_id_of(request), "point_teach")

        return {"ok": True, "point": points[name] | {"name": name},
                "program": prog, "rev": new_rev}

    @app.put("/api/programs/{prog_id}/points/{name}")
    async def api_program_update_point(prog_id: str, name: str, request: Request):
        """Re-teach (snapshot current pose into an existing point) OR
        rename OR relabel. Body fields (all optional):
            retach:   true → overwrite joints/tcp with current pose
            label:    new label
            new_name: rename (validated + collision-checked; updates
                      step.point_name references atomically)
        Sending an empty body is a no-op that just returns the current
        program.
        """
        prog, path = _load_prog(prog_id)
        if prog is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        points = dict(prog.get("points") or {})
        if name not in points:
            return JSONResponse({"error": f"point {name!r} not found"},
                                status_code=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        pt = dict(points[name])

        if body.get("retach"):
            j, t = _snapshot_current_pose()
            if j is None:
                return JSONResponse(
                    {"error": "no live pose to retach with"},
                    status_code=503)
            pt["joints"] = j
            pt["tcp"] = t
            pt["taught_at"] = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

        if "label" in body:
            lab = body["label"]
            pt["label"] = str(lab)[:80] if lab is not None else None

        new_name = body.get("new_name")
        if new_name is not None:
            nn = str(new_name).strip()
            if nn != name:
                if not _POINT_NAME_RE.match(nn):
                    return JSONResponse(
                        {"error": f"invalid new_name {nn!r}"},
                        status_code=400)
                if nn in points:
                    return JSONResponse(
                        {"error": f"point {nn!r} already exists"},
                        status_code=409)
                # Move the entry AND update step references so no step
                # is left pointing at a dead name. Atomic with the file
                # write below.
                del points[name]
                points[nn] = pt
                for s in prog.get("steps") or []:
                    if isinstance(s, dict) and s.get("point_name") == name:
                        s["point_name"] = nn
                name = nn
            else:
                points[name] = pt
        else:
            points[name] = pt

        prog["points"] = points
        new_rev = _save_prog_with_event(
            prog, path, prog_id, _client_id_of(request), "point_put")
        return {"ok": True, "point": points[name] | {"name": name},
                "program": prog, "rev": new_rev}

    @app.delete("/api/programs/{prog_id}/points/{name}")
    async def api_program_delete_point(prog_id: str, name: str, request: Request):
        """Delete a taught point. Refuses (409) if any step references
        the point by `point_name` — the operator has to either
        re-target the step first or delete the step. This is the
        block-or-reassign rule the operator asked for; auto-reassign
        would be lossy (which point do we pick?) and silent point
        drop would leave the program broken."""
        prog, path = _load_prog(prog_id)
        if prog is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        points = dict(prog.get("points") or {})
        if name not in points:
            return JSONResponse({"error": f"point {name!r} not found"},
                                status_code=404)
        in_use = _points_in_use(prog, name)
        if in_use:
            return JSONResponse(
                {"error": f"point {name!r} in use by step(s) {in_use}",
                 "in_use_by": in_use},
                status_code=409)
        del points[name]
        prog["points"] = points
        new_rev = _save_prog_with_event(
            prog, path, prog_id, _client_id_of(request), "point_delete")
        return {"ok": True, "program": prog, "rev": new_rev}

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
        # Heavy work — drop off the event loop. Wrap in try/except so
        # a pipeline crash (ffmpeg failure, schema bug, network) always
        # returns JSON instead of FastAPI's default text 500. The FE
        # parses res.json() and the bare "Internal Server Error" body
        # used to surface as the misleading "Unexpected token 'I'"
        # JSON parse error instead of the real reason.
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(
                None, _pbd_run_sync, video_path, demo_id, backend_override,
            )
        except Exception as e:
            import traceback as _tb
            tb_text = _tb.format_exc()
            print(f'[pbd] api_pbd_generate failed for demo {demo_id}: '
                  f'{type(e).__name__}: {e}\n{tb_text}', flush=True)
            return JSONResponse(
                {
                    'ok':       False,
                    'demo_id':  demo_id,
                    'error':    f'{type(e).__name__}: {e}',
                    # Truncated traceback for the operator's bug
                    # report; the full one stays in the journal.
                    'traceback_excerpt': tb_text[-1500:],
                },
                status_code=500,
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

    @app.post("/api/pbd/{demo_id}/recompose")
    async def api_pbd_recompose(demo_id: str, request: Request):
        """Re-run the composer on a stored demo's intent — the fix
        path for a draft that was generated before an effector /
        source / other composer-shape flip. Reads structured_intent.
        json from the demo's directory, applies optional overrides
        from the request body (currently: effector), calls
        compose_program_draft, and returns the fresh draft dict. Does
        NOT overwrite program_draft.json on disk (the operator can
        still Accept via /correct to persist).

        Body: {effector?: 'vacuum'|'finger'|'magnetic', intent?: <full
        intent override — the frontend can pass an intent that has
        already had clarifications applied>}

        This exists because a review screen with the wrong effector-
        emitted steps can't be repaired by simple relabelling — the
        step LIST needs to change (vacuum's engage/disengage steps
        replace grip_close/grip_release entirely, with the blow-off
        triplet inserted after disengage). Re-invoking the composer
        deterministic-ally regenerates the whole thing."""
        did = demo_id.strip()
        try:
            store = _pbd_store()
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
        demo_dir = store.dir_for(did)
        intent_path = os.path.join(demo_dir, 'structured_intent.json')
        if not os.path.isfile(intent_path):
            return JSONResponse({
                "ok": False,
                "error": f"no structured_intent.json for demo {did!r}",
            }, status_code=404)
        try:
            body = await request.json()
        except Exception:
            body = {}
        try:
            with open(intent_path) as f:
                intent_raw = json.load(f)
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"intent read failed: {e}",
            }, status_code=500)
        # Full-intent override wins; otherwise apply named overrides.
        if isinstance(body.get('intent'), dict):
            intent_raw = body['intent']
        eff = body.get('effector')
        if isinstance(eff, str) and eff.lower() in ('finger', 'vacuum', 'magnetic'):
            for op in (intent_raw.get('operations') or []):
                if isinstance(op, dict): op['effector'] = eff.lower()
        # Parse + compose using the same PBD pipeline the initial
        # generate flow uses.
        try:
            from programming_by_demonstration.schema import StructuredIntent
            from programming_by_demonstration.program_composer import compose_program_draft
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"pbd import failed: {e}",
            }, status_code=500)
        try:
            intent = StructuredIntent.from_dict(intent_raw)
            draft = compose_program_draft(intent, demo_id=did)
        except Exception as e:
            return JSONResponse({
                "ok": False,
                "error": f"compose failed: {e}",
            }, status_code=500)
        return {
            "ok":     True,
            "demo_id": did,
            "draft":  draft.to_program_payload(),
            "intent": intent.to_dict(),
        }

    @app.post("/api/pbd/{demo_id}/correct")
    async def api_pbd_correct(demo_id: str, request: Request):
        """Operator accepted the (possibly edited) draft. Body:
            { program: <full program payload — same shape as POST /api/programs>,
              intent:  <answered structured intent — client folded
                        clarifications via applyClarifications>,
              scene:   <corrected scene>,
              clarifications_answered: {...},
              save_to_library: true }

        Architectural fix (2026-07-27, PBD answer-application audit):
        BEFORE this pass, Accept saved `body.program.steps` verbatim.
        If the operator's answers required a STEP-LIST restructure
        (effector vacuum→engage/disengage, target_part label refresh,
        location_hint downstream), the client-side folder didn't
        rebuild the list — the manual ↻ Regenerate button was the
        only path that did. Result: "vacuum" answered, "Grip part"
        saved (whitebowl demo demo_20260727T161927_e475ef).

        Now: whenever `body.intent` carries answered operations, we
        recompose server-side (same deterministic compose_program_draft
        the ↻ button uses) and OVERWRITE `program.steps` with the
        composed output before persisting. Everything else on
        `program` (name, description, tags, config, and any client-
        appended `loop` step for cycles) is preserved.

        Fallback: if intent is missing / malformed / the composer
        raises, we save the client's draft as-is with a `warning`
        entry in the response so old clients keep working. Better to
        save what the operator saw than lose their work.
        """
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

        # Server-side recompose — the actual bug fix.
        recompose_warning = None
        recomposed = False
        intent_in = body.get('intent') if isinstance(body.get('intent'), dict) else None
        if intent_in and (intent_in.get('operations') or []):
            try:
                from programming_by_demonstration.schema import StructuredIntent
                from programming_by_demonstration.program_composer import compose_program_draft
                composed = compose_program_draft(
                    StructuredIntent.from_dict(intent_in), demo_id=did)
                composed_payload = composed.to_program_payload()
                composed_steps = list(composed_payload.get('steps') or [])
                # Preserve the operator's client-appended `loop` step
                # (cycles > 1). It always sits at the tail; the composer
                # never emits one, so we can splice safely.
                client_loop_steps = [
                    s for s in (program.get('steps') or [])
                    if isinstance(s, dict) and s.get('action') == 'loop'
                ]
                if client_loop_steps:
                    composed_steps = composed_steps + client_loop_steps
                # Overwrite steps with the composed output. Renumber
                # `step` fields to stay contiguous (composer numbers
                # its own output, but appending the loop can leave a
                # gap).
                for i, s in enumerate(composed_steps, 1):
                    if isinstance(s, dict):
                        s['step'] = i
                program = {**program, 'steps': composed_steps}
                # If the composer produced a description that differs
                # from the client's, prefer the client's — the operator
                # may have hand-edited it.
                recomposed = True
            except Exception as e:
                # Fall back to the client's draft; surface the warning
                # so the client can decide whether to re-try. Never
                # block Accept — losing the operator's work is worse
                # than saving a possibly-stale draft.
                recompose_warning = f'{type(e).__name__}: {e}'
                print(f'[pbd] server recompose failed for {did}: '
                      f'{recompose_warning}', flush=True)

        program_id = None
        if body.get('save_to_library', True):
            # Mint a slug using the same convention as POST /api/programs.
            # NO underscore — see _PROG_ID_RE comment for the controller-
            # side URL-parser split rationale.
            name = str(program.get('name')).strip()
            base = _prog_re.sub(r'[^a-z0-9]+', '', name.lower()) or 'program'
            try:
                os.makedirs(_PROG_DIR, exist_ok=True)
            except Exception as e:
                return JSONResponse({"ok": False,
                                     "error": f"cannot create {_PROG_DIR}: {e}"},
                                    status_code=500)
            slug = base
            n = 2
            while os.path.exists(os.path.join(_PROG_DIR, slug + '.json')):
                slug = f"{base}{n}"
                n += 1
            ts = _now_stamp()
            saved = {
                "id":          slug,
                "name":        name,
                "description": str(program.get('description') or ''),
                "tags":        list(program.get('tags') or []) + ['from_demonstration'],
                "config":      program.get('config') or {},
                "steps":       list(program.get('steps') or []),
                # PBD-corrected save path — source is authoritative
                # here (the program originated from a recorded demo,
                # even if the operator hand-corrected the intent and
                # taught real poses afterward). Downstream backfill
                # rules concur via config.pbd_metadata inference, but
                # having the field explicit avoids the inference on
                # every read.
                "source":      "demonstration",
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
            # Persist the operator's clarification answers as a
            # separate training signal — what the AI ASKED + what the
            # human ANSWERED. The intent's ambiguities list carries
            # the structured questions; answers is a {id: value} map.
            cl_list = []
            if isinstance(corrected_intent, dict):
                cl_list = corrected_intent.get('ambiguities') or []
            cl_answers = body.get('clarifications_answered')
            if isinstance(cl_answers, dict) and (cl_answers or cl_list):
                store.save_clarifications(did, cl_list, cl_answers)
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"save_correction failed: {e}"},
                                status_code=500)
        # Compute the CORRECTED-vs-DRAFT diff — the most valuable
        # training signal (what the AI got wrong, by how much). Strictly
        # best-effort: a diff failure must NEVER block the operator's
        # Accept, so we swallow exceptions and just log them.
        diff_summary = None
        try:
            ai_draft = store.load_draft(did)
            diff = store.save_correction_diff(did, ai_draft, program)
            diff_summary = (diff or {}).get('summary')
        except Exception as e:
            print(f'[pbd] correction_diff capture failed for {did}: '
                  f'{type(e).__name__}: {e}', flush=True)
        # Echo back the FINAL program the server actually persisted —
        # steps, id, everything. The client's accept() replaces its
        # local draft with this so the review re-renders what got
        # saved (no more silent divergence between screen and disk).
        final_program = None
        if body.get('save_to_library', True):
            try:
                final_program = saved   # defined above when we wrote to disk
            except NameError:
                final_program = program
        else:
            final_program = program
        out = {"ok": True, "demo_id": did, "program_id": program_id,
               "program": final_program, "recomposed": recomposed}
        if diff_summary is not None:
            out["diff_summary"] = diff_summary
        if recompose_warning is not None:
            out["recompose_warning"] = recompose_warning
        return out

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

    # Live merged snapshot from the driver's IOManager/GetIOValue +
    # GetIOInfo poll. Returned verbatim; the frontend renders the
    # `value` and `forced` fields on each row. `allow_io` mirrors the
    # driver's gate — the frontend uses it to disable the toggles
    # when writes would be refused.
    @app.get("/api/io/live")
    async def api_io_live():
        with _state_lock:
            live = STATE.get('io_live')
            robot = STATE.get('robot') or {}
        if not live:
            return {"ok": False,
                    "reason": "driver has not published /estun/io yet",
                    "allow_io": False,
                    "robot_mode_code": robot.get('robot_mode_code', -1)}
        return {"ok": True,
                "robot_mode_code": robot.get('robot_mode_code', -1),
                **live}

    # Manual DO / DI-force write. Body: {port: int, value: 0|1, type: "DO"|"DI"}.
    # This publishes onto /robot/io_set; the driver enforces the
    # monitor_only + allow_io + SM==READY gate and emits
    # IOManager/SetIOForcedFlag. Refusals surface on /estun/rejected
    # (family='io').
    @app.post("/api/io/force")
    async def api_io_force(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        try:
            port = int(body.get('port'))
        except (TypeError, ValueError):
            return JSONResponse({"error": "port required (integer)"}, status_code=400)
        typ = str(body.get('type') or '').upper()
        if typ not in ('DI', 'DO'):
            return JSONResponse({"error": "type must be 'DI' or 'DO'"}, status_code=400)
        val = 1 if body.get('value') else 0
        with _state_lock:
            r = STATE.get("robot", {})
            allow_io = bool(r.get('allow_io', False))
            monitor_only = bool(r.get('monitor_only', True))
            rej_before = len(r.get('rejected', []))
        if _ros_node is None:
            return JSONResponse({"error": "ros not available"}, status_code=503)
        payload = {"port": port, "value": val, "type": typ}
        m = String(); m.data = json.dumps(payload)
        _ros_node._estun_io_set_pub.publish(m)
        # Give the driver a short window to reject/ack. If the gate is
        # closed the driver publishes on /estun/rejected; if not, the
        # next /estun/io snapshot will carry the new forced/value.
        deadline = time.time() + 0.6
        outcome = {"kind": "published"}
        while time.time() < deadline:
            await asyncio.sleep(0.05)
            with _state_lock:
                r = STATE.get('robot', {})
                new_rej = r.get('rejected', [])[rej_before:]
                io_rejects = [x for x in new_rej if x.get('family') == 'io']
                if io_rejects:
                    outcome = {"kind": "rejected",
                               "reason": io_rejects[0].get('reason')}
                    break
        return {
            "ok": outcome["kind"] == "published",
            "outcome": outcome,
            "request": payload,
            "gate": {"allow_io": allow_io, "monitor_only": monitor_only},
        }

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

    # ------------------------------------------------------------------
    # I/O Port Map — verified against the factory-controller WS capture
    # at data/estun_captures/estun_io_20260721.har.
    #
    # Schema v3 replaces the earlier provisional block layout with the
    # authoritative channel inventory reported by IOManager/GetIOInfo:
    #   DI: 24 channels — general DI0-15 + modeSwitch@16 + enableButton@17
    #                     + flangeButton0-3@18-21 (flangeButton0 name
    #                     defaults to "Drag", function ['robotDrag',0,null])
    #                     + flangeDI0/1@22-23
    #   DO: 18 channels — general DO0-15 + flangeDO0/1@16-17
    #   AI: 4 channels  — AI0-3
    #   AO: 4 channels  — AO0-3
    #
    # Layout is organised by functional group (general / system-reserved /
    # flange / analog) rather than the earlier CC10-A back-panel plug
    # order — the panel-plug view was provisional and superseded by the
    # controller's own enumeration.
    #
    # Wire verbs (documented in the emitted payload as `verbs`) come
    # from the same capture:
    #   IOManager/GetIOInfo      — enumerate, returns names + forced flags
    #                              + function bindings
    #   IOManager/GetIOValue     — batch read, request/response
    #                              [{type,port,value}, ...]
    #   IOManager/SetIOForcedFlag — force override (test-inject); ONLY
    #                              type:"DI" seen in this capture; DO
    #                              force + unforce/release verb are
    #                              SOURCE-ONLY (unverified on the wire).
    #
    # Nothing in this module invokes those verbs. Driver-side bridge +
    # allow_io gate + codegen extensions land in a follow-up pass, after
    # a live-first force → GetIOValue round-trip is verified.
    # ------------------------------------------------------------------
    _IO_MAP_PATH    = '/opt/cobot/io_map.json'
    _IO_MAP_VERSION = 5

    # Controller nameplate — captured from the silkscreen label plate on
    # the back of the CC10-A controller on 2026-07-21.
    _IO_NAMEPLATE = {
        'model':     'CC10-A',
        'power_w':   1500,
        'voltage':   '1PH AC 100-240V',
        'current_a': 8,
        'serial':    '12605280821',
    }

    # Provenance for every data source that shapes this map. Keeping
    # these strings on the payload lets the frontend show operators
    # exactly which capture verified each part of the layout.
    _IO_SOURCES = {
        'physical': 'controller back-panel silkscreen label plate (2026-07-21)',
        'software': 'data/estun_captures/estun_io_20260721.har (IOManager/GetIOInfo)',
        'lua':      'data/estun_captures/estun_lua_io_v2_20260721.har (luaenginelib.json)',
    }

    # Kind-level electrical specs — reference tooltips only. Numbers
    # come from the manual OCR the operator confirmed:
    #   DI: 24 V typ / 30 V max, ~10 kΩ, PNP or NPN
    #   DO: 24 V typ / 30 V max, max 125 mA per group, PNP
    #   External supply: 24 V, 1 A per group
    _IO_SPECS = {
        'DI': {
            'voltage_typ_v': 24, 'voltage_max_v': 30,
            'impedance_kohm': 10, 'polarity': 'PNP or NPN',
            'terminals': ['24V', 'COM', 'DI'],
            'notes': 'External supply 24 V, 1 A per group.',
        },
        'DO': {
            'voltage_typ_v': 24, 'voltage_max_v': 30,
            'current_max_ma': 125, 'polarity': 'PNP',
            'terminals': ['24V', 'COM', 'DO'],
            'notes': 'Max 125 mA per DO group. External supply 24 V, 1 A per group.',
        },
        'AI': {
            'terminals': ['AI+', 'AI-', 'AGND'],
            'notes': 'Analog inputs, controller-mapped port 0-3.',
        },
        'AO': {
            'terminals': ['AO+', 'AO-'],
            'notes': 'Analog outputs, controller-mapped port 0-3.',
        },
        'SYSTEM': {
            'notes': ('System-reserved DIs owned by the controller '
                       '(modeSwitch, enableButton). Read-only from the '
                       'operator UI — do not force.'),
        },
        'FLANGE': {
            'notes': ('Tool-flange I/O on the end-effector connector. '
                       'Flange DI is PNP. Flange DO can be PNP signal-only '
                       '(≤5 mA) or NPN drive. flangeButton0 defaults to '
                       'the "Drag" function (robotDrag).'),
            'flange_di_polarity': 'PNP',
            'flange_do_modes': ['PNP signal-only (≤5 mA)', 'NPN drive'],
        },
    }

    # Wire verbs — the operator-visible spec for how I/O is read, forced,
    # and written. Two layers:
    #
    #   1. `ws` verbs: application-facing WebSocket messages the factory
    #      UI sends to the controller for testing (force override) and
    #      polling (batch read). Documented from the capture at
    #      data/estun_captures/estun_io_20260721.har.
    #
    #   2. `lua` verbs: names emitted INSIDE a saved Lua project so a
    #      running program can flip DO / read DI / (etc.). Documented
    #      verbatim from the controller's own
    #      /webmodel/cocontrol/luaeditor/luaenginelib.json (168-entry
    #      Lua template library), captured in
    #      data/estun_captures/estun_lua_io_v2_20260721.har.
    #
    # Every string here is the exact spelling the controller uses.
    _IO_VERBS = {
        # -------------------- WebSocket / testing side --------------------
        'enumerate': {
            'ty': 'IOManager/GetIOInfo',
            'layer': 'ws',
            'request':  {'ty': 'IOManager/GetIOInfo', 'db': '', 'id': '<client_id>'},
            'response': {'ty': 'IOManager/GetIOInfo', 'db':
                {'DI': [{'port': 0, 'defaultName': 'DI0', 'name': 'DI0',
                         'forced': 0, 'function': None}],
                 'DO': [{'port': 0, 'defaultName': 'DO0', 'name': 'DO0',
                         'forced': 0, 'function': None}],
                 'AI': [{'port': 0, 'defaultName': 'AI0', 'name': 'AI0',
                         'forced': 0, 'function': None}],
                 'AO': [{'port': 0, 'defaultName': 'AO0', 'name': 'AO0',
                         'forced': 0, 'function': None}]}},
            'notes': 'Wire-verified. Full enumeration of all 4 kinds.',
        },
        'read': {
            'ty': 'IOManager/GetIOValue',
            'layer': 'ws',
            'request':  {'ty': 'IOManager/GetIOValue',
                         'db': [{'type': 'DI', 'port': 0}],
                         'id': '<client_id>'},
            'response': {'ty': 'IOManager/GetIOValue',
                         'db': [{'type': 'DI', 'port': 0, 'value': 0}]},
            'cadence_ms_median': 500,
            'notes': 'Wire-verified. Batch read; mixed-kind batches legal by shape.',
        },
        'force': {
            'ty': 'IOManager/SetIOForcedFlag',
            'layer': 'ws',
            'request':  {'ty': 'IOManager/SetIOForcedFlag',
                         'db': {'port': 2, 'value': 1, 'type': 'DI'},
                         'id': '<client_id>'},
            'response': {'ty': 'IOManager/SetIOForcedFlag', 'db': None},
            'wire_types_seen': ['DI'],
            'notes': ('Wire-verified for type:"DI" only. type:"DO" '
                       'is SPEC-CONSISTENT but unverified; must be '
                       'exercised live before opening the gate for DO force.'),
        },
        'unforce': {
            'ty': 'IOManager/SetIOForcedFlag?  (unverified)',
            'layer': 'ws',
            'notes': 'SOURCE-ONLY — no unforce/release call ever observed.',
        },
        # -------------------- Lua / program-execution side ----------------
        # All entries below are keys in luaenginelib.json — the
        # controller's Lua template library. Exact spellings.
        'lua_movJ': {
            'ty': 'movJ',
            'layer': 'lua',
            'signature': 'movJ(p1, {v=..., a=..., b=..., rb=..., coor=..., tool=..., search=..., onpercent=...})',
            'notes': 'Wire-verified. Emitted by program_ops.codegen_lua_from_program.',
        },
        'lua_movL': {
            'ty': 'movL',
            'layer': 'lua',
            'signature': 'movL(p1, {v=..., a=..., b=..., rb=..., coor=..., tool=..., search=..., onpercent=...})',
            'notes': 'Wire-verified. Not yet emitted (motion codegen only emits movJ).',
        },
        'lua_setDO': {
            'ty': 'setDO',
            'layer': 'lua',
            'signature': 'setDO(port, value)',
            'notes': ('Wire-verified. Emitted for set_io steps whose '
                       'io_id starts with "DO". value coerced to 0/1.'),
        },
        'lua_setAO': {
            'ty': 'setAO',
            'layer': 'lua',
            'signature': 'setAO(port, value)',
            'notes': ('Wire-verified. Emitted for set_io steps whose '
                       'io_id starts with "AO".'),
        },
        'lua_getDI': {
            'ty': 'getDI',
            'layer': 'lua',
            'signature': 'val = getDI(port)',
            'notes': ('Wire-verified. Emitted for wait_input steps as '
                       'a bare read: `_diN = getDI(port)`. A blocking '
                       'wait-until-value pattern would compose with '
                       'waitCondition, which has an undocumented timeout '
                       'unit — not emitted.'),
        },
        'lua_getDO': {
            'ty': 'getDO',
            'layer': 'lua',
            'signature': 'val = getDO(port)',
            'notes': 'Wire-verified. Not yet emitted.',
        },
        'lua_getAI': {
            'ty': 'getAI',
            'layer': 'lua',
            'signature': 'val = getAI(port)',
            'notes': 'Wire-verified. Not yet emitted.',
        },
        'lua_delay': {
            'ty': '<absent>',
            'layer': 'lua',
            'signature': 'res = waitCondition(condition, timeout)  (only wait-shaped verb)',
            'notes': ('DEFINITIVELY ABSENT. Full audit of luadoc.json '
                       '(11 placeholder keys) and luaenginelib.json '
                       '(168 verbs) turned up NO plain sleep/wait/'
                       'delay/pause/tick/timer verb. Zero uses of '
                       '"ms", "sec", "second", or "millisec" anywhere '
                       'in any template or example. The only wait-'
                       'shaped primitives are waitCondition, '
                       'waitConnectSocketServer, waitConveyorObj — '
                       'all take a `timeout` whose unit is not '
                       'documented. codegen emits `-- skipped` for '
                       '`action == "wait"` until a save-shape capture '
                       'of the factory UI Wait node lands.'),
        },
    }

    # ------------------------------------------------------------------
    # CC10-A physical plate — silkscreen-accurate terminal layout.
    #
    # Each `plate` block is one physical connector on the controller
    # back panel. Terminals are listed in silkscreen order so the UI
    # can render them as a real wiring diagram. Terminal `role` field:
    #   signal   — a channel operators can assign (DI/DO/AI/AO/HDI)
    #   power    — 24V / 12V rails
    #   return   — 0V / GND / COM / AGND
    #   bus      — CAN / RS-485
    #   control  — ON / OFF / EN
    #   safety   — VO / ES / CH terminals
    #   aux      — FUSE, misc
    # Signal terminals additionally carry `kind` + `port`.
    # ------------------------------------------------------------------
    # ────────────────────────────────────────────────────────────
    # Physical-plate terminal builders — v3 layout (2026-07-22)
    #
    # Every card mirrors the CC10-A back panel silkscreen 1:1 so an
    # operator at the cabinet can count connectors left→right and
    # match the screen. Two ordering rules matter:
    #
    #   1. DI / DO signal rows carry `pair_tag` = the return terminal
    #      the operator physically lands the return wire on (0V for
    #      DI-A / DO-A, 24V for DI-B / DO-B). The frontend renders
    #      pair_tag as a small right-side chip on each row.
    #
    #   2. M-FUNC and PWR banks use `layout: 'pair-rows'` blocks where
    #      each row is a [left, right] terminal pair — verbatim from
    #      the silkscreen (not the logical order the earlier v1/v2
    #      renderer used).
    # ────────────────────────────────────────────────────────────

    def _mfunc_cell(name, role, **extra):
        return {'name': name, 'role': role, **extra}

    def _plate_mfunc_pair_rows():
        """8 rows, 2 columns — silkscreen order left→right, top→bottom.
        HDI1-4 stay as signal terminals so the toggle + live pill still
        light up on those cells."""
        return [
            [_mfunc_cell('CAN+',   'bus'),     _mfunc_cell('485A1',  'bus')],
            [_mfunc_cell('CAN-',   'bus'),     _mfunc_cell('485B1',  'bus')],
            [_mfunc_cell('ON/OFF', 'control'), _mfunc_cell('485A2',  'bus')],
            [_mfunc_cell('12V',    'power'),   _mfunc_cell('485B2',  'bus')],
            [_mfunc_cell('COM',    'return'),  _mfunc_cell('EN',     'control')],
            [_mfunc_cell('HDI1',   'signal', kind='HDI', port=1),
             _mfunc_cell('HDI2',   'signal', kind='HDI', port=2)],
            [_mfunc_cell('COM2',   'return'),  _mfunc_cell('COM2',   'return')],
            [_mfunc_cell('HDI3',   'signal', kind='HDI', port=3),
             _mfunc_cell('HDI4',   'signal', kind='HDI', port=4)],
        ]

    def _plate_di_a_terminals():
        """DI0..DI7 — SINK wiring, each row paired with 0V (rendered as
        a small right-side tag on each row)."""
        return [{'name': f'DI{i}', 'role': 'signal', 'kind': 'DI',
                 'port': i, 'pair_tag': '0V'}
                for i in range(8)]

    def _plate_di_b_terminals():
        """DI8..DI15 — SOURCE wiring, each row paired with 24V."""
        return [{'name': f'DI{i}', 'role': 'signal', 'kind': 'DI',
                 'port': i, 'pair_tag': '24V'}
                for i in range(8, 16)]

    def _plate_do_a_terminals():
        """DO0..DO7 — PNP output, each row's load returns to 0V."""
        return [{'name': f'DO{i}', 'role': 'signal', 'kind': 'DO',
                 'port': i, 'pair_tag': '0V'}
                for i in range(8)]

    def _plate_do_b_terminals():
        """DO8..DO15 — PNP output, each row's load returns to 24V."""
        return [{'name': f'DO{i}', 'role': 'signal', 'kind': 'DO',
                 'port': i, 'pair_tag': '24V'}
                for i in range(8, 16)]

    def _plate_pwr_rail_pair_rows():
        """Standalone 24V|0V power connector — 8 rows, 2 columns.
        Rendered between DI-A / DI-B (slot 3) and between DO-A / DO-B
        (slot 7) on the physical panel."""
        return [[
            _mfunc_cell('24V', 'power'),
            _mfunc_cell('0V',  'return'),
        ] for _ in range(8)]

    def _plate_pwrcfg_pair_rows():
        """PWR CFG connector — 4 rows + FUSE aux."""
        return [
            [_mfunc_cell('COM1', 'return'),  _mfunc_cell('0V',  'return')],
            [_mfunc_cell('24V',  'power'),   _mfunc_cell('0V',  'return')],
            [_mfunc_cell('24V',  'power'),   _mfunc_cell('0V',  'return')],
            [_mfunc_cell('GND',  'return'),  _mfunc_cell('0V',  'return')],
        ]

    def _plate_aio_sections():
        """One AI/O connector, silkscreened top→bottom: AO 0-3 then AI 0-3.
        Each row is AOn|AGNDn (or AIn|AGND{n+4}) — a signal terminal
        paired with its dedicated analog-ground return on the same row."""
        ao_rows = [[
            _mfunc_cell(f'AO{i}',    'signal', kind='AO', port=i,
                        pair_tag=f'AGND{i}'),
            _mfunc_cell(f'AGND{i}',  'return'),
        ] for i in range(4)]
        ai_rows = [[
            _mfunc_cell(f'AI{i}',        'signal', kind='AI', port=i,
                        pair_tag=f'AGND{i + 4}'),
            _mfunc_cell(f'AGND{i + 4}',  'return'),
        ] for i in range(4)]
        return [
            {'label': 'AO 0-3', 'rows': ao_rows},
            {'label': 'AI 0-3', 'rows': ai_rows},
        ]

    def _plate_safety_terminals():
        """Safety I/O terminals — order matches the CC10-A silkscreen
        top→bottom (v3, 2026-07-22): VO2± / VO1± / ES4B± down to
        ES1A± / CHA / CHB."""
        ts = [
            {'name': 'VO2+', 'role': 'safety'},
            {'name': 'VO2-', 'role': 'safety'},
            {'name': 'VO1+', 'role': 'safety'},
            {'name': 'VO1-', 'role': 'safety'},
        ]
        # ES4B, ES4A, ES3B, ES3A, ES2B, ES2A, ES1B, ES1A — descending.
        for i in (4, 3, 2, 1):
            for ch in ('B', 'A'):
                ts.append({'name': f'ES{i}{ch}+', 'role': 'safety'})
                ts.append({'name': f'ES{i}{ch}-', 'role': 'safety'})
        ts.append({'name': 'CHA', 'role': 'safety'})
        ts.append({'name': 'CHB', 'role': 'safety'})
        return ts

    def _plate_flange_terminals():
        # Software-enumerated (from IOManager/GetIOInfo) but NOT on the
        # CC10-A back panel — these ride the tool-flange connector on
        # the arm end. Kept separate so the plate view stays accurate.
        return [
            {'name': 'modeSwitch',    'role': 'signal', 'kind': 'DI', 'port': 16,
             'default_name': 'modeSwitch',   'sw_group': 'system'},
            {'name': 'enableButton',  'role': 'signal', 'kind': 'DI', 'port': 17,
             'default_name': 'enableButton', 'sw_group': 'system'},
            {'name': 'flangeButton0', 'role': 'signal', 'kind': 'DI', 'port': 18,
             'default_name': 'Drag', 'function': ['robotDrag', 0, None]},
            {'name': 'flangeButton1', 'role': 'signal', 'kind': 'DI', 'port': 19,
             'default_name': 'flangeButton1'},
            {'name': 'flangeButton2', 'role': 'signal', 'kind': 'DI', 'port': 20,
             'default_name': 'flangeButton2'},
            {'name': 'flangeButton3', 'role': 'signal', 'kind': 'DI', 'port': 21,
             'default_name': 'flangeButton3'},
            {'name': 'flangeDI0',     'role': 'signal', 'kind': 'DI', 'port': 22,
             'default_name': 'flangeDI0'},
            {'name': 'flangeDI1',     'role': 'signal', 'kind': 'DI', 'port': 23,
             'default_name': 'flangeDI1'},
            {'name': 'flangeDO0',     'role': 'signal', 'kind': 'DO', 'port': 16,
             'default_name': 'flangeDO0'},
            {'name': 'flangeDO1',     'role': 'signal', 'kind': 'DO', 'port': 17,
             'default_name': 'flangeDO1'},
        ]

    def _io_map_default_plate():
        """Physical CC10-A back panel — v3 layout (2026-07-22).

        Nine cards in exact left→right silkscreen order. Each carries
        a `slot` (1-9) so the frontend can render a position badge —
        the operator counts connectors at the cabinet and matches to
        the screen 1:1.

        Layout hints:
          layout='pair-rows'   → block carries `pair_rows` (list of
                                  [left_terminal, right_terminal])
                                  and NO flat `terminals`.
          layout='sections'    → block carries `sections`
                                  ([{label, rows}, ...]).
          default (signals)    → block carries flat `terminals`.

        The SAFETY card is the 10th block (kept below the row per the
        v2 declutter — safety-PLC domain, not operator-actuated)."""
        return [
            {'id': 'MFUNC',  'slot': 1, 'kind': 'M-FUNC', 'group': 'system',
             'label': 'M-Func',
             'layout': 'pair-rows',
             'pair_rows': _plate_mfunc_pair_rows(),
             'notes': ('High-speed inputs HDI1-4, CAN bus, dual RS-485, '
                        'ON/OFF, 12V/COM, EN, COM2.')},
            {'id': 'DI-A',   'slot': 2, 'kind': 'DI', 'group': 'general',
             'label': 'DI 0-7',
             'wiring': {'mode': 'sink', 'return_rail': '0V'},
             'terminals': _plate_di_a_terminals(),
             'notes': ('Sink wiring — sensor pulls DIn LOW through 0V to signal ON. '
                       'Manual is PNP/NPN capable; each row lands its return on 0V.')},
            {'id': 'PWR-A',  'slot': 3, 'kind': 'PWR-CFG', 'group': 'system',
             'label': 'Power (DI rail)',
             'layout': 'pair-rows',
             'pair_rows': _plate_pwr_rail_pair_rows(),
             'notes': ('Dedicated 24V|0V connector between the two DI banks — '
                       'silkscreen shows 8 rows of 24V|0V terminals.')},
            {'id': 'DI-B',   'slot': 4, 'kind': 'DI', 'group': 'general',
             'label': 'DI 8-15',
             'wiring': {'mode': 'source', 'return_rail': '24V'},
             'terminals': _plate_di_b_terminals(),
             'notes': ('Source wiring — sensor pulls DIn HIGH from 24V to signal ON. '
                       'Manual is PNP/NPN capable; each row lands its return on 24V.')},
            {'id': 'PWRCFG', 'slot': 5, 'kind': 'PWR-CFG', 'group': 'system',
             'label': 'Power / Fuse',
             'layout': 'pair-rows',
             'pair_rows': _plate_pwrcfg_pair_rows(),
             'aux': [{'name': 'FUSE', 'role': 'aux'}],
             'notes': 'External 24V field supply + system 0V/GND + FUSE lug.'},
            {'id': 'DO-A',   'slot': 6, 'kind': 'DO', 'group': 'general',
             'label': 'DO 0-7',
             'wiring': {'mode': 'sink', 'return_rail': '0V'},
             'terminals': _plate_do_a_terminals(),
             'notes': ('PNP outputs, 125 mA per group — load between DOn and 0V rail.')},
            {'id': 'PWR-B',  'slot': 7, 'kind': 'PWR-CFG', 'group': 'system',
             'label': 'Power (DO rail)',
             'layout': 'pair-rows',
             'pair_rows': _plate_pwr_rail_pair_rows(),
             'notes': ('Dedicated 24V|0V connector between the two DO banks — '
                       'silkscreen shows 8 rows of 24V|0V terminals.')},
            {'id': 'DO-B',   'slot': 8, 'kind': 'DO', 'group': 'general',
             'label': 'DO 8-15',
             'wiring': {'mode': 'source', 'return_rail': '24V'},
             'terminals': _plate_do_b_terminals(),
             'notes': ('PNP outputs, 125 mA per group — load between DOn and 24V rail.')},
            {'id': 'AIO',    'slot': 9, 'kind': 'A-IO', 'group': 'analog',
             'label': 'Analog I/O',
             'layout': 'sections',
             'sections': _plate_aio_sections(),
             'notes': ('One connector, silkscreened AO 0-3 on top, AI 0-3 below. '
                       'Each row is AOn|AGNDn (or AIn|AGND{n+4}) — signal paired '
                       'with its own analog ground.')},
            {'id': 'SAFETY', 'slot': None, 'kind': 'SAFETY', 'group': 'safety',
             'label': 'Safety I/O',
             'terminals': _plate_safety_terminals(),
             'notes': ('VO1± / VO2± voltage-monitored outputs, ES1-ES4 '
                        'dual-channel A/B E-stop inputs, CHA/CHB charge test.')},
        ]

    def _io_map_default_flange():
        return {
            'id':    'FLANGE',
            'kind':  'FLANGE',
            'group': 'flange',
            'label': 'Tool Flange Connector (arm-end)',
            'terminals': _plate_flange_terminals(),
            'notes': ('Software-enumerated via IOManager/GetIOInfo but '
                       'NOT on the CC10-A back-panel plate — these ride '
                       'the tool-flange connector on the arm.'),
        }

    # ------------------------------------------------------------------
    # Blocks view (derived) — the compact functional-group summary that
    # the older v3 renderer consumed. Kept alongside the plate so
    # consumers who only need per-channel data (like computeLineMap in
    # the frontend) don't need to walk terminals.
    # ------------------------------------------------------------------
    def _iter_block_terminals(src: dict):
        """Yield every terminal in any layout — flat `terminals`,
        `pair_rows` (M-FUNC + PWR banks), or `sections` (AI/O).
        Callers that only care about signal ports don't need to
        branch on block.layout — this hides the shape difference."""
        if isinstance(src.get('terminals'), list):
            yield from src['terminals']
        for row in src.get('pair_rows') or []:
            for cell in row:
                if isinstance(cell, dict):
                    yield cell
        for section in src.get('sections') or []:
            for row in section.get('rows') or []:
                for cell in row:
                    if isinstance(cell, dict):
                        yield cell
                for cell in section.get('terminals') or []:
                    if isinstance(cell, dict):
                        yield cell

    def _io_map_derive_blocks(plate: list, flange: dict) -> list:
        blocks = []
        for src in list(plate) + [flange]:
            signals = [t for t in _iter_block_terminals(src) if t.get('role') == 'signal']
            if not signals:
                continue
            rows = [{
                'port':         t.get('port'),
                'ch':           t['name'],
                'default_name': t.get('default_name', t['name']),
                'function':     t.get('function'),
                'kind':         t.get('kind', src['kind']),
            } for t in signals]
            blocks.append({
                'id':       src['id'],
                'kind':     src['kind'],
                'group':    src.get('group'),
                'label':    src['label'],
                'channels': [r['ch'] for r in rows],
                'rows':     rows,
                'readonly': src.get('group') == 'system',
            })
        return blocks

    def _io_map_default_ports(plate: list, flange: dict) -> dict:
        ports: dict = {}
        for src in list(plate) + [flange]:
            for t in _iter_block_terminals(src):
                if t.get('role') != 'signal':
                    continue
                name = t['name']
                dn = t.get('default_name', name)
                sysflg = src.get('group') in ('system', 'flange', 'safety')
                ports[name] = {
                    'assignment': dn if sysflg else 'Unassigned',
                    'in_use':     sysflg,
                    'notes':      '',
                }
        return ports

    def _io_map_default() -> dict:
        plate  = _io_map_default_plate()
        flange = _io_map_default_flange()
        return {
            'version':     _IO_MAP_VERSION,
            'provisional': False,
            'nameplate':   dict(_IO_NAMEPLATE),
            'sources':     dict(_IO_SOURCES),
            # `plate` is the primary rendering source (physical view).
            'plate':       plate,
            'flange':      flange,
            # `blocks` is the derived functional-group view (kept for
            # backward compat with the older frontend renderer).
            'blocks':      _io_map_derive_blocks(plate, flange),
            'specs':       copy.deepcopy(_IO_SPECS),
            'verbs':       copy.deepcopy(_IO_VERBS),
            'ports':       _io_map_default_ports(plate, flange),
        }

    def _io_map_reconcile(state: dict) -> dict:
        """Enforce the current v4 plate/flange/nameplate/specs/verbs on
        any incoming state. Only per-channel operator metadata
        (assignment / in_use / notes) is carried forward — everything
        else is authoritative from the physical plate silkscreen +
        controller captures."""
        default = _io_map_default()
        prior_ports = dict(state.get('ports') or {})
        state['version']     = _IO_MAP_VERSION
        state['provisional'] = False
        state['nameplate']   = default['nameplate']
        state['sources']     = default['sources']
        state['plate']       = default['plate']
        state['flange']      = default['flange']
        state['blocks']      = default['blocks']
        state['specs']       = default['specs']
        state['verbs']       = default['verbs']
        merged = dict(default['ports'])
        for ch, row in prior_ports.items():
            if ch not in merged or not isinstance(row, dict):
                continue
            for k in ('assignment', 'in_use', 'notes'):
                if k in row:
                    merged[ch][k] = row[k]
        state['ports'] = merged
        # Drop legacy fields the older schema emitted.
        for k in ('analog_input_count', 'analog_output_count', 'source'):
            state.pop(k, None)
        return state

    def _io_map_migrate_from_older(old: dict) -> dict:
        """v1 flat / v2 blocks / v3 functional-group → v4 plate.
        Preserves operator assignments/notes for any channel whose
        name still exists in the current plate + flange."""
        new = _io_map_default()
        old_ports = old.get('ports') or {}
        for ch, row in old_ports.items():
            if ch in new['ports'] and isinstance(row, dict):
                for k in ('assignment', 'in_use', 'notes'):
                    if k in row:
                        new['ports'][ch][k] = row[k]
        return new

    def _io_map_load() -> dict:
        if os.path.isfile(_IO_MAP_PATH):
            try:
                with open(_IO_MAP_PATH) as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    ver = int(d.get('version') or 1)
                    if ver >= _IO_MAP_VERSION \
                            and isinstance(d.get('plate'), list) \
                            and isinstance(d.get('flange'), dict):
                        return _io_map_reconcile(d)
                    return _io_map_migrate_from_older(d)
            except Exception:
                pass
        return _io_map_default()

    def _io_map_save(state: dict) -> tuple:
        try:
            os.makedirs(os.path.dirname(_IO_MAP_PATH), exist_ok=True)
            tmp = _IO_MAP_PATH + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(state, f, indent=2)
            os.replace(tmp, _IO_MAP_PATH)
            return True, None
        except Exception as e:
            return False, str(e)

    @app.get("/api/io/portmap")
    async def api_io_portmap_get():
        return _io_map_load()

    @app.put("/api/io/portmap")
    async def api_io_portmap_put(request: Request):
        """Accepts per-channel operator metadata patches only.
        Block structure + channel membership are authoritative from
        the controller's IOManager/GetIOInfo enumeration and are not
        editable via this endpoint. Any `blocks` field in the incoming
        body is silently ignored (older frontend compat)."""
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)
        cur = _io_map_load()
        incoming_ports = body.get('ports')
        if isinstance(incoming_ports, dict):
            cur_ports = dict(cur.get('ports') or {})
            for pid, meta in incoming_ports.items():
                if not isinstance(meta, dict):
                    continue
                # Never let a PUT create a channel that isn't in the
                # verified inventory — it would be invisible in the UI
                # and would drift out of sync on the next reconcile.
                if pid not in cur_ports:
                    continue
                row = dict(cur_ports[pid])
                if 'assignment' in meta:
                    row['assignment'] = str(meta['assignment'])[:80]
                if 'in_use' in meta:
                    row['in_use'] = bool(meta['in_use'])
                if 'notes' in meta:
                    row['notes'] = str(meta['notes'])[:400]
                cur_ports[pid] = row
            cur['ports'] = cur_ports
        cur['version'] = _IO_MAP_VERSION
        cur = _io_map_reconcile(cur)
        ok, err = _io_map_save(cur)
        if not ok:
            return JSONResponse({"error": err}, status_code=500)
        return {"ok": True, "portmap": cur}

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
        # s10-140-full.urdf: full articulating twin built from the
        # calibrated CS-frame dump. Six revolute joints, per-link
        # meshes baked to link-local frames (identity visual origins),
        # Y-up native (three.js frame — viewer applies NO tilt).
        # link_5 has no mesh yet (wrist2 re-export pending); joint_5
        # still articulates the downstream flange. s10-140-partial,
        # s10-140-hybrid, s10-140-real, and the canonical provisional
        # URDF stay on disk as fallbacks.
        return _serve_robot_asset('s10-140-full.urdf', 'application/xml')

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
        path = _prog_read_path(prog_id)
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
        path = _prog_read_path(prog_id)
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

    @app.get("/api/programs/{prog_id}/motion_check")
    async def api_program_motion_check(prog_id: str):
        """Return the analyzer's MotionCheckReport for a program.
        Consumed by the Motion Check panel in the editor. Pure read
        endpoint — never mutates the program or /opt/cobot/programs/*.
        See src/estun_driver/estun_driver/program_ops.py analyze_program
        for the shape of `findings`, `adaptations`, and `metrics`."""
        path = _prog_read_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "program not found"}, status_code=404)
        try:
            with open(path) as fp:
                prog = json.load(fp)
        except Exception as e:
            return JSONResponse({"error": f"read failed: {e}"}, status_code=500)
        try:
            from estun_driver import program_ops
        except Exception as e:
            return JSONResponse({"error": f"program_ops import: {e}"},
                                status_code=500)
        # Best-effort load of the parts library — enables rule 3b
        # (approach-below-part-height). When missing, the analyzer
        # simply skips that rule.
        part_index = None
        parts_path = '/opt/cobot/parts/index.json'
        if os.path.isfile(parts_path):
            try:
                with open(parts_path) as fp:
                    part_index = json.load(fp)
            except Exception:
                part_index = None
        try:
            rep = program_ops.analyze_program(prog, part_index=part_index)
        except Exception as e:
            return JSONResponse({"error": f"analyzer: {e}"}, status_code=500)
        # Adaptation dict has integer keys; JSON needs string keys.
        rep['adaptations'] = {str(k): v for k, v in rep['adaptations'].items()}
        rep['program_id'] = prog_id
        return rep

    @app.get("/api/programs/{prog_id}/line_map")
    async def api_program_line_map(prog_id: str):
        """Return the D9 line_map for a program: one entry per step
        with `{step_idx, step_id, action, lua_line_start,
        lua_line_end}` plus the codegen sha the map was generated
        against. Consumed by the Monitor's live step-highlight —
        joins ProjectState.line to step_id without regex heuristics
        against emitted comments.

        Read path: sidecar `<prog_id>.line_map.json` (written on
        every save). If the sidecar is missing (older program or
        a race), regenerate on demand and stash it. Honesty
        contract: `codegen_sha` in the response is the sha that
        AUTHORED the map — the client must compare against the
        RESIDENT program's codegen sha (from the /ws/state
        robot.program.codegen_sha wire) before highlighting; a
        mismatch means the resident Lua doesn't match this map."""
        prog_path = _prog_read_path(prog_id)
        if not prog_path or not os.path.isfile(prog_path):
            return JSONResponse({"error": "program not found"},
                                status_code=404)
        sc_path = _line_map_sidecar_path(prog_id)
        # Prefer cached sidecar (written on save).
        if os.path.isfile(sc_path):
            try:
                with open(sc_path) as fp:
                    return json.load(fp)
            except Exception:
                pass  # regenerate below on parse error
        # Regenerate on demand — first read after a fresh deploy or
        # for programs saved before the sidecar existed.
        try:
            with open(prog_path) as fp:
                prog = json.load(fp)
        except Exception as e:
            return JSONResponse({"error": f"read failed: {e}"},
                                status_code=500)
        sidecar = _compute_and_save_line_map(prog)
        if sidecar is None:
            return JSONResponse({"error": "cannot compute line_map"},
                                status_code=500)
        return sidecar

    @app.get("/api/programs/{prog_id}/pallet_slots")
    async def api_program_pallet_slots(prog_id: str):
        """Return per-slot derived TCPs for the 3D twin's ghost
        markers (2026-08-06 §2). Consumed by the 3D View's pallet
        overlay; renders slot positions relative to the anchor so an
        operator SEES the grid where it will land before running.

        Response shape:
            {
              "program_id": str,
              "pallet_place": {                # one block per pallet step;
                                                # today at most one per program
                "step_id":     int,
                "anchor_step_id": int,
                "anchor_tcp_mm": [x, y, z, rx, ry, rz] | None,
                                                # None when anchor hasn't been
                                                # taught yet — 3D can't ghost
                                                # without a real anchor pose
                "spec":        PalletPlaceSpec.to_dict(),
                "slots":       [ {index, row, col, layer, tcp_mm}, ... ]
              } | null,
              "reachability": ReachabilitySweepReport | null,
            }
        Pure read endpoint. Any pallet_slot step without an anchor pose
        returns anchor_tcp_mm=null and empty slots — the UI overlays
        a "teach the anchor first" hint instead of ghost markers.
        """
        path = _prog_read_path(prog_id)
        if not path or not os.path.isfile(path):
            return JSONResponse({"error": "program not found"}, status_code=404)
        try:
            with open(path) as fp:
                prog = json.load(fp)
        except Exception as e:
            return JSONResponse({"error": f"read failed: {e}"}, status_code=500)
        # Find the pallet anchor step (position_role='place', has
        # pallet_slot with index=0). Its `taught_tcp` — populated
        # after the operator teaches — is what we anchor the slot
        # grid to. Anchor's `pallet_slot` also carries the spec
        # indirectly (row=0,col=0,layer=0 slot); the SPEC itself lives
        # on the source intent, but we can reconstruct pitch + axes
        # from the second slot's iter_offset_mm if the anchor's own
        # spec isn't stored. For now, we read the spec off the FIRST
        # linked slot's step (any i>0) since composer stamps
        # iter_offset_mm there — plus the 'pallet_slot' metadata.
        steps = prog.get('steps') or []
        anchor = None
        for s in steps:
            ps = s.get('pallet_slot') or {}
            if ps.get('index') == 0 and s.get('position_role') == 'place':
                anchor = s
                break
        if anchor is None:
            return {"program_id": prog_id, "pallet_place": None,
                    "reachability": None}

        # Collect linked slots (index > 0) — each carries iter_offset_mm
        # already; we still recompute from spec for reachability +
        # canonical ordering.
        slot_steps = [s for s in steps if s.get('pallet_slot') is not None]

        # Locate the source spec — programs saved with pallet_place
        # store it under config.pallet_place; if absent, reconstruct
        # from step count + iter_offset_mm on slot 1 (defensive).
        cfg = prog.get('config') or {}
        spec_dict = cfg.get('pallet_place')

        # Legacy migration (2026-07-30 cleanup): pre-taught-frame
        # programs stored a single corner_tcp on config.pallet as
        # a {x,y,z,rx,ry,rz} dict. Seed corner_a_tcp from that so
        # a legacy program renders "A taught" honestly on the
        # frame status; the modal cleanup MUST NOT lose the
        # operator's already-captured corner.
        legacy_pallet = cfg.get('pallet') or {}
        legacy_corner = legacy_pallet.get('corner_tcp')
        def _legacy_corner_as_tcp(d):
            if not isinstance(d, dict): return None
            try:
                return [float(d.get('x') or 0), float(d.get('y') or 0),
                        float(d.get('z') or 0), float(d.get('rx') or 0),
                        float(d.get('ry') or 0), float(d.get('rz') or 0)]
            except (TypeError, ValueError):
                return None
        if isinstance(spec_dict, dict):
            if not spec_dict.get('corner_a_tcp'):
                migrated = _legacy_corner_as_tcp(legacy_corner)
                if migrated is not None:
                    spec_dict = dict(spec_dict)
                    spec_dict['corner_a_tcp'] = migrated
        if not spec_dict:
            # Legacy path: derive from the highest slot's metadata.
            max_r = max((s['pallet_slot']['row']   for s in slot_steps), default=0)
            max_c = max((s['pallet_slot']['col']   for s in slot_steps), default=0)
            max_l = max((s['pallet_slot']['layer'] for s in slot_steps), default=0)
            iter_off = None
            for s in slot_steps:
                if s['pallet_slot']['index'] == 1 and 'iter_offset_mm' in s:
                    iter_off = s['iter_offset_mm']
                    break
            spec_dict = {
                'rows':   max_r + 1,
                'cols':   max_c + 1,
                'layers': max_l + 1,
                'pitch_row_mm': (iter_off or {}).get('dx', 0.0),
                'pitch_col_mm': (iter_off or {}).get('dy', 0.0),
                'layer_height_mm': (iter_off or {}).get('dz', 0.0) if max_l else None,
                'row_axis': '+X', 'col_axis': '+Y', 'order': 'snake',
            }

        # Anchor TCP — taught contact populates taught_tcp after
        # perception resolves it; if still awaiting, we return null.
        anchor_tcp = anchor.get('taught_tcp')
        try:
            from programming_by_demonstration.schema import PalletPlaceSpec
            from programming_by_demonstration.pallet_geometry import (
                derive_slot_tcps, reachability_sweep,
                compute_frame, validate_frame, measured_pitches,
            )
        except Exception as e:
            return JSONResponse(
                {"error": f"pallet_geometry import: {e}"}, status_code=500)
        spec = PalletPlaceSpec.from_dict(spec_dict)
        # anchor_tcp is METERS + RADIANS (canonical taught_tcp
        # unit, matches driver tcp_m). pallet_geometry now works
        # entirely in meters (unit-mismatch fix, 2026-08-04) —
        # derive_slot_tcps produces `tcp_m` in the same unit.
        # This endpoint's DOCUMENTED response shape carries
        # `tcp_mm` for the 3D twin's rendering layer, so we
        # convert meters → mm at THIS boundary.
        slots = []
        slots_mm = []
        if isinstance(anchor_tcp, list) and len(anchor_tcp) >= 6:
            anchor_tuple = tuple(float(v) for v in anchor_tcp[:6])
            slots = derive_slot_tcps(spec, anchor_tuple)
            for s in slots:
                tcp_m = s.get('tcp_m') or [0, 0, 0, 0, 0, 0]
                slots_mm.append({
                    'index': s['index'],
                    'row':   s['row'],
                    'col':   s['col'],
                    'layer': s['layer'],
                    # Convert XYZ meters → mm for the twin.
                    # Orientation (rx/ry/rz) stays radians on the
                    # wire; the frontend renderer decides display.
                    'tcp_mm': [tcp_m[0] * 1000.0,
                               tcp_m[1] * 1000.0,
                               tcp_m[2] * 1000.0,
                               tcp_m[3], tcp_m[4], tcp_m[5]],
                })
        reach = None
        anchor_joints = anchor.get('taught_joints')
        if (isinstance(anchor_joints, list) and len(anchor_joints) == 6
                and all(isinstance(v, (int, float)) for v in anchor_joints)):
            try:
                reach = reachability_sweep(spec,
                                           [float(v) for v in anchor_joints])
            except Exception:
                reach = None
        # 2026-07-30: expose the taught frame + validation findings +
        # measured pitches so the twin can render slot ghosts in the
        # actual pallet frame AND the wizard can surface validation
        # (near-parallel B/C, tilt, pitch mismatch) without
        # re-implementing the math on the frontend.
        frame = compute_frame(spec)
        frame_serialisable = {
            'row_axis':          list(frame['row_axis']),
            'col_axis':          list(frame['col_axis']),
            'plane_normal':      list(frame['plane_normal']),
            'tilt_deg':          frame['tilt_deg'],
            'row_col_angle_deg': frame['row_col_angle_deg'],
            'source':            frame['source'],
        }
        # measured_pitches returns METERS. Convert to mm at this
        # endpoint's response boundary — the twin + wizard
        # readouts label the value in mm.
        m_row_m, m_col_m = measured_pitches(spec)
        m_row = (m_row_m * 1000.0) if m_row_m is not None else None
        m_col = (m_col_m * 1000.0) if m_col_m is not None else None
        return {
            "program_id":   prog_id,
            "pallet_place": {
                "step_id":        anchor.get('id') or anchor.get('step'),
                "anchor_step_id": anchor.get('id') or anchor.get('step'),
                # anchor_tcp_mm is the endpoint's documented shape
                # (mm on the wire for the 3D twin). anchor_tcp is
                # meters internally; convert XYZ at the boundary.
                "anchor_tcp_mm":  ([anchor_tcp[0] * 1000.0,
                                    anchor_tcp[1] * 1000.0,
                                    anchor_tcp[2] * 1000.0,
                                    anchor_tcp[3], anchor_tcp[4], anchor_tcp[5]]
                                   if isinstance(anchor_tcp, list)
                                      and len(anchor_tcp) >= 6
                                   else None),
                "spec":           spec.to_dict(),
                "frame":          frame_serialisable,
                "frame_validation": validate_frame(spec),
                "measured_pitches_mm": {
                    "pitch_row_mm": m_row,
                    "pitch_col_mm": m_col,
                },
                "slots":          slots_mm,
            },
            "reachability": reach,
        }

    # ── /api/pallet/validate_frame (§465 fork-1 kill, 2026-08-04) ─
    #
    # Shared-truth endpoint the Program Editor calls during and
    # after the 3-corner pallet teach so the frontend runs NO
    # frame geometry itself. Prior to this endpoint, the frontend
    # had its own `validatePalletFrame` in palletTeachSequence.js
    # that computed row/col vectors, length, orthogonality, and
    # tilt against RAW stored `place.corner{1,2,3}_tcp` — a fork
    # of `pallet_geometry.compute_frame/validate_frame` that
    # (a) skipped the v1→v2 migration (v1 programs got silent
    # passes), (b) did no Gram-Schmidt projection, and (c) fired
    # as a passive banner mid-re-teach against half-updated
    # state. This endpoint is the single frame-truth surface;
    # the no-fork lint at test/test_no_frontend_frame_math.py
    # prevents re-introduction.
    #
    # Request body:
    #   {
    #     "place":            { any subset of PalletPlaceSpec fields
    #                           — v1 (corner_a_tcp/point_b_tcp/…)
    #                           or v2 (corner{1,2,3}_tcp/part_tcp);
    #                           from_dict does the migration },
    #     "spec_dict":        { optional — merged onto place, wins
    #                           on conflict; lets the caller nudge
    #                           rows/cols/pitch without saving },
    #     "re_teaching_role": "pallet_c1"|"pallet_c2"|"pallet_c3"
    #                       | "pallet_part"|null (default null),
    #   }
    #
    # Response:
    #   { findings:[…], blocking:bool, measured:{…}, spec:{…} }
    #
    # Findings shape per-item:
    #   { severity, code, involves_corners, message, distance_mm?,
    #     operator: { title, detail, technicalDetail } }
    #
    # Suppression: findings whose involves_corners contains the
    # role currently being re-taught are DROPPED — the operator
    # is about to replace that corner and surfacing findings that
    # cite it is noise. This is the fix for "passive banner
    # mid-re-teach against half-updated state." Findings that
    # only cite the OTHER corners still surface, with copy that
    # names the actual problem corner (not the one being
    # re-taught).
    _ROLE_TO_CORNER = {
        'pallet_c1':   'c1',
        'pallet_c2':   'c2',
        'pallet_c3':   'c3',
        'pallet_part': 'c4',
    }

    def _pallet_finding_operator_copy(f: dict, place: dict) -> dict:
        """Map a pallet_geometry finding to the 267108a-register
        toast triple {title, detail, technicalDetail}. Raw wire
        text goes to technicalDetail; operator sees the demoted
        title + detail only.

        Distance fields on findings are METERS (canon, 2026-08-04
        unit-mismatch fix). This function renders mm for the
        operator by multiplying by 1000 — the ONLY place mm
        appears on the operator surface. Findings with legacy
        `distance_mm` (from a pre-fix caller) are read as a
        fallback with an in-place assumption that the value was
        already meters (matching the pre-fix behavior of the
        pallet_geometry code that generated it)."""
        code = f.get('code') or ''
        involves = f.get('involves_corners') or []
        # Canon: distance_m (meters). Legacy: distance_mm — which
        # HELD meters values before this commit, so use verbatim.
        dist_m = f.get('distance_m')
        if dist_m is None:
            dist_m = f.get('distance_mm')   # legacy — was meters
        tech = f.get('message', '')
        if code == 'corner_coincident':
            pair = ' and '.join(str(int(c[1:]) or c[1:])
                                for c in involves) if involves else '?'
            dmm = (f'{dist_m*1000.0:.2f} mm'
                   if isinstance(dist_m, (int, float)) else '?')
            return {
                'title':  f'Corners {pair} are too close.',
                'detail': (f'Measured {dmm} apart — jog to the actual '
                           f'pallet corner and record again.'),
                'technicalDetail': tech,
            }
        if code == 'row_col_near_parallel':
            ang = f.get('row_col_angle_deg')
            ang_s = f'{ang:.1f}°' if isinstance(ang, (int, float)) else '?'
            return {
                'title':  'Corners 2 and 3 point in the same direction.',
                'detail': (f'Row/column angle is {ang_s} — move corner 3 '
                           f'to the OTHER pallet edge (roughly 90° from '
                           f'corner 2) and re-teach.'),
                'technicalDetail': tech,
            }
        if code == 'pallet_tilted':
            t = f.get('tilt_deg')
            t_s = f'{t:.1f}°' if isinstance(t, (int, float)) else '?'
            return {
                'title':  'Pallet frame is tilted off horizontal.',
                'detail': (f'Measured {t_s} off — check that all three '
                           f'corners were recorded on the same surface.'),
                'technicalDetail': tech,
            }
        if code == 'part_datum_needs_reteach':
            return {
                'title':  'Teach the first-part position (④).',
                'detail': ('This pallet was migrated from the older '
                           '3-point model — the first-part pose was '
                           'seeded from corner 1 as a placeholder. '
                           'Re-teach ④ with a real part in the first '
                           'slot before running.'),
                'technicalDetail': tech,
            }
        if code == 'part_datum_not_taught':
            return {
                'title':  'Teach the first-part position (④).',
                'detail': ('④ is not distinct from corner 1. Place a '
                           'real part in the first slot and record.'),
                'technicalDetail': tech,
            }
        if code == 'part_datum_far_from_corner':
            dmm = (f'{dist_m*1000.0:.1f} mm'
                   if isinstance(dist_m, (int, float)) else '?')
            return {
                'title':  'First-part position (④) is far from corner 1.',
                'detail': (f'Measured {dmm} away — is the part actually '
                           f'in the first slot?'),
                'technicalDetail': tech,
            }
        if code == 'taught_frame_missing':
            return {
                'title':  'Teach all three pallet corners to lock the frame.',
                'detail': ('Slot positions currently assume the pallet is '
                           'aligned to the robot base — re-teach the three '
                           'corners for a rotation-safe grid.'),
                'technicalDetail': tech,
            }
        # Fallback: keep the raw message as the title so nothing
        # is silently eaten.
        return {'title':  tech,
                'detail': '',
                'technicalDetail': tech}

    @app.post("/api/pallet/validate_frame")
    async def api_pallet_validate_frame(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        place = dict(body.get('place') or {})
        override = body.get('spec_dict') or {}
        if isinstance(override, dict):
            place.update(override)
        role = body.get('re_teaching_role')
        suppress = _ROLE_TO_CORNER.get(role)
        try:
            from programming_by_demonstration.schema import PalletPlaceSpec
            from programming_by_demonstration.pallet_geometry import (
                compute_frame, validate_frame, measured_pitches,
            )
        except Exception as e:
            return JSONResponse(
                {"error": f"pallet_geometry import: {e}"}, status_code=500)
        spec = PalletPlaceSpec.from_dict(place)
        raw_findings = validate_frame(spec)
        # Suppression: drop findings that involve the corner
        # currently being re-taught. When the operator is
        # replacing corner N, we do NOT nag them about corner N
        # being wrong — the very next Record replaces it.
        # Findings that mention corner N alongside OTHERS still
        # surface iff at least one non-suppressed corner is
        # named; the OPERATOR copy is generated from
        # involves_corners so it already points at the actual
        # problem corner (not the one being re-taught).
        findings = []
        for f in raw_findings:
            involves = f.get('involves_corners') or []
            if suppress and involves and all(c == suppress
                                              for c in involves):
                continue
            operator = _pallet_finding_operator_copy(f, place)
            findings.append({**f, 'operator': operator})
        # Frame-measured helpers — the client shows these next to
        # the banner-less operator toast when useful. Endpoint
        # response uses `_mm`-suffixed field names (documented
        # shape for the twin); pallet_geometry works in METERS
        # internally, so we convert m→mm at THIS boundary — the
        # ONLY place mm crosses the wire for this endpoint.
        m_row_m, m_col_m = measured_pitches(spec)   # meters
        measured = {
            'row_len_mm':   None,
            'col_len_mm':   None,
            'row_col_angle_deg': None,
            'tilt_deg':     None,
            'pitch_row_mm': (m_row_m * 1000.0) if m_row_m is not None else None,
            'pitch_col_mm': (m_col_m * 1000.0) if m_col_m is not None else None,
        }
        if spec.has_taught_frame():
            frame = compute_frame(spec)
            measured['row_col_angle_deg'] = frame['row_col_angle_deg']
            measured['tilt_deg']         = frame['tilt_deg']
            from programming_by_demonstration.pallet_geometry import (
                _xyz as _pg_xyz, _sub as _pg_sub, _len as _pg_len,
            )
            A = _pg_xyz(spec.corner1_tcp)   # meters
            B = _pg_xyz(spec.corner2_tcp)   # meters
            C = _pg_xyz(spec.corner3_tcp)   # meters
            # Convert to mm at the response boundary.
            measured['row_len_mm'] = _pg_len(_pg_sub(B, A)) * 1000.0
            measured['col_len_mm'] = _pg_len(_pg_sub(C, A)) * 1000.0
        blocking = any(f.get('severity') == 'error' for f in findings)
        return {
            'findings': findings,
            'blocking': blocking,
            'measured': measured,
            'spec':     spec.to_dict(),
        }

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

    # Lazy bind: the dashboard ROS node creates subscribers in its
    # __init__ inside main(); this module-level block runs at import
    # BEFORE main(), so `_ros_node` is still None here. Wrap the
    # registration in a callable and invoke it from `lifespan`'s
    # startup — by then main() has assigned `_ros_node`. Prior code
    # gated on `if _ros_node is not None:` at import time and silently
    # skipped, which is why the identifier subs never attached.
    if RCLPY_AVAILABLE:
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

            def _register_lidar_identifier_subs():
                # Called from lifespan startup, after main() has set
                # _ros_node. Silent no-op if the node isn't up.
                if _ros_node is None:
                    return
                _ros_node.create_subscription(
                    _LidarObjArrayMsg, '/lidar_objects/identified',
                    _ident_array_cb, 5)
                _ros_node.create_subscription(
                    _LidarStatsMsg, '/lidar_objects/stats',
                    _ident_stats_cb, 5)
        except Exception:
            # Identifier msgs not built yet — endpoints still work, just
            # serve the empty snapshot.
            def _register_lidar_identifier_subs():
                pass
    else:
        def _register_lidar_identifier_subs():
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

    @app.post("/api/cells/deactivate")
    async def api_cells_deactivate():
        """Clear active_cell_id — the cell picker's 'None' option.
        The driver's next 30s poll of /api/collision/static_zones and
        the collision_monitor's next /collision/reload will both drop
        their env-zone lists to []; robot-intrinsic guards (self-
        collision, ground plane, joint limits) are unaffected. The
        StatusBar chip flips to the amber 'No cell — environment guard
        off' state on the next 15s poll."""
        with _cell_lock:
            idx = _cells_load_index()
            was = idx.get('active_cell_id')
            idx['active_cell_id'] = None
            _cells_save_index(idx)
        # Nudge the collision_monitor to reload right away instead of
        # waiting for its next tick — the driver's 30 s poll still
        # picks it up naturally on the next cycle.
        try:
            if _ros_node is not None:
                if not hasattr(_ros_node, '_collision_reload_pub'):
                    _ros_node._collision_reload_pub = _ros_node.create_publisher(
                        String, '/collision/reload', 5)
                m = String(); m.data = json.dumps({'reason': 'deactivate'})
                _ros_node._collision_reload_pub.publish(m)
        except Exception as e:
            print(f'[cells] deactivate reload publish failed: {e}', flush=True)
        return {'ok': True, 'active_cell_id': None, 'was': was}

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
            # Bring the cloud under max_points with as LITTLE
            # downsampling as possible — the 3D View wants the
            # densest cloud the SPA buffer can hold. The old loop
            # used a 1.6× voxel step which overshoots aggressively
            # (e.g. requesting 80 k from a 529 k-point PCD landed at
            # 37 k, then capping at 131 k landed at 86 k). A 1.15×
            # step converges to within a few percent of the target.
            if pts.shape[0] > max_points:
                voxel = float(prof.get('baseline_voxel_m') or 0.01)
                tries = 0
                while pts.shape[0] > max_points and tries < 20:
                    voxel *= 1.15
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

    # ── Teach-Session record-through store (2026-08-04) ────────────
    #
    # Pre-2026-08-04, taught poses recorded during a teach session lived
    # ONLY in the recording browser's Zustand state until save. Refresh
    # or a tablet-to-PC switch mid-teach → poses lost; the server could
    # not validate what it could not see; §406 first-class program sync
    # never covered teach-time state.
    #
    # This module is the single source of truth for teach-time state:
    #
    #   * `/opt/cobot/teach_sessions/{program_id}.draft.json` — one
    #     draft file per program (or per program-id). Contains
    #     `owner_device_id`, `poses: {slot_key: patch}`. Slot keys:
    #        step:<step_id>   step teaching (move_home, move_joint, …)
    #        corner:1|2|3     pallet frame corners
    #        corner:part      pallet part-datum ④
    #
    #   * `STATE['teach_sessions']` mirrors every draft file, keyed
    #     by program_id. Every WS state broadcast carries the mirror
    #     — connected clients see draft mutations without any extra
    #     WS channel, and reconcile-on-reconnect (Addendum 27) picks
    #     up the teach state via the same snapshot that ships
    #     currentProgram revs.
    #
    #   * Endpoints:
    #        POST /api/teach_session/{pid}/start       claim (409 if locked)
    #        POST /api/teach_session/{pid}/record     write one slot
    #        POST /api/teach_session/{pid}/take_over  atomic ownership swap
    #        POST /api/teach_session/{pid}/save       promote → validator
    #        POST /api/teach_session/{pid}/cancel     discard
    #        GET  /api/teach_session/{pid}            read current draft
    #
    # The draft store is the ONE canonical owner of teach-time pose
    # state. Registered in tools/fork_registry.yaml as
    # `teach_session_state`; forbidden in the registry: any frontend
    # localStorage.setItem carrying pose data.

    _TEACH_DIR = '/opt/cobot/teach_sessions'
    # 2026-08-05 stale-lock fix (P0-B): a session whose owner_device_id
    # hasn't heartbeated (or written) for _TEACH_OWNER_TTL_S seconds
    # gets its ownership released — the tab presumably crashed. The
    # DRAFT stays (poses safe on disk); another device can re-claim
    # via /start without a Take Over gesture. If nothing re-claims for
    # _TEACH_DRAFT_TTL_S beyond that, the whole draft is garbage-
    # collected. Both windows are picked to be short enough that a
    # crashed-tab operator doesn't stay locked out, long enough that
    # a slow network doesn't drop a live session mid-teach.
    # 2026-08-05 (teach-lock incident #3 + identity root-cause fix):
    # TTL 90s = 6 client heartbeat intervals (15s each). Record-through
    # means every pose is already persisted; expiry loses nothing but
    # the OWNERSHIP claim. A live client rides through several hiccups;
    # a phantom owner (crashed tab, closed laptop) drops out fast.
    _TEACH_OWNER_TTL_S = 90
    _TEACH_DRAFT_TTL_S = 24 * 3600  # 24 h — dropped from disk after this
    # Self-healing entry threshold: 60s = 4 missed 15s heartbeats.
    # Auto-swap the lock to the requester when the owner's updated_ts
    # is older than this — spares a real operator from waiting the
    # full 90s TTL when the previous owner has demonstrably gone quiet.
    _TEACH_STALE_HEARTBEAT_S = 60
    # Ghost-amnesty threshold (2026-08-05 identity root-cause fix).
    # A one-time sweep at boot clears ownership on drafts where the
    # owner_device_id is a UUID-shaped string with NO matching
    # ui_context entry AND updated_ts older than this — kills
    # orphaned tab-UUIDs from before the localStorage identity fix,
    # which were the true root cause of every teach-lock incident.
    # Poses are preserved (draft file stays); another device can
    # simply /start on it. 10 min gives a live-but-slow ui_context
    # write ample time to land before we amnesty its owner.
    _TEACH_GHOST_AMNESTY_S = 10 * 60
    _teach_lock = threading.Lock()

    def _teach_path(prog_id: str):
        if not _PROG_READ_ID_RE.match(prog_id or ''):
            return None
        return os.path.join(_TEACH_DIR, prog_id + '.draft.json')

    def _teach_read_draft(prog_id: str) -> dict | None:
        p = _teach_path(prog_id)
        if not p or not os.path.isfile(p):
            return None
        try:
            with open(p) as fh:
                return json.load(fh)
        except Exception:
            return None

    class _TeachWriteError(OSError):
        """Structured error the record/heartbeat/end/save endpoints
        catch and turn into a clean 507 for the operator, instead of
        letting the raw OSError traceback back through starlette as a
        500. Preserves the underlying errno for diagnostics.

        2026-08-05 P0: without this wrapper, any fs-level failure
        (ENOSPC=28, EROFS=30, EIO=5, EDQUOT=122, EACCES=13) crashed
        every Record press from the tablet as a 500 traceback."""
        pass

    def _storage_full_response(e):
        """Shared operator-language body for a 507 storage-full
        return. Called from every teach-session endpoint that
        writes to disk (record/end/heartbeat/save/edit)."""
        errno = e.args[0] if e.args else '?'
        detail = e.args[1] if len(e.args) > 1 else str(e)
        return {
            'ok':    False,
            'error': 'storage_full',
            'operator_message': (
                "Couldn't save — the dashboard's disk is full. "
                "Free space on /opt/cobot and try again. Earlier "
                "successful writes are safe on disk."),
            'technical_detail': f'errno={errno} {detail}',
        }

    def _teach_write_draft(prog_id: str, draft: dict) -> None:
        p = _teach_path(prog_id)
        if not p:
            return
        tmp = None
        try:
            os.makedirs(_TEACH_DIR, exist_ok=True)
            # Atomic write — rename after fsync so a mid-write kill
            # cannot leave a half-file on disk (draft survives a
            # `systemctl restart roboai-dashboard` mid-teach).
            tmp = p + '.tmp'
            with open(tmp, 'w') as fh:
                json.dump(draft, fh, indent=2)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, p)
        except OSError as e:
            # Clean up the .tmp fragment so a subsequent successful
            # write doesn't blend partial data with fresh state.
            if tmp is not None:
                try:
                    if os.path.exists(tmp):
                        os.remove(tmp)
                except Exception:
                    pass
            raise _TeachWriteError(e.errno, str(e))

    def _teach_delete_draft(prog_id: str) -> None:
        p = _teach_path(prog_id)
        if not p:
            return
        try:
            os.remove(p)
        except FileNotFoundError:
            pass

    def _teach_touch(draft: dict) -> dict:
        draft['updated_ts'] = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                            time.gmtime())
        return draft

    def _teach_updated_epoch(draft: dict) -> float | None:
        """Parse the draft's `updated_ts` (ISO-8601 UTC 'Z') to
        wall-clock epoch. Returns None if unparseable. Uses
        calendar.timegm because time.mktime interprets a naive tm as
        LOCAL and would silently drift by ±3600s across DST."""
        s = draft.get('updated_ts') if isinstance(draft, dict) else None
        if not isinstance(s, str) or not s:
            return None
        try:
            import calendar as _cal
            tm = time.strptime(s, '%Y-%m-%dT%H:%M:%SZ')
            return float(_cal.timegm(tm))
        except (ValueError, TypeError):
            return None

    def _teach_apply_ttl(pid: str, draft: dict) -> dict | None:
        """Apply the TTL rules to a live draft. Returns the (possibly
        rewritten) draft, or None if the draft was garbage-collected.

        Two windows:
          * owner_ttl:  released ownership after N s of silence
                        (poses preserved, banner clears)
          * draft_ttl:  drop the file entirely after N s more
        """
        if not isinstance(draft, dict):
            return draft
        upd_epoch = _teach_updated_epoch(draft)
        if upd_epoch is None:
            return draft
        age = time.time() - upd_epoch
        # Owner-TTL: release ownership if the live owner has gone silent.
        if age > _TEACH_OWNER_TTL_S and draft.get('owner_device_id'):
            draft = dict(draft)
            draft['owner_device_id'] = None
            draft['owner_label']     = None
            draft['ttl_expired_at']  = time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            _teach_touch(draft)
            # 2026-08-05 P0: TTL sweep runs on every state broadcast
            # (25 Hz idle / 8 Hz hold). An ENOSPC here would spam
            # exceptions through the broadcast pipeline. Swallow —
            # the caller (state broadcast) does not need a raise.
            try:
                _teach_write_draft(pid, draft)
            except _TeachWriteError:
                pass
            return draft
        # Draft-TTL: garbage-collect a long-abandoned unowned draft.
        if age > _TEACH_DRAFT_TTL_S and not draft.get('owner_device_id'):
            _teach_delete_draft(pid)
            return None
        return draft

    # 2026-08-05 (identity root-cause fix — Directive item 3).
    # One-time ghost amnesty: any draft whose owner_device_id is a
    # UUID-shaped string with NO matching ui_context entry AND has
    # been silent for _TEACH_GHOST_AMNESTY_S has ownership cleared
    # on next publish. Kills the tablet-real UUID + every orphaned
    # tab-UUID minted before device identity moved to localStorage.
    # Poses are preserved; another device can /start on the file.
    # Runs once per dashboard boot (via _teach_publish_to_state's
    # first call, gated by _amnesty_done). Idempotent — a false
    # positive would only require the operator to re-claim via
    # /start, which is cheap.
    import re as _amnesty_re
    _amnesty_uuid_re = _amnesty_re.compile(
        r'^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-'
        r'[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$')
    _amnesty_state = {'done': False}

    def _teach_ghost_amnesty_once() -> None:
        if _amnesty_state['done']:
            return
        _amnesty_state['done'] = True
        try:
            names = os.listdir(_TEACH_DIR)
        except FileNotFoundError:
            return
        # Known live device_ids from ui_context — a draft owner
        # matching any of these is NOT a ghost.
        try:
            live_ids = {ctx.get('_device_id')
                        for ctx in _ui_context.list_all()
                        if isinstance(ctx, dict) and ctx.get('_device_id')}
        except Exception:
            live_ids = set()
        cleared = 0
        for name in names:
            if not name.endswith('.draft.json'):
                continue
            pid = name[:-len('.draft.json')]
            d = _teach_read_draft(pid)
            if not isinstance(d, dict):
                continue
            owner = d.get('owner_device_id')
            if not owner:
                continue
            if not _amnesty_uuid_re.match(str(owner)):
                # Non-UUID owner — old label-shaped ids from before
                # the crypto.randomUUID switch. Leave alone.
                continue
            if owner in live_ids:
                continue
            upd = _teach_updated_epoch(d)
            if upd is None:
                continue
            if (time.time() - upd) < _TEACH_GHOST_AMNESTY_S:
                continue
            d = dict(d)
            d['owner_device_id'] = None
            d['owner_label']     = None
            d['ghost_cleared_at'] = time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            _teach_touch(d)
            try:
                _teach_write_draft(pid, d)
                cleared += 1
            except _TeachWriteError:
                pass
        if cleared:
            print(f'[dashboard] ghost-amnesty cleared {cleared} '
                  f'orphaned draft owner(s)')

    # 2026-08-06 (jog-jitter fix — operator directive). The teach-
    # sessions publish is decoupled from the calling endpoint's
    # critical section by a single background daemon thread. Callers
    # only signal the worker; they never block on the disk scan.
    #
    # Design:
    #   * `_teach_publish_event` — coalesces multiple pending publishes
    #     into one scan. Set by the endpoint; cleared by the worker
    #     before starting a scan.
    #   * `_teach_publish_worker` — single thread, single scan at a
    #     time. If a mutation signals mid-scan the event stays set,
    #     the worker immediately re-scans. No unbounded thread
    #     creation.
    #   * `_teach_publish_to_state()` — public entrypoint. Does the
    #     idle short-circuit (fix 1) inline (< 1 syscall), then
    #     signals the worker (fix 2) and returns. Never touches
    #     _teach_lock. Callers that hold _teach_lock (or any other
    #     lock) can call this safely; disk I/O runs off-thread.
    #
    # Fork registry: `jog_hold_heartbeat` MUST NOT share a lock or
    # a scheduling loop with teach-session housekeeping (see fork
    # registry entry landed with this commit).
    _teach_publish_event = threading.Event()
    _teach_publish_worker_started = [False]
    # Test hook — production sets None; test can inject a callback
    # invoked once at the end of every worker scan for verification.
    # Never called from the endpoint path.
    _teach_publish_after_scan_hook = [None]

    def _teach_scan_sync() -> None:
        """The actual disk scan + STATE mutation. Runs in the daemon
        worker thread. Never called from any endpoint path — all
        endpoints go through `_teach_publish_to_state()` which just
        signals the worker."""
        try:
            names = os.listdir(_TEACH_DIR)
        except FileNotFoundError:
            names = []
        draft_names = [n for n in names if n.endswith('.draft.json')]
        if not draft_names:
            with _state_lock:
                if STATE.get('teach_sessions'):
                    STATE['teach_sessions'] = {}
            return
        _teach_ghost_amnesty_once()
        drafts: dict = {}
        for name in draft_names:
            pid = name[:-len('.draft.json')]
            d = _teach_read_draft(pid)
            if d is None:
                continue
            d = _teach_apply_ttl(pid, d)
            if d is not None:
                drafts[pid] = d
        with _state_lock:
            STATE['teach_sessions'] = drafts

    def _teach_publish_worker_loop():
        while True:
            _teach_publish_event.wait()
            _teach_publish_event.clear()
            try:
                _teach_scan_sync()
            except Exception as _e:
                # Never let a scan exception kill the worker — the
                # next signal will re-fire the scan.
                print(f'[teach-publish] scan error: {_e}', flush=True)
            hook = _teach_publish_after_scan_hook[0]
            if hook is not None:
                try:
                    hook()
                except Exception:
                    pass

    def _teach_publish_to_state() -> None:
        """Mirror every draft file on disk into STATE['teach_sessions']
        so the WS broadcast carries it. Called at boot (hydrate) and
        after every mutation. Applies the TTL rules — a stale-owner
        draft has its ownership released here, and a long-abandoned
        draft is garbage-collected.

        2026-08-06 (jog-jitter fix — operator directive):

          FIX 1 (idle short-circuit). If the draft directory has NO
          `.draft.json` files, the sweep does NOTHING. No disk scan,
          no TTL apply, no worker signal. Bounded to ~1 syscall +
          comparison against a small in-memory dict. Eliminates all
          lock/disk contention when jogging with no teach session
          active — the operator's current jitter case.

          FIX 2 (disk I/O off the caller's thread). When drafts DO
          exist, the actual scan happens in a dedicated daemon
          thread; the caller signals a threading.Event and returns
          immediately. This guarantees that a caller holding
          _teach_lock (or the asyncio event loop) NEVER blocks on
          disk I/O. State mirror is eventually consistent — the
          next state broadcast (25 Hz idle / 8 Hz hold) picks up
          the fresh dict within ~40 ms of the mutation.

          FIX 3 (jog heartbeat isolation). The jog keepalive runs
          on its own native thread with `_active_holds_lock`; teach
          housekeeping runs on the publish worker with _state_lock.
          The two share no mutex. Verified by the fork registry
          entry `jog_hold_heartbeat`.
        """
        # Idle short-circuit — this fast path is what the operator
        # hits during any jog with no teach session active. Bounded
        # to ~1 syscall.
        try:
            names = os.listdir(_TEACH_DIR)
        except FileNotFoundError:
            names = []
        if not any(n.endswith('.draft.json') for n in names):
            with _state_lock:
                if STATE.get('teach_sessions'):
                    STATE['teach_sessions'] = {}
            return
        # Lazy-start the worker on first non-idle call. Subsequent
        # calls are cheap (already started).
        if not _teach_publish_worker_started[0]:
            _teach_publish_worker_started[0] = True
            threading.Thread(target=_teach_publish_worker_loop,
                             daemon=True,
                             name='teach-publish-worker').start()
        # Signal the worker. Coalescing is automatic: if the event
        # is already set (worker hasn't started this scan yet), the
        # set is a no-op — one scan covers both mutations.
        _teach_publish_event.set()

    # Hydrate at boot so a restart mid-teach resumes the session.
    # Boot path calls _teach_scan_sync directly (bypassing the worker
    # signal) so STATE['teach_sessions'] is populated before the first
    # request lands — otherwise the first client would see an empty
    # mirror for ~50 ms after startup.
    os.makedirs(_TEACH_DIR, exist_ok=True)
    _teach_scan_sync()

    def _teach_new_draft(prog_id: str, device_id: str,
                         device_label: str = '') -> dict:
        return _teach_touch({
            'program_id':      prog_id,
            'owner_device_id': device_id,
            'owner_label':     device_label or device_id[:8],
            'started_ts':      time.strftime('%Y-%m-%dT%H:%M:%SZ',
                                             time.gmtime()),
            'poses':           {},
        })

    # 2026-08-06 (Lesson 179 — null-owner refusal bug).
    #
    # ONE ownership-resolution rule, one implementation, so a future
    # endpoint can't bring back the "owner != device_id → 403" bare
    # pattern that the operator caught twice.
    #
    # Doctrine (operator-directed): a null owner_device_id means the
    # session is CLAIMABLE. The requesting device becomes owner and
    # proceeds. Refuse ONLY when a DIFFERENT, non-null device owns
    # it AND its heartbeat is fresh (< _TEACH_STALE_HEARTBEAT_S).
    # A stale non-null owner triggers an auto-swap (same as /start).
    #
    # Returns (draft_after_check, error_body_or_None,
    #          http_status_or_None). Caller writes draft only when
    # error is None. draft_after_check may be a fresh dict (claim /
    # swap) or the same object (already-owner).
    def _teach_claim_or_refuse(draft: dict, device_id: str,
                                device_label: str = ''):
        owner = draft.get('owner_device_id')
        if owner == device_id:
            return draft, None, None
        if owner is None:
            d = dict(draft)
            d['owner_device_id'] = device_id
            d['owner_label']     = (device_label or '').strip() \
                                    or device_id[:8]
            d['claimed_at']      = time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            return d, None, None
        # Owner is a different non-null device — check heartbeat.
        upd = _teach_updated_epoch(draft)
        if upd is not None and (time.time() - upd) > _TEACH_STALE_HEARTBEAT_S:
            d = dict(draft)
            d['owner_device_id']    = device_id
            d['owner_label']        = (device_label or '').strip() \
                                        or device_id[:8]
            d['previous_owner']     = owner
            d['auto_expired_at']    = time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            return d, None, None
        return draft, {
            'ok':              False,
            'error':           'not_owner',
            'owner_device_id': owner,
            'owner_label':     draft.get('owner_label'),
        }, 403

    @app.get("/api/teach_session/{prog_id}")
    async def api_teach_session_get(prog_id: str):
        """Return the current draft for prog_id, or {present: false}
        when none exists. Used by clients on program open + as a
        belt-and-suspenders reconcile against the WS state stream."""
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
        if draft is None:
            return {'present': False, 'program_id': prog_id}
        return {'present': True, 'draft': draft}

    @app.post("/api/teach_session/{prog_id}/start")
    async def api_teach_session_start(prog_id: str, request: Request):
        """Claim the teach session for prog_id. Body:
            {device_id: <str, required>, device_label?: <str>}
        Returns:
            {ok:true, draft} on successful claim (new draft OR
            existing draft owned by THIS device),
            409 {ok:false, owner_device_id, owner_label, taken_at}
            when another device owns the session."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        device_id = str(body.get('device_id') or '').strip()
        if not device_id:
            return JSONResponse({'error': 'device_id required'},
                                status_code=400)
        device_label = str(body.get('device_label') or '')
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
            if draft is None:
                draft = _teach_new_draft(prog_id, device_id, device_label)
                try:
                    _teach_write_draft(prog_id, draft)
                except _TeachWriteError as e:
                    return JSONResponse(_storage_full_response(e),
                                        status_code=507)
                _teach_publish_to_state()
                return {'ok': True, 'draft': draft}
            if draft.get('owner_device_id') == device_id:
                # Re-claim from the same device (refresh, resume) —
                # keep the poses, keep ownership.
                draft = _teach_touch(draft)
                try:
                    _teach_write_draft(prog_id, draft)
                except _TeachWriteError as e:
                    return JSONResponse(_storage_full_response(e),
                                        status_code=507)
                _teach_publish_to_state()
                return {'ok': True, 'draft': draft}
            # 2026-08-06 (Lesson 179): null owner → CLAIM.
            # Ghost-amnesty leaves owner=None on drafts whose
            # ownership was released. A fresh /start on such a
            # draft must succeed without a manual take_over.
            if draft.get('owner_device_id') is None:
                draft = dict(draft)
                draft['owner_device_id'] = device_id
                draft['owner_label']     = device_label or device_id[:8]
                draft['claimed_at']      = time.strftime(
                    '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                _teach_touch(draft)
                try:
                    _teach_write_draft(prog_id, draft)
                except _TeachWriteError as e:
                    return JSONResponse(_storage_full_response(e),
                                        status_code=507)
                _teach_publish_to_state()
                return {'ok': True, 'draft': draft, 'claimed': True}
            # Different device — check the owner's heartbeat age. If
            # they've been silent for > 2 heartbeat intervals (60 s),
            # the lock is treated as abandoned and we auto-grant it
            # to the requester (Directive item 6, 2026-08-05 teach-
            # lock incident #3). Poses stay put — this is a graceful
            # ownership swap, not a data reset.
            _upd = _teach_updated_epoch(draft)
            if _upd is not None:
                _age = time.time() - _upd
                if _age > _TEACH_STALE_HEARTBEAT_S:
                    prev_owner = draft.get('owner_device_id')
                    draft = dict(draft)
                    draft['owner_device_id']    = device_id
                    draft['owner_label']        = device_label or device_id[:8]
                    draft['previous_owner']     = prev_owner
                    draft['auto_expired_at']    = time.strftime(
                        '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                    _teach_touch(draft)
                    try:
                        _teach_write_draft(prog_id, draft)
                    except _TeachWriteError as e:
                        return JSONResponse(_storage_full_response(e),
                                            status_code=507)
                    _teach_publish_to_state()
                    return {
                        'ok': True,
                        'draft': draft,
                        'auto_expired_previous_owner': prev_owner,
                    }
            # Another live device owns it. 409 lets the client render
            # the read-only banner with a Take Over button.
            return JSONResponse({
                'ok': False,
                'error': 'teach_session_locked',
                'owner_device_id': draft.get('owner_device_id'),
                'owner_label':     draft.get('owner_label'),
                'taken_at':        draft.get('started_ts'),
            }, status_code=409)

    @app.post("/api/teach_session/{prog_id}/take_over")
    async def api_teach_session_take_over(prog_id: str, request: Request):
        """Atomically transfer ownership from the current owner to
        the requesting device. Existing poses are preserved."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        device_id = str(body.get('device_id') or '').strip()
        if not device_id:
            return JSONResponse({'error': 'device_id required'},
                                status_code=400)
        device_label = str(body.get('device_label') or '')
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
            if draft is None:
                # No existing draft — treat as a start.
                draft = _teach_new_draft(prog_id, device_id, device_label)
                try:
                    _teach_write_draft(prog_id, draft)
                except _TeachWriteError as e:
                    return JSONResponse(_storage_full_response(e),
                                        status_code=507)
                _teach_publish_to_state()
                return {'ok': True, 'draft': draft, 'took_over': False}
            prev_owner = draft.get('owner_device_id')
            draft = dict(draft)
            draft['owner_device_id']    = device_id
            draft['owner_label']        = device_label or device_id[:8]
            draft['previous_owner']     = prev_owner
            draft['took_over_at']       = time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            _teach_touch(draft)
            try:
                _teach_write_draft(prog_id, draft)
            except _TeachWriteError as e:
                return JSONResponse(_storage_full_response(e),
                                    status_code=507)
            _teach_publish_to_state()
            return {'ok': True, 'draft': draft, 'took_over': True,
                    'previous_owner': prev_owner}

    @app.post("/api/teach_session/{prog_id}/edit")
    async def api_teach_session_edit(prog_id: str, request: Request):
        """Record-through for STRUCTURAL edits — step reorder, add/
        delete, config change, program rename. Body:
            {device_id: <str, required>,
             program:  <full program dict, required>}
        Writes to draft.staged_program. Save merges staged_program
        as the base (not the disk-saved program), then applies the
        pose overlay from draft.poses.

        Ownership + self-heal same as /record — a stale-owner
        (heartbeat > 60 s old) gets auto-swapped. Non-owner with
        a fresh session → 403. Storage full → 507.

        Fork registry: page_context_persistence — this is the
        canonical write-through path for non-pose edits."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        device_id = str(body.get('device_id') or '').strip()
        program   = body.get('program')
        if not device_id:
            return JSONResponse({'error': 'device_id required'},
                                status_code=400)
        if not isinstance(program, dict):
            return JSONResponse({'error': 'program (full dict) required'},
                                status_code=400)
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
            if draft is None:
                # First edit implicitly starts the session — same
                # convenience the /record path offers.
                draft = _teach_new_draft(prog_id, device_id,
                    str(body.get('device_label') or ''))
            else:
                # Single canonical guard — null owner → CLAIM.
                # Fork registry: teach_ownership_resolution.
                draft, err_body, err_code = _teach_claim_or_refuse(
                    draft, device_id, str(body.get('device_label') or ''))
                if err_body is not None:
                    return JSONResponse(err_body, status_code=err_code)
            draft['staged_program'] = program
            _teach_touch(draft)
            try:
                _teach_write_draft(prog_id, draft)
            except _TeachWriteError as e:
                return JSONResponse(_storage_full_response(e),
                                    status_code=507)
            _teach_publish_to_state()
        return {'ok': True, 'draft': draft}

    @app.post("/api/teach_session/{prog_id}/record")
    async def api_teach_session_record(prog_id: str, request: Request):
        """Write one pose patch into the draft. Body:
            {device_id: <str, required>,
             slot_key: <str, required — 'step:<id>' | 'corner:1|2|3|part'>,
             patch:    <dict, required — the taught_* payload>}
        Ownership check refuses writes from non-owners with 403 so
        the second device's Record buttons (which are UI-disabled)
        cannot bypass via a direct API call."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        device_id = str(body.get('device_id') or '').strip()
        slot_key  = str(body.get('slot_key') or '').strip()
        patch     = body.get('patch')
        if not device_id:
            return JSONResponse({'error': 'device_id required'},
                                status_code=400)
        if not slot_key:
            return JSONResponse({'error': 'slot_key required'},
                                status_code=400)
        if not isinstance(patch, dict):
            return JSONResponse({'error': 'patch must be an object'},
                                status_code=400)
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
            if draft is None:
                # First record implicitly starts the session with
                # this device as owner. Keeps the client wire
                # simple (no explicit /start before /record).
                draft = _teach_new_draft(prog_id, device_id,
                    str(body.get('device_label') or ''))
            else:
                # Single canonical guard — null owner → CLAIM, stale
                # non-null owner → auto-swap, fresh non-null owner
                # → 403. Fork registry: teach_ownership_resolution.
                draft, err_body, err_code = _teach_claim_or_refuse(
                    draft, device_id, str(body.get('device_label') or ''))
                if err_body is not None:
                    return JSONResponse(err_body, status_code=err_code)
            poses = dict(draft.get('poses') or {})
            poses[slot_key] = patch
            draft['poses'] = poses
            _teach_touch(draft)
            try:
                _teach_write_draft(prog_id, draft)
            except _TeachWriteError as e:
                return JSONResponse(_storage_full_response(e),
                                    status_code=507)
            _teach_publish_to_state()
            return {'ok': True, 'draft': draft, 'slot_key': slot_key}

    @app.post("/api/teach_session/{prog_id}/cancel")
    async def api_teach_session_cancel(prog_id: str, request: Request):
        """Discard the draft. Either the owner OR a take-over
        confirmation can cancel — no permission check, because
        cancel is the "back out safely" affordance."""
        with _teach_lock:
            _teach_delete_draft(prog_id)
            _teach_publish_to_state()
        return {'ok': True, 'program_id': prog_id}

    @app.post("/api/teach_session/{prog_id}/end")
    async def api_teach_session_end(prog_id: str, request: Request):
        """Release ownership of the teach session. Body:
            {device_id: <str, required>}
        The DRAFT stays on disk (poses safe); the OWNER field clears
        so the banner drops for every other device, and the session
        is re-claimable via /start without a Take Over. The record-
        through architecture already persisted every pose on Record,
        so ending the session loses nothing (P0-B, 2026-08-05).

        Non-owner callers get 403 — device_B can't force-end
        device_A's session (Take Over is the collision-case path)."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        device_id = str(body.get('device_id') or '').strip()
        if not device_id:
            return JSONResponse({'error': 'device_id required'},
                                status_code=400)
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
            if draft is None:
                return {'ok': True, 'already_ended': True}
            # 2026-08-06 (Lesson 179): null owner → nothing to
            # release. "End my session" from a device that doesn't
            # own it is a no-op when the session is unclaimed —
            # same UX as no draft.
            if draft.get('owner_device_id') is None:
                return {'ok': True, 'already_ended': True}
            if draft.get('owner_device_id') != device_id:
                return JSONResponse({
                    'ok': False,
                    'error': 'not_owner',
                    'owner_device_id': draft.get('owner_device_id'),
                    'owner_label':     draft.get('owner_label'),
                }, status_code=403)
            draft = dict(draft)
            draft['owner_device_id'] = None
            draft['owner_label']     = None
            draft['ended_ts']        = time.strftime(
                '%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            _teach_touch(draft)
            try:
                _teach_write_draft(prog_id, draft)
            except _TeachWriteError as e:
                return JSONResponse(_storage_full_response(e),
                                    status_code=507)
            _teach_publish_to_state()
        return {'ok': True, 'released': True}

    @app.post("/api/teach_session/{prog_id}/heartbeat")
    async def api_teach_session_heartbeat(prog_id: str, request: Request):
        """Refresh the session's `updated_ts` so the owner-TTL doesn't
        expire on a slow-network live device. Body:
            {device_id: <str, required>}
        Non-owner → 403 (heartbeat is proof of live ownership; another
        device's heartbeat must not extend the owning device's TTL).
        No draft → 404 with a canonical "session gone" body so the
        client can navigate away cleanly."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        device_id = str(body.get('device_id') or '').strip()
        if not device_id:
            return JSONResponse({'error': 'device_id required'},
                                status_code=400)
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
            if draft is None:
                return JSONResponse({
                    'ok': False, 'error': 'no_session',
                }, status_code=404)
            # 2026-08-06 (Lesson 179): null owner → CLAIM.
            # Heartbeat from an unclaimed session becomes the claim
            # itself. Odd but consistent with the doctrine that a
            # null owner is CLAIMABLE, never refused.
            draft, err_body, err_code = _teach_claim_or_refuse(
                draft, device_id, str(body.get('device_label') or ''))
            if err_body is not None:
                return JSONResponse(err_body, status_code=err_code)
            _teach_touch(draft)
            try:
                _teach_write_draft(prog_id, draft)
            except _TeachWriteError as e:
                return JSONResponse(_storage_full_response(e),
                                    status_code=507)
        return {'ok': True, 'updated_ts': draft.get('updated_ts')}

    def _apply_draft_poses_to_program(program: dict, poses: dict):
        """Merge draft poses INTO a program dict (returns
        (merged_program, unmatched_slot_keys) without persisting).
        Slots:
          step:<step_id>    → merge patch into the matching step
          corner:1|2|3      → write .taught_tcp to
                              config.pallet_place.corner{N}_tcp
          corner:part       → write .taught_tcp to
                              config.pallet_place.part_tcp
        Slot keys that DON'T match any step or corner target are
        returned as `unmatched_slot_keys` so the caller can raise a
        named warning ("N recorded poses matched no step — steps
        may have been renumbered") instead of silently discarding.
        Pre-fix: unmatched keys were dropped without a trace, so
        a step deletion mid-teach silently lost the pose.
        """
        merged = json.loads(json.dumps(program))
        steps  = merged.setdefault('steps', [])
        cfg    = merged.setdefault('config', {})
        place  = cfg.setdefault('pallet_place', {})
        by_step_id = {}
        for s in steps:
            sid = s.get('id')
            if sid is not None:
                by_step_id[str(sid)] = s
        unmatched: list = []
        for slot_key, patch in (poses or {}).items():
            if slot_key.startswith('step:'):
                sid = slot_key[len('step:'):]
                target = by_step_id.get(sid)
                if target is None:
                    unmatched.append(slot_key)
                    continue
                for k, v in (patch or {}).items():
                    target[k] = v
            elif slot_key.startswith('corner:'):
                corner = slot_key[len('corner:'):]
                tcp = (patch or {}).get('taught_tcp')
                if not (isinstance(tcp, list) and len(tcp) >= 6):
                    unmatched.append(slot_key)
                    continue
                key = {
                    '1':    'corner1_tcp',
                    '2':    'corner2_tcp',
                    '3':    'corner3_tcp',
                    'part': 'part_tcp',
                }.get(corner)
                if key:
                    place[key] = list(tcp[:6])
                else:
                    unmatched.append(slot_key)
            else:
                unmatched.append(slot_key)
        return merged, unmatched

    @app.post("/api/teach_session/{prog_id}/save")
    async def api_teach_session_save(prog_id: str, request: Request):
        """Promote draft → program via the single validator door
        (check_program_pending_poses). On success: merged program
        persisted to /opt/cobot/programs/{id}.json AND the draft
        file deleted. On validation failure: HTTP 400 with the
        finding list; draft stays intact so the operator can jog
        + re-teach."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        device_id = str(body.get('device_id') or '').strip()
        device_label = str(body.get('device_label') or '')
        with _teach_lock:
            draft = _teach_read_draft(prog_id)
            if draft is None:
                return JSONResponse({
                    'ok': False, 'error': 'no_draft'}, status_code=404)
            # 2026-08-06 (Lesson 179): null owner → CLAIM, don't refuse.
            # Ghost-amnesty leaves owner=None; the promoting device
            # must be able to save without a manual take_over.
            if device_id:
                draft, err_body, err_code = _teach_claim_or_refuse(
                    draft, device_id, device_label)
                if err_body is not None:
                    return JSONResponse(err_body, status_code=err_code)
            path = _prog_read_path(prog_id)
            if path is None or not os.path.isfile(path):
                return JSONResponse({
                    'ok': False, 'error': 'program_not_found'},
                    status_code=404)
            with open(path) as fh:
                saved_program = json.load(fh)
            # 2026-08-05 (edit-through): if the draft carries a
            # staged_program (structural edits recorded through the
            # /edit endpoint), use it as the BASE for the merge —
            # not the disk-saved program. The pose overlay is then
            # applied on top. Without this, refreshing the tablet
            # would keep the poses but drop every step reorder /
            # add / delete / rename since last Save.
            base_program = (draft.get('staged_program')
                            if isinstance(draft.get('staged_program'), dict)
                            else saved_program)
            merged, unmatched_slot_keys = _apply_draft_poses_to_program(
                base_program, draft.get('poses') or {})
            # Single validator door: same check used by the
            # /api/estun/program/run push. Blocking findings refuse
            # the save so a controller-crashing program never reaches
            # disk via the teach-session path either.
            try:
                from estun_driver import program_ops
                pending = program_ops.check_program_pending_poses(merged)
            except Exception as _pe:
                pending = []
            if pending:
                return JSONResponse({
                    'ok':      False,
                    'error':   'pending_poses',
                    'outcome': {
                        'kind':     'pending_poses',
                        'count':    len(pending),
                        'findings': pending,
                    },
                    'program_id': prog_id,
                }, status_code=400)
            # Persist. Reuse the standard save shape: same fields
            # the /api/programs PUT would emit. Wrap in try/except so
            # a full-disk ENOSPC returns 507 instead of a 500 crash.
            try:
                tmp_path = path + '.tmp'
                with open(tmp_path, 'w') as fh:
                    json.dump(merged, fh, indent=2)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp_path, path)
            except OSError as _e:
                try:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass
                return JSONResponse(_storage_full_response(
                    _TeachWriteError(_e.errno, str(_e))),
                    status_code=507)
            _teach_delete_draft(prog_id)
            _teach_publish_to_state()
            # Bump the program-rev event so every client refreshes.
            try:
                _bump_prog_rev(prog_id)
            except Exception:
                pass
        response: dict = {'ok': True, 'program': merged}
        # 2026-08-05 (silent-drop kill — Directive item 5). Every
        # slot_key that didn't match a step or corner target is
        # surfaced as a named warning INSTEAD of being silently
        # discarded. Operator sees "N recorded poses matched no
        # step — steps may have been renumbered" in the save toast;
        # the forensic event-log entry keeps the slot keys for
        # later diagnosis (which pose, which program).
        if unmatched_slot_keys:
            response['warnings'] = [{
                'kind':             'unmatched_poses',
                'count':            len(unmatched_slot_keys),
                'unmatched_slot_keys': list(unmatched_slot_keys),
                'operator_message': (
                    f'{len(unmatched_slot_keys)} recorded pose'
                    + ('s' if len(unmatched_slot_keys) != 1 else '')
                    + ' matched no step — steps may have been '
                    + 'renumbered. Re-teach if needed.'),
            }]
            try:
                _event_log.emit(
                    severity='warning',
                    source='teach_session',
                    code='unmatched_poses_on_save',
                    operator_message=response['warnings'][0]['operator_message'],
                    technical_detail=(
                        f'program_id={prog_id} '
                        f'unmatched={list(unmatched_slot_keys)}'),
                    context={'program_id': prog_id,
                             'unmatched_slot_keys': list(unmatched_slot_keys)})
            except Exception:
                pass
        return response

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
