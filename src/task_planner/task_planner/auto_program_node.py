#!/usr/bin/env python3
"""Autonomous task generator.

Subscribes to /perception/scene_graph (std_msgs/String JSON describing
tracked objects). On a trigger from /task/generate_program (any String),
builds a structured scene description, sends it to a local Ollama
llama3.1:8b instance to produce a pick-and-place program, validates the
LLM's output against the current scene, and publishes:

    /task/auto_program  (std_msgs/String, JSON array of steps)
    /task/auto_status   (std_msgs/String, JSON: state + last error)

The LLM call runs in a worker thread so the ROS spin thread is never
blocked. If a previous generation is in flight, new triggers are
ignored until it finishes.
"""
import json
import threading
import time

import rclpy
import requests
from rclpy.node import Node
from std_msgs.msg import String


SYSTEM_PROMPT = """You are a collaborative robot task planner. You receive a JSON description of objects on a worktable detected by cameras and LiDAR.

Your job is to generate a pick-and-place program that a 6-axis robot arm can execute.

Rules:
- Only pick objects where graspable=true
- Approach each object from above (top-down grasp)
- Align gripper yaw with the object's yaw_deg
- Pick closest objects first (smallest distance_m)
- Place objects in a designated area at position [0.4, 0.0, table_height]
- After placing, return to home position before next pick

Output ONLY a JSON array of steps. No explanation. No markdown. Example:
[
  {"step": 1, "action": "move_home"},
  {"step": 2, "action": "pick", "target_id": "obj_001", "approach": "top_down", "gripper_width_cm": 5.0},
  {"step": 3, "action": "place", "position_m": [0.4, 0.0, 0.05], "approach": "top_down"},
  {"step": 4, "action": "move_home"}
]
"""


def _coerce_position(obj):
    pos = obj.get('position') or obj.get('pos') or obj.get('center') or [0.0, 0.0, 0.0]
    if isinstance(pos, dict):
        pos = [pos.get('x', 0.0), pos.get('y', 0.0), pos.get('z', 0.0)]
    out = [0.0, 0.0, 0.0]
    for i in range(min(3, len(pos))):
        try:
            out[i] = float(pos[i])
        except (TypeError, ValueError):
            pass
    return out


def _coerce_size(obj):
    size = (obj.get('size') or obj.get('size_3d') or obj.get('dims')
            or [0.05, 0.05, 0.05])
    out = [0.05, 0.05, 0.05]
    for i in range(min(3, len(size))):
        try:
            out[i] = float(size[i])
        except (TypeError, ValueError):
            pass
    return out


def _coerce_yaw(obj):
    ori = obj.get('orientation') or obj.get('euler') or [0.0, 0.0, 0.0]
    try:
        return float(ori[2])
    except (TypeError, ValueError, IndexError):
        return 0.0


def build_scene_description(objects):
    scene = {
        "timestamp": time.time(),
        "objects":   [],
        "workspace_bounds": {"x": [-0.5, 0.5], "y": [-0.5, 0.5], "z": [0.0, 0.5]},
    }
    for obj in objects or []:
        pos = _coerce_position(obj)
        size = _coerce_size(obj)
        scene["objects"].append({
            "id":         str(obj.get('id', 'unknown')),
            "class":      str(obj.get('class_name') or obj.get('class') or 'object'),
            "position_m": [round(p, 4) for p in pos],
            "size_cm":    [round(s * 100, 1) for s in size],
            "yaw_deg":    round(_coerce_yaw(obj), 1),
            "graspable":  all(s < 0.15 for s in size),
            "distance_m": round((pos[0]**2 + pos[1]**2) ** 0.5, 3),
        })
    return scene


def _strip_markdown(text):
    text = text.strip()
    if text.startswith('```'):
        text = text.split('\n', 1)[1] if '\n' in text else text[3:]
    if text.endswith('```'):
        text = text.rsplit('```', 1)[0]
    return text.strip()


