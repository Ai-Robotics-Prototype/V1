// Shared effector-vocabulary source — 2026-07-30 record-vs-apply
// instance #4.
//
// Before this module: the New Program Wizard had its own step-naming
// path that hardcoded gripper-vocabulary labels ("Grip part",
// "Release part") REGARDLESS of the answered effector. When the
// operator picked effector=vacuum, the wizard still emitted "Grip
// part" on the pick contact — vocabulary and IO shape were forked
// from the PBD composer (`programming_by_demonstration/program_
// composer.py`) which already got this right.
//
// Contract: this module is the SINGLE source of effector-aware step
// emitters + palette labels. Consumers:
//
//   * ProgramWizard.jsx  — new-program authoring
//   * ProgramEditor.jsx  — Add Step palette + step-detail rendering
//   * PBD composer       — mirror on the backend (`_effector_ready`,
//                          `_effector_engage`, `_effector_disengage`
//                          in program_composer.py). Any new effector
//                          lands HERE and there in the same commit.
//
// Every step emitted here carries `io_role` where relevant so
// downstream IO-remapping logic (dashboard I/O page → io_map.json)
// can update the io_id without editing the labels — same treatment
// the backend gives its own effector emissions.
//
// The gripper/vacuum/magnet string constants at the bottom are the
// exact tokens the no-fork-truth guard flags. Any hardcoded use in
// components/ or pages/ without importing this module fails CI.

// Default IO ports — same values as program_composer.py's
// _VACUUM_DEFAULT_PORT / _BLOWOFF_DEFAULT_PORT / _MAGNET_DEFAULT_PORT.
// Operators can rewire via the I/O page (io_map.json); the backend
// composer reads that file at compose time. The wizard emits the
// defaults; the codegen path is the one that consults io_map.
const V_DEFAULT_PORT = 2   // DO2 — vacuum
const B_DEFAULT_PORT = 3   // DO3 — blow-off (must differ from V_PORT
                           //       for the disengage triplet)
const M_DEFAULT_PORT = 3   // DO3 — magnet (single-DO effector)

export const CANONICAL_EFFECTORS = ['finger', 'vacuum', 'magnetic', 'custom']

// Normalise wizard answers / program config / PBD op to one canonical
// effector token. 'custom' → single-DO toggle on operator-picked
// activate/confirm signals; the executor treats it as 'magnetic'-
// shaped.
export function effectorOf(cfg) {
  const raw = String(cfg?.effector ?? cfg?.gripper_type ?? '').toLowerCase()
  if (raw === 'vacuum' || raw === 'magnetic' || raw === 'custom') return raw
  return 'finger'
}

// Human-readable name for the currently-selected effector — used by
// the palette label rendering to say "Grip part" vs "Engage vacuum".
export function effectorDisplayName(cfg) {
  const e = effectorOf(cfg)
  if (e === 'vacuum')   return 'vacuum'
  if (e === 'magnetic') return 'magnet'
  if (e === 'custom')   return 'custom gripper'
  return 'gripper'
}

// ── Step emitters — the PBD-composer mirror ──────────────────────

// READY at the start of the program (make sure effector is off/open).
// Options carry per-flow tunings (speed, gripper width, custom port).
export function effectorReady(cfg, opts = {}) {
  const { spd = 60, gripW = 85, customActivate = 'DO3' } = opts
  const e = effectorOf(cfg)
  if (e === 'vacuum') return [{
    action: 'set_io', label: 'Vacuum off (ready)',
    io_id:  `DO${V_DEFAULT_PORT}`, value: 0, io_role: 'vacuum',
  }]
  if (e === 'magnetic') return [{
    action: 'set_io', label: 'Magnet off (ready)',
    io_id:  `DO${M_DEFAULT_PORT}`, value: 0, io_role: 'magnet',
  }]
  if (e === 'custom') return [{
    action: 'set_io', label: 'Gripper off (ready)',
    io_id:  customActivate, value: 0,
  }]
  return [{
    action:  'open_gripper', label: 'Open gripper',
    width_mm: gripW, speed_pct: spd,
    io_open: 'DO1', io_open_confirm: 'DI1',
  }]
}

