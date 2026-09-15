"""Pinned tests for the geometry-aware motion analyzer (2026-07-30).

One dedicated test per rule (§1-§4 of the task):
  Rule 2a  blend_radius_scaling
  Rule 2b  near_limit_speed_cap
  Rule 2c  descent_split
  Rule 2d  micro_coalesce
  Rule 2e  awkward_wrist_transit
  Rule 3a  joint_limit_margin (warn)
  Rule 3b  approach_below_part_height (warn)
  Rule 3c  inconsistent_wrist_orientation (warn)
  Scope    adaptations switch, no-mutation invariant, no-op regression

Every test uses a synthetic fixture chosen to fire exactly one rule
so an incidental change to the analyzer surfaces as ONE targeted
failure, not a cascade of collateral damage.
"""
from __future__ import annotations

import copy
import json

from estun_driver.program_ops import (
    DEFAULT_ANALYZER_CONFIG,
    analyze_program,
    codegen_lua_from_program,
)


# ── Rule 2a: blend radius scaling ──────────────────────────────

def test_rule_2a_blend_radius_scaled_to_short_segment():
    """A waypoint between two close-together taught points must get a
    scaled blend_radius_mm_override under the profile radius."""
    # Three transits ~10 mm apart in a straight line — blend radius
    # would default to 12 mm (medium preset). Rule 2a: 25% × 10 mm
    # = 2.5 mm scaled radius.
    prog = {
        'id': 'rule-2a',
        'config': {'motion_profile': 'smooth'},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [10, 0, 0, 0, 90, 0], 'position_role': 'a',
             'taught_tcp': [0.500, 0.000, 0.500, 0, 0, 0]},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [11, 0, 0, 0, 90, 0], 'position_role': 'b',
             'taught_tcp': [0.510, 0.000, 0.500, 0, 0, 0]},
            {'id': 3, 'action': 'move_linear',
             'taught_joints': [12, 0, 0, 0, 90, 0], 'position_role': 'c',
             'taught_tcp': [0.520, 0.000, 0.500, 0, 0, 0]},
        ],
    }
    rep = analyze_program(prog)
    # Every waypoint whose adjacent segment is 10 mm should get an
    # override ≈ 2.5 mm.
    scaled = [(i, a['blend_radius_mm_override'])
              for i, a in rep['adaptations'].items()
              if a.get('blend_radius_mm_override') is not None]
    assert scaled, rep
    for i, r in scaled:
        assert r < 12.0
        assert 0 < r < 3.5, (i, r)


# ── Rule 2b: near-limit / wrist-singularity speed cap ──────────

def test_rule_2b_speed_cap_near_wrist_singularity():
    """Segment whose linear path passes within 10° of |J5|=0 must
    trigger a speed cap adaptation. Fixture: start J5=0, end J5=90 —
    the linear-interp path passes through J5=0 at the start sample."""
    prog = {
        'id': 'rule-2b',
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': [0, 0, 0, 0, 0, 0]},        # J5 = 0
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [10, 0, 0, 0, 90, 0]},      # J5 = 90
        ],
    }
    rep = analyze_program(prog)
    # Step 1's incoming segment (from step 0) passes through J5=0.
    a = rep['adaptations'].get(1)
    assert a is not None, rep
    assert a['speed_pct_cap'] == 50
    assert 'near_limit_speed_cap' in a['rules_applied']


def test_rule_2b_speed_cap_near_joint_limit():
    """Segment path within 15° of a joint limit → speed cap."""
    # J3 limit is ±166°.  Start J3=140°, end J3=155° — both within
    # 15° of +166.
    prog = {
        'id': 'rule-2b-limit',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [0, 0, 140, 0, 90, 0]},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [0, 0, 155, 0, 90, 0]},
        ],
    }
    rep = analyze_program(prog)
    a = rep['adaptations'].get(1)
    assert a is not None, rep
    assert a['speed_pct_cap'] == 50


# ── Rule 2c: descent length sanity ─────────────────────────────

