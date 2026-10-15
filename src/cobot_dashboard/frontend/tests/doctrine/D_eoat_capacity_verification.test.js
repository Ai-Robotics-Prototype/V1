// DOCTRINE — EOAT capacity + verification (2026-10-15 operator directive).
//
// The EOAT record now carries two permanent-truth fields the program
// wizard + codegen both consume:
//   * capacity: Number (1..10, default 1) — how many parts the tool
//     can hold at once. Gates the multi-pick question in the pick-
//     place wizard (hidden when capacity ≤ 1).
//   * verification: 'none'|'per_pick'|'per_part' — does the tool
//     sense that it grabbed the part. Gates the post-engage wait-
//     input emission in buildSteps.
// Both are append-only on the record. Existing EOATs saved before
// this directive migrate safely via lib/eoatVerification helpers
// (capacity defaults to 1; verification is 'per_pick' when any sensor
// is wired, else 'none'; 'per_part' is explicit opt-in only).
//
// Pins:
//   * lib/eoatVerification exports the canonical mode enum + three
//     resolver functions + the gating predicates.
//   * Migration: a record with no verification field + sensor_count ≥ 1
//     resolves to 'per_pick'; without sensors it resolves to 'none'.
//     per_part is NEVER auto-migrated (visible-behavior-change rule).
//   * Standard-path EOATSetupWizard renders the Capacity input ALWAYS
//     and the per_pick/per_part Verification picker ONLY when
//     capacity > 1 AND sensor_count ≥ 1.
//   * Gripper-path copy never mentions suction; vacuum-path copy never
//     mentions grippers. (The _standardCellEntry mapping is already
//     type-separated — this pin seals it against drift.)
//   * ProgramWizard declares a multi_pick_count step; its skip
//     predicate consults the SELECTED tool via _wizardSelectedEoat
//     and hides when capacity ≤ 1. The question copy is plain
//     ("Pick one part at a time, or grab several before placing?").
//   * verificationStepsForEoat emits [] for a capacity-1 / verification-
//     none tool (1/1 byte-identical equivalence), one verify_input for
//     per_pick, one verify_input per part for per_part.
//   * buildSteps emits the verification step AFTER effectorEngage in
//     both the single-pair pick side AND the multi-pair paired loop.
//   * buildPalletizeSteps emits the verification step after its pick
//     engageSteps() (same no-fork emission for pallet programs).
//
// Failure format: DOCTRINE EOAT_VERIFICATION VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  VERIFICATION_MODES, VERIFICATION_NONE,
  VERIFICATION_PER_PICK, VERIFICATION_PER_PART,
  CAPACITY_MIN, CAPACITY_MAX,
  clampCapacity, resolveCapacity, resolveVerification,
  resolveConfirmSignals, signalTypeLabel,
  offersMultiPick, emitsVerificationStep,
} from '../../src/lib/eoatVerification.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc    = readSrc('components/ProgramWizard.jsx')
const eoatWizSrc    = readSrc('components/EOATSetupWizard.jsx')
const verifSrc      = readSrc('lib/eoatVerification.js')

function v(msg) { return `DOCTRINE EOAT_VERIFICATION VIOLATED: ${msg}` }


// ── (1) Canonical mode enum + resolvers ─────────────────────────────

test('eoatVerification exports the three canonical modes', () => {
  assert.deepEqual([...VERIFICATION_MODES],
    [VERIFICATION_NONE, VERIFICATION_PER_PICK, VERIFICATION_PER_PART],
    v('VERIFICATION_MODES must be [none, per_pick, per_part] in that '
      + 'order — the single source of truth both the wizard UI and '
      + 'codegen consult.'))
  assert.equal(VERIFICATION_NONE,     'none')
  assert.equal(VERIFICATION_PER_PICK, 'per_pick')
  assert.equal(VERIFICATION_PER_PART, 'per_part')
})

test('CAPACITY bounds are 1..10 and clampCapacity enforces them', () => {
  assert.equal(CAPACITY_MIN, 1)
  assert.equal(CAPACITY_MAX, 10)
  for (const [input, want] of [
    [null,       1],
    [undefined,  1],
    ['foo',      1],
    [0,          1],
    [-5,         1],
    [1,          1],
    [5,          5],
    [10,        10],
    [99,        10],
    [3.6,        4],
  ]) {
    assert.equal(clampCapacity(input), want,
      v(`clampCapacity(${JSON.stringify(input)}) must be ${want}.`))
  }
})

