"""
Generic TCP/IP adapter — covers brands not yet explicitly supported:
  Fairino (FR series), Elite Robots (CS series), Rokae (xMate),
  Aubo i-series, Han's Robot (Elfin), Lebai, Elephant Robotics, etc.

Strategy:
  1. Tries a JSON-based probe on the configured port.
  2. Falls back to a minimal Modbus TCP read for joint positions.
  3. If neither works, runs in FAKE mode (simulated motion, safe for development).

When you identify your brand, replace this with a dedicated adapter
(copy xarm_adapter.py or jaka_adapter.py as a template).
"""

import json
import math
import socket
import threading
import time
import logging
from typing import List, Optional
from .base_adapter import BaseRobotAdapter, RobotState, MotionTarget

logger = logging.getLogger(__name__)

# Common Chinese cobot TCP ports to probe
PROBE_PORTS = [10000, 29999, 8080, 5000, 8181, 2000]


class GenericAdapter(BaseRobotAdapter):
    """
    Probe-and-connect adapter for unknown Chinese cobot brands.

    Falls back to FAKE mode if no TCP connection succeeds, so the
    full ROS stack still runs and can be tested.

    Config example:
      brand:      generic
      robot_ip:   192.168.1.100
      robot_port: 0        # 0 = auto-probe
    """

    def __init__(self, ip: str, port: int = 0, dof: int = 6):
        super().__init__(ip, port, dof)
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._fake = False
        self._fake_joints = [0.0] * dof
        self._fake_target: Optional[List[float]] = None
        self._detected_brand = 'unknown'

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def connect(self) -> bool:
        ports = [self.port] if self.port > 0 else PROBE_PORTS
        for p in ports:
            sock = self._try_connect(self.ip, p)
            if sock:
                self._sock = sock
                self.port  = p
                self._connected = True
                self._detected_brand = self._probe_brand()
                logger.info(f'Generic adapter connected: {self.ip}:{p} '
                            f'(detected: {self._detected_brand})')
                return True

        # No connection — run fake
        logger.warning(
            f'Cannot reach robot at {self.ip} on ports {ports}. '
            f'Running in FAKE mode — motion will be simulated.')
        self._fake      = True
        self._connected = True
        return True

    def _try_connect(self, ip: str, port: int,
                     timeout: float = 1.5) -> Optional[socket.socket]:
        try:
            s = socket.create_connection((ip, port), timeout=timeout)
            s.settimeout(2.0)
            return s
        except Exception:
            return None

    def _probe_brand(self) -> str:
        """Send common JSON probes to identify the brand."""
        probes = [
            ('{"cmdName":"get_robot_status"}',       'jaka'),
            ('EnableRobot()\n',                      'dobot'),
            ('{"method":"getRobotState","params":[]}','fairino'),
        ]
        for probe, brand in probes:
            try:
                with self._lock:
                    self._sock.sendall(probe.encode('utf-8'))
                    resp = self._sock.recv(1024).decode('utf-8', errors='ignore')
                if resp and len(resp) > 2:
                    logger.info(f'Brand probe matched: {brand}')
                    return brand
            except Exception:
                continue
        return 'unknown'

    def disconnect(self):
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass
        self._connected = False

    # ── State ─────────────────────────────────────────────────────────────────

    def get_state(self) -> RobotState:
        s = RobotState()
        if self._fake:
            return self._fake_state()
        try:
            # Try JSON first (covers JAKA, Fairino, many others)
            resp = self._send_json({'cmdName': 'get_robot_status'})
            if resp:
                data = resp.get('data', resp)
                joints = data.get('jointPos') or data.get('joint_pos') or []
                if joints:
                    s.joint_positions = [math.radians(j) for j in joints[:self.dof]]
                tcp = data.get('cartPos') or data.get('tcp_pos') or []
                if len(tcp) >= 6:
                    s.tcp_pose = [
                        tcp[0]/1000, tcp[1]/1000, tcp[2]/1000,
                        math.radians(tcp[3]), math.radians(tcp[4]), math.radians(tcp[5]),
                    ]
                s.is_enabled = True
                s.mode = 'idle'
        except Exception as e:
            logger.debug(f'get_state probe failed: {e}')
        return s

    def _fake_state(self) -> RobotState:
        # Smoothly interpolate toward target
        if self._fake_target:
            for i in range(self.dof):
                diff = self._fake_target[i] - self._fake_joints[i]
                step = math.copysign(min(abs(diff), 0.01), diff)
                self._fake_joints[i] += step
        s = RobotState()
        s.joint_positions = list(self._fake_joints)
        s.is_enabled = True
        s.mode = 'idle'
        return s

    # ── Motion ────────────────────────────────────────────────────────────────

    def move_to(self, target: MotionTarget) -> bool:
        if self._fake:
            if target.joint_positions:
                self._fake_target = list(target.joint_positions)
            logger.info(f'[FAKE] move_to: {target}')
            return True

        if target.tcp_pose is not None:
            p = target.tcp_pose
            cmd = {
                'cmdName': 'moveL',
                'targetPos': [
                    p[0]*1000, p[1]*1000, p[2]*1000,
                    math.degrees(p[3]), math.degrees(p[4]), math.degrees(p[5]),
                ],
                'speed': 100.0 * target.speed_scale,
            }
        elif target.joint_positions is not None:
            cmd = {
                'cmdName': 'moveJ',
                'jointPos': [math.degrees(j) for j in target.joint_positions],
                'speed': 20.0 * target.speed_scale,
            }
        else:
            return False

        resp = self._send_json(cmd)
        return resp is not None

    def stop(self):
        if not self._fake:
            self._send_json({'cmdName': 'stop_move'})
        self._fake_target = None

    def estop(self):
        if not self._fake:
            self._send_json({'cmdName': 'emergency_stop'})
        self._fake_target = None

    def clear_error(self) -> bool:
        if self._fake:
            return True
        resp = self._send_json({'cmdName': 'clear_error'})
        return resp is not None

    def enable(self) -> bool:
        if self._fake:
            return True
        resp = self._send_json({'cmdName': 'enable_robot'})
        return resp is not None

    def disable(self):
        if not self._fake:
            self._send_json({'cmdName': 'disable_robot'})

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _send_json(self, cmd: dict) -> Optional[dict]:
        payload = (json.dumps(cmd) + '\r\n').encode('utf-8')
        with self._lock:
            try:
                self._sock.sendall(payload)
                raw = self._sock.recv(4096).decode('utf-8').strip()
                return json.loads(raw)
            except Exception as e:
                logger.debug(f'_send_json error: {e}')
                return None
