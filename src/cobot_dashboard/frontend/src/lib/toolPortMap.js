// Tool → ports mapping for the EOAT Setup wizard's guidance
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

// Persisted-custom-tool guidance: build a port record from a saved
// tool row's operator-assigned valve + input ports.
//
// A tool that finished the Custom EOAT flow carries
// `config.assigned_valve` (string like 'V05') and
// `config.assigned_inputs` (array of 'IN01'…'IN10'). Missing or
// empty fields → return null so the wizard renders the
// "finish your tool definition" notice instead of a blank map.
//
// Multi-actuator extension (2026-10-01 operator directive): a tool
// may carry `config.actuators = [{ type, hold_on_loss, valve, label? }]`.
// When present, EACH actuator contributes a valve to required_valves;
// callouts name the actuator so the operator knows which coil they
// are wiring. Legacy single-valve records are STILL honoured — their
// `assigned_valve` field flows through unchanged for backward compat.
export function resolvePersistedCustomToolPortMap(tool) {
  if (!tool || !tool.config) return null
  const name = tool.name || 'Custom EOAT'
  const cfg = tool.config
  const actuators = Array.isArray(cfg.actuators)
    ? cfg.actuators.filter((a) => a && typeof a.valve === 'string' && a.valve)
    : []
  const inputs = Array.isArray(cfg.assigned_inputs)
    ? cfg.assigned_inputs.filter((s) => typeof s === 'string' && s)
    : []
  // Legacy fallback: no actuators[] but assigned_valve set.
  let valves = actuators.map((a) => a.valve)
  if (valves.length === 0 && typeof cfg.assigned_valve === 'string'
      && cfg.assigned_valve.length > 0) {
    valves = [cfg.assigned_valve]
  }
  if (valves.length === 0 && inputs.length === 0) return null
  const callouts = {}
  const labelOverrides = {}
  if (actuators.length > 0) {
    actuators.forEach((a, i) => {
      const actLabel = a.label
        || _defaultActuatorLabel(a.type, i, actuators.length)
      callouts[a.valve] =
        `Connect ${name}'s ${actLabel} air line to ${a.valve}`
      labelOverrides[a.valve] = actuators.length > 1
        ? `${name} — ${actLabel}` : name
    })
  } else if (valves.length === 1) {
    callouts[valves[0]] = `Connect ${name}'s air line to ${valves[0]}`
    labelOverrides[valves[0]] = name
  }
  inputs.forEach((id, i) => {
    callouts[id] = `Wire ${name}'s sensor #${i + 1} to ${id}`
  })
  return {
    key: `custom:${tool.id}`,
    label: name,
    required_valves:  valves,
    required_inputs:  inputs,
    required_outputs: [],
    notes:
      `Wire ${name} per the assignments recorded when it was set `
      + 'up in the Custom EOAT flow.',
    callouts,
    label_overrides: labelOverrides,
  }
}

function _defaultActuatorLabel(type, idx, total) {
  if (total === 1) return 'actuator'
  if (type === 'vacuum') return 'vacuum'
  if (type === 'single_acting') return `actuator ${idx + 1} (single-acting)`
  if (type === 'double_acting') return `actuator ${idx + 1} (double-acting)`
  return `actuator ${idx + 1}`
}

