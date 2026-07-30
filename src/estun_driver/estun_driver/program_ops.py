"""Program-execution helpers for the Estun driver.

Split into three concerns:

  1. Lua codegen — turns our taught-program IR (list of steps with
     6-joint `taught_joints`) into Lua 5.3 source that the controller
     will accept, plus a `varspoint` dict of named points.

  2. HTTP save — POSTs the source + points + registry entries to the
     controller's HTTP API (port 9198, `/api/robotcode/` +
     `/api/robotjson/`). Discovered from the factory UI bundle's
     `useProjectSave` composable.

  3. ProjectState / Error parsing — the frames the driver receives on
     `publish/ProjectState` and `publish/Error`; kept out of the driver
     node so unit tests can exercise the reflood-dedup logic without
     spinning up rclpy.

None of this touches ROS directly. The driver imports these helpers
and calls them from its own subscriber callbacks so the gate check
lives in one place.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re as _re
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any, Iterable

try:
    import numpy as _np
except ImportError:  # numpy not installed → SeededIK.available() == False
    _np = None


# ────────────────────────────────────────────────────────────────
# Seeded IK for wrist re-solve avoidance (Part C)
# ────────────────────────────────────────────────────────────────
#
# The wizard-derived "lift" steps (place_lift, retreat, etc. with
# `derived_from` + non-trivial `offset_z_mm`) previously round-tripped
# through movL / movJCoorRel with a base-frame Z offset — both allowed
# the controller's IK to pick a DIFFERENT J4/J5/J6 branch than the
# taught anchor. On real hardware this shows up as the wrist spinning
# ~50° between anchor and the "lift" step (operator observed
# taught J5≈89° vs runtime J5≈138° on testwizard step 7 / step 14).
#
# The fix implemented here computes the lifted joint solution AT
# CODEGEN TIME, seeded from the anchor's taught_joints, using the
# same fitted DH the driver's SingularityGuard uses (pos RMS 0.025 mm
# on the held-out test set). Wrist joints (J4, J5, J6) are held at
# their taught values — only J1/J2/J3 solve for the vertical lift.
# The emitted step is a plain `movJ(<name>)` referencing a fresh jp
# varspoint entry with the computed joints, so:
#   * no controller-side IK runs → no branch choice → no wrist flip;
#   * J5 is EXACTLY the taught value (delta 0 by construction);
#   * the emitted move can never be a zero-length movL (it's a movJ,
#     and zero-Δq is a no-op the controller tolerates).
#
# When the geometric shift can't be achieved by J1/J2/J3 alone
# (tool orientation far from vertical, or Δz outside the reachable
# manifold at this anchor pose), the seeded IK returns None and the
# caller falls back to movJCoorRel — with a loud comment.

# Fitted DH copied verbatim from estun_driver_node.py's SingularityGuard.
# Source: config/dh_fit_report.txt (stage-B fixed-xyz fit).
# Row per joint: (a_mm, alpha_deg, d_mm, theta_off_deg).
_FITTED_DH_STD = [
    (-0.00002,     90.00058,   325.89611, -179.99989),  # J1
    (-701.00394,    0.00028,  -579.68908,  -90.00022),  # J2
    (-538.58526,  180.00313,  -214.01833,   -0.00615),  # J3
    (-0.00374,    -89.99857, -1000.00000,  -90.00736),  # J4
    ( 0.00533,     89.99433,  -161.46726,  179.99693),  # J5
    (-0.00155,     -0.00674,   150.49959,    0.00152),  # J6
]
_FITTED_BASE_Z_MM = -139.89595


def _dh_transform(theta, d_mm, a_mm, alpha):
    """Standard DH: T = Rz(θ) · Tz(d) · Tx(a) · Rx(α). Returns 4×4."""
    ct = math.cos(theta); st = math.sin(theta)
    ca = math.cos(alpha); sa = math.sin(alpha)
    return _np.array([
        [ct, -st*ca,  st*sa, a_mm*ct],
        [st,  ct*ca, -ct*sa, a_mm*st],
        [0.0,    sa,     ca, d_mm  ],
        [0.0,   0.0,    0.0, 1.0   ],
    ])


def _fk_chain(q_deg):
    """Forward kinematics for the fitted DH. Returns a list T_0..T_6
    (each a 4x4 numpy array). T_6[:3, 3] is the flange (mm) in the
    driver's base_link frame (with the _FITTED_BASE_Z_MM shift)."""
    T = _np.eye(4)
    T[2, 3] = _FITTED_BASE_Z_MM
    Ts = [T]
    for i in range(6):
        a_mm, alpha_deg, d_mm, theta_off_deg = _FITTED_DH_STD[i]
        theta = math.radians(q_deg[i] + theta_off_deg)
        Ti = _dh_transform(theta, d_mm, a_mm, math.radians(alpha_deg))
        T = T @ Ti
        Ts.append(T)
    return Ts


def _jacobian_z_arm_only(q_deg):
    """Return the 1×3 gradient of end-effector Z (mm) w.r.t. joints
    [q1, q2, q3] (deg → the same units the caller passes in). We only
    need the vertical row of the linear Jacobian since our lift Δ is
    pure base-frame Z. Held wrist joints don't contribute to Δee_z at
    codegen time — we CONSTRAIN them to zero delta so J5 is exactly
    the taught value."""
    Ts = _fk_chain(q_deg)
    p_ee = Ts[6][:3, 3]
    # z-axis of joint i frame (world frame), origin of that frame
    row = [0.0, 0.0, 0.0]
    for i in range(3):
        z = Ts[i][:3, 2]      # unit vector, no units
        p = Ts[i][:3, 3]      # mm
        dp = p_ee - p         # mm
        # (z × dp)_z = z_x*dp_y - z_y*dp_x
        row[i] = z[0] * dp[1] - z[1] * dp[0]
    # Convert d_pos_mm / d_theta_rad → d_pos_mm / d_theta_deg
    return _np.array(row) * (math.pi / 180.0)


# Max per-wrist-axis deviation allowed on a taught-contact movL
# descend before we fall back to a joint-space movJ. Rationale: the
# controller's cartesian interpolator will re-solve IK at every
# frame between endpoints. When the two endpoints AGREE on wrist
# joints (which is the SEEDED-IK common case — approach's wrist
# axes are held EXACTLY at the anchor's taught values), the IK
# has no reason to visit a different branch mid-path. When they
# DISAGREE by more than a few degrees, the mid-path IK is free to
# pick whichever branch minimises its residual at each interp
# frame, and the wrist can end up rotating tens of degrees during
# a 100 mm cartesian descend (the §354 signature). 15° is
# defensive: legitimate re-orient across a segment is rare (the
# operator's spec assumes vertical entry, orientation locked) and
# a real >15° wrist re-solve is exactly the class we're trying to
# avoid.
_WRIST_LOCK_MAX_DEG = 15.0


def _wrist_descend_safety(target_joints, last_joints):
    """Verify that a movL taught-contact descend won't need a wrist
    re-solve mid-path.

    Given the segment's endpoint joints (target) and the previous
    step's endpoint joints (last), returns a small dict:
      {'safe':   True/False,   # keep movL, or fall back to movJ
       'reason': str,          # when unsafe, why
       'j4':     float, 'j5': float, 'j6': float,   # per-axis Δ (deg)
       'max':    float}        # max wrist-axis Δ

    `last` is None when the upstream emission was movJCoorRel (the
    controller picked joints) — we treat that as UNSAFE because we
    can't verify the start wrist matches. Same rule for a program
    whose first motion happens to be a taught contact: no prior
    move to compare against, fall back to movJ.
    """
    if last_joints is None or len(last_joints) < 6:
        return {'safe': False,
                'reason': 'no known start joints (upstream movJCoorRel '
                          'or first-motion contact)',
                'j4': 0.0, 'j5': 0.0, 'j6': 0.0, 'max': 0.0}
    d4 = abs(float(target_joints[3]) - float(last_joints[3]))
    d5 = abs(float(target_joints[4]) - float(last_joints[4]))
    d6 = abs(float(target_joints[5]) - float(last_joints[5]))
    mx = max(d4, d5, d6)
    if mx > _WRIST_LOCK_MAX_DEG:
        return {'safe': False,
                'reason': (f'wrist delta {mx:.2f}° exceeds {_WRIST_LOCK_MAX_DEG:.0f}°/axis '
                           f'(J4Δ={d4:.2f}° J5Δ={d5:.2f}° J6Δ={d6:.2f}°)'),
                'j4': d4, 'j5': d5, 'j6': d6, 'max': mx}
    return {'safe': True, 'reason': '',
            'j4': d4, 'j5': d5, 'j6': d6, 'max': mx}


def _joints_equal(a, b, tol_deg: float = 0.01) -> bool:
    """Two 6-element joint vectors are 'equal' if every joint agrees
    within `tol_deg` — 0.01° covers both float noise and the
    controller's smallest advertised joint resolution."""
    if len(a) != 6 or len(b) != 6:
        return False
    for x, y in zip(a, b):
        if abs(float(x) - float(y)) > tol_deg:
            return False
    return True


def seeded_ik_z_lift(anchor_deg, delta_z_mm, *,
                     max_iter: int = 12,
                     tol_mm: float = 0.05,
                     max_dq_deg_norm: float = 15.0):
    """Compute lifted joints given an anchor pose and a base-frame Z
    lift, using Newton-Raphson on q1/q2/q3 with q4/q5/q6 held EXACTLY
    at the anchor values.

    Returns (lifted_deg, achieved_dz_mm) on success, or None if:
      * numpy is unavailable;
      * the Jacobian's ee_z column is nearly zero (singular for pure
        vertical lift at this pose — J4/J5/J6 would be needed);
      * the iteration doesn't converge below tol_mm inside max_iter;
      * the shoulder-arm joint delta ‖Δq‖ blows up beyond
        max_dq_deg_norm (this catches lifts that would require unsafe
        arm reconfiguration — the caller falls back to movJCoorRel).

    Never returns joints outside ±360° (the controller rejects those).
    """
    if _np is None:
        return None
    q = _np.array([float(v) for v in anchor_deg], dtype=float)
    if q.shape != (6,):
        return None
    Ts0 = _fk_chain(q)
    z0 = float(Ts0[6][2, 3])
    z_target = z0 + float(delta_z_mm)
    for _ in range(max_iter):
        Ts = _fk_chain(q)
        z = float(Ts[6][2, 3])
        err = z_target - z
        if abs(err) < tol_mm:
            achieved = z - z0
            # Sanity: J4/J5/J6 must be EXACTLY the anchor values
            if not (q[3] == anchor_deg[3] and q[4] == anchor_deg[4]
                    and q[5] == anchor_deg[5]):
                return None
            return q.tolist(), achieved
        J = _jacobian_z_arm_only(q.tolist())   # shape (3,), row of dz/dq
        # Minimum-norm dq_arm solve for a scalar error: dq = J^T (J J^T)^{-1} err.
        # With J of shape (3,) and viewed as a 1×3 row:
        #   J J^T = ||J||^2  (scalar)
        #   dq   = err × J / ||J||^2
        denom = float(J @ J)
        if denom < 1e-9:
            return None
        step = (err / denom) * J
        # Damp large steps
        step_norm = float(_np.linalg.norm(step))
        if step_norm > max_dq_deg_norm:
            step = step * (max_dq_deg_norm / step_norm)
        q[0] += step[0]; q[1] += step[1]; q[2] += step[2]
        # q4/q5/q6 stay at anchor (never touched)
    return None


# ────────────────────────────────────────────────────────────────
# Lua codegen
# ────────────────────────────────────────────────────────────────

# The controller writes its own Lua files with a "--Lua version 5.3
# time:YYYY-MM-DD HH:MM:SS" trailer (seen on the demo project). We
# emit the same trailer so a round-trip select/update looks
# byte-similar and the operator can eyeball diffs.
_LUA_TRAILER_FMT = '--Lua version 5.3 time:%Y-%m-%d %H:%M:%S'


def _compute_codegen_version() -> dict:
    """Snapshot at import: git sha, file sha256, mtime, import wall-clock.

    Why: 2026-07-28 bowl run got mis-attributed as a stale-codegen problem
    because nothing on the wire proved which program_ops.py version had
    produced the pushed Lua. Every codegen output now carries this stamp,
    and the run manifest records it, so /api/runs can forever answer
    'which codegen produced this run's motion.'
    """
    src_path = os.path.abspath(__file__)
    try:
        src_mtime = os.path.getmtime(src_path)
    except Exception:
        src_mtime = 0.0
    try:
        with open(src_path, 'rb') as f:
            src_sha256 = hashlib.sha256(f.read()).hexdigest()
    except Exception:
        src_sha256 = 'unknown'
    git_sha = 'nogit'
    git_dirty = False
    try:
        r = subprocess.run(
            ['git', '-C', os.path.dirname(src_path), 'rev-parse', 'HEAD'],
            capture_output=True, text=True, timeout=2.0)
        if r.returncode == 0:
            git_sha = r.stdout.strip()[:12] or 'nogit'
        # NO path filter — colcon symlink-install hardlinks build/…/foo.py
        # to src/…/foo.py, but git only tracks the src/ side, so passing
        # the build path returns empty even when the src is modified.
        # Coarse repo-dirty is the honest signal: if the codegen module
        # is being rebuilt live, SOMETHING is dirty and the operator
        # should know.
        r2 = subprocess.run(
            ['git', '-C', os.path.dirname(src_path), 'diff-index',
             '--quiet', 'HEAD', '--'],
            capture_output=True, text=True, timeout=2.0)
        # diff-index returns 1 when dirty, 0 when clean, 128 on error.
        if r2.returncode == 1:
            git_dirty = True
    except Exception:
        pass
    return {
        'git_sha':    git_sha,
        'git_dirty':  git_dirty,
        'src_sha256': src_sha256,
        'src_path':   src_path,
        'src_mtime':  src_mtime,
        'import_ts':  time.time(),
    }


CODEGEN_VERSION = _compute_codegen_version()


def current_disk_src_sha256() -> str:
    """Live-read program_ops.py on disk and return sha256 hex. Used by the
    run endpoint to detect codegen edits that landed after service boot
    (the service caches modules — a disk-only edit doesn't take effect
    until restart, and the excursion investigation on 2026-07-28 burned
    hours because that detail was invisible)."""
    try:
        with open(CODEGEN_VERSION['src_path'], 'rb') as f:
            return hashlib.sha256(f.read()).hexdigest()
    except Exception:
        return 'unknown'


# ────────────────────────────────────────────────────────────────
# Wire-verified Lua linter
# ────────────────────────────────────────────────────────────────
#
# 2026-07-30 08:40 bench: waitCondition(false,N) was rejected 10006
# "invalid parameter" at runtime, mid-cycle. The root cause was that
# no code path checked what codegen emitted against the controller's
# ACTUAL verb catalogue — the robot was the first thing to notice.
# This lint pass closes that hole: every emitted call is validated
# against luaenginelib.json (the 168-entry authoritative library
# shipped by the editor at /webmodel/cocontrol/luaeditor/luaenginelib
# .json, captured to data/estun_captures/ on 2026-07-29) BEFORE any
# save/run publish. A finding blocks the push; the operator sees the
# line and reason instead of a controller alarm halting mid-cycle.
#
# Scope:
#   ✓ verb exists in library
#   ✓ positional arg count within the library's [min..max] arity
#     (max counts the optional trailing options-table when present)
#   ✗ deep type checking (the library entry only names placeholders
#     like ${vvd}/${port}/${timeout} — no strict types), so the
#     linter treats a single positional slot as "any Lua expression".
#     Higher-fidelity type checks are a future extension when the
#     placeholders' semantics are documented.
#
# Non-goals: catching pure-Lua syntax errors (Lua's own parser will).
# The linter's remit is the verb catalogue.

# Verbs that ARE wire-proven on this firmware but are missing from
# luaenginelib.json. The catalogue is authoritative for what the editor
# will scaffold; it is NOT the complete set of what the interpreter
# accepts. When bench evidence proves a verb runs cleanly, whitelist
# it here with a bench-record note and a (min, max) arity.
#
# Rules for entries:
#   * `evidence` MUST name a dated screenshot / capture / log where
#     the verb was RESIDENT on the controller and EXECUTED cleanly
#     (not just present in an editor palette or i18n bundle).
#   * arity `(min, max)` is the observed positional-arg range.
#   * Adding an entry means the linter will PASS calls to this verb
#     without library-catalogue lookup. It does NOT mean the verb is
#     safe — only that we've traced a specific working invocation
#     and are honoring that evidence.
#
# 2026-07-30 status:
#   wait — observed RESIDENT as `wait(500)` in whitebowlpickplace on
#          2026-07-29 (UI screenshot + clean runs). The 08:40 and
#          14:08 alarm 10006 hits were on `waitCondition(false, N)`,
#          NOT `wait(ms)`; the systemTime()-bounded-loop detour was
#          based on a mis-attribution and is retired. See
#          docs/estun_lua_reference.md for the full provenance table.
_WIRE_PROVEN_UNDOCUMENTED: dict = {
    'wait': {
        'arity':    (1, 1),
        'evidence': ('2026-07-29 UI screenshot + clean bowl-pickplace '
                     'runs on firmware v2.3 (resident `wait(500)` '
                     'executed without alarm across multiple cycles). '
                     'Absent from luaenginelib.json 168-verb catalogue.'),
    },
}


# Lua keywords that can appear immediately before `(` in emitted
# code but are NOT function calls (e.g., `while (...)`, `if (...)`,
# `return (...)`). Reserved-name protection.
_LUA_RESERVED = frozenset({
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
    'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or',
    'repeat', 'return', 'then', 'true', 'until', 'while',
})


class LuaLintError(RuntimeError):
    """Raised by callers that want lint failure to hard-block a push.
    Carries the findings list on `.findings`."""
    def __init__(self, findings: list):
        self.findings = list(findings)
        head = findings[0] if findings else {}
        summary = (f'{len(findings)} lint finding(s); '
                   f'first: line {head.get("line","?")} '
                   f'verb {head.get("verb","?")!r}: '
                   f'{head.get("reason","?")}')
        super().__init__(summary)


_LUAENGINELIB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  'luaenginelib.json')
_LUAENGINELIB_CACHE: dict | None = None


def _load_luaenginelib() -> dict:
    """Load the 168-verb catalogue. Cached per-process."""
    global _LUAENGINELIB_CACHE
    if _LUAENGINELIB_CACHE is not None:
        return _LUAENGINELIB_CACHE
    try:
        with open(_LUAENGINELIB_PATH) as fp:
            _LUAENGINELIB_CACHE = json.load(fp)
    except Exception as e:
        raise RuntimeError(
            f'lint: could not load luaenginelib.json at '
            f'{_LUAENGINELIB_PATH}: {e}. This file ships with the '
            f'package (data/estun_captures/luaenginelib.json → '
            f'estun_driver/luaenginelib.json). Re-install the package.')
    return _LUAENGINELIB_CACHE


def _split_top_level_commas(s: str) -> list:
    """Split `s` at commas that are not inside (), {}, or []. Used
    both for lint arg-count and for parsing library templates."""
    out, cur, depth = [], [], 0
    in_str = None
    escape = False
    for ch in s:
        if in_str:
            cur.append(ch)
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == in_str:
                in_str = None
            continue
        if ch in ('"', "'"):
            in_str = ch
            cur.append(ch)
            continue
        if ch in '({[':
            depth += 1; cur.append(ch)
        elif ch in ')}]':
            depth -= 1; cur.append(ch)
        elif ch == ',' and depth == 0:
            out.append(''.join(cur)); cur = []
        else:
            cur.append(ch)
    out.append(''.join(cur))
    return out


