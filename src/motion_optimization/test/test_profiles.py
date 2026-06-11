"""ProfileManager CRUD tests using a temp directory for state."""
from __future__ import annotations

import os

import pytest

from motion_optimization.profile_manager import (
    Profile, ProfileManager, RobotLimits, BUILT_IN_NAMES)


@pytest.fixture()
def manager(tmp_path):
    cfg = tmp_path / 'config'
    cfg.mkdir()
    # Point at the built-in YAML in the source tree.
    builtin = os.path.abspath(os.path.join(
        os.path.dirname(__file__), '..', 'config', 'default_profiles.yaml'))
    default_limits = os.path.abspath(os.path.join(
        os.path.dirname(__file__), '..', 'config', 'default_robot_limits.yaml'))
    return ProfileManager(
        builtin_path=builtin,
        robot_limits_path=str(cfg / 'robot_limits.yaml'),
        custom_profiles_path=str(cfg / 'profiles.json'),
        system_default_path=str(cfg / 'system_default.json'),
        default_robot_limits_path=default_limits,
    )


def test_builtin_profiles_present(manager):
    names = {p.name for p in manager.list_profiles()}
    assert set(BUILT_IN_NAMES).issubset(names)


def test_cannot_overwrite_builtin(manager):
    p = Profile(name='Balanced', velocity_scale_pct=10)
    with pytest.raises(PermissionError):
        manager.create_profile(p)


def test_cannot_delete_builtin(manager):
    with pytest.raises(PermissionError):
        manager.delete_profile('Balanced')


def test_create_and_delete_custom(manager):
    p = Profile(name='Custom1', velocity_scale_pct=80,
                acceleration_scale_pct=70, jerk_scale_pct=60)
    created = manager.create_profile(p)
    assert created.name == 'Custom1'
    assert manager.has_profile('Custom1')
    manager.delete_profile('Custom1')
    assert not manager.has_profile('Custom1')


def test_duplicate_profile(manager):
    clone = manager.duplicate_profile('Balanced', 'BalancedCopy')
    assert clone.name == 'BalancedCopy'
    assert clone.created_by_user is True


def test_validation_rejects_out_of_range(manager):
    p = Profile(name='Bad', velocity_scale_pct=120)
    with pytest.raises(ValueError):
        manager.create_profile(p)


def test_robot_limits_persisted(manager):
    limits = manager.get_robot_limits()
    limits.tcp_linear_velocity_mps = 2.0
    out = manager.set_robot_limits(limits)
    assert out.tcp_linear_velocity_mps == 2.0
    # Re-read from disk
    fresh = ProfileManager(
        robot_limits_path=manager.robot_limits_path,
        custom_profiles_path=manager.custom_profiles_path,
        system_default_path=manager.system_default_path,
        builtin_path=manager.builtin_path,
        default_robot_limits_path=manager.default_robot_limits_path,
    )
    assert fresh.get_robot_limits().tcp_linear_velocity_mps == 2.0


def test_system_default_set_and_get(manager):
    manager.set_system_default('Aggressive')
    assert manager.get_system_default() == 'Aggressive'
    with pytest.raises(KeyError):
        manager.set_system_default('Nope')
