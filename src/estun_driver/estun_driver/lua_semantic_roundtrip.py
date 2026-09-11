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
# G4 (2026-09-02): counted-loop closer. Codegen has two loop
# emit styles — labeled goto (uncounted continuous) and for..end
# (counted N-iteration). Both are valid loop step emissions.
_FOR_END_RE  = re.compile(r'\b(for\s+\w+\s*=|end\b)')
_INLINE_JOINTS_RE = re.compile(r'joints\s*=\s*\[\s*([-+0-9.,\s]+)\s*\]')
_POINT_NAME_RE = re.compile(r'^p(\d+)$')

# action → set of legal verb bases (verb w/o parens).
# Source: _NON_MOTION_ACTIONS_FOR_TAUGHT_CHECK + motion actions in
# program_ops.py:1379-1388 + the movement actions codegen tests
# for at lines 4063 / 1774 etc. Keep in sync when new actions land.
_ACTION_TO_LEGAL_VERBS = {
    # Motion
    "move_home":         {"movJ"},
    "move_joint":        {"movJ"},
    "move_linear":       {"movJ", "movL", "movJCoorRel", "movLCoorRel"},
    "move_arc":          {"movC"},
    "move_to_pallet":    {"movJ", "movL", "movJCoorRel"},
    # IO
    "set_io":            {"setDO", "setAO"},
    # Timing
    "wait":              {"wait", "sys.sleep", "waitCondition"},
    "dwell":             {"movJ", "wait", "sys.sleep"},
    # Control flow
    "loop":              {"goto", "for_end"},
    "pause":             {"wait", "sys.sleep", "waitCondition"},
    # Composites (codegen may emit multiple verbs per step)
    "gripper":           {"setDO", "wait", "sys.sleep"},
    "gripper_close":     {"setDO", "wait", "sys.sleep"},
    "gripper_open":      {"setDO", "wait", "sys.sleep"},
    "vacuum_on":         {"setDO", "wait", "sys.sleep"},
    "vacuum_off":        {"setDO", "wait", "sys.sleep"},
    # Input-conditional (G3 addition — pallet detect uses waitCondition/getDI)
    "wait_input":        {"waitCondition", "getDI"},
    "verify_input":      {"waitCondition", "getDI"},
    "detect":            {"waitCondition", "getDI", "setDO"},
    "scan_workspace":    {"waitCondition", "getDI", "setDO"},
    "scan_identify_each":{"waitCondition", "getDI", "setDO"},
    "sort_scanned":      {"waitCondition", "getDI", "setDO", "movJ", "movL"},
    "remove_defects":    {"waitCondition", "getDI", "setDO", "movJ", "movL"},
    # No-op step kinds — codegen emits comment-only ranges
    "comment":           set(),
    "end":               set(),
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
    # True when the program lacks a D9 line_map trailer entirely
    # (pre-D9-era legacy program). Callers should treat this as
    # "unverifiable, not caught" — the semantic RT gate can only
    # run on codegen-emitted programs from 2026-08-04+.
    legacy_no_line_map: bool = False

    @property
    def ok(self) -> bool:
        return not self.findings

    @property
    def verifiable(self) -> bool:
        """False when the program pre-dates the D9 stamp — sweep
        classifier should route to UNVERIFIABLE, not CAUGHT."""
        return not self.legacy_no_line_map


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

# G5 (2026-09-02): codegen-signaled non-emission markers.
#
# `-- skipped 'X': no point_name/points ref` — codegen safety-skip
#   when a step lacks taught data. LEGITIMATE only when the skipped
#   action is a non-motion class (detect, comment, etc.); a skipped
#   move_* is a REAL pending-pose defect (D14 companion).
#
# `-- absorbed into move_to_pallet cycle` — pallet composite
#   deferral. The step's actual emit lives downstream in the
#   move_to_pallet expansion; the individual line_map entry acts
#   as a placeholder. LEGITIMATE for any action that names the
#   pallet cycle as its parent.
_SKIPPED_RE   = re.compile(r"--\s*skipped\s+'([^']+)':")
_ABSORBED_RE  = re.compile(r"--\s*absorbed\s+into\s+move_to_pallet\s+cycle")
# G6 (2026-09-02): codegen-time refusal markers for palletize.
# §644 IK-unreachable class + config-incomplete class. Codegen
# emits these instead of a bad expansion. Sweep must surface as
# CAUGHT with the pallet_ik_refused kind, not generic step_drop.
_PALLET_IK_FAIL_RE = re.compile(r"--\s*PALLET\s+IK\s+FAILED:")
_PALLET_REFUSED_RE = re.compile(r"--\s*REFUSED\s+'move_to_pallet':")

_MOTION_ACTIONS = frozenset({
    "move_home", "move_joint", "move_linear", "move_arc",
    "move_to_pallet",
})


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
        # G4: counted-loop markers count as loop-step emissions.
        if _FOR_END_RE.search(cut):
            verbs.add("for_end")
    return verbs


# ─────────────────────────────────────────────────────────────
# Reachability — joint-limit envelope for S10-140
# ─────────────────────────────────────────────────────────────
#
# Source: HARDWARE.md §Joint limits (live from Config→Safety,
# enforced): J1/J2/J4/J5/J6 = ±200°, J3 = ±166°.
# Addendum-12 §115, addendum-14 §134.
#
# §644 IK-unreachable class: codegen expands a pallet transit_over_
# slot to a cartesian point that has no valid joint solution within
# limits. The failing symptom is a jp vector whose components exceed
# these limits (or that IK couldn't solve and codegen still emitted
# a partial/garbage jp). This matcher catches both by verifying
# every varspoint jp element is inside the envelope.
#
# NOTE: this is a JOINT-limit check only. True cartesian
# reachability (does the wrist-decoupled IK have a solution?)
# requires forward kinematics + IK solver, which is out of scope
# for a lint-time gate. But since the varspoint IS what goes to
# the wire, and every taught/computed jp must be inside limits,
# this catches the on-the-wire manifestation of §644.

_S10_140_JOINT_LIMITS_DEG = [200.0, 200.0, 166.0, 200.0, 200.0, 200.0]


def _check_reachability(varspoint: dict[str, dict]) -> list[RoundTripFinding]:
    """For every apos point in varspoint, verify every jp[i] is
    inside ±_S10_140_JOINT_LIMITS_DEG[i]. Returns a list of
    unreachable_joint_limit findings — empty on clean varspoint."""
    findings: list[RoundTripFinding] = []
    for pt_name, entry in varspoint.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("postype") not in ("jp", None):
            # cpos points are checked implicitly through their rj
            # field if present; skip pure-cartesian for now.
            pass
        jp = _varspoint_joints(entry)
        if jp is None:
            continue
        for i, val in enumerate(jp):
            if i >= len(_S10_140_JOINT_LIMITS_DEG):
                findings.append(RoundTripFinding(
                    kind="unreachable_joint_count", step_idx=None,
                    detail=f"varspoint[{pt_name}].jp has {len(jp)} "
                           f"axes; S10-140 has 6. "
                           f"External-axis pose in a wrong slot?",
                ))
                break
            limit = _S10_140_JOINT_LIMITS_DEG[i]
            if abs(val) > limit:
                findings.append(RoundTripFinding(
                    kind="unreachable_joint_limit", step_idx=None,
                    detail=(
                        f"varspoint[{pt_name}].jp[{i}] = {val:+.4f}° "
                        f"exceeds S10-140 J{i+1} soft limit "
                        f"±{limit:.1f}° (HARDWARE.md §Joint limits, "
                        f"addendum-12 §115). §644-class hazard: an "
                        f"unreachable pose reached the wire — either "
                        f"IK returned garbage or the taught apos was "
                        f"never validated."),
                ))
    return findings


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
        # G1: legacy program pre-D9-stamp (before 2026-08-04). Not
        # a defect for the RT checks — flag as unverifiable so the
        # sweep classifier routes to UNVERIFIABLE instead of CAUGHT.
        # BUT reachability still runs (§644 doesn't depend on D9).
        r.legacy_no_line_map = True
        r.findings.extend(_check_reachability(varspoint or {}))
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
        if not legal:
            # No-op step kinds (comment/end) — codegen legitimately
            # emits an empty range; skip verb checks.
            continue
        if not verbs:
            # G5+G6: recognize codegen-signaled non-emission markers.
            raw_slice = "\n".join(slice_lines)
            absorbed = bool(_ABSORBED_RE.search(raw_slice))
            skipped_m = _SKIPPED_RE.search(raw_slice)
            ik_fail_m = _PALLET_IK_FAIL_RE.search(raw_slice)
            pallet_refused_m = _PALLET_REFUSED_RE.search(raw_slice)
            if ik_fail_m or pallet_refused_m:
                # G6: codegen-time refusal of a pallet expansion.
                # This IS the §644 hand-queued class from the
                # regression corpus — now surfaced with an
                # explicit finding kind instead of generic
                # step_drop. The refusing comment carries the
                # operator-facing reason (unreachable Z, missing
                # config field, etc.).
                reason_line = next(
                    (L.strip() for L in slice_lines
                     if "-- PALLET IK FAILED" in L
                     or "-- REFUSED 'move_to_pallet'" in L),
                    "(marker present)",
                )
                r.findings.append(RoundTripFinding(
                    kind="pallet_ik_refused", step_idx=e.step_idx,
                    detail=(
                        f"codegen refused this pallet expansion at "
                        f"generation time — the program is on the "
                        f"controller in a run-broken state. Marker: "
                        f"{reason_line[:180]}"),
                ))
                continue
            if absorbed:
                # Composite deferral — real emit happens downstream.
                continue
            if skipped_m:
                skipped_action = skipped_m.group(1)
                if e.action not in _MOTION_ACTIONS:
                    # Skipping a non-motion action (detect, etc.)
                    # is a codegen no-op; nothing to run, nothing
                    # to worry about.
                    continue
                # Motion action skipped → real pending-pose defect.
                r.findings.append(RoundTripFinding(
                    kind="pending_pose_skip", step_idx=e.step_idx,
                    detail=f"action={e.action!r} was skipped by "
                           f"codegen (marker: 'skipped {skipped_action}') "
                           f"— the step lacks taught data. Program is "
                           f"unsafe to run: the arm will pass over this "
                           f"step in silence, likely leaving it in an "
                           f"unexpected pose for the next motion. Teach "
                           f"the pose and re-save.",
                ))
                continue
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

    # Reachability — joint-limit envelope over every varspoint jp.
    # This is the §644 IK-unreachable class matcher; runs whether
    # or not a D9 line_map is present.
    r.findings.extend(_check_reachability(varspoint or {}))

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