def _parse_lib_arity(entry: dict) -> tuple:
    """Return (min_args, max_args) for a luaenginelib.json entry, or
    (None, None) if the template can't be parsed. Optional args are
    detected by `${optional.*}` placeholder prefix (individual) OR by
    a table literal whose interior `${...}` placeholders are ALL
    prefixed `optional.` (the movJ/movL options-table pattern)."""
    tmpl = (entry or {}).get('lua') or ''
    if not tmpl:
        return (None, None)
    # Find `name(...)` at the end of the template (after any LHS
    # `${var}=` / `${a},${b}=` assignment).
    m = _re.search(r'([A-Za-z_][A-Za-z_0-9]*)\s*\((.*)\)\s*$', tmpl)
    if not m:
        return (None, None)
    body = m.group(2).strip()
    if not body:
        return (0, 0)
    args = _split_top_level_commas(body)
    min_n = max_n = 0
    for raw in args:
        a = raw.strip()
        if not a:
            continue
        max_n += 1
        if a.startswith('${optional.') and a.endswith('}'):
            continue  # optional single arg
        if a.startswith('{') and a.endswith('}'):
            inner = a[1:-1]
            placeholders = _re.findall(r'\$\{([^}]+)\}', inner)
            if placeholders and all(p.startswith('optional.')
                                    for p in placeholders):
                continue  # optional options-table
        min_n += 1
    return (min_n, max_n)


def _strip_lua_strings_and_comment(line: str) -> str:
    """Return `line` with string literals and any trailing comment
    stripped, so downstream regex-based call detection doesn't hit
    identifiers inside quoted strings or annotations."""
    out = []
    i, n = 0, len(line)
    in_str = None
    escape = False
    while i < n:
        ch = line[i]
        if in_str:
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == in_str:
                in_str = None
            # Consume string chars (replace with space to preserve column).
            out.append(' ')
            i += 1
            continue
        if ch in ('"', "'"):
            in_str = ch
            out.append(' ')
            i += 1
            continue
        # Lua `--` starts a line comment (we don't emit long-bracket
        # comments — codegen never produces `--[[...]]`).
        if ch == '-' and i + 1 < n and line[i + 1] == '-':
            break
        out.append(ch)
        i += 1
    return ''.join(out)


# Known-bad call patterns — verbs that ARE in luaenginelib but that
# firmware v2.3 rejects for specific arg shapes. Signature-vs-runtime
# gaps discovered on the wire; recorded here so the linter catches
# reintroductions even when arity is nominally correct. Each entry:
#   (verb, matcher-fn(args_list) -> reason|None)
# args_list is a list of ARG STRINGS (raw text between top-level commas).
_KNOWN_BAD_PATTERNS = []


def _bad_waitCondition_bare_literal_cond(args):
    """waitCondition(false, N) — bench 2026-07-30 08:40, firmware v2.3
    rejected with alarm 10006 despite the cowidgets.json docstring
    saying `false` triggers the timeout-only branch. cowidgets.json's
    doc for waitCondition — "Execution continues when [condition]
    returns true or after waiting for a timeout, res: true indicates
    true, while false waits for a timeout" — implies pure-timeout
    on `false` is legal, but the firmware's interpreter refuses a
    bare compile-time boolean literal in the condition slot. The
    condition must be a runtime-evaluable expression (e.g., getDI(N)
    ==V). Emit the systemTime() bounded loop for pure timeouts
    instead — see the wait branch of codegen_lua_from_program."""
    if len(args) != 2:
        return None
    cond = args[0].strip()
    if cond in ('false', 'true', 'nil'):
        return (f'waitCondition(<bare {cond}>, ...) is REJECTED by '
                f'firmware v2.3 alarm 10006 at runtime even though '
                f'the shape passes arity check. The condition slot '
                f'must be a runtime-evaluable expression, not a '
                f'compile-time literal. Use a systemTime() bounded '
                f'loop for pure timeouts.')
    return None


_KNOWN_BAD_PATTERNS.append(('waitCondition', _bad_waitCondition_bare_literal_cond))


def lint_lua_source(source: str, lib: dict = None) -> list:
    """Lint every function-call token in `source` against the shipped
    luaenginelib.json catalogue. Returns a list of finding dicts:

        {'line': int, 'verb': str, 'args': int|None,
         'reason': str, 'source_line': str}

    Findings are ordered by line, then column of the call.

    Handles:
      * assignment forms — `local _t0 = systemTime()`, `x = getDI(1)`
      * control flow — while/if/for/return/local skipped as non-calls
      * nested calls — every call token is validated independently
      * table-literal args — `movJCoorRel({cp={0,0,z,0,0,0}}, {...})`
        counts as 2 positional args
      * multi-word `for` header — the counter expression isn't a call
    """
    if lib is None:
        lib = _load_luaenginelib()
    arity_map = {name: _parse_lib_arity(e) for name, e in lib.items()}
    findings = []
    for lineno, raw_line in enumerate(source.splitlines(), start=1):
        clean = _strip_lua_strings_and_comment(raw_line)
        i = 0
        while i < len(clean):
            m = _re.match(r'([A-Za-z_][A-Za-z_0-9]*)\s*\(', clean[i:])
            if not m:
                i += 1
                continue
            name = m.group(1)
            open_paren = i + m.end() - 1
            if name in _LUA_RESERVED:
                # Skip the keyword — but keep scanning inside the
                # parenthesized expression for any real calls.
                i = open_paren + 1
                continue
            # Walk to the matching close paren, respecting nesting
            # over (), {}, [].
            depth = 1
            j = open_paren + 1
            while j < len(clean) and depth > 0:
                c = clean[j]
                if c in '({[': depth += 1
                elif c in ')}]': depth -= 1
                j += 1
            if depth != 0:
                findings.append({
                    'line': lineno, 'verb': name, 'args': None,
                    'reason': 'unbalanced parentheses in call',
                    'source_line': raw_line.rstrip(),
                })
                break
            args_body = clean[open_paren + 1:j - 1]
            arg_slots = [a for a in _split_top_level_commas(args_body)
                         if a.strip()]
            argc = len(arg_slots)
            if name not in arity_map:
                # Second chance: wire-proven-undocumented whitelist.
                wp = _WIRE_PROVEN_UNDOCUMENTED.get(name)
                if wp is not None:
                    lo, hi = wp['arity']
                    if not (lo <= argc <= hi):
                        findings.append({
                            'line': lineno, 'verb': name, 'args': argc,
                            'reason': (f'{name} is wire-proven-undocumented '
                                       f'but argc={argc} outside observed '
                                       f'range {lo}..{hi}. Evidence: '
                                       f'{wp["evidence"]}'),
                            'source_line': raw_line.rstrip(),
                        })
                    # argc within observed range → no finding.
                else:
                    findings.append({
                        'line': lineno, 'verb': name, 'args': argc,
                        'reason': (f'verb {name!r} is NOT in luaenginelib.json '
                                   f'(168-entry authoritative catalogue) and '
                                   f'not in the wire-proven-undocumented '
                                   f'whitelist. Controller will reject with '
                                   f'10012-class unknown-identifier at '
                                   f'runtime.'),
                        'source_line': raw_line.rstrip(),
                    })
            else:
                lo, hi = arity_map[name]
                if lo is not None and hi is not None:
                    if not (lo <= argc <= hi):
                        findings.append({
                            'line': lineno, 'verb': name, 'args': argc,
                            'reason': (f'arity mismatch — {name} expects '
                                       f'{lo}..{hi} positional args, '
                                       f'got {argc}. Library template: '
                                       f'{lib[name].get("lua","<?>")!r}'),
                            'source_line': raw_line.rstrip(),
                        })
                # Signature-vs-runtime gap checks: verbs that pass
                # arity but that the firmware rejects for specific
                # arg shapes (2026-07-30 08:40 discovery — see
                # _bad_waitCondition_bare_literal_cond). These are
                # bench-recorded gaps between what luaenginelib.json
                # says is legal and what v2.3 actually accepts.
                for _kbverb, _kbfn in _KNOWN_BAD_PATTERNS:
                    if _kbverb != name:
                        continue
                    _reason = _kbfn(arg_slots)
                    if _reason:
                        findings.append({
                            'line': lineno, 'verb': name, 'args': argc,
                            'reason': _reason,
                            'source_line': raw_line.rstrip(),
                        })
            # Continue scanning INSIDE this call's body for nested
            # calls (e.g., waitCondition(getDI(1)==1, 500) — the
            # getDI(1) inside needs its own validation). Restart the
            # loop at the position just after `name(` so nested calls
            # are picked up on the same line.
            i = open_paren + 1
    return findings


# ────────────────────────────────────────────────────────────────
# Motion vocabulary defaults (2026-07-29 §1-§4 work)
# ────────────────────────────────────────────────────────────────
#
# `wire_verified_blender` gates the SMOOTH profile. Bench evidence
# review on 2026-07-29 established that setBlender / setNoBlender are
# NOT in luaenginelib.json (168 callable signatures mined from
# data/estun_captures/luaenginelib.json) and have ZERO callsites in
# any captured save body (grep-verified across all four HARs in
# data/estun_captures/). They appear ONLY in the i18n label bundle
# ("Set the default transition radius" / "…no transition") and the
# syntax-highlighter keyword list. That is NOT evidence of runtime
# support; the interpreter rejects unknown identifiers with 10012-
# class errors before any move runs (see program_ops.py:591 for the
# same warning on the movJ/movL verb table).
#
# When `wire_verified_blender` is False (the release default), a
# program authored with motion_profile='smooth' quietly demotes to
# straight-motion behaviour: setBlender / setNoBlender are NOT
# emitted, and a header note explains the demotion. Flip the flag
# to True ONLY after a bench probe confirms setBlender(<mm>) runs
# cleanly on this controller — the §5 deploy checklist has the
# procedure.
#
# `max_joint_speed_dps` / `max_linear_speed_mmps` are the operator's
# 100%-speed absolutes in the units the Estun controller expects for
# setSpeedJ / setSpeedL (deg/s and mm/s).
#
# 2026-07-31 update (task §2): pulled from the factory UI's speedLimit
# and robotLimit pages (Config screenshots) — controller-declared,
# no longer inferred:
#   * max_joint_speed_dps = [150,150,150,180,180,180] — per-joint
#     rated max as shown on the S10-140's speedLimit screen.
#     setSpeedJ takes ONE scalar; per the task's "min applies for
#     multi-joint scaling" rule we emit min() of the six values (150)
#     so no joint is ever commanded above its rated max. The list is
#     retained (not collapsed to a scalar) so a future per-axis
#     scaling scheme can use it.
#   * max_linear_speed_mmps = 1500 — product cruise ceiling adopted
#     for codegen; the controller-declared cartAutoMaxVel from the
#     robotLimit screen is 2600 mm/s, kept as headroom above 1500.
#     Human-cell workflows never approach 2600; 1500 is a defensible
#     100% for pick-and-place programs.
# Re-tune per cell without a codegen rebuild by passing a
# `motion_config` dict into codegen_lua_from_program.
DEFAULT_MOTION_CONFIG: dict = {
    # SMOOTH profile gate — kept OFF: setBlender / setNoBlender are
    # NOT in the authoritative luaenginelib.json (168-verb library
    # captured 2026-07-29). The 2026-07-31 §3 note that flipped this
    # to True was based on a mistaken read of the editor's
    # syntax-highlighter keyword list (same trap as setPayload — cf.
    # memory cobot-lua-verb-provenance). Codegen still computes the
    # demotion metadata for the header note so the operator sees
    # which waypoints WOULD have been demoted, but no unverified
    # verb reaches the wire. Flip back to True only after the two
    # verbs are added to luaenginelib.json (would require a firmware
    # editor update) OR the lint allowlist is extended with a
    # documented bench-verification record.
    'wire_verified_blender': False,

    # 100%-speed absolutes (see the comment block above).
    'max_joint_speed_dps':   [150.0, 150.0, 150.0, 180.0, 180.0, 180.0],
    'max_linear_speed_mmps': 1500.0,
    # Controller-declared cartAutoMaxVel; retained for parity checks
    # and dashboards but NOT used for codegen scaling (1500 is the
    # product ceiling).
    'controller_cart_auto_max_vel_mmps': 2600.0,

    # Blend-radius presets for the smooth profile — millimetres.
    'blend_radius_mm': {
        'fine':   3.0,
        'medium': 12.0,
        'smooth': 30.0,
    },

    # Descent-acceleration override. When gentle, setAccL(<gentle>)
    # is emitted before each taught-contact descent and the baseline
    # setAccL is re-emitted before the next non-descent linear move
    # so the modal state is closed explicitly (the controller's own
    # resting AccL isn't captured on the wire — closing the bracket
    # avoids leaving a lower value armed for the next program).
    'gentle_descent_accL_mm_per_s2': 150.0,
    'default_accL_mm_per_s2':       1200.0,

    # Program-level defaults — used when the program itself doesn't
    # specify.
    'default_motion_profile': 'joint',    # joint | straight | smooth
    'default_descent_accel':   'normal',  # normal | gentle
    'default_blend_preset':    'medium',  # fine | medium | smooth
}


def _merged_motion_config(motion_config: dict | None) -> dict:
    """Shallow-merge caller's motion_config over DEFAULT_MOTION_CONFIG.
    blend_radius_mm sub-dict is deep-merged one level. Unknown keys
    on the caller side are preserved (forward-compat)."""
    out = dict(DEFAULT_MOTION_CONFIG)
    if not motion_config:
        return {**out, 'blend_radius_mm': dict(out['blend_radius_mm'])}
    out['blend_radius_mm'] = dict(out['blend_radius_mm'])
    for k, v in motion_config.items():
        if k == 'blend_radius_mm' and isinstance(v, dict):
            out['blend_radius_mm'] = {**out['blend_radius_mm'], **v}
        else:
            out[k] = v
    return out


def _fk_tcp_mm(joints_deg: list[float]) -> tuple[float, float, float] | None:
    """Forward-kinematics TCP position (x, y, z) in millimetres, in the
    driver's base_link frame. Returns None if numpy is unavailable or the
    joint vector is malformed. Used by the short-segment demoter to
    resolve cartesian segment lengths from taught_joints when no
    taught_tcp is present on a step."""
    if _np is None:
        return None
    if not (isinstance(joints_deg, (list, tuple)) and len(joints_deg) == 6
            and all(isinstance(v, (int, float)) for v in joints_deg)):
        return None
    try:
        Ts = _fk_chain([float(v) for v in joints_deg])
        p = Ts[6][:3, 3]
        return float(p[0]), float(p[1]), float(p[2])
    except Exception:
        return None


def _resolve_step_xyz_mm(step: dict, steps: list[dict], idx: int
                         ) -> tuple[float, float, float] | None:
    """Best-effort cartesian resolution for one step, in mm/base_link.

    Priority:
      1. step.taught_tcp (metres; converted to mm on emit path);
      2. step.taught_joints → FK;
      3. derived_from resolution: anchor's taught_tcp + z-offset, else
         anchor's taught_joints → FK, then z-offset applied.

    Non-motion steps (set_io, wait, wait_input, loop) return None and
    are treated as zero-length by the segment-length pass — they don't
    contribute a waypoint to consecutive-transit blending. This keeps
    IO / dwell interposed between two transits from being treated as
    a segment break.
    """
    action = str(step.get('action') or '').lower()
    if action in ('set_io', 'wait', 'wait_input', 'verify_input', 'loop', 'gripper'):
        return None
    # 1) taught_tcp on the step itself.
    tcp = step.get('taught_tcp') or step.get('position')
    if isinstance(tcp, (list, tuple)) and len(tcp) >= 3 \
            and all(isinstance(v, (int, float)) for v in tcp[:3]):
        x, y, z = float(tcp[0]), float(tcp[1]), float(tcp[2])
        # taught_tcp convention on this codebase: meters for x/y/z when
        # |value| < 10 (well outside the ~1 m base_link workspace);
        # otherwise already millimetres (some legacy PBD paths).
        if abs(x) < 10 and abs(y) < 10 and abs(z) < 10:
            x *= 1000.0; y *= 1000.0; z *= 1000.0
        return x, y, z
    # 2) taught_joints → FK.
    tj = step.get('taught_joints')
    fk = _fk_tcp_mm(tj) if tj else None
    if fk is not None:
        return fk
    # 3) derived_from — anchor's pose + offset.
    role = step.get('derived_from')
    if role:
        anchor = _resolve_anchor_step(steps, idx)
        if anchor is not None:
            ofs = float(step.get('offset_z_mm') or 0)
            atcp = anchor.get('taught_tcp') or anchor.get('position')
            if isinstance(atcp, (list, tuple)) and len(atcp) >= 3 \
                    and all(isinstance(v, (int, float)) for v in atcp[:3]):
                x, y, z = float(atcp[0]), float(atcp[1]), float(atcp[2])
                if abs(x) < 10 and abs(y) < 10 and abs(z) < 10:
                    x *= 1000.0; y *= 1000.0; z *= 1000.0
                return x, y, z + ofs
            atj = anchor.get('taught_joints')
            fk = _fk_tcp_mm(atj) if atj else None
            if fk is not None:
                return fk[0], fk[1], fk[2] + ofs
    return None


def _mark_blend_demotions(steps: list[dict], mc: dict,
                          blend_radius_mm: float
                          ) -> list[tuple[bool, str]]:
    """Return a list [(demote, reason)] parallel to `steps`.

    demote=True means: this waypoint MUST close its incoming/outgoing
    blend — emit setNoBlender before executing this step. Reasons:
      * 'contact'                — taught contact (has taught_joints and
                                   is a move_linear / move_home / move_joint
                                   without derived_from);
      * 'linked_zero_length'     — this step's resolved xyz equals the
                                   previous move's resolved xyz within
                                   1 mm (a linked/identical waypoint —
                                   consecutive identical poses = the
                                   §412 July-22 excursion class);
      * 'short_segment_before'   — the segment INTO this step is
                                   shorter than 2 × blend_radius;
      * 'short_segment_after'    — the segment OUT of this step is
                                   shorter than 2 × blend_radius;
      * 'final'                  — last motion step in the program
                                   (never leave modal blender armed).

    Non-motion steps (IO / wait / wait_input / loop) are marked with
    (False, '') — they don't participate in blender decisions.

    A demotion returned here IS honored by the SMOOTH path regardless
    of wire_verified_blender: even when we DON'T emit setBlender/
    setNoBlender, the reason is written into the header note so an
    operator reading the Lua sees WHY a smooth-authored program was
    pinned to straight motion at that step.
    """
    n = len(steps)
    xyz: list[tuple[float, float, float] | None] = [
        _resolve_step_xyz_mm(s, steps, i) for i, s in enumerate(steps)]
    # segment length TO step i (from previous resolvable step)
    seg_before: list[float | None] = [None] * n
    prev_pos = None
    for i, p in enumerate(xyz):
        if p is None:
            continue
        if prev_pos is not None:
            dx = p[0] - prev_pos[0]; dy = p[1] - prev_pos[1]; dz = p[2] - prev_pos[2]
            seg_before[i] = (dx * dx + dy * dy + dz * dz) ** 0.5
        prev_pos = p
    # segment length OUT of step i (to next resolvable step)
    seg_after: list[float | None] = [None] * n
    next_pos = None
    prev = None
    for i in range(n - 1, -1, -1):
        if xyz[i] is None:
            continue
        if prev is not None:
            dx = prev[0] - xyz[i][0]; dy = prev[1] - xyz[i][1]; dz = prev[2] - xyz[i][2]
            seg_after[i] = (dx * dx + dy * dy + dz * dz) ** 0.5
        prev = xyz[i]

    # identify the last motion step so we can mark it 'final'
    last_motion_idx = None
    for i in range(n - 1, -1, -1):
        if xyz[i] is not None:
            last_motion_idx = i
            break

    threshold = 2.0 * float(blend_radius_mm)
    marks: list[tuple[bool, str]] = []
    prev_xyz = None
    for i, s in enumerate(steps):
        if xyz[i] is None:
            marks.append((False, ''))
            continue
        # Contact: taught motion step with no derived_from and with
        # taught_joints — the operator taught this exact pose to touch
        # something. Contact descents MUST setNoBlender.
        action = str(s.get('action') or '').lower()
        tj = s.get('taught_joints')
        has_taught = (isinstance(tj, list) and len(tj) == 6
                      and all(isinstance(v, (int, float)) for v in tj))
        derived = bool(s.get('derived_from'))
        # 1) linked / identical waypoint — always demote (zero-length
        #    is the §412 firmware-crash class).
        if prev_xyz is not None:
            dx = xyz[i][0] - prev_xyz[0]; dy = xyz[i][1] - prev_xyz[1]; dz = xyz[i][2] - prev_xyz[2]
            gap = (dx * dx + dy * dy + dz * dz) ** 0.5
            if gap < 1.0:
                marks.append((True, 'linked_zero_length'))
                prev_xyz = xyz[i]
                continue
        # 2) taught contact — always demote.
        if has_taught and not derived and action in ('move_linear', 'move_joint', 'move_home'):
            # move_home is a taught pose but conceptually a "home" — still
            # demote so blends don't carry across a home rung.
            marks.append((True, 'contact'))
            prev_xyz = xyz[i]
            continue
        # 3) final motion step — never leave modal blender armed.
        if last_motion_idx is not None and i == last_motion_idx:
            marks.append((True, 'final'))
            prev_xyz = xyz[i]
            continue
        # 4) short-segment guard on either adjacent segment.
        sb = seg_before[i]; sa = seg_after[i]
        if sb is not None and sb < threshold:
            marks.append((True, f'short_segment_before ({sb:.1f}mm < {threshold:.1f}mm)'))
            prev_xyz = xyz[i]
            continue
        if sa is not None and sa < threshold:
            marks.append((True, f'short_segment_after ({sa:.1f}mm < {threshold:.1f}mm)'))
            prev_xyz = xyz[i]
            continue
        # No demotion — this waypoint is eligible for blending.
        marks.append((False, ''))
        prev_xyz = xyz[i]
    return marks


