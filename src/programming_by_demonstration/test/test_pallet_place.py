"""Pinned tests for the pallet_place pattern (2026-08-06 §5).

Two layers:
  A. pallet_geometry: pure math (compute_slot_offsets, derive_slot_tcps,
     order sequences, axis-sign variants, layer math). Deterministic —
     one arithmetic assertion per case.
  B. composer integration: pallet_place emits ONE taught anchor + N-1
     derived slots inside a single pick_and_place op; the composer's
     dedupe pass keeps the "teach one position for the whole pallet"
     invariant.

Reachability-refusal test lives in this file too — mocks the driver's
seeded IK to force a failure and asserts the codegen path names the
offending slot.
"""
from __future__ import annotations

from programming_by_demonstration.schema import (
    IntentOperation,
    PLACE_PATTERN_PALLET,
    PalletPlaceSpec,
    PartReference,
    PoseSlot,
    StructuredIntent,
)
from programming_by_demonstration.fusion import fuse_positions
from programming_by_demonstration.pallet_geometry import (
    compute_slot_offsets,
    derive_slot_tcps,
    reachability_sweep,
    slot_label,
)
from programming_by_demonstration.program_composer import compose_program_draft


# ── §A — geometry ────────────────────────────────────────────────

def test_1x1_grid_is_single_zero_offset_slot():
    """Baseline sanity — a 1×1×1 pallet has one slot at (0,0,0)."""
    spec = PalletPlaceSpec(rows=1, cols=1, pitch_row_mm=50, pitch_col_mm=50)
    offsets = compute_slot_offsets(spec)
    assert len(offsets) == 1
    assert offsets[0] == ((0, 0, 0), (0.0, 0.0, 0.0))


def test_2x2_grid_default_axes_exact_arithmetic():
    """2×2 grid with pitch_row=100 pitch_col=50, axes +X row / +Y col.
    Expected slots in snake order (default):
      (0,0) → dx=0    dy=0
      (0,1) → dx=0    dy=50
      (1,1) → dx=100  dy=50   (row 1 snake: reversed cols → c=1 first)
      (1,0) → dx=100  dy=0
    """
    spec = PalletPlaceSpec(rows=2, cols=2, pitch_row_mm=100, pitch_col_mm=50)
    offsets = compute_slot_offsets(spec)
    assert offsets == [
        ((0, 0, 0), (0.0,   0.0, 0.0)),
        ((0, 1, 0), (0.0,  50.0, 0.0)),
        ((1, 1, 0), (100.0, 50.0, 0.0)),
        ((1, 0, 0), (100.0, 0.0, 0.0)),
    ]


def test_row_major_produces_raster_sequence():
    spec = PalletPlaceSpec(rows=2, cols=3,
                           pitch_row_mm=100, pitch_col_mm=50,
                           order='row_major')
    seq = [(r, c) for ((r, c, _l), _off) in compute_slot_offsets(spec)]
    assert seq == [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2)]


def test_col_major_produces_column_sequence():
    spec = PalletPlaceSpec(rows=2, cols=3,
                           pitch_row_mm=100, pitch_col_mm=50,
                           order='col_major')
    seq = [(r, c) for ((r, c, _l), _off) in compute_slot_offsets(spec)]
    assert seq == [(0, 0), (1, 0), (0, 1), (1, 1), (0, 2), (1, 2)]


def test_snake_reverses_every_odd_row():
    spec = PalletPlaceSpec(rows=3, cols=3,
                           pitch_row_mm=100, pitch_col_mm=50,
                           order='snake')
    seq = [(r, c) for ((r, c, _l), _off) in compute_slot_offsets(spec)]
    assert seq == [(0, 0), (0, 1), (0, 2),
                   (1, 2), (1, 1), (1, 0),
                   (2, 0), (2, 1), (2, 2)]