test('resolveCapacity defaults missing records to 1', () => {
  assert.equal(resolveCapacity(null), 1)
  assert.equal(resolveCapacity({}), 1)
  assert.equal(resolveCapacity({ capacity: 4 }), 4)
  assert.equal(resolveCapacity({ capacity: 15 }), 10,
    v('resolveCapacity clamps above-max values.'))
})


// ── (2) Verification migration ──────────────────────────────────────

test('resolveVerification migrates pre-directive records safely', () => {
  // No sensors wired → 'none'.
  assert.equal(resolveVerification({ type: 'vacuum', inputs: [], sensor_count: 0 }),
    VERIFICATION_NONE,
    v('An EOAT with no sensors + no explicit verification → "none".'))
  // One sensor wired, no explicit verification → 'per_pick' (safe
  // default; same operator-visible behavior as the pre-directive
  // flow which already waited on the single sensor).
  assert.equal(resolveVerification({ type: 'vacuum', inputs: ['IN1'], sensor_count: 1 }),
    VERIFICATION_PER_PICK,
    v('An EOAT with ≥1 sensor + no explicit verification → "per_pick".'))
  // Explicit per_pick / per_part / none all round-trip verbatim.
  assert.equal(resolveVerification({ verification: 'per_part', inputs: ['IN1', 'IN2'] }),
    VERIFICATION_PER_PART)
  assert.equal(resolveVerification({ verification: 'none', inputs: ['IN1'] }),
    VERIFICATION_NONE)
})

test('per_part is NEVER auto-migrated (visible-behavior-change rule)', () => {
  // Even with 2 sensors wired, migration default is per_pick (one
  // wait-input per cycle, like pre-directive). per_part requires the
  // operator to explicitly opt in via the Verification picker.
  const record = { type: 'vacuum', inputs: ['IN1', 'IN2'], sensor_count: 2 }
  assert.equal(resolveVerification(record), VERIFICATION_PER_PICK,
    v('Multi-sensor records without explicit verification still migrate '
      + 'to per_pick — per_part changes codegen fan-out and must be '
      + 'opt-in only.'))
})


// ── (3) Confirm-signal derivation ───────────────────────────────────

test('resolveConfirmSignals returns [] for none verification', () => {
  assert.deepEqual(
    resolveConfirmSignals({ verification: 'none', inputs: ['IN1'] }), [])
})

test('resolveConfirmSignals returns first signal for per_pick', () => {
  assert.deepEqual(
    resolveConfirmSignals({ verification: 'per_pick', inputs: ['IN3', 'IN4'] }),
    ['IN3'])
})

test('resolveConfirmSignals returns capacity-capped list for per_part', () => {
  // 3 signals wired, capacity 2 → first 2 signals.
  assert.deepEqual(
    resolveConfirmSignals({ verification: 'per_part', capacity: 2,
                            inputs: ['IN1', 'IN2', 'IN3'] }),
    ['IN1', 'IN2'])
  // 2 signals wired, capacity 5 → all 2 signals (don't invent).
  assert.deepEqual(
    resolveConfirmSignals({ verification: 'per_part', capacity: 5,
                            inputs: ['IN7', 'IN8'] }),
    ['IN7', 'IN8'])
})


// ── (4) Type-aware signal label ─────────────────────────────────────

test('signalTypeLabel speaks the tool-type\'s own vocabulary', () => {
  assert.equal(signalTypeLabel({ type: 'vacuum' }), 'vacuum pressure signal',
    v('Vacuum EOATs must label their confirm signal as "vacuum pressure '
      + 'signal" — never gripper vocabulary.'))
  assert.equal(signalTypeLabel({ type: 'finger' }), 'grip sensor',
    v('Finger-gripper EOATs must label their confirm signal as '
      + '"grip sensor" — never vacuum vocabulary.'))
  // Custom tools: label follows declared capabilities.
  assert.equal(signalTypeLabel({ type: 'custom', has_suction: true, has_grippers: false }),
    'vacuum pressure signal')
  assert.equal(signalTypeLabel({ type: 'custom', has_suction: false, has_grippers: true }),
    'grip sensor')
})


// ── (5) Gating predicates ───────────────────────────────────────────

