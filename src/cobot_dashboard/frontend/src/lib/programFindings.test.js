// programFindings — legacy-pallet-migration finding lifecycle pin.
//
// Directive (2026-07-31 cleanup): the modal's amber "re-teach ④"
// notice moved to a program-level validation finding. It appears on
// programs migrated from the v1 3-point (A/B/C) frame and CLEARS
// once ④ is re-taught with a real part.
//
// These tests own that lifecycle contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeProgramFindings } from './programFindings.js'


test('computeProgramFindings: empty program → no findings', () => {
  assert.deepEqual(computeProgramFindings({}), [])
  assert.deepEqual(computeProgramFindings(null), [])
})

test('legacy-migration finding: v1 program → info finding present', () => {
  // v1 shape: corner_a / point_b / point_c set, no v2 corner1/2/3.
  // palletFrameStatus flags migratedFromV1 → the finding appears.
  const prog = { config: { pallet_place: {
    corner_a_tcp: [100, 0, 0, 0, 0, 0],
    point_b_tcp:  [500, 0, 0, 0, 0, 0],
    point_c_tcp:  [100, 400, 0, 0, 0, 0],
  }}}
  const findings = computeProgramFindings(prog)
  const migr = findings.find((f) => f.id === 'pallet-legacy-migration')
  assert.ok(migr, 'legacy-migration finding must appear for a v1 program')
  assert.equal(migr.severity, 'info',
    'migration is info-severity — nudge, not blocker')
  assert.ok(/first-part position \(④\)/.test(migr.body),
    'finding body must name the ④ position so the operator knows '
    + 'exactly what to re-teach')
  assert.ok(/real part in slot \[1,1\]/.test(migr.body),
    'finding body must direct the operator to place a REAL part')
  assert.ok(migr.action,
    'finding must carry a Re-teach ④ CTA so the host can wire a button')
  assert.equal(migr.action.kind, 'teach-pallet-part',
    'CTA kind names the operator gesture that resolves the finding')
})

test('legacy-migration finding: legacy pallet.corner_tcp dict → info finding present', () => {
  // Even older format: config.pallet.corner_tcp as {x,y,z,rx,ry,rz} dict.
  // The resolver flags migratedFromV1; the finding must appear.
  const prog = { config: { pallet: {
    corner_tcp: { x: 100, y: 200, z: 50, rx: 0, ry: 0, rz: 0 },
  }}}
  const findings = computeProgramFindings(prog)
  assert.ok(findings.find((f) => f.id === 'pallet-legacy-migration'),
    'finding must fire for the older config.pallet.corner_tcp dict shape')
})

test('legacy-migration finding: CLEARS once ④ is re-taught', () => {
  // Start on a v1 program → finding present. Simulate the operator
  // re-teaching ④ (v2 field written) → finding must disappear.
  //
  // The clear is entirely driven by palletFrameStatus: once v2
  // corner1/2/3/part fields are present, migratedFromV1 flips to
  // false and legacyPalletMigrationFinding returns null.
  const v1prog = { config: { pallet_place: {
    corner_a_tcp: [100, 0, 0, 0, 0, 0],
    point_b_tcp:  [500, 0, 0, 0, 0, 0],
    point_c_tcp:  [100, 400, 0, 0, 0, 0],
  }}}
  assert.ok(
    computeProgramFindings(v1prog).find((f) => f.id === 'pallet-legacy-migration'),
    'sanity: finding present before ④ re-teach')
  // Operator walks the pallet teach flow — writes v2 fields
  // including part_tcp. palletFrameStatus.migratedFromV1 → false.
  const v2prog = { config: { pallet_place: {
    ...v1prog.config.pallet_place,
    corner1_tcp: [100, 0, 0, 0, 0, 0],
    corner2_tcp: [500, 0, 0, 0, 0, 0],
    corner3_tcp: [100, 400, 0, 0, 0, 0],
    part_tcp:    [100, 0, 50, 0, 0, 0],
  }}}
  const cleared = computeProgramFindings(v2prog)
    .find((f) => f.id === 'pallet-legacy-migration')
  assert.equal(cleared, undefined,
    'finding must clear once v2 fields (incl. part_tcp) are present — '
    + 'operator resolved the underlying condition by re-teaching ④')
})

test('legacy-migration finding: absent for v2-native programs', () => {
  const prog = { config: { pallet_place: {
    corner1_tcp: [0,   0, 0, 0, 0, 0],
    corner2_tcp: [400, 0, 0, 0, 0, 0],
    corner3_tcp: [0, 300, 0, 0, 0, 0],
    part_tcp:    [10, 10, -50, 0, 0, 0],
  }}}
  const findings = computeProgramFindings(prog)
  assert.equal(
    findings.find((f) => f.id === 'pallet-legacy-migration'),
    undefined,
    'v2-native programs must not carry a migration finding')
})

test('legacy-migration finding: absent for fresh programs (no pallet)', () => {
  const findings = computeProgramFindings({ config: {} })
  assert.equal(
    findings.find((f) => f.id === 'pallet-legacy-migration'),
    undefined,
    'a fresh program with no pallet config has nothing to migrate '
    + 'from — no finding')
})