// ENGAGE after the arm reaches the pick contact.
export function effectorEngage(cfg, opts = {}) {
  const { gripF = 50, customActivate = 'DO3',
          // Alternate label for engage-in-context (machine tending
          // uses "Pick finished part" instead of "Grip part"). Only
          // the *label* changes; io + action are effector-driven.
          labelOverride = null,
          customConfirm = null } = opts
  const e = effectorOf(cfg)
  if (e === 'vacuum') return [
    { action: 'set_io',
      label:  labelOverride || 'Engage vacuum',
      io_id:  `DO${V_DEFAULT_PORT}`, value: 1, io_role: 'vacuum' },
    { action: 'wait',
      label:  'Wait for vacuum seal',
      duration_s: 0.5 },
  ]
  if (e === 'magnetic') return [{
    action: 'set_io',
    label:  labelOverride || 'Engage magnet',
    io_id:  `DO${M_DEFAULT_PORT}`, value: 1, io_role: 'magnet',
  }]
  if (e === 'custom') return [{
    action: 'set_io',
    label:  labelOverride || 'Gripper on',
    io_id:  customActivate, value: 1,
    ...(customConfirm ? { io_close_confirm: customConfirm } : {}),
  }]
  return [{
    action: 'close_gripper',
    label:  labelOverride || 'Grip part',
    force_pct: gripF, io_close: 'DO0', io_close_confirm: 'DI0',
  }]
}

// DISENGAGE after arriving at the place contact. Vacuum adds the
// blow-off triplet (set_io ON → dwell → set_io OFF) so parts are
// actively released; other effectors are single-step.
export function effectorDisengage(cfg, opts = {}) {
  const { gripW = 85, customActivate = 'DO3',
          withBlowOff = true, labelOverride = null } = opts
  const e = effectorOf(cfg)
  if (e === 'vacuum') {
    const out = [{
      action: 'set_io',
      label:  labelOverride || 'Disengage vacuum',
      io_id:  `DO${V_DEFAULT_PORT}`, value: 0, io_role: 'vacuum',
    }]
    if (withBlowOff && B_DEFAULT_PORT !== V_DEFAULT_PORT) out.push(
      { action: 'set_io',
        label:  'Blow off',
        io_id:  `DO${B_DEFAULT_PORT}`, value: 1, io_role: 'blow_off' },
      { action: 'wait',
        label:  'Wait for blow off',
        duration_s: 0.3 },
      { action: 'set_io',
        label:  'Blow off stop',
        io_id:  `DO${B_DEFAULT_PORT}`, value: 0, io_role: 'blow_off' },
    )
    return out
  }
  if (e === 'magnetic') return [{
    action: 'set_io',
    label:  labelOverride || 'Disengage magnet',
    io_id:  `DO${M_DEFAULT_PORT}`, value: 0, io_role: 'magnet',
  }]
  if (e === 'custom') return [{
    action: 'set_io',
    label:  labelOverride || 'Gripper off — release part',
    io_id:  customActivate, value: 0,
  }]
  return [{
    action: 'open_gripper',
    label:  labelOverride || 'Release part',
    width_mm: gripW, io_open: 'DO1',
  }]
}

// ── Palette label rendering — Add Step dropdown ──────────────────

// The Add Step palette currently offers "Close Gripper" / "Open
// Gripper" as authoring options regardless of the program's chosen
// effector. This helper returns the effector-aware label for those
// palette entries, so the operator picking a step from a vacuum
// program sees "Engage vacuum" in the dropdown, not "Close Gripper".
//
// Returns null for actions with no effector-linked wording; the
// caller then uses the default ACTION_TYPES.label.
export function paletteLabelForAction(action, cfg) {
  const e = effectorOf(cfg)
  const map = {
    close_gripper: {
      finger:   'Grip part',
      vacuum:   'Engage vacuum',
      magnetic: 'Engage magnet',
      custom:   'Engage gripper',
    },
    open_gripper: {
      finger:   'Open gripper',
      vacuum:   'Disengage vacuum',
      magnetic: 'Disengage magnet',
      custom:   'Disengage gripper',
    },
  }
  return (map[action] || {})[e] || null
}


// ── Vocabulary token sets — used by the pinned tests and the
//    no-fork-truth guard. ─────────────────────────────────────────

