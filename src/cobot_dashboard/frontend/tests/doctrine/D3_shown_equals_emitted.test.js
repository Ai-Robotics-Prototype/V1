// DOCTRINE D3 — A verb SHOWN ≠ verb EMITTED is a LIE unless the
// divergence + reason is displayed.
//
// Failure format:
//   DOCTRINE D3 VIOLATED: <detail>
//
// Phase-1 coverage:
//  (a) verbForStep returns { verb, expected, reason } — when
//      emitted_verbs is present, expected: false + verb is the
//      emitted value.
//  (b) verbForStep falls back to the action-implied verb only when
//      the emitted table is absent, and marks expected: true so the
//      caller can render the "expected only" caveat.
//  (c) Source-level: TypeChip (the row's verb label) reads verbForStep
//      output and surfaces both `verb` and `expected` flag.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { verbForStep } from '../../src/lib/programTruth.js'


function d3(msg) { return `DOCTRINE D3 VIOLATED: ${msg}` }


test('D3(a): with emitted_verbs → shown = emitted, expected=false, reason threaded', () => {
  const prog = {
    steps: [{ id: 1, action: 'move_linear', derived_from: 'pick' }],
    emitted_verbs: [
      { verb: 'movJ', reason: 'awkward wrist — cartesian arrival blocked' },
    ],
  }
  const v = verbForStep(prog, 0)
  assert.equal(v.verb, 'movJ',
    d3(`shown verb '${v.verb}' does not match emitted 'movJ' — the row `
     + `lied about what codegen wrote`))
  assert.equal(v.expected, false,
    d3(`expected flag must be false when emitted_verbs is authoritative — `
     + `the row should NOT render the "expected only" caveat`))
  assert.ok(v.reason && v.reason.length > 0,
    d3(`reason must be threaded when the emitted verb diverges from action — `
     + `no reason = no explanation to the operator`))
})

test('D3(b): without emitted_verbs → shown = action-implied, expected=true', () => {
  const prog = {
    steps: [{ id: 1, action: 'move_linear', derived_from: 'pick' }],
    // no emitted_verbs
  }
  const v = verbForStep(prog, 0)
  assert.equal(v.verb, 'movL',
    d3(`no emitted_verbs → verb should be the action-implied fallback`))
  assert.equal(v.expected, true,
    d3(`expected must be true so the row can render "expected only — `
     + `program hasn't been codegen'd yet" copy. Silent fallback lies.`))
})


// ── (c) Source-level: TypeChip surfaces `expected` flag ─────────

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const editorSrc = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'components', 'ProgramEditor.jsx'),
  'utf8')

test('D3(c): editor reads verbForStep output (verb + expected)', () => {
  // The row-render code must consume verbForStep so both the verb
  // AND the expected flag are visible. If the editor only reads
  // step.action for its label, an analyzer swap silently disappears
  // — the operator sees "MOVE LINEAR" while codegen emitted movJ.
  assert.ok(/verbForStep\(/.test(editorSrc),
    d3('ProgramEditor must call verbForStep to render step verb labels — '
     + 'reading step.action directly is a documented D3 violation'))
})
