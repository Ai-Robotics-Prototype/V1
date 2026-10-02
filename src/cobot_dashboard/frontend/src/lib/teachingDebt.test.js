// teachingDebt — one resolver, one banner. The 2026-07-31
// consolidation directive: "N positions not taught" + the legacy
// "re-teach ④" info are the same concern. Merge them behind a
// single count with one severity carrying the nuance.
//
// These tests own the debt-shape contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTeachingDebt, debtBannerLabel } from './teachingDebt.js'


// ── Empty / fully-taught programs → no debt, no banner ─────────

test('empty program → total 0, severity null (no banner)', () => {
  const d = computeTeachingDebt({})
  assert.equal(d.total, 0)
  assert.equal(d.severity, null)
  assert.deepEqual(d.stepIds, [])
  assert.deepEqual(d.palletReTeaches, [])
})

test('fully-taught v2 program → no debt', () => {
  const prog = {
    steps: [],
    config: { pallet_place: {
      corner1_tcp: [0,   0, 0, 0, 0, 0],
      corner2_tcp: [400, 0, 0, 0, 0, 0],
      corner3_tcp: [0, 300, 0, 0, 0, 0],
      part_tcp:    [10, 10, -50, 0, 0, 0],
    }},
  }
  const d = computeTeachingDebt(prog)
  assert.equal(d.total, 0)
  assert.equal(d.severity, null,
    'fully-taught program shows no banner')
})


// ── Untaught steps → severity=error (red banner blocks Run) ─────

test('program with untaught steps → severity=error', () => {
  // A move step without taught_joints — the untaught-steps resolver
  // picks it up.
  const prog = {
    steps: [
      { id: 1, action: 'move_home', taught: false },
      { id: 2, action: 'move_linear', taught: false },
    ],
    config: {},
  }
  const d = computeTeachingDebt(prog)
  assert.equal(d.severity, 'error',
    'any untaught step is BLOCKING — banner must be red')
  assert.ok(d.stepIds.length >= 1,
    'stepIds must include the untaught move step')
  assert.equal(d.total, d.stepIds.length + d.palletReTeaches.length)
})


// ── Owed re-teaches only → severity=warn (amber, improve owed) ─

test('legacy v1 program with no untaught steps → severity=warn (only re-teach owed)', () => {
  const prog = {
    steps: [],                          // no motion steps, nothing untaught
    config: { pallet_place: {
      corner_a_tcp: [100, 0, 0, 0, 0, 0],
      point_b_tcp:  [500, 0, 0, 0, 0, 0],
      point_c_tcp:  [100, 400, 0, 0, 0, 0],
    }},
  }
  const d = computeTeachingDebt(prog)
  assert.equal(d.severity, 'warn',
    'only quality re-teach outstanding → amber, not red')
  assert.deepEqual(d.stepIds, [])
  assert.equal(d.palletReTeaches.length, 1)
  const owed = d.palletReTeaches[0]
  assert.equal(owed.role, 'pallet_part',
    'the owed re-teach targets ④ (part datum)')
  assert.equal(owed.findingId, 'pallet-legacy-migration',
    'debt item names the corresponding finding so hosts can link '
    + 'the itinerary caption to the finding record')
  assert.ok(/real part in slot \[1,1\]/.test(owed.reason),
    'reason must direct the operator to place a real part in [1,1]')
})


// ── Mixed: untaught steps + owed re-teach → severity=error ─────

test('mixed: untaught steps + owed re-teach → severity=error, total sums both', () => {
  const prog = {
    // Three untaught move steps.
    steps: [
      { id: 1, action: 'move_home',   taught: false },
      { id: 2, action: 'move_linear', taught: false },
      { id: 3, action: 'move_linear', taught: false },
    ],
    // Legacy pallet → one owed re-teach on top.
    config: { pallet_place: {
      corner_a_tcp: [100, 0, 0, 0, 0, 0],
      point_b_tcp:  [500, 0, 0, 0, 0, 0],
      point_c_tcp:  [100, 400, 0, 0, 0, 0],
    }},
  }
  const d = computeTeachingDebt(prog)
  assert.equal(d.severity, 'error',
    'any untaught step wins over an owed re-teach — red banner')
  assert.equal(d.total, d.stepIds.length + d.palletReTeaches.length)
  // Directive: "Palletize1 should read '4 positions need teaching'
  // (3 untaught + ④ re-teach)". Verify the exact scenario.
  assert.equal(d.total, 4,
    '3 untaught steps + 1 owed re-teach → total 4')
})


// ── Completing ④ drops the count + flips severity to null ──────

test('completing ④ drops the count and clears the banner', () => {
  // Start on a program that has only the ④ re-teach outstanding.
  const v1prog = {
    steps: [],
    config: { pallet_place: {
      corner_a_tcp: [100, 0, 0, 0, 0, 0],
      point_b_tcp:  [500, 0, 0, 0, 0, 0],
      point_c_tcp:  [100, 400, 0, 0, 0, 0],
    }},
  }
  assert.equal(computeTeachingDebt(v1prog).severity, 'warn',
    'sanity: v1 program shows the amber banner')
  // Operator walks the pallet teach flow, writes v2 fields incl.
  // part_tcp. migratedFromV1 flips false → owed re-teach disappears.
  const v2prog = {
    steps: [],
    config: { pallet_place: {
      ...v1prog.config.pallet_place,
      corner1_tcp: [100, 0, 0, 0, 0, 0],
      corner2_tcp: [500, 0, 0, 0, 0, 0],
      corner3_tcp: [100, 400, 0, 0, 0, 0],
      part_tcp:    [100, 0, 50, 0, 0, 0],
    }},
  }
  const cleared = computeTeachingDebt(v2prog)
  assert.equal(cleared.total, 0,
    'debt total drops to 0 once ④ is re-taught')
  assert.equal(cleared.severity, null,
    'severity flips to null → banner disappears')
})


