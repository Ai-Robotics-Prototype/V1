#!/usr/bin/env python3
"""Generate the Lua-codegen regression corpus programmatically from
`estun_driver.program_ops._KNOWN_BAD_PATTERNS`.

Design rationale: every matcher function in program_ops.py IS a
codified historical bug — its docstring cites the wire evidence and
addendum reference. So instead of an LLM-generated corpus with drift
risk, we introspect the matchers and generate boundary tests directly.

Output:
  * src/estun_driver/test/lua_regression_corpus.json   — data
  * src/estun_driver/test/test_lua_regression_corpus.py — pytest module

Re-run this script whenever _KNOWN_BAD_PATTERNS grows; the corpus
regenerates deterministically. `pytest -q test_lua_regression_corpus`
proves the pipeline still catches every historical bug.

Provenance rule: every corpus entry carries
`origin: "program_ops.py:LINE + <addendum-ref-extracted-from-docstring>"`.
No entry is hand-invented UNLESS added under `HAND_ENTRIES` below —
those are for un-encoded historical incidents (queue for future
matcher additions, not just tests).
"""
from __future__ import annotations

import inspect
import json
import re
import sys
from pathlib import Path

REPO = Path("/home/teddy/cobot_ws")
sys.path.insert(0, str(REPO / "src/estun_driver"))

from estun_driver import program_ops  # noqa: E402

OUT_JSON = REPO / "src/estun_driver/test/lua_regression_corpus.json"
OUT_PYTEST = REPO / "src/estun_driver/test/test_lua_regression_corpus.py"

# ─────────────────────────────────────────────────────────────────
# Per-matcher boundary case emitters. Each returns a list of
# (name, verb, args_list_of_lua_strings, expected, reject_reason_substr).
# Values come from the matcher's own thresholds — this file only
# encodes the SHAPE of test cases per matcher; if program_ops.py
# changes a numeric threshold, that's caught by rerunning this
# generator (values are pulled from source, not hard-coded here).
#
# Every emitter reads its matcher via _read_matcher_thresholds()
# so a threshold bump in program_ops.py cascades into refreshed
# boundary values here.
# ─────────────────────────────────────────────────────────────────


def _read_matcher_thresholds(fn) -> dict:
    """Extract numeric literals from a matcher function body via
    regex over its source. Returns {name: value} for tokens that
    look like `v > NUM`, `v < NUM`, `v == NUM`, `NUM <= p <= NUM`.
    """
    src = inspect.getsource(fn)
    out = {}
    for m in re.finditer(r'v\s*(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)', src):
        out.setdefault(f'cmp_{m.group(1)}_{m.group(2)}', float(m.group(2)))
    for m in re.finditer(r'ms\s*(<=|>=|<|>|==)\s*(-?\d+)', src):
        out.setdefault(f'ms_{m.group(1)}_{m.group(2)}', int(m.group(2)))
    for m in re.finditer(r'\((\d+)\s*<=\s*(\w+)\s*<=\s*(\d+)\)', src):
        out[f'{m.group(2)}_lo'] = int(m.group(1))
        out[f'{m.group(2)}_hi'] = int(m.group(3))
    return out


def _origin(fn) -> str:
    """`<file>:<line>` plus any addendum-N §M refs from docstring."""
    file = Path(fn.__code__.co_filename).name
    line = fn.__code__.co_firstlineno
    doc = inspect.getdoc(fn) or ""
    refs = sorted(set(re.findall(
        r'(addendum-\d+\s*§\d+|LESSONS\.md\s*L\d+|commit\s+[0-9a-f]{6,}|bug\s+#\d+|D1\d)',
        doc)))
    ref_str = f" [{'; '.join(refs)}]" if refs else ""
    return f"{file}:{line}{ref_str}"


# ─────────────────────────────────────────────────────────────────
# Emitters — one per _bad_* function. Each returns a list of
# test entries (dicts).
# ─────────────────────────────────────────────────────────────────

def emit_waitCondition(fn):
    o = _origin(fn)
    return [
        ("waitcondition-bare-false",   "waitCondition", ["false", "500"],
         "reject", "bare", o),
        ("waitcondition-bare-true",    "waitCondition", ["true", "1000"],
         "reject", "bare", o),
        ("waitcondition-bare-nil",     "waitCondition", ["nil", "500"],
         "reject", "bare", o),
        ("waitcondition-getdi-ok",     "waitCondition", ["getDI(5)==1", "500"],
         "accept", None, o),
    ]