def _classify_standard_columns(steps: list[dict]) -> list[str]:
    """Per-step classification for the STANDARD motion profile
    (2026-07-31 task §3): every step is 'column' | 'transit' |
    'non_motion'.

    A STATION column is a taught-contact pose plus its immediate
    derived approach-above and retreat-above steps — the operator's
    doctrine that the tool arrives at the station orientation-locked,
    contacts, and departs orientation-locked before any wrist re-solve
    is permitted.

    Rules:
      * Non-motion actions (set_io / wait / verify_input / loop /
        gripper) → 'non_motion' (never gets a verb).
      * A step whose `derived_from` names a station role → 'column'
        (the approach-above or retreat-above of that station).
      * A step whose `position_role` names a station role and which
        carries taught_joints (the contact itself) → 'column'.
      * Everything else that reaches the walker (move_home, ungrouped
        transits, any move without a station-role tie) → 'transit'.

    STATION ROLES = the set of position_role values on steps that
    have BOTH taught_joints AND no derived_from AND are NOT the
    'home' role. That excludes home moves — home is a transit anchor,
    not a station.

    The boundary pose (approach-above) belongs to the column: its
    step is classified 'column' via the derived_from → station rule.
    The task's "exactly one arrival emitted" invariant is satisfied by
    the existing walker (one move emission per step); classification
    doesn't introduce any duplicate emissions.
    """
    station_roles: set[str] = set()
    for s in steps:
        if not isinstance(s, dict):
            continue
        role = s.get('position_role')
        if not role or str(role).lower() == 'home':
            continue
        if s.get('derived_from'):
            continue
        tj = s.get('taught_joints')
        if isinstance(tj, list) and len(tj) == 6 \
                and all(isinstance(v, (int, float)) for v in tj):
            station_roles.add(role)
    out: list[str] = []
    for s in steps:
        action = str(s.get('action') or '').lower()
        if action in ('set_io', 'wait', 'wait_input', 'verify_input',
                      'loop', 'gripper'):
            out.append('non_motion')
            continue
        # derived approach/retreat → column (only when the target role
        # is a real station).
        if s.get('derived_from') in station_roles:
            out.append('column')
            continue
        role = s.get('position_role')
        if role in station_roles:
            out.append('column')
            continue
        out.append('transit')
    return out


def _tcp_orientation_deg(joints_deg: list[float]) -> list[float] | None:
    """Return the flange orientation as XYZ Euler angles in degrees
    from FK on the fitted DH. Returns None on malformed input or when
    numpy is unavailable.

    XYZ Euler is chosen to match the taught_tcp convention emitted by
    the PBD path (rx, ry, rz euler angles in radians). The analyzer's
    orientation-invariant check uses per-axis absolute error, so the
    convention only needs to be consistent between taught and emitted
    (both derive from the same joints or FK)."""
    if _np is None:
        return None
    if not (isinstance(joints_deg, (list, tuple)) and len(joints_deg) == 6
            and all(isinstance(v, (int, float)) for v in joints_deg)):
        return None
    try:
        Ts = _fk_chain([float(v) for v in joints_deg])
        R = Ts[6][:3, :3]
        # XYZ Euler decomposition (Rz * Ry * Rx convention).
        # ry = asin(-R[2,0]); rx = atan2(R[2,1], R[2,2]);
        # rz = atan2(R[1,0], R[0,0])
        import math as _m
        ry = _m.asin(max(-1.0, min(1.0, -float(R[2, 0]))))
        if abs(_m.cos(ry)) < 1e-6:
            # Gimbal lock — pick one solution branch; caller only
            # uses per-axis abs error, so pick the standard branch.
            rx = _m.atan2(-float(R[1, 2]), float(R[1, 1]))
            rz = 0.0
        else:
            rx = _m.atan2(float(R[2, 1]), float(R[2, 2]))
            rz = _m.atan2(float(R[1, 0]), float(R[0, 0]))
        return [_m.degrees(rx), _m.degrees(ry), _m.degrees(rz)]
    except Exception:
        return None


def _path_feasibility_sample(anchor_deg: list[float],
                             delta_z_mm: float,
                             *,
                             samples: int = 10,
                             max_inter_sample_joint_dps: float = 60.0
                             ) -> dict:
    """For the STRAIGHT profile: sample the seeded-IK solution along
    a base-frame Z lift/descent at N points, check no inter-sample
    joint step exceeds the bounded velocity (branch-flip detector),
    and report the worst inter-sample joint delta.

    Returns:
        {'feasible':      bool,          True → movL is safe;
         'reason':        str,           when not feasible;
         'worst_axis':    int,           1-6, the offender;
         'worst_delta':   float,         deg between neighbours;
         'threshold':     float,         the bound used;
         'endpoints':     list[list],    seeded joints at each sample.}
    """
    n = max(2, int(samples))
    endpoints: list[list[float]] = []
    fractions: list[float] = []
    for k in range(n):
        t = k / (n - 1)
        ik = seeded_ik_z_lift(anchor_deg, delta_z_mm * t)
        if ik is None:
            return {'feasible': False,
                    'reason': (f'seeded IK failed at sample {k+1}/{n} '
                               f'(t={t:.2f}, Δz={delta_z_mm*t:+.2f} mm)'),
                    'worst_axis': 0, 'worst_delta': 0.0,
                    'threshold': max_inter_sample_joint_dps,
                    'endpoints': endpoints}
        lifted, _ = ik
        endpoints.append(list(lifted))
        fractions.append(t)
    # Estimate a per-sample "time budget" assuming linear-time travel
    # of the whole segment; if the whole descent takes D seconds and
    # we cross N-1 sub-segments, each takes D/(N-1) seconds. The
    # bounded velocity is per-second, so allowed inter-sample joint
    # delta = bound * D/(N-1). At the analyzer level we don't know D;
    # we use the joint-space deltas directly and compare against a
    # tuned per-sub-segment threshold: if a single sub-segment causes
    # a joint to swing more than max_inter_sample_joint_dps degrees,
    # the branch has flipped. 60 deg between adjacent samples is a
    # generous threshold — a smooth path never swings a joint that
    # much between IK samples, but a branch flip does (all six axes
    # jump simultaneously).
    worst = 0.0
    worst_axis = 0
    for k in range(1, n):
        for a in range(6):
            d = abs(endpoints[k][a] - endpoints[k-1][a])
            if d > worst:
                worst = d
                worst_axis = a + 1
    if worst > max_inter_sample_joint_dps:
        return {'feasible': False,
                'reason': (f'inter-sample joint delta {worst:.1f}° on J{worst_axis} '
                           f'between samples exceeds bound '
                           f'{max_inter_sample_joint_dps:g}° — likely branch flip'),
                'worst_axis': worst_axis, 'worst_delta': worst,
                'threshold': max_inter_sample_joint_dps,
                'endpoints': endpoints}
    return {'feasible': True, 'reason': '',
            'worst_axis': worst_axis, 'worst_delta': worst,
            'threshold': max_inter_sample_joint_dps,
            'endpoints': endpoints}


def _make_jp_point(joints: list[float], nm: str,
                   coord: int = 0, tool: int = 0) -> dict:
    """varspoint entry for a joint pose. The controller expects:
        {postype: "jp", nm: "<name>", val: <JSON-encoded string>}
    where val decodes to
        {coord, tool, jp: [j1..j6], ep: []}
    Mined from `useProjectPointJoint.newPoint` in the factory UI
    bundle — the first save attempt on this branch used a plain
    object under val and the controller rejected with
    10012 "Failed to parse variable <p1>: Value is not in JSON
    string format." because it tries JSON.parse(val).
    """
    val_obj = {
        'coord': int(coord),
        'tool': int(tool),
        'jp': [float(v) for v in joints],
        'ep': [],
    }
    return {
        'postype': 'jp',
        'nm': nm,
        'val': json.dumps(val_obj, separators=(',', ':')),
    }


# Anchor pose resolution for `derived_from` steps. The wizard authors
# offset moves (descend / lift / retreat) as {derived_from: "<role>",
# offset_z_mm: N} with NO taught_joints/tcp of their own — the anchor
# pose is a sibling step that carries position_role == <role> plus real
# taught data. The runtime executor already resolves this at tick time
# (program_executor_node._resolve_base_tcp). Codegen needs the same
# resolution so we can emit a real movL instead of a `-- skipped` line.
#
# _build_role_map does the one-time scan; _resolve_derived returns a
# ('cp'|'jp', [6 vals]) tuple for a derived step, applying the z offset
# in the base frame (base_tcp is meters → convert to mm for Estun cp).
def _build_role_map(steps: list[dict]) -> dict[str, dict]:
    """{role → {taught_joints, taught_tcp}} for steps that both carry a
    position_role AND real taught data. Historically the derived-step
    resolver keyed off this map directly (last-writer-wins) — that's
    the multi-pair bug fixed 2026-07-27 where pair-1's approach/retreat
    steps resolved to pair-2's contact. Kept for backward compat with
    any external caller; the codegen path now uses
    `_resolve_anchor_step` instead, which is index-aware."""
    out: dict[str, dict] = {}
    for s in steps:
        role = s.get('position_role')
        if not role:
            continue
        tj = s.get('taught_joints')
        tc = s.get('taught_tcp') or s.get('position')
        entry: dict = {}
        if isinstance(tj, list) and len(tj) == 6 \
                and all(isinstance(v, (int, float)) for v in tj):
            entry['taught_joints'] = [float(v) for v in tj]
        if isinstance(tc, list) and len(tc) >= 3 \
                and all(isinstance(v, (int, float)) for v in tc):
            entry['taught_tcp'] = [float(v) for v in tc]
        if entry:
            out[role] = entry
    return out


def _resolve_anchor_step(steps: list[dict], derived_step_idx: int
                         ) -> dict | None:
    """Return the taught anchor step for `steps[derived_step_idx]`.

    Resolution order:
      1. Explicit `derived_from_step_id` on the derived step — an
         unambiguous unique-id reference (composer + wizard start
         emitting this in the follow-up; already honored today for
         forward compat).
      2. Nearest step (by absolute index distance) whose
         `position_role` matches `derived_from` AND that carries
         real taught data. Ties (equidistant anchors on either side)
         resolve toward the PRECEDING step — it's already been taught
         and executed at the point the derived step runs, so seeded
         IK / movJ-reuse has real joints in hand.
      3. None if nothing plausible exists — the caller emits a
         validation error, never a silent fallback (silent fallback
         is exactly how multi-pair programs kept the pre-fix bug
         invisible in single-pair programs).

    The distance heuristic reliably groups derived steps with their
    OWN pair in a flat multi-pair sequence: approach-before-anchor
    finds the anchor that follows (distance 1); retreat-after-anchor
    finds the anchor that preceded (distance 1); the OTHER pair's
    same-role anchor sits further away and loses.
    """
    if derived_step_idx < 0 or derived_step_idx >= len(steps):
        return None
    dstep = steps[derived_step_idx]
    if not isinstance(dstep, dict):
        return None
    # 1) Explicit unique-id link.
    explicit_id = dstep.get('derived_from_step_id')
    if explicit_id is not None:
        for s in steps:
            if isinstance(s, dict) and s.get('id') == explicit_id:
                return s
        return None
    role = dstep.get('derived_from')
    if not role:
        return None
    best = None
    best_dist = None
    best_precedes = False   # True when the current best has j < derived
    for j, s in enumerate(steps):
        if j == derived_step_idx:
            continue
        if not isinstance(s, dict):
            continue
        if s.get('position_role') != role:
            continue
        tj = s.get('taught_joints')
        tc = s.get('taught_tcp') or s.get('position')
        has_data = ((isinstance(tj, list) and len(tj) == 6
                     and all(isinstance(v, (int, float)) for v in tj))
                    or (isinstance(tc, list) and len(tc) >= 3
                        and all(isinstance(v, (int, float)) for v in tc)))
        if not has_data:
            continue
        dist = abs(j - derived_step_idx)
        precedes = j < derived_step_idx
        # Replacement rules: strictly closer wins; equal-distance
        # tie goes to the preceding step (it's already been taught by
        # then and can serve seeded-IK without waiting).
        take = False
        if best is None:
            take = True
        elif dist < best_dist:
            take = True
        elif dist == best_dist and precedes and not best_precedes:
            take = True
        if take:
            best = s
            best_dist = dist
            best_precedes = precedes
    return best


def _resolve_derived(step: dict, role_map: dict[str, dict]
                     ) -> tuple[str, list[float]] | None:
    """Turn a `derived_from` + `offset_z_mm` step into a concrete pose.

    Returns:
        ('cp', [x_mm, y_mm, z_mm, rx, ry, rz])   preferred — TCP with
                                                  z offset applied in
                                                  the base frame
        ('jp', [j1..j6])                          fallback when the
                                                  anchor only has
                                                  taught_joints and
                                                  the offset is 0
        None                                       anchor missing OR
                                                  offset non-zero and
                                                  no anchor TCP (can't
                                                  apply cartesian z
                                                  offset in joint
                                                  space without IK)

    Anchor lookup is by role string — matches
    program_executor_node._resolve_base_tcp semantics.
    """
    role = step.get('derived_from')
    if not role:
        return None
    anchor = role_map.get(role)
    if not anchor:
        return None
    ofs_mm = float(step.get('offset_z_mm') or 0)
    tcp = anchor.get('taught_tcp')
    if tcp is not None:
        # taught_tcp convention: meters for x/y/z (values < 10),
        # radians for rx/ry/rz. Estun cp expects mm for translation,
        # radians for rotation — mirror what program_executor_node
        # does before send_move('movl').
        x_m = tcp[0]; y_m = tcp[1]; z_m = tcp[2]
        rx = tcp[3] if len(tcp) > 3 else 0.0
        ry = tcp[4] if len(tcp) > 4 else 0.0
        rz = tcp[5] if len(tcp) > 5 else 0.0
        x_mm = x_m * 1000.0 if abs(x_m) < 10 else x_m
        y_mm = y_m * 1000.0 if abs(y_m) < 10 else y_m
        z_mm = z_m * 1000.0 if abs(z_m) < 10 else z_m
        z_mm += ofs_mm
        return 'cp', [x_mm, y_mm, z_mm, rx, ry, rz]
    tj = anchor.get('taught_joints')
    if tj is not None and abs(ofs_mm) < 1e-6:
        # Anchor has only joints and offset is zero — the derived
        # pose IS the anchor pose, so emit as jp.
        return 'jp', list(tj)
    return None


# ────────────────────────────────────────────────────────────────
# Geometry-aware motion analyzer (2026-07-30 §1-§4 work)
# ────────────────────────────────────────────────────────────────
#
# The analyzer inspects taught points AFTER seeded-IK resolution and
# ADJUSTS parameters (blend radius, per-segment speed cap, descent
# segmentation, per-step profile) — never TARGETS. Taught points are
# sacred; nothing moves where the operator didn't put it.
#
# Consumers:
#   1. codegen_lua_from_program — applies the returned adaptations
#      dict during emission (each stamped with a Lua comment).
#   2. dashboard_server /api/programs/<id>/motion_check — renders
#      the findings list in the editor's Motion Check panel.
#
# The analyzer is a pure function of program + motion_config; no I/O,
# no ROS, no external state.  Deterministic on repeat runs.

# Physical joint limits (deg) mirror declare_parameter('joint_limit_deg')
# in estun_driver_node.py — J1/J2/J4/J6 = ±200°, J3/J5 = ±166°. The
# driver-side clamp subtracts a 2° margin at wire time; the analyzer
# uses the raw limit and reports margin so an operator sees the
# real distance to the physical envelope.
_JOINT_LIMITS_DEG = [200.0, 200.0, 166.0, 200.0, 166.0, 200.0]

# Analyzer thresholds — every value is either task-specified or config-
# derived.  Kept here as a single-source-of-truth so tests can import
# them and reason about triggering conditions without duplicating
# magic numbers.
DEFAULT_ANALYZER_CONFIG: dict = {
    # Rule 2b — near-limit / near-singularity speed cap.
    'joint_limit_margin_warn_deg':  5.0,   # rule 3a — warn on taught point
    'joint_limit_margin_cap_deg':  15.0,   # rule 2b — cap segment speed
    'wrist_singularity_deg':       10.0,   # rule 2b — |J5| within N° of 0
    'near_limit_speed_scale':       0.5,   # rule 2b — 50% of commanded
    # Rule 2c — descent split.
    'max_descent_mm':             250.0,   # threshold to trigger split
    'descent_split_stop_above_mm': 50.0,   # split-point height above contact
    # Rule 2d — micro-coalesce.
    'micro_segment_mm':             2.0,   # ≤ this cartesian gap = duplicate
    # Rule 2e — awkward-wrist transit.
    'awkward_wrist_delta_deg':     30.0,   # any J4/J5/J6 delta above this
    # Rule 3c — inconsistent wrist across program.
    'inconsistent_wrist_deg':      20.0,   # per-pair delta considered "different"
    'inconsistent_wrist_min_count':   3,   # need N differing pairs to warn
    # Analyzer max IK sample points along a segment (for rule 2b joint-
    # path sweep). Higher = more accurate near-limit detection at the
    # cost of analyze() runtime. 5 is coarse enough to catch mid-path
    # limit crossings on a joint-interp path (which is linear in q).
    'segment_path_samples':           5,
    # Adaptation blend-radius scale factor (rule 2a).  radius =
    # min(profile_radius, adaptation_blend_frac × shorter_adjacent_segment).
    'adaptation_blend_frac':        0.25,
}