// ── Banner label helper ─────────────────────────────────────────

test('debtBannerLabel: empty → empty string', () => {
  assert.equal(debtBannerLabel({ total: 0 }), '')
  assert.equal(debtBannerLabel(null), '')
})

test('debtBannerLabel: 1 → singular, 2+ → plural', () => {
  assert.equal(debtBannerLabel({ total: 1 }), '1 position needs teaching')
  assert.equal(debtBannerLabel({ total: 4 }), '4 positions need teaching')
})


// ── Palletize1: the EXACT six ─────────────────────────────────
// Addendum directive (2026-07-31): "The itinerary for this program
// is exactly: home, pick contact, frame ①②③④ — six. Nothing else."
// This test enumerates the exact six for a Palletize1-shaped
// program and pins the count + composition against every future
// change to the resolvers.

test("Palletize1 itinerary: exactly six — 1 home + 1 pick + 4 corners", () => {
  // Match the on-disk shape of palletize1.json (2026-07-31 field
  // audit): 10 steps + a pallet config with the zero-init legacy
  // corner_tcp placeholder (which does NOT count as a taught corner
  // — the placeholder was the wizard's cruft, not a real teach).
  const program = {
    steps: [
      { id: 1,  action: 'move_home',      label: 'Move to home position' },
      { id: 2,  action: 'detect',         label: 'Find library part' },
      { id: 3,  action: 'move_linear',    label: 'Approach above pick', derived_from: 'pick' },
      { id: 4,  action: 'move_linear',    label: 'Pick position — contact', taught: false },
      { id: 5,  action: 'set_io',         label: 'Grip part' },
      { id: 6,  action: 'wait',           label: 'Wait for vacuum seal' },
      { id: 7,  action: 'move_linear',    label: 'Retreat above pick', derived_from: 'pick' },
      { id: 8,  action: 'move_to_pallet', label: 'Place at pallet slot' },
      { id: 9,  action: 'loop',           label: 'Pallet loop — 4 cycles' },
      { id: 10, action: 'move_home',      label: 'Return to home' },
    ],
    config: {
      pallet: { corner_tcp: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 } },
      pallet_place: { rows: 2, cols: 2, layers: 1 },
    },
  }

  const debt = computeTeachingDebt(program)

  // — Total is EXACTLY six —
  assert.equal(debt.total, 6,
    '"exactly six" per the directive: 1 home + 1 pick contact + 4 corners')

  // — Step-list slice: exactly 2 (step 1 + step 4). No approach
  //   (step 3), no retreat (step 7), no move_to_pallet (step 8),
  //   no second home (step 10). No detect. No set_io. No wait.
  //   No loop.
  assert.deepEqual(debt.stepIds, [1, 4],
    'itinerary steps: FIRST move_home (id=1) + Pick contact (id=4). '
    + 'Approach/retreat both derived → out. Second home auto-shares → out.')

  // — Pallet slice: exactly 4 corners in canonical ①②③④ order.
  const roles = debt.palletReTeaches.map((r) => r.role)
  assert.deepEqual(roles,
    ['pallet_c1', 'pallet_c2', 'pallet_c3', 'pallet_part'],
    'pallet corners: ①②③④ all untaught (zero-init corner_tcp does NOT count)')

  // — Severity is 'error' because there are untaught pose-bearing
  //   steps (moves + corners aren't "quality re-teaches", they're
  //   fresh teaches).
  assert.equal(debt.severity, 'error')
})


// ── Zero-init legacy corner_tcp doesn't count as taught ──────

test('legacy corner_tcp={0,0,0,...} does NOT count as corner1 taught', () => {
  // Directly test the palletFrameStatus fix that makes the
  // "exactly six" enumeration work: a zero-init placeholder is
  // NOT a real teach.
  const prog = { config: { pallet: {
    corner_tcp: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
  }, pallet_place: { rows: 2, cols: 2 } } }
  const debt = computeTeachingDebt(prog)
  // All four corners appear as owed teaches.
  assert.equal(debt.palletReTeaches.length, 4,
    'zero-init placeholder → ①②③④ all owed, none pre-satisfied')
  const c1 = debt.palletReTeaches.find((r) => r.role === 'pallet_c1')
  assert.ok(c1, 'pallet_c1 must be in the owed list')
  assert.notEqual(c1.findingId, 'pallet-legacy-migration',
    'a fresh teach is NOT a legacy-migration finding — that only '
    + 'fires when real v1 corner_a values were present')
})

test('legacy corner_tcp with non-zero value → counted as corner1 taught (real legacy)', () => {
  const prog = { config: { pallet: {
    corner_tcp: { x: 250, y: 100, z: 30, rx: 0, ry: 0, rz: 0 },
  }, pallet_place: { rows: 2, cols: 2 } } }
  const debt = computeTeachingDebt(prog)
  // corner1 counts (via legacy migration path). corners 2/3 + part
  // still owed. part carries the migration reason.
  assert.equal(debt.palletReTeaches.length, 3)
  const roles = debt.palletReTeaches.map((r) => r.role)
  assert.deepEqual(roles, ['pallet_c2', 'pallet_c3', 'pallet_part'],
    'only the corners not covered by legacy migration remain owed')
  const part = debt.palletReTeaches.find((r) => r.role === 'pallet_part')
  assert.equal(part.findingId, 'pallet-legacy-migration',
    'when the pallet is a real v1 legacy, the ④ re-teach carries '
    + 'the migration finding link')
})
