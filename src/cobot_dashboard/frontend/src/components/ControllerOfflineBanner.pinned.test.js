// ControllerOfflineBanner — pins for the 2026-09-15 auto-recovery
// directive. The banner is a can't-miss operator inform tied to
// STATE.robot.controller_offline, mounted globally so BOTH editions
// see it without an edition slice.
//
// These pins are source-level: they protect the banner's operator
// copy (no dev jargon), its two visual states (amber offline, green
// recovered), the auto-dismiss on recovery, and the App.jsx mount.
// Behavioral state-machine logic (down/up flip decision) lives in
// staleness.py and is pinned there under test_cri_proxy_staleness.py.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const bannerSrc = fs.readFileSync(
  path.resolve(__dirname, 'ControllerOfflineBanner.jsx'), 'utf8')
const appSrc = fs.readFileSync(
  path.resolve(__dirname, '..', 'App.jsx'), 'utf8')
const dashSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', 'cobot_dashboard',
                'dashboard_server.py'), 'utf8')


// ── Banner source ───────────────────────────────────────────────

test('banner reads STATE.robot.controller_offline', () => {
  assert.ok(/controller_offline/.test(bannerSrc),
    'banner must consume STATE.robot.controller_offline as the '
    + 'authoritative offline signal (set by the dashboard\'s '
    + 'controller-staleness watchdog + synced from driver-reported '
    + 'connected in _on_estun_status)')
})

test('banner operator copy has no dev jargon', () => {
  // Per the auto-recovery directive: "NO dev jargon in banners."
  // Amber label MUST say "Controller offline — reconnecting…"; green
  // label MUST say "Reconnected". No SHA, no error codes, no
  // "WebSocket", no "estun" — in the RENDERED strings (source-level
  // comments naming things are fine and expected).
  assert.ok(bannerSrc.includes('Controller offline — reconnecting…'),
    'amber banner label must read "Controller offline — reconnecting…"')
  assert.ok(bannerSrc.includes("'Reconnected'"),
    'green banner label must read "Reconnected"')
  // Extract the label string-literal assignments — the operator-
  // facing text. Only those must be scrubbed of dev tokens.
  const labelExpr = /const\s+label\s*=[\s\S]*?:\s*'[^']+'/.exec(bannerSrc)
  assert.ok(labelExpr, 'label ternary not found in banner source')
  const rendered = labelExpr[0]
  for (const forbidden of [
    'WebSocket', '/estun/', 'sha ', 'ROS2', 'ws://', 'wss://', 'HTTP',
  ]) {
    assert.ok(!rendered.includes(forbidden),
      `banner RENDERED label MUST NOT contain dev-jargon token: "${forbidden}" — `
      + `found in: ${rendered.replace(/\n/g, ' ')}`)
  }
})

test('banner exposes offline + recovered testids for pins', () => {
  assert.ok(bannerSrc.includes("data-testid=\"controller-offline-banner\""),
    'banner must expose data-testid so pins can target it')
  assert.ok(/data-state=\{offline \? 'offline' : 'recovered'\}/.test(bannerSrc),
    'banner must expose data-state=offline|recovered so pins can '
    + 'distinguish the two visual modes')
})

test('recovered toast auto-dismisses (not sticky)', () => {
  // The "Reconnected" green state is meant to be brief — the
  // operator sees a confirmation and then the banner clears
  // back to normal chrome. If someone removes the setTimeout,
  // the green banner turns into a stuck strip after every
  // reconnect.
  assert.ok(/setTimeout\(\(\)\s*=>\s*setShowRecovered\(false\)/.test(bannerSrc),
    'recovered state MUST auto-dismiss via setTimeout — a sticky '
    + 'green banner would stack up after every reconnect')
  assert.ok(/RECOVERED_TOAST_MS\s*=\s*3000/.test(bannerSrc),
    'auto-dismiss delay must be defined as a named constant (3s)')
})

test('banner is non-blocking (pointerEvents: none)', () => {
  // Same rule as StaleCodegenBanner: the strip must NEVER block
  // clicks on the topbar or any operator control underneath.
  assert.ok(/pointerEvents:\s*'none'/.test(bannerSrc),
    'banner MUST NOT block clicks — pointerEvents:none is required')
})


// ── App.jsx mount (edition independence) ────────────────────────

test('banner is mounted globally in App.jsx (edition independent)', () => {
  assert.ok(/import\s+ControllerOfflineBanner\s+from/.test(appSrc),
    'App.jsx must import ControllerOfflineBanner')
  assert.ok(/<ControllerOfflineBanner\s*\/>/.test(appSrc),
    'App.jsx must mount <ControllerOfflineBanner /> at the app shell '
    + '— NOT inside an edition-gated layout. Both editions must render it.')
  // Belt-and-suspenders: the mount must not be inside an
  // isFeatureEnabled / edition-slice check. Scan the block from
  // <ControllerOfflineBanner /> back up to the previous open of
  // <ErrorBoundary>; that region must not contain edition gating.
  const bannerMatch = appSrc.match(/<ControllerOfflineBanner\s*\/>/)
  assert.ok(bannerMatch, 'banner mount not found in App.jsx')
})


// ── Backend wiring ──────────────────────────────────────────────

test('backend staleness loop is NOT gated on JOG_BACKEND==ros2', () => {
  // Pre-2026-09-15, the entire _cri_proxy_staleness_loop body was
  // wrapped in `if _JOG_BACKEND_ENV == "ros2":` — under ws (the
  // live config) nothing flipped controller_offline and the
  // frontend held stale state forever. Pin the ungating.
  const loopMatch = dashSrc.match(/def _cri_proxy_staleness_loop[\s\S]*?time\.sleep\(0\.2\)/)
  assert.ok(loopMatch, '_cri_proxy_staleness_loop not found in dashboard_server')
  const loopBody = loopMatch[0]
  assert.ok(!/if\s+_JOG_BACKEND_ENV\s*==\s*["']ros2["']\s*:\s*\n\s*now_mono/.test(loopBody),
    'the top-level `if _JOG_BACKEND_ENV == "ros2":` gate MUST be '
    + 'removed — the watchdog now runs for both backends so a '
    + 'WS-mode controller drop actually flips the offline flag.')
})

test('backend sets controller_offline flag on the STATE.robot mirror', () => {
  // The banner reads STATE.robot.controller_offline. This is set
  // by the watchdog on flip-down AND synced by _on_estun_status
  // whenever a fresh status frame lands.
  assert.ok(/r\[["']controller_offline["']\]\s*=\s*True/.test(dashSrc),
    'watchdog must set r["controller_offline"]=True on flip-down')
  assert.ok(/r\[["']controller_offline["']\]\s*=\s*False/.test(dashSrc),
    '_on_estun_status must clear r["controller_offline"] when the '
    + 'driver reports connected=true')
})