def test_rule_2c_long_descent_triggers_split():
    """A taught contact whose preceding approach sits >250 mm above
    it triggers a descent_split adaptation."""
    # Approach at +300 mm above the contact — over the 250 mm
    # threshold.
    prog = {
        'id': 'rule-2c',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 300},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [30, 20, 110, 45, 90, -100],
             'position_role': 'pick'},
        ],
    }
    rep = analyze_program(prog)
    a = rep['adaptations'].get(1)
    assert a is not None and a.get('descent_split'), rep
    assert a['descent_split']['fast_stop_z_above_contact_mm'] == 50.0


def test_rule_2c_short_descent_no_split():
    """Approach at 100 mm — well below the 250 mm threshold — must NOT
    trigger a descent_split."""
    prog = {
        'id': 'rule-2c-neg',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [30, 20, 110, 45, 90, -100],
             'position_role': 'pick'},
        ],
    }
    rep = analyze_program(prog)
    for a in rep['adaptations'].values():
        assert not a.get('descent_split'), rep


def test_rule_2c_split_lua_inserts_intermediate_movL():
    """Descent-split adaptation applied at codegen time must emit an
    intermediate movL + gentle setAccL BEFORE the taught contact."""
    prog = {
        'id': 'rule-2c-lua',
        'config': {'speed_pct': 50},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 300},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [30, 20, 110, 45, 90, -100],
             'position_role': 'pick'},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    lines = lua.splitlines()
    # An intermediate `RULE 2c intermediate movL` line MUST appear
    # before the taught-contact emission.
    inter_idx = next((i for i, ln in enumerate(lines)
                      if 'RULE 2c intermediate movL' in ln), None)
    contact_idx = next((i for i, ln in enumerate(lines)
                        if ln.startswith('movL(') and 'step move_linear' in ln
                        and 'derived_from' not in ln
                        and 'intermediate' not in ln), None)
    assert inter_idx is not None, lua
    assert contact_idx is not None, lua
    assert inter_idx < contact_idx, (inter_idx, contact_idx)
    # A gentle setAccL for the final descent must land between them.
    gentle_setAccL = [i for i in range(inter_idx, contact_idx)
                     if lines[i].startswith('setAccL(150')]
    assert gentle_setAccL, lua


# ── Rule 2d: micro-segment coalescing ──────────────────────────

def test_rule_2d_micro_gap_coalesced():
    """Two consecutive taught points closer than 2 mm — the second
    must be marked coalesce_with_prev, and codegen must suppress its
    emission."""
    prog = {
        'id': 'rule-2d',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [10, 20, 30, 40, 90, 0],
             'taught_tcp': [0.500, 0.000, 0.500, 0, 0, 0]},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [10, 20, 30, 40, 90, 0],
             'taught_tcp': [0.5005, 0.0005, 0.5005, 0, 0, 0]},   # 0.87 mm away
        ],
    }
    rep = analyze_program(prog)
    a = rep['adaptations'].get(1)
    assert a is not None
    assert a['coalesce_with_prev'] is True, rep
    # Codegen suppresses the step.
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    coalesce_lines = [ln for ln in lua.splitlines()
                      if 'motion_check COALESCED' in ln]
    assert len(coalesce_lines) == 1, lua


# ── Rule 2e: awkward-wrist transit → force joint ───────────────

def test_rule_2e_wrist_delta_over_30_forces_joint():
    """A move_linear transit whose start and end differ by > 30° in
    any wrist axis must get force_motion_profile='joint'."""
    prog = {
        'id': 'rule-2e',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 0, 90, 0]},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 45, 90, 0]},   # J4 delta = 45°
        ],
    }
    rep = analyze_program(prog)
    a = rep['adaptations'].get(1)
    assert a is not None, rep
    assert a['force_motion_profile'] == 'joint'


def test_rule_2e_small_wrist_delta_no_force():
    """< 30° wrist delta must NOT trigger the awkward-wrist rule."""
    prog = {
        'id': 'rule-2e-neg',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 0, 90, 0]},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 20, 90, 0]},   # J4 delta = 20°
        ],
    }
    rep = analyze_program(prog)
    for a in rep['adaptations'].values():
        assert a.get('force_motion_profile') is None, rep


