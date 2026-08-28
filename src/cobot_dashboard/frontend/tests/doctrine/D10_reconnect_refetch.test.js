// DOCTRINE D10 — extension: cross-client sync (2026-07-31 §16).
//
// Operator-hit bug: tablet showed a step as taught, PC didn't. Root
// cause: /ws/state dropped on the PC, event ring fanned out during
// the outage, PC reconnected without refetching, held the pre-drop
// rev, rendered a confident T on stale data. D10's "never assert
// state you can't read" applies — the client can't read fresh state
// while the WS is down, so it must not render a green ✓.
//
// Failure format:
//   DOCTRINE D10 VIOLATED: <detail>
//
// Coverage:
//  (a) store initializes programRevConfirmed=false + _hasConnectedOnce=false
//  (b) onclose flips programRevConfirmed=false (WS drop → distrust)
//  (c) onopen on RECONNECT refetches currentProgram (the fix)
//  (d) _refreshCurrentProgram flips programRevConfirmed=true on success
//  (e) setCurrentProgram flips programRevConfirmed=true when a rev
//      arrives with the WS up (fresh server payload)
//  (f) row taught-badge renders the 'syncing' state when
//      programRevConfirmed=false (source-level check)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d10(msg) { return `DOCTRINE D10 VIOLATED: ${msg}` }


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..')
const storeSrc = fs.readFileSync(
  path.join(FRONTEND_ROOT, 'src', 'store', 'useStore.js'), 'utf8')
const editorSrc = fs.readFileSync(
  path.join(FRONTEND_ROOT, 'src', 'components', 'ProgramEditor.jsx'),
  'utf8')


test('D10(a): store initializes programRevConfirmed=false', () => {
  // Default false means the badge shows "syncing" until we
  // actually confirm the rev. Safer default than true.
  assert.ok(/programRevConfirmed:\s*false/.test(storeSrc),
    d10('programRevConfirmed must default to false in the store — '
     + 'anything else would render a confident T on unconfirmed data '
     + 'during the initial-load window'))
  assert.ok(/_hasConnectedOnce:\s*false/.test(storeSrc),
    d10('_hasConnectedOnce marker must default to false so onopen '
     + 'can distinguish "first connect" from "reconnect"'))
})


test('D10(b): WS onclose flips programRevConfirmed=false', () => {
  // The critical invariant: any WS drop invalidates trust. If we
  // don't flip this false, a subsequent mutation on another client
  // during the outage is lost silently.
  const closeBlock = storeSrc.match(
    /ws\.onclose\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,500}?\}/)
  assert.ok(closeBlock, 'ws.onclose handler must be locatable')
  assert.ok(/programRevConfirmed:\s*false/.test(closeBlock[0]),
    d10('ws.onclose MUST set programRevConfirmed:false — this is the '
     + 'cross-client sync invariant. Without it, the tablet-vs-PC '
     + 'stale-badge class of bug can silently reappear.'))
})


