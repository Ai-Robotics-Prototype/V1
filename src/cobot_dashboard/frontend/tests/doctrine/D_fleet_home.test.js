// DOCTRINE — Fleet home invariants (2026-09-21 operator directive).
//
// When the mDNS registry (self + Avahi peers) holds >1 robot the
// app's landing surface is a fleet grid. This suite pins the four
// invariants named in the directive:
//
//   1. grid-renders-per-registry — App.jsx routes to FleetHome when
//      the registry total exceeds 1 (or ?view=fleet is set).
//   2. offline-card-honest — the fleet card renders offline peers
//      as such; never fabricates status, name, or program.
//   3. no-control-on-cards — the grid has ONE tap action per card
//      (open the robot's dashboard). NO start, NO stop, NO enable,
//      NO E-STOP, NO gripper, NO jog. Fleet-level control is
//      deferred to v2 by design.
//   4. single-robot-skips-grid — a registry of ≤ 1 robot lands
//      the operator directly in the dashboard as today.
//
// E-STOP invariant: safety stays PER-ROBOT inside the connected
// dashboard, labeled with the robot's friendly_name. The fleet
// grid MUST NOT render an E-STOP button.
//
// Failure format:
//   DOCTRINE FLEET_HOME VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE FLEET_HOME VIOLATED: ${msg}` }

const appSrc     = readSrc('App.jsx')
const fleetSrc   = readSrc('pages/FleetHome.jsx')
const libSrc     = readSrc('lib/fleet.js')
const topbarSrc  = readSrc('components/TopBar.jsx')
const storeSrc   = readSrc('store/useStore.js')


// ── (1) grid-renders-per-registry ────────────────────────────────────

