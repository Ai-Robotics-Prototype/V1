// DOCTRINE — Program ↔ cell rebind (2026-10-05 operator directive).
//
// Field bug: a vacuum program created BEFORE 7052786 (the "wizard
// emits cell-sourced io_ids" fix) still carries hardcoded io_id='DO2'
// baked in by the pre-fix wizard's effectorVocab default. detailLine
// honestly reverse-looks-up DO2 → "Valve 02" via the portmap — the
// portmap display is correct per the panel wiring — but the program
// is bound to a cell whose vacuum EOAT lives on V03, so the row
// disagrees with the cell AND the executor fires the wrong wire.
//
// Fix shape — lib/programCellRebind.js owns the two helpers:
//
//   displayIoForStep(step, program, cell, portmap)
//     → returns the Synapse display, preferring the cell's current
//       valve when the step plays a cell-eoat role AND the program
//       is cell-bound. source='cell' | 'legacy'. Used by detailLine
//       so the editor shows "Valve 03" against a V03-vacuum cell
//       even when the stored io_id is DO2.
//
//   rebindProgramToCell(program, cell, portmap)
//     → pure, deterministic, idempotent. Walks the program's steps
//       and rewrites io_id to match the cell's current valve for
//       every cell-role step. Returns the SAME object reference
//       when nothing changed (caller skips the store write).
//
// Pins:
//   1. Shared module exports displayIoForStep + rebindProgramToCell
//      + stepsNeedingRebind.
//   2. ProgramEditor imports from the shared module (import-identity).
//   3. detailLine takes program + cell as trailing args + threads
//      the step into ioName so cell-role resolution kicks in.
//   4. ProgramEditor loads the cell + runs rebindProgramToCell on
//      program-id change (one-shot via _rebindFiredRef).
//   5. Behavior: legacy program with io_id='DO2' + cell vacuum V03
//      → displayIoForStep returns 'Valve 03' (cell source).
//   6. Behavior: rebindProgramToCell rewrites that step's io_id to
//      'DO3'; the migrated program is === itself on the second
//      pass (idempotent).
//   7. Behavior: step with no io_role and no cell binding is left
//      verbatim (no silent invention).
//   8. Behavior: unmapped channel still renders honest copy via
//      displayNameForRaw fallthrough.
//
// Failure format:
//   DOCTRINE PROGRAM_CELL_REBIND VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE PROGRAM_CELL_REBIND VIOLATED: ${msg}` }

const rebindSrc  = readSrc('lib/programCellRebind.js')
const progEdSrc  = readSrc('components/ProgramEditor.jsx')


// ── (1) Shared module exports ──────────────────────────────────────

