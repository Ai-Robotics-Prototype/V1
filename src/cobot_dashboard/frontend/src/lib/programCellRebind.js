// Program ↔ cell rebind — display + wire alignment for EXISTING
// programs (2026-10-05 operator directive follow-up).
//
// Background: commits 8b02590 (Oct 1) + 7052786 (Oct 5) landed the
// Synapse display path and taught the wizard to emit cell-sourced
// io_ids for NEW programs. EXISTING programs created BEFORE
// 7052786 still carry hardcoded io_ids ('DO2' for vacuum) baked in
// at author time. detailLine honestly reverses DO2 → "Valve 02"
// via the portmap, but that disagrees with the cell's current
// vacuum assignment (e.g. V03). The operator-facing symptom:
// "step 5 shows Valve 02 for a Valve-03 vacuum tool."
//
// This module owns the one place that re-resolves a step's io_id
// against the current cell binding — the display path prefers the
// cell's assignment over the stored raw channel, and the open-time
// migration rewrites stored io_ids so display ↔ wire agree.
//
// RULES:
//
//   displayIoForStep(step, program, cell, portmap):
//     * returns { raw, synapse, display, source } for the IO to
//       show on the step row.
//     * source='cell'    — resolved via program.config.cell_eoat_id
//                          + cell entry's current valve (preferred).
//     * source='legacy'  — fell back to displayNameForRaw(step.io_id).
//     * source='missing' — no io_id and no cell binding to anchor on.
//
//   rebindProgramToCell(program, cell):
//     * pure function; returns a NEW program whose cell-role steps
//       carry io_ids that match the cell's current valve.
//     * returns the SAME object reference when nothing changed, so
//       the caller can cheaply detect no-op loads via identity.
//     * leaves non-cell-role steps alone (set_io without io_role,
//       verify_input, etc. — any step the operator hand-authored
//       stays verbatim).
//
// Scope: EOAT roles (vacuum, magnet, blow_off). Fixture steps
// already carry cell_binding.fixture_id — a later pass can extend
// here when the fixture rebind arrives.

import { rawForSynapse, displayNameForRaw } from './synapsePortmap.js'

// Roles that cell-rebind touches today. Fixture roles are left out
// (fixture steps come from cellActions.compileFixtureAction which
// already consults the entry at compile time).
//
// 2026-10-08: gripper_close + gripper_open added for finger EOATs.
// Their rebind writes io_close / io_open (not io_id) — see
// _CELL_IO_FIELD_FOR_ROLE below.
const _CELL_EOAT_ROLES = Object.freeze(new Set([
  'vacuum', 'magnet', 'blow_off',
  'gripper_close', 'gripper_open',
]))

// Role → the step field whose value is the raw IO channel for the
// role. Vacuum/magnet steps carry `io_id` (set_io shape);
// close_gripper/open_gripper carry `io_close`/`io_open` on the same
// step (two-DO finger shape, or single-valve double-acting shape
// where close == open channel).
const _CELL_IO_FIELD_FOR_ROLE = Object.freeze({
  vacuum:        'io_id',
  magnet:        'io_id',
  blow_off:      'io_id',
  gripper_close: 'io_close',
  gripper_open:  'io_open',
})

// Map io_role → cell EOAT type the role implies. Used to infer a
// cell binding for LEGACY programs that pre-date the cell_eoat_id
// field (pre-7052786 wizard output) but still carry a gripper_type
// in config. When exactly one cell EOAT of that type exists, the
// rebinder treats it as if the operator had bound the program to it.
const _ROLE_TO_EOAT_TYPE = Object.freeze({
  vacuum:        'vacuum',
  magnet:        'magnetic',
  // 2026-10-08 finger: close + open both resolve against a finger
  // EOAT's single valve (actuators[0].valve for double-acting).
  gripper_close: 'finger',
  gripper_open:  'finger',
  // blow_off has no distinct cell entry today — handled downstream.
})

// Resolve the cell EOAT entry a step should bind to. Prefers (in
// order):
//   1. explicit program.config.cell_eoat_id (set by the wizard
//      since 7052786 via ToolFromCellStep).
//   2. step.cell_binding.eoat_id (set by cellActions-compiled
//      primitives + effectorVocab emit path).
//   3. INFERENCE for legacy programs: when the step's io_role maps
//      to an EOAT type AND exactly ONE cell EOAT of that type
//      exists AND the program's config.gripper_type agrees, use
//      that lone entry. The Poopyyy field case: gripper_type=vacuum
//      + exactly one standard:vacuum entry on V03 → infer the
//      binding, display + wire both resolve to V03.
//
// Returns the cell entry object (so callers can read .valve etc)
// or null when no binding can be inferred.
function _resolveCellEntry(step, program, cell) {
  const eoats = (cell && cell.eoats) || []
  const explicitId = program?.config?.cell_eoat_id
    || step?.cell_binding?.eoat_id
  if (explicitId) {
    return eoats.find((e) => e.id === explicitId) || null
  }
  const role = String(step?.io_role || '').toLowerCase()
  const impliedType = _ROLE_TO_EOAT_TYPE[role]
  if (!impliedType) return null
  const programGripType = String(
    program?.config?.gripper_type || '').toLowerCase()
  // Only infer when the program's own gripper_type agrees — don't
  // guess across effector mismatches (a magnet step in a 'finger'
  // program stays legacy).
  if (programGripType && programGripType !== impliedType) return null
  const matches = eoats.filter(
    (e) => String(e.type || '').toLowerCase() === impliedType)
  if (matches.length !== 1) return null   // ambiguous or absent
  return matches[0]
}