export const VOCAB_TOKENS = {
  finger: [
    'Grip part', 'Grip finished part',
    'Open gripper', 'Close gripper',
    'Release part', 'Release part into machine',
  ],
  vacuum: [
    'Vacuum off (ready)', 'Vacuum off', 'Vacuum on',
    'Engage vacuum', 'Disengage vacuum',
    'Blow off', 'Blow off stop', 'Wait for blow off',
    'Wait for vacuum seal',
  ],
  magnetic: [
    'Engage magnet', 'Disengage magnet', 'Magnet off (ready)', 'Magnet off',
  ],
  machine: [
    'Clamp workpiece', 'Unclamp workpiece',
    'Verify clamp engaged', 'Verify clamp released',
    'Start machine cycle', 'Cycle start pulse hold', 'End machine cycle pulse',
    'Wait for machine cycle',
  ],
}


// ── Machine-tending vocabulary ────────────────────────────────────
//
// Named machine-side outputs promoted to first-class steps (2026-07-
// 30 audit follow-up):
//   * Machine clamp        — DO, sustained
//   * Cycle start          — DO, PULSED (default 500 ms)
//   * Cycle done           — DI (input; wait_input target)
//   * Clamp confirmed      — DI (optional; auto-attached verify)
//
// Operators assign these on the I/O page like the effector roles.
// Assignment matching is substring / case-insensitive so both
// "Machine clamp" and factory-default "Fixture Clamp" resolve. If a
// role isn't assigned, the corresponding emitter returns an empty
// step list — the wizard/composer skip that step silently, so a
// program authored without a clamp signal doesn't emit a broken
// set_io on port undefined. Every emitter carries `io_role` so a
// later io_map remap propagates without label edits.

export const MACHINE_ROLES = {
  CLAMP_DO:       'Machine clamp',
  // Alt-token list is intentionally NARROW ("machine clamp",
  // "fixture clamp", NOT bare "clamp") because a Clamp confirmed
  // DI's assignment string ("Clamp Confirmed") would otherwise
  // match the CLAMP_DO lookup by substring. Keep bare-"clamp"
  // matches out; force operators to name the DO as "Machine clamp"
  // or "Fixture clamp" (both match the factory defaults).
  CLAMP_DO_ALTS:  ['machine clamp', 'fixture clamp'],
  CYCLE_START_DO: 'Cycle start',
  CYCLE_START_ALTS: ['cycle start', 'machine start'],
  CYCLE_DONE_DI:  'Cycle done',
  CYCLE_DONE_ALTS: ['cycle done', 'machine done', 'part done', 'cycle complete'],
  CLAMP_CONF_DI:  'Clamp confirmed',
  CLAMP_CONF_ALTS: ['clamp confirmed', 'clamp ok', 'fixture clamped'],
}

// Default pulse width on a machine cycle-start DO. Overridable per-
// program via config.machine.pulse_ms; also overridable per-step.
export const DEFAULT_CYCLE_PULSE_MS = 500
export const DEFAULT_CYCLE_WAIT_TIMEOUT_MS = 60000   // 60 s outer bound

// Look up a DO/DI port assigned to a machine role. Returns the port
// number (integer) or null when no matching assignment exists.
// Case-insensitive substring match against the operator's assignment
// string so "Machine Clamp", "machine clamp", "Fixture Clamp — Right"
// all resolve.
//
// `kind` restricts the search to DO / DI so a mis-typed assignment
// (e.g. "clamp confirmed" written on a DO row) doesn't accidentally
// hijack the role — the caller declares whether it wants an input
// or output.
export function machinePortFor(portmap, alts, kind /* 'DO' | 'DI' */) {
  const ports = (portmap && portmap.ports) || {}
  const lc = (alts || []).map((s) => String(s).toLowerCase())
  for (const [name, cfg] of Object.entries(ports)) {
    if (!name.startsWith(kind)) continue
    const asn = String((cfg && cfg.assignment) || '').trim().toLowerCase()
    if (!asn || asn === 'unassigned') continue
    if (lc.some((k) => asn.includes(k))) {
      const m = /^[A-Z]+(\d+)$/.exec(name)
      if (m) return parseInt(m[1], 10)
    }
  }
  return null
}


// ── Machine-tending emitters ─────────────────────────────────────
//
// Every emitter takes `portmap` (from useIOPortmap / /api/io/portmap).
// When the required role isn't assigned, returns [] so the wizard's
// step list stays coherent. Callers that consider machine tending
// mandatory (the "Machine tending" template) should surface a save-
// time error separately — see validateMachineTendingOrdering below.

