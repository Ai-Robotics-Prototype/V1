// DOCTRINE — Always-pneumatic fixture types skip the "how does this
// device work?" power question (2026-10-16 operator order).
//
// Pre-fix: every device type walked step 1 of the External Fixture
// wizard: "How does this device work? / The robot controls its air /
// It has its own controls — the robot just tells it to go / A person
// operates it." For vice/clamp and door/slide the answer is always
// "robot controls its air" — the question is pure noise. The operator
// order asks us to skip step 1 for always-pneumatic types.
//
// Fix: a per-type `power_fixed: true` flag on FIXTURE_TYPES entries
// drives a navigation skip in the wizard. The entry's existing
// defaults.power_mode='air' is already applied when the operator
// picks the type (see TypePicker's onPick handler), so skipping the
// question doesn't change the compiled record — the answer is just
// pre-set. Types where the power mode genuinely varies (feeder,
// indexer, custom "other") still ask.
//
// Pins:
//   * FIXTURE_TYPES.vice, FIXTURE_TYPES.door, FIXTURE_TYPES.blow_off
//     all carry `power_fixed: true`.
//   * FIXTURE_TYPES.indexer, FIXTURE_TYPES.feeder, FIXTURE_TYPES.other
//     do NOT carry `power_fixed: true` (the question is relevant).
//   * isPowerFixed(type) is exported from lib/fixturesData + is the
//     single resolver the wizard consults (no inline per-type if/else).
//   * ExternalFixtureWizard derives `skipsPower = isPowerFixed(answers.type)`.
//   * nextStep() skips step 1 when leaving step 0 for a power-fixed
//     type (jumps straight to step 2, or step 3 when actuation is
//     also skipped — blow_off).
//   * prevStep() skips step 1 when coming back from step 2 for a
//     power-fixed type (goes to step 0, not step 1).
//   * The compiled record still carries power_mode='air' for
//     power-fixed types (the TypePicker's onPick handler already
//     writes it from defaults.power_mode) — no change to downstream
//     port allocation / codegen.
//
// Failure format: DOCTRINE FIXTURE_POWER_FIXED VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  FIXTURE_TYPES, isPowerFixed, compileFixtureRecord,
} from '../../src/lib/fixturesData.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const wizSrc = readSrc('components/ExternalFixtureWizard.jsx')

function v(msg) { return `DOCTRINE FIXTURE_POWER_FIXED VIOLATED: ${msg}` }


// ── (1) Per-type flag table ─────────────────────────────────────────

test('vice / door / blow_off carry power_fixed: true (always pneumatic)', () => {
  for (const key of ['vice', 'door', 'blow_off']) {
    assert.equal(FIXTURE_TYPES[key].power_fixed, true,
      v(`FIXTURE_TYPES.${key} must carry power_fixed: true — vice, `
        + `door, and blow-off are always pneumatic per the 2026-10-16 `
        + `operator order.`))
  }
})

test('indexer / feeder / other DO NOT carry power_fixed (power varies)', () => {
  for (const key of ['indexer', 'feeder', 'other']) {
    assert.notEqual(FIXTURE_TYPES[key].power_fixed, true,
      v(`FIXTURE_TYPES.${key} must NOT carry power_fixed: true — the `
        + `operator chooses (own-controller vs air vs manual) for `
        + `these types.`))
  }
})

test('isPowerFixed is exported + matches the per-type flag', () => {
  assert.ok(typeof isPowerFixed === 'function',
    v('lib/fixturesData must export isPowerFixed — the single '
      + 'resolver ExternalFixtureWizard consults for the step-1 skip.'))
  for (const key of ['vice', 'door', 'blow_off']) {
    assert.equal(isPowerFixed(key), true,
      v(`isPowerFixed("${key}") must return true.`))
  }
  for (const key of ['indexer', 'feeder', 'other']) {
    assert.equal(isPowerFixed(key), false,
      v(`isPowerFixed("${key}") must return false.`))
  }
  assert.equal(isPowerFixed(null), false,
    v('isPowerFixed(null) must return false (no type → safe default).'))
  assert.equal(isPowerFixed('does-not-exist'), false,
    v('isPowerFixed("<unknown>") must return false (unknown type → safe).'))
})


// ── (2) Wizard navigation skips step 1 for power-fixed types ────────