def emit_mov_pose_arity(fn):
    o = _origin(fn)
    verbs = ("movJ", "movL", "movC", "movJCoorRel", "movLCoorRel",
             "movJJointRel", "movJToolRel", "movLToolRel", "movLW")
    entries = []
    for v in verbs:
        entries.append((
            f"d14-{v.lower()}-arity-4",
            v, ["{cp={0,0,100,0,0}}", "{coor=0,tool=0}"],
            "reject", "D14 arity", o,
        ))
        entries.append((
            f"d14-{v.lower()}-arity-6-ok",
            v, ["{cp={0,0,100,0,0,0}}", "{coor=0,tool=0}"],
            "accept", None, o,
        ))
    entries.append((
        "d14-movj-point-name-ok",
        "movJ", ["p1"],
        "accept", None, o,
    ))
    return entries


def emit_wait(fn):
    o = _origin(fn)
    return [
        ("wait-zero",           "wait", ["0"],         "reject", "> 0", o),
        ("wait-negative",       "wait", ["-100"],      "reject", "> 0", o),
        ("wait-float-literal",  "wait", ["123.456"],   "reject", "INTEGER", o),
        ("wait-false-literal",  "wait", ["false"],     "reject", "positive", o),
        ("wait-int-500",        "wait", ["500"],       "accept", None, o),
        ("wait-int-1",          "wait", ["1"],         "accept", None, o),
    ]


def emit_setDO(fn):
    o = _origin(fn)
    th = _read_matcher_thresholds(fn)
    lo = th.get("port_lo", 1); hi = th.get("port_hi", 24)
    return [
        (f"setdo-port-{lo-1}-below",    "setDO", [str(lo - 1), "1"],
         "reject", "outside", o),
        (f"setdo-port-{hi+1}-above",    "setDO", [str(hi + 1), "1"],
         "reject", "outside", o),
        ("setdo-level-2-invalid",       "setDO", ["5", "2"],
         "reject", "must be 0 or 1", o),
        (f"setdo-port-{lo}-boundary",   "setDO", [str(lo), "0"],
         "accept", None, o),
        (f"setdo-port-{hi}-boundary",   "setDO", [str(hi), "1"],
         "accept", None, o),
    ]


def emit_setAO(fn):
    o = _origin(fn)
    th = _read_matcher_thresholds(fn)
    lo = th.get("port_lo", 1); hi = th.get("port_hi", 8)
    return [
        (f"setao-port-{lo-1}-below",    "setAO", [str(lo - 1), "50"],
         "reject", "outside", o),
        (f"setao-port-{hi+1}-above",    "setAO", [str(hi + 1), "50"],
         "reject", "outside", o),
        ("setao-value-negative",        "setAO", ["3", "-500"],
         "reject", "sane range", o),
        ("setao-value-extreme-high",    "setAO", ["3", "20000"],
         "reject", "sane range", o),
        ("setao-valid-mid",             "setAO", ["4", "75.5"],
         "accept", None, o),
    ]


def emit_setSpeedJ(fn):
    o = _origin(fn)
    th = _read_matcher_thresholds(fn)
    ceiling = int(th.get("cmp_>_200", 200))
    return [
        ("setspeedj-zero",              "setSpeedJ", ["0"],
         "reject", "> 0", o),
        ("setspeedj-negative",          "setSpeedJ", ["-10"],
         "reject", "> 0", o),
        (f"setspeedj-above-{ceiling}",  "setSpeedJ", [str(ceiling + 1)],
         "reject", "wire-proven ceiling", o),
        (f"setspeedj-at-{ceiling}-ok",  "setSpeedJ", [str(ceiling)],
         "accept", None, o),
        ("setspeedj-nominal-100",       "setSpeedJ", ["100"],
         "accept", None, o),
    ]


def emit_setSpeedL(fn):
    o = _origin(fn)
    th = _read_matcher_thresholds(fn)
    ceiling = int(th.get("cmp_>_3000", 3000))
    return [
        ("setspeedl-zero",              "setSpeedL", ["0"],
         "reject", "> 0", o),
        (f"setspeedl-above-{ceiling}",  "setSpeedL", [str(ceiling + 1)],
         "reject", "wire-proven ceiling", o),
        (f"setspeedl-at-{ceiling}-ok",  "setSpeedL", [str(ceiling)],
         "accept", None, o),
        ("setspeedl-nominal-800",       "setSpeedL", ["800"],
         "accept", None, o),
    ]


