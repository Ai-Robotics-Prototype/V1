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
  firstUntaughtPalletRole,
  PALLET_ROLE_ORDER,
  NON_MOTION_ACTIONS,
  TEACHABLE_ACTIONS,
  isTeachable,
  isDerivedOffsetMove,
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

test('isStepTaught: derived step is trivially taught (source is the truth)', () => {
  // 2026-07-31 unification: a derived step CAN'T be independently
  // taught — its pose resolves at runtime from the source role.
  // So isStepTaught → true (it's not a gap in the itinerary; the
  // operator will teach the source, not this step). Whether the
  // program will actually RUN depends on the source being taught,
  // but that's a runtime concern, not the itinerary question.
  const prog = {
    steps: [
      { action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
      { action: 'move_linear', position_role: 'pick' },  // untaught pick
    ],
  }
  assert.equal(isStepTaught(prog.steps[0], prog), true,
    'derived steps short-circuit via isTeachable → true, so they '
    + 'never appear in the Teach All itinerary')
  // The SOURCE (which IS teachable) is what surfaces as untaught.
  assert.equal(isStepTaught(prog.steps[1], prog), false,
    'the pick contact step is what needs teaching — not the derived')
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
  // 2026-07-31 unification: derived + linked + non-motion all
  // short-circuit isStepTaught → true. Only the teachable-and-
  // untaught rows appear in untaughtStepIds. runnableStepCount
  // counts everything that isn't a teach gap.
  const prog = {
    steps: [
      { id: 1, action: 'move_home', taught_joints: [0, 0, 0, 0, 0, 0], taught: true },
      { id: 2, action: 'set_io', io_id: 'DO1', value: 0 },
      { id: 3, action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
      { id: 4, action: 'move_linear', position_role: 'pick' },   // untaught contact
      { id: 5, action: 'move_linear', derived_from: 'pick', offset_z_mm: 100 },
    ],
  }
  // 1 taught + 1 non-motion + 2 derived = 4 not-in-itinerary. Only
  // id=4 (the untaught pick contact) surfaces as untaught.
  assert.equal(runnableStepCount(prog), 4,
    'home + set_io + two derived steps all short-circuit as "taught" '
    + '— only the teachable-untaught pick contact is a gap')
  assert.deepEqual(untaughtStepIds(prog), [4],
    'only the source pick contact appears — derived steps are '
    + 'inherit-at-runtime and belong to the source, not the itinerary')
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


// ── palletFrameStatus — modal frame indicator (v2 4-point) ──────

test('palletFrameStatus: empty program → nothing taught', () => {
  assert.deepEqual(palletFrameStatus({}),
    { corner1: false, corner2: false, corner3: false, part: false,
      allTaught: false, migratedFromV1: false })
})

test('palletFrameStatus: v2 4-point fully taught', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [0, 0, 0, 0, 0, 0],
    corner2_tcp: [100, 0, 0, 0, 0, 0],
    corner3_tcp: [0, 100, 0, 0, 0, 0],
    part_tcp:    [5, 5, -10, 0, 0, 0],
  }}}
  const st = palletFrameStatus(prog)
  assert.equal(st.corner1, true)
  assert.equal(st.corner2, true)
  assert.equal(st.corner3, true)
  assert.equal(st.part, true)
  assert.equal(st.allTaught, true)
  assert.equal(st.migratedFromV1, false)
})

test('palletFrameStatus: v2 only corners taught (no part) → ④ open', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [0, 0, 0, 0, 0, 0],
    corner2_tcp: [100, 0, 0, 0, 0, 0],
    corner3_tcp: [0, 100, 0, 0, 0, 0],
  }}}
  const st = palletFrameStatus(prog)
  assert.equal(st.corner1, true)
  assert.equal(st.corner2, true)
  assert.equal(st.corner3, true)
  assert.equal(st.part, false)
  assert.equal(st.allTaught, false)
})