// Given a live customs list from /api/tools, return the set of
// VALVE ids already claimed by other custom tools (so the Custom
// EOAT flow can avoid recommending an already-assigned slot).
// Each tool.config.assigned_valve holds the VALVE id it was
// wired to at Custom-EOAT completion time; empty when the tool
// hasn't been through the flow. Multi-actuator tools contribute
// EVERY valve in config.actuators[*].valve.
export function assignedValveIds(customs) {
  const s = new Set()
  if (!Array.isArray(customs)) return s
  for (const t of customs) {
    const cfg = t && t.config
    if (!cfg) continue
    if (typeof cfg.assigned_valve === 'string' && cfg.assigned_valve) {
      s.add(cfg.assigned_valve)
    }
    if (Array.isArray(cfg.actuators)) {
      for (const a of cfg.actuators) {
        if (a && typeof a.valve === 'string' && a.valve) s.add(a.valve)
      }
    }
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
// Multi-actuator extension (2026-10-01 operator directive): the
// `actuators` parameter is an array of { type, holdOnLoss?, label? }.
// Each actuator gets its OWN free SPARE valve; recommend type lookup
// runs per-actuator. The map callouts name the actuator so the
// operator sees "Connect <tool>'s blow-off air line to V10", etc.
//
// Legacy single-actuation callers (actuation + holdOnLoss at top
// level) still work — they collapse to actuators=[{type: actuation,
// holdOnLoss}]. The returned record exposes both shapes:
//   * required_valves (N ids) — union across all actuators
//   * actuators[]        — [{ type, hold_on_loss, valve, label,
//                            recommended_valve_type, why }]
//   * recommended_valve_type / recommended_valve_why — FIRST
//     actuator's values, kept for legacy single-actuator surfaces.
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
  actuators,
  sensorCount = 0,
  customs = [],
}) {
  const claimedValves = assignedValveIds(customs)
  const claimedInputs = assignedInputIds(customs)

  // Normalize to actuators[] shape. Legacy callers pass a single
  // actuation + holdOnLoss; new callers pass actuators[].
  let acts = Array.isArray(actuators) && actuators.length > 0
    ? actuators
    : (actuation
         ? [{ type: actuation, holdOnLoss }]
         : [])

  // Valves available for new allocation — SPARE slots that no OTHER
  // custom tool has claimed. The flow walks actuators in order and
  // assigns the next free SPARE to each electric-less actuator.
  const spareValveIds = ['V05', 'V10']
  const freeSpares = spareValveIds.filter((v) => !claimedValves.has(v))

  let spareCursor = 0
  const resolvedActuators = acts.map((a, i) => {
    const type = a.type
    const hold = a.holdOnLoss ?? a.hold_on_loss
    const rec = recommendValveType(type, hold)
    const valve = rec ? (freeSpares[spareCursor++] || null) : null
    const label = a.label
      || _defaultActuatorLabel(type, i, acts.length)
    return {
      type,
      hold_on_loss: hold ?? null,
      valve,
      label,
      recommended_valve_type: rec ? rec.type : null,
      recommended_valve_why:  rec ? rec.why  : null,
      notes: rec ? rec.notes : null,
    }
  })

  const required_valves = resolvedActuators
    .map((a) => a.valve).filter(Boolean)

  // First N free IN ports (IN01..IN10). Skip anything already
  // claimed by another custom tool.
  const assignedInputs = []
  for (let i = 1; i <= 10 && assignedInputs.length < sensorCount; i++) {
    const id = `IN${String(i).padStart(2, '0')}`
    if (claimedInputs.has(id)) continue
    assignedInputs.push(id)
  }

  const callouts = {}
  const labelOverrides = {}
  const typeOverrides  = {}
  resolvedActuators.forEach((a) => {
    if (!a.valve) return
    callouts[a.valve] = acts.length > 1
      ? `Connect the ${toolName || 'tool'}'s ${a.label} air line here`
      : `Connect the ${toolName || 'tool'}'s air line here`
    labelOverrides[a.valve] = acts.length > 1
      ? `${toolName || 'Custom EOAT'} — ${a.label}`
      : (toolName || 'Custom EOAT')
    if (a.recommended_valve_type) {
      typeOverrides[a.valve] = a.recommended_valve_type
    }
  })
  assignedInputs.forEach((id, i) => {
    callouts[id] = `Wire sensor #${i + 1} here (${sensorTypeCopy()})`
  })

  // Legacy single-actuator surface (first actuator's values).
  const first = resolvedActuators[0] || null

  return {
    key: 'custom',
    label: toolName || 'Custom EOAT',
    actuation,
    holdOnLoss,
    actuators: resolvedActuators,
    sensorCount,
    recommended_valve_type: first ? first.recommended_valve_type : null,
    recommended_valve_why:  first ? first.recommended_valve_why  : null,
    required_valves,
    required_inputs:  assignedInputs,
    required_outputs: [],
    notes: first && first.notes
      ? first.notes
      : 'Electric or no actuation — no valve required. Wire only '
        + 'the feedback sensors your controller reads directly.',
    callouts,
    label_overrides: labelOverrides,
    type_overrides: typeOverrides,
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
