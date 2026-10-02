// Single-source-of-truth resolver for program-level truths every
// frontend surface needs to render honestly:
//
//   * isStepTaught(step, program) — step-by-step MIRROR of the
//     backend's dashboard_server._has_taught_poses per-step rule.
//     Every taught-count in the UI (Editor's "N untaught", Run
//     modal's "N taught / M total", Monitor's runnable-check)
//     imports this so all three agree with each other AND with
//     what codegen accepts.
//
//   * runnableStepCount(program) — count of runnable steps under
//     the same rules.
//
//   * hasFullTaughtPose(step, program) — stricter version used by
//     "View position data" toggles: true only when the step has a
//     6-element pose that would round-trip through codegen.
//
// LOAD-BEARING: today's 5 UI-truth incidents (see docs/
// ui_truth_audit.md) were all instances of this exact class of
// bug — the frontend re-derived what the backend was already
// deriving. This module is the anti-fork counter-measure. See
// scripts/no-fork-truth.mjs for the CI rule that keeps new code
// from forking again.

// Kept in sync with dashboard_server._NON_MOTION_ACTIONS.
// Add a new action here AND to the backend set in the same commit.
// The eslint rule at scripts/no-fork-truth.mjs treats this constant
// as authoritative — no component may hardcode a competing list.
//
// 2026-07-31: `detect` + scan family + move_to_pallet were added
// after the operator caught detect showing up in a Teach All
// itinerary. They're camera / config-driven verbs that carry no
// per-step pose and MUST NOT prompt "record a position". See
// isTeachable() below — the itinerary is now gated on the same
// allow-list predicate the row-level Teach button uses.
export const NON_MOTION_ACTIONS = new Set([
  'set_io', 'wait', 'wait_input', 'loop', 'gripper',
  'gripper_close', 'gripper_open', 'pause', 'comment', 'end',
  'vacuum_on', 'vacuum_off',
  'detect',
  'scan_workspace', 'scan_identify_each', 'sort_scanned', 'remove_defects',
  'move_to_pallet',
])

// Pose-bearing actions — the operator teaches a position for these.
// Anything NOT in this set skips the teach flow entirely (whether
// it's non-motion like `wait` or config-driven like `move_to_pallet`).
// Both the step-row Teach button AND the itinerary builder MUST
// consult isTeachable(); that's the anti-fork invariant §396's
// itinerary-audit surfaced.
export const TEACHABLE_ACTIONS = new Set([
  'move_home', 'move_joint', 'move_linear',
  'approach',  'pick',       'place',
])

// A derived offset move (descend / lift / retreat / "approach
// finished part") computes its target at runtime as
//   <source taught_tcp> + Z offset
// The operator never teaches it directly. Explicit `derived_from`
// tag is the new shape emitted by the wizard; the offset_z_mm
// heuristic covers older saved programs that were generated before
// the tag existed (their descend/lift had offset_z_mm set and no
// taught data of their own, which uniquely identifies them as
// wizard-derived).
//
// Override semantics: a derived step can be manually overridden by
// the operator (`overridden: true` + its own taught_tcp). Once
// overridden, we stop treating it as auto-derived so the editor
// exposes pose inputs and the Teach button works directly.
export function isDerivedOffsetMove(step) {
  if (!step) return false
  if (step.overridden) return false
  if (step.derived_from) return true
  const isMoveLinear = step.action === 'move_linear' || step.type === 'move'
  if (!isMoveLinear) return false
  if (step.offset_z_mm === undefined || step.offset_z_mm === null) return false
  const hasJoints = Array.isArray(step.taught_joints) && step.taught_joints.length >= 6
  const hasTcp    = Array.isArray(step.taught_tcp)    && step.taught_tcp.length    >= 3
  return !hasJoints && !hasTcp
}

// True when the operator can (and must) teach a pose for `step`.
// Row-level Teach buttons + badges consult this; so does the
// Teach All itinerary builder. Same predicate, same result — no
// forks. Exclusions:
//   * derived offset moves (resolve at runtime from a source)
//   * position-reference links (inherit from another step)
//   * later move_home steps (share the first home's pose by
//     wizard convention — checked only when `program` is given)
//   * anything whose action isn't in TEACHABLE_ACTIONS
//
// The optional `program` argument is what enables the last two
// checks. Callers that lack context (unit tests, migrations) can
// omit it and get the step-local answer.
export function isTeachable(step, program) {
  if (!step) return false
  if (isDerivedOffsetMove(step)) return false
  if (step.position_ref != null) return false
  const action = String(step.action || '').toLowerCase()
  if (!action) {
    // Legacy type-only records: cannot disambiguate (type='move'
    // covers move_linear, detect, scan_*, move_to_pallet, …) so we
    // conservatively return false. Callers that need to teach a
    // legacy record can round-trip it through the editor to get an
    // explicit action written.
    return false
  }
  if (!TEACHABLE_ACTIONS.has(action)) return false
  // Auto-share home — any move_home AFTER the first move_home in
  // the program inherits from the first (this is the wizard's
  // "share home pose across cycle start + end" intent, made
  // authoritative in the resolver rather than requiring the
  // operator to click "Use Step N home position" every time).
  // Overridden flag lets the operator break the share when they
  // want an independent pose.
  if (action === 'move_home' && program && Array.isArray(program.steps)) {
    if (step.overridden) return true
    const firstHomeIdx = program.steps.findIndex(
      (s) => s && String(s.action || '').toLowerCase() === 'move_home')
    if (firstHomeIdx >= 0) {
      // Locate by object identity first (safest), then by id.
      const myIdx = program.steps.indexOf(step)
      const myIdxById = (myIdx < 0 && step.id != null)
        ? program.steps.findIndex((s) => s && s.id === step.id)
        : myIdx
      if (myIdxById > firstHomeIdx) return false
    }
  }
  return true
}

