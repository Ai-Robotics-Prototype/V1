// DOCTRINE D5 — One vocabulary module (effector + machine verbs),
// one resolver (programTruth), one teach surface per capability.
//
// Failure format:
//   DOCTRINE D5 VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d5(msg) { return `DOCTRINE D5 VIOLATED: ${msg}` }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..')


test('D5: canonical vocabulary + resolver modules exist under lib/', () => {
  // effector + machine verbs live in ONE module (effectorVocab.js —
  // machine-tending emitters are exported from the same file to
  // keep the vocabulary unified). programTruth.js is the taught-
  // state resolver. Both must exist.
  for (const rel of ['lib/effectorVocab.js', 'lib/programTruth.js']) {
    const full = path.join(FRONTEND_ROOT, 'src', rel)
    assert.ok(fs.existsSync(full),
      d5(`missing canonical module: ${rel}. Vocabulary and truth `
       + `resolvers live under src/lib/, one module per concern.`))
  }
  // Machine-tending vocabulary MUST NOT split back out into a
  // sibling machineVocab.js — the unification is intentional.
  assert.equal(
    fs.existsSync(path.join(FRONTEND_ROOT, 'src', 'lib', 'machineVocab.js')),
    false,
    d5('lib/machineVocab.js reappeared. Machine-tending emitters live '
     + 'INSIDE effectorVocab.js so vacuum + finger templates share the '
     + 'same machine-side steps (see machineVocab.test.js import path).'))
})


test('D5: pallet teach surface exists in exactly one component', () => {
  // The row's Teach button + the diagram-guided flow are the ONE
  // teach surface for pallet frames. A second modal-based teach
  // path would violate D5.
  const editorSrc = fs.readFileSync(
    path.join(FRONTEND_ROOT, 'src', 'components', 'ProgramEditor.jsx'),
    'utf8')
  assert.ok(/function PalletConfigEditor\s*\(/.test(editorSrc),
    d5('PalletConfigEditor must exist as the parameters-only modal'))
  // The retired teach elements MUST stay retired (previously pinned
  // in PalletConfigEditor.pinned.test.js; mirrored here as doctrine).
  const forbidden = ['pallet-frame-status', 'pallet-frame-goto-teaching',
                     'pallet-frame-migrated-notice']
  for (const tok of forbidden) {
    assert.equal(editorSrc.includes(tok), false,
      d5(`retired teach surface '${tok}' reappeared in PalletConfigEditor. `
       + `Teach state lives on the STEP ROW + program findings, never in a modal.`))
  }
})


test('D5: no vocabulary hardcoded outside effectorVocab (labels)', () => {
  // scripts/no-fork-truth.mjs already gates specific hardcoded labels
  // ("Grip part" / "Release part" / "Open Gripper" / "Close Gripper" /
  // "Engage vacuum" ...). D5 pins that the guard exists and covers
  // effectorVocab.
  const guardSrc = fs.readFileSync(
    path.join(FRONTEND_ROOT, 'scripts', 'no-fork-truth.mjs'), 'utf8')
  assert.ok(/effectorVocab/.test(guardSrc),
    d5('scripts/no-fork-truth.mjs must include the effectorVocab guard'))
  assert.ok(/programTruth/.test(guardSrc),
    d5('scripts/no-fork-truth.mjs must include the programTruth guard'))
})


test('D5: one resolver per capability — no parallel exports', () => {
  // Sanity check: the resolver modules export their headline
  // functions exactly once each (no accidental duplicate exports).
  const truthSrc = fs.readFileSync(
    path.join(FRONTEND_ROOT, 'src', 'lib', 'programTruth.js'), 'utf8')
  for (const name of ['isStepTaught', 'isTeachable', 'untaughtStepIds',
                      'palletFrameStatus', 'verbForStep']) {
    const matches = (truthSrc.match(new RegExp(`export function ${name}\\b`, 'g'))
                     || []).length
                  + (truthSrc.match(new RegExp(`export const ${name}\\b`, 'g'))
                     || []).length
    assert.equal(matches, 1,
      d5(`${name} must be exported exactly once from lib/programTruth `
       + `(found ${matches}). Parallel exports fork the resolver.`))
  }
})
