// DOCTRINE — External Fixture Wizard (2026-09-22 operator directive).
//
// Process-language interview compiling to Synapse port assignments.
// Vices, indexers, feeders, blow-offs, doors, other. Guidance is
// visual only; the wizard NEVER emits an IO write.
//
// Invariants pinned here:
//   1. Six device types with per-type defaults + WHY copy.
//   2. Each path (air-hold / air-release / blow-off / own-controller
//      / manual) compiles to a complete record with the correct
//      port classes (valve? out? in_done?).
//   3. Free-port allocation NEVER collides with tools OR other fixtures.
//   4. Process-language: no "N/C", "5/2", "DO", "3/2" strings in
//      OPERATOR-facing wizard copy (the JSX outside the WHY block).
//      Those hardware terms live only in the valve-info explainers.
//   5. Summary map glows exactly the assigned port set.
//   6. Record round-trips through the store: save → list → get.
//   7. Wizard reuses SynapseConnectionMap via the shared GuidanceBlock
//      (no fork of the map).
//   8. Keyboard-inset hook is consumed on text fields.
//
// Failure format:
//   DOCTRINE FIXTURE_WIZARD VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Ensure the store can persist under Node's --test by shimming a tiny
// localStorage before importing the module.
if (typeof globalThis.window === 'undefined') {
  const bag = {}
  globalThis.window = {
    localStorage: {
      getItem: (k) => (k in bag ? bag[k] : null),
      setItem: (k, v) => { bag[k] = String(v) },
      removeItem: (k) => { delete bag[k] },
      clear: () => { for (const k of Object.keys(bag)) delete bag[k] },
    },
  }
}

const {
  FIXTURE_TYPES, FIXTURE_TYPE_KEYS,
  compileFixtureRecord, allocateFixturePorts,
  claimedValveIds, claimedInputIds, claimedOutputIds,
  fixturePortMap, recommendValveType,
} = await import('../../src/lib/fixturesData.js')

const {
  listFixtures, saveFixture, getFixture, removeFixture,
} = await import('../../src/lib/fixturesStore.js')

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const wizardSrc  = readSrc('components/ExternalFixtureWizard.jsx')
const dataSrc    = readSrc('lib/fixturesData.js')
const storeSrc   = readSrc('lib/fixturesStore.js')
const insetSrc   = readSrc('lib/keyboardInset.js')

function v(msg) { return `DOCTRINE FIXTURE_WIZARD VIOLATED: ${msg}` }


// ── (1) Six device types + defaults + WHY ───────────────────────────

test('FIXTURE_TYPES contains the six device categories', () => {
  const expected = ['vice', 'indexer', 'feeder', 'blow_off', 'door', 'other']
  assert.deepEqual(FIXTURE_TYPE_KEYS.slice().sort(), expected.slice().sort(),
    v(`FIXTURE_TYPE_KEYS must be exactly ${expected.join(', ')} — `
      + `found ${FIXTURE_TYPE_KEYS.join(', ')}.`))
})

test('every FIXTURE_TYPE has label, desc, name_prefix, defaults, and a non-empty WHY', () => {
  for (const k of FIXTURE_TYPE_KEYS) {
    const t = FIXTURE_TYPES[k]
    assert.ok(t.label && t.label.length > 0,
      v(`FIXTURE_TYPES.${k} must have a label`))
    assert.ok(t.desc && t.desc.length > 0,
      v(`FIXTURE_TYPES.${k} must have a desc`))
    assert.ok(t.name_prefix && t.name_prefix.length > 0,
      v(`FIXTURE_TYPES.${k} must have a name_prefix`))
    assert.ok(t.defaults && typeof t.defaults === 'object',
      v(`FIXTURE_TYPES.${k} must have a defaults object`))
    assert.ok(t.why && t.why.length >= 20,
      v(`FIXTURE_TYPES.${k} must have a non-empty why (>= 20 chars) — `
        + `every operator-facing card carries a one-line WHY.`))
  }
})

