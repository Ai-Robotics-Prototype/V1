import json
import rclpy
from rclpy.node import Node
from std_msgs.msg import String, Bool
from geometry_msgs.msg import PoseStamped
from sensor_msgs.msg import JointState
import time


class State:
    STARTUP = 'STARTUP'
    IDLE = 'IDLE'
    SELECT_TARGET = 'SELECT_TARGET'
    APPROACH = 'APPROACH'
    PICK = 'PICK'
    LIFT = 'LIFT'
    PLACE = 'PLACE'
    HOME = 'HOME'


class TaskPlannerNode(Node):
    def __init__(self):
        super().__init__('task_planner_node')

        self.declare_parameter('home_position', [0.0, -1.57, 0.0, -1.57, 0.0, 0.0])
        self.declare_parameter('pick_height_offset_m', 0.15)
        self.declare_parameter('task_timeout_s', 30.0)
        self.declare_parameter('idle_check_rate_hz', 2.0)

        self.pick_offset = self.get_parameter('pick_height_offset_m').value
        self.task_timeout = self.get_parameter('task_timeout_s').value
        rate = self.get_parameter('idle_check_rate_hz').value

        self._state = State.STARTUP
        self._zone = 'GREEN'
        self._estop = False
        self._scene_graph: dict = {}
        self._task_command: dict = {}
        self._target = None
        self._state_entry_time = time.monotonic()
        self._task_count = 0
        self._success_count = 0
        self._paused = False
        self._pick_state_start = None
        self._approach_start = None

        self.create_subscription(String, '/perception/scene_graph', self._graph_cb, 10)
        self.create_subscription(String, '/safety/zone', self._zone_cb, 10)
        self.create_subscription(Bool, '/safety/estop', self._estop_cb, 10)
        self.create_subscription(String, '/task/command', self._command_cb, 10)

        self.state_pub = self.create_publisher(String, '/task/state', 10)
        self.pose_pub = self.create_publisher(PoseStamped, '/task/target_pose', 10)
        self.status_pub = self.create_publisher(String, '/task/status', 10)

        self.create_timer(1.0 / rate, self._tick)
        self.create_timer(0.2, self._publish_status)

        self._start_time = time.monotonic()
        self.get_logger().info('task_planner_node started')

    def _graph_cb(self, msg: String):
        try:
            self._scene_graph = json.loads(msg.data)
        except json.JSONDecodeError:
            pass

    def _zone_cb(self, msg: String):
        self._zone = msg.data
        if msg.data == 'YELLOW' and self._state not in (State.IDLE, State.STARTUP):
            if not self._paused:
                self._paused = True
                self.get_logger().info('PAUSED — human in yellow zone')
        elif msg.data == 'GREEN':
            if self._paused:
                self._paused = False
                self.get_logger().info('RESUMING — zone is GREEN')

    def _estop_cb(self, msg: Bool):
        prev = self._estop
        self._estop = msg.data
        if msg.data and not prev and self._state not in (State.IDLE, State.STARTUP):
            self.get_logger().warn('ESTOP — aborting task')
            self._transition(State.IDLE)

    def _command_cb(self, msg: String):
        try:
            cmd = json.loads(msg.data)
            self._task_command = cmd
            self.get_logger().info(f'Task command received: {cmd.get("action")}')
        except json.JSONDecodeError:
            pass

    def _transition(self, new_state: str):
        self.get_logger().info(f'{self._state} → {new_state}')
        self._state = new_state
        self._state_entry_time = time.monotonic()
        s_msg = String()
        s_msg.data = new_state
        self.state_pub.publish(s_msg)

    def _select_target(self):
        best = None
        best_conf = 0.0
        for obj in self._scene_graph.values():
            if obj.get('class_id') == 'person':
                continue
            if obj.get('confidence', 0) > best_conf:
                best_conf = obj['confidence']
                best = obj
        return best

    def _tick(self):
        if self._estop and self._state not in (State.IDLE, State.STARTUP):
            self._transition(State.IDLE)
            return

        if self._paused:
            return

        elapsed = time.monotonic() - self._state_entry_time

        if self._state == State.STARTUP:
            if elapsed > 2.0:
                self._transition(State.IDLE)

        elif self._state == State.IDLE:
            if self._estop:
                return
            if self._zone != 'GREEN':
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
                self._transition(State.APPROACH)
            elif elapsed > 5.0:
                self.get_logger().info('No valid target found — returning to IDLE')
                self._transition(State.IDLE)

        elif self._state == State.APPROACH:
            if self._approach_start is None:
                self._approach_start = time.monotonic()
                pos = self._target.get('position', {})
                pose = PoseStamped()
                pose.header.frame_id = 'base_link'
                pose.header.stamp = self.get_clock().now().to_msg()
                pose.pose.position.x = float(pos.get('x', 0.3))
                pose.pose.position.y = float(pos.get('y', 0.0))
                pose.pose.position.z = float(pos.get('z', 0.5)) + self.pick_offset
                pose.pose.orientation.w = 1.0
                self.pose_pub.publish(pose)
                self.get_logger().info(
                    f'SIMULATED APPROACH to {self._target.get("class_id")} at '
                    f'({pos.get("x", 0):.2f}, {pos.get("y", 0):.2f}, {pos.get("z", 0):.2f})')
            if elapsed > 2.0:
                self._approach_start = None
                self._transition(State.PICK)

        elif self._state == State.PICK:
            if elapsed < 0.1:
                self.get_logger().info('GRASP: closing gripper')
            if elapsed > 1.0:
                self._transition(State.LIFT)

        elif self._state == State.LIFT:
            if elapsed < 0.1:
                pos = self._target.get('position', {}) if self._target else {}
                pose = PoseStamped()
                pose.header.frame_id = 'base_link'
                pose.header.stamp = self.get_clock().now().to_msg()
                pose.pose.position.x = float(pos.get('x', 0.3))
                pose.pose.position.y = float(pos.get('y', 0.0))
                pose.pose.position.z = float(pos.get('z', 0.5)) + 0.1
                pose.pose.orientation.w = 1.0
                self.pose_pub.publish(pose)
            if elapsed > 1.5:
                self._transition(State.PLACE)

        elif self._state == State.PLACE:
            if elapsed < 0.1:
                pose = PoseStamped()
                pose.header.frame_id = 'base_link'
                pose.header.stamp = self.get_clock().now().to_msg()
                pose.pose.position.x = 0.5
                pose.pose.position.y = 0.0
                pose.pose.position.z = 0.3
                pose.pose.orientation.w = 1.0
                self.pose_pub.publish(pose)
            if elapsed > 2.0:
                self.get_logger().info('RELEASE: opening gripper')
                self._task_count += 1
                self._success_count += 1
                self._transition(State.HOME)

        elif self._state == State.HOME:
            if elapsed < 0.1:
                self.get_logger().info('Moving to home position')
            if elapsed > 2.0:
                self._target = None
                self._task_command = {}
                self._transition(State.IDLE)

    def _publish_status(self):
        target_cls = self._target.get('class_id', '') if self._target else ''
        target_pos = self._target.get('position', {}) if self._target else {}
        status = {
            'state': self._state,
            'target_class': target_cls,
            'target_position': target_pos,
            'zone': self._zone,
            'estop': bool(self._estop),
            'task_count': self._task_count,
            'success_count': self._success_count,
        }
        msg = String()
        msg.data = json.dumps(status)
        self.status_pub.publish(msg)


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
