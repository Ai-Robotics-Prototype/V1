// External-fixture wizard data + allocation.
//
// 2026-09-22 operator directive (External Fixture Wizard):
//   * Process-language interview compiles to Synapse port assignments.
//   * Six device types, each carrying operator-language copy + per-
//     type defaults (power mode, actuation, hold-on-loss).
//   * Free-port allocation consults BOTH tools (from /api/tools →
//     tool.config.assigned_valve / assigned_inputs) AND other
//     fixtures (from the fixtures store → fixture.valve / .in_done
//     / .out) so we never double-assign a port.
//   * The wizard NEVER emits IO writes; assignments are guidance
//     only until the operator wires and confirms.
//
// 2026-10-05 operator directive (stay-clamped on loss → DS valve):
//   * Valve TYPE resolution now routes through the shared
//     ../lib/valveMapping.valveTypeForActuation so the fixture
//     wizard and the EOAT wizard can never diverge on the safety-
//     relevant hold-on-loss → DS/SS mapping.
//   * Allocation is TYPE-AWARE via allocateValveForType — a 5/2 DS
//     requirement never lands on an SS-only slot. Prefers a free
//     slot whose declared type EQUALS the requirement (e.g. V09
//     for DS), falls back to SPARE 1/2 (operator wires matching
//     valve there), refuses when neither is free.

import {
  valveTypeForActuation, allocateValveForType, slotAcceptsType,
} from './valveMapping.js'

// Valve-explainer copy — the SAME plain-language strings the Synapse
// page's ValveInfoPanel shows, kept here as a small local subset so
// the wizard code is testable in isolation (no cross-file JSX import
// chain). When SynapsePage's VALVE_TYPE_INFO copy is edited, mirror
// the change here — the D_fixture_wizard "process language" pin makes
// sure the wizard JSX itself never leaks hardware terms even if these
// explainer strings do.
const _VALVE_TYPE_WHY = Object.freeze({
  '5/2 DS':
    'Holds the last position when power or air is lost — the fixture '
    + 'stays clamped until the program commands a change.',
  '5/2 SS':
    'Snaps back to home when power or air is lost — the fixture '
    + 'opens on its own, which is safer for anything grabbing a '
    + 'person or a fragile item.',
  'HI/LO 3/2 N/C':
    'Default off. The valve pulses only when the program commands '
    + 'it — perfect for on-demand air like a blow-off or ejector.',
})

// Re-export for consumers that want to introspect slot acceptance
// (D-level pin tests + any UI widget that wants to flag a mismatch).
export { slotAcceptsType }

// ── Device types ────────────────────────────────────────────────────
//
// The picker shows these as cards. Each card pre-seeds later defaults
// per the directive: "Card pre-seeds later defaults per type".
//
// Defaults:
//   * power_mode      — the fork choice on screen 2 (air / own_controller / manual)
//   * air_actuation   — 'single' (spring-return) | 'double' (holds last position)
//                       Only meaningful when power_mode='air'. The AIR path
//                       screen still asks the hold-on-loss question in plain
//                       words; this is the pre-seeded default the operator
//                       accepts by default.
//   * hold_on_loss    — true → 5/2 DS (holds); false → 5/2 SS (springs home);
//                       null → not applicable (blow-off, own-controller, manual).
//   * name_prefix     — prefill for step 5's Name field, disambiguated by
//                       an incrementing counter across saved fixtures of the
//                       same type ("Vice 1", "Vice 2", ...).
//   * why             — one-line WHY paragraph shown under the card.

