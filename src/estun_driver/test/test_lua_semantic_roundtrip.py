"""Semantic round-trip coverage proof.

Fixture: real `test100` program fetched from
`http://192.168.2.136:9198` on 2026-09-02 — a 13-step
loop-terminated pick-and-place. Files:
    test/fixtures/test100_main.lua       — emitted Lua
    test/fixtures/test100_varspoint.json — point dict

Baseline test verifies the parser accepts the real fixture.
Each mutation test injects one of the four bug classes the user
called out and asserts the parser catches it.

**Honest note on "prove against a real historical case":**
step-drop and reorder have NO wire-captured historical Lua
(corpus mining agent confirmed 2026-09-02: no addendum captured
the failing Lua for these classes). Structural mutations of the
real fixture are structurally identical to what those historical
events would have looked like. The anchor-mixup mutation is
structurally identical to the pre-2026-07-27 multi-pair
role-map bug fixed at codegen time by `_resolve_anchor_step`
(addendum-29 §334 — matcher NOT yet encoded, see
`lua_regression_corpus.json` HAND_ENTRIES).
"""
from __future__ import annotations

import copy
import json
import pathlib
import re
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from estun_driver.lua_semantic_roundtrip import (  # noqa: E402
    check_consistency,
    verify_against_taught,
)


_FIX = pathlib.Path(__file__).parent / "fixtures"
_LUA = (_FIX / "test100_main.lua").read_text()
_VARSPOINT = json.loads((_FIX / "test100_varspoint.json").read_text())


def _kinds(report) -> list[str]:
    return [f.kind for f in report.findings]


# ─────────────────────────────────────────────────────────────
# Baseline: real fixture is internally consistent
# ─────────────────────────────────────────────────────────────

def test_baseline_test100_ok():
    r = check_consistency(_LUA, _VARSPOINT)
    assert r.ok, f"real test100 should pass consistency check, got: {r.findings}"
    assert len(r.line_map) == 13, r.line_map


# ─────────────────────────────────────────────────────────────
# Mutation 1 — step-drop
# ─────────────────────────────────────────────────────────────

def test_mutation_step_drop_detected():
    """Simulate codegen dropping step 5 (`wait` after `set_io`).
    We do this by editing the line_map trailer to omit that entry;
    the Lua still contains a `wait(500)` line, so the parser sees
    an emitted primary verb with no line_map entry, AND detects a
    reorder because the remaining step_idx sequence has a gap
    after re-indexing."""
    mutated = _drop_line_map_entry(_LUA, drop_step_idx=5)
    r = check_consistency(mutated, _VARSPOINT)
    assert not r.ok, "expected findings from step-drop mutation"
    # We accept either a reorder finding (gap in step_idx) OR a
    # step_count_mismatch downstream. The KEY is: baseline was OK,
    # mutation is not.
    assert any(k in ("reorder", "step_drop") for k in _kinds(r)), _kinds(r)


# ─────────────────────────────────────────────────────────────
# Mutation 2 — reorder
# ─────────────────────────────────────────────────────────────

def test_mutation_reorder_detected():
    """Swap step_idx 3 and 4 in the line_map trailer. The rest of
    the Lua is untouched; the reorder check must fire."""
    mutated = _swap_line_map_entries(_LUA, 3, 4)
    r = check_consistency(mutated, _VARSPOINT)
    assert "reorder" in _kinds(r), _kinds(r)


# ─────────────────────────────────────────────────────────────
# Mutation 3 — anchor-mixup (varspoint carries the wrong point)
# ─────────────────────────────────────────────────────────────

def test_mutation_anchor_mixup_detected():
    """Swap the val of p1 (home pose) and p2 (approach pose above
    pick) in varspoint. The Lua still emits `movJ(p1)` at step 0
    with the inline comment showing p1's ORIGINAL home joints, but
    the varspoint lookup now returns p2's joints — the anchor-mixup
    finding must fire.

    (Note: p1 and p8 in this fixture are both "home" — same joints
    — so swapping them is a semantic no-op; p2 has approach-pose
    joints that differ from home by ~30° per axis, making it a
    clean mutation subject.)

    Structural analog of the pre-2026-07-27 multi-pair role-map
    bug where approach/retreat resolved to a different pair's
    anchor (addendum-29 §334, fixed by `_resolve_anchor_step`
    distance heuristic)."""
    vp = copy.deepcopy(_VARSPOINT)
    vp["p1"]["val"], vp["p2"]["val"] = vp["p2"]["val"], vp["p1"]["val"]
    r = check_consistency(_LUA, vp)
    assert "anchor_mixup" in _kinds(r), _kinds(r)


