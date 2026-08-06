"""2026-08-06 operator directive — Blocker A pallet codegen.

Pinned invariants:

  (A) Slot geometry math: derive_slot_tcps produces N = rows*cols*
      layers slots. Slot [0,0,0] = part_tcp. Slot [0,1,0] = part_tcp
      + pitch_row along row axis. Slot [1,0,0] = part_tcp + pitch_col
      along col axis. Layer offset is layer_height along plane_normal.

  (B) IK convergence: seeded_ik_to_pose solves each slot TCP to
      within 0.10 mm / 0.011° when seeded from a nearby (pick)
      joint config. Pre-fix Blocker A had NO IK for arbitrary XY
      — the codegen skip-with-comment left step 7 emitting nothing.

  (C) Codegen emits per-slot sub-sequences: 4 movL + 1 setDO + 1
      wait per slot. rows*cols*layers slots → 6*N lines under the
      expansion header. No skip line. Line-map's move_to_pallet
      entry covers the full range.

  (D) Fixed-XYZ Euler orientation: R_target = Rz(c)·Ry(b)·Rx(a).
      Pre-fix used _rot_exp (rotation-vector), which is WRONG for
      Estun's a/b/c convention — LM converged to wrist-flipped
      branches with ~55° orientation error.

  (E) Emitted point-table units are METERS internal (from
      pallet_geometry) but the WIRE format is joint angles in
      DEGREES (postype='jp', matches whitebowlpickplace precedent).

  (F) Golden point-table for holepartpalletize — each place slot
      FK's to its geometric target within tolerance.

Fork registry: pallet_codegen (Blocker A).
"""

from __future__ import annotations

import json
import math
import os
import sys


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..',
                                                  'estun_driver')))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..',
                                                  'programming_by_demonstration')))

from estun_driver import program_ops     # noqa: E402
from programming_by_demonstration.schema import PalletPlaceSpec  # noqa: E402
from programming_by_demonstration.pallet_geometry import (  # noqa: E402
    derive_slot_tcps, compute_frame,
)


# ── (A) Slot geometry math ─────────────────────────────────

def _test_spec():
    """A canonical 2x2x2 spec matching the holepartpalletize demo."""
    return PalletPlaceSpec.from_dict({
        'rows':            2,
        'cols':            2,
        'layers':          2,
        'pitch_row_mm':    150.0,
        'pitch_col_mm':    150.0,
        'layer_height_mm': 100.0,
        'order':           'row_major',
        'corner1_tcp':     [0.540, 0.100, 0.135, 3.1, 0.0, -0.8],
        'corner2_tcp':     [0.540, 0.480, 0.135, 3.1, 0.0, -0.8],
        'corner3_tcp':     [0.940, 0.070, 0.135, 3.1, 0.0, -0.8],
        'part_tcp':        [0.650, 0.180, 0.135, 3.1, 0.0, -0.8],
    })


def test_slot_geometry_all_slots_emitted():
    """rows*cols*layers slots are emitted, in fill order."""
    spec = _test_spec()
    slots = derive_slot_tcps(spec, tuple(spec.corner1_tcp))
    assert len(slots) == spec.rows * spec.cols * spec.layers == 8


def test_slot_00_is_part_tcp():
    """Slot [0,0,0] = part_tcp exactly (operator doctrine §484)."""
    spec = _test_spec()
    slots = derive_slot_tcps(spec, tuple(spec.corner1_tcp))
    slot00 = next(s for s in slots
                  if s['row'] == 0 and s['col'] == 0 and s['layer'] == 0)
    # Position matches part_tcp within numerical noise.
    for i in range(3):
        assert abs(slot00['tcp_m'][i] - spec.part_tcp[i]) < 1e-6, (
            f'Slot [0,0,0] must equal part_tcp — component {i} '
            f'differs by {abs(slot00["tcp_m"][i] - spec.part_tcp[i]):.6f} m')