// CLAMP — sustained DO ON. Auto-attaches verify_input when Clamp
// confirmed DI is assigned. The verify is the load-bearing safety
// step: it must fire BEFORE the robot releases its grip, otherwise
// an unclamped part will fall to the floor when the vacuum shuts
// off.
export function clampWorkpiece(portmap, opts = {}) {
  const doPort = machinePortFor(portmap, MACHINE_ROLES.CLAMP_DO_ALTS, 'DO')
  if (doPort == null) return []   // No clamp assigned — no-op emit.
  const out = [{
    action: 'set_io',
    label:  'Clamp workpiece',
    io_id:  `DO${doPort}`, value: 1,
    io_role: 'machine_clamp',
  }]
  const confirmPort = machinePortFor(portmap, MACHINE_ROLES.CLAMP_CONF_ALTS, 'DI')
  if (confirmPort != null) {
    out.push({
      action: 'verify_input',
      label:  'Verify clamp engaged',
      io_id:  `DI${confirmPort}`, expect: 1,
      timeout_ms: opts.clamp_confirm_timeout_ms != null
        ? opts.clamp_confirm_timeout_ms : 3000,
      on_fail: 'abort',
      io_role: 'clamp_confirmed',
    })
  }
  return out
}

// UNCLAMP — sustained DO OFF. Optional verify (some clamps report
// the released state on the same DI, some don't; when Clamp
// confirmed is assigned we expect it low after release).
export function unclampWorkpiece(portmap, opts = {}) {
  const doPort = machinePortFor(portmap, MACHINE_ROLES.CLAMP_DO_ALTS, 'DO')
  if (doPort == null) return []
  const out = [{
    action: 'set_io',
    label:  'Unclamp workpiece',
    io_id:  `DO${doPort}`, value: 0,
    io_role: 'machine_clamp',
  }]
  const confirmPort = machinePortFor(portmap, MACHINE_ROLES.CLAMP_CONF_ALTS, 'DI')
  if (confirmPort != null && opts.verifyRelease) {
    out.push({
      action: 'verify_input',
      label:  'Verify clamp released',
      io_id:  `DI${confirmPort}`, expect: 0,
      timeout_ms: opts.clamp_release_timeout_ms != null
        ? opts.clamp_release_timeout_ms : 3000,
      on_fail: 'abort',
      io_role: 'clamp_confirmed',
    })
  }
  return out
}

// CYCLE START — pulsed DO. Emits the triplet
//   set_io(DO,1) → wait(pulse_ms) → set_io(DO,0)
// The wait bracket is why we can't do this as a single set_io: many
// machine PLCs latch on the RISING edge only, and hold-high
// indefinitely would keep starting a new cycle each scan.
export function startMachineCycle(portmap, opts = {}) {
  const doPort = machinePortFor(portmap, MACHINE_ROLES.CYCLE_START_ALTS, 'DO')
  if (doPort == null) return []
  const requested = opts.pulse_ms != null ? opts.pulse_ms : DEFAULT_CYCLE_PULSE_MS
  const pulse_ms = Math.max(50, requested)
  return [
    { action: 'set_io',
      label:  'Start machine cycle',
      io_id:  `DO${doPort}`, value: 1,
      io_role: 'cycle_start' },
    { action: 'wait',
      label:  'Cycle start pulse hold',
      duration_s: pulse_ms / 1000.0 },
    { action: 'set_io',
      label:  'End machine cycle pulse',
      io_id:  `DO${doPort}`, value: 0,
      io_role: 'cycle_start' },
  ]
}

// WAIT-FOR-DONE — blocking verify_input on the Cycle done DI.
// timeout_ms is the outer bound; on_fail=abort so a stuck machine
// stops the program instead of hanging forever.
export function waitMachineCycle(portmap, opts = {}) {
  const diPort = machinePortFor(portmap, MACHINE_ROLES.CYCLE_DONE_ALTS, 'DI')
  if (diPort == null) return []
  return [{
    action:     'verify_input',
    label:      'Wait for machine cycle',
    io_id:      `DI${diPort}`, expect: 1,
    timeout_ms: opts.timeout_ms != null
      ? opts.timeout_ms : DEFAULT_CYCLE_WAIT_TIMEOUT_MS,
    on_fail:    'abort',
    io_role:    'cycle_done',
  }]
}