def _merged_analyzer_config(analyzer_config: dict | None) -> dict:
    """Shallow-merge caller overrides onto DEFAULT_ANALYZER_CONFIG."""
    out = dict(DEFAULT_ANALYZER_CONFIG)
    if analyzer_config:
        out.update(analyzer_config)
    return out


def _joint_limit_margin(joints_deg: list[float]) -> list[float]:
    """Per-joint distance (deg) to the nearer of ±limit. NaN for a
    malformed joint value."""
    margins: list[float] = []
    for i in range(6):
        try:
            q = float(joints_deg[i])
        except (TypeError, ValueError, IndexError):
            margins.append(float('nan'))
            continue
        margins.append(_JOINT_LIMITS_DEG[i] - abs(q))
    return margins


def _wrist_singularity_distance_deg(joints_deg: list[float]) -> float:
    """|J5| in degrees. 0 = at wrist singularity. Uses the ABSOLUTE
    value because both +J5 and -J5 approach the singular pose at 0.
    Returns +inf on malformed input so callers never treat it as
    'close to zero' by accident."""
    try:
        return abs(float(joints_deg[4]))
    except (TypeError, ValueError, IndexError):
        return float('inf')


def _sample_joint_path(start_j: list[float], end_j: list[float],
                       n: int) -> list[list[float]]:
    """Linearly interpolate the joint-space path between two 6-vectors.
    Returns n samples INCLUDING both endpoints (n>=2). This mirrors
    what the controller does for a movJ: joint-space linear interp.
    A movL's cartesian path is what the controller SOLVES to — with
    seeded IK holding the wrist endpoints equal, the mid-path joints
    for a movL closely approximate this same linear interp, so we
    use the joint-linear sample for both segment kinds.  Not perfect
    for movL long-arc segments; good enough for the near-limit
    proximity check we're building here (task's own wording: 'solved
    joints pass within N° of a limit')."""
    if n < 2:
        n = 2
    out: list[list[float]] = []
    for k in range(n):
        t = k / (n - 1)
        out.append([float(a) * (1 - t) + float(b) * t
                    for a, b in zip(start_j, end_j)])
    return out


def _resolve_step_joints(step: dict, steps: list[dict], idx: int
                         ) -> list[float] | None:
    """Return best-effort resolved joints (deg) for one step. Uses:
      1. step.taught_joints if present + 6-el numeric;
      2. derived_from + offset_z_mm resolved via seeded_ik_z_lift
         against the anchor's taught_joints (matches what codegen
         actually emits for these steps);
      3. None for non-motion steps and unresolvable ones.
    """
    action = str(step.get('action') or '').lower()
    if action in ('set_io', 'wait', 'wait_input', 'verify_input', 'loop', 'gripper'):
        return None
    tj = step.get('taught_joints')
    if isinstance(tj, list) and len(tj) == 6 \
            and all(isinstance(v, (int, float)) for v in tj):
        return [float(v) for v in tj]
    if step.get('derived_from'):
        anchor = _resolve_anchor_step(steps, idx)
        if anchor is not None:
            atj = anchor.get('taught_joints')
            if isinstance(atj, list) and len(atj) == 6 \
                    and all(isinstance(v, (int, float)) for v in atj):
                ofs = float(step.get('offset_z_mm') or 0)
                if abs(ofs) < 1e-6:
                    return [float(v) for v in atj]
                # Try seeded IK — same call codegen would make.
                ik = seeded_ik_z_lift([float(v) for v in atj], ofs)
                if ik is not None:
                    lifted, _ = ik
                    return list(lifted)
                # Seeded IK unavailable — leave joints unresolved;
                # rule 2b will note this step is skipped by joint
                # analysis. Cartesian analysis still runs via
                # _resolve_step_xyz_mm.
    return None


def _finding(step_idx: int, step: dict, severity: str,
             rule: str, message: str,
             suggested_action: str | None = None,
             metrics: dict | None = None) -> dict:
    """Uniform Finding dict — every analyzer emission goes through
    this so the shape stays consistent for the dashboard renderer."""
    return {
        'step_idx':          step_idx,
        'step_id':           step.get('id'),
        'step_label':        step.get('label', ''),
        'step_action':       step.get('action', ''),
        'severity':          severity,       # 'warn' | 'info' | 'adapted'
        'rule':              rule,
        'message':           message,
        'suggested_action':  suggested_action,
        'metrics':           metrics or {},
    }


def analyze_program(program: dict, *,
                    motion_config: dict | None = None,
                    analyzer_config: dict | None = None,
                    part_index: dict | None = None) -> dict:
    """Geometry-aware motion analysis of a taught program.

    Returns a MotionCheckReport dict:
      {
        'program_id':   str,
        'findings':     [Finding, ...],     # ordered by step_idx
        'adaptations':  {step_idx: dict},   # per-step overrides
        'metrics': {
            'segment_lengths_mm':  [float | None, ...],
            'wrist_deltas_deg':    [float | None, ...],
            'joint_margins_deg':   [[m1..m6] | None, ...],
        },
        'analyzer_config': dict,   # thresholds actually used
      }

    `part_index` (optional) — the parts library dict; when provided,
    the analyzer runs rule 3b (approach height vs. part height). Pass
    /opt/cobot/parts/index.json's contents; None disables the check.

    Pure function: no I/O, no ROS, deterministic. Consumed both by
    codegen_lua_from_program (via the `motion_check` param) and by
    the dashboard's /api/programs/<id>/motion_check endpoint.
    """
    mc = _merged_motion_config(motion_config)
    ac = _merged_analyzer_config(analyzer_config)
    steps: list[dict] = list(program.get('steps') or [])
    n = len(steps)
    findings: list[dict] = []
    adaptations: dict[int, dict] = {}

    def _add_adapt(idx: int, **kv):
        entry = adaptations.setdefault(idx, {
            'blend_radius_mm_override':  None,
            'speed_pct_cap':             None,
            'descent_split':             None,
            'coalesce_with_prev':        False,
            'force_motion_profile':      None,
            'rules_applied':             [],
            'reasons':                   [],
        })
        for k, v in kv.items():
            if k == 'rules_applied':
                for r in v:
                    if r not in entry['rules_applied']:
                        entry['rules_applied'].append(r)
            elif k == 'reasons':
                for r in v:
                    entry['reasons'].append(r)
            else:
                entry[k] = v

    # ── Resolve joints + cartesian pose per step ────────────────
    resolved_j:  list[list[float] | None] = [
        _resolve_step_joints(s, steps, i) for i, s in enumerate(steps)]
    resolved_xyz: list[tuple[float, float, float] | None] = [
        _resolve_step_xyz_mm(s, steps, i) for i, s in enumerate(steps)]

    # ── Per-segment metrics ─────────────────────────────────────
    segment_lengths_mm: list[float | None] = [None] * n
    wrist_deltas_deg:   list[float | None] = [None] * n   # max(|dJ4|,|dJ5|,|dJ6|)
    prev_xyz = None
    prev_j = None
    prev_motion_idx = None
    for i in range(n):
        if resolved_xyz[i] is None and resolved_j[i] is None:
            continue
        if prev_xyz is not None and resolved_xyz[i] is not None:
            dx = resolved_xyz[i][0] - prev_xyz[0]
            dy = resolved_xyz[i][1] - prev_xyz[1]
            dz = resolved_xyz[i][2] - prev_xyz[2]
            segment_lengths_mm[i] = (dx * dx + dy * dy + dz * dz) ** 0.5
        if prev_j is not None and resolved_j[i] is not None:
            wd = max(abs(resolved_j[i][3] - prev_j[3]),
                     abs(resolved_j[i][4] - prev_j[4]),
                     abs(resolved_j[i][5] - prev_j[5]))
            wrist_deltas_deg[i] = wd
        if resolved_xyz[i] is not None:
            prev_xyz = resolved_xyz[i]
        if resolved_j[i] is not None:
            prev_j = resolved_j[i]
        prev_motion_idx = i

    # ── Rule 3a: taught point within joint_limit_margin_warn_deg
    # of a physical limit ──────────────────────────────────────
    warn_margin = float(ac['joint_limit_margin_warn_deg'])
    for i, j in enumerate(resolved_j):
        if j is None:
            continue
        # Only warn about TAUGHT points (real operator input), not
        # derived-from steps whose joints came from seeded IK — a
        # near-limit seeded solution reflects the anchor, and warning
        # about the anchor separately below is enough.
        if steps[i].get('derived_from') and not steps[i].get('taught_joints'):
            continue
        margins = _joint_limit_margin(j)
        tight = [(k + 1, margins[k]) for k in range(6)
                 if margins[k] == margins[k] and margins[k] < warn_margin]
        if tight:
            worst_axis, worst_margin = min(tight, key=lambda pair: pair[1])
            findings.append(_finding(
                i, steps[i], 'warn',
                'joint_limit_margin',
                f'J{worst_axis} within {worst_margin:.2f}° of its ±{_JOINT_LIMITS_DEG[worst_axis-1]:g}° limit '
                f'(threshold {warn_margin:g}°) — this pose will age badly if the '
                f'part shifts or the tool is swapped',
                'Re-teach the point with more margin — jog inward '
                'a few degrees on the joint flagged.',
                metrics={
                    'joints_deg':  list(j),
                    'margins_deg': list(margins),
                }))

    # ── Rule 2b: speed cap when segment path passes near a limit
    # or within N° of |J5|=0 ───────────────────────────────────
    cap_margin = float(ac['joint_limit_margin_cap_deg'])
    wrist_sing = float(ac['wrist_singularity_deg'])
    speed_scale = float(ac['near_limit_speed_scale'])
    n_samples   = int(ac['segment_path_samples'])
    # Walk consecutive resolvable-joint pairs.
    prev_j_for_seg = None
    prev_seg_idx = None
    for i, j in enumerate(resolved_j):
        if j is None:
            prev_j_for_seg = None if resolved_j[i] is None else j
            continue
        if prev_j_for_seg is None:
            prev_j_for_seg = j
            prev_seg_idx = i
            continue
        # Sample the linear joint path between prev and current.
        samples = _sample_joint_path(prev_j_for_seg, j, n_samples)
        min_limit_margin = float('inf')
        min_wrist_dist   = float('inf')
        worst_axis       = None
        for s_j in samples:
            m = _joint_limit_margin(s_j)
            for k in range(6):
                if m[k] == m[k] and m[k] < min_limit_margin:
                    min_limit_margin = m[k]
                    worst_axis = k + 1
            wsd = _wrist_singularity_distance_deg(s_j)
            if wsd < min_wrist_dist:
                min_wrist_dist = wsd
        triggered_reasons: list[str] = []
        if min_limit_margin < cap_margin:
            triggered_reasons.append(
                f'segment path approaches J{worst_axis} within '
                f'{min_limit_margin:.2f}° of ±{_JOINT_LIMITS_DEG[worst_axis-1]:g}° '
                f'(cap threshold {cap_margin:g}°)')
        if min_wrist_dist < wrist_sing:
            triggered_reasons.append(
                f'segment path approaches |J5|=0 wrist singularity '
                f'within {min_wrist_dist:.2f}° (threshold {wrist_sing:g}°)')
        if triggered_reasons:
            capped_pct = max(1, int(round(speed_scale * 100)))
            _add_adapt(i,
                       speed_pct_cap=capped_pct,
                       rules_applied=['near_limit_speed_cap'],
                       reasons=triggered_reasons)
            findings.append(_finding(
                i, steps[i], 'adapted',
                'near_limit_speed_cap',
                f'segment speed capped to {capped_pct}% of commanded — '
                + '; '.join(triggered_reasons),
                'Odd-pose steps run slow-and-safe. Re-teach with more '
                'margin from the limit to lift the cap.',
                metrics={
                    'min_limit_margin_deg':  min_limit_margin,
                    'min_wrist_distance_deg': min_wrist_dist,
                    'worst_axis':            worst_axis,
                    'speed_scale':           speed_scale,
                }))
        prev_j_for_seg = j
        prev_seg_idx = i

    # ── Rule 2a: blend radius scales to segment length ────────
    # Only meaningful for the SMOOTH profile — we still compute the
    # override so a program that later flips to SMOOTH picks it up.
    profile_radius = float(mc['blend_radius_mm'].get(
        str((program.get('config') or {}).get('blend_preset')
            or mc['default_blend_preset']),
        mc['blend_radius_mm']['medium']))
    frac = float(ac['adaptation_blend_frac'])
    for i in range(n):
        # Compute shorter of segments INTO and OUT of this waypoint.
        # segment_lengths_mm[i] is the length INTO step i.
        into = segment_lengths_mm[i]
        # Length OUT of step i = segment_lengths_mm of next
        # resolvable step (the segment that STARTS at step i).
        out = None
        for k in range(i + 1, n):
            if segment_lengths_mm[k] is not None:
                out = segment_lengths_mm[k]
                break
        candidates = [x for x in (into, out) if x is not None]
        if not candidates:
            continue
        shorter = min(candidates)
        scaled_radius = frac * shorter
        # Only record the adaptation if the scaled radius is smaller
        # than the profile default (no point overriding to a larger
        # value — the profile already picks the max sensible).
        if scaled_radius < profile_radius:
            _add_adapt(i,
                       blend_radius_mm_override=round(scaled_radius, 2),
                       rules_applied=['blend_radius_scaling'],
                       reasons=[
                           f'shorter adjacent segment {shorter:.1f}mm × '
                           f'{frac:g} = {scaled_radius:.1f}mm (< profile '
                           f'{profile_radius:g}mm)'])
            findings.append(_finding(
                i, steps[i], 'adapted',
                'blend_radius_scaling',
                f'blend radius scaled to {scaled_radius:.1f}mm '
                f'(profile {profile_radius:g}mm capped by 25% × shorter '
                f'segment {shorter:.1f}mm)',
                None,
                metrics={
                    'shorter_adjacent_segment_mm': shorter,
                    'scaled_radius_mm':            scaled_radius,
                    'profile_radius_mm':           profile_radius,
                }))

    # ── Rule 2c: descent length sanity ─────────────────────────
    max_desc = float(ac['max_descent_mm'])
    split_z  = float(ac['descent_split_stop_above_mm'])
    for i in range(n):
        # A "descent" here is a derived_from step with negative
        # offset_z_mm (i.e. dropping toward the contact) OR the
        # taught contact whose immediately-preceding derived approach
        # sits > max_desc above it. Codegen doesn't have a "downward
        # approach" step in current usage — approaches are POSITIVE
        # offset_z_mm above the contact, and the descent is the
        # taught contact itself after that approach. So the descent
        # length equals the approach's offset_z_mm.
        if not steps[i].get('taught_joints'):
            continue
        if steps[i].get('derived_from'):
            continue
        # Find the immediately-preceding derived approach for this
        # contact (same position_role, derived_from).
        role = steps[i].get('position_role')
        if not role:
            continue
        approach_offset = None
        for k in range(i - 1, -1, -1):
            if steps[k].get('derived_from') == role \
                    and steps[k].get('offset_z_mm') is not None:
                approach_offset = float(steps[k].get('offset_z_mm'))
                break
        if approach_offset is None or approach_offset < max_desc:
            continue
        # Fires: this descent is > max_desc mm. Adapt: split at
        # split_z above the contact.
        _add_adapt(i,
                   descent_split={
                       'fast_stop_z_above_contact_mm': split_z,
                       'gentle_accL_mm_per_s2':
                           float(mc['gentle_descent_accL_mm_per_s2']),
                       'approach_offset_mm':           approach_offset,
                   },
                   rules_applied=['descent_split'],
                   reasons=[
                       f'descent {approach_offset:.0f}mm > threshold '
                       f'{max_desc:g}mm — split at {split_z:g}mm above contact'])
        findings.append(_finding(
            i, steps[i], 'adapted',
            'descent_split',
            f'long descent ({approach_offset:.0f}mm) split into a fast movL '
            f'to {split_z:g}mm above the contact + a gentle-accel final descent',
            'Long reaches stop being long lunges. Verify the split-point '
            f'({split_z:g}mm above the taught contact) is reachable and safe.',
            metrics={
                'descent_mm':          approach_offset,
                'split_at_mm':         split_z,
                'gentle_accL':         float(mc['gentle_descent_accL_mm_per_s2']),
            }))

    # ── Rule 2d: micro-segment coalescing ──────────────────────
    micro = float(ac['micro_segment_mm'])
    for i in range(n):
        L = segment_lengths_mm[i]
        if L is None or L >= micro:
            continue
        # Two consecutive resolvable poses within `micro_segment_mm`.
        # We coalesce forward — the CURRENT step gets absorbed into
        # its predecessor (the operator's most-recent teach usually
        # supersedes an earlier duplicate).
        _add_adapt(i,
                   coalesce_with_prev=True,
                   rules_applied=['micro_coalesce'],
                   reasons=[f'cartesian gap {L:.2f}mm < {micro:g}mm — '
                            f'likely duplicate teach; suppressed as no-op move'])
        findings.append(_finding(
            i, steps[i], 'adapted',
            'micro_coalesce',
            f'cartesian gap to previous move {L:.2f}mm — likely duplicate '
            f'teach; this step suppressed (motion coalesced into predecessor)',
            'Check whether this step should have targeted a different pose. '
            'If it is a duplicate teach, delete it from the program.',
            metrics={'cartesian_gap_mm': L, 'threshold_mm': micro}))

    # ── Rule 2e: awkward-wrist transit → force profile=joint ───
    awk = float(ac['awkward_wrist_delta_deg'])
    for i in range(n):
        wd = wrist_deltas_deg[i]
        if wd is None or wd <= awk:
            continue
        # Only meaningful when the STEP itself is a transit — an
        # already-jointed home-return has nothing to gain.
        action = str(steps[i].get('action') or '').lower()
        if action == 'move_linear':
            _add_adapt(i,
                       force_motion_profile='joint',
                       rules_applied=['awkward_wrist_transit'],
                       reasons=[
                           f'wrist delta {wd:.1f}° > {awk:g}° — a cartesian '
                           f'movL with a spinning wrist is the worst of both '
                           f'worlds; forcing joint-space transit'])
            findings.append(_finding(
                i, steps[i], 'adapted',
                'awkward_wrist_transit',
                f'wrist delta {wd:.1f}° exceeds {awk:g}° threshold — '
                f'forcing motion_profile=joint for this transit only',
                'Consider re-teaching so the two endpoints share wrist '
                'orientation. See the J4-saga writeup in PART_2C_ARCHITECTURE.md.',
                metrics={'wrist_delta_deg': wd, 'threshold_deg': awk}))

    # ── Rule 3c: inconsistent wrist across program ─────────────
    inc = float(ac['inconsistent_wrist_deg'])
    inc_min = int(ac['inconsistent_wrist_min_count'])
    # Collect wrist-orientation triples for TAUGHT poses only (excl.
    # derived approaches — those inherit).
    taught_wrists: list[tuple[int, list[float]]] = []
    for i, s in enumerate(steps):
        if s.get('derived_from') and not s.get('taught_joints'):
            continue
        j = resolved_j[i]
        if j is None:
            continue
        taught_wrists.append((i, j[3:6]))
    if len(taught_wrists) >= 2:
        differing_pairs = 0
        max_delta = 0.0
        for a in range(len(taught_wrists)):
            for b in range(a + 1, len(taught_wrists)):
                d = max(abs(taught_wrists[a][1][0] - taught_wrists[b][1][0]),
                        abs(taught_wrists[a][1][1] - taught_wrists[b][1][1]),
                        abs(taught_wrists[a][1][2] - taught_wrists[b][1][2]))
                if d > inc:
                    differing_pairs += 1
                    if d > max_delta:
                        max_delta = d
        if differing_pairs >= inc_min:
            # Point the finding at the FIRST taught step so the
            # dashboard has an anchor to focus in the editor.
            first_i = taught_wrists[0][0]
            findings.append(_finding(
                first_i, steps[first_i], 'warn',
                'inconsistent_wrist_orientation',
                f'{differing_pairs} taught-point pair(s) differ by more than '
                f'{inc:g}° in wrist axes (max {max_delta:.1f}°) — '
                f'inconsistent wrist orientations across the program',
                'Consider consistent wrist orientation. Use the [Match] '
                'tool in the teach drawer once it ships.',
                metrics={
                    'differing_pairs': differing_pairs,
                    'max_wrist_delta_deg': max_delta,
                    'threshold_deg':  inc,
                    'taught_count':   len(taught_wrists),
                }))

    # ── Rule 3b: approach height less than part height ─────────
    # Requires part_index binding. Bowl program has part_ids=[] so
    # this is a no-op today; wired for when a bound program lands.
    if part_index is not None:
        pbd = (program.get('config') or {}).get('pbd_metadata') or {}
        part_ids = pbd.get('part_ids') or []
        # Compute the tallest bound part's extent along its Z axis
        # (cm → mm).  extents_cm = [width, depth, height] per the
        # parts library convention (verify against the index shape).
        max_h_mm = None
        parts_list = part_index.get('parts', []) if isinstance(part_index, dict) else []
        by_id = {p.get('id'): p for p in parts_list if isinstance(p, dict)}
        for pid in part_ids:
            p = by_id.get(pid)
            if not p:
                continue
            ext = p.get('extents_cm') or []
            if len(ext) >= 3:
                h_mm = float(ext[2]) * 10.0
                if max_h_mm is None or h_mm > max_h_mm:
                    max_h_mm = h_mm
        if max_h_mm is not None:
            for i, s in enumerate(steps):
                if not s.get('derived_from') or s.get('offset_z_mm') is None:
                    continue
                ofs = float(s.get('offset_z_mm'))
                if ofs < max_h_mm:
                    findings.append(_finding(
                        i, s, 'warn',
                        'approach_below_part_height',
                        f'approach offset {ofs:.0f}mm is less than part '
                        f'height {max_h_mm:.0f}mm — approach may collide '
                        f'with the part itself',
                        'Raise approach height above the part or '
                        're-teach the contact so the approach clears.',
                        metrics={'approach_mm': ofs,
                                 'part_max_height_mm': max_h_mm}))

    # ── Rule 3d: contact pose whose approach direction isn't
    # tool-aligned. Placeholder — needs a wire-verified movLToolRel
    # or a tool-frame vector on the step. Flag today as an info
    # finding; adapt later when the vocabulary ships.
    # No adaptation is applied — this is pure surfacing.

    # Sort findings by step index for a stable UI ordering.
    findings.sort(key=lambda f: (f['step_idx'], f['rule']))

    return {
        'program_id': program.get('id'),
        'findings':    findings,
        'adaptations': adaptations,
        'metrics': {
            'segment_lengths_mm':  segment_lengths_mm,
            'wrist_deltas_deg':    wrist_deltas_deg,
            'resolved_joints':     resolved_j,
        },
        'analyzer_config': ac,
    }


