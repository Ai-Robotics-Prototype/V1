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
const _CELL_EOAT_ROLES = Object.freeze(new Set([
  'vacuum', 'magnet', 'blow_off',
]))

// Look up the cell's current valve for the role the step plays.
// Returns the raw controller channel ('DO3') or null when the
// program has no cell binding, the cell entry is absent, or the
// role isn't one we rebind.
function _cellRawForRole(step, program, cell, portmap) {
  const role = String(step?.io_role || '').toLowerCase()
  if (!_CELL_EOAT_ROLES.has(role)) return null
  const eoatId = program?.config?.cell_eoat_id
    || step?.cell_binding?.eoat_id
  if (!eoatId) return null
  const entry = (cell?.eoats || []).find((e) => e.id === eoatId)
  if (!entry) return null
  // Vacuum + magnet live on entry.valve. Blow-off uses a distinct
  // valve on tools that carry one; today's standard vacuum entry
  // has no distinct blow-off slot, so we return null for blow_off
  // and let the row fall back to the stored io_id (operator sees
  // the raw-channel reverse until a blow-off valve lands on the
  // cell record).
  if (role === 'blow_off') return null
  if (!entry.valve) return null
  const raw = rawForSynapse(portmap, entry.valve)
  return raw || null
}

// Primary display resolver. detailLine (and any other step-row
// surface) calls this so the row shows the Synapse name for the
// CELL's current valve when the program is cell-bound, falling
// through to the honest raw-channel reverse-lookup otherwise.
export function displayIoForStep(step, program, cell, portmap) {
  if (!step || !step.io_id) return null
  const cellRaw = _cellRawForRole(step, program, cell, portmap)
  if (cellRaw) {
    return {
      raw: cellRaw,
      display: displayNameForRaw(portmap, cellRaw),
      source: 'cell',
    }
  }
  return {
    raw: step.io_id,
    display: displayNameForRaw(portmap, step.io_id),
    source: 'legacy',
  }
}

// Open-time migration: walk the program and, for each cell-role
// step whose stored io_id disagrees with the cell's current valve,
// rewrite io_id to match. Returns a new program object with the
// patched steps, or the SAME object reference when nothing changed
// (caller uses the identity check to skip a store write).
//
// The migration is DETERMINISTIC and IDEMPOTENT:
//   * Same program + same cell → same output every time.
//   * Running twice on the output of itself is a no-op.
//
// The step's cell_binding is preserved; io_id is the only field
// that changes. If the role has no cell binding to anchor on
// (role not in _CELL_EOAT_ROLES, program has no cell_eoat_id,
// cell entry missing, cell valve missing), the step is left
// verbatim — honest-copy behavior, no silent invention.
export function rebindProgramToCell(program, cell, portmap) {
  if (!program || !Array.isArray(program.steps)) return program
  let changed = false
  const nextSteps = program.steps.map((step) => {
    const cellRaw = _cellRawForRole(step, program, cell, portmap)
    if (!cellRaw) return step
    if (step.io_id === cellRaw) return step
    changed = true
    return { ...step, io_id: cellRaw }
  })
  if (!changed) return program
  return { ...program, steps: nextSteps }
}

// Diagnostic: return the list of steps whose stored io_id disagrees
// with the cell's current valve. Used by pins + any UI that wants
// to surface the mismatch count before migration lands.
export function stepsNeedingRebind(program, cell, portmap) {
  if (!program || !Array.isArray(program.steps)) return []
  const out = []
  for (let i = 0; i < program.steps.length; i++) {
    const step = program.steps[i]
    const cellRaw = _cellRawForRole(step, program, cell, portmap)
    if (!cellRaw) continue
    if (step.io_id === cellRaw) continue
    out.push({ index: i, stored: step.io_id, cell: cellRaw,
               io_role: step.io_role })
  }
  return out
}