// ── Sequence guard: clamp → verify → release ordering ───────────
//
// Safety rule (bench-record 2026-07-30): between a Clamp workpiece
// step and its attached Verify clamp engaged, the operator MUST NOT
// insert a step that releases the robot's grip on the workpiece.
// Otherwise: robot puts part in fixture, releases grip, clamp fails
// to engage, part falls. The verify must gate the grip release.
//
// The clamp emitter above always emits the verify adjacent to the
// clamp, so the only way this rule fires is if a hand-edit
// reordered them OR a wizard template composed steps out of order.
// This validator is applied at save time to reject the program
// with a specific line-item error.

// Actions that release the robot's grip on the workpiece — every
// effector's disengage form. Kept in sync with the effectorDisengage
// emitter; if a new effector adds a release verb it must be added
// here or the guard silently misses it.
const RELEASE_ACTIONS = new Set([
  'open_gripper',   // finger
])
const RELEASE_IO_ROLES = new Set([
  'vacuum',         // set_io value=0 on vacuum port  = release
  'magnet',         // set_io value=0 on magnet port  = release
  // 'custom' isn't tracked with io_role today — sequence guard for
  // custom relies on the label-token check below.
])
const RELEASE_LABEL_TOKENS = [
  'release', 'gripper off', 'disengage vacuum', 'disengage magnet',
]

function _isReleaseStep(step) {
  if (!step || typeof step !== 'object') return false
  const action = String(step.action || '').toLowerCase()
  if (RELEASE_ACTIONS.has(action)) return true
  if (action === 'set_io' && step.value === 0) {
    const role = String(step.io_role || '').toLowerCase()
    if (RELEASE_IO_ROLES.has(role)) return true
    const label = String(step.label || '').toLowerCase()
    if (RELEASE_LABEL_TOKENS.some((t) => label.includes(t))) return true
  }
  return false
}

function _isClampStep(step) {
  if (!step || typeof step !== 'object') return false
  const role = String(step.io_role || '').toLowerCase()
  if (role === 'machine_clamp' && step.value === 1) return true
  return String(step.label || '').toLowerCase() === 'clamp workpiece'
}

function _isClampVerifyStep(step) {
  if (!step || typeof step !== 'object') return false
  if (String(step.action || '').toLowerCase() !== 'verify_input') return false
  return String(step.io_role || '').toLowerCase() === 'clamp_confirmed'
      && step.expect === 1
}

// Return an array of {step_index, reason, clamp_step_index}
// violations. Empty array means the sequence is safe.
//
// Rule fires ONLY when a Verify clamp engaged step exists somewhere
// after the clamp — that's the operator's declared intent that they
// want a verified clamp (evidenced by assigning Clamp confirmed DI
// in the io_map so the emitter attached one). If no verify exists
// downstream, either the operator opted out of a verified clamp
// (no Clamp confirmed DI assigned) or hand-edited it away; in
// neither case can this rule tell whether that's intentional. The
// verify's PRESENCE is what makes ordering enforceable.
export function validateMachineTendingOrdering(steps) {
  const violations = []
  const arr = Array.isArray(steps) ? steps : []
  for (let i = 0; i < arr.length; i++) {
    if (!_isClampStep(arr[i])) continue
    // Find the verify (if any) after this clamp.
    let verifyIdx = -1
    for (let j = i + 1; j < arr.length; j++) {
      if (_isClampVerifyStep(arr[j])) { verifyIdx = j; break }
    }
    if (verifyIdx < 0) continue   // no verify → nothing to enforce
    // Verify exists — check for release between clamp and verify.
    for (let j = i + 1; j < verifyIdx; j++) {
      const s = arr[j]
      if (_isReleaseStep(s)) {
        violations.push({
          step_index: j,
          clamp_step_index: i,
          reason: (
            `Step ${j + 1} (${s.label || s.action}) releases the ` +
            `robot's grip AFTER the clamp at step ${i + 1} but BEFORE ` +
            `the attached "Verify clamp engaged" at step ${verifyIdx + 1}. ` +
            `A failed clamp with the grip released drops the part — ` +
            `reorder so the verify runs first, or remove the release ` +
            `from between them.`),
        })
        break   // one violation per clamp is enough
      }
    }
  }
  return violations
}
