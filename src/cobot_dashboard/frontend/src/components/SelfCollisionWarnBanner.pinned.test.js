// SelfCollisionWarnBanner + ObstacleEscapeModal — component-level
// pins for the §396 self-collision presentation split (2026-07-31).
//
// The DECISION lives in lib/collisionPresentation and is tested
// there. These tests pin that BOTH components consume the shared
// resolver, and that the toggle / mute / drag-suppression wiring
// is present at the source level (no re-inventing the rule per
// component).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const bannerSrc = fs.readFileSync(
  path.resolve(__dirname, 'SelfCollisionWarnBanner.jsx'), 'utf8')
const modalSrc = fs.readFileSync(
  path.resolve(__dirname, 'ObstacleEscapeModal.jsx'), 'utf8')
const appSrc = fs.readFileSync(
  path.resolve(__dirname, '..', 'App.jsx'), 'utf8')
const safetyPageSrc = fs.readFileSync(
  path.resolve(__dirname, '..', 'pages', 'SafetyPage.jsx'), 'utf8')
const storeSrc = fs.readFileSync(
  path.resolve(__dirname, '..', 'store', 'useStore.js'), 'utf8')


// ── Shared resolver — both components consume it ────────────────

test('banner + modal both import from lib/collisionPresentation', () => {
  assert.ok(
    /import\s*\{[^}]*presentDecision[^}]*\}\s*from\s*['"]\.\.\/lib\/collisionPresentation['"]/.test(bannerSrc),
    'banner must import presentDecision (and helpers) from the shared module')
  assert.ok(
    /import\s*\{[^}]*presentDecision[^}]*\}\s*from\s*['"]\.\.\/lib\/collisionPresentation['"]/.test(modalSrc),
    'modal must import presentDecision from the shared module')
})

test('modal opens only when the resolver says show === "modal"', () => {
  // The old direct comparison (env_min_mm <= env_stop_mm) is
  // fine to KEEP for rendering-time details, but the trigger
  // must consult the resolver.
  assert.ok(/const decision = presentDecision\(/.test(modalSrc),
    'modal must call presentDecision to compute its trigger')
  assert.ok(/const inStop = decision\.show === 'modal'/.test(modalSrc),
    'modal must gate `inStop` on decision.show === "modal" — never '
    + 'a direct distance comparison inline')
})

test('modal ignores mute + toggle (last line of defense)', () => {
  // Any Mute / toggle plumbing in the MODAL trigger would break the
  // "not behind the toggle" invariant. The modal must pass literal
  // `bannerOn: true` + `pairMuted: false` to the resolver.
  assert.ok(/pairMuted:\s*false/.test(modalSrc),
    'modal must pass pairMuted:false so mute never suppresses it')
  assert.ok(/bannerOn:\s*true/.test(modalSrc),
    'modal must pass bannerOn:true so the toggle never suppresses it')
})


// ── Banner wiring ───────────────────────────────────────────────

test('banner is mounted globally in App.jsx', () => {
  assert.ok(/import\s+SelfCollisionWarnBanner\s+from/.test(appSrc),
    'App.jsx must import the banner')
  assert.ok(/<SelfCollisionWarnBanner\s*\/>/.test(appSrc),
    'App.jsx must mount <SelfCollisionWarnBanner />')
})

test('banner testids let tests target it by state', () => {
  for (const id of [
    'self-collision-warn-banner',
    'self-collision-warn-banner-label',
    'self-collision-warn-banner-mute',
  ]) {
    assert.ok(bannerSrc.includes(`data-testid="${id}"`),
      `banner must expose ${id} testid`)
  }
  assert.ok(/data-level=\{decision\.level\}/.test(bannerSrc),
    'banner must publish data-level so tests can distinguish warn / stop')
})

test('banner reads bannerOn + mutedPairs + dragActive from the store', () => {
  for (const sel of [
    'selfCollisionBannerEnabled',
    'mutedCollisionPairs',
    'drag_active',
  ]) {
    assert.ok(bannerSrc.includes(sel),
      `banner must consume the ${sel} slice`)
  }
})

test('banner Mute button calls muteCollisionPair with the canonical key', () => {
  assert.ok(/muteCollisionPair\(muteKey\)/.test(bannerSrc),
    'Mute button must dispatch muteCollisionPair(muteKey) — '
    + 'the key comes from pairMuteKey(pair) so [a,b] and [b,a] '
    + 'share one mute entry')
})


// ── Store slice ─────────────────────────────────────────────────

test('store owns the banner toggle + mute set', () => {
  assert.ok(/selfCollisionBannerEnabled:\s*/.test(storeSrc),
    'store must declare selfCollisionBannerEnabled')
  assert.ok(/mutedCollisionPairs:\s*new Set\(\)/.test(storeSrc),
    'store must declare mutedCollisionPairs as a Set (session-only)')
  assert.ok(/setSelfCollisionBannerEnabled:\s*\(on\)\s*=>/.test(storeSrc),
    'store must expose setSelfCollisionBannerEnabled action')
  assert.ok(/muteCollisionPair:\s*\(key\)\s*=>/.test(storeSrc),
    'store must expose muteCollisionPair action')
  assert.ok(/unmuteCollisionPair:\s*\(key\)\s*=>/.test(storeSrc),
    'store must expose unmuteCollisionPair action')
})

test('banner-toggle preference persists via localStorage', () => {
  assert.ok(/localStorage\.getItem\('selfCollisionBannerEnabled'\)/.test(storeSrc),
    'toggle must hydrate from localStorage on load')
  assert.ok(/localStorage\.setItem\('selfCollisionBannerEnabled'/.test(storeSrc),
    'toggle must persist to localStorage on change')
})

test('banner-toggle DEFAULTS OFF (2026-07-31 operator directive)', () => {
  // The capsule model was blocking legitimate teach jogs. Until
  // the §396 mesh-hull upgrade lands, warnings are off unless
  // someone opts in. The hydration must return `false` when no
  // localStorage value is set (raw === null).
  //
  // Pattern: raw === null ? false : raw === '1'
  //   — null (never set) → false
  //   — '1'              → true  (opted in via toggle)
  //   — '0'              → false (opted out via toggle)
  assert.ok(
    /raw === null \? false : raw === '1'/.test(storeSrc),
    'toggle default MUST be off — the initial hydration must '
    + 'return false when no localStorage value is set. The capsule '
    + 'model over-approximates ~30 mm and was blocking safe jogs; '
    + 'the banner comes back on when the operator opts in.')
})

test('mute set is SESSION-only (not persisted)', () => {
  // "per-pair session mute" per the directive — muted pairs
  // CLEAR on refresh. So the initial value is a fresh Set and
  // NO localStorage hydration for mute.
  assert.equal(
    /localStorage\.(get|set)Item\('mutedCollisionPairs/.test(storeSrc),
    false,
    'mute must NOT persist across refresh — directive: "per-pair session mute"')
})


// ── Safety-page toggle ──────────────────────────────────────────

test('SafetyPage renders the self-collision toggle', () => {
  assert.ok(safetyPageSrc.includes('data-testid="self-collision-warning-toggle"'),
    'SafetyPage must render the toggle with a stable testid')
  assert.ok(/setSelfCollisionBannerEnabled/.test(safetyPageSrc),
    'toggle must wire onChange to setSelfCollisionBannerEnabled')
  // Directive: "banner layer only — the stop-zone block is NOT
  // behind the toggle". Body copy has to say so.
  assert.ok(/stop-zone modal[\s\S]*?not[\s\S]*?affected/i.test(safetyPageSrc),
    'toggle body copy must state the modal is NOT affected by the toggle')
})
