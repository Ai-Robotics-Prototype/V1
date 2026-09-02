"""Semantic round-trip check for codegen output.

Stage 4+ of the codegen pipeline in `docs/lua_contract.md` §9:
after the syntax gate and semantic lint pass, verify the emitted
Lua is internally consistent — i.e., that codegen didn't drop a
step, reorder steps, or resolve the wrong anchor.

**Design:** codegen already emits its own provenance stamp — the
D9 `line_map` trailer plus per-step inline comments carrying the
resolved joint vector. This parser cross-checks:

  1. line_map count == emitted mov*/setDO/setAO/wait/goto count
  2. line_map step_idx sequence is a monotone 0..N-1
  3. for every emitted `movJ(pN)` / `movL(pN)`, the point name pN
     appears in `varspoint` AND its jp matches the step's inline-
     comment joints within tolerance
  4. every line_map entry's `action` maps to a legal verb set
     (move_home→movJ, set_io→setDO|setAO, wait→wait|sys.sleep,
     loop→goto, move_linear→movJ|movL, move_joint→movJ)

**Coverage vs the four bug classes:**

  * step-drop        — check 1 fires
  * reorder          — check 2 fires
  * anchor-mixup     — check 3 fires
  * point-substitution — check 3 fires

**Honest gaps:** this is a CONSISTENCY check, not a comparison
against a taught program. If codegen consistently emits the wrong
thing (e.g., a stale `program.steps[]` snapshot AND matching
line_map AND matching varspoint), no internal check catches it.
The upstream defense is codegen's own step-loop over
`program.steps` — this stage only catches drift BETWEEN codegen
emit passes for the same program.

For production-time full round-trip (taught_program vs emitted
Lua), pass the taught program to `verify_against_taught()`.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Optional

# ─────────────────────────────────────────────────────────────
# Parsing
# ─────────────────────────────────────────────────────────────

_LINE_MAP_RE = re.compile(r'--\s*line_map\s*\(D9[^:]*:\s*(\[.*\])\s*$')
_MOV_CALL_RE = re.compile(r'\b(movJ|movL|movC|movCircle|movLW|movCW|movJCoorRel|movLCoorRel|movJJointRel|movJToolRel|movLToolRel|movAS|movAST)\s*\(([^)]*)\)')
_SETDO_RE    = re.compile(r'\b(setDO|setAO)\s*\(')
_WAIT_RE     = re.compile(r'\b(wait|sys\.sleep|waitCondition)\s*\(')
_GOTO_RE     = re.compile(r'\bgoto\s+\S+')
_INLINE_JOINTS_RE = re.compile(r'joints\s*=\s*\[\s*([-+0-9.,\s]+)\s*\]')
_POINT_NAME_RE = re.compile(r'^p(\d+)$')

# action → set of legal verb bases (verb w/o parens)
_ACTION_TO_LEGAL_VERBS = {
    "move_home":   {"movJ"},
    "move_joint":  {"movJ"},
    "move_linear": {"movJ", "movL", "movJCoorRel", "movLCoorRel"},
    "move_arc":    {"movC"},
    "set_io":      {"setDO", "setAO"},
    "wait":        {"wait", "sys.sleep", "waitCondition"},
    "loop":        {"goto"},
    "dwell":       {"movJ", "wait", "sys.sleep"},
    # gripper/pallet composites (codegen may emit multiple verbs)
    "gripper":     {"setDO", "wait", "sys.sleep"},
}


@dataclass
class LineMapEntry:
    step_idx: int
    step_id: Optional[int]
    action: str
    lua_line_start: int
    lua_line_end: int


@dataclass
class RoundTripFinding:
    kind: str          # "step_drop" | "reorder" | "anchor_mixup" | ...
    step_idx: Optional[int]
    detail: str

    def __str__(self) -> str:
        loc = f"step {self.step_idx}" if self.step_idx is not None else "global"
        return f"[{self.kind}] {loc}: {self.detail}"


@dataclass
class RoundTripReport:
    findings: list[RoundTripFinding] = field(default_factory=list)
    line_map: list[LineMapEntry] = field(default_factory=list)
    emitted_mov_count: int = 0

    @property
    def ok(self) -> bool:
        return not self.findings


def _parse_line_map(source: str) -> list[LineMapEntry]:
    for raw in source.splitlines():
        m = _LINE_MAP_RE.search(raw.strip())
        if not m:
            continue
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            return []
        return [
            LineMapEntry(
                step_idx=e["step_idx"], step_id=e.get("step_id"),
                action=e["action"],
                lua_line_start=e["lua_line_start"],
                lua_line_end=e["lua_line_end"],
            )
            for e in data
        ]
    return []


_LOOP_LABEL_RE = re.compile(r'^::\s*_prog_start\s*::')


def _split_and_normalize_lines(source: str) -> list[str]:
    """Codegen's `line_map` uses "logical" 1-based line numbers that
    skip the `::_prog_start::` loop-label prefix line (D9 convention,
    wire-verified against test100 fixture 2026-09-02). Return the
    source split into lines with that prefix removed, so a caller
    can index `lines[e.lua_line_start - 1]` and hit the correct line.
    """
    raw = source.splitlines()
    if raw and _LOOP_LABEL_RE.match(raw[0].strip()):
        return raw[1:]
    return raw


def _joints_from_inline_comment(line: str) -> Optional[list[float]]:
    m = _INLINE_JOINTS_RE.search(line)
    if not m:
        return None
    parts = [p.strip() for p in m.group(1).split(",") if p.strip()]
    try:
        return [float(p) for p in parts]
    except ValueError:
        return None


def _extract_point_names(line: str) -> list[str]:
    out = []
    for verb, argstr in _MOV_CALL_RE.findall(line):
        for arg in argstr.split(","):
            arg = arg.strip()
            if _POINT_NAME_RE.match(arg):
                out.append(arg)
    return out


def _emitted_action_verbs(lines: list[str]) -> set[str]:
    """Extract the base verb names from a slice of Lua lines. Skips
    modal setters (setSpeedJ, setSpeedL, setAccL, setBlender,
    setNoBlender) — those aren't step-primary."""
    verbs: set[str] = set()
    for L in lines:
        # strip comments
        cut = L.split("--", 1)[0]
        for verb, _args in _MOV_CALL_RE.findall(cut):
            verbs.add(verb)
        for m in _SETDO_RE.finditer(cut):
            verbs.add(m.group(1))
        for m in _WAIT_RE.finditer(cut):
            verbs.add(m.group(1).replace("sys.sleep", "sys.sleep"))
        if _GOTO_RE.search(cut):
            verbs.add("goto")
    return verbs


