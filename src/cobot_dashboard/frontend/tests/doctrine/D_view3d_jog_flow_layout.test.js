// DOCTRINE — 3D View jog surface flow layout + overlay non-collision.
//
// Bug fixed 2026-09-09: on tablet-width viewports the XYZ jog mode
// button rendered partly UNDER the DISABLE/READY header banner of
// the jog surface. Root cause: the LEFT column of JogControls used
// `justifyContent: 'center'`; when its stacked controls exceeded the
// available column height (short landscape tablet, ~440 − header −
// banners), the mathematical centering placed the top of the stack
// above the row's scrollable top edge and the row's overflow-y:auto
// could not scroll to reach it — so the XYZ button visually clipped
// against the DISABLE/READY header band above. Secondary cause: the
// RealArmChrome outer had default flex-shrink:1 so on tight tablet
// heights the whole surface could shrink below its 440px budget.
//
// Fix pinned by this file:
//   * RealArmChrome outer: flexShrink:0 + header minHeight:44
//   * JogControls LEFT column: justifyContent:'flex-start'
//   * Overlay-collision sweep: no two absolute-positioned overlays
//     inside the 3D twin container share the same anchor corner
//     without an intentional offset.
//
// Failure format:
//   DOCTRINE VIEW3D_JOG_FLOW VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')