# ── Rule 3a: joint-limit margin (warn only) ────────────────────

def test_rule_3a_taught_point_near_limit_warns():
    """Taught pose with J3 = 162° (4° from ±166° limit) triggers a
    'joint_limit_margin' warn finding."""
    prog = {
        'id': 'rule-3a',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [0, 0, 162, 0, 90, 0]},
        ],
    }
    rep = analyze_program(prog)
    warns = [f for f in rep['findings']
             if f['rule'] == 'joint_limit_margin']
    assert warns, rep
    assert warns[0]['severity'] == 'warn'
    assert 'J3' in warns[0]['message']


# ── Rule 3b: approach below part height (warn only) ────────────

def test_rule_3b_approach_below_part_height_warns():
    """When a program is bound to a part and its approach offset is
    less than the part's height, a warning is surfaced."""
    prog = {
        'id': 'rule-3b',
        'config': {'pbd_metadata': {'part_ids': ['tall-part']}},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 30},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [30, 20, 110, 45, 90, -100],
             'position_role': 'pick'},
        ],
    }
    part_index = {'parts': [{
        'id': 'tall-part',
        'name': 'tall',
        'extents_cm': [3.0, 3.0, 6.0],   # 60 mm tall
    }]}
    rep = analyze_program(prog, part_index=part_index)
    warns = [f for f in rep['findings']
             if f['rule'] == 'approach_below_part_height']
    assert warns, rep


def test_rule_3b_no_warn_without_part_binding():
    """Empty part_ids — the warning MUST NOT fire even if the parts
    library is provided."""
    prog = {
        'id': 'rule-3b-neg',
        'config': {'pbd_metadata': {'part_ids': []}},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 30},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [30, 20, 110, 45, 90, -100],
             'position_role': 'pick'},
        ],
    }
    part_index = {'parts': [{'id': 'x', 'extents_cm': [1, 1, 6.0]}]}
    rep = analyze_program(prog, part_index=part_index)
    warns = [f for f in rep['findings']
             if f['rule'] == 'approach_below_part_height']
    assert not warns, rep


# ── Rule 3c: inconsistent wrist across program ─────────────────

def test_rule_3c_inconsistent_wrists_warn():
    """3+ pairs of taught points differing >20° in wrist axes — one
    'inconsistent_wrist_orientation' warn finding at the first step."""
    prog = {
        'id': 'rule-3c',
        'steps': [
            {'id': 1, 'action': 'move_linear', 'taught_joints': [0,0,0,0,90,  0]},
            {'id': 2, 'action': 'move_linear', 'taught_joints': [0,0,0,0,90, 30]},   # J6 +30
            {'id': 3, 'action': 'move_linear', 'taught_joints': [0,0,0,0,90, 60]},   # J6 +60
            {'id': 4, 'action': 'move_linear', 'taught_joints': [0,0,0,0,90, 90]},   # J6 +90
        ],
    }
    rep = analyze_program(prog)
    warns = [f for f in rep['findings']
             if f['rule'] == 'inconsistent_wrist_orientation']
    assert len(warns) == 1, rep
    assert warns[0]['severity'] == 'warn'


# ── Scope guards §4 ────────────────────────────────────────────

def test_adaptations_off_leaves_targets_untouched():
    """With adaptations='off', codegen must ignore the analyzer's
    adaptation dict — no speed cap, no split, no coalesce. Findings
    still land in the footer."""
    # Build a program that would normally trigger BOTH rule 2b and
    # rule 2e.
    prog = {
        'id': 'scope-off',
        'config': {'adaptations': 'off'},
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 0, 0, 0]},         # J5=0
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 45, 90, 0]},       # J4 delta 45, path through J5=0
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    # Adaptation stamps MUST NOT appear (adaptations dict was empty).
    assert 'motion_check ADAPTED' not in lua, lua
    assert 'RULE 2c' not in lua, lua
    # Findings summary still shows up in the footer.
    assert 'motion_check:' in lua
    assert 'adaptations_switch=off' in lua


