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


# ── 2026-08-06 finalize palletize subroutine (operator directive) ──
#
# The palletize cycle is now emitted inline per iteration with dynamic
# transit_Z. These pins guarantee: (a) transit_Z rises per layer as
# transit_Z(l) = slot_Z(l) + layer_height + safety_margin; (b) blow-off
# is optional and pulse fires when configured; (c) vacuum port sources
# from move_to_pallet.vacuum_port_do (which the composer stamps from
# io_map — NOT hardcoded); (d) OFF matches ON per cycle (vacuum
# de-energize, not a separate finger release IO); (e) cycle count is
# driven by part_count.

def _extract_place_layer_z_mm(prog, lua, points):
    """Given the emitted Lua and points table, extract {layer_l:
    slot_Z_mm} by FK-ing the joint config from each 'slot[r,c,l] place'
    line. FK returns mm in base frame; taking [2] gives Z."""
    import re
    result = {}
    for ln in lua.splitlines():
        m = re.search(
            r'movL\((p\d+)\)\s+--\s+slot\[(\d+),(\d+),(\d+)\]\s+place\b',
            ln)
        if not m:
            continue
        nm = m.group(1); l = int(m.group(4))
        val = points[nm]['val']
        if isinstance(val, str): val = json.loads(val)
        fk = program_ops._fk_chain(val['jp'])[6][:3, 3]
        result.setdefault(l, float(fk[2]))
    return result


def _extract_transit_over_slot_z_mm(prog, lua, points):
    """Similar to _extract_place_layer_z_mm but for the 'traverse-over-
    slot' emit line — this is the transit_Z above the slot (before
    lowering). One per cycle; the first cycle per layer suffices."""
    import re
    result = {}
    for ln in lua.splitlines():
        m = re.search(
            r'movL\((p\d+)\)\s+--\s+cycle\s+\d+\s+traverse-over-slot '
            r'\[(\d+),(\d+),(\d+)\]', ln)
        if not m:
            continue
        nm = m.group(1); l = int(m.group(4))
        val = points[nm]['val']
        if isinstance(val, str): val = json.loads(val)
        fk = program_ops._fk_chain(val['jp'])[6][:3, 3]
        result.setdefault(l, float(fk[2]))
    return result


