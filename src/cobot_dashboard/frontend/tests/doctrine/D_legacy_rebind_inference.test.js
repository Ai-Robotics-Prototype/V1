// DOCTRINE — Legacy-program cell inference + Tool&Payload selector
// (2026-10-05 operator order).
//
// Field case (program "Poopyyy"): the program carries no
// cell_eoat_id (pre-7052786 wizard output), gripper_type='vacuum',
// and vacuum steps store io_id='DO2' (hardcoded wizard default).
// detailLine reversed DO2 honestly to "Valve 02" via the portmap,
// but the cell's vacuum EOAT lives on V03 — the WIRE fires the
// wrong channel (vacuum won't pull). The rebind helper from 618a86c
// couldn't help because it required an explicit cell_eoat_id or
// step.cell_binding to anchor on.
//
// Fix: _resolveCellEntry INFERS the cell EOAT when the explicit id
// is absent. Rule: step's io_role maps to an EOAT type ∧ program's
// config.gripper_type agrees ∧ exactly ONE cell EOAT of that type
// exists → use that lone entry. This brings display + wire into
// agreement with the cell for legacy programs without any manual
// migration or operator action.
//
// Item 3: the Tool & Payload section on the ProgramEditor renders
// a cell-driven EOAT selector + "Set up a new tool" escape hatch.
// Selecting a tool patches program.config.cell_eoat_id +
// gripper_type by id; the downstream rebind effect (618a86c) then
// updates every cell-role step's io_id to match the newly-bound
// cell valve.
//
// Pins:
//   1. displayIoForStep on the Poopyyy shape returns the CELL's
//      current valve (DO3 / "Valve 03") — source='cell' — even
//      without an explicit cell_eoat_id.
//   2. rebindProgramToCell rewrites the legacy vacuum steps to
//      DO3 and is idempotent.
//   3. Inference is CONSERVATIVE: ambiguous (two vacuum EOATs) OR
//      cross-type (magnet step in a 'finger' program) → no infer,
//      step stays legacy.
//   4. ProgramEditor's Tool & Payload section renders the selector
//      + the "Set up a new tool" button + a "bound" chip when a
//      cell_eoat_id is present. Grep pin.
//   5. The selector's onChange patches cell_eoat_id + gripper_type
//      via the shared onPatch (so the editor's rebind effect fires
//      on the next render and brings io_id into agreement).
//
// Failure format:
//   DOCTRINE LEGACY_REBIND_INFERENCE VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE LEGACY_REBIND_INFERENCE VIOLATED: ${msg}` }

const progEdSrc = readSrc('components/ProgramEditor.jsx')

const _SEED = {
  version: 1,
  rows: Array.from({ length: 10 }, (_, i) => ({
    synapse: `V${String(i + 1).padStart(2, '0')}`,
    kind: 'valve', raw: `DO${i + 1}`, verified: false,
  })),
}


// ── (1) displayIoForStep infers from gripper_type when no cell_eoat_id ─

test('displayIoForStep: Poopyyy (no cell_eoat_id) resolves vacuum step via inference', async () => {
  const { displayIoForStep } = await import(
    '../../src/lib/programCellRebind.js')
  // Exact field shape: no cell_eoat_id on config; gripper_type=vacuum.
  const legacy = {
    id: 'poopyyy', name: 'Poopyyy',
    config: { gripper_type: 'vacuum' },
  }
  const cell = {
    eoats: [
      { id: 'standard:vacuum', type: 'vacuum', valve: 'V03',
        inputs: ['IN04'], outputs: [] },
    ],
  }
  const step = {
    action: 'set_io', label: 'Engage vacuum',
    io_id: 'DO2', value: 1, io_role: 'vacuum',
  }
  const res = displayIoForStep(step, legacy, cell, _SEED)
  assert.equal(res.source, 'cell',
    v('Legacy vacuum step with no cell_eoat_id must resolve via '
      + "inference (gripper_type='vacuum' + sole cell EOAT of "
      + "type='vacuum') — source='cell'."))
  assert.equal(res.raw, 'DO3',
    v(`Inferred display must use the cell's current valve raw `
      + `channel. Expected 'DO3' (V03→DO3), got '${res.raw}'.`))
  assert.equal(res.display, 'Valve 03',
    v('Inferred display must render "Valve 03" — not the stale '
      + '"Valve 02" that DO2 would reverse to.'))
})


// ── (2) Rebind migration lifts Poopyyy's io_id onto V03 ────────────

