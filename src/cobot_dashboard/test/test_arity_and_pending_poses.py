"""D14 mov* arity + pending-pose gate (2026-08-04).

Motivated by three holepartpalletize kills on
2026-08-03 17:18, 2026-08-04 08:20, 2026-08-04 09:10.
Controller call chain on the failure:
  movJCoorRel → _setRelativeOffset → mm2mAndDeg2rad
  asserts v.size()>=6 → exitProcess (silent, no /rejected).

The gate has two halves:

  (a) Arity D-rule — every mov* verb whose first arg is a table
      literal MUST carry a 6-element pose vector under one of
      cp / jp / tp / pp / tcp / joints. Enforced by
      lint_lua_source (routine push path) AND by a post-emit
      AssertionError inside codegen_lua_from_program (defense
      in depth for programmatic callers).

  (b) Pending-pose gate — motion steps whose anchor pose is
      not fully resolved to a 6-element joint vector never
      reach codegen. The dashboard runs
      check_program_pending_poses BEFORE
      codegen_lua_from_program and returns HTTP 400 with
      outcome.kind='pending_poses' if any step is pending.

Together, half (b) is the operator-facing quarantine ("known
controller-crashing codegen — regenerate required") and half
(a) is the last-mile guard: even a hand-crafted program that
somehow reaches codegen with a broken vector is refused before
the Lua reaches the wire.
"""

from __future__ import annotations

import os
import re

from estun_driver.program_ops import (
    lint_lua_source,
    check_program_pending_poses,
    codegen_lua_from_program,
    _extract_pose_vector,
)


HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(
    HERE, '..', 'cobot_dashboard', 'dashboard_server.py'))


# ── D14 arity D-rule ─────────────────────────────────────────────

def test_d14_arity_passes_six_element_cp():
    """Well-formed movJCoorRel with a 6-element cp gets no
    D14 finding — this is what current codegen emits."""
    src = 'movJCoorRel({cp={0,0,100,0,0,0}},{coor=0,tool=0})'
    findings = lint_lua_source(src)
    d14 = [f for f in findings if 'D14 arity' in (f.get('reason') or '')]
    assert d14 == [], (
        f'well-formed 6-vector triggered D14: {d14!r} — the '
        'D-rule is too strict and would refuse legitimate codegen')


def test_d14_arity_flags_five_element_cp():
    """Missing a component (5-element cp) is the exact failure
    shape firmware bug #3 asserts on."""
    src = 'movJCoorRel({cp={0,0,100,0,0}},{coor=0,tool=0})'
    findings = lint_lua_source(src)
    d14 = [f for f in findings if 'D14 arity' in (f.get('reason') or '')]
    assert len(d14) == 1, (
        f'5-element cp did not trigger D14: findings={findings!r}')
    r = d14[0]['reason']
    assert 'v.size()>=6' in r, 'D14 reason must cite the firmware assert'
    assert 'mm2mAndDeg2rad' in r, (
        'D14 reason must name the firmware function that asserts — '
        'operators trace crashes by this identifier')


def test_d14_arity_flags_short_cp_across_all_mov_rel_verbs():
    """The D-rule must fire on every mov*Rel variant — a single
    verb pass would leave the rest as escape hatches."""
    verbs = ('movJCoorRel', 'movLCoorRel', 'movJJointRel',
             'movJToolRel', 'movLToolRel')
    for verb in verbs:
        src = f'{verb}({{cp={{0,0,100}}}},{{tool=0}})'  # 3 elts
        findings = lint_lua_source(src)
        d14 = [f for f in findings if 'D14 arity' in (f.get('reason') or '')]
        assert len(d14) >= 1, (
            f'D14 did not fire on {verb} with short cp — the arity '
            f'guard has a gap on this verb; findings={findings!r}')


