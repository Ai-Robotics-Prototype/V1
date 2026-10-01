// DOCTRINE — The Cell (2026-09-22 operator directive).
//
// Unified registry of EOATs + external fixtures with single-source
// port-allocation truth at /opt/cobot/cell.json. Wizards read AND
// write the cell so tools and fixtures can never collide on a port.
// Programs bind to cell entries by ID (not port literals), so if a
// port ever changes on the cell entry, emitted primitives follow.
//
// Pins:
//   1. Rename "Hardware Setup" → "EOAT Setup" complete in operator-
//      facing surfaces + component identity.
//   2. Backend cell endpoints exist and share a single _CELL_PATH.
//   3. Migration seed from tools_library is idempotent (meta stamp).
//   4. Cell store client + allocation single-source helper.
//   5. Named actions per cell entry — every action has a label +
//      description; the mapper generates the actions for each
//      power_mode branch.
//   6. Named-action → primitive compilation emits ONLY the primitives
//      already in the codegen ({set_io, verify_input, wait, operator_
//      continue}). Every primitive carries a cell_binding so a future
//      re-port on the cell entry is picked up automatically at emit.
//   7. Binding-by-id: primitives reference the entry's CURRENT valve
//      /out/in_done, not a snapshot; changing the port and re-emitting
//      yields the new io_id.
//   8. Missing-entry refusal returns operator-copy problems (no
//      silent stale-port emit).
//   9. Delete-with-references helper enumerates program refs.
//  10. My Cell view is VIEW-tier (no /cmd/, no writes, no
//      dispatchEvent).
//
// Failure format:
//   DOCTRINE CELL VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const {
  namedActionsForFixture, namedActionsForEoat,
  compileFixtureAction, compileEoatAction,
  checkCellBindings, programsReferencingCellId,
} = await import('../../src/lib/cellActions.js')

const {
  cellClaimedPorts, cellEoatsAsToolRows,
  findCellEoat, findCellFixture,
} = await import('../../src/lib/cellStore.js')

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')
// FRONT_ROOT = .../src/cobot_dashboard/frontend; back three levels
// lands at repo root (~/cobot_ws).
const REPO_ROOT = join(FRONT_ROOT, '..', '..', '..')
const readRepo = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

const editorSrc  = readSrc('components/ProgramEditor.jsx')
const eoatWizSrc = readSrc('components/EOATSetupWizard.jsx')
const fixWizSrc  = readSrc('components/ExternalFixtureWizard.jsx')
const myCellSrc  = readSrc('components/MyCellSection.jsx')
const cellStoreSrc = readSrc('lib/cellStore.js')
const cellActSrc = readSrc('lib/cellActions.js')
const synapseSrc = readSrc('pages/SynapsePage.jsx')
const backendSrc = readRepo(
  'src/cobot_dashboard/cobot_dashboard/dashboard_server.py')

function v(msg) { return `DOCTRINE CELL VIOLATED: ${msg}` }


// ── (1) Rename complete ────────────────────────────────────────────

test('operator-facing button label reads "EOAT Setup"', () => {
  // The launcher in ProgramEditor renders "EOAT Setup" (not
  // "Hardware Setup"). Legacy testid preserved as data-legacy-testid
  // for any operator-gate script that still references it.
  assert.ok(/>\s*EOAT Setup\s*</.test(editorSrc),
    v('ProgramEditor top-bar launcher must render "EOAT Setup".'))
  assert.equal(/>\s*Hardware Setup\s*</.test(editorSrc), false,
    v('ProgramEditor must not render "Hardware Setup" as a button label.'))
  assert.ok(/data-testid="eoat-setup-launcher"/.test(editorSrc),
    v('Launcher must expose data-testid="eoat-setup-launcher".'))
})

