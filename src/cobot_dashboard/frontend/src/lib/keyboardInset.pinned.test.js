// On-screen keyboard inset — single-source shared behaviour pin
// (2026-10-09 + 2026-10-12 operator directives, tablet).
//
// 2026-10-09 round: only ExternalFixtureWizard applied the keyboard-
// safe maxHeight / paddingBottom pattern + the focused-field auto-
// scroll. LoginModal, DevicePairingWizard, ProgramWizard, EOATSetup
// Wizard, RecordConfirmModal, ProgramFromDemonstration all had text
// inputs that disappeared behind the on-screen keyboard on tablet.
// The fix centralised two pieces:
//
//   * a single `useGlobalKeyboardAutoScroll` hook mounted at the App
//     root scrolls any focused text input / textarea into view;
//   * a single `kbSafeModalContentStyle()` helper returns the
//     maxHeight + paddingBottom + overflowY snippet every prompt's
//     content container spreads to shrink around the keyboard.
//
// 2026-10-12 round (recurring): the panel's maxHeight shrank but the
// flex overlay still centered the panel in the full LAYOUT viewport
// — so the bottom half of every modal was still behind the keyboard.
// Also SetupWizard had never been patched. The structural fix adds
// a THIRD piece at the OUTER overlay level:
//
//   * a single `kbSafeOverlayStyle()` helper spread on every modal /
//     dialog / wizard outer overlay. paddingBottom:var(--kb-inset)
//     shrinks the flex container so alignItems:center naturally
//     lifts the panel above the keyboard.
//
// These pins block any resurfacing of the one-off per-prompt
// patterns, confirm every known text-input surface consumes BOTH
// shared helpers (panel + overlay), and catch any NEW modal with
// inputs that omits the overlay helper (anti-recurrence sentinel).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
function readSrc(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
}


// ─────────────────────────────────────────────────────────────
// The shared library exposes the two load-bearing exports.
// ─────────────────────────────────────────────────────────────

