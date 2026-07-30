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
  palletFrameStatus,
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


// ── palletFrameStatus — modal frame indicator ────────────────────

test('palletFrameStatus: empty program → nothing taught', () => {
  assert.deepEqual(palletFrameStatus({}),
    { cornerA: false, pointB: false, pointC: false, allTaught: false })
})

test('palletFrameStatus: full 3-point frame taught', () => {
  const prog = { config: { pallet_place: {
    corner_a_tcp: [0, 0, 0, 0, 0, 0],
    point_b_tcp:  [100, 0, 0, 0, 0, 0],
    point_c_tcp:  [0, 100, 0, 0, 0, 0],
  }}}
  assert.deepEqual(palletFrameStatus(prog),
    { cornerA: true, pointB: true, pointC: true, allTaught: true })
})

test('palletFrameStatus: only A taught', () => {
  const prog = { config: { pallet_place: {
    corner_a_tcp: [0, 0, 0, 0, 0, 0],
  }}}
  const st = palletFrameStatus(prog)
  assert.equal(st.cornerA, true)
  assert.equal(st.pointB, false)
  assert.equal(st.pointC, false)
  assert.equal(st.allTaught, false)
})

test('palletFrameStatus: legacy corner_tcp {x,y,z,...} seeds A', () => {
  // Pre-2026-07-30 programs stored a single corner as a dict on
  // config.pallet.corner_tcp. The modal cleanup must not drop
  // this operator-authored data — palletFrameStatus reads the
  // legacy field so the "A taught" indicator lights up.
  const prog = { config: { pallet: {
    corner_tcp: { x: 100, y: 200, z: 50, rx: 0, ry: 0, rz: 0 },
  }}}
  const st = palletFrameStatus(prog)
  assert.equal(st.cornerA, true, 'legacy corner_tcp dict must seed cornerA')
  assert.equal(st.pointB, false)
  assert.equal(st.pointC, false)
})

test('palletFrameStatus: legacy corner_tcp with missing xyz keys does NOT seed A', () => {
  const prog = { config: { pallet: {
    corner_tcp: { rx: 0.1 }, // no x/y/z
  }}}
  assert.equal(palletFrameStatus(prog).cornerA, false)
})

test('palletFrameStatus: partial 6-el array does NOT count as taught', () => {
  const prog = { config: { pallet_place: {
    corner_a_tcp: [0, 0, 0],   // only 3 elements — malformed
  }}}
  assert.equal(palletFrameStatus(prog).cornerA, false)
})
