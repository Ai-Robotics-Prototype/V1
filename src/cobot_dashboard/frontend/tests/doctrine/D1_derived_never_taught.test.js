// DOCTRINE D1 — Contacts are taught; approaches/retreats are DERIVED,
// never taught, never in a teach itinerary, no taught-badge.
//
// Failure format:
//   DOCTRINE D1 VIOLATED: <detail>
//
// Coverage:
//  (a) For every reference program, no derived step appears in
//      untaughtStepIds() OR in computeTeachingDebt.stepIds.
//  (b) For every reference program, isTeachable(step, program) is
//      false for every derived step.
//  (c) Source-level: the row's taught-badge visibility gates on
//      isTeachable(step, currentProgram) — a derived row's badge is
//      hidden by the same predicate the itinerary uses. No local
//      re-derivation may sneak the badge back in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { untaughtStepIds, isTeachable, isDerivedOffsetMove }
  from '../../src/lib/programTruth.js'
import { computeTeachingDebt } from '../../src/lib/teachingDebt.js'
import { ALL_REFERENCE_PROGRAMS } from './_reference_programs.js'


function d1(msg) { return `DOCTRINE D1 VIOLATED: ${msg}` }


test('D1(a): no derived step appears in untaughtStepIds()', () => {
  for (const prog of ALL_REFERENCE_PROGRAMS) {
    const untaught = untaughtStepIds(prog)
    for (const id of untaught) {
      const step = prog.steps.find((s) => s.id === id)
      assert.equal(isDerivedOffsetMove(step), false,
        d1(`derived step '${step?.label || step?.action}' (id=${id}) `
         + `appears in untaughtStepIds for program '${prog.name}' — `
         + `the itinerary must never prompt a pose for a derived step`))
    }
  }
})

test('D1(a): no derived step appears in computeTeachingDebt.stepIds', () => {
  for (const prog of ALL_REFERENCE_PROGRAMS) {
    const debt = computeTeachingDebt(prog)
    for (const id of debt.stepIds) {
      const step = prog.steps.find((s) => s.id === id)
      assert.equal(isDerivedOffsetMove(step), false,
        d1(`derived step '${step?.label || step?.action}' (id=${id}) `
         + `appears in teachingDebt.stepIds for program '${prog.name}'`))
    }
  }
})

test('D1(b): isTeachable(step, program) === false for every derived step', () => {
  for (const prog of ALL_REFERENCE_PROGRAMS) {
    for (const step of prog.steps) {
      if (!isDerivedOffsetMove(step)) continue
      assert.equal(isTeachable(step, prog), false,
        d1(`isTeachable returned true for derived step `
         + `'${step.label || step.action}' (id=${step.id}) in program '${prog.name}'`))
    }
  }
})

test('D1(b): overridden derived steps are promoted to teachable', () => {
  // The override case is the ONE way a derived step becomes teachable
  // (operator claimed the pose). This test guards the escape hatch —
  // making sure the invariant isn't accidentally "derived is NEVER
  // teachable, period".
  const step = { id: 99, action: 'move_linear',
                 derived_from: 'pick', overridden: true }
  const program = { steps: [step], config: {} }
  assert.equal(isTeachable(step, program), true,
    d1('overridden derived step must be independently teachable — '
     + 'the operator claimed the pose, so the itinerary must offer it'))
})


// ── (c) Source-level: row taught-badge gates on isTeachable ─────

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const editorSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'components', 'ProgramEditor.jsx'),
  'utf8')

test('D1(c): row taught-badge visibility gates on isTeachable', () => {
  // The badge JSX (in ProgramEditor.jsx) sets its visibility from
  // isTeachable(step, currentProgram). Either the direct call
  //   visibility: isTeachable(step, currentProgram) ? 'visible' : 'hidden'
  // or a local variable derived from it
  //   const teachable = isTeachable(step, currentProgram)
  //   ...visibility: teachable ? 'visible' : 'hidden'
  // is acceptable — the invariant is that visibility follows the
  // shared predicate, no local re-derivation.
  const badgeBlock = editorSrc.match(
    /data-testid="step-row-taught-badge"[\s\S]{0,600}visibility/)
  assert.ok(badgeBlock,
    d1('step-row taught-badge block must be locatable with a stable testid'))
  const region = editorSrc.slice(
    editorSrc.indexOf('const teachable = isTeachable(step, currentProgram)'),
    editorSrc.indexOf('data-testid="step-row-taught-badge"') + 800)
  const direct = /visibility:\s*isTeachable\(step,\s*currentProgram\)\s*\?/.test(editorSrc)
  const viaLocal = /const teachable\s*=\s*isTeachable\(step,\s*currentProgram\)/
                     .test(editorSrc)
                   && /visibility:\s*teachable\s*\?/.test(region || editorSrc)
  assert.ok(direct || viaLocal,
    d1('row taught-badge visibility must gate on isTeachable(step, currentProgram) — '
     + 'either directly or through a local variable derived from that exact call. '
     + 'No local re-derivation may sneak the badge back onto derived rows.'))
})

test("D1(c): row Teach button hides when isTeachable is false", () => {
  assert.ok(
    /\{!locked && isTeachable\(step,\s*currentProgram\)\s*&&/.test(editorSrc),
    d1('row Teach button must gate on isTeachable(step, currentProgram) — '
     + 'derived rows must not render an independent Teach button'))
})
