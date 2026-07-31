// payloadTruth — live program-vs-controller comparison. Three
// operator-facing states pinned here so the copy stays honest:
//
//   * match       — program and controller agree (within tolerance)
//   * mismatch    — both known, but different (incl. controller=0)
//   * unreadable  — controller value not available on the wire; the
//                   copy MUST say so explicitly and NEVER imply sync
//   * unset       — no payload on the program (chip flags it)
//
// See the 2026-07-31 directive: the retired "info only" fine-print
// banner made claims the app couldn't back with a wire read. This
// resolver's copy is the operator's contract now.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePayloadTruth } from './payloadTruth.js'


// ── match ─────────────────────────────────────────────────────

test('match: same value on both sides → state=match, green copy', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 1.2 })
  assert.equal(t.state, 'match')
  assert.equal(t.programKg, 1.2)
  assert.equal(t.controllerKg, 1.2)
  assert.ok(/1\.2 kg/.test(t.message),
    'message must name the mass so the operator sees WHAT matched')
  assert.ok(/✓/.test(t.message),
    'match state carries the ✓ affordance')
})

test('match: values within 0.05 kg tolerance → still match', () => {
  const t = computePayloadTruth({ programKg: 1.20, controllerKg: 1.22 })
  assert.equal(t.state, 'match',
    'small measurement noise (< 0.05 kg) should not flip severity')
})


// ── mismatch ─────────────────────────────────────────────────

test('mismatch: controller 0 kg, program 1.2 kg → state=mismatch', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 0 })
  assert.equal(t.state, 'mismatch')
  assert.ok(/1\.2 kg/.test(t.message), 'must name program mass')
  assert.ok(/0 kg/.test(t.message),  'must name controller preset')
  assert.ok(/collision detection and drag degraded/.test(t.message),
    'must state the consequence in operator-facing terms')
  assert.ok(/Factory UI/.test(t.message),
    'must point to Factory UI as the fix location')
  assert.ok(/Parameter Identification/.test(t.message),
    'must offer Parameter Identification as an alternative')
})

test('mismatch: differing non-zero values → state=mismatch', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: 3.5 })
  assert.equal(t.state, 'mismatch')
})


// ── unreadable ───────────────────────────────────────────────

test('unreadable: null controller value → state=unreadable', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: null })
  assert.equal(t.state, 'unreadable')
  assert.ok(/not readable/.test(t.message),
    'copy MUST use the exact "not readable" phrase — no sync claim')
  assert.ok(/verify at Factory UI/.test(t.message),
    'directs the operator to the true source of the value')
  // Directive: "never imply sync that doesn't exist". Guard against
  // future edits that add "will sync" / "syncs to" / "auto-updates".
  assert.equal(/\bsync\b|\bauto[- ]?update/i.test(t.message), false,
    'copy MUST NOT imply a sync mechanism — the wire read isn\'t wired up')
})

test('unreadable: undefined controller value → state=unreadable', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: undefined })
  assert.equal(t.state, 'unreadable')
})


// ── unset ────────────────────────────────────────────────────

test('unset: no program payload → state=unset', () => {
  const t = computePayloadTruth({ programKg: null, controllerKg: 1.2 })
  assert.equal(t.state, 'unset')
  assert.ok(/No payload set on the program/.test(t.message))
})

test('unset: unset beats unreadable — the program is the fix', () => {
  const t = computePayloadTruth({ programKg: null, controllerKg: null })
  assert.equal(t.state, 'unset',
    'when neither is known, unset wins — the operator has to enter '
    + 'the program value first before the comparison means anything')
})


// ── stringy / edge inputs are normalized ─────────────────────

test('numeric-string controller value normalizes to number', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: '1.2' })
  assert.equal(t.state, 'match')
})

test('empty-string controller value → unreadable', () => {
  const t = computePayloadTruth({ programKg: 1.2, controllerKg: '' })
  assert.equal(t.state, 'unreadable')
})
