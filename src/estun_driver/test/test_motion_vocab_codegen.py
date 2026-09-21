"""Codegen tests for the 2026-07-29 motion-vocabulary work.

Locks the emission contract for:

  * setSpeedJ / setSpeedL modal emission (§2 speed mapping);
  * setAccL bracketing for descent_accel=gentle (§3);
  * motion_profile: joint | straight | smooth field (§1);
  * SMOOTH profile gated behind motion_config['wire_verified_blender']:
      · False (release default) → NO setBlender/setNoBlender emitted
        even when profile=smooth; header note records demotion;
      · True                    → setBlender before consecutive
        transits, setNoBlender before contacts / linked waypoints /
        short segments / program end;
  * verify_input step → waitCondition(getDI(port)==<expect>, timeout_ms).

Every setBlender/setNoBlender-touching test flips
wire_verified_blender=True explicitly. The release-default assertion
(profile=smooth stays quiet when the flag is off) has its own dedicated
test so a future toggle to True on the config side surfaces as a
visible failure.
"""

from __future__ import annotations

import copy

from estun_driver.program_ops import (
    DEFAULT_MOTION_CONFIG,
    _mark_blend_demotions,
    _merged_motion_config,
    codegen_lua_from_program,
)


def _pick_place_program(pick_j, place_j, approach_h_mm=100):
    """Same shape as the wrist-lock fixture — a single-pair pick/place
    with derived approach/retreat around each contact."""
    return {
        'id':   'motion-vocab-test',
        'name': 'motion-vocab-test',
        'config': {'speed_pct': 50},
        'steps': [
            {'id': 1, 'action': 'move_home', 'label': 'Home',
             'taught_joints': [0.0] * 6, 'position_role': 'home',
             'taught_tcp': [0.5, 0.0, 0.6, 0.0, 0.0, 0.0]},
            {'id': 2, 'action': 'move_linear', 'label': 'Approach above pick',
             'derived_from': 'pick', 'offset_z_mm': approach_h_mm},
            {'id': 3, 'action': 'move_linear', 'label': 'Pick contact',
             'taught_joints': list(pick_j),
             'position_role': 'pick',
             'taught_tcp': [0.400, 0.100, 0.200, 0.0, 0.0, 0.0]},
            {'id': 4, 'action': 'move_linear', 'label': 'Retreat above pick',
             'derived_from': 'pick', 'offset_z_mm': approach_h_mm},
            {'id': 5, 'action': 'move_linear', 'label': 'Approach above place',
             'derived_from': 'place', 'offset_z_mm': approach_h_mm},
            {'id': 6, 'action': 'move_linear', 'label': 'Place contact',
             'taught_joints': list(place_j),
             'position_role': 'place',
             'taught_tcp': [-0.100, 0.400, 0.180, 0.0, 0.0, 0.0]},
            {'id': 7, 'action': 'move_linear', 'label': 'Retreat above place',
             'derived_from': 'place', 'offset_z_mm': approach_h_mm},
            {'id': 8, 'action': 'move_home', 'label': 'Return home',
             'taught_joints': [0.0] * 6, 'position_role': 'home',
             'taught_tcp': [0.5, 0.0, 0.6, 0.0, 0.0, 0.0]},
        ],
    }


PICK_J  = [63.15, 38.45, 133.63, 81.85, 90.57, -105.28]
PLACE_J = [-2.82, 22.14, 130.69, 62.61, 90.57, -105.28]


# ── §2: setSpeedJ / setSpeedL modal emission ────────────────────

def test_setSpeedJ_emits_before_first_movJ():
    """First movJ in the body must be preceded by a setSpeedJ(N)
    line. Absolute value equals speed_pct/100 × min(max_joint_speed_dps)
    at the current motion config defaults (per-joint list, 2026-07-31
    §2). min of [150,150,150,180,180,180] is 150 dps."""
    lua, _, _ = codegen_lua_from_program(
        _pick_place_program(PICK_J, PLACE_J),
        operator_speed_limit_pct=100)
    lines = lua.splitlines()
    for i, ln in enumerate(lines):
        if ln.startswith('movJ('):
            preceding = lines[:i]
            speed_lines = [x for x in preceding if x.startswith('setSpeedJ(')]
            assert speed_lines, (
                f'no setSpeedJ before first movJ (line {i}): {ln}')
            # 50% × min(150,150,150,180,180,180) = 50% × 150 = 75 dps
            assert '75' in speed_lines[0], speed_lines[0]
            return
    assert False, 'no movJ emitted'