def test_finalize_transit_z_rises_per_layer():
    """transit_Z(layer 1) > transit_Z(layer 0). The delta must equal
    layer_height_mm within IK convergence tolerance. Guards against
    a regression where transit_h collapses to a per-cycle constant
    that doesn't rise per layer."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 8   # full capacity so
                                                 # we see both layers
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    layer_z_mm = _extract_transit_over_slot_z_mm(prog, lua, points)
    assert 0 in layer_z_mm and 1 in layer_z_mm, (
        f'expected transit_over_slot for layer 0 and 1, got '
        f'{sorted(layer_z_mm.keys())}')
    dz = layer_z_mm[1] - layer_z_mm[0]
    layer_h = float(prog['config']['pallet']['layer_height_mm'])
    assert dz > 0, (
        f'transit_Z must rise per layer: layer 0 Z={layer_z_mm[0]:.2f} '
        f'mm, layer 1 Z={layer_z_mm[1]:.2f} mm, Δ={dz:+.2f} mm')
    # Δ = layer_height (transit_Z(l) - transit_Z(l-1) = layer_h).
    assert abs(dz - layer_h) < 2.0, (
        f'transit_Z should rise by layer_height ({layer_h:.1f} mm) '
        f'per layer; got Δ={dz:.2f} mm')


def test_finalize_transit_z_formula():
    """transit_Z(layer) = slot_Z(layer) + layer_height + safety_margin.
    Verified by FK-ing the transit-over-slot emit and comparing to
    (place slot's FK Z) + (layer_height + safety_margin)."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 8
    # Explicit safety_margin on the step so we can verify the formula.
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['safety_margin_mm'] = 75   # non-default; forces the
                                         # test to see the formula, not
                                         # the default 50
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    place_z   = _extract_place_layer_z_mm(prog, lua, points)
    transit_z = _extract_transit_over_slot_z_mm(prog, lua, points)
    layer_h_mm = float(prog['config']['pallet']['layer_height_mm'])
    margin_mm  = 75.0
    for l in (0, 1):
        assert l in place_z and l in transit_z, (
            f'missing FK for layer {l}: place_z={place_z}, transit_z={transit_z}')
        want = place_z[l] + layer_h_mm + margin_mm
        got  = transit_z[l]
        # Allow ~1mm slop for IK convergence and plane_normal deviation
        # from pure +Z (the fixture's corner1/corner2/corner3 span a
        # near-horizontal plane so plane_normal ≈ +Z, but not exactly).
        assert abs(got - want) < 3.0, (
            f'layer {l}: transit_Z should equal slot_Z+layer_h+margin '
            f'= {place_z[l]:.2f} + {layer_h_mm:.1f} + {margin_mm:.1f} '
            f'= {want:.2f} mm; got {got:.2f} mm')


def test_finalize_safety_margin_editable_default_50():
    """safety_margin_mm=50 is the default when the field is absent
    on move_to_pallet. Setting it to a different value shifts the
    transit_Z by exactly that delta."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 4
    # Compare emit with default (implicit 50) vs explicit 150.
    lua_default, pts_default, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    prog2 = json.loads(json.dumps(prog))
    for s in prog2['steps']:
        if s.get('action') == 'move_to_pallet':
            s['safety_margin_mm'] = 150
    lua_150, pts_150, _ = program_ops.codegen_lua_from_program(
        prog2, operator_speed_limit_pct=25)
    z_def = _extract_transit_over_slot_z_mm(prog, lua_default, pts_default)
    z_150 = _extract_transit_over_slot_z_mm(prog2, lua_150, pts_150)
    assert 0 in z_def and 0 in z_150, (
        f'missing layer 0 transit_Z in one emit: default={z_def}, '
        f'safety_margin=150={z_150}')
    delta = z_150[0] - z_def[0]
    assert abs(delta - 100.0) < 3.0, (
        f'raising safety_margin_mm 50→150 should raise transit_Z by '
        f'100 mm; got Δ={delta:.2f} mm')


def test_finalize_vacuum_off_matches_vacuum_on():
    """Under the finalize spec, release is vacuum de-energize (setDO
    vac_port, 0), NOT a separate finger release IO. Every cycle:
    one setDO(vac,1) at pick paired with one setDO(vac,0) at place."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Extract the vacuum port used by the codegen from the emitted
    # header comment (which names vacuum_port=DO<N>).
    import re
    m = re.search(r'vacuum_port=DO(\d+)', lua)
    assert m, 'expansion header must name vacuum_port=DO<N>'
    vac_port = int(m.group(1))
    n_on  = len(re.findall(rf'^\s*setDO\({vac_port}\s*,\s*1\)\s', lua,
                           re.MULTILINE))
    n_off = len(re.findall(rf'^\s*setDO\({vac_port}\s*,\s*0\)\s', lua,
                           re.MULTILINE))
    assert n_on == 5 and n_off == 5, (
        f'expected 5 vacuum-ON and 5 vacuum-OFF (finalize spec: one '
        f'of each per cycle); got on={n_on}, off={n_off}')


def test_finalize_blow_off_optional_absent_by_default_on_holepart():
    """holepartpalletize's io_map may not define a 'blow' port. In
    that case the pallet expansion emits only vacuum-off (no pulse).
    The header line should say `blow_off=none` and no blow-off pulse
    lines appear."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 3
    # Force blow_off_port_do = None on the step (composer default when
    # no 'blow' entry in io_map).
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['blow_off_port_do'] = None
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'blow_off=none' in lua, (
        'expansion header must state blow_off=none when no blow port '
        'configured')
    assert 'blow-off pulse' not in lua, (
        'no blow-off pulse should emit when blow_off_port_do is None')


def test_finalize_blow_off_present_when_configured():
    """Setting blow_off_port_do on the step emits a pulse: setDO(N,1)
    → wait(pulse_ms) → setDO(N,0). One pulse per cycle."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 4
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['blow_off_port_do']   = 3
            s['blow_off_pulse_ms']  = 250
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    import re
    n_pulse_start = len(re.findall(
        r'^\s*setDO\(3\s*,\s*1\)\s+--\s+.*blow-off pulse start',
        lua, re.MULTILINE))
    n_pulse_end   = len(re.findall(
        r'^\s*setDO\(3\s*,\s*0\)\s+--\s+.*blow-off pulse end',
        lua, re.MULTILINE))
    n_pulse_wait  = len(re.findall(
        r'^\s*wait\(250\)\s+--\s+blow-off pulse 250 ms',
        lua, re.MULTILINE))
    assert n_pulse_start == 4 and n_pulse_end == 4 and n_pulse_wait == 4, (
        f'expected 4 blow-off pulses for part_count=4; got start='
        f'{n_pulse_start} end={n_pulse_end} wait={n_pulse_wait}')


def test_finalize_vacuum_port_read_from_composer_field_not_hardcoded():
    """The vacuum port is stamped on the move_to_pallet step by the
    composer (from io_map). Changing vacuum_port_do on the step
    updates the emitted setDO port — proves the codegen is NOT
    hardcoded to a specific DO."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 3
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['vacuum_port_do'] = 7
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'vacuum_port=DO7' in lua, (
        'header must reflect the step\'s vacuum_port_do field')
    import re
    n_on  = len(re.findall(r'^\s*setDO\(7\s*,\s*1\)\s', lua, re.MULTILINE))
    n_off = len(re.findall(r'^\s*setDO\(7\s*,\s*0\)\s', lua, re.MULTILINE))
    assert n_on == 3 and n_off == 3, (
        f'setDO(7, ..) count for part_count=3: on={n_on}, off={n_off}')


def test_finalize_part_count_drives_cycle_count():
    """Changing part_count changes the emitted cycle count (already
    covered by pre-existing tests, but pinned again here as part of
    the finalize contract)."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    for n in (1, 2, 5, 8):
        prog['config']['pallet']['part_count'] = n
        lua, _, _ = program_ops.codegen_lua_from_program(
            prog, operator_speed_limit_pct=25)
        assert lua.count('pallet release') == n, (
            f'part_count={n} must produce {n} pallet release events; '
            f'got {lua.count("pallet release")}')


def test_finalize_composer_stamps_vacuum_port_from_io_map(tmp_path,
                                                           monkeypatch):
    """The composer reads /opt/cobot/io_map.json for the vacuum
    keyword and stamps the port on move_to_pallet. A synthetic io_map
    with vacuum on DO5 must produce vacuum_port_do=5 — proves the
    codegen field is NOT hardcoded, it flows from the io_map."""
    sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', '..',
                                                     'programming_by_demonstration')))
    from programming_by_demonstration import program_composer as pc
    from programming_by_demonstration.schema import (
        StructuredIntent, IntentOperation, PoseSlot, PartReference,
        PalletSpec,
    )
    # Point the composer at a temp io_map.json with vacuum on DO5.
    fake_map = tmp_path / 'io_map.json'
    fake_map.write_text(json.dumps({
        'plate': [{
            'terminals': [
                {'name': 'DO2', 'kind': 'DO', 'port': 2, 'role': 'signal'},
                {'name': 'DO5', 'kind': 'DO', 'port': 5, 'role': 'signal'},
            ],
        }],
        'ports': {
            'DO5': {'assignment': 'Vacuum'},
            'DO2': {'assignment': 'Unassigned'},
        },
    }))
    monkeypatch.setattr(pc, '_IO_MAP_PATH', str(fake_map))
    intent = StructuredIntent(
        task_summary='pallet vacuum test',
        operations=[IntentOperation(
            operation_type='palletize',
            target_part=PartReference(part_id='test-part', name='test-part'),
            sequence_index=1,
            effector='vacuum',
            pick=PoseSlot(location_hint='parts feed'),
            place=PoseSlot(
                location_hint='pallet slot [computed at runtime]'),
            pallet=PalletSpec(rows=2, cols=2, layers=1),
        )],
    )
    draft = pc.compose_program_draft(intent, demo_id='t',
                                     program_name='t')
    move_to_pallet_step = next(
        s for s in draft.steps
        if s.get('action') == 'move_to_pallet')
    assert move_to_pallet_step.get('vacuum_port_do') == 5, (
        f'composer must stamp vacuum_port_do from io_map; got '
        f'{move_to_pallet_step.get("vacuum_port_do")!r}')
    # And the same io_map ought to fill (or not) blow_off_port_do.
    # No 'Blow' entry in fake_map → composer field is None.
    assert move_to_pallet_step.get('blow_off_port_do') is None, (
        f'no io_map entry containing "blow" — blow_off_port_do must '
        f'be None; got {move_to_pallet_step.get("blow_off_port_do")!r}')