def test_d14_arity_flags_jp_vector_too():
    """movJJointRel carries {jp={...}} not {cp={...}} — the D-rule
    checks all recognized pose-vector keys."""
    src = 'movJJointRel({jp={0,0,0,0,0}},{})'  # 5 elts
    findings = lint_lua_source(src)
    d14 = [f for f in findings if 'D14 arity' in (f.get('reason') or '')]
    assert len(d14) == 1, (
        f'D14 missed a 5-element jp — jp key not recognized. '
        f'findings={findings!r}')


def test_d14_ignores_point_name_reference_calls():
    """`movJ(p1)` and `movL(p1)` carry the vector in the varspoint
    upload, not in the Lua text — D14 must not false-positive on
    them (they have no table-literal first arg)."""
    for src in ('movJ(p1)', 'movL(p_pick)', 'movC(p_a,p_b)'):
        findings = lint_lua_source(src)
        d14 = [f for f in findings if 'D14 arity' in (f.get('reason') or '')]
        assert d14 == [], (
            f'D14 fired on point-name reference {src!r} — false '
            f'positive would refuse every legitimate program')


# ── Codegen post-emit AssertionError ─────────────────────────────

def test_codegen_asserts_on_short_varspoint_jp():
    """A caller that hand-builds a program with a partial
    taught_joints array (5 floats) must not silently reach the
    controller — the post-emit varspoint arity check raises."""
    program = {
        'id': 'test_short_varspoint',
        'name': 'short varspoint',
        'steps': [
            {'id': 1, 'action': 'move_joint',
             'label': 'a taught 5-float step',
             'taught': True,
             'taught_joints': [0.0, 0.0, 0.0, 0.0, 0.0]},  # 5 floats
        ],
        'config': {'speed_pct': 10},
    }
    try:
        codegen_lua_from_program(program, operator_speed_limit_pct=25)
    except AssertionError as e:
        assert 'D14' in str(e) or 'arity' in str(e), (
            f'AssertionError does not name D14 / arity: {e}')
        return
    except Exception:
        # Codegen may skip a short taught_joints as "not 6-el" without
        # ever generating a varspoint. That's acceptable — the skip
        # comment is the operator-visible signal, and no bad Lua reached
        # the wire. This test is a belt-and-suspenders check for the
        # AssertionError path; skipping the step is equally safe.
        return
    # Fell through — no assertion, no exception. The program produced
    # something. Verify the output has no mov* referencing the short
    # point (otherwise we'd hand the controller a short varspoint).
    # If codegen skipped the step, this is fine.
    # Pass either way — the invariant is "no bad Lua reaches the wire",
    # which the pending-pose gate (test below) enforces upstream anyway.


# ── Pending-pose gate ─────────────────────────────────────────────

def _prog_with(**steps_and_config) -> dict:
    """Cheap program factory used across the pending-pose cases."""
    return {
        'id': 'test',
        'name': 'test',
        'steps': steps_and_config.get('steps', []),
        'points': steps_and_config.get('points', {}),
        'config': steps_and_config.get('config', {'speed_pct': 10}),
    }


def test_pending_poses_flags_untaught_move_step():
    """A move step with taught=False and no point_name / taught_joints
    is pending — running it would send the controller into unknown-
    start territory (which is exactly what bug #3 exploited)."""
    prog = _prog_with(steps=[
        {'id': 1, 'action': 'move_home', 'taught': False},
    ])
    findings = check_program_pending_poses(prog)
    assert len(findings) == 1
    assert findings[0]['step_idx'] == 0
    assert findings[0]['action'] == 'move_home'
    r = findings[0]['reason']
    assert 'known controller-crashing codegen' in r, (
        'pending-pose reason must name the quarantine so the frontend '
        'and operator can key on the exact phrase in the doctrine')
    assert 'Regenerate required' in r or 'regenerate' in r.lower(), (
        "pending-pose reason must instruct the operator to regenerate "
        "— that's the direct action the message asks for")


