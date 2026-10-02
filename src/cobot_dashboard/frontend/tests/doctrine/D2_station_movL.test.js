// DOCTRINE D2 — Station columns (approach→contact→retreat) emit
// movL, every profile; transits movJ unless overridden. Exceptions
// only via the analyzer, reason printed.
//
// Failure format:
//   DOCTRINE D2 VIOLATED: <detail>
//
// Phase-1 coverage (this file):
//  (a) verbForStep — no emitted-verbs table present, "expected"
//      resolution: approach/contact/retreat rows all resolve to movL
//      via their action verb.
//  (b) transit (move_home) resolves to movJ.
//  (c) When an emitted_verbs table is present that overrides a
//      station column, the reason MUST be non-empty (D3 handles the
//      shown-vs-emitted display; D2 pins the "reason printed" side).
//
// Phase-2 (TODO): snapshot-compare reference Lua across the four
// profiles (Conservative / Balanced / Aggressive / custom). Requires
// invoking codegen from a test harness; scaffolded in
// tests/doctrine/fixtures/ (empty today).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verbForStep } from '../../src/lib/programTruth.js'


function d2(msg) { return `DOCTRINE D2 VIOLATED: ${msg}` }


function stationColumnProgram(role) {
  return {
    steps: [
      { id: 1, action: 'move_home' },
      { id: 2, action: 'move_linear', derived_from: role, offset_z_mm: -80 }, // approach
      { id: 3, action: 'move_linear', position_role: role },                  // contact
      { id: 4, action: 'move_linear', derived_from: role, offset_z_mm: 100 }, // retreat
    ],
  }
}


test('D2(a): approach → movL', () => {
  const prog = stationColumnProgram('pick')
  const v = verbForStep(prog, 1)  // approach
  assert.equal(v.verb, 'movL',
    d2(`approach step resolved to ${v.verb} — expected movL. `
     + `Station arrivals must emit linear motion across every profile.`))
})

test('D2(a): contact → movL', () => {
  const prog = stationColumnProgram('pick')
  const v = verbForStep(prog, 2)
  assert.equal(v.verb, 'movL',
    d2(`contact step resolved to ${v.verb} — expected movL`))
})

test('D2(a): retreat → movL', () => {
  const prog = stationColumnProgram('pick')
  const v = verbForStep(prog, 3)
  assert.equal(v.verb, 'movL',
    d2(`retreat step resolved to ${v.verb} — expected movL. `
     + `Retreats leave the station cartesian by design.`))
})

test('D2(b): transit (move_home) → movJ', () => {
  const prog = stationColumnProgram('pick')
  const v = verbForStep(prog, 0)  // move_home
  assert.equal(v.verb, 'movJ',
    d2(`transit move_home resolved to ${v.verb} — expected movJ`))
})

test('D2(c): analyzer overrides thread their reason through verbForStep', () => {
  // Positive path — when codegen writes a divergence (movJ instead
  // of movL for an approach) with a reason, verbForStep MUST
  // surface both the verb AND the reason. This is the wire D3
  // depends on; D2 pins the reason path.
  const prog = {
    steps: [
      { id: 1, action: 'move_linear', derived_from: 'pick', offset_z_mm: -80 },
    ],
    emitted_verbs: [
      { verb: 'movJ', reason: 'awkward wrist — cartesian arrival blocked' },
    ],
  }
  const v = verbForStep(prog, 0)
  assert.equal(v.verb, 'movJ',
    d2(`emitted verb ${v.verb} lost through verbForStep — the row `
     + `would then show a stale movL that doesn't match the wire`))
  assert.ok(v.reason && v.reason.length > 0,
    d2(`analyzer reason discarded by verbForStep — the row can't `
     + `explain WHY the divergence exists without it`))
})


// TODO(phase 2): compose a program through codegen at each profile
// (Conservative / Balanced / Aggressive / custom) and assert every
// station-column row emits movL. Fixture:
//   tests/doctrine/fixtures/expected_lua/<profile>/pick_and_place.lua
// Scaffold this once the test harness can invoke codegen from JS.
