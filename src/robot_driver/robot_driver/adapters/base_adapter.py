"""
Abstract base class for robot brand adapters.

To add a new brand:
  1. Create src/robot_driver/robot_driver/adapters/mybrand_adapter.py
  2. Subclass BaseRobotAdapter and implement every abstract method
  3. Add the brand name to ADAPTER_REGISTRY in __init__.py
  4. Set `brand: mybrand` in config/robot_driver.yaml
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
import math


@dataclass
class RobotState:
    """Normalised robot state — same structure regardless of brand."""
    joint_positions: List[float] = field(default_factory=lambda: [0.0] * 6)
    joint_velocities: List[float] = field(default_factory=lambda: [0.0] * 6)
    joint_efforts: List[float] = field(default_factory=lambda: [0.0] * 6)
    tcp_pose: List[float] = field(default_factory=lambda: [0.0] * 6)
    # tcp_pose: [x, y, z, rx, ry, rz] in metres and radians

    is_moving: bool = False
    is_enabled: bool = False
    error_code: int = 0
    error_message: str = ''
    mode: str = 'idle'          # idle | moving | error | estop


@dataclass
class MotionTarget:
    """Normalised motion command — same structure regardless of brand."""
    # Set EITHER pose XOR joints (not both)
    tcp_pose: Optional[List[float]] = None
    # [x_m, y_m, z_m, rx_rad, ry_rad, rz_rad]

    joint_positions: Optional[List[float]] = None
    # [j1..j6] radians

    speed_scale: float = 1.0      # 0.0–1.0  (applied on top of max_velocity)
    acceleration: float = 0.5     # 0.0–1.0  fraction of max
    blend_radius: float = 0.0     # metres — for move blending / via-points
    blocking: bool = False        # wait for motion complete before returning


class BaseRobotAdapter(ABC):
    """
    Brand-agnostic robot adapter interface.

    The robot_driver_node calls these methods only.
    All brand-specific TCP/IP framing lives inside the subclass.
    """

    def __init__(self, ip: str, port: int, dof: int = 6):
        self.ip   = ip
        self.port = port
        self.dof  = dof
        self._connected = False

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    @abstractmethod
    def connect(self) -> bool:
        """Open TCP connection. Return True on success."""

    @abstractmethod
    def disconnect(self):
        """Close TCP connection cleanly."""

    @property
    def connected(self) -> bool:
        return self._connected

    # ── State ─────────────────────────────────────────────────────────────────

    @abstractmethod
    def get_state(self) -> RobotState:
        """Read current robot state. Called at ~50 Hz by the driver node."""

    # ── Motion ────────────────────────────────────────────────────────────────

    @abstractmethod
    def move_to(self, target: MotionTarget) -> bool:
        """
        Send a motion command.
        Return True if the command was accepted (not necessarily completed).
        """

    @abstractmethod
    def stop(self):
        """Immediately decelerate to zero. Do NOT cut servo power."""

    @abstractmethod
    def estop(self):
        """Emergency stop — may cut servo power depending on brand."""

    @abstractmethod
    def clear_error(self) -> bool:
        """Attempt to clear fault state. Return True if cleared."""

    # ── Enable / disable servos ───────────────────────────────────────────────

    @abstractmethod
    def enable(self) -> bool:
        """Enable servo power. Return True on success."""

    @abstractmethod
    def disable(self):
        """Disable servo power."""

    # ── Helpers (shared, not brand-specific) ─────────────────────────────────

    @staticmethod
    def deg_to_rad(deg_list: List[float]) -> List[float]:
        return [math.radians(d) for d in deg_list]

    @staticmethod
    def rad_to_deg(rad_list: List[float]) -> List[float]:
        return [math.degrees(r) for r in rad_list]

    @staticmethod
    def mm_to_m(val: float) -> float:
        return val / 1000.0

    @staticmethod
    def m_to_mm(val: float) -> float:
        return val * 1000.0
