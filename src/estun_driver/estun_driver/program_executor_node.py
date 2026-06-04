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


class ProgramExecutor(Node):

    # Execution states
    IDLE = 'idle'
    RUNNING = 'running'
    PAUSED = 'paused'
    WAITING_MOTION = 'waiting_motion'
    WAITING_IO = 'waiting_io'
    WAITING_DETECT = 'waiting_detect'
    WAITING_TIME = 'waiting_time'
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
        self._lock = threading.Lock()

        # Publishers
        self._pub_state = self.create_publisher(String, '/task/state', 10)
        self._pub_cmd = self.create_publisher(String, '/estun/command', 10)
        self._pub_move = self.create_publisher(String, '/estun/move', 10)
        self._pub_io = self.create_publisher(String, '/robot/io_command', 10)
        self._pub_jog = self.create_publisher(String, '/robot/jog_command', 10)

        # Subscribers
        self.create_subscription(String, '/task/run_program', self._on_run_command, 10)
        self.create_subscription(String, '/estun/status', self._on_robot_status, 10)
        self.create_subscription(Bool, '/estun/is_moving', self._on_is_moving, 10)

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

        self.get_logger().info(f'Loaded program "{self._program_name}" with {len(self._steps)} steps')
        self._start_execution()

    def _start_execution(self):
        """Begin executing from step 0."""
        self._current_step_idx = 0
        self._cycle_count = 0
        self._cycle_start_time = time.time()
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

    # ── Execution Engine ──────────────────────────────────

    def _execution_tick(self):
        """Main execution loop — runs at 20Hz."""
        if self._state not in (self.RUNNING, self.WAITING_MOTION, self.WAITING_TIME, self.WAITING_IO, self.WAITING_DETECT):
            return

        if self._current_step_idx < 0 or self._current_step_idx >= len(self._steps):
            self._on_program_complete()
            return

        step = self._steps[self._current_step_idx]
        action = step.get('action', '')

        # ── Waiting states ──
        if self._state == self.WAITING_MOTION:
            if not self._is_robot_moving:
                # Motion complete — advance to next step
                self.get_logger().info(f'Step {self._current_step_idx + 1} motion complete: {step.get("label", action)}')
                self._advance_step()
            return

        if self._state == self.WAITING_TIME:
            if time.time() >= self._wait_until:
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

        # ── Execute current step ──
        self.get_logger().info(f'Executing step {self._current_step_idx + 1}/{len(self._steps)}: [{action}] {step.get("label", "")}')

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

        else:
            self.get_logger().warn(f'Unknown action: {action} — skipping')
            self._advance_step()

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

        self._state = self.COMPLETE
        self._current_step_idx = -1
        self.get_logger().info(
            f'Program "{self._program_name}" complete. '
            f'Cycles: {self._cycle_count}, Picks: {self._total_picks} '
            f'(pass: {self._pick_passes}, fail: {self._pick_fails})')

        # Save stats
        self._save_stats()

    # ── Helpers ───────────────────────────────────────────

    def _send_cmd(self, cmd):
        """Publish a command to the Estun driver."""
        msg = String()
        msg.data = json.dumps(cmd)
        self._pub_cmd.publish(msg)

    def _send_move(self, move_data):
        """Publish a motion command."""
        msg = String()
        msg.data = json.dumps(move_data)
        self._pub_move.publish(msg)

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