test('device-type defaults match the operator directive', () => {
  // Vice → air, hold on loss = stay clamped (parts are worse to drop
  // than to pin).
  assert.equal(FIXTURE_TYPES.vice.defaults.power_mode, 'air',
    v('vice default power_mode must be "air"'))
  assert.equal(FIXTURE_TYPES.vice.defaults.hold_on_loss, true,
    v('vice default hold_on_loss must be true (stay clamped)'))

  // Indexer + feeder → own_controller.
  assert.equal(FIXTURE_TYPES.indexer.defaults.power_mode, 'own_controller',
    v('indexer default power_mode must be "own_controller"'))
  assert.equal(FIXTURE_TYPES.feeder.defaults.power_mode, 'own_controller',
    v('feeder default power_mode must be "own_controller"'))

  // Blow-off → air, blow_off actuation (3/2 N/C is the wire type
  // but only in the WHY; the wizard talks about "off by default").
  assert.equal(FIXTURE_TYPES.blow_off.defaults.power_mode, 'air',
    v('blow_off default power_mode must be "air"'))
  assert.equal(FIXTURE_TYPES.blow_off.defaults.air_actuation, 'blow_off',
    v('blow_off default air_actuation must be "blow_off"'))

  // Door → stay clamped on loss (2026-10-02 operator directive:
  // every asking path preselects STAY CLAMPED; operators who need
  // a safety guard that must open for egress can still pick
  // Release on the next step).
  assert.equal(FIXTURE_TYPES.door.defaults.hold_on_loss, true,
    v('door default hold_on_loss must be true (STAY CLAMPED '
      + 'preselect per 2026-10-02 safety default)'))
})


// ── (2) Per-path compile → complete record ──────────────────────────

test('air-hold path compiles to a record with valve + valve_type=5/2 DS', () => {
  const rec = compileFixtureRecord({
    type: 'vice', power_mode: 'air',
    actuation: 'double', hold_on_loss: true,
    completion: 'sensor',
  }, { tools: [], fixtures: [] })
  assert.equal(rec.power_mode, 'air')
  assert.equal(rec.hold_on_loss, true)
  assert.equal(rec.actuation, 'double')
  assert.equal(rec.valve_type, '5/2 DS',
    v('air-hold path must resolve valve_type = "5/2 DS" (memory).'))
  assert.ok(rec.valve, v('air-hold path must allocate a valve slot.'))
  assert.equal(rec.out, null, v('air path must NOT allocate an OUT'))
})

test('air-release path compiles to a record with valve_type=5/2 SS', () => {
  const rec = compileFixtureRecord({
    type: 'door', power_mode: 'air',
    actuation: 'double', hold_on_loss: false,
    completion: 'operator',
  }, { tools: [], fixtures: [] })
  assert.equal(rec.valve_type, '5/2 SS',
    v('air-release path must resolve valve_type = "5/2 SS" (spring return).'))
  assert.ok(rec.valve, v('air-release path must allocate a valve slot.'))
})

test('blow-off path compiles to HI/LO 3/2 N/C, no hold-on-loss', () => {
  const rec = compileFixtureRecord({
    type: 'blow_off', power_mode: 'air',
    actuation: 'blow_off',
    completion: 'operator',
  }, { tools: [], fixtures: [] })
  assert.equal(rec.valve_type, 'HI/LO 3/2 N/C',
    v('blow-off path must resolve valve_type = "HI/LO 3/2 N/C".'))
  assert.ok(rec.valve, v('blow-off path must allocate a valve slot.'))
  assert.equal(rec.hold_on_loss, null,
    v('blow-off path leaves hold_on_loss null (default-off has no hold state).'))
})

test('own-controller path (with done sensor) allocates OUT + IN, no valve', () => {
  const rec = compileFixtureRecord({
    type: 'indexer', power_mode: 'own_controller',
    wants_done: true,
    completion: 'sensor',
  }, { tools: [], fixtures: [] })
  assert.equal(rec.power_mode, 'own_controller')
  assert.equal(rec.valve, null, v('own-controller path must NOT allocate a valve.'))
  assert.ok(rec.out, v('own-controller path must allocate an OUT (start signal).'))
  assert.ok(rec.in_done, v('own-controller with sensor must allocate an IN.'))
})

