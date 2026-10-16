// DOCTRINE — External Fixture wizard completion copy is DEVICE-TYPE
// adapted (2026-10-16 operator field report).
//
// Pre-fix: setting up a DOOR actuator, the wizard's step-3 "completion"
// question showed the generic headline "How will the robot know it's
// finished?" with options "A sensor tells it / It always takes about
// the same time / A person presses continue." For a door, "finished"
// is "the door reached open/closed." The copy did not fit a door, and
// — by extension — did not fit a vice ("clamped"), an indexer ("in
// position"), a feeder ("part at the pickup"), or a blow-off (just a
// timed pulse, no "finished" state to detect at all).
//
// Fix: each FIXTURE_TYPES entry carries a `completion` sub-object that
// drives CompletionStep's wording. The sub-object is purely data —
// CompletionStep renders from it without any per-type if/else chain.
// A helper completionCopyFor(type) returns the type's bespoke config
// (or _GENERIC_COMPLETION for safety). Door = position-sensor copy.
// Blow-off = ONLY the 'wait' option, labeled "Pulse length."
//
// Pins:
//   * completionCopyFor is exported from lib/fixturesData and returns
//     a well-formed config for every shipped device type.
//   * Each shipped FIXTURE_TYPES entry (vice, indexer, feeder, blow_off,
//     door, other) carries a `completion` sub-object with a question
//     string and an options array.
//   * Door's completion question references "open" and "closed", NOT
//     the generic "finished" wording.
//   * Blow-off exposes ONLY the 'wait' option (no 'sensor' / 'operator'
//     — the device just pulses) and labels the wait field "Pulse length".
//   * CompletionStep JSX reads `copy.question` + `copy.options` + the
//     per-option entries (no inline string literals that could drift
//     from the data).
//   * The retired generic headline "How will the robot know it's
//     finished?" no longer appears as a hard-coded JSX literal in
//     CompletionStep (it lives ONCE as a template-level string in
//     _GENERIC_COMPLETION / `other`.completion).
//
// Failure format: DOCTRINE FIXTURE_COMPLETION VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  FIXTURE_TYPES, FIXTURE_TYPE_KEYS, completionCopyFor,
} from '../../src/lib/fixturesData.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const wizSrc   = readSrc('components/ExternalFixtureWizard.jsx')
const dataSrc  = readSrc('lib/fixturesData.js')

function v(msg) { return `DOCTRINE FIXTURE_COMPLETION VIOLATED: ${msg}` }


// ── (1) Data-driven config exists for every shipped type ────────────

test('completionCopyFor is exported + returns a well-formed config', () => {
  assert.ok(typeof completionCopyFor === 'function',
    v('lib/fixturesData must export completionCopyFor — the single '
      + 'resolver CompletionStep consumes to pick per-type copy.'))
  // Fallback for null / unknown type → still returns a working config.
  const fallback = completionCopyFor(null)
  assert.ok(fallback && typeof fallback.question === 'string',
    v('completionCopyFor(null) must return a well-formed fallback '
      + 'config so a type-less answer never crashes the step.'))
  assert.ok(Array.isArray(fallback.options) && fallback.options.length > 0,
    v('Fallback completion config must carry options[] with ≥1 entry.'))
})

test('Every shipped device type carries a completion sub-object', () => {
  for (const key of FIXTURE_TYPE_KEYS) {
    const def = FIXTURE_TYPES[key]
    assert.ok(def && def.completion,
      v(`FIXTURE_TYPES.${key} must declare a completion sub-object — `
        + `the per-type copy that drives CompletionStep.`))
    assert.ok(typeof def.completion.question === 'string'
              && def.completion.question.length > 0,
      v(`FIXTURE_TYPES.${key}.completion.question must be a non-empty `
        + `string — the operator-facing headline for this type's step.`))
    assert.ok(Array.isArray(def.completion.options)
              && def.completion.options.length > 0,
      v(`FIXTURE_TYPES.${key}.completion.options must be a non-empty `
        + `array — the subset of completion kinds shown for this type.`))
  }
})


// ── (2) Door-specific wording ───────────────────────────────────────