test('palletFrameStatus: v1 program migrates to corners, ④ stays OPEN', () => {
  // v1 (3-point A/B/C) programs load into a v2 view: corner1/2/3
  // seed from a/b/c, but part is intentionally NOT lit (the
  // migration seeded part_tcp = corner_a for math preservation
  // only — the operator hasn't taught the real part datum yet).
  // migratedFromV1 flag surfaces the "re-teach ④" nudge.
  const prog = { config: { pallet_place: {
    corner_a_tcp: [0, 0, 0, 0, 0, 0],
    point_b_tcp:  [100, 0, 0, 0, 0, 0],
    point_c_tcp:  [0, 100, 0, 0, 0, 0],
  }}}
  const st = palletFrameStatus(prog)
  assert.equal(st.corner1, true)
  assert.equal(st.corner2, true)
  assert.equal(st.corner3, true)
  assert.equal(st.part, false, 'v1 migration must not claim part is taught')
  assert.equal(st.allTaught, false)
  assert.equal(st.migratedFromV1, true)
})

test('palletFrameStatus: legacy config.pallet.corner_tcp dict seeds ①', () => {
  // Pre-2026-07-30 programs stored a single corner as
  // {x,y,z,rx,ry,rz} on config.pallet.corner_tcp. Only ① lights
  // up from this legacy shape; the operator still needs to teach
  // ②③④ through the wizard.
  const prog = { config: { pallet: {
    corner_tcp: { x: 100, y: 200, z: 50, rx: 0, ry: 0, rz: 0 },
  }}}
  const st = palletFrameStatus(prog)
  assert.equal(st.corner1, true)
  assert.equal(st.corner2, false)
  assert.equal(st.corner3, false)
  assert.equal(st.part, false)
  assert.equal(st.migratedFromV1, true)
})

test('palletFrameStatus: partial 6-el array does NOT count as taught', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [0, 0, 0],   // only 3 elements — malformed
  }}}
  assert.equal(palletFrameStatus(prog).corner1, false)
})

test('palletFrameStatus: only ① missing → part stays open, allTaught false', () => {
  const prog = { config: { pallet_place: {
    corner2_tcp: [100, 0, 0, 0, 0, 0],
    corner3_tcp: [0, 100, 0, 0, 0, 0],
    part_tcp:    [5, 5, -10, 0, 0, 0],
  }}}
  const st = palletFrameStatus(prog)
  assert.equal(st.corner1, false)
  assert.equal(st.allTaught, false)
})


// ── firstUntaughtPalletRole — mid-flow entry point for the pallet
//    Teach button on the step-list row. Powers the "resume at first
//    untaught corner instead of restarting at ①" behavior.

test('firstUntaughtPalletRole: order is c1 → c2 → c3 → part', () => {
  assert.deepEqual(PALLET_ROLE_ORDER,
    ['pallet_c1', 'pallet_c2', 'pallet_c3', 'pallet_part'])
})

test('firstUntaughtPalletRole: fresh program → pallet_c1', () => {
  assert.equal(firstUntaughtPalletRole({}), 'pallet_c1')
})

test('firstUntaughtPalletRole: ① taught, ② untaught → pallet_c2', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [100, 0, 0, 0, 0, 0],
  }}}
  assert.equal(firstUntaughtPalletRole(prog), 'pallet_c2')
})

test('firstUntaughtPalletRole: ①② taught, ③ untaught → pallet_c3', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [100, 0, 0, 0, 0, 0],
    corner2_tcp: [500, 0, 0, 0, 0, 0],
  }}}
  assert.equal(firstUntaughtPalletRole(prog), 'pallet_c3')
})

test('firstUntaughtPalletRole: ①②③ taught, ④ open → pallet_part', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [100, 0, 0, 0, 0, 0],
    corner2_tcp: [500, 0, 0, 0, 0, 0],
    corner3_tcp: [100, 400, 0, 0, 0, 0],
  }}}
  assert.equal(firstUntaughtPalletRole(prog), 'pallet_part')
})