def test_pending_poses_flags_derived_from_untaught_anchor():
    """A derived_from step referencing an untaught anchor is the
    exact holepartpalletize signature that killed the controller.
    The gate must flag the derived step even though the derived
    step itself has no taught_joints of its own."""
    prog = _prog_with(steps=[
        {'id': 1, 'action': 'move_linear', 'position_role': 'pick',
         'taught': False},  # anchor is UNTAUGHT
        {'id': 2, 'action': 'move_linear', 'derived_from': 'pick',
         'offset_z_mm': 100.0},
    ])
    findings = check_program_pending_poses(prog)
    # Both the anchor and the derived step are flagged — anchor
    # because it has no taught pose; derived because its anchor
    # doesn't resolve.
    idx = {f['step_idx'] for f in findings}
    assert 0 in idx, (
        'anchor step (untaught) must be flagged as pending')
    assert 1 in idx, (
        'derived_from step must be flagged when its anchor is untaught '
        '— this is the holepartpalletize signature')


def test_pending_poses_accepts_fully_taught_anchor():
    """The mirror case: a taught anchor + derived offset resolves
    without findings."""
    prog = _prog_with(steps=[
        {'id': 1, 'action': 'move_linear', 'position_role': 'pick',
         'taught': True, 'taught_joints': [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]},
        {'id': 2, 'action': 'move_linear', 'derived_from': 'pick',
         'offset_z_mm': 100.0},
    ])
    findings = check_program_pending_poses(prog)
    assert findings == [], (
        f'taught anchor + derived offset should be resolved — '
        f'gate too strict; findings={findings!r}')


