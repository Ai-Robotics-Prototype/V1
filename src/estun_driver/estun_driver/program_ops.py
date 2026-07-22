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

import json
import re as _re
import time
import urllib.error
import urllib.request
from typing import Any, Iterable


# ────────────────────────────────────────────────────────────────
# Lua codegen
# ────────────────────────────────────────────────────────────────

# The controller writes its own Lua files with a "--Lua version 5.3
# time:YYYY-MM-DD HH:MM:SS" trailer (seen on the demo project). We
# emit the same trailer so a round-trip select/update looks
# byte-similar and the operator can eyeball diffs.
_LUA_TRAILER_FMT = '--Lua version 5.3 time:%Y-%m-%d %H:%M:%S'


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
    position_role AND real taught data. Later derived children look
    themselves up here by their `derived_from` string."""
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
            # Last writer wins if the same role is taught twice —
            # matches the executor's "walk backward, take first
            # match" semantics for the LATEST step at codegen time
            # (there's no runtime step-index here to bound the walk).
            out[role] = entry
    return out


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


def codegen_lua_from_program(
    program: dict,
    *,
    operator_speed_limit_pct: int,
    point_prefix: str = 'p',
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

    Point entries follow the shape mined from the factory UI bundle
    (see _make_jp_point) — {postype:"jp", nm, val:<JSON string>}.
    """
    cfg = program.get('config') or {}
    requested_pct = int(
        cfg.get('speed_pct')
        or program.get('speed_pct')
        or 10  # conservative default
    )
    eff_pct = max(1, min(int(operator_speed_limit_pct), requested_pct))

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
    # Points saved by role for reuse — a derived step with offset_z_mm=0
    # points at the anchor's already-registered varspoint entry rather
    # than duplicating the joints under a fresh name.
    role_point_name: dict[str, str] = {}
    # Loop step (goto=<line>, count=<n>) → emit `goto ::_prog_start::`.
    # Prepend the label at file line 1 so `setStartLine 1` still lands
    # on real executable code. Track whether the label is needed so
    # non-looping programs stay label-free.
    needs_start_label = any(str(s.get('action') or '').lower() == 'loop'
                            for s in steps)
    for step in steps:
        action = step.get('action', '?')

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

        # ---- Wait / delay — wire-verified `wait(<seconds>)` -----------
        # The Control category in the editor generates a bare
        # `wait(<duration>)` node (verified live: a Control→wait step
        # in the "roboaitest" editor project produced `wait(0)` in the
        # exported Lua). Argument is seconds — matches the wizard's
        # `duration_s` field on the step. `wait` is not enumerated in
        # luaenginelib.json (which only covers the Motion / IO / Logic
        # categories) but is a valid Control primitive on the
        # controller. `waitCondition` stays reserved for future
        # sensor-conditioned dwell steps.
        if action == 'wait':
            try:
                dur = float(step.get('duration_s') or 0)
            except (TypeError, ValueError):
                dur = 0.0
            # Format short so 0.5 → "0.5" not "0.500000".
            dur_s = f'{dur:g}'
            exec_lines.append(f'wait({dur_s})  -- step {action}  '
                              f'duration_s={dur_s}')
            continue

        # ---- Loop — goto label at file line 1 -------------------------
        # `goto` and `::label::` are wire-verified verbs in
        # luaenginelib.json. `count == 0` (== continuous) emits a bare
        # `goto ::_prog_start::`. A finite count would need a counter
        # var + `if _iter < N then goto ... end`; not exercised by the
        # test wizard so kept minimal here — extend when a program with
        # count>0 lands.
        if action == 'loop':
            count = int(step.get('count') or 0)
            if count == 0:
                exec_lines.append(f'goto _prog_start  -- step {action}  '
                                  f'continuous (count=0)')
            else:
                # Finite loops need a counter; not covered by current
                # wire captures. Emit a bare goto with a marker so it
                # still runs (turns into an infinite loop, but never
                # stops the operator from spotting the TODO).
                exec_lines.append(f'goto _prog_start  -- step {action}  '
                                  f'count={count} (finite counter not '
                                  f'yet implemented; running as '
                                  f'continuous)')
            continue

        # ---- Wait input — emit a getDI read -------------------------
        # `getDI(port)` is wire-verified from luaenginelib.json:
        #   {"lua": "$2 = getDI($1)", "vars": ["port", "var"]}
        # Semantics of the emitted step: sample the DI channel and
        # bind the value into a local. This is the read the user's
        # brief mapped `wait_input` to. A blocking-wait pattern
        # (waitCondition(getDI(port)==value, timeout)) would also
        # need a wire-verified timeout unit, which is not documented
        # — so it stays out of scope until captured.
        if action == 'wait_input':
            io_id = str(step.get('io_id') or '').strip()
            m = _re.match(r'^DI(\d+)$', io_id, _re.IGNORECASE)
            if not m:
                exec_lines.append(f'-- skipped {action!r}: '
                                  f'io_id {io_id!r} is not a DI port '
                                  f'(getDI reads DI channels only)')
                continue
            port = int(m.group(1))
            # Local variable name — one per wait_input step. `_diN`
            # collides with no Lua keyword; downstream logic can wire
            # it into a subsequent condition step.
            di_read_idx += 1
            local_name = f'_di{di_read_idx}'
            exec_lines.append(f'{local_name} = getDI({port})  '
                              f'-- step wait_input {io_id} '
                              f'(read; blocking-wait pattern needs '
                              f'waitCondition + unverified timeout unit)')
            continue

        # Verb selection: move_linear → movL, everything else that
        # reaches here (move_home / move_joint / approach / etc.) →
        # movJ. Matches program_executor_node.tick semantics.
        verb = 'movL' if str(action).lower() == 'move_linear' else 'movJ'

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
        # FIX B — |offset_z_mm| ≥ 1 mm: no in-process IK library is
        #   available at codegen time (no ikpy / no MoveIt bridge from
        #   this module), so we fall back to `movL({cp={...}}, {coor=0,
        #   tool=0})` with the anchor's rx/ry/rz preserved and the
        #   frame/tool pinned. Pinning coor and tool reduces the IK's
        #   solution-branch ambiguity (unpinned, Estun searches across
        #   frames), which curbs — but does not eliminate — the wrist-
        #   flip hazard. The step is flagged in the emitted comment so
        #   the operator watches these steps live. Preferred long-term
        #   fix: ship a seeded-IK helper (URDF at /opt/cobot/models/
        #   estun_s10-140.urdf + ikpy) and swap this branch for a
        #   movJ with the seeded-IK joints.
        if step.get('derived_from') and not (
                isinstance(step.get('taught_joints'), list)
                and len(step.get('taught_joints')) == 6):
            role = step.get('derived_from')
            ofs_mm = float(step.get('offset_z_mm') or 0)
            # FIX A: offset ≈ 0 collapses to a movJ back to the anchor.
            # Prefer this branch whenever the anchor was already saved
            # as a jp point AND the offset is under 1 mm — the anchor's
            # taught_joints are authoritative, no IK involved.
            if abs(ofs_mm) < 1.0 and role in role_point_name:
                ref = role_point_name[role]
                anchor = role_map.get(role, {})
                tj = anchor.get('taught_joints') or []
                joints_s = ', '.join(f'{float(v):+.3f}' for v in tj) if tj else ''
                exec_lines.append(
                    f'movJ({ref})  -- step {action}  '
                    f'derived_from={role!r} offset_z_mm={ofs_mm:g}  '
                    f'(FIX A: identity offset → reuse anchor jp; no IK)'
                    + (f'  joints=[{joints_s}]' if joints_s else ''))
                continue
            # FIX B: non-trivial offset. Resolve to cp, emit movL with
            # coor=0, tool=0 pinned, and flag the step.
            resolved = _resolve_derived(step, role_map)
            if resolved is not None:
                kind, vals = resolved
                if kind == 'cp':
                    cp_s = ', '.join(f'{v:g}' for v in vals)
                    exec_lines.append(
                        f'movL({{cp={{{cp_s}}}}},{{coor=0,tool=0}})  '
                        f'-- step {action}  derived_from={role!r} '
                        f'offset_z_mm={ofs_mm:g}  '
                        f'(FIX B: offset>1mm; no seeded IK available — '
                        f'movL with anchor rx/ry/rz + pinned coor/tool. '
                        f'WATCH LIVE: wrist could still re-solve.)')
                else:  # jp fallback (anchor had no tcp AND offset≈0)
                    jp_s = ', '.join(f'{v:g}' for v in vals)
                    exec_lines.append(
                        f'movJ({{jp={{{jp_s}}}}})  -- step {action}  '
                        f'derived_from={role!r} offset_z_mm={ofs_mm:g}  '
                        f'(anchor jp fallback)')
                continue
            # Anchor unresolved — fall through so the point_name /
            # taught_joints paths still get a chance.

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
            if pn not in used_named:
                varspoint[pn] = _make_jp_point(j, pn)
                used_named.add(pn)
            role = step.get('position_role')
            if role and role not in role_point_name:
                role_point_name[role] = pn
            joints_s = ', '.join(f'{float(v):+.3f}' for v in j)
            exec_lines.append(f'{verb}({pn})  -- step {action}  point={pn}  '
                              f'joints=[{joints_s}]')
            continue
        taught = step.get('taught_joints')
        if not (isinstance(taught, list) and len(taught) == 6
                and all(isinstance(v, (int, float)) for v in taught)):
            exec_lines.append(f'-- skipped {action!r}: '
                              f'no point_name/points ref, no 6-el taught_joints '
                              f'(got {type(taught).__name__})')
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
        joints_s = ', '.join(f'{float(v):+.3f}' for v in taught)
        exec_lines.append(f'{verb}({name})  -- step {action}  '
                          f'joints=[{joints_s}]')

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
    footer_lines = [
        '',
        f'-- generated by estun_driver.program_ops from program '
        f'{program.get("id","<unknown>")!r}',
        f'-- taught steps: {len(steps)}, requested speed_pct={requested_pct}, '
        f'operator_cap_pct={operator_speed_limit_pct}, effective_pct={eff_pct}',]
    if home_drift_notes:
        footer_lines.append('-- FIX C: move_home drift normalized —')
        for note in home_drift_notes:
            footer_lines.append(f'--   {note}')
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
    """
    def __init__(self):
        self._active_key: tuple[int, float] | None = None
        self._active_entry: list | None = None

    def observe(self, db: Any) -> dict:
        """Return {kind, entry, key, changed}. kind ∈ {"clear", "new",
        "same"}."""
        if not isinstance(db, list) or len(db) == 0:
            changed = self._active_key is not None
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
        self._active_key = key
        self._active_entry = entry
        return {'kind': 'new', 'entry': entry, 'key': key,
                'changed': True}