test('programCellRebind module exports displayIoForStep + rebindProgramToCell', () => {
  for (const sym of [
    'export function displayIoForStep',
    'export function rebindProgramToCell',
    'export function stepsNeedingRebind',
  ]) {
    assert.ok(rebindSrc.includes(sym),
      v(`lib/programCellRebind.js must declare "${sym}" — the shared `
        + 'cell-rebind helpers power both display + migration.'))
  }
  // Routes through the single-source portmap library.
  assert.ok(/from\s+['"]\.\/synapsePortmap(?:\.js)?['"]/.test(rebindSrc),
    v('programCellRebind must import from ./synapsePortmap — one '
      + 'translator for every surface.'))
})


// ── (2) ProgramEditor import-identity ──────────────────────────────

test('ProgramEditor imports from programCellRebind + cellStore', () => {
  assert.ok(
    /from\s+['"]\.\.\/lib\/programCellRebind['"]/.test(progEdSrc),
    v('ProgramEditor.jsx must import from ../lib/programCellRebind — '
      + 'detailLine + the open-time migration both route through the '
      + 'shared helpers.'))
  assert.ok(
    /from\s+['"]\.\.\/lib\/cellStore['"]/.test(progEdSrc),
    v('ProgramEditor.jsx must import from ../lib/cellStore — the '
      + 'editor loads the cell registry so rebind has something to '
      + 'resolve against.'))
})


// ── (3) detailLine accepts program + cell for cell-rebind ──────────

test('detailLine threads step + program + cell into ioName', () => {
  // Signature: (step, ioLabels, synapsePortmap, program, cell, ...).
  // 2026-10-06 extension: a trailing `profile` arg carries the I/O
  // hardware profile so OEM installs render raw DO/DI channels. The
  // 5-arg prefix is still required — cell-rebind context is
  // positional and the Configure-tab doctrine is additive.
  assert.ok(
    /function\s+detailLine\(step,\s*ioLabels,\s*synapsePortmap,\s*program,\s*cell(?:,\s*profile)?\)/
      .test(progEdSrc),
    v('detailLine must accept (step, ioLabels, synapsePortmap, '
      + 'program, cell) — the two trailing cell-rebind args are '
      + 'required (profile is an optional sixth arg per the '
      + 'Configure-tab directive).'))
  // ioName must call displayIoForStep when a step is passed through.
  assert.ok(/displayIoForStep\(_step,\s*program,\s*cell,\s*synapsePortmap\)/
              .test(progEdSrc),
    v('detailLine.ioName must call displayIoForStep(step, program, '
      + 'cell, portmap) so cell-role steps prefer the cell\'s '
      + 'current valve over the stored raw io_id reverse.'))
  // The call site passes currentProgram + cellRegistry (+ profile).
  assert.ok(
    /detailLine\(step,\s*ioLabels,\s*synapsePortmap,\s*\n?\s*currentProgram,\s*cellRegistry(?:,\s*\n?\s*ioHardwareProfile)?\)/
      .test(progEdSrc),
    v('ProgramEditor must call detailLine(step, ioLabels, portmap, '
      + 'currentProgram, cellRegistry[, ioHardwareProfile]) at the '
      + 'step-row render.'))
})


// ── (4) Open-time rebind migration ─────────────────────────────────

test('ProgramEditor runs rebindProgramToCell on program-id change', () => {
  assert.ok(/rebindProgramToCell\(/.test(progEdSrc),
    v('ProgramEditor must call rebindProgramToCell(program, cell, '
      + 'portmap) in a useEffect — the open-time migration brings '
      + 'wire into agreement with display for legacy programs.'))
  // Guarded by a ref so repeat renders don't re-fire.
  assert.ok(/_rebindFiredRef/.test(progEdSrc),
    v('ProgramEditor must guard the rebind effect with '
      + '_rebindFiredRef so it fires once per program+cell key — '
      + 'the migration is idempotent but the setCurrentProgram '
      + 'patch is a store write worth skipping.'))
  // Migration marks unsaved so the debounced edit-through fires.
  assert.ok(/setCurrentProgram\(\{\s*steps:\s*rebound\.steps,\s*unsaved:\s*true\s*\}\)/
              .test(progEdSrc),
    v('Rebind migration must set unsaved:true so the debounced '
      + 'edit-through writes the patched io_ids back to the draft '
      + '— wire follows display on the next tick.'))
})


// ── (5) displayIoForStep: cell overrides raw ───────────────────────

test('displayIoForStep: cell-bound vacuum step shows Valve 03 for V03 tool', async () => {
  const { displayIoForStep }
    = await import('../../src/lib/programCellRebind.js')
  const { _primeCacheForTests, canonSynapse }
    = await import('../../src/lib/synapsePortmap.js')
  const seed = {
    version: 1,
    rows: Array.from({ length: 10 }, (_, i) => ({
      synapse: `V${String(i + 1).padStart(2, '0')}`,
      kind: 'valve', raw: `DO${i + 1}`, verified: false,
    })),
  }
  _primeCacheForTests(seed)
  // Legacy step: stored io_id='DO2' (the pre-fix wizard default).
  const legacyStep = {
    action: 'set_io', label: 'Engage vacuum',
    io_id: 'DO2', value: 1, io_role: 'vacuum',
  }
  // Program is cell-bound to a vacuum EOAT whose current valve is V03.
  const program = { id: 'legacy-prog', config: { cell_eoat_id: 'eoat-A' } }
  const cell = { eoats: [{ id: 'eoat-A', valve: 'V03',
                           inputs: [], outputs: [] }] }
  const res = displayIoForStep(legacyStep, program, cell, seed)
  assert.equal(res.source, 'cell',
    v('A cell-bound vacuum step must resolve its display via the '
      + "cell's current valve — source='cell'."))
  assert.equal(res.raw, 'DO3',
    v(`Cell-bound display must return the cell's current raw channel `
      + `(DO3 for V03). Got raw=${res.raw}.`))
  assert.equal(res.display, 'Valve 03',
    v('Cell-bound display must render "Valve 03" for a V03 vacuum '
      + 'tool — the operator-facing name must agree with the cell.'))
  // Legacy fallthrough: step with no io_role still reverses the
  // stored raw channel honestly through the portmap.
  const noRoleStep = {
    action: 'set_io', label: 'Hand-added set DO',
    io_id: 'DO5', value: 1,
  }
  const res2 = displayIoForStep(noRoleStep, program, cell, seed)
  assert.equal(res2.source, 'legacy',
    v("No-role step must fall through to source='legacy' — the "
      + 'honest raw reverse-lookup.'))
  assert.equal(res2.raw, 'DO5',
    v('Legacy source must return the stored io_id verbatim.'))
})


// ── (6) rebindProgramToCell: writes io_id + idempotent ─────────────

test('rebindProgramToCell rewrites legacy vacuum io_id + is idempotent', async () => {
  const { rebindProgramToCell, stepsNeedingRebind }
    = await import('../../src/lib/programCellRebind.js')
  const { _primeCacheForTests }
    = await import('../../src/lib/synapsePortmap.js')
  const seed = {
    version: 1,
    rows: Array.from({ length: 10 }, (_, i) => ({
      synapse: `V${String(i + 1).padStart(2, '0')}`,
      kind: 'valve', raw: `DO${i + 1}`, verified: false,
    })),
  }
  _primeCacheForTests(seed)
  const legacyProgram = {
    id: 'p1',
    config: { cell_eoat_id: 'eoat-A' },
    steps: [
      { action: 'move_home', label: 'Home' },
      { action: 'set_io', label: 'Vacuum off (ready)',
        io_id: 'DO2', value: 0, io_role: 'vacuum' },
      { action: 'set_io', label: 'Engage vacuum',
        io_id: 'DO2', value: 1, io_role: 'vacuum' },
      { action: 'set_io', label: 'Disengage vacuum',
        io_id: 'DO2', value: 0, io_role: 'vacuum' },
      { action: 'set_io', label: 'Hand-authored set',
        io_id: 'DO7', value: 1 },   // no io_role → left alone
    ],
  }
  const cell = { eoats: [{ id: 'eoat-A', valve: 'V03',
                           inputs: [], outputs: [] }] }

  // stepsNeedingRebind flags the three vacuum steps.
  const needing = stepsNeedingRebind(legacyProgram, cell, seed)
  assert.equal(needing.length, 3,
    v(`stepsNeedingRebind must flag the 3 legacy vacuum steps — got `
      + `${needing.length}.`))
  assert.ok(needing.every((n) => n.stored === 'DO2' && n.cell === 'DO3'),
    v('Every flagged step must report stored=DO2 + cell=DO3.'))

  const rebound = rebindProgramToCell(legacyProgram, cell, seed)
  assert.notEqual(rebound, legacyProgram,
    v('rebindProgramToCell must return a NEW program object when '
      + 'any io_id changed.'))
  // All vacuum steps carry the cell's raw channel now.
  for (const i of [1, 2, 3]) {
    assert.equal(rebound.steps[i].io_id, 'DO3',
      v(`Step ${i} must have io_id='DO3' after rebind — got `
        + `'${rebound.steps[i].io_id}'.`))
  }
  // Hand-authored no-role step is left verbatim.
  assert.equal(rebound.steps[4].io_id, 'DO7',
    v('Hand-authored set_io without io_role must be left verbatim '
      + '(no silent invention).'))
  // move_home has no io_id at all — passes through.
  assert.equal(rebound.steps[0].action, 'move_home')

  // Idempotence: running rebind on the output of itself returns the
  // SAME object reference (nothing to change).
  const twice = rebindProgramToCell(rebound, cell, seed)
  assert.equal(twice, rebound,
    v('rebindProgramToCell must be idempotent — re-running on the '
      + 'rebound output must return the same reference (no-op).'))
  // And stepsNeedingRebind now reports zero.
  assert.equal(stepsNeedingRebind(rebound, cell, seed).length, 0,
    v('After rebind, stepsNeedingRebind must return [] (every '
      + 'cell-role step agrees with the cell).'))
})


// ── (7) Non-cell programs + no cell_eoat_id → no changes ───────────

test('rebindProgramToCell: no cell binding → identity (no mutation)', async () => {
  const { rebindProgramToCell }
    = await import('../../src/lib/programCellRebind.js')
  const seed = {
    version: 1,
    rows: [{ synapse: 'V03', kind: 'valve', raw: 'DO3', verified: false }],
  }
  const prog = {
    id: 'cell-less',
    config: {},   // no cell_eoat_id
    steps: [
      { action: 'set_io', io_id: 'DO2', value: 1, io_role: 'vacuum' },
    ],
  }
  const cell = { eoats: [] }
  const out = rebindProgramToCell(prog, cell, seed)
  assert.equal(out, prog,
    v('A program with no cell_eoat_id must pass through rebind '
      + 'unchanged — identity preserved so callers can skip the '
      + 'store write.'))
})


// ── (8) Unmapped-channel honest copy still works ───────────────────

test('displayIoForStep: unmapped channel falls back to honest copy', async () => {
  const { displayIoForStep }
    = await import('../../src/lib/programCellRebind.js')
  const emptyPm = { version: 1, rows: [] }
  const step = { action: 'set_io', io_id: 'DO9', value: 1 }
  const res = displayIoForStep(step, { config: {} }, { eoats: [] },
    emptyPm)
  assert.equal(res.source, 'legacy',
    v('No cell-role step must take the legacy branch.'))
  assert.equal(res.display, 'Unmapped channel DO9',
    v('Legacy branch must render the honest "Unmapped channel X" '
      + 'copy via displayNameForRaw — never silently invent a '
      + 'Synapse name.'))
})


// ── (9) Finger-gripper rebind (2026-10-08) ────────────────────────
//
// Operator field report (2026-10-08): a finger-gripper program's
// gripper steps carried the pre-cell hardcoded io_close='DO0' /
// io_open='DO1' instead of the EOAT's actual Synapse valve. The
// rebind layer now also tracks close_gripper/open_gripper roles so
// a port change on the cell's finger EOAT propagates to existing
// programs at load time (same path the vacuum/magnet rebind takes).

test('rebindProgramToCell: finger program with legacy DO0/DO1 → cell V05 rewrites both fields', async () => {
  const { rebindProgramToCell }
    = await import('../../src/lib/programCellRebind.js')
  const seed = {
    version: 1,
    rows: [
      { synapse: 'V05', raw: 'DO5' },
      { synapse: 'V01', raw: 'DO1' },
      { synapse: 'V00', raw: 'DO0' },
    ],
  }
  const cell = {
    eoats: [{
      id: 'eoat_f1', name: 'Finger Gripper', type: 'finger',
      valve: 'V05',
      actuators: [{ type: 'double_acting', valve: 'V05' }],
      inputs: ['IN01', 'IN02'], sensor_count: 2,
    }],
  }
  const prog = {
    id: 'p1', config: { cell_eoat_id: 'eoat_f1' },
    steps: [
      // Pre-fix wizard emission — hardcoded placeholders.
      { action: 'close_gripper', io_close: 'DO0', io_close_confirm: 'DI0',
        io_role: 'gripper_close' },
      { action: 'open_gripper',  io_open:  'DO1',
        io_role: 'gripper_open' },
    ],
  }
  const out = rebindProgramToCell(prog, cell, seed)
  assert.notEqual(out, prog,
    v('Finger program bound to a V05 EOAT must get a NEW object '
      + 'from rebind (both gripper steps need io rewrite).'))
  assert.equal(out.steps[0].io_close, 'DO5',
    v('close_gripper.io_close must rewrite to the cell valve raw '
      + '(V05 → DO5).'))
  assert.equal(out.steps[1].io_open, 'DO5',
    v('open_gripper.io_open must rewrite to the cell valve raw '
      + '(same V05, double-acting valve shared by both halves).'))
  // Second pass is identity (idempotent).
  const out2 = rebindProgramToCell(out, cell, seed)
  assert.equal(out2, out,
    v('rebindProgramToCell must be idempotent for finger rebinds — '
      + 'same input + same cell → same output reference.'))
})

test('displayIoForStep: finger close_gripper routes io_close through cell-aware display', async () => {
  const { displayIoForStep }
    = await import('../../src/lib/programCellRebind.js')
  const seed = {
    version: 1,
    rows: [
      { synapse: 'V05', raw: 'DO5' },
      { synapse: 'V00', raw: 'DO0' },
    ],
  }
  const cell = {
    eoats: [{
      id: 'eoat_f1', name: 'Finger Gripper', type: 'finger',
      valve: 'V05',
    }],
  }
  const program = { config: { cell_eoat_id: 'eoat_f1' } }
  const step = { action: 'close_gripper', io_close: 'DO0',
                 io_role: 'gripper_close' }
  const res = displayIoForStep(step, program, cell, seed)
  assert.equal(res.source, 'cell',
    v('A cell-bound finger step must take the cell branch.'))
  assert.equal(res.raw, 'DO5',
    v('displayIoForStep must prefer the cell valve raw (V05 → DO5) '
      + 'over the step\'s stored io_close.'))
})

test('wizard _cellVocabOpts passes fingerValve + sensor inputs to effectorVocab', () => {
  // Grep-pin the wizard's bridge from the picked cell EOAT to the
  // emitter opts. Without these, the finger branch of effectorVocab
  // keeps emitting the pre-cell DO0/DO1/DI0 defaults even on a
  // cell-bound program.
  const wizSrc = readFileSync(
    new URL('../../src/components/ProgramWizard.jsx', import.meta.url),
    'utf8')
  assert.ok(/opts\.fingerValve\s*=\s*cellEoat\.valve/.test(wizSrc),
    v('_cellVocabOpts must set opts.fingerValve = cellEoat.valve so '
      + 'the finger emitter resolves the Synapse valve from the '
      + 'bound EOAT (not the pre-cell DO0/DO1 default).'))
  assert.ok(/opts\.fingerCloseConfirmInput\s*=\s*inputs\[0\]/.test(wizSrc),
    v('_cellVocabOpts must thread inputs[0] through as the close-'
      + 'confirm sensor DI.'))
  assert.ok(/opts\.fingerOpenConfirmInput\s*=\s*inputs\[1\]/.test(wizSrc),
    v('_cellVocabOpts must thread inputs[1] through as the open-'
      + 'confirm sensor DI (when present).'))
})

test('effectorVocab finger branches honor the cell-sourced fingerValve', async () => {
  const { effectorEngage, effectorDisengage, effectorReady }
    = await import('../../src/lib/effectorVocab.js')
  const seed = {
    version: 1,
    rows: [
      { synapse: 'V05', raw: 'DO5' },
      { synapse: 'IN01', raw: 'DI1' },
      { synapse: 'IN02', raw: 'DI2' },
    ],
  }
  const cfg = { effector: 'finger' }
  const opts = {
    fingerValve: 'V05',
    fingerCloseConfirmInput: 'IN01',
    fingerOpenConfirmInput: 'IN02',
    cellBinding: { eoat_id: 'eoat_f1' },
    portmap: seed,
  }
  const engage = effectorEngage(cfg, opts)
  assert.equal(engage[0].action, 'close_gripper',
    v('finger engage emits close_gripper'))
  assert.equal(engage[0].io_close, 'DO5',
    v('finger engage must resolve io_close from the cell valve '
      + '(V05 → DO5) instead of the pre-cell DO0 default.'))
  assert.equal(engage[0].io_close_confirm, 'DI1',
    v('finger engage must resolve io_close_confirm from the cell '
      + 'inputs[0] (IN01 → DI1).'))
  assert.equal(engage[0].io_role, 'gripper_close',
    v('finger engage must carry io_role=gripper_close for the '
      + 'cell-rebind resolver.'))
  assert.equal(engage[0].cell_binding?.eoat_id, 'eoat_f1',
    v('finger engage must carry cell_binding so a later rebind can '
      + 'anchor on it.'))
  const disengage = effectorDisengage(cfg, opts)
  assert.equal(disengage[0].io_open, 'DO5',
    v('finger disengage must resolve io_open from the cell valve.'))
  assert.equal(disengage[0].io_role, 'gripper_open',
    v('finger disengage must carry io_role=gripper_open.'))
  const ready = effectorReady(cfg, opts)
  assert.equal(ready[0].io_open, 'DO5',
    v('finger ready must resolve io_open from the cell valve.'))
})

test('non-motion whitelist includes close_gripper + open_gripper tokens', () => {
  // 2026-10-08 operator field report — the three whitelists must
  // all recognise the wizard-emitted token form. Grep-pin all
  // three in the same test so a token split can't be re-introduced
  // in one copy without the pin firing.
  const programTruthSrc = readFileSync(
    new URL('../../src/lib/programTruth.js', import.meta.url), 'utf8')
  const dashSrc = readFileSync(new URL(
    '../../../cobot_dashboard/dashboard_server.py',
    import.meta.url), 'utf8')
  const programOpsSrc = readFileSync(new URL(
    '../../../../estun_driver/estun_driver/program_ops.py',
    import.meta.url), 'utf8')
  for (const [label, src] of [
    ['programTruth.NON_MOTION_ACTIONS', programTruthSrc],
    ['dashboard_server._NON_MOTION_ACTIONS', dashSrc],
    ['program_ops._NON_MOTION_ACTIONS_FOR_TAUGHT_CHECK', programOpsSrc],
  ]) {
    assert.ok(/'close_gripper'/.test(src),
      v(`${label} must whitelist 'close_gripper' — the wizard emits `
        + `this token form (effectorVocab.js finger engage).`))
    assert.ok(/'open_gripper'/.test(src),
      v(`${label} must whitelist 'open_gripper' — the wizard emits `
        + `this token form (effectorVocab.js finger ready + `
        + `disengage).`))
  }
})

test('semantic roundtrip whitelist accepts close_gripper + open_gripper tokens', () => {
  // 2026-10-08 operator field report — SAVE flow refused with
  // "Controller refused the save — program not loaded" + raw
  // "semantic_roundtrip_error" in technicalDetail. Root cause:
  // lua_semantic_roundtrip._ACTION_TO_LEGAL_VERBS had the
  // inverted gripper_close/gripper_open tokens but the wizard
  // emits close_gripper/open_gripper. Pin all four token forms
  // here so a future refactor can't silently drop one again.
  const rtSrc = readFileSync(new URL(
    '../../../../estun_driver/estun_driver/lua_semantic_roundtrip.py',
    import.meta.url), 'utf8')
  for (const tok of ['"close_gripper"', '"open_gripper"',
                     '"gripper_close"', '"gripper_open"']) {
    assert.ok(rtSrc.includes(tok),
      v(`lua_semantic_roundtrip._ACTION_TO_LEGAL_VERBS must include `
        + `${tok} — pre-fix the save flow refused finger programs `
        + `with kind='unknown_action'.`))
  }
  // The marker that codegen's new finger-dispatch emits on
  // tool-IO setup gaps must be recognised by the gate so the
  // sweep classifier surfaces it as tool_io_refused rather than
  // step_drop.
  assert.ok(/_TOOL_IO_REFUSED_RE\s*=/.test(rtSrc),
    v('lua_semantic_roundtrip must define _TOOL_IO_REFUSED_RE '
      + '— the codegen marker for a bound EOAT without a valve.'))
  assert.ok(/kind="tool_io_refused"/.test(rtSrc),
    v('lua_semantic_roundtrip must emit RoundTripFinding kind='
      + '"tool_io_refused" for the gripper setup-incomplete case.'))
})

test('codegen emits raw DO channels for close_gripper / open_gripper (no Synapse names)', () => {
  // Pin that the gripper-dispatch branch emits setDO(<port>,<val>)
  // directly — codegen's wire output must carry raw controller
  // channels, never "Valve 03" or other Synapse labels. The
  // addressing doctrine (ADR + rebind layer) keeps Synapse names
  // in display surfaces; codegen converts to DO<n> at emit.
  const opsSrc = readFileSync(new URL(
    '../../../../estun_driver/estun_driver/program_ops.py',
    import.meta.url), 'utf8')
  assert.ok(/action in \('close_gripper', 'open_gripper',\s*'gripper_close', 'gripper_open'\)/
              .test(opsSrc),
    v('program_ops.codegen must dispatch on close_gripper / '
      + 'open_gripper / gripper_close / gripper_open as a group '
      + '— pre-fix these actions fell through to the generic '
      + 'motion branch and got silent-skipped.'))
  // The emitted line uses setDO + raw port int, not a Synapse id.
  assert.ok(/f'setDO\(\{port\},\{value\}\)/.test(opsSrc),
    v('codegen must emit setDO(<port>,<value>) literals — not '
      + 'Synapse names. The addressing doctrine keeps Synapse '
      + 'display at the UI layer; the wire is raw DO<n>.'))
  // Bind-by-id: codegen re-resolves io_close/io_open from the
  // cell's current EOAT valve so a stored DO0 placeholder from
  // pre-cell wizard output doesn't poison the emission.
  assert.ok(/_tool_valve_raw\s*=\s*None/.test(opsSrc),
    v('codegen must cache _tool_valve_raw per codegen call for '
      + 'the bind-by-id gripper resolve.'))
  assert.ok(/_cell_eoat_id/.test(opsSrc),
    v('codegen must read program.config.cell_eoat_id for the '
      + 'bind-by-id resolve.'))
  // The REFUSED marker surfaces an operator-actionable reason
  // (never raw gate jargon). String is split across adjacent
  // f-string literals in the source, so grep for the two key
  // phrases independently.
  assert.ok(/has no valve/.test(opsSrc)
             && /finish its setup/.test(opsSrc)
             && /EOAT Setup before saving/.test(opsSrc),
    v('codegen must emit the "no valve assigned — finish its '
      + 'setup in EOAT Setup" marker when the bind-by-id resolve '
      + 'finds no valve. The dashboard save-flow translates this '
      + 'into the plain-language toast.'))
})

test('save-flow translates semantic_roundtrip_error to plain operator copy', () => {
  // 2026-10-08: pre-fix the save handler surfaced the raw
  // "semantic_roundtrip_error" code to the frontend; the
  // operator saw "Controller refused the save — program not
  // loaded" + jargon in technicalDetail. The handler must now
  // parse the body_head for the gate's kind and route into a
  // named outcome (tool_io_unassigned / pallet_refused / codegen)
  // so loadOutcome.js can render operator-language copy.
  const dashSrc = readFileSync(new URL(
    '../../../cobot_dashboard/dashboard_server.py',
    import.meta.url), 'utf8')
  assert.ok(/code == "semantic_roundtrip_error"/.test(dashSrc),
    v('save-flow error extractor must branch on '
      + 'code=="semantic_roundtrip_error" so the raw code never '
      + 'reaches the operator.'))
  assert.ok(/outcome_kind_override = "tool_io_unassigned"/.test(dashSrc),
    v('save-flow must map a tool_io_refused finding to the '
      + 'named outcome kind "tool_io_unassigned".'))
  assert.ok(/outcome_kind_override = "pallet_refused"/.test(dashSrc),
    v('save-flow must map a pallet_ik_refused finding to the '
      + 'named outcome kind "pallet_refused".'))
  assert.ok(/not a teaching gap/.test(dashSrc),
    v('tool_io_unassigned operator copy must disclaim "this is '
      + 'a tool setup gap, not a teaching gap" so the operator '
      + 'is pointed at EOAT Setup not the Program Editor.'))
})

test('loadOutcome: tool_io_unassigned renders plain operator copy', async () => {
  const { namedLoadError } = await import('../../src/lib/loadOutcome.js')
  const out = namedLoadError({
    outcome: {
      kind: 'tool_io_unassigned',
      eoat_name: 'Finger Gripper',
      reason: "The gripper's valve isn't assigned on its cell record"
        + " — finish the tool's setup in EOAT Setup, then save again.",
    },
    error: 'raw',
  }, 400)
  assert.equal(out.code, 'tool_io_unassigned',
    v('tool_io_unassigned must produce a shaped outcome with the '
      + 'same code.'))
  assert.match(out.title, /Finger Gripper/,
    v('tool_io_unassigned title must interpolate the EOAT name '
      + 'so the operator knows which tool is missing a valve.'))
  // No raw gate jargon in the operator-visible strings.
  for (const banned of ['semantic_roundtrip', 'unknown_action',
                        'line_map', 'tool_io_refused']) {
    assert.ok(!out.title.includes(banned),
      v(`tool_io_unassigned title must not contain gate jargon `
        + `(${banned})`))
    assert.ok(!out.detail.includes(banned),
      v(`tool_io_unassigned detail must not contain gate jargon `
        + `(${banned})`))
  }
})

test('backend tool-IO gate names its outcome kind + the EOAT', () => {
  // The pre-run gate for the "tool IO unassigned" case must return
  // a NAMED outcome kind separate from pending_poses, with the
  // EOAT name interpolated into the operator-facing copy so the
  // operator knows which tool to finish setting up.
  const dashSrc = readFileSync(new URL(
    '../../../cobot_dashboard/dashboard_server.py',
    import.meta.url), 'utf8')
  assert.ok(/def _check_program_tool_io\(program: dict\)/.test(dashSrc),
    v('dashboard_server must define _check_program_tool_io(program).'))
  assert.ok(/"kind": "tool_io_unassigned"/.test(dashSrc),
    v('tool-IO gate outcome kind must be tool_io_unassigned — '
      + 'distinct from pending_poses so the UI can render the '
      + 'right copy.'))
  assert.ok(/has no valve assigned/.test(dashSrc)
             && /finish its setup/.test(dashSrc)
             && /EOAT Setup/.test(dashSrc),
    v('tool-IO gate operator copy must say "has no valve assigned '
      + '— finish its setup in EOAT Setup" so the operator is '
      + 'pointed at the right place (NOT the Program Editor).'))
  assert.ok(/not a teaching gap/.test(dashSrc),
    v('tool-IO gate copy must explicitly disclaim "this is a tool '
      + 'setup gap, not a teaching gap" so the operator doesn\'t '
      + 'retrace their steps looking for an untaught position.'))
})