def call_ollama(scene_json, host='http://localhost:11434', model='llama3.1:8b',
                timeout_s=60.0):
    """Returns (program_steps:list, raw_text:str, error:str|None)."""
    payload = {
        'model':  model,
        'prompt': (
            f'{SYSTEM_PROMPT}\n\nCurrent scene:\n'
            f'{json.dumps(scene_json, indent=2)}\n\nGenerate the program:'
        ),
        'stream': False,
        'options': {'temperature': 0.1, 'num_predict': 2000},
    }
    try:
        r = requests.post(f'{host}/api/generate', json=payload, timeout=timeout_s)
        r.raise_for_status()
    except Exception as e:
        return [], '', f'ollama request failed: {e}'

    text = (r.json() or {}).get('response', '')
    cleaned = _strip_markdown(text)
    try:
        program = json.loads(cleaned)
        if not isinstance(program, list):
            return [], text, 'LLM output is not a JSON array'
        return program, text, None
    except json.JSONDecodeError as e:
        return [], text, f'JSON decode: {e}'


def validate_program(program, scene):
    validated = []
    object_lookup = {obj['id']: obj for obj in scene.get('objects', [])}
    for step in program:
        if not isinstance(step, dict):
            continue
        action = step.get('action')
        if action == 'pick':
            target = step.get('target_id')
            obj = object_lookup.get(target)
            if obj is None:
                step['warning'] = f'Unknown target {target!r}'
            else:
                if not obj['graspable']:
                    step['warning'] = 'Object too large to grasp'
                step['target_position'] = obj['position_m']
                step['target_yaw']      = obj['yaw_deg']
        validated.append(step)
    return validated


class AutoProgramNode(Node):
    def __init__(self):
        super().__init__('auto_program_node')

        self.declare_parameter('ollama_host', 'http://localhost:11434')
        self.declare_parameter('ollama_model', 'llama3.1:8b')
        self.declare_parameter('ollama_timeout_s', 60.0)
        self.host    = self.get_parameter('ollama_host').value
        self.model   = self.get_parameter('ollama_model').value
        self.timeout = float(self.get_parameter('ollama_timeout_s').value)

        self._lock = threading.Lock()
        self._latest_scene_objects = []
        self._busy = False

        self._program_pub = self.create_publisher(String, '/task/auto_program', 5)
        self._status_pub  = self.create_publisher(String, '/task/auto_status', 5)

        self.create_subscription(String, '/perception/scene_graph',
                                 self._on_scene_graph, 10)
        self.create_subscription(String, '/task/generate_program',
                                 self._on_trigger, 5)

        self._publish_status('IDLE', None, 0)
        self.get_logger().info(
            f'auto_program_node ready | ollama {self.model} @ {self.host}')

    def _publish_status(self, state, error, n_steps):
        m = String()
        m.data = json.dumps({
            't': time.time(),
            'state': state,
            'error': error,
            'n_steps': n_steps,
        })
        self._status_pub.publish(m)

    def _on_scene_graph(self, msg):
        try:
            payload = json.loads(msg.data) if msg.data else {}
        except json.JSONDecodeError:
            return
        objects = (
            payload.get('objects')
            or payload.get('scene_graph', {}).get('objects')
            or []
        )
        if not isinstance(objects, list):
            return
        with self._lock:
            self._latest_scene_objects = objects

    def _on_trigger(self, msg):
        if self._busy:
            self.get_logger().warn(
                'generation already in flight — ignoring trigger')
            return
        self._busy = True
        threading.Thread(target=self._generate, daemon=True).start()

    def _generate(self):
        try:
            with self._lock:
                objects = list(self._latest_scene_objects)
            scene = build_scene_description(objects)
            self._publish_status('GENERATING', None, 0)
            self.get_logger().info(
                f'generating program for {len(scene["objects"])} object(s)')

            program, raw, err = call_ollama(
                scene, host=self.host, model=self.model, timeout_s=self.timeout)
            if err:
                self.get_logger().warn(f'LLM error: {err}')
                self._publish_status('ERROR', err, 0)
                return

            validated = validate_program(program, scene)
            out = String()
            out.data = json.dumps({
                't': time.time(),
                'scene_size': len(scene['objects']),
                'steps': validated,
            })
            self._program_pub.publish(out)
            self._publish_status('READY', None, len(validated))
            self.get_logger().info(
                f'published program: {len(validated)} step(s)')
        except Exception as e:
            self.get_logger().error(f'unhandled error in _generate: {e}')
            self._publish_status('ERROR', str(e), 0)
        finally:
            self._busy = False


def main(args=None):
    rclpy.init(args=args)
    node = AutoProgramNode()
    try:
        rclpy.spin(node)
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