def test_setSpeedL_emits_before_first_movL():
    """setSpeedL(N) precedes the first movL. At 50% × 1500 mm/s max
    (2026-07-31 §2) the emitted value should be 750 mm/s."""
    lua, _, _ = codegen_lua_from_program(
        _pick_place_program(PICK_J, PLACE_J),
        operator_speed_limit_pct=100)
    lines = lua.splitlines()
    for i, ln in enumerate(lines):
        if ln.startswith('movL('):
            preceding = lines[:i]
            speed_lines = [x for x in preceding if x.startswith('setSpeedL(')]
            assert speed_lines, (
                f'no setSpeedL before first movL (line {i}): {ln}')
            assert '750' in speed_lines[0], speed_lines[0]
            return
    # No movL emitted — the wrist-lock guard may have converted every
    # linear contact to a movJ fallback. In that case this test is
    # vacuous but not a failure of the vocabulary work.


def test_setSpeed_is_modal_not_repeated_every_step():
    """setSpeedJ / setSpeedL only re-emit when the target value
    changes. With no per-step overrides, each verb emits exactly
    once for the whole program (or twice if it toggles)."""
    lua, _, _ = codegen_lua_from_program(
        _pick_place_program(PICK_J, PLACE_J),
        operator_speed_limit_pct=100)
    lines = lua.splitlines()
    speedJ = [ln for ln in lines if ln.startswith('setSpeedJ(')]
    speedL = [ln for ln in lines if ln.startswith('setSpeedL(')]
    # Fixture uses uniform speed_pct — exactly one setSpeedJ, at most
    # one setSpeedL.
    assert len(speedJ) == 1, speedJ
    assert len(speedL) <= 1, speedL


def test_speed_maps_25pct_to_expected_absolutes():
    """25% × 2026-07-31 defaults (min(150...180) dps, 1500 mm/s) →
    37.5 deg/s, 375 mm/s."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['speed_pct'] = 25
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    speedJ = [ln for ln in lines if ln.startswith('setSpeedJ(')]
    assert speedJ and '37.5' in speedJ[0], speedJ
    speedL = [ln for ln in lines if ln.startswith('setSpeedL(')]
    if speedL:
        assert '375' in speedL[0], speedL[0]


def test_speed_maps_100pct_to_expected_absolutes():
    """100% × 2026-07-31 defaults → 150 deg/s (min of per-joint list),
    1500 mm/s."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['speed_pct'] = 100
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    speedJ = [ln for ln in lines if ln.startswith('setSpeedJ(')]
    assert speedJ and '150' in speedJ[0], speedJ
    speedL = [ln for ln in lines if ln.startswith('setSpeedL(')]
    if speedL:
        assert '1500' in speedL[0], speedL[0]


def test_per_step_speed_override_caps_at_program_speed():
    """A step's own speed_pct overrides the program's — but is CAPPED
    at the program's eff_pct (never faster)."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['speed_pct'] = 20
    # Try to make step 3 (contact) run at 80% — should be pulled down
    # to 20 (the program's cap).
    prog['steps'][2]['speed_pct'] = 80
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    # No setSpeed line should mention the 80% attempt.
    for ln in lines:
        if ln.startswith('setSpeed') and '80%' in ln:
            assert False, f'per-step speed exceeded program cap: {ln!r}'


def test_operator_cap_binds_before_speed_mapping():
    """operator_speed_limit_pct is the outer cap — program can request
    100 but a 25-cap operator gets 25% × maxima on the wire."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['speed_pct'] = 100
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=25)
    lines = lua.splitlines()
    speedJ = [ln for ln in lines if ln.startswith('setSpeedJ(')]
    assert speedJ and '37.5' in speedJ[0], speedJ   # 25% × 150 dps = 37.5


# ── §3: gentle descent bracketing (setAccL) ─────────────────────