test('own-controller path (no done sensor, wait timer) allocates OUT only', () => {
  const rec = compileFixtureRecord({
    type: 'feeder', power_mode: 'own_controller',
    wants_done: false,
    completion: 'wait', wait_s: 3.5,
  }, { tools: [], fixtures: [] })
  assert.ok(rec.out)
  assert.equal(rec.in_done, null,
    v('own-controller + wait must NOT allocate an IN — the timer replaces it.'))
  assert.equal(rec.completion, 'wait')
  assert.equal(rec.wait_s, 3.5,
    v('wait_s must round-trip as a Number (coerced from string input).'))
})

test('manual path allocates nothing', () => {
  const rec = compileFixtureRecord({
    type: 'other', power_mode: 'manual',
    completion: 'operator',
  }, { tools: [], fixtures: [] })
  assert.equal(rec.valve, null)
  assert.equal(rec.out, null)
  assert.equal(rec.in_done, null)
  assert.equal(rec.completion, 'operator')
})


// ── (3) Free-port allocation never collides ─────────────────────────

test('allocation avoids valves already claimed by tools', () => {
  const tools = [{ id: 't', config: { assigned_valve: 'V05' } }]
  const alloc = allocateFixturePorts({ needsValve: true, tools, fixtures: [] })
  assert.equal(alloc.valve, 'V10',
    v('allocateFixturePorts must skip a tool-claimed valve.'))
})

test('allocation avoids valves already claimed by other fixtures', () => {
  const fixtures = [{ id: 'f', valve: 'V05' }]
  const alloc = allocateFixturePorts({ needsValve: true, tools: [], fixtures })
  assert.equal(alloc.valve, 'V10',
    v('allocateFixturePorts must skip a fixture-claimed valve.'))
})

test('allocation returns null valve when SPARE inventory is exhausted', () => {
  const fixtures = [{ id: 'f1', valve: 'V05' }, { id: 'f2', valve: 'V10' }]
  const alloc = allocateFixturePorts({ needsValve: true, tools: [], fixtures })
  assert.equal(alloc.valve, null,
    v('allocateFixturePorts must return null when both SPARE slots are claimed '
      + '— the wizard renders a "no spare valve" notice from that.'))
})

test('allocation skips INs claimed by tools and by fixtures', () => {
  const tools    = [{ id: 't', config: { assigned_inputs: ['IN01'] } }]
  const fixtures = [{ id: 'f', in_done: 'IN02' }]
  const alloc = allocateFixturePorts({ needsIn: true, tools, fixtures })
  assert.equal(alloc.in_done, 'IN03',
    v('allocateFixturePorts must skip both tool-inputs and fixture-inputs.'))
})

test('allocation skips OUTs claimed by other fixtures', () => {
  const fixtures = [{ id: 'f1', out: 'OUT01' }, { id: 'f2', out: 'OUT02' }]
  const alloc = allocateFixturePorts({ needsOut: true, tools: [], fixtures })
  assert.equal(alloc.out, 'OUT03',
    v('allocateFixturePorts must skip fixture-claimed OUTs.'))
})

test('claimedValveIds / claimedInputIds / claimedOutputIds are stable helpers', () => {
  const tools = [{ config: { assigned_valve: 'V05', assigned_inputs: ['IN01'] } }]
  const fixtures = [{ valve: 'V10', in_done: 'IN02', out: 'OUT03' }]
  assert.deepEqual([...claimedValveIds(tools, fixtures)].sort(),
    ['V05', 'V10'].sort())
  assert.deepEqual([...claimedInputIds(tools, fixtures)].sort(),
    ['IN01', 'IN02'].sort())
  assert.deepEqual([...claimedOutputIds(tools, fixtures)].sort(),
    ['OUT03'].sort())
})


// ── (4) Process language — no hardware terms in operator copy ───────

