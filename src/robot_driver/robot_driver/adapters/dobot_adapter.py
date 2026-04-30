"""
Dobot cobot adapter.
Covers: CR3, CR5, CR10, CR16 (collaborative series).
SDK:  pip install dobot-api-v2   (or dobot-api for older firmware)
Docs: https://github.com/Dobot-Arm/TCP-IP-CR-Python-CMD

Protocol: plain-text commands over TCP port 29999 (dashboard)
          and port 30003 (real-time feedback).
"""

import socket
import time
import logging
from typing import Optional, List
from .base_adapter import BaseRobotAdapter, RobotState, MotionTarget

logger = logging.getLogger(__name__)

DASHBOARD_PORT = 29999
MOVE_PORT      = 30003
FEEDBACK_PORT  = 30004
TIMEOUT        = 3.0


class DobotAdapter(BaseRobotAdapter):
    """
    Dobot CR-series TCP/IP adapter.

    Config example:
      brand:      dobot
      robot_ip:   192.168.5.1
      robot_port: 29999
    """

    def __init__(self, ip: str, port: int = DASHBOARD_PORT, dof: int = 6):
        super().__init__(ip, port, dof)
        self._dash: Optional[socket.socket] = None
        self._move: Optional[socket.socket] = None

    def _open_socket(self, port: int) -> Optional[socket.socket]:
        try:
            s = socket.create_connection((self.ip, port), timeout=TIMEOUT)
            s.settimeout(TIMEOUT)
            return s
        except Exception as e:
            logger.error(f'Cannot connect to {self.ip}:{port} — {e}')
            return None

    def _send_cmd(self, sock: socket.socket, cmd: str) -> str:
        try:
            sock.sendall((cmd + '\n').encode('utf-8'))
            resp = sock.recv(1024).decode('utf-8').strip()
            return resp
        except Exception as e:
            logger.warning(f'Dobot send error: {e}')
            return ''

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def connect(self) -> bool:
        self._dash = self._open_socket(DASHBOARD_PORT)
        self._move = self._open_socket(MOVE_PORT)
        if not self._dash or not self._move:
            return False

        # Clear any existing errors, enable robot
        self._send_cmd(self._dash, 'ClearError()')
        time.sleep(0.2)
        resp = self._send_cmd(self._dash, 'EnableRobot()')
        self._connected = '0' in resp or 'ok' in resp.lower()
        if self._connected:
            logger.info(f'Dobot CR connected: {self.ip}')
        return self._connected

    def disconnect(self):
        try:
            if self._dash:
                self._send_cmd(self._dash, 'DisableRobot()')
                self._dash.close()
            if self._move:
                self._move.close()
        except Exception:
            pass
        self._connected = False

    # ── State ─────────────────────────────────────────────────────────────────

    def get_state(self) -> RobotState:
        s = RobotState()
        if not self._dash:
            return s
        try:
            # GetAngle() returns joint angles in degrees
            raw = self._send_cmd(self._dash, 'GetAngle()')
            # Response: {0,{j1,j2,j3,j4,j5,j6},GetAngle()}
            joints_deg = self._parse_tuple(raw)
            if joints_deg:
                s.joint_positions = self.deg_to_rad(joints_deg[:self.dof])

            # GetPose() returns [x,y,z mm, rx,ry,rz deg]
            raw = self._send_cmd(self._dash, 'GetPose()')
            pose = self._parse_tuple(raw)
            if pose and len(pose) >= 6:
                s.tcp_pose = [
                    self.mm_to_m(pose[0]), self.mm_to_m(pose[1]), self.mm_to_m(pose[2]),
                    *self.deg_to_rad(pose[3:6]),
                ]

            raw = self._send_cmd(self._dash, 'RobotMode()')
            mode_val = self._parse_single_int(raw)
            # Dobot modes: 5=running, 7=error, 9=idle
            s.is_moving  = mode_val == 5
            s.is_enabled = mode_val not in (1, 2)
            s.error_code = 1 if mode_val == 7 else 0
            s.mode = 'error' if s.error_code else ('moving' if s.is_moving else 'idle')
        except Exception as e:
            logger.warning(f'Dobot get_state error: {e}')
        return s

    # ── Motion ────────────────────────────────────────────────────────────────

    def move_to(self, target: MotionTarget) -> bool:
        if not self._move:
            return False
        speed = max(1, int(200 * target.speed_scale))
        acc   = max(1, int(400 * target.acceleration))
        try:
            if target.tcp_pose is not None:
                p = target.tcp_pose
                cmd = (f'MovL('
                       f'{self.m_to_mm(p[0]):.2f},{self.m_to_mm(p[1]):.2f},'
                       f'{self.m_to_mm(p[2]):.2f},'
                       f'{self.rad_to_deg([p[3]])[0]:.2f},'
                       f'{self.rad_to_deg([p[4]])[0]:.2f},'
                       f'{self.rad_to_deg([p[5]])[0]:.2f})')
            elif target.joint_positions is not None:
                degs = self.rad_to_deg(target.joint_positions)
                cmd = (f'JointMovJ('
                       + ','.join(f'{d:.2f}' for d in degs) + ')')
            else:
                return False
            resp = self._send_cmd(self._move, cmd)
            return '0' in resp
        except Exception as e:
            logger.error(f'Dobot move_to error: {e}')
            return False

    def stop(self):
        if self._dash:
            self._send_cmd(self._dash, 'StopMove()')

    def estop(self):
        if self._dash:
            self._send_cmd(self._dash, 'EmergencyStop()')

    def clear_error(self) -> bool:
        if not self._dash:
            return False
        self._send_cmd(self._dash, 'ClearError()')
        time.sleep(0.3)
        resp = self._send_cmd(self._dash, 'EnableRobot()')
        return '0' in resp

    def enable(self) -> bool:
        if not self._dash:
            return False
        resp = self._send_cmd(self._dash, 'EnableRobot()')
        return '0' in resp

    def disable(self):
        if self._dash:
            self._send_cmd(self._dash, 'DisableRobot()')

    # ── Parsing helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _parse_tuple(resp: str) -> List[float]:
        """Extract float list from Dobot response like {0,{1.0,2.0,...},cmd()}."""
        try:
            inner = resp.split('{')[2].split('}')[0]
            return [float(v) for v in inner.split(',')]
        except Exception:
            return []

    @staticmethod
    def _parse_single_int(resp: str) -> int:
        try:
            return int(resp.split('{')[1].split(',')[1].strip())
        except Exception:
            return 0
