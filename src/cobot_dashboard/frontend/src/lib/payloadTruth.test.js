// payloadTruth — operator-facing tool-weight comparison. Four states
// pinned here so the copy stays plain and the severity stays
// right-sized:
//
//   * match       — program and robot agree (within tolerance) → ok
//   * mismatch    — both known but different → warning
//   * unreadable  — the robot's live payload setting can't be read
//                   back here (this controller has no such wire
//                   path). Informational, not an alarm.
//   * unset       — no tool mass on the program → warning (chip
//                   flags it in the header)
//
// 2026-10-09 operator directive (reframe): the pre-change copy
// called this an alarm and used Factory UI / "preset" / "on the
// wire" jargon. The new copy is plain operator-language and
// severity splits so unreadable renders as info, not warning.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePayloadTruth } from './payloadTruth.js'


// ─────────────────────────────────────────────────────────────
// Severity split — plain language + right-sized colour
// ─────────────────────────────────────────────────────────────

test('severity: match → ok (green)', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 1.2 })
  assert.equal(t.state, 'match')
  assert.equal(t.severity, 'ok',
    'match confirms the robot and program agree — green, not amber')
})


test('severity: unreadable → info (NOT a warning)', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: null })
  assert.equal(t.state, 'unreadable')
  assert.equal(t.severity, 'info',
    'unreadable is the default state when no wire-read exists — it '
    + 'is an FYI, not an alarm. Pre-fix amber styling made every '
    + 'program look broken.')
})


test('severity: mismatch → warning (genuine action needed)', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 3.5 })
  assert.equal(t.state, 'mismatch')
  assert.equal(t.severity, 'warning',
    'a true program/pendant disagreement affects collision detection '
    + 'sizing — warning is the right severity')
})


test('severity: unset → warning (program itself is the fix)', () => {
  const t = computePayloadTruth({ programKg: null, controllerKg: 1.2 })
  assert.equal(t.state, 'unset')
  assert.equal(t.severity, 'warning')
})


// ─────────────────────────────────────────────────────────────
// Plain-language pins — no jargon in operator-facing copy
// ─────────────────────────────────────────────────────────────

const JARGON_TERMS = [
  'Factory UI',
  'Set the default load',
  'on the wire',
  'preset',
  'PayloadId',
  'ParamID',
  'Parameter Identification',
]


for (const kg of [1.2, 3.5, null]) {
  test(`no jargon in copy for programKg=${kg}, controller unreadable`, () => {
    const t = computePayloadTruth({ programKg: kg, controllerKg: null })
    for (const term of JARGON_TERMS) {
      assert.ok(!t.message.includes(term),
        `operator-facing message must not contain "${term}". `
        + `State=${t.state}. Message=${JSON.stringify(t.message)}`)
    }
  })
}


test('no jargon in mismatch copy', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 0 })
  for (const term of JARGON_TERMS) {
    assert.ok(!t.message.includes(term),
      `mismatch message must not contain "${term}". `
      + `Message=${JSON.stringify(t.message)}`)
  }
})


test('no jargon in match copy', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 1.2 })
  for (const term of JARGON_TERMS) {
    assert.ok(!t.message.includes(term),
      `match message must not contain "${term}". `
      + `Message=${JSON.stringify(t.message)}`)
  }
})


test('no jargon in unset copy', () => {
  const t = computePayloadTruth({ programKg: null, controllerKg: null })
  for (const term of JARGON_TERMS) {
    assert.ok(!t.message.includes(term),
      `unset message must not contain "${term}". `
      + `Message=${JSON.stringify(t.message)}`)
  }
})


// ─────────────────────────────────────────────────────────────
// Content pins — the operator still sees the mass + a reasonable
// next-step pointer in plain terms
// ─────────────────────────────────────────────────────────────

test('match: copy still names the mass + carries the ✓ affordance', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 1.2 })
  assert.ok(/1\.2 kg/.test(t.message),
    'match message must name the agreed mass')
  assert.ok(/✓/.test(t.message), 'match copy carries the ✓')
})


test('unreadable: copy names program mass, mentions pendant, no alarm words', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: null })
  assert.ok(/1\.2 kg/.test(t.message),
    'unreadable message must name the mass the program will send')
  assert.ok(/pendant/i.test(t.message),
    'unreadable copy must point the operator at the robot\'s pendant '
    + '— the actual home of the setting')
  // Directive: "it reads like an error". No alarm words.
  for (const word of ['error', 'failed', 'warning', 'alarm', 'cannot']) {
    assert.ok(!(new RegExp(`\\b${word}\\b`, 'i').test(t.message)),
      `unreadable copy must not use the alarm word "${word}". `
      + `Message=${JSON.stringify(t.message)}`)
  }
})


test('mismatch: copy names BOTH masses + the operator action in plain terms', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 0 })
  assert.ok(/1\.2 kg/.test(t.message), 'must name program mass')
  assert.ok(/0 kg/.test(t.message),    'must name robot mass')
  assert.ok(/pendant/i.test(t.message),
    'must point the operator at the pendant for the fix')
  assert.ok(/collision detection/i.test(t.message),
    'must name the consequence — collision detection sizing')
})


test('unset: copy nudges operator to enter the tool mass', () => {
  const t = computePayloadTruth({ programKg: null, controllerKg: 1.2 })
  assert.ok(/tool weight/i.test(t.message)
         || /tool mass/i.test(t.message),
    'unset message must mention tool weight / tool mass in plain terms')
})


// ─────────────────────────────────────────────────────────────
// Detail string — technical explanation for the tooltip/expander
// ─────────────────────────────────────────────────────────────

test('every state carries a detail string for the tooltip', () => {
  for (const [pkg, ckg] of [
    [1.2, null], [1.2, 1.2], [1.2, 3.5], [null, 1.2], [null, null],
  ]) {
    const t = computePayloadTruth({ programKg: pkg, controllerKg: ckg })
    assert.ok(typeof t.detail === 'string' && t.detail.length > 0,
      `state=${t.state} must carry a non-empty detail string so the `
      + 'tooltip can surface the technical explanation to anyone who '
      + 'wants it')
  }
})


// ─────────────────────────────────────────────────────────────
// Tolerance + stringy inputs — unchanged behaviour
// ─────────────────────────────────────────────────────────────

test('match: values within 0.05 kg tolerance → still match', () => {
  const t = computePayloadTruth({ programKg: 1.20, controllerKg: 1.22 })
  assert.equal(t.state, 'match')
})


test('mismatch: differing non-zero values → state=mismatch', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 3.5 })
  assert.equal(t.state, 'mismatch')
})


test('unreadable: undefined controller value → state=unreadable', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: undefined })
  assert.equal(t.state, 'unreadable')
})


test('unset: unset beats unreadable — program is the fix', () => {
  const t = computePayloadTruth({ programKg: null, controllerKg: null })
  assert.equal(t.state, 'unset')
})


test('numeric-string controller value normalizes to number', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: '1.2' })
  assert.equal(t.state, 'match')
})


test('empty-string controller value → unreadable', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: '' })
  assert.equal(t.state, 'unreadable')
})
