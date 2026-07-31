// collisionPresentation — the decision rule from §396 (2026-07-31).
//
// Pinned invariants:
//   * warn zone → banner, never modal
//   * stop zone → modal (unless drag-active, then banner)
//   * mute affects banner ONLY, never the modal
//   * bannerOn=false hides the banner but NEVER the modal
//   * pairMuteKey is order-independent so [a,b] and [b,a] share
//     one mute entry

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  presentDecision,
  pairMuteKey,
  bannerLabel,
  PAIR_MUTE_SEPARATOR,
} from './collisionPresentation.js'


// ── Warn / stop routing ──────────────────────────────────────

test('above warn threshold → show=none, level=near', () => {
  const d = presentDecision({ distMm: 200, warnMm: 40, stopMm: 20 })
  assert.equal(d.show, 'none')
  assert.equal(d.level, 'near')
  assert.equal(d.reason, 'above-warn')
})

test('inside warn band → show=banner, level=warn, NEVER modal', () => {
  const d = presentDecision({ distMm: 35, warnMm: 40, stopMm: 20 })
  assert.equal(d.show, 'banner',
    'directive: warn zone shows banner only, NEVER a modal')
  assert.equal(d.level, 'warn')
  assert.equal(d.reason, 'in-warn')
})

test('at stop threshold → show=modal (dist <= stop)', () => {
  const d = presentDecision({ distMm: 20, warnMm: 40, stopMm: 20 })
  assert.equal(d.show, 'modal',
    'exactly at stop threshold is the modal zone')
  assert.equal(d.level, 'stop')
  assert.equal(d.reason, 'below-stop')
})

test('below stop threshold → show=modal', () => {
  const d = presentDecision({ distMm: 8, warnMm: 40, stopMm: 20 })
  assert.equal(d.show, 'modal')
  assert.equal(d.level, 'stop')
})

test('unknown distance → show=none, reason=unknown', () => {
  for (const bad of [
    { distMm: null, warnMm: 40, stopMm: 20 },
    { distMm: 30,   warnMm: null, stopMm: 20 },
    { distMm: 30,   warnMm: 40, stopMm: null },
  ]) {
    const d = presentDecision(bad)
    assert.equal(d.show, 'none')
    assert.equal(d.reason, 'unknown')
  }
})


// ── No modal above stop threshold (the operator rule) ────────

test('DIRECTIVE — no modal ever above the stop threshold', () => {
  // Sweep the warn band; the resolver must NEVER emit 'modal'.
  for (let d = 40; d > 20.0001; d -= 0.5) {
    const dec = presentDecision({ distMm: d, warnMm: 40, stopMm: 20 })
    assert.notEqual(dec.show, 'modal',
      `dist=${d} sits in the warn band — modal must NEVER open here`)
  }
})


// ── Toggle scope: banner-only, modal untouched ───────────────

test('bannerOn=false hides the banner but NEVER the modal', () => {
  // Warn zone — banner off → hidden.
  const warn = presentDecision({
    distMm: 30, warnMm: 40, stopMm: 20, bannerOn: false,
  })
  assert.equal(warn.show, 'none')
  assert.equal(warn.reason, 'banner-off')
  // Stop zone — banner off → modal STILL fires.
  const stop = presentDecision({
    distMm: 10, warnMm: 40, stopMm: 20, bannerOn: false,
  })
  assert.equal(stop.show, 'modal',
    'DIRECTIVE — the stop-zone block is NOT behind the toggle. '
    + 'That was the whole point of the "on/off, honest and visible" wording')
})


// ── Per-pair mute scope: banner-only, modal untouched ────────

test('pairMuted=true suppresses the banner but NEVER the modal', () => {
  const warn = presentDecision({
    distMm: 30, warnMm: 40, stopMm: 20, pairMuted: true,
  })
  assert.equal(warn.show, 'none')
  assert.equal(warn.reason, 'muted')
  const stop = presentDecision({
    distMm: 10, warnMm: 40, stopMm: 20, pairMuted: true,
  })
  assert.equal(stop.show, 'modal',
    'mute never applies to the modal — the operator can\'t mute '
    + 'the last line of defense')
})


// ── Drag-active edge cases ───────────────────────────────────

test('drag-active in stop zone → banner (modal suppressed)', () => {
  const d = presentDecision({
    distMm: 10, warnMm: 40, stopMm: 20, dragActive: true,
  })
  assert.equal(d.show, 'banner',
    'DIRECTIVE — during drag, never a modal mid-hand-guide. '
    + 'The driver\'s motion-block still applies at the controller.')
  assert.equal(d.level, 'stop',
    'level still reports stop so the banner can paint red')
  assert.equal(d.reason, 'drag-suppresses-modal')
})

test('drag-active in warn zone → banner (unchanged)', () => {
  const d = presentDecision({
    distMm: 30, warnMm: 40, stopMm: 20, dragActive: true,
  })
  assert.equal(d.show, 'banner')
  assert.equal(d.level, 'warn')
})

test('drag-active + banner off + stop zone → still no modal, but drag-active is enough context', () => {
  // A wilder combo: operator turned banners off AND is drag-guiding
  // AND we entered stop. bannerOn=false should NOT re-enable the
  // modal that drag suppressed — it's the more restrictive rule
  // (drag) that wins.
  const d = presentDecision({
    distMm: 10, warnMm: 40, stopMm: 20,
    dragActive: true, bannerOn: false,
  })
  assert.notEqual(d.show, 'modal',
    'never a modal mid-drag, regardless of the toggle')
})


// ── Mute key normalization ────────────────────────────────────

test('pairMuteKey is order-independent', () => {
  const k1 = pairMuteKey(['link3_forearm', 'link5_wrist2'])
  const k2 = pairMuteKey(['link5_wrist2', 'link3_forearm'])
  assert.equal(k1, k2,
    'muting [a,b] must also mute [b,a] — the driver may report '
    + 'either ordering on any given tick')
  assert.ok(k1.includes(PAIR_MUTE_SEPARATOR),
    'key uses the ↔ separator so it reads naturally in logs')
})

test('pairMuteKey handles nonsense input safely', () => {
  assert.equal(pairMuteKey(null), null)
  assert.equal(pairMuteKey([]), null)
  assert.equal(pairMuteKey(['only-one']), null)
})


// ── Banner label copy ────────────────────────────────────────

test('bannerLabel: matches the directive example ("linkA↔linkB: NNmm")', () => {
  const s = bannerLabel(['link3_forearm', 'link5_wrist2'], 48)
  // Directive example: "link3↔link5: 48mm" — allow "48 mm" with a
  // space; the short link names must appear.
  assert.ok(/link3/.test(s), 'must include the short link3 name')
  assert.ok(/link5/.test(s), 'must include the short link5 name')
  assert.ok(/48\s*mm/.test(s), 'must include the distance in mm')
  assert.ok(s.includes(PAIR_MUTE_SEPARATOR),
    'must include the ↔ separator so the two links read as a pair')
})

test('bannerLabel: unknown distance renders as em-dash', () => {
  const s = bannerLabel(['a', 'b'], null)
  assert.ok(s.includes('—'), 'unknown distance falls back to em-dash')
})

test('bannerLabel: __ground__ shortens to "ground"', () => {
  const s = bannerLabel(['__ground__', 'link6_flange'], 12)
  assert.ok(/ground/.test(s))
  assert.ok(/link6/.test(s))
})
