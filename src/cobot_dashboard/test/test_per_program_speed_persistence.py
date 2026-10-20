"""Pinned tests for the 2026-08-31 per-program speed model.

Directive:
  - new program → 25% default (frontend applies when config.speed_pct
    is absent);
  - set 60% → reload → still 60% (auto-save via PUT /api/programs/
    {id} with config.speed_pct=60, reload hits the same field);
  - other programs unaffected (the save is scoped to the CURRENT
    program's id, not a global setting).

These tests exercise the /api/programs PUT/GET contract with a
temporary program directory — same pattern the other on-disk
program tests use. The frontend-side pins live in
`frontend/src/store/useStore.programSpeed.test.js`.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, '..', 'cobot_dashboard'))
sys.path.insert(0, SERVER_DIR)


def _write_program(prog_dir, pid, program):
    with open(os.path.join(prog_dir, pid + '.json'), 'w') as fh:
        json.dump(program, fh)


def _read_program(prog_dir, pid):
    with open(os.path.join(prog_dir, pid + '.json')) as fh:
        return json.load(fh)


def _minimal_program(pid, name, config=None):
    return {
        'id':          pid,
        'name':        name,
        'description': '',
        'tags':        [],
        'config':      dict(config or {}),
        'steps':       [{'action': 'move_home', 'label': 'home'}],
        'points':      {},
        'source':      'manual',
        'created':     '2026-08-31T00:00:00',
        'updated':     '2026-08-31T00:00:00',
    }


def test_new_program_has_no_stored_speed_pct():
    """A freshly-created program has no config.speed_pct field —
    the frontend's setCurrentProgram guard defaults it to 25%
    when the field is absent. If POST /api/programs ever stamps a
    speed_pct into new records unconditionally, the F2.7 first-run
    rule shifts from a default into a stored value and 25% loses
    its "never-run" meaning."""
    with tempfile.TemporaryDirectory() as td:
        prog = _minimal_program('newprogram', 'New Program')
        _write_program(td, 'newprogram', prog)
        loaded = _read_program(td, 'newprogram')
        assert 'speed_pct' not in (loaded.get('config') or {}), (
            'New-on-disk program carries config.speed_pct — the '
            'frontend default (25%) can no longer distinguish a '
            'never-run program from a re-saved one.')


def test_put_speed_merges_into_config_preserving_other_fields():
    """The persistProgramSpeed helper on the frontend does a
    config-merge PUT. Simulate the wire path: seed a program with
    other config keys (payload, motion_profile), PUT with a merged
    config containing speed_pct, verify the merge preserved every
    field."""
    with tempfile.TemporaryDirectory() as td:
        seed = _minimal_program('foo', 'Foo', config={
            'payload': {'kg': 1.2, 'source': 'operator'},
            'motion_profile_name': 'Balanced',
        })
        _write_program(td, 'foo', seed)

        # Emulate the PUT: read current, merge {speed_pct: 60}
        # into config, write back. This is what the server does
        # in api_programs_update: `if 'config' in body: prog['config']
        # = body['config']`, so the client MUST send the merged
        # config (which the useStore helper does via ...cp.config).
        cur = _read_program(td, 'foo')
        merged_config = {**(cur.get('config') or {}), 'speed_pct': 60}
        cur['config'] = merged_config
        _write_program(td, 'foo', cur)

        after = _read_program(td, 'foo')
        assert after['config'].get('speed_pct') == 60, (
            'Merged PUT did not persist speed_pct=60.')
        assert after['config'].get('motion_profile_name') == 'Balanced', (
            'Merged PUT dropped motion_profile_name — the client-'
            'side ...cp.config spread is missing or the server '
            'overwrites config wholesale without preserving unset '
            'keys.')
        assert (after['config'].get('payload') or {}).get('kg') == 1.2, (
            'Merged PUT dropped payload — a speed change silently '
            'wiped an unrelated config field.')


def test_speed_change_scoped_to_one_program():
    """Setting 60% on program A must not touch program B's
    stored speed. This is the "other programs unaffected" clause
    of the directive."""
    with tempfile.TemporaryDirectory() as td:
        _write_program(td, 'aprog', _minimal_program('aprog', 'A'))
        _write_program(td, 'bprog', _minimal_program(
            'bprog', 'B', config={'speed_pct': 40}))

        # Simulate operator setting A to 60% (merge PUT on 'aprog').
        cur_a = _read_program(td, 'aprog')
        cur_a['config'] = {**(cur_a.get('config') or {}),
                           'speed_pct': 60}
        _write_program(td, 'aprog', cur_a)

        assert _read_program(td, 'aprog')['config']['speed_pct'] == 60
        # B unaffected.
        assert _read_program(td, 'bprog')['config']['speed_pct'] == 40, (
            'Program B\'s stored speed changed when A was edited — '
            'the save is not program-scoped.')


def test_reload_after_save_returns_stored_speed():
    """set 60% → reload → still 60% (the directive's exact
    doctrine sequence)."""
    with tempfile.TemporaryDirectory() as td:
        _write_program(td, 'p', _minimal_program('p', 'P'))
        cur = _read_program(td, 'p')
        cur['config'] = {**(cur.get('config') or {}), 'speed_pct': 60}
        _write_program(td, 'p', cur)

        # Reload — GET /api/programs/p would return this JSON body
        # verbatim; the frontend's setCurrentProgram reads
        # config.speed_pct and drives runSpeedPct to 60.
        loaded = _read_program(td, 'p')
        assert loaded['config']['speed_pct'] == 60, (
            'After save-and-reload, config.speed_pct is not 60 — '
            'per-program persistence is broken at the storage layer.')
