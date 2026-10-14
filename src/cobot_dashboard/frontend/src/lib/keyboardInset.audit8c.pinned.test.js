// Audit #8C pins — tablet payload-step blank-with-keyboard
// (2026-10-14 operator photo: wizard shell visible, mass input near
// top, blank white middle, numeric keyboard at bottom). NOT a crash
// — the step rendered; the on-screen keyboard just covered / pushed
// the content into a dead region.
//
// Three mechanisms were in place pre-fix:
//   (1) kbSafeOverlayStyle paddingBottom on the overlay — only
//       helpful when --kb-inset actually updates.
//   (2) kbSafeModalContentStyle maxHeight = vh - --kb-inset —
//       same dependency.
//   (3) scrollFocusedIntoView via useGlobalKeyboardAutoScroll —
//       fired once on rAF (~16 ms), well before the iOS keyboard
//       animation finishes (~250-300 ms), so the "centre in viewport"
//       happened against the FULL-TALL viewport and the field ended
//       up BEHIND the keyboard after the animation completed.
//
// This file pins the audit #8C fix for all three:
//   - scrollFocusedIntoView now fires THREE times (rAF, 320 ms,
//     next vv.resize one-shot) so by the time the operator sees
//     the field, it's centred in the SHRUNK viewport.
//   - kbSafeModalContentStyle uses min(dvh, vh) so dvh-aware iOS
//     reliably shrinks the modal even if visualViewport.resize
//     never fires (standalone-PWA quirk).
//   - .kb-safe-modal-shell class in styles/tokens.css gives older
//     engines (iOS Safari < 15.4) a vh-only fallback since inline
//     `min(dvh, vh)` is dropped when dvh is unknown.
//   - ProgramWizard modal panel wears the class so the fallback
//     applies when the inline value drops.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FRONT_ROOT = path.resolve(__dirname, '..', '..')
const readSrc = (rel) => fs.readFileSync(path.join(FRONT_ROOT, 'src', rel), 'utf8')
const readStyles = (rel) => fs.readFileSync(path.join(FRONT_ROOT, 'src', 'styles', rel), 'utf8')

const kbSrc    = readSrc('lib/keyboardInset.js')
const wizSrc   = readSrc('components/ProgramWizard.jsx')
const tokens   = readStyles('tokens.css')

// ── scrollFocusedIntoView three-shot schedule ────────────────────

test('scrollFocusedIntoView fires on rAF (shot 1)', () => {
  assert.match(kbSrc, /requestAnimationFrame\(_scroll\)/,
    'first shot must be requestAnimationFrame(_scroll) — covers the '
    + 'fast-keyboard case where the keyboard was already up')
})

test('scrollFocusedIntoView fires again after the keyboard animation (shot 2)', () => {
  // iOS keyboard animation lands around 250-300 ms. The second scroll
  // must sit JUST after that so block:'center' re-runs against the
  // now-shrunk visual viewport.
  assert.match(kbSrc, /setTimeout\(_scroll,\s*320\)/,
    'second shot must be setTimeout(_scroll, 320) — fires after the '
    + 'iOS keyboard animation completes so the field is actually '
    + 'centred in the VISIBLE (post-shrink) viewport, not the pre-'
    + 'keyboard LAYOUT viewport')
})

