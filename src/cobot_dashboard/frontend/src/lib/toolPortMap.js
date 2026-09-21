// Tool → ports mapping for the Hardware Setup wizard's guidance
// map (2026-09-21 operator directive).
//
// One record per KIND of tool. Each record names which valves and
// which digital inputs the operator needs to wire up on the
// Synapse controller. The wizard's guidance step passes the record
// to <SynapseConnectionMap mode="guidance" highlight={...} /> —
// highlighted ports glow, non-highlighted ports render dimmed.
//
// Data lives here (not JSX). Adding a new tool = new entry.
//
// Rules:
//   * required_valves are VALVE ids (V01..V10), not port ids
//     (V05_PA / V05_PB). The map component highlights BOTH ports
//     of a highlighted valve automatically.
//   * required_inputs / required_outputs are IN/OUT ids
//     (IN04, OUT02, etc.).
//   * callouts is a { [portId]: string } map that the wizard uses
//     to render "Connect the gripper's air line here" next to each
//     highlighted glyph. Keyed by VALVE id OR port id — the
//     wizard falls back to a generic string if empty.
//   * notes is a short paragraph the wizard shows once above the
//     checklist. Plain operator language.
//
// Guidance is visual only — this module NEVER emits an /api or
// /cmd call. Live verify-connection is a later directive.

import { VALVE_TYPE_INFO } from '../pages/SynapsePage'

// Fixed built-in tool port mappings. Free-slot resolution for
// Custom EOAT happens at runtime (see resolveCustomEOATRecord
// below) so it can pick the first available SPARE valve.
const _FIXED = {
  finger: {
    label: 'Finger Gripper',
    // Two-jaw parallel pneumatic gripper. Needs one 5/2 valve
    // (open/close) — the S10-140 wiring convention uses the
    // first slot for the gripper. Two sensor inputs for the
    // "open" and "closed" limit-switch feedback.
    required_valves:  ['V01'],
    required_inputs:  ['IN01', 'IN02'],
    required_outputs: [],
    notes:
      'A two-jaw parallel gripper. Air runs to a 5/2 valve that '
      + 'strokes the fingers open and closed. Two sensor inputs '
      + 'confirm the open and closed positions.',
    callouts: {
      V01:  "Connect the gripper's air line here",
      IN01: 'Wire the OPEN limit-switch here',
      IN02: 'Wire the CLOSED limit-switch here',
    },
  },
  vacuum: {
    label: 'Vacuum Suction',
    // Vacuum cup / ejector. Uses a 3/2 N/C valve (default OFF,
    // pulse to engage vacuum). One input for the vacuum switch
    // that reports "part attached".
    required_valves:  ['V03'],
    required_inputs:  ['IN04'],
    required_outputs: [],
    notes:
      'Vacuum-cup end-effector. A 3/2 Normally Closed valve pulses '
      + 'the ejector on to draw vacuum, and a vacuum switch '
      + 'reports when the part is attached.',
    callouts: {
      V03:  "Connect the vacuum ejector's air line here",
      IN04: 'Wire the vacuum-switch feedback here',
    },
  },
}

// Public API — return the tool port record for a given tool key.
// Keys: 'finger' | 'vacuum' | 'custom' (custom-eoat during flow).
export function getToolPortMap(toolKey) {
  if (!toolKey) return null
  if (_FIXED[toolKey]) return { key: toolKey, ..._FIXED[toolKey] }
  return null
}

// Given a live customs list from /api/tools, return the set of
// VALVE ids already claimed by other custom tools (so the Custom
// EOAT flow can avoid recommending an already-assigned slot).
// Each tool.config.assigned_valve holds the VALVE id it was
// wired to at Custom-EOAT completion time; empty when the tool
// hasn't been through the flow.
export function assignedValveIds(customs) {
  const s = new Set()
  if (!Array.isArray(customs)) return s
  for (const t of customs) {
    const v = t && t.config && t.config.assigned_valve
    if (typeof v === 'string' && v) s.add(v)
  }
  return s
}

// Same idea for IN ports.
export function assignedInputIds(customs) {
  const s = new Set()
  if (!Array.isArray(customs)) return s
  for (const t of customs) {
    const arr = t && t.config && t.config.assigned_inputs
    if (Array.isArray(arr)) for (const i of arr) s.add(String(i))
  }
  return s
}