test('D10(c): WS onopen reconciles on RECONNECT (not first connect)', () => {
  // 2026-07-31 §16 upgrade: onopen now calls _reconcileAll on
  // reconnect (which fetches the full {id: rev} map + the open
  // program's state), not just _refreshCurrentProgram for the
  // open program. The full-list check catches missed events on
  // programs the operator switches TO after the outage.
  // Anchor from `ws.onopen = () => {` to the next `ws.onerror`
  // marker so the whole handler is captured regardless of length.
  const openStart = storeSrc.indexOf('ws.onopen = () => {')
  const openEnd   = storeSrc.indexOf('ws.onerror', openStart)
  assert.ok(openStart >= 0 && openEnd > openStart,
    'ws.onopen handler must be locatable')
  const openBlock = storeSrc.slice(openStart, openEnd)
  assert.ok(/wasReconnect\s*=\s*get\(\)\._hasConnectedOnce/.test(openBlock),
    d10('onopen must snapshot _hasConnectedOnce so it can distinguish '
     + 'first-connect from reconnect'))
  assert.ok(/_hasConnectedOnce:\s*true/.test(openBlock),
    d10('onopen must set _hasConnectedOnce:true so the NEXT onopen '
     + 'sees this as a reconnect'))
  assert.ok(/if \(wasReconnect\)[\s\S]{0,300}?_reconcileAll\(/.test(openBlock),
    d10('onopen must call _reconcileAll() on the reconnect path — '
     + 'per-open-program refetch alone misses events on other programs'))
})


test('D10(d): _refreshCurrentProgram flips programRevConfirmed=true on success', () => {
  // The confirmation moment: fresh fetch landed AND ws is up. Only
  // then can taught-badges show a confident T again.
  const fnBlock = storeSrc.match(
    /async _refreshCurrentProgram[\s\S]{0,2500}?\n  \},/)
  assert.ok(fnBlock, '_refreshCurrentProgram must be locatable')
  assert.ok(/wsStatus\s*===\s*['"]connected['"][\s\S]{0,80}?programRevConfirmed:\s*true/
    .test(fnBlock[0]),
    d10('_refreshCurrentProgram must gate programRevConfirmed=true on '
     + 'wsStatus === "connected". Setting it true while the WS is down '
     + 'would re-open the stale-badge window.'))
})


test('D10(e): setCurrentProgram flips confirmed=true on fresh server payloads', () => {
  // Initial page load path: user loads a program → setCurrentProgram
  // called with the full payload (including rev). That's fresh, so
  // confirm — but only when WS is up.
  assert.ok(
    /if \(patch && patch\.rev != null && get\(\)\.wsStatus === ['"]connected['"]\)\s*\{[\s\S]{0,80}?programRevConfirmed:\s*true/
      .test(storeSrc),
    d10('setCurrentProgram must confirm rev when the patch carries '
     + 'a fresh rev AND the WS is up — that\'s the initial-load path\'s '
     + 'confirmation moment'))
})


test('D10(f): row taught-badge renders "syncing" when confirmed=false', () => {
  // Source-level check on the badge render. The badge state must
  // fall back to 'syncing' when programRevConfirmed is false — the
  // T/! decision is DERIVED from the rev-confirmed flag.
  assert.ok(/programRevConfirmed\s*=\s*useStore/.test(editorSrc),
    d10('ProgramEditor must subscribe to programRevConfirmed from the store'))
  assert.ok(/programRevConfirmed\s*\?\s*derived\s*:\s*['"]syncing['"]/.test(editorSrc),
    d10('pallet-row badge state must be `programRevConfirmed ? derived : "syncing"` — '
     + 'never render a confident T on unconfirmed data'))
  assert.ok(/!programRevConfirmed\s*\?\s*['"]syncing['"]/.test(editorSrc),
    d10('standard step-row badge must render "syncing" when '
     + 'programRevConfirmed is false. This is the D10 promise in JSX form.'))
})


test('D10(f): "syncing" badge has honest copy — never asserts a read', () => {
  // Directive: the copy must NAME the limitation, not invent an
  // assertion. Check the title attribute the badge sets when
  // rendering the syncing state.
  assert.ok(/state syncing…/.test(editorSrc),
    d10('syncing badge title must include the literal "state syncing…" '
     + 'phrase — copy that names the limitation, not one that pretends '
     + 'to know the taught-state'))
  assert.ok(/Never render green on unconfirmed data/i.test(editorSrc),
    d10('the syncing badge tooltip must explain WHY it\'s "…" — the '
     + 'operator sees the reason without having to guess'))
})


// ── 2026-07-31 §16 CONVERGENCE extension ────────────────────────
// Operator-hit twice today. New invariants pinned below:
//   (g) _reconcileAll() exists + is called from onopen (reconnect)
//   (h) visibilitychange + pageshow listeners installed
//   (i) rev-gap in a state frame triggers refetch
//   (j) reconcile log ring exists + records key transitions
//   (k) deploy-aware bundle-id check exists + toasts on mismatch
//   (l) backend seeds _prog_revs from disk at startup + persists

const backendSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', '..',
    'src', 'cobot_dashboard', 'cobot_dashboard', 'dashboard_server.py'),
  'utf8')


test('D10(g): _reconcileAll is defined + called from WS onopen on reconnect', () => {
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'store', 'useStore.js'),
    'utf8')
  assert.ok(/async _reconcileAll\(/.test(storeSrc),
    d10('_reconcileAll must be defined as an async function — the '
     + 'reconcile path is the convergence guarantee'))
  const openBlock = storeSrc.match(/ws\.onopen\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,1500}?\n    \}/)
  assert.ok(openBlock, 'ws.onopen locatable')
  assert.ok(/wasReconnect[\s\S]{0,200}?_reconcileAll\(/.test(openBlock[0]),
    d10('onopen must call _reconcileAll() on the reconnect branch — '
     + 'no more just-refetch-open-program half-measure. The full list '
     + 'of revs must be checked so a program the operator switches to '
     + 'later reconciles too.'))
})


test('D10(h): visibilitychange + pageshow listeners registered', () => {
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'store', 'useStore.js'),
    'utf8')
  assert.ok(/_installVisibilityHooks\(\)/.test(storeSrc),
    d10('connectWS must call _installVisibilityHooks — mobile Chrome '
     + 'suspend/resume is the primary way the tablet ends up on stale '
     + 'state without an onclose event to trigger the reconcile'))
  assert.ok(/document\.addEventListener\(['"]visibilitychange['"]/.test(storeSrc),
    d10('visibilitychange listener must be installed'))
  assert.ok(/window\.addEventListener\(['"]pageshow['"]/.test(storeSrc),
    d10('pageshow listener must be installed — bfcache restore is a '
     + 'silent resume path distinct from visibilitychange'))
  // The visibility handler must ACTUALLY call _reconcileAll — not
  // just log the event. Anchor from the addEventListener call to
  // the pageshow registration below it so the full handler is
  // captured.
  const visStart = storeSrc.indexOf(
    "document.addEventListener('visibilitychange'")
  const visEnd   = storeSrc.indexOf(
    "window.addEventListener('pageshow'", visStart)
  assert.ok(visStart >= 0 && visEnd > visStart,
    'visibilitychange listener block locatable')
  const visBlock = storeSrc.slice(visStart, visEnd)
  assert.ok(/_reconcileAll\(/.test(visBlock),
    d10('visibilitychange handler must invoke _reconcileAll — logging '
     + 'the event alone doesn\'t heal stale state'))
})


test('D10(i): rev-gap in a state frame triggers refetch', () => {
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'store', 'useStore.js'),
    'utf8')
  // Look for the rev-gap watcher in the state-frame onmessage
  // handler. It reads msg.program_revs and refetches when the
  // server's rev exceeds the held rev.
  assert.ok(/msg\.program_revs/.test(storeSrc),
    d10('state-frame handler must read msg.program_revs — the '
     + 'per-frame convergence signal'))
  assert.ok(/serverRev\s*>\s*heldRev/.test(storeSrc),
    d10('handler must compare serverRev > heldRev and refetch on gap'))
  assert.ok(/_refreshCurrentProgram\(\)/.test(storeSrc),
    d10('gap-detection must call _refreshCurrentProgram to heal'))
})


test('D10(j): reconcile log ring records key transitions', () => {
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'store', 'useStore.js'),
    'utf8')
  assert.ok(/_reconcileLog:\s*\[\]/.test(storeSrc),
    d10('store must expose _reconcileLog as a session-only array'))
  assert.ok(/_pushReconcileLog\(['"]ws_open['"]/.test(storeSrc)
         && /_pushReconcileLog\(['"]ws_close['"]/.test(storeSrc)
         && /_pushReconcileLog\(['"]reconcile_start['"]/.test(storeSrc)
         && /_pushReconcileLog\(['"]reconcile_done['"]/.test(storeSrc)
         && /_pushReconcileLog\(['"]visibility_visible['"]/.test(storeSrc)
         && /_pushReconcileLog\(['"]rev_gap_in_frame['"]/.test(storeSrc),
    d10('reconcile log must record ws_open, ws_close, reconcile_start, '
     + 'reconcile_done, visibility_visible, rev_gap_in_frame — the '
     + 'operator will ask "what happened on the tablet at 14:22?" and '
     + 'the log is the only answer'))
})


test('D10(k): deploy-aware stale-tab detection exists + BLOCKS on mismatch', () => {
  // 2026-08-28 doctrine amendment (ledger addendum-48): the
  // ORIGINAL D10(k) required _checkBundleId — a poll of
  // /api/build_id.bundle_id (chunk hash) compared to __BUILD_ID__
  // (git-describe SHA). Two DIFFERENT SHAPES — the strings could
  // never equal each other, so the "New app version available"
  // toast fired for every deploy where both fields were non-empty,
  // AND the operator learned to click through it, defeating the
  // whole point of the doctrine.
  //
  // The invariant D10(k) is meant to enforce ("a tab left open
  // through a deploy must LEARN about it and BLOCK, not silently
  // stay on the old bundle") is now enforced by the provenance
  // stack — StaleGuard + WS hello frame + SHA-to-SHA compare, all
  // like-for-like (L257). This test now pins the newer mechanism.
  const storeSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'store', 'useStore.js'),
    'utf8')
  const guardSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'components',
                 'StaleGuard.jsx'),
    'utf8')

  // 1. Store WS onmessage must intercept the {type:'hello'} frame
  //    (SHA-to-SHA compare feed).
  assert.ok(/msg\.type\s*===\s*['"]hello['"]/.test(storeSrc),
    d10('WS onmessage must intercept the {type:"hello"} frame from '
     + '/ws/state so backend + frontend SHAs reach the client'))

  // 2. Client-side compare must use the compile-time __GIT_SHA__
  //    baked by vite — anything else is not like-for-like.
  assert.ok(/__GIT_SHA__/.test(storeSrc),
    d10('client-side stale check must compare against __GIT_SHA__ '
     + '(vite define, baked at build time) — chunk-hash vs git-SHA '
     + 'is what previously misfired'))

  // 3. Mismatch flips staleProvenance to the mismatch record —
  //    the store hook StaleGuard subscribes to.
  assert.ok(/staleProvenance/.test(storeSrc),
    d10('mismatch must populate staleProvenance so StaleGuard can '
     + 'react — a hidden bundle version is the class the retired '
     + 'toast failed to catch six times'))

  // 4. StaleGuard renders a BLOCKING overlay (aria-modal,
  //    pointerEvents auto, no close/dismiss control by default).
  //    Dismissible-toast pattern is what taught operators to click
  //    through the warning.
  assert.ok(/aria-modal="true"|aria-modal='true'/.test(guardSrc),
    d10('StaleGuard must render an aria-modal overlay — silent toast '
     + 'was ignored by operators'))
  assert.ok(/pointerEvents:\s*['"]auto['"]/.test(guardSrc),
    d10('StaleGuard must intercept clicks (pointerEvents: auto) — the '
     + 'overlay is the block, not a hint'))
  assert.ok(/Reload now/.test(guardSrc),
    d10('StaleGuard must expose a Reload button — the only path '
     + 'forward is a fresh load'))
})


test('D10(l): backend seeds _prog_revs from disk at startup', () => {
  assert.ok(/_seed_prog_revs_from_disk/.test(backendSrc),
    d10('_seed_prog_revs_from_disk must be defined — restart resetting '
     + '_prog_revs to empty is exactly how tablet-vs-PC diverged today'))
  // Called from the FastAPI lifespan startup hook. Match with a
  // wider window since lifespan does other startup work first.
  const lifespan = backendSrc.match(
    /async def lifespan\(app: FastAPI\)[\s\S]{0,4000}?_seed_prog_revs_from_disk\(\)/)
  assert.ok(lifespan,
    d10('lifespan startup must invoke _seed_prog_revs_from_disk() BEFORE '
     + 'the broadcast loop starts — clients must never see a lower '
     + 'post-restart rev than they held pre-restart'))
})


test('D10(l): backend broadcasts program_revs in every state frame', () => {
  assert.ok(/payload\["program_revs"\]/.test(backendSrc),
    d10('state broadcast must include payload["program_revs"] — the '
     + 'per-frame convergence signal the client rev-gap-checks against'))
  assert.ok(/def _snapshot_prog_revs/.test(backendSrc),
    d10('_snapshot_prog_revs helper must exist for cheap lock-held '
     + 'copies during the broadcast tick'))
})


test('D10(l): /api/programs/revs endpoint exists (cheap reconcile query)', () => {
  assert.ok(/\/api\/programs\/revs/.test(backendSrc),
    d10('GET /api/programs/revs must exist — the client\'s _reconcileAll '
     + 'hits this on WS reconnect + visibility resume to fetch the '
     + '{id: rev} map without waiting for the next state broadcast'))
})


test('D10(l): GET /api/programs/{id} normalises rev — never returns None', () => {
  // The bug that hit twice today: a program on disk with rev=None
  // was serving None to clients. Client compared ev.rev>cp.rev with
  // one side null, JavaScript coerced silently, refetch never fired.
  // Every read path must return a numeric rev.
  const getBlock = backendSrc.match(
    /async def api_programs_get\(prog_id: str\)[\s\S]{0,2000}?return prog/)
  assert.ok(getBlock, 'api_programs_get must be locatable')
  assert.ok(/prog\["rev"\]\s*=\s*int\(authoritative\)/.test(getBlock[0]),
    d10('GET /api/programs/{id} must set prog["rev"] to an int derived '
     + 'from _prog_revs (or 0), never None. The client\'s > compare '
     + 'requires a numeric.'))
})
