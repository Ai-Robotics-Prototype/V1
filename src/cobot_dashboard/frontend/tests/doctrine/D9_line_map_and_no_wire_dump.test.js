// DOCTRINE D9 addition (2026-08-03) — the codegen-emitted line_map
// is the single source of truth for the Monitor's live step
// highlight. Companion rule (D10-adjacent): the raw ProjectState
// wire string ("Estun: state=2 task=main line=15 project=...") is
// controller-speak and never renders to the operator.
//
// Failure format:
//   DOCTRINE D9 VIOLATED: <detail>
//   DOCTRINE D10 VIOLATED: <detail>    (for the tagline check)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stepIndexForLine, lineMapHonesty } from '../../src/lib/runState.js'


function d9(msg)  { return `DOCTRINE D9 VIOLATED: ${msg}` }
function d10(msg) { return `DOCTRINE D10 VIOLATED: ${msg}` }


// stepIndexForLine + inclusive-range lookup ------------------------------

test('D9(a): stepIndexForLine resolves ProjectState.line via line_map', () => {
  const lineMap = [
    { step_idx: 0, step_id: 1,  action: 'move_home',
      lua_line_start: 1, lua_line_end: 3 },
    { step_idx: 1, step_id: 2,  action: 'set_io',
      lua_line_start: 4, lua_line_end: 5 },
    { step_idx: 2, step_id: 3,  action: 'move_linear',
      lua_line_start: 6, lua_line_end: 7 },
    { step_idx: 3, step_id: 4,  action: 'move_linear',
      lua_line_start: 8, lua_line_end: 9 },
    { step_idx: 4, step_id: 5,  action: 'move_linear',
      lua_line_start: 10, lua_line_end: 11 },
  ]
  // Every line inside a step range resolves to that step.
  for (const e of lineMap) {
    for (let ln = e.lua_line_start; ln <= e.lua_line_end; ln++) {
      assert.equal(
        stepIndexForLine(null, ln, lineMap), e.step_idx,
        d9(`line ${ln} inside [${e.lua_line_start}, ${e.lua_line_end}]`
          + ` should map to step ${e.step_idx}`))
    }
  }
  // Out-of-range lines return -1 (no false positives).
  assert.equal(stepIndexForLine(null, 999, lineMap), -1,
    d9('lines outside any range must return -1, not a fallback step'))
  // Missing line_map falls through to -1 (caller may then use
  // task.program_step). NEVER returns a heuristic answer.
  assert.equal(stepIndexForLine(null, 5, null), -1,
    d9('missing line_map must return -1 — no regex-heuristic fallback'))
  assert.equal(stepIndexForLine(null, 5, []), -1,
    d9('empty line_map must return -1'))
})


// Loop-aware behavior ----------------------------------------------------

test('D9(b): same physical Lua line resolves to same step every iteration', () => {
  // The controller reports line=13 (pick contact movL) on iteration
  // 1 and again on iteration 5. Both must resolve to the same step.
  const lineMap = [
    { step_idx: 0, action: 'move_home',   lua_line_start: 1,  lua_line_end: 3 },
    { step_idx: 1, action: 'set_io',      lua_line_start: 4,  lua_line_end: 5 },
    { step_idx: 2, action: 'move_linear', lua_line_start: 6,  lua_line_end: 7 },
    { step_idx: 3, action: 'move_linear', lua_line_start: 8,  lua_line_end: 9 },
  ]
  const wireLine = 8   // pick contact
  const iter1 = stepIndexForLine(null, wireLine, lineMap)
  const iter5 = stepIndexForLine(null, wireLine, lineMap)
  assert.equal(iter1, iter5,
    d9(`loop iteration must not affect line→step mapping; got `
      + `${iter1} on iter1 and ${iter5} on iter5`))
  assert.equal(iter1, 3, d9('pick contact line=8 must map to step 3'))
})


// Honesty guard: sha mismatch ---------------------------------------------

test('D9(c): honesty guard blocks highlight on sha mismatch', () => {
  const r = lineMapHonesty({
    residentSha:       'aaaaaaaaaaaa',
    residentProgramId: 'bowl',
    lineMapSha:        'bbbbbbbbbbbb',
    lineMapProgramId:  'bowl',
  })
  assert.equal(r.ok, false,
    d9(`sha mismatch must set ok=false to prevent wrong-step highlight`))
  assert.equal(r.reason, 'sha_mismatch', d9(`reason must name the failure`))
})

test('D9(c): honesty guard blocks highlight when resident program != map program', () => {
  const r = lineMapHonesty({
    residentSha:       'aaaaaaaaaaaa',
    residentProgramId: 'bowl',
    lineMapSha:        'aaaaaaaaaaaa',
    lineMapProgramId:  'palletize',
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'wrong_program',
    d9(`different program on the wire vs on screen must not highlight`))
})

test('D9(c): honesty guard okay on matching sha + program', () => {
  const r = lineMapHonesty({
    residentSha:       'aaaaaaaaaaaa',
    residentProgramId: 'bowl',
    lineMapSha:        'aaaaaaaaaaaa',
    lineMapProgramId:  'bowl',
  })
  assert.equal(r.ok, true, d9(`matching sha+program must allow highlight`))
})

test('D9(c): honesty guard distinguishes no-resident from mismatch', () => {
  const noResident = lineMapHonesty({
    residentSha: null, lineMapSha: 'aaaa',
  })
  assert.equal(noResident.reason, 'no_resident',
    d9('reason distinguishes "nothing running" from "wrong resident"'))
  const noMap = lineMapHonesty({
    residentSha: 'aaaa', lineMapSha: null,
  })
  assert.equal(noMap.reason, 'no_map',
    d9('reason distinguishes "no map fetched yet" from other failures'))
})


// Estun tagline banished from the Monitor DOM ----------------------------

test('D10: Monitor no longer renders the raw Estun wire string', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const monitorPath = path.resolve(here,
    '../../src/pages/MonitorDashboard.jsx')
  const src = fs.readFileSync(monitorPath, 'utf8')
  // The banished phrasing (any of these substrings would mean the
  // tagline came back):
  const forbidden = [
    '<b>Estun:</b>',
    'task={robot.program.task',
    'state={robot.program.state',
    // A comma-joined version we might refactor to
    'Estun: state=',
  ]
  for (const needle of forbidden) {
    assert.equal(
      src.includes(needle), false,
      d10(`Monitor still renders the raw wire tagline (matches `
        + `${JSON.stringify(needle)}). Controller-speak never renders `
        + `to the operator; keep the raw wire in debug/log surfaces.`))
  }
})


test('D10: Monitor still surfaces single-step via a chip, not a protocol dump', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const monitorPath = path.resolve(here,
    '../../src/pages/MonitorDashboard.jsx')
  const src = fs.readFileSync(monitorPath, 'utf8')
  // A single-step chip is expected (the mode datum from the wire
  // that DOES matter to the operator). This test guards against a
  // regression that would drop the mode indicator entirely.
  assert.ok(
    src.includes('Single-step') && src.includes('is_step'),
    d10('single-step mode indicator missing — operator loses the '
      + 'one wire datum that matters (auto vs single-step)'))
})
