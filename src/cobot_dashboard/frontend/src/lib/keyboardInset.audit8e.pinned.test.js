// Audit #8E pins — the New Program Wizard was the ONLY modal where
// text inputs still read "barely visible" on the iPad after audits
// #8C and #8D. Everything else (LoginModal, EOAT naming, rename,
// fixtures, record-confirm) behaved. 2026-10-14 operator-confirmed
// narrowing: the fault is wizard-specific.
//
// Root cause — the shared helper fits SIMPLE-form modals (LoginModal
// <form>, RecordConfirmModal <div>) where the outer element IS the
// scroll surface. On a FLEX-COLUMN shell (header + progress + scroll
// child) `kbSafeModalContentStyle()` is a trap: its paddingBottom
// sits on the SHELL, box-sizing:border-box makes that padding INSIDE
// the shell's height, and when --kb-inset grows to ~300 px the
// padding steals from every flex child simultaneously — the scroll
// child collapses to 60-120 px on iPad landscape and the field is
// visible but the band around it is a strip. Operator reads "barely
// visible".
//
// Fix — SPLIT the pair for flex-column modals:
//   * kbSafeFlexShellStyle(vhCap)  → maxHeight + boxSizing only.
//     Lives on the shell; no paddingBottom.
//   * kbSafeScrollChildStyle(padBottom) → overflowY:auto +
//     paddingBottom:calc(padBottom + --kb-inset). Lives on the
//     scroll child, so breathing room is given to the LAST field in
//     the scrollable list and the shell's flex siblings aren't
//     starved.
//
// Simple-form modals keep using kbSafeModalContentStyle (unchanged
// behaviour, unchanged pins). Flex-column modals use the new pair.
// ProgramWizard is the first consumer; future multi-page prompts
// should use the same pair.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FRONT_ROOT = path.resolve(__dirname, '..', '..')
const readSrc = (rel) => fs.readFileSync(path.join(FRONT_ROOT, 'src', rel), 'utf8')

const kbSrc  = readSrc('lib/keyboardInset.js')
const wizSrc = readSrc('components/ProgramWizard.jsx')

// ── Helper existence + shape ─────────────────────────────────────

test('keyboardInset.js exports kbSafeFlexShellStyle', () => {
  assert.match(kbSrc, /export\s+function\s+kbSafeFlexShellStyle\s*\(/,
    'kbSafeFlexShellStyle must be an exported function')
})

test('keyboardInset.js exports kbSafeScrollChildStyle', () => {
  assert.match(kbSrc, /export\s+function\s+kbSafeScrollChildStyle\s*\(/,
    'kbSafeScrollChildStyle must be an exported function')
})

test('kbSafeFlexShellStyle sets maxHeight + boxSizing but NO paddingBottom', () => {
  // Pull the function body so unrelated matches outside it can\'t
  // satisfy the pin.
  const start = kbSrc.indexOf('export function kbSafeFlexShellStyle')
  assert.ok(start >= 0)
  const end = kbSrc.indexOf('export function', start + 10)
  const body = kbSrc.slice(start, end >= 0 ? end : kbSrc.length)
  assert.match(body, /maxHeight:/,
    'kbSafeFlexShellStyle must set maxHeight')
  assert.match(body, /boxSizing:\s*['"]border-box['"]/,
    'kbSafeFlexShellStyle must set boxSizing: border-box so the '
    + 'maxHeight bounds the padded box, matching the shell\'s layout')
  assert.equal(/paddingBottom/.test(body), false,
    'kbSafeFlexShellStyle must NOT emit paddingBottom — that is what '
    + 'collapsed the flex scroll child in the pre-fix pair')
  // dvh + vh branches must both be present (audit #8C contract).
  assert.match(body, /dvh/, 'dvh branch required for modern iPad')
  assert.match(body, /vh/,  'vh branch required for < iOS 15.4 fallback')
})

test('kbSafeScrollChildStyle sets overflowY + paddingBottom (keeps simple-form semantics)', () => {
  const start = kbSrc.indexOf('export function kbSafeScrollChildStyle')
  assert.ok(start >= 0)
  const end = kbSrc.indexOf('export function', start + 10)
  const body = kbSrc.slice(start, end >= 0 ? end : kbSrc.length)
  assert.match(body, /overflowY:\s*['"]auto['"]/,
    'kbSafeScrollChildStyle must set overflowY: auto on the scroll child')
  assert.match(body,
    /paddingBottom:\s*`calc\(\$\{padBottom\}px\s*\+\s*var\(--kb-inset,\s*0px\)\)/,
    'paddingBottom must track --kb-inset — same semantic the simple-'
    + 'form helper had, now scoped to the scroll child')
})

// ── ProgramWizard uses the split pair ────────────────────────────

test('ProgramWizard imports kbSafeFlexShellStyle + kbSafeScrollChildStyle', () => {
  assert.match(wizSrc,
    /import\s*\{[^}]*kbSafeFlexShellStyle[^}]*\}\s*from\s*['"]\.\.\/lib\/keyboardInset['"]/,
    'ProgramWizard must import kbSafeFlexShellStyle from the shared library')
  assert.match(wizSrc,
    /import\s*\{[^}]*kbSafeScrollChildStyle[^}]*\}\s*from\s*['"]\.\.\/lib\/keyboardInset['"]/,
    'ProgramWizard must import kbSafeScrollChildStyle from the shared library')
})

test('ProgramWizard does NOT spread kbSafeModalContentStyle on the shell anymore', () => {
  // Comment-strip so a historical reference in a code comment can\'t
  // falsely satisfy the "still on shell" check.
  const noComments = wizSrc.replace(/\/\/[^\n]*\n/g, '\n')
  // Simple-form helper must not appear as a spread anywhere in the
  // wizard — the file is purely flex-column modal now.
  assert.equal(/\.\.\.\s*kbSafeModalContentStyle\(/.test(noComments), false,
    'kbSafeModalContentStyle must NOT be spread anywhere in '
    + 'ProgramWizard.jsx — the shell is flex column (use '
    + 'kbSafeFlexShellStyle) and the scroll child needs the split '
    + 'helper (kbSafeScrollChildStyle). Leaving the old spread would '
    + 'reintroduce the audit #8E regression.')
})

test('simple-form helper kbSafeModalContentStyle is still exported and used by LoginModal', () => {
  // Make sure the SPLIT doesn\'t break the simple-form path. The
  // helper must still exist and still be the one LoginModal (and
  // other simple-form modals) spread on their form.
  assert.match(kbSrc, /export\s+function\s+kbSafeModalContentStyle\s*\(/,
    'kbSafeModalContentStyle must still exist for simple-form modals')
  const loginSrc = readSrc('components/LoginModal.jsx')
  assert.match(loginSrc, /\.\.\.\s*kbSafeModalContentStyle\(\)/,
    'LoginModal must still use the simple-form helper (no regression)')
})
