// ProgramEditor routine-fold + broadcast pin — 2026-07-30 §430.
//
// The editor collapses routine iterations by default and broadcasts
// operator edits from iter 0 to sibling iterations at the matching
// offset. These properties matter because:
//
//   1. Fold turns a 63-step white-bowl program into ~13 rows the
//      operator can actually scan. Regression: unrolled everything.
//   2. Broadcast turns "edit once, apply to every cycle" into a
//      real thing — otherwise the operator would have to walk the
//      list N times.  Regression: broadcast silently disabled.
//   3. Broadcast must NOT touch per-iteration fields (taught poses,
//      derived_from_step_id, iter_offset_mm). Regression: broadcast
//      overwrites taught data.
//
// Source-level checks (matches PalletConfigEditor.pinned.test.js
// pattern — no JSX renderer + jsdom required).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.resolve(__dirname, 'ProgramEditor.jsx'), 'utf8')


test('editor state: expandedRoutines Set, default empty (collapsed)', () => {
  assert.ok(/const \[expandedRoutines,\s*setExpandedRoutines\]\s*=\s*useState\(\s*\(\)\s*=>\s*new Set\(\)\s*\)/.test(source),
    'expandedRoutines state (Set) missing; must default to empty (collapsed)')
})

test('editor row map skips iteration>0 rows when routine is collapsed', () => {
  assert.ok(/_rinfo\s*&&\s*_rinfo\.iteration\s*>\s*0\s*&&\s*!isRoutineExpanded\(_rinfo\.routineId\)/.test(source),
    'fold guard (_rinfo.iteration>0 && !isRoutineExpanded) missing')
  assert.ok(/return null/.test(source),
    'fold branch must return null to remove the row')
})

