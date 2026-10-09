"""Custom End-of-Arm Tool codegen pin (2026-09-08).

directive item 4: "same program, two tools with different TCPs →
different emitted targets."

The tool-frame emission mechanism is documented in program_ops.py
around the `_emit_tool_var` block:

  * When program.config.tool_id references a tool with tcp_offset,
    the codegen header emits:
        local __tool = toolOffset(getTool(0), {x=…,y=…,z=…,rx=…,ry=…,rz=…})
  * Every mov* verb below carries `tool=__tool` in its options table.
  * Two programs with the same taught_joints but different tool_id
    (different tcp_offset) therefore produce byte-different Lua
    sources: the toolOffset literal differs AND each mov call routes
    through the tool-frame variable.

This is the S-Series tool/coordinate mechanism: `toolOffset(base,
delta)` returns a toolCoor; the mov* verbs accept `tool=<toolCoor>`
to interpret the target in the tool frame. Cited from
luaenginelib.json (`toolOffset` + `getTool` + optional `tool=` on
every mov verb).

Fixture path uses a stub tools_library so the driver-side test can
run WITHOUT the dashboard package installed — the codegen falls back
to reading from cobot_dashboard.tools_library, and the stub replaces
the read function.
"""

from __future__ import annotations

import os
import sys

import pytest

from estun_driver.program_ops import codegen_lua_from_program


def _stub_tools_library(monkeypatch, tools_by_id):
    """Register a fake cobot_dashboard.tools_library that returns
    canned tool docs. Codegen's local import will pick this up."""
    import types
    fake_pkg = types.ModuleType('cobot_dashboard')
    fake_mod = types.ModuleType('cobot_dashboard.tools_library')

    def get_tool(tid):
        if tid not in tools_by_id:
            raise FileNotFoundError(tid)
        return tools_by_id[tid]

    fake_mod.get_tool = get_tool
    fake_pkg.tools_library = fake_mod
    monkeypatch.setitem(sys.modules, 'cobot_dashboard', fake_pkg)
    monkeypatch.setitem(sys.modules,
                        'cobot_dashboard.tools_library', fake_mod)


def _one_step_program(tool_id=None):
    """Minimal single-move program — enough to observe the tool=
    suffix. Two taught joint targets so the codegen emits at least
    one movJ we can inspect."""
    return {
        'id':   'eoat-test',
        'name': 'eoat-test',
        'config': {'speed_pct': 50, **({'tool_id': tool_id} if tool_id else {})},
        'steps': [
            {'id': 1, 'action': 'move_home', 'label': 'Home',
             'taught_joints': [0.0] * 6, 'position_role': 'home',
             'taught_tcp': [0.5, 0.0, 0.6, 0.0, 0.0, 0.0]},
            {'id': 2, 'action': 'move_linear', 'label': 'Pick',
             'taught_joints': [0.5, 0.3, 1.1, 0.8, 1.5, -1.2],
             'position_role': 'pick',
             'taught_tcp': [0.4, 0.1, 0.2, 0.0, 0.0, 0.0]},
        ],
    }


def test_no_tool_id_emits_no_tool_frame_header(monkeypatch):
    """Baseline: without a tool_id, no toolOffset header line and no
    tool= suffix on any mov* — exactly the pre-2026-09-08 emission
    shape. Prevents an accidental universal-emit regression."""
    _stub_tools_library(monkeypatch, {})
    lua, _, _ = codegen_lua_from_program(
        _one_step_program(tool_id=None),
        operator_speed_limit_pct=100)
    assert 'toolOffset(getTool(0)' not in lua
    # And no mov call carries tool= in its options.
    for ln in lua.splitlines():
        if ln.startswith('movJ(') or ln.startswith('movL('):
            assert 'tool=' not in ln, ln


