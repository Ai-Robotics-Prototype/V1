// Pinned tests for lib/programTruth — the single source of truth
// every UI surface uses to decide "is this step taught / runnable?"
// and "what verb will actually be emitted?".
//
// See docs/ui_truth_audit.md for the fork history that motivated
// consolidating these into one module.
//
// Any regression here means the Editor's "N untaught" counter, the
// Run modal's Confirm button, and Monitor's run-eligibility can
// disagree with each other AND with what codegen accepts — the
// exact class of bug this module exists to prevent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isStepTaught,
  isProgramFullyRunnable,
  runnableStepCount,
  untaughtStepIds,
  hasFullTaughtPose,
  verbForStep,
  NON_MOTION_ACTIONS,
} from './programTruth.js'

// ── isStepTaught — mirror of dashboard_server._has_taught_poses ──

test('isStepTaught: non-motion actions are always taught', () => {
  for (const act of NON_MOTION_ACTIONS) {
    assert.equal(isStepTaught({ action: act }, { steps: [] }), true,
      `${act} must be treated as taught`)
  }
})

test('isStepTaught: legacy type=gripper marker is taught', () => {
  assert.equal(isStepTaught({ type: 'gripper' }, { steps: [] }), true)
})

test('isStepTaught: point_name → 6-el joints in points table', () => {
  const prog = {
    steps: [],
    points: { pick: { joints: [1, 2, 3, 4, 5, 6] } },
  }
  const step = { action: 'move_linear', point_name: 'pick' }
  assert.equal(isStepTaught(step, prog), true)
})

test('isStepTaught: point_name with 5-el joints is NOT taught (backend requires 6)', () => {
  const prog = {
    steps: [],
    points: { pick: { joints: [1, 2, 3, 4, 5] } },
  }
  const step = { action: 'move_linear', point_name: 'pick' }
  assert.equal(isStepTaught(step, prog), false)
})

test('isStepTaught: taught_joints length===6 requires taught:true', () => {
  const step6 = { action: 'move_linear', taught_joints: [1, 2, 3, 4, 5, 6], taught: true }
  const step6noflag = { action: 'move_linear', taught_joints: [1, 2, 3, 4, 5, 6] }
  const step5 = { action: 'move_linear', taught_joints: [1, 2, 3, 4, 5], taught: true }
  assert.equal(isStepTaught(step6, { steps: [] }), true)
  assert.equal(isStepTaught(step6noflag, { steps: [] }), false)
  assert.equal(isStepTaught(step5, { steps: [] }), false)
})

test('isStepTaught: derived_from role that is taught inline is taught', () => {
  // Pick contact taught inline → approach-above-pick with
  // derived_from:'pick' inherits.
  const prog = {
    steps: [
      { action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
      { action: 'move_linear', position_role: 'pick',
        taught_joints: [1, 2, 3, 4, 5, 6], taught: true },
    ],
  }
  assert.equal(isStepTaught(prog.steps[0], prog), true,
    'approach must inherit from taught pick contact')
  assert.equal(isStepTaught(prog.steps[1], prog), true)
})

test('isStepTaught: derived_from role that is NOT taught is not taught', () => {
  const prog = {
    steps: [
      { action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
      { action: 'move_linear', position_role: 'pick' },  // untaught pick
    ],
  }
  assert.equal(isStepTaught(prog.steps[0], prog), false)
})


// ── isProgramFullyRunnable — one-shot verdict ──

test('isProgramFullyRunnable: empty program is not runnable', () => {
  assert.equal(isProgramFullyRunnable({ steps: [] }), false)
})

test('isProgramFullyRunnable: any untaught → false', () => {
  const prog = {
    steps: [
      { action: 'move_linear', taught_joints: [1, 2, 3, 4, 5, 6], taught: true },
      { action: 'move_linear' /* untaught */ },
    ],
  }
  assert.equal(isProgramFullyRunnable(prog), false)
})

test('isProgramFullyRunnable: all taught → true', () => {
  const prog = {
    steps: [
      { action: 'move_home', taught_joints: [0, 0, 0, 0, 0, 0], taught: true },
      { action: 'set_io', io_id: 'DO1', value: 1 },
      { action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
      { action: 'move_linear', position_role: 'pick',
        taught_joints: [1, 2, 3, 4, 5, 6], taught: true },
    ],
  }
  assert.equal(isProgramFullyRunnable(prog), true)
})


// ── runnableStepCount / untaughtStepIds ──

test('runnableStepCount + untaughtStepIds: mixed program', () => {
  const prog = {
    steps: [
      { id: 1, action: 'move_home', taught_joints: [0, 0, 0, 0, 0, 0], taught: true },
      { id: 2, action: 'set_io', io_id: 'DO1', value: 0 },
      { id: 3, action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
      { id: 4, action: 'move_linear', position_role: 'pick' },   // untaught contact
      { id: 5, action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
    ],
  }
  assert.equal(runnableStepCount(prog), 2,   // home + set_io only
    'derived+pick untaught contact must NOT count as runnable')
  assert.deepEqual(untaughtStepIds(prog), [3, 4, 5])
})


// ── hasFullTaughtPose — 6-el only ──

test('hasFullTaughtPose: length<6 does not count as position data', () => {
  assert.equal(hasFullTaughtPose({ taught_joints: [1, 2, 3, 4, 5] }), false,
    'partial joint arrays are malformed teach data — must not render')
  assert.equal(hasFullTaughtPose({ taught_joints: [1, 2, 3, 4, 5, 6] }), true)
})

test('hasFullTaughtPose: taught_tcp length>=6 counts', () => {
  assert.equal(hasFullTaughtPose({ taught_tcp: [0.1, 0.2, 0.3, 0, 0, 0] }), true)
  assert.equal(hasFullTaughtPose({ taught_tcp: [0.1, 0.2, 0.3] }), false)
})


// ── verbForStep — authoritative vs expected ──

test('verbForStep: prefers program.emitted_verbs when present', () => {
  const prog = {
    steps: [{ action: 'move_linear' }],
    emitted_verbs: [{ verb: 'movJ', reason: 'awkward_wrist_transit' }],
  }
  const v = verbForStep(prog, 0)
  assert.equal(v.verb, 'movJ')
  assert.equal(v.expected, false)
  assert.match(v.reason, /awkward/)
})

test('verbForStep: falls back to expected verb for uncodegen-ed program', () => {
  const prog = { steps: [
    { action: 'move_home' },
    { action: 'move_linear' },
    { action: 'move_joint' },
    { action: 'set_io' },
  ]}
  assert.deepEqual(verbForStep(prog, 0),
    { verb: 'movJ', expected: true, reason: '' })
  assert.deepEqual(verbForStep(prog, 1),
    { verb: 'movL', expected: true, reason: '' })
  assert.deepEqual(verbForStep(prog, 2),
    { verb: 'movJ', expected: true, reason: '' })
  assert.equal(verbForStep(prog, 3).verb, null)
})