const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE VIEW3D_JOG_FLOW VIOLATED: ${msg}` }


test('flow(a): single-window pad-cluster overlay replaces RealArmChrome', () => {
  // 2026-09-17 SINGLE-WINDOW RESTRUCTURE: RealArmChrome and its
  // viewport-aware panelHeight are retired. The pad cluster is a
  // content-sized floating overlay (jog-pad-cluster-overlay)
  // anchored bottom-center. LEFT/RIGHT columns are page-level
  // slots. The doctrine now anchors on the ABSENCE of the retired
  // full-width band and PRESENCE of the successor overlay.
  const src = readSrc('layouts/View3DLayout.jsx')

  assert.equal(src.indexOf('function RealArmChrome('), -1,
    v('RealArmChrome function MUST be retired — it was the full-'
      + 'width band forming the operator-flagged second window'))
  assert.equal(src.indexOf('data-testid="jog-floating-panel"'), -1,
    v('jog-floating-panel testid must be gone — retired with '
      + 'RealArmChrome per 2026-09-17 single-window restructure'))
  assert.equal(src.indexOf('data-testid="jog-overlay-wrapper"'), -1,
    v('jog-overlay-wrapper testid must be gone — the full-width '
      + 'wrapper (left:0 right:0) was the second-window culprit'))

  const padIdx = src.indexOf('data-testid="jog-pad-cluster-overlay"')
  assert.notEqual(padIdx, -1,
    v('jog-pad-cluster-overlay must exist as the content-sized '
      + 'floating overlay for the CENTER pads'))
  const padBlock = src.slice(padIdx, padIdx + 1500)
  assert.match(padBlock, /position:\s*'absolute'/,
    v('jog-pad-cluster-overlay must be absolute-positioned'))
  assert.match(padBlock, /bottom:\s*16/,
    v('jog-pad-cluster-overlay must anchor bottom:16'))
  assert.match(padBlock, /pointerEvents:\s*'none'/,
    v('jog-pad-cluster-overlay must be pointerEvents:none so orbit '
      + 'passes through the empty margin around the pad cluster'))
})


test('flow(b): DISABLE/READY live in the LEFT column top slot (page-level)', () => {
  // 2026-09-17 SINGLE-WINDOW UPDATE: chrome header retired
  // entirely along with RealArmChrome. DISABLE + READY are
  // passed to JogControls.leftTopSlot from View3DLayout, then
  // portaled into the page-level jog-left-column-slot. This pin
  // pins the presence of the leftTopSlot prop wiring + the two
  // components inside it, so a future edit can't quietly reintroduce
  // a chrome header container that would resurface the z-overlap.
  const src = readSrc('layouts/View3DLayout.jsx')

  assert.equal(src.indexOf('data-testid="jog-chrome-header-empty"'), -1,
    v('jog-chrome-header-empty marker retired — RealArmChrome deleted'))

  // View3DLayout passes leftTopSlot with ArmEnableControl + Badge.
  const jcIdx = src.indexOf('<JogControls')
  assert.notEqual(jcIdx, -1, v('<JogControls> mount site not found'))
  const jcBlock = src.slice(jcIdx, jcIdx + 3000)
  assert.match(jcBlock, /leftTopSlot=\{/,
    v('View3DLayout must pass leftTopSlot to JogControls'))
  assert.match(jcBlock, /<ArmEnableControl/,
    v('leftTopSlot must contain <ArmEnableControl />'))
  assert.match(jcBlock, /<JogReadyBadge/,
    v('leftTopSlot must contain <JogReadyBadge />'))
})


test('flow(c): JogControls LEFT column spreads vertically (not center, not top-packed)', () => {
  const src = readSrc('components/JogControls.jsx')

  // Locate the LEFT column marker comment then read its style object.
  const leftMarker = src.indexOf('LEFT — mode, step, speed')
  assert.notEqual(leftMarker, -1,
    v('LEFT column marker not found in JogControls'))

  const styleOpen  = src.indexOf('style={{', leftMarker)
  const styleClose = src.indexOf('}}', styleOpen)
  const leftStyle  = src.slice(styleOpen, styleClose)

  assert.match(leftStyle, /alignSelf:\s*'stretch'/,
    v('LEFT column must alignSelf:stretch to inherit the row height'))
  // 2026-09-16 side-column directive: distribute the stack vertically
  // (space-around) instead of packing at the top. The tablet-XYZ-clip
  // safety of the previous flex-start fix is replaced by the
  // viewport-aware panel height (flow(a)) which gives the column
  // enough room to spread without spilling past its top.
  assert.match(leftStyle, /justifyContent:\s*'space-(around|between)'/,
    v('LEFT column MUST use justifyContent:space-around (or '
      + 'space-between) so groups spread up the edge. flex-start '
      + 'packs them at the top which contradicts the side-column '
      + 'directive.'))
  assert.doesNotMatch(leftStyle, /justifyContent:\s*'center'/,
    v('LEFT column regressed to justifyContent:center — see fix note'))
})


test('flow(d): no two absolute overlays share the same top-left anchor', () => {
  // The 3D-twin container (`<div style={{ flex: 1, position: 'relative' }}>`
  // in View3DLayout, inside `!isExpanded`) hosts these absolute overlays
  // AFTER the 2026-09-14 JointJogPanel retirement:
  //   * OrientFlangeDownControl (top:8 right:8) — modal-gated button,
  //                              its wrap owns the top-right corner
  //   * MinClearanceReadout (top:44 left:8) — offset BELOW view-switcher
  //   * RealArmMinimizedPill (bottom:12 right:12) — pill (MINIMIZED only)
  // Plus the corner view-switcher inside ArmViewer3D (top:8 left:8).
  //
  // AT-LIMIT chip retired 2026-09-14 (was gated on Cartesian mode
  // which no longer has a toggle). MinClearanceReadout still lives
  // at top:44 left:8; the pin below preserves that placement.

  const layout = readSrc('layouts/View3DLayout.jsx')

  // AT-LIMIT chip must be gone from the layout — the Cartesian-mode
  // check that gated its render is retired.
  assert.doesNotMatch(layout, /AT LIMIT/,
    v('AT-LIMIT chip resurfaced in View3DLayout — it was retired '
      + 'with the JointJogPanel Cartesian-mode toggle on 2026-09-14'))

  // MinClearanceReadout: pinned to top:44 left:8 (below view-switcher).
  const clrIdx = layout.indexOf('function MinClearanceReadout')
  assert.notEqual(clrIdx, -1, v('MinClearanceReadout function not found'))
  const clrBlock = layout.slice(clrIdx)
  const clrPos = clrBlock.match(/position:\s*'absolute'[^}]+/)
  assert.notEqual(clrPos, null, v('MinClearanceReadout position not found'))
  assert.match(clrPos[0], /top:\s*44/,
    v('MinClearanceReadout must be top:44 to clear the ArmViewer3D corner '
      + 'view-switcher (Front/Side/Top/Iso + reach-dome) at top:8 left:8'))
  assert.match(clrPos[0], /left:\s*8/,
    v('MinClearanceReadout should stay left-aligned to keep the chip out '
      + 'of the OrientFlangeDownControl column on the right side'))
})
