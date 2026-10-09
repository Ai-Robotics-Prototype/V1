"""cell_resolver — single source of truth for cell_id → raw-port
resolution. These tests pin the resolver's contract so program_ops,
the PBD composer, and the dashboard-server save gate can share one
implementation without re-forking.
"""
from __future__ import annotations

import os
import json
import tempfile

from cobot_dashboard import cell_resolver as cr


# ─────────────────────────────────────────────────────────────
# Synapse → raw translation
# ─────────────────────────────────────────────────────────────

def test_synapse_to_raw_translates_valves_outputs_inputs():
    assert cr.synapse_to_raw('V05')  == 'DO5'
    assert cr.synapse_to_raw('OUT3') == 'DO3'
    assert cr.synapse_to_raw('IN02') == 'DI2'


def test_synapse_to_raw_passes_through_already_raw_ids():
    assert cr.synapse_to_raw('DO12') == 'DO12'
    assert cr.synapse_to_raw('DI1')  == 'DI1'


def test_synapse_to_raw_rejects_junk():
    assert cr.synapse_to_raw(None) is None
    assert cr.synapse_to_raw('') is None
    assert cr.synapse_to_raw('V') is None
    assert cr.synapse_to_raw('garbage') is None


# ─────────────────────────────────────────────────────────────
# EOAT resolution
# ─────────────────────────────────────────────────────────────

def test_resolve_eoat_actuator_valve_wins_over_legacy_field():
    cell = {'eoats': [{
        'id': 'eoat_a', 'name': 'Finger',
        'valve': 'V02',   # legacy
        'actuators': [{'valve': 'V05'}],  # authoritative
    }], 'fixtures': []}
    r = cr.resolve_eoat(cell, 'eoat_a')
    assert r is not None
    assert r['valve_do'] == 'DO5', 'actuators[0].valve must win'


def test_resolve_eoat_falls_back_to_legacy_valve():
    cell = {'eoats': [{
        'id': 'eoat_a', 'name': 'Vacuum',
        'valve': 'V03',   # legacy single-valve shape
    }], 'fixtures': []}
    r = cr.resolve_eoat(cell, 'eoat_a')
    assert r is not None
    assert r['valve_do'] == 'DO3'


def test_resolve_eoat_returns_none_when_no_valve():
    """Audit #5: a tool with no valve must NOT resolve — callers
    treat None as the "no valve assigned" refusal trigger."""
    cell = {'eoats': [{'id': 'eoat_a', 'name': 'Half-set-up tool'}],
            'fixtures': []}
    assert cr.resolve_eoat(cell, 'eoat_a') is None


def test_resolve_eoat_returns_none_for_unknown_id():
    cell = {'eoats': [{'id': 'eoat_a', 'name': 'A', 'valve': 'V01'}],
            'fixtures': []}
    assert cr.resolve_eoat(cell, 'nope') is None
    assert cr.resolve_eoat(cell, None) is None


def test_resolve_eoat_picks_up_sensor_inputs():
    cell = {'eoats': [{
        'id': 'eoat_a', 'name': 'Smart Finger',
        'actuators': [{'valve': 'V05'}],
        'inputs': [
            {'port': 'IN07', 'label': 'close/clamp sensor'},
            {'port': 'IN08', 'label': 'open/release sensor'},
        ],
    }], 'fixtures': []}
    r = cr.resolve_eoat(cell, 'eoat_a')
    assert r is not None
    assert r['valve_do'] == 'DO5'
    assert len(r['inputs']) == 2
    assert r['inputs'][0]['raw'] == 'DI7'
    assert r['inputs'][1]['raw'] == 'DI8'


# ─────────────────────────────────────────────────────────────
# Fixture resolution
# ─────────────────────────────────────────────────────────────

def test_resolve_fixture_air_requires_valve():
    cell = {'eoats': [], 'fixtures': [{
        'id': 'fx_a', 'name': 'Vice 1',
        'power_mode': 'air', 'valve': 'V10',
    }]}
    r = cr.resolve_fixture(cell, 'fx_a')
    assert r is not None
    assert r['valve_do'] == 'DO10'
    assert r['power_mode'] == 'air'


