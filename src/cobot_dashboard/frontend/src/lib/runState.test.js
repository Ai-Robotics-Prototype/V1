// Node built-in test-runner unit tests for the run-state helpers.
// Run with: `node --test src/lib/runState.test.js` from frontend/.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  deriveRunState,
  STUCK_STOPPING_MS,
  STATE_STREAM_STALE_MS,
  isStopButtonEnabled,
  isStuckStopping,
  isStateStreamStale,
  homeButtonEnabled,
  restartButtonEnabled,
} from './runState.js'


// ── deriveRunState precedence ──────────────────────────────────

test('deriveRunState: estop wins over everything', () => {
  const s = deriveRunState({
    safety: { estop: true },
    robot: { connected: true, enabled: true, program: { state: 2, line: 5 } },
  })
  assert.equal(s.kind, 'estop')
})

test('deriveRunState: alarm wins over running', () => {
  const s = deriveRunState({
    robot: {
      connected: true, enabled: true,
      active_alarm: { code: 2015, text: 'Singular position' },
      program: { state: 2 },
    },
  })
  assert.equal(s.kind, 'alarm')
})

test('deriveRunState: state=3 → stopping', () => {
  const s = deriveRunState({
    robot: { connected: true, enabled: true, program: { state: 3, line: 7 } },
  })
  assert.equal(s.kind, 'stopping')
})

test('deriveRunState: state=2 → running', () => {
  const s = deriveRunState({
    robot: { connected: true, enabled: true, program: { state: 2, line: 4 } },
  })
  assert.equal(s.kind, 'running')
})

test('deriveRunState: idle when no state', () => {
  const s = deriveRunState({ robot: { connected: true, enabled: true } })
  assert.equal(s.kind, 'idle')
})


// ── STOP button always enabled in active states ─────────────────

test('isStopButtonEnabled: enabled in running/paused/stopping/alarm', () => {
  for (const k of ['running', 'paused', 'stopping', 'alarm']) {
    assert.equal(isStopButtonEnabled(k), true, `STOP should be enabled in ${k}`)
  }
})

test('isStopButtonEnabled: disabled in idle/estop/disabled', () => {
  for (const k of ['idle', 'estop', 'disabled']) {
    assert.equal(isStopButtonEnabled(k), false, `STOP should be disabled in ${k}`)
  }
})


// ── Stuck-STOPPING detection ───────────────────────────────────

test('isStuckStopping: not stuck below threshold', () => {
  const now = 10_000
  assert.equal(
    isStuckStopping('stopping', now - (STUCK_STOPPING_MS - 100), now),
    false,
    'below threshold should not be stuck',
  )
})

test('isStuckStopping: stuck at exactly the threshold', () => {
  const now = 10_000
  assert.equal(
    isStuckStopping('stopping', now - STUCK_STOPPING_MS, now),
    true,
    'at the threshold should count as stuck',
  )
})

test('isStuckStopping: stuck well past the threshold', () => {
  const now = 30_000
  assert.equal(
    isStuckStopping('stopping', now - 15_000, now),
    true,
  )
})

test('isStuckStopping: not stopping → never stuck', () => {
  const now = 10_000
  for (const k of ['idle', 'running', 'paused', 'alarm']) {
    assert.equal(
      isStuckStopping(k, now - 10_000, now),
      false,
      `${k} should never be stuck-stopping`,
    )
  }
})

test('isStuckStopping: null stoppingSinceTs → never stuck', () => {
  assert.equal(isStuckStopping('stopping', null, 10_000), false)
})


// ── Home/Restart re-enable on stuck-STOPPING ───────────────────

test('homeButtonEnabled: disabled during normal STOPPING (not stuck yet)', () => {
  const now = 10_000
  const stoppingSince = now - 500       // 500 ms — well under threshold
  const r = homeButtonEnabled({
    runStateKind: 'stopping', stoppingSinceTs: stoppingSince,
    safety: {}, robot: { connected: true }, nowTs: now,
  })
  assert.equal(r, false)
})

test('homeButtonEnabled: RE-ENABLED once stuck-STOPPING trips', () => {
  const now = 10_000
  const stoppingSince = now - (STUCK_STOPPING_MS + 100)
  const r = homeButtonEnabled({
    runStateKind: 'stopping', stoppingSinceTs: stoppingSince,
    safety: {}, robot: { connected: true }, nowTs: now,
  })
  assert.equal(r, true, 'Home button must re-enable on stuck-STOPPING')
})

test('homeButtonEnabled: still disabled under estop even when stuck', () => {
  const now = 10_000
  const stoppingSince = now - (STUCK_STOPPING_MS + 500)
  const r = homeButtonEnabled({
    runStateKind: 'stopping', stoppingSinceTs: stoppingSince,
    safety: { estop: true }, robot: { connected: true }, nowTs: now,
  })
  assert.equal(r, false)
})

test('homeButtonEnabled: idle + connected → enabled', () => {
  const r = homeButtonEnabled({
    runStateKind: 'idle', stoppingSinceTs: null,
    safety: {}, robot: { connected: true }, nowTs: 10_000,
  })
  assert.equal(r, true)
})

test('homeButtonEnabled: disabled while running', () => {
  const r = homeButtonEnabled({
    runStateKind: 'running', stoppingSinceTs: null,
    safety: {}, robot: { connected: true }, nowTs: 10_000,
  })
  assert.equal(r, false)
})


test('restartButtonEnabled: disabled during normal STOPPING (not stuck)', () => {
  const now = 10_000
  const stoppingSince = now - 500
  const r = restartButtonEnabled({
    runStateKind: 'stopping', stoppingSinceTs: stoppingSince,
    safety: {}, nowTs: now,
  })
  assert.equal(r, false)
})

test('restartButtonEnabled: RE-ENABLED on stuck-STOPPING', () => {
  const now = 10_000
  const stoppingSince = now - (STUCK_STOPPING_MS + 200)
  const r = restartButtonEnabled({
    runStateKind: 'stopping', stoppingSinceTs: stoppingSince,
    safety: {}, nowTs: now,
  })
  assert.equal(r, true)
})

test('restartButtonEnabled: disabled while alarm active', () => {
  const r = restartButtonEnabled({
    runStateKind: 'alarm', stoppingSinceTs: null,
    safety: {}, nowTs: 10_000,
  })
  assert.equal(r, false)
})

test('restartButtonEnabled: idle → enabled', () => {
  const r = restartButtonEnabled({
    runStateKind: 'idle', stoppingSinceTs: null,
    safety: {}, nowTs: 10_000,
  })
  assert.equal(r, true)
})


// ── isStateStreamStale ─────────────────────────────────────────

test('isStateStreamStale: zero timestamp counts as stale (never received)', () => {
  assert.equal(isStateStreamStale(0, 100_000), true)
  assert.equal(isStateStreamStale(null, 100_000), true)
  assert.equal(isStateStreamStale(undefined, 100_000), true)
})

test('isStateStreamStale: recent frame within window → NOT stale', () => {
  const now = 100_000
  const recent = now - (STATE_STREAM_STALE_MS - 500)
  assert.equal(isStateStreamStale(recent, now), false)
})

test('isStateStreamStale: old frame past window → stale', () => {
  const now = 100_000
  const old = now - (STATE_STREAM_STALE_MS + 100)
  assert.equal(isStateStreamStale(old, now), true)
})

test('isStateStreamStale: exactly at threshold counts as stale', () => {
  const now = 100_000
  const boundary = now - STATE_STREAM_STALE_MS
  assert.equal(isStateStreamStale(boundary, now), true)
})