def codegen_lua_from_program(
    program: dict,
    *,
    operator_speed_limit_pct: int,
    point_prefix: str = 'p',
    motion_config: dict | None = None,
    motion_check: dict | None = None,
    part_index: dict | None = None,
) -> tuple[str, dict[str, dict], int]:
    """Turn a taught-program dict into (lua_source, varspoint, effective_pct).

    Only steps with 6-element `taught_joints` are emitted. Anything
    else is skipped with a comment so the operator sees the gap in
    the generated file.

    Speed selection: the program's own `config.speed_pct` (or the
    top-level `speed_pct`) is CAPPED at operator_speed_limit_pct.
    The cap is a hard limit — no matter what a program requests,
    the emitted `Robot/setAutoMoveRate` sits at or below the
    operator ceiling.

    `motion_config` (dict, optional) — carries the vocabulary settings
    for setSpeedJ / setSpeedL / setAccL emission and the SMOOTH
    profile's blend radii. Passed through _merged_motion_config so
    partial dicts are OK. See DEFAULT_MOTION_CONFIG for the shape.
    When None, defaults are used — the SMOOTH profile stays gated off
    (wire_verified_blender=False), which is the intended state until a
    bench probe proves setBlender is callable on this controller.

    Motion profile: read from `program.config.motion_profile` (default
    from motion_config.default_motion_profile — 'joint' at release).
    Values: 'joint' | 'straight' | 'smooth'. Per-step override on
    `step.motion_profile`. The profile controls how TRANSIT steps
    (approach / retreat / derived offset moves) are emitted; taught
    CONTACT steps are still gated by the wrist-lock guard and the
    zero-length movL guard.

    Point entries follow the shape mined from the factory UI bundle
    (see _make_jp_point) — {postype:"jp", nm, val:<JSON string>}.
    """
    mc = _merged_motion_config(motion_config)
    cfg = program.get('config') or {}
    requested_pct = int(
        cfg.get('speed_pct')
        or program.get('speed_pct')
        or 10  # conservative default
    )
    eff_pct = max(1, min(int(operator_speed_limit_pct), requested_pct))

    # ── Motion profile resolution ────────────────────────────────
    program_profile = str(cfg.get('motion_profile')
                          or program.get('motion_profile')
                          or mc['default_motion_profile']).lower()
    # 2026-07-31 §3 introduces 'standard' — station columns are movL
    # orientation-locked, transits between stations are movJ (optionally
    # blended when wire_verified_blender is on).
    if program_profile not in ('joint', 'straight', 'smooth', 'standard'):
        program_profile = 'joint'
    # Blender radius (mm): profile 'smooth' picks a preset by name
    # (fine/medium/smooth) from motion_config; the program or a step
    # can override with an explicit `blend_radius_mm`.
    blend_preset = str(cfg.get('blend_preset')
                       or program.get('blend_preset')
                       or mc['default_blend_preset']).lower()
    default_radius = float(
        mc['blend_radius_mm'].get(blend_preset,
                                  mc['blend_radius_mm']['medium']))
    program_blend_radius_mm = float(cfg.get('blend_radius_mm')
                                    or program.get('blend_radius_mm')
                                    or default_radius)

    # Descent acceleration mode — 'normal' (no setAccL emission at all)
    # or 'gentle' (setAccL(<gentle>) before contact descent, restored
    # before the next non-descent linear move).
    descent_accel_mode = str(cfg.get('descent_accel')
                             or program.get('descent_accel')
                             or mc['default_descent_accel']).lower()
    if descent_accel_mode not in ('normal', 'gentle'):
        descent_accel_mode = 'normal'

    # SMOOTH / STANDARD blender gate — actual emission of setBlender /
    # setNoBlender. When the program requests SMOOTH or STANDARD but
    # wire_verified_blender is off, we STILL compute demotion metadata
    # so the header note lists exactly which waypoints would have been
    # demoted; we just don't emit the blend/no-blend calls themselves.
    #
    # (2026-07-31 §3: STANDARD blends only on transits between stations;
    # SMOOTH blends on every non-demoted waypoint. The two share the
    # same wire_verified_blender gate.)
    wire_blender = bool(mc.get('wire_verified_blender', False))
    _profile_wants_blender = program_profile in ('smooth', 'standard')
    smooth_active_on_wire = _profile_wants_blender and wire_blender
    smooth_requested_but_gated = _profile_wants_blender and not wire_blender

    # Standard-profile column/transit classification. Empty for other
    # profiles (the walker just uses action-based verb selection).
    standard_class: list[str] = (
        _classify_standard_columns(list(program.get('steps') or []))
        if program_profile == 'standard' else []
    )

    # Absolute speed derivation:
    #   dps  = pct/100 * max_joint_speed_dps    (setSpeedJ input)
    #   mmps = pct/100 * max_linear_speed_mmps  (setSpeedL input)
    # max_joint_speed_dps is a per-joint list (2026-07-31 §2) OR a
    # scalar (legacy callers; kept for back-compat). setSpeedJ takes
    # one scalar — use the MIN of the per-joint values so no joint is
    # commanded above its rated max on a multi-joint move.
    _mj_raw = mc['max_joint_speed_dps']
    if isinstance(_mj_raw, (list, tuple)) and _mj_raw:
        max_dps  = float(min(float(v) for v in _mj_raw))
    else:
        max_dps  = float(_mj_raw)
    max_mmps = float(mc['max_linear_speed_mmps'])

    # ── Analyzer + adaptations plumbing (2026-07-30 §1-§4) ──────
    # If the caller didn't supply a precomputed motion_check, run
    # the analyzer here so codegen always has adaptations metadata.
    # `adaptations_enabled` is the program-level on/off switch —
    # when 'off', the analyzer STILL runs (findings show up in the
    # header) but the emission logic ignores the adaptations dict.
    if motion_check is None:
        motion_check = analyze_program(program,
                                       motion_config=mc,
                                       part_index=part_index)
    adaptations_enabled = str(
        cfg.get('adaptations')
        or program.get('adaptations')
        or 'on').lower() != 'off'
    _adapt_map: dict[int, dict] = (motion_check.get('adaptations') or {}) \
        if adaptations_enabled else {}
    _findings: list[dict] = list(motion_check.get('findings') or [])

    steps = program.get('steps') or []
    varspoint: dict[str, dict[str, list[float]]] = {}
    lines: list[str] = []
    lines.append(f'-- generated by estun_driver.program_ops '
                 f'from program {program.get("id","<unknown>")!r}')
    lines.append(f'-- taught steps: {len(steps)}, '
                 f'requested speed_pct={requested_pct}, '
                 f'operator_cap_pct={operator_speed_limit_pct}, '
                 f'effective_pct={eff_pct}')
    lines.append('')

    # Line numbering matters here: setStartLine + project/runStep act on
    # file-line numbers, and the demo project we validated shape against
    # had movJ at line 1. So we emit EXECUTABLE statements starting at
    # line 1 (with inline trailing `--` comments for review context)
    # and put the header/trailer AFTER, not before. That way rung 2's
    # `setStartLine 1` puts the interpreter exactly on `movJ(p1)`.
    #
    # Two step-source paths land at the same movJ output:
    #   1. program.points table + step.point_name  — the schema authored
    #      via /api/programs/{id}/points. Preferred; the point is a
    #      first-class reusable entity across steps.
    #   2. step.taught_joints (legacy PBD-draft path). Kept for backward
    #      compat; each such step gets its own auto-named point (p1,
    #      p2, ...) unique to that step.
    #
    # Points from path (1) are emitted into varspoint under their
    # AUTHORED names; path (2) uses point_prefix + index. If both a
    # point_name and taught_joints are present on the same step, the
    # named point wins (authored schema is authoritative).
    # Verb table verified against the controller's own
    # /webmodel/cocontrol/luaeditor/luaenginelib.json (captured in
    # data/estun_captures/estun_lua_io_v2_20260721.har). Every verb
    # emitted below is a key in that library with the exact spelling
    # shown here. Do NOT re-invent spellings — the interpreter rejects
    # unknown names with 10012-class errors before any move runs.
    #
    # Wire-verified verbs currently used:
    #   movJ(p, opts)            movJ($1,{v=..., a=..., b=..., ...})
    #   setDO(port, value)       setDO($1,$2)      port in [0, 17]
    #   setAO(port, value)       setAO($1,$2)      port in [0, 3]
    #
    # Wire-verified but not yet emitted (available for a future
    # DI-wait / DO-read step):
    #   val = getDI(port)        val = getDI($1)
    #   val = getDO(port)        val = getDO($1)
    #   val = getAI(port)        val = getAI($1)
    #   val = getAO(port)        val = getAO($1)
    #
    # Delay: the 168-entry library has NO plain sleep/wait/delay verb.
    # The only wait-shaped primitive is waitCondition(cond, timeout) —
    # timeout unit unverified. A `wait` step therefore stays SKIPPED in
    # the emitted Lua with an explanatory comment; the operator-side UI
    # continues to flag it as "pending capture" in StepPreviewPanel.
    program_points = program.get('points') or {}
    # Pre-pass 1 (FIX C, home-drift normalization): the wizard authors
    # both the start-of-cycle and end-of-cycle move_home steps against
    # the same `taught_home` fixture, but a later editor re-teach on
    # one of them (without the other) can leave the program with two
    # move_home steps that disagree on joints. That drift causes the
    # arm to sweep to a different pose on each cycle boundary — the
    # J1/J6 wrist rotation reported by the operator. Normalize here:
    # take the FIRST move_home step's taught_joints as authoritative
    # and rewrite any subsequent move_home step whose joints differ by
    # >5° in any axis. Non-destructive to the on-disk JSON — we work on
    # a local list. Emit a warning comment into the Lua header so the
    # operator can see the alignment happened.
    #
    # 5° threshold: matches the validation the dashboard save endpoint
    # applies (any single-axis drift above that flags the program for
    # the operator).
    steps = list(steps)  # local shallow copy — never mutate the caller's
    home_drift_notes: list[str] = []
    first_home_joints = None
    first_home_tcp = None
    first_home_idx = None
    HOME_DRIFT_DEG = 5.0
    for i, s in enumerate(steps):
        if str(s.get('action') or '').lower() != 'move_home':
            continue
        tj = s.get('taught_joints')
        if not (isinstance(tj, list) and len(tj) == 6
                and all(isinstance(v, (int, float)) for v in tj)):
            continue
        if first_home_joints is None:
            first_home_joints = [float(v) for v in tj]
            first_home_tcp = s.get('taught_tcp')
            first_home_idx = i
            continue
        deltas = [abs(float(a) - float(b))
                  for a, b in zip(tj, first_home_joints)]
        max_delta = max(deltas)
        if max_delta > HOME_DRIFT_DEG:
            # Rewrite this step's taught data to match the first home.
            # Keep the step's own metadata (label, step-index, id)
            # so the executor's per-step logging still reports "step 15
            # Return to home", just with the aligned joints.
            aligned = dict(s)
            aligned['taught_joints'] = list(first_home_joints)
            if first_home_tcp is not None:
                aligned['taught_tcp'] = list(first_home_tcp)
            aligned['joints'] = list(first_home_joints)
            steps[i] = aligned
            home_drift_notes.append(
                f'step {s.get("step", i+1)} '
                f'({s.get("label") or "move_home"}): '
                f'aligned to step {steps[first_home_idx].get("step", first_home_idx+1)} '
                f'(max joint delta was {max_delta:.2f}° > {HOME_DRIFT_DEG}°)')
    # Pre-pass 2: resolve position_role → taught data so `derived_from`
    # children (descend / lift / retreat) can compute concrete poses
    # at codegen time rather than being emitted as `-- skipped`.
    role_map = _build_role_map(steps)
    exec_lines: list[str] = []
    fallback_idx = 0
    di_read_idx  = 0   # counts wait_input steps → _di1, _di2, ... locals
    used_named: set[str] = set()   # named points that got REFERENCED
    # Points saved BY STEP ID for reuse — a derived step with
    # offset_z_mm≈0 emits movJ pointing at its anchor's already-
    # registered varspoint. Keyed on the ANCHOR STEP'S UNIQUE id (not
    # role) so multi-pair programs pick the right pair's varspoint;
    # the pre-fix version used {role → point_name} which collapsed
    # both pick-place pairs onto whichever landed first. Fallback
    # role→name kept as a legacy key for programs whose taught steps
    # have no id at all.
    step_point_name: dict[int, str] = {}
    role_point_name: dict[str, str] = {}   # legacy fallback
    # Zero-length-movL guard (Part C, 2026-07-22). The controller's
    # blend planner crashed on real hardware when asked to execute a
    # movL whose target equals the CURRENT pose (0 mm Cartesian
    # motion) — log-proven firmware bug. We track the joints of the
    # previously-emitted move; if a new movL would target the same
    # 6-vector, we skip it with a loud comment. Applies only to
    # movL (movJ back-to-back at the same joints is a controller-
    # tolerated no-op).
    last_move_joints: list[float] | None = None
    # Loop step handling. There are three cases:
    #   count == 0  (continuous)  — emit `goto ::_prog_start::` at the
    #                               loop step and prepend the label at
    #                               file line 1. Wire-verified.
    #   count == 1                 — no loop wrapping at all; the step
    #                               is a no-op (matches today's
    #                               "run once" byte output).
    #   count >= 2  (finite)       — wrap the body in a Lua counted
    #                               `for i=1,N do ... end`. The
    #                               initial move_home stays OUTSIDE
    #                               the loop (home once, then cycle
    #                               pick/place); the trailing
    #                               return-to-home stays inside so
    #                               each cycle ends at a safe pose.
    # A finite-count wrapping suppresses the `::_prog_start::` label
    # (for-loop doesn't need a goto target). Track which mode this
    # program uses so the walker below emits the right skeleton.
    _loop_step   = next((s for s in steps
                          if str(s.get('action') or '').lower() == 'loop'),
                        None)
    _loop_count  = int((_loop_step.get('count') if _loop_step else 0) or 0)
    _use_forloop = _loop_step is not None and _loop_count >= 2
    _use_goto    = _loop_step is not None and _loop_count == 0
    needs_start_label = _use_goto
    # Index (in `steps`) of the first move_home — the anchor around
    # which the for-loop wraps. `None` when no move_home exists (the
    # for-loop then wraps everything after the first step).
    _forloop_open_after_idx = None
    if _use_forloop:
        for _i, _s in enumerate(steps):
            if str(_s.get('action') or '').lower() == 'move_home':
                _forloop_open_after_idx = _i
                break
    # Records the exec_lines position at which the for-loop opener
    # was injected, purely for post-walk sanity. If for some reason
    # the initial move_home never emits (skipped, malformed pose,
    # etc.) we still open the for-loop right before the first
    # non-loop step so the counted body isn't lost.
    _forloop_opened = False

    # ── Motion-vocabulary modal state (2026-07-29) ────────────────
    # Compute blend-demotion marks over all steps up-front — cartesian
    # segment lengths, taught-contact detection, linked/zero-length
    # waypoints, program-end. Every mark's reason gets written into
    # the emitted comment so the operator can see WHY a waypoint was
    # demoted (useful when SMOOTH is the requested profile and a
    # short segment is quietly closing its blend).
    _demote_marks = _mark_blend_demotions(steps, mc, program_blend_radius_mm)
    # Modal-emission state — the whole point of the vocabulary work
    # is to only re-emit set* verbs when the effective value changes.
    # `None` means "not emitted yet this program" — the first motion
    # emits the initial value unconditionally.
    _last_speed_j: float | None = None
    _last_speed_l: float | None = None
    _last_accl:    float | None = None
    _blender_on:   float | None = None   # current radius mm, or None = off

    def _step_effective_pct(step: dict, step_idx: int | None = None) -> int:
        """Per-step speed override capped at the already-computed program
        eff_pct AND at any analyzer-supplied `speed_pct_cap` (rule 2b).
        A step never gets to move FASTER than either cap; it can only
        go slower. `step_idx` optional so callers without an index can
        still use the base override logic; analyzer caps take effect
        only when an index is available and adaptations are enabled."""
        raw = step.get('speed_pct')
        if raw is None:
            base = int(eff_pct)
        else:
            try:
                v = int(raw)
                base = max(1, min(int(eff_pct), v))
            except (TypeError, ValueError):
                base = int(eff_pct)
        if step_idx is not None:
            cap = (_adapt_map.get(step_idx) or {}).get('speed_pct_cap')
            if cap is not None:
                try:
                    base = min(base, int(cap))
                except (TypeError, ValueError):
                    pass
        return max(1, base)

    def _step_is_contact_descent(step: dict) -> bool:
        """A 'contact descent' for the gentle-accel bracket = a taught
        move_linear step with 6-el taught_joints AND no derived_from.
        These are the operator-taught contact poses; the descent INTO
        one is what the operator wants slowed down when
        descent_accel=='gentle'."""
        if str(step.get('action') or '').lower() != 'move_linear':
            return False
        if step.get('derived_from'):
            return False
        tj = step.get('taught_joints')
        return (isinstance(tj, list) and len(tj) == 6
                and all(isinstance(v, (int, float)) for v in tj))

    def _emit_motion_prelude(step_idx: int, verb: str, step: dict):
        """Append any needed setSpeedJ/setSpeedL/setAccL/setBlender/
        setNoBlender lines to exec_lines BEFORE the motion emission.
        Mutates the enclosing modal-state locals.

        Called from every motion-emission branch (derived FIX A/C,
        movJCoorRel fallback, point-name motion, inline taught_joints).
        Read the header comment for the SPEED / ACCEL / BLENDER
        emission contract."""
        nonlocal _last_speed_j, _last_speed_l, _last_accl, _blender_on
        step_pct = _step_effective_pct(step, step_idx)
        # Analyzer adaptation for this step (rule 2a/2b/2e), if any.
        _adapt = _adapt_map.get(step_idx) or {}
        _adapt_blend_override = _adapt.get('blend_radius_mm_override')
        _adapt_force_profile  = _adapt.get('force_motion_profile')
        _adapt_reasons        = _adapt.get('reasons') or []
        # Adaptation stamp — one comment summarizing which rules
        # touched this step's parameters, so the emitted Lua is
        # self-explanatory alongside the motion_check report.
        if _adapt_reasons:
            _rules_applied = _adapt.get('rules_applied') or []
            exec_lines.append(
                f'-- motion_check ADAPTED (rules: {",".join(_rules_applied)}): '
                + ' | '.join(_adapt_reasons))
        # ── SPEED ────────────────────────────────────────────────
        # setSpeedJ controls joint-space cruise (movJ, movJCoorRel);
        # setSpeedL controls cartesian cruise (movL). Modal — only
        # re-emit when the effective value changes. Units per
        # luaenginelib.json entries setSpeedJ(${vvd}) / setSpeedL(${vvd})
        # and the Estun S-series manual convention: deg/s for J,
        # mm/s for L. NOTE: these units are not yet wire-confirmed on
        # THIS controller — the §5 first-run sheet measures observed
        # cartesian speed against the emitted mm/s value.
        if verb in ('movJ', 'movJCoorRel'):
            target = round(step_pct / 100.0 * max_dps, 3)
            if _last_speed_j is None or abs(target - _last_speed_j) > 1e-4:
                exec_lines.append(
                    f'setSpeedJ({target:g})  '
                    f'-- {step_pct}% × max {max_dps:g} deg/s = {target:g} deg/s '
                    f'(setSpeedJ is modal — re-emitted only when value changes)')
                _last_speed_j = target
        elif verb == 'movL':
            target_l = round(step_pct / 100.0 * max_mmps, 3)
            if _last_speed_l is None or abs(target_l - _last_speed_l) > 1e-4:
                exec_lines.append(
                    f'setSpeedL({target_l:g})  '
                    f'-- {step_pct}% × max {max_mmps:g} mm/s = {target_l:g} mm/s '
                    f'(setSpeedL is modal — re-emitted only when value changes)')
                _last_speed_l = target_l
        # ── ACCEL — gentle-descent bracket ───────────────────────
        # Only interacts with linear (setAccL). Joint accel (setAccJ)
        # left untouched at controller default — a gentle joint move
        # is more naturally expressed as a lower joint speed.
        if descent_accel_mode == 'gentle' and verb == 'movL':
            is_contact = _step_is_contact_descent(step)
            per_step_gentle = step.get('descent_accel')
            per_step_wants_gentle = None
            if isinstance(per_step_gentle, str):
                per_step_wants_gentle = per_step_gentle.lower() == 'gentle'
            if per_step_wants_gentle is False:
                # Step opts OUT of the gentle bracket even though the
                # program is gentle — restore default.
                want_accl = float(mc['default_accL_mm_per_s2'])
                tag = 'step opt-out'
            elif is_contact or per_step_wants_gentle is True:
                want_accl = float(mc['gentle_descent_accL_mm_per_s2'])
                tag = 'gentle-descent (contact)' if is_contact else 'gentle (per-step override)'
            else:
                # A non-descent linear step in a gentle-mode program —
                # emit the default so the previous gentle setAccL
                # doesn't linger onto a retreat / transit segment.
                want_accl = float(mc['default_accL_mm_per_s2'])
                tag = 'restore-default (post-descent)'
            if _last_accl is None or abs(want_accl - _last_accl) > 1e-4:
                exec_lines.append(
                    f'setAccL({want_accl:g})  '
                    f'-- descent_accel=gentle ({tag}); modal, only re-emitted on change')
                _last_accl = want_accl
        # ── BLENDER — SMOOTH profile, wire_verified_blender gated ─
        # smooth_active_on_wire == (program_profile == 'smooth'
        # AND motion_config['wire_verified_blender'] is True). When
        # False, no setBlender/setNoBlender is emitted regardless of
        # profile — but the demotion metadata still shows up in the
        # header note so the operator sees which waypoints WOULD
        # have been demoted.
        if smooth_active_on_wire:
            demote, reason = _demote_marks[step_idx] if step_idx < len(_demote_marks) else (False, '')
            # Per-step motion_profile override: an operator hand-
            # authoring can pin a specific step to 'joint' or 'straight'
            # inside a smooth program — those steps also demote.
            step_profile = str(step.get('motion_profile') or '').lower()
            # Rule 2e adaptation: analyzer-forced motion_profile on
            # awkward-wrist transits also demotes the blender.
            if _adapt_force_profile in ('joint', 'straight'):
                step_profile = _adapt_force_profile
            if step_profile in ('joint', 'straight'):
                demote = True
                reason = reason or f'step motion_profile={step_profile!r} inside smooth program'
            # 2026-07-31 §3 STANDARD: demote the blender ONLY when the
            # incoming segment is WITHIN a column (same station role
            # as the previous motion step). Segments between stations
            # or between home and a column entry are transits and get
            # blended. So:
            #   home → approach_pick      transit → column entry: BLEND
            #   approach_pick → contact   within pick column:    DEMOTE
            #   contact → retreat_pick    within pick column:    DEMOTE
            #   retreat_pick → approach_place  cross-column:     BLEND
            #   approach_place → contact  within place column:   DEMOTE
            #   ...
            if program_profile == 'standard' \
                    and step_idx < len(standard_class) \
                    and standard_class[step_idx] == 'column':
                # Find the previous motion step's column identity.
                prev_role = None
                for _j in range(step_idx - 1, -1, -1):
                    if _j >= len(standard_class):
                        continue
                    if standard_class[_j] == 'non_motion':
                        continue
                    if standard_class[_j] == 'column':
                        _prev = steps[_j]
                        prev_role = (_prev.get('derived_from')
                                     or _prev.get('position_role'))
                    else:
                        prev_role = None      # prev was a transit
                    break
                curr_role = (step.get('derived_from')
                             or step.get('position_role'))
                if prev_role is not None and prev_role == curr_role:
                    demote = True
                    reason = f'STANDARD: within {curr_role!r} column'
            if demote:
                if _blender_on is not None:
                    exec_lines.append(
                        f'setNoBlender()  -- demote: {reason} ({program_profile.upper()} modal)')
                    _blender_on = None
            else:
                # Rule 2a adaptation: analyzer may have scaled the
                # radius for this specific waypoint. Use the override
                # if present; otherwise the program-level radius.
                effective_radius = (float(_adapt_blend_override)
                                    if _adapt_blend_override is not None
                                    else program_blend_radius_mm)
                if _blender_on is None or abs(effective_radius - _blender_on) > 1e-4:
                    tag = (f'(profile={program_profile}, preset={blend_preset!r}'
                           f'; RULE 2a scaled from {program_blend_radius_mm:g}mm)'
                           if _adapt_blend_override is not None
                           else f'(profile={program_profile}, preset={blend_preset!r})')
                    exec_lines.append(
                        f'setBlender({effective_radius:g})  '
                        f'-- radius mm {tag}')
                    _blender_on = effective_radius

    for _step_idx, step in enumerate(steps):
        action = step.get('action', '?')

        # Rule 2d adaptation: coalesce_with_prev — the analyzer
        # flagged this step as a micro-duplicate of the previous
        # motion; skip the emission but leave a loud comment so the
        # operator can see WHY the step doesn't appear on the wire.
        _coalesce = (_adapt_map.get(_step_idx) or {}).get('coalesce_with_prev')
        if _coalesce:
            _reason = ' | '.join((_adapt_map.get(_step_idx) or {}).get('reasons') or [])
            exec_lines.append(
                f'-- motion_check COALESCED step {action!r} (rule micro_coalesce): '
                f'{_reason}  — no emission')
            continue

        # Inject the `for i=1,N do` opener right before the first step
        # AFTER the initial move_home (or before the first step
        # outright when no move_home exists). The trailing `end` is
        # emitted by the loop-step handler above.
        if _use_forloop and not _forloop_opened:
            _should_open = (
                (_forloop_open_after_idx is None and _step_idx == 0)
                or (_forloop_open_after_idx is not None
                    and _step_idx == _forloop_open_after_idx + 1)
            )
            if _should_open:
                exec_lines.append(
                    f'for i=1,{_loop_count} do  '
                    f'-- counted cycles (home outside; body inside)')
                _forloop_opened = True

        # ---- DO / AO set — verified verbs setDO / setAO --------------
        if action == 'set_io':
            io_id = str(step.get('io_id') or '').strip()
            m = _re.match(r'^(DO|AO)(\d+)$', io_id, _re.IGNORECASE)
            if not m:
                # DI writes aren't supported by the library (getDI is a
                # reader; no setDI verb exists). System-reserved names
                # (modeSwitch etc.) also fall through here.
                exec_lines.append(f'-- skipped {action!r}: '
                                  f'io_id {io_id!r} is not a writable DO/AO '
                                  f'(DI is read-only per luaenginelib; '
                                  f'system-reserved ports rejected)')
                continue
            kind = m.group(1).upper()
            port = int(m.group(2))
            raw_v = step.get('value')
            if kind == 'DO':
                if raw_v is None:
                    exec_lines.append(f'-- skipped {action!r} {io_id!r}: '
                                      f'value missing')
                    continue
                # DO takes 0/1 — coerce truthy → 1, everything else → 0.
                v = 1 if int(bool(raw_v)) == 1 and raw_v not in (0, '0', False) else 0
                exec_lines.append(f'setDO({port},{v})  -- step {action} {io_id}={v}')
            else:  # AO
                try:
                    v_f = float(raw_v)
                except (TypeError, ValueError):
                    exec_lines.append(f'-- skipped {action!r} {io_id!r}: '
                                      f'AO value {raw_v!r} not numeric')
                    continue
                exec_lines.append(f'setAO({port},{v_f:g})  -- step {action} {io_id}={v_f:g}')
            continue

        # ---- Wait / delay — wait(<ms>) (wire-proven, undocumented) ----
        # Emission: `wait(<int_ms>)`. Wire evidence trumps the library
        # catalogue here.
        #
        # Provenance:
        #   * `wait` is NOT in luaenginelib.json (168 catalogued verbs).
        #     Appears only in the editor palette template and the i18n
        #     bundle. On paper, [[cobot-lua-verb-provenance]] would rule
        #     it out.
        #   * BUT: 2026-07-29 UI screenshot + logs show `wait(500)`
        #     RESIDENT on the controller and executing cleanly on
        #     multiple bowl-pickplace runs. That is wire-proof no
        #     catalogue can override.
        #   * The 2026-07-30 08:40 alarm 10006 that triggered the
        #     wait-replacement rabbit hole was actually on
        #     `waitCondition(false, N)` — a DIFFERENT verb the analyzer
        #     mis-attributed as a `wait` fault. Two independent 10006
        #     hits (bench 08:40, run 14:08) confirmed waitCondition
        #     rejects the bare-literal condition slot. `wait(ms)` was
        #     never rejected — the systemTime() bounded-loop detour was
        #     unnecessary and untested.
        #
        # Linter: `wait` is whitelisted in _WIRE_PROVEN_UNDOCUMENTED
        # (see below) with a 1..1 arity. Any drift in arg count still
        # fails lint.
        #
        # This restores exactly the emission shape captured in the
        # 2026-07-29 resident: `wait(<int_ms>)` with a trailing
        # explanatory comment. Zero-duration waits still suppress to a
        # no-op comment — same behavior as before.
        if action == 'wait':
            try:
                dur = float(step.get('duration_s') or 0)
            except (TypeError, ValueError):
                dur = 0.0
            dur_ms = int(round(dur * 1000.0))
            # Preserve any positive dwell: if the operator authored a
            # non-zero duration but rounding zeroed it, floor to 1 ms
            # so the wait isn't silently deleted.
            if dur > 0 and dur_ms == 0:
                dur_ms = 1
            if dur_ms == 0:
                exec_lines.append(
                    f'-- step {action} duration_s=0 → no-op '
                    f'(wait emission suppressed)')
                continue
            exec_lines.append(
                f'wait({dur_ms})  '
                f'-- step {action}  duration_s={dur:g} → {dur_ms} ms '
                f'(wire-proven on v2.3, undocumented in luaenginelib; '
                f'not waitCondition — that idiom hits 10006)')
            continue

        # ---- Loop — for-loop wrap OR continuous goto ----------------
        # Wire-verified verbs: `goto`, `::label::`, plus plain Lua 5.3
        # counted `for` — none of these require a new controller verb.
        #   count == 0  (continuous) → `goto ::_prog_start::` (label
        #                             prepended before the first step
        #                             so the jump has a target).
        #   count == 1              → no output; the step is a no-op.
        #                             Preserves byte-identical Lua vs
        #                             the pre-cycles-input "run once"
        #                             mode (diff-verifiable).
        #   count >= 2  (finite)    → the loop body was opened with
        #                             `for i=1,N do` right after the
        #                             initial move_home; here we close
        #                             it with `end`.
        # For finite loops the initial move_home stays OUTSIDE (home
        # once at start of program); the trailing return-to-home
        # inside the loop keeps each cycle ending at a safe pose.
        if action == 'loop':
            count = int(step.get('count') or 0)
            if count == 0:
                exec_lines.append(f'goto _prog_start  -- step {action}  '
                                  f'continuous (count=0)')
            elif count == 1:
                # Explicit no-op — the composer/wizard could just as
                # well omit the loop step at count=1, but tolerating
                # it here keeps hand-authored programs runnable.
                exec_lines.append(f'-- step {action}  count=1 (no-op; '
                                  f'body runs once as authored)')
            else:
                exec_lines.append(
                    f'end  -- step {action}  '
                    f'for i=1,{count} counted loop end')
            continue

        # ---- Wait / verify input ------------------------------------
        # Two step shapes land here:
        #
        #   wait_input    — the legacy read-only shape. Emits a bare
        #                   `_diN = getDI(port)`, no blocking. Kept
        #                   for backward compat with programs that
        #                   sample DI and hand the value to a
        #                   downstream condition step.
        #
        #   verify_input  — the blocking-wait shape (§406 prompt).
        #                   Requires `expect` (0|1) and `timeout_ms`
        #                   on the step. Emits a single line:
        #                       waitCondition(getDI(<port>)==<expect>, <timeout_ms>)
        #                   `waitCondition` is wire-verified per
        #                   luaenginelib.json: {"lua":"${var} =
        #                   waitCondition(${condition},${timeout})"}.
        #                   The library entry shows the ${var} assignment
        #                   form but examples in the palette use the
        #                   bare-call form too — we emit the bare form
        #                   for a wait-until side effect since no
        #                   downstream step consumes the return value.
        #
        # A wait_input step CAN opt into blocking semantics by adding
        # `expect` + `timeout_ms` fields — the emitter upgrades to
        # waitCondition automatically. Bare wait_input (no expect)
        # stays on the read-only path.
        if action in ('wait_input', 'verify_input'):
            io_id = str(step.get('io_id') or '').strip()
            m = _re.match(r'^DI(\d+)$', io_id, _re.IGNORECASE)
            if not m:
                exec_lines.append(f'-- skipped {action!r}: '
                                  f'io_id {io_id!r} is not a DI port '
                                  f'(getDI reads DI channels only)')
                continue
            port = int(m.group(1))
            expect_raw = step.get('expect')
            timeout_ms_raw = step.get('timeout_ms')
            is_blocking = (action == 'verify_input'
                           or expect_raw is not None
                           or timeout_ms_raw is not None)
            if is_blocking:
                # Emit `waitCondition(getDI(N)==<expect>, <timeout_ms>)`.
                # expect defaults to 1 (signal received); timeout_ms
                # is required for the blocking shape — we refuse to
                # emit an unbounded wait.
                try:
                    expect_v = int(expect_raw) if expect_raw is not None else 1
                except (TypeError, ValueError):
                    exec_lines.append(f'-- skipped {action!r} {io_id!r}: '
                                      f'expect must be an int, got {expect_raw!r}')
                    continue
                if expect_v not in (0, 1):
                    exec_lines.append(f'-- skipped {action!r} {io_id!r}: '
                                      f'expect={expect_v} not 0 or 1')
                    continue
                if timeout_ms_raw is None:
                    exec_lines.append(
                        f'-- skipped {action!r} {io_id!r}: '
                        f'timeout_ms is required for blocking waitCondition '
                        f'(refusing to emit unbounded wait)')
                    continue
                try:
                    timeout_ms_v = int(timeout_ms_raw)
                except (TypeError, ValueError):
                    exec_lines.append(f'-- skipped {action!r} {io_id!r}: '
                                      f'timeout_ms not an integer '
                                      f'({timeout_ms_raw!r})')
                    continue
                if timeout_ms_v < 1:
                    exec_lines.append(f'-- skipped {action!r} {io_id!r}: '
                                      f'timeout_ms={timeout_ms_v} < 1')
                    continue
                exec_lines.append(
                    f'waitCondition(getDI({port})=={expect_v},{timeout_ms_v})  '
                    f'-- step {action} {io_id} expect={expect_v} '
                    f'timeout_ms={timeout_ms_v} '
                    f'(NOTE timeout unit inferred from library — bench-verify)')
                continue
            # Bare wait_input: legacy read-only path (unchanged).
            di_read_idx += 1
            local_name = f'_di{di_read_idx}'
            exec_lines.append(f'{local_name} = getDI({port})  '
                              f'-- step wait_input {io_id} '
                              f'(read only; add `expect`+`timeout_ms` to block)')
            continue

        # Verb selection: move_linear → movL, everything else that
        # reaches here (move_home / move_joint / approach / etc.) →
        # movJ. Matches program_executor_node.tick semantics.
        verb = 'movL' if str(action).lower() == 'move_linear' else 'movJ'
        # 2026-07-31 §3 STANDARD profile override: column steps
        # (approach-above / contact / retreat-above of a station) →
        # movL orientation-locked; transit steps (between stations,
        # home moves) → movJ. Ignores the action's own suggestion so
        # a wizard-authored move_linear home-transit becomes movJ.
        if program_profile == 'standard' \
                and _step_idx < len(standard_class):
            _cls = standard_class[_step_idx]
            if _cls == 'column':
                verb = 'movL'
            elif _cls == 'transit':
                verb = 'movJ'

        # ---- Derived offset resolver → movJ(anchor) OR movL cp --------
        # A move_linear step with `derived_from` + `offset_z_mm` and no
        # taught_joints of its own is a wizard-derived child. Two
        # branches with distinct safety properties:
        #
        # FIX A — |offset_z_mm| < 1 mm: emit `movJ(<anchor_point>)`.
        #   The derived pose IS the anchor pose. Reusing the anchor's
        #   already-registered jp varspoint entry guarantees the arm
        #   re-executes the EXACT taught joint solution — no IK, no
        #   wrist ambiguity. This is critical because Estun's movL
        #   solves inverse-kinematics fresh against the target TCP; if
        #   the TCP is identical to the current pose (which it is after
        #   the just-fired movJ to the anchor), IK can pick a DIFFERENT
        #   J4/J5/J6 branch that still satisfies the TCP — the wrist
        #   rotates without any Cartesian motion. movJ to the anchor
        #   name is exact.
        #
        # FIX B (v2) — |offset_z_mm| ≥ 1 mm: emit movJCoorRel with a
        #   relative-cp offset in base frame (coor=0). movJCoorRel is a
        #   wire-verified verb in luaenginelib.json whose semantics are
        #   documented as "Move from the current position, based on the
        #   user's coordinate system, [the] joint moves to the target
        #   point." Two properties that matter for our wrist problem:
        #     • the START pose is CURRENT joints — the arm is at the
        #       anchor after the just-fired movJ, so IK is seeded from
        #       the anchor's exact taught joint solution (including J5)
        #       and can't jump to a distant IK branch;
        #     • the TARGET is expressed as a RELATIVE cp offset
        #       ({cp={0,0,Δz,0,0,0}}) — no absolute orientation is
        #       resolved, so there's no rx/ry/rz for the IK to satisfy
        #       via a wrist flip.
        #   The previous mitigation — absolute-cp movL with coor=0 /
        #   tool=0 pinned — did NOT prevent J5 re-solve at runtime
        #   (operator observed ~138° J5 rotation on step 7). Delegating
        #   the IK to the controller with a relative offset and
        #   current-pose seed is the proper fix.
        #
        # Note on true codegen-time seeded IK: the URDF at
        # models/robots/estun_s10-140/ is untracked and unverified, and
        # a Python-side IK (ikpy / PyKDL) would need the exact DH/URDF
        # to match the controller's kinematics. Delegating to the
        # controller via movJCoorRel avoids that risk entirely — it
        # uses the arm's own kinematics.
        if step.get('derived_from') and not (
                isinstance(step.get('taught_joints'), list)
                and len(step.get('taught_joints')) == 6):
            role = step.get('derived_from')
            ofs_mm = float(step.get('offset_z_mm') or 0)
            # Multi-pair bug fix (2026-07-27). Resolve to the NEAREST
            # matching-role taught step by index distance — pair-local
            # scoping — instead of the previous last-writer-wins
            # role_map lookup that made pair-1 derived steps target
            # pair-2 anchors. `anchor` is the resolved step dict here
            # (or {} if nothing plausible); `anchor_id` keys the
            # per-step varspoint reuse map, so FIX A picks the RIGHT
            # pair's anchor point in multi-pair programs.
            anchor = _resolve_anchor_step(steps, _step_idx) or {}
            anchor_id = anchor.get('id') if isinstance(anchor, dict) else None
            # FIX A: offset ≈ 0 collapses to a movJ back to the anchor.
            # Prefer this branch whenever the anchor was already saved
            # as a jp point AND the offset is under 1 mm — the anchor's
            # taught_joints are authoritative, no IK involved.
            reuse_ref = None
            if anchor_id is not None and anchor_id in step_point_name:
                reuse_ref = step_point_name[anchor_id]
            elif role in role_point_name:
                # Legacy fallback for programs whose taught steps
                # never got id fields (older PBD outputs). Only
                # trusted when there's a SINGLE matching-role anchor
                # in the whole program — otherwise we'd re-introduce
                # the multi-pair collapse.
                matches = [s for s in steps
                           if isinstance(s, dict) and s.get('position_role') == role]
                if len(matches) == 1:
                    reuse_ref = role_point_name[role]
            if abs(ofs_mm) < 1.0 and reuse_ref is not None:
                ref = reuse_ref
                tj = anchor.get('taught_joints') or []
                joints_s = ', '.join(f'{float(v):+.3f}' for v in tj) if tj else ''
                j5_note = (f'J5={float(tj[4]):+.2f}°' if len(tj) >= 5 else 'J5=?')
                _emit_motion_prelude(_step_idx, 'movJ', step)
                exec_lines.append(
                    f'movJ({ref})  -- step {action}  '
                    f'derived_from={role!r} offset_z_mm={ofs_mm:g}  '
                    f'(FIX A: identity offset → reuse anchor jp; no IK)  '
                    f'{j5_note}'
                    + (f'  joints=[{joints_s}]' if joints_s else ''))
                if len(tj) == 6:
                    last_move_joints = [float(v) for v in tj]
                continue
            # FIX C (Part C, 2026-07-22): SEEDED IK at codegen time.
            # Compute the lifted joints from the anchor's taught_joints
            # holding J4/J5/J6 EXACTLY, solving q1/q2/q3 for the base-
            # frame Z lift. Emit `movJ(<lifted_point>)` referencing a
            # fresh jp varspoint entry so the controller runs OUR
            # joints — no IK, no branch choice, no wrist flip. Verify
            # J5 delta == 0 (holds by construction) and record the
            # taught-vs-emitted J5 for the operator table. Fall back to
            # movJCoorRel only when the IK can't converge (rare —
            # non-vertical tool at the anchor, or Δz outside J1/J2/J3
            # manifold).
            # `anchor` is already the nearest-by-distance anchor for
            # this derived step (resolved above in the FIX A branch).
            tj = anchor.get('taught_joints') or []
            if len(tj) == 6 and all(isinstance(v, (int, float)) for v in tj):
                anchor_deg = [float(v) for v in tj]
                anchor_j5 = anchor_deg[4]
                ik = seeded_ik_z_lift(anchor_deg, ofs_mm)
                if ik is not None:
                    lifted_deg, achieved = ik
                    j5_delta = abs(lifted_deg[4] - anchor_j5)
                    if j5_delta <= 5.0:
                        fallback_idx += 1
                        name = f'{point_prefix}{fallback_idx}'
                        while name in program_points or name in used_named:
                            fallback_idx += 1
                            name = f'{point_prefix}{fallback_idx}'
                        varspoint[name] = _make_jp_point(lifted_deg, name)
                        used_named.add(name)
                        joints_s = ', '.join(f'{v:+.3f}' for v in lifted_deg)
                        # 2026-07-31 §3 STRAIGHT / STANDARD path-
                        # feasibility check: on STRAIGHT, sample the
                        # seeded-IK path along the Z-lift; if the
                        # inter-sample joint velocity stays bounded
                        # (no branch flip), emit as movL for cartesian
                        # interpolation. STANDARD does the same for
                        # column-approach steps. JOINT / SMOOTH stay
                        # on the movJ emission.
                        emit_verb_derived = 'movJ'
                        feas_note = ''
                        if program_profile == 'straight' or (
                                program_profile == 'standard'
                                and _step_idx < len(standard_class)
                                and standard_class[_step_idx] == 'column'):
                            feas = _path_feasibility_sample(
                                anchor_deg, ofs_mm)
                            if feas['feasible']:
                                emit_verb_derived = 'movL'
                                feas_note = (
                                    f'  path_feas=ok worst={feas["worst_delta"]:.2f}°'
                                    f' on J{feas["worst_axis"]} ≤ {feas["threshold"]:g}°')
                            else:
                                exec_lines.append(
                                    f'-- STRAIGHT/STANDARD path-feasibility '
                                    f'FALLBACK to movJ ({feas["reason"]})')
                        # Orientation invariant stamp — FK the seeded
                        # joints vs the anchor's taught joints and
                        # report per-axis delta. Task §3 threshold
                        # is 1°; deviation above that warrants an
                        # operator note (still emit; check only
                        # informational at codegen).
                        orient_note = ''
                        emitted_orient = _tcp_orientation_deg(lifted_deg)
                        anchor_orient  = _tcp_orientation_deg(anchor_deg)
                        if emitted_orient is not None and anchor_orient is not None:
                            drx = abs(emitted_orient[0] - anchor_orient[0])
                            dry = abs(emitted_orient[1] - anchor_orient[1])
                            drz = abs(emitted_orient[2] - anchor_orient[2])
                            worst = max(drx, dry, drz)
                            flag = ' >1°(!) ' if worst > 1.0 else ''
                            orient_note = (
                                f'  orient_dev=(rx={drx:.2f}°,ry={dry:.2f}°,rz={drz:.2f}°)'
                                f' max={worst:.2f}°{flag}')
                        _emit_motion_prelude(_step_idx, emit_verb_derived, step)
                        exec_lines.append(
                            f'{emit_verb_derived}({name})  -- step {action}  '
                            f'derived_from={role!r} offset_z_mm={ofs_mm:g}  '
                            f'(FIX C: SEEDED IK Δz={achieved:+.2f} mm; '
                            f'taught J5={anchor_j5:+.2f}° → emitted J5={lifted_deg[4]:+.2f}° '
                            f'Δ{j5_delta:.3f}°)  joints=[{joints_s}]{feas_note}{orient_note}')
                        last_move_joints = list(lifted_deg)
                        continue
                    # J5 sanity trip — should NEVER happen (we hold J5)
                    # but the fallback path is safer than emitting a
                    # bad move.
                # else: IK didn't converge; fall through to movJCoorRel
            j5_note = (f'anchor J5={float(tj[4]):+.2f}°' if len(tj) >= 5 else 'anchor J5=?')
            exec_lines.append(
                f'-- SEEDED IK unavailable → falling back to movJCoorRel  '
                f'{j5_note}')
            _emit_motion_prelude(_step_idx, 'movJCoorRel', step)
            exec_lines.append(
                f'movJCoorRel({{cp={{0,0,{ofs_mm:g},0,0,0}}}},{{coor=0,tool=0}})  '
                f'-- step {action}  derived_from={role!r} '
                f'offset_z_mm={ofs_mm:g}  '
                f'(FIX B v2 fallback)')
            # movJCoorRel hands wrist branch selection to the
            # controller — downstream verifiers (zero-length guard,
            # wrist-deviation check on the next taught contact) must
            # treat the endpoint joints as UNKNOWN. Prior code left
            # last_move_joints at its previous value, which the
            # descend wrist check would have then compared against
            # a stale target. Wire evidence: none observed in the
            # bowl program (FIX B v2 never fired there), but the
            # invariant matters for legacy programs whose approach
            # is still on the movJCoorRel path.
            last_move_joints = None
            continue

        # ---- Motion — movJ/movL via point ref or inline taught_joints
        pn = step.get('point_name')
        if pn and pn in program_points:
            p = program_points[pn]
            j = p.get('joints') or p.get('jp')
            if not (isinstance(j, list) and len(j) == 6
                    and all(isinstance(v, (int, float)) for v in j)):
                exec_lines.append(f'-- skipped {action!r}: '
                                  f'point {pn!r} has no valid joints')
                continue
            j_list = [float(v) for v in j]
            # Zero-length-movL guard — see comment on last_move_joints.
            if verb == 'movL' and last_move_joints is not None \
                    and _joints_equal(j_list, last_move_joints):
                exec_lines.append(
                    f'-- SKIPPED zero-length movL: point={pn!r} equals '
                    f'previous move target (would crash controller '
                    f'blend planner — firmware bug guard)')
                continue
            if pn not in used_named:
                varspoint[pn] = _make_jp_point(j, pn)
                used_named.add(pn)
            role = step.get('position_role')
            if role and role not in role_point_name:
                role_point_name[role] = pn
            # Per-step id → varspoint name (bug fix 2026-07-27; picks
            # the right pair in multi-pair programs).
            sid = step.get('id')
            if sid is not None:
                step_point_name.setdefault(sid, pn)
            joints_s = ', '.join(f'{float(v):+.3f}' for v in j)
            j5_note = f'J5={float(j[4]):+.2f}°'
            # Wrist-lock guard on taught-contact descend (2026-07-28).
            # See _wrist_descend_safety docstring — when movL's start
            # and end wrist joints agree, the controller has no reason
            # to re-solve the wrist branch mid-cartesian; when they
            # disagree beyond _WRIST_LOCK_MAX_DEG we fall back to
            # movJ(pN) so the descend is joint-space (deterministic,
            # no re-solve, at the cost of orientation not being
            # slerped along a cartesian line).
            emit_verb = verb
            wrist_note = ''
            if verb == 'movL':
                chk = _wrist_descend_safety(j, last_move_joints)
                if chk['safe']:
                    wrist_note = (f'  wrist_dev=max{chk["max"]:.2f}° '
                                  f'(J4Δ={chk["j4"]:.2f}° J5Δ={chk["j5"]:.2f}° '
                                  f'J6Δ={chk["j6"]:.2f}°) ≤ {_WRIST_LOCK_MAX_DEG:.0f}°')
                else:
                    emit_verb = 'movJ'
                    exec_lines.append(
                        f'-- WRIST-LOCK FALLBACK: descend as joint-space movJ  '
                        f'(reason: {chk["reason"]})')
            _emit_motion_prelude(_step_idx, emit_verb, step)
            exec_lines.append(f'{emit_verb}({pn})  -- step {action}  point={pn}  '
                              f'{j5_note}  joints=[{joints_s}]{wrist_note}')
            last_move_joints = j_list
            continue
        taught = step.get('taught_joints')
        if not (isinstance(taught, list) and len(taught) == 6
                and all(isinstance(v, (int, float)) for v in taught)):
            exec_lines.append(f'-- skipped {action!r}: '
                              f'no point_name/points ref, no 6-el taught_joints '
                              f'(got {type(taught).__name__})')
            continue
        taught_list = [float(v) for v in taught]
        # Zero-length-movL guard.
        if verb == 'movL' and last_move_joints is not None \
                and _joints_equal(taught_list, last_move_joints):
            exec_lines.append(
                f'-- SKIPPED zero-length movL: inline taught_joints equal '
                f'previous move target (firmware blend-planner bug guard)')
            continue
        fallback_idx += 1
        name = f'{point_prefix}{fallback_idx}'
        while name in program_points or name in used_named:
            fallback_idx += 1
            name = f'{point_prefix}{fallback_idx}'
        varspoint[name] = _make_jp_point(taught, name)
        used_named.add(name)
        role = step.get('position_role')
        if role and role not in role_point_name:
            role_point_name[role] = name
        # Per-step id → varspoint name (multi-pair fix).
        sid = step.get('id')
        if sid is not None:
            step_point_name.setdefault(sid, name)
        joints_s = ', '.join(f'{float(v):+.3f}' for v in taught)
        j5_note = f'J5={float(taught[4]):+.2f}°'
        # Wrist-lock guard on taught-contact descend — see the twin
        # emission in the point_name branch above for the rationale.
        emit_verb = verb
        wrist_note = ''
        if verb == 'movL':
            chk = _wrist_descend_safety(taught, last_move_joints)
            if chk['safe']:
                wrist_note = (f'  wrist_dev=max{chk["max"]:.2f}° '
                              f'(J4Δ={chk["j4"]:.2f}° J5Δ={chk["j5"]:.2f}° '
                              f'J6Δ={chk["j6"]:.2f}°) ≤ {_WRIST_LOCK_MAX_DEG:.0f}°')
            else:
                emit_verb = 'movJ'
                exec_lines.append(
                    f'-- WRIST-LOCK FALLBACK: descend as joint-space movJ  '
                    f'(reason: {chk["reason"]})')
        # Rule 2c adaptation: descent split. When the analyzer flagged
        # this contact for splitting, insert an intermediate movL to
        # `split_z` above the taught contact (via seeded IK from the
        # taught joints, holding the wrist EXACTLY — same shape as
        # FIX C) BEFORE the taught-contact emission, and bracket the
        # final descent with gentle setAccL. Wrist-lock guard on the
        # final descent still applies against the intermediate move's
        # joints (they share J4/J5/J6 with the contact, so the check
        # will always pass).
        _adapt_split = (_adapt_map.get(_step_idx) or {}).get('descent_split')
        _did_split = False
        if _adapt_split and emit_verb == 'movL':
            split_z = float(_adapt_split.get('fast_stop_z_above_contact_mm', 50.0))
            gentle_accL = float(_adapt_split.get('gentle_accL_mm_per_s2',
                                                 mc['gentle_descent_accL_mm_per_s2']))
            ik = seeded_ik_z_lift([float(v) for v in taught], split_z)
            if ik is not None:
                inter_joints, achieved = ik
                # Fresh varspoint entry for the intermediate pose.
                fallback_idx += 1
                inter_name = f'{point_prefix}{fallback_idx}'
                while inter_name in program_points or inter_name in used_named:
                    fallback_idx += 1
                    inter_name = f'{point_prefix}{fallback_idx}'
                varspoint[inter_name] = _make_jp_point(inter_joints, inter_name)
                used_named.add(inter_name)
                inter_joints_s = ', '.join(f'{v:+.3f}' for v in inter_joints)
                exec_lines.append(
                    f'-- motion_check RULE 2c DESCENT SPLIT: intermediate '
                    f'stop at {split_z:g}mm above taught contact')
                _emit_motion_prelude(_step_idx, 'movL', step)
                exec_lines.append(
                    f'movL({inter_name})  -- step {action} (RULE 2c intermediate '
                    f'movL Δz={achieved:+.2f}mm above contact)  '
                    f'joints=[{inter_joints_s}]')
                # Emit gentle setAccL for the final descent. Modal —
                # if we're already at the gentle value it's a no-op.
                if _last_accl is None or abs(gentle_accL - _last_accl) > 1e-4:
                    exec_lines.append(
                        f'setAccL({gentle_accL:g})  '
                        f'-- RULE 2c gentle descent final approach')
                    _last_accl = gentle_accL
                last_move_joints = list(inter_joints)
                _did_split = True
            else:
                exec_lines.append(
                    '-- motion_check RULE 2c descent split SKIPPED: seeded IK '
                    'did not converge for the intermediate pose; falling '
                    'through to single-shot descent')
        _emit_motion_prelude(_step_idx, emit_verb, step)
        exec_lines.append(f'{emit_verb}({name})  -- step {action}  '
                          f'{j5_note}  joints=[{joints_s}]{wrist_note}')
        last_move_joints = taught_list
        # After a descent split, restore default setAccL so the
        # retreat (or next segment) doesn't inherit the gentle value.
        if _did_split:
            default_a = float(mc['default_accL_mm_per_s2'])
            if _last_accl is not None and abs(default_a - _last_accl) > 1e-4:
                exec_lines.append(
                    f'setAccL({default_a:g})  '
                    f'-- RULE 2c bracket close (restore default post-descent)')
                _last_accl = default_a

    # Program-end modal cleanup — never leave a modal blender or a
    # lowered setAccL armed for the next program. Only emit closers
    # for modal state we ACTUALLY armed during this program.
    if smooth_active_on_wire and _blender_on is not None:
        exec_lines.append(
            'setNoBlender()  -- program end (never leave modal blender '
            'armed for the next program)')
        _blender_on = None
    if descent_accel_mode == 'gentle' and _last_accl is not None \
            and abs(_last_accl - float(mc['default_accL_mm_per_s2'])) > 1e-4:
        exec_lines.append(
            f'setAccL({float(mc["default_accL_mm_per_s2"]):g})  '
            f'-- program end (restore default; gentle mode leaves nothing armed)')

    # If the program has any `loop` step, prepend a `::_prog_start::`
    # label so the emitted `goto _prog_start` has a target. Label goes
    # BEFORE exec line 1 — the Estun interpreter treats `::label::` as
    # a no-op statement, so `setStartLine 1` still lands on it and
    # falls through to the first movJ without observable delay.
    if needs_start_label:
        exec_lines = ['::_prog_start::  -- loop target'] + exec_lines

    trailer = time.strftime(_LUA_TRAILER_FMT, time.localtime(time.time()))
    # Header AFTER the executable region so `setStartLine 1` lands on
    # the first movJ. The Estun controller doesn't care about position
    # of comments; they're stripped by the interpreter.
    _profile_note = (
        f'profile={program_profile}'
        f' blend_preset={blend_preset!r} radius_mm={program_blend_radius_mm:g}'
        f' descent_accel={descent_accel_mode}'
        f' max_dps={max_dps:g} max_mmps={max_mmps:g}')
    if smooth_requested_but_gated:
        _profile_note += (' | SMOOTH REQUESTED BUT GATED OFF (wire_verified_blender=False; '
                          'demoting to straight — see docs/estun_lua_reference.md '
                          'for setBlender/setNoBlender bench-verification status)')
    footer_lines = [
        '',
        f'-- generated by estun_driver.program_ops from program '
        f'{program.get("id","<unknown>")!r}',
        f'-- taught steps: {len(steps)}, requested speed_pct={requested_pct}, '
        f'operator_cap_pct={operator_speed_limit_pct}, effective_pct={eff_pct}',
        f'-- motion: {_profile_note}',
        f'-- codegen: git={CODEGEN_VERSION["git_sha"]}'
        f'{"-dirty" if CODEGEN_VERSION["git_dirty"] else ""} '
        f'src_sha={CODEGEN_VERSION["src_sha256"][:12]} '
        f'src_mtime={time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(CODEGEN_VERSION["src_mtime"]))} '
        f'boot={time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(CODEGEN_VERSION["import_ts"]))}',]

    # Motion-check findings summary — always emitted (even when
    # adaptations are disabled) so the operator can see what the
    # analyzer thinks in the emitted Lua.  Warning findings live
    # first so they can't be missed; adaptation findings follow.
    if _findings or _adapt_map:
        footer_lines.append(
            f'-- motion_check: {len(_findings)} finding(s), '
            f'{sum(1 for a in _adapt_map.values() if a.get("rules_applied"))} '
            f'adaptation(s) applied '
            f'(adaptations_switch={"on" if adaptations_enabled else "off"})')
        _warn_findings = [f for f in _findings if f.get('severity') == 'warn']
        _info_findings = [f for f in _findings if f.get('severity') == 'info']
        _adap_findings = [f for f in _findings if f.get('severity') == 'adapted']
        for tag, group in (('WARN', _warn_findings),
                           ('INFO', _info_findings),
                           ('ADAPTED', _adap_findings)):
            for f in group:
                footer_lines.append(
                    f'--   [{tag}] step {f["step_idx"]} '
                    f'({f.get("step_label") or f.get("step_action") or "?"}): '
                    f'[{f["rule"]}] {f["message"]}')
    # Payload annotation (INFO ONLY). The captured luaenginelib.json has
    # NO callable setPayload signature — `setPayload` appears only as a
    # reserved word in the Estun-Lua dialect's syntax-highlighter
    # keyword list, and the i18n bundle labels it "Set the default
    # load" (a factory-UI menu string, not a callable). The controller
    # itself selects payload by PayloadId preset (visible in
    # publish/RobotStatus). We therefore write the operator-authored
    # payload_kg into the header as informational metadata but do NOT
    # emit any wire-invented verb — see the run-confirm modal's
    # PAYLOAD_INFO_ONLY line for where the operator sets the matching
    # preset on the controller.
    payload_kg = cfg.get('payload_kg')
    try:
        pkg = float(payload_kg) if payload_kg not in (None, '') else None
    except (TypeError, ValueError):
        pkg = None
    if pkg is not None and pkg > 0:
        tool_name = str(cfg.get('tool_name') or '').strip()
        note = f'-- payload: {pkg:g} kg'
        if tool_name:
            note += f' ({tool_name})'
        note += ' — info only; select the matching PayloadId preset on the controller'
        footer_lines.append(note)
        cog = cfg.get('payload_cog_mm') or {}
        if isinstance(cog, dict) and any(k in cog for k in ('x','y','z')):
            x = cog.get('x'); y = cog.get('y'); z = cog.get('z')
            footer_lines.append(
                f'-- payload CoG (mm from flange): '
                f'x={x if x is not None else "?"} '
                f'y={y if y is not None else "?"} '
                f'z={z if z is not None else "?"}')
    else:
        footer_lines.append(
            '-- payload: UNSET — collision-detection accuracy on this '
            'program is reduced until an operator sets the tool mass '
            'in the program editor')
    if home_drift_notes:
        footer_lines.append('-- FIX C: move_home drift normalized —')
        for note in home_drift_notes:
            footer_lines.append(f'--   {note}')
    # Lint stamp — 2026-07-30 §2 addition. Every codegen output is
    # linted against luaenginelib.json BEFORE being returned so the
    # header note shows the operator that lint passed. The push
    # endpoint calls lint_lua_source() again on the returned source
    # and refuses to publish on any finding; this footer stamp is
    # informational (a mismatch between the stamp and a fresh lint
    # would flag disk/memory corruption).
    _lint_source_before_footer = '\r\n'.join(exec_lines) + '\r\n'
    try:
        _lint_findings = lint_lua_source(_lint_source_before_footer)
    except Exception as _le:
        _lint_findings = None
        footer_lines.append(f'-- lint: SKIPPED — {type(_le).__name__}: {_le}')
    if _lint_findings is not None:
        if not _lint_findings:
            footer_lines.append(
                '-- lint: OK (0 findings against luaenginelib.json, '
                f'{len(_load_luaenginelib())} verbs)')
        else:
            footer_lines.append(
                f'-- lint: {len(_lint_findings)} FINDING(S) — push will be '
                'refused by /api/estun/program/run:')
            for f in _lint_findings:
                footer_lines.append(
                    f'--   [line {f.get("line","?")}] '
                    f'{f.get("verb","?")}({f.get("args","?")} arg(s)): '
                    f'{f.get("reason","?")}')
    footer_lines += [
        trailer,
    ]
    # CRLF line endings match the controller's own-emitted files (see
    # projectlua_projectluademo/lua/taskluademo.lua as ground truth).
    source = '\r\n'.join(exec_lines + footer_lines) + '\r\n'
    return source, varspoint, eff_pct


