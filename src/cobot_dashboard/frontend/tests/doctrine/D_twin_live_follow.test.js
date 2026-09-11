// DOCTRINE — 3D twin LIVE-FOLLOW / TWIN-POSING state machine.
//
// The twin (StandaloneRobot / URDFArm) mirrors the real arm's joint
// positions from the WS stream by default. Operator interactions
// (slider drag, Face Down preview) latch a per-joint mask; the mirror
// tick SKIPS masked joints until an explicit release path clears the
// mask. Prior bug (fixed 2026-09-09): once ANY mask latched there was
// no release path in the UI — the twin silently froze against the
// real arm's ongoing motion. Fix: slider pointerup calls
// releaseJointMask, plus a Follow-Robot button calls followLive() to
// clear all six.
//
// Neither release path yanks joints anywhere — the next mirror tick
// seeds targets from the LATEST store positions.
//
// This suite is the load-bearing pin for the state machine. All state
// changes go through lib/twinFollowState primitives so React /
// three-fiber are not needed to test the invariants.
//
// Failure format:
//   DOCTRINE TWIN_LIVE_FOLLOW VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  newMask, anyPosing, applyStoreTick,
  poseJoint, releaseJoint, followLiveAll, poseAll, JOINT_COUNT,
} from '../../src/lib/twinFollowState.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE TWIN_LIVE_FOLLOW VIOLATED: ${msg}` }


// ── State-machine primitives ─────────────────────────────────────

test('follow(a): fresh mask is LIVE-FOLLOW on every joint', () => {
  const m = newMask()
  assert.equal(m.length, JOINT_COUNT, v('mask length mismatch'))
  for (let i = 0; i < JOINT_COUNT; i++) {
    assert.equal(m[i], false, v(`joint ${i} not initialised to live-follow`))
  }
  assert.equal(anyPosing(m), false,
    v('anyPosing() must be false for a fresh mask'))
})


test('follow(b): WS tick seeds every unmasked joint from store', () => {
  const mask = newMask()
  const targets = [0, 0, 0, 0, 0, 0]
  const ws = [0.1, -0.2, 0.3, -0.4, 0.5, -0.6]
  applyStoreTick(mask, targets, ws)
  for (let i = 0; i < JOINT_COUNT; i++) {
    assert.equal(targets[i], ws[i],
      v(`joint ${i} not mirrored from store in LIVE-FOLLOW`))
  }
})


test('follow(c): masked joint survives store ticks; others still mirror', () => {
  const mask = newMask()
  const targets = [0, 0, 0, 0, 0, 0]
  // Simulate operator dragging joint 2 (0-based) to 1.23 rad.
  poseJoint(mask, 2)
  targets[2] = 1.23
  // Real arm streams new positions on WS; joint 2 must NOT be
  // overwritten (that was the frozen-preview footgun).
  const ws = [0.11, -0.22, 0.33, -0.44, 0.55, -0.66]
  applyStoreTick(mask, targets, ws)
  assert.equal(targets[2], 1.23,
    v('TWIN-POSING joint was overwritten by WS mirror tick'))
  for (let i = 0; i < JOINT_COUNT; i++) {
    if (i === 2) continue
    assert.equal(targets[i], ws[i],
      v(`LIVE-FOLLOW joint ${i} did NOT mirror WS positions`))
  }
})


test('follow(d): releaseJoint returns that joint to LIVE-FOLLOW', () => {
  const mask = newMask()
  const targets = [0, 0, 0, 0, 0, 0]

  // Operator poses joint 4 at 0.9 rad.
  poseJoint(mask, 4); targets[4] = 0.9
  // Real arm streams — joint 4 stays at 0.9 (preview holds).
  applyStoreTick(mask, targets, [0, 0, 0, 0, 0.20, 0])
  assert.equal(targets[4], 0.9,
    v('TWIN-POSING preview did not hold'))

  // Slider pointerup: release joint 4 back to LIVE-FOLLOW.
  const changed = releaseJoint(mask, 4)
  assert.equal(changed, true,
    v('releaseJoint on a posing joint must return true'))
  assert.equal(mask[4], false,
    v('releaseJoint left mask[4] latched'))

  // Next WS tick — joint 4 catches up from wherever it was, NOT yanked
  // by the release call itself (targets[4] still 0.9 until next tick).
  applyStoreTick(mask, targets, [0, 0, 0, 0, 0.30, 0])
  assert.equal(targets[4], 0.30,
    v('after release, next WS tick did NOT resume mirroring joint 4'))
})


test('follow(e): followLive clears all masks with no yank', () => {
  const mask = newMask()
  const targets = [0, 0, 0, 0, 0, 0]
  // Simulate Face Down preview: all six joints latched.
  poseAll(mask)
  for (let i = 0; i < JOINT_COUNT; i++) targets[i] = 0.5 + 0.1 * i
  // WS keeps streaming; every joint holds its preview.
  applyStoreTick(mask, targets, [0, 0, 0, 0, 0, 0])
  for (let i = 0; i < JOINT_COUNT; i++) {
    assert.equal(targets[i], 0.5 + 0.1 * i,
      v(`TWIN-POSING joint ${i} did not hold under WS pressure`))
  }
  // Operator taps "Follow robot" — clears every mask.
  const changed = followLiveAll(mask)
  assert.equal(changed, true, v('followLiveAll on any-posing must return true'))
  assert.equal(anyPosing(mask), false,
    v('anyPosing() still true after followLiveAll'))
  // Next WS tick mirrors the real arm — the twin catches up from
  // wherever it was, NO snap-to-zero, NO yank inside followLive itself.
  const ws = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]
  applyStoreTick(mask, targets, ws)
  for (let i = 0; i < JOINT_COUNT; i++) {
    assert.equal(targets[i], ws[i],
      v(`joint ${i} did not resume LIVE-FOLLOW after followLiveAll`))
  }
})