test('wizard JSX contains no hardware jargon in operator-facing copy', () => {
  // Extract only the JSX/prose that the operator SEES — strip
  // comments AND <WhyExpander> subtrees (the "why?" disclosure is
  // the only legal home for hardware terms per the 2026-10-02
  // plain-register directive).
  const codeOnly = _stripWhyExpanders(_stripComments(wizardSrc))
  for (const term of ['5/2 DS', '5/2 SS', 'HI/LO 3/2', 'N/C', 'N/O',
                        'DO01', 'DO02']) {
    assert.equal(codeOnly.includes(term), false,
      v(`Wizard operator copy must NOT contain "${term}" — hardware `
        + `terms live only inside <WhyExpander> subtrees (imported `
        + `into the port record notes/why, not written into the JSX).`))
  }
})

test('device-type WHY paragraphs are operator-language (no valve-type strings)', () => {
  // Every card's `why` copy is what the operator READS to decide.
  for (const k of FIXTURE_TYPE_KEYS) {
    const w = FIXTURE_TYPES[k].why
    for (const term of ['5/2', 'N/C', 'N/O', 'DO', 'DI']) {
      assert.equal(new RegExp(`\\b${term}\\b`).test(w), false,
        v(`FIXTURE_TYPES.${k}.why must not contain "${term}" — the `
          + `card is operator-facing; hardware terms belong in the `
          + `valve-info explainer.`))
    }
  }
})


// ── (5) Summary map glows exactly the assigned port set ─────────────

test('fixturePortMap projects the record → highlight sets 1:1', () => {
  const rec = {
    id: 'f', name: 'Vice 1', type: 'vice',
    valve: 'V05', out: null, in_done: 'IN03',
  }
  const port = fixturePortMap(rec)
  assert.deepEqual(port.required_valves, ['V05'])
  assert.deepEqual(port.required_outputs, [])
  assert.deepEqual(port.required_inputs, ['IN03'])
  // Callouts NAME the fixture ("Connect Vice 1's air line to V05")
  // per the operator directive.
  assert.ok(port.callouts.V05.includes('Vice 1'),
    v('valve callout must name the fixture'))
  assert.ok(port.callouts.IN03.includes('Vice 1'),
    v('IN callout must name the fixture'))
  // Label override renames the SPARE slot to the fixture name so
  // the map reads honestly after assignment.
  assert.equal(port.label_overrides.V05, 'Vice 1',
    v('label_overrides must relabel the SPARE slot with the fixture name.'))
})

test('summary uses the shared GuidanceBlock (no fork of the map)', () => {
  assert.ok(/import\s*\{\s*GuidanceBlock[^}]*\}\s*from\s*['"]\.\/EOATSetupWizard['"]/
              .test(wizardSrc),
    v('ExternalFixtureWizard must import { GuidanceBlock } from '
      + '"./EOATSetupWizard" — the map is a single shared surface.'))
  assert.ok(/<GuidanceBlock\s+port=\{port\}/.test(wizardSrc),
    v('SummaryStep must render <GuidanceBlock port={port} />.'))
})


// ── (6) Record round-trip through the store ─────────────────────────

test('fixture record saves → lists → gets → deletes', async () => {
  // Clean the localStorage shim between runs.
  globalThis.window.localStorage.setItem('roboai:fixtures.v1', '[]')

  const draft = compileFixtureRecord({
    type: 'vice', power_mode: 'air',
    actuation: 'double', hold_on_loss: true,
    completion: 'sensor',
  }, { tools: [], fixtures: [] })
  const saved = await saveFixture(draft)
  assert.ok(saved.id, v('saveFixture must assign an id'))
  assert.equal(saved.name, draft.name)

  const list = await listFixtures()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, saved.id)

  const got = await getFixture(saved.id)
  assert.deepEqual(got.valve, draft.valve)
  assert.equal(got.type, 'vice')

  const removed = await removeFixture(saved.id)
  assert.equal(removed, true)
  const listAfter = await listFixtures()
  assert.equal(listAfter.length, 0)
})

test('saved record uses the store schema key so a backend swap-in is trivial', () => {
  assert.ok(/roboai:fixtures\.v1/.test(storeSrc),
    v('fixturesStore must persist under key "roboai:fixtures.v1" — '
      + 'stable prefix for a future migration.'))
})


