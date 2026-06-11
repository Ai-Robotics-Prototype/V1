"""Motion profile CRUD (built-in presets + user-created profiles)."""
from __future__ import annotations

import json
import os
import threading
from copy import deepcopy
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

import yaml

from . import utils


CONFIG_ROOT = '/opt/cobot/motion'
CONFIG_DIR = os.path.join(CONFIG_ROOT, 'config')
ROBOT_LIMITS_PATH = os.path.join(CONFIG_DIR, 'robot_limits.yaml')
CUSTOM_PROFILES_PATH = os.path.join(CONFIG_DIR, 'profiles.json')
SYSTEM_DEFAULT_PATH = os.path.join(CONFIG_DIR, 'system_default.json')

BUILT_IN_NAMES = ('Conservative', 'Balanced', 'Aggressive')


@dataclass
class RobotLimits:
    joint_velocity_limits_dps: List[float] = field(
        default_factory=lambda: [180.0] * 6)
    joint_acceleration_limits_dps2: List[float] = field(
        default_factory=lambda: [400.0] * 6)
    joint_jerk_limits_dps3: List[float] = field(
        default_factory=lambda: [4000.0] * 6)
    tcp_linear_velocity_mps: float = 1.5
    tcp_linear_acceleration_mps2: float = 5.0
    tcp_angular_velocity_dps: float = 180.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> 'RobotLimits':
        kwargs = {k: d[k] for k in d if k in cls.__dataclass_fields__}
        return cls(**kwargs)


@dataclass
class Profile:
    name: str
    description: str = ''
    velocity_scale_pct: float = 70.0
    acceleration_scale_pct: float = 60.0
    jerk_scale_pct: float = 50.0
    blend_radius_mm: float = 15.0
    toppra_enabled: bool = True
    moveit_enabled: bool = False
    smoothing_method: str = 'toppra'
    approach_speed_pct: float = 40.0
    retreat_speed_pct: float = 60.0
    created_by_user: bool = False
    created_at: str = ''

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> 'Profile':
        kwargs = {k: d[k] for k in d if k in cls.__dataclass_fields__}
        return cls(**kwargs)


def _default_package_share() -> str:
    try:
        from ament_index_python.packages import get_package_share_directory
        return get_package_share_directory('motion_optimization')
    except Exception:
        here = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(os.path.dirname(here), 'config')


