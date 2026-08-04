// Node built-in test-runner unit tests for the load-outcome mapper.
// Run with: `node --test src/lib/loadOutcome.test.js` from frontend/.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  namedLoadError,
  LOAD_OUTCOME_KINDS,
  BANNED_OPERATOR_TOKENS,
} from './loadOutcome.js'


// ── Contract: every outcome kind is named + operator-safe ──────

test('every documented outcome.kind has a named mapping', () => {
  for (const kind of LOAD_OUTCOME_KINDS) {
    const named = namedLoadError({ outcome: { kind } }, 400)
    assert.ok(named && named.code, `no mapping for ${kind}`)
    assert.ok(named.title && named.title.length > 0,
      `${kind} has no title`)
    assert.ok('detail' in named, `${kind} missing detail field`)
    assert.ok('technicalDetail' in named,
      `${kind} missing technicalDetail field`)
  }
})


test('title and detail contain no technical tokens (operator language only)', () => {
  // Sweep every named outcome AND the unknown fallback. Any
  // token in BANNED_OPERATOR_TOKENS in the title or detail is a
  // regression — the technical strings belong in
  // technicalDetail, which the ToastContainer demotes behind
  // the "Details" toggle.
  const cases = [
    { outcome: { kind: 'pending_poses',
                 count: 5, findings: [
                   { step_idx: 0, action: 'move_home' },
                   { step_idx: 1, action: 'move_linear' },
                 ],
                 reason: 'motion step has no fully-resolved '
                       + '6-element pose ... known controller-'
                       + 'crashing codegen (firmware bug #3, '
                       + 'mm2mAndDeg2rad asserts v.size()>=6)' } },
    { outcome: { kind: 'arity_assertion_failed',
                 reason: 'D14 codegen post-emit assertion '
                       + '— codegen produced 1 mov* line(s)' } },
    { outcome: { kind: 'empty_program',
                 reason: 'codegen produced zero motion-verb emissions' } },
    { outcome: { kind: 'lint_failed', count: 2,
                 findings: [{ line: 17, verb: 'setBlender' }],
                 reason: 'lint blocked push: 2 finding(s)' } },
    { outcome: { kind: 'byte_verify_mismatch',
                 sent_sha: 'abc', stored_sha: 'def',
                 reason: 'post-save byte-verify MISMATCH' } },
    { outcome: { kind: 'byte_verify_get_failed',
                 reason: 'HTTP 500' } },
    { outcome: { kind: 'save_rejected',
                 reason: 'allow_move gate closed' } },
    { outcome: { kind: 'save_failed',
                 reason: 'save did not complete cleanly' } },
    { outcome: { kind: 'transport_down',
                 reason: 'ws not connected' } },
    { outcome: { kind: 'id_not_controller_safe',
                 reason: "id 'new_program_2' would collide" } },
    { outcome: { kind: 'lint_infrastructure_error',
                 reason: 'lint failed to run' } },
    { outcome: { kind: 'codegen' },
      error: 'codegen: KeyError' },
  ]
  for (const body of cases) {
    const named = namedLoadError(body, 400)
    for (const t of BANNED_OPERATOR_TOKENS) {
      assert.ok(!named.title.includes(t),
        `${named.code}: title contains banned token ${JSON.stringify(t)}: `
        + JSON.stringify(named.title))
      assert.ok(!named.detail.includes(t),
        `${named.code}: detail contains banned token ${JSON.stringify(t)}: `
        + JSON.stringify(named.detail))
    }
  }
})


test('technicalDetail carries the raw wire reason verbatim', () => {
  const raw = 'motion step has no fully-resolved 6-element pose — '
            + 'known controller-crashing codegen (firmware bug #3, '
            + 'mm2mAndDeg2rad asserts v.size()>=6)'
  const named = namedLoadError({
    outcome: { kind: 'pending_poses', count: 1,
               findings: [{ step_idx: 0, action: 'move_home' }],
               reason: raw },
  }, 400)
  // Full raw string preserved so devtools grep works.
  assert.equal(named.technicalDetail, raw)
  // ...and it's not smuggled back into the operator fields.
  assert.ok(!named.title.includes('mm2mAndDeg2rad'))
  assert.ok(!named.detail.includes('mm2mAndDeg2rad'))
})


// ── Duplication: title and detail don't overlap each other ─────

test('title and detail do not contain each other (no duplication)', () => {
  // Rendering: title on its own line, detail below. If detail
  // contains the title as a substring (or vice versa), the
  // operator sees the same phrase twice — the exact class of
  // bug that motivated the rewrite.
  for (const kind of LOAD_OUTCOME_KINDS) {
    const body = _minimalBodyFor(kind)
    const named = namedLoadError(body, 400)
    if (named.title && named.detail) {
      assert.ok(!named.detail.includes(named.title),
        `${kind}: detail contains the full title verbatim `
        + `(duplication): title=${JSON.stringify(named.title)} `
        + `detail=${JSON.stringify(named.detail)}`)
      assert.ok(!named.title.includes(named.detail),
        `${kind}: title contains the full detail verbatim `
        + `(duplication)`)
    }
  }
})