// 2026-10-16 operator field report: the completion step's generic
// "How will the robot know it's finished?" copy did not fit a DOOR
// actuator (operators think of a door as open/closed, not "finished").
// Fix: each FIXTURE_TYPES entry carries a `completion` sub-object that
// drives CompletionStep's wording. The sub-object is purely data —
// CompletionStep renders from it without any per-type if/else chain.
//
// Shape:
//   completion: {
//     question:   string,          // operator-facing headline
//     options:    [string],        // subset of ['sensor','wait','operator']
//                                   // in display order; blow-off = ['wait']
//     sensor?:    { label, desc },
//     wait?:      { label, desc,
//                   waitLabel, waitHint },
//     operator?:  { label, desc },
//     sensorNote?: string,         // optional callout under the sensor
//                                   // choice (safest/wiring hint).
//   }
//
// Any type without a `completion` entry falls back to _GENERIC_COMPLETION
// so a future type that forgets to opt in still renders a working step
// (never a crash); the pin suite asserts every shipped type carries its
// own copy.
const _GENERIC_COMPLETION = Object.freeze({
  question: "How will the robot know it's finished?",
  options:  ['sensor', 'wait', 'operator'],
  sensor: {
    label: 'A sensor tells it',
    desc:
      'A sensor on the device sends a signal when it is done. The '
      + 'robot waits for the signal before moving on.',
  },
  wait: {
    label: 'It always takes about the same time',
    desc:
      'The robot waits a set number of seconds. Pick this only when '
      + 'the device has no signal — a timer cannot tell if the device '
      + 'actually finished.',
    waitLabel: 'Wait time',
    waitHint:  'seconds',
  },
  operator: {
    label: 'A person will press continue',
    desc:
      'The program pauses and asks the operator to confirm before '
      + 'moving on.',
  },
  sensorNote:
    'A sensor is safest — the robot never guesses whether the '
    + 'device finished.',
})

