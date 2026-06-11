"""MoveIt2 bridge skeleton.

Returns graceful fallbacks until a URDF is dropped at
/opt/cobot/models/estun_s10_140.urdf and the MoveIt2 config has been
generated via ``setup_moveit_config.sh``.
"""
from __future__ import annotations

import logging
import os
from typing import List, Optional, Tuple

import numpy as np

from . import kinematics_helper
from .profile_manager import Profile

logger = logging.getLogger(__name__)


MOVEIT_CONFIG_ROOT = '/opt/cobot/moveit_config'
URDF_PATH = kinematics_helper.URDF_PATH
SRDF_PATH = os.path.join(MOVEIT_CONFIG_ROOT, 'config', 'estun_s10_140.srdf')
KINEMATICS_YAML = os.path.join(MOVEIT_CONFIG_ROOT, 'config', 'kinematics.yaml')


class MoveItBridge:
    def __init__(self):
        self._available = self._probe()

    def _probe(self) -> bool:
        if not os.path.isfile(URDF_PATH):
            return False
        if not os.path.isfile(SRDF_PATH):
            return False
        try:
            import moveit_commander  # noqa: F401
            return True
        except Exception:
            return False

    def is_available(self) -> bool:
        return self._available

    def refresh(self) -> bool:
        self._available = self._probe()
        return self._available

    def status(self) -> dict:
        return {
            'available': self._available,
            'urdf_path': URDF_PATH,
            'urdf_exists': os.path.isfile(URDF_PATH),
            'srdf_path': SRDF_PATH,
            'srdf_exists': os.path.isfile(SRDF_PATH),
            'kinematics_yaml_exists': os.path.isfile(KINEMATICS_YAML),
            'config_root': MOVEIT_CONFIG_ROOT,
            'config_valid': self._available,
            'default_planner': 'RRTConnect',
            'collision_scene_active': False,
        }

    def plan_collision_free_path(self,
                                 start_rad: List[float],
                                 goal_rad: List[float],
                                 profile: Profile
                                 ) -> List[List[float]]:
        """Plan a path between two joint configurations.

        Without MoveIt2: returns ``[start, goal]`` (no planning).
        With MoveIt2: would invoke OMPL RRTConnect by default.
        """
        if not self._available:
            return [list(start_rad), list(goal_rad)]
        # TODO: real MoveIt2 invocation once URDF arrives
        logger.info('MoveIt2 path planning placeholder (using straight line)')
        return [list(start_rad), list(goal_rad)]

    def optimize_path_chomp(self,
                            path_rad: List[List[float]],
                            profile: Profile
                            ) -> List[List[float]]:
        if not self._available:
            return list(path_rad)
        # TODO: invoke CHOMP optimizer
        return list(path_rad)

    def optimize_path_stomp(self,
                            path_rad: List[List[float]],
                            profile: Profile
                            ) -> List[List[float]]:
        if not self._available:
            return list(path_rad)
        # TODO: invoke STOMP optimizer
        return list(path_rad)

    def set_collision_scene_from_nvblox(self, mesh_msg) -> bool:
        if not self._available:
            return False
        # TODO: convert mesh → CollisionObject(s) → PlanningScene
        return False
