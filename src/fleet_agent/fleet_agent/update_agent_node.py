import hashlib
import json
import os
import shutil
import tempfile
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

try:
    import urllib.request
    import urllib.error
    HTTP_AVAILABLE = True
except ImportError:
    HTTP_AVAILABLE = False


class UpdateAgentNode(Node):
    def __init__(self):
        super().__init__('update_agent_node')

        self.declare_parameter('update_url', 'https://your-api.example.com/models/latest')
        self.declare_parameter('current_model_version_path', '/opt/cobot/models/version.txt')
        self.declare_parameter('models_dir', '/opt/cobot/models/')
        self.declare_parameter('check_interval_s', 3600.0)
        self.declare_parameter('enabled', False)

        self.enabled = self.get_parameter('enabled').value
        self.update_url = self.get_parameter('update_url').value
        self.version_path = self.get_parameter('current_model_version_path').value
        self.models_dir = self.get_parameter('models_dir').value
        interval = self.get_parameter('check_interval_s').value

        self._current_task_state = 'IDLE'
        self.create_subscription(String, '/task/state', self._task_state_cb, 10)
        self.model_updated_pub = self.create_publisher(String, '/fleet/model_updated', 10)

        self.create_timer(interval, self._check_for_update)

        if not self.enabled:
            self.get_logger().info('Update agent disabled — set enabled:true in fleet.yaml')
        self.get_logger().info('update_agent_node started')

    def _task_state_cb(self, msg: String):
        self._current_task_state = msg.data

    def _read_version(self) -> str:
        if os.path.exists(self.version_path):
            with open(self.version_path) as f:
                return f.read().strip()
        return '0.0.0'

    def _check_for_update(self):
        if not self.enabled:
            self.get_logger().info('Update agent disabled — skipping check')
            return

        current_version = self._read_version()
        try:
            url = f'{self.update_url}?version={current_version}'
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10.0) as resp:
                data = json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            self.get_logger().warn(f'Update check failed: {e}')
            return

        if not data.get('update_available'):
            return

        new_version = data.get('version', 'unknown')
        download_url = data.get('download_url', '')
        expected_sha256 = data.get('sha256', '')
        self.get_logger().info(f'Model update available: v{new_version}')

        # Download to staging area
        staging_dir = os.path.join(self.models_dir, 'download_staging')
        os.makedirs(staging_dir, exist_ok=True)
        filename = download_url.split('/')[-1] or 'model.pt'
        staging_path = os.path.join(staging_dir, filename)

        try:
            urllib.request.urlretrieve(download_url, staging_path)
        except Exception as e:
            self.get_logger().error(f'Download failed: {e}')
            return

        # Verify checksum
        if expected_sha256:
            sha = hashlib.sha256()
            with open(staging_path, 'rb') as f:
                for chunk in iter(lambda: f.read(8192), b''):
                    sha.update(chunk)
            if sha.hexdigest() != expected_sha256:
                self.get_logger().error('Checksum mismatch — aborting update')
                os.remove(staging_path)
                return

        # Wait until IDLE
        deadline = 60.0
        waited = 0.0
        while self._current_task_state != 'IDLE' and waited < deadline:
            import time
            time.sleep(1.0)
            waited += 1.0

        if self._current_task_state != 'IDLE':
            self.get_logger().warn('Robot not idle after 60s — deferring model update')
            return

        dest_path = os.path.join(self.models_dir, filename)
        shutil.move(staging_path, dest_path)

        with open(self.version_path, 'w') as f:
            f.write(new_version)

        msg = String()
        msg.data = new_version
        self.model_updated_pub.publish(msg)
        self.get_logger().info(f'Model updated to v{new_version}')


def main(args=None):
    rclpy.init(args=args)
    node = UpdateAgentNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
