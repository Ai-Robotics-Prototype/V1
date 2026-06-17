#!/usr/bin/env python3
"""
Program Executor Node

Loads saved robot programs from /opt/cobot/programs/ and executes them
step by step via the Estun Codroid driver. Publishes execution state
so the dashboard can show progress.

Subscribes to:
  /task/run_program   (String JSON: {program_id, action})
  /estun/status       (String JSON: robot state for motion-complete detection)
  /estun/is_moving    (Bool: true when robot is in motion)

Publishes to:
  /task/state          (String JSON: {state, program_id, program_name, current_step, total_steps, ...})
  /estun/command       (String JSON: robot commands)
  /estun/move          (String JSON: motion commands)
  /robot/io_command    (String JSON: I/O commands)
"""

import rclpy
from rclpy.node import Node
from std_msgs.msg import String, Bool
import json
import os
import time
import threading

PROGRAMS_DIR = '/opt/cobot/programs'
STATS_DIR = '/opt/cobot/stats'

# Motion optimization middleware — graceful fallback if msgs not yet built.
try:
    from motion_optimization_msgs.msg import MotionStatistics
    MOTION_MSGS_AVAILABLE = True
except Exception:
    MotionStatistics = None
    MOTION_MSGS_AVAILABLE = False

DEFAULT_MOTION_PROFILE = 'Balanced'
# Match the velocity_scale_pct of the default profile so unscaled programs
# behave identically to the pre-motion-optimization executor.
_PROFILE_BASELINE_VEL_PCT = 70.0


