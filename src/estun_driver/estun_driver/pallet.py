"""pallet.py — Palletize codegen for `move_to_pallet`.

Extracted from `program_ops.py` during the 2026-08-19 scoped fix
(ledger 2c2e435 pallet regression). Three defects rolled into a
single atomic module:

  1. Restore cb83ed4-era pick semantics. Each cycle starts with a
     single `movJ(pick_pt)` back to the taught pick pose — no
     `pick_approach` IK, no `linear-down` / `linear-up` around
     `pick_contact`. 2c2e435 added an axis-offset pick approach + a
     descent / retract per cycle, which combined with the walker-
     emitted taught `movL(pick_contact)` produced the observed
     "down → touch → up → down → vacuum-on" double-descend at pick.

  2. Preserve rule B on the place side: `place_approach = slot -
     approach_dist * slot_tool_Z` (or taught `place_approach + layer
     lift`). This is the "layer-N approach never dips to layer N-1"
     invariant.

  3. Atomic emit + refusal. On any IK failure inside the expansion,
     `_abort()` truncates `exec_lines` back to the pre-expansion mark
     and appends exactly one refusal comment — no partial cycles ever
     reach the controller. `should_refuse()` rejects programs whose
     `config.pallet` is missing `rows / cols / layers` OR whose
     `pallet_loop` step count exceeds slot capacity (the composer
     bug that made `pallettest.json` render as stuck-at-slot-1).

The walker also absorbs the taught `pick_contact` step (previously
KEPT for side-effect point registration) — `expand()` now self-
registers the pick point in `ctx.varspoint`, and `plan_absorb()`
marks pick_contact for the comment-only walker branch.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable
import re as _re


# ── Pre-scan for pick-block absorption ──────────────────────────────

@dataclass
class AbsorbPlan:
    """Which pre-pick steps to skip during walker emission.

    absorb_step_ids           id() of the approach, engage set_io,
                              seal wait, retreat, AND pick_contact
                              steps. The walker emits an `-- absorbed`
                              comment for each; the pallet expansion
                              emits the full pick+place cycle inline.

    inferred_vac_port         DO port inferred from an absorbed engage
                              set_io (`io_id='DO<N>'`, `value=1`).
                              Falls back through if the move_to_pallet
                              step lacks `vacuum_port_do`.

    inferred_seal_wait_ms     Dwell in ms inferred from an absorbed
                              wait step (`duration_s * 1000`). Falls
                              back through if the step lacks
                              `seal_wait_ms`.

    absorbed_approach_step    The `move_linear derived_from='pick'`
                              step BEFORE pick_contact (walker clause
                              d). Consumed by expand() to emit a
                              per-cycle approach lift + descent-split.
                              Refuses codegen when absent — never
                              silently emit a bare direct-to-pick.

    absorbed_retreat_step     The `move_linear derived_from='pick'`
                              step AFTER pick_contact (first backward
                              encounter, walker clause a). Consumed
                              by expand() to emit a per-cycle retreat
                              lift back above pick before the transit
                              move. Refuses codegen when absent.

    absorbed_pick_step        The taught pick_contact step (walker
                              clause c). Its speed_pct sets the gentle
                              final-descent cruise; expand() uses it
                              for both the descent and the taught
                              pick emission.
    """
    absorb_step_ids: set = field(default_factory=set)
    inferred_vac_port: int | None = None
    inferred_seal_wait_ms: int | None = None
    absorbed_approach_step: dict | None = None
    absorbed_retreat_step: dict | None = None
    absorbed_pick_step: dict | None = None


def plan_absorb(steps: list, cfg: dict) -> AbsorbPlan:
    """Walk backward from the first palletize `move_to_pallet` step
    and mark the pre-pick block for absorption.

    Order of absorption (walker backward):
        move_linear derived_from='pick'  → absorb  (approach / retreat)
        wait / set_io / gripper helpers  → absorb  (engage + seal wait)
        move_linear position_role='pick' → absorb  (pick_contact,
                                                     2026-08-19 fix)
        move_linear derived_from='pick'  → absorb  (approach BEFORE
                                                     pick_contact,
                                                     one more step
                                                     backward)

    All absorbed steps emit `-- absorbed into move_to_pallet cycle`
    comments at walker time; the palletize expansion emits its own
    single-descend pick + rule-B place inline.
    """
    plan = AbsorbPlan()
    for i, step in enumerate(steps):
        if str(step.get('action') or '').lower() != 'move_to_pallet':
            continue
        mode = str(step.get('mode') or '').lower()
        if not mode:
            mode = str((cfg.get('pallet') or {}).get('pallet_mode')
                       or 'palletize').lower()
        if mode != 'palletize':
            continue
        j = i - 1
        while j >= 0:
            st = steps[j]
            act = str(st.get('action') or '').lower()
            derived = st.get('derived_from')
            # (a) approach/retreat above pick → absorb.
            #     First encounter walking backward = RETREAT (post-pick).
            if act == 'move_linear' and derived == 'pick':
                plan.absorb_step_ids.add(id(st))
                if plan.absorbed_retreat_step is None:
                    plan.absorbed_retreat_step = st
                j -= 1
                continue
            # (b) engage: set_io / wait / gripper helpers → absorb,
            # and infer vac port + seal wait for legacy programs
            # whose move_to_pallet lacks these fields.
            if act in ('wait', 'set_io', 'close_gripper',
                       'open_gripper', 'gripper'):
                plan.absorb_step_ids.add(id(st))
                if act == 'set_io' and int(st.get('value') or 0) == 1:
                    iid = str(st.get('io_id') or '')
                    mm = _re.match(r'^DO(\d+)$', iid, _re.IGNORECASE)
                    if mm and plan.inferred_vac_port is None:
                        plan.inferred_vac_port = int(mm.group(1))
                if act == 'wait' and plan.inferred_seal_wait_ms is None:
                    try:
                        dur = float(st.get('duration_s') or 0)
                        plan.inferred_seal_wait_ms = int(round(dur * 1000))
                    except (TypeError, ValueError):
                        pass
                j -= 1
                continue
            # (c) pick_contact (position_role='pick') — ABSORB TOO
            # (2026-08-19 scoped fix). The walker previously KEPT
            # pick_contact so its emission would register the point
            # in varspoint. That standalone `movL(pick_pt)` combined
            # with the pallet expansion's own pick emission produced
            # a redundant pre-descent. `expand()` now self-registers
            # the pick point, so we absorb pick_contact too.
            if st.get('position_role') == 'pick' \
                    and act == 'move_linear':
                plan.absorb_step_ids.add(id(st))
                plan.absorbed_pick_step = st
                # And one more step backward: the approach that sits
                # BEFORE pick_contact (derived_from='pick', typically
                # z-lifted). Recorded so expand() can consume its
                # offset_z_mm + speed_pct for the per-cycle approach
                # lift instead of discarding them.
                j -= 1
                if j >= 0:
                    pst = steps[j]
                    if str(pst.get('action') or '').lower() == 'move_linear' \
                            and pst.get('derived_from') == 'pick':
                        plan.absorb_step_ids.add(id(pst))
                        plan.absorbed_approach_step = pst
                break
            # Anything else stops the scan.
            break
        break
    return plan


# ── Refusal on obviously-broken pallet config ───────────────────────

def should_refuse(steps: list, cfg: dict) -> str | None:
    """Return a one-line refusal message if the pallet block is
    misconfigured, else `None`.

    Two refusal cases (2026-08-19 scoped fix, defect A):

      (i)  `config.pallet` is present AND a `move_to_pallet` step is
           present AND `rows / cols / layers` are ALL absent. The
           composer bug (pallettest.json fixture) writes only
           corners + part_tcp; codegen must NOT default 1×1×1 and
           silently emit a single-slot cycle that a `pallet_loop`
           wrapper then replays N times (stuck-at-slot-1).

      (ii) A `pallet_loop` step (`action='loop'`, `pallet_loop=True`)
           has `count > slot capacity (rows*cols*layers)`. The
           palletize expansion emits ALL slots INLINE per iteration;
           a loop wrapper on top would replay them, placing more
           parts than the pallet holds.
    """
    has_pallet_step = any(
        str(s.get('action') or '').lower() == 'move_to_pallet'
        for s in steps)
    if not has_pallet_step:
        return None
    pallet_cfg = (cfg.get('pallet') or {})
    if 'rows' not in pallet_cfg \
            and 'cols' not in pallet_cfg \
            and 'layers' not in pallet_cfg:
        return (
            "config.pallet is missing rows/cols/layers — composer wrote "
            "only corner1/2/3 + part_tcp. Codegen refuses to expand a "
            "1x1x1 default that would produce single-slot cycles "
            "(stuck-at-slot-1 defect). Fix the composer to persist the "
            "grid dimensions alongside the pallet frame.")
    rows   = int(pallet_cfg.get('rows',   1) or 1)
    cols   = int(pallet_cfg.get('cols',   1) or 1)
    layers = int(pallet_cfg.get('layers', 1) or 1)
    capacity = rows * cols * layers
    for s in steps:
        if str(s.get('action') or '').lower() == 'loop' \
                and s.get('pallet_loop') is True:
            try:
                cnt = int(s.get('count') or 0)
            except (TypeError, ValueError):
                cnt = 0
            if cnt > capacity:
                return (
                    f"pallet_loop step count={cnt} exceeds slot capacity "
                    f"{capacity} (rows*cols*layers = {rows}x{cols}x{layers}). "
                    f"The palletize expansion emits all slots INLINE per "
                    f"iteration; a loop wrapper on top would replay them, "
                    f"placing more parts than the pallet holds. Set the "
                    f"pallet_loop step count to 1 (or omit it) — the "
                    f"expansion is already fully unrolled.")
    return None


# ── Expansion context ───────────────────────────────────────────────

@dataclass
class ExpandCtx:
    """State that `expand()` mutates. Keeps the walker's function
    signature small: `expand(step, ctx)`.
    """
    steps: list
    cfg: dict
    exec_lines: list             # mutable Lua line buffer
    varspoint: dict              # mutable {name → point-table entry}
    used_named: set              # {name} that have been referenced
    program_points: dict         # program.points (external names)
    role_point_name: dict        # {role → name}
    step_point_name: dict        # {step_id → name}
    eff_pct: int                 # operator-cap % (unused today; kept
                                 # for symmetry with the walker branch)
    point_prefix: str            # 'p' by default
    absorb_plan: AbsorbPlan
    seeded_ik_to_pose: Callable
    fk_chain: Callable
    R_from_tcp_abc: Callable
    tcp_from_joints_m: Callable
    make_jp_point: Callable
    fallback_idx: list           # [int], mutable through indexing
    # Motion constants — mirror the outer emitter's math so per-cycle
    # setSpeedJ/L/AccL directives inside expand() use the same
    # % → deg/s / mm/s / mm/s² conversion the walker uses.
    max_dps: float = 150.0
    max_mmps: float = 1500.0
    default_accl_mm_s2: float = 1200.0
    gentle_accl_mm_s2: float = 150.0


def _next_point_name(ctx: ExpandCtx) -> str:
    ctx.fallback_idx[0] += 1
    nm = f'{ctx.point_prefix}{ctx.fallback_idx[0]}'
    while nm in ctx.program_points or nm in ctx.used_named:
        ctx.fallback_idx[0] += 1
        nm = f'{ctx.point_prefix}{ctx.fallback_idx[0]}'
    return nm


# 2026-09-04 §13.3 — retry IK across multiple seeds before declaring a
# pose "unreachable". The prior single-seed policy (feed the previous
# solved joints as the sole seed) was operator-hostile: LM would get
# stuck at a local minimum on the wrong kinematic branch for edge
# slots even though the pose was clearly reachable — verified against
# slot [0,3,0] on program 'test', which the taught_pick seed solves in
# 5μm. Refuse ONLY when every seed fails; then the pose really is
# outside reach and the refusal is a true kinematic impossibility.
#
# Seeds are tried in order of "closest to expected branch":
#   1. `primary_seed`   — the walker's chained seed (previous solve).
#                         Fast when it works; the traditional path.
#   2. `pick_joints`    — the operator's taught pick pose. Known
#                         reachable, known branch; robust for any
#                         nearby slot / transit.
#   3. `_NEUTRAL_SEED`  — a wrist-neutral pose commonly reachable
#                         across the arm's envelope. Last resort;
#                         also widens `max_seed_dev_deg` so LM can
#                         cross branches if needed.
_NEUTRAL_SEED = [0.0, -45.0, 90.0, 0.0, 90.0, 0.0]


def _multi_seed_ik(ctx: ExpandCtx, primary_seed, target_tcp_m,
                   pick_joints):
    """Try the primary seed, then the taught pick, then a neutral
    seed with widened branch tolerance. Return the first solve or
    None if every seed fails.

    Signature matches `ctx.seeded_ik_to_pose(seed, tcp_m)` so callers
    can drop-in swap; solve success is `(joints, ...)` per the same
    contract.
    """
    r = ctx.seeded_ik_to_pose(list(primary_seed), target_tcp_m)
    if r is not None:
        return r
    if list(pick_joints) != list(primary_seed):
        r = ctx.seeded_ik_to_pose(list(pick_joints), target_tcp_m)
        if r is not None:
            return r
    r = ctx.seeded_ik_to_pose(list(_NEUTRAL_SEED), target_tcp_m,
                              max_seed_dev_deg=180.0, max_iter=300)
    return r


# ── Expansion ───────────────────────────────────────────────────────

def expand(step: dict, ctx: ExpandCtx) -> None:
    """Expand a single `move_to_pallet` step into per-slot cycles.

    Atomic emit: any IK failure aborts the whole expansion — partial
    cycles are rolled back and exactly one refusal comment remains
    in `ctx.exec_lines`. No half-expanded cycle ever reaches the
    controller.

    Per-cycle emission (cb83ed4 pick restore + rule-B place):

        (header)  -- cycle N/M: ...
        movJ(pick_pt)              — joint-space return to taught pick
        setDO(vac,1)                — vacuum ON at contact
        wait(seal_ms)               — seal dwell
        movL(transit_pick)          — lift to transit_Z above pick
        movL(transit_slot)          — traverse over slot at transit_Z
        movL(place_approach)        — descend to layer-shifted approach
        movL(slot)                  — descend to slot (linear-down)
        setDO(vac,0)                — release
        [optional 3-line blow-off pulse]
        movL(place_approach)        — retract to approach (linear-up)
        movL(transit_slot)          — lift to transit_Z for next cycle
    """
    # Late imports so this module stays importable in headless test
    # environments where the ROS 2 workspace isn't fully installed.
    from programming_by_demonstration.schema import PalletPlaceSpec
    from programming_by_demonstration.pallet_geometry import (
        derive_slot_tcps, compute_frame,
    )

    # The atomic-rollback mark is set AFTER the expansion header is
    # emitted (further down). Header stays visible on IK failure so
    # the operator can read the intended cycle count / grid dims /
    # I/O ports next to the refusal comment. Only per-cycle body
    # lines are subject to rollback.
    _abort_mark = [-1]   # mutable box; set post-header

    def _abort(msg: str) -> None:
        """Roll back per-cycle emissions to the post-header mark and
        emit the failure exactly once."""
        if _abort_mark[0] >= 0:
            del ctx.exec_lines[_abort_mark[0]:]
        ctx.exec_lines.append(msg)

    place = (ctx.cfg.get('pallet_place') or {})
    pold  = (ctx.cfg.get('pallet')       or {})
    corner1 = place.get('corner1_tcp')
    if not (isinstance(corner1, list) and len(corner1) == 6):
        ctx.exec_lines.append(
            "-- skipped 'move_to_pallet': pallet_place.corner1_tcp "
            "missing or malformed — cannot compute slot frame")
        return
    part_tcp = place.get('part_tcp')
    if not (isinstance(part_tcp, list) and len(part_tcp) == 6):
        ctx.exec_lines.append(
            "-- skipped 'move_to_pallet': pallet_place.part_tcp "
            "missing — no operator-taught slot datum")
        return

    # ── build the pallet spec ─────────────────────────────────
    spec_dict = dict(place)
    spec_dict['rows']            = int(pold.get('rows',   1) or 1)
    spec_dict['cols']            = int(pold.get('cols',   1) or 1)
    spec_dict['layers']          = int(pold.get('layers', 1) or 1)
    spec_dict['pitch_row_mm']    = float(pold.get('spacing_x_mm', 150) or 150)
    spec_dict['pitch_col_mm']    = float(pold.get('spacing_y_mm', 150) or 150)
    spec_dict['layer_height_mm'] = float(pold.get('layer_height_mm', 100) or 100)
    order_legacy = str(pold.get('fill_order') or 'snake').lower()
    order_map = {
        'row_lr': 'row_major', 'row-lr': 'row_major', 'row': 'row_major',
        'col_tb': 'col_major', 'col-tb': 'col_major', 'column': 'col_major',
        'snake':  'snake',
    }
    spec_dict['order'] = order_map.get(order_legacy, 'snake')
    try:
        pspec = PalletPlaceSpec.from_dict(spec_dict)
        slots = derive_slot_tcps(pspec, tuple(corner1))
    except Exception as pe:
        ctx.exec_lines.append(
            f"-- skipped 'move_to_pallet': derive_slot_tcps failed "
            f"({type(pe).__name__}: {pe})")
        return

    # ── part_count cap ────────────────────────────────────────
    capacity = len(slots)
    pc_raw = pold.get('part_count')
    if pc_raw is None:
        part_count = capacity
        pc_note = 'no part_count set — emitting full capacity'
    else:
        try:
            part_count = max(1, int(pc_raw))
        except (TypeError, ValueError):
            part_count = capacity
            pc_note = (f'invalid part_count={pc_raw!r} — falling back to '
                       f'capacity {capacity}')
        else:
            if part_count > capacity:
                ctx.exec_lines.append(
                    f'-- move_to_pallet: part_count={part_count} exceeds '
                    f'capacity={capacity} — capping at capacity (only '
                    f'{capacity} placed)')
                part_count = capacity
                pc_note = f'capped at capacity {capacity}'
            else:
                pc_note = f'part_count={part_count}/capacity={capacity}'
    slots = slots[:part_count]

    # ── frame normal ─────────────────────────────────────────
    try:
        fr = compute_frame(pspec)
        normal = fr['plane_normal']
    except Exception:
        normal = (0.0, 0.0, 1.0)

    # ── step-level knobs ─────────────────────────────────────
    step_grip_type = str(step.get('gripper_type') or 'finger').lower()
    vac_port_do = step.get('vacuum_port_do')
    if vac_port_do is None:
        vac_port_do = ctx.absorb_plan.inferred_vac_port
    if vac_port_do is None and step_grip_type == 'vacuum':
        vac_port_do = 2   # io_map default (VACUUM_DEFAULT_PORT)
    try:
        vac_port_do = int(vac_port_do) if vac_port_do is not None else None
    except (TypeError, ValueError):
        vac_port_do = None
    _bp = step.get('blow_off_port_do')
    try:
        blow_port_do = int(_bp) if _bp is not None else None
    except (TypeError, ValueError):
        blow_port_do = None
    try:
        blow_pulse_ms = int(step.get('blow_off_pulse_ms') or 300)
    except (TypeError, ValueError):
        blow_pulse_ms = 300
    try:
        safety_margin_mm = float(step.get('safety_margin_mm') or 50)
    except (TypeError, ValueError):
        safety_margin_mm = 50.0
    seal_wait_ms = step.get('seal_wait_ms')
    if seal_wait_ms is None:
        seal_wait_ms = ctx.absorb_plan.inferred_seal_wait_ms or 500
    try:
        seal_wait_ms = int(seal_wait_ms)
    except (TypeError, ValueError):
        seal_wait_ms = 500
    try:
        approach_dist_mm = float(step.get('approach_distance_mm') or 50)
    except (TypeError, ValueError):
        approach_dist_mm = 50.0
    try:
        retract_dist_mm = float(step.get('retract_distance_mm') or 50)
    except (TypeError, ValueError):
        retract_dist_mm = 50.0
    layer_h_mm = float(pold.get('layer_height_mm') or 100)
    # transit_over_slot lifts ABOVE the current slot by
    # (layer_height + safety_margin) along the plane normal. Because
    # slot_Z(l) rises with layer, transit_slot's absolute Z rises
    # with layer too — the "clears the highest occupied layer" invariant.
    transit_h_mm = layer_h_mm + safety_margin_mm

    # ── locate the taught pick pose ──────────────────────────
    pick_step = None
    for s in ctx.steps:
        if s.get('position_role') == 'pick' \
                and isinstance(s.get('taught_joints'), list) \
                and len(s['taught_joints']) == 6:
            pick_step = s
            break
    if pick_step is None:
        _abort(
            "-- skipped 'move_to_pallet': no taught pick pose "
            "(position_role='pick' with 6-el taught_joints) in the "
            "program — cannot expand palletize cycles")
        return
    pick_joints = [float(v) for v in pick_step['taught_joints']]
    # SELF-REGISTER the pick point. Under the 2026-08-19 scoped fix
    # (defect B), plan_absorb() absorbs the taught pick_contact step
    # so the walker never emits its movL — that means the walker also
    # never registers the point in varspoint. Do it here.
    pick_pt_name = ctx.role_point_name.get('pick')
    if pick_pt_name is None:
        pick_pt_name = _next_point_name(ctx)
        ctx.varspoint[pick_pt_name] = ctx.make_jp_point(
            pick_joints, pick_pt_name)
        ctx.used_named.add(pick_pt_name)
        ctx.role_point_name['pick'] = pick_pt_name
        # Also register by step id so downstream role reuse (derived
        # anchor lookup) picks the same point.
        _pid = pick_step.get('id')
        if _pid is not None:
            ctx.step_point_name.setdefault(_pid, pick_pt_name)
    pick_tcp = ctx.tcp_from_joints_m(pick_joints)

    # ── slot orientation → tool Z (rule B place) ──────────────
    if slots:
        s0 = slots[0]['tcp_m']
        slot_R = ctx.R_from_tcp_abc(
            float(s0[3]), float(s0[4]), float(s0[5]))
        slot_tool_z = (float(slot_R[0, 2]),
                       float(slot_R[1, 2]),
                       float(slot_R[2, 2]))
    else:
        slot_tool_z = (0.0, 0.0, -1.0)

    # ── optional taught place_approach ────────────────────────
    place_appr_taught = step.get('place_approach_joints')
    if isinstance(place_appr_taught, list) and len(place_appr_taught) == 6:
        place_appr_joints_taught = [float(v) for v in place_appr_taught]
        place_appr_tcp_taught = ctx.tcp_from_joints_m(
            place_appr_joints_taught)
    else:
        place_appr_tcp_taught = None

    # ── vacuum port required ─────────────────────────────────
    if vac_port_do is None:
        _abort(
            "-- skipped 'move_to_pallet': no vacuum_port_do on step "
            "and no engage set_io in the pre-pallet block to infer it "
            "from — palletize needs a DO to energize at pick and "
            "de-energize at place")
        return

    # ── approach + retreat MUST be present ───────────────────
    # Codegen used to silently emit a bare `movJ(pick_pt)` per cycle,
    # discarding the operator's authored approach lift + retreat lift.
    # That produced a sweep-through-workspace hazard: the arm jumped
    # directly to the taught pick pose from wherever the previous
    # cycle left it (cycle 1 = move_home; cycles 2+ = the previous
    # cycle's transit-over-slot). Now the expansion re-emits an
    # approach hop, a descent (with analyzer's descent-split when the
    # authored offset > threshold), and a symmetric retreat — all
    # driven by the absorbed steps' offset_z_mm + speed_pct. When
    # either step is missing, refuse rather than fall back to the
    # bare direct-to-pick.
    absorbed_approach = ctx.absorb_plan.absorbed_approach_step
    absorbed_retreat  = ctx.absorb_plan.absorbed_retreat_step
    if absorbed_approach is None:
        ctx.exec_lines.append(
            "-- REFUSED 'move_to_pallet': no absorbed approach step "
            "(move_linear with derived_from='pick' BEFORE the taught "
            "pick_contact) — refusing rather than emitting a bare "
            "direct-to-pick. Add the approach step to the program "
            "(the wizard's buildPalletizeSteps emits one automatically) "
            "and re-push.")
        return
    if absorbed_retreat is None:
        ctx.exec_lines.append(
            "-- REFUSED 'move_to_pallet': no absorbed retreat step "
            "(move_linear with derived_from='pick' AFTER the taught "
            "pick_contact) — refusing rather than emitting a bare "
            "direct-to-pick with no retreat lift.")
        return

    def _pos_offset_mm(st: dict) -> float | None:
        try:
            v = float(st.get('offset_z_mm'))
        except (TypeError, ValueError):
            return None
        return v if v > 0 else None

    def _pct(st: dict, default: int) -> int:
        try:
            v = int(st.get('speed_pct'))
            return max(1, min(100, v))
        except (TypeError, ValueError):
            return default

    approach_offset_z_mm = _pos_offset_mm(absorbed_approach)
    retreat_offset_z_mm  = _pos_offset_mm(absorbed_retreat)
    if approach_offset_z_mm is None:
        ctx.exec_lines.append(
            "-- REFUSED 'move_to_pallet': absorbed approach step has "
            "no positive `offset_z_mm` — cannot compute an approach "
            "point above the pick.")
        return
    if retreat_offset_z_mm is None:
        ctx.exec_lines.append(
            "-- REFUSED 'move_to_pallet': absorbed retreat step has "
            "no positive `offset_z_mm` — cannot compute a retreat "
            "point above the pick.")
        return
    approach_speed_pct = _pct(absorbed_approach, 40)
    retreat_speed_pct  = _pct(absorbed_retreat, 40)
    absorbed_pick_step = ctx.absorb_plan.absorbed_pick_step
    pick_speed_pct = _pct(absorbed_pick_step, 20) if absorbed_pick_step else 20

    # Descent-split constants — mirror analyzer's Rule 2c so the
    # per-cycle emission gets the same "fast to 50mm above + gentle
    # final" treatment the operator sees in `motion_check`.
    DESCENT_SPLIT_THRESHOLD_MM  = 250.0
    DESCENT_SPLIT_STOP_ABOVE_MM = 50.0
    descent_split_needed = approach_offset_z_mm > DESCENT_SPLIT_THRESHOLD_MM

    # ── header ───────────────────────────────────────────────
    blow_desc = (f'DO{blow_port_do}+{blow_pulse_ms}ms'
                 if blow_port_do is not None else 'none')
    place_appr_kind = ('taught (layer-shifted)'
                       if place_appr_tcp_taught is not None
                       else f'axis-offset {approach_dist_mm:.0f}mm')
    pick_desc = (
        f'pick=approach({approach_offset_z_mm:.0f}mm '
        f'@ {approach_speed_pct}%)→descent-split→pick '
        f'@ {pick_speed_pct}%'
        if descent_split_needed
        else f'pick=approach({approach_offset_z_mm:.0f}mm '
             f'@ {approach_speed_pct}%)→pick @ {pick_speed_pct}%')
    ctx.exec_lines.append(
        f'-- move_to_pallet EXPANSION: {len(slots)} cycle(s) ({pc_note}), '
        f'{pspec.rows}x{pspec.cols}x{pspec.layers} grid, '
        f'pitch_row={pspec.pitch_row_mm:.0f}mm '
        f'pitch_col={pspec.pitch_col_mm:.0f}mm '
        f'layer_h={pspec.layer_height_mm or 0:.0f}mm '
        f'order={pspec.order} (layer-outermost)  '
        f'vacuum_port=DO{vac_port_do}  '
        f'blow_off={blow_desc}  '
        f'safety_margin={safety_margin_mm:.0f}mm  '
        f'transit_h_above_slot={transit_h_mm:.0f}mm  '
        f'approach={approach_dist_mm:.0f}mm  '
        f'retract={retract_dist_mm:.0f}mm  '
        f'{pick_desc}  '
        f'retreat={retreat_offset_z_mm:.0f}mm @ {retreat_speed_pct}%  '
        f'place_approach={place_appr_kind}')

    # Set the atomic-rollback mark AFTER the header. Per-cycle body
    # lines below are subject to rollback on IK failure; the header
    # itself remains visible to the operator.
    _abort_mark[0] = len(ctx.exec_lines)

    # Modal setSpeedJ / setSpeedL / setAccL cache local to this
    # expansion. Reset every time expand() runs (fresh per-cycle
    # emission). The outer walker also resets its own copies AFTER
    # expand() returns so a subsequent movJ/movL re-issues its
    # speed directive.
    _last_speed_j: float | None = None
    _last_speed_l: float | None = None
    _last_accl: float | None = None

    # ── per-slot cycles ──────────────────────────────────────
    for sl_idx, sl in enumerate(slots):
        r_idx = int(sl['row'])
        c_idx = int(sl['col'])
        l_idx = int(sl['layer'])
        slot_m = list(sl['tcp_m'])
        transit_slot_m = list(slot_m)
        transit_slot_m[0] += (transit_h_mm / 1000.0) * float(normal[0])
        transit_slot_m[1] += (transit_h_mm / 1000.0) * float(normal[1])
        transit_slot_m[2] += (transit_h_mm / 1000.0) * float(normal[2])
        transit_pick_m = [
            float(pick_tcp[0]),
            float(pick_tcp[1]),
            float(transit_slot_m[2]),
            float(pick_tcp[3]),
            float(pick_tcp[4]),
            float(pick_tcp[5]),
        ]
        # PLACE_APPROACH — rule B (layer-rising).
        if place_appr_tcp_taught is not None:
            lift = (l_idx * layer_h_mm) / 1000.0
            place_appr_tcp = [
                place_appr_tcp_taught[0] + lift * float(normal[0]),
                place_appr_tcp_taught[1] + lift * float(normal[1]),
                place_appr_tcp_taught[2] + lift * float(normal[2]),
                place_appr_tcp_taught[3],
                place_appr_tcp_taught[4],
                place_appr_tcp_taught[5],
            ]
            place_appr_kind_line = f'taught + layer×{layer_h_mm:.0f}mm lift'
        else:
            place_appr_tcp = [
                slot_m[0] - (approach_dist_mm / 1000.0) * slot_tool_z[0],
                slot_m[1] - (approach_dist_mm / 1000.0) * slot_tool_z[1],
                slot_m[2] - (approach_dist_mm / 1000.0) * slot_tool_z[2],
                slot_m[3], slot_m[4], slot_m[5],
            ]
            place_appr_kind_line = (f'axis-offset {approach_dist_mm:.0f}mm '
                                    f'along slot -tool_Z')

        ctx.exec_lines.append(
            f'-- cycle {sl_idx + 1}/{len(slots)}: pick (fixed taught pose) '
            f'-> vacuum ON -> seal wait -> transit_Z (layer {l_idx}, '
            f'absolute Z={transit_slot_m[2]*1000:.1f}mm) -> over '
            f'slot({r_idx},{c_idx},{l_idx}) -> place_approach '
            f'({place_appr_kind_line}, absolute Z='
            f'{place_appr_tcp[2]*1000:.1f}mm) -> place -> vacuum OFF'
            + (' + blow-off pulse' if blow_port_do is not None else '')
            + ' -> retract -> transit_Z')

        # (1a) Approach above pick — consume the absorbed approach's
        # authored `offset_z_mm` (positive, base +Z). Use movJ so
        # cycle 1 (arriving from move_home) and cycles 2+ (arriving
        # from prev transit) don't have to hold a straight-line path
        # from an unbounded start. Emit setSpeedJ modally.
        approach_tcp = [
            float(pick_tcp[0]),
            float(pick_tcp[1]),
            float(pick_tcp[2]) + approach_offset_z_mm / 1000.0,
            float(pick_tcp[3]),
            float(pick_tcp[4]),
            float(pick_tcp[5]),
        ]
        ik_appr = _multi_seed_ik(ctx, list(pick_joints), approach_tcp, pick_joints)
        if ik_appr is None:
            _abort(
                f'-- PALLET IK FAILED: approach above pick '
                f'({approach_offset_z_mm:.0f}mm) unreachable at Z='
                f'{approach_tcp[2]*1000:.1f}mm — refusing pallet '
                f'expansion')
            return
        q_appr = ik_appr[0]
        nm_appr = _next_point_name(ctx)
        ctx.varspoint[nm_appr] = ctx.make_jp_point(q_appr, nm_appr)
        ctx.used_named.add(nm_appr)
        _speed_j_appr = round(approach_speed_pct / 100.0 * ctx.max_dps, 3)
        if _last_speed_j is None or abs(_speed_j_appr - _last_speed_j) > 1e-4:
            ctx.exec_lines.append(
                f'setSpeedJ({_speed_j_appr:g})  -- cycle '
                f'{sl_idx + 1} approach {approach_speed_pct}% '
                f'× max {ctx.max_dps:g} deg/s')
            _last_speed_j = _speed_j_appr
        ctx.exec_lines.append(
            f'movJ({nm_appr})  -- cycle {sl_idx + 1} approach '
            f'above pick ({approach_offset_z_mm:.0f}mm above contact, '
            f'absolute Z={approach_tcp[2]*1000:.1f}mm)  '
            f'joints=[{", ".join(f"{v:+.3f}" for v in q_appr)}]')
        seed = list(q_appr)

        # (1b) Descent to pick contact — either single movL (short
        # descent) or descent-split (long descent > threshold, fast
        # movL to 50mm above pick + gentle-accel final movL to pick).
        # Mirrors analyzer Rule 2c so the absorbed adaptation actually
        # reaches the wire instead of being discarded with the step.
        _speed_l_pick = round(pick_speed_pct / 100.0 * ctx.max_mmps, 3)
        _speed_l_appr = round(approach_speed_pct / 100.0 * ctx.max_mmps, 3)
        if descent_split_needed:
            split_tcp = [
                float(pick_tcp[0]),
                float(pick_tcp[1]),
                float(pick_tcp[2]) + DESCENT_SPLIT_STOP_ABOVE_MM / 1000.0,
                float(pick_tcp[3]),
                float(pick_tcp[4]),
                float(pick_tcp[5]),
            ]
            ik_split = _multi_seed_ik(ctx, seed, split_tcp, pick_joints)
            if ik_split is None:
                _abort(
                    f'-- PALLET IK FAILED: descent-split waypoint '
                    f'({DESCENT_SPLIT_STOP_ABOVE_MM:.0f}mm above pick) '
                    f'unreachable — refusing pallet expansion')
                return
            q_split = ik_split[0]
            nm_split = _next_point_name(ctx)
            ctx.varspoint[nm_split] = ctx.make_jp_point(q_split, nm_split)
            ctx.used_named.add(nm_split)
            if _last_speed_l is None or abs(_speed_l_appr - _last_speed_l) > 1e-4:
                ctx.exec_lines.append(
                    f'setSpeedL({_speed_l_appr:g})  -- cycle '
                    f'{sl_idx + 1} descent-split fast portion '
                    f'{approach_speed_pct}% × max {ctx.max_mmps:g} mm/s')
                _last_speed_l = _speed_l_appr
            ctx.exec_lines.append(
                f'movL({nm_split})  -- cycle {sl_idx + 1} '
                f'descent-split fast to '
                f'{DESCENT_SPLIT_STOP_ABOVE_MM:.0f}mm above pick '
                f'(absolute Z={split_tcp[2]*1000:.1f}mm)  '
                f'joints=[{", ".join(f"{v:+.3f}" for v in q_split)}]')
            seed = list(q_split)
            if _last_accl is None or abs(ctx.gentle_accl_mm_s2 - _last_accl) > 1e-4:
                ctx.exec_lines.append(
                    f'setAccL({ctx.gentle_accl_mm_s2:g})  -- cycle '
                    f'{sl_idx + 1} gentle-accel final descent to pick '
                    f'(descent_split rule 2c mirror)')
                _last_accl = ctx.gentle_accl_mm_s2
            if _last_speed_l is None or abs(_speed_l_pick - _last_speed_l) > 1e-4:
                ctx.exec_lines.append(
                    f'setSpeedL({_speed_l_pick:g})  -- cycle '
                    f'{sl_idx + 1} pick descent {pick_speed_pct}% '
                    f'× max {ctx.max_mmps:g} mm/s')
                _last_speed_l = _speed_l_pick
            ctx.exec_lines.append(
                f'movL({pick_pt_name})  -- cycle {sl_idx + 1} pick '
                f'(gentle final descent, split at '
                f'{DESCENT_SPLIT_STOP_ABOVE_MM:.0f}mm above)  '
                f'joints=[{", ".join(f"{v:+.3f}" for v in pick_joints)}]')
        else:
            if _last_speed_l is None or abs(_speed_l_pick - _last_speed_l) > 1e-4:
                ctx.exec_lines.append(
                    f'setSpeedL({_speed_l_pick:g})  -- cycle '
                    f'{sl_idx + 1} pick descent {pick_speed_pct}% '
                    f'× max {ctx.max_mmps:g} mm/s')
                _last_speed_l = _speed_l_pick
            ctx.exec_lines.append(
                f'movL({pick_pt_name})  -- cycle {sl_idx + 1} pick '
                f'(descent from {approach_offset_z_mm:.0f}mm above)  '
                f'joints=[{", ".join(f"{v:+.3f}" for v in pick_joints)}]')
        seed = list(pick_joints)

        # (2) Vacuum ON at pick contact.
        ctx.exec_lines.append(
            f'setDO({vac_port_do},1)  -- cycle {sl_idx + 1} '
            f'vacuum ON  (vacuum_port_do=DO{vac_port_do})')

        # (3) Seal wait.
        if seal_wait_ms > 0:
            ctx.exec_lines.append(
                f'wait({seal_wait_ms})  -- cycle {sl_idx + 1} '
                f'seal wait {seal_wait_ms} ms')

        # (3.5) Retreat above pick — consume the absorbed retreat's
        # authored `offset_z_mm` (positive, base +Z). Symmetric with
        # the approach; use movL so the lift is straight-line above
        # the pick (no lateral drift while the part settles). Restore
        # default accL if descent-split bumped it to gentle.
        if descent_split_needed and _last_accl is not None \
                and abs(ctx.default_accl_mm_s2 - _last_accl) > 1e-4:
            ctx.exec_lines.append(
                f'setAccL({ctx.default_accl_mm_s2:g})  -- cycle '
                f'{sl_idx + 1} restore default accel after descent-split')
            _last_accl = ctx.default_accl_mm_s2
        retreat_tcp = [
            float(pick_tcp[0]),
            float(pick_tcp[1]),
            float(pick_tcp[2]) + retreat_offset_z_mm / 1000.0,
            float(pick_tcp[3]),
            float(pick_tcp[4]),
            float(pick_tcp[5]),
        ]
        ik_retreat = _multi_seed_ik(ctx, seed, retreat_tcp, pick_joints)
        if ik_retreat is None:
            _abort(
                f'-- PALLET IK FAILED: retreat above pick '
                f'({retreat_offset_z_mm:.0f}mm) unreachable at Z='
                f'{retreat_tcp[2]*1000:.1f}mm — refusing pallet '
                f'expansion')
            return
        q_retreat = ik_retreat[0]
        nm_retreat = _next_point_name(ctx)
        ctx.varspoint[nm_retreat] = ctx.make_jp_point(q_retreat, nm_retreat)
        ctx.used_named.add(nm_retreat)
        _speed_l_retreat = round(retreat_speed_pct / 100.0 * ctx.max_mmps, 3)
        if _last_speed_l is None or abs(_speed_l_retreat - _last_speed_l) > 1e-4:
            ctx.exec_lines.append(
                f'setSpeedL({_speed_l_retreat:g})  -- cycle '
                f'{sl_idx + 1} retreat {retreat_speed_pct}% '
                f'× max {ctx.max_mmps:g} mm/s')
            _last_speed_l = _speed_l_retreat
        ctx.exec_lines.append(
            f'movL({nm_retreat})  -- cycle {sl_idx + 1} retreat '
            f'above pick ({retreat_offset_z_mm:.0f}mm above contact, '
            f'absolute Z={retreat_tcp[2]*1000:.1f}mm)  '
            f'joints=[{", ".join(f"{v:+.3f}" for v in q_retreat)}]')
        seed = list(q_retreat)

        # (4) Lift to transit_Z above pick — only emit when retreat
        # left us BELOW the traversal height. If the operator authored
        # a retreat >= transit height, we're already at (or above) the
        # traversal Z and this move would go DOWNWARD; skip it and
        # let (5) traverse straight from retreat over to the slot.
        retreat_z_abs = float(retreat_tcp[2])
        if retreat_z_abs < float(transit_pick_m[2]) - 1e-4:
            ik_tpick = _multi_seed_ik(ctx, seed, transit_pick_m, pick_joints)
            if ik_tpick is None:
                _abort(
                    f'-- PALLET IK FAILED: transit_over_pick for slot '
                    f'[{r_idx},{c_idx},{l_idx}] unreachable (target Z='
                    f'{transit_pick_m[2]*1000:.1f}mm) — refusing pallet '
                    f'expansion')
                return
            q_tpick = ik_tpick[0]
            nm_tpick = _next_point_name(ctx)
            ctx.varspoint[nm_tpick] = ctx.make_jp_point(q_tpick, nm_tpick)
            ctx.used_named.add(nm_tpick)
            ctx.exec_lines.append(
                f'movL({nm_tpick})  -- cycle {sl_idx + 1} '
                f'lift-to-transit (over pick, absolute Z='
                f'{transit_pick_m[2]*1000:.1f}mm)  '
                f'joints=[{", ".join(f"{v:+.3f}" for v in q_tpick)}]')
            seed = list(q_tpick)

        # (5) Traverse over slot at transit_Z.
        ik_tslot = _multi_seed_ik(ctx, seed, transit_slot_m, pick_joints)
        if ik_tslot is None:
            _abort(
                f'-- PALLET IK FAILED: transit_over_slot '
                f'[{r_idx},{c_idx},{l_idx}] unreachable at Z='
                f'{transit_slot_m[2]*1000:.1f}mm — refusing')
            return
        q_tslot = ik_tslot[0]
        nm_tslot = _next_point_name(ctx)
        ctx.varspoint[nm_tslot] = ctx.make_jp_point(q_tslot, nm_tslot)
        ctx.used_named.add(nm_tslot)
        ctx.exec_lines.append(
            f'movL({nm_tslot})  -- cycle {sl_idx + 1} '
            f'traverse-over-slot [{r_idx},{c_idx},{l_idx}] at '
            f'transit_Z={transit_slot_m[2]*1000:.1f}mm  '
            f'joints=[{", ".join(f"{v:+.3f}" for v in q_tslot)}]')
        seed = list(q_tslot)

        # (6) Descend to place_approach (layer-adjusted).
        ik_place_appr = _multi_seed_ik(ctx, seed, place_appr_tcp, pick_joints)
        if ik_place_appr is None:
            _abort(
                f'-- PALLET IK FAILED: place_approach for '
                f'[{r_idx},{c_idx},{l_idx}] unreachable at Z='
                f'{place_appr_tcp[2]*1000:.1f}mm — refusing')
            return
        q_place_appr = ik_place_appr[0]
        nm_place_appr = _next_point_name(ctx)
        ctx.varspoint[nm_place_appr] = ctx.make_jp_point(
            q_place_appr, nm_place_appr)
        ctx.used_named.add(nm_place_appr)
        ctx.exec_lines.append(
            f'movL({nm_place_appr})  -- cycle {sl_idx + 1} '
            f'place_approach [{r_idx},{c_idx},{l_idx}] layer {l_idx} '
            f'({place_appr_kind_line}, absolute Z='
            f'{place_appr_tcp[2]*1000:.1f}mm)  '
            f'joints=[{", ".join(f"{v:+.3f}" for v in q_place_appr)}]')
        seed = list(q_place_appr)

        # (7) LINEAR DOWN to place at slot.
        ik_slot = _multi_seed_ik(ctx, seed, slot_m, pick_joints)
        if ik_slot is None:
            _abort(
                f'-- PALLET IK FAILED: slot [{r_idx},{c_idx},{l_idx}] '
                f'place unreachable from approach — refusing')
            return
        q_slot = ik_slot[0]
        nm_slot = _next_point_name(ctx)
        ctx.varspoint[nm_slot] = ctx.make_jp_point(q_slot, nm_slot)
        ctx.used_named.add(nm_slot)
        ctx.exec_lines.append(
            f'movL({nm_slot})  -- slot[{r_idx},{c_idx},{l_idx}] place  '
            f'joints=[{", ".join(f"{v:+.3f}" for v in q_slot)}]  '
            f'(linear-down from approach)')
        seed = list(q_slot)

        # (8) Vacuum OFF (release).
        ctx.exec_lines.append(
            f'setDO({vac_port_do},0)  -- cycle {sl_idx + 1} '
            f'vacuum OFF  (pallet release DO{vac_port_do}=0, '
            f'slot [{r_idx},{c_idx},{l_idx}])')

        # (9) Optional blow-off pulse.
        if blow_port_do is not None and blow_pulse_ms > 0:
            ctx.exec_lines.append(
                f'setDO({blow_port_do},1)  -- cycle {sl_idx + 1} '
                f'blow-off pulse start DO{blow_port_do}=1')
            ctx.exec_lines.append(
                f'wait({blow_pulse_ms})  -- blow-off pulse '
                f'{blow_pulse_ms} ms')
            ctx.exec_lines.append(
                f'setDO({blow_port_do},0)  -- cycle {sl_idx + 1} '
                f'blow-off pulse end DO{blow_port_do}=0')

        # (10) LINEAR UP — retract to place_approach.
        ctx.exec_lines.append(
            f'movL({nm_place_appr})  -- cycle {sl_idx + 1} '
            f'linear-up to place_approach (retract '
            f'{retract_dist_mm:.0f}mm)  '
            f'joints=[{", ".join(f"{v:+.3f}" for v in q_place_appr)}]')

        # (11) Lift back to transit_Z above slot.
        ctx.exec_lines.append(
            f'movL({nm_tslot})  -- cycle {sl_idx + 1} '
            f'lift-to-transit (over slot after release, '
            f'transit_Z={transit_slot_m[2]*1000:.1f}mm)  '
            f'joints=[{", ".join(f"{v:+.3f}" for v in q_tslot)}]')