test('editor renders ×N chip + expand/fold toggle on firstOfRoutine row', () => {
  assert.ok(/_rinfo\s*&&\s*_rinfo\.firstOfRoutine\s*&&\s*\(/.test(source),
    'firstOfRoutine gating for the ×N chip missing')
  assert.ok(/×\{_rinfo\.iterations\}/.test(source),
    '×{iterations} chip label missing')
  assert.ok(/isRoutineExpanded\(_rinfo\.routineId\)\s*\?\s*['"`]▾ fold['"`]\s*:\s*['"`]▸ expand['"`]/.test(source),
    'fold/expand toggle label missing')
})

test('editor derives stepRoutineInfo from currentProgram.routines (backend truth)', () => {
  assert.ok(/currentProgram\?\.routines/.test(source),
    'editor must read currentProgram.routines[] as backend truth')
  assert.ok(/step_indices_per_iter/.test(source),
    'editor must consume step_indices_per_iter for iteration ranges')
})

test('editor broadcasts label + safe fields across iterations, blocks pose fields', () => {
  // Broadcast helper exists and is called from handleRename + handleEditSave.
  assert.ok(/_broadcastToRoutine/.test(source),
    '_broadcastToRoutine helper missing')
  assert.ok(/function handleRename[\s\S]{0,200}_broadcastToRoutine/.test(source),
    'handleRename must broadcast to sibling iterations')
  assert.ok(/function handleEditSave[\s\S]{0,200}_broadcastToRoutine/.test(source),
    'handleEditSave must broadcast to sibling iterations')
  // Safe fields explicitly whitelisted; taught / joints / point_name
  // MUST NOT appear — they're per-iteration.
  assert.ok(/_ROUTINE_BROADCAST_FIELDS\s*=\s*new Set\(\[/.test(source),
    'safe-fields whitelist _ROUTINE_BROADCAST_FIELDS missing')
  assert.ok(/'label'/.test(source),   'label must be broadcast-safe')
  assert.ok(/'action'/.test(source),  'action must be broadcast-safe')
  assert.ok(/'duration_s'/.test(source), 'duration_s must be broadcast-safe')
  assert.ok(/'io_id'/.test(source),   'io_id must be broadcast-safe')
  assert.ok(/'value'/.test(source),   'io value must be broadcast-safe')
  // These MUST NOT be listed as broadcast-safe — verify their
  // absence from the whitelist block.
  const setBlock = source.match(/_ROUTINE_BROADCAST_FIELDS\s*=\s*new Set\(\[[\s\S]*?\]\)/)
  assert.ok(setBlock, 'could not locate the broadcast whitelist block for exclusion checks')
  const listBody = setBlock[0]
  for (const forbidden of ['taught_joints', 'taught_tcp', "'taught'",
                           "'joints'", 'derived_from_step_id',
                           'position_ref', 'point_name', 'iter_offset_mm']) {
    assert.ok(!listBody.includes(forbidden),
      `${forbidden} is per-iteration and must NOT be broadcast`)
  }
})

test('editor save round-trips routines[] so the backend can persist the fold shape', () => {
  // handleSave attaches currentProgram.routines to the POST/PUT body.
  assert.ok(/payload\.routines\s*=\s*currentProgram\.routines/.test(source),
    'handleSave must send routines[] to the backend')
})

// ─────────────────────────────────────────────────────────────
// Waypoint step (2026-10-09) — Add Step vocabulary + copy pins
// ─────────────────────────────────────────────────────────────

test('ACTION_TYPES carries a waypoint entry tagged WAYPOINT', () => {
  assert.ok(
    /value:\s*'waypoint',\s*label:\s*'Waypoint'[^,]*,\s*type:\s*'move'[^,]*,\s*tag:\s*'WAYPOINT'/
    .test(source),
    'ACTION_TYPES must register waypoint (value=waypoint, label=Waypoint, type=move, tag=WAYPOINT) so '
    + 'the inline editor + verb-divergence chip + detail line all find it')
})

test('STEP_CATEGORIES exposes waypoint under the Motion category', () => {
  assert.ok(
    /action:\s*'waypoint',\s*label:\s*'Waypoint'/.test(source),
    'STEP_CATEGORIES Motion group must list waypoint so operators '
    + 'can add it from the Add Step tab')
})

test('Add Step copy frames waypoint as MANUAL routing, not auto-avoidance', () => {
  // The operator order is explicit: NEVER suggest the arm plans
  // around obstacles automatically — this is a path-shaping tool.
  // The description string spans multiple concatenated literals;
  // grab the WHOLE entry up to its closing brace.
  const addStepCopy = source.match(
    /action:\s*'waypoint'[\s\S]{0,800}?\}\s*,/)
  assert.ok(addStepCopy, 'could not locate waypoint STEP_CATEGORIES entry')
  const desc = addStepCopy[0]
  assert.match(desc, /guide the path around obstacles/,
    'copy must name manual guidance, not avoidance')
  assert.match(desc, /Manual routing/i,
    'copy must say "Manual routing" so operators do not expect '
    + 'auto-detection')
  assert.doesNotMatch(desc, /avoid(s|ance)?\b/i,
    'copy MUST NOT say "avoids" / "avoidance" — the software does '
    + 'not auto-detect obstacles (that is collision-aware planning, '
    + 'out of scope)')
  assert.doesNotMatch(desc, /\bautomatic(ally)?\b/i,
    'copy MUST NOT suggest automation — the operator teaches the via')
})

test('freshStepForAction waypoint carries sane position defaults', () => {
  assert.ok(
    /case\s*'waypoint':\s*return\s*{\s*\.\.\.base,\s*position:/.test(source),
    'freshStepForAction must give waypoint a position seed so the '
    + 'inline editor renders the pose fields before the operator teaches')
})

test('WAYPOINT tag has a distinct color in TAG_COLORS', () => {
  assert.match(source, /TAG_COLORS\s*=\s*{[\s\S]*?WAYPOINT:\s*'#[0-9a-fA-F]{3,8}'/,
    'WAYPOINT entry in TAG_COLORS makes the row chip readable')
})

test('verb-divergence chip knows waypoint implies movL', () => {
  assert.match(source, /step\.action\s*===\s*'waypoint'\s*\?\s*'movL'/,
    'when codegen emits anything other than movL for a waypoint, '
    + 'the chip must surface the divergence (D3 doctrine)')
})