test('scrollFocusedIntoView re-scrolls on the next visualViewport resize (shot 3)', () => {
  // Belt-and-braces for standalone-PWA iOS where the fixed 320 ms
  // timer sometimes beats the actual resize event. The one-shot
  // listener fires exactly once per focus and detaches itself after
  // 2 s so a focus that never raised the keyboard (hardware keyboard
  // attached) doesn't leave listener debris.
  assert.match(kbSrc,
    /vv\.addEventListener\(['"]resize['"]\s*,\s*once\)/,
    'third shot must register a one-shot resize listener on '
    + 'visualViewport')
  assert.match(kbSrc,
    /vv\.removeEventListener\(['"]resize['"]\s*,\s*once\)/,
    'the listener must detach itself after it fires — a leaky listener '
    + 'would re-scroll on every keyboard open on the page')
  // Safety-net detach so the listener is cleaned up even if the
  // keyboard never comes up (hardware keyboard case).
  assert.match(kbSrc,
    /setTimeout\(\(\)\s*=>\s*\{[^}]*removeEventListener\(['"]resize['"]/,
    'a safety-net setTimeout must detach the listener if no resize '
    + 'ever fires (hardware keyboard / no-op focus)')
})

// ── kbSafeModalContentStyle dvh/vh combo ─────────────────────────

test('kbSafeModalContentStyle picks min(dvh, vh) so dvh wins when supported', () => {
  assert.match(kbSrc, /min\(/,
    'maxHeight must use min() so dvh-aware engines take the dvh '
    + 'branch, non-aware engines drop the whole value and fall '
    + 'through to the .kb-safe-modal-shell class fallback')
  assert.match(kbSrc, /dvh - var\(--kb-inset,\s*0px\)/,
    'dvh branch must subtract the same --kb-inset (combined coverage: '
    + 'dvh handles the keyboard, --kb-inset covers VirtualKeyboard '
    + 'API deliveries that overlaysContent=true suppresses on dvh)')
})

// ── CSS fallback for older engines ───────────────────────────────

test('tokens.css ships .kb-safe-modal-shell with a vh-only max-height fallback', () => {
  assert.match(tokens, /\.kb-safe-modal-shell\s*\{/,
    'the fallback class must exist in the shared stylesheet')
  assert.match(tokens,
    /max-height:\s*calc\(\d+vh\s*-\s*var\(--kb-inset,\s*0px\)\)/,
    'the fallback must emit the pre-dvh vh calc so engines that drop '
    + 'the inline min() still get a shrinking modal via the --kb-inset '
    + 'JS tracking path alone')
})

test('ProgramWizard modal panel wears the .kb-safe-modal-shell class', () => {
  // The class gives the modal a CSS-cascade fallback when the inline
  // `min(dvh, vh)` is rejected by an older engine. Without this class
  // the modal would have NO max-height on those engines and the
  // content could overflow the viewport entirely.
  assert.match(wizSrc, /className="kb-safe-modal-shell"/,
    'ProgramWizard modal panel must wear className="kb-safe-modal-shell"')
  // The class + inline-style both set max-height; the inline value
  // wins when parseable, class wins when the inline value drops.
  // Pin that the inline helper is still called on the SAME element.
  const modalLineIdx = wizSrc.indexOf('className="kb-safe-modal-shell"')
  const sliceAfter   = wizSrc.slice(modalLineIdx, modalLineIdx + 600)
  assert.match(sliceAfter, /kbSafeModalContentStyle\(95\)/,
    'the inline kbSafeModalContentStyle(95) spread must still appear '
    + 'on the SAME modal panel element as the fallback class')
})

// ── Payload step: no auto-focus (keyboard doesn't pop on step entry) ─

test('payload step mass input has NO autoFocus (keyboard only opens on tap)', () => {
  // If the mass input were autoFocus, the keyboard would open the
  // instant the operator reaches the step — before they even see
  // the content. Pin that it is NOT auto-focused so the step is
  // visible first; the operator taps the field when ready and the
  // three-shot scroll takes care of lifting it above the keyboard.
  // We scope the check to the ToolAndPayloadStep function body so an
  // unrelated autoFocus elsewhere (name step uses it legitimately)
  // doesn't false-match.
  const start = wizSrc.indexOf('function ToolAndPayloadStep(')
  assert.ok(start >= 0, 'ToolAndPayloadStep must exist')
  const parenClose = _matchParen(wizSrc, wizSrc.indexOf('(', start))
  const braceOpen  = wizSrc.indexOf('{', parenClose)
  const bodyEnd    = _matchBrace(wizSrc, braceOpen)
  const body = wizSrc.slice(start, bodyEnd + 1)
  assert.equal(/\bautoFocus\b/.test(body), false,
    'ToolAndPayloadStep must NOT auto-focus any input — the step '
    + 'should render first; the operator taps the mass field when '
    + 'they are ready to type.')
})

function _matchParen(src, start) {
  let d = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '(') d++
    else if (src[i] === ')') { d--; if (d === 0) return i }
  }
  throw new Error('unmatched (')
}
function _matchBrace(src, start) {
  let d = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') d++
    else if (src[i] === '}') { d--; if (d === 0) return i }
  }
  throw new Error('unmatched {')
}