test('offersMultiPick is true only when capacity > 1', () => {
  assert.equal(offersMultiPick(null),              false)
  assert.equal(offersMultiPick({}),                false)
  assert.equal(offersMultiPick({ capacity: 1 }),   false,
    v('capacity 1 → multi-pick question MUST stay hidden (operator rule).'))
  assert.equal(offersMultiPick({ capacity: 2 }),   true)
  assert.equal(offersMultiPick({ capacity: 10 }),  true)
})

test('emitsVerificationStep gates both the wizard + codegen in one predicate', () => {
  assert.equal(emitsVerificationStep({ verification: 'none', inputs: ['IN1'] }),
    false, v('verification "none" → no emit, even with wired inputs.'))
  assert.equal(emitsVerificationStep({ verification: 'per_pick', inputs: [] }),
    false, v('No wired inputs → no emit, even when verification is set.'))
  assert.equal(emitsVerificationStep({ verification: 'per_pick', inputs: ['IN2'] }),
    true)
  assert.equal(emitsVerificationStep({ verification: 'per_part', capacity: 2,
                                       inputs: ['IN2', 'IN3'] }),
    true)
})


// ── (6) EOAT wizard UI shape ────────────────────────────────────────

test('EOATSetupWizard renders the Capacity input on standard paths', () => {
  assert.ok(/function StandardCapacityInput\(/.test(eoatWizSrc),
    v('EOATSetupWizard must define StandardCapacityInput — the shared '
      + 'capacity stepper for the standard paths.'))
  assert.ok(/<StandardCapacityInput\b[\s\S]{0,400}activeStandardCapacity/.test(eoatWizSrc),
    v('EOATSetupWizard must mount <StandardCapacityInput> with the '
      + 'activeStandardCapacity derivation — one card per standard tool.'))
  assert.ok(/data-testid="hardware-setup-standard-capacity"/.test(eoatWizSrc),
    v('StandardCapacityInput must stamp data-testid="hardware-setup-'
      + 'standard-capacity" for operator-facing selection.'))
})

test('EOATSetupWizard renders the Verification picker only when capacity > 1 + sensors ≥ 1', () => {
  // Mount condition verbatim: activeStandardCapacity > 1 AND
  // (activeStandardSensorCount ?? 0) >= 1. Both guards must be live;
  // if either drops, the hidden-when-not-relevant rule breaks.
  assert.ok(
    /<StandardVerificationMode\b[\s\S]{0,400}activeStandardVerification/.test(eoatWizSrc),
    v('EOATSetupWizard must mount <StandardVerificationMode> with the '
      + 'activeStandardVerification derivation.'))
  assert.ok(
    /activeStandardCapacity > 1[\s\S]{0,200}activeStandardSensorCount[\s\S]{0,80}>= 1[\s\S]{0,400}<StandardVerificationMode\b/
      .test(eoatWizSrc),
    v('The <StandardVerificationMode> mount must be gated on '
      + 'activeStandardCapacity > 1 AND (activeStandardSensorCount ?? 0) '
      + '>= 1 — otherwise the mode is deterministic and the operator '
      + 'has nothing to decide.'))
  assert.ok(/data-testid="hardware-setup-standard-verification"/.test(eoatWizSrc),
    v('StandardVerificationMode must stamp data-testid="hardware-setup-'
      + 'standard-verification" so e2e tests can observe when it appears.'))
})

test('_standardCellEntry writes capacity + verification + confirm_signals', () => {
  assert.ok(/function _standardCellEntry\(\{[\s\S]{0,200}capacity,\s*verification\s*\}\)/.test(eoatWizSrc),
    v('_standardCellEntry must accept capacity + verification in its '
      + 'arg destructure — the two new permanent-truth fields.'))
  // Returned entry must carry all three new fields (capacity,
  // verification, confirm_signals). The order of serialization doesn't
  // matter; existence does.
  for (const field of ['capacity:', 'verification:', 'confirm_signals']) {
    assert.ok(new RegExp(field).test(eoatWizSrc),
      v(`_standardCellEntry's return value must set ${field.replace(':', '')} — `
        + `codegen reads these from the resolved cell record.`))
  }
})


// ── (7) Copy separation — gripper path ↔ vacuum path ────────────────

test('Vacuum-path cell entry does not mention gripper vocabulary', () => {
  // _standardCellEntry's vacuum branch sets label 'vacuum'; the finger
  // branch sets 'gripper'. The strings must not cross — operators who
  // picked Vacuum should never see "gripper" in the resulting record.
  // Scope the sweep to the _standardCellEntry function body only;
  // other sites in the file legitimately handle both tool kinds.
  const entryIdx = eoatWizSrc.indexOf('function _standardCellEntry(')
  assert.ok(entryIdx > 0, v('_standardCellEntry function must exist.'))
  const vacuumIdx  = eoatWizSrc.indexOf("toolKey === 'vacuum'", entryIdx)
  const fingerIdx  = eoatWizSrc.indexOf('finger (and any future paired-coil', entryIdx)
  assert.ok(vacuumIdx > 0 && fingerIdx > vacuumIdx,
    v('_standardCellEntry must retain its type-separated branches.'))
  const vacuumBlock = eoatWizSrc.slice(vacuumIdx, fingerIdx)
  assert.ok(!/gripper/i.test(vacuumBlock),
    v('Vacuum-path _standardCellEntry branch must NOT contain the word '
      + '"gripper" — plain-copy rule (vacuum ≠ gripper).'))
  assert.ok(!/finger/i.test(vacuumBlock),
    v('Vacuum-path branch must NOT contain the word "finger" either.'))
})

test('Finger-path cell entry does not mention vacuum vocabulary', () => {
  const fingerIdx  = eoatWizSrc.indexOf('finger (and any future paired-coil')
  const endIdx     = eoatWizSrc.indexOf('return {', fingerIdx)
  assert.ok(fingerIdx > 0 && endIdx > fingerIdx,
    v('_standardCellEntry finger branch must exist with a return block.'))
  const fingerBlock = eoatWizSrc.slice(fingerIdx, endIdx)
  assert.ok(!/vacuum/i.test(fingerBlock),
    v('Finger-path _standardCellEntry branch must NOT contain the word '
      + '"vacuum" — plain-copy rule.'))
  assert.ok(!/suction/i.test(fingerBlock),
    v('Finger-path branch must NOT contain the word "suction" either.'))
})


// ── (8) ProgramWizard multi-pick step ───────────────────────────────

test('ProgramWizard declares a multi_pick_count step', () => {
  assert.ok(/id:\s*['"]multi_pick_count['"]/.test(progWizSrc),
    v('ProgramWizard must declare id:"multi_pick_count" — the pick-'
      + 'place wizard\'s per-cycle multi-pick question.'))
})

test('multi_pick_count skip gates on tool capacity via offersMultiPick', () => {
  // The skip predicate must consult _wizardSelectedEoat + offersMultiPick
  // so the question stays hidden when the operator has not yet picked
  // a tool, or when the selected tool has capacity ≤ 1.
  const idx = progWizSrc.indexOf("id: 'multi_pick_count'")
  assert.ok(idx > 0, v('multi_pick_count step must exist.'))
  const chunk = progWizSrc.slice(idx, idx + 2000)
  assert.ok(/_wizardSelectedEoat\(answers\)/.test(chunk),
    v('multi_pick_count skip must call _wizardSelectedEoat(answers) to '
      + 'reach the current cell snapshot (the engine does not thread '
      + 'cellRegistry through skip).'))
  assert.ok(/offersMultiPick\(eoat\)/.test(chunk),
    v('multi_pick_count skip must return !offersMultiPick(eoat) — the '
      + 'tool\'s permanent-truth capacity gate.'))
  assert.ok(/if \(!eoat\) return true/.test(chunk),
    v('multi_pick_count skip must return true when no tool is picked '
      + 'yet — the question needs a tool to anchor on.'))
})

test('multi_pick_count copy is plain operator language', () => {
  assert.ok(/Pick one part at a time, or grab several before placing\?/.test(progWizSrc),
    v('multi_pick_count copy must ask verbatim "Pick one part at a '
      + 'time, or grab several before placing?" per the 2026-10-15 '
      + 'operator directive.'))
  assert.ok(/One at a time/.test(progWizSrc)
         && /Grab several/.test(progWizSrc),
    v('The two choice buttons must read "One at a time" + "Grab '
      + 'several" verbatim.'))
})


// ── (9) Codegen verification emission ───────────────────────────────

test('verificationStepsForEoat exists + emits via resolveConfirmSignals', () => {
  assert.ok(/function verificationStepsForEoat\(cellEoat,/.test(progWizSrc),
    v('ProgramWizard must define verificationStepsForEoat as the single '
      + 'builder for post-engage wait-input emission.'))
  assert.ok(/if \(!emitsVerificationStep\(cellEoat\)\) return \[\]/.test(progWizSrc),
    v('verificationStepsForEoat must early-return [] when the shared '
      + 'emitsVerificationStep predicate says no — single gate shared '
      + 'with wizard surfaces.'))
  assert.ok(/const signals = resolveConfirmSignals\(cellEoat\)/.test(progWizSrc),
    v('verificationStepsForEoat must read resolveConfirmSignals — '
      + 'operator never picks DI numbers; the shared allocator\'s '
      + 'confirm_signals are the sole source.'))
})

test('verify_input steps emit on_fail=stop + reason="part not confirmed"', () => {
  const vIdx = progWizSrc.indexOf('function verificationStepsForEoat')
  const chunk = progWizSrc.slice(vIdx, vIdx + 2000)
  assert.ok(/on_fail:\s*['"]stop['"]/.test(chunk),
    v('verify_input must carry on_fail: "stop" — failed verification '
      + 'is a safe-default stop per the operator order.'))
  assert.ok(/reason:\s*['"]part not confirmed['"]/.test(chunk),
    v('verify_input must carry reason: "part not confirmed" — the '
      + 'operator-facing stop reason that lands in the Run modal / '
      + 'Monitor pill in plain language.'))
})

test('buildSteps emits verificationStepsForEoat in single-pair pick side', () => {
  const sIdx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(sIdx, sIdx + 18000)
  // The single-pair pick side must call verificationStepsForEoat
  // immediately after effectorEngage.
  assert.ok(
    /action: 'move_linear', label: 'Pick position — contact'[\s\S]{0,400}effectorEngage\(cfgEffector[\s\S]{0,400}verificationStepsForEoat\(cellEoat,\s*\{\s*partsOnPick:\s*1,\s*partIndex:\s*1\s*\}\)/
      .test(chunk),
    v('buildSteps single-pair pick path must call '
      + 'verificationStepsForEoat(cellEoat, {partsOnPick:1, partIndex:1}) '
      + 'right after effectorEngage.'))
})

test('buildSteps emits verificationStepsForEoat inside the multi-pair loop', () => {
  const sIdx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(sIdx, sIdx + 18000)
  assert.ok(
    /for \(let i = 1; i <= K; i\+\+\)[\s\S]{0,2000}effectorEngage\(cfgEffector[\s\S]{0,400}verificationStepsForEoat\(cellEoat,\s*\{\s*partsOnPick:\s*K,\s*partIndex:\s*i\s*\}\)/
      .test(chunk),
    v('buildSteps multi-pair paired loop must call '
      + 'verificationStepsForEoat(cellEoat, {partsOnPick:K, partIndex:i}) '
      + 'inside the loop, right after effectorEngage.'))
})

test('buildPalletizeSteps emits verificationStepsForEoat after pick engage', () => {
  const pIdx = progWizSrc.indexOf('function buildPalletizeSteps')
  const chunk = progWizSrc.slice(pIdx, pIdx + 10000)
  assert.ok(
    /steps\.push\(\.\.\.engageSteps\(\)\)[\s\S]{0,400}verificationStepsForEoat\(cellEoat/
      .test(chunk),
    v('buildPalletizeSteps must call verificationStepsForEoat(cellEoat, '
      + '...) after its pick engageSteps() — no-fork emission vs the '
      + 'generic buildSteps path.'))
})


// ── (10) Byte-identical equivalence pin ─────────────────────────────

test('verificationStepsForEoat returns [] for null / none / no-signals', () => {
  // The pin suite can't directly import ProgramWizard (it's a React
  // module), so we rely on the shared helpers it depends on. Those
  // helpers' tests above cover the equivalence invariant transitively:
  // any cellEoat that resolves to emitsVerificationStep === false produces
  // zero verify_input emissions — exactly today's output.
  for (const entry of [
    null,
    {},
    { verification: 'none' },
    { verification: 'per_pick', inputs: [] },
    { verification: 'per_pick' },
  ]) {
    assert.equal(emitsVerificationStep(entry), false,
      v(`entry ${JSON.stringify(entry)} must NOT trigger verification `
        + `emission — the 1/1 equivalence pin reduces to this.`))
    assert.deepEqual(resolveConfirmSignals(entry), [],
      v(`resolveConfirmSignals(${JSON.stringify(entry)}) must be [].`))
  }
})