// ── (7) Wizard reuses SynapseConnectionMap via shared block ─────────

test('wizard imports fixturePortMap + FIXTURE_TYPES from lib/fixturesData', () => {
  assert.ok(/import\s*\{[^}]*FIXTURE_TYPES[^}]*\}\s*from\s*['"]\.\.\/lib\/fixturesData['"]/
              .test(wizardSrc),
    v('ExternalFixtureWizard must import FIXTURE_TYPES from '
      + 'lib/fixturesData (single source of truth).'))
  assert.ok(/import\s*\{[^}]*fixturePortMap[^}]*\}\s*from\s*['"]\.\.\/lib\/fixturesData['"]/
              .test(wizardSrc),
    v('ExternalFixtureWizard must import fixturePortMap from lib/fixturesData.'))
})

test('SynapseConnectionMap is NOT re-imported by the fixture wizard (no fork)', () => {
  assert.equal(
    /import\s+\{[^}]*SynapseConnectionMap[^}]*\}\s+from/.test(wizardSrc),
    false,
    v('ExternalFixtureWizard must NOT import SynapseConnectionMap directly '
      + '— it reuses EOATSetupWizard.GuidanceBlock, which owns the '
      + 'map mount.'))
})


// ── (8) Keyboard-inset hook consumed on text fields ─────────────────

test('useKeyboardInset hook exists with virtualKeyboard + visualViewport branches', () => {
  assert.ok(/export function useKeyboardInset\s*\(/.test(insetSrc),
    v('lib/keyboardInset must export useKeyboardInset()'))
  assert.ok(/navigator\.virtualKeyboard/.test(insetSrc),
    v('useKeyboardInset must have a navigator.virtualKeyboard branch (API path)'))
  assert.ok(/visualViewport/.test(insetSrc),
    v('useKeyboardInset must have a visualViewport branch (fallback)'))
  assert.ok(/--kb-inset/.test(insetSrc),
    v('useKeyboardInset must write --kb-inset on the document root '
      + 'so pure-CSS consumers read the same source.'))
})

test('fixture wizard consumes useKeyboardInset + scrolls focused field into view', () => {
  assert.ok(/import\s+\{[^}]*useKeyboardInset[^}]*\}\s+from\s+['"]\.\.\/lib\/keyboardInset['"]/
              .test(wizardSrc),
    v('ExternalFixtureWizard must import useKeyboardInset from lib/keyboardInset'))
  assert.ok(/useKeyboardInset\(\)/.test(wizardSrc),
    v('ExternalFixtureWizard must call useKeyboardInset() at top-level'))
  assert.ok(/scrollFocusedIntoView/.test(wizardSrc),
    v('Text inputs must call scrollFocusedIntoView on focus'))
  // The panel style must consume the CSS var — either as a direct
  // reference OR by spreading the shared kbSafeModalContentStyle()
  // helper (2026-10-09 refactor: the inline calc moved behind the
  // helper so every modal in the app can spread the same snippet).
  assert.ok(
    /var\(--kb-inset[^)]*\)/.test(wizardSrc)
    || /kbSafeModalContentStyle\s*\(/.test(wizardSrc),
    v('Panel style must shrink around the keyboard — either reference '
      + 'var(--kb-inset, ...) directly OR spread the shared '
      + 'kbSafeModalContentStyle() helper.'))
})


// ── (9) VIEW-tier — no IO writes from the wizard ────────────────────