// Look up the cell's current valve for the role the step plays.
// Returns the raw controller channel ('DO3') or null when nothing
// to rebind against.
function _cellRawForRole(step, program, cell, portmap) {
  const role = String(step?.io_role || '').toLowerCase()
  if (!_CELL_EOAT_ROLES.has(role)) return null
  // Blow-off uses a distinct valve on tools that carry one; today's
  // standard vacuum entry has no distinct blow-off slot, so we
  // return null for blow_off and let the row fall back to the
  // stored io_id (operator sees the raw-channel reverse until a
  // blow-off valve lands on the cell record).
  if (role === 'blow_off') return null
  const entry = _resolveCellEntry(step, program, cell)
  if (!entry || !entry.valve) return null
  const raw = rawForSynapse(portmap, entry.valve)
  return raw || null
}

// The IO value currently carried on the step for this role. For
// vacuum/magnet/blow_off that's `step.io_id`; for the two gripper
// roles it's `step.io_close` / `step.io_open`.
function _storedIoForRole(step) {
  const role = String(step?.io_role || '').toLowerCase()
  const field = _CELL_IO_FIELD_FOR_ROLE[role]
  if (!field) return step?.io_id || null
  return step?.[field] || null
}

// Primary display resolver. detailLine (and any other step-row
// surface) calls this so the row shows the Synapse name for the
// CELL's current valve when the program is cell-bound, falling
// through to the honest raw-channel reverse-lookup otherwise.
export function displayIoForStep(step, program, cell, portmap) {
  if (!step) return null
  const stored = _storedIoForRole(step)
  if (!stored) return null
  const cellRaw = _cellRawForRole(step, program, cell, portmap)
  if (cellRaw) {
    return {
      raw: cellRaw,
      display: displayNameForRaw(portmap, cellRaw),
      source: 'cell',
    }
  }
  return {
    raw: stored,
    display: displayNameForRaw(portmap, stored),
    source: 'legacy',
  }
}

// Open-time migration: walk the program and, for each cell-role
// step whose stored IO disagrees with the cell's current valve,
// rewrite it to match. Returns a new program object with the
// patched steps, or the SAME object reference when nothing changed
// (caller uses the identity check to skip a store write).
//
// The migration is DETERMINISTIC and IDEMPOTENT:
//   * Same program + same cell → same output every time.
//   * Running twice on the output of itself is a no-op.
//
// The step's cell_binding is preserved; only the role-specific IO
// field changes (io_id for vacuum/magnet; io_close/io_open for the
// finger roles). If the role has no cell binding to anchor on
// (role not in _CELL_EOAT_ROLES, program has no cell_eoat_id,
// cell entry missing, cell valve missing), the step is left
// verbatim — honest-copy behavior, no silent invention.
export function rebindProgramToCell(program, cell, portmap) {
  if (!program || !Array.isArray(program.steps)) return program
  let changed = false
  const nextSteps = program.steps.map((step) => {
    const cellRaw = _cellRawForRole(step, program, cell, portmap)
    if (!cellRaw) return step
    const role = String(step.io_role || '').toLowerCase()
    const field = _CELL_IO_FIELD_FOR_ROLE[role] || 'io_id'
    if (step[field] === cellRaw) return step
    changed = true
    return { ...step, [field]: cellRaw }
  })
  if (!changed) return program
  return { ...program, steps: nextSteps }
}

// Diagnostic: return the list of steps whose stored IO disagrees
// with the cell's current valve. Used by pins + any UI that wants
// to surface the mismatch count before migration lands.
export function stepsNeedingRebind(program, cell, portmap) {
  if (!program || !Array.isArray(program.steps)) return []
  const out = []
  for (let i = 0; i < program.steps.length; i++) {
    const step = program.steps[i]
    const cellRaw = _cellRawForRole(step, program, cell, portmap)
    if (!cellRaw) continue
    const role = String(step.io_role || '').toLowerCase()
    const field = _CELL_IO_FIELD_FOR_ROLE[role] || 'io_id'
    if (step[field] === cellRaw) continue
    out.push({ index: i, stored: step[field], cell: cellRaw,
               io_role: step.io_role, field })
  }
  return out
}