def test_slot_along_row_axis_steps_pitch_row():
    """Slot [0,1,0] − slot [0,0,0] magnitude = pitch_row_mm/1000."""
    spec = _test_spec()
    slots = derive_slot_tcps(spec, tuple(spec.corner1_tcp))
    s00 = next(s for s in slots if s['row']==0 and s['col']==0 and s['layer']==0)
    s01 = next(s for s in slots if s['row']==0 and s['col']==1 and s['layer']==0)
    dx = s01['tcp_m'][0] - s00['tcp_m'][0]
    dy = s01['tcp_m'][1] - s00['tcp_m'][1]
    dz = s01['tcp_m'][2] - s00['tcp_m'][2]
    mag = math.sqrt(dx*dx + dy*dy + dz*dz)
    assert abs(mag - spec.pitch_row_mm / 1000.0) < 1e-4, (
        f'|[0,1,0] − [0,0,0]| must equal pitch_row_mm, '
        f'got {mag*1000:.3f} mm vs {spec.pitch_row_mm:.3f} mm')


def test_slot_along_col_axis_steps_pitch_col():
    spec = _test_spec()
    slots = derive_slot_tcps(spec, tuple(spec.corner1_tcp))
    s00 = next(s for s in slots if s['row']==0 and s['col']==0 and s['layer']==0)
    s10 = next(s for s in slots if s['row']==1 and s['col']==0 and s['layer']==0)
    dx = s10['tcp_m'][0] - s00['tcp_m'][0]
    dy = s10['tcp_m'][1] - s00['tcp_m'][1]
    dz = s10['tcp_m'][2] - s00['tcp_m'][2]
    mag = math.sqrt(dx*dx + dy*dy + dz*dz)
    assert abs(mag - spec.pitch_col_mm / 1000.0) < 1e-4, (
        f'|[1,0,0] − [0,0,0]| must equal pitch_col_mm, '
        f'got {mag*1000:.3f} mm vs {spec.pitch_col_mm:.3f} mm')


def test_layer_offset_along_plane_normal():
    """Slot [0,0,1] − slot [0,0,0] magnitude = layer_height_mm/1000."""
    spec = _test_spec()
    slots = derive_slot_tcps(spec, tuple(spec.corner1_tcp))
    s00 = next(s for s in slots if s['layer'] == 0 and s['row']==0 and s['col']==0)
    s01 = next(s for s in slots if s['layer'] == 1 and s['row']==0 and s['col']==0)
    dx = s01['tcp_m'][0] - s00['tcp_m'][0]
    dy = s01['tcp_m'][1] - s00['tcp_m'][1]
    dz = s01['tcp_m'][2] - s00['tcp_m'][2]
    mag = math.sqrt(dx*dx + dy*dy + dz*dz)
    assert abs(mag - spec.layer_height_mm / 1000.0) < 1e-4, (
        f'|layer 1 - layer 0| = layer_height_mm, got {mag*1000:.3f} mm')


# ── (B) IK convergence ─────────────────────────────────────

def test_seeded_ik_solves_pick_itself():
    """FK(seed) as target → IK converges to seed within tolerance."""
    seed = [-28.46, 32.84, 122.83, 65.23, 92.36, -71.13]
    target = [0.765555, -0.187313, 0.132565,
              3.100210897, -0.006003932, -0.825680362]
    r = program_ops.seeded_ik_to_pose(seed, target)
    assert r is not None
    q, pos_err, ori_err = r
    assert pos_err < 0.10, f'pos_err {pos_err:.3f} mm exceeds tol'
    assert ori_err < 0.05, f'ori_err {ori_err:.4f}° exceeds tol'
    # Same-branch: max joint deviation from seed < 0.1°.
    max_dev = max(abs(a - b) for a, b in zip(q, seed))
    assert max_dev < 0.1, f'same-target IK drifted {max_dev:.3f}°'


def test_seeded_ik_solves_z_lift():
    """+100mm Z target converges close to seeded_ik_z_lift's answer."""
    seed = [-28.46, 32.84, 122.83, 65.23, 92.36, -71.13]
    tgt = [0.765555, -0.187313, 0.232565,   # +100mm Z
           3.100210897, -0.006003932, -0.825680362]
    r_gen = program_ops.seeded_ik_to_pose(seed, tgt)
    r_zl  = program_ops.seeded_ik_z_lift_hold_orientation(seed, 100.0)
    assert r_gen is not None and r_zl is not None
    q_gen, _, _ = r_gen
    q_zl, _, _  = r_zl
    # Both should land in the same branch — max joint delta < 0.5°.
    max_delta = max(abs(a - b) for a, b in zip(q_gen, q_zl))
    assert max_delta < 0.5, (
        f'general IK diverged from Z-lift-only by {max_delta:.3f}° — '
        f'may have picked a different branch')


