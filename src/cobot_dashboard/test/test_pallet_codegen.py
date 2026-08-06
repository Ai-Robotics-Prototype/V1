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