function _minimalBodyFor(kind) {
  // Enough shape to exercise each mapper without hardcoding the
  // full server response format.
  if (kind === 'pending_poses') {
    return { outcome: { kind, count: 3, findings: [
      { step_idx: 0, action: 'move_home' },
      { step_idx: 2, action: 'move_linear' },
      { step_idx: 4, action: 'move_linear' },
    ], reason: 'wire reason' } }
  }
  if (kind === 'lint_failed') {
    return { outcome: { kind, count: 1,
      findings: [{ line: 3, verb: 'setBlender' }],
      reason: 'wire reason' } }
  }
  if (kind === 'codegen') {
    return { outcome: { kind }, error: 'codegen: X' }
  }
  return { outcome: { kind, reason: 'wire reason' } }
}


// ── Copy pins per outcome — the operator-facing sentences ──────

test('pending_poses: matches the operator directive verbatim', () => {
  const named = namedLoadError({
    outcome: { kind: 'pending_poses', count: 5, findings: [
      { step_idx: 0, action: 'move_home' },
      { step_idx: 1, action: 'move_linear' },
      { step_idx: 2, action: 'move_linear' },
      { step_idx: 5, action: 'move_linear' },
      { step_idx: 7, action: 'move_home' },
    ], reason: '...' },
  }, 400)
  assert.equal(named.title,
    'Teach positions first — this program has untaught positions.')
  assert.equal(named.detail,
    'Untaught: step 1 (home), step 2 (linear), step 3 (linear), '
    + 'step 6 (linear), step 8 (home). Open it in the Program '
    + 'Editor to teach them.')
})


test('pending_poses: enumerates the actual step numbers from findings (1-based)', () => {
  // Non-sequential indices to catch a mapper bug where every
  // step gets renumbered instead of using its actual index.
  const named = namedLoadError({
    outcome: { kind: 'pending_poses', count: 2, findings: [
      { step_idx: 3, action: 'move_linear' },
      { step_idx: 9, action: 'move_home' },
    ], reason: 'x' },
  }, 400)
  assert.match(named.detail, /step 4 \(linear\)/)
  assert.match(named.detail, /step 10 \(home\)/)
})


test('pending_poses: caps step list at 5, shows "+N more" for the rest', () => {
  const findings = []
  for (let i = 0; i < 12; i++) {
    findings.push({ step_idx: i, action: 'move_linear' })
  }
  const named = namedLoadError({
    outcome: { kind: 'pending_poses', count: 12, findings,
               reason: 'x' },
  }, 400)
  // 5 explicit + "+7 more"
  const commaCount = (named.detail.match(/step \d+ \(/g) || []).length
  assert.equal(commaCount, 5)
  assert.match(named.detail, /\+7 more/)
})


test('arity_assertion_failed: matches the operator directive', () => {
  const named = namedLoadError({
    outcome: { kind: 'arity_assertion_failed',
               reason: 'D14 assertion tripped' },
  }, 400)
  assert.equal(named.title,
    "Program can't run — internal generation error. Report this.")
})


test('transport_down: keeps its calm register', () => {
  const named = namedLoadError({
    outcome: { kind: 'transport_down', reason: 'ws not connected' },
  }, 400)
  assert.match(named.title, /Controller link is down/)
  assert.match(named.title, /not loaded/)
  assert.match(named.detail, /Wait for the driver to reconnect/)
})


test('empty_program: names the fix, not the mechanism', () => {
  const named = namedLoadError({
    outcome: { kind: 'empty_program', reason: 'zero motion' },
  }, 400)
  assert.match(named.title, /Nothing to run/)
  assert.match(named.detail, /Program Editor/)
})


test('unknown outcome: falls back with an operator-safe sentence', () => {
  const named = namedLoadError({}, 599)
  assert.equal(named.code, 'unknown')
  assert.match(named.title, /Program not loaded/)
  // Even the "unknown" branch stays operator-friendly.
  for (const t of BANNED_OPERATOR_TOKENS) {
    assert.ok(!named.title.includes(t))
    assert.ok(!named.detail.includes(t))
  }
})


// ── Backwards-compat: headline still populated ─────────────────

test('headline compat field is populated from title + detail (no runaway duplication)', () => {
  // The pre-2026-08-04 shape returned { headline, detail } and
  // callers concatenated them into a single toast string.
  // headline is preserved for un-migrated callers as
  // title + " " + detail; its length must be bounded (no
  // multi-sentence repetition of the same phrase).
  const named = namedLoadError({
    outcome: { kind: 'pending_poses', count: 1,
               findings: [{ step_idx: 0, action: 'move_home' }],
               reason: 'x' },
  }, 400)
  assert.ok(named.headline)
  // The headline must contain each of title and detail once.
  const titleCount = _countOccurrences(named.headline, named.title)
  assert.equal(titleCount, 1,
    `title appears ${titleCount}× in headline (should be 1)`)
})


function _countOccurrences(hay, needle) {
  if (!needle) return 0
  let n = 0
  let idx = 0
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    n += 1
    idx += needle.length
  }
  return n
}
