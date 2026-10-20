// Pinned behavior for NumericField — 2026-07-30 pallet wizard bug.
//
// Every other numeric input in the app used to parse+commit on every
// keystroke, so clearing the field (select-all + delete) got
// parseInt('') → NaN → snap back to the last value. NumericField
// replaces that with focused-string / blur-commit semantics, and
// these tests pin the contract:
//
//   * clear→type→blur commits the typed value
//   * empty blur reverts to the last committed value (with a
//     visible flash — the operator sees the rollback)
//   * mid-typing states like "" / "-" / "1." never snap
//   * min/max clamp only on commit, not on keystroke
//
// The component uses React state + effects; here we exercise the
// pure helpers (formatValue + parseAndClamp) since those carry the
// whole numerical contract. The React lifecycle (onFocus select,
// onChange raw, onBlur commit) is thin glue over these — a full
// React-testing-library setup would add jsdom + rtl; keeping this
// module-level test dep-free.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatValue, parseAndClamp } from './NumericField.helpers.js'


// ── formatValue ───────────────────────────────────────────────────

test('formatValue: integer strips fractional part', () => {
  assert.equal(formatValue(1.9, true), '1')
  assert.equal(formatValue(-2.5, true), '-2')
  assert.equal(formatValue(0, true), '0')
})

test('formatValue: float renders without trailing zeros', () => {
  assert.equal(formatValue(1.5, false), '1.5')
  assert.equal(formatValue(2, false), '2')
})

test('formatValue: null / undefined / NaN → empty string', () => {
  assert.equal(formatValue(null, false), '')
  assert.equal(formatValue(undefined, false), '')
  assert.equal(formatValue(NaN, false), '')
})


// ── parseAndClamp: the empty / partial states that MUST NOT snap ─

test('parseAndClamp: empty string → null (revert on blur)', () => {
  assert.equal(parseAndClamp('', { integer: true }), null)
  assert.equal(parseAndClamp('   ', { integer: false }), null)
})

test('parseAndClamp: lone minus / dot / -. → null (mid-typing)', () => {
  assert.equal(parseAndClamp('-',  { integer: true }), null)
  assert.equal(parseAndClamp('.',  { integer: false }), null)
  assert.equal(parseAndClamp('-.', { integer: false }), null)
})

test('parseAndClamp: null input → null', () => {
  assert.equal(parseAndClamp(null, { integer: false }), null)
  assert.equal(parseAndClamp(undefined, { integer: true }), null)
})


// ── parseAndClamp: valid values commit through ────────────────────

test('parseAndClamp: integer parses without clamp when in range', () => {
  assert.equal(parseAndClamp('42', { integer: true, min: 0, max: 100 }), 42)
  assert.equal(parseAndClamp('-3', { integer: true, min: -10, max: 10 }), -3)
})

test('parseAndClamp: float parses without clamp when in range', () => {
  assert.equal(parseAndClamp('1.5', { integer: false, min: 0, max: 100 }), 1.5)
  assert.equal(parseAndClamp('-0.25', { integer: false, min: -1, max: 1 }), -0.25)
})

test('parseAndClamp: trailing dot is legal on commit', () => {
  // parseFloat('1.') === 1
  assert.equal(parseAndClamp('1.', { integer: false }), 1)
})


// ── parseAndClamp: clamping happens ONLY at commit ────────────────

test('parseAndClamp: value above max clamps to max', () => {
  assert.equal(parseAndClamp('999', { integer: true, min: 1, max: 20 }), 20)
})

test('parseAndClamp: value below min clamps to min', () => {
  assert.equal(parseAndClamp('-5', { integer: true, min: 1, max: 20 }), 1)
})

test('parseAndClamp: integer truncates fractional input', () => {
  // 12.9 with integer=true → 12, not 13 (matches formatValue)
  assert.equal(parseAndClamp('12.9', { integer: true, min: 0, max: 100 }), 12)
})

test('parseAndClamp: bounds default to ±Infinity', () => {
  assert.equal(parseAndClamp('1e9', { integer: false }), 1e9)
  assert.equal(parseAndClamp('-1e9', { integer: false }), -1e9)
})


// ── the exact bug we fixed (pallet wizard clear→retype) ──────────

test('the pallet-wizard bug is fixed: clear+retype does not snap', () => {
  // Old code: onChange={(e) => setRows(parseInt(e.target.value, 10) || 1)}
  //   Selecting all + hitting delete → e.target.value = ''
  //   parseInt('', 10) = NaN
  //   NaN || 1 = 1
  //   → field snaps to 1 immediately
  //
  // New contract: mid-typing empty is null (no commit); after
  // typing new value + blur, commit fires with the new number.
  assert.equal(parseAndClamp('', { integer: true, min: 1, max: 20 }), null,
    'empty mid-typing does NOT commit — parent state stays at last value')
  assert.equal(parseAndClamp('8', { integer: true, min: 1, max: 20 }), 8,
    'the operator retypes "8", blurs, and 8 is committed')
})


// ── integer mode rejects invalid tokens ──────────────────────────

test('parseAndClamp: garbage strings → null', () => {
  assert.equal(parseAndClamp('abc', { integer: true }), null)
  assert.equal(parseAndClamp('foo1', { integer: true }), null)
  assert.equal(parseAndClamp('NaN', { integer: false }), null)
})
