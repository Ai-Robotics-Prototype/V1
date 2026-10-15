// DOCTRINE — Program-wizard teach record confirmation (2026-10-15
// operator field report).
//
// Pre-fix:
//   (1) After pressing Record on a wizard teach step, the reuse-choice
//       screen fired on EVERY step whose key already carried a value in
//       `answers` — including edit-mode re-opens where every taught
//       position pre-populates. Operator saw "reuse the position?" after
//       recording a fresh step; the reuse flow was supposed to be the
//       narrow end-of-sequence HOME-return case only.
//   (2) The reuse screen dumped TCP x/y/z/rx/ry/rz (or Joints[]°) in a
//       monospace block — raw numbers the operator doesn't need to see
//       to make the reuse/re-teach decision.
//   (3) The post-record confirmation was a button-only green flash
//       ("✓ Recorded") with no copy that named THIS position. The
//       operator wanted a short "Successfully taught <position>" callout.
//
// Scope leak classification: cause (d) — the reuse trigger
// (`alreadyRecordedHere`) was too loose; the earlier 23ea7e3 fix (bug 1,
// 2026-10-08) killed one source (global-home seed) but did not scope
// the trigger itself. This fix narrows the trigger to the end-return
// step only.
//
// Pins (ProgramWizard.jsx TeachSequence):
//   * `showChoiceScreen` gates on `isEndReturnStep` — reuse NEVER fires
//     mid-sequence, even in edit mode with pre-populated answers.
//   * `isEndReturnStep` is derived from (posIdx === last) AND an earlier
//     position shares this step's key — the canonical end-return pattern
//     (teachPositionsForAnswers unconditionally appends taught_home at
//     the tail).
//   * The reuse screen renders NO TCP coord dump and NO Joints[] dump —
//     just the "already taught" header + Reuse/Re-teach buttons.
//   * After record, a `teach-success-banner` with the title-cased
//     position name renders ("Successfully taught Home position").
//   * `teachLabelToName` helper exists and is applied so ALL-CAPS teach
//     labels render in sentence case ("HOME POSITION" → "Home position").
//
// Failure format: DOCTRINE TEACH_RECORD_CONFIRMATION VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc = readSrc('components/ProgramWizard.jsx')

function v(msg) { return `DOCTRINE TEACH_RECORD_CONFIRMATION VIOLATED: ${msg}` }


// ── (1) Reuse screen fires ONLY on the end-return step ──────────────

