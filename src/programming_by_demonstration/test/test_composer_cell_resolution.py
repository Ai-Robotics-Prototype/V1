"""Audit #6 (2026-10-09): PBD composer resolves gripper IO from the
cell record, never emits DO0/DO1/DI0/DI1 placeholders.
"""
from __future__ import annotations

from programming_by_demonstration.program_composer import (
    _grip_open, _grip_close, _grip_release, compose_program_draft,
    _finger_close_confirm_di, _finger_open_confirm_di,
)
from programming_by_demonstration.schema import StructuredIntent


EOAT_CTX = {
    'id': 'eoat_a', 'name': 'Finger Gripper',
    'valve_do': 'DO5',
    'inputs': [
        {'raw': 'DI7', 'synapse': 'IN07', 'label': 'close/clamp sensor'},
        {'raw': 'DI8', 'synapse': 'IN08', 'label': 'open/release sensor'},
    ],
    'outputs': [],
}


# ─────────────────────────────────────────────────────────────
# Grip helpers never emit the pre-fix placeholders
# ─────────────────────────────────────────────────────────────

def test_grip_open_without_ctx_emits_no_port_fields():
    """Pre-fix shape (hardcoded DO1/DI1) must NEVER resurface. When
    no cell binding resolves, the step carries no io_* fields so the
    backend codegen's REFUSED path surfaces 'has no valve assigned'
    instead of firing DO0/DO1 on metal."""
    step = _grip_open(50)
    assert step['action'] == 'open_gripper'
    assert 'io_open' not in step
    assert 'io_open_confirm' not in step


def test_grip_close_without_ctx_emits_no_port_fields():
    step = _grip_close()
    assert step['action'] == 'close_gripper'
    assert 'io_close' not in step
    assert 'io_close_confirm' not in step


def test_grip_release_without_ctx_emits_no_port_fields():
    step = _grip_release()
    assert step['action'] == 'open_gripper'
    assert 'io_open' not in step


def test_grip_open_with_ctx_emits_resolved_ports():
    step = _grip_open(50, EOAT_CTX)
    assert step['io_open']         == 'DO5'
    assert step['io_open_confirm'] == 'DI8'   # "open" sensor


def test_grip_close_with_ctx_emits_resolved_ports():
    step = _grip_close(EOAT_CTX)
    assert step['io_close']         == 'DO5'
    assert step['io_close_confirm'] == 'DI7'  # "close/clamp" sensor


def test_grip_release_with_ctx_emits_resolved_valve():
    step = _grip_release(EOAT_CTX)
    assert step['io_open'] == 'DO5'


# ─────────────────────────────────────────────────────────────
# No placeholder DO0 / DO1 / DI0 / DI1 anywhere in the module
# ─────────────────────────────────────────────────────────────

def test_grip_helpers_do_not_emit_pre_fix_placeholders():
    """Audit #6 anti-recurrence pin: scan every emission path for
    DO0 / DO1 / DI0 / DI1 — the placeholders that fired the wrong
    valve on metal before the resolver landed. Both ctx branches
    checked; both must stay placeholder-free.
    """
    for step in (_grip_open(50), _grip_open(50, EOAT_CTX),
                 _grip_close(), _grip_close(EOAT_CTX),
                 _grip_release(), _grip_release(EOAT_CTX)):
        for v in step.values():
            if isinstance(v, str):
                assert v not in ('DO0', 'DO1', 'DI0', 'DI1'), (
                    f'pre-fix placeholder resurfaced: {step!r}')


# ─────────────────────────────────────────────────────────────
# Sensor label matching
# ─────────────────────────────────────────────────────────────

def test_finger_close_confirm_picks_close_labeled_input():
    assert _finger_close_confirm_di(EOAT_CTX) == 'DI7'


def test_finger_open_confirm_picks_open_labeled_input():
    assert _finger_open_confirm_di(EOAT_CTX) == 'DI8'


def test_finger_confirm_without_inputs_returns_none():
    ctx = {'valve_do': 'DO5', 'inputs': []}
    assert _finger_close_confirm_di(ctx) is None
    assert _finger_open_confirm_di(ctx) is None


# ─────────────────────────────────────────────────────────────
# compose_program_draft threads cell binding end-to-end
# ─────────────────────────────────────────────────────────────

def test_compose_auto_binds_single_eoat_cell():
    """When the cell has exactly one resolvable EOAT and the caller
    passes no cell_eoat_id, the composer auto-binds — matches the
    frontend wizard's single-EOAT auto-pick behaviour.
    """
    intent = StructuredIntent.from_dict({
        'operations': [{
            'operation_type': 'pick_and_place',
            'effector': 'finger',
            'pick':  {'location_hint': 'A'},
            'place': {'location_hint': 'B'},
        }],
        'confidence_overall': 0.9,
    })
    cell = {
        'eoats': [{
            'id': 'eoat_only', 'name': 'The Finger',
            'actuators': [{'valve': 'V06'}],
            'inputs': [{'port': 'IN03', 'label': 'close sensor'}],
        }],
        'fixtures': [],
    }
    draft = compose_program_draft(
        intent, demo_id='demo_x', cell=cell)
    cfg = draft.config
    assert cfg.get('cell_eoat_id') == 'eoat_only', (
        'single-EOAT auto-bind must stamp config.cell_eoat_id so '
        'downstream codegen resolves against the same tool')
    # Any gripper step in the draft must carry the resolved port.
    grips = [s for s in draft.steps
             if s.get('action') in ('open_gripper', 'close_gripper')]
    assert grips, 'intent produced no gripper steps — regression?'
    for s in grips:
        for k in ('io_open', 'io_close'):
            if k in s:
                assert s[k] == 'DO6', (
                    f'composer must emit resolved valve DO6 on {k}, '
                    f'got {s[k]!r}')


def test_compose_without_cell_leaves_grips_resolver_bound_but_placeholder_free():
    """No cell + no cell_eoat_id → the composer still runs, grip
    steps carry no io_* fields, and the backend codegen's REFUSED
    path (surfaced as 'has no valve assigned') is the operator-
    actionable gate."""
    intent = StructuredIntent.from_dict({
        'operations': [{
            'operation_type': 'pick_and_place',
            'effector': 'finger',
            'pick':  {'location_hint': 'A'},
            'place': {'location_hint': 'B'},
        }],
        'confidence_overall': 0.9,
    })
    draft = compose_program_draft(intent, demo_id='demo_x',
                                  cell={'eoats': [], 'fixtures': []})
    cfg = draft.config
    assert 'cell_eoat_id' not in cfg
    for s in draft.steps:
        if s.get('action') in ('open_gripper', 'close_gripper'):
            # Must NOT carry the pre-fix placeholders.
            for k in ('io_open', 'io_close'):
                assert s.get(k) not in ('DO0', 'DO1')