test('rebindProgramToCell: Poopyyy legacy vacuum io_ids rewrite to DO3 (idempotent)', async () => {
  const { rebindProgramToCell, stepsNeedingRebind } = await import(
    '../../src/lib/programCellRebind.js')
  const legacy = {
    id: 'poopyyy', name: 'Poopyyy',
    config: { gripper_type: 'vacuum' },
    steps: [
      { action: 'move_home', label: 'Home' },
      { action: 'set_io', label: 'Vacuum off (ready)',
        io_id: 'DO2', value: 0, io_role: 'vacuum' },
      { action: 'set_io', label: 'Engage vacuum',
        io_id: 'DO2', value: 1, io_role: 'vacuum' },
      { action: 'set_io', label: 'Disengage vacuum',
        io_id: 'DO2', value: 0, io_role: 'vacuum' },
      { action: 'set_io', label: 'Hand-added',
        io_id: 'DO7', value: 1 },   // no io_role → untouched
    ],
  }
  const cell = {
    eoats: [{ id: 'standard:vacuum', type: 'vacuum', valve: 'V03',
              inputs: ['IN04'], outputs: [] }],
  }
  const needing = stepsNeedingRebind(legacy, cell, _SEED)
  assert.equal(needing.length, 3,
    v(`Three legacy vacuum steps must need rebind; got ${needing.length}.`))
  const rebound = rebindProgramToCell(legacy, cell, _SEED)
  for (const i of [1, 2, 3]) {
    assert.equal(rebound.steps[i].io_id, 'DO3',
      v(`Vacuum step ${i} must rewrite to DO3; got '${rebound.steps[i].io_id}'.`))
  }
  assert.equal(rebound.steps[4].io_id, 'DO7',
    v('Hand-added set_io without io_role must be left verbatim.'))
  // Idempotence.
  const twice = rebindProgramToCell(rebound, cell, _SEED)
  assert.equal(twice, rebound,
    v('rebindProgramToCell must be idempotent on the rebind output.'))
})


// ── (3) Inference is conservative ──────────────────────────────────

test('inference is CONSERVATIVE: ambiguous and cross-type cases skip', async () => {
  const { displayIoForStep } = await import(
    '../../src/lib/programCellRebind.js')
  // Ambiguous: two vacuum EOATs. Must NOT infer (operator intent
  // unknown).
  const ambig = {
    id: 'p1', config: { gripper_type: 'vacuum' },
  }
  const cellTwoVac = {
    eoats: [
      { id: 'a', type: 'vacuum', valve: 'V03' },
      { id: 'b', type: 'vacuum', valve: 'V05' },
    ],
  }
  const step = { action: 'set_io', io_id: 'DO2', io_role: 'vacuum' }
  const resA = displayIoForStep(step, ambig, cellTwoVac, _SEED)
  assert.equal(resA.source, 'legacy',
    v('Ambiguous (two vacuum EOATs) must leave the step on the '
      + 'legacy branch — never guess which tool.'))
  // Cross-type: magnet step in a 'finger' program → no infer.
  const finger = { id: 'p2', config: { gripper_type: 'finger' } }
  const cellMag = {
    eoats: [{ id: 'm', type: 'magnetic', valve: 'V03' }],
  }
  const magStep = { action: 'set_io', io_id: 'DO3', io_role: 'magnet' }
  const resB = displayIoForStep(magStep, finger, cellMag, _SEED)
  assert.equal(resB.source, 'legacy',
    v('Cross-type (magnet step in a finger program) must stay '
      + 'legacy — the inference is scoped to agreeing gripper_type.'))
})


// ── (4) Tool & Payload selector grep pin ──────────────────────────

test('ProgramEditor Tool & Payload renders a cell-EOAT selector', () => {
  assert.ok(
    /data-testid="tool-and-payload-eoat-selector"/.test(progEdSrc),
    v('ProgramEditor.ToolAndPayloadSection must render the EOAT '
      + 'selector block (data-testid="tool-and-payload-eoat-selector").'))
  assert.ok(
    /data-testid="tool-and-payload-eoat-select"/.test(progEdSrc),
    v('Selector must carry data-testid="tool-and-payload-eoat-select" '
      + 'on the <select> so the operator can pick any saved cell tool.'))
  assert.ok(
    /data-testid="tool-and-payload-setup-new"/.test(progEdSrc),
    v('"Set up a new tool" escape hatch must carry '
      + 'data-testid="tool-and-payload-setup-new" so the operator can '
      + 'register a new tool without leaving the editor.'))
})


// ── (5) Selection rebinds the program by id ───────────────────────

test('Selector onChange patches cell_eoat_id + gripper_type via onPatch', () => {
  // The handler must call onPatch({ cell_eoat_id, gripper_type })
  // so the editor's downstream rebind effect (618a86c) picks up the
  // new binding and rewrites io_ids on the next render.
  assert.ok(
    /onPatch\(\{\s*cell_eoat_id:\s*id,\s*gripper_type:\s*gt,\s*\}\)/
      .test(progEdSrc),
    v('Selector onChange must patch BOTH cell_eoat_id AND '
      + 'gripper_type via onPatch — rebinding by id alone is not '
      + 'enough; downstream code reads gripper_type for executor '
      + 'routing (finger / vacuum / magnetic).'))
  // Clearing the selection ("— no tool bound —") must patch
  // cell_eoat_id:null without disturbing gripper_type.
  assert.ok(/onPatch\(\{\s*cell_eoat_id:\s*null\s*\}\)/.test(progEdSrc),
    v('Selector must patch cell_eoat_id:null when the operator '
      + "picks the '— no tool bound —' option."))
})
