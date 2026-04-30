"""
robot_driver_node — TCP/IP bridge between any Chinese cobot and ROS2.

Publishes:
  /joint_states          sensor_msgs/JointState     50 Hz
  /robot/tcp_pose        geometry_msgs/PoseStamped  50 Hz
  /robot/status          std_msgs/String (JSON)     5 Hz
  TF:  base_link → tool0  (computed from joint states + DH params)

Subscribes:
  /task/target_pose      geometry_msgs/PoseStamped  (from task_planner)
  /robot/joint_command   sensor_msgs/JointState     (direct joint control)
  /safety/speed_scale    std_msgs/Float32            (safety scaling)
  /safety/estop          std_msgs/Bool               (emergency stop)

Services:
  /robot/enable          std_srvs/SetBool
  /robot/clear_error     std_srvs/Trigger
  /robot/go_home         std_srvs/Trigger

Change brand by editing config/robot_driver.yaml — no code changes needed.
"""

import json
import math
import threading
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from geometry_msgs.msg import PoseStamped, TransformStamped
from std_msgs.msg import String, Float32, Bool
from std_srvs.srv import Trigger, SetBool
from tf2_ros import TransformBroadcaster

from robot_driver.adapters import get_adapter, MotionTarget


class RobotDriverNode(Node):
    def __init__(self):
        super().__init__('robot_driver_node')

        # ── Parameters ────────────────────────────────────────────────────────
        self.declare_parameter('brand',       'generic')
        self.declare_parameter('robot_ip',    '192.168.1.100')
        self.declare_parameter('robot_port',  0)
        self.declare_parameter('dof',         6)
        self.declare_parameter('state_rate_hz', 50.0)
        self.declare_parameter('home_joints', [0.0, -1.57, 0.0, -1.57, 0.0, 0.0])
        self.declare_parameter('joint_names',
            ['joint_1','joint_2','joint_3','joint_4','joint_5','joint_6'])
        self.declare_parameter('reconnect_interval_s', 5.0)
        self.declare_parameter('max_speed_scale', 1.0)

        brand      = self.get_parameter('brand').value
        ip         = self.get_parameter('robot_ip').value
        port       = self.get_parameter('robot_port').value
        dof        = self.get_parameter('dof').value
        rate       = self.get_parameter('state_rate_hz').value
        self._home = self.get_parameter('home_joints').value
        self._joint_names = self.get_parameter('joint_names').value[:dof]
        self._max_speed_scale = self.get_parameter('max_speed_scale').value

        self._speed_scale = 1.0
        self._estop       = False
        self._lock        = threading.Lock()

        # ── Robot adapter ─────────────────────────────────────────────────────
        self._adapter = get_adapter(brand, ip, port, dof)
        self._connect_robot()

        # ── Publishers ────────────────────────────────────────────────────────
        self._js_pub     = self.create_publisher(JointState,    '/joint_states',    10)
        self._pose_pub   = self.create_publisher(PoseStamped,   '/robot/tcp_pose',  10)
        self._status_pub = self.create_publisher(String,        '/robot/status',    10)
        self._tf_pub     = TransformBroadcaster(self)

        # ── Subscribers ───────────────────────────────────────────────────────
        self.create_subscription(PoseStamped,  '/task/target_pose',   self._pose_cmd_cb,  10)
        self.create_subscription(JointState,   '/robot/joint_command',self._joint_cmd_cb, 10)
        self.create_subscription(Float32,      '/safety/speed_scale', self._speed_cb,     10)
        self.create_subscription(Bool,         '/safety/estop',       self._estop_cb,     10)

        # ── Services ──────────────────────────────────────────────────────────
        self.create_service(SetBool, '/robot/enable',      self._enable_cb)
        self.create_service(Trigger, '/robot/clear_error', self._clear_error_cb)
        self.create_service(Trigger, '/robot/go_home',     self._go_home_cb)

        # ── Timers ────────────────────────────────────────────────────────────
        self.create_timer(1.0 / rate, self._state_tick)
        self.create_timer(0.2,        self._publish_status)
        self.create_timer(
            self.get_parameter('reconnect_interval_s').value,
            self._reconnect_check)

        self.get_logger().info(
            f'robot_driver_node started | brand={brand} ip={ip} port={port}')

    # ── Connection management ─────────────────────────────────────────────────

    def _connect_robot(self):
        if self._adapter.connect():
            self.get_logger().info('Robot connected')
        else:
            self.get_logger().warn('Robot not reachable — running in FAKE mode')

    def _reconnect_check(self):
        if not self._adapter.connected:
            self.get_logger().info('Attempting robot reconnect...')
            self._connect_robot()

    # ── State tick ────────────────────────────────────────────────────────────

    def _state_tick(self):
        if not self._adapter.connected:
            return
        with self._lock:
            state = self._adapter.get_state()

        now = self.get_clock().now().to_msg()

        # Joint states
        js = JointState()
        js.header.stamp = now
        js.name         = self._joint_names
        js.position     = list(state.joint_positions[:len(self._joint_names)])
        js.velocity     = list(state.joint_velocities[:len(self._joint_names)])
        js.effort       = list(state.joint_efforts[:len(self._joint_names)])
        self._js_pub.publish(js)

        # TCP pose
        if len(state.tcp_pose) >= 6:
            ps = PoseStamped()
            ps.header.stamp    = now
            ps.header.frame_id = 'base_link'
            ps.pose.position.x = state.tcp_pose[0]
            ps.pose.position.y = state.tcp_pose[1]
            ps.pose.position.z = state.tcp_pose[2]
            # Convert RPY → quaternion
            q = self._rpy_to_quat(
                state.tcp_pose[3], state.tcp_pose[4], state.tcp_pose[5])
            ps.pose.orientation.x = q[0]
            ps.pose.orientation.y = q[1]
            ps.pose.orientation.z = q[2]
            ps.pose.orientation.w = q[3]
            self._pose_pub.publish(ps)

            # TF: base_link → tool0
            tf = TransformStamped()
            tf.header.stamp    = now
            tf.header.frame_id = 'base_link'
            tf.child_frame_id  = 'tool0'
            tf.transform.translation.x = state.tcp_pose[0]
            tf.transform.translation.y = state.tcp_pose[1]
            tf.transform.translation.z = state.tcp_pose[2]
            tf.transform.rotation.x = q[0]
            tf.transform.rotation.y = q[1]
            tf.transform.rotation.z = q[2]
            tf.transform.rotation.w = q[3]
            self._tf_pub.sendTransform(tf)

    def _publish_status(self):
        if not self._adapter.connected:
            status = {'connected': False, 'brand': self._adapter.__class__.__name__}
        else:
            with self._lock:
                state = self._adapter.get_state()
            status = {
                'connected':    True,
                'brand':        self._adapter.__class__.__name__,
                'mode':         state.mode,
                'is_moving':    state.is_moving,
                'is_enabled':   state.is_enabled,
                'error_code':   state.error_code,
                'error_message':state.error_message,
                'speed_scale':  self._speed_scale,
                'estop':        self._estop,
                'tcp_pose':     state.tcp_pose[:6] if len(state.tcp_pose) >= 6 else [],
            }
        msg = String()
        msg.data = json.dumps(status)
        self._status_pub.publish(msg)

    # ── Subscribers ───────────────────────────────────────────────────────────

    def _pose_cmd_cb(self, msg: PoseStamped):
        if self._estop:
            self.get_logger().warn('ESTOP active — ignoring pose command', throttle_duration_sec=2.0)
            return
        p = msg.pose.position
        o = msg.pose.orientation
        rpy = self._quat_to_rpy(o.x, o.y, o.z, o.w)
        target = MotionTarget(
            tcp_pose=[p.x, p.y, p.z, rpy[0], rpy[1], rpy[2]],
            speed_scale=min(self._speed_scale, self._max_speed_scale),
        )
        with self._lock:
            self._adapter.move_to(target)

    def _joint_cmd_cb(self, msg: JointState):
        if self._estop:
            return
        target = MotionTarget(
            joint_positions=list(msg.position),
            speed_scale=min(self._speed_scale, self._max_speed_scale),
        )
        with self._lock:
            self._adapter.move_to(target)

    def _speed_cb(self, msg: Float32):
        self._speed_scale = float(msg.data)

    def _estop_cb(self, msg: Bool):
        prev = self._estop
        self._estop = bool(msg.data)
        if self._estop and not prev:
            self.get_logger().warn('ESTOP received — stopping robot')
            with self._lock:
                self._adapter.estop()

    # ── Services ─────────────────────────────────────────────────────────────

    def _enable_cb(self, req: SetBool.Request, res: SetBool.Response):
        with self._lock:
            if req.data:
                res.success = self._adapter.enable()
                res.message = 'enabled' if res.success else 'enable failed'
            else:
                self._adapter.disable()
                res.success = True
                res.message = 'disabled'
        return res

    def _clear_error_cb(self, req, res: Trigger.Response):
        with self._lock:
            res.success = self._adapter.clear_error()
        res.message = 'error cleared' if res.success else 'clear failed'
        return res

    def _go_home_cb(self, req, res: Trigger.Response):
        if self._estop:
            res.success = False
            res.message = 'ESTOP active'
            return res
        target = MotionTarget(
            joint_positions=list(self._home),
            speed_scale=0.3,
            blocking=False,
        )
        with self._lock:
            res.success = self._adapter.move_to(target)
        res.message = 'moving home' if res.success else 'move failed'
        return res

    # ── Math helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def _rpy_to_quat(r, p, y):
        cr, sr = math.cos(r/2), math.sin(r/2)
        cp, sp = math.cos(p/2), math.sin(p/2)
        cy, sy = math.cos(y/2), math.sin(y/2)
        return (
            sr*cp*cy - cr*sp*sy,
            cr*sp*cy + sr*cp*sy,
            cr*cp*sy - sr*sp*cy,
            cr*cp*cy + sr*sp*sy,
        )

    @staticmethod
    def _quat_to_rpy(x, y, z, w):
        sinr = 2*(w*x + y*z); cosr = 1 - 2*(x*x + y*y)
        roll = math.atan2(sinr, cosr)
        sinp = 2*(w*y - z*x)
        pitch = math.copysign(math.pi/2, sinp) if abs(sinp) >= 1 else math.asin(sinp)
        siny = 2*(w*z + x*y); cosy = 1 - 2*(y*y + z*z)
        yaw  = math.atan2(siny, cosy)
        return (roll, pitch, yaw)


def main(args=None):
    rclpy.init(args=args)
    node = RobotDriverNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