test('ExternalFixtureWizard imports isPowerFixed + derives skipsPower', () => {
  assert.ok(
    /import\s*\{[\s\S]{0,300}isPowerFixed[\s\S]{0,120}\}\s*from\s*['"]\.\.\/lib\/fixturesData['"]/
      .test(wizSrc),
    v('ExternalFixtureWizard must import isPowerFixed from '
      + 'lib/fixturesData — the single-source navigation gate.'))
  assert.ok(
    /const skipsPower\s*=\s*isPowerFixed\(answers\.type\)/.test(wizSrc),
    v('ExternalFixtureWizard must derive '
      + '`const skipsPower = isPowerFixed(answers.type)` — the UI '
      + 'reads the per-type flag through the shared helper.'))
})

test('nextStep skips the power step when leaving step 0 for a power-fixed type', () => {
  // The nextStep body must branch on `step === 0 && skipsPower` BEFORE
  // the generic `setStep(Math.min(4, step + 1))` line, otherwise the
  // operator would still see the power screen for a split render.
  const idx = wizSrc.indexOf('function nextStep()')
  assert.ok(idx > 0, v('nextStep must exist.'))
  const stop = wizSrc.indexOf('function prevStep()', idx)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 2000)
  assert.ok(
    /if \(step === 0 && skipsPower\)\s*\{[\s\S]{0,500}setStep\(target\)/
      .test(chunk),
    v('nextStep must early-return into setStep(target) when '
      + '`step === 0 && skipsPower` — jump to step 2 (actuation) or '
      + 'step 3 (when actuation is also skipped — blow-off).'))
  assert.ok(
    /const target\s*=\s*skipsActuation\s*\?\s*3\s*:\s*2/.test(chunk),
    v('nextStep must compute target = skipsActuation ? 3 : 2 — handles '
      + 'blow-off (both power + actuation skipped → land on completion).'))
})

test('prevStep skips the power step when coming back from step 2 for a power-fixed type', () => {
  const idx = wizSrc.indexOf('function prevStep()')
  assert.ok(idx > 0, v('prevStep must exist.'))
  const stop = wizSrc.indexOf('async function commitSave', idx)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 2000)
  assert.ok(
    /if \(step === 2 && skipsPower\)\s*\{[\s\S]{0,200}setStep\(0\)/
      .test(chunk),
    v('prevStep must handle `step === 2 && skipsPower` → setStep(0) '
      + 'so back-nav from actuation lands on type-pick (not the hidden '
      + 'power step).'))
})


// ── (3) Compiled record is unchanged for power-fixed types ─────────

test('vice compiles to power_mode="air" without any wizard-provided answer', () => {
  // Simulate what TypePicker's onPick writes when the operator picks
  // "Vice / Clamp": the type is set + the defaults are spread onto
  // answers. The wizard skips step 1 (power), so answers.power_mode
  // is NOT re-set from the (hidden) PowerForkStep — it comes solely
  // from FIXTURE_TYPES.vice.defaults.power_mode.
  const typePickerAnswers = {
    type:         'vice',
    power_mode:   FIXTURE_TYPES.vice.defaults.power_mode,
    actuation:    FIXTURE_TYPES.vice.defaults.air_actuation,
    hold_on_loss: FIXTURE_TYPES.vice.defaults.hold_on_loss,
    completion:   'sensor',
  }
  const rec = compileFixtureRecord(typePickerAnswers, { tools: [], fixtures: [] })
  assert.equal(rec.power_mode, 'air',
    v('Vice compile with ONLY type-picker answers (no step-1 input) '
      + 'must still produce power_mode: "air" — the skip must not '
      + 'change the compiled record.'))
  assert.equal(rec.type, 'vice')
  assert.ok(rec.valve, v('Vice compile must still allocate a valve '
    + '(the air-side port allocation is unchanged by the skip).'))
})

test('door compiles to power_mode="air" without any wizard-provided answer', () => {
  const typePickerAnswers = {
    type:         'door',
    power_mode:   FIXTURE_TYPES.door.defaults.power_mode,
    actuation:    FIXTURE_TYPES.door.defaults.air_actuation,
    hold_on_loss: FIXTURE_TYPES.door.defaults.hold_on_loss,
    completion:   'sensor',
  }
  const rec = compileFixtureRecord(typePickerAnswers, { tools: [], fixtures: [] })
  assert.equal(rec.power_mode, 'air')
  assert.ok(rec.valve,
    v('Door compile must still allocate a valve for the air actuation.'))
})

test('blow_off compiles to power_mode="air" + air_actuation="blow_off"', () => {
  const typePickerAnswers = {
    type:         'blow_off',
    power_mode:   FIXTURE_TYPES.blow_off.defaults.power_mode,
    actuation:    FIXTURE_TYPES.blow_off.defaults.air_actuation,
    hold_on_loss: FIXTURE_TYPES.blow_off.defaults.hold_on_loss,
    completion:   'wait',
    wait_s:       0.3,
  }
  const rec = compileFixtureRecord(typePickerAnswers, { tools: [], fixtures: [] })
  assert.equal(rec.power_mode, 'air',
    v('Blow-off compile must set power_mode: "air" verbatim from the '
      + 'skipped type-picker answer.'))
  assert.equal(rec.actuation, 'blow_off',
    v('Blow-off compile must set actuation: "blow_off" verbatim from '
      + 'the type defaults.'))
})