test('keyboardInset.js exports useGlobalKeyboardAutoScroll + kbSafeModalContentStyle + kbSafeOverlayStyle', () => {
  const src = readSrc('lib/keyboardInset.js')
  assert.match(src, /export function useGlobalKeyboardAutoScroll\(/,
    'the global focusin auto-scroll hook must be exported')
  assert.match(src, /export function kbSafeModalContentStyle\(/,
    'the shared keyboard-safe modal panel style helper must be exported')
  assert.match(src, /export function kbSafeOverlayStyle\(/,
    'the shared keyboard-safe modal OVERLAY style helper must be '
    + 'exported — this is the piece that lifts the panel above the '
    + 'keyboard; without it the panel shrinks but stays centered '
    + 'behind the keyboard (2026-10-12 recurrence root cause)')
  // Positive wiring: the global hook attaches a document-level
  // focusin listener (one subscriber covers every prompt in the app)
  // and the style helpers read var(--kb-inset) with a 0px fallback
  // so desktop stays inert.
  assert.match(src, /document\.addEventListener\(['"]focusin['"]/,
    'useGlobalKeyboardAutoScroll must mount a document-level focusin listener')
  assert.match(src, /var\(--kb-inset,\s*0px\)/,
    'kbSafeModalContentStyle must read var(--kb-inset, 0px) so the '
    + 'modal shrinks when the keyboard opens and is inert otherwise')
})


test('kbSafeOverlayStyle returns paddingBottom:var(--kb-inset) with the 0px fallback', () => {
  // The overlay helper is the structural fix. paddingBottom shrinks
  // the flex container's content box; the 0px fallback is what makes
  // it inert on desktop. If either disappears the tablet bug comes
  // back (field + buttons behind keyboard) OR desktop breaks.
  const src = readSrc('lib/keyboardInset.js')
  assert.match(src,
    /paddingBottom:\s*['"]var\(--kb-inset,\s*0px\)['"]/,
    'kbSafeOverlayStyle must set paddingBottom: var(--kb-inset, 0px) '
    + 'on the outer overlay so flex centering lifts the panel above '
    + 'the on-screen keyboard; 0px fallback keeps desktop inert')
})


test('App root mounts the global keyboard auto-scroll hook', () => {
  // Every prompt in the app inherits the focused-field scroll
  // behaviour from this single mount. If it ever vanishes, every
  // modal's keyboard-cover bug returns.
  const app = readSrc('App.jsx')
  assert.match(app, /from ['"]\.\/lib\/keyboardInset['"]/,
    'App.jsx must import from ./lib/keyboardInset')
  assert.match(app, /useGlobalKeyboardAutoScroll\(\)/,
    'App.jsx must call useGlobalKeyboardAutoScroll() at the root — '
    + 'the ONE mount that covers every modal')
})


// ─────────────────────────────────────────────────────────────
// Every text-input prompt / modal consumes the shared helper.
// Keep this list in sync with the enumerate step in the operator
// directive; adding a new text-input prompt means adding it here.
// ─────────────────────────────────────────────────────────────

const SURFACES_WITH_TEXT_INPUT = [
  // [component file, free-text description for assertion messages]
  ['components/LoginModal.jsx',          'LoginModal (username / password)'],
  ['components/DevicePairingWizard.jsx', 'DevicePairingWizard (address, device name, code)'],
  ['components/ProgramWizard.jsx',       'ProgramWizard (program name + numeric inputs)'],
  ['components/EOATSetupWizard.jsx',     'EOATSetupWizard (tool naming)'],
  ['components/ExternalFixtureWizard.jsx','ExternalFixtureWizard (fixture naming)'],
  ['components/RecordConfirmModal.jsx',  'RecordConfirmModal (shared confirm)'],
  ['components/ProgramFromDemonstration.jsx',
    'ProgramFromDemonstration (name/description, label edits)'],
  // 2026-10-12 addition — the "robot name / cell name" surface that
  // slipped through the first round because it was never patched for
  // either helper. Now routed through the shared library.
  ['components/SetupWizard.jsx',         'SetupWizard (cell name)'],
]


test('every known text-input prompt consumes kbSafeModalContentStyle', () => {
  for (const [rel, label] of SURFACES_WITH_TEXT_INPUT) {
    const src = readSrc(rel)
    assert.match(src, /kbSafeModalContentStyle/,
      `${label} must import + spread kbSafeModalContentStyle so its `
      + 'content container shrinks around the on-screen keyboard')
    assert.match(src,
      /from ['"](?:\.\.\/|\.\/)lib\/keyboardInset['"]/,
      `${label} must import from ../lib/keyboardInset (shared source)`)
  }
})


test('every known text-input prompt also consumes kbSafeOverlayStyle', () => {
  // 2026-10-12 — this is the pin that catches the recurrence. The
  // panel-level helper alone leaves the panel bisected by the keyboard
  // because the outer flex overlay still centers in the full layout
  // viewport. The overlay helper reserves paddingBottom:var(--kb-inset)
  // on the outer `position:fixed; inset:0; display:flex` wrapper so
  // alignItems:center naturally lifts the panel above the keyboard.
  for (const [rel, label] of SURFACES_WITH_TEXT_INPUT) {
    const src = readSrc(rel)
    assert.match(src, /kbSafeOverlayStyle/,
      `${label} must import + spread kbSafeOverlayStyle on its outer `
      + 'overlay so flex centering lifts the panel above the keyboard. '
      + 'Without this, kbSafeModalContentStyle on the panel alone is '
      + 'not enough — the shrunk panel still sits centered at layoutH/2 '
      + 'which is behind the on-screen keyboard.')
  }
})


test('no modal reinvents the keyboard-safe snippet inline (no fork)', () => {
  // The one-off expression `maxHeight: 'calc(…vh - var(--kb-inset…))'`
  // is now owned by lib/keyboardInset.kbSafeModalContentStyle. If any
  // modal reintroduces an inline fork, this pin fires.
  for (const [rel, label] of SURFACES_WITH_TEXT_INPUT) {
    const src = readSrc(rel)
    // Match a maxHeight that reads --kb-inset but is NOT inside a
    // helper call — i.e. a hand-rolled inline expression.
    const inlineForks = src.match(
      /maxHeight:\s*['"]calc\([^'"]*--kb-inset[^'"]*\)['"]/g)
    assert.equal(inlineForks, null,
      `${label} must call kbSafeModalContentStyle() instead of `
      + `inlining the maxHeight calc — found ${JSON.stringify(inlineForks)}`)
  }
})


// ─────────────────────────────────────────────────────────────
// Behaviour pins (restores on close + desktop-inert)
// ─────────────────────────────────────────────────────────────

test('kbSafeModalContentStyle degrades to a 0px shift when --kb-inset is absent', () => {
  // The style helper uses var(--kb-inset, 0px); the 0px fallback is
  // what makes the pattern inert on desktop (no virtualKeyboard, no
  // visualViewport shrink → inset stays 0 → calc evaluates to the
  // pre-change maxHeight). This pin blocks any edit that drops the
  // fallback and silently zeros the modal on desktop.
  //
  // 2026-10-14 audit #8C: maxHeight now wraps the vh calc in
  // `min(dvh, vh)` so dvh-aware engines (iOS 15.4+ / Chrome 108+)
  // shrink with the on-screen keyboard without depending on our JS
  // --kb-inset tracking. Both branches of the min() carry the 0px
  // fallback — the pin checks the semantic (var with 0px fallback
  // + vh carrier survives) rather than the exact pre-fix form.
  const src = readSrc('lib/keyboardInset.js')
  assert.match(src,
    /calc\(\$\{vhCapInt?\}vh - var\(--kb-inset, 0px\)\)/,
    'kbSafeModalContentStyle must preserve the vh branch with the '
    + '0px fallback so engines that don\'t parse dvh still get a '
    + 'desktop-byte-identical layout')
  assert.match(src,
    /calc\(\$\{vhCapInt?\}dvh - var\(--kb-inset, 0px\)\)/,
    'kbSafeModalContentStyle must emit the dvh branch so modern '
    + 'engines shrink with the keyboard independent of JS inset tracking')
  assert.match(src, /min\(/,
    'maxHeight must use min(dvh, vh) so dvh wins when supported '
    + 'and the whole value drops on older engines (which then get the '
    + '.kb-safe-modal-shell CSS fallback at the stylesheet level)')
})


test('useKeyboardInset resets --kb-inset to 0 on unmount', () => {
  // The hook's cleanup runs when the user leaves the view / the app
  // unmounts. Not clearing the var would leave stale padding on any
  // remaining fixed element. Pin the cleanup set.
  const src = readSrc('lib/keyboardInset.js')
  const resets = src.match(
    /root\.style\.setProperty\(['"]--kb-inset['"],\s*['"]0px['"]\)/g)
  // Both the VirtualKeyboard path and the visualViewport fallback
  // cleanup reset the var. 2 or more hits = both branches covered.
  assert.ok(resets && resets.length >= 2,
    `useKeyboardInset cleanup must reset --kb-inset to '0px' on `
    + `both the VirtualKeyboard and visualViewport paths; found `
    + `${(resets || []).length}`)
})


// ─────────────────────────────────────────────────────────────
// Anti-recurrence sentinel — scans EVERY component file. If a
// component is a modal/dialog overlay (position:fixed + inset:0 +
// display:flex) AND contains a text/number input, it must spread
// kbSafeOverlayStyle. This fires on NEW modals added later that
// forget the shared container — the recurrence failure mode.
// ─────────────────────────────────────────────────────────────

test('any modal overlay containing a text/number input spreads kbSafeOverlayStyle', () => {
  const componentsDir = path.resolve(__dirname, '..', 'components')
  const files = fs.readdirSync(componentsDir)
    .filter(f => f.endsWith('.jsx'))
  const nonTextTypes = /type=["']?(range|checkbox|radio|file|color|button|submit|reset|hidden)/
  const offenders = []
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(componentsDir, f), 'utf8')
    const isFixedOverlay =
      /position:\s*['"]fixed['"]/.test(src)
      && /inset:\s*0\b/.test(src)
      && /display:\s*['"]flex['"]/.test(src)
    if (!isFixedOverlay) continue
    // Collect every <input ...> occurrence; keep only text-like ones
    // (anything without a non-text type attribute).
    const inputMatches = src.match(/<input\b[^>]*/g) || []
    const hasTextInput = inputMatches.some(m => !nonTextTypes.test(m))
    const hasTextarea = /<textarea\b/.test(src)
    if (!hasTextInput && !hasTextarea) continue
    if (!/kbSafeOverlayStyle/.test(src)) offenders.push(f)
  }
  assert.deepEqual(offenders, [],
    'Each of these component files is a modal overlay (position:fixed '
    + '+ inset:0 + display:flex) with a text/number input, but does '
    + 'NOT spread kbSafeOverlayStyle on its outer overlay. Without '
    + 'the overlay helper the panel still gets bisected by the on-'
    + 'screen keyboard. Import from ../lib/keyboardInset and spread '
    + 'kbSafeOverlayStyle() on the outer fixed overlay. '
    + `Offenders: ${JSON.stringify(offenders)}`)
})


test('useGlobalKeyboardAutoScroll skips non-text inputs (no false scroll jumps)', () => {
  // Range sliders, checkboxes, radio buttons, and buttons never
  // bring up the on-screen keyboard. Scrolling them into view on
  // focus produces a jarring layout jump the operator didn't ask
  // for. The hook gates on `isText`.
  const src = readSrc('lib/keyboardInset.js')
  assert.match(src, /const isText = /,
    'useGlobalKeyboardAutoScroll must compute an isText predicate '
    + 'that gates the scroll call')
  assert.match(src, /if \(!isText\) return/,
    'the hook must early-return on non-text focus events')
})