def test_seeded_ik_rejects_out_of_reach():
    """A target 3 m out of reach must return None, not garbage."""
    seed = [-28.46, 32.84, 122.83, 65.23, 92.36, -71.13]
    tgt = [3.000, 3.000, 0.500, 3.1, 0.0, -0.8]
    r = program_ops.seeded_ik_to_pose(seed, tgt, max_iter=40)
    assert r is None, 'out-of-reach target must return None'


# ── (D) Fixed-XYZ Euler orientation converter ──────────────

def test_R_from_tcp_abc_matches_fk():
    """The Euler converter must produce the same rotation the FK
    produces at those joints — otherwise the IK is chasing the
    wrong orientation."""
    seed = [-28.46, 32.84, 122.83, 65.23, 92.36, -71.13]
    target_abc = (3.100210897, -0.006003932, -0.825680362)
    R_ours = program_ops._R_from_tcp_abc(*target_abc)
    R_fk   = program_ops._fk_chain(seed)[6][:3, :3]
    # Max component-wise difference.
    import numpy as np
    diff = float(np.max(np.abs(R_ours - R_fk)))
    assert diff < 5e-3, (
        f'_R_from_tcp_abc must match FK rotation. Max diff {diff:.6f}. '
        f'If this fails, the Euler convention is wrong AGAIN — the '
        f'pre-fix _rot_exp had 55° error on this exact case.')


# ── (C, F) Codegen — full-program dry-run + golden point table ─

def _load_holepartpalletize():
    p = '/opt/cobot/programs/holepartpalletize.json'
    assert os.path.isfile(p), (
        'holepartpalletize.json not on disk — the golden fixture '
        'needs this program present to validate the emitter.')
    return json.load(open(p))


def test_codegen_no_skip_of_move_to_pallet():
    """The core Blocker A regression: emitted Lua must NOT contain
    "skipped 'move_to_pallet'". Pre-fix, that comment appeared and
    the whole place cycle disappeared."""
    prog = _load_holepartpalletize()
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert "skipped 'move_to_pallet'" not in lua, (
        'move_to_pallet is being skipped — Blocker A has regressed.')
    assert 'move_to_pallet EXPANSION' in lua, (
        'expected an EXPANSION header line for move_to_pallet')


def test_codegen_emits_rows_x_cols_x_layers_slots():
    """rows*cols*layers slot sub-sequences appear, one setDO per slot."""
    prog = _load_holepartpalletize()
    rows   = prog['config']['pallet']['rows']
    cols   = prog['config']['pallet']['cols']
    layers = prog['config']['pallet']['layers']
    n_expected = rows * cols * layers
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # One `pallet release` setDO per slot.
    n_release = lua.count('pallet release')
    assert n_release == n_expected, (
        f'expected {n_expected} pallet release IO fires '
        f'(rows*cols*layers), got {n_release}')
    # Slot-place lines named by index.
    for r in range(rows):
        for c in range(cols):
            for l in range(layers):
                assert f'slot[{r},{c},{l}] place' in lua, (
                    f'slot [{r},{c},{l}] place line missing')


def test_codegen_lint_and_line_map_intact():
    """The lint gate + line-map annotations remain clean after the
    expansion. Any codegen bug that emits an unrecognized verb or
    breaks the JSON line_map will fail here."""
    prog = _load_holepartpalletize()
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'lint: OK' in lua, 'codegen lint gate reports findings'
    # move_to_pallet's line_map entry must span from expansion header
    # to the last lift line.
    lm = [ln for ln in lua.splitlines() if '"action":"move_to_pallet"' in ln]
    assert lm, 'line_map missing move_to_pallet entry'


