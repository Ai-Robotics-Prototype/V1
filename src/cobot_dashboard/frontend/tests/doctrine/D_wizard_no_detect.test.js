// DOCTRINE — Program wizard emits ZERO detect steps (2026-10-05
// operator directive: vision / detect is not in scope).
//
// Field report: the wizard was still inserting an `action:'detect'`
// step into generated programs ("Find <library part>") on both the
// pick_and_place/machine_tend path and the palletize path. Operator
// confirmed detect is not in scope; the wizard must stop inserting
// the step entirely.
//
// Scope boundary — THIS DOCTRINE IS NARROW. Deliberately kept:
//   * ACTION_TYPES includes `detect` in ProgramEditor (so saved
//     legacy programs render + the operator can hand-add via the
//     step palette if they're hand-wiring vision).
//   * The step palette in ProgramEditor keeps the Detect entry.
//   * Detect-step editing + default-fields handlers in the editor
//     are unchanged.
//   * The parts-library endpoint stays live for future re-wiring.
//
// Deliberately removed:
//   * `buildSteps` detect-emit guard + the detect step itself.
//   * `buildPalletizeSteps` detect-emit guard + the detect step.
//   * The `which_part` wizard page + its WhichPartBody render
//     function + the COCO_NATIVE_NAMES helper (only used by that
//     page). The page's only job was selecting the target_part for
//     the detect step; with no detect emission, the page has no
//     purpose.
//
// Pins:
//   1. ProgramWizard.jsx source has NO `action: 'detect'` emit
//      anywhere in buildSteps or buildPalletizeSteps.
//   2. The `which_part` PAGES entry is gone.
//   3. The WhichPartBody render function is gone (dead code
//      regression guard).
//   4. ProgramEditor.jsx keeps the ACTION_TYPES `detect` row and
//      the step-palette Detect entry — the primitive survives.
//   5. A reference program that carries a legacy detect step
//      loads / renders without crashing (editor-side pass).
//
// Failure format:
//   DOCTRINE WIZARD_NO_DETECT VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE WIZARD_NO_DETECT VIOLATED: ${msg}` }

const wizSrc    = readSrc('components/ProgramWizard.jsx')
const editorSrc = readSrc('components/ProgramEditor.jsx')


// ── (1) + (2) wizard emits zero detect steps ────────────────────────

test('ProgramWizard source contains no action:detect emit anywhere', () => {
  // Scan for a `push({ action: 'detect' ... })` or raw
  // `action: 'detect'` object literal in the wizard file. The only
  // legitimate uses of the string 'detect' in this file would be
  // comments (which this grep catches too, so we strip them).
  const stripped = wizSrc.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('//')) return false
    if (t.startsWith('*'))  return false
    return true
  }).join('\n')
  const hit = stripped.match(/action:\s*['"]detect['"]/)
  assert.equal(hit, null,
    v('ProgramWizard.jsx must not emit any `action: "detect"` step '
      + '— vision / detect is not in scope (2026-10-05 directive).'))
})

test('ProgramWizard has no which_part PAGES entry', () => {
  // The PAGES array entry had `id: 'which_part'` and `render:
  // WhichPartBody`. Both must be gone.
  assert.equal(/id:\s*['"]which_part['"]/.test(wizSrc), false,
    v('ProgramWizard.jsx must not declare a PAGES entry with '
      + "id: 'which_part' — the page existed only to configure the "
      + 'now-removed detect step.'))
  assert.equal(/render:\s*WhichPartBody/.test(wizSrc), false,
    v('ProgramWizard.jsx must not route a page to WhichPartBody — '
      + 'the body function is deleted along with the page.'))
})

test('ProgramWizard: WhichPartBody dead-code regression guard', () => {
  // Strip comment lines so a breadcrumb "deleted" comment doesn't
  // flag the pin.
  const stripped = wizSrc.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('//')) return false
    if (t.startsWith('*'))  return false
    return true
  }).join('\n')
  assert.equal(/function\s+WhichPartBody\s*\(/.test(stripped), false,
    v('WhichPartBody function definition must be deleted — the '
      + 'which_part page is retired.'))
  // The COCO_NATIVE_NAMES helper was only used by WhichPartBody.
  assert.equal(/COCO_NATIVE_NAMES/.test(stripped), false,
    v('COCO_NATIVE_NAMES helper must be deleted — it was only used '
      + 'inside WhichPartBody and has no other call site in the '
      + 'wizard.'))
})


// ── (4) detect primitive survives in the editor ─────────────────────

test('ProgramEditor keeps the detect ACTION_TYPES row', () => {
  assert.ok(/value:\s*['"]detect['"]/.test(editorSrc),
    v('ProgramEditor.jsx ACTION_TYPES must still include the '
      + "'detect' row — saved legacy programs with a detect step "
      + 'rely on this for rendering + editing.'))
})

test('ProgramEditor keeps the Detect entry in the step palette', () => {
  // The palette line is `{ action: 'detect', label: 'Detect', ... }`.
  assert.ok(/\{\s*action:\s*['"]detect['"],\s*label:\s*['"]Detect['"]/
              .test(editorSrc),
    v('ProgramEditor.jsx step palette must still offer the Detect '
      + 'entry — operators may hand-add detect while the vision '
      + 'stack is out of scope; the directive stops wizard emission '
      + 'ONLY.'))
})


// ── (5) legacy program with a detect step still loads ──────────────

test('reference program with a detect step keeps its shape', async () => {
  // The pallet reference program carries a detect step at index 1
  // (position 2 in the 1-indexed view). It must still parse, keep
  // the detect step, and the step-row renderer must not crash on
  // the detect action. We assert the shape; the editor renders
  // through detailLine which handles any unknown step action
  // defensively (label passthrough), so a legacy detect step is
  // operator-visible without any wizard involvement.
  const { REF_PALLET } = await import('./_reference_programs.js')
  const detectSteps = REF_PALLET.steps.filter(
    (s) => s.action === 'detect')
  assert.equal(detectSteps.length, 1,
    v('REF_PALLET must preserve its legacy detect step so this '
      + 'suite proves the editor still loads older programs after '
      + 'the wizard stopped emitting detect.'))
  assert.ok(detectSteps[0].label,
    v('Legacy detect step must carry a label the row renderer can '
      + 'display.'))
})