test('follow(f): releaseJoint / followLiveAll never yank targets themselves',
() => {
  // followLiveAll must NOT touch targets — resetAll (legacy, yanks to
  // zero) is the yanking helper. Regression guard for the fix that
  // separated the two APIs.
  const mask = newMask()
  const targets = [1.1, 2.2, 3.3, 4.4, 5.5, 6.6]
  poseAll(mask)
  followLiveAll(mask)
  assert.deepEqual(targets, [1.1, 2.2, 3.3, 4.4, 5.5, 6.6],
    v('followLiveAll mutated targets — it must only clear the mask'))

  poseJoint(mask, 3); targets[3] = 9.9
  releaseJoint(mask, 3)
  assert.equal(targets[3], 9.9,
    v('releaseJoint mutated targets — it must only clear the mask'))
})


test('follow(g): redundant writes do not re-notify (transition-only)',
() => {
  const mask = newMask()
  // poseJoint on already-live returns true (transition).
  assert.equal(poseJoint(mask, 1), true,
    v('poseJoint on live joint must report transition=true'))
  assert.equal(poseJoint(mask, 1), false,
    v('poseJoint on already-posing joint must report transition=false '
      + '(so notifyMaskChange skips redundant fires)'))
  // releaseJoint on already-live returns false.
  assert.equal(releaseJoint(mask, 5), false,
    v('releaseJoint on live joint must report transition=false'))
  // followLiveAll on all-live returns false.
  const clear = newMask()
  assert.equal(followLiveAll(clear), false,
    v('followLiveAll on all-live must report transition=false'))
})


test('follow(h): degenerate WS payloads leave targets untouched', () => {
  const mask = newMask()
  const targets = [7, 7, 7, 7, 7, 7]
  applyStoreTick(mask, targets, null)
  applyStoreTick(mask, targets, undefined)
  applyStoreTick(mask, targets, [1, 2, 3])   // too short
  assert.deepEqual(targets, [7, 7, 7, 7, 7, 7],
    v('applyStoreTick mutated targets on a degenerate payload'))
  // NaN or non-finite entries fall back to 0 for that joint only.
  applyStoreTick(mask, targets, [1, NaN, 3, Infinity, 5, 'x'])
  assert.equal(targets[0], 1,   v('finite entry 0 not mirrored'))
  assert.equal(targets[1], 0,   v('NaN entry not clamped to 0'))
  assert.equal(targets[2], 3,   v('finite entry 2 not mirrored'))
  assert.equal(targets[3], 0,   v('Infinity entry not clamped to 0'))
  assert.equal(targets[4], 5,   v('finite entry 4 not mirrored'))
  assert.equal(targets[5], 0,   v('non-numeric entry not clamped to 0'))
})


// ── Wiring pins (source-level guards) ─────────────────────────────

test('follow(i): StandaloneRobot exposes the LIVE-FOLLOW API surface',
() => {
  const src = readSrc('components/StandaloneRobot.jsx')
  // The three release-path APIs must exist on jogApi so JointJogPanel
  // can wire them without knowing the internals.
  for (const name of ['releaseJointMask', 'followLive', 'onManualMaskChange']) {
    assert.match(src, new RegExp(`\\b${name}\\s*:`),
      v(`StandaloneRobot.jogApi is missing ${name} — panel wiring would fail`))
  }
  // Mirror effect must delegate to applyStoreTick — that's how the
  // primitive tests above cover the component's runtime behavior.
  assert.match(src, /applyStoreTick\(manualMaskRef/,
    v('mirror effect must call applyStoreTick to keep the primitive '
      + 'test suite load-bearing against runtime behavior'))
})


test('follow(j): JointJogPanel wires slider release + Follow-Robot button',
() => {
  const src = readSrc('components/JointJogPanel.jsx')
  assert.match(src, /onPointerUp=\{\(\) => onSlideEnd\(i\)\}/,
    v('slider must call onSlideEnd on pointerup (auto-release path)'))
  assert.match(src, /jogApi\?\.releaseJointMask\?\.\(idx\)/,
    v('onSlideEnd must call jogApi.releaseJointMask'))
  assert.match(src, /jogApi\?\.followLive\?\.\(\)/,
    v('Follow-Robot button must call jogApi.followLive'))
  assert.match(src, /data-testid="follow-state-banner"/,
    v('follow-state-banner test hook missing — E2E cannot assert '
      + 'the PREVIEWING / LIVE banner'))
  assert.match(src, /data-testid="follow-robot-btn"/,
    v('follow-robot-btn test hook missing'))
})