def test_adaptations_on_by_default():
    """No explicit config.adaptations → analyzer adaptations are
    applied.  Same fixture as scope-off; adaptations stamps DO
    appear."""
    prog = {
        'id': 'scope-on',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 0, 0, 0]},
            {'id': 2, 'action': 'move_linear',
             'taught_joints': [0, 0, 0, 45, 90, 0]},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    assert 'motion_check ADAPTED' in lua, lua
    assert 'adaptations_switch=on' in lua


def test_taught_targets_are_immutable():
    """No matter what rules fire, the emitted varspoint's `jp` list
    for the taught contact must equal the operator's taught_joints
    exactly (rounded to the codegen's 3-decimal serialization)."""
    contact_j = [30.123, 20.456, 110.789, 45.012, 90.345, -100.678]
    prog = {
        'id': 'immutable',
        'steps': [
            {'id': 1, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 300},   # triggers 2c
            {'id': 2, 'action': 'move_linear',
             'taught_joints': contact_j, 'position_role': 'pick'},
        ],
    }
    lua, varspoint, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    # Find the varspoint entry whose joints match the taught contact.
    contact_entry = None
    for name, pt in varspoint.items():
        val = json.loads(pt['val'])
        if val['jp'] == contact_j:
            contact_entry = (name, val)
            break
    assert contact_entry is not None, (
        f'taught_joints {contact_j} not found unchanged in any varspoint '
        f'entry — analyzer MUST NOT mutate taught targets. varspoint={varspoint}')


def test_no_rule_triggers_produces_clean_lua():
    """Regression gate: a program that hits NO analyzer rule must
    emit Lua containing no `motion_check ADAPTED` stamps and no
    `RULE 2c` intermediate emissions. Findings block may still note
    zero findings / adaptations."""
    prog = {
        'id': 'clean',
        'config': {'speed_pct': 50},
        'steps': [
            {'id': 1, 'action': 'move_home',
             'taught_joints': [0, 0, 0, 0, 90, 0]},   # J5 away from 0
            {'id': 2, 'action': 'move_linear',
             'derived_from': 'pick', 'offset_z_mm': 100},   # short descent
            {'id': 3, 'action': 'move_linear',
             'taught_joints': [10, 5, 20, 5, 90, 0],
             'position_role': 'pick'},
            {'id': 4, 'action': 'move_home',
             'taught_joints': [0, 0, 0, 0, 90, 0]},
        ],
    }
    lua, _, _ = codegen_lua_from_program(prog, operator_speed_limit_pct=100)
    assert 'motion_check ADAPTED' not in lua, lua
    assert 'RULE 2c intermediate movL' not in lua, lua
    assert 'motion_check COALESCED' not in lua, lua


def test_analyzer_is_pure_deterministic():
    """analyze_program must not mutate its input program."""
    prog = {
        'id': 'purity',
        'steps': [
            {'id': 1, 'action': 'move_linear', 'taught_joints': [0,0,0,0,90,0]},
            {'id': 2, 'action': 'move_linear', 'taught_joints': [0,0,0,45,90,0]},
        ],
    }
    snapshot = copy.deepcopy(prog)
    analyze_program(prog)
    analyze_program(prog)
    assert prog == snapshot, 'analyze_program mutated its input!'


def test_default_analyzer_config_matches_task_thresholds():
    """Sanity: the task spec explicitly names 5°, 10°, 15°, 20°, 30°,
    250 mm, 50 mm, 2 mm thresholds — pin them here so a future
    'tune' surfaces as a visible failure."""
    ac = DEFAULT_ANALYZER_CONFIG
    assert ac['joint_limit_margin_warn_deg'] == 5.0
    assert ac['wrist_singularity_deg'] == 10.0
    assert ac['joint_limit_margin_cap_deg'] == 15.0
    assert ac['inconsistent_wrist_deg'] == 20.0
    assert ac['awkward_wrist_delta_deg'] == 30.0
    assert ac['max_descent_mm'] == 250.0
    assert ac['descent_split_stop_above_mm'] == 50.0
    assert ac['micro_segment_mm'] == 2.0
    assert ac['near_limit_speed_scale'] == 0.5
    assert ac['adaptation_blend_frac'] == 0.25
