"""Motion-gate no-fork lint (2026-08-03).

The operator hit "codegen produced zero valid movJ steps" three
times running because the gate wording said `movJ` and TWO
independent code paths (`dashboard_server.py:5276` and `:5749`)
implemented the "empty program" check with `if not points:`. Each
path had its own reason string; only one was updated when the
retire-classical + Isaac work made all-cartesian programs the norm.

These pinned checks make sure:
  * The shared predicate `program_ops.has_valid_motion` exists
    and behaves correctly (movJ + movL + movC → runnable;
    movJCoorRel alone → not runnable; empty Lua → not runnable).
  * Every motion-emptiness gate in `dashboard_server.py` routes
    through `has_valid_motion` — no ad-hoc `if not points:` or
    "zero valid movJ" wording survives.
"""

from __future__ import annotations

import os
import re

from estun_driver.program_ops import (
    has_valid_motion, motion_verbs, _load_luaenginelib)


def test_motion_verbs_sourced_from_luaenginelib_catalogue():
    """The predicate's verb set is derived from the same 168-entry
    catalogue the lint gate uses (`luaenginelib.json`) — every
    entry whose name starts with 'mov' is a motion verb. No
    hand-typed allowlist to drift."""
    verbs = motion_verbs()
    # Sanity floor: the four verbs that MUST exist to declare
    # motion under any catalogue revision. If any of these
    # disappears we want to know loudly.
    for required in ('movJ', 'movL', 'movC', 'movJCoorRel'):
        assert required in verbs, (
            f'motion_verbs() missing required verb {required!r} — '
            f'either the catalogue drifted or the mov-prefix rule '
            f'stopped matching. Got: {verbs}')
    # Every returned name must actually exist in the catalogue —
    # this is what pins the no-fork contract.
    lib = _load_luaenginelib()
    for v in verbs:
        assert v in lib, (
            f'motion_verbs() returned {v!r} but the catalogue does '
            f'not know that name — predicate is DRIFTING from the '
            f'lint catalogue.')
        assert v.startswith('mov'), (
            f'motion_verbs() returned non-mov* verb {v!r} — the '
            f'derivation rule is broken.')


def test_has_valid_motion_counts_every_mov_verb():
    """Every mov* verb from the catalogue counts as motion. Pre-
    fix (2026-08-03) the predicate hardcoded movJ+movL+movC and
    rejected movJCoorRel — that discrimination is retired."""
    lua = "\n".join([
        "setSpeedJ(90)",
        "movJ(p1)",
        "movL(p2)",
        "movC(p3, p4)",
        "movJCoorRel({cp={0,0,100,0,0,0}},{coor=0,tool=0})",
        "movLCoorRel({cp={0,0,50,0,0,0}},{coor=0,tool=0})",
        "movJToolRel({cp={0,0,-30,0,0,0}},{tool=1})",
        "setDO(2,1)",
        "-- movJ(fake) in a comment must not count",
    ])
    ok, counts = has_valid_motion(lua)
    assert ok is True
    assert counts['movJ'] == 1
    assert counts['movL'] == 1
    assert counts['movC'] == 1
    assert counts['movJCoorRel'] == 1
    assert counts['movLCoorRel'] == 1
    assert counts['movJToolRel'] == 1
    assert counts['total'] == 6


def test_has_valid_motion_movJCoorRel_alone_is_still_motion():
    """The operator's 2026-08-03 directive: movJCoorRel commands
    the arm to move — it IS motion. The gate must not discriminate
    against relative-move verbs. Pre-fix predicate treated a
    movJCoorRel-only program as empty (regression).

    Physical meaning: two relative Z-moves from wherever the arm
    starts. Not tied to a taught point, but still legitimate
    motion the operator may have authored on purpose."""
    lua = "\n".join([
        "setSpeedJ(90)",
        "movJCoorRel({cp={0,0,100,0,0,0}},{coor=0,tool=0})",
        "movJCoorRel({cp={0,0,200,0,0,0}},{coor=0,tool=0})",
    ])
    ok, counts = has_valid_motion(lua)
    assert ok is True, (
        'movJCoorRel is a motion verb per the catalogue — a program '
        'consisting only of movJCoorRel lines has motion. Gate '
        'must not discriminate.')
    assert counts['movJCoorRel'] == 2
    assert counts['total'] == 2


def test_has_valid_motion_empty_or_comment_only():
    for lua in ("", "-- everything skipped", "\n\n\n"):
        ok, counts = has_valid_motion(lua)
        assert ok is False, f'empty-ish Lua passed: {lua!r} -> {counts}'
        assert counts['total'] == 0


def test_all_cartesian_program_passes_the_gate():
    """A valid all-cartesian program (only movL point references)
    must pass the motion gate."""
    lua = "\n".join([
        "movL(p1)  -- pick contact",
        "movL(p2)  -- pallet slot",
        "movL(p3)  -- retreat",
    ])
    ok, counts = has_valid_motion(lua)
    assert ok is True
    assert counts['movJ'] == 0
    assert counts['movL'] == 3
    assert counts['total'] == 3


def test_dashboard_server_gates_route_through_has_valid_motion():
    """No-fork lint: every motion-emptiness gate in
    dashboard_server.py MUST call `program_ops.has_valid_motion`.
    An `if not points:` immediately followed by a JSONResponse
    with `"empty_program"` or `"codegen_empty"` outcome is a
    forked implementation and must be flagged."""
    here = os.path.dirname(os.path.abspath(__file__))
    server_path = os.path.abspath(os.path.join(
        here, '..', 'cobot_dashboard', 'dashboard_server.py'))
    with open(server_path) as fh:
        src = fh.read()
    # The predicate is referenced by name at the call sites.
    assert 'has_valid_motion' in src, (
        'dashboard_server.py does not reference has_valid_motion — '
        'the shared predicate is not wired in')
    # Count call sites; expect at least two (run-gate, home-gate).
    calls = re.findall(r'program_ops\.has_valid_motion\s*\(', src)
    assert len(calls) >= 2, (
        f'expected >=2 program_ops.has_valid_motion(...) call sites, '
        f'found {len(calls)} — a gate may still be forked')
    # No motion-emptiness gate should still read `if not points:`
    # right before an empty_program / codegen_empty outcome.
    bad = re.findall(
        r'if\s+not\s+points\s*:[\s\S]{0,400}?'
        r'(?:"empty_program"|"codegen_empty")',
        src)
    assert not bad, (
        f'legacy `if not points:` motion gate still present '
        f'({len(bad)} hit(s)) — collapse to has_valid_motion')
    # And no stale "zero valid movJ" reason string.
    assert 'zero valid movJ' not in src, (
        'stale "zero valid movJ" wording still in dashboard_server.py '
        '— run gate reads as movJ-only when it should be '
        'verb-agnostic')