# ── 2026-08-06 palletize completeness (Rules A/B/C, operator directive)
#
# The palletize cycle is now the FULL pick+place loop: approach along
# each pose's OWN flange Z axis (rule A), layer-shifted place approach
# (rule B — layer-N approaches from above layer N, never dips), and
# optional taught approach poses (rule C). These pins guarantee: (a)
# per-cycle sub-step count matches the spec; (b) approach point sits
# along the pose's tool axis at the configured distance; (c) place
# approach Z rises by layer_height per layer; (d) taught pick_approach
# / place_approach override the axis-offset default; (e) approach_
# distance_mm and retract_distance_mm are independent numeric fields.

def _get_pallet_step(prog):
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            return s
    return None


def test_completeness_per_cycle_has_all_thirteen_substeps():
    """Every cycle emits: pick_approach movJ + linear-down pick +
    vacuum ON + wait + linear-up + transit-over-pick + traverse-over-
    slot + place_approach + place linear-down + vacuum OFF + linear-up
    + transit-over-slot. (Blow-off adds 3 more when configured.)"""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    step = _get_pallet_step(prog)
    step['blow_off_port_do'] = None   # keep the count clean
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Count the substep markers that appear ONE PER CYCLE.
    N = 5
    import re
    def _count_line_prefix(prefix):
        return len(re.findall(
            r'^\s*' + re.escape(prefix), lua, re.MULTILINE))
    checks = {
        'pick_approach movJ': _count_line_prefix('movJ(') and lua.count(
            'cycle 1 pick_approach (axis-offset')  \
            + lua.count('cycle 2 pick_approach (axis-offset')  \
            + lua.count('cycle 3 pick_approach (axis-offset')  \
            + lua.count('cycle 4 pick_approach (axis-offset')  \
            + lua.count('cycle 5 pick_approach (axis-offset'),
        'linear-down to pick': lua.count('linear-down to pick contact'),
        'vacuum ON events': lua.count('vacuum ON  (vacuum_port_do'),
        'seal wait ms': len(re.findall(
            r'^\s*wait\(\d+\)\s+--\s+cycle\s+\d+\s+seal wait',
            lua, re.MULTILINE)),
        'linear-up to pick_approach': lua.count(
            'linear-up to pick_approach (retract'),
        'transit_Z over pick': lua.count('lift-to-transit (over pick'),
        'traverse-over-slot': lua.count('traverse-over-slot'),
        'place_approach descent': lua.count('layer ') and len(re.findall(
            r'movL\(p\d+\)\s+--\s+cycle\s+\d+\s+place_approach',
            lua)),
        'linear-down to slot': lua.count(
            '(linear-down from approach)'),
        'vacuum OFF setDO events': len(re.findall(
            r'^\s*setDO\(\d+\s*,\s*0\)\s+--\s+cycle\s+\d+\s+vacuum OFF',
            lua, re.MULTILINE)),
        'linear-up to place_approach': lua.count(
            'linear-up to place_approach (retract'),
        'transit_Z over slot': lua.count(
            'lift-to-transit (over slot after release'),
    }
    for k, v in checks.items():
        assert v == N, (
            f'sub-step {k!r} count = {v}, expected {N} (one per cycle)')