test('wizard emits no /cmd/ or IO writes; guidance is visual only', () => {
  const codeOnly = _stripComments(wizardSrc)
  for (const forbidden of [
    { pat: /\/cmd\//,  label: '/cmd/ path' },
    { pat: /\/api\/io\//, label: '/api/io/ path (IO writes)' },
    { pat: /dispatchEvent\s*\(/, label: 'dispatchEvent()' },
  ]) {
    assert.equal(forbidden.pat.test(codeOnly), false,
      v(`ExternalFixtureWizard code must NOT contain ${forbidden.label} — `
        + `guidance is visual only, no IO writes.`))
  }
})


// ── (10) 2026-10-02 hold-on-loss default: STAY CLAMPED preselect ────
//
// Every asking path preselects STAY CLAMPED so doing nothing yields
// hold_on_loss=true → 5/2 DS. Pinned at three layers so a regression
// at any one of them fails loudly:
//   (a) type defaults — vice/door/other default hold_on_loss=true;
//       conveyor/own-controller stay null (no hold question).
//   (b) compile — compileFixtureRecord with NO explicit answer picks
//       up the type default and resolves valve_type='5/2 DS'.
//   (c) wizard JSX — AirActuationStep carries the preselect marker
//       and the "Recommended — the part won't drop" plain copy.

test('every air-driven type with a hold question preselects STAY CLAMPED', () => {
  // Air types that ask the hold question (not blow-off).
  for (const k of ['vice', 'door', 'other']) {
    assert.equal(FIXTURE_TYPES[k].defaults.hold_on_loss, true,
      v(`FIXTURE_TYPES.${k}.defaults.hold_on_loss must be true — `
        + `2026-10-02 safety default preselects STAY CLAMPED on `
        + `every asking path.`))
  }
  // Continuous / own-controller devices never ask (no hold).
  assert.equal(FIXTURE_TYPES.indexer.defaults.hold_on_loss, null,
    v('indexer has its own controller — no hold question is asked, '
      + 'default stays null.'))
  assert.equal(FIXTURE_TYPES.feeder.defaults.hold_on_loss, null,
    v('feeder has its own controller — no hold question is asked, '
      + 'default stays null.'))
  // Blow-off has no hold state at all.
  assert.equal(FIXTURE_TYPES.blow_off.defaults.hold_on_loss, null,
    v('blow-off is default-off — no hold state to pre-select.'))
})

test('air-driven type with NO explicit hold answer compiles to 5/2 DS', () => {
  for (const k of ['vice', 'door', 'other']) {
    const rec = compileFixtureRecord({
      type: k, power_mode: 'air',
      actuation: 'double',
      completion: 'operator',
    }, { tools: [], fixtures: [] })
    assert.equal(rec.hold_on_loss, true,
      v(`${k} with no explicit hold answer must inherit true from `
        + `the type default.`))
    assert.equal(rec.valve_type, '5/2 DS',
      v(`${k} with no explicit hold answer must resolve `
        + `valve_type='5/2 DS' — "default-yields-DS" pin.`))
  }
})

test('AirActuationStep JSX carries preselect marker + recommended copy', () => {
  // Preselect marker lets inspectors (and this test) confirm the
  // step actually renders the preselect without re-running the
  // wizard; the "data-preselected-hold" attribute is required.
  assert.ok(/data-preselected-hold="true"/.test(wizardSrc),
    v('AirActuationStep must carry data-preselected-hold="true" so '
      + 'the preselect is visible to inspectors + regression tests.'))
  // Recommended-copy pin — the 2026-10-02 plain-register directive
  // shortened the copy to "Recommended — the part won't drop." The
  // technical "if power or air is lost" explanation now lives in
  // the WhyExpander below the question.
  assert.ok(/Recommended — the part won't drop\./.test(wizardSrc),
    v('AirActuationStep must render the "Recommended — the part '
      + "won't drop.\" plain copy under the preselected STAY CLAMPED "
      + 'answer.'))
  // The data-testid for the recommended-copy block exists so a
  // future RTL render-pass test can target it directly.
  assert.ok(/data-testid="fixture-hold-recommended-copy"/.test(wizardSrc),
    v('AirActuationStep must expose fixture-hold-recommended-copy '
      + 'via data-testid so the preselect copy is testable.'))
})


// ── Comment stripper (shared shape from D_synapse_tab) ──────────────

function _stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1')
}

function _stripWhyExpanders(src) {
  let out = src
  let prev
  do {
    prev = out
    out = out.replace(/<WhyExpander\b[^>]*>[\s\S]*?<\/WhyExpander>/g, '')
  } while (out !== prev)
  return out
}