test('Door completion asks about "open or closed", NOT "finished"', () => {
  const door = completionCopyFor('door')
  assert.ok(/open or closed/i.test(door.question),
    v('Door completion question must reference "open or closed" — the '
      + 'operator-facing door states. Current question: '
      + JSON.stringify(door.question)))
  assert.equal(/finished/i.test(door.question), false,
    v('Door completion question must NOT contain the generic word '
      + '"finished" — the 2026-10-16 operator field report was '
      + 'explicit that this copy did not fit a door.'))
})

test('Door offers all three completion kinds with door-term labels', () => {
  const door = completionCopyFor('door')
  assert.deepEqual(door.options, ['sensor', 'wait', 'operator'],
    v('Door completion must offer sensor + wait + operator — the '
      + 'full three-way choice.'))
  // Sensor copy must call out a door POSITION sensor (not generic).
  assert.ok(/door\s+position\s+sensor/i.test(door.sensor.label)
         || /door\s+position\s+sensor/i.test(door.sensor.desc),
    v('Door sensor option must reference "door position sensor" — '
      + 'specific to the door type (operator order).'))
  // Wait copy's label must reframe "wait time" as "how long to open or close".
  assert.ok(/open\s+or\s+close/i.test(door.wait.waitLabel),
    v('Door wait option\'s waitLabel must read "How long to open or '
      + 'close?" (or similar open/close phrasing) instead of the '
      + 'generic "Wait time".'))
})


// ── (3) Blow-off special-case: wait-only, pulse-length label ────────

test('Blow-off completion offers ONLY the wait option', () => {
  const blow = completionCopyFor('blow_off')
  assert.deepEqual(blow.options, ['wait'],
    v('blow_off completion.options must be exactly ["wait"] — the '
      + 'operator order "usually no completion, it just pulses" '
      + 'maps to a single timed-pulse question, no sensor/operator '
      + 'alternatives.'))
  assert.equal(blow.sensor, undefined,
    v('blow_off completion must NOT carry a sensor sub-config — it '
      + 'has no "finished" state to detect.'))
  assert.equal(blow.operator, undefined,
    v('blow_off completion must NOT carry an operator sub-config.'))
})

test('Blow-off wait field is labeled "Pulse length" (not "Wait time")', () => {
  const blow = completionCopyFor('blow_off')
  assert.ok(/\bpulse\b/i.test(blow.question),
    v('blow_off completion question must reference "pulse" — the '
      + 'operator-facing framing for a blow-off is pulse duration, '
      + 'not "finished."'))
  assert.ok(/pulse\s+length/i.test(blow.wait.waitLabel),
    v('blow_off wait field must be labeled "Pulse length" (not '
      + '"Wait time") — the operator sees the blow-off\'s physical '
      + 'knob, not generic completion jargon.'))
})


// ── (4) Other types' wording also fits (vice / indexer / feeder) ───

test('Vice completion asks about "clamped"', () => {
  const vice = completionCopyFor('vice')
  assert.ok(/clamp/i.test(vice.question),
    v('Vice completion question must reference "clamp" / "clamped" — '
      + 'the operator-facing state for a vice.'))
  assert.equal(/finished/i.test(vice.question), false,
    v('Vice completion question must NOT use the generic "finished" '
      + 'wording.'))
})

test('Indexer completion asks about "in position"', () => {
  const idx = completionCopyFor('indexer')
  assert.ok(/in\s+position/i.test(idx.question)
         || /indexed/i.test(idx.question),
    v('Indexer completion question must reference "in position" or '
      + '"indexed" — not generic "finished".'))
})

test('Feeder completion asks about "part at the pickup"', () => {
  const feeder = completionCopyFor('feeder')
  assert.ok(/part/i.test(feeder.question)
         && /pickup/i.test(feeder.question),
    v('Feeder completion question must reference "part" + "pickup" — '
      + 'the operator-facing state for a feeder/conveyor.'))
})


// ── (5) CompletionStep renders from the config (no inline literals) ─

