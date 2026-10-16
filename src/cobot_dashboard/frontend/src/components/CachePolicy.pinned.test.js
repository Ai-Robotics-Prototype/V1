// Cache-policy / update-flow pins — 2026-10-14 operator audit #8B
// (tablet keeps serving stale bundles after a deploy).
//
// The repo has NEVER registered a service worker (git history
// confirms, this test will fail if that changes without explicit
// review). The stale-serve symptom traces to a mix of:
//   (a) /assets/* served with NO Cache-Control, so iOS Safari used
//       its implicit heuristic — unpredictable per-tablet.
//   (b) No visible way for the operator to confirm which bundle
//       actually loaded vs what the server claims to serve.
//   (c) The WS hello frame is the ONLY stale-provenance signal; if
//       the WS never connects on a given tab the client sits on an
//       old bundle forever.
//   (d) If any upstream (browser extension, prior short-lived
//       deploy, Vite PWA plugin) ever registered a SW on this
//       origin, it would persist across deploys with no code path
//       to clean it up — classic beta-blocker on fleet devices.
//
// Each pin below locks the fix in place. Source-level checks only
// (matches the pattern used elsewhere in the suite; no React render
// runner is wired up in this repo).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FRONT_ROOT = path.resolve(__dirname, '..', '..')
const REPO_ROOT  = path.resolve(FRONT_ROOT, '..', '..', '..')

const mainSrc    = fs.readFileSync(path.join(FRONT_ROOT, 'src', 'main.jsx'), 'utf8')
const statusSrc  = fs.readFileSync(path.join(FRONT_ROOT, 'src', 'components', 'StatusBar.jsx'), 'utf8')
const bannerSrc  = fs.readFileSync(path.join(FRONT_ROOT, 'src', 'components', 'DeployStatusBanner.jsx'), 'utf8')
const backendSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'cobot_dashboard', 'cobot_dashboard', 'dashboard_server.py'), 'utf8')
const indexHtml  = fs.readFileSync(path.join(FRONT_ROOT, 'index.html'), 'utf8')

// ── (a) /assets/* served immutable (hashed, safe for forever cache) ──

