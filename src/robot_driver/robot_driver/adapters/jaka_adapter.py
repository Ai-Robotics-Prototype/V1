"""
JAKA Zu cobot adapter.
Protocol: JSON over TCP on port 10000.
Docs: JAKA SDK Manual v2.x

Tested with: JAKA Zu 3, Zu 5, Zu 7, MiniCobo
"""

import json
import socket
import threading
import time
import logging
from typing import List, Optional
from .base_adapter import BaseRobotAdapter, RobotState, MotionTarget

logger = logging.getLogger(__name__)

JAKA_PORT    = 10000
JAKA_TIMEOUT = 3.0


class JAKAAdapter(BaseRobotAdapter):
    """
    JAKA cobot JSON/TCP adapter.

    Config example:
      brand:      jaka
      robot_ip:   192.168.2.100
      robot_port: 10000
    """

    def __init__(self, ip: str, port: int = JAKA_PORT, dof: int = 6):
        super().__init__(ip, port, dof)
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._cmd_id = 0

    # ── TCP helpers ───────────────────────────────────────────────────────────

    def _send(self, cmd: dict) -> Optional[dict]:
        """Send JSON command, return JSON response."""
        self._cmd_id += 1
        cmd['id'] = self._cmd_id
        payload = (json.dumps(cmd) + '\r\n').encode('utf-8')
        with self._lock:
            try:
                self._sock.sendall(payload)
                raw = b''
                while True:
                    chunk = self._sock.recv(4096)
                    if not chunk:
                        break
                    raw += chunk
                    if raw.endswith(b'\r\n') or b'\r\n' in raw:
                        break
                return json.loads(raw.decode('utf-8').strip())
            except Exception as e:
                logger.warning(f'JAKA send error: {e}')
                return None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def connect(self) -> bool:
        try:
            self._sock = socket.create_connection(
                (self.ip, self.port), timeout=JAKA_TIMEOUT)
            self._sock.settimeout(JAKA_TIMEOUT)
            # Power on and enable
            self._send({'cmdName': 'power_on'})
            time.sleep(0.5)
            resp = self._send({'cmdName': 'enable_robot'})
            self._connected = resp is not None and resp.get('errorCode', -1) == 0
            if self._connected:
                logger.info(f'JAKA connected: {self.ip}:{self.port}')
            return self._connected
        except Exception as e:
            logger.error(f'JAKA connect failed: {e}')
            return False

    def disconnect(self):
        try:
            if self._sock:
                self._send({'cmdName': 'disable_robot'})
                self._sock.close()
        except Exception:
            pass
        self._connected = False

    # ── State ─────────────────────────────────────────────────────────────────

    def get_state(self) -> RobotState:
        s = RobotState()
        resp = self._send({'cmdName': 'get_robot_status'})
        if not resp:
            return s

        data = resp.get('data', {})

        joints_deg = data.get('jointPos', [0.0] * self.dof)
        s.joint_positions = self.deg_to_rad(joints_deg[:self.dof])

        tcp = data.get('cartPos', [0.0] * 6)
        # JAKA: [x,y,z mm, rx,ry,rz deg]
        s.tcp_pose = [
            self.mm_to_m(tcp[0]), self.mm_to_m(tcp[1]), self.mm_to_m(tcp[2]),
            *self.deg_to_rad(tcp[3:6]),
        ]

        s.is_moving  = bool(data.get('isMoving', False))
        s.is_enabled = bool(data.get('isPowerOn', False))
        s.error_code = int(data.get('errorCode', 0))
        s.error_message = data.get('errorMsg', '')
        s.mode = 'error' if s.error_code else ('moving' if s.is_moving else 'idle')
        return s

    # ── Motion ────────────────────────────────────────────────────────────────

    def move_to(self, target: MotionTarget) -> bool:
        if target.tcp_pose is not None:
            p = target.tcp_pose
            # JAKA expects mm + degrees
            cmd = {
                'cmdName': 'moveL',
                'targetPos': [
                    self.m_to_mm(p[0]), self.m_to_mm(p[1]), self.m_to_mm(p[2]),
                    *self.rad_to_deg(p[3:6]),
                ],
                'speed': 200.0 * target.speed_scale,
                'acc':   1000.0 * target.acceleration,
                'cont':  0,
            }
        elif target.joint_positions is not None:
            cmd = {
                'cmdName': 'moveJ',
                'jointPos': self.rad_to_deg(target.joint_positions),
                'speed': 30.0 * target.speed_scale,
                'acc':   100.0 * target.acceleration,
                'cont':  0,
            }
        else:
            return False
        resp = self._send(cmd)
        return resp is not None and resp.get('errorCode', -1) == 0

    def stop(self):
        self._send({'cmdName': 'stop_move'})

    def estop(self):
        self._send({'cmdName': 'emergency_stop'})

    def clear_error(self) -> bool:
        resp = self._send({'cmdName': 'clear_error'})
        if resp and resp.get('errorCode', -1) == 0:
            self._send({'cmdName': 'enable_robot'})
            return True
        return False

    def enable(self) -> bool:
        resp = self._send({'cmdName': 'enable_robot'})
        return resp is not None and resp.get('errorCode', -1) == 0

    def disable(self):
        self._send({'cmdName': 'disable_robot'})
