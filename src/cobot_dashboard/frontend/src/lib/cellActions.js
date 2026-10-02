// Cell → named actions → primitive step lists.
//
// 2026-09-22 operator directive (The Cell): the program editor
// exposes NAMED ACTIONS generated from the selected cell entries;
// each named action compiles to the SAME set_io / verify_input /
// wait primitives that already ship (no new wire verbs).
//
// Design rules (from the directive):
//   * Named actions are per-entry: the fixture "Vice 1" produces
//     "Close Vice 1" + "Open Vice 1" + "Wait for Vice 1 clamped".
//   * Compilation reads the cell entry's assigned port at codegen
//     time. Program records bind BY ID, not by port literal — if the
//     port ever changes on the cell entry, the emitted primitives
//     follow automatically.
//   * The primitive shape matches lib/effectorVocab exactly:
//       set_io       { action:'set_io', io_id:'DO<N>', value:0|1, ... }
//       verify_input { action:'verify_input', io_id:'DI<N>', expect:0|1,
//                      timeout_ms, on_fail:'abort', ... }
//       wait         { action:'wait', duration_s:<seconds>, ... }
//     The 4 codegen gates + sweep that already validate these
//     primitives keep working — cell-emitted steps look identical
//     to hand-authored ones.

const DEFAULT_TRIGGER_PULSE_MS = 200
const DEFAULT_WAIT_TIMEOUT_MS  = 30000
const DEFAULT_CLAMP_TIMEOUT_MS = 5000

// ── Port helpers ────────────────────────────────────────────────────
//
// Cell entries store port IDs as 'V05', 'IN04', 'OUT03'. The codegen
// primitives take io_id like 'DO<N>' and 'DI<N>'. Translation now
// routes through the single-source synapsePortmap module
// (2026-10-01 Synapse Addressing Doctrine). The seeded portmap
// matches the current convention — V<NN>→DO<N>, OUT<NN>→DO<N>,
// IN<NN>→DI<N> — so emitted io_ids are byte-identical with the
// pre-directive helpers. When the operator audits the seeded map
// (/opt/cobot/synapse_portmap.json) and corrects a row, that fix
// flows through every caller automatically.
//
// The fallback (cachedPortmap() === null, before the hook has
// fetched) uses the convention mapping directly so cell-sourced
// primitives in server-side codegen tests stay deterministic.

import {
  cachedPortmap, rawForSynapse,
} from './synapsePortmap.js'

function _rawFromPortmap(synId) {
  const pm = cachedPortmap()
  if (pm) {
    const r = rawForSynapse(pm, synId)
    if (r) return r
  }
  // Fallback: convention mapping. Preserves byte-identical emission
  // when the portmap hasn't been fetched yet (server-side tests +
  // cold-boot wizard renders before the hook mounts).
  if (typeof synId !== 'string') return null
  const v = synId.match(/^V(\d+)$/)
  if (v) return `DO${Number(v[1])}`
  const o = synId.match(/^OUT(\d+)$/)
  if (o) return `DO${Number(o[1])}`
  const i = synId.match(/^IN(\d+)$/)
  if (i) return `DI${Number(i[1])}`
  return null
}

function _valveToDo(valveId) {
  if (typeof valveId !== 'string' || !valveId.match(/^V\d+$/)) return null
  return _rawFromPortmap(valveId)
}
function _outToDo(outId) {
  if (typeof outId !== 'string' || !outId.match(/^OUT\d+$/)) return null
  return _rawFromPortmap(outId)
}
function _inToDi(inId) {
  if (typeof inId !== 'string' || !inId.match(/^IN\d+$/)) return null
  return _rawFromPortmap(inId)
}

// ── Named actions for a fixture entry ──────────────────────────────
//
// namedActionsForFixture(entry) → [ { key, label, description } ]
//
// Presence rules:
//   power_mode='air'            → close/open (+ wait_done if in_done set)
//     actuation='blow_off'       → pulse (single action, no open/close)
//   power_mode='own_controller' → trigger (+ wait_done if in_done set)
//   power_mode='manual'         → wait_operator (single action)

