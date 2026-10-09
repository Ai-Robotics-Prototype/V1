"""Sensor DI emission — audit #7 (2026-10-09).

A gripper step that carries `io_close_confirm` / `io_open_confirm`
must emit a `waitCondition(getDI(N)==<expect>, timeout_ms)` after the
setDO. A step with NO confirm field emits none (no false wait on
tools without sensors). An unresolvable confirm port emits a plain-
copy REFUSED marker.
"""
from __future__ import annotations

from estun_driver.program_ops import codegen_lua_from_program


HOME_J = [40.0, 30.0, 130.0, 80.0, 90.0, -110.0]


def _program(steps):
    return {
        'id': 'sensor-di',
        'name': 'sensor-di',
        'config': {},
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': list(HOME_J), 'taught': True},
            *steps,
        ],
        'points': {},
    }


def _codegen(prog):
    lua, _points, _pct = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)
    return lua


def test_close_gripper_with_confirm_emits_waitCondition():
    """Audit #7 head: close_gripper with io_close_confirm='DI7' must
    emit setDO + waitCondition(getDI(7)==1,…) — the sensor DI isn't
    dead wire any more."""
    prog = _program([{
        'id': 2, 'action': 'close_gripper',
        'io_close': 'DO5', 'io_close_confirm': 'DI7',
        'label': 'Clamp',
    }])
    lua = _codegen(prog)
    assert 'setDO(5,1)' in lua
    assert 'waitCondition(getDI(7)==1,' in lua


def test_open_gripper_with_confirm_emits_waitCondition_expect_0():
    """open_gripper waits for getDI==0 (fingers home sensor)."""
    prog = _program([{
        'id': 2, 'action': 'open_gripper',
        'io_open': 'DO5', 'io_open_confirm': 'DI8',
        'label': 'Release',
    }])
    lua = _codegen(prog)
    assert 'setDO(5,0)' in lua
    assert 'waitCondition(getDI(8)==0,' in lua


def test_close_gripper_WITHOUT_confirm_emits_no_wait():
    """A tool with no sensor configured must not emit a false
    waitCondition — the operator didn't buy a sensor; the Lua
    shouldn't block forever on one."""
    prog = _program([{
        'id': 2, 'action': 'close_gripper',
        'io_close': 'DO5',
        'label': 'Clamp',
    }])
    lua = _codegen(prog)
    assert 'setDO(5,1)' in lua
    # No waitCondition emitted for the gripper step.
    assert all(('waitCondition' not in L
                or 'getDI(7)' not in L
                and 'getDI(0)' not in L)
               for L in lua.splitlines())


def test_sensor_confirm_timeout_override_honoured():
    prog = _program([{
        'id': 2, 'action': 'close_gripper',
        'io_close': 'DO5', 'io_close_confirm': 'DI7',
        'io_confirm_timeout_ms': 1200,
    }])
    lua = _codegen(prog)
    assert 'waitCondition(getDI(7)==1,1200)' in lua


def test_sensor_id_not_DIn_emits_REFUSED_marker():
    """An operator-authored step with io_close_confirm='V04' (a valve
    id by mistake) must not silently drop the check — surface a
    plain-copy REFUSED marker so the operator fixes it in EOAT Setup.
    """
    prog = _program([{
        'id': 2, 'action': 'close_gripper',
        'io_close': 'DO5', 'io_close_confirm': 'V04',
    }])
    lua = _codegen(prog)
    assert "-- REFUSED 'close_gripper' sensor" in lua
    assert "DI<n>" in lua


def test_sensor_di_port_out_of_range_emits_REFUSED_marker():
    prog = _program([{
        'id': 2, 'action': 'close_gripper',
        'io_close': 'DO5', 'io_close_confirm': 'DI99',
    }])
    lua = _codegen(prog)
    assert "-- REFUSED 'close_gripper' sensor" in lua
    assert "[1..24]" in lua