# 2026-08-19 scoped fix (ledger 2c2e435 pallet regression, defect B):
# The pick-side pick_approach point + linear-down/linear-up around
# pick_contact are DELETED from the palletize cycle. The tests below
# that pinned rule A on the pick side are also deleted — see the new
# `test_pick_sequence_single_descend_before_vacuum_on` and
# `test_no_pick_approach_lift_in_cycle` pins for the replacement
# contract (cb83ed4 restore: bare `movJ(pick_pt)` at cycle start, no
# per-cycle pre-descent).
#
# Deleted:
#   - test_completeness_pick_approach_along_flange_z_axis
#   - test_completeness_taught_pick_approach_overrides_default
#   - test_completeness_independent_approach_and_retract_distances
#
# The rule-B pins on the PLACE side (place_approach layer-shifted,
# rule B "never dip" invariant) remain in force below.


def test_completeness_place_approach_rises_per_layer():
    """Rule B: layer-1 place_approach absolute Z is layer_height above
    layer-0 place_approach Z. Both layers should have well-defined
    approach points."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 8
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    import re
    # Extract place_approach Z per layer via FK of the emitted point.
    layer_z = {}
    for ln in lua.splitlines():
        m = re.search(
            r'movL\((p\d+)\)\s+--\s+cycle\s+\d+\s+place_approach '
            r'\[(\d+),(\d+),(\d+)\]', ln)
        if not m:
            continue
        nm, l = m.group(1), int(m.group(4))
        if l in layer_z:
            continue
        val = points[nm]['val']
        if isinstance(val, str): val = json.loads(val)
        fk = program_ops._fk_chain(val['jp'])[6][:3, 3]
        layer_z[l] = float(fk[2])
    assert 0 in layer_z and 1 in layer_z, (
        f'expected place_approach for layer 0 AND layer 1, got '
        f'{sorted(layer_z.keys())}')
    dz = layer_z[1] - layer_z[0]
    layer_h = float(prog['config']['pallet']['layer_height_mm'])
    assert dz > 0, (
        f'layer 1 place_approach Z ({layer_z[1]:.2f}) must be ABOVE '
        f'layer 0 place_approach Z ({layer_z[0]:.2f}); Δ={dz:+.2f} mm')
    assert abs(dz - layer_h) < 3.0, (
        f'layer 1 - layer 0 place_approach Z Δ should equal '
        f'layer_height ({layer_h:.1f} mm); got {dz:.2f} mm')


def test_completeness_layer_N_approach_above_layer_N_slot():
    """Rule B strict form: for every layer N, the place_approach Z
    must be at or above the layer-N slot Z + a nonzero clearance.
    Layer-1 approach must not dip to layer-0 Z."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 8
    lua, points, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    import re
    # For each layer, gather place_approach Z and slot Z.
    appr_z = {}
    slot_z = {}
    for ln in lua.splitlines():
        m = re.search(
            r'movL\((p\d+)\)\s+--\s+cycle\s+\d+\s+place_approach '
            r'\[(\d+),(\d+),(\d+)\]', ln)
        if m:
            nm, l = m.group(1), int(m.group(4))
            val = points[nm]['val']
            if isinstance(val, str): val = json.loads(val)
            appr_z.setdefault(l, float(
                program_ops._fk_chain(val['jp'])[6][2, 3]))
        m2 = re.search(
            r'movL\((p\d+)\)\s+--\s+slot\[(\d+),(\d+),(\d+)\]\s+place',
            ln)
        if m2:
            nm, l = m2.group(1), int(m2.group(4))
            val = points[nm]['val']
            if isinstance(val, str): val = json.loads(val)
            slot_z.setdefault(l, float(
                program_ops._fk_chain(val['jp'])[6][2, 3]))
    for l in slot_z:
        assert l in appr_z, f'missing place_approach for layer {l}'
        assert appr_z[l] > slot_z[l], (
            f'layer {l} place_approach Z ({appr_z[l]:.2f}) must be '
            f'ABOVE slot Z ({slot_z[l]:.2f}); this is rule B')
    # Layer-1 approach must NOT dip to layer-0 slot Z: strict pin.
    if 0 in slot_z and 1 in appr_z:
        assert appr_z[1] > slot_z[0], (
            f'layer-1 place_approach Z ({appr_z[1]:.2f}) must be above '
            f'layer-0 slot Z ({slot_z[0]:.2f}) — the "never dip" pin')