def test_resolve_fixture_air_without_valve_returns_none():
    """Audit #3 companion: air fixture missing its valve → refuse."""
    cell = {'eoats': [], 'fixtures': [{
        'id': 'fx_b', 'name': 'Half Vice',
        'power_mode': 'air',  # no valve
    }]}
    assert cr.resolve_fixture(cell, 'fx_b') is None


def test_resolve_fixture_own_controller_requires_out():
    cell = {'eoats': [], 'fixtures': [{
        'id': 'fx_c', 'name': 'Machine 1',
        'power_mode': 'own_controller', 'out': 'OUT04',
    }]}
    r = cr.resolve_fixture(cell, 'fx_c')
    assert r is not None
    assert r['out_do'] == 'DO4'


def test_resolve_fixture_manual_requires_neither():
    cell = {'eoats': [], 'fixtures': [{
        'id': 'fx_d', 'name': 'Manual Clamp',
        'power_mode': 'manual',
    }]}
    r = cr.resolve_fixture(cell, 'fx_d')
    assert r is not None
    assert r['valve_do'] is None
    assert r['out_do'] is None


def test_resolve_fixture_unknown_id_returns_none():
    cell = {'eoats': [], 'fixtures': []}
    assert cr.resolve_fixture(cell, 'nope') is None
    assert cr.resolve_fixture(cell, None) is None


# ─────────────────────────────────────────────────────────────
# Save-validation helpers (mirror the resolver's "no valve" rule)
# ─────────────────────────────────────────────────────────────

def test_eoat_body_has_valve_actuator_shape():
    assert cr.eoat_body_has_valve({
        'name': 'Finger', 'actuators': [{'valve': 'V02'}]})


def test_eoat_body_has_valve_legacy_shape():
    assert cr.eoat_body_has_valve({'name': 'V', 'valve': 'V03'})


def test_eoat_body_has_valve_rejects_empty():
    """Audit #5 at the save endpoint: no valve → refuse."""
    assert not cr.eoat_body_has_valve({'name': 'X'})
    assert not cr.eoat_body_has_valve({'name': 'X', 'actuators': []})
    assert not cr.eoat_body_has_valve({'name': 'X',
                                       'actuators': [{'type': 'single'}]})


def test_fixture_body_has_actuation_air():
    assert cr.fixture_body_has_actuation({
        'name': 'V1', 'power_mode': 'air', 'valve': 'V08'})
    assert not cr.fixture_body_has_actuation({
        'name': 'V1', 'power_mode': 'air'})


def test_fixture_body_has_actuation_own_controller():
    assert cr.fixture_body_has_actuation({
        'name': 'M1', 'power_mode': 'own_controller', 'out': 'OUT02'})
    assert not cr.fixture_body_has_actuation({
        'name': 'M1', 'power_mode': 'own_controller'})


def test_fixture_body_has_actuation_manual_passes():
    assert cr.fixture_body_has_actuation({
        'name': 'ManualClamp', 'power_mode': 'manual'})


def test_fixture_body_has_actuation_rejects_unknown_power_mode():
    assert not cr.fixture_body_has_actuation({'name': 'Mystery'})


# ─────────────────────────────────────────────────────────────
# load_cell is permissive on broken input
# ─────────────────────────────────────────────────────────────

def test_load_cell_returns_empty_shape_on_missing_file():
    cell = cr.load_cell('/nonexistent/path/cell.json')
    assert cell == {'eoats': [], 'fixtures': []}


def test_load_cell_reads_valid_file():
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json',
                                     delete=False) as fh:
        json.dump({'eoats': [{'id': 'x', 'name': 'A', 'valve': 'V01'}],
                   'fixtures': []}, fh)
        path = fh.name
    try:
        cell = cr.load_cell(path)
        assert cell['eoats'][0]['id'] == 'x'
    finally:
        os.unlink(path)