test('wizard file is EOATSetupWizard.jsx and exports EOATSetupWizard', () => {
  assert.ok(/export default function EOATSetupWizard\(/.test(eoatWizSrc),
    v('The wizard file must `export default function EOATSetupWizard(...)`.'))
  assert.ok(/EOAT Setup — pick a tool/.test(eoatWizSrc),
    v('Wizard title must read "EOAT Setup — pick a tool" (renamed).'))
})

test('no operator-facing "Hardware Setup" string remains in src (comments allowed)', () => {
  // Non-comment mentions must be gone from the app source. Test files
  // narrate history and are exempt.
  const files = [eoatWizSrc, fixWizSrc, editorSrc, myCellSrc,
                 cellStoreSrc, cellActSrc]
  for (const src of files) {
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:'"`])\/\/.*$/gm, '$1')
    assert.equal(/Hardware Setup/.test(codeOnly), false,
      v('An operator-facing "Hardware Setup" string still exists — '
        + 'rename to "EOAT Setup".'))
  }
})


// ── (2) Backend cell endpoints exist + share one _CELL_PATH ────────

test('dashboard_server declares /api/cell CRUD endpoints', () => {
  for (const route of [
    '@app.get("/api/cell")',
    '@app.post("/api/cell/eoat")',
    '@app.post("/api/cell/fixture")',
    '@app.delete("/api/cell/eoat/{eoat_id}")',
    '@app.delete("/api/cell/fixture/{fixture_id}")',
  ]) {
    assert.ok(backendSrc.includes(route),
      v(`Backend must declare ${route}`))
  }
  assert.ok(/_CELL_PATH = os\.environ\.get\(\s*'COBOT_CELL',/.test(backendSrc),
    v("Backend must define _CELL_PATH = os.environ.get('COBOT_CELL', "
      + "'/opt/cobot/cell.json') — one path constant."))
  // Only ONE definition — no fork.
  const paths = backendSrc.match(/_CELL_PATH\s*=/g) || []
  assert.equal(paths.length, 1,
    v(`_CELL_PATH must be defined exactly once — found ${paths.length}.`))
})

test('cell endpoints use a shared lock for read/write safety', () => {
  assert.ok(/_CELL_LOCK\s*=\s*threading\.RLock\(\)/.test(backendSrc),
    v('Backend must guard cell reads/writes with _CELL_LOCK (RLock)'))
  // Every endpoint body enters the lock.
  const endpoints = backendSrc.match(
    /def api_cell_[a-z_]+\([^)]*\):[\s\S]*?(?=\n    @app\.|def api_cell_)/g)
  if (endpoints) {
    for (const body of endpoints) {
      assert.ok(/with _CELL_LOCK:/.test(body),
        v('Every /api/cell endpoint must enter _CELL_LOCK before '
          + 'touching the cell.'))
    }
  }
})


// ── (3) Migration idempotence ──────────────────────────────────────

test('migration seeds cell.eoats from tools_library.list_tools with a stamp', () => {
  assert.ok(/def _migrate_cell_if_empty\(/.test(backendSrc),
    v('Backend must define _migrate_cell_if_empty'))
  assert.ok(/tools_library_seed_v1/.test(backendSrc),
    v('Migration stamp "tools_library_seed_v1" required for idempotence'))
  // Migration writes to cell.meta.migrations so future reads skip it.
  assert.ok(/stamps\s*=\s*set\(cell\.get\('meta',\s*\{\}\)\.get\('migrations'\)\s*or\s*\[\]\)/
              .test(backendSrc),
    v('Migration must read/write meta.migrations for idempotence'))
})


// ── (4) Cell store client + allocation single-source ───────────────

test('cellClaimedPorts unions eoats + fixtures port claims', () => {
  const cell = {
    eoats:    [{ id: 'e1', valve: 'V05', inputs: ['IN01'] }],
    fixtures: [{ id: 'f1', valve: 'V10', in_done: 'IN04', out: 'OUT02' }],
  }
  const c = cellClaimedPorts(cell)
  assert.deepEqual([...c.valves].sort(),  ['V05', 'V10'].sort())
  assert.deepEqual([...c.inputs].sort(),  ['IN01', 'IN04'].sort())
  assert.deepEqual([...c.outputs].sort(), ['OUT02'].sort())
})

test('cellEoatsAsToolRows adapts to fixturesData allocator shape', () => {
  const cell = { eoats: [{
    id: 'e1', name: 'Vac 1', valve: 'V03',
    inputs: ['IN04'], outputs: [] }] }
  const rows = cellEoatsAsToolRows(cell)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].config.assigned_valve, 'V03')
  assert.deepEqual(rows[0].config.assigned_inputs, ['IN04'])
})

test('findCellEoat + findCellFixture look up by id', () => {
  const cell = {
    eoats: [{ id: 'e1', name: 'Tool' }],
    fixtures: [{ id: 'f1', name: 'Vice 1' }],
  }
  assert.equal(findCellEoat(cell, 'e1').name, 'Tool')
  assert.equal(findCellFixture(cell, 'f1').name, 'Vice 1')
  assert.equal(findCellEoat(cell, 'nope'), null)
})


// ── (5) Named actions per cell entry ───────────────────────────────