test('App.jsx renders FleetHome when landingView is "fleet"', () => {
  assert.ok(/import\s+FleetHome\s+from\s+['"]\.\/pages\/FleetHome['"]/.test(appSrc),
    v('App.jsx must import FleetHome from ./pages/FleetHome'))
  assert.ok(/landingView\s*===\s*['"]fleet['"]/.test(appSrc),
    v('App.jsx must branch on landingView === "fleet"'))
  assert.ok(/return\s*<FleetHome\s*\/>/s.test(appSrc),
    v('App.jsx must render <FleetHome /> inside the fleet branch'))
})

test('App.jsx uses pickLandingView from lib/fleet (single truth)', () => {
  assert.ok(/import\s*\{[^}]*pickLandingView[^}]*\}\s*from\s*['"]\.\/lib\/fleet['"]/.test(appSrc),
    v('App.jsx must import pickLandingView from ./lib/fleet — the '
      + 'landing decision must go through the ONE helper so tests '
      + 'pin one code path'))
})

test('pickLandingView pins the >1 rule', () => {
  // Sanity re-check at the source level: the >1 comparison MUST live
  // in lib/fleet, not in App.jsx (single source, testable in isolation).
  assert.ok(/totalRobots\s*>\s*1/.test(libSrc),
    v('lib/fleet.js must contain the "totalRobots > 1" rule — the '
      + 'grid-renders-per-registry threshold'))
})


// ── (2) offline-card-honest ─────────────────────────────────────────

test('FleetHome renders an offline-note when the peer is offline', () => {
  assert.ok(/data-testid="fleet-card-offline-note"/.test(fleetSrc),
    v('FleetHome must render data-testid="fleet-card-offline-note" '
      + 'for offline peers so tests can pin the honest-offline path'))
  // Copy can render the apostrophe as ', ’, or a JSX entity like
  // &apos;/&#39; — accept any of those. What we CANNOT accept is
  // the copy silently dropping the "didn't respond" contract.
  assert.ok(/didn(?:'|’|&apos;|&#39;|&#039;)t respond/i.test(fleetSrc),
    v('offline-note copy must state that the robot "didn\'t respond" '
      + '— no fake status, no fabricated name'))
})

test('normalizeCard never fabricates identity fields', () => {
  // The helper must default missing identity to empty strings, not
  // to placeholders like "Unknown robot" — that string only appears
  // as a render fallback in the card, NEVER as data.
  assert.ok(
    /friendlyName:\s*String\(ident\.friendly_name\s*\|\|\s*['"]{2}\)/.test(libSrc),
    v('normalizeCard must default friendly_name to empty string, '
      + 'not to a placeholder — offline cards render honestly'))
})

test('FleetCard reads Offline status from the payload', () => {
  // The card must render the status the backend/probe gave it. A
  // peer whose probe times out returns status="Offline"; the card
  // must render that verbatim, not derive a different label.
  assert.ok(/data-testid="fleet-card-status-pill"/.test(fleetSrc),
    v('FleetCard must render the status pill with the exact '
      + 'testid'))
  assert.ok(/data-is-offline=/.test(fleetSrc),
    v('FleetCard must expose data-is-offline for tests'))
})


// ── (3) no-control-on-cards ─────────────────────────────────────────

test('FleetHome contains NO control endpoints or verbs', () => {
  // Grep-pin the forbidden control surfaces. Fleet-level control is
  // deferred to v2 — the ONLY action on the grid is "open the
  // robot's dashboard" via a location redirect. If a future edit
  // adds a Start / Stop / Enable / E-STOP / Jog button here, this
  // pin fails and the operator directive is re-asserted.
  const forbidden = [
    { pat: /\/api\/estun\/(mode|program\/|orient)/,
      hint: 'no /api/estun/... control endpoint' },
    { pat: /\/cmd\/(estop|jog|task|gripper|power|voice)/,
      hint: 'no /cmd/... control endpoint' },
    { pat: /triggerEstop|releaseEstop/,
      hint: 'no E-STOP action on the fleet grid — safety stays '
            + 'per-robot inside the connected dashboard' },
    { pat: /\bE-STOP\b|\bEStop\b|\bestop\b/,
      hint: 'no E-STOP label / component on the fleet grid — '
            + 'safety invariant' },
    { pat: /program\/run|programRun|Run\s+program/i,
      hint: 'no run-program affordance on the fleet grid' },
    { pat: /\bmethod:\s*['"]POST['"]/,
      hint: 'no POST from the fleet grid (VIEW-tier)' },
    { pat: /\bmethod:\s*['"](PUT|DELETE|PATCH)['"]/,
      hint: 'no PUT/DELETE/PATCH from the fleet grid (VIEW-tier)' },
  ]
  for (const { pat, hint } of forbidden) {
    assert.equal(pat.test(fleetSrc), false,
      v(`fleet grid must NOT contain ${pat} — ${hint}`))
  }
})

test('FleetHome cards use ONE tap action: location redirect', () => {
  // The card's onClick MUST route through window.location (cross-
  // origin redirect) — never through a fetch/dispatch. Deferred
  // fleet-level control would need a different code path here.
  assert.ok(/window\.location\.href/.test(fleetSrc),
    v('FleetCard must navigate via window.location.href — the '
      + 'cross-origin redirect is the ONLY tap action in v1'))
})


// ── (4) single-robot-skips-grid ─────────────────────────────────────

test('App.jsx gates FleetHome on fleetTotal > 1', () => {
  // The render branch must combine BOTH the URL-view decision AND
  // the numeric guard so a single-robot install never lands here
  // even if a stale ?view=fleet param is on the URL.
  assert.ok(/fleetTotal\s*>\s*1/.test(appSrc),
    v('App.jsx must gate the FleetHome render on fleetTotal > 1'))
  assert.ok(/fleetHydrated\s*&&\s*landingView\s*===\s*['"]fleet['"]/.test(appSrc),
    v('App.jsx must gate on fleetHydrated so we do not flash-render '
      + 'the fleet grid before /api/fleet/peers has answered'))
})

test('store.hydrateFleet is the single fleet-hydrate site', () => {
  assert.ok(/hydrateFleet\s*\(?/.test(storeSrc),
    v('useStore must expose hydrateFleet — the ONE fleet-hydrate '
      + 'action App.jsx calls'))
  assert.ok(/fleetTotal:/.test(storeSrc),
    v('useStore must expose fleetTotal so TopBar can gate the '
      + 'back-to-fleet chip on the same signal App.jsx uses'))
})


// ── E-STOP stays per-robot, named with friendly_name ────────────────

test('TopBar E-STOP is labeled with the robot friendly_name', () => {
  assert.ok(/data-testid="topbar-estop"/.test(topbarSrc),
    v('TopBar E-STOP must carry data-testid="topbar-estop"'))
  assert.ok(/robotIdentity\?\.friendly_name/.test(topbarSrc),
    v('TopBar must read robotIdentity.friendly_name from the store '
      + 'and render it under the E-STOP label — the operator on '
      + 'a two-dashboard workstation must always know which robot '
      + 'they are stopping'))
})

test('TopBar renders a Fleet chip only when fleetTotal > 1', () => {
  assert.ok(/data-testid="topbar-fleet-chip"/.test(topbarSrc),
    v('TopBar must expose the fleet chip via '
      + 'data-testid="topbar-fleet-chip"'))
  assert.ok(/fleetTotal\s*>\s*1/.test(topbarSrc),
    v('TopBar must gate the Fleet chip on fleetTotal > 1 — a '
      + 'single-robot install never sees the affordance'))
})


// ── VIEW-tier: fleet endpoints stay in the unauth allowlist ─────────

test('fleet endpoints are hit with credentials: omit (no token)', () => {
  // The fleet endpoints are VIEW-tier per the auth pivot. The
  // frontend explicitly omits credentials so a stale token from a
  // previous session doesn't smuggle auth into a discovery call.
  assert.ok(/credentials:\s*['"]omit['"]/.test(libSrc),
    v('lib/fleet.js must call /api/fleet/peers with credentials: '
      + '"omit" — the discovery layer is VIEW-tier'))
})