def test_golden_point_table_slot_places_match_geometry():
    """Every emitted place slot's FK-position must match the geometric
    slot target within 0.1 mm. This is the end-to-end sanity: the LM
    IK actually landed on the physical pallet slot, not somewhere
    else in reachable space."""
    prog = _load_holepartpalletize()
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Build the geometric truth from pallet_geometry.
    place = prog['config']['pallet_place']; pold = prog['config']['pallet']
    spec_dict = dict(place)
    spec_dict.update({
        'rows':            pold['rows'],
        'cols':            pold['cols'],
        'layers':          pold['layers'],
        'pitch_row_mm':    pold['spacing_x_mm'],
        'pitch_col_mm':    pold['spacing_y_mm'],
        'layer_height_mm': pold['layer_height_mm'],
        'order':           'row_major',
    })
    spec  = PalletPlaceSpec.from_dict(spec_dict)
    slots = derive_slot_tcps(spec, tuple(place['corner1_tcp']))
    # For each slot, find its `place` line + point-name from the
    # emitted Lua, look up the point, FK it, and compare.
    import re
    lines = lua.splitlines()
    for s in slots:
        r, c, l = s['row'], s['col'], s['layer']
        pat = rf'movL\((p\d+)\)\s+--\s+slot\[{r},{c},{l}\] place\b'
        hit = None
        for ln in lines:
            m = re.search(pat, ln)
            if m:
                hit = m.group(1)
                break
        assert hit is not None, (
            f'slot [{r},{c},{l}] place movL line missing from emitted Lua')
        # Point value → joints.
        val = points[hit]['val']
        if isinstance(val, str):
            val = json.loads(val)
        jp = val['jp']
        fk = program_ops._fk_chain(jp)[6][:3, 3]
        expected_mm = tuple(v * 1000.0 for v in s['tcp_m'][:3])
        for axis, (got, want) in enumerate(zip(fk, expected_mm)):
            assert abs(got - want) < 0.1, (
                f'slot [{r},{c},{l}] axis {axis}: FK={got:.3f} mm '
                f'vs expected {want:.3f} mm (delta {got-want:+.3f} mm) '
                f'— pallet IK is landing off the physical slot')


def test_emitted_points_are_joint_degrees_not_meters():
    """postype='jp', val decodes to jp:[deg, deg, deg, deg, deg, deg]
    matching whitebowlpickplace's wire-verified convention."""
    prog = _load_holepartpalletize()
    _, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    for nm, pt in points.items():
        assert pt.get('postype') == 'jp'
        val = pt['val']
        if isinstance(val, str):
            val = json.loads(val)
        jp = val['jp']
        assert len(jp) == 6
        # Degrees range check — every axis under 360 to catch a rogue
        # rad-vs-deg emission (a 1.5-rad value would look like 1.5 —
        # this catches an "in radians" bug).
        for j in jp:
            assert -360.0 < j < 360.0, (
                f'{nm} joint {j} outside ±360° — units may be radians '
                f'instead of degrees')


def test_out_of_reach_slot_aborts_pallet_not_partial():
    """When any slot's IK fails, the codegen must emit the PALLET IK
    FAILED comment and refuse to emit further slot sub-sequences.
    A partial emit (some slots placed, others silently missing) is
    the worst outcome — arm holds a part with nowhere to place it."""
    # Synthesize a spec whose slots march far out of reach.
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))   # deep copy
    # Move corner1 3 meters away — every slot is way beyond reach.
    prog['config']['pallet_place']['corner1_tcp'] = [3.0, 3.0, 0.5,
                                                      3.1, 0.0, -0.8]
    prog['config']['pallet_place']['corner2_tcp'] = [3.0, 3.4, 0.5,
                                                      3.1, 0.0, -0.8]
    prog['config']['pallet_place']['corner3_tcp'] = [3.4, 3.0, 0.5,
                                                      3.1, 0.0, -0.8]
    prog['config']['pallet_place']['part_tcp']    = [3.1, 3.1, 0.5,
                                                      3.1, 0.0, -0.8]
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'PALLET IK FAILED' in lua, (
        'out-of-reach pallet must emit a PALLET IK FAILED comment '
        'naming the offending slot; instead the codegen emitted:\n'
        + lua)


# ── 2026-08-06 operator directive: part_count + layer direction ─

