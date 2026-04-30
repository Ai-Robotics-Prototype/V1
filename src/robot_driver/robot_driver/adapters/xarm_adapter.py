"""
UFACTORY xArm adapter.
Supports: xArm 5/6/7, Lite 6
SDK:  pip install xArm-Python-SDK
Docs: https://github.com/xArm-Developer/xArm-Python-SDK

Default port: 502 (Modbus) — SDK handles internally via port 18333.
"""

import logging
from typing import List
from .base_adapter import BaseRobotAdapter, RobotState, MotionTarget

logger = logging.getLogger(__name__)

try:
    from xarm.wrapper import XArmAPI
    XARM_SDK_AVAILABLE = True
except ImportError:
    XARM_SDK_AVAILABLE = False
    logger.warning('xArm-Python-SDK not installed: pip install xArm-Python-SDK')


class XArmAdapter(BaseRobotAdapter):
    """
    UFACTORY xArm / Lite 6 adapter.

    Config example (robot_driver.yaml):
      brand:     xarm
      robot_ip:  192.168.1.200
      robot_port: 18333          # xArm SDK default
      dof:       6
      max_speed_mm_s: 200
      max_acc_mm_s2:  2000
    """

    def __init__(self, ip: str, port: int = 18333, dof: int = 6,
                 max_speed: float = 200.0, max_acc: float = 2000.0):
        super().__init__(ip, port, dof)
        self._arm = None
        self._max_speed = max_speed    # mm/s
        self._max_acc   = max_acc      # mm/s²

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def connect(self) -> bool:
        if not XARM_SDK_AVAILABLE:
            logger.error('xArm SDK not installed')
            return False
        try:
            self._arm = XArmAPI(self.ip, baud_checkset=False)
            self._arm.motion_enable(enable=True)
            self._arm.set_mode(0)       # position mode
            self._arm.set_state(0)      # sport state
            self._connected = True
            logger.info(f'xArm connected: {self.ip}  firmware={self._arm.version}')
            return True
        except Exception as e:
            logger.error(f'xArm connect failed: {e}')
            return False

    def disconnect(self):
        if self._arm:
            try:
                self._arm.disconnect()
            except Exception:
                pass
        self._connected = False

    # ── State ─────────────────────────────────────────────────────────────────

    def get_state(self) -> RobotState:
        s = RobotState()
        if not self._arm:
            return s
        try:
            code, joints = self._arm.get_servo_angle(is_radian=True)
            if code == 0:
                s.joint_positions = list(joints[:self.dof])

            code, pose = self._arm.get_position(is_radian=True)
            if code == 0:
                # xArm returns [x,y,z mm, roll,pitch,yaw rad]
                s.tcp_pose = [
                    self.mm_to_m(pose[0]), self.mm_to_m(pose[1]), self.mm_to_m(pose[2]),
                    pose[3], pose[4], pose[5],
                ]

            state = self._arm.get_state()[1]
            s.is_moving  = state == 1
            s.is_enabled = self._arm.get_is_moving() is not None
            err = self._arm.get_err_warn_code()[1]
            s.error_code    = err[0] if err else 0
            s.error_message = f'xArm error {s.error_code}' if s.error_code else ''
            s.mode = 'error' if s.error_code else ('moving' if s.is_moving else 'idle')
        except Exception as e:
            logger.warning(f'get_state error: {e}')
        return s

    # ── Motion ────────────────────────────────────────────────────────────────

    def move_to(self, target: MotionTarget) -> bool:
        if not self._arm:
            return False
        speed = max(1.0, self._max_speed * target.speed_scale)
        acc   = max(1.0, self._max_acc   * target.acceleration)
        try:
            if target.tcp_pose is not None:
                p = target.tcp_pose
                code = self._arm.set_position(
                    x=self.m_to_mm(p[0]), y=self.m_to_mm(p[1]), z=self.m_to_mm(p[2]),
                    roll=p[3], pitch=p[4], yaw=p[5],
                    speed=speed, mvacc=acc, is_radian=True,
                    wait=target.blocking)
            elif target.joint_positions is not None:
                code = self._arm.set_servo_angle(
                    angle=self.rad_to_deg(target.joint_positions),
                    speed=30.0 * target.speed_scale,
                    mvacc=300.0 * target.acceleration,
                    wait=target.blocking)
            else:
                return False
            return code == 0
        except Exception as e:
            logger.error(f'move_to failed: {e}')
            return False

    def stop(self):
        if self._arm:
            self._arm.emergency_stop()
            self._arm.set_state(0)

    def estop(self):
        if self._arm:
            self._arm.emergency_stop()

    def clear_error(self) -> bool:
        if not self._arm:
            return False
        self._arm.clean_error()
        self._arm.clean_warn()
        self._arm.motion_enable(enable=True)
        self._arm.set_mode(0)
        self._arm.set_state(0)
        return True

    def enable(self) -> bool:
        if not self._arm:
            return False
        self._arm.motion_enable(enable=True)
        self._arm.set_state(0)
        return True

    def disable(self):
        if self._arm:
            self._arm.motion_enable(enable=False)
