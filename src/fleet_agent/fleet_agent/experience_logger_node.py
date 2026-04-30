import json
import os
import time
import uuid
from datetime import datetime
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

LOGS_DIR = '/opt/cobot/logs'
ROBOT_ID_PATH = '/opt/cobot/robot_id'


def _get_or_create_robot_id() -> str:
    os.makedirs(os.path.dirname(ROBOT_ID_PATH), exist_ok=True)
    if os.path.exists(ROBOT_ID_PATH):
        with open(ROBOT_ID_PATH) as f:
            return f.read().strip()
    robot_id = str(uuid.uuid4())
    with open(ROBOT_ID_PATH, 'w') as f:
        f.write(robot_id)
    return robot_id


class ExperienceLoggerNode(Node):
    def __init__(self):
        super().__init__('experience_logger_node')

        self._robot_id = _get_or_create_robot_id()
        self._latest_task_status: dict = {}
        self._latest_safety_status: dict = {}
        self._latest_scene: dict = {}
        self._prev_state = ''
        self._task_start_time: float = 0.0
        self._zone_transitions: list = []
        self._estop_events: int = 0

        global LOGS_DIR
        try:
            os.makedirs(LOGS_DIR, exist_ok=True)
        except PermissionError:
            self.get_logger().warn(f'Cannot create {LOGS_DIR} — logging to /tmp/cobot_logs')
            LOGS_DIR = '/tmp/cobot_logs'
            os.makedirs(LOGS_DIR, exist_ok=True)

        self.create_subscription(String, '/task/status', self._task_cb, 10)
        self.create_subscription(String, '/safety/status', self._safety_cb, 10)
        self.create_subscription(String, '/perception/scene_graph', self._scene_cb, 10)

        self.get_logger().info(f'experience_logger_node started, robot_id={self._robot_id}')

    def _task_cb(self, msg: String):
        try:
            status = json.loads(msg.data)
        except json.JSONDecodeError:
            return

        state = status.get('state', '')

        if self._prev_state == 'PICK' and state == 'LIFT':
            self._task_start_time = time.time()

        if self._prev_state == 'HOME' and state == 'IDLE':
            # Task completed
            duration = time.time() - self._task_start_time if self._task_start_time else 0.0
            success = status.get('success_count', 0) > 0
            entry = {
                'timestamp': time.time(),
                'robot_id': self._robot_id,
                'task': {
                    'action': 'pick_and_place',
                    'target_class': status.get('target_class', ''),
                    'success': bool(status.get('success_count', 0) >= status.get('task_count', 1)),
                    'duration_s': round(duration, 2),
                    'attempts': 1,
                },
                'safety': {
                    'zone_transitions': list(self._zone_transitions),
                    'estop_events': self._estop_events,
                },
                'scene_snapshot': self._latest_scene,
            }
            self._write_log(entry)
            self._zone_transitions.clear()
            self._estop_events = 0

        self._prev_state = state
        self._latest_task_status = status

    def _safety_cb(self, msg: String):
        try:
            status = json.loads(msg.data)
        except json.JSONDecodeError:
            return

        zone = status.get('zone', '')
        if not self._zone_transitions or self._zone_transitions[-1] != zone:
            self._zone_transitions.append(zone)

        if status.get('estop') and not self._latest_safety_status.get('estop'):
            self._estop_events += 1

        self._latest_safety_status = status

    def _scene_cb(self, msg: String):
        try:
            self._latest_scene = json.loads(msg.data)
        except json.JSONDecodeError:
            pass

    def _write_log(self, entry: dict):
        date_str = datetime.utcnow().strftime('%Y-%m-%d')
        log_file = os.path.join(LOGS_DIR, f'experiences_{date_str}.jsonl')
        try:
            with open(log_file, 'a') as f:
                f.write(json.dumps(entry) + '\n')
            self.get_logger().info(f'Experience logged to {log_file}')
        except Exception as e:
            self.get_logger().error(f'Failed to write log: {e}')


def main(args=None):
    rclpy.init(args=args)
    node = ExperienceLoggerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
