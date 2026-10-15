// lib/waypointJunctions.js — the shared waypoint-offer data model.
//
// 2026-10-15 operator directive: the "add a waypoint between positions?"
// offer shipped for pick-place (sha 045432f) must be a SHARED feature
// of the teach sequence, consumed by every wizard — NOT reimplemented
// per surface. This module is the single source of truth for:
//
//   * waypointJunctionsForOperation(answers) — per-op junction list.
//     Each entry is { id, afterKey, fromLabel, toLabel }; the teach
//     sequence interleaves an offer screen after each referenced
//     taught-position key.
//   * readWaypointsForJunction(answers, junctionId) — storage reader
//     (answers.waypoints[junctionId] is an ordered list of
//     operator-taught via-poses).
//   * waypointStepsForJunction(answers, junctionId, defaultSpeed) —
//     codegen emitter that converts taught poses into
//     action:"waypoint" steps for the generated program.
//   * OFFER_INSTR / HONEST_SCOPE_DISCLAIMER — operator-facing copy
//     constants reused by the TeachSequence offer panel.
//
// Any future wizard surface that wants to offer waypoint teaching
// consumes THIS module and provides only its junction list via
// waypointJunctionsForOperation. A fix landed here applies everywhere.
//
// Honest-scope rule (inherited from 08cf555's waypoint step): the arm
// does NOT auto-detect obstacles. These prompts are the operator's
// manual-routing seam — "steer the path around" is the ONLY copy that
// may ship. The pin suite greps this file + ProgramWizard for any
// forbidden copy that would imply the software routes around obstacles
// on its own (see D_shared_waypoint_offer.test.js for the exact
// forbidden-token regexes).

// Per-op junction list. Each junction fires an offer screen AFTER the
// referenced afterKey teach step. Keep lists ordered as they will
// appear in the wizard flow — the teach-sequence interleave preserves
// source order.
//
// Design rules per the 2026-10-15 operator directive:
//   * pick_and_place (default) → full set between main motion endpoints
//   * machine_tend             → one offer at each motion endpoint
//     transition (home / pick / machine_load / unload / return)
//   * sort                     → aliased to pick_and_place since the
//     codegen folds the two sort places onto one place segment
//   * palletize                → EXACTLY ONE offer at pick → pallet
//     approach (route to the pallet around a fixture). NEVER between
//     grid cells (those are computed, not taught — no junction there).
//   * depalletize              → unchanged from 045432f (home → pallet
//     pick, pallet pick → place, place → home) because the operator's
//     directive scoped the single-offer reduction to palletize only.
export function waypointJunctionsForOperation(answers) {
  const op   = (answers && answers.operation) || 'pick_and_place'
  const mode = answers && answers.pallet_mode

  if (op === 'palletize' && mode === 'palletize') {
    // 2026-10-15 operator directive: palletize gets EXACTLY ONE
    // offer, at the pick → pallet-approach seam. The other junctions
    // (home_to_pick, place_to_home) retired for this op — the operator
    // intent is a single via-point for routing to the pallet around a
    // fixture / column. Pallet grid cells are COMPUTED (not taught);
    // no junction appears between them.
    return [
      { id: 'pick_to_place', afterKey: 'taught_pick',
        fromLabel: 'Pick',   toLabel: 'Pallet place' },
    ]
  }
  if (op === 'palletize' && mode === 'depalletize') {
    return [
      { id: 'home_to_pick',  afterKey: 'taught_home',        fromLabel: 'Home',        toLabel: 'Pallet pick'  },
      { id: 'pick_to_place', afterKey: 'taught_pallet_part', fromLabel: 'Pallet pick', toLabel: 'Place'        },
      { id: 'place_to_home', afterKey: 'taught_place',       fromLabel: 'Place',       toLabel: 'Home (return)' },
    ]
  }
  if (op === 'machine_tend') {
    return [
      { id: 'home_to_pick',             afterKey: 'taught_home',         fromLabel: 'Home',         toLabel: 'Pick / Load'    },
      { id: 'pick_to_machine_load',     afterKey: 'taught_pick',         fromLabel: 'Pick',         toLabel: 'Machine load'   },
      { id: 'machine_load_to_unload',   afterKey: 'taught_machine_load', fromLabel: 'Machine load', toLabel: 'Unload'         },
      { id: 'unload_to_home',           afterKey: 'taught_unload',       fromLabel: 'Unload',       toLabel: 'Home (return)'  },
    ]
  }
  if (op === 'sort') {
    // Sort codegen (buildSteps) folds the two sort places onto one
    // place segment, so place_to_home anchors on taught_sort_2 — the
    // operator sees the junction where they expect it.
    return [
      { id: 'home_to_pick',  afterKey: 'taught_home',   fromLabel: 'Home',         toLabel: 'Pick'          },
      { id: 'pick_to_place', afterKey: 'taught_pick',   fromLabel: 'Pick',         toLabel: 'Sort place 1'  },
      { id: 'place_to_home', afterKey: 'taught_sort_2', fromLabel: 'Sort place 2', toLabel: 'Home (return)' },
    ]
  }
  // Default (pick_and_place and any sibling flow with pick + place).
  return [
    { id: 'home_to_pick',  afterKey: 'taught_home',  fromLabel: 'Home',  toLabel: 'Pick'          },
    { id: 'pick_to_place', afterKey: 'taught_pick',  fromLabel: 'Pick',  toLabel: 'Place'         },
    { id: 'place_to_home', afterKey: 'taught_place', fromLabel: 'Place', toLabel: 'Home (return)' },
  ]
}

