// DOCTRINE — E-STOP button + overlay ISOLATED from fleet/poll churn.
//
// 2026-09-21 regression sweep of the fleet commit (802fdc2). The
// operator reported the dashboard E-STOP flashing a prompt that
// vanished immediately. Root cause was two-layered:
//
//   (1) Backend: ROS `/safety/estop` publisher clobbered a soft-
//       commanded stop within 1 s. Fixed by split-source software
//       latch (see test/test_software_estop_latch.py — Python).
//
//   (2) Frontend defence-in-depth: the E-STOP button + the
//       EStopOverlay must NOT unmount as a side effect of fleet-
//       home polling, hydrateFleet, or any tab navigation. Their
//       fibers must survive every store update the fleet commit
//       introduced; only an actual `estop` state flip may drive
//       their visibility. This suite pins that discipline at the
//       source level.
//
// Failure format:
//   DOCTRINE ESTOP_ISOLATION VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE ESTOP_ISOLATION VIOLATED: ${msg}` }

const topbarSrc  = readSrc('components/TopBar.jsx')
const overlaySrc = readSrc('components/EStopOverlay.jsx')
const storeSrc   = readSrc('store/useStore.js')
const appSrc     = readSrc('App.jsx')


// ── (1) E-STOP press path does not read fleet or poll state ─────────

test('EStopOverlay does not import or read any fleet/poll signal', () => {
  // The overlay's mount decision + local state must depend ONLY on
  // safety.estop + safety.zone + safety.human_proximity + release
  // actions. Any reference to fleet* / robotIdentity / hydrateFleet
  // would let the overlay's fiber remount when those change.
  for (const forbidden of [
    'fleetTotal', 'fleetHydrated', 'robotIdentity', 'hydrateFleet',
    'fetchFleetPeers', '/api/fleet',
  ]) {
    assert.equal(overlaySrc.includes(forbidden), false,
      v(`EStopOverlay must not reference "${forbidden}" — the E-STOP `
        + `surface is per-robot safety, isolated from every fleet-`
        + `hydration signal so a fleet re-render cannot unmount the `
        + `confirm prompt mid-press.`))
  }
})

test('triggerEstop / releaseEstop / overrideEstop do not touch fleet', () => {
  // Extract the safety actions block from the store source and
  // prove none of them reference the fleet fields the 802fdc2
  // commit introduced.
  const safetyIdx = storeSrc.indexOf('// Safety commands')
  assert.ok(safetyIdx > 0,
    v('store must contain a "// Safety commands" section header'))
  // Take a healthy window past the marker — the three actions live
  // inside ~200 lines of the header.
  const safetyBlock = storeSrc.slice(safetyIdx, safetyIdx + 3000)
  for (const forbidden of [
    'fleetTotal', 'fleetHydrated', 'hydrateFleet', 'robotIdentity',
    '/api/fleet',
  ]) {
    assert.equal(safetyBlock.includes(forbidden), false,
      v(`triggerEstop / releaseEstop must not reference "${forbidden}" `
        + `— the E-STOP press path is a safety surface and cannot `
        + `depend on the fleet layer's state.`))
  }
})


// ── (2) EStopOverlay's mount visibility is driven by estop alone ────

test('EStopOverlay early-returns null on !estop and mounts on estop', () => {
  // The overlay's fiber persists across React re-renders; its
  // visibility is toggled by the `if (!estop) return null` guard.
  // Any additional guard (e.g. gated on fleet state) would let a
  // fleet churn hide the overlay while a stop was actively
  // commanded — the exact 2026-09-21 field-bug fingerprint.
  assert.ok(/if \(!estop\) return null/.test(overlaySrc),
    v('EStopOverlay must gate its render exclusively on the `estop` '
      + 'boolean — no additional guards may be inserted here.'))
})


// ── (3) Bug B — landing decision is settled + memoized ─────────────