def test_axis_sign_negative_x_grows_backward():
    """row_axis='-X' → dx term is NEGATIVE per row-index."""
    spec = PalletPlaceSpec(rows=2, cols=1,
                           pitch_row_mm=100, pitch_col_mm=50,
                           row_axis='-X', col_axis='+Y',
                           order='row_major')
    offs = [(dx, dy, dz) for ((_r, _c, _l), (dx, dy, dz)) in compute_slot_offsets(spec)]
    assert offs == [(0.0, 0.0, 0.0), (-100.0, 0.0, 0.0)]


def test_axis_sign_swap_x_and_y():
    """row_axis='+Y' + col_axis='+X' → dx/dy roles swap."""
    spec = PalletPlaceSpec(rows=2, cols=3,
                           pitch_row_mm=10, pitch_col_mm=20,
                           row_axis='+Y', col_axis='+X',
                           order='row_major')
    offs = compute_slot_offsets(spec)
    # (r=0, c=0) → 0 / 0.  (r=0, c=1) → dy=0 dx=20 (col_axis=+X).
    # (r=0, c=2) → 40 / 0.  (r=1, c=0) → dx=0 dy=10 (row_axis=+Y).
    assert offs[0] == ((0, 0, 0), (0.0, 0.0, 0.0))
    assert offs[1] == ((0, 1, 0), (20.0, 0.0, 0.0))
    assert offs[2] == ((0, 2, 0), (40.0, 0.0, 0.0))
    assert offs[3] == ((1, 0, 0), (0.0, 10.0, 0.0))


def test_layer_math_2_rows_2_cols_2_layers():
    spec = PalletPlaceSpec(rows=2, cols=2,
                           pitch_row_mm=100, pitch_col_mm=50,
                           layers=2, layer_height_mm=30,
                           order='row_major')
    offs = compute_slot_offsets(spec)
    # 8 slots. Layer 0: dz=0 for all 4. Layer 1: dz=30 for all 4.
    layer_dz = [dz for ((_r, _c, _l), (_dx, _dy, dz)) in offs]
    assert layer_dz == [0, 0, 0, 0, 30, 30, 30, 30]
    # Slot index within each layer preserves the 2D order.
    slot_2d = [(r, c) for ((r, c, _l), _off) in offs]
    assert slot_2d == [(0, 0), (0, 1), (1, 0), (1, 1)] * 2


def test_derive_slot_tcps_adds_offsets_to_anchor_and_preserves_orientation():
    """Orientation (rx, ry, rz) MUST carry over from anchor unchanged
    — pallet slots share orientation by definition (task §1)."""
    spec = PalletPlaceSpec(rows=2, cols=2,
                           pitch_row_mm=100, pitch_col_mm=50,
                           order='row_major')
    anchor = (500.0, 250.0, 100.0, 3.14, 0.0, -1.57)
    slots = derive_slot_tcps(spec, anchor)
    assert len(slots) == 4
    for s in slots:
        tcp = s['tcp_mm']
        # Orientation exact match.
        assert tcp[3:] == [3.14, 0.0, -1.57]
    # First slot equals anchor position.
    assert slots[0]['tcp_mm'][:3] == [500.0, 250.0, 100.0]
    # Last slot (row 1 col 1 in row_major) = (600, 300, 100).
    assert slots[3]['tcp_mm'][:3] == [600.0, 300.0, 100.0]


def test_slot_label_convention():
    assert slot_label(0, 0, 0, layers=1) == 'slot r0,c0'
    assert slot_label(2, 3, 0, layers=1) == 'slot r2,c3'
    assert slot_label(2, 3, 1, layers=2) == 'slot r2,c3,l1'


# ── §B — composer integration ────────────────────────────────────

def _pnp_with_pallet(spec, ref_seed='loc_1'):
    """Single pick_and_place op with a pallet_place pattern."""
    return StructuredIntent(
        task_summary='pallet demo',
        raw_understanding_notes='pick from the tray, place on the pallet corner.',
        operations=[
            IntentOperation(
                operation_type='pick_and_place',
                target_part=PartReference('unknown', 'part'),
                sequence_index=1,
                count=1,
                place_pattern=PLACE_PATTERN_PALLET,
                pallet_place=spec,
                pick=PoseSlot(location_hint='tray'),
                place=PoseSlot(location_hint='pallet corner'),
            ),
        ],
    )


