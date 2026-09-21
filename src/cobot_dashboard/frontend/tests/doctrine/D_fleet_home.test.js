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

test('App.jsx renders FleetHome via the settled `showFleetHome` memo', () => {
  // 2026-09-21 regression sweep: the fleet branch was reshaped to
  // route through a `useMemo` on the SETTLED signals so a tab
  // click (which does not change fleetHydrated / fleetTotal) can
  // NEVER flip the branch mid-navigation. Grep-pins the shape.
  assert.ok(/import\s+FleetHome\s+from\s+['"]\.\/pages\/FleetHome['"]/.test(appSrc),
    v('App.jsx must import FleetHome from ./pages/FleetHome'))
  assert.ok(/const showFleetHome = useMemo/.test(appSrc),
    v('App.jsx must derive `showFleetHome` via useMemo on the '
      + 'settled fleet signals (bug B fix — no mid-nav flip).'))
  assert.ok(/if \(showFleetHome\)\s*\{[\s\S]*?return <FleetHome \/>/s
              .test(appSrc),
    v('App.jsx must render <FleetHome /> inside `if (showFleetHome)`. '
      + 'Re-deriving the guard in JSX would defeat the memo.'))
  // The memo body must call pickLandingView with the SETTLED count
  // and the current URL search — no other args, no other state.
  assert.ok(/pickLandingView\(\{\s*totalRobots:\s*fleetTotal/.test(appSrc),
    v('showFleetHome memo must feed pickLandingView with fleetTotal'))
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

test('App.jsx gates FleetHome on fleetTotal > 1 (inside the memo)', () => {
  // 2026-09-21 regression sweep: the numeric + hydration guards now
  // live INSIDE the `showFleetHome` memo (not in the JSX branch),
  // so the settled decision cannot flip mid-navigation. Pin both.
  assert.ok(/fleetTotal\s*<=\s*1/.test(appSrc),
    v('showFleetHome memo must short-circuit on fleetTotal <= 1 '
      + '(single-robot-skips-grid, hardened at the memo layer)'))
  assert.ok(/!fleetHydrated/.test(appSrc),
    v('showFleetHome memo must short-circuit on !fleetHydrated so '
      + 'FleetHome never briefly renders before /api/fleet/peers '
      + 'has answered — this is the pre-hydration flash guard.'))
})

test('store.hydrateFleet is the single fleet-hydrate site', () => {
  assert.ok(/hydrateFleet\s*\(?/.test(storeSrc),
    v('useStore must expose hydrateFleet — the ONE fleet-hydrate '
      + 'action App.jsx calls'))
  assert.ok(/fleetTotal:/.test(storeSrc),
    v('useStore must expose fleetTotal so TopBar can gate the '
      + 'back-to-fleet chip on the same signal App.jsx uses'))
})


// ── E-STOP stays per-robot; subtitle is a MULTI-ROBOT-ONLY affordance ─
//
// Operator correction (2026-09-21): the robot-name subtitle under
// E-STOP is scoped to multi-robot context. Wrong-robot confusion
// only exists when the operator has more than one robot to reach;
// on a single-robot dashboard the subtitle is wrong scope and
// visual noise. Gate: identical to the Fleet chip — render iff
// fleetTotal > 1. This pair of pins guards the conditional at
// source level.

test('TopBar E-STOP carries testids for both subtitle-branch pins', () => {
  assert.ok(/data-testid="topbar-estop"/.test(topbarSrc),
    v('TopBar E-STOP must carry data-testid="topbar-estop"'))
  assert.ok(/robotIdentity\?\.friendly_name/.test(topbarSrc),
    v('TopBar must read robotIdentity.friendly_name from the store — '
      + 'the source of the subtitle text under multi-robot context'))
  // The subtitle span is a distinct testid so pins can assert its
  // presence + absence independently of the E-STOP button itself.
  assert.ok(/data-testid="topbar-estop-robot-subtitle"/.test(topbarSrc),
    v('TopBar E-STOP subtitle must carry '
      + 'data-testid="topbar-estop-robot-subtitle" so tests can pin '
      + 'the conditional render'))
})

test('E-STOP subtitle is gated on fleetTotal > 1 (multi-robot ONLY)', () => {
  // The subtitle span MUST appear inside a `fleetTotal > 1` branch,
  // NEVER at the top level of the button. This is what makes the
  // single-robot dashboard render E-STOP exactly as before the
  // fleet commit — no subtitle, no column-flex, no wrong scope.
  //
  // Extract the E-STOP button block and prove the subtitle
  // subtree lives inside a `fleetTotal > 1` conditional. Doing
  // this at the source level (not DOM) keeps the pin honest under
  // any future refactor that inverts the ternary.
  const idx = topbarSrc.indexOf('data-testid="topbar-estop"')
  assert.ok(idx > 0, v('E-STOP button block not found in TopBar'))
  const buttonBlock = topbarSrc.slice(idx, idx + 3000)

  // (1) The subtitle span appears in the source (present branch).
  const subtitleIdx = buttonBlock.indexOf(
    'data-testid="topbar-estop-robot-subtitle"')
  assert.ok(subtitleIdx > 0,
    v('E-STOP subtitle span must be present in the source — it is '
      + 'the multi-robot branch of the conditional'))

  // (2) Between the button opening and the subtitle span there
  //     MUST be a `fleetTotal > 1` gate — otherwise the subtitle
  //     would render on single-robot dashboards too.
  const preSubtitle = buttonBlock.slice(0, subtitleIdx)
  assert.ok(/fleetTotal\s*>\s*1/.test(preSubtitle),
    v('E-STOP subtitle must be inside a `fleetTotal > 1` branch. '
      + 'On a single-robot dashboard (fleetTotal === 1) E-STOP '
      + 'renders exactly as it did before the fleet commit — no '
      + 'subtitle, no column-flex layout, no robot name in the '
      + 'title. Operator correction 2026-09-21.'))

  // (3) Grep-pin that the button has a `data-multi-robot` marker
  //     wired to `fleetTotal > 1` — makes the branch state
  //     visible in the DOM for downstream tests without them
  //     re-deriving the gate.
  assert.ok(/data-multi-robot=\{String\(fleetTotal\s*>\s*1\)\}/
              .test(topbarSrc),
    v('E-STOP button must expose data-multi-robot="true|false" '
      + 'reflecting fleetTotal > 1 — the DOM must announce which '
      + 'branch it rendered so tests do not have to re-derive it'))
})

test('E-STOP button title text is bare when fleetTotal === 1', () => {
  // The multi-robot title interpolates the robot name; the single-
  // robot title MUST NOT — that would violate "renders exactly as
  // before the fleet commit". Pin the pre-fleet copy verbatim.
  assert.ok(
    /title=\{[\s\S]*fleetTotal\s*>\s*1[\s\S]*'E-Stop active — click to release \(requires green zone\)'[\s\S]*'Click to trigger emergency stop'/.test(topbarSrc),
    v('E-STOP title must branch on fleetTotal > 1 and include the '
      + 'pre-fleet bare copy ("E-Stop active — click to release …" '
      + '/ "Click to trigger emergency stop") in the single-robot '
      + 'leaf. Any drift here re-scopes the label change to '
      + 'single-robot dashboards, which the operator retired.'))
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