test('CompletionStep calls completionCopyFor(answers.type)', () => {
  assert.ok(
    /completionCopyFor\s*\(\s*answers\.type\s*\)/.test(wizSrc),
    v('CompletionStep must call completionCopyFor(answers.type) — the '
      + 'single seam that routes per-type copy into the render. '
      + 'Without this call, the step reverts to generic wording.'))
})

test('CompletionStep renders the question from the resolved config', () => {
  // The headline must come from `copy.question`, not an inline literal.
  assert.ok(
    /\{copy\.question\}/.test(wizSrc),
    v('CompletionStep headline must render {copy.question} — the '
      + 'per-type question text. An inline string literal would '
      + 'bypass the data-driven path.'))
  // The retired generic headline must not appear in the JSX as a
  // literal.
  const idx = wizSrc.indexOf('function CompletionStep(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 6000)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\n]*$/gm, '')
  assert.equal(
    /How will the robot know it's finished\?/.test(chunk),
    false,
    v('The retired generic headline "How will the robot know it\'s '
      + 'finished?" must NOT appear as a JSX literal in CompletionStep '
      + '— it lives ONCE in lib/fixturesData._GENERIC_COMPLETION / '
      + 'other.completion. A relapse here would re-ship the field bug.'))
})

test('CompletionStep options loop reads copy.options + per-option entries', () => {
  const idx = wizSrc.indexOf('function CompletionStep(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 6000)
  assert.ok(/\(copy\.options\s*\|\|\s*\[['"]sensor['"]/.test(chunk),
    v('CompletionStep options render must iterate copy.options (with '
      + 'the generic default as a defensive fallback), so a type with '
      + 'options:["wait"] renders ONLY that choice.'))
  // The per-option label/desc must come from the config, not inline.
  assert.ok(/entry\.label/.test(chunk) && /entry\.desc/.test(chunk),
    v('Per-option render must read entry.label + entry.desc from the '
      + 'config — no inline label / desc strings in the JSX.'))
})

test('Wait-field label + hint come from the config (type-adaptive)', () => {
  const idx = wizSrc.indexOf('function CompletionStep(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 6000)
  assert.ok(/waitEntry\.waitLabel/.test(chunk),
    v('Wait field must render waitEntry.waitLabel — so a door reads '
      + '"How long to open or close?" and a blow-off reads "Pulse '
      + 'length" instead of the generic "Wait time".'))
  assert.ok(/waitEntry\.waitHint/.test(chunk),
    v('Wait field must render waitEntry.waitHint — the unit suffix '
      + '("seconds") is type-adaptive too.'))
})

test('Sensor callout reads copy.sensorNote (only when the config defines it)', () => {
  const idx = wizSrc.indexOf('function CompletionStep(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 6000)
  // Rendering must gate on copy.sensorNote being truthy — a type that
  // omits the note (e.g. blow-off, which has no sensor option at all)
  // never renders a dangling empty callout box.
  assert.ok(
    /kind === ['"]sensor['"] && copy\.sensorNote/.test(chunk),
    v('Sensor callout must render only when copy.sensorNote is set — '
      + 'otherwise the step shows an empty amber box for a type that '
      + 'has nothing to say.'))
})


// ── (6) Config consistency: no "finished" in per-type copy ─────────

// ── (7) 2026-10-16 default-preselection + Recommended chip ─────────

test('CompletionStep preselects the sensor option on mount (data-driven default)', () => {
  const idx = wizSrc.indexOf('function CompletionStep(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 8000)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\n]*$/gm, '')
  // Derivation: default = 'sensor' when options includes it, else the
  // first option in copy.options. Sensor-less types (blow_off) fall
  // back to 'wait'.
  assert.ok(
    /const defaultKind\s*=\s*options\.some\(\(o\)\s*=>\s*o\.key\s*===\s*['"]sensor['"]\)\s*\?\s*['"]sensor['"]\s*:\s*\(options\[0\]/
      .test(chunk),
    v('CompletionStep must derive `defaultKind = options.some(o => '
      + 'o.key === "sensor") ? "sensor" : (options[0] && options[0]'
      + '.key) || null` — the data-driven default-preselection rule.'))
  // useEffect must call onCompletion(defaultKind) when answers.completion
  // is falsy. Navigating back preserves the operator's prior pick.
  assert.ok(
    /useEffect\(\(\)\s*=>\s*\{\s*\n\s*if \(!answers\.completion\s*&&\s*defaultKind\)\s*\{\s*\n\s*onCompletion\(defaultKind\)/
      .test(chunk),
    v('CompletionStep must useEffect-call onCompletion(defaultKind) '
      + 'when answers.completion is nullish — preselect on first '
      + 'arrival, preserve on back-nav.'))
  // Dependency array must include answers.completion + defaultKind so
  // a device-type change (which changes defaultKind) re-fires. The
  // onCompletion ref doesn't change in practice but is listed for
  // react-hooks exhaustive-deps.
  assert.ok(
    /\}, \[answers\.completion, defaultKind, onCompletion\]\)/.test(chunk),
    v('CompletionStep useEffect deps must be [answers.completion, '
      + 'defaultKind, onCompletion] — react-hooks/exhaustive-deps + '
      + 'the type-change re-fire path.'))
})

test('Sensor option carries a "Recommended" chip when it is the default', () => {
  const idx = wizSrc.indexOf('function CompletionStep(')
  const stop = wizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = wizSrc.slice(idx, stop > idx ? stop : idx + 8000)
  // The chip renders when the option is the default — gated on
  // isDefault, which is `c.key === defaultKind`. For sensor-offering
  // types the chip lands on sensor; for blow_off it lands on wait
  // (which is also the only option — operator still sees a clear
  // signal that THIS is the one to pick).
  assert.ok(/const isDefault\s*=\s*c\.key\s*===\s*defaultKind/.test(chunk),
    v('Each option render must compute isDefault = c.key === '
      + 'defaultKind so the Recommended chip only appears on the '
      + 'default row.'))
  assert.ok(
    /\{isDefault\s*&&[\s\S]{0,500}data-testid="fixture-completion-recommended"[\s\S]{0,600}Recommended/
      .test(chunk),
    v('CompletionStep must render a Recommended chip (data-testid='
      + '"fixture-completion-recommended") when isDefault is true. The '
      + 'chip body must read "Recommended" verbatim.'))
  // Also pin the data-default attribute on the choice button so e2e
  // tests can filter the default row directly.
  assert.ok(/data-default=\{String\(isDefault\)\}/.test(chunk),
    v('Each choice button must stamp data-default={String(isDefault)} '
      + 'so operator-facing tests can select the default row.'))
})

test('Sensor-less type (blow_off) still preselects via the first-option fallback', () => {
  // Behavioral invariant: for blow_off, defaultKind = 'wait' because
  // 'sensor' isn't in options. CompletionStep still auto-sets
  // answers.completion so Next transitions depend only on the wait_s
  // value (which the operator must type). We assert the data-level
  // guarantee here — the UI logic is pinned above.
  const blowCopy = completionCopyFor('blow_off')
  assert.deepEqual(blowCopy.options, ['wait'],
    v('blow_off options must still be ["wait"] — the first-option '
      + 'fallback for sensor-less types lands on wait.'))
})

test('No shipped type (except the generic "other" fallback) uses the word "finished" in its question', () => {
  // "finished" is the pre-fix generic wording the operator flagged as
  // not fitting specific types. Each shipped type MUST have replaced
  // the word in its question with a type-fit phrasing. The generic
  // fallback (lib/fixturesData._GENERIC_COMPLETION) still carries it
  // for completionCopyFor(null) safety; it also surfaces as the
  // "other" type's completion (operators who pick "something else"
  // deliberately opt into the generic flow).
  for (const key of FIXTURE_TYPE_KEYS) {
    if (key === 'other') continue
    const def = FIXTURE_TYPES[key]
    assert.equal(/finished/i.test(def.completion.question), false,
      v(`FIXTURE_TYPES.${key}.completion.question must NOT use the `
        + `generic word "finished" — the 2026-10-16 operator order `
        + `was explicit that type-specific wording wins.`))
  }
})
