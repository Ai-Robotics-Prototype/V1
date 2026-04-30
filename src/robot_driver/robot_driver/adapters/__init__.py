"""
Brand adapter registry.
Add new brands here — the robot_driver_node selects by the `brand` parameter.
"""

from .base_adapter import BaseRobotAdapter, RobotState, MotionTarget
from .xarm_adapter    import XArmAdapter
from .jaka_adapter    import JAKAAdapter
from .dobot_adapter   import DobotAdapter
from .generic_adapter import GenericAdapter

ADAPTER_REGISTRY: dict = {
    'xarm':     XArmAdapter,
    'ufactory': XArmAdapter,
    'jaka':     JAKAAdapter,
    'dobot':    DobotAdapter,
    'cr':       DobotAdapter,
    'generic':  GenericAdapter,
    'fairino':  GenericAdapter,
    'elite':    GenericAdapter,
    'rokae':    GenericAdapter,
    'aubo':     GenericAdapter,
    'hans':     GenericAdapter,
    'lebai':    GenericAdapter,
    'fake':     GenericAdapter,
}


def get_adapter(brand: str, ip: str, port: int, dof: int = 6) -> BaseRobotAdapter:
    brand_key = brand.lower().strip()
    cls = ADAPTER_REGISTRY.get(brand_key, GenericAdapter)
    return cls(ip=ip, port=port, dof=dof)
