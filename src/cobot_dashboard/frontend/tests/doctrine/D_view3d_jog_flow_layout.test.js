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


test('flow(a): RealArmChrome outer honors a viewport-aware height with a 440 floor', () => {
  const src = readSrc('layouts/View3DLayout.jsx')

  // Locate the RealArmChrome function body — its outer div is the first
  // returned element. 2026-09-16 side-column directive: NORMAL height is
  // now viewport-aware (`panelHeight || 440`) so the LEFT/RIGHT columns
  // can spread up the edges; the 440 floor stays for short-tablet
  // safety (tablet-XYZ-clip class), served by the fallback and the
  // Program-tab consumer that passes no panelHeight.
  const chromeStart = src.indexOf('function RealArmChrome(')
  assert.notEqual(chromeStart, -1,
    v('RealArmChrome no longer defined in View3DLayout — this pin is stale'))

  const returnStart = src.indexOf('return (', chromeStart)
  const headerStart = src.indexOf('padding: \'5px 8px\'', returnStart)
  const outerBlock  = src.slice(returnStart, headerStart)

  // NORMAL: either panelHeight (viewport-aware) with a 440 fallback,
  // or the legacy plain 440 for consumers that don't pass panelHeight.
  assert.match(outerBlock,
    /height:\s*isExpanded\s*\?\s*'100%'\s*:\s*\(panelHeight\s*\|\|\s*440\)/,
    v('RealArmChrome outer height must be `isExpanded ? "100%" '
      + ': (panelHeight || 440)` — the viewport-aware NORMAL '
      + 'height + 440 floor let the side-column layout spread '
      + 'while keeping short-tablet safety.'))
  assert.match(outerBlock, /flexShrink:\s*0/,
    v('RealArmChrome outer MUST set flexShrink:0 so a short flex parent '
      + 'cannot squeeze the surface below its budget (the twin viewer must '
      + 'shrink first).'))
})


test('flow(b): chrome header collapses to 0 — DISABLE/READY moved to LEFT top slot', () => {
  // 2026-09-16 LEFT-column-cleanup operator order: DISABLE + READY
  // moved OUT of the RealArmChrome header INTO the LEFT column top
  // slot (JogControls.leftTopSlot). The chrome header now has no
  // content and collapses to 0. The 44 px minHeight anchor from
  // the previous version of this pin is superseded — the DISABLE
  // row is now anchored by the LEFT column's `minHeight: 44` top
  // wrapper instead. This pin ensures the header doesn't quietly
  // regain child controls in a future edit (which would re-create
  // the z-overlap that motivated this cleanup).
  const src = readSrc('layouts/View3DLayout.jsx')

  assert.match(src, /data-testid="jog-chrome-header-empty"/,
    v('chrome header must render an empty div with the '
      + 'jog-chrome-header-empty testid — the marker for the '
      + 'DISABLE-moved-out-of-header contract'))
  // Header block must NOT reference ArmEnableControl or JogReadyBadge
  // any more (they now live inside JogControls.leftTopSlot).
  const emptyIdx = src.indexOf('data-testid="jog-chrome-header-empty"')
  const before = src.slice(Math.max(0, emptyIdx - 800), emptyIdx)
  assert.doesNotMatch(before, /<ArmEnableControl\s*\/>/,
    v('ArmEnableControl must not render inside the chrome header any '
      + 'more — it moved to JogControls.leftTopSlot'))
  assert.doesNotMatch(before, /<JogReadyBadge\s*\/>/,
    v('JogReadyBadge must not render inside the chrome header any '
      + 'more — it moved to JogControls.leftTopSlot'))
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
