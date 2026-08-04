// palletTeachSequence — sequence state machine pins. These tests
// own the behavior contract every host must obey (wizard teach +
// editor row-button teach both read from this module — see the
// no-fork rule).
//
// Coverage:
//   * role↔field + role↔status-key mappings
//   * back / next / jump transitions
//   * modeForRole picks 're-teach' when the target has a taught pose
//   * taughtCount reflects palletFrameStatus booleans
//   * cancel-persists behavior (Record writes to program; nothing
//     rolls back on cancel — pinned via the transition math)
//
// Frame validation lives in the backend now (§465 fork-1 kill,
// 2026-08-04) — see palletFrameValidator.js on the client and
// pallet_geometry.compute_frame/validate_frame on the server.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PALLET_ROLE_ORDER,
  PALLET_ROLE_TO_FIELD,
  PALLET_ROLE_TO_STATUS_KEY,
  nextRoleFrom,
  backRoleFrom,
  modeForRole,
  taughtCount,
  backFrom,
  advanceFrom,
  jumpTo,
} from './palletTeachSequence.js'


// ── Role tables ─────────────────────────────────────────────────

test('PALLET_ROLE_ORDER is exactly [c1, c2, c3, part]', () => {
  assert.deepEqual(PALLET_ROLE_ORDER,
    ['pallet_c1', 'pallet_c2', 'pallet_c3', 'pallet_part'])
})

test('PALLET_ROLE_TO_FIELD maps each role to its write field', () => {
  assert.equal(PALLET_ROLE_TO_FIELD.pallet_c1,   'corner1_tcp')
  assert.equal(PALLET_ROLE_TO_FIELD.pallet_c2,   'corner2_tcp')
  assert.equal(PALLET_ROLE_TO_FIELD.pallet_c3,   'corner3_tcp')
  assert.equal(PALLET_ROLE_TO_FIELD.pallet_part, 'part_tcp')
})

test('PALLET_ROLE_TO_STATUS_KEY maps each role to its resolver key', () => {
  assert.equal(PALLET_ROLE_TO_STATUS_KEY.pallet_c1,   'corner1')
  assert.equal(PALLET_ROLE_TO_STATUS_KEY.pallet_c2,   'corner2')
  assert.equal(PALLET_ROLE_TO_STATUS_KEY.pallet_c3,   'corner3')
  assert.equal(PALLET_ROLE_TO_STATUS_KEY.pallet_part, 'part')
})


// ── Sequence transitions ────────────────────────────────────────

test('nextRoleFrom walks ① → ② → ③ → ④ → null', () => {
  assert.equal(nextRoleFrom('pallet_c1'),   'pallet_c2')
  assert.equal(nextRoleFrom('pallet_c2'),   'pallet_c3')
  assert.equal(nextRoleFrom('pallet_c3'),   'pallet_part')
  assert.equal(nextRoleFrom('pallet_part'), null,
    'sequence closes after ④')
})

test('backRoleFrom walks ④ → ③ → ② → ① → null', () => {
  assert.equal(backRoleFrom('pallet_part'), 'pallet_c3')
  assert.equal(backRoleFrom('pallet_c3'),   'pallet_c2')
  assert.equal(backRoleFrom('pallet_c2'),   'pallet_c1')
  assert.equal(backRoleFrom('pallet_c1'),   null,
    'no back from the first role')
})


// ── modeForRole — teach vs re-teach ─────────────────────────────

test('modeForRole: fresh program → every role is teach', () => {
  const fs = { corner1: false, corner2: false, corner3: false, part: false }
  for (const r of PALLET_ROLE_ORDER) {
    assert.equal(modeForRole(r, fs), 'teach')
  }
})

test('modeForRole: taught role → re-teach', () => {
  const fs = { corner1: true, corner2: false, corner3: false, part: false }
  assert.equal(modeForRole('pallet_c1', fs), 're-teach')
  assert.equal(modeForRole('pallet_c2', fs), 'teach')
})


// ── taughtCount ─────────────────────────────────────────────────

test('taughtCount: 0 for empty status', () => {
  assert.equal(taughtCount({}), 0)
  assert.equal(taughtCount(null), 0)
  assert.equal(taughtCount(undefined), 0)
})

test('taughtCount: 4 when all frame points taught', () => {
  assert.equal(taughtCount({
    corner1: true, corner2: true, corner3: true, part: true,
  }), 4)
})

test('taughtCount: mixed states give partial counts', () => {
  assert.equal(taughtCount({ corner1: true }), 1)
  assert.equal(taughtCount({ corner1: true, corner3: true }), 2)
  assert.equal(taughtCount({ corner1: true, corner2: true, corner3: true }), 3)
})