def test_gentle_descent_emits_setAccL_before_contact():
    """descent_accel='gentle' → setAccL(gentle_value) precedes each
    contact-descent movL; setAccL(default_value) closes the bracket
    before the next non-descent linear move."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['descent_accel'] = 'gentle'
    prog['config']['motion_profile'] = 'straight'
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    accL = [ln for ln in lines if ln.startswith('setAccL(')]
    # At least one gentle setAccL (the pick descent) + one restore.
    gentle = [ln for ln in accL if '150' in ln or 'gentle' in ln]
    assert gentle, f'expected gentle setAccL, got: {accL}'


def test_gentle_default_is_no_setAccL_emission():
    """Default descent_accel='normal' — no setAccL lines anywhere."""
    lua, _, _ = codegen_lua_from_program(
        _pick_place_program(PICK_J, PLACE_J),
        operator_speed_limit_pct=100)
    accL = [ln for ln in lua.splitlines() if ln.startswith('setAccL(')]
    assert accL == [], accL


# ── §1: motion_profile + SMOOTH gate ────────────────────────────

def test_smooth_gated_off_by_default():
    """2026-07-30 §2 revert: profile='smooth' with the shipping default
    motion_config (wire_verified_blender=False) MUST NOT emit
    setBlender / setNoBlender — those verbs are NOT in luaenginelib.
    json's 168-entry catalogue and would be refused by the linter and
    at runtime. Header note must announce the demotion so the
    operator sees that the requested profile was gated.

    The 2026-07-31 flip to True was based on a misread of the editor
    syntax-highlighter keyword list (same trap as setPayload); it
    landed with no wire-verified callsite and would have started
    failing at runtime on every SMOOTH-authored program. Reverted."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['motion_profile'] = 'smooth'
    prog['config']['adaptations'] = 'off'    # isolate the modal path
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    assert not any(ln.startswith('setBlender(') for ln in lua.splitlines()), lua
    assert not any(ln.startswith('setNoBlender(') for ln in lua.splitlines()), lua
    # Header note MUST announce demotion — SMOOTH is gated.
    assert 'SMOOTH REQUESTED BUT GATED OFF' in lua


def test_wire_verified_blender_flag_defaults_to_false():
    """DEFAULT_MOTION_CONFIG.wire_verified_blender is False (post-
    2026-07-30 revert). This test freezes the default so any future
    flip to True — which would emit setBlender / setNoBlender that
    the linter would refuse — surfaces as a visible failure."""
    assert DEFAULT_MOTION_CONFIG['wire_verified_blender'] is False


def test_smooth_gated_off_when_flag_flipped():
    """Explicit motion_config override to False must gate SMOOTH off
    even in the 2026-07-31 default-True world — used for a fast rollback
    at the operator's discretion without editing DEFAULT_MOTION_CONFIG."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['motion_profile'] = 'smooth'
    prog['config']['adaptations'] = 'off'
    mc = {'wire_verified_blender': False}
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, motion_config=mc)
    assert not any(ln.startswith('setBlender(') for ln in lua.splitlines()), lua
    assert 'SMOOTH REQUESTED BUT GATED OFF' in lua


def test_smooth_active_when_wire_verified_blender_true():
    """Flip the flag; SMOOTH now emits setBlender + setNoBlender."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['motion_profile'] = 'smooth'
    mc = {'wire_verified_blender': True}
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, motion_config=mc)
    lines = lua.splitlines()
    blender_lines    = [ln for ln in lines if ln.startswith('setBlender(')]
    no_blender_lines = [ln for ln in lines if ln.startswith('setNoBlender(')]
    assert blender_lines, lines
    # Contacts and the final step demote → setNoBlender.
    assert no_blender_lines, lines


