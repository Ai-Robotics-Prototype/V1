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

const {
  shouldReviewHold,
} = await import('../../src/lib/cellReview.js')

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

test('MyCellSection is runtime-safe: no /cmd/, no dispatchEvent, no literal POST/DELETE string', () => {
  // 2026-10-01 operator directive moved rename + delete into My Cell;
  // the view calls saveCellEoat / deleteCellEoat from lib/cellStore
  // (which own the literal `method:` strings). This pin keeps the
  // runtime-safety invariants intact: no control-plane calls, no
  // dispatchEvent escape hatch, no localStorage writes, and no
  // literal `method: 'POST'` string sneaking back into the view —
  // writes still flow through the vetted cellStore helpers.
  const codeOnly = myCellSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1')
  for (const forbidden of [
    { pat: /\/cmd\//, label: '/cmd/' },
    { pat: /dispatchEvent\s*\(/, label: 'dispatchEvent()' },
    { pat: /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
      label: 'literal method: "POST/PUT/DELETE/PATCH" (route through cellStore)' },
    { pat: /\.setItem\s*\(/, label: 'localStorage write' },
  ]) {
    assert.equal(forbidden.pat.test(codeOnly), false,
      v(`MyCellSection must NOT contain ${forbidden.label} — control-`
        + `plane calls and raw fetches are off-limits; cell writes `
        + `must flow through lib/cellStore (saveCellEoat / deleteCellEoat).`))
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


// ── (14) Multi-actuator cell schema + end-to-end roundtrip ─────────
//
// 2026-10-01 operator directive extensions:
//   * cellClaimedPorts must union EVERY valve in actuators[]
//     (otherwise a dual-actuator tool silently frees a port it
//     actually consumes, and the next allocation collides).
//   * The backend accepts actuators + sensor_count on
//     /api/cell/eoat POST and persists them, so a tool saved by
//     the EOAT Setup wizard is readable by the Program Wizard
//     tool-step on its next getCell.
//   * The migration _migrate_actuators_v1 backfills legacy
//     single-valve entries with actuators[0] so every reader sees
//     one shape.

test('cellClaimedPorts unions multi-actuator valves (no silent drops)', () => {
  const cell = {
    eoats: [{
      id: 'e1', name: 'Dual',
      valve: 'V05',
      actuators: [
        { type: 'single_acting', valve: 'V05' },
        { type: 'vacuum',        valve: 'V10' },
      ],
      inputs: ['IN01'],
    }],
    fixtures: [],
  }
  const c = cellClaimedPorts(cell)
  assert.deepEqual([...c.valves].sort(), ['V05', 'V10'],
    v('cellClaimedPorts must claim EVERY actuators[*].valve — a '
      + 'dual-actuator tool had valves [V05, V10], got '
      + `[${[...c.valves].sort().join(', ')}].`))
})

test('backend /api/cell/eoat accepts actuators + sensor_count fields', () => {
  // Grep the handler body — it must thread actuators through to the
  // persisted entry (operator-controlled payload fields need
  // explicit allow-listing in the handler).
  assert.ok(/body\.get\(['"]actuators['"]\)/.test(backendSrc),
    v('/api/cell/eoat handler must read body["actuators"] from the '
      + 'POST payload — the multi-actuator schema is operator-driven.'))
  assert.ok(/body\.get\(['"]sensor_count['"]\)/.test(backendSrc),
    v('/api/cell/eoat handler must read body["sensor_count"] from '
      + 'the POST payload.'))
  // Entry constructed with actuators (list) + sensor_count fields.
  assert.ok(/'actuators':\s*actuators,/.test(backendSrc),
    v("Persisted cell entry must include 'actuators': actuators"))
  assert.ok(/'sensor_count':\s*body\.get\(['"]sensor_count['"]\)/
              .test(backendSrc),
    v("Persisted cell entry must include 'sensor_count'"))
})

test('migration cell_actuators_v1 backfills legacy single-valve entries', () => {
  assert.ok(/def _migrate_actuators_v1\(/.test(backendSrc),
    v('Backend must define _migrate_actuators_v1 — the backfill '
      + 'that upgrades legacy single-valve cell entries to carry '
      + 'actuators[0] so every reader sees one shape.'))
  assert.ok(/'cell_actuators_v1' in stamps/.test(backendSrc),
    v('Migration must consult the cell_actuators_v1 stamp for '
      + 'idempotence (never re-run against an already-migrated cell).'))
  assert.ok(/'migrated_from':\s*'single_valve_v0'/.test(backendSrc),
    v("Migrated actuator entries must carry "
      + "'migrated_from': 'single_valve_v0' as a provenance tag — "
      + 'a session that later audits the migration can distinguish '
      + 'operator-written actuators from auto-filled ones.'))
})

test('new-profile-appears-in-program-wizard: save + getCell roundtrip', async () => {
  // Simulate the end-to-end chain IN-MEMORY by mocking fetch:
  //   1. EOATSetupWizard.CustomEOATFlow.finish() → saveCellEoat()
  //      POST /api/cell/eoat with { name, actuators, sensor_count }
  //   2. ProgramWizard tool step calls getCell() → GET /api/cell
  //      → the entry we just posted is in cell.eoats.
  const { saveCellEoat, getCell } = await import('../../src/lib/cellStore.js')

  const stored = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    if (url === '/api/cell/eoat' && opts && opts.method === 'POST') {
      const entry = { ...JSON.parse(opts.body), id: 'eoat_t1',
                      created_at: '2026-10-01T00:00:00Z' }
      stored.push(entry)
      return new Response(JSON.stringify({ ok: true, entry }),
                          { status: 200 })
    }
    if (url === '/api/cell') {
      return new Response(JSON.stringify({
        ok: true, cell: { eoats: stored, fixtures: [], meta: {} },
      }), { status: 200 })
    }
    throw new Error(`unmocked fetch: ${url}`)
  }
  try {
    const payload = {
      name: 'Dual Tool',
      type: 'custom',
      valve: 'V05',
      inputs: ['IN01', 'IN02'],
      actuators: [
        { type: 'single_acting', hold_on_loss: false, valve: 'V05',
          label: 'gripper' },
        { type: 'vacuum',        hold_on_loss: false, valve: 'V10',
          label: 'vacuum' },
      ],
      sensor_count: 2,
    }
    const saved = await saveCellEoat(payload)
    assert.equal(saved.name, 'Dual Tool',
      v('saveCellEoat must echo the saved entry back'))

    // Program Wizard tool step would call getCell on mount.
    const cell = await getCell()
    const found = cell.eoats.find((e) => e.id === 'eoat_t1')
    assert.ok(found,
      v('Program Wizard getCell must see the EOAT the wizard just saved'))
    assert.equal(found.actuators.length, 2,
      v('Round-tripped entry must preserve all actuators'))
    assert.deepEqual(found.actuators.map((a) => a.valve), ['V05', 'V10'],
      v('Round-tripped entry must preserve per-actuator valves in order'))
  } finally {
    global.fetch = originalFetch
  }
})


// ── (15) EOAT setup name + save-visibility (2026-10-01) ────────────
//
// Operator directive: every EOAT setup path (finger / vacuum /
// custom) must (a) ask the operator to NAME the tool, (b) refuse
// duplicate names, and (c) show a save-confirmation screen with
// [View in My Cell] / [Set up another tool] / [Done]. No silent-end
// wizard.

test('name-step-present-and-required: custom path has name step', () => {
  // Already pinned at step-count level — this pin is explicit about
  // the input + required predicate so a future refactor can't quietly
  // drop the field.
  assert.ok(/data-testid="custom-eoat-name"/.test(eoatWizSrc),
    v('Custom flow must render data-testid="custom-eoat-name" input'))
  assert.ok(/const\s+nameTrim\s*=\s*name\.trim\(\)/.test(eoatWizSrc),
    v('Custom flow must trim the name before using it'))
  // Required predicate — Next on step 0 blocks when name is empty
  // AND when the name clashes with an existing cell entry.
  assert.ok(/step === 0 \? nameOk/.test(eoatWizSrc),
    v('Custom flow canAdvance(step===0) must gate on nameOk '
      + '(nameOk = trim.length > 0 && !nameClash).'))
})

test('name-step-present-and-required: standard paths prompt for a name', () => {
  // The standard body wraps a StandardNameInput component when the
  // active tool is finger OR vacuum. The input prefills from
  // _STANDARD_NAME_DEFAULTS and the operator can edit it before
  // confirming.
  assert.ok(/<StandardNameInput/.test(eoatWizSrc),
    v('Standard body must mount <StandardNameInput /> so finger/vacuum '
      + 'paths ask the operator to name the tool.'))
  assert.ok(/_STANDARD_NAME_DEFAULTS\s*=\s*\{[\s\S]*?finger:\s*'Finger Gripper'[\s\S]*?vacuum:\s*'Vacuum Tool'[\s\S]*?\}/
              .test(eoatWizSrc),
    v("Standard name prefills must be { finger: 'Finger Gripper', "
      + "vacuum: 'Vacuum Tool' } — the operator can edit, but a tap-"
      + 'through workflow still produces named entries.'))
  // Confirm button is disabled when the name is empty or clashes.
  assert.ok(/standardNameClash/.test(eoatWizSrc),
    v('Standard path must compute standardNameClash and feed it to the '
      + 'Confirm disabled predicate.'))
})

test('duplicate-name guard: shared helper with plain-copy refusal', () => {
  // One helper per spec — case-insensitive, trimmed, with the
  // excludeId escape for the same-id rename path.
  assert.ok(/function\s+_nameClashes\(cell,\s*candidate,\s*excludeId\s*=\s*null\)/
              .test(eoatWizSrc),
    v('EOATSetupWizard must define _nameClashes(cell, candidate, excludeId=null)'))
  // Plain-copy refusal rendered in both the custom and standard flows.
  // Grep for the two anchor phrases together instead of a brittle
  // name-token regex (the message interpolates the operator's name).
  const copyHits = (eoatWizSrc.match(/You already have a tool named/g) || []).length
  assert.ok(copyHits >= 3,
    v("'You already have a tool named …' refusal must appear at least "
      + '3 times (standard confirm handler, custom finish, inline '
      + `JSX) — found ${copyHits}.`))
  const tailHits = (eoatWizSrc.match(/pick another name/g) || []).length
  assert.ok(tailHits >= 3,
    v("'pick another name' tail copy must appear at least 3 times — "
      + `found ${tailHits}. This is the operator-visible refusal copy, `
      + 'single-sourced across every entry point.'))
  // Pinned testids on both flows so the refusal is DOM-targetable.
  for (const tid of [
    'custom-eoat-name-clash',
    'hardware-setup-standard-name-clash',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(eoatWizSrc),
      v(`Duplicate-name refusal must expose data-testid="${tid}"`))
  }
})

test('save-confirmation screen renders on all three paths (no silent end)', () => {
  // SavedScreen is the shared closing surface, mounted on BOTH the
  // standard-path body and the custom-flow step 4.
  assert.ok(/function\s+SavedScreen\(/.test(eoatWizSrc),
    v('EOATSetupWizard must define a SavedScreen function — the '
      + 'shared closing surface across standard + custom paths.'))
  // Standard-path mount: when savedEntry is set we render SavedScreen.
  const standardMount = /savedEntry\s*&&\s*toolKey\s*!==\s*['"]custom_new['"][\s\S]{0,120}<SavedScreen/
  assert.ok(standardMount.test(eoatWizSrc),
    v('Standard body must mount <SavedScreen /> when savedEntry is set '
      + '(gated on toolKey !== "custom_new"). This is the standard-path '
      + 'exit — no silent-end for finger/vacuum.'))
  // Custom-flow mount: step 4 + savedEntry → SavedScreen.
  const customMount = /step === 4 && savedEntry[\s\S]{0,80}<SavedScreen/
  assert.ok(customMount.test(eoatWizSrc),
    v('CustomEOATFlow step 4 must mount <SavedScreen /> when savedEntry '
      + 'is set (not the old inline "saved" strip).'))
  // Three action buttons on the saved screen.
  for (const tid of [
    'hardware-setup-saved-view',
    'hardware-setup-saved-another',
    'hardware-setup-saved-done',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(eoatWizSrc),
      v(`SavedScreen must expose data-testid="${tid}"`))
  }
  // Headline carries the operator's name verbatim.
  assert.ok(/"\{name\}" saved to your cell\./.test(eoatWizSrc),
    v('SavedScreen headline must read \'"<name>" saved to your cell.\''))
})

test('view-in-my-cell navigation routes to the Synapse tab', () => {
  // SavedScreen's primary action lands on My Cell. The Synapse tab
  // is where MyCellSection is mounted (pages/SynapsePage.jsx).
  assert.ok(/useStore\.getState\(\)\.setTab\(['"]synapse['"]\)/
              .test(eoatWizSrc),
    v('viewInMyCell must call useStore.getState().setTab("synapse") so '
      + 'the Synapse tab (which mounts MyCellSection) is the landing '
      + 'spot for the operator.'))
})


// ── (16) My Cell rename + delete (2026-10-01) ──────────────────────

test('rename affordance: My Cell entries render Rename + Save/Cancel buttons', () => {
  for (const tid of [
    'my-cell-entry-rename',
    'my-cell-entry-rename-input',
    'my-cell-entry-rename-save',
    'my-cell-entry-rename-cancel',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(myCellSrc),
      v(`My Cell row must expose data-testid="${tid}" for the rename flow`))
  }
})

test('rename-preserves-program-binding: cell POST reuses entry id (name-only diff)', () => {
  // The rename commit path spreads the full entry and only overwrites
  // name. Backend upserts by id, so every program binding by id
  // survives untouched. Grep the commit payload shape.
  assert.ok(/const\s+payload\s*=\s*\{\s*\.\.\.entry,\s*name:\s*next\s*\}/
              .test(myCellSrc),
    v('commitRename must build payload = { ...entry, name: next } — '
      + 'any other shape risks dropping actuators[] / inputs / '
      + 'sensor_count and would silently break program bindings.'))
  assert.ok(/saveCellEoat\(payload\)/.test(myCellSrc),
    v('commitRename must POST via saveCellEoat(payload) so the '
      + 'backend upsert key (id) is preserved — programs bound by id '
      + 'follow the rename automatically.'))
})

test('rename-preserves-program-binding: id-binding roundtrip (fetch-mocked)', async () => {
  // Simulate end-to-end: start with an EOAT in the cell + a program
  // whose config.cell_eoat_id points at it. Rename the EOAT. Fetch
  // the program again. Verify the program's binding still resolves
  // to the renamed entry.
  const { saveCellEoat, getCell } = await import('../../src/lib/cellStore.js')
  const originalFetch = global.fetch

  const cell = { eoats: [{
    id: 'eoat_x1', name: 'Old Name', type: 'vacuum',
    valve: 'V03', inputs: ['IN04'], outputs: [],
    actuators: [{ type: 'vacuum', hold_on_loss: false,
                  valve: 'V03', label: 'vacuum' }],
    sensor_count: 1,
  }], fixtures: [], meta: {} }
  const program = { id: 'p1', name: 'Pick',
                    config: { cell_eoat_id: 'eoat_x1' } }

  global.fetch = async (url, opts) => {
    if (url === '/api/cell/eoat' && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      // Upsert in place by id — the backend contract.
      const existing = cell.eoats.find((e) => e.id === body.id)
      Object.assign(existing, body)
      return new Response(JSON.stringify({ ok: true, entry: existing }),
                          { status: 200 })
    }
    if (url === '/api/cell') {
      return new Response(JSON.stringify({ ok: true, cell }),
                          { status: 200 })
    }
    throw new Error(`unmocked fetch: ${url}`)
  }
  try {
    const existing = cell.eoats[0]
    await saveCellEoat({ ...existing, name: 'New Name' })
    const after = await getCell()
    const renamed = after.eoats.find((e) => e.id === 'eoat_x1')
    assert.equal(renamed.name, 'New Name',
      v('Rename must persist the new name on the same id'))
    // Program's cell_eoat_id still resolves to the renamed entry.
    const resolved = after.eoats.find(
      (e) => e.id === program.config.cell_eoat_id)
    assert.ok(resolved,
      v('Program binding by id must still resolve after rename'))
    assert.equal(resolved.name, 'New Name',
      v('Program binding should transparently see the new name '
        + 'because programs bind by id, not by name.'))
    // Preserved fields (actuators + sensor_count + ports) survive.
    assert.equal(resolved.sensor_count, 1,
      v('Rename must preserve sensor_count'))
    assert.deepEqual(resolved.inputs, ['IN04'],
      v('Rename must preserve inputs'))
    assert.equal(resolved.actuators.length, 1,
      v('Rename must preserve the actuators array'))
  } finally {
    global.fetch = originalFetch
  }
})

test('delete affordance: My Cell entries render Delete + confirm with programs warning', () => {
  for (const tid of [
    'my-cell-entry-delete',
    'my-cell-entry-delete-confirm',
    'my-cell-entry-delete-commit',
    'my-cell-entry-delete-cancel',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(myCellSrc),
      v(`My Cell row must expose data-testid="${tid}" for the delete flow`))
  }
  // Programs-ref warning uses the existing cellActions helper so a
  // future binding-source change (new config field) auto-propagates.
  assert.ok(/import\s*\{[^}]*programsReferencingCellId[^}]*\}/.test(myCellSrc),
    v('MyCellSection must import programsReferencingCellId from '
      + 'lib/cellActions — the existing programs-reference warning '
      + 'helper (per the Sep 22 directive) is the single source.'))
  assert.ok(/data-testid="my-cell-entry-delete-ref"/.test(myCellSrc),
    v('Programs-reference list items must expose data-testid='
      + '"my-cell-entry-delete-ref" so tests can target them.'))
})


// ── (17) Per-path save-and-reuse roundtrip (2026-10-01) ────────────

test('standard finger: save → cell carries operator name under standard:finger', async () => {
  const { saveCellEoat, getCell } = await import('../../src/lib/cellStore.js')
  const stored = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    if (url === '/api/cell/eoat' && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      const i = stored.findIndex((e) => e.id === body.id)
      if (i >= 0) stored[i] = body
      else stored.push(body)
      return new Response(JSON.stringify({ ok: true, entry: body }),
                          { status: 200 })
    }
    if (url === '/api/cell') {
      return new Response(JSON.stringify({
        ok: true, cell: { eoats: stored, fixtures: [], meta: {} },
      }), { status: 200 })
    }
    throw new Error(`unmocked fetch: ${url}`)
  }
  try {
    const saved = await saveCellEoat({
      id: 'standard:finger', name: 'My Gripper', type: 'finger',
      valve: 'V01', inputs: ['IN01', 'IN02'], outputs: [],
      actuators: [{ type: 'single_acting', hold_on_loss: false,
                    valve: 'V01', label: 'actuator' }],
      sensor_count: 2,
    })
    assert.equal(saved.name, 'My Gripper',
      v('Standard-finger save must echo the operator-supplied name'))
    const cell = await getCell()
    const found = cell.eoats.find((e) => e.id === 'standard:finger')
    assert.ok(found, v('Standard-finger entry must appear in the cell'))
    assert.equal(found.name, 'My Gripper',
      v('Operator name — not type label — must be the card title'))
  } finally {
    global.fetch = originalFetch
  }
})

test('standard vacuum: save upserts under standard:vacuum (one-per-type)', async () => {
  const { saveCellEoat, getCell } = await import('../../src/lib/cellStore.js')
  const stored = [{
    id: 'standard:vacuum', name: 'Prior Vacuum', type: 'vacuum',
    valve: 'V03', inputs: ['IN04'], outputs: [],
  }]
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    if (url === '/api/cell/eoat' && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      const i = stored.findIndex((e) => e.id === body.id)
      if (i >= 0) stored[i] = body
      else stored.push(body)
      return new Response(JSON.stringify({ ok: true, entry: body }),
                          { status: 200 })
    }
    if (url === '/api/cell') {
      return new Response(JSON.stringify({
        ok: true, cell: { eoats: stored, fixtures: [], meta: {} },
      }), { status: 200 })
    }
    throw new Error(`unmocked fetch: ${url}`)
  }
  try {
    await saveCellEoat({
      id: 'standard:vacuum', name: 'Edited Vacuum', type: 'vacuum',
      valve: 'V03', inputs: ['IN04'], outputs: [],
    })
    const cell = await getCell()
    const matches = cell.eoats.filter(
      (e) => e.id === 'standard:vacuum')
    assert.equal(matches.length, 1,
      v('Standard-vacuum save must upsert in place — no duplicate '
        + 'standard:vacuum entry can appear.'))
    assert.equal(matches[0].name, 'Edited Vacuum',
      v('Upsert must overwrite the name field with the operator edit'))
  } finally {
    global.fetch = originalFetch
  }
})

test('custom path: save → entry appears + resolveable by ToolFromCellStep card shape', async () => {
  const { saveCellEoat, getCell } = await import('../../src/lib/cellStore.js')
  const stored = []
  const originalFetch = global.fetch
  global.fetch = async (url, opts) => {
    if (url === '/api/cell/eoat' && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      // Backend assigns a fresh id when none supplied.
      const entry = { id: 'eoat_abc1234', ...body }
      stored.push(entry)
      return new Response(JSON.stringify({ ok: true, entry }),
                          { status: 200 })
    }
    if (url === '/api/cell') {
      return new Response(JSON.stringify({
        ok: true, cell: { eoats: stored, fixtures: [], meta: {} },
      }), { status: 200 })
    }
    throw new Error(`unmocked fetch: ${url}`)
  }
  try {
    const payload = {
      name: 'Multi-Tool',
      type: 'custom',
      valve: 'V05',
      inputs: ['IN01'],
      outputs: [],
      actuators: [
        { type: 'single_acting', hold_on_loss: false, valve: 'V05',
          label: 'gripper' },
        { type: 'vacuum', hold_on_loss: false, valve: 'V10',
          label: 'vacuum' },
      ],
      sensor_count: 1,
    }
    const saved = await saveCellEoat(payload)
    assert.equal(saved.name, 'Multi-Tool',
      v('Custom save must echo the operator-supplied name'))
    const cell = await getCell()
    const found = cell.eoats.find((e) => e.id === saved.id)
    assert.ok(found,
      v('Custom entry must appear in the cell after save'))
    // ToolFromCellStep renders cards from cell.eoats directly — the
    // card title is entry.name, type is entry.type, and ports render
    // via valve + inputs.
    assert.equal(found.name, 'Multi-Tool')
    assert.equal(found.type, 'custom')
    assert.equal(found.actuators.length, 2,
      v('Both actuators must survive the roundtrip'))
  } finally {
    global.fetch = originalFetch
  }
})


// ── 2026-10-02 hold-on-loss default: My Cell review-chip + no-migration ──
//
// Saved profiles are NEVER silently migrated — changing a valve class
// behind the operator's back changes physical behavior. Legacy entries
// get a subtle "review recommended" chip + plain copy; the operator
// re-confirms per tool.

test('shouldReviewHold flags legacy single-valve finger (single_acting, hold false)', () => {
  const legacyFinger = {
    id: 'standard:finger', name: 'Finger Gripper', type: 'finger',
    valve: 'V01', inputs: ['IN01', 'IN02'],
    actuators: [{
      type: 'single_acting', hold_on_loss: false,
      valve: 'V01', label: 'actuator',
    }],
  }
  assert.equal(shouldReviewHold(legacyFinger), false,
    v('single_acting physically cannot hold on loss — it must NEVER '
      + 'trigger the review chip (it is already honest).'))
})

test('shouldReviewHold flags legacy vacuum entry with hold_on_loss=false', () => {
  const legacyVacuum = {
    id: 'standard:vacuum', name: 'Vacuum Suction', type: 'vacuum',
    valve: 'V03', inputs: ['IN04'],
    actuators: [{
      type: 'vacuum', hold_on_loss: false, valve: 'V03', label: 'vacuum',
    }],
  }
  assert.equal(shouldReviewHold(legacyVacuum), true,
    v('A pre-directive vacuum entry recording hold_on_loss=false '
      + 'must trigger the chip — operator should re-confirm whether '
      + 'the tool has a check valve.'))
})

test('shouldReviewHold does NOT flag vacuum entries that record holds_via=check_valve', () => {
  const freshVacuum = {
    id: 'standard:vacuum', name: 'Vacuum Suction', type: 'vacuum',
    valve: 'V03', inputs: ['IN04'],
    actuators: [{
      type: 'vacuum', hold_on_loss: true, holds_via: 'check_valve',
      valve: 'V03', label: 'vacuum',
    }],
  }
  assert.equal(shouldReviewHold(freshVacuum), false,
    v('A fresh vacuum entry recording holds_on_loss=true + '
      + 'holds_via=check_valve is already truthful — no chip.'))
})

test('shouldReviewHold flags double_acting with hold_on_loss=false (release)', () => {
  const dsReleaseFinger = {
    id: 'standard:finger', name: 'Finger Gripper', type: 'finger',
    valve: 'V01', inputs: ['IN01', 'IN02'],
    actuators: [{
      type: 'double_acting', hold_on_loss: false,
      valve: 'V01', label: 'actuator',
    }],
  }
  assert.equal(shouldReviewHold(dsReleaseFinger), true,
    v('A double-acting entry with hold_on_loss=false predates the '
      + '2026-10-02 safety default — chip the entry so the operator '
      + 'can re-confirm.'))
})

test('shouldReviewHold does NOT flag fresh standard finger (double_acting, hold true)', () => {
  const freshFinger = {
    id: 'standard:finger', name: 'Finger Gripper', type: 'finger',
    valve: 'V01', inputs: ['IN01', 'IN02'],
    actuators: [{
      type: 'double_acting', hold_on_loss: true,
      valve: 'V01', label: 'actuator',
    }],
  }
  assert.equal(shouldReviewHold(freshFinger), false,
    v('A fresh finger entry under the new default (double_acting + '
      + 'hold true) must NOT trigger the chip.'))
})

test('shouldReviewHold flags legacy air fixture with hold_on_loss=false', () => {
  const legacyVice = {
    id: 'fx_abc', name: 'Vice 1', type: 'vice',
    power_mode: 'air', actuation: 'double',
    hold_on_loss: false, valve: 'V05',
  }
  assert.equal(shouldReviewHold(legacyVice), true,
    v('A pre-directive air-powered fixture recording hold_on_loss='
      + 'false must trigger the chip.'))
})

test('shouldReviewHold ignores own-controller / manual fixtures (no hold question)', () => {
  const indexer = {
    id: 'fx_i', name: 'Indexer', type: 'indexer',
    power_mode: 'own_controller', hold_on_loss: null,
  }
  const manual = {
    id: 'fx_m', name: 'Manual', type: 'other',
    power_mode: 'manual', hold_on_loss: null,
  }
  assert.equal(shouldReviewHold(indexer), false,
    v('Own-controller fixtures never ask the hold question — no chip.'))
  assert.equal(shouldReviewHold(manual), false,
    v('Manual fixtures never ask the hold question — no chip.'))
})

test('shouldReviewHold ignores blow-off fixtures (no hold state at all)', () => {
  const blowoff = {
    id: 'fx_b', name: 'Blow-off', type: 'blow_off',
    power_mode: 'air', actuation: 'blow_off', hold_on_loss: null,
  }
  assert.equal(shouldReviewHold(blowoff), false,
    v('Blow-off is default-off; no hold state to review.'))
})

test('MyCellSection renders review-chip for flagged entries', () => {
  assert.ok(/data-testid="my-cell-entry-review-chip"/.test(myCellSrc),
    v('MyCellSection must render a review-recommended chip with '
      + 'data-testid="my-cell-entry-review-chip" for legacy hold '
      + 'entries.'))
  // 2026-10-02 plain-register directive: the chip no longer uses
  // the banned "hold-on-loss" phrase. It reads in operator language.
  assert.ok(
    /Review recommended — set what happens on power loss/.test(myCellSrc),
    v('Chip must carry the "Review recommended — set what happens '
      + 'on power loss" plain-copy label (2026-10-02 register).'))
  assert.ok(/import \{ shouldReviewHold \} from '\.\.\/lib\/cellReview'/
    .test(myCellSrc),
    v('MyCellSection must import shouldReviewHold from the shared '
      + 'lib/cellReview module (test-reachable single source).'))
})

test('NO silent migration: backend never rewrites hold_on_loss on legacy entries', () => {
  // Scan the cell endpoint block + migration helper for any
  // assignment that would silently flip saved hold_on_loss to
  // true. The actuators backfill is allowed to seed hold_on_loss
  // for new fields but must NOT overwrite existing values.
  const migrator = backendSrc.match(
    /def _migrate_actuators_v1[\s\S]*?(?=\n    def [a-zA-Z_])/)
  assert.ok(migrator, v('_migrate_actuators_v1 helper not found'))
  const code = migrator[0]
  // The seed line "hold_on_loss': False" is allowed (new backfill
  // keeps the honest 'false' for legacy single_acting entries).
  // A regression would look like "hold_on_loss'] = True" on an
  // existing entry — forbid that pattern.
  assert.equal(/hold_on_loss['"]\]\s*=\s*True/.test(code), false,
    v('_migrate_actuators_v1 must NEVER overwrite an existing '
      + 'hold_on_loss to True — that would silently change the '
      + 'physical behavior of saved tools.'))
})


// ── 2026-10-02 EOAT wizard: per-actuator preselects + vacuum copy ──

test('EOAT wizard custom path preselects holdOnLoss=true on grips_fingers capability', () => {
  // 2026-10-02 plain-register directive: the per-actuator type picker
  // was replaced by a multi-select "What does this tool do?" step.
  // Each capability catalog entry carries its own preselect — the
  // compilation-equivalence pin below guarantees the resulting
  // actuator record matches the old flow's output.
  //
  // 2026-10-05 operator order: the hold-question UI is retired —
  // both finger and suction custom tools ALWAYS hold the part on
  // power/air loss. The preselect in the capability catalog is now
  // the record-truth source (no operator toggle); AlwaysHoldsNote
  // surfaces the decision as read-only copy.
  const capSrc = readSrc('lib/eoatCapabilities.js')
  assert.ok(/key: 'grips_fingers'/.test(capSrc),
    v('Capability catalog must include grips_fingers.'))
  assert.ok(
    /actuatorType:\s*'double_acting',[\s\S]*?preselect:\s*\{\s*holdOnLoss:\s*true\s*\}/
      .test(capSrc),
    v('grips_fingers capability must map to actuatorType=double_acting '
      + 'with preselect holdOnLoss=true — this is now the ONLY source '
      + 'for the record (the hold-question toggle is retired).'))
  // Read-only AlwaysHoldsNote with tool="finger" surfaces the decision
  // on the confirm card.
  assert.ok(/<AlwaysHoldsNote\s+tool="finger"\s*\/>/.test(eoatWizSrc),
    v('ActuatorCard for grips_fingers must render '
      + '<AlwaysHoldsNote tool="finger" /> — the read-only line '
      + 'that replaced the retired HoldQuestion toggle.'))
})

test('EOAT wizard custom path preselects hasCheckValve=true on holds_suction capability', () => {
  const capSrc = readSrc('lib/eoatCapabilities.js')
  assert.ok(/key: 'holds_suction'/.test(capSrc),
    v('Capability catalog must include holds_suction.'))
  assert.ok(
    /actuatorType:\s*'vacuum',[\s\S]*?preselect:\s*\{\s*hasCheckValve:\s*true\s*\}/
      .test(capSrc),
    v('holds_suction capability must map to actuatorType=vacuum with '
      + 'preselect hasCheckValve=true (NeuRobots standard holds via '
      + 'inline check valve).'))
  assert.ok(/<AlwaysHoldsNote\s+tool="suction"\s*\/>/.test(eoatWizSrc),
    v('ActuatorCard for holds_suction must render '
      + '<AlwaysHoldsNote tool="suction" /> — the read-only line '
      + 'that replaced the retired SuctionHoldQuestion toggle.'))
})

test('EOAT wizard custom confirm step offers NO hold-on-loss questions', () => {
  // 2026-10-05 operator order: neither finger nor suction hold
  // questions should be an option on the custom confirm step. Pin
  // the retired UI (components + testids + button copy) is GONE.
  assert.equal(/function\s+HoldQuestion\s*\(/.test(eoatWizSrc), false,
    v('HoldQuestion component must be deleted — the finger hold '
      + 'question is retired (operator order 2026-10-05).'))
  assert.equal(/function\s+SuctionHoldQuestion\s*\(/.test(eoatWizSrc),
    false,
    v('SuctionHoldQuestion component must be deleted — the suction '
      + 'hold question is retired.'))
  const normalized = eoatWizSrc.replace(/\s+/g, ' ')
  assert.equal(
    normalized.includes(
      "If the air supply is lost, does your suction tool keep holding?"),
    false,
    v('The suction hold-on-loss question copy must be removed — the '
      + 'operator no longer makes this choice.'))
  assert.equal(
    normalized.includes(
      "If the robot suddenly stops, should this keep holding"),
    false,
    v('The finger hold-on-loss question copy must be removed.'))
  // "I'm not sure" button retired alongside the suction question.
  assert.equal(/data-testid="custom-eoat-check-valve-unsure"/
    .test(eoatWizSrc), false,
    v('The "I\'m not sure" button is retired with the suction '
      + 'question — the record is always holds_on_loss=true.'))
  // "Which part did we pick?" expander retired per the directive —
  // strip JSX comments (/* ... */) so a breadcrumb note that mentions
  // the retired copy doesn't trip the pin.
  const stripped = eoatWizSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  assert.equal(
    /Which part did we pick\?/.test(stripped), false,
    v('The "Which part did we pick?" why-expander on the actuator '
      + 'card must be removed (operator order 2026-10-05).'))
})

test('EOAT wizard hookup/guidance screen: suction check-valve explainer retired', () => {
  // 2026-10-05 operator order: the explainer box under the vacuum
  // GuidanceBlock on the hookup/guidance screen was noise on the
  // wiring view. Retired. Strip comments so a breadcrumb that
  // mentions the retired copy doesn't trip the pin.
  const stripped = eoatWizSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  assert.equal(
    /data-testid="hardware-setup-vacuum-check-valve-note"/.test(stripped),
    false,
    v('The hardware-setup-vacuum-check-valve-note box must be '
      + 'removed from the hookup/guidance screen (2026-10-05).'))
  assert.equal(
    /data-testid="hardware-setup-vacuum-why"/.test(stripped), false,
    v('The companion "How?" WhyExpander (testId=hardware-setup-'
      + 'vacuum-why) must be removed with the explainer box.'))
  const normalized = stripped.replace(/\s+/g, ' ')
  assert.equal(
    normalized.includes('Standard inclusion, not an upsell.'), false,
    v('The retired "Standard inclusion, not an upsell." copy must '
      + 'be absent from the hookup/guidance screen.'))
  // The CONFIRM-step AlwaysHoldsNote line stays — the directive
  // explicitly scoped the removal to the hookup/guidance surface.
  // Positive proof the record-truth path is unchanged.
  assert.ok(
    /<AlwaysHoldsNote\s+tool="suction"\s*\/>/.test(stripped),
    v('The confirm-step AlwaysHoldsNote (tool="suction") must stay '
      + '— the operator order removed the hookup/guidance box only.'))
})

test('standard-vacuum cell entry still records holds_via=check_valve', () => {
  // Record truth is unchanged — only the on-screen explainer was
  // retired. The _standardCellEntry helper for vacuum still produces
  // hold_on_loss=true + holds_via='check_valve' so programs built
  // against the standard vacuum tool keep behaving the same.
  assert.ok(
    /type:\s*'vacuum',\s*hold_on_loss:\s*true,\s*holds_via:\s*'check_valve',\s*valve,/
      .test(eoatWizSrc),
    v('_standardCellEntry for vacuum must still record '
      + "hold_on_loss=true + holds_via='check_valve' — the on-screen "
      + 'explainer removal is UI-only, no data change.'))
})

test('standard-path cell entry: finger records double_acting + hold_on_loss=true', () => {
  // The _standardCellEntry helper is private; grep for the exact
  // record shape it produces.
  assert.ok(
    /type:\s*'double_acting',\s*hold_on_loss:\s*true,\s*holds_via:\s*null,\s*valve,/
      .test(eoatWizSrc),
    v('Standard finger path must record '
      + "type='double_acting', hold_on_loss=true, holds_via=null on "
      + 'the standard:finger cell entry.'))
})

test('standard-path cell entry: vacuum records holds_on_loss=true + holds_via=check_valve', () => {
  assert.ok(
    /type:\s*'vacuum',\s*hold_on_loss:\s*true,\s*holds_via:\s*'check_valve',\s*valve,/
      .test(eoatWizSrc),
    v('Standard vacuum path must record '
      + "type='vacuum', hold_on_loss=true, holds_via='check_valve' on "
      + 'the standard:vacuum cell entry.'))
})

test('recommendValveType defaults to 5/2 DS on unanswered double_acting', async () => {
  // 2026-10-05 unification: both wizards' recommendValveType routes
  // through the shared valveMapping.valveTypeForActuation. Pin the
  // behavior directly on the shared resolver (pure .js, no JSX
  // loader needed) instead of the old if-chain source grep.
  const { valveTypeForActuation } = await import(
    '../../src/lib/valveMapping.js')
  // Explicit false → SS (operator opted out of hold).
  assert.equal(
    valveTypeForActuation({ actuation: 'double_acting', holdOnLoss: false }),
    '5/2 SS',
    v('double_acting + holdOnLoss=false must resolve to 5/2 SS '
      + '(spring returns home on power loss — operator opt-out).'))
  // Explicit true → DS (holds last state).
  assert.equal(
    valveTypeForActuation({ actuation: 'double_acting', holdOnLoss: true }),
    '5/2 DS',
    v('double_acting + holdOnLoss=true must resolve to 5/2 DS '
      + '(holds last state on power loss — the operator asked to '
      + 'stay clamped).'))
  // Default (null / undefined) → DS (2026-10-02 directive: no answer
  // yields the part-wont-drop valve class).
  assert.equal(
    valveTypeForActuation({ actuation: 'double_acting', holdOnLoss: null }),
    '5/2 DS',
    v('double_acting + no answer must default to 5/2 DS so a '
      + 'half-filled wizard record still asks for the holding valve.'))
  assert.equal(
    valveTypeForActuation({ actuation: 'double_acting' }),
    '5/2 DS',
    v('double_acting + undefined holdOnLoss must default to 5/2 DS.'))
})

test('vacuumHoldMetadata records holds_via distinct from valve-class holding', () => {
  const toolPortSrc = readSrc('lib/toolPortMap.js')
  assert.ok(/export function vacuumHoldMetadata\(/.test(toolPortSrc),
    v('toolPortMap.js must export vacuumHoldMetadata(hasCheckValve) '
      + 'so the custom + standard vacuum paths share a single source '
      + 'for the holds_via field.'))
  // The function must return holds_on_loss=false on explicit NO,
  // and holds_on_loss=true + holds_via='check_valve' otherwise
  // (including the preselect-default when hasCheckValve is
  // undefined). Pin each branch.
  assert.ok(
    /hasCheckValve === false[\s\S]*?holds_on_loss:\s*false,\s*holds_via:\s*null/
      .test(toolPortSrc),
    v('vacuumHoldMetadata must map hasCheckValve=false → '
      + 'holds_on_loss:false + holds_via:null (operator wiring a '
      + 'cup with no check valve gets an honest record).'))
  assert.ok(
    /holds_on_loss:\s*true,\s*holds_via:\s*'check_valve'/.test(toolPortSrc),
    v('vacuumHoldMetadata must map the YES/preselect-default to '
      + "holds_on_loss:true + holds_via:'check_valve' — provenance "
      + 'stays truthful (hardware does the holding, not the valve).'))
})


// ── 2026-10-02 plain-register pins ──────────────────────────────────
//
// Three load-bearing invariants for the plain-language pass:
//   (a) banned-word grep — no "actuator", "5/2", "N/C", "hold-on-loss"
//       etc. in operator-visible copy (WhyExpander subtrees exempt).
//   (b) compilation-equivalence — multi-select capability picks
//       compile to the same actuator records as the old flow.
//   (c) why-expander coverage — every recommendation surface has an
//       adjacent WhyExpander so technical detail is reachable.

const _REGISTER_BANNED = [
  'actuator', 'actuation', 'solenoid', 'pneumatic',
  'single-acting', 'double-acting', 'spring return',
  'check valve', 'hold-on-loss', 'discrete', 'continuous',
  'N/C', 'N/O', '5/2', '3/2', 'HI/LO', 'PNP', 'OSSD',
]
const _REGISTER_BANNED_ACRONYMS = ['DS', 'SS', 'DI', 'DO']

function _stripWhyExpanders(src) {
  let out = src, prev
  do {
    prev = out
    out = out.replace(/<WhyExpander\b[^>]*>[\s\S]*?<\/WhyExpander>/g, '')
  } while (out !== prev)
  return out
}
function _stripBacktickLiterals(src) {
  return src.replace(/`(?:[^`\\]|\\.)*`/g, '``')
}
function _stripSrcComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1')
}

function _operatorStringLiterals(src) {
  // Only sentence-shaped strings count as operator copy — short
  // snake_case tokens are internal data values that may legitimately
  // mention 'actuation' / 'vacuum' / 'double_acting' etc.
  const literals = []
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g
  let m
  while ((m = re.exec(src))) {
    const s = m[1] || m[2]
    if (s && /\s/.test(s) && /[a-z]{3,}/.test(s)) literals.push(s)
  }
  return literals
}

function _registerSweep(src) {
  const cleaned = _stripBacktickLiterals(_stripWhyExpanders(
    _stripSrcComments(src)))
  const strings = _operatorStringLiterals(cleaned)
  const hits = []
  for (const s of strings) {
    for (const b of _REGISTER_BANNED) {
      const r = new RegExp('\\b' + b.replace(/[/.]/g, '\\$&') + '\\b', 'i')
      if (r.test(s)) hits.push({ word: b, text: s })
    }
    for (const a of _REGISTER_BANNED_ACRONYMS) {
      if (new RegExp('\\b' + a + '\\b').test(s)) {
        hits.push({ word: a, text: s })
      }
    }
  }
  return hits
}

test('plain-register pin: EOAT wizard operator copy is free of banned words', () => {
  const hits = _registerSweep(eoatWizSrc)
  assert.equal(hits.length, 0,
    v('EOATSetupWizard operator copy contains banned register words. '
      + 'Hits: ' + hits.map((h) =>
        `[${h.word}] ${h.text.substring(0, 80)}`).join(' | ')))
})

test('plain-register pin: fixture wizard operator copy is free of banned words', () => {
  const hits = _registerSweep(fixWizSrc)
  assert.equal(hits.length, 0,
    v('ExternalFixtureWizard operator copy contains banned register '
      + 'words. Hits: ' + hits.map((h) =>
        `[${h.word}] ${h.text.substring(0, 80)}`).join(' | ')))
})

test('plain-register pin: fixturesData operator-visible copy is free of banned words', () => {
  const dataSrc = readSrc('lib/fixturesData.js')
  const hits = _registerSweep(dataSrc)
  assert.equal(hits.length, 0,
    v('fixturesData.js operator-visible copy contains banned register '
      + 'words. Hits: ' + hits.map((h) =>
        `[${h.word}] ${h.text.substring(0, 80)}`).join(' | ')))
})

test('plain-register pin: My Cell section operator copy is free of banned words', () => {
  const hits = _registerSweep(myCellSrc)
  assert.equal(hits.length, 0,
    v('MyCellSection operator copy contains banned register words. '
      + 'Hits: ' + hits.map((h) =>
        `[${h.word}] ${h.text.substring(0, 80)}`).join(' | ')))
})

// ── Compilation-equivalence pins ────────────────────────────────────
//
// The multi-select capability flow MUST produce the same actuator
// records as the old per-actuator picker would have produced for the
// same operator intent. Pin each capability → record mapping.

test('compilation-equivalence: grips_fingers → one double_acting actuator (hold preselected)', async () => {
  const { actuatorsFromCapabilities } = await import(
    '../../src/lib/eoatCapabilities.js')
  const acts = actuatorsFromCapabilities(new Set(['grips_fingers']))
  assert.equal(acts.length, 1,
    v('One capability selected → one actuator in the compiled record.'))
  assert.equal(acts[0].type, 'double_acting',
    v('grips_fingers → actuator type double_acting.'))
  assert.equal(acts[0].holdOnLoss, true,
    v('grips_fingers preselects holdOnLoss=true (safety default).'))
  assert.equal(acts[0].capability, 'grips_fingers',
    v('Compiled actuator carries the originating capability key.'))
})

test('compilation-equivalence: holds_suction → one vacuum actuator (check-valve preselected)', async () => {
  const { actuatorsFromCapabilities } = await import(
    '../../src/lib/eoatCapabilities.js')
  const acts = actuatorsFromCapabilities(new Set(['holds_suction']))
  assert.equal(acts.length, 1)
  assert.equal(acts[0].type, 'vacuum')
  assert.equal(acts[0].hasCheckValve, true,
    v('holds_suction preselects hasCheckValve=true (NeuRobots standard).'))
})

test('compilation-equivalence: blows_air → one blow_off actuator (no hold question)', async () => {
  const { actuatorsFromCapabilities } = await import(
    '../../src/lib/eoatCapabilities.js')
  const acts = actuatorsFromCapabilities(new Set(['blows_air']))
  assert.equal(acts.length, 1)
  assert.equal(acts[0].type, 'blow_off')
  // No preselect for hold or check-valve — blow has no hold state.
  assert.equal(acts[0].holdOnLoss, null)
  assert.equal(acts[0].hasCheckValve, null)
})

test('compilation-equivalence: multi-select combinations preserve order + count', async () => {
  const { actuatorsFromCapabilities } = await import(
    '../../src/lib/eoatCapabilities.js')
  const acts = actuatorsFromCapabilities(
    new Set(['grips_fingers', 'blows_air']))
  assert.equal(acts.length, 2,
    v('Two capabilities selected → two actuators in the compiled record.'))
  // Catalog order (grips_fingers before blows_air) must be preserved
  // regardless of insertion order — the record stays deterministic
  // across runs.
  assert.equal(acts[0].capability, 'grips_fingers',
    v('Catalog order wins over insertion order.'))
  assert.equal(acts[1].capability, 'blows_air')
})

test('compilation-equivalence: capability-shape matches the resolve-pipeline contract', async () => {
  // resolveCustomEOATRecord expects actuators[i] with fields
  // {type, holdOnLoss|hold_on_loss, hasCheckValve|has_check_valve,
  //  label?} and treats blow_off / vacuum / double_acting / anything-
  // else per its branches. The capability compiler must produce
  // records that satisfy EVERY one of those shape expectations so
  // the end-to-end path (capabilities → compiled → resolved) stays
  // byte-stable with what the old flow produced. Pinned by source
  // grep because toolPortMap.js imports SynapsePage.jsx and cannot
  // load under node:test's non-JSX loader.
  const toolPortSrc = readSrc('lib/toolPortMap.js')
  // The resolver reads a.holdOnLoss ?? a.hold_on_loss.
  assert.ok(/a\.holdOnLoss\s*\?\?\s*a\.hold_on_loss/.test(toolPortSrc),
    v('resolveCustomEOATRecord must read holdOnLoss (new flow) OR '
      + 'hold_on_loss (legacy) so the capability compiler stays '
      + 'compatible without needing a field rename.'))
  // The resolver reads a.hasCheckValve ?? a.has_check_valve.
  assert.ok(
    /a\.hasCheckValve\s*\?\?\s*a\.has_check_valve/.test(toolPortSrc),
    v('resolveCustomEOATRecord must read hasCheckValve (new flow) '
      + 'OR has_check_valve (legacy).'))
  // blow_off branch exists and records hold_on_loss=false.
  assert.ok(/type === 'blow_off'/.test(toolPortSrc),
    v('resolveCustomEOATRecord must branch on blow_off — the new '
      + 'capability catalog introduces this actuator type.'))
  const { actuatorsFromCapabilities } = await import(
    '../../src/lib/eoatCapabilities.js')
  const acts = actuatorsFromCapabilities(
    new Set(['grips_fingers', 'holds_suction', 'blows_air']))
  // The compiled actuator fields must be in the shape the resolver
  // consumes above — holdOnLoss / hasCheckValve, not snake_case.
  assert.ok(Object.prototype.hasOwnProperty.call(acts[0], 'holdOnLoss'))
  assert.ok(Object.prototype.hasOwnProperty.call(acts[1], 'hasCheckValve'))
  assert.equal(acts[2].type, 'blow_off')
})

// ── Why-expander coverage pin ───────────────────────────────────────
//
// Every operator-facing RECOMMENDATION surface must sit adjacent to
// a <WhyExpander> so the technical detail is reachable without
// cluttering the question. The pin counts WhyExpander instances —
// a drop below the baseline means a recommendation lost its
// explainer.

test('why-expander coverage: EOAT wizard carries explainers at each recommendation', () => {
  // 2026-10-05 operator order dropped the hold-question WhyExpanders
  // (finger + suction + blow-off "which part" + something-else).
  // The remaining explainers cover the standard-finger note, the
  // standard-vacuum note, and the sensor-definition — plus any
  // future recommendation surface that adds its own. Floor at 2 so
  // a regression that strips the standard-path explainers still
  // fails loudly.
  const count = (eoatWizSrc.match(/<WhyExpander\b/g) || []).length
  assert.ok(count >= 2,
    v('EOATSetupWizard must carry at least 2 WhyExpander instances '
      + '(standard-finger note, standard-vacuum note, sensor '
      + 'definition). Found: ' + count))
})

test('why-expander coverage: fixture wizard carries explainers at each recommendation', () => {
  const count = (fixWizSrc.match(/<WhyExpander\b/g) || []).length
  assert.ok(count >= 2,
    v('ExternalFixtureWizard must carry at least 2 WhyExpander '
      + 'instances (hold question + wants-done question). Found: '
      + count))
})

test('WhyExpander component defines the data-why-expander marker', () => {
  const src = readSrc('components/WhyExpander.jsx')
  assert.ok(/data-why-expander="1"/.test(src),
    v('WhyExpander must render data-why-expander="1" on its outer '
      + 'div — the banned-word pin uses this marker to carve the '
      + 'subtree out of the sweep.'))
})