# ─────────────────────────────────────────────────────────────
# Mutation 4 — point-substitution (Lua emits wrong point name)
# ─────────────────────────────────────────────────────────────

def test_mutation_point_substitution_detected():
    """Rewrite `movJ(p1)` to `movJ(p3)` in the Lua, leaving the
    inline comment intact (comment still shows p1's home joints).
    The point-name now refers to p3 (pick-descent pose) but the
    inline comment still claims home joints. varspoint[p3].jp is
    the descent joints, which disagree with the inline comment →
    the anchor-mixup / point-substitution class fires.

    (p8 shares p1's home joints so substituting p8 would be a
    no-op; p3 is a clean substitution target with distinct
    joints.)"""
    mutated = re.sub(r'\bmovJ\(p1\)', 'movJ(p3)', _LUA, count=1)
    assert mutated != _LUA, "mutation did not modify the fixture"
    r = check_consistency(mutated, _VARSPOINT)
    kinds = _kinds(r)
    assert "anchor_mixup" in kinds or "point_substitution" in kinds, kinds


# ─────────────────────────────────────────────────────────────
# Verb-substitution guard (bonus: catches action↔verb drift)
# ─────────────────────────────────────────────────────────────

def test_mutation_verb_substitution_detected():
    """Replace `setDO(2,0)` at step 1 (action=set_io) with a
    `movJ(p1)` call. line_map still says set_io, but the emitted
    range now contains movJ — verb-substitution fires.

    Note: codegen's line_map uses "logical" line 4 for set_io,
    which is file line 5 (loop-label prefix at file line 1 is
    skipped in the D9 numbering — see _split_and_normalize_lines).
    """
    lines = _LUA.splitlines()
    # file line 5 (index 4) = setDO(2,0) — see fixture head
    assert "setDO" in lines[4], lines[4]
    lines[4] = lines[4].replace("setDO(2,0)", "movJ(p1)", 1)
    mutated = "\n".join(lines) + "\n"
    r = check_consistency(mutated, _VARSPOINT)
    assert "verb_substitution" in _kinds(r), _kinds(r)


# ─────────────────────────────────────────────────────────────
# verify_against_taught — action-drift + joints-drift catches
# ─────────────────────────────────────────────────────────────

def test_taught_program_action_drift_detected():
    """Full round-trip against a synthetic taught_steps whose step
    0 has action='set_io' but line_map says 'move_home' → action
    drift."""
    taught = [{"action": "set_io"}] + [{"action": e.action} for e in
              [type("X",(),{"action": a})() for a in
               ("set_io", "move_linear", "move_linear", "set_io",
                "wait", "move_linear", "move_linear", "move_linear",
                "set_io", "move_linear", "move_home", "loop")]]
    r = verify_against_taught(_LUA, _VARSPOINT, taught)
    assert "action_drift" in _kinds(r), _kinds(r)


def test_taught_program_step_count_mismatch_detected():
    """taught_steps has 12 entries; line_map has 13 → step-count
    mismatch."""
    taught = [{"action": "move_home"}] * 12
    r = verify_against_taught(_LUA, _VARSPOINT, taught)
    assert "step_count_mismatch" in _kinds(r), _kinds(r)


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

_LM_LINE_RE = re.compile(r'(--\s*line_map\s*\(D9[^:]*:\s*)(\[.*\])(\s*)$')


def _rewrite_line_map(lua: str, new_list: list) -> str:
    out = []
    for L in lua.splitlines():
        m = _LM_LINE_RE.search(L)
        if m:
            L = L[:m.start()] + m.group(1) + json.dumps(new_list) + m.group(3)
        out.append(L)
    return "\n".join(out) + ("\n" if lua.endswith("\n") else "")


def _extract_line_map(lua: str) -> list:
    for L in lua.splitlines():
        m = _LM_LINE_RE.search(L)
        if m:
            return json.loads(m.group(2))
    return []


def _drop_line_map_entry(lua: str, *, drop_step_idx: int) -> str:
    lm = _extract_line_map(lua)
    new = [e for e in lm if e["step_idx"] != drop_step_idx]
    # Do NOT re-index — leaving a gap is the point (simulates a
    # partial-write regression where codegen forgot to renumber).
    return _rewrite_line_map(lua, new)


def _swap_line_map_entries(lua: str, i: int, j: int) -> str:
    lm = _extract_line_map(lua)
    # Swap the step_idx fields so the resulting sequence is a
    # permutation, not a rewrite of positions.
    for e in lm:
        if e["step_idx"] == i: e["step_idx"] = j
        elif e["step_idx"] == j: e["step_idx"] = i
    return _rewrite_line_map(lua, lm)
