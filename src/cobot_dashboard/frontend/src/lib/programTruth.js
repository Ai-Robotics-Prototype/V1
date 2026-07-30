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
export const NON_MOTION_ACTIONS = new Set([
  'set_io', 'wait', 'wait_input', 'loop', 'gripper',
  'gripper_close', 'gripper_open', 'pause', 'comment', 'end',
  'vacuum_on', 'vacuum_off',
])

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
export function isStepTaught(step, program) {
  if (!step) return false
  // Legacy gripper marker — never a motion step, always OK.
  if (step.type === 'gripper') return true
  const action = String(step.action || '').toLowerCase()
  if (NON_MOTION_ACTIONS.has(action)) return true

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

// Pallet 3-point taught frame — read-only status for the edit
// modal's frame indicator. Mirrors the backend's PalletPlaceSpec.
// has_taught_frame + the pallet_slots endpoint's legacy corner_tcp
// → corner_a_tcp migration, so a legacy program (pre-2026-07-30)
// renders "A taught" from its already-captured single corner.
//
// Returns { cornerA, pointB, pointC, allTaught } — booleans per
// point + a convenience flag for the whole frame. Reads from
// program.config.pallet_place (canonical) with a fallback to
// program.config.pallet.corner_tcp (legacy dict shape).
export function palletFrameStatus(program) {
  const cfg = (program && program.config) || {}
  const place = cfg.pallet_place || {}
  const pallet = cfg.pallet || {}
  const hasArr6 = (v) => Array.isArray(v) && v.length >= 6
  const legacyCorner = pallet.corner_tcp
  const legacyHasXyz = !!(legacyCorner && typeof legacyCorner === 'object'
    && ['x','y','z'].every((k) => Number.isFinite(Number(legacyCorner[k]))))
  const cornerA = !!(hasArr6(place.corner_a_tcp) || legacyHasXyz)
  const pointB  = hasArr6(place.point_b_tcp)
  const pointC  = hasArr6(place.point_c_tcp)
  return { cornerA, pointB, pointC, allTaught: cornerA && pointB && pointC }
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
