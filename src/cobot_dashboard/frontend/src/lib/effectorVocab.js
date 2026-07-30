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
}
