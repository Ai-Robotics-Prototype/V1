// RunProgramModal — pinned surface for the Run confirm view.
//
// Operator directive (originally issued 2026-09-03; never landed at
// the time; re-issued 2026-09-10 as the "Run confirmation modal
// cleanup" task): the confirm view keeps ONLY what an operator
// confirms — program name, steps taught/total, requested speed,
// effective speed, Cancel, Confirm. Everything else (executor/Lua
// info note, payload row + payload warning, gate/staleness banners,
// mode-switch banners, description prose) is retired.
//
// This test guards the source of RunProgramModal.jsx directly. A
// future modal rebuild can't resurrect the removed strings without
// tripping this file. Same source-level pin pattern as
// PayloadSection.pinned.test.js / PalletFrameDiagram.pinned.test.js
// (repo convention — see NumericField.test.js docblock for why we
// don't wire jsdom + RTL for every UI test).
//
// The "verify headlessly, both editions" step in the directive is
// satisfied structurally: RunProgramModal is a shared component
// (Basic + Full both mount MonitorDashboard, which renders this
// modal), and this file has no edition guard — the same DOM ships
// on both editions. If a future edit adds an edition gate around
// any of these rows, the file's structure would diverge and this
// test would tell us so at the source level.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const source = fs.readFileSync(
  path.resolve(__dirname, 'RunProgramModal.jsx'), 'utf8')

// Isolate the confirm-view JSX block (between `phase === 'confirm' && (`
// and its matching close). This is what an operator SEES; the running /
// ok / error phases are separate branches and stay unchanged.
function _extractConfirmBlock(src) {
  const anchor = src.indexOf("phase === 'confirm' && (")
  assert.ok(anchor >= 0, "must have a phase === 'confirm' branch")
  // Skip past `&& (` to the first paren; then match paren-depth to close.
  const parenOpen = src.indexOf('(', anchor + "phase === 'confirm' &&".length)
  let depth = 0
  for (let i = parenOpen; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(parenOpen, i + 1)
    }
  }
  throw new Error('unbalanced parens in confirm branch')
}
const confirmBlock = _extractConfirmBlock(source)


// ── (1) Executor / Lua info note — REMOVED ────────────────────────

test('confirm view does NOT render the legacy Lua-push executor note', () => {
  assert.equal(/legacy Lua-push/.test(confirmBlock), false,
    "the legacy_lua executor info box is retired — operator directive")
  assert.equal(/F2\.7 cutover pending/.test(confirmBlock), false,
    "the legacy_lua explainer ('F2.7 cutover pending') is retired")
  assert.equal(/RUN_BACKEND=ros2_executor/.test(confirmBlock), false,
    "no run-backend narrative belongs in the operator confirm view")
})

test('confirm view does NOT render the ros2_executor info note', () => {
  assert.equal(/s10_140_executor/.test(confirmBlock), false,
    "the ros2_executor info box is retired — operator directive")
  assert.equal(/Pilz PTP\/LIN/.test(confirmBlock), false,
    "the Pilz PTP/LIN explainer is retired")
  assert.equal(/L222 pre-submit validation/.test(confirmBlock), false,
    "the L222 refuse-composites explainer is retired")
})

test('confirm view does NOT render an "Executor:" label at all', () => {
  // Both executor notes used a bold "Executor:" label. Neither
  // may exist in the confirm view under any run backend.
  assert.equal(/Executor:/.test(confirmBlock), false,
    "no 'Executor:' label anywhere in the confirm view")
})

test('modal no longer fetches /api/provenance for run_backend', () => {
  // The run-backend state was only used to decide which executor
  // info box to render. With both boxes retired the fetch has no
  // consumer and must not resurrect.
  assert.equal(/\/api\/provenance/.test(source), false,
    "no /api/provenance fetch — the only consumer was the retired executor note")
  assert.equal(/run_backend_target_mode/.test(source), false,
    "the run_backend_target_mode read is retired with the executor notes")
  assert.equal(/setRunBackend/.test(source), false,
    "the runBackend state is retired with the executor notes")
})


// ── (2) Payload row + payload warning — REMOVED ───────────────────

test('confirm view does NOT render the "Payload" row', () => {
  assert.equal(/>Payload</.test(confirmBlock), false,
    "the 'Payload' row is retired — Tool & Payload strip in the editor is the only surface")
})

test('confirm view does NOT render the "No payload set" warning', () => {
  assert.equal(/No payload set/.test(confirmBlock), false,
    "the 'No payload set — collision detection accuracy is reduced' warning is retired")
  assert.equal(/PAYLOAD_UNSET_WARNING/.test(confirmBlock), false,
    "the PAYLOAD_UNSET_WARNING constant is not referenced in the confirm view")
  assert.equal(/PAYLOAD_INFO_ONLY/.test(confirmBlock), false,
    "the PAYLOAD_INFO_ONLY 'info only' banner is retired")
  assert.equal(/collision detection accuracy/.test(confirmBlock), false,
    "the collision-accuracy warning copy is retired from the modal")
})