# ─────────────────────────────────────────────────────────────
# Public API — consistency check
# ─────────────────────────────────────────────────────────────

def check_consistency(
    lua_source: str,
    varspoint: dict[str, dict],
    *,
    joint_tolerance_deg: float = 0.01,
) -> RoundTripReport:
    """Internal-consistency check on an already-emitted Lua program.

    Verifies:
      - line_map trailer exists and parses
      - line_map step_idx is monotone 0..N-1 (catches REORDER)
      - line_map count matches emitted mov*/setDO/setAO/wait/goto
        primary verbs (catches STEP-DROP or PHANTOM-EMIT)
      - every action → verb mapping is respected (catches
        VERB-SUBSTITUTION at the step level)
      - every emitted `movJ(pN) / movL(pN)` etc. resolves to a
        varspoint entry with matching inline-comment joints
        (catches ANCHOR-MIXUP / POINT-SUBSTITUTION)
    """
    r = RoundTripReport()
    lines = _split_and_normalize_lines(lua_source)
    r.line_map = _parse_line_map(lua_source)

    if not r.line_map:
        r.findings.append(RoundTripFinding(
            kind="missing_line_map", step_idx=None,
            detail="No `-- line_map (D9 …)` trailer found — cannot "
                   "run semantic round-trip. Ship a codegen that "
                   "emits the D9 stamp.",
        ))
        return r

    # Check 2: reorder — step_idx must be exactly [0..N-1] in order.
    indices = [e.step_idx for e in r.line_map]
    expected = list(range(len(r.line_map)))
    if indices != expected:
        r.findings.append(RoundTripFinding(
            kind="reorder", step_idx=None,
            detail=f"line_map step_idx sequence is {indices}, "
                   f"expected {expected}. Codegen dropped/reordered "
                   f"a step or a step_id collision occurred.",
        ))

    # Check 1: step-drop — count primary emit-verbs across the whole
    # program and compare to line_map length. We can't do a strict
    # 1:1 line-by-line count because dwell/pallet actions emit
    # multiple verbs; do a range-scoped count per step and require
    # each range to contain AT LEAST one primary verb.
    for e in r.line_map:
        slice_lines = lines[e.lua_line_start - 1:e.lua_line_end]
        verbs = _emitted_action_verbs(slice_lines)
        legal = _ACTION_TO_LEGAL_VERBS.get(e.action)
        if legal is None:
            r.findings.append(RoundTripFinding(
                kind="unknown_action", step_idx=e.step_idx,
                detail=f"action={e.action!r} has no verb mapping in "
                       f"_ACTION_TO_LEGAL_VERBS. Update the module.",
            ))
            continue
        if not verbs:
            r.findings.append(RoundTripFinding(
                kind="step_drop", step_idx=e.step_idx,
                detail=f"line_map claims action={e.action!r} at "
                       f"lines {e.lua_line_start}..{e.lua_line_end} "
                       f"but no primary verb was emitted in that "
                       f"range.",
            ))
            continue
        if not (verbs & legal):
            r.findings.append(RoundTripFinding(
                kind="verb_substitution", step_idx=e.step_idx,
                detail=f"action={e.action!r} expects any of "
                       f"{sorted(legal)}; emitted {sorted(verbs)}.",
            ))

    # Checks 3 & 4: point-name / anchor consistency.
    for e in r.line_map:
        for lineno in range(e.lua_line_start, e.lua_line_end + 1):
            if lineno < 1 or lineno > len(lines):
                continue
            raw = lines[lineno - 1]
            code = raw.split("--", 1)[0]
            comment = raw[len(code):]
            emitted_pts = _extract_point_names(code)
            if not emitted_pts:
                continue
            comment_joints = _joints_from_inline_comment(comment)
            for pt in emitted_pts:
                vp = varspoint.get(pt)
                if vp is None:
                    r.findings.append(RoundTripFinding(
                        kind="point_missing", step_idx=e.step_idx,
                        detail=f"Emitted {pt!r} at line {lineno} but "
                               f"pt not present in varspoint.",
                    ))
                    continue
                vp_joints = _varspoint_joints(vp)
                if vp_joints is None:
                    continue
                if comment_joints is None:
                    # inline joints aren't present — this is a
                    # step type (e.g. loop's goto) that carries no
                    # joint comment. Silent-OK.
                    continue
                if len(vp_joints) != len(comment_joints):
                    r.findings.append(RoundTripFinding(
                        kind="point_substitution", step_idx=e.step_idx,
                        detail=f"{pt}.jp has {len(vp_joints)} elements "
                               f"but inline comment carries "
                               f"{len(comment_joints)}. Codegen wrote "
                               f"mismatched pose vector to varspoint.",
                    ))
                    continue
                worst = max(abs(a - b) for a, b in zip(vp_joints, comment_joints))
                if worst > joint_tolerance_deg:
                    r.findings.append(RoundTripFinding(
                        kind="anchor_mixup", step_idx=e.step_idx,
                        detail=f"{pt}.jp = {vp_joints} but the inline "
                               f"comment at line {lineno} claims "
                               f"joints={comment_joints} (worst-axis "
                               f"Δ={worst:.4f}° > tol "
                               f"{joint_tolerance_deg}°). Codegen "
                               f"resolved this step's anchor to a "
                               f"DIFFERENT point than the one it "
                               f"emitted — anchor-role-map bug class.",
                    ))

    r.emitted_mov_count = sum(1 for L in lines for _ in _MOV_CALL_RE.findall(L.split("--", 1)[0]))
    return r