export const FIXTURE_TYPES = Object.freeze({
  vice: {
    key: 'vice', label: 'Vice / Clamp',
    desc: 'Grips a workpiece.',
    icon: 'vice',
    // 2026-10-16 operator order: vice/clamp is always pneumatic in
    // our installs — the "How does this device work?" power question
    // is skipped for this type and power_mode is auto-set to 'air'
    // from `defaults.power_mode`. See isPowerFixed() below.
    power_fixed: true,
    defaults: {
      power_mode: 'air',
      air_actuation: 'double',
      hold_on_loss: true,
    },
    name_prefix: 'Vice',
    why:
      'A clamp with two states — open and closed. By default it '
      + 'keeps holding the part if the robot stops, so nothing '
      + 'drops mid-cycle. You can change this on the next step.',
    completion: {
      question: 'How will the robot know the part is clamped?',
      options:  ['sensor', 'wait', 'operator'],
      sensor: {
        label: 'A clamp sensor tells it',
        desc:
          'A sensor on the vice signals when the jaws are closed on '
          + 'the part. The robot waits for the signal before moving on.',
      },
      wait: {
        label: 'It always takes about the same time',
        desc:
          'The robot waits a set number of seconds for the clamp to '
          + 'close. Pick this only when the vice has no clamp sensor — '
          + 'a timer cannot tell if the part is actually clamped.',
        waitLabel: 'Clamp time',
        waitHint:  'seconds',
      },
      operator: {
        label: 'A person will press continue',
        desc:
          'The program pauses and asks the operator to confirm the '
          + 'part is clamped before moving on.',
      },
      sensorNote:
        'A clamp sensor is safest — the robot never guesses whether '
        + 'the part is actually held.',
    },
  },
  indexer: {
    key: 'indexer', label: 'Rotary Table / Indexer',
    desc: 'Spins to a new position.',
    icon: 'indexer',
    defaults: {
      power_mode: 'own_controller',
      hold_on_loss: null,
    },
    name_prefix: 'Indexer',
    why:
      'Rotary indexers almost always have their own controls — the '
      + "robot tells it to go and waits for it to finish.",
    completion: {
      question: 'How will the robot know the table is in position?',
      options:  ['sensor', 'wait', 'operator'],
      sensor: {
        label: 'An in-position sensor tells it',
        desc:
          'A sensor on the indexer signals when it reaches the next '
          + 'station. The robot waits for the signal before moving on.',
      },
      wait: {
        label: 'It always takes about the same time',
        desc:
          'The robot waits a set number of seconds for the index to '
          + 'complete. Pick this only when the indexer has no sensor.',
        waitLabel: 'Index time',
        waitHint:  'seconds',
      },
      operator: {
        label: 'A person will press continue',
        desc:
          'The program pauses and asks the operator to confirm the '
          + 'table is in position before moving on.',
      },
      sensorNote:
        'An in-position sensor is safest — the robot never guesses '
        + 'whether the table actually reached the next station.',
    },
  },
  feeder: {
    key: 'feeder', label: 'Part Feeder / Conveyor',
    desc: 'Delivers the next part.',
    icon: 'feeder',
    defaults: {
      power_mode: 'own_controller',
      hold_on_loss: null,
    },
    name_prefix: 'Feeder',
    why:
      'Bowl feeders and conveyors have their own controls. The '
      + 'robot sends a start signal and waits for the next part.',
    completion: {
      question: 'How will the robot know the next part is at the pickup?',
      options:  ['sensor', 'wait', 'operator'],
      sensor: {
        label: 'A part-present sensor tells it',
        desc:
          'A sensor at the pickup signals when a part arrives. The '
          + 'robot waits for the signal before picking.',
      },
      wait: {
        label: 'It always takes about the same time',
        desc:
          'The robot waits a set number of seconds for the next part '
          + 'to arrive. Pick this only when the feeder has no sensor '
          + '— a timer cannot tell if a part is actually there.',
        waitLabel: 'Feed time',
        waitHint:  'seconds',
      },
      operator: {
        label: 'A person will press continue',
        desc:
          'The program pauses and asks the operator to confirm a '
          + 'part is at the pickup before moving on.',
      },
      sensorNote:
        'A part-present sensor is safest — the robot never guesses '
        + 'whether a part is actually at the pickup.',
    },
  },
  blow_off: {
    key: 'blow_off', label: 'Air Blast / Blow-off',
    desc: 'Pulses air to clear chips.',
    icon: 'blow_off',
    // Blow-off is pneumatic by name — skip the power question.
    power_fixed: true,
    defaults: {
      power_mode: 'air',
      air_actuation: 'blow_off',
      hold_on_loss: null,
    },
    name_prefix: 'Blow-off',
    why:
      'Blow-offs sit off by default and pulse when the program '
      + 'says so — nothing to hold here.',
    // Blow-offs are self-contained pulses — no "finished" question
    // applies. The only operator-facing knob is HOW LONG the pulse
    // lasts, so we offer only the wait option and label it "pulse
    // length" (not "finished / wait time").
    completion: {
      question: 'How long should the air pulse?',
      options:  ['wait'],
      wait: {
        label: 'Pulse length',
        desc:
          'Set the number of seconds the air pulses when the program '
          + 'fires it. Short pulses (0.1 – 0.5 s) are typical for '
          + 'chip clearing.',
        waitLabel: 'Pulse length',
        waitHint:  'seconds',
      },
    },
  },
  door: {
    key: 'door', label: 'Door / Slide',
    desc: 'Opens and closes a guard.',
    icon: 'door',
    // Door / slide is always pneumatic — skip the power question.
    power_fixed: true,
    defaults: {
      power_mode: 'air',
      air_actuation: 'double',
      hold_on_loss: true,
    },
    name_prefix: 'Door',
    why:
      'A door or slide with two states — open and closed. By default '
      + 'it keeps holding when the robot stops, so a cover or chute '
      + 'never drops a part. If this is a safety guard that must '
      + 'open for a person to walk through, pick "let go" on the '
      + 'next step.',
    completion: {
      // 2026-10-16 operator field report: the generic "finished"
      // wording made no sense for a door — operators think of a
      // door as reaching open or closed, not finishing. Reframed.
      question: 'How will the robot know the door is open or closed?',
      options:  ['sensor', 'wait', 'operator'],
      sensor: {
        label: 'A door position sensor tells it',
        desc:
          'A sensor on the door signals when it reaches the open or '
          + 'closed position. The robot waits for the signal before '
          + 'moving on.',
      },
      wait: {
        label: 'It takes about the same time to open and close',
        desc:
          'The robot waits a set number of seconds for the door to '
          + 'open or close. Pick this only when the door has no '
          + 'position sensor — a timer cannot tell if the door '
          + 'actually reached its end stop.',
        waitLabel: 'How long to open or close?',
        waitHint:  'seconds',
      },
      operator: {
        label: 'A person will confirm',
        desc:
          'The program pauses and asks the operator to confirm the '
          + 'door is in the right position before moving on.',
      },
      sensorNote:
        'A position sensor is safest — the robot never guesses whether '
        + 'the door actually reached open or closed.',
    },
  },
  other: {
    key: 'other', label: 'Something else',
    desc: 'Any other device.',
    icon: 'other',
    defaults: {
      power_mode: null,
      hold_on_loss: true,
    },
    name_prefix: 'Fixture',
    why:
      'Not sure what this is — the wizard will ask the same '
      + 'questions and build the record from your answers.',
    completion: _GENERIC_COMPLETION,
  },
})