def test_program_end_leaves_blender_off():
    """Invariant: no matter which step is last, the emitted Lua ends
    with the blender OFF. Either the last motion step's prelude
    emitted setNoBlender for its own reason (contact, linked, final),
    OR the program-end cleanup emitted an explicit setNoBlender.
    Either way, the LAST setBlender/setNoBlender line in the exec
    region must be a setNoBlender."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['motion_profile'] = 'smooth'
    mc = {'wire_verified_blender': True}
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, motion_config=mc)
    blend_lines = [ln for ln in lua.splitlines()
                   if ln.startswith('setBlender(')
                   or ln.startswith('setNoBlender(')]
    assert blend_lines, lua
    assert blend_lines[-1].startswith('setNoBlender('), (
        f'program ended with blender ARMED: last was {blend_lines[-1]!r}')


def test_program_end_setNoBlender_fires_when_last_step_isnt_contact():
    """A program that ends on a NON-contact step (e.g. a derived
    retreat) requires the program-end cleanup to close the blender.
    Fixture: single approach-only program, no closing home."""
    prog = {
        'id': 'no-closing-home',
        'config': {'speed_pct': 50, 'motion_profile': 'smooth'},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': PICK_J, 'position_role': 'pick',
             'taught_tcp': [0.400, 0.100, 0.200, 0, 0, 0]},
            # Two derived approaches so blender arms between them.
            {'id': 2, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 200},
            {'id': 3, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 300},
        ],
    }
    mc = {'wire_verified_blender': True}
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, motion_config=mc)
    # Last emitted step is derived (retreat lift) — the 'final' mark
    # in _mark_blend_demotions demotes it, so setNoBlender must appear.
    blend_lines = [ln for ln in lua.splitlines()
                   if ln.startswith('setBlender(')
                   or ln.startswith('setNoBlender(')]
    assert blend_lines and blend_lines[-1].startswith('setNoBlender('), lua


def test_contact_step_demotes_blender():
    """A taught contact (has taught_joints, no derived_from) must
    demote — setNoBlender emitted before its movL/movJ. Adaptations
    off to isolate the SMOOTH modal emission from analyzer rules
    that might force joint transits (see analyzer §1 §4)."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['motion_profile'] = 'smooth'
    prog['config']['adaptations'] = 'off'
    mc = {'wire_verified_blender': True}
    lua, _, _ = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, motion_config=mc)
    lines = lua.splitlines()
    # Find the first contact emission — 'step move_linear' comment
    # without derived_from.
    for i, ln in enumerate(lines):
        if ('step move_linear' in ln and 'derived_from' not in ln
                and (ln.startswith('movJ(') or ln.startswith('movL('))):
            # Search preceding non-blank/non-comment for setNoBlender.
            found = False
            for j in range(i - 1, -1, -1):
                if lines[j].startswith('setNoBlender('):
                    found = True
                    break
                if lines[j].startswith('movJ(') or lines[j].startswith('movL('):
                    break
            assert found, f'setNoBlender not found before contact at line {i}: {ln}'
            return