test('air fixture with in_done produces close/open/wait_done', () => {
  const acts = namedActionsForFixture({
    id: 'f', name: 'Vice 1', power_mode: 'air',
    actuation: 'double', valve: 'V05', in_done: 'IN03',
    completion: 'sensor',
  })
  const keys = acts.map((a) => a.key)
  assert.deepEqual(keys, ['close', 'open', 'wait_done'])
  for (const a of acts) {
    assert.ok(a.label.includes('Vice 1'),
      v(`named action ${a.key} label must include the fixture name`))
    assert.ok(a.description && a.description.length > 0,
      v(`named action ${a.key} must have a non-empty description`))
  }
})

test('blow-off fixture produces only the pulse action', () => {
  const acts = namedActionsForFixture({
    id: 'f', name: 'Blow-off 1', power_mode: 'air',
    actuation: 'blow_off', valve: 'V10',
    completion: 'operator',
  })
  const keys = acts.map((a) => a.key)
  assert.deepEqual(keys, ['pulse'])
})

test('own-controller fixture with sensor produces trigger + wait_done', () => {
  const acts = namedActionsForFixture({
    id: 'f', name: 'Indexer', power_mode: 'own_controller',
    out: 'OUT03', in_done: 'IN05',
  })
  const keys = acts.map((a) => a.key)
  assert.deepEqual(keys, ['trigger', 'wait_done'])
})

test('own-controller fixture with wait timer produces trigger + wait_time', () => {
  const acts = namedActionsForFixture({
    id: 'f', name: 'Feeder', power_mode: 'own_controller',
    out: 'OUT02', completion: 'wait', wait_s: 3,
  })
  assert.deepEqual(acts.map((a) => a.key), ['trigger', 'wait_time'])
})

test('manual fixture produces only wait_operator', () => {
  const acts = namedActionsForFixture({
    id: 'f', name: 'Manual clamp', power_mode: 'manual',
    completion: 'operator',
  })
  assert.deepEqual(acts.map((a) => a.key), ['wait_operator'])
})

test('vacuum EOAT produces vacuum_on/vacuum_off', () => {
  const acts = namedActionsForEoat({
    id: 'e', name: 'Vac EOAT', type: 'vacuum', valve: 'V03',
  })
  assert.deepEqual(acts.map((a) => a.key), ['vacuum_on', 'vacuum_off'])
})

test('finger EOAT produces close/open', () => {
  const acts = namedActionsForEoat({
    id: 'e', name: 'Gripper', type: 'finger', valve: 'V01',
  })
  assert.deepEqual(acts.map((a) => a.key), ['close', 'open'])
})


// ── (6) Named-action → primitives (only existing verbs) ────────────

const _PRIMITIVE_ACTIONS = new Set([
  'set_io', 'verify_input', 'wait', 'operator_continue',
])

test('every emitted primitive uses only existing codegen actions', () => {
  const fixtures = [
    { id: 'a', name: 'Vice', power_mode: 'air',   actuation: 'double',
      valve: 'V05', in_done: 'IN02', completion: 'sensor' },
    { id: 'b', name: 'Blow', power_mode: 'air',   actuation: 'blow_off',
      valve: 'V10', completion: 'operator' },
    { id: 'c', name: 'Idx',  power_mode: 'own_controller',
      out: 'OUT03', in_done: 'IN05' },
    { id: 'd', name: 'Feed', power_mode: 'own_controller',
      out: 'OUT02', completion: 'wait', wait_s: 2 },
    { id: 'e', name: 'Man',  power_mode: 'manual', completion: 'operator' },
  ]
  for (const f of fixtures) {
    for (const a of namedActionsForFixture(f)) {
      const prims = compileFixtureAction(f, a.key)
      assert.ok(prims.length > 0,
        v(`compileFixtureAction ${f.name}.${a.key} must emit ≥ 1 primitive`))
      for (const p of prims) {
        assert.ok(_PRIMITIVE_ACTIONS.has(p.action),
          v(`Fixture ${f.name}.${a.key} emitted unknown action `
            + `"${p.action}" — allowed: ${[..._PRIMITIVE_ACTIONS].join(', ')}`))
      }
    }
  }
})

test('close/open primitives are exact-value set_io on the fixture valve', () => {
  const fx = { id: 'f', name: 'Vice 1', power_mode: 'air',
    actuation: 'double', valve: 'V07' }
  const close = compileFixtureAction(fx, 'close')
  assert.deepEqual(close, [{
    action: 'set_io', label: 'Close Vice 1',
    io_id: 'DO7', value: 1,
    cell_binding: { fixture_id: 'f', action: 'close' },
  }])
  const open = compileFixtureAction(fx, 'open')
  assert.equal(open[0].value, 0)
  assert.equal(open[0].io_id, 'DO7')
})