// Roles that count as "station" anchors — a step with position_role
// in this set AND 6-el taught_joints AND taught:true becomes a source
// that any derived_from=<role> step can inherit. Home is intentionally
// excluded (matches backend — home is a transit anchor, not a station).
function _collectTaughtRoles(steps) {
  const out = new Set()
  for (const s of (steps || [])) {
    if (!s) continue
    const role = s.position_role
    if (!role || String(role).toLowerCase() === 'home') continue
    const j = s.taught_joints
    if (Array.isArray(j) && j.length === 6
        && j.every((v) => typeof v === 'number')
        && s.taught === true) {
      out.add(role)
    }
  }
  return out
}

// Mirror of dashboard_server._has_taught_poses's per-step logic —
// returns TRUE when the step is runnable / taught, FALSE when the
// operator still needs to teach it. `program` provides the points
// table and the sibling-steps context that derived_from lookup needs.
//
// 2026-07-31 unification: anything the row wouldn't offer a Teach
// button on (isTeachable === false) trivially returns TRUE here —
// non-motion, config-driven, and derived/linked steps aren't
// "untaught", they don't take a pose. This closes the itinerary
// fork that put `detect` in a Teach All queue (§396 audit).
export function isStepTaught(step, program) {
  if (!step) return false
  // Fast path: if the operator can't teach this step in the
  // context of the program (including the "later move_home shares
  // the first" rule), it's not a gap. Covers non-motion actions,
  // derived offset moves, position-ref links, later home steps,
  // and anything without a teachable action.
  if (!isTeachable(step, program)) return true

  const points = (program && program.points) || {}
  const pn = step.point_name
  if (pn && points[pn]) {
    const j = points[pn].joints
    if (Array.isArray(j) && j.length === 6) return true
  }
  const tj = step.taught_joints
  if (Array.isArray(tj) && tj.length === 6 && step.taught === true) {
    return true
  }
  const df = step.derived_from
  if (df) {
    const taughtRoles = _collectTaughtRoles(program && program.steps)
    if (taughtRoles.has(df)) return true
  }
  return false
}

// True iff EVERY step in `program` is taught/runnable under the
// backend rule. Cheap to call; still computes the taught-roles set
// once per invocation via isStepTaught below.
export function isProgramFullyRunnable(program) {
  const steps = (program && program.steps) || []
  if (steps.length === 0) return false
  for (const s of steps) if (!isStepTaught(s, program)) return false
  return true
}

// Count of runnable steps — used by Run/Monitor to decide whether
// the Run button surfaces or greys out.
export function runnableStepCount(program) {
  const steps = (program && program.steps) || []
  return steps.filter((s) => isStepTaught(s, program)).length
}

// Ids of steps the operator still needs to teach. Editor's teach-all
// action uses this to build its work queue.
export function untaughtStepIds(program) {
  const steps = (program && program.steps) || []
  return steps.filter((s) => !isStepTaught(s, program))
               .map((s) => s.id)
}

// Stricter form for the "View position data" drawer. Only a 6-el
// joints array OR a 6-el TCP counts as a fully-teachable pose. A
// partial array (< 6) is malformed and shouldn't render as "position
// data" — that fooled operators into thinking a bad teach had
// captured something.
export function hasFullTaughtPose(step) {
  if (!step) return false
  const tj = step.taught_joints
  if (Array.isArray(tj) && tj.length === 6) return true
  const tt = step.taught_tcp
  if (Array.isArray(tt) && tt.length >= 6) return true
  const j  = step.joints
  if (Array.isArray(j) && j.length === 6) return true
  return false
}

