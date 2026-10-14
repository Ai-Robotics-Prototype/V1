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
  // 2026-10-14 audit #8D: shot 1 is the FAST path (keyboard already
  // up, field-to-field tabbing). Still uses scrollIntoView via the
  // _naiveScroll helper. Shots 2 + 3 do the real work (manual centre).
  assert.match(kbSrc, /requestAnimationFrame\(_naiveScroll\)/,
    'first shot must be requestAnimationFrame(_naiveScroll)')
})

test('scrollFocusedIntoView does a MANUAL centre at shot 2 (post-keyboard-animation)', () => {
  // The naive scrollIntoView({block:'center'}) landed the field at
  // the top edge on iPad Safari (operator photo on C1_kSxD9 — field
  // visible but pinned high) because the browser's "centre" didn't
  // subtract the keyboard. Shot 2 now computes the exact scroll
  // delta from visualViewport.height / offsetTop and places the
  // field in the middle of the band ABOVE the keyboard.
  assert.match(kbSrc, /setTimeout\(_manualCentre,\s*350\)/,
    'second shot must be setTimeout(_manualCentre, 350) — fires after '
    + 'the iOS keyboard animation completes so the manual compute '
    + 'runs against the shrunk visual viewport')
  // The manual centre MUST read visualViewport.height and offsetTop
  // (not just rely on scrollIntoView's hint).
  assert.match(kbSrc, /vv\s*\?\s*vv\.height/,
    'manual centre must read vv.height to subtract the keyboard')
  assert.match(kbSrc, /vv\s*\?\s*\(vv\.offsetTop/,
    'manual centre must read vv.offsetTop to account for a shifted '
    + 'visual viewport (iOS pinch-zoom + keyboard)')
})

test('manual centre computes the visible band and targets the middle of it', () => {
  // Visible band = intersection of scroll container and visual
  // viewport. Must appear in the compute, otherwise the "centre" is
  // the container centre (= Safari\'s old wrong answer).
  assert.match(kbSrc, /const\s+visibleTop\s*=\s*Math\.max\(cRect\.top,\s*vvTop\)/,
    'visibleTop must clip the container to the visual viewport top')
  assert.match(kbSrc,
    /const\s+visibleBottom\s*=\s*Math\.min\(cRect\.bottom,\s*vvTop\s*\+\s*vvHeight\)/,
    'visibleBottom must clip to the top-of-keyboard, not container.bottom')
  assert.match(kbSrc,
    /desiredFieldTop\s*=\s*visibleTop\s*\+\s*\(bandHeight\s*-\s*eRect\.height\)\s*\/\s*2/,
    'desiredFieldTop must centre the field inside the clipped band, '
    + 'not the raw container')
  // Breathing-room fallback for a tight band so we never target
  // outside the field itself.
  assert.match(kbSrc,
    /bandHeight\s*<=\s*eRect\.height\s*\+\s*margin\s*\*\s*2/,
    'tight-band fallback must park the field with margin rather than '
    + 'crash the compute')
})

test('_findScrollContainer walks up to the first overflow-y: auto/scroll ancestor', () => {
  assert.match(kbSrc, /function\s+_findScrollContainer\(el\)/,
    'helper must exist as a named function so the test can grep it')
  assert.match(kbSrc, /style\.overflowY/,
    'helper must inspect overflow-y')
  assert.match(kbSrc, /document\.scrollingElement\s*\|\|\s*document\.documentElement/,
    'helper must fall back to the document scrolling root so a caller '
    + 'is never left with null')
})

test('scrollFocusedIntoView re-scrolls (manual) on the next visualViewport resize (shot 3)', () => {
  // Shot 3 is the resize-driven re-centre. Uses the manual compute
  // (not the naive scroll) so a late resize still lands the field in
  // the middle of the above-keyboard band.
  assert.match(kbSrc,
    /vv\.addEventListener\(['"]resize['"]\s*,\s*once\)/,
    'third shot must register a one-shot resize listener on '
    + 'visualViewport')
  assert.match(kbSrc,
    /vv\.removeEventListener\(['"]resize['"]\s*,\s*once\)/,
    'the listener must detach itself after it fires — a leaky listener '
    + 'would re-scroll on every keyboard open on the page')
  // The one-shot handler must call _manualCentre (not _naiveScroll)
  // so the resize-driven re-run also lands in the centre of the band.
  assert.match(kbSrc,
    /const\s+once\s*=\s*\(\)\s*=>\s*\{\s*\n[\s\S]*?_manualCentre\(\)/,
    'the resize handler must call _manualCentre so the late re-run '
    + 'also centres in the above-keyboard band')
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
  // 2026-10-14 audit #8E (iPad fix): the inline helper changed from
  // kbSafeModalContentStyle(95) to kbSafeFlexShellStyle(95) because
  // the shell is a FLEX COLUMN (header + progress + scroll child)
  // and the old helper's paddingBottom was collapsing the scroll
  // child's flex: 1 share when --kb-inset grew. The new helper omits
  // paddingBottom (which now lives on the scroll child via
  // kbSafeScrollChildStyle). Pin verifies the correct helper is on
  // the SAME element as the shell class — strip out the surrounding
  // comment first so a mention of the OLD helper in a code comment
  // can't false-match.
  const modalLineIdx = wizSrc.indexOf('className="kb-safe-modal-shell"')
  const sliceAfter   = wizSrc.slice(modalLineIdx, modalLineIdx + 1200)
  // Comment-strip: drop every // line before matching so historical
  // helper names in explanatory comments don't satisfy the pin.
  const noComments = sliceAfter.replace(/\/\/[^\n]*\n/g, '\n')
  assert.match(noComments, /\.\.\.\s*kbSafeFlexShellStyle\(95\)/,
    'the inline kbSafeFlexShellStyle(95) spread must appear on the '
    + 'SAME modal panel element as the fallback class (the new '
    + 'split-pair helper for flex-column modals)')
  assert.equal(/\.\.\.\s*kbSafeModalContentStyle\(/.test(noComments), false,
    'the old kbSafeModalContentStyle spread must NOT be on the shell '
    + 'anymore — it collapsed the flex scroll child under keyboard')
})

test('ProgramWizard content div uses kbSafeScrollChildStyle', () => {
  // The paddingBottom used to live on the shell; it must now live
  // on the scroll child, together with overflowY:auto. If a future
  // refactor pulls them back onto the shell the iPad landscape
  // regression returns.
  assert.match(wizSrc, /\.\.\.\s*kbSafeScrollChildStyle\(/,
    'ProgramWizard content div must spread kbSafeScrollChildStyle so '
    + 'paddingBottom + overflowY land on the scroll child, not the '
    + 'flex-column shell')
  // Pin that the content div still carries flex:1 so the shell\'s
  // header + progress still size naturally and the scroll child takes
  // the remainder. Strip comments so a long inline note between
  // `flex: 1` and the spread doesn\'t push them apart.
  const scrollChildIdx = wizSrc.indexOf('kbSafeScrollChildStyle(')
  const before = wizSrc.slice(Math.max(0, scrollChildIdx - 800), scrollChildIdx)
  const noComments = before.replace(/\/\/[^\n]*\n/g, '\n')
  assert.match(noComments, /flex:\s*1/,
    'the scroll child must still carry flex: 1 so it takes the '
    + 'leftover vertical space after header + progress bar')
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