def test_composer_forces_iteration_count_to_slot_count():
    """§4 slot-to-cycle binding: composer overrides count with
    rows×cols×layers so every slot gets its own unrolled iteration."""
    spec = PalletPlaceSpec(rows=2, cols=3, layers=2,
                           pitch_row_mm=100, pitch_col_mm=50,
                           layer_height_mm=30)
    si = _pnp_with_pallet(spec)
    fuse_positions(si)
    draft = compose_program_draft(si, demo_id='pallet-2x3x2')
    # 12 place-contact steps in total (2 rows × 3 cols × 2 layers).
    place_contacts = [s for s in draft.steps
                      if s.get('position_role') == 'place'
                      and s.get('pallet_slot') is not None]
    assert len(place_contacts) == 12, len(place_contacts)


def test_composer_emits_one_taught_anchor_plus_n_minus_1_derived():
    """§1 teach-once invariant. Iteration 0 is the TAUGHT anchor
    (position_role='place', not derived); iterations 1..N-1 are all
    derived (derived_from='place' + iter_offset_mm)."""
    spec = PalletPlaceSpec(rows=2, cols=2,
                           pitch_row_mm=100, pitch_col_mm=50)
    si = _pnp_with_pallet(spec)
    fuse_positions(si)
    draft = compose_program_draft(si, demo_id='pallet-2x2')
    pallet_slots = [s for s in draft.steps if s.get('pallet_slot') is not None]
    assert len(pallet_slots) == 4
    # Iteration 0 = anchor.  Others carry derived_from='place'.
    anchor = [s for s in pallet_slots
              if s['pallet_slot']['index'] == 0][0]
    assert not anchor.get('derived_from')
    assert 'Pallet corner — teach at first slot' in anchor['label']
    derived = [s for s in pallet_slots
               if s['pallet_slot']['index'] > 0]
    assert len(derived) == 3
    for s in derived:
        assert s.get('derived_from') == 'place'
        assert 'iter_offset_mm' in s


def test_composer_labels_slots_with_row_col_layer_names():
    spec = PalletPlaceSpec(rows=2, cols=2,
                           pitch_row_mm=100, pitch_col_mm=50,
                           layers=2, layer_height_mm=30)
    si = _pnp_with_pallet(spec)
    fuse_positions(si)
    draft = compose_program_draft(si, demo_id='pallet-labels')
    for step in [s for s in draft.steps if s.get('pallet_slot') is not None]:
        slot_meta = step['pallet_slot']
        r, c, l = slot_meta['row'], slot_meta['col'], slot_meta['layer']
        # Anchor label doesn't start with slot-r/c/l — check others.
        if slot_meta['index'] == 0:
            continue
        assert f'r{r},c{c},l{l}' in step['label'], step['label']


def test_teach_flow_counts_exactly_one_position_for_the_whole_pallet():
    """§5 explicit test: the teach flow sees ONE position across the
    whole pallet, not rows×cols×layers positions. Composer's dedupe
    pass turns the N-1 derived slots into derived_from-shape steps
    that don't count as separate 'teachable' points."""
    from programming_by_demonstration.program_composer import _dedupe_repeated_refs
    spec = PalletPlaceSpec(rows=3, cols=4,
                           pitch_row_mm=100, pitch_col_mm=50)
    si = _pnp_with_pallet(spec)
    fuse_positions(si)
    draft = compose_program_draft(si, demo_id='pallet-teach-once')
    # Any step the operator would be asked to teach carries a
    # non-derived contact shape (position_role in {pick, place}
    # and no derived_from* fields).
    taught_places = [s for s in draft.steps
                     if s.get('position_role') == 'place'
                     and not s.get('derived_from')
                     and not s.get('derived_from_step_id')]
    assert len(taught_places) == 1, (
        f'pallet_place must teach ONE anchor; got {len(taught_places)}')