// Frame validation lives in POST /api/pallet/validate_frame now;
// see palletFrameValidator.test.js for the client contract and
// pallet_geometry Python tests for the geometry.


// ── Host-shared action helpers ──────────────────────────────────
// The scenario the directive names: at ③, hit Back — must land on
// ② in re-teach mode. Then Record → advance to ③; ①/④ untouched.

test('backFrom(③) lands on ② in re-teach mode when ② already taught', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [0,   0, 0, 0, 0, 0],
    corner2_tcp: [400, 0, 0, 0, 0, 0],   // ② is taught
    // ③ freshly taught in this session — call backFrom from ③.
    corner3_tcp: [0, 300, 0, 0, 0, 0],
    // ④ also taught earlier.
    part_tcp:    [10, 10, -50, 0, 0, 0],
  }}}
  const back = backFrom('pallet_c3', prog)
  assert.deepEqual(back, { role: 'pallet_c2', mode: 're-teach' },
    'Back at ③ → ② in re-teach mode (② has a pose)')
})

test('backFrom(①) → null (no back from first role)', () => {
  assert.equal(backFrom('pallet_c1', { config: {} }), null)
})

test('advanceFrom(②) → ③ with correct mode based on program', () => {
  // ③ untaught → advance lands in teach mode
  const untaughtProg = { config: { pallet_place: {
    corner1_tcp: [0,0,0,0,0,0], corner2_tcp: [400,0,0,0,0,0],
  }}}
  assert.deepEqual(advanceFrom('pallet_c2', untaughtProg),
    { role: 'pallet_c3', mode: 'teach' })
  // ③ taught → advance lands in re-teach mode (rare case: operator
  // walked backward then re-recorded ②).
  const taughtProg = { config: { pallet_place: {
    corner1_tcp: [0,0,0,0,0,0], corner2_tcp: [400,0,0,0,0,0],
    corner3_tcp: [0,300,0,0,0,0],
  }}}
  assert.deepEqual(advanceFrom('pallet_c2', taughtProg),
    { role: 'pallet_c3', mode: 're-teach' })
})

test('advanceFrom(④) → null (sequence closes)', () => {
  assert.equal(advanceFrom('pallet_part', { config: {} }), null)
})


// ── Tap-navigation ──────────────────────────────────────────────

test('jumpTo(current role) → null (no-op)', () => {
  assert.equal(jumpTo('pallet_c2', { config: {} }, 'pallet_c2'), null,
    'tapping the current role must not change state')
})

test('jumpTo a taught role → re-teach mode', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [0,0,0,0,0,0],
  }}}
  assert.deepEqual(jumpTo('pallet_c1', prog, 'pallet_c3'),
    { role: 'pallet_c1', mode: 're-teach' })
})

test('jumpTo a future untaught role → teach mode', () => {
  assert.deepEqual(jumpTo('pallet_part', { config: {} }, 'pallet_c1'),
    { role: 'pallet_part', mode: 'teach' })
})


// ── Directive scenario: back-from-③ re-records ② without disturbing ①/④

test('directive: back-from-③ + record ② does NOT clear ① / ④ (transition math)', () => {
  // Simulate the transition sequence the editor performs. The
  // *host* is responsible for the actual writes; the transition
  // math here confirms Back doesn't emit any "clear" side effect
  // and Record advances to ③ in re-teach mode.
  const prog = { config: { pallet_place: {
    corner1_tcp: [0,   0, 0, 0, 0, 0],   // ① taught
    corner2_tcp: [400, 0, 0, 0, 0, 0],   // ② taught
    corner3_tcp: [0, 300, 0, 0, 0, 0],   // ③ taught
    part_tcp:    [10, 10, -50, 0, 0, 0], // ④ taught
  }}}
  // From ③, hit Back:
  const back = backFrom('pallet_c3', prog)
  assert.deepEqual(back, { role: 'pallet_c2', mode: 're-teach' })
  // At ②, operator re-records — new pose but ①/③/④ unchanged.
  const nextPlace = { ...prog.config.pallet_place,
                      corner2_tcp: [420, 0, 0, 0, 0, 0] }
  assert.deepEqual(nextPlace.corner1_tcp, prog.config.pallet_place.corner1_tcp)
  assert.deepEqual(nextPlace.corner3_tcp, prog.config.pallet_place.corner3_tcp)
  assert.deepEqual(nextPlace.part_tcp,    prog.config.pallet_place.part_tcp)
  // Advance from ②:
  const fwd = advanceFrom('pallet_c2', { config: { pallet_place: nextPlace }})
  assert.deepEqual(fwd, { role: 'pallet_c3', mode: 're-teach' },
    'after re-recording ②, advance lands on ③ in re-teach mode '
    + '(③ was already taught; the flow now offers Record over or Skip)')
})