# ────────────────────────────────────────────────────────────────
# HTTP save — controller endpoints
# ────────────────────────────────────────────────────────────────
#
# Endpoints discovered in the factory UI bundle's `useProjectSave`:
#
#   POST /api/robotcode/project<lang>_<prid>_<lang>/update/<tkid>/
#       body: raw Lua source text
#
#   POST /api/robotjson/project<lang>_<prid>/update/varspoint/
#       body: JSON dict {name → {joint:[...] | end:{...}}}
#
#   POST /api/robotjson/project<lang>_<prid>/update/project/
#       body: JSON dict {<tkid>: {nm, tk}, ...}   (task registry)
#
#   POST /api/robotjson/project<lang>/update/projectlist/
#       body: JSON dict {<prid>: {nm, posid, varid}, ...}   (project registry)
#
# The demo project's shapes (probed against 192.168.2.136:9198):
#
#   projectlist.json = {"projectluademo":{"nm":"lua-demo","posid":0,"varid":0}}
#   projectluademo/project.json = {"taskluademo":{"nm":"lua-main","tk":1}}
#   projectluademo/varspoint.json = {}        ← empty; this is why the
#                                                demo's movJ(p1) errored
#                                                with "invalid target point"
#   projectluademo/lua/taskluademo.lua       ← the Lua source
#
# `<lang>` = "lua" for B1. select-side is /api/.../select/... which we
# also use to read back the projectlist before rewriting it (so we
# don't clobber other projects registered on the controller).
#
# Response shape (from a live GET probe):
#   {"code": 909, "data": [{"name": "<path>", "content": "<string>"}]}
# We treat code == 909 as OK. Anything else is surfaced verbatim.

