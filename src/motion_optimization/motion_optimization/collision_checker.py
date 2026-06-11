"""Basic collision checking against the nvblox mesh.

This is a stub until MoveIt2 is wired up — full collision checking is
delegated to MoveIt2's PlanningScene once a URDF is available. Until
then ``check_trajectory`` always returns ``(True, [])`` ("no collisions
found, no checks performed") so executor logic stays simple.
"""
from __future__ import annotations

from typing import List, Tuple

import numpy as np


class CollisionChecker:
    def __init__(self):
        self._mesh_active = False
        self._last_mesh_stamp_ns = 0

    def set_mesh_active(self, active: bool, stamp_ns: int = 0) -> None:
        self._mesh_active = bool(active)
        self._last_mesh_stamp_ns = int(stamp_ns)

    def is_active(self) -> bool:
        return self._mesh_active

    def check_trajectory(self,
                         positions_rad: np.ndarray
                         ) -> Tuple[bool, List[str]]:
        """Returns (collision_free, warnings)."""
        if not self._mesh_active:
            return True, ['collision-checker idle (MoveIt2/nvblox not active)']
        # Placeholder: once MoveIt2 is wired in this delegates to the
        # PlanningScene. For now we only flag obvious nans / infs.
        if not np.all(np.isfinite(positions_rad)):
            return False, ['trajectory contains non-finite joint positions']
        return True, []