def test_tool_id_emits_toolOffset_header_and_tool_arg(monkeypatch):
    """With tool_id and a non-zero tcp_offset:
       (a) header emits `local __tool = toolOffset(getTool(0), {…})`
       (b) every mov call carries `tool=__tool`."""
    _stub_tools_library(monkeypatch, {
        'aabbccdd': {
            'id':   'aabbccdd',
            'name': 'GripperA',
            'tcp_offset': {'x': 0.05, 'y': 0.00, 'z': 0.120,
                           'rx': 0.0, 'ry': 0.0, 'rz': 0.0},
        }
    })
    lua, _, _ = codegen_lua_from_program(
        _one_step_program(tool_id='aabbccdd'),
        operator_speed_limit_pct=100)
    assert 'local __tool = toolOffset(getTool(0)' in lua
    # tcp is in meters + radians internally → codegen converts to
    # mm + degrees at the emit boundary.
    assert 'x=50.0' in lua and 'y=0.0' in lua and 'z=120.0' in lua
    # rx/ry/rz zero → 0.0 in the emitted table.
    assert 'rx=0.0,ry=0.0,rz=0.0' in lua
    mov_lines = [ln for ln in lua.splitlines()
                 if ln.startswith('movJ(') or ln.startswith('movL(')]
    assert mov_lines, 'no mov* emitted'
    for ln in mov_lines:
        assert 'tool=__tool' in ln, ln


def test_two_tools_different_tcp_produce_different_lua(monkeypatch):
    """Item 4 pin: same program, two tools with different TCPs →
    different emitted targets.
    A byte-diff at the toolOffset literal + at each mov call's
    options table is proof."""
    _stub_tools_library(monkeypatch, {
        'toola111': {
            'id':   'toola111',
            'name': 'GripperShort',
            'tcp_offset': {'x': 0.0, 'y': 0.0, 'z': 0.050,
                           'rx': 0.0, 'ry': 0.0, 'rz': 0.0},
        },
        'toolb222': {
            'id':   'toolb222',
            'name': 'GripperLong',
            'tcp_offset': {'x': 0.0, 'y': 0.0, 'z': 0.200,
                           'rx': 0.0, 'ry': 0.0, 'rz': 0.0},
        }
    })
    prog = _one_step_program(tool_id='toola111')
    lua_a, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)
    prog['config']['tool_id'] = 'toolb222'
    lua_b, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100)

    assert lua_a != lua_b, 'two different TCPs must produce different Lua'
    # Specifically the toolOffset z field differs.
    assert 'z=50.0' in lua_a
    assert 'z=200.0' in lua_b
    # The mov* verbs on both sides still emit tool=__tool — the
    # DIFFERENCE lives in the toolOffset literal, which resolves to
    # different tool-frame targets at the controller.
    for lua in (lua_a, lua_b):
        assert any('tool=__tool' in ln
                   for ln in lua.splitlines()
                   if ln.startswith(('movJ(', 'movL(')))


def test_unresolvable_tool_id_falls_back_to_no_tool_frame(monkeypatch):
    """If the tools_library can't find the tool_id (dashboard didn't
    sync it to the driver, or the tool was deleted after program
    save), codegen falls back to the no-tool-frame shape rather than
    raising. The push-side lint gate is a separate authority; here
    we care that a stale tool_id doesn't brick codegen."""
    _stub_tools_library(monkeypatch, {})  # empty
    lua, _, _ = codegen_lua_from_program(
        _one_step_program(tool_id='ghost'),
        operator_speed_limit_pct=100)
    assert 'toolOffset(getTool(0)' not in lua


def test_lint_gate_stays_green_with_tool_frame_emission(monkeypatch):
    """Regression fence: the tool-frame emission must NOT trip the
    codegen lint gate (memory [[cobot-lua-lint-gate]]: every emit is
    linted against luaenginelib.json, 168 verbs, pre-push refuse).
    `toolOffset` + `getTool` + `movJ`/`movL` with tool= are all in
    the authoritative library — verify the emission passes."""
    _stub_tools_library(monkeypatch, {
        'lint1234': {
            'id':   'lint1234',
            'name': 'LintProbe',
            'tcp_offset': {'x': 0.02, 'y': 0.00, 'z': 0.100,
                           'rx': 0.0, 'ry': 0.0, 'rz': 0.0},
        }
    })
    from estun_driver.program_ops import lint_lua_source
    lua, _, _ = codegen_lua_from_program(
        _one_step_program(tool_id='lint1234'),
        operator_speed_limit_pct=100)
    findings = lint_lua_source(lua)
    # Filter out benign informational findings if the linter emits
    # any — the ONLY thing this test forbids is a hard refusal.
    hard = [f for f in findings
            if str(f.get('severity', 'error')).lower() in ('error',
                                                            'refuse')]
    assert not hard, f'lint refused tool-frame emission: {hard!r}'