// Resolve the completion copy for a device type. Returns the type's
// bespoke config when present, else the generic fallback — a future
// type that forgets to opt in still renders a working step.
export function completionCopyFor(type) {
  const def = FIXTURE_TYPES[type]
  if (def && def.completion) return def.completion
  return _GENERIC_COMPLETION
}

// 2026-10-16 operator order: for always-pneumatic device types (vice,
// door, blow_off) the "How does this device work?" power step is
// pointless — the answer is always "robot controls its air." The
// wizard skips step 1 for these types and uses the type's
// defaults.power_mode ('air') verbatim. Types where the power mode
// genuinely varies (feeder / indexer / custom "other") still ask.
// Data-driven: the per-type `power_fixed: true` flag is the single
// source of truth; the UI reads it via this helper.
export function isPowerFixed(type) {
  const def = FIXTURE_TYPES[type]
  return !!(def && def.power_fixed === true)
}

export const FIXTURE_TYPE_KEYS = Object.freeze(
  Object.keys(FIXTURE_TYPES))

// ── Free-port allocation ─────────────────────────────────────────────
//
// One entry point: allocateFixturePorts({ needsValve, needsOut,
// needsIn, actuationType, tools, fixtures }) → { valve?, out?, in? }.
//
// Rules:
//   * Valve requests get the first free SPARE slot ('V05', 'V10'). If
//     both are claimed the caller renders a "no SPARE slots left"
//     refusal at the summary step (never here).
//   * OUT requests get the first free OUT01..OUT10. Fixtures never
//     claim OUTs that a tool has claimed (tools don't currently claim
//     OUTs, but the shape is future-proof).
//   * IN requests get the first free IN01..IN10.
//
// Callers pass:
//   * tools    — array of tool records from /api/tools. We read
//                `config.assigned_valve` (string) + `config.assigned_inputs`
//                (array of strings) per the pattern lib/toolPortMap
//                already uses.
//   * fixtures — array of fixture records from the fixtures store.
//                We read `valve` (string) + `in_done` (string) + `out`
//                (string) per the record schema at the bottom of this
//                file.

// SPARE_VALVES retained only as a historical fallback for callers
// that compute "no spare slots left" prose; actual allocation now
// routes through valveMapping.allocateValveForType which considers
// EVERY slot and selects by matching type → SPARE fallback.
const SPARE_VALVES = Object.freeze(['V05', 'V10'])
const ALL_INPUTS   = Object.freeze(
  Array.from({ length: 10 }, (_, i) => `IN${String(i + 1).padStart(2, '0')}`))
const ALL_OUTPUTS  = Object.freeze(
  Array.from({ length: 10 }, (_, i) => `OUT${String(i + 1).padStart(2, '0')}`))

