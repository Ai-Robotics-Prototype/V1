"""Pinned tests for the 2026-08-05 recovery event journal.

Directive item 5: "Log every recovery to the learning record
(condition, joint, angles, operator action) — commissioning-wizard
source material."

The dashboard writes past_escape_only True↔False transitions to
/opt/cobot/logs/recovery_events.jsonl. This test slices the writer
out of dashboard_server.py without importing the full server
(which pulls in FastAPI + ROS).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


def _load_writer():
    """Slice the writer + its dependencies from dashboard_server.py.
    The writer sits above the class boundary specifically so this
    hermetic pattern works (see also test_jog_stop_operator_copy.py)."""
    src_path = os.path.join(SERVER_DIR, 'dashboard_server.py')
    with open(src_path) as fh:
        src = fh.read()
    cut = src.find('class DashboardServer')
    assert cut > 0
    prelude = src[:cut]
    marker = 'def _write_recovery_events_from_jl'
    idx = prelude.find(marker)
    assert idx > 0, 'writer function not found — has it moved?'
    banner_idx = prelude.find('_RECOVERY_EVENTS_PATH')
    assert banner_idx >= 0
    # Grab from the path constant through the class boundary.
    slice_src = prelude[banner_idx:]
    # The slice references `time`, `os`, `json` — import them into the
    # namespace so exec doesn't NameError.
    ns: dict = {
        'time': __import__('time'),
        'os': __import__('os'),
        'json': __import__('json'),
    }
    exec(slice_src, ns)
    return ns


def _joint_snapshot(j6_past=True, j6_current=-193.31):
    return [
        {'joint': 1, 'past_escape_only': False, 'current_deg': 0.0,
         'limit_deg': 200.0, 'escape_only_edge_deg': 188.0, 'headroom_deg': 200.0},
        {'joint': 2, 'past_escape_only': False, 'current_deg': 0.0,
         'limit_deg': 200.0, 'escape_only_edge_deg': 188.0, 'headroom_deg': 200.0},
        {'joint': 3, 'past_escape_only': False, 'current_deg': 0.0,
         'limit_deg': 166.0, 'escape_only_edge_deg': 154.0, 'headroom_deg': 166.0},
        {'joint': 4, 'past_escape_only': False, 'current_deg': 0.0,
         'limit_deg': 200.0, 'escape_only_edge_deg': 188.0, 'headroom_deg': 200.0},
        {'joint': 5, 'past_escape_only': False, 'current_deg': 0.0,
         'limit_deg': 166.0, 'escape_only_edge_deg': 154.0, 'headroom_deg': 166.0},
        {'joint': 6, 'past_escape_only': j6_past, 'current_deg': j6_current,
         'limit_deg': 200.0, 'escape_only_edge_deg': 188.0,
         'headroom_deg': 200.0 - abs(j6_current)},
    ]


def test_entered_transition_writes_a_line(tmp_path):
    ns = _load_writer()
    ns['_RECOVERY_EVENTS_PATH'] = str(tmp_path / 'rec.jsonl')
    prev = _joint_snapshot(j6_past=False, j6_current=-100)
    new  = _joint_snapshot(j6_past=True,  j6_current=-193.31)
    ns['_write_recovery_events_from_jl'](prev, new)
    with open(ns['_RECOVERY_EVENTS_PATH']) as fh:
        lines = [json.loads(ln) for ln in fh]
    assert len(lines) == 1
    e = lines[0]
    assert e['kind'] == 'past_escape_only_entered'
    assert e['joint'] == 6
    assert abs(e['current_deg'] + 193.31) < 1e-6
    assert e['limit_deg'] == 200.0


def test_exited_transition_writes_a_line(tmp_path):
    ns = _load_writer()
    ns['_RECOVERY_EVENTS_PATH'] = str(tmp_path / 'rec.jsonl')
    prev = _joint_snapshot(j6_past=True,  j6_current=-193.31)
    new  = _joint_snapshot(j6_past=False, j6_current=-180.0)
    ns['_write_recovery_events_from_jl'](prev, new)
    with open(ns['_RECOVERY_EVENTS_PATH']) as fh:
        lines = [json.loads(ln) for ln in fh]
    assert len(lines) == 1
    assert lines[0]['kind'] == 'past_escape_only_exited'
    assert lines[0]['joint'] == 6


def test_no_transition_writes_nothing(tmp_path):
    ns = _load_writer()
    ns['_RECOVERY_EVENTS_PATH'] = str(tmp_path / 'rec.jsonl')
    prev = _joint_snapshot(j6_past=True, j6_current=-193.31)
    new  = _joint_snapshot(j6_past=True, j6_current=-192.5)   # still past
    ns['_write_recovery_events_from_jl'](prev, new)
    assert not os.path.exists(ns['_RECOVERY_EVENTS_PATH'])


def test_writer_bails_gracefully_on_bad_paths(tmp_path):
    """A read-only path must not raise — the safety action already
    happened at the driver side. Silently swallow so the state
    pipeline stays alive."""
    ns = _load_writer()
    # A path in /proc/self/... is not writable — write attempts fail.
    ns['_RECOVERY_EVENTS_PATH'] = '/proc/self/nowhere.jsonl'
    prev = _joint_snapshot(j6_past=False, j6_current=-100)
    new  = _joint_snapshot(j6_past=True,  j6_current=-193.31)
    # Should not raise.
    ns['_write_recovery_events_from_jl'](prev, new)


def test_multi_joint_transitions_write_one_line_each(tmp_path):
    ns = _load_writer()
    ns['_RECOVERY_EVENTS_PATH'] = str(tmp_path / 'rec.jsonl')
    prev = _joint_snapshot(j6_past=False, j6_current=-100)
    new = _joint_snapshot(j6_past=True,  j6_current=-193.31)
    # Also promote J3 past.
    new[2]['past_escape_only'] = True
    new[2]['current_deg'] = 165.0
    ns['_write_recovery_events_from_jl'](prev, new)
    with open(ns['_RECOVERY_EVENTS_PATH']) as fh:
        lines = [json.loads(ln) for ln in fh]
    assert len(lines) == 2
    joints = sorted(e['joint'] for e in lines)
    assert joints == [3, 6]