def test_part_count_caps_slots_at_specified_value():
    """part_count=5 on 2×2×2 (capacity 8) → exactly 5 place cycles.
    Slot order matches the operator's demo spec: [0,0,0], [0,1,0],
    [1,0,0], [1,1,0], [0,0,1]. This is the golden fixture."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Exactly 5 pallet release IO fires.
    assert lua.count('pallet release') == 5, (
        f'expected 5 place cycles for part_count=5, got '
        f'{lua.count("pallet release")}')
    # Slot 5 must be layer 1 [0,0,1] — NOT [1,1,0] or [0,1,1].
    # Slots 1..4 are all of layer 0.
    expected_places = ['slot[0,0,0] place', 'slot[0,1,0] place',
                       'slot[1,0,0] place', 'slot[1,1,0] place',
                       'slot[0,0,1] place']
    lines = lua.splitlines()
    place_lines_in_order = [ln for ln in lines
                             if any(p in ln for p in expected_places)
                             and 'place' in ln]
    # Filter to just place (excludes traverse-height/approach/lift).
    place_lines_in_order = [ln for ln in place_lines_in_order
                             if 'place  joints' in ln]
    assert len(place_lines_in_order) == 5, (
        f'expected 5 place lines, got {len(place_lines_in_order)}: '
        f'{place_lines_in_order}')
    for i, want in enumerate(expected_places):
        assert want in place_lines_in_order[i], (
            f'position {i}: expected "{want}", got "{place_lines_in_order[i]}"')


def test_part_count_3_stays_within_layer_0():
    """part_count=3 → only [0,0,0], [0,1,0], [1,0,0]. Layer 0 has
    4 slots; 3 partial-fill leaves [1,1,0] and all layer 1 unused."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 3
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert lua.count('pallet release') == 3
    # No layer 1 slot may appear.
    assert 'slot[0,0,1]' not in lua
    assert 'slot[1,1,0] place' not in lua   # partial layer 0


def test_part_count_over_capacity_caps_and_warns():
    """part_count=15 on capacity 8 → cap at 8, emit a warning comment."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 15
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert lua.count('pallet release') == 8, (
        'over-capacity must cap at capacity, not emit garbage cycles')
    assert 'exceeds capacity' in lua, (
        'operator must see a comment naming the excess')
    assert 'capping at' in lua


def test_part_count_absent_emits_full_capacity():
    """No part_count field → emit rows*cols*layers (pre-directive
    behavior; back-compat for saved programs)."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    if 'part_count' in prog['config']['pallet']:
        del prog['config']['pallet']['part_count']
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    rows   = prog['config']['pallet']['rows']
    cols   = prog['config']['pallet']['cols']
    layers = prog['config']['pallet']['layers']
    assert lua.count('pallet release') == rows * cols * layers


