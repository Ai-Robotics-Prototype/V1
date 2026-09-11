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


test('flow(a): RealArmChrome outer never shrinks below its 440 budget', () => {
  const src = readSrc('layouts/View3DLayout.jsx')

  // Locate the RealArmChrome function body — its outer div is the first
  // returned element and carries `height: isExpanded ? '100%' : 440`.
  const chromeStart = src.indexOf('function RealArmChrome(')
  assert.notEqual(chromeStart, -1,
    v('RealArmChrome no longer defined in View3DLayout — this pin is stale'))

  const returnStart = src.indexOf('return (', chromeStart)
  const headerStart = src.indexOf('padding: \'5px 8px\'', returnStart)
  const outerBlock  = src.slice(returnStart, headerStart)

  assert.match(outerBlock, /height:\s*isExpanded\s*\?\s*'100%'\s*:\s*440/,
    v('RealArmChrome outer height budget changed — was 440 NORMAL / 100% EXPANDED'))
  assert.match(outerBlock, /flexShrink:\s*0/,
    v('RealArmChrome outer MUST set flexShrink:0 so a short flex parent '
      + 'cannot squeeze the surface below 440px (the twin viewer must '
      + 'shrink first).'))
})


test('flow(b): jog surface header reserves an explicit minimum height', () => {
  const src = readSrc('layouts/View3DLayout.jsx')

  // The header row lives inside RealArmChrome and uses padding '5px 8px'
  // as a stable landmark. Snip out that div's inline style object.
  const headerAnchor = src.indexOf('padding: \'5px 8px\'')
  assert.notEqual(headerAnchor, -1,
    v('RealArmChrome header row landmark not found'))

  // Grab the surrounding style object braces.
  const styleOpen = src.lastIndexOf('style={{', headerAnchor)
  const styleClose = src.indexOf('}}', headerAnchor)
  const styleBlock = src.slice(styleOpen, styleClose)

  assert.match(styleBlock, /flexShrink:\s*0/,
    v('jog surface header must be flex-shrink:0 to reserve its own space '
      + 'in the RealArmChrome flex column'))
  assert.match(styleBlock, /minHeight:\s*44/,
    v('jog surface header must declare an explicit minHeight (44px) so '
      + 'it never collapses below its control heights on narrow tablets '
      + '— the DISABLE/READY row is the anchor controls below flow from'))
})


test('flow(c): JogControls LEFT column anchors to the top (not center)', () => {
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
  assert.match(leftStyle, /justifyContent:\s*'flex-start'/,
    v('LEFT column MUST use justifyContent:flex-start. justifyContent:center '
      + 'caused the XYZ button top to spill above the row\'s overflow:auto '
      + 'top edge on tablet heights where content > column height — the '
      + 'XYZ button then rendered partly under the DISABLE/READY header band.'))
  assert.doesNotMatch(leftStyle, /justifyContent:\s*'center'/,
    v('LEFT column regressed to justifyContent:center — see fix note'))
})


test('flow(d): no two absolute overlays share the same top-left anchor', () => {
  // The 3D-twin container (`<div style={{ flex: 1, position: 'relative' }}>`
  // in View3DLayout, inside `!isExpanded`) hosts these absolute overlays:
  //   * AT-LIMIT chip  (top:8 right:316) — offset LEFT of JointJogPanel
  //   * MinClearanceReadout (top:44 left:8) — offset BELOW view-switcher
  //   * JointJogPanel  (top:8 right:8) — top-right dock
  //   * RealArmMinimizedPill (bottom:12 right:12) — pill (MINIMIZED only)
  // Plus the corner view-switcher inside ArmViewer3D (top:8 left:8).
  //
  // The invariant this test pins: no two overlays inside the 3D twin
  // container share the same (edge_x, edge_y) pair with both offsets
  // equal to 8 (i.e., "same corner, no offset"). The AT-LIMIT chip and
  // MinClearanceReadout were both anchored top:8, right:8 / left:8 before
  // this fix.

  const layout = readSrc('layouts/View3DLayout.jsx')

  // AT-LIMIT: pinned to top:8 right:316 (offset left of JointJogPanel).
  // Strip line-comments so an explanatory `right:8` in a comment does
  // not shadow the actual style property value.
  const stripComments = (s) => s.replace(/\/\/[^\n]*/g, '')
  const atLimitIdx = layout.indexOf('AT LIMIT')
  assert.notEqual(atLimitIdx, -1, v('AT-LIMIT chip block not found'))
  const atLimitStyleOpen = layout.lastIndexOf('style={{', atLimitIdx)
  const atLimitStyleClose = layout.indexOf('}}', atLimitStyleOpen)
  const atLimitBlock = stripComments(
    layout.slice(atLimitStyleOpen, atLimitStyleClose))
  assert.match(atLimitBlock, /right:\s*316/,
    v('AT-LIMIT chip must be offset right:316 to clear the 300-wide '
      + 'JointJogPanel that occupies the top-right corner'))
  assert.doesNotMatch(atLimitBlock, /right:\s*8\b/,
    v('AT-LIMIT chip regressed to right:8 — collides with JointJogPanel'))

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
      + 'of the JointJogPanel column on the right side'))
})