class ProfileManager:
    """Owns the on-disk store. Thread-safe via a single lock."""

    def __init__(self,
                 builtin_path: Optional[str] = None,
                 robot_limits_path: str = ROBOT_LIMITS_PATH,
                 custom_profiles_path: str = CUSTOM_PROFILES_PATH,
                 system_default_path: str = SYSTEM_DEFAULT_PATH,
                 default_robot_limits_path: Optional[str] = None):
        self._lock = threading.RLock()
        share = _default_package_share()
        self.builtin_path = builtin_path or os.path.join(
            share, 'config', 'default_profiles.yaml')
        self.default_robot_limits_path = default_robot_limits_path or os.path.join(
            share, 'config', 'default_robot_limits.yaml')
        self.robot_limits_path = robot_limits_path
        self.custom_profiles_path = custom_profiles_path
        self.system_default_path = system_default_path

        os.makedirs(CONFIG_DIR, exist_ok=True)

        self._builtins: Dict[str, Profile] = {}
        self._customs: Dict[str, Profile] = {}
        self._limits = RobotLimits()
        self._system_default = 'Balanced'

        self._load_builtins()
        self._load_robot_limits()
        self._load_custom_profiles()
        self._load_system_default()

    def _load_builtins(self) -> None:
        try:
            with open(self.builtin_path, 'r') as fh:
                doc = yaml.safe_load(fh) or {}
        except FileNotFoundError:
            doc = {'profiles': {}}
        out = {}
        for name, body in (doc.get('profiles') or {}).items():
            body = dict(body or {})
            body['name'] = name
            body['created_by_user'] = False
            out[name] = Profile.from_dict(body)
        self._builtins = out

    def _load_robot_limits(self) -> None:
        try:
            with open(self.robot_limits_path, 'r') as fh:
                self._limits = RobotLimits.from_dict(yaml.safe_load(fh) or {})
        except FileNotFoundError:
            try:
                with open(self.default_robot_limits_path, 'r') as fh:
                    self._limits = RobotLimits.from_dict(yaml.safe_load(fh) or {})
            except FileNotFoundError:
                self._limits = RobotLimits()

    def _load_custom_profiles(self) -> None:
        try:
            with open(self.custom_profiles_path, 'r') as fh:
                doc = json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            doc = {}
        out = {}
        for name, body in doc.items():
            body = dict(body)
            body['name'] = name
            body['created_by_user'] = True
            out[name] = Profile.from_dict(body)
        self._customs = out

    def _load_system_default(self) -> None:
        try:
            with open(self.system_default_path, 'r') as fh:
                doc = json.load(fh)
            self._system_default = doc.get('profile', 'Balanced')
        except (FileNotFoundError, json.JSONDecodeError):
            self._system_default = 'Balanced'

    def _persist_customs(self) -> None:
        os.makedirs(os.path.dirname(self.custom_profiles_path), exist_ok=True)
        tmp = self.custom_profiles_path + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump({n: p.to_dict() for n, p in self._customs.items()},
                      fh, indent=2)
        os.replace(tmp, self.custom_profiles_path)

    def _persist_limits(self) -> None:
        os.makedirs(os.path.dirname(self.robot_limits_path), exist_ok=True)
        tmp = self.robot_limits_path + '.tmp'
        with open(tmp, 'w') as fh:
            yaml.safe_dump(self._limits.to_dict(), fh)
        os.replace(tmp, self.robot_limits_path)

    def _persist_system_default(self) -> None:
        os.makedirs(os.path.dirname(self.system_default_path), exist_ok=True)
        tmp = self.system_default_path + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump({'profile': self._system_default}, fh, indent=2)
        os.replace(tmp, self.system_default_path)

    def list_profiles(self) -> List[Profile]:
        with self._lock:
            return list(self._builtins.values()) + list(self._customs.values())

    def get_profile(self, name: str) -> Profile:
        with self._lock:
            if name in self._builtins:
                return deepcopy(self._builtins[name])
            if name in self._customs:
                return deepcopy(self._customs[name])
            raise KeyError(f'Unknown motion profile: {name}')

    def has_profile(self, name: str) -> bool:
        with self._lock:
            return name in self._builtins or name in self._customs

    def is_builtin(self, name: str) -> bool:
        return name in self._builtins

    def create_profile(self, profile: Profile, overwrite: bool = False) -> Profile:
        if not profile.name:
            raise ValueError('profile.name is required')
        if profile.name in BUILT_IN_NAMES:
            raise PermissionError(
                f'"{profile.name}" is a built-in profile and cannot be overwritten. '
                'Duplicate it under a new name to customize.')
        with self._lock:
            if (not overwrite) and profile.name in self._customs:
                raise FileExistsError(
                    f'Profile "{profile.name}" already exists. Use overwrite=True.')
            profile.created_by_user = True
            if not profile.created_at:
                profile.created_at = utils.iso_now()
            self._validate_profile(profile)
            self._customs[profile.name] = profile
            self._persist_customs()
            return deepcopy(profile)

    def update_profile(self, name: str, profile: Profile) -> Profile:
        if name in BUILT_IN_NAMES:
            raise PermissionError(
                f'Built-in profile "{name}" cannot be modified.')
        with self._lock:
            if name not in self._customs:
                raise KeyError(f'No custom profile named "{name}"')
            profile.name = name
            profile.created_by_user = True
            if not profile.created_at:
                profile.created_at = self._customs[name].created_at or utils.iso_now()
            self._validate_profile(profile)
            self._customs[name] = profile
            self._persist_customs()
            return deepcopy(profile)

    def delete_profile(self, name: str) -> None:
        if name in BUILT_IN_NAMES:
            raise PermissionError(
                f'Built-in profile "{name}" cannot be deleted.')
        with self._lock:
            if name not in self._customs:
                raise KeyError(f'No custom profile named "{name}"')
            del self._customs[name]
            self._persist_customs()
            if self._system_default == name:
                self._system_default = 'Balanced'
                self._persist_system_default()

    def duplicate_profile(self, name: str, new_name: str) -> Profile:
        src = self.get_profile(name)
        clone = Profile.from_dict(src.to_dict())
        clone.name = new_name
        clone.description = f'Copy of {name}: {src.description}'.strip()
        clone.created_by_user = True
        clone.created_at = utils.iso_now()
        return self.create_profile(clone)

    def get_robot_limits(self) -> RobotLimits:
        with self._lock:
            return deepcopy(self._limits)

    def set_robot_limits(self, limits: RobotLimits) -> RobotLimits:
        with self._lock:
            self._limits = limits
            self._persist_limits()
            return deepcopy(self._limits)

    def reset_robot_limits(self) -> RobotLimits:
        with open(self.default_robot_limits_path, 'r') as fh:
            doc = yaml.safe_load(fh) or {}
        return self.set_robot_limits(RobotLimits.from_dict(doc))

    def get_system_default(self) -> str:
        with self._lock:
            return self._system_default

    def set_system_default(self, name: str) -> str:
        with self._lock:
            if not self.has_profile(name):
                raise KeyError(f'Unknown profile "{name}"')
            self._system_default = name
            self._persist_system_default()
            return name

    @staticmethod
    def _validate_profile(p: Profile) -> None:
        for fname in ('velocity_scale_pct', 'acceleration_scale_pct',
                      'jerk_scale_pct', 'approach_speed_pct',
                      'retreat_speed_pct'):
            v = getattr(p, fname)
            if v is None or v < 0 or v > 100:
                raise ValueError(
                    f'{fname} must be in [0, 100], got {v!r}')
        if p.blend_radius_mm < 0 or p.blend_radius_mm > 200:
            raise ValueError(
                f'blend_radius_mm must be in [0, 200], got {p.blend_radius_mm}')
        if p.smoothing_method not in ('none', 'spline', 'toppra', 'moveit'):
            raise ValueError(
                f'smoothing_method must be one of none/spline/toppra/moveit, '
                f'got {p.smoothing_method!r}')
