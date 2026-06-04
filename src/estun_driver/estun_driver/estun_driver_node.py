#!/usr/bin/env python3
"""
Estun Codroid S-Series ROS2 Driver

Connects to the Estun robot controller via WebSocket (ws://ROBOT_IP:9000).
Publishes joint states, TCP pose, robot status.
Subscribes to motion commands, jog commands, I/O commands.

API Reference: CodroidApi Interface Description (2025-07-08)
"""

import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import JointState
from geometry_msgs.msg import PoseStamped, WrenchStamped
from std_msgs.msg import String, Bool, Float32, Int32
import json
import math
import time
import threading
import asyncio

try:
    import websockets
    import websockets.sync.client as ws_sync
except ImportError:
    websockets = None


class EstunCodroidDriver(Node):
    """ROS2 driver for Estun Codroid S-Series collaborative robots."""

    # Joint names matching URDF convention
    JOINT_NAMES = ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6']

    # Robot modes from GetRobotStateFlag
    ROBOT_MODES = {
        'PowerOff': 'power_off',
        'Idle': 'idle',
        'Jogging': 'jogging',
        'Dragging': 'freedrive',
        'ToPoint': 'moving',
        'AutoReady': 'auto_ready',
        'AutoRunning': 'auto_running',
        'Rescue': 'rescue',
        'Fault': 'fault',
    }

    # Safety modes
    SAFETY_MODES = {
        0: 'error',
        1: 'normal',
        2: 'estop',
        3: 'rescue',
        4: 'reduced',
    }

    def __init__(self):
        super().__init__('estun_driver')

        # Parameters
        self.declare_parameter('robot_ip', '192.168.101.100')
        self.declare_parameter('robot_port', 9000)
        self.declare_parameter('poll_rate_hz', 50.0)
        self.declare_parameter('auto_connect', True)

        self._robot_ip = self.get_parameter('robot_ip').value
        self._robot_port = self.get_parameter('robot_port').value
        self._poll_rate = self.get_parameter('poll_rate_hz').value
        self._auto_connect = self.get_parameter('auto_connect').value

        self._ws = None
        self._connected = False
        self._msg_id = 0
        self._lock = threading.Lock()
        self._pending = {}  # msg_id -> asyncio.Future
        self._recv_thread = None

        # State
        self._joint_positions_deg = [0.0] * 6
        self._joint_positions_rad = [0.0] * 6
        self._tcp_pose_mm = [0.0] * 6  # x,y,z (mm), a,b,c (deg)
        self._tcp_pose_m = [0.0] * 6   # x,y,z (m), a,b,c (rad)
        self._robot_mode = 'unknown'
        self._safety_mode = 'unknown'
        self._status_flag = 0
        self._is_moving = False
        self._is_estop = False
        self._jog_active = False
        self._jog_keepalive_timer = None

        # Publishers
        self._pub_joint_state = self.create_publisher(JointState, '/joint_states', 10)
        self._pub_tcp_pose = self.create_publisher(PoseStamped, '/estun/tcp_pose', 10)
        self._pub_robot_mode = self.create_publisher(String, '/estun/robot_mode', 10)
        self._pub_safety_mode = self.create_publisher(String, '/estun/safety_mode', 10)
        self._pub_estop = self.create_publisher(Bool, '/safety/estop', 10)
        self._pub_is_moving = self.create_publisher(Bool, '/estun/is_moving', 10)
        self._pub_status = self.create_publisher(String, '/estun/status', 10)  # JSON status blob

        # Subscribers
        self.create_subscription(String, '/estun/command', self._on_command, 10)
        self.create_subscription(String, '/estun/jog', self._on_jog, 10)
        self.create_subscription(String, '/estun/move', self._on_move, 10)
        self.create_subscription(String, '/estun/io', self._on_io, 10)
        self.create_subscription(String, '/robot/jog_command', self._on_jog, 10)  # from dashboard
        self.create_subscription(String, '/robot/io_command', self._on_io, 10)   # from dashboard

        # Timers
        period = 1.0 / self._poll_rate
        self._poll_timer = self.create_timer(period, self._poll_robot)
        self._status_timer = self.create_timer(0.2, self._poll_status)  # 5Hz status
        self._connect_timer = self.create_timer(2.0, self._try_connect)

        self.get_logger().info(
            f'Estun Codroid driver initialized — target: ws://{self._robot_ip}:{self._robot_port}')

    # ── WebSocket Connection ──────────────────────────────

    def _try_connect(self):
        """Attempt to connect to the robot controller."""
        if self._connected:
            return
        if ws_sync is None:
            self.get_logger().warn_once(
                'websockets library not installed — pip install websockets')
            return
        try:
            url = f'ws://{self._robot_ip}:{self._robot_port}'
            self._ws = ws_sync.connect(url, open_timeout=2, close_timeout=1)
            self._connected = True
            self.get_logger().info(f'Connected to Estun controller at {url}')

            # Start receive thread
            self._recv_thread = threading.Thread(target=self._recv_loop, daemon=True)
            self._recv_thread.start()

        except Exception as e:
            self._connected = False
            self._ws = None
            self.get_logger().warn(f'Cannot connect to Estun controller: {e}')

    def _disconnect(self):
        """Disconnect from the robot."""
        self._connected = False
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None
        self.get_logger().info('Disconnected from Estun controller')

    def _recv_loop(self):
        """Background thread: read WebSocket messages."""
        while self._connected and self._ws:
            try:
                raw = self._ws.recv(timeout=1.0)
                if raw:
                    msg = json.loads(raw)
                    self._handle_response(msg)
            except websockets.exceptions.ConnectionClosed:
                self.get_logger().warn('WebSocket connection closed')
                self._connected = False
                break
            except TimeoutError:
                continue
            except Exception as e:
                self.get_logger().debug(f'recv error: {e}')

    def _send(self, action, data=None, msg_type='common', extra_fields=None):
        """Send a JSON command to the robot controller."""
        if not self._connected or not self._ws:
            return None
        with self._lock:
            self._msg_id += 1
            msg = {
                'id': self._msg_id,
                'type': msg_type,
                'action': action,
            }
            if data is not None:
                msg['data'] = data
            if extra_fields:
                msg.update(extra_fields)
            try:
                self._ws.send(json.dumps(msg))
                return self._msg_id
            except Exception as e:
                self.get_logger().warn(f'Send error: {e}')
                self._connected = False
                return None

    def _handle_response(self, msg):
        """Process a response from the robot controller."""
        action = msg.get('action', '')
        code = msg.get('code', -1)
        data = msg.get('data', {})

        if code != 200:
            err = data.get('msg', msg.get('msg', '')) if isinstance(data, dict) else msg.get('msg', '')
            if err:
                self.get_logger().warn(f'Robot error [{action}]: {err}')
            return

        inner = data.get('data', data) if isinstance(data, dict) else data

        if action == 'getCurAPos':
            self._update_joint_positions(inner)
        elif action == 'getCurCPos':
            self._update_tcp_pose(inner)
        elif action == 'getRobotStates':
            self._update_robot_state(inner)
        elif action == 'getProjectState':
            pass  # project status
        elif action in ('mov', 'movMulti', 'movJoint', 'movLine'):
            self.get_logger().info(f'Motion command acknowledged: {action}')
        elif action in ('setDO', 'setDOGroup'):
            pass  # I/O ack
        elif action in ('getDI', 'getDIGroup'):
            self._handle_di_response(inner)

    # ── State Updates ─────────────────────────────────────

    def _update_joint_positions(self, data):
        """Update joint positions from getCurAPos response."""
        if not isinstance(data, dict):
            return
        for i in range(6):
            key = f'jntpos{i+1}'
            if key in data:
                self._joint_positions_deg[i] = float(data[key])
                self._joint_positions_rad[i] = math.radians(float(data[key]))

        # Publish JointState
        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name = self.JOINT_NAMES
        msg.position = list(self._joint_positions_rad)
        msg.velocity = [0.0] * 6
        msg.effort = [0.0] * 6
        self._pub_joint_state.publish(msg)

    def _update_tcp_pose(self, data):
        """Update TCP pose from getCurCPos response."""
        if not isinstance(data, dict):
            return
        self._tcp_pose_mm = [
            float(data.get('x', 0)), float(data.get('y', 0)), float(data.get('z', 0)),
            float(data.get('a', 0)), float(data.get('b', 0)), float(data.get('c', 0)),
        ]
        # Convert mm -> m for position, deg -> rad for orientation
        self._tcp_pose_m = [
            self._tcp_pose_mm[0] / 1000.0,
            self._tcp_pose_mm[1] / 1000.0,
            self._tcp_pose_mm[2] / 1000.0,
            math.radians(self._tcp_pose_mm[3]),
            math.radians(self._tcp_pose_mm[4]),
            math.radians(self._tcp_pose_mm[5]),
        ]

        # Publish TCP PoseStamped
        msg = PoseStamped()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = 'base_link'
        msg.pose.position.x = self._tcp_pose_m[0]
        msg.pose.position.y = self._tcp_pose_m[1]
        msg.pose.position.z = self._tcp_pose_m[2]
        self._pub_tcp_pose.publish(msg)

    def _update_robot_state(self, data):
        """Update robot state from GetRobotStateFlag response."""
        if not isinstance(data, dict):
            return
        mode_str = data.get('robotMode', 'unknown')
        self._robot_mode = self.ROBOT_MODES.get(mode_str, mode_str)

        safety_int = data.get('safetyMode', -1)
        self._safety_mode = self.SAFETY_MODES.get(safety_int, f'unknown_{safety_int}')

        flag = data.get('statusFlag', 0)
        self._status_flag = int(flag)
        self._is_estop = bool(flag & 1)        # bit 0
        self._is_moving = bool(flag & 8)        # bit 3

        # Publish
        mode_msg = String()
        mode_msg.data = self._robot_mode
        self._pub_robot_mode.publish(mode_msg)

        safety_msg = String()
        safety_msg.data = self._safety_mode
        self._pub_safety_mode.publish(safety_msg)

        estop_msg = Bool()
        estop_msg.data = self._is_estop
        self._pub_estop.publish(estop_msg)

        moving_msg = Bool()
        moving_msg.data = self._is_moving
        self._pub_is_moving.publish(moving_msg)

        # Full status JSON
        status = {
            'connected': self._connected,
            'robot_mode': self._robot_mode,
            'safety_mode': self._safety_mode,
            'status_flag': self._status_flag,
            'estop': self._is_estop,
            'moving': self._is_moving,
            'joints_deg': list(self._joint_positions_deg),
            'joints_rad': list(self._joint_positions_rad),
            'tcp_mm': list(self._tcp_pose_mm),
            'tcp_m': list(self._tcp_pose_m),
        }
        status_msg = String()
        status_msg.data = json.dumps(status)
        self._pub_status.publish(status_msg)

    def _handle_di_response(self, data):
        """Handle digital input responses."""
        # Published via /estun/di topic if needed
        pass

    # ── Polling ───────────────────────────────────────────

    def _poll_robot(self):
        """Poll joint positions and TCP at the configured rate."""
        if not self._connected:
            return
        self._send('getCurAPos', [])
        self._send('getCurCPos', [])

    def _poll_status(self):
        """Poll robot state at 5Hz."""
        if not self._connected:
            return
        self._send('getparam', ['Robot/Control/state'])

        # Use GetRobotStateFlag for detailed status
        self._send('getRobotStates', {})

    # ── Command Handlers ──────────────────────────────────

    def _on_command(self, msg):
        """Handle robot control commands: power, mode, home, estop."""
        try:
            cmd = json.loads(msg.data)
        except Exception:
            return
        action = cmd.get('action', '')

        if action == 'power_on':
            self._send('setparam', [{'path': 'Robot/Control/command', 'value': 1}])
        elif action == 'power_off':
            self._send('setparam', [{'path': 'Robot/Control/command', 'value': 2}])
        elif action == 'to_manual':
            self._send('setparam', [{'path': 'Robot/Control/command', 'value': 3}])
        elif action == 'to_auto':
            self._send('setparam', [{'path': 'Robot/Control/command', 'value': 5}])
        elif action == 'clear_error':
            self._send('setparam', [{'path': 'Robot/Control/command', 'value': 100}])
        elif action == 'home':
            self._send('goHome', {})
        elif action == 'stop':
            self._send('stopMove', {})
            self._send('stopjog', {})
        elif action == 'run':
            project = cmd.get('project')
            if project:
                self._send('run', {'projectName': project, 'taskName': 'main1'}, msg_type='projexecute')
            else:
                self._send('runLast', {}, msg_type='projexecute')
        elif action == 'pause':
            self._send('pause', {}, msg_type='projexecute')
        elif action == 'resume':
            self._send('resume', {}, msg_type='projexecute')

    def _on_jog(self, msg):
        """Handle jog commands from dashboard."""
        try:
            cmd = json.loads(msg.data)
        except Exception:
            return

        mode = cmd.get('mode', 'joint')
        axis = cmd.get('axis')
        direction = cmd.get('direction', 1)
        speed_level = cmd.get('speed', 1)  # 1=low, 2=mid, 3=high
        step = cmd.get('step', 1.0)

        if axis == 'home':
            self._send('goHome', {})
            return

        if axis == 0 or mode == 'stop':
            self._stop_jog()
            return

        # Map speed level
        if speed_level <= 20:
            jog_speed = 1
        elif speed_level <= 60:
            jog_speed = 2
        else:
            jog_speed = 3

        # Apply direction
        if direction < 0:
            jog_speed = -jog_speed

        if mode == 'joint':
            # Joint jog: axis is joint number 1-6
            jog_index = int(axis)
            self._send('setparam', [
                {'path': 'Robot/Control/jogMode', 'value': 1},  # 1 = joint mode
                {'path': 'Robot/Control/jogSpeed', 'value': jog_speed},
                {'path': 'Robot/Control/jogIndex', 'value': jog_index},
            ])
        elif mode == 'cartesian':
            # TCP jog: axis is x,y,z,rx,ry,rz
            axis_map = {'x': 1, 'y': 2, 'z': 3, 'rx': 4, 'ry': 5, 'rz': 6}
            jog_index = axis_map.get(str(axis), 1)
            self._send('setparam', [
                {'path': 'Robot/Control/jogMode', 'value': 2},  # 2 = TCP mode
                {'path': 'Robot/Control/jogSpeed', 'value': jog_speed},
                {'path': 'Robot/Control/jogIndex', 'value': jog_index},
            ])

        # Start keepalive heartbeat
        self._jog_active = True
        self._start_jog_keepalive()

    def _start_jog_keepalive(self):
        """Send keepjog heartbeat every 400ms (must be < 500ms)."""
        if self._jog_keepalive_timer:
            self._jog_keepalive_timer.cancel()

        def keepalive():
            if self._jog_active and self._connected:
                timestamp = int(time.time() * 1000)
                self._send('setparam', [
                    {'path': 'Robot/Control/commandHeart', 'value': timestamp}
                ])
                self._jog_keepalive_timer = threading.Timer(0.4, keepalive)
                self._jog_keepalive_timer.daemon = True
                self._jog_keepalive_timer.start()

        keepalive()

    def _stop_jog(self):
        """Stop jog motion."""
        self._jog_active = False
        if self._jog_keepalive_timer:
            self._jog_keepalive_timer.cancel()
            self._jog_keepalive_timer = None
        self._send('setparam', [
            {'path': 'Robot/Control/jogMode', 'value': 0},
            {'path': 'Robot/Control/jogSpeed', 'value': 0},
            {'path': 'Robot/Control/jogIndex', 'value': 0},
        ])

    def _on_move(self, msg):
        """Handle motion commands: movj, movl, multi-point."""
        try:
            cmd = json.loads(msg.data)
        except Exception:
            return

        move_type = cmd.get('type', 'movj')
        speed_pct = cmd.get('speed_pct', 50)
        joints = cmd.get('joints')  # [j1, j2, j3, j4, j5, j6] in degrees
        tcp = cmd.get('tcp')  # [x, y, z, a, b, c] in mm/degrees
        waypoints = cmd.get('waypoints')  # list of joint/tcp targets

        # Convert speed percentage to deg/s (assuming 180 deg/s max)
        sper = speed_pct * 1.8  # 100% = 180 deg/s

        if waypoints:
            # Multi-point path
            points = []
            for wp in waypoints[:30]:  # max 30 points
                point = {
                    'target': {
                        'type': 'apos',
                        'apos': {f'jntpos{i+1}': wp[i] for i in range(6)},
                    },
                    'speed': {'sori': 0, 'sper': sper, 'stcp': 0, 'sexjl': 0, 'sexjr': 0},
                    'acc': {'aori': 0, 'aper': 80.0, 'atcp': 0, 'aexjl': 0, 'aexjr': 0},
                    'zone': {'type': 'FINE', 'data': {'zper': 0, 'zdis': 0, 'zvconst': 0}},
                }
                points.append(point)

            self._send('movMulti', {
                'type': 'movJoint',
                'points': points,
            })
        elif joints:
            # Single joint move
            self._send('mov', {
                'acc': {'aexjl': 0, 'aexjr': 0, 'aori': 0, 'aper': 80.0, 'atcp': 0},
                'speed': {'sexjl': 0, 'sexjr': 0, 'sori': 0, 'sper': sper, 'stcp': 0},
                'target': {
                    'apos': {f'jntpos{i+1}': joints[i] for i in range(6)},
                },
                'type': move_type,
            })
        elif tcp:
            # Cartesian move
            self._send('mov', {
                'acc': {'aexjl': 0, 'aexjr': 0, 'aori': 0, 'aper': 80.0, 'atcp': 0},
                'speed': {'sexjl': 0, 'sexjr': 0, 'sori': 0, 'sper': sper, 'stcp': 0},
                'target': {
                    'cpos': {
                        'x': tcp[0], 'y': tcp[1], 'z': tcp[2],
                        'a': tcp[3], 'b': tcp[4], 'c': tcp[5],
                        'poscfg': {'mode': -1, 'cf1': 0, 'cf2': 0, 'cf3': 0, 'cf4': 0, 'cf5': 0, 'cf6': 0, 'cf7': 0},
                    },
                },
                'type': 'movl',
            })

    def _on_io(self, msg):
        """Handle I/O commands."""
        try:
            cmd = json.loads(msg.data)
        except Exception:
            return

        io_id = cmd.get('io_id') or cmd.get('id', '')
        value = cmd.get('value', 0)

        if io_id.startswith('DO'):
            port_num = int(io_id.replace('DO', ''))
            # DO0-DO15 map to ports 16-31
            actual_port = port_num + 16
            self._send('setDO', {'port': actual_port, 'val': int(value)})
        elif io_id.startswith('DI'):
            port_num = int(io_id.replace('DI', ''))
            self._send('getDI', {'port': port_num})

    # ── Shutdown ──────────────────────────────────────────

    def destroy_node(self):
        self._stop_jog()
        self._disconnect()
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
