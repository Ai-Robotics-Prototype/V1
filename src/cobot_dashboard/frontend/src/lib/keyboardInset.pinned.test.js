// On-screen keyboard inset — single-source shared behaviour pin
// (2026-10-09 operator directive, tablet).
//
// Before this directive only ExternalFixtureWizard applied the
// keyboard-safe maxHeight / paddingBottom pattern + the focused-
// field auto-scroll. LoginModal, DevicePairingWizard, ProgramWizard,
// EOATSetupWizard, RecordConfirmModal, ProgramFromDemonstration all
// had text inputs that disappeared behind the on-screen keyboard on
// tablet. The fix centralises both pieces:
//
//   * a single `useGlobalKeyboardAutoScroll` hook mounted at the App
//     root scrolls any focused text input / textarea into view;
//   * a single `kbSafeModalContentStyle()` helper returns the
//     maxHeight + paddingBottom + overflowY snippet every prompt's
//     content container spreads to shrink around the keyboard.
//
// These pins block any resurfacing of the one-off per-prompt
// patterns and confirm every known text-input surface consumes the
// shared helpers.

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

test('keyboardInset.js exports useGlobalKeyboardAutoScroll + kbSafeModalContentStyle', () => {
  const src = readSrc('lib/keyboardInset.js')
  assert.match(src, /export function useGlobalKeyboardAutoScroll\(/,
    'the global focusin auto-scroll hook must be exported')
  assert.match(src, /export function kbSafeModalContentStyle\(/,
    'the shared keyboard-safe modal style helper must be exported')
  // Positive wiring: the global hook attaches a document-level
  // focusin listener (one subscriber covers every prompt in the app)
  // and the style helper reads var(--kb-inset) with a 0px fallback
  // so desktop stays inert.
  assert.match(src, /document\.addEventListener\(['"]focusin['"]/,
    'useGlobalKeyboardAutoScroll must mount a document-level focusin listener')
  assert.match(src, /var\(--kb-inset,\s*0px\)/,
    'kbSafeModalContentStyle must read var(--kb-inset, 0px) so the '
    + 'modal shrinks when the keyboard opens and is inert otherwise')
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
  const src = readSrc('lib/keyboardInset.js')
  assert.match(src,
    /maxHeight:\s*`calc\(\$\{vhCap\}vh - var\(--kb-inset, 0px\)\)`/,
    'kbSafeModalContentStyle must preserve the 0px fallback so '
    + 'desktop renders byte-identically to the pre-change layout')
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