test('firstUntaughtPalletRole: fully taught → null (caller starts Re-teach at ①)', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [100, 0, 0, 0, 0, 0],
    corner2_tcp: [500, 0, 0, 0, 0, 0],
    corner3_tcp: [100, 400, 0, 0, 0, 0],
    part_tcp:    [100, 0, 50, 0, 0, 0],
  }}}
  assert.equal(firstUntaughtPalletRole(prog), null)
})

test('firstUntaughtPalletRole: v1-migrated program → pallet_part (④ still needed)', () => {
  const prog = { config: { pallet_place: {
    corner_a_tcp: [100, 0, 0, 0, 0, 0],
    point_b_tcp:  [500, 0, 0, 0, 0, 0],
    point_c_tcp:  [100, 400, 0, 0, 0, 0],
  }}}
  assert.equal(firstUntaughtPalletRole(prog), 'pallet_part',
    'v1 saves migrate corners but leave ④ open; Teach must resume there')
})


// ── isTeachable + itinerary unification — 2026-07-31 (§396 audit) ─
// The bug: `detect` (a camera op) appeared as Step 2 of 7 in
// Palletize1's Teach All, prompting a pose recording for a step
// that doesn't take one. Root cause: row used an ALLOW-LIST
// (TEACHABLE_ACTIONS), untaughtStepIds used a DENY-LIST
// (NON_MOTION_ACTIONS) — and `detect` was in neither. Unified:
// isTeachable() is the single predicate; isStepTaught treats
// !isTeachable as trivially "taught" so the itinerary matches
// the row without a separate list to keep in sync.

test('TEACHABLE_ACTIONS is the pose-bearing set — everything else is not-teachable', () => {
  for (const a of ['move_home', 'move_joint', 'move_linear',
                   'approach', 'pick', 'place']) {
    assert.ok(TEACHABLE_ACTIONS.has(a), `${a} must be teachable`)
  }
  // Non-pose actions must NOT be teachable.
  for (const a of ['detect', 'set_io', 'wait', 'loop',
                   'gripper_open', 'gripper_close', 'vacuum_on',
                   'move_to_pallet',
                   'scan_workspace', 'scan_identify_each',
                   'sort_scanned', 'remove_defects']) {
    assert.equal(TEACHABLE_ACTIONS.has(a), false,
      `${a} is a non-pose action and must NOT be in TEACHABLE_ACTIONS`)
  }
})

test('isTeachable: detect / wait / set_io / loop / gripper / move_to_pallet → false', () => {
  for (const action of ['detect', 'wait', 'set_io', 'loop',
                        'gripper_open', 'gripper_close', 'vacuum_on',
                        'move_to_pallet',
                        'scan_workspace', 'sort_scanned']) {
    assert.equal(isTeachable({ action }), false,
      `${action} is not pose-bearing — must not be teachable`)
  }
})

test('isTeachable: pose-bearing actions → true (unless derived / linked)', () => {
  for (const action of ['move_home', 'move_joint', 'move_linear',
                        'approach', 'pick', 'place']) {
    assert.equal(isTeachable({ action }), true,
      `${action} takes a pose — must be teachable by default`)
  }
})

test('isTeachable: derived offset moves → false (inherit at runtime)', () => {
  // derived_from set → derived
  assert.equal(isTeachable({ action: 'move_linear', derived_from: 'pick' }), false)
  // overridden derived → teachable (operator claims the pose)
  assert.equal(isTeachable({
    action: 'move_linear', derived_from: 'pick', overridden: true,
  }), true, 'overridden derived steps become teachable again')
})

test('isTeachable: position_ref links → false (source is the truth)', () => {
  assert.equal(isTeachable({ action: 'move_linear', position_ref: 2 }), false,
    'linked steps must not be teachable — re-teach the source')
})