test('App.jsx computes the FleetHome decision via useMemo', () => {
  assert.ok(/useMemo\(\(\)\s*=>\s*\{[^}]*fleetHydrated[\s\S]*fleetTotal/s
              .test(appSrc),
    v('App.jsx must memoize the FleetHome landing decision on '
      + '`fleetHydrated` + `fleetTotal` so a tab click (which does '
      + 'not change either) cannot flip the branch mid-navigation.'))
})

test('App.jsx FleetHome branch gates on the memoized showFleetHome only', () => {
  // The render branch must consume the memo, not re-derive at render.
  assert.ok(/if \(showFleetHome\)/.test(appSrc),
    v('App.jsx must gate the FleetHome render on the memoized '
      + '`showFleetHome` — re-deriving in the JSX defeats the memo '
      + 'and re-opens the mid-navigation flash window.'))
})

test('showFleetHome memo deps are [fleetHydrated, fleetTotal] only', () => {
  // The memo's dependency array must NOT include `activeTab` or any
  // other navigation signal. If it did, `setTab('io')` would
  // re-compute the memo AND could theoretically flip
  // showFleetHome for one frame — the exact bug B fingerprint.
  const idx = appSrc.indexOf('const showFleetHome = useMemo')
  assert.ok(idx > 0, v('App.jsx must define `showFleetHome` via useMemo'))
  const memoBlock = appSrc.slice(idx, idx + 800)
  const depsMatch = memoBlock.match(/\},\s*\[([^\]]*)\]\)/)
  assert.ok(depsMatch, v('useMemo dep array not found'))
  const deps = depsMatch[1].split(',').map((s) => s.trim())
              .filter((s) => s.length > 0)
  assert.deepEqual(deps.sort(), ['fleetHydrated', 'fleetTotal'],
    v(`showFleetHome memo deps must be exactly `
      + `[fleetHydrated, fleetTotal] — found [${deps.join(', ')}]. `
      + `Adding any nav-tied dep (activeTab, tab URL) reopens the `
      + `black-flash window during in-app navigation.`))
})