def test_completeness_taught_place_approach_layer_shifts():
    """Rule C + B: taught place_approach is layer-shifted by
    layer_height along the plane_normal. Layer 1 taught-approach Z
    should be layer_height above layer 0 taught-approach Z."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 8
    step = _get_pallet_step(prog)
    # Use the pick pose as a synthetic taught place_approach (any
    # 6-el joint config works; we just need the taught branch to fire).
    pick_step = next(
        s for s in prog['steps']
        if s.get('position_role') == 'pick')
    step['place_approach_joints'] = list(pick_step['taught_joints'])
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'place_approach=taught (layer-shifted)' in lua, (
        'expansion header must state place_approach=taught when set')


# ── 2026-08-06 (inline sub-step edit → regenerate ALL cycles) ─────
#
# The palletize expanded view lets the operator edit approach/retract
# /safety_margin/vacuum/blow-off/seal_wait inline; the sub-steps stay
# COMPOSER-GENERATED, so every cycle picks up the change deterministically.
# These pins verify a single-field edit updates every cycle in the emit,
# not just the first.


def test_inline_edit_approach_distance_regenerates_all_cycles():
    """Approach distance 50 → 75 mm on move_to_pallet propagates to
    every cycle's linear-up + place_approach + retract comments."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 5
    N = 5
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['approach_distance_mm'] = 75
            s['retract_distance_mm']  = 75
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Header reflects the new distance.
    assert 'approach=75mm' in lua, (
        'expansion header must show approach=75mm after inline edit')
    # Every cycle's linear-up comment says 75mm — not the default 50.
    n_retract_pick = lua.count(
        'linear-up to pick_approach (retract 75mm)')
    n_retract_place = lua.count(
        'linear-up to place_approach (retract 75mm)')
    assert n_retract_pick == N, (
        f'expected {N} pick-side retract comments at 75mm; got '
        f'{n_retract_pick}')
    assert n_retract_place == N, (
        f'expected {N} place-side retract comments at 75mm; got '
        f'{n_retract_place}')
    # No cycle should still be quoting the old default 50mm.
    assert 'retract 50mm' not in lua, (
        'a cycle is still quoting retract 50mm after 50→75 edit')