test('modal file does not import the retired payload helpers', () => {
  assert.equal(
    /import\s*\{[^}]*(PAYLOAD_UNSET_WARNING|PAYLOAD_INFO_ONLY|readPayload)[^}]*\}\s*from\s*['"]\.\.\/lib\/payload['"]/.test(source),
    false,
    "no import of readPayload / PAYLOAD_UNSET_WARNING / PAYLOAD_INFO_ONLY " +
    "from ../lib/payload — every consumer is retired")
})


// ── (3) Confirm view surface is exactly the operator-approved set ─

test('confirm view keeps the Program row', () => {
  assert.ok(/>Program</.test(confirmBlock),
    "'Program' row is one of the five kept surfaces")
})

test('confirm view keeps the Steps row (taught/total)', () => {
  assert.ok(/>Steps</.test(confirmBlock),
    "'Steps' row is one of the five kept surfaces")
  assert.ok(/taught \/ \{stepCount\} total/.test(confirmBlock),
    "the Steps row must render 'N taught / M total'")
})

test('confirm view keeps the Requested speed row', () => {
  assert.ok(/>Requested speed</.test(confirmBlock),
    "'Requested speed' row is one of the five kept surfaces")
})

test('confirm view keeps the Effective speed row', () => {
  assert.ok(/>\s*Effective speed\s*</.test(confirmBlock),
    "'Effective speed' row is one of the five kept surfaces")
})

test('confirm view keeps Cancel and Confirm buttons', () => {
  assert.ok(/>Cancel</.test(confirmBlock),
    "Cancel button must remain")
  assert.ok(/Confirm — Run at/.test(confirmBlock),
    "Confirm button label must remain")
})


// ── (4) Ambient banners in the confirm view are RETIRED ───────────

test('confirm view has no "Move gate closed" banner', () => {
  assert.equal(/Move gate closed/.test(confirmBlock), false,
    "the move-gate banner is retired from the confirm view")
})

test('confirm view has no codegen-stale banner', () => {
  assert.equal(/run-confirm-stale-warning/.test(confirmBlock), false,
    "the codegen-stale banner is retired from the confirm view")
  assert.equal(/Code updated on disk/.test(confirmBlock), false,
    "the codegen-stale copy is retired")
})

test('confirm view has no untaught / invalid-id warning boxes', () => {
  assert.equal(/no taught poses/.test(confirmBlock), false,
    "the 'Program has no taught poses' banner is retired (Confirm still disables)")
  assert.equal(/can't round-trip on the controller/.test(confirmBlock), false,
    "the 'id can't round-trip' banner is retired (Confirm still disables)")
})

test('confirm view has no mode-switch banner', () => {
  assert.equal(/willSwitchToAuto/.test(confirmBlock), false,
    "the willSwitchToAuto banner is retired")
  assert.equal(/Switch to \$\{targetModeLabel\}/.test(confirmBlock), false,
    "the mode-switch banner copy is retired")
})

test('confirm view has no narrative "This will overwrite" description', () => {
  assert.equal(/This will overwrite the controller/.test(confirmBlock), false,
    "the narrative preamble is retired — operator confirms rows only")
})


// ── (5) The disable-Confirm gates remain wired (safety) ───────────

test('Confirm remains disabled when there are no taught poses', () => {
  assert.ok(/disabled=\{taughtCount === 0 \|\| !idSafe\}/.test(confirmBlock),
    "the Confirm button must stay disabled on taughtCount===0 || !idSafe " +
    "even after warning banners were removed — otherwise removing the " +
    "banner would let an unsafe run through")
})


// ── (6) Headless render invariance — payload state and edition ────
// "Verify headlessly both editions: modal shows only item-3 contents
// for a normal program and for a no-payload program (no warning
// either way)." — the file has NO payload-conditional branching in
// the confirm block, so a headless render of any program produces
// the same rows. Same for edition: the file has no edition selector,
// so Basic and Full both mount identical JSX.

test('confirm block has no payload-conditional branching', () => {
  assert.equal(/readPayload/.test(confirmBlock), false,
    "no readPayload() call in the confirm view — payload set/unset " +
    "render IDENTICALLY, which is the whole point of the directive")
  assert.equal(/p\.isSet/.test(confirmBlock), false,
    "no payload.isSet branch in the confirm view")
  assert.equal(/payload_kg/.test(confirmBlock), false,
    "no payload_kg field read in the confirm view")
})

test('modal has no edition selector or gate', () => {
  assert.equal(/from ['"]\.\.\/lib\/edition['"]/.test(source), false,
    "RunProgramModal must not import from lib/edition — the confirm " +
    "surface is edition-independent (same DOM in Basic + Full)")
  assert.equal(/useStore\(\(?s\)? => s\.edition\)/.test(source), false,
    "no edition selector — both editions mount identical JSX")
  assert.equal(/isFeatureEnabled/.test(source), false,
    "no feature-flag gate inside the modal")
})