test('trigger primitive is set_io/wait/set_io pulse on the OUT', () => {
  const fx = { id: 'f', name: 'Feeder', power_mode: 'own_controller',
    out: 'OUT04' }
  const prims = compileFixtureAction(fx, 'trigger', { pulse_ms: 250 })
  assert.equal(prims.length, 3)
  assert.equal(prims[0].action, 'set_io')
  assert.equal(prims[0].io_id, 'DO4')
  assert.equal(prims[0].value, 1)
  assert.equal(prims[1].action, 'wait')
  assert.equal(prims[1].duration_s, 0.25)
  assert.equal(prims[2].action, 'set_io')
  assert.equal(prims[2].value, 0)
})

test('wait_done primitive is verify_input(DI, expect=1, on_fail=abort)', () => {
  const fx = { id: 'f', name: 'Vice 1', power_mode: 'air',
    actuation: 'double', valve: 'V05', in_done: 'IN03' }
  const prims = compileFixtureAction(fx, 'wait_done')
  assert.equal(prims.length, 1)
  assert.equal(prims[0].action, 'verify_input')
  assert.equal(prims[0].io_id, 'DI3')
  assert.equal(prims[0].expect, 1)
  assert.equal(prims[0].on_fail, 'abort')
})


// ── (7) Binding by id — no snapshot ────────────────────────────────

test('changing the cell entry port yields a new io_id on re-compile', () => {
  let fx = { id: 'f', name: 'Vice', power_mode: 'air',
    actuation: 'double', valve: 'V05' }
  assert.equal(compileFixtureAction(fx, 'close')[0].io_id, 'DO5')
  // Re-port the entry (as the cell would after a wizard edit).
  fx = { ...fx, valve: 'V10' }
  assert.equal(compileFixtureAction(fx, 'close')[0].io_id, 'DO10',
    v('re-compile with new port must yield the new io_id — binding by '
      + 'id, not by snapshot.'))
})

test('every emitted primitive carries a cell_binding tag', () => {
  const fx = { id: 'f', name: 'Vice', power_mode: 'air',
    actuation: 'double', valve: 'V05', in_done: 'IN03' }
  for (const key of ['close', 'open', 'wait_done']) {
    for (const p of compileFixtureAction(fx, key)) {
      assert.ok(p.cell_binding && p.cell_binding.fixture_id === 'f',
        v(`${key} primitives must include cell_binding.fixture_id`))
    }
  }
})


// ── (8) Missing-entry refusal ──────────────────────────────────────

test('checkCellBindings returns refusal when eoat_id is missing', () => {
  const problems = checkCellBindings(
    { config: { cell_eoat_id: 'missing' } },
    { eoats: [], fixtures: [] })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'missing_eoat')
  assert.ok(problems[0].detail.includes('missing'))
})

test('checkCellBindings returns refusal when a fixture_id is missing', () => {
  const problems = checkCellBindings(
    { config: { cell_fixture_ids: ['f1', 'f2'] } },
    { eoats: [], fixtures: [{ id: 'f1' }] })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].kind, 'missing_fixture')
})

test('checkCellBindings returns [] when every binding resolves', () => {
  const problems = checkCellBindings(
    { config: { cell_eoat_id: 'e1', cell_fixture_ids: ['f1'] } },
    { eoats: [{ id: 'e1' }], fixtures: [{ id: 'f1' }] })
  assert.deepEqual(problems, [])
})


// ── (9) Delete-with-references helper ──────────────────────────────

test('programsReferencingCellId lists programs binding a given id', () => {
  const programs = [
    { id: 'p1', config: { cell_eoat_id: 'e1' } },
    { id: 'p2', config: { cell_fixture_ids: ['f1'] } },
    { id: 'p3', config: {} },
  ]
  assert.deepEqual(
    programsReferencingCellId(programs, 'e1').map((p) => p.id),
    ['p1'])
  assert.deepEqual(
    programsReferencingCellId(programs, 'f1').map((p) => p.id),
    ['p2'])
  assert.deepEqual(
    programsReferencingCellId(programs, 'nope').map((p) => p.id),
    [])
})


// ── (10) My Cell VIEW-tier ─────────────────────────────────────────

test('MyCellSection is mounted on the Synapse page', () => {
  assert.ok(/import MyCellSection from '\.\.\/components\/MyCellSection'/
              .test(synapseSrc),
    v('SynapsePage must import MyCellSection'))
  assert.ok(/<MyCellSection\s*\/>/.test(synapseSrc),
    v('SynapsePage must render <MyCellSection />'))
})