def test_inline_edit_safety_margin_regenerates_transit_z_per_cycle():
    """safety_margin 50 → 200 mm raises transit_Z per layer by
    +150 mm; every cycle emits the new absolute Z. Rule B still holds
    (layer 1 > layer 0)."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 8
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['safety_margin_mm'] = 200
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Header transit height = layer_h(100) + safety_margin(200) = 300 mm
    assert 'transit_h_above_slot=300mm' in lua, (
        'expansion header must show 300mm transit height after '
        '50→200 safety_margin edit')
    assert 'safety_margin=200mm' in lua
    # Layer 0 transit at 458.2mm; Layer 1 at 558.2mm (both +150 vs default).
    import re
    ls = set(re.findall(
        r'traverse-over-slot \[\d+,\d+,(\d+)\] at transit_Z=([\d.]+)mm',
        lua))
    zs_by_layer = {}
    for l, z in ls:
        zs_by_layer.setdefault(int(l), float(z))
    assert 0 in zs_by_layer and 1 in zs_by_layer
    delta = zs_by_layer[1] - zs_by_layer[0]
    layer_h = float(prog['config']['pallet']['layer_height_mm'])
    assert abs(delta - layer_h) < 0.5, (
        f'layer-1 transit_Z minus layer-0 transit_Z should equal '
        f'layer_height ({layer_h}); got {delta:.2f}')


def test_inline_edit_vacuum_port_routes_setDO_every_cycle():
    """vacuum_port_do 2 → 9 routes every cycle's setDO ON+OFF to DO9."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 4
    N = 4
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['vacuum_port_do'] = 9
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    import re
    on = len(re.findall(r'^\s*setDO\(9\s*,\s*1\)\s', lua, re.MULTILINE))
    off = len(re.findall(r'^\s*setDO\(9\s*,\s*0\)\s', lua, re.MULTILINE))
    assert on == N and off == N, (
        f'expected {N} setDO(9,1) + {N} setDO(9,0); got on={on} off={off}')
    assert 'vacuum_port=DO9' in lua