# ── Reachability sweep + refusal ─────────────────────────────────

def test_reachability_sweep_reports_ik_unavailable_off_host():
    """When estun_driver isn't importable (test env / dev host without
    the driver in PYTHONPATH), sweep should degrade gracefully:
    return every slot as unreachable with reason='ik unavailable',
    NOT crash. This is the safety default — codegen refuses either
    way, but the report shape stays stable."""
    import sys
    saved = sys.modules.pop('estun_driver.program_ops', None)
    saved_pkg = sys.modules.pop('estun_driver', None)
    try:
        # Force ImportError by shadowing the module.
        sys.modules['estun_driver.program_ops'] = None   # type: ignore
        spec = PalletPlaceSpec(rows=2, cols=2,
                               pitch_row_mm=100, pitch_col_mm=50)
        rep = reachability_sweep(spec, [0.0] * 6)
        assert rep['total_slots'] == 4
        assert rep['reachable'] == 0
        assert len(rep['unreachable']) == 4
        for u in rep['unreachable']:
            assert u['reason'] == 'ik unavailable'
    finally:
        if saved is not None:
            sys.modules['estun_driver.program_ops'] = saved
        if saved_pkg is not None:
            sys.modules['estun_driver'] = saved_pkg


def test_reachability_sweep_names_the_slot_on_refusal():
    """When a slot's IK fails, the report names it by (row, col, layer)
    so the codegen refusal message can render 'slot r2,c3 unreachable'."""
    import sys, types
    # Install a stub seeded_ik_z_lift that fails on the second slot.
    call_count = {'n': 0}
    def _stub(anchor_deg, dz_mm, **kw):
        call_count['n'] += 1
        if call_count['n'] == 2:
            return None
        return list(anchor_deg), dz_mm
    pkg = types.ModuleType('estun_driver')
    mod = types.ModuleType('estun_driver.program_ops')
    mod.seeded_ik_z_lift = _stub
    saved_pkg = sys.modules.get('estun_driver')
    saved_mod = sys.modules.get('estun_driver.program_ops')
    sys.modules['estun_driver']              = pkg
    sys.modules['estun_driver.program_ops']  = mod
    try:
        spec = PalletPlaceSpec(rows=1, cols=3,
                               pitch_row_mm=100, pitch_col_mm=50,
                               layer_height_mm=10, layers=2)
        rep = reachability_sweep(spec, [10, 20, 30, 40, 50, 60])
        # One failure expected on the second call.
        assert len(rep['unreachable']) == 1
        u = rep['unreachable'][0]
        assert 'row' in u and 'col' in u and 'layer' in u
        assert u['reason'].startswith('seeded IK layer lift')
    finally:
        if saved_pkg is not None:
            sys.modules['estun_driver'] = saved_pkg
        else:
            sys.modules.pop('estun_driver', None)
        if saved_mod is not None:
            sys.modules['estun_driver.program_ops'] = saved_mod
        else:
            sys.modules.pop('estun_driver.program_ops', None)


def test_pallet_place_schema_round_trips():
    """PalletPlaceSpec serialises via to_dict AND parses back via
    from_dict without loss. Legacy intents without the field parse
    with pallet_place=None (empty-input safety)."""
    spec = PalletPlaceSpec(rows=3, cols=4, layers=2,
                           pitch_row_mm=45.5, pitch_col_mm=60.0,
                           row_axis='-X', col_axis='+Y',
                           layer_height_mm=25.0, order='snake')
    d = spec.to_dict()
    round_tripped = PalletPlaceSpec.from_dict(d)
    assert round_tripped == spec
    # None-input safety.
    assert PalletPlaceSpec.from_dict(None) == PalletPlaceSpec()
    # Bad axis + order coerce to defaults.
    bad = PalletPlaceSpec.from_dict({'row_axis': 'diagonal', 'order': 'random'})
    assert bad.row_axis == '+X'
    assert bad.order == 'snake'