test('isDerivedOffsetMove: explicit derived_from beats override', () => {
  assert.equal(isDerivedOffsetMove({ derived_from: 'pick' }), true)
  assert.equal(isDerivedOffsetMove({ derived_from: 'pick', overridden: true }),
    false, 'overridden clears the derived-treatment')
})


// ── isStepTaught short-circuit — the anti-fork fix ─────────────

test('isStepTaught: non-teachable actions → true (nothing to teach)', () => {
  // The whole point of the 2026-07-31 unification: anything the
  // row doesn't offer a Teach button on is NOT a gap in the
  // itinerary either.
  for (const action of ['detect', 'set_io', 'wait', 'loop',
                        'move_to_pallet', 'scan_workspace']) {
    assert.equal(isStepTaught({ action }, { steps: [] }), true,
      `${action} must be treated as taught (short-circuit via isTeachable)`)
  }
})

test('isStepTaught: derived offset moves → true (inherit at runtime)', () => {
  assert.equal(
    isStepTaught({ action: 'move_linear', derived_from: 'pick' },
                 { steps: [] }),
    true,
    'derived steps are trivially taught — the operator teaches the source')
})

test('isStepTaught: position_ref links → true', () => {
  assert.equal(
    isStepTaught({ action: 'move_linear', position_ref: 2 },
                 { steps: [] }),
    true,
    'linked steps are trivially taught — source carries the pose')
})


// ── untaughtStepIds — the itinerary builder ────────────────────

test('untaughtStepIds excludes detect / wait / set_io / loop / gripper', () => {
  const program = { steps: [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'detect' },
    { id: 3, action: 'wait',   duration_s: 1 },
    { id: 4, action: 'set_io', io_id: 1, value: true },
    { id: 5, action: 'loop',   count: 3 },
    { id: 6, action: 'gripper_close' },
    { id: 7, action: 'move_linear' },
  ]}
  const ids = untaughtStepIds(program)
  assert.deepEqual(ids, [1, 7],
    'itinerary must contain ONLY teachable pose-bearing steps — '
    + 'detect / wait / set_io / loop / gripper never appear')
})

test('untaughtStepIds excludes move_to_pallet and derived moves', () => {
  const program = { steps: [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'move_linear' },                       // taught
    { id: 3, action: 'move_linear', derived_from: 'pick' }, // derived
    { id: 4, action: 'move_linear', position_ref: 2 },      // linked
    { id: 5, action: 'move_to_pallet' },                    // config-driven
  ]}
  const ids = untaughtStepIds(program)
  assert.deepEqual(ids, [1, 2],
    'derived / linked / move_to_pallet stay out of the itinerary — '
    + 'the operator teaches sources, not runtime resolutions')
})

test('untaughtStepIds mirrors the Palletize1 audit exactly', () => {
  // 2026-07-31 field audit — palletize1 on disk had 10 steps and
  // the itinerary built to 7 (WRONG, prompting for detect + both
  // derived approach/retreat + move_to_pallet + second home).
  //
  // After the unification + auto-share-home + retreat-is-derived
  // fixes, the step-list itinerary is EXACTLY two IDs:
  //   1: move_home (start)                       — teachable
  //   4: move_linear "Pick position — contact"   — teachable
  // Every other step is non-teachable:
  //   2  detect            — camera op, no pose
  //   3  approach derived  — derived_from='pick'
  //   5  set_io / 6 wait / 9 loop — non-motion
  //   7  retreat derived   — derived_from='pick'
  //   8  move_to_pallet    — config-driven
  //   10 return home       — auto-shares first move_home's pose
  //
  // The pallet corners ①②③④ come in via the debt resolver, not
  // untaughtStepIds — those are program.config state, not steps.
  const program = { steps: [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'detect' },
    { id: 3, action: 'move_linear', derived_from: 'pick', label: 'Approach above pick' },
    { id: 4, action: 'move_linear', taught: false, label: 'Pick position — contact' },
    { id: 5, action: 'set_io' },
    { id: 6, action: 'wait' },
    { id: 7, action: 'move_linear', derived_from: 'pick', label: 'Retreat above pick' },
    { id: 8, action: 'move_to_pallet' },
    { id: 9, action: 'loop' },
    { id: 10, action: 'move_home', label: 'Return to home' },
  ]}
  assert.deepEqual(untaughtStepIds(program), [1, 4],
    'Palletize1 audit: itinerary drops from 7 (buggy) to EXACTLY 2 '
    + 'teachable step IDs. Approach + retreat both derived → both '
    + 'skipped. Second move_home auto-shares → skipped.')
})

