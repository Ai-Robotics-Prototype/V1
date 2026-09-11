"""Codegen tests for the per-program payload header emission.

The Estun controller has no wire-proven `setPayload(...)` verb (see
the protocol check: setPayload appears only as a reserved word in
the syntax highlighter and as a factory-UI menu label; luaenginelib.
json has zero payload/mass/load call signatures). So the codegen
MUST NOT emit any wire-invented verb; it writes the operator-authored
payload into the Lua header as informational metadata. These tests
lock that behavior in — a future refactor that accidentally emits
setPayload will fail here.
"""

from __future__ import annotations

import pytest

from estun_driver.program_ops import codegen_lua_from_program


def _prog(**config):
    return {
        'id': 't',
        'name': 't',
        'config': dict(config),
        'steps': [{'action': 'move', 'taught_joints': [0, 0, 0, 0, 0, 0]}],
        'points': {},
    }


# ── never emit setPayload — the wire-proven rule ────────────────

def test_never_emits_setpayload_call_even_when_set():
    lua, _, _ = codegen_lua_from_program(
        _prog(payload_kg=1.2, tool_name='vac'),
        operator_speed_limit_pct=65)
    assert 'setPayload(' not in lua, \
        "setPayload verb has no wire proof — never emit it as a call"
    assert 'SetPayload(' not in lua


def test_never_emits_setpayload_call_when_unset():
    lua, _, _ = codegen_lua_from_program(_prog(), operator_speed_limit_pct=65)
    assert 'setPayload(' not in lua
    assert 'SetPayload(' not in lua


# ── unset path ──────────────────────────────────────────────────

def test_unset_payload_records_warning_note():
    lua, _, _ = codegen_lua_from_program(_prog(), operator_speed_limit_pct=65)
    assert '-- payload: UNSET' in lua
    assert 'reduced' in lua


def test_null_and_empty_string_treated_as_unset():
    for cfg in [{'payload_kg': None}, {'payload_kg': ''}]:
        lua, _, _ = codegen_lua_from_program(_prog(**cfg),
                                             operator_speed_limit_pct=65)
        assert '-- payload: UNSET' in lua


def test_zero_or_negative_kg_treated_as_unset():
    for kg in [0, -1.0]:
        lua, _, _ = codegen_lua_from_program(_prog(payload_kg=kg),
                                             operator_speed_limit_pct=65)
        assert '-- payload: UNSET' in lua, f'kg={kg!r} should count as unset'


def test_non_numeric_kg_treated_as_unset():
    lua, _, _ = codegen_lua_from_program(_prog(payload_kg='foo'),
                                         operator_speed_limit_pct=65)
    assert '-- payload: UNSET' in lua


# ── set path ────────────────────────────────────────────────────

def test_kg_alone_emits_header():
    lua, _, _ = codegen_lua_from_program(_prog(payload_kg=1.2),
                                         operator_speed_limit_pct=65)
    assert '-- payload: 1.2 kg' in lua
    assert 'info only' in lua
    assert 'PayloadId preset' in lua


def test_kg_plus_tool_name_appears_together():
    lua, _, _ = codegen_lua_from_program(
        _prog(payload_kg=3.5, tool_name='vacuum tool'),
        operator_speed_limit_pct=65)
    assert '-- payload: 3.5 kg (vacuum tool)' in lua


def test_cog_emitted_when_present():
    lua, _, _ = codegen_lua_from_program(
        _prog(payload_kg=1.2, payload_cog_mm={'x': 0, 'y': 5, 'z': 45}),
        operator_speed_limit_pct=65)
    assert 'payload CoG (mm from flange): x=0 y=5 z=45' in lua


def test_cog_missing_axes_use_question_mark():
    lua, _, _ = codegen_lua_from_program(
        _prog(payload_kg=1.2, payload_cog_mm={'z': 45}),
        operator_speed_limit_pct=65)
    assert 'payload CoG (mm from flange): x=? y=? z=45' in lua


def test_cog_ignored_when_payload_unset():
    lua, _, _ = codegen_lua_from_program(
        _prog(payload_cog_mm={'x': 1, 'y': 2, 'z': 3}),
        operator_speed_limit_pct=65)
    assert 'payload CoG' not in lua, \
        'CoG without a payload_kg should not appear standalone'


# ── integer kg formatted cleanly ────────────────────────────────

def test_integer_kg_prints_without_trailing_zero():
    lua, _, _ = codegen_lua_from_program(_prog(payload_kg=5),
                                         operator_speed_limit_pct=65)
    assert '-- payload: 5 kg' in lua


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