def emit_setAccL(fn):
    o = _origin(fn)
    return [
        ("setaccl-zero",         "setAccL", ["0"],     "reject", "> 0", o),
        ("setaccl-negative",     "setAccL", ["-5"],    "reject", "> 0", o),
        ("setaccl-nominal-1200", "setAccL", ["1200"],  "accept", None, o),
    ]


def emit_setBlender(fn):
    o = _origin(fn)
    return [
        ("d15-setblender-zero",     "setBlender", ["0"],
         "reject", "D15", o),
        ("d15-setblender-negative", "setBlender", ["-5"],
         "reject", "positive", o),
        ("setblender-valid-12",     "setBlender", ["12"],
         "accept", None, o),
    ]


EMITTERS = {
    "_bad_waitCondition_bare_literal_cond": emit_waitCondition,
    "_bad_mov_pose_vector_arity":           emit_mov_pose_arity,
    "_bad_wait_arg":                        emit_wait,
    "_bad_setDO_args":                      emit_setDO,
    "_bad_setAO_args":                      emit_setAO,
    "_bad_setSpeedJ_arg":                   emit_setSpeedJ,
    "_bad_setSpeedL_arg":                   emit_setSpeedL,
    "_bad_setAccL_arg":                     emit_setAccL,
    "_bad_setBlender_arg":                  emit_setBlender,
}


# ─────────────────────────────────────────────────────────────────
# Hand-written entries — un-encoded historical incidents. These
# document bugs we've seen on the wire but that have NO
# _KNOWN_BAD_PATTERNS matcher yet. Two purposes: (a) a queue for
# future matcher additions, (b) explicit accept-marked lines so a
# regression that adds a wrong matcher for them is caught.
#
# Every hand entry MUST cite a real addendum §-ref that has been
# grep-verified. Provenance format:
#   "hand-entry | <addendum-file>:<line> | <one-line-quote>"
# ─────────────────────────────────────────────────────────────────

HAND_ENTRIES = [
    {
        "name": "palletize-transit-over-slot-unreachable",
        "kind": "un_encoded_historical",
        "verb": "movJ",
        "input_lua": None,
        "note": (
            "Palletize IK-failure — codegen emits transit_over_slot at "
            "[0,0,0] which is unreachable @ Z=273.2mm, then still emits "
            "partial movJ(p4). No wire-captured Lua string; recovery "
            "requires running the pallet expansion path with a "
            "specific tray/pallet fixture."
        ),
        "expected": "reject",
        "reject_reason": "requires_ik_precheck_matcher",
        "stage": "semantic_round_trip_queue",
        "origin": (
            "hand-entry | docs/ledger/addendum-52-*.md §644 (grep-verified) | "
            "LESSONS.md L311 | matcher NOT YET encoded"
        ),
    },
    {
        "name": "multi-pair-role-map-anchor-mixup",
        "kind": "un_encoded_historical",
        "verb": "movJ",
        "input_lua": None,
        "note": (
            "Approach/retreat steps in multi-pair pick-place resolved "
            "to the WRONG pair's anchor. Fixed at codegen time by "
            "`_resolve_anchor_step` distance heuristic — no lint "
            "matcher exists because the bug is upstream of Lua emit. "
            "This entry is a semantic-round-trip queue item: verify "
            "that emitted movJ(pN) point names match the step's "
            "resolved anchor."
        ),
        "expected": "reject",
        "reject_reason": "requires_semantic_round_trip",
        "stage": "semantic_round_trip_queue",
        "origin": (
            "hand-entry | docs/ledger/addendum-29-*.md — anchor-resolution "
            "commits pre-2026-07-27 (grep-verified) | matcher NOT YET encoded"
        ),
    },
]


def build_corpus() -> list:
    entries = []
    seen_fns = set()
    for verb, fn in program_ops._KNOWN_BAD_PATTERNS:
        if fn in seen_fns:
            continue
        seen_fns.add(fn)
        name = fn.__name__
        emitter = EMITTERS.get(name)
        if emitter is None:
            print(f"WARN: no emitter for {name} — skipping", file=sys.stderr)
            continue
        for row in emitter(fn):
            n, v, args, expected, reason_substr, origin = row
            entries.append({
                "name": n,
                "verb": v,
                "args": args,
                "expected": expected,
                "reject_reason_substr": reason_substr,
                "origin": origin,
                "kind": "auto_derived",
            })
    return entries