export function namedActionsForFixture(entry) {
  if (!entry) return []
  const name = entry.name || 'Fixture'
  const acts = []
  if (entry.power_mode === 'air') {
    if (entry.actuation === 'blow_off') {
      acts.push({
        key: 'pulse',
        label: `Pulse ${name}`,
        description: `Fires ${name} on for a short time, then off.`,
      })
    } else {
      acts.push({
        key: 'close',
        label: `Close ${name}`,
        description: `Energizes the ${name} valve to clamp/close.`,
      })
      acts.push({
        key: 'open',
        label: `Open ${name}`,
        description: `De-energizes the ${name} valve to release/open.`,
      })
    }
  } else if (entry.power_mode === 'own_controller') {
    acts.push({
      key: 'trigger',
      label: `Trigger ${name}`,
      description: `Pulses the start-signal wire to ${name}.`,
    })
  }
  if (entry.in_done) {
    acts.push({
      key: 'wait_done',
      label: `Wait for ${name} done`,
      description: `Blocks until the ${name} done sensor reports ready.`,
    })
  } else if (entry.completion === 'wait' && entry.wait_s) {
    acts.push({
      key: 'wait_time',
      label: `Wait for ${name} (${entry.wait_s}s)`,
      description: `Fixed wait — no sensor available for ${name}.`,
    })
  } else if (entry.power_mode === 'manual') {
    acts.push({
      key: 'wait_operator',
      label: `Wait for operator (${name})`,
      description: `Prompts the operator to press Continue.`,
    })
  }
  return acts
}

// namedActionsForEoat(entry) → [ { key, label, description } ]
//
// EOAT actions are simpler because the cell entry carries only the
// tool's port assignments — the primitives look identical.

export function namedActionsForEoat(entry) {
  if (!entry) return []
  const name = entry.name || 'Tool'
  const acts = []
  if (entry.valve) {
    if (entry.type === 'vacuum') {
      acts.push({ key: 'vacuum_on',  label: `${name}: vacuum ON`,
        description: 'Draws vacuum on the tool.' })
      acts.push({ key: 'vacuum_off', label: `${name}: vacuum OFF`,
        description: 'Releases vacuum on the tool.' })
    } else {
      acts.push({ key: 'close', label: `${name}: close`,
        description: 'Closes the tool grip.' })
      acts.push({ key: 'open',  label: `${name}: open`,
        description: 'Opens the tool grip.' })
    }
  }
  return acts
}

// ── Compile named action + entry → primitive steps ─────────────────
//
// compileFixtureAction(entry, actionKey, opts?) → [ primitive, ... ]
//
// Returns an empty array when the entry doesn't support the action
// (e.g. asking for 'wait_done' on a fixture with no in_done). The
// program editor filters actions via namedActionsForFixture BEFORE
// composing, so this shouldn't fire in practice — but the safe
// return keeps the codegen path defensive.

export function compileFixtureAction(entry, actionKey, opts = {}) {
  if (!entry || !actionKey) return []
  const name = entry.name || 'Fixture'
  const valveDo = _valveToDo(entry.valve)
  const outDo   = _outToDo(entry.out)
  const inDi    = _inToDi(entry.in_done)
  const clampTimeout = opts.timeout_ms != null
    ? opts.timeout_ms : DEFAULT_CLAMP_TIMEOUT_MS
  const waitTimeout = opts.timeout_ms != null
    ? opts.timeout_ms : DEFAULT_WAIT_TIMEOUT_MS
  const pulseMs = opts.pulse_ms != null ? opts.pulse_ms : DEFAULT_TRIGGER_PULSE_MS

  switch (actionKey) {
    case 'close':
      if (!valveDo) return []
      return [{
        action: 'set_io', label: `Close ${name}`,
        io_id: valveDo, value: 1,
        cell_binding: { fixture_id: entry.id, action: 'close' },
      }]
    case 'open':
      if (!valveDo) return []
      return [{
        action: 'set_io', label: `Open ${name}`,
        io_id: valveDo, value: 0,
        cell_binding: { fixture_id: entry.id, action: 'open' },
      }]
    case 'pulse': {
      if (!valveDo) return []
      const ms = opts.pulse_ms != null ? opts.pulse_ms : 500
      return [
        { action: 'set_io', label: `${name} pulse ON`,
          io_id: valveDo, value: 1,
          cell_binding: { fixture_id: entry.id, action: 'pulse' } },
        { action: 'wait',   label: `${name} pulse hold`,
          duration_s: ms / 1000.0 },
        { action: 'set_io', label: `${name} pulse OFF`,
          io_id: valveDo, value: 0,
          cell_binding: { fixture_id: entry.id, action: 'pulse' } },
      ]
    }
    case 'trigger': {
      if (!outDo) return []
      return [
        { action: 'set_io', label: `Trigger ${name}`,
          io_id: outDo, value: 1,
          cell_binding: { fixture_id: entry.id, action: 'trigger' } },
        { action: 'wait',   label: `${name} trigger hold`,
          duration_s: pulseMs / 1000.0 },
        { action: 'set_io', label: `End ${name} trigger`,
          io_id: outDo, value: 0,
          cell_binding: { fixture_id: entry.id, action: 'trigger' } },
      ]
    }
    case 'wait_done':
      if (!inDi) return []
      return [{
        action: 'verify_input', label: `Wait for ${name} done`,
        io_id: inDi, expect: 1,
        timeout_ms: opts.timeout_ms != null
          ? opts.timeout_ms
          : (entry.power_mode === 'own_controller'
              ? waitTimeout : clampTimeout),
        on_fail: 'abort',
        cell_binding: { fixture_id: entry.id, action: 'wait_done' },
      }]
    case 'wait_time':
      return [{
        action: 'wait', label: `Wait for ${name}`,
        duration_s: entry.wait_s || 1.0,
        cell_binding: { fixture_id: entry.id, action: 'wait_time' },
      }]
    case 'wait_operator':
      return [{
        action: 'operator_continue',
        label: `Wait for operator (${name})`,
        prompt: `Press Continue when ${name} is ready.`,
        cell_binding: { fixture_id: entry.id, action: 'wait_operator' },
      }]
    default:
      return []
  }
}

