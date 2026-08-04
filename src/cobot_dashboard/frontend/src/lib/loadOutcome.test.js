// Node built-in test-runner unit tests for the load-outcome mapper.
// Run with: `node --test src/lib/loadOutcome.test.js` from frontend/.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { namedLoadError, LOAD_OUTCOME_KINDS } from './loadOutcome.js'


test('every documented outcome.kind has a named mapping', () => {
  for (const kind of LOAD_OUTCOME_KINDS) {
    const named = namedLoadError({ outcome: { kind } }, 400)
    assert.ok(named && named.code, `no mapping for ${kind}`)
    assert.ok(named.headline && named.headline.length > 0)
    // Every mapping must state that the program was NOT loaded so the
    // operator understands the resident did not change. Codegen and
    // infra failures use "Cannot load".
    assert.match(named.headline, /NOT loaded|Cannot load/,
      `outcome ${kind} headline does not say the load failed`)
  }
})


test('transport_down: explicit outcome.kind maps to transport_down', () => {
  const named = namedLoadError(
    { outcome: { kind: 'transport_down', reason: 'ws not connected' } }, 400)
  assert.equal(named.code, 'transport_down')
  assert.match(named.headline, /Controller link down/)
  assert.match(named.headline, /kept the previous resident/)
})


test('transport_down: legacy save_rejected + ws-not-connected reason still maps to transport_down', () => {
  // The dashboard has been shipping save_rejected with reason
  // "ws not connected" from before the reason_code migration. The
  // mapper falls back on the reason string so old server versions
  // don't downgrade to the generic "Controller refused the save".
  const named = namedLoadError(
    { outcome: { kind: 'save_rejected', reason: 'ws not connected' } }, 400)
  assert.equal(named.code, 'transport_down')
})


test('empty_program: names the untaught-motion cause', () => {
  const named = namedLoadError({
    outcome: {
      kind: 'empty_program',
      reason: 'codegen produced zero motion-verb emissions (all mov* verbs = 0)',
      motion_counts: { total: 6 },
    },
  }, 400)
  assert.equal(named.code, 'empty_program')
  assert.match(named.headline, /no valid motion/)
  assert.match(named.headline, /Teach positions first/)
  assert.match(named.headline, /6 steps checked/)
  // Driver reason propagates verbatim into detail so devtools can see
  // the full wire message.
  assert.match(named.detail, /zero motion-verb emissions/)
})


test('lint_failed: names finding location', () => {
  const named = namedLoadError({
    outcome: {
      kind: 'lint_failed',
      count: 2,
      findings: [{ line: 17, verb: 'setBlender', reason: 'unknown verb' }],
    },
  }, 400)
  assert.equal(named.code, 'lint_failed')
  assert.match(named.headline, /2 invalid lines/)
  assert.match(named.headline, /line 17/)
  assert.match(named.headline, /setBlender/)
})


test('byte_verify_mismatch: names sent/stored sha', () => {
  const named = namedLoadError({
    outcome: {
      kind: 'byte_verify_mismatch',
      sent_sha:   'abc123def456',
      stored_sha: '111222333444',
    },
  }, 502)
  assert.equal(named.code, 'byte_verify_mismatch')
  assert.match(named.headline, /abc123def456/)
  assert.match(named.headline, /111222333444/)
})


test('codegen 500: falls into the codegen bucket', () => {
  const named = namedLoadError({
    error: 'codegen: KeyError: "steps"',
  }, 500)
  assert.equal(named.code, 'codegen')
  assert.match(named.headline, /codegen failed/)
  assert.match(named.detail, /KeyError/)
})


test('unknown shape: surfaces http status rather than eating the failure', () => {
  const named = namedLoadError({}, 599)
  assert.equal(named.code, 'unknown')
  assert.match(named.headline, /HTTP 599/)
})
