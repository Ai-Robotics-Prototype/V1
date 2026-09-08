"""Custom End-of-Arm Tool library backend regression (2026-09-08).

Pins:
  1. STEP upload → cascadio conversion (async) → GLB on disk
  2. Named refusal on unparseable STEP file: exact operator copy
  3. Empty name / oversize file / wrong suffix all refuse by name
  4. TCP + payload_kg mandatory before confirm_tool
  5. Delete follows .deleted safeguard pattern (matches program
     store, dashboard_server.py:6640)
  6. programs_referencing_tool() scans config.tool_id — powers the
     retro-edit guard modal (directive item 7)

Runs against real cascadio on the Jetson (0 bytes install cost, 78 ms
per 37 KB STEP smoke-test; see item-2 report). Uses a real STEP file
from /opt/cobot/parts/step/ if present, else skips the conversion pin.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import time

import pytest


# Point the library at a scratch dir before importing so its module-
# level TOOLS_DIR resolves correctly for the whole test session.
_SCRATCH = tempfile.mkdtemp(prefix='cobot_tools_test_')
os.environ['COBOT_TOOLS_DIR'] = _SCRATCH

# Local import — repo layout: this file lives in
# src/cobot_dashboard/test/, and the package sits alongside as
# src/cobot_dashboard/cobot_dashboard/. Add the parent to sys.path so
# `import cobot_dashboard.tools_library` succeeds without an install.
import sys
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, '..')))

from cobot_dashboard import tools_library as tl  # noqa: E402


REAL_STEP_SAMPLE = '/opt/cobot/parts/step/BT225L24_a.STEP'


def teardown_module(module):
    shutil.rmtree(_SCRATCH, ignore_errors=True)


def _wait_convert(tool_id: str, timeout_s: float = 15.0) -> dict:
    """Poll the tool_json until conversion.state != converting."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        doc = tl.get_tool(tool_id)
        state = (doc.get('conversion') or {}).get('state')
        if state in ('converted', 'failed'):
            return doc
        time.sleep(0.05)
    raise TimeoutError(f'conversion still {state!r} after {timeout_s}s')


def test_refuse_empty_name():
    with pytest.raises(ValueError, match='name required'):
        tl.create_tool_from_step(name='', step_bytes=b'x',
                                 filename='x.step')


def test_refuse_wrong_suffix():
    with pytest.raises(ValueError) as exc:
        tl.create_tool_from_step(name='n', step_bytes=b'x',
                                 filename='x.stl')
    assert 'STEP file' in str(exc.value)


def test_refuse_oversize():
    huge = b'x' * (tl.MAX_STEP_UPLOAD_BYTES + 1)
    with pytest.raises(ValueError, match='50 MB'):
        tl.create_tool_from_step(name='n', step_bytes=huge,
                                 filename='x.step')


def test_refuse_unparseable_step_bytes():
    """Junk bytes with .step suffix → conversion fails with the
    NAMED refusal, never a Python traceback exposed."""
    tid = tl.create_tool_from_step(
        name='junk', step_bytes=b'this is not a STEP file',
        filename='junk.step')
    doc = _wait_convert(tid)
    assert doc['conversion']['state'] == 'failed'
    assert doc['conversion']['error'] == tl.REFUSE_UNPARSEABLE
    assert 'Traceback' not in (doc['conversion']['error'] or '')


@pytest.mark.skipif(not os.path.isfile(REAL_STEP_SAMPLE),
                    reason='no STEP sample on disk')
def test_real_step_converts_end_to_end():
    with open(REAL_STEP_SAMPLE, 'rb') as fh:
        data = fh.read()
    tid = tl.create_tool_from_step(name='sample', step_bytes=data,
                                   filename='sample.step')
    doc = _wait_convert(tid)
    assert doc['conversion']['state'] == 'converted', \
        f'conversion failed: {doc["conversion"]["error"]!r}'
    assert doc['conversion']['glb_bytes'] > 0
    # GLB actually exists at the expected path.
    mesh_path = tl.get_tool_mesh_path(tid)
    assert os.path.isfile(mesh_path)
    assert os.path.getsize(mesh_path) == doc['conversion']['glb_bytes']


def test_confirm_refuses_without_tcp():
    """directive 3(c): "the robot needs to know where this tool
    works" is the exact operator copy. No skip permitted."""
    tid = tl.create_tool_from_step(
        name='no-tcp', step_bytes=b'x', filename='x.step')
    with pytest.raises(ValueError) as exc:
        tl.confirm_tool(tid)
    assert str(exc.value) == tl.REFUSE_MISSING_TCP
    assert str(exc.value) == 'the robot needs to know where this tool works'


def test_confirm_refuses_without_payload():
    tid = tl.create_tool_from_step(
        name='no-payload', step_bytes=b'x', filename='x.step')
    tl.update_tcp(tid, {'x': 0.05, 'y': 0.0, 'z': 0.12,
                        'rx': 0.0, 'ry': 0.0, 'rz': 0.0})
    with pytest.raises(ValueError) as exc:
        tl.confirm_tool(tid)
    assert str(exc.value) == tl.REFUSE_MISSING_PAYLOAD