// Read the taught waypoint pose list for a junction. Returns an array
// of waypoint pose records (each with tcp / joints / taught_at). Safe
// against undefined storage.
export function readWaypointsForJunction(answers, junctionId) {
  if (!answers || typeof answers !== 'object') return []
  const wps = answers.waypoints && answers.waypoints[junctionId]
  if (!Array.isArray(wps)) return []
  return wps.filter((wp) => wp && !wp.skipped
    && (Array.isArray(wp.tcp) || Array.isArray(wp.joints)))
}

// Codegen: convert the taught via-points at a junction into
// action:'waypoint' program steps. One step per taught pose; keeps
// the junction id as audit (waypoint_junction field). Shape matches
// the ProgramEditor's waypoint step (08cf555 TEACHABLE_ACTIONS +
// MOTION_SMOOTHING_ACTIONS already cover 'waypoint' — no editor /
// palette changes needed). Returns [] when no waypoints are taught,
// so existing programs emit byte-identical to the pre-feature shape.
export function waypointStepsForJunction(answers, junctionId, defaultSpeed) {
  const wps = readWaypointsForJunction(answers, junctionId)
  const spd = Number.isFinite(defaultSpeed) ? defaultSpeed : 40
  return wps.map((wp, idx) => {
    const tcp    = Array.isArray(wp.tcp)    ? wp.tcp    : null
    const joints = Array.isArray(wp.joints) ? wp.joints : null
    return {
      action: 'waypoint',
      label: `Waypoint ${idx + 1} (${junctionId})`,
      speed_pct: spd,
      position: tcp ? tcp.slice(0, 3) : null,
      taught: !!(tcp || joints),
      taught_tcp:    tcp,
      taught_joints: joints,
      joints,
      waypoint_junction: junctionId,
    }
  })
}

// Operator-facing copy. Kept as exported constants so a copy change
// lands here once and every surface that consumes the shared module
// picks it up. The honest-scope disclaimer is REQUIRED on every offer
// screen (grep-pinned in both files).
export const HONEST_SCOPE_DISCLAIMER
  = 'Manual routing: you teach the via-point; the arm does not auto-detect obstacles.'

export function offerInstrFor(junction) {
  if (!junction) return HONEST_SCOPE_DISCLAIMER
  return `A waypoint is a point the robot passes through — use it to steer the path around a fixture or obstacle between ${junction.fromLabel} and ${junction.toLabel}. ${HONEST_SCOPE_DISCLAIMER}`
}