test('TeachSequence derives isEndReturnStep from last-index + shared key', () => {
  assert.ok(
    /isEndReturnStep\s*=\s*!!\(current[\s\S]{0,200}posIdx\s*===\s*positions\.length\s*-\s*1[\s\S]{0,200}positions\.slice\(0,\s*posIdx\)\.some\(\(p\)\s*=>\s*p\.key\s*===\s*current\.key\)/
      .test(progWizSrc),
    v('TeachSequence must derive isEndReturnStep from '
      + '(posIdx === positions.length - 1) AND an earlier position '
      + 'sharing this step\'s key — the canonical end-return pattern '
      + 'teachPositionsForAnswers emits (taught_home duplicate at the '
      + 'tail of every sequence).'))
})

test('TeachSequence showChoiceScreen is AND-gated by isEndReturnStep', () => {
  assert.ok(
    /showChoiceScreen\s*=\s*alreadyRecordedHere\s*&&\s*!forceTeach\[posIdx\]\s*&&\s*isEndReturnStep/
      .test(progWizSrc),
    v('showChoiceScreen must AND in isEndReturnStep — pre-fix (2026-10-15) '
      + 'the trigger fired on every step whose key already carried a '
      + 'value in `answers`, which included every edit-mode re-open. '
      + 'The reuse prompt is now the end/return step ONLY.'))
})


// ── (2) Reuse screen carries NO coord dump ──────────────────────────

test('Reuse choice screen does not render a TCP coord block', () => {
  // Pre-fix the reuse screen dumped TCP x:/y:/z:/rx:/ry:/rz:. The post-
  // fix screen names what\'s already taught and offers the two choices;
  // no numbers. The TCP: literal + per-axis labels are the smoking gun.
  assert.ok(
    !/TCP:\s*x:\$\{Number/.test(progWizSrc)
      && !/TCP:\s*x:\{Number\(existingForCurrent\.tcp\[0\]\)/.test(progWizSrc),
    v('Reuse screen must NOT emit a TCP coord dump — the operator does '
      + 'not need x/y/z/rx/ry/rz numbers to pick Reuse vs Re-teach.'))
  assert.ok(
    !/rx:\{Number\(existingForCurrent\.tcp\[3\]\)/.test(progWizSrc)
      && !/ry:\{Number\(existingForCurrent\.tcp\[4\]\)/.test(progWizSrc)
      && !/rz:\{Number\(existingForCurrent\.tcp\[5\]\)/.test(progWizSrc),
    v('Reuse screen must NOT emit per-axis rx/ry/rz coord labels — the '
      + 'pre-fix monospace dump is retired.'))
})

test('Reuse choice screen does not render a Joints[]° dump', () => {
  assert.ok(
    !/Joints:\s*\[\{existingForCurrent\.joints\.map/.test(progWizSrc),
    v('Reuse screen must NOT emit a Joints: [...]° dump — operator does '
      + 'not need the joint vector to pick Reuse vs Re-teach.'))
})


// ── (3) Plain success message naming THIS position ──────────────────

test('teachLabelToName helper exists in ProgramWizard', () => {
  assert.ok(
    /function teachLabelToName\(label\)/.test(progWizSrc),
    v('ProgramWizard must define teachLabelToName — converts the '
      + 'ALL-CAPS teach label to sentence case for the success banner '
      + '("HOME POSITION" → "Home position").'))
})

test('TeachSequence renders a teach-success-banner during the flash window', () => {
  assert.ok(
    /data-testid="teach-success-banner"/.test(progWizSrc),
    v('TeachSequence must render data-testid="teach-success-banner" '
      + 'during the post-record flash window — the operator-facing '
      + 'confirmation that THIS position was recorded.'))
  assert.ok(
    /flash\s*&&\s*current\s*&&/.test(progWizSrc),
    v('The teach-success-banner must be gated on `flash && current` '
      + 'so it only renders while the 900 ms record-confirmation '
      + 'window is open.'))
})

test('teach-success-banner copy is "Successfully taught <name>"', () => {
  // Match the banner body literally — the operator-specified phrasing.
  assert.ok(
    /Successfully taught \{teachLabelToName\(current\.label\)\}/
      .test(progWizSrc),
    v('Success banner must render "Successfully taught <name>" where '
      + '<name> comes from teachLabelToName(current.label) — single '
      + 'source of truth for the position name.'))
})

test('teach-success-banner carries the position name as a data attribute', () => {
  assert.ok(
    /data-position-name=\{teachLabelToName\(current\.label\)\}/
      .test(progWizSrc),
    v('teach-success-banner must stamp data-position-name so e2e tests '
      + 'can assert the CURRENT step\'s name (and not a stale neighbour) '
      + 'rode the confirmation.'))
})


// ── (4) teachLabelToName produces the expected sentence case ────────
//
// We evaluate the helper in isolation to confirm the real strings the
// teach labels use (HOME POSITION / PICK POSITION / PLACE POSITION /
// HOME (return) / ① PALLET CORNER — origin / MACHINE LOAD POSITION /
// UNLOAD POSITION / SORT PLACE 1) all round-trip to a sentence-cased
// name the operator will read in the confirmation banner.

function evalTeachLabelToName() {
  // Extract the helper body from the source and eval under Function —
  // byte-identical to what ships at runtime, no stub re-implementation.
  const m = progWizSrc.match(/function teachLabelToName\(label\)\s*\{[\s\S]*?\n\}/)
  if (!m) throw new Error('teachLabelToName not found in ProgramWizard.jsx')
  return new Function(`${m[0]}; return teachLabelToName;`)()
}

test('teachLabelToName converts the common teach labels to sentence case', () => {
  const toName = evalTeachLabelToName()
  const cases = [
    ['HOME POSITION',                     'Home position'],
    ['PICK POSITION',                     'Pick position'],
    ['PLACE POSITION',                    'Place position'],
    ['HOME (return)',                     'Home (return)'],
    ['PICK / LOAD POSITION',              'Pick / load position'],
    ['MACHINE LOAD POSITION',             'Machine load position'],
    ['UNLOAD POSITION',                   'Unload position'],
    ['SORT PLACE 1',                      'Sort place 1'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(toName(input), expected,
      v(`teachLabelToName(${JSON.stringify(input)}) should be `
        + `${JSON.stringify(expected)} — got ${JSON.stringify(toName(input))}.`))
  }
})

test('teachLabelToName tolerates empty / non-string input', () => {
  const toName = evalTeachLabelToName()
  assert.equal(toName(''),       'position',
    v('teachLabelToName("") should return "position" as a safe default.'))
  assert.equal(toName(null),     'position',
    v('teachLabelToName(null) should return "position" as a safe default.'))
  assert.equal(toName(undefined),'position',
    v('teachLabelToName(undefined) should return "position" as a safe default.'))
})


// ── (5) End-position step is still the HOME (return) wording ────────
//
// Pin that teachPositionsForAnswers still appends a tail step with the
// HOME (return) label + taught_home key. If this ever changes (someone
// adds a NEW tail step for a different operation), the end-position
// trigger needs to update in lockstep — this pin exists to force that
// coordination.

test('teachPositionsForAnswers appends HOME (return) + taught_home at the tail', () => {
  assert.ok(
    /positions\.push\(\{\s*key:\s*['"]taught_home['"],\s*label:\s*['"]HOME \(return\)['"],/
      .test(progWizSrc),
    v('teachPositionsForAnswers must still append { key: "taught_home", '
      + 'label: "HOME (return)" } at the tail of every sequence — the '
      + 'end-return step\'s identity is what the reuse trigger scopes '
      + 'against. If this changes the reuse gate must change with it.'))
})
