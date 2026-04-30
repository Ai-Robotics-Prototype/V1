"""
gripper_node — generic TCP/IP gripper interface.

Supported brands:
  dh        : DH-Robotics AG-95, PGC-50/140 (RS485-over-TCP gateway)
  robotiq   : Robotiq 2F-85 / 2F-140 (Modbus TCP port 502)
  xarm      : xArm built-in gripper (via xArm SDK)
  fake      : simulated (default — safe for development)

Topics:
  /gripper/command   std_msgs/Float32   0.0 = fully open, 1.0 = fully closed
  /gripper/state     std_msgs/String    JSON {position, force, is_moving, error}

Services:
  /gripper/open      std_srvs/Trigger
  /gripper/close     std_srvs/Trigger
  /gripper/set       std_srvs/SetBool   true=close, false=open
"""

import json
import socket
import struct
import time
import threading
import rclpy
from rclpy.node import Node
from std_msgs.msg import Float32, String
from std_srvs.srv import Trigger, SetBool


class GripperNode(Node):
    def __init__(self):
        super().__init__('gripper_node')

        self.declare_parameter('brand',         'fake')
        self.declare_parameter('gripper_ip',    '192.168.1.100')
        self.declare_parameter('gripper_port',  0)
        self.declare_parameter('open_position', 0.0)
        self.declare_parameter('close_position',1.0)
        self.declare_parameter('speed',         0.5)
        self.declare_parameter('force',         0.5)

        self._brand     = self.get_parameter('brand').value.lower()
        self._ip        = self.get_parameter('gripper_ip').value
        self._port      = self.get_parameter('gripper_port').value
        self._open_pos  = self.get_parameter('open_position').value
        self._close_pos = self.get_parameter('close_position').value
        self._speed     = self.get_parameter('speed').value
        self._force     = self.get_parameter('force').value

        self._position  = 0.0   # 0=open, 1=closed
        self._is_moving = False
        self._error     = ''
        self._sock: socket.socket = None
        self._lock = threading.Lock()

        self._connect()

        self.create_subscription(Float32, '/gripper/command', self._cmd_cb, 10)
        self._state_pub = self.create_publisher(String, '/gripper/state', 10)
        self.create_service(Trigger, '/gripper/open',  self._open_cb)
        self.create_service(Trigger, '/gripper/close', self._close_cb)
        self.create_service(SetBool, '/gripper/set',   self._set_cb)
        self.create_timer(0.1, self._publish_state)

        self.get_logger().info(f'gripper_node started | brand={self._brand}')

    # ── Connection ────────────────────────────────────────────────────────────

    def _connect(self):
        if self._brand == 'fake':
            self.get_logger().info('Gripper: FAKE mode')
            return
        default_ports = {'dh': 6000, 'robotiq': 502, 'xarm': 18333}
        port = self._port or default_ports.get(self._brand, 6000)
        try:
            self._sock = socket.create_connection((self._ip, port), timeout=3.0)
            self._sock.settimeout(2.0)
            self.get_logger().info(f'Gripper connected: {self._ip}:{port}')
        except Exception as e:
            self.get_logger().warn(f'Gripper not reachable ({e}) — FAKE mode')
            self._brand = 'fake'

    # ── Command dispatch ──────────────────────────────────────────────────────

    def _send_position(self, position: float):
        """position: 0.0 = fully open, 1.0 = fully closed."""
        pos = max(0.0, min(1.0, position))
        if self._brand == 'fake':
            self._position  = pos
            self._is_moving = False
            return

        with self._lock:
            if self._brand == 'dh':
                self._send_dh(pos)
            elif self._brand == 'robotiq':
                self._send_robotiq(pos)

    def _send_dh(self, pos: float):
        # DH-Robotics Modbus RTU-over-TCP
        # Register 0x0103 = position (0–1000), 0x0104 = speed, 0x0105 = force
        pos_raw   = int(pos * 1000)
        speed_raw = int(self._speed * 1000)
        force_raw = int(self._force * 100)
        for reg, val in [(0x0103, pos_raw), (0x0104, speed_raw), (0x0105, force_raw)]:
            pdu = struct.pack('>BBHH', 0x01, 0x06, reg, val)
            mbap = struct.pack('>HHHB', 0, 0, len(pdu) + 1, 0x01)
            self._sock.sendall(mbap + pdu)
            self._sock.recv(256)
        self._position = pos

    def _send_robotiq(self, pos: float):
        # Robotiq 2F Modbus TCP — register 0x03E8 (ACTION_REQUEST)
        # Byte 0: rACT=1, rGTO=1, rATR=0 → 0x09
        # Byte 3: position (0=open, 255=closed)
        # Byte 4: speed (0–255)
        # Byte 5: force (0–255)
        rPOS = int(pos * 255)
        rSPD = int(self._speed * 255)
        rFOR = int(self._force * 255)
        data = struct.pack('>BBBBBB', 0x09, 0x00, 0x00, rPOS, rSPD, rFOR)
        # Write 3 holding registers starting at 0x03E8
        pdu  = struct.pack('>BBHHB', 0x01, 0x10, 0x03E8, 3, 6) + data
        mbap = struct.pack('>HHHB', 0, 0, len(pdu) + 1, 0xFF)
        self._sock.sendall(mbap + pdu)
        self._sock.recv(256)
        self._position = pos

    # ── Subscribers / Services ────────────────────────────────────────────────

    def _cmd_cb(self, msg: Float32):
        self._send_position(msg.data)

    def _open_cb(self, req, res: Trigger.Response):
        self._send_position(self._open_pos)
        res.success = True
        res.message = 'opening'
        return res

    def _close_cb(self, req, res: Trigger.Response):
        self._send_position(self._close_pos)
        res.success = True
        res.message = 'closing'
        return res

    def _set_cb(self, req: SetBool.Request, res: SetBool.Response):
        self._send_position(self._close_pos if req.data else self._open_pos)
        res.success = True
        res.message = 'closed' if req.data else 'opened'
        return res

    def _publish_state(self):
        state = {
            'position': round(self._position, 3),
            'force':    self._force,
            'is_moving':self._is_moving,
            'brand':    self._brand,
            'error':    self._error,
        }
        msg = String()
        msg.data = json.dumps(state)
        self._state_pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = GripperNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