def _origin(robot_ip: str, port: int) -> str:
    return f'http://{robot_ip}:{port}'


def _http_request(method: str, url: str, body: bytes | None,
                  content_type: str, timeout_s: float
                  ) -> tuple[int, dict, bytes]:
    """Bare urllib POST/GET so the driver picks up no new pip deps.
    Returns (http_status, response_json_or_empty, raw_body).
    """
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header('Content-Type', content_type)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read()
            try:
                parsed = json.loads(raw.decode('utf-8'))
            except Exception:
                parsed = {}
            return resp.status, parsed, raw
    except urllib.error.HTTPError as e:
        raw = e.read() if hasattr(e, 'read') else b''
        try:
            parsed = json.loads(raw.decode('utf-8'))
        except Exception:
            parsed = {}
        return e.code, parsed, raw


def http_get_projectlist(robot_ip: str, port: int, lang: str = 'lua',
                         timeout_s: float = 3.0) -> dict:
    """Fetch the current projectlist so we can merge our entry into it."""
    url = f'{_origin(robot_ip, port)}/api/robotjson/project{lang}/select/projectlist/'
    status, parsed, _ = _http_request('GET', url, None, '', timeout_s)
    if status != 200:
        raise RuntimeError(f'projectlist GET returned HTTP {status}')
    if parsed.get('code') != 909:
        raise RuntimeError(f'projectlist GET code={parsed.get("code")}')
    data = parsed.get('data') or []
    if not data:
        return {}
    content = data[0].get('content')
    if isinstance(content, str):
        try:
            return json.loads(content)
        except Exception:
            return {}
    return content or {}


