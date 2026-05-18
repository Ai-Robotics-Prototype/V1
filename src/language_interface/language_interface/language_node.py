import json
import re
import rclpy
from rclpy.node import Node
from std_msgs.msg import String

try:
    import urllib.request
    import urllib.error
    HTTP_AVAILABLE = True
except ImportError:
    HTTP_AVAILABLE = False

SYSTEM_PROMPT = """You are a robot task planner. You receive a natural language command and
a JSON scene graph showing visible objects.

You must respond with ONLY a valid JSON task plan in this exact format:
{
  "action": "pick_and_place",
  "target_object": "bottle",
  "target_class_id": "bottle",
  "place_position": {"x": 0.5, "y": 0.0, "z": 0.3},
  "confidence": 0.95,
  "reasoning": "User asked to move the bottle. I can see a bottle at position..."
}

Valid actions: pick_and_place, go_home, pause, resume, stop
If the command is unclear or no matching object exists, respond:
{"action": "clarify", "message": "I cannot see a bottle. I can see: [list objects]"}
Respond with JSON only. No prose. No markdown."""


class LanguageNode(Node):
    def __init__(self):
        super().__init__('language_node')

        self.declare_parameter('ollama_host', 'http://localhost:11434')
        self.declare_parameter('model_name', 'llama3.1:8b')
        self.declare_parameter('max_tokens', 512)
        self.declare_parameter('temperature', 0.1)
        self.declare_parameter('context_window_objects', 10)
        self.declare_parameter('timeout_s', 10.0)

        self.ollama_host = self.get_parameter('ollama_host').value
        self.model_name = self.get_parameter('model_name').value
        self.max_tokens = self.get_parameter('max_tokens').value
        self.temperature = self.get_parameter('temperature').value
        self.context_window = self.get_parameter('context_window_objects').value
        self.timeout_s = self.get_parameter('timeout_s').value

        self._latest_scene_graph = '{}'
        self._ollama_connected = False
        self._last_command = ''
        self._last_action = ''
        self._command_count = 0

        self.create_subscription(String, '/language/text_command', self._command_cb, 10)
        self.create_subscription(String, '/perception/scene_graph', self._scene_cb, 10)

        self.task_pub = self.create_publisher(String, '/task/command', 10)
        self.response_pub = self.create_publisher(String, '/language/response', 10)
        self.status_pub = self.create_publisher(String, '/language/status', 10)

        self.create_timer(0.5, self._publish_status)
        self.create_timer(10.0, self._check_ollama)

        self._check_ollama()
        self.get_logger().info('language_node started')

    def _scene_cb(self, msg: String):
        self._latest_scene_graph = msg.data

    def _check_ollama(self):
        try:
            url = f'{self.ollama_host}/api/tags'
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=3.0) as resp:
                if resp.status == 200:
                    self._ollama_connected = True
                    return
        except Exception:
            pass
        self._ollama_connected = False
        self.get_logger().warn('Ollama not reachable — will retry', throttle_duration_sec=30.0)

    def _strip_markdown(self, text: str) -> str:
        text = text.strip()
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
        return text.strip()

    def _command_cb(self, msg: String):
        command = msg.data.strip()
        if not command:
            return

        self._last_command = command
        self._command_count += 1
        self.get_logger().info(f'Received command: {command}')

        if not self._ollama_connected:
            self._check_ollama()
            if not self._ollama_connected:
                resp_msg = String()
                resp_msg.data = 'Cannot process command: Ollama not available'
                self.response_pub.publish(resp_msg)
                return

        # Trim scene graph for context window
        try:
            graph = json.loads(self._latest_scene_graph)
            objects = list(graph.values())[:self.context_window]
            scene_str = json.dumps(objects)
        except Exception:
            scene_str = '{}'

        prompt = f'{SYSTEM_PROMPT}\nScene: {scene_str}\nCommand: {command}'

        payload = json.dumps({
            'model': self.model_name,
            'prompt': prompt,
            'stream': False,
            'options': {
                'temperature': self.temperature,
                'num_predict': self.max_tokens,
            },
        }).encode('utf-8')

        try:
            url = f'{self.ollama_host}/api/generate'
            req = urllib.request.Request(
                url, data=payload,
                headers={'Content-Type': 'application/json'},
                method='POST')
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                raw = resp.read().decode('utf-8')
            result = json.loads(raw)
            llm_text = result.get('response', '')
        except Exception as e:
            self.get_logger().error(f'Ollama request failed: {e}')
            resp_msg = String()
            resp_msg.data = f'LLM error: {e}'
            self.response_pub.publish(resp_msg)
            return

        clean = self._strip_markdown(llm_text)
        try:
            task_plan = json.loads(clean)
        except json.JSONDecodeError as e:
            self.get_logger().error(f'LLM response is not valid JSON: {e}\nRaw: {clean[:200]}')
            resp_msg = String()
            resp_msg.data = f'Could not parse LLM response as JSON'
            self.response_pub.publish(resp_msg)
            return

        self._last_action = task_plan.get('action', '')

        task_msg = String()
        task_msg.data = json.dumps(task_plan)
        self.task_pub.publish(task_msg)

        action = task_plan.get('action', 'unknown')
        target = task_plan.get('target_object', '')
        reasoning = task_plan.get('reasoning', '')
        human_text = f'Action: {action}'
        if target:
            human_text += f', target: {target}'
        if reasoning:
            human_text += f'. {reasoning}'

        resp_msg = String()
        resp_msg.data = human_text
        self.response_pub.publish(resp_msg)
        self.get_logger().info(f'Task plan published: {action} → {target}')

    def _publish_status(self):
        status = {
            'ollama_connected': self._ollama_connected,
            'model_loaded': self.model_name if self._ollama_connected else None,
            'last_command': self._last_command,
            'last_action': self._last_action,
            'command_count': self._command_count,
        }
        msg = String()
        msg.data = json.dumps(status)
        self.status_pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = LanguageNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