export function claimedValveIds(tools, fixtures) {
  const s = new Set()
  for (const t of tools || []) {
    const v = t?.config?.assigned_valve
    if (typeof v === 'string' && v) s.add(v)
  }
  for (const f of fixtures || []) {
    if (typeof f?.valve === 'string' && f.valve) s.add(f.valve)
  }
  return s
}

export function claimedInputIds(tools, fixtures) {
  const s = new Set()
  for (const t of tools || []) {
    const arr = t?.config?.assigned_inputs
    if (Array.isArray(arr)) for (const i of arr) s.add(String(i))
  }
  for (const f of fixtures || []) {
    if (typeof f?.in_done === 'string' && f.in_done) s.add(f.in_done)
  }
  return s
}

export function claimedOutputIds(tools, fixtures) {
  const s = new Set()
  for (const t of tools || []) {
    const arr = t?.config?.assigned_outputs
    if (Array.isArray(arr)) for (const o of arr) s.add(String(o))
  }
  for (const f of fixtures || []) {
    if (typeof f?.out === 'string' && f.out) s.add(f.out)
  }
  return s
}

export function allocateFixturePorts({
  needsValve = false, needsOut = false, needsIn = false,
  valveType = null,
  tools = [], fixtures = [],
} = {}) {
  const cValve = claimedValveIds(tools, fixtures)
  const cIn    = claimedInputIds(tools, fixtures)
  const cOut   = claimedOutputIds(tools, fixtures)
  const out = {}
  if (needsValve) {
    // Type-aware allocation (2026-10-05 directive): a fixture that
    // needs 5/2 DS must land on a slot whose declared type is 5/2 DS
    // (or SPARE as the operator-wired fallback). Never on an SS-only
    // slot — that silently dumps clamped parts on power loss.
    out.valve = allocateValveForType(valveType, cValve)
  }
  if (needsOut) {
    out.out = ALL_OUTPUTS.find((o) => !cOut.has(o)) || null
  }
  if (needsIn) {
    out.in_done = ALL_INPUTS.find((i) => !cIn.has(i)) || null
  }
  return out
}

// ── Valve TYPE recommendation (process-language → hardware term) ────
//
// The wizard NEVER asks "5/2 SS or DS?" — it asks the hold-on-loss
// question in plain words on the AIR path. That answer + the device
// type resolves to the concrete valve TYPE, and we pull the WHY copy
// from VALVE_TYPE_INFO so the operator sees the same explainer text
// as on the Synapse page.

export function recommendValveType({ actuation, holdOnLoss }) {
  const type = valveTypeForActuation({ actuation, holdOnLoss })
  if (!type) return null
  return { type, why: _VALVE_TYPE_WHY[type] || '' }
}

// ── Compile answers → fixture record ────────────────────────────────
//
// The wizard collects answers per step; compileFixtureRecord folds
// them into the canonical record shape at any point (used by the
// summary preview AND the persistence writer).
//
// Record schema (order-stable so JSON diffs read cleanly):
//   {
//     id,
//     name,
//     type,             // 'vice' | 'indexer' | 'feeder' | 'blow_off' | 'door' | 'other'
//     power_mode,       // 'air' | 'own_controller' | 'manual'
//     actuation,        // 'single' | 'double' | 'blow_off' | null
//     hold_on_loss,     // true | false | null
//     valve,            // string 'V05' | 'V10' | null
//     out,              // string 'OUT03' | null
//     in_done,          // string 'IN04' | null
//     completion,       // 'sensor' | 'wait' | 'operator' | null
//     wait_s,           // number | null
//     valve_type,       // '5/2 DS' | '5/2 SS' | 'HI/LO 3/2 N/C' | null
//     valve_type_why,   // one-line explainer copy from VALVE_TYPE_INFO
//     created_at,       // ISO
//   }
//
// PROGRAM-EDITOR EXPOSURE (named follow-up, not this session): the
// record shape carries `type` + assigned ports so a future editor
// action list can emit "Close Vice 1", "Wait Vice 1 done", "Trigger
// Feeder" without a schema change.

