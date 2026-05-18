import glob
import hashlib
import json
import os
import time
import rclpy
from rclpy.node import Node

try:
    import urllib.request
    import urllib.error
    HTTP_AVAILABLE = True
except ImportError:
    HTTP_AVAILABLE = False


class UploadAgentNode(Node):
    def __init__(self):
        super().__init__('upload_agent_node')

        self.declare_parameter('upload_url', 'https://your-api.example.com/experiences')
        self.declare_parameter('api_key_path', '/opt/cobot/fleet_api_key.txt')
        self.declare_parameter('upload_hour', 2)
        self.declare_parameter('max_file_age_days', 30)
        self.declare_parameter('enabled', False)

        self.enabled = self.get_parameter('enabled').value
        self.upload_url = self.get_parameter('upload_url').value
        self.api_key_path = self.get_parameter('api_key_path').value
        self.upload_hour = self.get_parameter('upload_hour').value
        self.max_file_age_days = self.get_parameter('max_file_age_days').value

        self._last_upload_day = -1

        self.create_timer(60.0, self._check_upload_time)

        if not self.enabled:
            self.get_logger().info('Fleet upload disabled — set enabled:true in fleet.yaml')
        self.get_logger().info('upload_agent_node started')

    def _check_upload_time(self):
        if not self.enabled:
            return
        now = time.localtime()
        if now.tm_hour == self.upload_hour and now.tm_yday != self._last_upload_day:
            self._last_upload_day = now.tm_yday
            self._do_upload()

    def _load_api_key(self) -> str:
        if os.path.exists(self.api_key_path):
            with open(self.api_key_path) as f:
                return f.read().strip()
        return ''

    def _anonymise_robot_id(self, robot_id: str) -> str:
        return hashlib.sha256(robot_id.encode()).hexdigest()[:16]

    def _do_upload(self):
        logs_dir = '/opt/cobot/logs' if os.path.isdir('/opt/cobot/logs') else '/tmp/cobot_logs'
        pattern = os.path.join(logs_dir, 'experiences_*.jsonl')
        files = glob.glob(pattern)
        api_key = self._load_api_key()

        for filepath in files:
            age_days = (time.time() - os.path.getmtime(filepath)) / 86400
            if age_days > self.max_file_age_days:
                os.remove(filepath)
                self.get_logger().info(f'Deleted old log: {filepath}')
                continue

            try:
                with open(filepath) as f:
                    lines = f.readlines()
                anonymised = []
                for line in lines:
                    try:
                        entry = json.loads(line)
                        entry['robot_id'] = self._anonymise_robot_id(entry.get('robot_id', ''))
                        anonymised.append(json.dumps(entry))
                    except json.JSONDecodeError:
                        continue

                payload = '\n'.join(anonymised).encode('utf-8')
                req = urllib.request.Request(
                    self.upload_url, data=payload,
                    headers={
                        'Content-Type': 'application/x-ndjson',
                        'X-Api-Key': api_key,
                    },
                    method='POST')
                with urllib.request.urlopen(req, timeout=30) as resp:
                    if resp.status == 200:
                        os.remove(filepath)
                        self.get_logger().info(f'Uploaded and removed: {filepath}')
                    else:
                        self.get_logger().warn(f'Upload failed ({resp.status}): {filepath}')
            except Exception as e:
                self.get_logger().warn(f'Upload error for {filepath}: {e} — will retry tomorrow')


def main(args=None):
    rclpy.init(args=args)
    node = UploadAgentNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