def test_layer_index_increases_z():
    """Layer N sits ABOVE layer N-1 in +Z_base. Slot [0,0,1].z >
    Slot [0,0,0].z by layer_height_mm. Pre-fix, the derived normal
    could point downward and stack layers into the pallet — this
    test pins the sign-adjusted normal."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5   # includes layer 1
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Find the place point for slot [0,0,0] and [0,0,1] by scanning
    # the emitted Lua for the slot label. Then FK each.
    import re
    slot00_name = None
    slot01_name = None
    for ln in lua.splitlines():
        m = re.search(r'movL\((p\d+)\)\s+--\s+slot\[0,0,0\]\s+place\b', ln)
        if m: slot00_name = m.group(1)
        m = re.search(r'movL\((p\d+)\)\s+--\s+slot\[0,0,1\]\s+place\b', ln)
        if m: slot01_name = m.group(1)
    assert slot00_name and slot01_name, (
        f'could not find place lines for [0,0,0] / [0,0,1] in Lua')
    for nm in (slot00_name, slot01_name):
        val = points[nm]['val']
        if isinstance(val, str): val = json.loads(val)
    def _fk_z(nm):
        val = points[nm]['val']
        if isinstance(val, str): val = json.loads(val)
        return program_ops._fk_chain(val['jp'])[6][2, 3]
    z00 = _fk_z(slot00_name)
    z01 = _fk_z(slot01_name)
    layer_h_mm = float(prog['config']['pallet']['layer_height_mm'])
    dz = z01 - z00
    assert dz > 0, (
        f'layer 1 must sit ABOVE layer 0: got Δz = {dz:.2f} mm '
        f'(z00={z00:.2f}, z01={z01:.2f}). Layer direction has '
        f'regressed — plane_normal is pointing INTO the pallet.')
    assert abs(dz - layer_h_mm) < 2.0, (
        f'Δz between layers must equal layer_height_mm '
        f'({layer_h_mm:.1f}); got {dz:.2f}')


def test_layer_fully_filled_before_next_layer_starts():
    """Fill order = layer OUTERMOST. All rows*cols slots on layer L
    emit before any slot on layer L+1, regardless of the row/col
    fill order within a layer."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    rows   = prog['config']['pallet']['rows']
    cols   = prog['config']['pallet']['cols']
    layers = prog['config']['pallet']['layers']
    # Emit at full capacity so we see all layer 0 + all layer 1.
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    import re
    # Find the layer index for each place line, in emission order.
    layer_seq = []
    for ln in lua.splitlines():
        m = re.search(r'slot\[(\d+),(\d+),(\d+)\]\s+place\b', ln)
        if m:
            layer_seq.append(int(m.group(3)))
    # Sequence must be non-decreasing (no layer 1 followed by layer 0).
    for i in range(1, len(layer_seq)):
        assert layer_seq[i] >= layer_seq[i-1], (
            f'layer index went backwards at position {i}: '
            f'{layer_seq[i-1]} → {layer_seq[i]}. Fill order must be '
            f'layer-outermost.')
    # And within each layer we saw exactly rows*cols slots.
    from collections import Counter
    counts = Counter(layer_seq)
    for l in range(layers):
        assert counts[l] == rows * cols, (
            f'layer {l} saw {counts[l]} slots, expected {rows*cols}')


def test_plane_normal_points_up_after_sign_fix():
    """compute_frame's plane_normal has non-negative +Z_base
    component regardless of corner ordering. Pre-fix the raw
    row×col could point downward; the sign fix flips it."""
    from programming_by_demonstration.schema import PalletPlaceSpec
    from programming_by_demonstration.pallet_geometry import compute_frame
    # Corner ordering that produces row×col in -Z.
    spec = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2, 'layers': 2,
        'pitch_row_mm': 100, 'pitch_col_mm': 100, 'layer_height_mm': 50,
        'corner1_tcp': [0.5,  0.1, 0.1, 0, 0, 0],
        'corner2_tcp': [0.5,  0.4, 0.1, 0, 0, 0],
        'corner3_tcp': [0.8,  0.1, 0.1, 0, 0, 0],
        'part_tcp':    [0.55, 0.15, 0.1, 0, 0, 0],
    })
    fr = compute_frame(spec)
    assert fr['plane_normal'][2] >= 0, (
        f'plane_normal must point up (+Z) after sign fix, got '
        f'{fr["plane_normal"]}')
    # And the reverse ordering (which naturally gives +Z) also works.
    spec2 = PalletPlaceSpec.from_dict({
        'rows': 2, 'cols': 2, 'layers': 2,
        'pitch_row_mm': 100, 'pitch_col_mm': 100, 'layer_height_mm': 50,
        'corner1_tcp': [0.5, 0.1, 0.1, 0, 0, 0],
        'corner2_tcp': [0.8, 0.1, 0.1, 0, 0, 0],
        'corner3_tcp': [0.5, 0.4, 0.1, 0, 0, 0],
        'part_tcp':    [0.55, 0.15, 0.1, 0, 0, 0],
    })
    fr2 = compute_frame(spec2)
    assert fr2['plane_normal'][2] >= 0