// Pallet 4-point taught frame — read-only status for the edit
// modal's frame indicator. Mirrors backend
// PalletPlaceSpec.has_taught_frame + has_taught_part_datum, plus
// the pallet_slots endpoint's v1→v2 migration.
//
// Returns { corner1, corner2, corner3, part, allTaught,
//           migratedFromV1 } — booleans per point + convenience
// flags. The v2 wire fields are `corner1_tcp` / `corner2_tcp` /
// `corner3_tcp` / `part_tcp`; the migration reads v1's
// `corner_a_tcp` / `point_b_tcp` / `point_c_tcp` (or the even-
// older `config.pallet.corner_tcp` dict) and lights up the
// migratedFromV1 flag so the UI shows "re-teach ④" instead of
// pretending the part datum is real.
export function palletFrameStatus(program) {
  const cfg = (program && program.config) || {}
  const place = cfg.pallet_place || {}
  const pallet = cfg.pallet || {}
  const hasArr6 = (v) => Array.isArray(v) && v.length >= 6
  const legacyCornerDict = pallet.corner_tcp
  // 2026-07-31: require at least one non-zero coordinate. The wizard
  // historically emitted `corner_tcp: {x:0, y:0, z:0, ...}` as a
  // placeholder for programs that hadn't been through the corner
  // teach yet — treating that as "taught" mis-reports the frame and
  // hides ①②③ from the itinerary. A real teach at the base-frame
  // origin is impossible (that point is inside the robot column),
  // so {0,0,0} is unambiguously un-set.
  const legacyHasXyz = !!(legacyCornerDict
    && typeof legacyCornerDict === 'object'
    && ['x','y','z'].every((k) => Number.isFinite(Number(legacyCornerDict[k])))
    && ['x','y','z'].some((k) => Number(legacyCornerDict[k]) !== 0))
  // v2 fields — canonical.
  const v2C1 = hasArr6(place.corner1_tcp)
  const v2C2 = hasArr6(place.corner2_tcp)
  const v2C3 = hasArr6(place.corner3_tcp)
  const v2P  = hasArr6(place.part_tcp)
  // v1 fallback — corner1/2/3 fill from v1's a/b/c; part fills
  // from a (with the migration flag set so the UI nudges).
  const v1A = hasArr6(place.corner_a_tcp)
  const v1B = hasArr6(place.point_b_tcp)
  const v1C = hasArr6(place.point_c_tcp)
  const migratedFromV1 = !v2C1 && !v2P && (v1A || legacyHasXyz)
  const corner1 = v2C1 || v1A || legacyHasXyz
  const corner2 = v2C2 || v1B
  const corner3 = v2C3 || v1C
  // Part is "truly taught" ONLY when v2P is present AND (either
  // no migration OR the part TCP differs from corner1 by any
  // measurable amount — matches PalletPlaceSpec.has_taught_part_datum).
  // For simplicity in the modal indicator, treat "part_tcp present
  // AND source is v2" as taught; migration path shows part=false
  // so the operator sees the ○.
  const part = v2P && !migratedFromV1
  return {
    corner1: !!corner1,
    corner2: !!corner2,
    corner3: !!corner3,
    part:    !!part,
    allTaught:      !!(corner1 && corner2 && corner3 && part),
    migratedFromV1: !!migratedFromV1,
  }
}


// Mid-flow entry point for the pallet Teach button. Returns the first
// untaught frame role in canonical order (①②③④) so re-entering a
// partially-taught flow resumes where the operator left off instead of
// restarting at ①. Returns null when every point is taught — callers
// should treat that as "Re-teach from ①" and start at 'pallet_c1'.
export const PALLET_ROLE_ORDER = ['pallet_c1', 'pallet_c2', 'pallet_c3', 'pallet_part']

export function firstUntaughtPalletRole(program) {
  const st = palletFrameStatus(program)
  if (!st.corner1) return 'pallet_c1'
  if (!st.corner2) return 'pallet_c2'
  if (!st.corner3) return 'pallet_c3'
  if (!st.part)    return 'pallet_part'
  return null
}


// Codegen may emit a different verb than the step's action implies.
// This resolver names the AUTHORITATIVE mapping — approach arrivals
// under the columns-cartesian invariant, retreats forced to movJ by
// design, wrist-lock fallbacks, and the analyzer's awkward_wrist_
// transit exception all diverge from step.action.
//
// Preferred source: the backend's per-step verb table (populated
// during the most recent codegen, exposed as `program.emitted_verbs`
// on GET /api/programs/{id}). Falls back to the "expected" verb from
// step.action for programs that haven't been codegen'd yet, with an
// explicit `expected` flag so the caller can distinguish a live truth
// from an educated guess.
export function verbForStep(program, stepIdx) {
  const emitted = program && program.emitted_verbs
  if (Array.isArray(emitted) && emitted[stepIdx]) {
    const e = emitted[stepIdx]
    return { verb: e.verb, expected: false, reason: e.reason || '' }
  }
  const step = (program && program.steps && program.steps[stepIdx]) || null
  if (!step) return { verb: null, expected: true, reason: '' }
  const action = String(step.action || '').toLowerCase()
  if (action === 'move_home')   return { verb: 'movJ', expected: true, reason: '' }
  if (action === 'move_linear') return { verb: 'movL', expected: true, reason: '' }
  if (action === 'move_joint')  return { verb: 'movJ', expected: true, reason: '' }
  return { verb: null, expected: true, reason: '' }
}