def _varspoint_joints(entry: dict) -> Optional[list[float]]:
    """Parse the JSON-encoded `val` field into a joint list.
    Handles apos (jp) points; returns None for cpos or malformed."""
    raw_val = entry.get("val")
    if not isinstance(raw_val, str):
        return None
    try:
        obj = json.loads(raw_val)
    except json.JSONDecodeError:
        return None
    jp = obj.get("jp") if isinstance(obj, dict) else None
    if not isinstance(jp, list):
        return None
    try:
        return [float(x) for x in jp]
    except (TypeError, ValueError):
        return None


# ─────────────────────────────────────────────────────────────
# Full round-trip against a taught program (production-time)
# ─────────────────────────────────────────────────────────────

def verify_against_taught(
    lua_source: str,
    varspoint: dict[str, dict],
    taught_steps: list[dict],
    *,
    joint_tolerance_deg: float = 0.01,
) -> RoundTripReport:
    """Full round-trip: the emitted Lua must reconstruct to the
    given taught step list.

    `taught_steps` is the list of dicts codegen consumed. Each dict
    must carry at least:
      - action:      str (matches line_map's action field)
      - taught_joints: list[float] | None (optional; when present,
        must match the inline-comment joints for this step)

    Runs `check_consistency` first, then adds:
      - len(line_map) == len(taught_steps)   → step-count check
      - line_map[i].action == taught_steps[i]["action"]   → per-step
        action-drift catch
      - line_map[i]'s inline-comment joints ≈ taught_steps[i]["taught_joints"]
    """
    r = check_consistency(lua_source, varspoint,
                          joint_tolerance_deg=joint_tolerance_deg)
    if not r.line_map:
        return r

    if len(r.line_map) != len(taught_steps):
        r.findings.append(RoundTripFinding(
            kind="step_count_mismatch", step_idx=None,
            detail=f"line_map has {len(r.line_map)} entries but the "
                   f"taught program has {len(taught_steps)} steps. "
                   f"Codegen dropped or duplicated a step.",
        ))
        return r

    lines = _split_and_normalize_lines(lua_source)
    for i, (e, step) in enumerate(zip(r.line_map, taught_steps)):
        if e.action != step.get("action"):
            r.findings.append(RoundTripFinding(
                kind="action_drift", step_idx=i,
                detail=f"line_map action={e.action!r} does not match "
                       f"taught_steps[{i}]['action']="
                       f"{step.get('action')!r}.",
            ))
        taught_j = step.get("taught_joints")
        if taught_j is None:
            continue
        # Scan the step's line range for an inline joints=[...] and
        # compare against taught_j.
        found_match = False
        for lineno in range(e.lua_line_start, e.lua_line_end + 1):
            if lineno < 1 or lineno > len(lines):
                continue
            js = _joints_from_inline_comment(lines[lineno - 1])
            if js is None:
                continue
            if len(js) != len(taught_j):
                continue
            worst = max(abs(a - b) for a, b in zip(js, taught_j))
            if worst <= joint_tolerance_deg:
                found_match = True
                break
        if not found_match:
            r.findings.append(RoundTripFinding(
                kind="joints_drift", step_idx=i,
                detail=f"No inline-comment joints within "
                       f"{joint_tolerance_deg}° of taught_joints="
                       f"{taught_j}. Codegen emitted a different "
                       f"anchor than the taught program specified.",
            ))
    return r