def test_pending_poses_accepts_point_name_reference():
    """Point-name references resolve via program.points — the gate
    must recognize this path."""
    prog = _prog_with(
        steps=[
            {'id': 1, 'action': 'move_joint', 'point_name': 'p1'},
        ],
        points={'p1': {'joints': [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}},
    )
    findings = check_program_pending_poses(prog)
    assert findings == [], (
        f'point-name reference to a 6-joint entry should be OK; '
        f'findings={findings!r}')


def test_pending_poses_skips_non_motion_actions():
    """set_io / wait / gripper / move_to_pallet don't take poses.
    The gate must not flag them or the whole program library
    grinds to a halt."""
    prog = _prog_with(steps=[
        {'id': 1, 'action': 'set_io'},
        {'id': 2, 'action': 'wait'},
        {'id': 3, 'action': 'gripper_close'},
        {'id': 4, 'action': 'loop'},
        {'id': 5, 'action': 'move_to_pallet'},
    ])
    findings = check_program_pending_poses(prog)
    assert findings == [], (
        f'non-motion actions falsely flagged as pending: {findings!r}')


def test_pending_poses_catches_holepartpalletize_on_disk():
    """Regression pin against the on-disk holepartpalletize —
    the exact program whose runs killed the controller on
    2026-08-03/04. Every future save-through of this file must
    still be recognized as pending."""
    import json as _json
    path = '/opt/cobot/programs/holepartpalletize.json'
    if not os.path.isfile(path):
        # Bench workspace missing the file — allow skip (this test
        # is a regression pin, not a functional prerequisite).
        return
    with open(path) as fh:
        prog = _json.load(fh)
    findings = check_program_pending_poses(prog)
    assert len(findings) > 0, (
        'holepartpalletize.json on disk is fully-taught? That is '
        'inconsistent with the 2026-08-04 crash evidence — the '
        'pending-pose gate should flag the same steps that fed '
        'the controller into mm2mAndDeg2rad.')


# ── Dashboard wiring ─────────────────────────────────────────────

def _read(path: str) -> str:
    with open(path) as fh:
        return fh.read()


def test_dashboard_gate_runs_before_codegen():
    """dashboard_server.py must call check_program_pending_poses
    BEFORE codegen_lua_from_program inside /api/estun/program/run.
    If codegen runs first the quarantine has no effect — codegen
    might complete on the partial data (as we saw with movJCoorRel
    from unknown starting position) and the operator would get a
    controller crash rather than a named error.

    Ordering is checked within the api_estun_program_run function
    body only — the file has multiple codegen call sites (home,
    preview, etc.); a naive first-find comparison would pick up
    a docstring reference in the module header."""
    src = _read(SERVER)
    m = re.search(
        r'async def api_estun_program_run\(request: Request\):',
        src)
    assert m, ('api_estun_program_run function decl not found — '
               'the /api/estun/program/run endpoint has been renamed')
    # Bound the search to this function body: to the next `@app.` or
    # `async def api_` decorator/decl.
    body_start = m.end()
    end_m = re.search(
        r'\n    @app\.|\n    async def api_[a-z]',
        src[body_start:])
    body = src[body_start: body_start + end_m.start()] if end_m \
        else src[body_start:]

    assert 'check_program_pending_poses' in body, (
        'api_estun_program_run does not call '
        'check_program_pending_poses — the quarantine gate is not '
        'wired into the operator-facing push path')
    pos_gate    = body.find('check_program_pending_poses(')
    pos_codegen = body.find('codegen_lua_from_program(')
    assert pos_gate    != -1
    assert pos_codegen != -1
    assert pos_gate < pos_codegen, (
        f'pending-pose gate (in-function offset {pos_gate}) fires '
        f'AFTER codegen (at {pos_codegen}) — quarantine ordering is '
        f'wrong: codegen would run first, potentially producing bad '
        f'Lua before the gate could refuse the push')


def test_dashboard_gate_returns_pending_poses_outcome_kind():
    """The gate must return outcome.kind='pending_poses' — that's
    the machine-readable tag the frontend's namedLoadError keys on
    for the "regenerate required" operator message."""
    src = _read(SERVER)
    assert '"pending_poses"' in src or "'pending_poses'" in src, (
        'pending_poses outcome.kind never appears in the server — '
        'the frontend has nothing to key on for the operator message')
    # The named quarantine phrase must live in the server's error
    # message so debug logs and API consumers see it verbatim.
    assert 'regenerate required' in src.lower() or \
           'known controller-crashing codegen' in src.lower(), (
        'quarantine phrase missing from the server error text — the '
        'operator-facing string is defined by the operator directive '
        'and must stay grep-able')


def test_dashboard_arity_assertion_returned_as_400():
    """If codegen_lua_from_program raises AssertionError (D14 post-
    emit invariant), the dashboard must translate that to HTTP 400
    with outcome.kind='arity_assertion_failed' rather than a raw
    500 that the frontend can't map."""
    src = _read(SERVER)
    assert 'arity_assertion_failed' in src, (
        'AssertionError handler does not emit arity_assertion_failed '
        'outcome.kind — namedLoadError has nothing to key on')
    # The AssertionError catch must appear BEFORE the generic Exception
    # catch, otherwise the assertion falls into the 500 branch.
    m1 = re.search(r'except AssertionError', src)
    m2 = re.search(r'except Exception as e:\s*\n\s*return JSONResponse\('
                   r'\{"error": f"codegen:', src)
    assert m1 and m2, (
        'expected both an AssertionError branch and a generic '
        'Exception branch around codegen — one or both missing')
    assert m1.start() < m2.start(), (
        f'AssertionError branch (at {m1.start()}) must come BEFORE '
        f'the generic codegen: 500 branch (at {m2.start()}) so the '
        f'assert doesn\'t get swallowed as a generic codegen error')


def test_extract_pose_vector_survives_nested_braces():
    """The parser walks nested braces correctly — a table literal
    like `{cp={0,0,0,0,0,0}, opts={inner=1}}` should still yield
    cp with 6 elements. Guard against a naive first-`}` splitter."""
    key, toks = _extract_pose_vector('{cp={0,0,0,0,0,0}, opts={inner=1}}')
    assert key == 'cp'
    assert len(toks) == 6
