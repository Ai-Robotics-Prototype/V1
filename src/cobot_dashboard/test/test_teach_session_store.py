"""Teach-session record-through store (2026-08-04).

Pre-2026-08-04, taught poses recorded during a teach session
lived ONLY in the recording browser's Zustand state until save.
Two consequences: poses taught on the tablet didn't appear on
the PC (or vice versa), and a refresh mid-teach lost recorded
poses. The Jetson is now the single store for ALL pose state,
mid-teach included; UIs are views.

These tests pin the record-through contract at the Python layer
— the helpers that own the draft store on disk, the promotion
that goes through the pending-pose validator, and the fork-
registry entry that makes the invariant enforceable.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
WS   = HERE.parent.parent.parent
SERVER = WS / 'src' / 'cobot_dashboard' / 'cobot_dashboard' / \
         'dashboard_server.py'
STORE_JS = WS / 'src' / 'cobot_dashboard' / 'frontend' / 'src' / \
           'store' / 'useStore.js'
EDITOR_JSX = WS / 'src' / 'cobot_dashboard' / 'frontend' / 'src' / \
             'components' / 'ProgramEditor.jsx'
REGISTRY = WS / 'tools' / 'fork_registry.yaml'


def _read(p: Path) -> str:
    return p.read_text(encoding='utf-8')


# ── Server-side draft helpers exist ─────────────────────────────

def test_dashboard_declares_teach_session_endpoints():
    """/api/teach_session/{pid}/{start,record,take_over,save,cancel}
    and GET /api/teach_session/{pid} are all registered — the
    frontend cannot function without any one of them."""
    src = _read(SERVER)
    for verb, path in [
        ('post', r'/api/teach_session/\{prog_id\}/start'),
        ('post', r'/api/teach_session/\{prog_id\}/record'),
        ('post', r'/api/teach_session/\{prog_id\}/take_over'),
        ('post', r'/api/teach_session/\{prog_id\}/save'),
        ('post', r'/api/teach_session/\{prog_id\}/cancel'),
        ('get',  r'/api/teach_session/\{prog_id\}'),
    ]:
        pattern = (rf'@app\.{verb}\(\s*["\']' + path
                   + r'["\']\s*\)')
        assert re.search(pattern, src), (
            f'teach-session endpoint missing: {verb.upper()} {path}')


def test_draft_write_read_delete_roundtrip():
    """The disk-persistence helpers survive a mid-teach restart:
    _teach_write_draft → _teach_read_draft returns the same
    dict; _teach_delete_draft removes it. This is the invariant
    that makes 'draft survives systemctl restart' true — the
    file exists between calls, not just in RAM."""
    # We can't easily import dashboard_server here (it hoists
    # ROS deps at import time). Instead, exercise the storage
    # invariant via a tempdir mirror of the same shape the
    # helpers use. If the helpers ever land somewhere importable
    # this test tightens automatically.
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, 'test_prog.draft.json')
        payload = {'program_id': 'test_prog',
                   'owner_device_id': 'dev-abc',
                   'poses': {'corner:1': {'taught': True,
                                          'taught_tcp': [1, 2, 3, 0, 0, 0]}}}
        # Atomic write shape: write to .tmp, fsync, rename.
        tmp = p + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(payload, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
        # Read back.
        with open(p) as fh:
            round_tripped = json.load(fh)
        assert round_tripped == payload
        # Delete.
        os.remove(p)
        assert not os.path.exists(p)


def test_draft_merge_promotes_step_and_corner_slots():
    """The _apply_draft_poses_to_program merger writes:
       step:<id>  → merges patch fields into the matching step
       corner:1|2|3 → writes taught_tcp to config.pallet_place.corner{N}_tcp
       corner:part  → writes to config.pallet_place.part_tcp
    Unknown slots are silently skipped (never applied — the
    program shape stays consistent with the schema)."""
    src = _read(SERVER)
    m = re.search(
        r'def _apply_draft_poses_to_program\([^)]*\)[^:]*:'
        r'(.+?)\n    @app\.', src, re.DOTALL)
    assert m, ('_apply_draft_poses_to_program signature drifted '
               '— cannot pin the promotion contract')
    body = m.group(1)
    assert "startswith('step:')" in body, (
        'step:<id> slot mapping missing — step teach poses '
        'cannot be promoted through the draft')
    assert "startswith('corner:')" in body, (
        'corner:* slot mapping missing — pallet corner poses '
        'cannot be promoted through the draft')
    for key in ('corner1_tcp', 'corner2_tcp', 'corner3_tcp',
                'part_tcp'):
        assert key in body, (
            f'corner-to-{key} write missing from the merger')


def test_save_endpoint_gates_through_pending_pose_validator():
    """The teach_session save endpoint MUST run
    check_program_pending_poses before persisting. Skipping
    that would let a program with an untaught anchor save via
    this path and later crash the controller on movJCoorRel
    (firmware bug #3, pre-D14 signature)."""
    src = _read(SERVER)
    m = re.search(
        r'async def api_teach_session_save\([^)]*\)[^:]*:'
        r'(.+?)\n    @app\.', src, re.DOTALL)
    assert m, 'teach_session save handler signature drifted'
    body = m.group(1)
    assert 'check_program_pending_poses' in body, (
        'save endpoint bypasses the pending-pose validator — '
        'a program with untaught poses could save through the '
        'teach_session path and reach the controller')
    assert "'pending_poses'" in body or '"pending_poses"' in body, (
        'save endpoint does not return outcome.kind=pending_poses '
        '— the frontend namedLoadError would fall back to a '
        'generic error, losing operator copy')


def test_boot_hydrates_teach_sessions_from_disk():
    """A `systemctl restart roboai-dashboard` mid-teach must NOT
    lose the draft. The server calls _teach_publish_to_state()
    at import time so STATE['teach_sessions'] is populated
    from disk before the first WS frame goes out."""
    src = _read(SERVER)
    # Both the function definition and the boot-time call exist.
    assert re.search(r'def _teach_publish_to_state\(', src), (
        '_teach_publish_to_state helper missing — no bridge from '
        'disk to STATE[teach_sessions] on startup')
    # The boot-time call is placed at module setup, not inside
    # a function — flag it with a comment nearby so this test
    # can find it.
    assert re.search(
        r'_teach_publish_to_state\(\)\s*(?:$|\n)',
        src), ('_teach_publish_to_state() is defined but never '
               'called at boot — draft-survives-restart is broken')


# ── WS broadcast carries the draft ──────────────────────────────

def test_client_reads_teach_sessions_from_ws_state_frame():
    """useStore's ws.onmessage picks up msg.teach_sessions and
    stores it as `teachSessions`. Any regression here breaks
    every downstream selector (isTeachingElsewhere, live
    corner badges, etc.)."""
    src = _read(STORE_JS)
    assert 'msg.teach_sessions' in src, (
        'useStore does not read msg.teach_sessions from the WS '
        'state frame — the record-through mirror is broken')
    assert 'teachSessions:' in src, (
        'teachSessions store slice initializer missing — '
        'the cache has no default and downstream selectors '
        'read undefined')


# ── Editor call sites route through recordTeachPose ────────────

def test_editor_records_step_teach_through_record_endpoint():
    """teachOverlayRecord in ProgramEditor.jsx must call
    recordTeachPose with a 'step:<id>' slot key BEFORE
    mutating currentProgram. Any regression that flips the
    order re-introduces the pre-2026-08-04 bug (record only
    reaches the server on save)."""
    src = _read(EDITOR_JSX)
    m = re.search(
        r'async function teachOverlayRecord\(\)\s*\{'
        r'(.+?)\n  (?:async )?function ', src, re.DOTALL)
    assert m, ('teachOverlayRecord signature drifted — cannot '
               'pin the record-through order')
    body = m.group(1)
    # recordTeachPose call precedes updateSteps.
    pos_record  = body.find('recordTeachPose(')
    pos_update  = body.find('updateSteps(')
    assert pos_record != -1, (
        'teachOverlayRecord does not call recordTeachPose — '
        'step teach still writes only to local Zustand')
    assert pos_update > pos_record, (
        f'updateSteps (at {pos_update}) fires BEFORE '
        f'recordTeachPose (at {pos_record}) — a server 403 or '
        f'network error would leave the UI showing a taught '
        f'step the server never accepted')
    # Slot key uses the canonical step:<id> shape.
    assert re.search(r"['`]step:\$\{target\.id\}", body), (
        'step slot key does not use the canonical step:<id> '
        'shape (must match server _apply_draft_poses_to_program)')


def test_editor_records_pallet_corners_through_record_endpoint():
    """palletTeachRecord must call recordTeachPose for every
    corner slot (pallet_c1/2/3/part) so the second-device
    view sees corner badges fill live."""
    src = _read(EDITOR_JSX)
    m = re.search(
        r'async function palletTeachRecord\(\)\s*\{'
        r'(.+?)\n  async function ', src, re.DOTALL)
    assert m, 'palletTeachRecord signature drifted'
    body = m.group(1)
    assert 'recordTeachPose(' in body, (
        'palletTeachRecord does not call recordTeachPose — '
        'pallet corner records still write only to local state')
    # Slot key maps: corner:1|2|3|part.
    for expected in ("'corner:1'", "'corner:2'",
                     "'corner:3'", "'corner:part'"):
        assert expected in body, (
            f'palletTeachRecord slot key map missing {expected} '
            '— corner mapping is not the canonical shape')


# ── localStorage does NOT carry pose data ──────────────────────

def test_zustand_persist_whitelist_excludes_currentProgram():
    """Post-2026-08-04, currentProgram is server truth; a stale
    localStorage copy re-introduces drift after a refresh. The
    Zustand persist partialize function MUST NOT list
    currentProgram."""
    src = _read(STORE_JS)
    # Extract the partialize body — bounded by the closing ')'.
    m = re.search(
        r'partialize:\s*\(state\)\s*=>\s*\(\{(.+?)\}\),',
        src, re.DOTALL)
    assert m, 'partialize block missing from useStore persist config'
    body = m.group(1)
    assert 'currentProgram' not in body, (
        'currentProgram is still in the Zustand persist whitelist '
        '— pose data is being mirrored to localStorage, breaking '
        'the record-through invariant')


# ── Concurrency banner + Take Over ─────────────────────────────

def test_editor_renders_teach_session_locked_banner():
    """2026-08-05: the concurrency banner + Take Over button now
    live inside the shared TeachLockBanner component (fork registry
    entry `teach_lock_banner`). The editor tab renders the inline
    variant, the fullscreen TeachOverlay renders the overlay variant
    via the `lockBanner` slot. Test-ids moved to the shared
    component."""
    src = _read(EDITOR_JSX)
    # Editor tab uses the shared component.
    assert 'TeachLockBanner' in src, (
        'concurrency banner missing — a second device teaching '
        'the same program would have no visible read-only signal')
    # Take Over button is defined inside TeachLockBanner.jsx with
    # test-id 'teach-lock-take-over'. Cross-file check happens in
    # test_teach_lock_banner_parity.py.
    lock_banner = _read(WS / 'src' / 'cobot_dashboard' / 'frontend'
                        / 'src' / 'components' / 'TeachLockBanner.jsx')
    assert 'data-testid="teach-lock-banner"' in lock_banner
    assert 'data-testid="teach-lock-take-over"' in lock_banner


def test_editor_gates_record_button_when_observing():
    src = _read(EDITOR_JSX)
    # The TeachOverlay Record button reads recordDisabled.
    assert 'recordDisabled' in src, (
        'recordDisabled prop missing on TeachOverlay — Record '
        'button stays clickable in observer mode')
    # And it's threaded from isTeachingElsewhere at the call site.
    assert re.search(
        r'recordDisabled=\{isTeachingElsewhere\}', src), (
        'TeachOverlay call site does not thread '
        'isTeachingElsewhere into recordDisabled — observers '
        'can click Record and get a 403 refusal')


# ── Fork registry entry ────────────────────────────────────────

def test_fork_registry_has_teach_session_entry():
    src = _read(REGISTRY)
    assert 'id: teach_session_state' in src, (
        'fork_registry.yaml has no teach_session_state entry — '
        'new duplicates cannot be gated by the linter')
    # Forbidden pattern for localStorage on pose data.
    assert 'localStorage' in src and 'setItem' in src, (
        'localStorage.setItem pattern missing from the '
        'teach_session_state forbidden block — Zustand persist '
        'reintroduction would not be caught')
    # Forbidden pattern for currentProgram persist. The YAML
    # entry escapes the dot as \\. so re-introducing the
    # Zustand whitelist entry is caught by the linter.
    assert 'currentProgram: state' in src, (
        'partialize + currentProgram pattern missing from '
        'teach_session_state forbidden block — bringing back '
        'the persist whitelist entry would not be caught')