test('MyCellSection is VIEW-tier: no writes, no /cmd/, no dispatchEvent', () => {
  const codeOnly = myCellSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1')
  for (const forbidden of [
    { pat: /\/cmd\//, label: '/cmd/' },
    { pat: /dispatchEvent\s*\(/, label: 'dispatchEvent()' },
    { pat: /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
      label: 'POST/PUT/DELETE/PATCH method' },
    { pat: /\.setItem\s*\(/, label: 'localStorage write' },
  ]) {
    assert.equal(forbidden.pat.test(codeOnly), false,
      v(`MyCellSection must NOT contain ${forbidden.label} — the view `
        + `is read-only; writes belong to the wizards.`))
  }
})

test('MyCellSection reuses the shared GuidanceBlock (no map fork)', () => {
  assert.ok(/import\s*\{\s*GuidanceBlock[^}]*\}\s*from\s*['"]\.\/EOATSetupWizard['"]/
              .test(myCellSrc),
    v('MyCellSection must import { GuidanceBlock } from EOATSetupWizard'))
})

test('MyCellSection exposes stable testids', () => {
  for (const tid of [
    'my-cell-section',
    'my-cell-empty',
    'my-cell-entry',
    'my-cell-entry-toggle',
    'my-cell-entry-body',
    'my-cell-actions',
    'my-cell-action',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(myCellSrc),
      v(`MyCellSection must expose data-testid="${tid}"`))
  }
})


// ── (11) External fixture wizard writes to the cell ────────────────

test('ExternalFixtureWizard writes to the cell on save/delete', () => {
  assert.ok(/import\s*\{[^}]*saveCellFixture[^}]*\}\s*from\s*['"]\.\.\/lib\/cellStore['"]/
              .test(fixWizSrc),
    v('ExternalFixtureWizard must import saveCellFixture from lib/cellStore'))
  assert.ok(/saveCellFixture\s*\(/.test(fixWizSrc),
    v('ExternalFixtureWizard must call saveCellFixture in commitSave'))
  assert.ok(/deleteCellFixture\s*\(/.test(fixWizSrc),
    v('ExternalFixtureWizard must call deleteCellFixture in commitDelete'))
})


// ── (12) Program-wizard tool step reads cell.eoats only ────────────
//
// 2026-09-22 operator directive (tool step): the wizard's tool
// choice is a CARDS-FROM-CELL step. No tool-type / gripper-type /
// actuation question survives in ANY program-creation flow.

const toolStepSrc = readSrc('components/ToolFromCellStep.jsx')
const wizardSrc   = readSrc('components/ProgramWizard.jsx')

test('ToolFromCellStep exists + reads cell.eoats via getCell', () => {
  assert.ok(/export default function ToolFromCellStep\(/.test(toolStepSrc),
    v('ToolFromCellStep must be a default export'))
  assert.ok(/import\s*\{\s*getCell\s*\}\s*from\s*['"]\.\.\/lib\/cellStore['"]/
              .test(toolStepSrc),
    v('ToolFromCellStep must import getCell from lib/cellStore'))
})

test('tool-step-renders-cell-cards-only: no ChoiceButton for gripper types in wizard', () => {
  // The old step rendered ChoiceButton entries for finger / vacuum
  // / custom in the SAME body as the "What type of gripper?"
  // question. Grep the wizard's CODE (comments narrating the retire
  // are exempt — they're historical narrative, not surfaces).
  const codeOnly = wizardSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1')
  assert.equal(/What type of gripper/.test(codeOnly), false,
    v('ProgramWizard must NOT ask "What type of gripper?" — retired.'))
  assert.equal(/label:\s*['"]Finger Gripper['"]/.test(codeOnly), false,
    v('ProgramWizard must NOT list "Finger Gripper" as a type option'))
  assert.equal(/label:\s*['"]Vacuum Suction['"]/.test(codeOnly), false,
    v('ProgramWizard must NOT list "Vacuum Suction" as a type option'))
  assert.equal(/label:\s*['"]Custom Gripper['"]/.test(codeOnly), false,
    v('ProgramWizard must NOT list "Custom Gripper" as a type option'))
})

test('gripper_settings STEP-upload step and CustomGripperPanel are retired', () => {
  assert.equal(/id:\s*['"]gripper_settings['"]/.test(wizardSrc), false,
    v('ProgramWizard must NOT declare a gripper_settings step — '
      + 'custom-tool creation lives in EOAT Setup now.'))
  assert.equal(/function CustomGripperPanel\(/.test(wizardSrc), false,
    v('CustomGripperPanel function must be deleted (dead-code disposition).'))
  assert.equal(/function GripperStlModel\(/.test(wizardSrc), false,
    v('GripperStlModel helper must be deleted with CustomGripperPanel.'))
  assert.equal(/function GripperPreviewCanvas\(/.test(wizardSrc), false,
    v('GripperPreviewCanvas helper must be deleted with CustomGripperPanel.'))
  assert.equal(/function IOPortDropdown\(/.test(wizardSrc), false,
    v('IOPortDropdown helper must be deleted with CustomGripperPanel.'))
  // And the orphaned imports too.
  assert.equal(/from\s+['"]three\/examples\/jsm\/loaders\/STLLoader['"]/
                .test(wizardSrc), false,
    v('STLLoader import must be pruned — used only by the retired '
      + 'GripperStlModel.'))
  assert.equal(/from\s+['"]@react-three\/fiber['"]/.test(wizardSrc), false,
    v('@react-three/fiber import must be pruned — used only by the '
      + 'retired GripperPreviewCanvas.'))
})

test('ProgramWizard tool step render is ToolFromCellStep (shared component)', () => {
  assert.ok(/import ToolFromCellStep from '\.\/ToolFromCellStep'/
              .test(wizardSrc),
    v('ProgramWizard must import ToolFromCellStep'))
  // The gripper_type page's render is now the imported component
  // itself, not an inline function.
  assert.ok(/id:\s*['"]gripper_type['"],\s*\n\s*render:\s*ToolFromCellStep/
              .test(wizardSrc),
    v('gripper_type step render must be `ToolFromCellStep` (shared '
      + 'component) — one mount serves every program-creation path '
      + '(palletize + machine-tend + pick-and-place ride the same '
      + 'PAGES list).'))
})

test('single-EOAT preselect + zero-EOAT empty state present in ToolFromCellStep', () => {
  assert.ok(/data-testid="tool-from-cell-empty"/.test(toolStepSrc),
    v('Zero-EOAT state must render data-testid="tool-from-cell-empty"'))
  assert.ok(/data-testid="tool-from-cell-empty-setup"/.test(toolStepSrc),
    v('Zero-EOAT state must expose a "Set up a tool" button'))
  assert.ok(/data-testid="tool-from-cell-confirm"/.test(toolStepSrc),
    v('Single-EOAT preselect must expose a one-tap Confirm button'))
  // The preselect logic: exactly one eoat + nothing already chosen.
  assert.ok(/eoats\.length === 1 && !answers\?\.cell_eoat_id/.test(toolStepSrc),
    v('Auto-preselect must trigger only when eoats.length===1 AND '
      + 'answers.cell_eoat_id is unset.'))
  // Data-state values expose the three UI states for DOM assertions.
  assert.ok(/data-state=\{eoats\.length === 0 \? 'empty'\s*\n?\s*:\s*eoats\.length === 1 \? 'single' : 'multi'\}/
              .test(toolStepSrc),
    v('ToolFromCellStep root must expose data-state="empty|single|multi".'))
})

test('setup-roundtrip-preserves-wizard-state: nested EOATSetupWizard + refetch', () => {
  // The "+ Set up a new tool" affordance opens EOATSetupWizard as a
  // nested modal. On close, ToolFromCellStep refetches the cell and
  // preselects the newest entry — ProgramWizard state around it is
  // preserved by construction (no unmount).
  assert.ok(/import EOATSetupWizard from '\.\/EOATSetupWizard'/
              .test(toolStepSrc),
    v('ToolFromCellStep must import EOATSetupWizard for the nested '
      + 'round-trip.'))
  assert.ok(/<EOATSetupWizard onClose=\{closeSetupAndRefresh\}/.test(toolStepSrc),
    v('The nested EOATSetupWizard onClose must trigger the refresh '
      + '(closeSetupAndRefresh)'))
  assert.ok(/preSetupEoatIds/.test(toolStepSrc),
    v('Round-trip must snapshot the pre-setup eoat ids so the newly-'
      + 'added entry can be preselected on close.'))
  // Empty-state also opens the same setup modal.
  assert.ok(/data-testid="tool-from-cell-empty-setup"[\s\S]*?onClick=\{openSetup\}/
              .test(toolStepSrc),
    v('Empty-state Setup button must call openSetup.'))
})

test('bind-by-id: commit writes cell_eoat_id and derives gripper_type + custom_tool_id', () => {
  // The commit path sets THREE keys on the wizard answers so
  // downstream (buildSteps, toolHookupKey, codegen) still gets its
  // legacy fields. Grep-pin the writes.
  for (const key of ['cell_eoat_id', 'gripper_type', 'custom_tool_id']) {
    assert.ok(new RegExp(`setAnswer\\(['"]${key}['"]`).test(toolStepSrc),
      v(`commit must setAnswer("${key}", ...)`))
  }
  // The commit's goNext override must carry the fresh values so
  // downstream skip predicates see them.
  assert.ok(/goNext\(\{\s*\n?\s*cell_eoat_id:/.test(toolStepSrc),
    v('commit goNext must pass an override object with cell_eoat_id + '
      + 'gripper_type + custom_tool_id so downstream skip predicates '
      + 'read fresh values (the wizard\'s advance-with-value rule).'))
})

test('palletizing rides the same tool step (single PAGES mount, no fork)', () => {
  // The gripper_type step has NO skip predicate — palletize +
  // machine_tend + pick_and_place all pass through it.
  const stepBlock = wizardSrc.match(
    /\{\s*\n?\s*id:\s*['"]gripper_type['"],[\s\S]*?render:\s*ToolFromCellStep[\s\S]*?\}/)
  assert.ok(stepBlock, v('gripper_type step block must exist'))
  assert.equal(/skip:/.test(stepBlock[0]), false,
    v('gripper_type step must have NO skip predicate — every '
      + 'program-creation path (palletize / machine-tend / '
      + 'pick-and-place) shares this ONE tool step.'))
  // And there's exactly ONE mount site — grep for the render binding.
  const mounts = wizardSrc.match(/render:\s*ToolFromCellStep/g) || []
  assert.equal(mounts.length, 1,
    v(`ToolFromCellStep must be mounted EXACTLY once in the PAGES `
      + `list — found ${mounts.length}.`))
})

test('type-question absent everywhere in program-creation flows (grep pin)', () => {
  // Scan every program-creation wizard for the retired question copy.
  // Comments narrating the retire are exempt (historical narrative).
  const searched = [
    'components/ProgramWizard.jsx',
    'components/ProgramFromDemonstration.jsx',
    'components/SetupWizard.jsx',
  ]
  for (const rel of searched) {
    let src
    try { src = readSrc(rel) } catch { continue }
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:'"`])\/\/.*$/gm, '$1')
    for (const pat of [
      /What type of gripper/i,
      /Choose the end-of-arm tool type/i,
      /Finger Gripper.*Vacuum Suction.*Custom Gripper/s,
    ]) {
      assert.equal(pat.test(codeOnly), false,
        v(`${rel} still contains a tool-type question — retire it.`))
    }
  }
})


// ── (13) Tool step uses the canonical wizard container ────────────
//
// 2026-10-01 operator field report: the tool step rendered in a
// bespoke prompt wrapper, so its window chrome diverged from every
// other PAGES entry. Fix: ToolFromCellStep imports the canonical
// QuestionCard from components/WizardStepCard and wraps its body in
// it; the inline <QuestionCard> definition in ProgramWizard.jsx is
// retired in favour of the same named import so the canonical chrome
// is single-sourced. Grep both facts here.

const stepCardSrc = readSrc('components/WizardStepCard.jsx')

test('tool-step-uses-canonical-container: ToolFromCellStep imports and renders QuestionCard', () => {
  assert.ok(
    /import\s*\{\s*QuestionCard\s*\}\s*from\s*['"]\.\/WizardStepCard['"]/
      .test(toolStepSrc),
    v('ToolFromCellStep must `import { QuestionCard } from "./WizardStepCard"` — canonical chrome, no fork.'))
  // The step body renders inside the imported QuestionCard — the
  // loading / error / main returns all open a <QuestionCard ...>
  // element. Count ≥ 3 to cover the three states.
  const uses = toolStepSrc.match(/<QuestionCard\b/g) || []
  assert.ok(uses.length >= 3,
    v(`ToolFromCellStep must render <QuestionCard> in every state `
      + `(loading / error / main) — found ${uses.length} uses.`))
  // The retired bespoke prompt wrapper (`_Question` helper + its
  // hand-rolled fontSize:18 heading) must be gone.
  assert.equal(/function\s+_Question\s*\(/.test(toolStepSrc), false,
    v('ToolFromCellStep must NOT define its own `_Question` prompt '
      + 'wrapper — the canonical QuestionCard replaces it.'))
})

test('canonical QuestionCard is single-sourced in WizardStepCard.jsx', () => {
  assert.ok(/export function QuestionCard\(/.test(stepCardSrc),
    v('WizardStepCard.jsx must export the named `QuestionCard` component.'))
  // ProgramWizard imports the same canonical named export AND does
  // NOT redefine it locally — one definition in the tree.
  assert.ok(
    /import\s*\{\s*QuestionCard\s*\}\s*from\s*['"]\.\/WizardStepCard['"]/
      .test(wizardSrc),
    v('ProgramWizard must import QuestionCard from WizardStepCard — '
      + 'no inline fork.'))
  assert.equal(/\n\s*function\s+QuestionCard\s*\(/.test(wizardSrc), false,
    v('ProgramWizard must NOT define a local `function QuestionCard(` '
      + '— the canonical container lives in WizardStepCard.jsx.'))
})

test('no bespoke wizard-page window wrappers (grep pin)', () => {
  // Any file that houses a ProgramWizard step is screened for a
  // hand-rolled fixed-overlay / full-modal window wrapper. The
  // outer modal chrome belongs to ProgramWizard itself; a step
  // that renders its own fixed/absolute overlay or its own card
  // backdrop is the exact class the 2026-10-01 field report called
  // out. ProgramWizard's own outer overlay + TeachSequence's
  // intentional fullscreen jog pendant are the sanctioned
  // exceptions and are grep-skipped by filename.
  const stepFiles = [
    'components/ToolFromCellStep.jsx',
  ]
  for (const rel of stepFiles) {
    const src = readSrc(rel)
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:'"`])\/\/.*$/gm, '$1')
    for (const pat of [
      /position:\s*['"]fixed['"]/,
      /zIndex\s*:\s*\d{3,}/,
      /inset:\s*0/,
    ]) {
      assert.equal(pat.test(codeOnly), false,
        v(`${rel} must NOT define its own modal/window chrome `
          + `(${pat}) — render inside the canonical QuestionCard.`))
    }
  }
})

test('ProgramWizard PAGES entries all route through the canonical container', () => {
  // Grep pin: every page in the PAGES list either (a) renders
  // <QuestionCard> inline, (b) uses one of the shared body helpers
  // that themselves wrap in <QuestionCard>, or (c) is the sanctioned
  // fullscreen teach_sequence (TeachSequence). No other inline
  // bespoke window wrappers are allowed to creep in.
  const SANCTIONED_FULLSCREEN = new Set(['teach_sequence'])
  // Grab the PAGES array body.
  const pagesStart = wizardSrc.indexOf('const PAGES = [')
  assert.ok(pagesStart >= 0, v('PAGES array must exist in ProgramWizard'))
  let depth = 1
  let i = pagesStart + 'const PAGES = ['.length
  while (i < wizardSrc.length && depth > 0) {
    if (wizardSrc[i] === '[') depth++
    else if (wizardSrc[i] === ']') depth--
    i++
  }
  const pagesBody = wizardSrc.slice(
    pagesStart + 'const PAGES = ['.length, i - 1)
  // Find each top-level `{ ... }` entry (same depth-walk).
  const entries = []
  let j = 0
  while (j < pagesBody.length) {
    const brace = pagesBody.indexOf('{', j)
    if (brace < 0) break
    let d = 1; let k = brace + 1
    while (k < pagesBody.length && d > 0) {
      if (pagesBody[k] === '{') d++
      else if (pagesBody[k] === '}') d--
      k++
    }
    entries.push(pagesBody.slice(brace, k))
    j = k
  }
  for (const body of entries) {
    const idMatch = body.match(/\n\s*id:\s*['"]([^'"]+)['"]/)
    if (!idMatch) continue
    const id = idMatch[1]
    if (SANCTIONED_FULLSCREEN.has(id)) continue
    const renderMatch = body.match(/render:\s*([A-Za-z_][A-Za-z0-9_]*)/)
    // Inline arrow render: body must mention QuestionCard directly.
    if (!renderMatch) {
      assert.ok(body.includes('QuestionCard'),
        v(`PAGES entry "${id}" inline render must wrap in QuestionCard`))
      continue
    }
    const target = renderMatch[1]
    // Allowed named renders: ToolFromCellStep (imports QuestionCard
    // from WizardStepCard), plus the inline body helpers in this
    // same file. Verify each body helper's own definition uses
    // QuestionCard.
    if (target === 'ToolFromCellStep') continue
    const defRe = new RegExp(
      `function\\s+${target}\\s*\\([\\s\\S]*?\\n\\}`, 'g')
    const defs = wizardSrc.match(defRe) || []
    assert.ok(defs.length > 0,
      v(`PAGES entry "${id}" references ${target} but no definition `
        + `found in ProgramWizard.jsx`))
    assert.ok(defs[0].includes('QuestionCard'),
      v(`PAGES entry "${id}" renders ${target}, which must itself `
        + `wrap in <QuestionCard>`))
  }
})
