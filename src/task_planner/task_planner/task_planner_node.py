"""
task_planner_node — pick-and-place state machine.

Motion is executed by publishing to robot_driver_node:
  /task/target_pose  → robot_driver_node → TCP/IP → robot arm
  /gripper/set       → gripper_node      → TCP/IP → gripper

No MoveIt2 dependency.
"""

import json
import rclpy
from rclpy.node import Node
from std_msgs.msg import String, Bool
from std_srvs.srv import SetBool
from geometry_msgs.msg import PoseStamped
from sensor_msgs.msg import JointState
import time


class State:
    STARTUP       = 'STARTUP'
    IDLE          = 'IDLE'
    SELECT_TARGET = 'SELECT_TARGET'
    APPROACH      = 'APPROACH'
    DESCEND       = 'DESCEND'
    PICK          = 'PICK'
    LIFT          = 'LIFT'
    PLACE         = 'PLACE'
    RELEASE       = 'RELEASE'
    HOME          = 'HOME'


class TaskPlannerNode(Node):
    def __init__(self):
        super().__init__('task_planner_node')

        self.declare_parameter('home_joints',          [0.0, -1.57, 0.0, -1.57, 0.0, 0.0])
        self.declare_parameter('pick_height_offset_m', 0.15)
        self.declare_parameter('descend_height_m',     0.02)
        self.declare_parameter('lift_height_m',        0.15)
        self.declare_parameter('task_timeout_s',       30.0)
        self.declare_parameter('idle_check_rate_hz',   2.0)
        self.declare_parameter('motion_settle_s',      2.0)

        self._home_joints  = self.get_parameter('home_joints').value
        self._pick_offset  = self.get_parameter('pick_height_offset_m').value
        self._descend_h    = self.get_parameter('descend_height_m').value
        self._lift_h       = self.get_parameter('lift_height_m').value
        self._task_timeout = self.get_parameter('task_timeout_s').value
        self._settle_s     = self.get_parameter('motion_settle_s').value
        rate               = self.get_parameter('idle_check_rate_hz').value

        self._state            = State.STARTUP
        self._zone             = 'GREEN'
        self._estop            = False
        self._scene_graph: dict= {}
        self._task_command     = {}
        self._target           = None
        self._robot_status     = {}
        self._state_entry      = time.monotonic()
        self._task_count       = 0
        self._success_count    = 0
        self._paused           = False

        # ── Subscriptions ────────────────────────────────────────────────────
        self.create_subscription(String,  '/perception/scene_graph', self._graph_cb,  10)
        self.create_subscription(String,  '/safety/zone',            self._zone_cb,   10)
        self.create_subscription(Bool,    '/safety/estop',           self._estop_cb,  10)
        self.create_subscription(String,  '/task/command',           self._command_cb,10)
        self.create_subscription(String,  '/robot/status',           self._robot_cb,  10)

        # ── Publishers ───────────────────────────────────────────────────────
        self._state_pub  = self.create_publisher(String,       '/task/state',       10)
        self._pose_pub   = self.create_publisher(PoseStamped,  '/task/target_pose', 10)
        self._joint_pub  = self.create_publisher(JointState,   '/robot/joint_command', 10)
        self._status_pub = self.create_publisher(String,       '/task/status',      10)

        # ── Gripper service client ────────────────────────────────────────────
        self._gripper_cli = self.create_client(SetBool, '/gripper/set')

        # ── Timers ───────────────────────────────────────────────────────────
        self.create_timer(1.0 / rate, self._tick)
        self.create_timer(0.2,        self._publish_status)

        self.get_logger().info('task_planner_node started')

    # ── Subscribers ───────────────────────────────────────────────────────────

    def _graph_cb(self, msg):
        try:
            self._scene_graph = json.loads(msg.data)
        except json.JSONDecodeError:
            pass

    def _zone_cb(self, msg):
        self._zone = msg.data
        if msg.data == 'YELLOW' and self._state not in (State.IDLE, State.STARTUP):
            if not self._paused:
                self._paused = True
                self.get_logger().info('PAUSED — human in yellow zone')
        elif msg.data == 'GREEN' and self._paused:
            self._paused = False
            self.get_logger().info('RESUMING — zone GREEN')

    def _estop_cb(self, msg):
        prev = self._estop
        self._estop = msg.data
        if msg.data and not prev and self._state not in (State.IDLE, State.STARTUP):
            self.get_logger().warn('ESTOP — aborting task')
            self._transition(State.IDLE)

    def _command_cb(self, msg):
        try:
            self._task_command = json.loads(msg.data)
        except json.JSONDecodeError:
            pass

    def _robot_cb(self, msg):
        try:
            self._robot_status = json.loads(msg.data)
        except json.JSONDecodeError:
            pass

    # ── State machine ─────────────────────────────────────────────────────────

    def _transition(self, new_state: str):
        self.get_logger().info(f'{self._state} → {new_state}')
        self._state       = new_state
        self._state_entry = time.monotonic()
        s = String(); s.data = new_state
        self._state_pub.publish(s)

    def _elapsed(self) -> float:
        return time.monotonic() - self._state_entry

    def _robot_is_moving(self) -> bool:
        return bool(self._robot_status.get('is_moving', False))

    def _robot_has_error(self) -> bool:
        return int(self._robot_status.get('error_code', 0)) != 0

    def _publish_pose(self, x, y, z, rx=0.0, ry=0.0, rz=0.0):
        ps = PoseStamped()
        ps.header.frame_id = 'base_link'
        ps.header.stamp    = self.get_clock().now().to_msg()
        ps.pose.position.x = float(x)
        ps.pose.position.y = float(y)
        ps.pose.position.z = float(z)
        ps.pose.orientation.w = 1.0
        self._pose_pub.publish(ps)

    def _send_home(self):
        js = JointState()
        js.header.stamp = self.get_clock().now().to_msg()
        js.name     = ['joint_1','joint_2','joint_3','joint_4','joint_5','joint_6']
        js.position = list(self._home_joints)
        self._joint_pub.publish(js)

    def _gripper(self, close: bool):
        if not self._gripper_cli.service_is_ready():
            self.get_logger().warn('Gripper service not ready')
            return
        req = SetBool.Request(); req.data = close
        self._gripper_cli.call_async(req)

    def _select_target(self):
        best, best_conf = None, 0.0
        for obj in self._scene_graph.values():
            if obj.get('class_id') == 'person':
                continue
            if obj.get('confidence', 0.0) > best_conf:
                best_conf = obj['confidence']
                best      = obj
        return best

    def _tick(self):
        if self._estop and self._state not in (State.IDLE, State.STARTUP):
            self._transition(State.IDLE)
            return
        if self._paused:
            return

        elapsed = self._elapsed()

        if self._state == State.STARTUP:
            if elapsed > 2.0:
                self._transition(State.IDLE)

        elif self._state == State.IDLE:
            if self._estop or self._zone != 'GREEN':
                return
            target = self._select_target()
            if target:
                self._target = target
                self._transition(State.SELECT_TARGET)
            elif self._task_command.get('action') == 'pick_and_place':
                self._transition(State.SELECT_TARGET)

        elif self._state == State.SELECT_TARGET:
            if self._target is None:
                self._target = self._select_target()
            if self._target:
                self._gripper(close=False)       # open gripper before approach
                self._transition(State.APPROACH)
            elif elapsed > 5.0:
                self.get_logger().info('No pickable object — returning IDLE')
                self._task_command = {}
                self._transition(State.IDLE)

        elif self._state == State.APPROACH:
            pos = self._target.get('position', {})
            if elapsed < 0.1:
                # Publish approach pose: above the object
                self._publish_pose(
                    pos.get('x', 0.3), pos.get('y', 0.0),
                    pos.get('z', 0.3) + self._pick_offset)
            if elapsed > self._settle_s and not self._robot_is_moving():
                self._transition(State.DESCEND)
            elif elapsed > self._task_timeout:
                self.get_logger().warn('APPROACH timeout')
                self._transition(State.HOME)

        elif self._state == State.DESCEND:
            pos = self._target.get('position', {})
            if elapsed < 0.1:
                # Move down to grasp height
                self._publish_pose(
                    pos.get('x', 0.3), pos.get('y', 0.0),
                    pos.get('z', 0.1) + self._descend_h)
            if elapsed > self._settle_s and not self._robot_is_moving():
                self._transition(State.PICK)

        elif self._state == State.PICK:
            if elapsed < 0.1:
                self.get_logger().info(
                    f'GRASP: closing gripper on {self._target.get("class_id")}')
                self._gripper(close=True)
            if elapsed > 1.5:
                self._transition(State.LIFT)

        elif self._state == State.LIFT:
            pos = self._target.get('position', {})
            if elapsed < 0.1:
                self._publish_pose(
                    pos.get('x', 0.3), pos.get('y', 0.0),
                    pos.get('z', 0.3) + self._lift_h)
            if elapsed > self._settle_s and not self._robot_is_moving():
                self._transition(State.PLACE)

        elif self._state == State.PLACE:
            if elapsed < 0.1:
                self._publish_pose(0.5, 0.0, 0.3)
            if elapsed > self._settle_s and not self._robot_is_moving():
                self._transition(State.RELEASE)

        elif self._state == State.RELEASE:
            if elapsed < 0.1:
                self.get_logger().info('RELEASE: opening gripper')
                self._gripper(close=False)
            if elapsed > 1.0:
                self._task_count   += 1
                self._success_count += 1
                self._transition(State.HOME)

        elif self._state == State.HOME:
            if elapsed < 0.1:
                self._send_home()
            if elapsed > self._settle_s and not self._robot_is_moving():
                self._target       = None
                self._task_command = {}
                self._transition(State.IDLE)

    def _publish_status(self):
        status = {
            'state':          self._state,
            'target_class':   self._target.get('class_id', '') if self._target else '',
            'target_position':self._target.get('position', {}) if self._target else {},
            'zone':           self._zone,
            'estop':          bool(self._estop),
            'task_count':     self._task_count,
            'success_count':  self._success_count,
            'robot_moving':   self._robot_is_moving(),
            'robot_error':    self._robot_has_error(),
        }
        msg = String(); msg.data = json.dumps(status)
        self._status_pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = TaskPlannerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