def test_confirm_succeeds_with_tcp_and_payload():
    tid = tl.create_tool_from_step(
        name='complete', step_bytes=b'x', filename='x.step')
    tl.update_tcp(tid, {'x': 0.05, 'y': 0.0, 'z': 0.12,
                        'rx': 0.0, 'ry': 0.0, 'rz': 0.0})
    tl.update_payload(tid, 1.5)
    doc = tl.confirm_tool(tid)
    assert doc['confirmed'] is True
    assert doc['payload_kg'] == 1.5


def test_mount_transform_snaps_rotations_to_pi_over_2():
    """directive 3(b): rotation controls limited to 90° steps. The
    coercer snaps any input to the nearest π/2 multiple so
    downstream math treats them as exact."""
    tid = tl.create_tool_from_step(
        name='mt', step_bytes=b'x', filename='x.step')
    tl.update_mount_transform(tid, {
        'tx': 0.010, 'ty': -0.005, 'tz': 0.020,
        'rx': 1.4, 'ry': 3.2, 'rz': 0.05,  # arbitrary rads
    })
    import math
    doc = tl.get_tool(tid)
    mt = doc['mount_transform']
    # rx=1.4 → nearest π/2 multiple is π/2 (1.5708…). ry=3.2 → π.
    # rz=0.05 → 0.
    assert abs(mt['rx'] - math.pi / 2) < 1e-6
    assert abs(mt['ry'] - math.pi) < 1e-6
    assert abs(mt['rz'] - 0.0) < 1e-6
    # Translation kept as-is (no snap).
    assert mt['tx'] == 0.010


def test_delete_follows_deleted_safeguard():
    """directive item 1: delete follows the .deleted safeguard from
    program delete integrity. The tool dir is moved into
    .deleted/<id>.<ts>/ — NOT unlinked — so a wrong tap is
    reversible until the trash cap prunes it."""
    tid = tl.create_tool_from_step(
        name='trash-me', step_bytes=b'x', filename='x.step')
    src = os.path.join(_SCRATCH, tid)
    assert os.path.isdir(src)
    result = tl.delete_tool(tid)
    assert not os.path.isdir(src)
    trashed = result['trashed_to']
    assert trashed.startswith(os.path.join(_SCRATCH, '.deleted'))
    assert os.path.isdir(trashed)
    # Nothing under /opt/cobot was touched (scratch dir isolation).
    assert '/opt/cobot' not in trashed


def test_deleted_tool_hidden_from_list():
    tid = tl.create_tool_from_step(
        name='hidden', step_bytes=b'x', filename='x.step')
    assert any(t['id'] == tid for t in tl.list_tools())
    tl.delete_tool(tid)
    assert not any(t['id'] == tid for t in tl.list_tools())


def test_delete_missing_tool_raises_named():
    with pytest.raises(FileNotFoundError) as exc:
        tl.delete_tool('deadbeef')
    assert str(exc.value) == tl.REFUSE_UNKNOWN_TOOL


def test_programs_referencing_tool_scans_config_tool_id():
    """directive item 7 guard input. Given two programs — one
    referencing this tool, one not — return only the referring one."""
    tid = tl.create_tool_from_step(
        name='referred', step_bytes=b'x', filename='x.step')
    prog_dir = tempfile.mkdtemp(prefix='cobot_prog_test_')
    try:
        # Program A references the tool.
        with open(os.path.join(prog_dir, 'progA.json'), 'w') as fh:
            json.dump({'id': 'progA', 'name': 'A',
                       'config': {'tool_id': tid}}, fh)
        # Program B references a different tool.
        with open(os.path.join(prog_dir, 'progB.json'), 'w') as fh:
            json.dump({'id': 'progB', 'name': 'B',
                       'config': {'tool_id': 'ffffffff'}}, fh)
        # Sidecar files are excluded by suffix.
        with open(os.path.join(prog_dir, 'progA.line_map.json'), 'w') as fh:
            json.dump({'config': {'tool_id': tid}}, fh)
        using = tl.programs_referencing_tool(tid, programs_dir=prog_dir)
        assert len(using) == 1
        assert using[0]['id'] == 'progA'
        assert using[0]['name'] == 'A'
    finally:
        shutil.rmtree(prog_dir, ignore_errors=True)


def test_validate_tool_id_rejects_path_traversal():
    """Regression fence: tool_id is used to build a path, so anything
    non-hex must refuse before it touches the filesystem."""
    for bad in ('../etc', 'abc/def', '..', '.hidden',
                'AB123456', 'z1234567'):
        with pytest.raises(ValueError):
            tl._validate_tool_id(bad)
    tl._validate_tool_id('abcdef12')  # valid — 8-char lowercase hex