def http_get_lua(robot_ip: str, port: int, *, project_id: str, task_id: str,
                 lang: str = 'lua', timeout_s: float = 3.0) -> str:
    """Fetch the currently-stored Lua source for a project/task back
    from the controller. Used by the run path's post-save byte-verify
    (Part G) and by anyone wanting to prove what the controller
    ACTUALLY holds vs. what codegen produced.

    Returns the Lua text (never the JSON envelope). Raises RuntimeError
    on any non-909 response — the caller decides whether that's fatal.
    """
    url = (f'{_origin(robot_ip, port)}/api/robotcode/'
           f'project{lang}_{project_id}_{lang}/select/{task_id}/')
    status, parsed, _ = _http_request('GET', url, None, '', timeout_s)
    if status != 200 or (isinstance(parsed, dict) and parsed.get('code') != 909):
        raise RuntimeError(f'lua GET status={status} '
                           f'code={parsed.get("code") if isinstance(parsed, dict) else "?"}')
    data = parsed.get('data') or []
    if not data:
        return ''
    content = data[0].get('content')
    return content if isinstance(content, str) else ''


def http_post_json(robot_ip: str, port: int, path: str, obj: Any,
                   timeout_s: float = 3.0) -> tuple[int, dict, bytes]:
    """POST a JSON body to /api/robotjson/... — used for varspoint,
    project (task registry), projectlist, varsproject."""
    url = f'{_origin(robot_ip, port)}{path}'
    body = json.dumps(obj, separators=(',', ':')).encode('utf-8')
    return _http_request('POST', url, body, 'application/json', timeout_s)


def http_post_text(robot_ip: str, port: int, path: str, text: str,
                   timeout_s: float = 3.0) -> tuple[int, dict, bytes]:
    """POST a Lua source body to /api/robotcode/... — the demo file
    uses text/plain; the controller doesn't seem to care about the
    charset param but text/plain is what apiPost uses in the bundle."""
    url = f'{_origin(robot_ip, port)}{path}'
    body = text.encode('utf-8')
    return _http_request('POST', url, body, 'text/plain; charset=utf-8', timeout_s)


def save_project(robot_ip: str, port: int, *,
                 project_id: str, task_id: str,
                 project_display: str, task_display: str,
                 lua_source: str,
                 varspoint: dict,
                 lang: str = 'lua',
                 timeout_s: float = 3.0) -> list[dict]:
    """Full save sequence.

    Order matters: source → varspoint → project.json → projectlist.
    The controller does not appear to depend on the order but running
    the point registration BEFORE registering the project keeps the
    controller from briefly seeing a project with no points.

    Returns a list of {step, path, http_status, code, body_head} dicts
    so a caller (the driver's /estun/program_status publisher or an
    ad-hoc test script) can log exactly what happened.
    """
    origin_ip = f'{_origin(robot_ip, port)}'  # for reporting
    steps: list[dict] = []

    def record(step, path, method, http_status, parsed, raw):
        body_head = raw[:180].decode('utf-8', 'replace') if raw else ''
        code = parsed.get('code') if isinstance(parsed, dict) else None
        steps.append({
            'step': step, 'path': path, 'method': method,
            'http_status': http_status, 'code': code,
            'body_head': body_head,
        })

    # 1) Lua source under /api/robotcode/
    p = f'/api/robotcode/project{lang}_{project_id}_{lang}/update/{task_id}/'
    st, parsed, raw = http_post_text(robot_ip, port, p, lua_source, timeout_s)
    record('source', p, 'POST', st, parsed, raw)

    # 2) varspoint dict under /api/robotjson/
    p = f'/api/robotjson/project{lang}_{project_id}/update/varspoint/'
    st, parsed, raw = http_post_json(robot_ip, port, p, varspoint, timeout_s)
    record('varspoint', p, 'POST', st, parsed, raw)

    # 3) project.json (task registry — one task in B1)
    project_json = {task_id: {'nm': task_display, 'tk': 1}}
    p = f'/api/robotjson/project{lang}_{project_id}/update/project/'
    st, parsed, raw = http_post_json(robot_ip, port, p, project_json, timeout_s)
    record('project', p, 'POST', st, parsed, raw)

    # 4) projectlist.json — MERGE our entry into whatever exists so
    #    other projects on the controller don't get clobbered. If the
    #    controller's projectlist is unreadable (rare), fall back to a
    #    single-entry rewrite; better to fail visibly if that too fails.
    try:
        current = http_get_projectlist(robot_ip, port, lang, timeout_s)
    except Exception as e:
        current = {}
        record('projectlist_get_warn', '', 'GET', 0, {}, str(e).encode())
    current[project_id] = {'nm': project_display, 'posid': 0, 'varid': 0}
    p = f'/api/robotjson/project{lang}/update/projectlist/'
    st, parsed, raw = http_post_json(robot_ip, port, p, current, timeout_s)
    record('projectlist', p, 'POST', st, parsed, raw)

    return steps


# ────────────────────────────────────────────────────────────────
# publish/ProjectState + publish/Error parsing
# ────────────────────────────────────────────────────────────────
#
# publish/ProjectState frames observed in the HAR (10 frames across
# three run cycles). Two distinct shapes for state==2:
#
#   {"id":"projectluademo","type":0,"state":2,"isStep":false}
#     ← first frame after project/run, carries the project id.
#
#   {"id":"","type":0,"state":2,"isStep":false,"scripts":{"taskA":{"line":N}}}
#     ← current-line frame; id blanks out, scripts.{task}.line is the
#       live program counter.
#
# The state==0 frame carries only {"id":"","type":0,"state":0,"isStep":false}
# — no scripts, no id. We keep our own last-known project id across
# the state=2→0 transition.
#
# publish/Error is a 3 Hz reflood (median 0.333 s inter-arrival in the
# HAR). Empty db (`[]`) is the "no active error" heartbeat. A non-empty
# entry is `[level, code, unix_ts, msg]` and the unix_ts stays CONSTANT
# across the entire reflood window for the same fault — that's what
# lets us dedup by (code, unix_ts).

def parse_project_state(db: Any, prev_id: str | None
                        ) -> tuple[dict, str | None]:
    """Return (status_dict, updated_prev_id). Caller keeps the id
    around and passes it in on the next frame."""
    if not isinstance(db, dict):
        return {}, prev_id
    state = int(db.get('state', 0))
    is_step = bool(db.get('isStep', False))
    scripts = db.get('scripts') or {}
    # Extract the (task, line) if present; there's normally exactly one
    # task in the scripts dict.
    task, line = None, None
    if isinstance(scripts, dict):
        for k, v in scripts.items():
            if not k or not isinstance(v, dict):
                continue
            task, line = k, int(v.get('line', 0))
            break
    project_id = db.get('id') or ''
    # Persist project id across the state=2 sequence — first frame
    # has it, subsequent frames blank it out.
    if project_id:
        new_prev = project_id
    else:
        new_prev = prev_id if state == 2 else None
    return {
        'state': state,
        'is_step': is_step,
        'task': task,
        'line': line,
        'project_id': new_prev,
    }, new_prev


class ErrorDedup:
    """Suppress the ~3 Hz publish/Error reflood.

    Dedup key: (code, unix_ts). unix_ts is the fault-time timestamp
    from the wire (element [2] of the entry), NOT the frame time — it
    stays constant across the reflood so identical faults collapse to
    one event. An empty db list is treated as a clear.

    Part I stale-error fix (2026-07-22): a bare `_active_key = None`
    on clear meant a straggler reflood of the SAME (code, unix_ts)
    after the clear would re-fire as `new` — the dashboard would
    then re-show an alarm the operator had just acknowledged. Now
    the class remembers the last N cleared keys in an LRU-ish set
    (`_cleared_keys`) and treats a reflood of any cleared key as
    `stale` (same handling as `same`: changed=False, no re-fire).
    """

    # How many cleared keys to remember. In practice a run has < ~20
    # distinct alarms in its lifetime; 64 gives comfortable headroom
    # without unbounded growth on a very long-running session.
    _CLEARED_HISTORY = 64

    def __init__(self):
        self._active_key: tuple[int, float] | None = None
        self._active_entry: list | None = None
        # Insertion-ordered (Py 3.7+) — trimmed from the front when
        # length exceeds _CLEARED_HISTORY. dict-as-ordered-set.
        self._cleared_keys: dict[tuple[int, float], None] = {}

    def _remember_cleared(self, key):
        # Drop-oldest if we exceed cap; dict maintains insertion order.
        self._cleared_keys.pop(key, None)   # move to end if already present
        self._cleared_keys[key] = None
        if len(self._cleared_keys) > self._CLEARED_HISTORY:
            # Evict oldest — first inserted.
            oldest = next(iter(self._cleared_keys))
            del self._cleared_keys[oldest]

    def observe(self, db: Any) -> dict:
        """Return {kind, entry, key, changed}. kind ∈ {"clear", "new",
        "same", "stale", "noise"}. `stale` is a reflood of a cleared
        error — treated like `same` (never re-fires an event)."""
        if not isinstance(db, list) or len(db) == 0:
            changed = self._active_key is not None
            if self._active_key is not None:
                self._remember_cleared(self._active_key)
            self._active_key = None
            self._active_entry = None
            return {'kind': 'clear', 'entry': None,
                    'key': None, 'changed': changed}
        entry = db[0]
        if not (isinstance(entry, list) and len(entry) >= 4):
            return {'kind': 'noise', 'entry': entry, 'key': None,
                    'changed': False}
        code = int(entry[1]) if isinstance(entry[1], (int, float)) else -1
        ts = float(entry[2]) if isinstance(entry[2], (int, float)) else 0.0
        key = (code, ts)
        if self._active_key == key:
            return {'kind': 'same', 'entry': entry, 'key': key,
                    'changed': False}
        # Reflood of a cleared error — do NOT re-surface it.
        if key in self._cleared_keys:
            return {'kind': 'stale', 'entry': entry, 'key': key,
                    'changed': False}
        self._active_key = key
        self._active_entry = entry
        return {'kind': 'new', 'entry': entry, 'key': key,
                'changed': True}
