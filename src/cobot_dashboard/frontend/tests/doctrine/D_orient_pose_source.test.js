// DOCTRINE — Orient Flange Down modal + 3D twin share ONE pose source.
//
// Operator-reported bug (2026-09-21): pressing Orient Flange Down
// sometimes raised "couldn't read the robot's orientation," yet
// Continue then executed a correct orient. Root cause: the confirm
// modal had no visibility into WS-frame freshness — it treated the
// display's cached joints.positions as always current, and the
// operator saw the server's downstream stale_joint_state refusal as
// if the ROBOT's pose was unreadable. Fix: the modal now reads the
// same lastMessageTime the 3D render subscribes to and honors a
// 1000 ms freshness gate with a bounded 2000 ms wait for a fresh
// frame, then a HONEST warning ("dashboard's pose display is
// stale") that names the display feed, not the robot's pose.
//
// This suite pins the invariant at the source level:
//   • QuickOrientButtons + ArmViewer3D + StandaloneRobot import
//     `useStore` from the SAME relative store module (../store/useStore).
//   • QuickOrientButtons + ArmViewer3D read joints via the SAME
//     selector: `s.joints?.positions`.
//   • QuickOrientButtons reads the freshness signal (lastMessageTime)
//     the 3D render uses — no second store, no cached copy.
//   • The freshness thresholds come from the ONE lib/poseFreshness
//     module (POSE_FRESH_MS + POSE_WAIT_TIMEOUT_MS + isPoseFresh).
//   • The endpoint call site is unchanged: exactly ONE POST to
//     /api/estun/orient/face_down. Continue-with-stale-display never
//     forks a second motion path.
//   • The honest stale-warning copy is intact.
//
// Failure format:
//   DOCTRINE ORIENT_POSE_SOURCE VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE ORIENT_POSE_SOURCE VIOLATED: ${msg}` }

const modalSrc     = readSrc('components/QuickOrientButtons.jsx')
const viewerSrc    = readSrc('components/ArmViewer3D.jsx')
const standaloneSrc = readSrc('components/StandaloneRobot.jsx')
const freshnessSrc = readSrc('lib/poseFreshness.js')


// ── (1) All three components import from the same store module ──────

test('modal + viewer + standalone import useStore from ../store/useStore', () => {
  for (const [name, src] of [
    ['QuickOrientButtons', modalSrc],
    ['ArmViewer3D',        viewerSrc],
    ['StandaloneRobot',    standaloneSrc],
  ]) {
    assert.ok(
      /import\s*\{\s*useStore\s*\}\s*from\s*['"]\.\.\/store\/useStore['"]/.test(src),
      v(`${name} must import { useStore } from '../store/useStore' `
        + `— any second store fork would let the modal and the 3D `
        + `view drift apart`))
  }
})


// ── (2) Modal + viewer share the same joints selector ───────────────

test('modal reads joints via s.joints?.positions', () => {
  assert.ok(
    /useStore\(\(s\)\s*=>\s*s\.joints\?\.positions\)/.test(modalSrc),
    v('QuickOrientButtons must read joints via '
      + '`useStore((s) => s.joints?.positions)` — the SAME selector '
      + 'ArmViewer3D uses'))
})

test('viewer reads joints via s.joints?.positions', () => {
  assert.ok(
    /useStore\(\(s\)\s*=>\s*s\.joints\?\.positions\)/.test(viewerSrc),
    v('ArmViewer3D must read joints via '
      + '`useStore((s) => s.joints?.positions)` — pinned so drift is '
      + 'caught here, not on-device'))
})


// ── (3) Modal reads the SAME freshness signal the 3D view uses ──────

test('modal subscribes to lastMessageTime (shared with ArmViewer3D)', () => {
  assert.ok(
    /useStore\(\(s\)\s*=>\s*s\.lastMessageTime\)/.test(modalSrc),
    v('QuickOrientButtons must subscribe to `s.lastMessageTime` — '
      + 'this is the same freshness signal ArmViewer3D uses at line '
      + '~550. Any second freshness store would let the modal and '
      + 'the 3D render disagree about "is the display fresh right '
      + 'now"'))
})

test('viewer subscribes to lastMessageTime', () => {
  assert.ok(
    /useStore\(\(s\)\s*=>\s*s\.lastMessageTime\)/.test(viewerSrc),
    v('ArmViewer3D must subscribe to `s.lastMessageTime` — pinned '
      + 'so any refactor that hides this behind a memoized selector '
      + 'is caught here, not on-device'))
})


// ── (4) Modal uses the ONE freshness helper module ──────────────────

test('modal imports the poseFreshness helpers', () => {
  assert.ok(
    /import\s*\{[^}]*POSE_FRESH_MS[^}]*\}\s*from\s*['"]\.\.\/lib\/poseFreshness['"]/.test(modalSrc),
    v('QuickOrientButtons must import POSE_FRESH_MS from '
      + '`../lib/poseFreshness` — thresholds live in one file, not '
      + 'in an ad-hoc constant hidden in the component'))
  for (const name of ['POSE_WAIT_TIMEOUT_MS',
                        'computePoseAgeMs',
                        'isPoseFresh',
                        'formatPoseAge']) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(modalSrc),
      v(`QuickOrientButtons must reference ${name} from `
        + `lib/poseFreshness — the modal cannot re-derive freshness `
        + `math in-file`))
  }
})