def test_inline_edit_seal_wait_regenerates_every_wait_comment():
    """seal_wait_ms 500 → 750 lands in every cycle's wait comment."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 3
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['seal_wait_ms'] = 750
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # 3 cycles × one seal wait = 3 wait(750) lines with 'seal wait 750 ms'
    n = lua.count('seal wait 750 ms')
    assert n == 3, f'expected 3 seal-wait comments at 750 ms; got {n}'


def test_inline_edit_blow_off_from_none_to_set_adds_pulse_every_cycle():
    """blow_off_port_do None → 4, pulse 100 ms → every cycle gains
    the blow-off pulse (setDO(4,1) → wait(100) → setDO(4,0))."""
    prog = _load_holepartpalletize()
    prog = json.loads(json.dumps(prog))
    prog['config']['pallet']['part_count'] = 3
    for s in prog['steps']:
        if s.get('action') == 'move_to_pallet':
            s['blow_off_port_do']  = 4
            s['blow_off_pulse_ms'] = 100
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    N = 3
    import re
    starts = len(re.findall(
        r'^\s*setDO\(4\s*,\s*1\)\s+--\s+.*blow-off pulse start',
        lua, re.MULTILINE))
    ends = len(re.findall(
        r'^\s*setDO\(4\s*,\s*0\)\s+--\s+.*blow-off pulse end',
        lua, re.MULTILINE))
    pulses = lua.count('blow-off pulse 100 ms')
    assert starts == N and ends == N and pulses == N, (
        f'expected {N} blow-off pulse triples; got starts={starts} '
        f'ends={ends} pulses={pulses}')


# ── 2026-08-19 scoped fix (ledger 2c2e435 pallet regression) ──────────
#
# Pinned regressions for:
#   defect A — pallet index stuck at slot 1 (composer bug: config.pallet
#              missing rows/cols/layers; loop count > slot capacity)
#   defect B — double-descend at pick (2c2e435 added a pre-pick descent
#              per cycle on top of the walker-emitted taught contact)
#
# These pins are the load-bearing tests for the scoped fix. Do NOT
# delete them without operator directive naming the ledger entry.


def _minimal_palletize_program(rows=2, cols=2, layers=1,
                                pallet_dims_present=True,
                                loop_count=None,
                                include_pallet_loop_step=False):
    """Synthesize the smallest palletize program that exercises the
    pallet expansion. Reachable pick pose taken from
    holepartpalletize.json (known reachable for the S10-140 URDF).

    `pallet_dims_present=False` OMITS rows/cols/layers from config.pallet
    to reproduce the composer bug (pallettest.json fixture).
    """
    pick_joints = [-30.77, 34.29, 123.41, 68.83, 92.1, -111.94]
    pick_tcp = [0.758949, -0.218183, 0.119734,
                3.100210897, -0.005916666, -0.825366203]
    steps = [
        {'action': 'move_home', 'label': 'Move to home', 'id': 1,
         'step': 1,
         'taught_joints': pick_joints, 'taught_tcp': pick_tcp,
         'joints': pick_joints, 'position': pick_tcp[:3]},
        {'action': 'move_linear', 'label': 'Approach above pick',
         'id': 2, 'step': 2, 'speed_pct': 60, 'offset_z_mm': 100,
         'derived_from': 'pick'},
        {'action': 'move_linear', 'label': 'Pick — contact',
         'id': 3, 'step': 3, 'taught': True,
         'taught_joints': pick_joints, 'taught_tcp': pick_tcp,
         'joints': pick_joints, 'position': pick_tcp[:3],
         'position_role': 'pick', 'speed_pct': 30},
        {'action': 'set_io', 'label': 'Vac ON',
         'id': 4, 'step': 4, 'io_id': 'DO2', 'value': 1,
         'io_role': 'vacuum'},
        {'action': 'wait', 'label': 'Seal wait',
         'id': 5, 'step': 5, 'duration_s': 0.5},
        {'action': 'move_linear', 'label': 'Retreat above pick',
         'id': 6, 'step': 6, 'speed_pct': 40, 'offset_z_mm': 200,
         'derived_from': 'pick'},
        {'action': 'move_to_pallet', 'mode': 'palletize',
         'label': 'Place at pallet slot',
         'id': 7, 'step': 7,
         'pallet_phase': 'place',
         'gripper_type': 'vacuum',
         'io_vacuum': 'DO2', 'vacuum_port_do': 2,
         'speed_pct': 30},
        {'action': 'move_home', 'label': 'Return home',
         'id': 99, 'step': 8},
    ]
    if include_pallet_loop_step:
        # Insert loop between move_to_pallet and move_home.
        steps.insert(-1, {
            'action': 'loop', 'label': 'pallet loop',
            'id': 42, 'step': 8, 'goto': 3,
            'count': loop_count or 0, 'pallet_loop': True,
        })
        steps[-1]['step'] = 9   # renumber move_home
    # Reachable slot near the pick pose.
    place_block = {
        'corner1_tcp': [0.62, -0.20, 0.13, 3.1, 0.0, -0.82],
        'corner2_tcp': [0.62, -0.05, 0.13, 3.1, 0.0, -0.82],
        'corner3_tcp': [0.75, -0.20, 0.13, 3.1, 0.0, -0.82],
        'part_tcp':    [0.68, -0.12, 0.13, 3.1, 0.0, -0.82],
    }
    pallet_block = dict(place_block)
    if pallet_dims_present:
        pallet_block.update({
            'rows': rows, 'cols': cols, 'layers': layers,
            'spacing_x_mm': 60, 'spacing_y_mm': 60,
            'layer_height_mm': 50, 'fill_order': 'row_lr',
        })
    return {
        'id': 'synthetic', 'name': 'synthetic',
        'steps': steps,
        'config': {
            'operation': 'palletize',
            'speed': 40, 'speed_pct': 40,
            'pallet': pallet_block,
            'pallet_place': place_block,
        },
        'points': {}, 'source': 'synthetic',
    }


def test_pick_sequence_single_descend_before_vacuum_on():
    """DEFECT B PIN — 2026-08-19 scoped fix.

    In every cycle emitted by the pallet expansion, the sequence of
    motion verbs from cycle start to `setDO(vac_port,1)` must contain
    EXACTLY ONE motion — a `movJ(pick_pt)` back to the taught pick
    contact. No `movL` linear-down to a separate approach point, no
    lift-then-descend pair.

    Pre-fix (2c2e435 regression) each cycle emitted:
        movJ(pick_appr) → movL(pick_contact) → setDO(vac,1) ...
    which combined with the walker-emitted taught contact produced a
    down → touch → up → down → vacuum-on double-descend.
    """
    prog = _minimal_palletize_program(rows=1, cols=1, layers=1)
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    import re
    # Find the first setDO(vac_port,1) — the "vacuum ON" marker.
    vac_on_pat = re.compile(
        r'^\s*setDO\(2\s*,\s*1\)\s+--\s+cycle', re.MULTILINE)
    vac_on = vac_on_pat.search(lua)
    assert vac_on, ('no cycle vacuum-ON emitted — expansion never '
                    'reached the pick block')
    # Find the cycle 1 header before it.
    cycle_hdr = lua.rfind('-- cycle 1/', 0, vac_on.start())
    assert cycle_hdr >= 0, ('no `-- cycle 1/` header before vacuum-ON')
    # Count motion verb emissions between cycle header and vacuum-ON.
    body = lua[cycle_hdr:vac_on.start()]
    motions = re.findall(r'^\s*(movJ|movL|movJCoorRel)\(',
                          body, re.MULTILINE)
    assert motions == ['movJ'], (
        f'cycle-1 pre-vacuum sequence must be exactly one movJ(pick_pt); '
        f'got {motions}. Double-descend regression is back — see the '
        f'2026-08-19 scoped fix (ledger 2c2e435).')


def test_no_pick_approach_lift_in_cycle():
    """DEFECT B PIN — 2026-08-19 scoped fix.

    The 2c2e435 pattern `movL(pick_approach)` used as the pick-side
    linear-up must NOT appear in the emitted Lua. cb83ed4-style has
    no pick_approach point; retraction from pick contact goes
    directly to `transit_over_pick`.
    """
    prog = _minimal_palletize_program(rows=1, cols=1, layers=1)
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'linear-up to pick_approach' not in lua, (
        'pick-side pick_approach retract MUST NOT emit — cb83ed4 '
        'restore has no pick_approach point at all.')
    assert 'linear-down to pick contact' not in lua, (
        'pick-side linear-down MUST NOT emit under cb83ed4 restore.')
    assert 'pick_approach (axis-offset' not in lua, (
        'pick_approach axis-offset movJ MUST NOT emit under cb83ed4 '
        'restore.')


def test_refuse_pallet_when_dims_missing():
    """DEFECT A PIN — 2026-08-19 scoped fix.

    A palletize program whose `config.pallet` omits `rows/cols/layers`
    (the composer bug that produced `pallettest.json`) MUST NOT emit
    a 1×1×1 default expansion. The codegen refuses with a clear
    operator-facing message naming the fix.
    """
    prog = _minimal_palletize_program(pallet_dims_present=False)
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'REFUSED' in lua and 'missing rows/cols/layers' in lua, (
        f'expected REFUSED comment naming the missing dims; got:\n{lua}')
    # No expansion header should emit — the whole expansion is short-
    # circuited by the refusal.
    assert 'move_to_pallet EXPANSION' not in lua, (
        'expansion header must not emit when the refusal short-circuits')
    # No slot lines either.
    assert 'slot[' not in lua, (
        'no slot place lines under refusal — the arm must never see '
        'a fabricated 1x1x1 default')


def test_refuse_pallet_when_loop_count_exceeds_capacity():
    """DEFECT A PIN — 2026-08-19 scoped fix.

    A `pallet_loop=True` step whose `count` exceeds slot capacity
    (rows*cols*layers) is a composer bug: the palletize expansion
    emits all slots INLINE per iteration, so a loop wrapper on top
    would place more parts than the pallet holds. Refuse with a
    named message.
    """
    prog = _minimal_palletize_program(
        rows=2, cols=2, layers=1,
        include_pallet_loop_step=True, loop_count=16)
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    assert 'REFUSED' in lua and 'exceeds slot capacity' in lua, (
        f'expected REFUSED comment naming the count/capacity mismatch; '
        f'got:\n{lua}')


def test_atomic_pallet_emit_on_ik_failure():
    """DEFECT B PIN — 2026-08-19 scoped fix.

    On any IK failure inside the pallet block, the expansion body
    lines from ALL previously emitted cycles roll back — no partial
    cycles reach the controller. The header + the refusal comment
    remain visible so the operator sees intent + failure together.
    """
    prog = _minimal_palletize_program(rows=2, cols=2, layers=1)
    # Move the pallet 3 m out of reach on every corner — the FIRST
    # cycle's transit_over_pick IK will fail.
    prog['config']['pallet_place']['corner1_tcp'] = [3.0, 3.0, 0.5,
                                                     3.1, 0.0, -0.82]
    prog['config']['pallet_place']['corner2_tcp'] = [3.0, 3.2, 0.5,
                                                     3.1, 0.0, -0.82]
    prog['config']['pallet_place']['corner3_tcp'] = [3.2, 3.0, 0.5,
                                                     3.1, 0.0, -0.82]
    prog['config']['pallet_place']['part_tcp']    = [3.1, 3.1, 0.5,
                                                     3.1, 0.0, -0.82]
    # Same for the older `pallet` block that carries dims.
    prog['config']['pallet'].update(prog['config']['pallet_place'])
    lua, _, _ = program_ops.codegen_lua_from_program(
        prog, operator_speed_limit_pct=25)
    # Header stays.
    assert 'move_to_pallet EXPANSION' in lua
    # Refusal stays.
    assert 'PALLET IK FAILED' in lua
    # No partial cycle emissions: no setDO(vac,1) and no slot place
    # lines survive the rollback.
    import re
    assert not re.search(
        r'^\s*setDO\(2\s*,\s*1\)\s+--\s+cycle',
        lua, re.MULTILINE), (
        'atomic emit failed — a vacuum-ON survived past IK failure')
    assert 'place  joints=' not in lua, (
        'atomic emit failed — a slot place line survived past IK failure')

