// EOAT verification model (2026-10-15 operator directive).
//
// A single physical truth about the end-of-arm tool: how many parts
// can it hold at once (capacity), and does it have a sensor that
// confirms it actually got the part (verification). These two answers
// drive BOTH the pick-place wizard's multi-pick question (hidden when
// capacity ≤ 1) and the codegen's post-engage verify-input emission
// (silent when verification is 'none').
//
// Shape of an EOAT entry (append-only; existing cells migrate safely):
//
//   {
//     id, name, type ('finger'|'vacuum'|'custom'),
//     valve, inputs: [IN-port…], outputs: [], actuators: [...],
//     sensor_count,
//
//     // 2026-10-15 additions:
//     capacity:      Number,                    // 1..10, default 1
//     verification: 'none'|'per_pick'|'per_part', // default: migrated
//     confirm_signals: [IN-port…],              // derived from `inputs`
//   }
//
// Migration rule (resolveVerification): an EOAT saved before the
// 2026-10-15 directive carries no `verification` field. We infer:
//   * capacity → entry.capacity if finite, else 1 (clamped 1..10)
//   * verification → explicit entry.verification wins; otherwise
//     'per_pick' when any sensor is wired (inputs.length ≥ 1 OR
//     sensor_count ≥ 1), else 'none'. 'per_part' is NEVER auto-
//     migrated — it requires an explicit operator opt-in because it
//     means N wait-input emits per cycle (visible behavior change).
//
// All functions are pure. Same module backs the wizard UI, the
// ProgramWizard multi-pick gate, and buildSteps codegen — so a copy
// change (adding a mode, renaming a key) lands in one place.

export const VERIFICATION_NONE     = 'none'
export const VERIFICATION_PER_PICK = 'per_pick'
export const VERIFICATION_PER_PART = 'per_part'

export const VERIFICATION_MODES = Object.freeze([
  VERIFICATION_NONE,
  VERIFICATION_PER_PICK,
  VERIFICATION_PER_PART,
])

export const CAPACITY_MIN = 1
export const CAPACITY_MAX = 10

export function clampCapacity(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return CAPACITY_MIN
  return Math.max(CAPACITY_MIN, Math.min(CAPACITY_MAX, Math.round(v)))
}

export function resolveCapacity(entry) {
  if (!entry) return CAPACITY_MIN
  return clampCapacity(entry.capacity)
}

export function resolveVerification(entry) {
  if (!entry) return VERIFICATION_NONE
  const explicit = String(entry.verification || '').toLowerCase().trim()
  if (VERIFICATION_MODES.includes(explicit)) return explicit
  // Migration path for records saved before the directive. Any wired
  // sensor → per_pick (safe default — same operator-visible behavior
  // as the pre-directive flow, which already fired a single wait-
  // input downstream for tools that declared a sensor). per_part is
  // opt-in only.
  const sensors = Array.isArray(entry.inputs) ? entry.inputs.length : 0
  const declared = Number.isFinite(entry.sensor_count) ? entry.sensor_count : 0
  if (sensors > 0 || declared > 0) return VERIFICATION_PER_PICK
  return VERIFICATION_NONE
}

// Derive the ordered confirm-signal IN port list the codegen will
// consume. For per_pick: the FIRST signal fires once per cycle. For
// per_part: all signals fire (one per part held). For none: [].
// Reads entry.confirm_signals when the record was authored under the
// post-directive schema; otherwise falls back to entry.inputs (the
// shared allocator's existing output — no fork).
export function resolveConfirmSignals(entry) {
  if (!entry) return []
  const mode = resolveVerification(entry)
  if (mode === VERIFICATION_NONE) return []
  const explicit = Array.isArray(entry.confirm_signals) ? entry.confirm_signals : null
  const inputs   = Array.isArray(entry.inputs)          ? entry.inputs          : []
  const signals = (explicit && explicit.length) ? explicit : inputs
  if (!signals.length) return []
  if (mode === VERIFICATION_PER_PICK) return [signals[0]]
  // per_part: return as many signals as we have, capped by capacity.
  const cap = resolveCapacity(entry)
  return signals.slice(0, Math.max(1, cap))
}

// Operator-facing signal type for the plain-copy wiring prompt. Vacuum
// cups talk about pressure; grippers talk about part-presence. The
// wizard uses this label on the hookup / glowing-map prompt so the
// operator sees "vacuum pressure signal" or "grip sensor" — never
// "DI12" (that's the shared allocator's job).
export function signalTypeLabel(entry) {
  if (!entry) return 'confirmation signal'
  const t = String(entry.type || '').toLowerCase().trim()
  const hasSuction = !!entry.has_suction
  const hasGrippers = !!entry.has_grippers
  if (t === 'vacuum')  return 'vacuum pressure signal'
  if (t === 'finger')  return 'grip sensor'
  // Custom tools: fall back to whatever the operator declared.
  if (hasSuction && !hasGrippers) return 'vacuum pressure signal'
  if (hasGrippers && !hasSuction) return 'grip sensor'
  if (hasSuction &&  hasGrippers) return 'vacuum pressure + grip sensor'
  return 'confirmation signal'
}

// True when the ProgramWizard should SURFACE the multi-pick question
// for the operator. Rule: the selected tool's capacity > 1.
// Capacity 1 → the question stays hidden. Operator-order honored.
export function offersMultiPick(entry) {
  return resolveCapacity(entry) > 1
}

// True when the pick-place sequence must emit a wait-input after
// effectorEngage. Guard both the wizard-level multi-pick question
// and the codegen in one predicate so the two paths cannot drift.
export function emitsVerificationStep(entry) {
  return resolveVerification(entry) !== VERIFICATION_NONE
    && resolveConfirmSignals(entry).length > 0
}