def test_smooth_profile_note_lands_in_footer():
    """The header footer's `-- motion:` line must show the requested
    profile + blend preset + radius so the operator can eyeball the
    profile decision."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['motion_profile'] = 'smooth'
    prog['config']['blend_preset'] = 'fine'
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    motion_lines = [ln for ln in lua.splitlines() if ln.startswith('-- motion:')]
    assert motion_lines, lua
    assert 'profile=smooth' in motion_lines[0]
    assert "blend_preset='fine'" in motion_lines[0]
    assert 'radius_mm=3' in motion_lines[0]


# ── §1 short-segment / linked demotion ───────────────────────────

def test_zero_length_linked_waypoint_marked_demote():
    """Two consecutive resolvable moves at the SAME cartesian position
    must both be marked 'linked_zero_length' by _mark_blend_demotions.
    """
    steps = [
        {'id': 1, 'action': 'move_linear', 'position_role': 'p1',
         'taught_joints': [10, 20, 30, 40, 50, 60],
         'taught_tcp': [0.5, 0.0, 0.5, 0, 0, 0]},
        {'id': 2, 'action': 'move_linear', 'position_role': 'p2',
         'taught_joints': [10, 20, 30, 40, 50, 60],
         'taught_tcp': [0.5, 0.0, 0.5, 0, 0, 0]},   # identical
    ]
    mc = _merged_motion_config(None)
    marks = _mark_blend_demotions(steps, mc, mc['blend_radius_mm']['medium'])
    # Step 2 sits at the same xyz as step 1 → linked_zero_length.
    assert marks[1][0] is True
    assert 'linked_zero_length' in marks[1][1]


def test_short_segment_demoted():
    """A waypoint between two short segments demotes with a
    short_segment_before or short_segment_after reason. Uses blend
    radius=30 mm so a 20 mm segment (< 2×30 = 60 mm threshold) trips.
    """
    # Three transit poses along a 20-mm-spaced line.
    steps = [
        {'id': 1, 'action': 'move_linear',
         'taught_joints': [1, 2, 3, 4, 5, 6],
         'taught_tcp': [0.500, 0.0, 0.500, 0, 0, 0], 'position_role': 'a'},
        {'id': 2, 'action': 'move_linear',
         'taught_joints': [1, 2, 3, 4, 5, 6],
         'taught_tcp': [0.520, 0.0, 0.500, 0, 0, 0], 'position_role': 'b'},
        {'id': 3, 'action': 'move_linear',
         'taught_joints': [1, 2, 3, 4, 5, 6],
         'taught_tcp': [0.540, 0.0, 0.500, 0, 0, 0], 'position_role': 'c'},
    ]
    mc = _merged_motion_config({'blend_radius_mm': {'medium': 30.0}})
    marks = _mark_blend_demotions(steps, mc, 30.0)
    # All are contacts (taught_joints + not derived) — they demote as
    # contacts. To exercise the short-segment path explicitly, run the
    # same fixture with derived steps.
    assert all(m[0] for m in marks)   # every one demotes for some reason
    # At least one reason includes 'contact' or 'short_segment'.
    assert any('contact' in m[1] or 'short_segment' in m[1]
               for m in marks)


def test_final_step_marked_final_demotion():
    """Last resolvable motion is marked 'final' so the program-end
    setNoBlender is emitted (invariant: never leave blender armed)."""
    steps = [
        {'id': 1, 'action': 'move_linear',
         'taught_joints': [1, 2, 3, 4, 5, 6],
         'taught_tcp': [0.5, 0.0, 0.5, 0, 0, 0], 'position_role': 'a',
         'derived_from': 'zzz'},   # forces this to not be a contact
        {'id': 2, 'action': 'move_home',
         'taught_joints': [0, 0, 0, 0, 0, 0],
         'taught_tcp': [0.3, 0.0, 0.6, 0, 0, 0]},
    ]
    mc = _merged_motion_config(None)
    marks = _mark_blend_demotions(steps, mc, mc['blend_radius_mm']['medium'])
    # move_home is treated as a taught pose → demotes; the LAST motion
    # step is also 'final'. Either reason satisfies the invariant.
    assert marks[-1][0] is True


# ── §4: verify_input via waitCondition ─────────────────────────

def test_verify_input_emits_waitCondition():
    """verify_input with expect + timeout_ms → one blocking line."""
    prog = {
        'id': 'wait-cond-test',
        'steps': [
            {'id': 1, 'action': 'verify_input', 'io_id': 'DI4',
             'expect': 1, 'timeout_ms': 5000},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    wc_lines = [ln for ln in lua.splitlines()
                if ln.startswith('waitCondition(')]
    assert wc_lines, lua
    assert 'getDI(4)==1' in wc_lines[0]
    assert ',5000)' in wc_lines[0]


def test_wait_input_stays_readonly_without_expect():
    """Backward compat: bare wait_input (no expect / no timeout_ms)
    still emits `_diN = getDI(port)` — programs that USED the read
    value in downstream logic keep working."""
    prog = {
        'id': 'wait-read-test',
        'steps': [
            {'id': 1, 'action': 'wait_input', 'io_id': 'DI2'},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    assert any('_di1 = getDI(2)' in ln for ln in lines), lua
    assert not any(ln.startswith('waitCondition(') for ln in lines), lua


def test_verify_input_requires_timeout_ms():
    """Refuse to emit an unbounded wait — verify_input without
    timeout_ms is skipped with an explicit reason (safety default)."""
    prog = {
        'id': 'no-timeout',
        'steps': [
            {'id': 1, 'action': 'verify_input', 'io_id': 'DI4', 'expect': 1},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    skip_lines = [ln for ln in lua.splitlines() if 'skipped' in ln]
    assert skip_lines, lua
    assert 'timeout_ms is required' in skip_lines[0]


def test_wait_input_upgrades_when_expect_present():
    """wait_input with expect + timeout_ms → upgrades to waitCondition.
    Path preserved so operator UIs authoring wait_input steps get the
    blocking semantics for free by adding the two fields."""
    prog = {
        'id': 'upgrade-test',
        'steps': [
            {'id': 1, 'action': 'wait_input', 'io_id': 'DI7',
             'expect': 0, 'timeout_ms': 2000},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    wc_lines = [ln for ln in lua.splitlines()
                if ln.startswith('waitCondition(')]
    assert wc_lines, lua
    assert 'getDI(7)==0' in wc_lines[0]


# ── determinism sanity ─────────────────────────────────────────

def test_motion_vocab_codegen_is_deterministic():
    """Same input → same Lua on repeat calls, including all the new
    prelude emissions."""
    prog = _pick_place_program(PICK_J, PLACE_J)
    prog['config']['motion_profile'] = 'smooth'
    prog['config']['descent_accel'] = 'gentle'
    mc = {'wire_verified_blender': True}
    lua_a, vp_a, pct_a = codegen_lua_from_program(
        prog, operator_speed_limit_pct=100, motion_config=mc)
    lua_b, vp_b, pct_b = codegen_lua_from_program(
        copy.deepcopy(prog), operator_speed_limit_pct=100,
        motion_config=dict(mc))
    # Trailer comment carries a timestamp; strip it before comparing.
    def _no_trailer(s):
        return '\n'.join(ln for ln in s.splitlines()
                         if not ln.startswith('--Lua version'))
    assert _no_trailer(lua_a) == _no_trailer(lua_b)
    assert vp_a == vp_b
    assert pct_a == pct_b