// compileEoatAction(entry, actionKey, opts?) → [ primitive, ... ]

export function compileEoatAction(entry, actionKey, opts = {}) {
  if (!entry || !actionKey) return []
  const name = entry.name || 'Tool'
  const valveDo = _valveToDo(entry.valve)
  switch (actionKey) {
    case 'close':
      if (!valveDo) return []
      return [{
        action: 'set_io', label: `${name}: close`,
        io_id: valveDo, value: 1,
        cell_binding: { eoat_id: entry.id, action: 'close' },
      }]
    case 'open':
      if (!valveDo) return []
      return [{
        action: 'set_io', label: `${name}: open`,
        io_id: valveDo, value: 0,
        cell_binding: { eoat_id: entry.id, action: 'open' },
      }]
    case 'vacuum_on':
      if (!valveDo) return []
      return [{
        action: 'set_io', label: `${name}: vacuum ON`,
        io_id: valveDo, value: 1,
        cell_binding: { eoat_id: entry.id, action: 'vacuum_on' },
      }]
    case 'vacuum_off':
      if (!valveDo) return []
      return [{
        action: 'set_io', label: `${name}: vacuum OFF`,
        io_id: valveDo, value: 0,
        cell_binding: { eoat_id: entry.id, action: 'vacuum_off' },
      }]
    default:
      return []
  }
}

// ── Missing-entry refusal helper ────────────────────────────────────
//
// The program editor calls checkCellBindings(program, cell) before
// build. When a bound cell id is no longer in the cell, returns a
// list of plain-copy refusals for the operator.

export function checkCellBindings(program, cell) {
  const problems = []
  const cfg = (program && program.config) || {}
  const eoatIds = []
  if (cfg.cell_eoat_id) eoatIds.push(cfg.cell_eoat_id)
  const fixtureIds = Array.isArray(cfg.cell_fixture_ids)
    ? cfg.cell_fixture_ids : []
  const eoats = (cell && cell.eoats) || []
  const fixtures = (cell && cell.fixtures) || []
  for (const id of eoatIds) {
    const found = eoats.find((e) => e.id === id)
    if (!found) {
      problems.push({
        kind: 'missing_eoat', id,
        detail: `This program uses an end-of-arm tool that is no `
              + `longer set up (id ${id}).`,
      })
    }
  }
  for (const id of fixtureIds) {
    const found = fixtures.find((f) => f.id === id)
    if (!found) {
      problems.push({
        kind: 'missing_fixture', id,
        detail: `This program uses a fixture that is no longer set `
              + `up (id ${id}).`,
      })
    }
  }
  return problems
}

// Delete-with-references warning helper (used by the My Cell view
// and the wizard delete confirmations).

export function programsReferencingCellId(programs, cellId) {
  if (!Array.isArray(programs) || !cellId) return []
  return programs.filter((p) => {
    const cfg = (p && p.config) || {}
    if (cfg.cell_eoat_id === cellId) return true
    const ids = Array.isArray(cfg.cell_fixture_ids)
      ? cfg.cell_fixture_ids : []
    return ids.includes(cellId)
  })
}