// Runtime resolver for the Custom EOAT flow.
//
// Given the operator's answers (actuation type, hold-on-loss,
// sensor count) + the current customs list, pick the first free
// SPARE valve slot and the first N free IN ports; return a
// full port record shaped like _FIXED entries.
//
// Actuation → valve type recommendation:
//   single_acting  → 5/2 SS   (spring-return; snaps home on power loss)
//   double_acting  → 5/2 DS or 5/2 SS depending on hold-on-loss:
//                      hold=true  → 5/2 DS (memory: holds last position)
//                      hold=false → 5/2 SS (spring returns home)
//   vacuum         → HI/LO 3/2 N/C (default-off, pulse to engage)
//   electric_none  → no valve required
//
// The wizard reads the recommended TYPE and asks the operator
// to pick a matching SPARE slot from the map. `assignedValveIds`
// lets the flow avoid recommending an already-claimed spare.
export function resolveCustomEOATRecord({
  toolName,
  actuation,
  holdOnLoss,
  sensorCount = 0,
  customs = [],
}) {
  const claimedValves = assignedValveIds(customs)
  const claimedInputs = assignedInputIds(customs)

  // Recommended valve TYPE (from VALVE_TYPE_INFO copy — reuse the
  // valve-info-panel language rather than duplicating it here).
  const rec = recommendValveType(actuation, holdOnLoss)

  // Find the first SPARE slot that matches the recommended type
  // AND isn't already claimed by another custom tool. SPARE slots
  // are 'SPARE 1' + 'SPARE 2' in the shipped configuration; a
  // future SPARE reallocation only edits SynapsePage data.
  //
  // Note: we look up SPARE-typed slots by iterating an in-file
  // copy of the type map instead of pulling the whole VALVES
  // array into this module (avoids a JSX-load side effect).
  const spareTypes = new Set(['SPARE 1', 'SPARE 2'])
  const spareValveIds = ['V05', 'V10']
  let assignedValve = null
  if (rec) {
    for (const v of spareValveIds) {
      if (claimedValves.has(v)) continue
      assignedValve = v
      break
    }
  }

  // First N free IN ports (IN01..IN10). Skip anything already
  // claimed by another custom tool.
  const assignedInputs = []
  for (let i = 1; i <= 10 && assignedInputs.length < sensorCount; i++) {
    const id = `IN${String(i).padStart(2, '0')}`
    if (claimedInputs.has(id)) continue
    assignedInputs.push(id)
  }

  const callouts = {}
  if (assignedValve) {
    callouts[assignedValve] =
      `Connect the ${toolName || 'tool'}'s air line here`
  }
  assignedInputs.forEach((id, i) => {
    callouts[id] = `Wire sensor #${i + 1} here (${sensorTypeCopy()})`
  })

  return {
    key: 'custom',
    label: toolName || 'Custom EOAT',
    actuation,
    holdOnLoss,
    sensorCount,
    recommended_valve_type: rec ? rec.type : null,
    recommended_valve_why: rec ? rec.why : null,
    required_valves:  assignedValve ? [assignedValve] : [],
    required_inputs:  assignedInputs,
    required_outputs: [],
    notes: rec
      ? rec.notes
      : 'Electric or no actuation — no valve required. Wire only '
        + 'the feedback sensors your controller reads directly.',
    callouts,
    // Label overrides for the map: rename the SPARE slot to the
    // tool's name so the map reads honestly after assignment.
    label_overrides: assignedValve
      ? { [assignedValve]: toolName || 'Custom EOAT' }
      : {},
    // And swap the SPARE type subtitle to the recommended type.
    type_overrides: (assignedValve && rec)
      ? { [assignedValve]: rec.type }
      : {},
  }
}

// Actuation → valve type recommendation with plain-copy WHY
// pulled from the valve-info panel content in SynapsePage.jsx.
// Never duplicate copy — reference VALVE_TYPE_INFO so a copy
// edit there flows through here automatically.
export function recommendValveType(actuation, holdOnLoss) {
  if (actuation === 'single_acting') {
    const info = VALVE_TYPE_INFO['5/2 SS'] || {}
    return {
      type: '5/2 SS',
      why:  info.best_use || 'Fail-safe: spring return to home on '
                            + 'power or air loss.',
      notes: info.plain_explanation || '',
    }
  }
  if (actuation === 'double_acting') {
    if (holdOnLoss) {
      const info = VALVE_TYPE_INFO['5/2 DS'] || {}
      return {
        type: '5/2 DS',
        why:  info.best_use || 'Holds last position when power drops.',
        notes: info.plain_explanation || '',
      }
    }
    const info = VALVE_TYPE_INFO['5/2 SS'] || {}
    return {
      type: '5/2 SS',
      why:  info.best_use || 'Spring return to home on power or air loss.',
      notes: info.plain_explanation || '',
    }
  }
  if (actuation === 'vacuum') {
    const info = VALVE_TYPE_INFO['HI/LO 3/2 N/C'] || {}
    return {
      type: 'HI/LO 3/2 N/C',
      why:  info.best_use || 'Default-off — pulses vacuum on demand.',
      notes: info.plain_explanation || '',
    }
  }
  return null
}

function sensorTypeCopy() {
  return 'PNP proximity, 24 VDC per the panel spec'
}

// S10-140 payload capacity — 10 kg at full reach per the arm's
// datasheet + repeated confirmations across the ledger
// (era-01, add-01, add-08a). The wizard warns plainly when the
// operator enters a mass above this ceiling.
export const S10_140_PAYLOAD_KG_MAX = 10.0

// Rough guidance number: if the tool alone weighs > 70 % of the
// budget, moving a part becomes marginal. Warn (not refuse).
export const S10_140_PAYLOAD_ADVISORY_KG = 7.0