test('untaughtStepIds: both approach AND retreat derived steps stay out', () => {
  // The addendum called this out explicitly: whether the derived
  // Z-offset is positive (retreat +200mm) or negative (approach
  // -100mm), the step is derived and MUST NOT appear.
  const program = { steps: [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'move_linear', derived_from: 'pick', offset_z_mm: -100 },  // approach
    { id: 3, action: 'move_linear', taught: false },                             // pick contact
    { id: 4, action: 'move_linear', derived_from: 'pick', offset_z_mm:  200 },  // retreat
  ]}
  assert.deepEqual(untaughtStepIds(program), [1, 3],
    'both approach (-100) and retreat (+200) derived from the same '
    + 'source stay out — the predicate is symmetric on sign')
})


// ── The anti-fork invariant: row set === itinerary set ────────

test('for every step: NOT-isTeachable ⇒ isStepTaught (row/itinerary agree)', () => {
  // Sample every action verb we know about + a few edge shapes.
  const program = { steps: [], points: {} }
  const cases = [
    { action: 'move_home' },
    { action: 'move_linear' },
    { action: 'move_linear', derived_from: 'pick' },
    { action: 'move_linear', position_ref: 2 },
    { action: 'move_linear', overridden: true, derived_from: 'pick' },
    { action: 'detect' },
    { action: 'wait' },
    { action: 'set_io' },
    { action: 'loop' },
    { action: 'gripper_open' },
    { action: 'gripper_close' },
    { action: 'vacuum_on' },
    { action: 'move_to_pallet' },
    { action: 'scan_workspace' },
    { action: 'sort_scanned' },
  ]
  for (const step of cases) {
    if (!isTeachable(step, program)) {
      assert.equal(isStepTaught(step, program), true,
        `INVARIANT — row hides Teach for ${JSON.stringify(step)}, so `
        + 'itinerary must skip it (isStepTaught → true short-circuit)')
    }
  }
})


// ── Auto-share home: later move_home shares first's pose ──────

test('isTeachable(later move_home) → false when program has an earlier move_home', () => {
  const program = { steps: [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'move_linear' },
    { id: 3, action: 'move_home' },        // return home
  ]}
  // First home: teachable (source of truth).
  assert.equal(isTeachable(program.steps[0], program), true,
    'first move_home is the pose source — always teachable')
  // Later home: not teachable (auto-shares).
  assert.equal(isTeachable(program.steps[2], program), false,
    'later move_home inherits from the first — not independently teachable')
})

test('isTeachable(later move_home) with overridden=true → true (opt back in)', () => {
  const program = { steps: [
    { id: 1, action: 'move_home' },
    { id: 2, action: 'move_home', overridden: true },  // operator explicit override
  ]}
  assert.equal(isTeachable(program.steps[1], program), true,
    'overridden=true is the operator opting out of the auto-share')
})

test('isTeachable(move_home) without program context → true (no siblings visible)', () => {
  // Callers that lack program context (unit tests, migrations)
  // get the step-local answer — the auto-share rule requires the
  // program to compare against.
  assert.equal(isTeachable({ action: 'move_home' }), true)
})