test('poseFreshness exports the required contract', () => {
  for (const name of ['POSE_FRESH_MS', 'POSE_WAIT_TIMEOUT_MS',
                       'computePoseAgeMs', 'isPoseFresh',
                       'formatPoseAge']) {
    assert.ok(
      new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`).test(freshnessSrc),
      v(`lib/poseFreshness must export ${name} — the modal + tests `
        + `both depend on it`))
  }
})


// ── (5) The endpoint call site is unchanged (single motion path) ────

test('modal POSTs to /api/estun/orient/face_down exactly once', () => {
  // Match the actual fetch call site — ignore commentary references
  // to the endpoint. A doc comment naming the URL is not a call
  // site; we're pinning the number of MOTION-PATH sends.
  const matches = modalSrc.match(
    /fetch\(\s*['"]\/api\/estun\/orient\/face_down['"]/g) || []
  assert.equal(matches.length, 1,
    v(`QuickOrientButtons must FETCH `
      + `/api/estun/orient/face_down EXACTLY once — found `
      + `${matches.length}. Continue-with-stale-display must NOT `
      + `fork a second motion path; the driver's own pose `
      + `precondition + FK cross-check stays authoritative.`))
})

test('modal POST uses q_target payload (no bypass fields)', () => {
  // Continue-with-stale-display routes through the SAME body shape
  // as fresh-continue. If a future edit adds a bypass flag like
  // `force: true` we want to see it here.
  assert.ok(
    /JSON\.stringify\(\{\s*q_target\s*\}\)/.test(modalSrc),
    v('the face_down POST body must be JSON.stringify({ q_target }) '
      + '— any bypass flag (force/skip_stale/allow_stale) would '
      + 'route around the driver\'s server-side stale_joint_state '
      + 'gate. Do not add one.'))
})


// ── (6) Honest warning copy — names the display, not the robot ──────

test('stale-display banner names the DISPLAY, not the robot pose', () => {
  // Copy must state that the DASHBOARD's pose DISPLAY is stale — not
  // that the robot's pose is unreadable. The prior copy leaked
  // "couldn't read the robot's current position" into a display-feed
  // problem; the robot verifies its own pose before moving.
  assert.ok(
    /pose display is stale/.test(modalSrc),
    v('stale banner must include "pose display is stale" — names '
      + 'the display feed as the problem, not the robot'))
  assert.ok(
    /robot verifies its own pose before moving/.test(modalSrc),
    v('stale banner must remind the operator that "the robot '
      + 'verifies its own pose before moving" — this is what makes '
      + 'the warning honest'))
  assert.ok(
    /last update.*ago/s.test(modalSrc),
    v('stale banner must render the frame age ("last update X ago") '
      + '— the operator needs a number to reason about'))
})

test('stale-display banner surfaces the age via a data attribute', () => {
  // Test-only surface: pins the age at the DOM boundary so headless
  // pins in either edition can assert on the number without parsing
  // localized copy.
  assert.ok(
    /data-testid="orient-flange-down-pose-stale"/.test(modalSrc),
    v('stale banner must carry data-testid="orient-flange-down-pose-stale"'))
  assert.ok(
    /data-age-ms=/.test(modalSrc),
    v('stale banner must carry data-age-ms — pins the age at DOM level'))
})


// ── (7) Freshness gate emits an event-log entry on timeout ──────────

test('stale-at-press event is logged to /api/event_log/append', () => {
  assert.ok(
    /\/api\/event_log\/append/.test(modalSrc),
    v('freshness-gate timeout must POST /api/event_log/append — the '
      + 'directive requires a LOUD event capturing frame age, device, '
      + 'transport, so we can see whether tablet WiFi is the driver'))
  assert.ok(
    /orient_flange_down\.pose_display_stale/.test(modalSrc),
    v('event code must be "orient_flange_down.pose_display_stale" '
      + '— grepable across daily JSONL for post-hoc analysis'))
})


// ── (8) Fresh-frame path renders no warning ─────────────────────────

test('waiting + stale banners render only under their poseWait branch', () => {
  // Grep-level pin: both banners live behind explicit `poseWait ===`
  // branches, so a fresh-frame press (poseWait === 'idle') cannot
  // render either. Guards against a future refactor that lifts the
  // banners out of the state check.
  const waitingCount = (modalSrc.match(/poseWait === 'waiting'/g) || []).length
  const staleCount   = (modalSrc.match(/poseWait === 'stale'/g) || []).length
  assert.ok(waitingCount >= 1,
    v(`waiting banner must be gated behind `
      + `poseWait === 'waiting' — found ${waitingCount} references`))
  assert.ok(staleCount   >= 1,
    v(`stale banner must be gated behind `
      + `poseWait === 'stale' — found ${staleCount} references`))
})


// ── (9) The 1 s / 2 s directive numbers are the SINGLE source ───────

test('poseFreshness constants match the operator directive', () => {
  assert.ok(/POSE_FRESH_MS\s*=\s*1000\b/.test(freshnessSrc),
    v('POSE_FRESH_MS must be 1000 — the directive says "older than '
      + '1000ms"'))
  assert.ok(/POSE_WAIT_TIMEOUT_MS\s*=\s*2000\b/.test(freshnessSrc),
    v('POSE_WAIT_TIMEOUT_MS must be 2000 — the directive says "wait '
      + 'up to 2s"'))
})