test('DevicePairingWizard is an OVERLAY, not a top-level return branch', () => {
  // 2026-09-21 field bug B: operator saw a "brief pair device
  // prompt" flash on I/O tab navigation. Root cause: DevicePairing-
  // Wizard was rendered via `if (needsPair) return <Wizard />` — a
  // top-level return, which UNMOUNTED the whole dashboard tree
  // (TopBar / IOPage / 3D twin / EStopOverlay ALL destroyed) when
  // any spurious `roboai-pair-required` event fired. Fix: render
  // the wizard as an in-tree overlay after the dashboard grid so
  // the dashboard NEVER unmounts. Any spurious dispatch is now
  // capped at rendering a fixed-position overlay that layers on
  // top; underlying pages stay mounted with their local state.
  //
  // Pin at source level: DevicePairingWizard must appear inside
  // the JSX tree (near LoginModal), NOT inside any `if (...)
  // return <DevicePairingWizard ...>` shape.
  assert.equal(
    /if\s*\([^)]*\)\s*\{?\s*return\s*<DevicePairingWizard/.test(appSrc),
    false,
    v('DevicePairingWizard must NOT appear inside an `if (...) '
      + 'return` block. Rendering it as a top-level early return '
      + 'unmounts the dashboard tree on every spurious pair-required '
      + 'event — the exact 2026-09-21 I/O-tab flash bug.'))
  // Positive assertion: the wizard IS rendered inside the JSX
  // subtree that also contains PairRequestModal / LoginModal.
  assert.ok(/\{needsPair && \(\s*<DevicePairingWizard/.test(appSrc),
    v('DevicePairingWizard must render as `{needsPair && '
      + '(<DevicePairingWizard ... />)}` alongside PairRequestModal '
      + '/ LoginModal — an overlay layered on top of the dashboard, '
      + 'never a replacement for it.'))
})

test('roboai-pair-required event goes through the confirmation probe', () => {
  // Defence-in-depth: even if the wizard is an overlay, we don't
  // want a spurious event to flash the black Screen wrapper for
  // one frame. Under PAIRING_ENFORCED=0, no legitimate 401
  // pairing_required can fire — so the event handler MUST probe
  // /api/paired_devices before honouring the dispatch.
  assert.ok(/roboai-pair-required[\s\S]*?fetch\(['"]\/api\/paired_devices['"]/
              .test(appSrc),
    v('roboai-pair-required listener must probe /api/paired_devices '
      + 'before setting needsPair=true. This is the confirmation '
      + 'gate that swallows stale/transient 401s from spurious '
      + 'WS reconnects or middleware races.'))
})

test('App.jsx memo bails on !fleetHydrated so no flash pre-hydration', () => {
  // Belt-and-braces: the memo must fast-return false when
  // fleetHydrated is false. A single-robot install lands in the
  // dashboard immediately and NEVER sees the FleetHome page.
  assert.ok(/if\s*\(!fleetHydrated\)\s*return false/.test(appSrc),
    v('App.jsx memo must return false while !fleetHydrated so the '
      + 'FleetHome page cannot briefly render before /api/fleet/peers '
      + 'has answered.'))
  assert.ok(/if\s*\(fleetTotal\s*<=\s*1\)\s*return false/.test(appSrc),
    v('App.jsx memo must return false when fleetTotal <= 1 — this '
      + 'is the single-robot-skips-grid invariant, hardened at the '
      + 'memo layer so an errant ?view=fleet URL cannot show the '
      + 'grid to a solo operator.'))
})


// ── (4) hydrateFleet is a ONE-SHOT (not an interval on the dashboard) ─

test('App.jsx does not wire hydrateFleet to any setInterval', () => {
  // FleetHome (the grid page) has its own 5 s poll, but that page
  // only mounts when fleetTotal > 1. The DASHBOARD render path must
  // NOT poll — the operator directive requires the E-STOP surface
  // to sit above any polling re-render.
  const appHydrateArea = appSrc.substring(
    appSrc.indexOf('hydrateFleet'), appSrc.indexOf('hydrateFleet') + 400)
  assert.equal(/setInterval/.test(appHydrateArea), false,
    v('App.jsx must not poll hydrateFleet via setInterval. Fleet '
      + 'hydration on the dashboard is a one-shot on mount; the 5 s '
      + 'poll belongs to FleetHome (which only mounts on multi-robot).'))
})

test('useStore.hydrateFleet does not schedule any polling', () => {
  const hydrateIdx = storeSrc.indexOf('async hydrateFleet')
  assert.ok(hydrateIdx > 0,
    v('useStore must define async hydrateFleet'))
  const block = storeSrc.slice(hydrateIdx, hydrateIdx + 1400)
  assert.equal(/setInterval|setTimeout/.test(block), false,
    v('useStore.hydrateFleet must not set any interval/timeout — '
      + 'polling for the fleet grid lives on pages/FleetHome.jsx '
      + 'and only fires when that page is mounted.'))
})


// ── (5) Bug C — subtitle conditional (present > 1, absent === 1) ────

test('E-STOP subtitle stays gated on fleetTotal > 1', () => {
  // Extract the E-STOP button block; assert the subtitle span
  // appears AND lives inside a `fleetTotal > 1` conditional.
  const idx = topbarSrc.indexOf('data-testid="topbar-estop"')
  assert.ok(idx > 0, v('E-STOP button block not found'))
  const buttonBlock = topbarSrc.slice(idx, idx + 3000)
  const subIdx = buttonBlock.indexOf(
    'data-testid="topbar-estop-robot-subtitle"')
  assert.ok(subIdx > 0,
    v('subtitle span must exist (multi-robot branch)'))
  const preSub = buttonBlock.slice(0, subIdx)
  assert.ok(/fleetTotal\s*>\s*1/.test(preSub),
    v('subtitle span must be gated on fleetTotal > 1 — single-robot '
      + 'dashboards render E-STOP without a subtitle (operator '
      + 'correction 2026-09-21).'))
  assert.ok(/data-multi-robot=\{String\(fleetTotal\s*>\s*1\)\}/
              .test(topbarSrc),
    v('E-STOP button must expose data-multi-robot for downstream '
      + 'DOM-level pins to key on without re-deriving the gate.'))
})


// ── (6) All prior fleet pins still expected to pass (grep here so ────
//        this suite fails loudly if the fleet-doctrine file goes AWOL) ─

test('D_fleet_home.test.js still lives in the tree', () => {
  // A future refactor that renames or removes the fleet doctrine
  // would silently drop those pins. Keep this cross-reference
  // green so we always run BOTH suites together.
  const path = join(__dirname, 'D_fleet_home.test.js')
  const exists = readFileSync(path, 'utf8').length > 0
  assert.ok(exists, v('D_fleet_home.test.js must remain in place'))
})