test('backend mounts /assets with immutable Cache-Control', () => {
  // The subclass sets Cache-Control:public,max-age=31536000,immutable
  // on 200/304 responses. Three independent regexes keep the pin
  // honest against a reformat:
  assert.match(backendSrc, /class\s+_ImmutableAssets\s*\(\s*StaticFiles\s*\)/,
    'ImmutableAssets subclass must exist so headers are injectable')
  assert.match(backendSrc,
    /Cache-Control["']\]?\s*=\s*\\?\s*["']public,\s*max-age=31536000,\s*immutable["']/,
    'immutable Cache-Control must be set verbatim')
  assert.match(backendSrc, /app\.mount\(\s*["']\/assets["']\s*,\s*_ImmutableAssets\s*\(/,
    '/assets mount must use _ImmutableAssets, not raw StaticFiles')
})

test('backend serves manifest.json with no-cache (installed-PWA update path)', () => {
  // iOS "Add to Home Screen" caches the manifest on the install side;
  // if we change start_url / scope / icons later, the install must
  // see the new manifest on next launch. no-cache keeps that path open.
  const re = /@app\.get\(["']\/manifest\.json["']\)[\s\S]{0,600}?FileResponse\([^)]*headers=_NO_CACHE/
  assert.match(backendSrc, re,
    'manifest.json FileResponse must pass headers=_NO_CACHE')
})

// ── (b) In-app version visibility ──────────────────────────────────

test('StatusBar renders a VersionChip (operator-visible bundle + git SHA)', () => {
  assert.match(statusSrc, /function\s+VersionChip\s*\(/,
    'VersionChip component must be defined')
  assert.match(statusSrc, /<VersionChip\s*\/>/,
    'StatusBar must mount <VersionChip />')
  assert.match(statusSrc, /data-testid="footer-version-chip"/,
    'chip must expose a stable test id')
  assert.match(statusSrc, /__GIT_SHA__/,
    'chip must display the baked git SHA')
  assert.match(statusSrc, /getServedBundleHash\(/,
    'chip must display the actually-loaded bundle hash (DOM-read, not baked)')
})

test('VersionChip offers a tap-to-hard-reload fallback', () => {
  // A tablet with no devtools can still force a refresh by tapping
  // the chip. The reload must cache-bust via a query string so an
  // intermediate proxy / iOS Safari HTML cache can't serve stale.
  assert.match(statusSrc,
    /searchParams\.set\(['"]_r['"]/,
    'reload must append a _r= cache-bust query param')
})

// ── (c) Fallback stale-detection polling ────────────────────────────

test('DeployStatusBanner trips staleProvenance when SHAs drift', () => {
  // WS hello is the primary signal; the banner polls /api/deploy_status
  // every 3s and mirrors the same compare against __GIT_SHA__ so a
  // tab without a WS still gets the StaleGuard overlay.
  assert.match(bannerSrc, /_setStaleProvenance/,
    'banner must take the store setter')
  assert.match(bannerSrc, /__GIT_SHA__/,
    'banner must compare against the baked bundle SHA')
  assert.match(bannerSrc, /layer:\s*['"]frontend['"]/,
    "latched record must mark layer: 'frontend'")
  // Guard against re-latching: never overwrite an existing (possibly
  // backend-layer) stale record.
  assert.match(bannerSrc, /!existingStale/,
    'skip when a stale record is already latched (no overwrite)')
})

// ── (d) Service-worker killswitch ───────────────────────────────────

test('main.jsx actively unregisters any legacy service worker', () => {
  assert.match(mainSrc, /navigator\.serviceWorker\.getRegistrations\(\)/,
    'must enumerate SW registrations on boot')
  assert.match(mainSrc, /\.unregister\(\)/,
    'must call unregister() on each registration')
  assert.match(mainSrc, /caches\.keys\(\)/,
    'must drop SW cache buckets so no cached response survives unregister')
  assert.match(mainSrc, /_swkill/,
    'post-unregister reload must cache-bust via _swkill query param')
})

test('no service worker is registered anywhere in src/ or public/', () => {
  // Belt-and-braces: if someone later adds a SW registration without
  // thinking through the update-flow contract, this pin fires.
  function walk(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue
        walk(p, out)
      } else if (/\.(js|jsx|ts|tsx|html|json)$/.test(name)) {
        out.push(p)
      }
    }
    return out
  }
  const files = [
    ...walk(path.join(FRONT_ROOT, 'src')),
    ...walk(path.join(FRONT_ROOT, 'public')),
    path.join(FRONT_ROOT, 'index.html'),
  ]
  // Build the forbidden-call regex at runtime so this test file itself
  // doesn't contain the literal string the regex would match.
  const forbidden = new RegExp(
    'navigator' + '\\.' + 'serviceWorker' + '\\.' + 'register' + '\\b', 'g')
  for (const f of files) {
    // Skip this test file — the regex above would match our own
    // documentation of what's forbidden.
    if (f === path.resolve(__dirname, 'CachePolicy.pinned.test.js')) continue
    const body = fs.readFileSync(f, 'utf8')
    const hits = body.match(forbidden) || []
    assert.equal(hits.length, 0,
      `${path.relative(REPO_ROOT, f)} must not register a service worker — `
      + 'if a SW is truly needed, update the CachePolicy contract first '
      + '(update strategy + cache keying + API bypass).')
  }
})

// ── (e) Shell cache contract: index.html stays no-cache ─────────────

test('backend still serves index.html with no-cache (unchanged contract)', () => {
  const re = /@app\.get\(["']\/["']\)[\s\S]{0,500}?FileResponse\([^)]*headers=_NO_CACHE/
  assert.match(backendSrc, re,
    'index.html FileResponse must still pass headers=_NO_CACHE — the '
    + 'hashed asset URLs inside the shell are how the browser picks '
    + 'up new bundles, so a cached shell pins the old hash forever.')
})

test('index.html global error overlay still present (prior audit)', () => {
  assert.match(indexHtml, /id="global-error-overlay"/,
    'global error overlay from prior audit must still be live')
})