export function compileFixtureRecord(answers, { tools = [], fixtures = [] } = {}) {
  const type    = answers.type
  const typeDef = FIXTURE_TYPES[type] || FIXTURE_TYPES.other
  const power   = answers.power_mode || typeDef.defaults.power_mode
  const actuation = _resolveActuation(answers, typeDef)
  const holdOnLoss = _resolveHoldOnLoss(answers, typeDef)
  const rec = recommendValveType({ actuation, holdOnLoss })

  const needsValve = power === 'air'
  const needsOut   = power === 'own_controller'
  const needsIn    = answers.completion === 'sensor'
                  || (power === 'own_controller' && answers.wants_done === true)

  const alloc = allocateFixturePorts({
    needsValve, needsOut, needsIn,
    // Thread the recommended valve type into allocation so the
    // chosen slot can actually carry it (safety: a DS requirement
    // cannot land on an SS slot).
    valveType: rec ? rec.type : null,
    tools, fixtures,
  })

  return {
    id:            answers.id || null,
    name:          answers.name || _defaultName(type, fixtures),
    type,
    power_mode:    power,
    actuation:     actuation || null,
    hold_on_loss:  holdOnLoss,
    valve:         alloc.valve || null,
    out:           alloc.out || null,
    in_done:       alloc.in_done || null,
    completion:    answers.completion || null,
    wait_s:        answers.completion === 'wait'
                     ? _coerceSeconds(answers.wait_s) : null,
    valve_type:    rec ? rec.type : null,
    valve_type_why: rec ? rec.why : null,
    created_at:    answers.created_at || new Date().toISOString(),
  }
}

function _resolveActuation(answers, typeDef) {
  if (typeof answers.actuation === 'string') return answers.actuation
  if (typeDef.defaults.air_actuation) return typeDef.defaults.air_actuation
  return null
}

function _resolveHoldOnLoss(answers, typeDef) {
  if (typeof answers.hold_on_loss === 'boolean') return answers.hold_on_loss
  if (typeof typeDef.defaults.hold_on_loss === 'boolean') {
    return typeDef.defaults.hold_on_loss
  }
  return null
}

function _defaultName(type, fixtures) {
  const typeDef = FIXTURE_TYPES[type] || FIXTURE_TYPES.other
  const same = (fixtures || []).filter((f) => f.type === type)
  const n = same.length + 1
  return `${typeDef.name_prefix} ${n}`
}

function _coerceSeconds(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100) / 100
}

// ── Guidance-map port record ────────────────────────────────────────
//
// Same shape as lib/toolPortMap._FIXED entries so we can drop it into
// <GuidanceBlock port={...} /> in the wizard's summary step. Callouts
// carry the FIXTURE NAME per the operator directive.

export function fixturePortMap(rec) {
  if (!rec) return null
  const callouts = {}
  const required_valves = rec.valve ? [rec.valve] : []
  const required_outputs = rec.out ? [rec.out] : []
  const required_inputs = rec.in_done ? [rec.in_done] : []
  if (rec.valve) {
    callouts[rec.valve] =
      `Connect ${rec.name}'s air line to ${rec.valve}`
  }
  if (rec.out) {
    callouts[rec.out] =
      `Wire ${rec.name}'s START input to ${rec.out}`
  }
  if (rec.in_done) {
    callouts[rec.in_done] =
      `Wire ${rec.name}'s DONE sensor to ${rec.in_done}`
  }
  return {
    key: `fixture:${rec.id || rec.name}`,
    label: rec.name,
    required_valves, required_outputs, required_inputs,
    notes: rec.valve_type_why
      || 'Wire the ports below as the wizard assigned them.',
    callouts,
    label_overrides: rec.valve ? { [rec.valve]: rec.name } : {},
  }
}
