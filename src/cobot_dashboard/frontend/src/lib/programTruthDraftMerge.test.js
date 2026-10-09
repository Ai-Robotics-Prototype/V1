// Pinned test for the 2026-08-05 editor-truth directive:
// NOT TAUGHT badges + banner reflect the DRAFT-merged program,
// not the stale saved copy, when a teach session exists.
//
// The merge logic lives inline in ProgramEditor.jsx (stepsMerged)
// because it depends on the teachSession Zustand slice. This test
// pins the SEMANTICS of the merge — record-through means the
// operator teaches N poses, the draft's `poses['step:<id>']` gets
// the taught_joints, and the editor's truth resolver sees taught=
// true immediately. Without the merge, the operator taught five
// and saw six missing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStepTaught, untaughtStepIds, isTeachable }
  from './programTruth.js'


// Standalone merge — mirrors the stepsMerged block in
// ProgramEditor.jsx. If a refactor moves the merge out into a
// shared helper, update this test's import and delete the local
// copy. Until then, the two must match exactly (byte-check the
// commit if in doubt).
function mergeDraftPoses(steps, draftPoses) {
  if (!draftPoses || typeof draftPoses !== 'object') return steps
  const byKey = draftPoses
  let touched = false
  const out = steps.map((s) => {
    const patch = byKey['step:' + s.id]
    if (!patch || typeof patch !== 'object') return s
    touched = true
    const merged = { ...s }
    for (const k of ['taught_joints', 'taught_tcp', 'taught',
                     'pose', 'pose_status']) {
      if (patch[k] !== undefined && patch[k] !== null) merged[k] = patch[k]
    }
    if (Array.isArray(merged.taught_joints)
        && merged.taught_joints.length === 6
        && merged.taught !== true) {
      merged.taught = true
    }
    return merged
  })
  return touched ? out : steps
}


const _sixJoints = [0.1, -1.2, 0.3, -1.5, 0.4, 0.2]


// ── The reported bug: five taught, six claimed missing ─────

test('draft merge: five recorded poses reduce the untaught count', () => {
  // Six move_linear steps, none taught in the saved program.
  const savedSteps = [1, 2, 3, 4, 5, 6].map((id) => ({
    id, action: 'move_linear', position_role: `slot_${id}`,
    taught: false, taught_joints: null,
  }))
  const savedProgram = { steps: savedSteps }
  const savedUntaught = untaughtStepIds(savedProgram)
    .filter((id) => {
      const s = savedSteps.find((x) => x.id === id)
      return s && isTeachable(s, savedProgram)
    })
  assert.equal(savedUntaught.length, 6,
    'saved-only view should show six untaught')

  // The operator's teach session has poses for the first five.
  const draftPoses = {}
  for (const id of [1, 2, 3, 4, 5]) {
    draftPoses['step:' + id] = {
      taught_joints: _sixJoints,
      taught_tcp:    [0.5, 0.5, 0.5, 0, 0, 0],
    }
  }
  const merged = mergeDraftPoses(savedSteps, draftPoses)
  const mergedProgram = { steps: merged }
  const mergedUntaught = untaughtStepIds(mergedProgram)
    .filter((id) => {
      const s = merged.find((x) => x.id === id)
      return s && isTeachable(s, mergedProgram)
    })
  assert.equal(mergedUntaught.length, 1,
    `draft-merged view should show ONE untaught (step 6). ` +
    `Got ${mergedUntaught.length} — the record-through pose was ` +
    `not reflected in the truth resolver.`)
  assert.deepEqual(mergedUntaught, [6],
    'the untaught id should be step 6 (the only unmerged one)')
})


test('draft merge: null / missing poses fall through unchanged', () => {
  const steps = [
    { id: 1, action: 'move_linear', taught: true,
      taught_joints: _sixJoints },
    { id: 2, action: 'move_linear', taught: false, taught_joints: null },
  ]
  // No draft.
  assert.equal(mergeDraftPoses(steps, null), steps,
    'no draft → identity return')
  assert.equal(mergeDraftPoses(steps, undefined), steps)
  assert.equal(mergeDraftPoses(steps, {}), steps,
    'empty draft → identity (no fresh object allocation)')
})


test('draft merge: patch missing taught flag is inferred from joints', () => {
  const steps = [{ id: 1, action: 'move_linear',
                    taught: false, taught_joints: null }]
  const draft = { 'step:1': { taught_joints: _sixJoints } }
  const merged = mergeDraftPoses(steps, draft)
  assert.equal(merged[0].taught, true,
    'a 6-vector merged in should imply taught=true even when the ' +
    'patch omitted the flag')
})


test('draft merge: only step:<id> keys are consumed', () => {
  const steps = [{ id: 1, action: 'move_linear',
                    taught: false, taught_joints: null }]
  // Pallet corner keys (corner:1 etc.) do not touch step poses.
  const draft = {
    'corner:1': { taught_tcp: [0, 0, 0, 0, 0, 0] },
    'corner:part': { taught_tcp: [0.1, 0.1, 0.1, 0, 0, 0] },
  }
  const merged = mergeDraftPoses(steps, draft)
  assert.equal(merged[0].taught, false)
  assert.equal(merged[0].taught_joints, null)
})


test('draft merge: preserves step id + all non-merged fields', () => {
  const steps = [{
    id: 42, action: 'move_linear', label: 'pick from tray',
    position_role: 'pick', speed_pct: 20,
    taught: false, taught_joints: null,
  }]
  const draft = { 'step:42': { taught_joints: _sixJoints, taught: true } }
  const merged = mergeDraftPoses(steps, draft)
  assert.equal(merged[0].id, 42)
  assert.equal(merged[0].label, 'pick from tray')
  assert.equal(merged[0].position_role, 'pick')
  assert.equal(merged[0].speed_pct, 20)
  assert.deepEqual(merged[0].taught_joints, _sixJoints)
  assert.equal(merged[0].taught, true)
})


// ── isStepTaught with merged data reports true on merged step ─

test('isStepTaught reads the merged taught state', () => {
  const rawStep = { id: 5, action: 'move_linear',
                    position_role: 'x', taught: false, taught_joints: null }
  const savedProgram = { steps: [rawStep] }
  assert.equal(isStepTaught(rawStep, savedProgram), false,
    'saved step is not taught')

  const merged = mergeDraftPoses([rawStep], {
    'step:5': { taught_joints: _sixJoints, taught: true },
  })
  const mergedProgram = { steps: merged }
  assert.equal(isStepTaught(merged[0], mergedProgram), true,
    'merged step should be taught — record-through pose reflected')
})