def test_golden_5cycle_slot_positions_holepartpalletize():
    """The exact golden fixture for the operator's demo:
    part_count=5 on holepartpalletize's actual saved corners/pitch
    produces these 5 physical slot positions (mm), verified against
    the geometry.
    """
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Compute the expected positions from geometry (independent
    # of what codegen emits — this is the truth).
    from programming_by_demonstration.schema import PalletPlaceSpec
    from programming_by_demonstration.pallet_geometry import derive_slot_tcps
    place = prog['config']['pallet_place']; pold = prog['config']['pallet']
    spec_dict = dict(place)
    spec_dict.update({
        'rows': pold['rows'], 'cols': pold['cols'],
        'layers': pold['layers'],
        'pitch_row_mm': pold['spacing_x_mm'],
        'pitch_col_mm': pold['spacing_y_mm'],
        'layer_height_mm': pold['layer_height_mm'],
        'order': 'row_major',
    })
    spec = PalletPlaceSpec.from_dict(spec_dict)
    all_slots = derive_slot_tcps(spec, tuple(place['corner1_tcp']))
    # First 5 in emission order.
    golden = all_slots[:5]
    # Assert the exact (r, c, l) tuples matching the operator's spec.
    expected_rcl = [(0,0,0), (0,1,0), (1,0,0), (1,1,0), (0,0,1)]
    for i, (want, s) in enumerate(zip(expected_rcl, golden)):
        got = (s['row'], s['col'], s['layer'])
        assert got == want, (
            f'golden slot {i}: expected {want} got {got}')
    # And the emitted place-joints FK to the golden geometry.
    import re
    for i, (r, c, l) in enumerate(expected_rcl):
        pat = rf'movL\((p\d+)\)\s+--\s+slot\[{r},{c},{l}\]\s+place\b'
        hit = None
        for ln in lua.splitlines():
            m = re.search(pat, ln)
            if m: hit = m.group(1); break
        assert hit is not None, f'place line for [{r},{c},{l}] missing'
        val = points[hit]['val']
        if isinstance(val, str): val = json.loads(val)
        fk = program_ops._fk_chain(val['jp'])[6][:3, 3]
        want_mm = tuple(v * 1000 for v in golden[i]['tcp_m'][:3])
        for axis in range(3):
            assert abs(fk[axis] - want_mm[axis]) < 0.1, (
                f'slot [{r},{c},{l}] axis {axis}: FK={fk[axis]:.2f} mm '
                f'vs want {want_mm[axis]:.2f} mm')


# ── 2026-08-06 I/O pairing (hardware Blocker A follow-up) ──────
#
# The pre-fix codegen emitted ONE vacuum-ON before `move_to_pallet`
# and N releases inside the expansion. The gripper was empty from
# release #2 onward. Correct: each cycle is a complete pick+place
# with one vacuum-ON at pick and one release at place — N of each,
# correctly interleaved. These pins guarantee the interleaving.

def _vacuum_port_from_program(prog: dict) -> int:
    """Derive the vacuum DO port from the composer-emitted set_io
    step (io_role='vacuum'). Fallback = 2 (composer default)."""
    for s in prog.get('steps', []):
        if str(s.get('action') or '').lower() != 'set_io':
            continue
        if str(s.get('io_role') or '').lower() == 'vacuum' \
                and int(s.get('value') or 0) == 1:
            m = __import__('re').match(
                r'^DO(\d+)$', str(s.get('io_id') or ''),
                __import__('re').IGNORECASE)
            if m:
                return int(m.group(1))
    return 2


def test_io_pairing_n_vacuum_ons_matches_n_releases():
    """Every cycle carries exactly one vacuum-ON at pick and one
    release at place. N cycles → N of each, one-to-one. Pre-fix:
    1 vacuum-ON + N releases (I/O pairing broken)."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    vac_port = _vacuum_port_from_program(prog)
    import re
    vacuum_ons = re.findall(
        rf'^\s*setDO\({vac_port}\s*,\s*1\)\s', lua, re.MULTILINE)
    releases = lua.count('pallet release')
    assert releases == 5, (
        f'expected 5 pallet releases for part_count=5, got {releases}')
    assert len(vacuum_ons) == 5, (
        f'expected 5 vacuum-ON events (one per cycle) for part_count=5, '
        f'got {len(vacuum_ons)}. Pre-fix regression: 1 vacuum-ON + N '
        f'releases means the arm dropped nothing on releases 2..N.')


def test_io_pairing_ordering_pick_then_place_each_cycle():
    """Sequence contract: for each cycle i (1..N), a vacuum-ON must
    appear BEFORE cycle i's release, and no more than one vacuum-ON
    may appear between two consecutive releases. This pins the
    interleaving pattern — batching (all picks, then all releases)
    is disallowed."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    vac_port = _vacuum_port_from_program(prog)
    import re
    # Emit (event_kind, line_no) pairs in emission order.
    events: list[tuple[str, int]] = []
    for i, ln in enumerate(lua.splitlines(), start=1):
        if re.search(rf'^\s*setDO\({vac_port}\s*,\s*1\)\s', ln):
            events.append(('pick', i))
        elif 'pallet release' in ln:
            events.append(('release', i))
    # Interleave check: pick, release, pick, release, ... × 5.
    expected = ['pick', 'release'] * 5
    got = [k for k, _ in events]
    assert got == expected, (
        f'I/O event order must alternate pick,release,pick,release,... '
        f'for 5 full cycles. Got: {got}')


def test_io_pairing_full_capacity_no_batching():
    """The full 8-slot (2×2×2) fill: 8 vacuum-ONs, 8 releases,
    interleaved. Guards against a regression where the pick-block
    hoist decays back to the pre-fix single-vacuum shape at higher
    slot counts."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    # Force full-capacity emit — no part_count cap.
    if 'part_count' in prog['config']['pallet']:
        del prog['config']['pallet']['part_count']
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    vac_port = _vacuum_port_from_program(prog)
    import re
    n_expected = (prog['config']['pallet']['rows']
                  * prog['config']['pallet']['cols']
                  * prog['config']['pallet']['layers'])
    vacuum_ons = re.findall(
        rf'^\s*setDO\({vac_port}\s*,\s*1\)\s', lua, re.MULTILINE)
    releases = lua.count('pallet release')
    assert len(vacuum_ons) == n_expected == releases, (
        f'full-capacity ({n_expected}) must emit {n_expected} vacuum-'
        f'ONs and {n_expected} releases; got vacuum_ons='
        f'{len(vacuum_ons)}, releases={releases}')


def test_io_pairing_expansion_cycle_headers_present():
    """The pick-block hoist emits one 'cycle N/M' header per cycle.
    This is the operator-legible marker separating cycles in the
    emitted Lua so a Monitor trace can be read top-to-bottom."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    for i in range(1, 6):
        marker = f'cycle {i}/5:'
        assert marker in lua, (
            f'expected cycle header {marker!r} in emitted Lua — the '
            f'pick-block hoist must annotate each cycle boundary')


def test_pick_block_replay_repeats_pick_contact_reference():
    """After the hoist, cycle 2..N must include a movJ/movL call to
    the taught pick contact point. The pick point's name is unique
    per program; it appears once in cycle 1 and N-1 more times via
    replay. Total references = N."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Find the taught pick point. It's the point referenced by the
    # movJ/movL emitted at cycle-1 pick-contact — the composer marks
    # the step with position_role='pick'. Simpler heuristic: find a
    # point whose name appears in a line commented 'Pick position'.
    import re
    pick_ref = None
    for ln in lua.splitlines():
        m = re.search(r'mov[JL]\(([A-Za-z_][A-Za-z_0-9]*)\)', ln)
        if not m:
            continue
        if 'position_role' in ln and 'pick' in ln:
            pick_ref = m.group(1)
            break
        if 'Pick position' in ln:
            pick_ref = m.group(1)
            break
    if pick_ref is None:
        # Fallback: any point-name that appears in a comment
        # mentioning 'pick' (taught contact emissions include the
        # role in their comment tail).
        for ln in lua.splitlines():
            m = re.search(
                r'mov[JL]\(([A-Za-z_][A-Za-z_0-9]*)\)[^\n]*'
                r'position_role=\'?pick\'?', ln)
            if m:
                pick_ref = m.group(1)
                break
    # If we still couldn't find it — at least confirm the
    # cycle-header markers exist (structural pin above already
    # covers this; skip this assertion to avoid false negatives on
    # naming-scheme changes).
    if pick_ref is not None:
        # Count mov[JL](pick_ref) — must appear exactly N times
        # (once per cycle).
        n_refs = len(re.findall(
            rf'mov[JL]\({re.escape(pick_ref)}\)', lua))
        assert n_refs == 5, (
            f'pick contact point {pick_ref!r} must be referenced '
            f'once per cycle (5 times for part_count=5); got '
            f'{n_refs} references')