class ProgramExecutor(Node):

    # Execution states
    IDLE = 'idle'
    RUNNING = 'running'
    PAUSED = 'paused'
    WAITING_MOTION = 'waiting_motion'
    WAITING_IO = 'waiting_io'
    WAITING_DETECT = 'waiting_detect'
    WAITING_TIME = 'waiting_time'
    WAITING_INSPECTION = 'waiting_inspection'
    WAITING_OPERATOR = 'waiting_operator'
    ERROR = 'error'
    COMPLETE = 'complete'

    def __init__(self):
        super().__init__('program_executor')

        # State
        self._state = self.IDLE
        self._program = None
        self._program_id = None
        self._program_name = ''
        self._steps = []
        self._current_step_idx = -1
        self._cycle_count = 0
        self._cycle_start_time = 0
        self._last_cycle_time = 0
        self._total_picks = 0
        self._pick_passes = 0
        self._pick_fails = 0
        self._fail_reasons = {}
        self._is_robot_moving = False
        self._robot_connected = False
        self._robot_mode = 'unknown'
        self._wait_until = 0
        # Scan & Identify state — populated by scan_workspace,
        # consumed by scan_identify_each and the downstream sort /
        # remove-defects actions.
        self._scan_results      = []   # detections at the wide scan step
        self._identified_parts  = []   # per-object results after close-up scan
        self._scan_identify_idx = 0
        # Pallet runtime state. mode + config are populated when a
        # pallet program is loaded (None otherwise so the dashboard
        # knows no pallet program is active). cycle / row / col / layer
        # track which slot the current move_to_pallet step targets.
        # pallet_substep / pallet_io_fired manage the multi-phase motion
        # inside a single move_to_pallet step.
        self._pallet_state = {
            'cycle': 0, 'row': 0, 'col': 0, 'layer': 0,
            'mode': None, 'config': None,
        }
        self._pallet_substep   = 0      # 0=lift, 1=traverse retract, 2=descend approach, 3=descend slot, 4=io, 5=lift retract
        self._pallet_io_fired  = False
        # Inspection state — populated by the inspect_part handler and
        # consumed by the WAITING_INSPECTION transition. Kept on the
        # executor (not the inspection node) because the *executor* is
        # the thing that gates the rest of the program on the result.
        self._current_inspection_id     = None
        self._last_inspection_result    = None   # 'pass' / 'warn' / 'fail' / None
        self._last_inspection_record    = None   # full JSON record
        self._inspection_in_progress    = False
        self._inspection_pass_count     = 0
        self._inspection_fail_count     = 0
        self._inspection_sample_counter = 0      # for sampling: every N parts
        self._operator_ack              = False  # alert_operator waits on this
        self._lock = threading.Lock()

        # Motion optimization state — populated when a program is loaded.
        # _motion_profile mirrors the active profile body (cached so we
        # don't query the optimizer service on every move). When motion
        # optimization is disabled (per-program flag or service down),
        # _send_move passes commands through unchanged.
        self._motion_profile_name = DEFAULT_MOTION_PROFILE
        self._motion_profile = None  # dict or None
        self._motion_enabled = True
        self._motion_optimize_estimate_s = 0.0
        self._motion_unopt_estimate_s = 0.0
        self._motion_segment_count = 0
        self._motion_segments_optimized = 0
        self._motion_cycles_completed = 0
        self._motion_last_cycle_time = 0.0

        # Publishers
        self._pub_state = self.create_publisher(String, '/task/state', 10)
        self._pub_cmd = self.create_publisher(String, '/estun/command', 10)
        self._pub_move = self.create_publisher(String, '/estun/move', 10)
        self._pub_io = self.create_publisher(String, '/robot/io_command', 10)
        self._pub_jog = self.create_publisher(String, '/robot/jog_command', 10)
        if MOTION_MSGS_AVAILABLE:
            self._pub_motion_stats = self.create_publisher(
                MotionStatistics, '/motion_optimization/statistics', 10)
        else:
            self._pub_motion_stats = None

        # Subscribers
        self.create_subscription(String, '/task/run_program', self._on_run_command, 10)
        self.create_subscription(String, '/estun/status', self._on_robot_status, 10)
        self.create_subscription(Bool, '/estun/is_moving', self._on_is_moving, 10)
        # Inspection integration — published by inspection_pipeline.
        # The /inspection/result message arrives once per inspection;
        # the inspect_part step waits for it before deciding pass/warn/
        # fail branching.
        self.create_subscription(String, '/inspection/result',
                                 self._on_inspection_result, 10)
        self.create_subscription(String, '/inspection/status',
                                 self._on_inspection_status, 10)
        self.create_subscription(String, '/task/operator_ack',
                                 self._on_operator_ack, 10)
        # Used to tell the inspection node which part/plan to run
        # before the next /inspection/start call.
        self._pub_insp_params = self.create_publisher(
            String, '/inspection/set_params', 10)
        self._pub_alert = self.create_publisher(
            String, '/task/operator_alert', 10)

        # Execution timer — checks state at 20Hz
        self._exec_timer = self.create_timer(0.05, self._execution_tick)

        # State publish timer — 5Hz
        self._state_timer = self.create_timer(0.2, self._publish_state)

        os.makedirs(PROGRAMS_DIR, exist_ok=True)
        os.makedirs(STATS_DIR, exist_ok=True)

        self.get_logger().info('Program executor ready')

    # ── Command Handler ───────────────────────────────────

    def _on_run_command(self, msg):
        """Handle run/pause/stop/resume commands."""
        try:
            cmd = json.loads(msg.data)
        except Exception:
            return

        action = cmd.get('action', '')

        if action == 'run':
            prog_id = cmd.get('program_id')
            if prog_id:
                self._load_and_run(prog_id)
            elif self._program and self._state in (self.IDLE, self.COMPLETE, self.ERROR):
                self._start_execution()

        elif action == 'pause':
            if self._state == self.RUNNING:
                self._state = self.PAUSED
                self._send_cmd({'action': 'stop'})  # stop current motion
                self.get_logger().info('Program paused')

        elif action == 'resume':
            if self._state == self.PAUSED:
                self._state = self.RUNNING
                self.get_logger().info('Program resumed')

        elif action == 'stop':
            self._send_cmd({'action': 'stop'})
            self._state = self.IDLE
            self._current_step_idx = -1
            self.get_logger().info('Program stopped')

        elif action == 'home':
            self._send_cmd({'action': 'home'})

    def _load_and_run(self, prog_id):
        """Load a program from disk and start execution."""
        path = os.path.join(PROGRAMS_DIR, f'{prog_id}.json')
        if not os.path.isfile(path):
            self.get_logger().error(f'Program not found: {prog_id}')
            return

        try:
            with open(path) as f:
                prog = json.load(f)
        except Exception as e:
            self.get_logger().error(f'Failed to load program: {e}')
            return

        self._program = prog
        self._program_id = prog.get('id', prog_id)
        self._program_name = prog.get('name', prog_id)
        self._steps = prog.get('steps', [])

        if not self._steps:
            self.get_logger().warn(f'Program "{self._program_name}" has no steps')
            return

        # Motion profile lookup: program override → system default →
        # built-in Balanced. The cached body is read off disk so the
        # executor doesn't take a service-call hit on every step.
        self._motion_profile_name = (
            prog.get('motion_profile_name') or DEFAULT_MOTION_PROFILE)
        self._motion_enabled = bool(prog.get('motion_optimization_enabled', True))
        self._motion_profile = self._load_motion_profile(self._motion_profile_name)
        self._motion_segment_count = sum(
            1 for s in self._steps
            if s.get('action') in ('move_to_position', 'move_to_pallet',
                                   'home', 'tcp_move'))
        self._motion_segments_optimized = 0
        self._motion_cycles_completed = 0
        self._motion_last_cycle_time = 0.0

        # Latch pallet runtime state from program.config if this is a
        # pallet program; otherwise null it out so the dashboard hides
        # its widget.
        cfg = prog.get('config') or {}
        if cfg.get('operation') == 'palletize' and isinstance(cfg.get('pallet'), dict):
            self._pallet_state = {
                'cycle': 0, 'row': 0, 'col': 0, 'layer': 0,
                'mode':   'depalletize' if cfg.get('pallet_mode') == 'depalletize' else 'palletize',
                'config': cfg['pallet'],
            }
        else:
            self._pallet_state = {
                'cycle': 0, 'row': 0, 'col': 0, 'layer': 0,
                'mode': None, 'config': None,
            }

        self.get_logger().info(f'Loaded program "{self._program_name}" with {len(self._steps)} steps')
        self._start_execution()

    def _start_execution(self):
        """Begin executing from step 0."""
        self._current_step_idx = 0
        self._cycle_count = 0
        self._cycle_start_time = time.time()
        self._scan_results      = []
        self._identified_parts  = []
        self._scan_identify_idx = 0
        # Reset pallet position trackers but keep the mode/config the
        # program loader latched in.
        self._pallet_state['cycle'] = 0
        self._pallet_state['row']   = 0
        self._pallet_state['col']   = 0
        self._pallet_state['layer'] = 0
        self._pallet_substep   = 0
        self._pallet_io_fired  = False
        self._state = self.RUNNING
        self.get_logger().info(f'Starting execution: "{self._program_name}"')

    # ── Robot Status ──────────────────────────────────────

    def _on_robot_status(self, msg):
        """Update robot status from the Estun driver."""
        try:
            status = json.loads(msg.data)
            self._robot_connected = status.get('connected', False)
            self._robot_mode = status.get('robot_mode', 'unknown')
        except Exception:
            pass

    def _on_is_moving(self, msg):
        """Track whether the robot is currently in motion."""
        self._is_robot_moving = msg.data

    def _on_inspection_result(self, msg):
        """Receive a finished inspection record from inspection_pipeline.

        We only consume the result when there's a currently-pending
        inspection on the executor side — stale or out-of-order results
        (e.g. from a manual inspection started from the dashboard) get
        logged and ignored.
        """
        try:
            record = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        if not self._inspection_in_progress:
            return
        # Only accept results that match our pending inspection_id; if
        # the inspection_node assigned us a different id, accept the
        # next result anyway (manual starts produce mismatching ids).
        expected = self._current_inspection_id
        actual = record.get('inspection_id')
        if expected and actual and expected != actual:
            self.get_logger().info(
                f'ignoring inspection result {actual} '
                f'(waiting for {expected})')
            return
        self._last_inspection_record = record
        self._last_inspection_result = record.get('overall_result', 'pass')
        self._inspection_in_progress = False
        if self._last_inspection_result == 'pass':
            self._inspection_pass_count += 1
        elif self._last_inspection_result == 'fail':
            self._inspection_fail_count += 1

    def _on_inspection_status(self, msg):
        """Mirror inspection-node liveness into executor state.

        We don't gate on the status topic — the result topic is the
        authoritative completion signal. This just lets us notice if
        the inspection node enters an error state and abort cleanly.
        """
        try:
            status = json.loads(msg.data)
        except json.JSONDecodeError:
            return
        if (self._inspection_in_progress and
                status.get('status') == 'error'):
            self._last_inspection_result = 'error'
            self._inspection_in_progress = False

    def _on_operator_ack(self, msg):
        """Operator pressed Acknowledge on the dashboard alert."""
        self._operator_ack = True

    # ── Execution Engine ──────────────────────────────────

    def _execution_tick(self):
        """Main execution loop — runs at 20Hz."""
        if self._state not in (self.RUNNING, self.WAITING_MOTION,
                                self.WAITING_TIME, self.WAITING_IO,
                                self.WAITING_DETECT,
                                self.WAITING_INSPECTION,
                                self.WAITING_OPERATOR):
            return

        if self._current_step_idx < 0 or self._current_step_idx >= len(self._steps):
            self._on_program_complete()
            return

        step = self._steps[self._current_step_idx]
        action = step.get('action', '')

        # ── Waiting states ──
        if self._state == self.WAITING_MOTION:
            if not self._is_robot_moving:
                # Motion complete. For multi-phase move_to_pallet steps,
                # transition to the next substep rather than advancing
                # the whole step.
                if action == 'move_to_pallet':
                    self._tick_move_to_pallet(step, motion_complete=True)
                    return
                self.get_logger().info(f'Step {self._current_step_idx + 1} motion complete: {step.get("label", action)}')
                self._advance_step()
            return

        if self._state == self.WAITING_TIME:
            if time.time() >= self._wait_until:
                # Same trick for move_to_pallet — the gripper-settle
                # substep parks in WAITING_TIME for ~0.4s; on expiry we
                # need to kick the next substep, not advance the step.
                if action == 'move_to_pallet':
                    self._tick_move_to_pallet(step, time_complete=True)
                    return
                self.get_logger().info(f'Step {self._current_step_idx + 1} wait complete')
                self._advance_step()
            return

        if self._state == self.WAITING_IO:
            # For now, advance immediately (real implementation would check DI confirmation)
            self._advance_step()
            return

        if self._state == self.WAITING_DETECT:
            # For now, advance immediately (real implementation would wait for detection result)
            self._advance_step()
            return

        if self._state == self.WAITING_INSPECTION:
            # Block until /inspection/result arrives. Timeout after the
            # configured limit (default 30s) so a stalled pipeline
            # doesn't freeze the program forever.
            timeout_s = float(step.get('inspection_timeout_s', 30.0))
            if not self._inspection_in_progress:
                self._handle_inspection_outcome(step)
                return
            if time.time() - self._wait_until > timeout_s:
                self.get_logger().warn(
                    f'inspection timed out after {timeout_s}s — '
                    f'treating as fail')
                self._inspection_in_progress = False
                self._last_inspection_result = 'fail'
                self._last_inspection_record = {'overall_result': 'fail',
                                                'error': 'timeout'}
                self._handle_inspection_outcome(step)
            return

        if self._state == self.WAITING_OPERATOR:
            timeout_s = float(step.get('operator_timeout_s', 60.0))
            if self._operator_ack:
                self._operator_ack = False
                self._advance_step()
                return
            if time.time() - self._wait_until > timeout_s:
                if step.get('on_timeout', 'continue') == 'abort':
                    self._state = self.ERROR
                else:
                    self._advance_step()
            return

        # ── Execute current step ──
        self.get_logger().info(f'Executing step {self._current_step_idx + 1}/{len(self._steps)}: [{action}] {step.get("label", "")}')

        # Derived-move resolver: descend / lift / retreat / "approach
        # finished part" carry `derived_from: '<role>'` + offset_z_mm and
        # compute their target at runtime from a prior step's taught_tcp.
        # _resolve_base_tcp walks backward from the current step looking
        # for the matching source by `position_role` (explicit) or, for
        # legacy programs without the tag, the most recent step that
        # carries any taught_tcp/position. Returns (tcp_list, label).

        if action == 'move_home':
            self._send_cmd({'action': 'home'})
            self._state = self.WAITING_MOTION

        elif action == 'move_joint':
            joints = step.get('taught_joints') or step.get('joints')
            if joints and len(joints) >= 6:
                self._send_move({
                    'type': 'movj',
                    'joints': joints,
                    'speed_pct': step.get('speed_pct', 50),
                })
                self._state = self.WAITING_MOTION
            else:
                self.get_logger().warn(f'Step {self._current_step_idx + 1}: no joint position — skipping')
                self._advance_step()

        elif action == 'move_linear':
            # Derived offset moves (descend / lift / retreat / "approach
            # finished part") carry derived_from + offset_z_mm and resolve
            # at runtime by reading the source step's taught_tcp and
            # adding the z offset. The operator teaches the source ONCE;
            # all derived children pick up the new pose automatically.
            #
            # Override: if the operator manually overrode the derived
            # step in the editor (overridden:true + a real taught_tcp),
            # we use that pose verbatim and skip the base+offset path.
            # Reset-to-auto in the editor clears both fields and we
            # fall back to the link.
            overridden = bool(step.get('overridden')) and (
                isinstance(step.get('taught_tcp'), list) and len(step['taught_tcp']) >= 3
            )
            base_tcp, source_label = self._resolve_base_tcp(step)
            offset_z_mm = float(step.get('offset_z_mm') or 0)
            is_derived = (not overridden) and (
                (step.get('derived_from') is not None) or (
                    # Heuristic for older saves: a move_linear with offset and
                    # no own taught data is a wizard-derived step.
                    step.get('offset_z_mm') is not None
                    and not (step.get('taught_tcp') or step.get('position'))
                    and not (step.get('taught_joints') or step.get('joints'))
                )
            )
            if is_derived:
                if base_tcp is None:
                    role = step.get('derived_from') or 'previous taught position'
                    self.get_logger().warn(
                        f'Step {self._current_step_idx + 1}: derived from "{role}" '
                        f'but {source_label or "source"} is not taught — skipping'
                    )
                    self._advance_step()
                    return
                # base_tcp is in meters from /api/state-style payloads.
                # Apply z offset in meters (mm → m).
                target = [
                    base_tcp[0],
                    base_tcp[1],
                    base_tcp[2] + offset_z_mm / 1000.0,
                    base_tcp[3] if len(base_tcp) > 3 else 0,
                    base_tcp[4] if len(base_tcp) > 4 else 0,
                    base_tcp[5] if len(base_tcp) > 5 else 0,
                ]
                tcp_mm = [
                    target[0] * 1000 if abs(target[0]) < 10 else target[0],
                    target[1] * 1000 if abs(target[1]) < 10 else target[1],
                    target[2] * 1000 if abs(target[2]) < 10 else target[2],
                    target[3], target[4], target[5],
                ]
                self._send_move({
                    'type': 'movl',
                    'tcp': tcp_mm,
                    'speed_pct': step.get('speed_pct', 30),
                })
                self._state = self.WAITING_MOTION
                return
            # Non-derived: existing behavior — read taught pose directly.
            tcp = step.get('taught_tcp') or step.get('position')
            joints = step.get('taught_joints') or step.get('joints')
            if tcp and len(tcp) >= 3:
                # Convert meters to mm for Estun API
                tcp_mm = [
                    tcp[0] * 1000 if abs(tcp[0]) < 10 else tcp[0],
                    tcp[1] * 1000 if abs(tcp[1]) < 10 else tcp[1],
                    tcp[2] * 1000 if abs(tcp[2]) < 10 else tcp[2],
                    tcp[3] if len(tcp) > 3 else 0,
                    tcp[4] if len(tcp) > 4 else 0,
                    tcp[5] if len(tcp) > 5 else 0,
                ]
                self._send_move({
                    'type': 'movl',
                    'tcp': tcp_mm,
                    'speed_pct': step.get('speed_pct', 30),
                })
                self._state = self.WAITING_MOTION
            elif joints and len(joints) >= 6:
                # Fallback to joint move if no TCP
                self._send_move({
                    'type': 'movj',
                    'joints': joints,
                    'speed_pct': step.get('speed_pct', 30),
                })
                self._state = self.WAITING_MOTION
            else:
                self.get_logger().warn(f'Step {self._current_step_idx + 1}: no position — skipping')
                self._advance_step()

        elif action == 'approach':
            joints = step.get('taught_joints') or step.get('joints')
            if joints and len(joints) >= 6:
                self._send_move({
                    'type': 'movj',
                    'joints': joints,
                    'speed_pct': step.get('speed_pct', 50),
                })
                self._state = self.WAITING_MOTION
            else:
                self._advance_step()

        elif action == 'pick':
            joints = step.get('taught_joints') or step.get('joints')
            if joints and len(joints) >= 6:
                self._send_move({
                    'type': 'movj',
                    'joints': joints,
                    'speed_pct': step.get('speed_pct', 20),
                })
                self._state = self.WAITING_MOTION
                self._total_picks += 1
            else:
                self._advance_step()

        elif action == 'place':
            joints = step.get('taught_joints') or step.get('joints')
            tcp = step.get('taught_tcp') or step.get('position')
            if joints and len(joints) >= 6:
                self._send_move({
                    'type': 'movj',
                    'joints': joints,
                    'speed_pct': step.get('speed_pct', 20),
                })
                self._state = self.WAITING_MOTION
            elif tcp:
                if len(tcp) >= 6:
                    tcp_mm = [t * 1000 if abs(t) < 10 else t for t in tcp[:3]] + list(tcp[3:6])
                else:
                    tcp_mm = [t * 1000 if abs(t) < 10 else t for t in tcp[:3]] + [0, 0, 0]
                self._send_move({
                    'type': 'movl',
                    'tcp': tcp_mm,
                    'speed_pct': step.get('speed_pct', 20),
                })
                self._state = self.WAITING_MOTION
            else:
                self._advance_step()

        elif action == 'open_gripper':
            # Use I/O port from step config
            io_open = step.get('io_open', 'DO1')
            io_close = step.get('io_close', 'DO0')
            self._send_io(io_open, 1)   # activate open
            self._send_io(io_close, 0)  # deactivate close
            # Wait briefly for gripper to open
            self._wait_until = time.time() + 0.5
            self._state = self.WAITING_TIME

        elif action == 'close_gripper':
            io_close = step.get('io_close', 'DO0')
            io_open = step.get('io_open', 'DO1')
            self._send_io(io_close, 1)  # activate close
            self._send_io(io_open, 0)   # deactivate open
            # Wait for gripper to close
            self._wait_until = time.time() + 0.5
            self._state = self.WAITING_TIME
            # Check gripper confirmation after wait
            self._pick_passes += 1  # TODO: check DI confirm signal

        elif action == 'wait':
            duration = step.get('duration_s', 1.0)
            self._wait_until = time.time() + duration
            self._state = self.WAITING_TIME

        elif action == 'detect':
            # Trigger detection — for now just wait briefly
            self._wait_until = time.time() + 1.0
            self._state = self.WAITING_DETECT

        elif action == 'set_io':
            io_id = step.get('io_id', 'DO0')
            value = step.get('value', 0)
            self._send_io(io_id, value)
            self._wait_until = time.time() + 0.1
            self._state = self.WAITING_TIME

        elif action == 'scan_workspace':
            # Read current detections from the dashboard's /api/detections.
            # The depth_segment_node publishes detections continuously;
            # we just snapshot them at this instant. Note: positions are
            # in CAMERA frame today — to move above each object the
            # robot needs camera-to-robot extrinsics calibration, which
            # is tracked separately. Until that lands, scan_identify_each
            # only logs the intent.
            try:
                import urllib.request as _ur
                with _ur.urlopen('http://localhost:8080/api/detections', timeout=2) as resp:
                    data = json.loads(resp.read().decode())
                self._scan_results = data.get('objects', []) or []
                self.get_logger().info(
                    f'Scan found {len(self._scan_results)} object'
                    f'{"" if len(self._scan_results) == 1 else "s"}')
            except Exception as e:
                self.get_logger().warn(f'Failed to read detections: {e}')
                self._scan_results = []
            self._identified_parts  = []
            self._scan_identify_idx = 0
            self._advance_step()

        elif action == 'scan_identify_each':
            # Walks the snapshot from scan_workspace, intending to move
            # the robot above each detected object for a close-up
            # identification. Without camera->robot extrinsics we can't
            # send a real motion command; we still record the per-object
            # ID + confidence so the Monitor scan-results panel works.
            scan_height_m  = float(step.get('scan_height_mm', 150)) / 1000.0
            scan_speed_pct = int(step.get('scan_speed_pct', 20))
            settle_s       = float(step.get('settle_time_ms', 500)) / 1000.0

            if not self._scan_results:
                self.get_logger().warn('No scan results from scan_workspace — skipping identify')
                self._advance_step()
                return

            if self._scan_identify_idx >= len(self._scan_results):
                self.get_logger().info(
                    f'Identified {len(self._identified_parts)} part'
                    f'{"" if len(self._identified_parts) == 1 else "s"}:')
                for p in self._identified_parts:
                    self.get_logger().info(
                        f'  {p.get("part_id", "unknown")} '
                        f'conf={p.get("confidence", 0):.0f}%')
                self._scan_identify_idx = 0
                self._advance_step()
                return

            obj = self._scan_results[self._scan_identify_idx]
            obj_x = float(obj.get('x', 0))
            obj_y = float(obj.get('y', 0))
            obj_z = float(obj.get('z', 0))
            self.get_logger().info(
                f'Scanning object {self._scan_identify_idx + 1}/{len(self._scan_results)} '
                f'at cam frame ({obj_x:.3f}, {obj_y:.3f}, {obj_z:.3f})')

            # TODO: send movl above (obj_x, obj_y, obj_z + scan_height_m)
            # once camera->robot calibration is wired. For now we just
            # capture the existing detection metadata.
            _ = scan_height_m, scan_speed_pct  # keep for the eventual move

            self._identified_parts.append({
                'scan_index':  self._scan_identify_idx,
                'x': obj_x, 'y': obj_y, 'z': obj_z,
                'part_id':     obj.get('part_id', 'unknown'),
                'confidence':  float(obj.get('confidence', 0)),
                'orientation': obj.get('orientation', 'unknown'),
                'is_defect':   bool(obj.get('is_defect', False)),
                'defect_name': obj.get('defect_name', ''),
            })

            self._scan_identify_idx += 1
            self._wait_until = time.time() + settle_s
            self._state = self.WAITING_TIME

        elif action == 'sort_scanned':
            # Placeholder — a real implementation needs:
            #   * a per-part-id place position (or a bin per type)
            #   * camera->robot calibration so we know where each
            #     identified part actually is
            # Until those are wired we log and advance.
            self.get_logger().info(
                f'sort_scanned: {len(self._identified_parts)} parts in queue '
                '(placeholder — needs per-type bin positions + calibration)')
            self._advance_step()

        elif action == 'remove_defects':
            defects = [p for p in self._identified_parts if p.get('is_defect')]
            self.get_logger().info(
                f'remove_defects: {len(defects)} defective parts found '
                '(placeholder — needs reject-bin position + calibration)')
            self._advance_step()

        elif action == 'move_to_pallet':
            self._tick_move_to_pallet(step)
            return

        elif action == 'loop':
            goto_step = step.get('goto', 1) - 1  # convert 1-indexed to 0-indexed
            count = step.get('count', 0)  # 0 = infinite
            self._cycle_count += 1

            # Record cycle time
            now = time.time()
            self._last_cycle_time = round(now - self._cycle_start_time, 2)
            self._cycle_start_time = now

            if count > 0 and self._cycle_count >= count:
                self.get_logger().info(f'Loop complete: {self._cycle_count}/{count} cycles')
                self._advance_step()
            else:
                self.get_logger().info(f'Loop iteration {self._cycle_count}{" / " + str(count) if count > 0 else ""} — jumping to step {goto_step + 1}')
                self._current_step_idx = max(0, min(goto_step, len(self._steps) - 1))

        elif action == 'inspect_part':
            self._handle_inspect_part(step)

        elif action == 'place_at_reject':
            tcp = step.get('reject_tcp') or step.get('taught_tcp')
            if tcp and len(tcp) >= 3:
                tcp_mm = [
                    tcp[0] * 1000 if abs(tcp[0]) < 10 else tcp[0],
                    tcp[1] * 1000 if abs(tcp[1]) < 10 else tcp[1],
                    tcp[2] * 1000 if abs(tcp[2]) < 10 else tcp[2],
                    tcp[3] if len(tcp) > 3 else 0,
                    tcp[4] if len(tcp) > 4 else 0,
                    tcp[5] if len(tcp) > 5 else 0,
                ]
                self._send_move({
                    'type': 'movl',
                    'tcp': tcp_mm,
                    'speed_pct': step.get('speed_pct', 30),
                })
                self._state = self.WAITING_MOTION
            else:
                self.get_logger().warn(
                    f'place_at_reject: no reject position taught — skipping')
                self._advance_step()

        elif action == 'alert_operator':
            # Publish the alert so the dashboard can render it; then
            # park in WAITING_OPERATOR until an ack arrives (or the
            # timeout fires per `on_timeout`).
            alert = {
                'type':      'inspection_alert',
                'severity':  step.get('severity', 'warn'),
                'message':   step.get('message',
                                      'Inspection requires operator review'),
                'inspection_id': self._current_inspection_id,
                'timestamp':  time.time(),
            }
            self._pub_alert.publish(String(data=json.dumps(alert)))
            self._operator_ack = False
            self._wait_until = time.time()
            self._state = self.WAITING_OPERATOR

        elif action == 'log_inspection':
            # Records the most-recent inspection result into stats
            # without taking any action on it. Useful in sample-mode
            # inspection programs where only every Nth part is
            # actually inspected.
            self.get_logger().info(
                f'log_inspection: result={self._last_inspection_result}, '
                f'pass_total={self._inspection_pass_count}, '
                f'fail_total={self._inspection_fail_count}')
            self._advance_step()

        else:
            self.get_logger().warn(f'Unknown action: {action} — skipping')
            self._advance_step()

    # ── Inspection-step support ───────────────────────────

    def _handle_inspect_part(self, step):
        """Kick off an inspection and park in WAITING_INSPECTION.

        Sampling: if `every_n_parts` > 1, only inspect every Nth part.
        Manual triggers (every_n_parts=0) skip the inspection here —
        the operator invokes it from the dashboard instead.
        """
        every_n = int(step.get('every_n_parts', 1))
        self._inspection_sample_counter += 1
        if every_n > 1 and (self._inspection_sample_counter % every_n) != 0:
            self.get_logger().info(
                f'inspect_part: skipping (sample {self._inspection_sample_counter} '
                f'of every {every_n})')
            self._last_inspection_result = 'pass'  # treat as pass for branching
            self._advance_step()
            return
        if every_n == 0:
            # Manual-trigger only — never starts an inspection from
            # inside the program.
            self._advance_step()
            return

        # Publish per-inspection params (part_id / plan_id) onto the
        # /inspection/set_params topic so the inspection_node knows
        # what to scan against. The actual /inspection/start ROS
        # service call is fired by the dashboard or by a sibling node
        # — here we just record what we're waiting for.
        params = {
            'part_id':       step.get('part_id', 'unknown'),
            'plan_id':       step.get('plan_id', 'default'),
            'tier':          step.get('tier', 1),
            'reference_type': step.get('reference_type', 'step'),
            'trigger_source': 'program',
            'program':       self._program_name,
        }
        self._pub_insp_params.publish(String(data=json.dumps(params)))

        self._current_inspection_id  = None
        self._last_inspection_result = None
        self._last_inspection_record = None
        self._inspection_in_progress = True
        self._wait_until = time.time()
        self._state = self.WAITING_INSPECTION

    def _handle_inspection_outcome(self, step):
        """Branch the program based on the last inspection result."""
        result = self._last_inspection_result or 'pass'
        action_on_pass = step.get('on_pass',  'continue')
        action_on_warn = step.get('on_warn',  'log_continue')
        action_on_fail = step.get('on_fail',  'pause')

        chosen = {
            'pass': action_on_pass,
            'warn': action_on_warn,
            'fail': action_on_fail,
            'error': action_on_fail,
        }.get(result, 'continue')

        self.get_logger().info(
            f'inspection result: {result} → action={chosen}')

        if chosen == 'continue' or chosen == 'log_continue':
            self._advance_step()
        elif chosen == 'pause':
            self._state = self.PAUSED
        elif chosen == 'abort':
            self._state = self.ERROR
        elif chosen == 'jump_to_reject':
            # Jump to the next place_at_reject step if any.
            reject_idx = self._find_step_by_action('place_at_reject')
            if reject_idx is not None:
                self._current_step_idx = reject_idx
                self._state = self.RUNNING
            else:
                self.get_logger().warn(
                    'inspection on_fail=jump_to_reject but no '
                    'place_at_reject step found — pausing instead')
                self._state = self.PAUSED
        else:
            self._advance_step()

    def _find_step_by_action(self, action_name):
        for i in range(self._current_step_idx + 1, len(self._steps)):
            if self._steps[i].get('action') == action_name:
                return i
        return None

    def _resolve_base_tcp(self, step):
        """Find the base TCP for a derived offset move.

        Walks backward through self._steps from the current step looking
        for the source pose:
          - If `step.derived_from` is set (e.g. 'pick'), find the most
            recent prior step with `position_role` matching that role
            and read its taught_tcp.
          - Otherwise (legacy programs without the tag) take the most
            recent prior step that carries any taught_tcp / position.

        Returns (tcp_list_in_meters, source_label) — tcp_list is a list
        of length 3 or 6 (meters / radians), or (None, label) if no
        suitable source is found. `source_label` is the human-readable
        role for warning messages.
        """
        derived_from = step.get('derived_from')
        # Walk backward from immediately before the current step.
        for i in range(self._current_step_idx - 1, -1, -1):
            src = self._steps[i]
            if derived_from is not None:
                if src.get('position_role') != derived_from:
                    continue
            tcp = src.get('taught_tcp') or src.get('position')
            if tcp and len(tcp) >= 3:
                return list(tcp), (derived_from or src.get('position_role') or src.get('label') or 'previous taught position')
        return None, (derived_from or 'previous taught position')

    def _advance_step(self):
        """Move to the next step."""
        self._current_step_idx += 1
        self._state = self.RUNNING

        if self._current_step_idx >= len(self._steps):
            self._on_program_complete()

    def _on_program_complete(self):
        """Program finished all steps."""
        now = time.time()
        if self._cycle_start_time > 0:
            self._last_cycle_time = round(now - self._cycle_start_time, 2)
            self._motion_last_cycle_time = self._last_cycle_time
            self._motion_cycles_completed += 1

        self._state = self.COMPLETE
        self._current_step_idx = -1
        self.get_logger().info(
            f'Program "{self._program_name}" complete. '
            f'Cycles: {self._cycle_count}, Picks: {self._total_picks} '
            f'(pass: {self._pick_passes}, fail: {self._pick_fails})')

        # Save stats
        self._save_stats()
        # Publish motion-optimization statistics so the Monitor badge and
        # /opt/cobot/motion/statistics/ historical data can update.
        try:
            self._publish_motion_statistics()
        except Exception as e:
            self.get_logger().debug(f'motion statistics publish failed: {e}')

    # ── move_to_pallet multi-phase compound motion ────────

    def _tick_move_to_pallet(self, step, motion_complete=False, time_complete=False):
        """Drive the compound motion for a single move_to_pallet step.

        Substeps (palletize = place, depalletize = pick):
          0: traverse XY to retract above slot       (medium speed)
          1: descend to approach height above slot   (slow)
          2: descend to slot                          (slow)
          3: fire gripper (release for palletize,
             close for depalletize) and brief settle
          4: lift back to retract above slot          (medium)
          done: advance pallet_state.cycle, advance step
        """
        pallet = self._pallet_state
        config = pallet.get('config')
        if not config:
            self.get_logger().warn('move_to_pallet without pallet config — skipping')
            self._advance_step()
            return

        cycle = pallet.get('cycle', 0)
        rows   = int(config.get('rows',   1) or 1)
        cols   = int(config.get('cols',   1) or 1)
        layers = int(config.get('layers', 1) or 1)
        total  = max(1, rows * cols * layers)
        if cycle >= total:
            self.get_logger().warn(
                f'move_to_pallet cycle {cycle} beyond capacity {total} — skipping')
            self._advance_step()
            return

        row, col, layer = self._get_next_slot(config, cycle)
        pallet['row']   = row
        pallet['col']   = col
        pallet['layer'] = layer

        slot           = self._compute_pallet_position(config, row, col, layer)
        appH_m         = float(config.get('approach_height_mm', 100)) / 1000.0
        retH_m         = float(config.get('retract_height_mm',  200)) / 1000.0
        above_retract  = {**slot, 'z': slot['z'] + retH_m}
        above_approach = {**slot, 'z': slot['z'] + appH_m}

        spd    = int(step.get('speed_pct', 30))
        slow   = max(5,  min(spd, 20))
        medium = max(10, min(spd, 40))
        is_place = (pallet.get('mode') == 'palletize')

        # New step entering — reset substep tracking. The fresh enter is
        # the only call with neither motion nor time completion flags
        # set, and current substep hasn't been touched yet for this step.
        if not motion_complete and not time_complete:
            self._pallet_substep  = 0
            self._pallet_io_fired = False
        elif motion_complete or time_complete:
            # Previous substep done — bump.
            self._pallet_substep += 1

        sub = self._pallet_substep

        if sub == 0:
            self.get_logger().info(
                f'Pallet cycle {cycle + 1}/{total}: traverse to retract '
                f'above slot row={row} col={col} layer={layer}')
            self._send_pallet_move(above_retract, medium)
            self._state = self.WAITING_MOTION
            return

        if sub == 1:
            self._send_pallet_move(above_approach, slow)
            self._state = self.WAITING_MOTION
            return

        if sub == 2:
            self._send_pallet_move(slot, slow)
            self._state = self.WAITING_MOTION
            return

        if sub == 3:
            # Fire the gripper and park briefly while it actuates. The
            # IO command itself is fast; the wait lets the gripper close
            # / release before we lift.
            if not self._pallet_io_fired:
                self._fire_pallet_gripper(step, 'open' if is_place else 'close')
                self._pallet_io_fired = True
                if is_place:
                    self._pick_passes += 1
                else:
                    self._total_picks += 1
                    self._pick_passes += 1
            self._wait_until = time.time() + 0.4
            self._state = self.WAITING_TIME
            return

        if sub == 4:
            self._send_pallet_move(above_retract, medium)
            self._state = self.WAITING_MOTION
            return

        # Compound motion complete — advance the pallet cycle counter
        # then step forward. The next iteration of the program's
        # outer loop will re-enter move_to_pallet with cycle + 1.
        pallet['cycle']        = cycle + 1
        self._pallet_substep   = 0
        self._pallet_io_fired  = False
        self.get_logger().info(
            f'Pallet cycle {cycle + 1}/{total} complete '
            f'(row={row} col={col} layer={layer})')
        self._advance_step()

    # ── Pallet helpers ────────────────────────────────────

    def _compute_pallet_position(self, config, row, col, layer):
        """Translate a (row, col, layer) grid slot into an absolute
        TCP using the corner_tcp + spacing fields the wizard saved.

        corner_tcp is in metres / radians (matches Estun TCP convention);
        spacing_*_mm and layer_height_mm are millimetres so we divide by
        1000 before adding. rx/ry/rz are taken straight from the corner."""
        corner = config.get('corner_tcp') or {}
        cx = float(corner.get('x', 0.0))
        cy = float(corner.get('y', 0.0))
        cz = float(corner.get('z', 0.0))
        rx = float(corner.get('rx', 0.0))
        ry = float(corner.get('ry', 0.0))
        rz = float(corner.get('rz', 0.0))
        sx = float(config.get('spacing_x_mm', 150)) / 1000.0
        sy = float(config.get('spacing_y_mm', 150)) / 1000.0
        lz = float(config.get('layer_height_mm', 100)) / 1000.0
        return {
            'x':  cx + col * sx,
            'y':  cy + row * sy,
            'z':  cz + layer * lz,
            'rx': rx, 'ry': ry, 'rz': rz,
        }

    def _get_next_slot(self, config, cycle):
        """Return (row, col, layer) for the Nth pallet cycle (0-indexed)
        under the configured fill order. For depalletize the layer is
        reversed so the top layer is emptied first."""
        rows   = int(config.get('rows',   1) or 1)
        cols   = int(config.get('cols',   1) or 1)
        layers = int(config.get('layers', 1) or 1)
        layer_size = max(1, rows * cols)
        order = config.get('fill_order') or 'row_lr'

        layer_idx = cycle // layer_size
        within    = cycle %  layer_size

        if order == 'row_lr':
            r = (within // cols) % rows
            c = within % cols
        elif order == 'row_rl':
            r = (within // cols) % rows
            c = (cols - 1) - (within % cols)
        elif order == 'col':
            r = within % rows
            c = (within // rows) % cols
        elif order == 'snake':
            r = (within // cols) % rows
            within_row = within % cols
            c = within_row if (r % 2 == 0) else (cols - 1 - within_row)
        else:
            r = (within // cols) % rows
            c = within % cols

        if self._pallet_state.get('mode') == 'depalletize':
            layer = (layers - 1) - (layer_idx % layers)
        else:
            layer = layer_idx % layers
        return (r, c, layer)

    def _send_pallet_move(self, tcp, speed_pct, motion='movl'):
        """Helper — convert a pallet TCP dict (metres) into the mm-format
        Estun /estun/move expects and publish it."""
        tcp_mm = [
            tcp['x'] * 1000.0,
            tcp['y'] * 1000.0,
            tcp['z'] * 1000.0,
            tcp.get('rx', 0.0),
            tcp.get('ry', 0.0),
            tcp.get('rz', 0.0),
        ]
        self._send_move({'type': motion, 'tcp': tcp_mm, 'speed_pct': int(speed_pct)})

    def _fire_pallet_gripper(self, step, phase):
        """Fire the gripper IO for the current move_to_pallet phase.
        phase='close' → grip; phase='open' → release.
        Looks up the IO from the step's gripper_type so palletize
        programs work for finger / vacuum / magnetic alike."""
        gtype = step.get('gripper_type', 'finger')
        if gtype == 'finger':
            if phase == 'close':
                self._send_io(step.get('io_close', 'DO0'), 1)
                self._send_io(step.get('io_open',  'DO1'), 0)
            else:
                self._send_io(step.get('io_open',  'DO1'), 1)
                self._send_io(step.get('io_close', 'DO0'), 0)
        elif gtype == 'vacuum':
            self._send_io(step.get('io_vacuum', 'DO2'), 1 if phase == 'close' else 0)
        elif gtype == 'magnetic':
            self._send_io(step.get('io_magnet', 'DO3'), 1 if phase == 'close' else 0)

    # ── Helpers ───────────────────────────────────────────

    def _send_cmd(self, cmd):
        """Publish a command to the Estun driver."""
        msg = String()
        msg.data = json.dumps(cmd)
        self._pub_cmd.publish(msg)

    def _send_move(self, move_data):
        """Publish a motion command, optionally scaled by the active motion profile.

        The scaling layer is a stop-gap until /estun/move carries a full
        joint trajectory we can hand to TOPP-RA. We multiply the
        commanded speed_pct by the profile's velocity_scale_pct ratio
        (against a 70%% baseline so the default Balanced profile is a
        no-op against pre-motion-opt programs).
        """
        try:
            move_data = self._apply_motion_profile(dict(move_data))
        except Exception as e:
            self.get_logger().debug(f'motion profile scaling skipped: {e}')
        msg = String()
        msg.data = json.dumps(move_data)
        self._pub_move.publish(msg)
        self._motion_segments_optimized += 1

    def _load_motion_profile(self, name):
        """Read a motion profile body from /opt/cobot/motion/.

        Built-ins are baked into the package's default_profiles.yaml; user
        profiles live in /opt/cobot/motion/config/profiles.json. Returns a
        plain dict (or None if the name can't be resolved).
        """
        # Custom profiles first
        try:
            custom_path = '/opt/cobot/motion/config/profiles.json'
            if os.path.isfile(custom_path):
                with open(custom_path) as f:
                    customs = json.load(f) or {}
                if name in customs:
                    return customs[name]
        except Exception:
            pass
        # Built-ins from install share
        try:
            import yaml
            from ament_index_python.packages import get_package_share_directory
            share = get_package_share_directory('motion_optimization')
            with open(os.path.join(share, 'config', 'default_profiles.yaml')) as f:
                doc = yaml.safe_load(f) or {}
            builtins = (doc.get('profiles') or {})
            if name in builtins:
                body = dict(builtins[name])
                body['name'] = name
                return body
        except Exception as e:
            self.get_logger().debug(f'Could not load default_profiles.yaml: {e}')
        return None

    def _apply_motion_profile(self, move_data):
        """Mutate move_data['speed_pct'] in place per the active profile.

        Move types respected:
          movj / movl / movc / move_to_position → velocity_scale_pct
          approach moves (move_data.get('phase') == 'approach') →
            approach_speed_pct
          retreat moves (phase == 'retreat') → retreat_speed_pct
        When _motion_enabled is False or no profile is cached, move_data
        is returned unchanged.
        """
        if not self._motion_enabled or not self._motion_profile:
            return move_data
        prof = self._motion_profile
        phase = move_data.get('phase')
        if phase == 'approach':
            factor_pct = prof.get('approach_speed_pct',
                                  prof.get('velocity_scale_pct',
                                           _PROFILE_BASELINE_VEL_PCT))
        elif phase == 'retreat':
            factor_pct = prof.get('retreat_speed_pct',
                                  prof.get('velocity_scale_pct',
                                           _PROFILE_BASELINE_VEL_PCT))
        else:
            factor_pct = prof.get('velocity_scale_pct',
                                  _PROFILE_BASELINE_VEL_PCT)
        # Express the profile factor relative to the 70% baseline so the
        # default Balanced profile is the identity for legacy programs.
        ratio = max(0.05, min(2.0, float(factor_pct) / _PROFILE_BASELINE_VEL_PCT))
        base_speed = float(move_data.get('speed_pct', 50))
        new_speed = max(1.0, min(100.0, base_speed * ratio))
        move_data['speed_pct'] = round(new_speed, 1)
        move_data['motion_profile'] = prof.get('name')
        return move_data

    def _publish_motion_statistics(self):
        """Publish a MotionStatistics snapshot after a cycle finishes."""
        if not self._pub_motion_stats or not MOTION_MSGS_AVAILABLE:
            return
        msg = MotionStatistics()
        try:
            msg.header.stamp = self.get_clock().now().to_msg()
        except Exception:
            pass
        msg.program_id = self._program_id or ''
        msg.program_name = self._program_name or ''
        msg.estimated_cycle_time_s = float(self._motion_optimize_estimate_s)
        msg.actual_cycle_time_s = float(self._motion_last_cycle_time)
        diff = msg.actual_cycle_time_s - msg.estimated_cycle_time_s
        msg.cycle_time_savings_s = float(self._motion_unopt_estimate_s -
                                         msg.actual_cycle_time_s)
        denom = max(self._motion_unopt_estimate_s, 1e-3)
        msg.cycle_time_savings_pct = float(
            100.0 * msg.cycle_time_savings_s / denom)
        msg.total_segments = int(self._motion_segment_count)
        msg.optimized_segments = int(self._motion_segments_optimized)
        msg.cycles_completed = int(self._motion_cycles_completed)
        self._pub_motion_stats.publish(msg)

    def _send_io(self, io_id, value):
        """Publish an I/O command."""
        msg = String()
        msg.data = json.dumps({'io_id': io_id, 'value': int(value)})
        self._pub_io.publish(msg)

    def _publish_state(self):
        """Publish current execution state for the dashboard."""
        step_label = ''
        step_action = ''
        if 0 <= self._current_step_idx < len(self._steps):
            s = self._steps[self._current_step_idx]
            step_label = s.get('label', '')
            step_action = s.get('action', '')

        # Pallet snapshot — null when no pallet program is loaded, so
        # the dashboard widget knows to hide itself. The cycle / row /
        # col / layer keep updating across the program's outer loop so
        # the operator sees which slot is being placed / picked.
        pallet      = self._pallet_state
        pallet_mode = pallet.get('mode')
        if pallet_mode and isinstance(pallet.get('config'), dict):
            cfg = pallet['config']
            rows   = int(cfg.get('rows',   1) or 1)
            cols   = int(cfg.get('cols',   1) or 1)
            layers = int(cfg.get('layers', 1) or 1)
            pallet_total = max(1, rows * cols * layers)
            pallet_cycle = int(pallet.get('cycle', 0))
            pallet_row   = int(pallet.get('row',   0))
            pallet_col   = int(pallet.get('col',   0))
            pallet_layer = int(pallet.get('layer', 0))
        else:
            pallet_mode  = None
            pallet_total = None
            pallet_cycle = None
            pallet_row   = None
            pallet_col   = None
            pallet_layer = None

        state = {
            'state': self._state,
            'program_id': self._program_id,
            'program_name': self._program_name,
            'current_step': self._current_step_idx,
            'total_steps': len(self._steps),
            'step_label': step_label,
            'step_action': step_action,
            'cycle_count': self._cycle_count,
            'last_cycle_time': self._last_cycle_time,
            'total_picks': self._total_picks,
            'pick_passes': self._pick_passes,
            'pick_fails': self._pick_fails,
            'robot_connected': self._robot_connected,
            'robot_mode': self._robot_mode,
            # Scan & Identify snapshots — present even on non-scan
            # programs (empty lists) so the Monitor can render
            # consistently. scan_count is the wide-scan total;
            # identified_count is how many have been close-up scanned.
            'scan_results':     list(self._identified_parts),
            'scan_count':       len(self._scan_results),
            'identified_count': len(self._identified_parts),
            # Pallet progress — all fields are null when no pallet
            # program is loaded so the Monitor widget hides cleanly.
            'pallet_mode':  pallet_mode,
            'pallet_cycle': pallet_cycle,
            'pallet_total': pallet_total,
            'pallet_row':   pallet_row,
            'pallet_col':   pallet_col,
            'pallet_layer': pallet_layer,
            # Inspection progress — null when no inspection program is
            # loaded or when no inspection has run yet.
            'current_inspection_id':   self._current_inspection_id,
            'last_inspection_result':  self._last_inspection_result,
            'inspection_in_progress':  self._inspection_in_progress,
            'cumulative_pass_count':   self._inspection_pass_count,
            'cumulative_fail_count':   self._inspection_fail_count,
        }

        msg = String()
        msg.data = json.dumps(state)
        self._pub_state.publish(msg)

    def _save_stats(self):
        """Save program execution stats to disk."""
        if not self._program_id:
            return
        stats_path = os.path.join(STATS_DIR, f'{self._program_id}.json')

        # Load existing stats
        existing = {}
        if os.path.isfile(stats_path):
            try:
                with open(stats_path) as f:
                    existing = json.load(f)
            except Exception:
                pass

        # Merge
        total = existing.get('total', 0) + self._total_picks
        passes = existing.get('pass', 0) + self._pick_passes
        fails = existing.get('fail', 0) + self._pick_fails
        cycle_times = existing.get('cycle_times', [])
        if self._last_cycle_time > 0:
            cycle_times.append({
                'time': self._last_cycle_time,
                'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
            })
        # Keep last 500 cycle times
        cycle_times = cycle_times[-500:]

        stats = {
            'program_id': self._program_id,
            'total': total,
            'pass': passes,
            'fail': fails,
            'cycle_times': cycle_times,
            'fail_reasons': existing.get('fail_reasons', []),
            'last_run': time.strftime('%Y-%m-%d %H:%M:%S'),
        }

        try:
            with open(stats_path, 'w') as f:
                json.dump(stats, f, indent=2)
        except Exception as e:
            self.get_logger().warn(f'Failed to save stats: {e}')


def main(args=None):
    rclpy.init(args=args)
    node = ProgramExecutor()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