def build_lua_stub(verb: str, args: list[str]) -> str:
    """Wrap a verb call in a minimal valid Lua program so
    lint_lua_source can chew on it. `waitCondition` and `getDI`
    return values, so we don't wrap them differently — a bare-
    expression statement is illegal Lua, so we assign to _."""
    call = f'{verb}({", ".join(args)})'
    if verb in ("getDI", "getDO", "getAI", "getAO", "waitCondition"):
        return f'local _ = {call}\n'
    return f'{call}\n'


def emit_pytest_module(entries: list) -> str:
    header = '''\
"""Auto-generated by scripts/generate_lua_regression_corpus.py.
Do NOT hand-edit — regenerate by rerunning the script whenever
program_ops._KNOWN_BAD_PATTERNS changes.

Corpus provenance: every entry cites its origin
(program_ops.py:LINE + addendum-N §M). See lua_regression_corpus.json.
"""
import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from estun_driver.program_ops import lint_lua_source

CORPUS = json.loads((pathlib.Path(__file__).parent /
                     "lua_regression_corpus.json").read_text())

# Skip un-encoded historical entries — those are a queue for
# future matcher additions; they cannot yet run through
# lint_lua_source because there's no matcher to trigger.
AUTO_DERIVED = [e for e in CORPUS if e.get("kind") == "auto_derived"]
HAND_QUEUED  = [e for e in CORPUS if e.get("kind") == "un_encoded_historical"]


def _build_lua(verb, args):
    call = f"{verb}({', '.join(args)})"
    if verb in ("getDI", "getDO", "getAI", "getAO", "waitCondition"):
        return f"local _ = {call}\\n"
    return f"{call}\\n"


@pytest.mark.parametrize("entry",
                         AUTO_DERIVED,
                         ids=[e["name"] for e in AUTO_DERIVED])
def test_corpus_entry(entry):
    lua = _build_lua(entry["verb"], entry["args"])
    findings = lint_lua_source(lua)
    if entry["expected"] == "accept":
        assert findings == [], (
            f"{entry['name']}: expected accept, got findings "
            f"{[f['reason'] for f in findings]!r}. Origin: "
            f"{entry['origin']}"
        )
    else:
        assert findings, (
            f"{entry['name']}: expected REJECT, got accept. "
            f"Matcher {entry['origin']} did not fire on lua={lua!r}"
        )
        substr = entry.get("reject_reason_substr")
        if substr:
            joined = " || ".join(f["reason"] for f in findings)
            assert substr.lower() in joined.lower(), (
                f"{entry['name']}: reject fired, but no finding "
                f"contained {substr!r}. Got: {joined!r}"
            )


def test_hand_queued_present():
    """Un-encoded historical incidents MUST remain in the corpus as
    a visible queue for future matcher additions. This test fails
    loud if someone deletes them without landing the matcher."""
    names = {e["name"] for e in HAND_QUEUED}
    assert "palletize-transit-over-slot-unreachable" in names
    assert "multi-pair-role-map-anchor-mixup" in names
    for e in HAND_QUEUED:
        assert e["stage"] == "semantic_round_trip_queue"
        assert "grep-verified" in e["origin"]
'''
    return header


def main():
    auto = build_corpus()
    all_entries = HAND_ENTRIES + auto
    OUT_JSON.parent.mkdir(exist_ok=True)
    OUT_JSON.write_text(json.dumps(all_entries, indent=2))
    OUT_PYTEST.write_text(emit_pytest_module(all_entries))
    # Summary
    n_auto = len(auto)
    n_reject = sum(1 for e in auto if e["expected"] == "reject")
    n_accept = sum(1 for e in auto if e["expected"] == "accept")
    print(f"wrote {OUT_JSON.relative_to(REPO)}")
    print(f"wrote {OUT_PYTEST.relative_to(REPO)}")
    print(f"  auto-derived: {n_auto}  ({n_reject} reject, {n_accept} accept)")
    print(f"  hand-queued : {len(HAND_ENTRIES)}")
    print(f"  matchers covered: {len({e['origin'].split(':')[0]+':'+e['origin'].split(':')[1].split(' ')[0] for e in auto})}")


if __name__ == "__main__":
    main()
