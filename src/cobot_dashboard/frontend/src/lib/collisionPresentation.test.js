// collisionPresentation — 2026-08-05 (operator directive:
// clearance warnings OFF).
//
// Pinned invariants for the disabled-warn-tier era:
//   * ANY warn-band distance → show='none', reason='warn-tier-off'
//   * stop-zone → show='modal' (env callers still consume this;
//     ObstacleEscapeModal early-outs on guard_kind self/ground)
//   * pair / pairMuted / bannerOn / dragActive have NO
//     presentation effect any more — every combination collapses
//     to the same {show,level,reason} for a given distance.
//   * pairMuteKey remains order-independent (kept for signature
//     stability; still used by the store's dead-code muted set).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  presentDecision,
  pairMuteKey,
  bannerLabel,
  PAIR_MUTE_SEPARATOR,
} from './collisionPresentation.js'


// ── warn tier is off ─────────────────────────────────────────

test('above warn threshold → show=none, level=near', () => {
  const d = presentDecision({ distMm: 200, warnMm: 40, stopMm: 15 })
  assert.equal(d.show, 'none')
  assert.equal(d.level, 'near')
  assert.equal(d.reason, 'above-warn')
})

test('inside warn band → show=none, reason=warn-tier-off (NEVER banner)', () => {
  const d = presentDecision({ distMm: 30, warnMm: 40, stopMm: 15 })
  assert.equal(d.show, 'none')
  assert.equal(d.level, 'warn')
  assert.equal(d.reason, 'warn-tier-off')
})

test('warn tier is off — pair/mute/bannerOn/dragActive are ignored', () => {
  const inputs = [
    { pairMuted: true,  bannerOn: true  },
    { pairMuted: false, bannerOn: false },
    { pairMuted: true,  bannerOn: false, dragActive: true  },
    { pairMuted: false, bannerOn: true,  dragActive: true  },
  ]
  for (const opts of inputs) {
    const d = presentDecision({
      distMm: 30, warnMm: 40, stopMm: 15,
      pair: ['a', 'b'], ...opts })
    assert.equal(d.show, 'none',
      `warn band must never render regardless of ${JSON.stringify(opts)}`)
    assert.equal(d.reason, 'warn-tier-off')
  }
})

test('warnMm=0 (server-published disabled sentinel) → show=none anywhere', () => {
  // 2026-08-05 driver publishes collision_warn_mm=0.0 to signal
  // "warn tier disabled". Even if some caller still passes it
  // through, the frontend collapses cleanly.
  const cases = [
    { distMm: 200, warnMm: 0, stopMm: 15 },
    { distMm: 30,  warnMm: 0, stopMm: 15 },
    { distMm: 16,  warnMm: 0, stopMm: 15 },
  ]
  for (const c of cases) {
    const d = presentDecision(c)
    assert.notEqual(d.show, 'banner',
      `warnMm=0 must never yield a banner (${JSON.stringify(c)})`)
  }
})


// ── stop zone: modal path preserved for env callers ─────────

test('stop zone → show=modal, level=stop, reason=below-stop', () => {
  const d = presentDecision({ distMm: 10, warnMm: 40, stopMm: 15 })
  assert.equal(d.show, 'modal')
  assert.equal(d.level, 'stop')
  assert.equal(d.reason, 'below-stop')
})

test('stop zone: dragActive no longer changes the decision', () => {
  // Pre-directive: dragActive returned show='banner' in the stop
  // band. Post-directive: modal is the sole surface for env-
  // obstacle stops (self/ground are toast-only via
  // HardStopToast); no drag-suppress case any more.
  const d = presentDecision({
    distMm: 10, warnMm: 40, stopMm: 15,
    pair: ['link3', 'link5'], dragActive: true,
  })
  assert.equal(d.show, 'modal')
  assert.equal(d.reason, 'below-stop')
})


// ── missing inputs ──────────────────────────────────────────

test('missing distance → show=none, reason=unknown', () => {
  const d = presentDecision({ distMm: null, warnMm: 40, stopMm: 15 })
  assert.equal(d.show, 'none')
  assert.equal(d.reason, 'unknown')
})

test('missing stopMm → show=none, reason=unknown', () => {
  const d = presentDecision({ distMm: 30, warnMm: 40, stopMm: null })
  assert.equal(d.show, 'none')
  assert.equal(d.reason, 'unknown')
})


// ── pairMuteKey still order-independent (signature stability) ─

test('pairMuteKey is order-independent', () => {
  const k1 = pairMuteKey(['link3', 'link5'])
  const k2 = pairMuteKey(['link5', 'link3'])
  assert.equal(k1, k2)
  assert.ok(k1.includes(PAIR_MUTE_SEPARATOR))
})

test('bannerLabel still formats compactly (dead code but exported)', () => {
  const s = bannerLabel(['link3', 'link5'], 42)
  assert.ok(s.includes('link3'))
  assert.ok(s.includes('link5'))
  assert.ok(s.includes('42 mm'))
})
