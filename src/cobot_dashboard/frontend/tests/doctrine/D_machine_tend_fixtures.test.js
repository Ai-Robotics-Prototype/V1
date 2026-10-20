// DOCTRINE — Machine-tending clamping fixtures (vices): wizard asks
// which fixtures, codegen emits clamp/confirm per fixture, multi-vice
// loads all before the cycle, safety sequencing (clamp AFTER release,
// cycle-start AFTER all clamped, unclamp AFTER cycle AND before
// retrieval). 2026-10-15 operator field report.
//
// Pre-fix: a machine-tending program placed the part in the fixture
// (step 10 "Place in fixture — contact") and released the gripper
// (step 11 "Release part into fixture") but NEVER emitted a clamp IO.
// The vocab clampWorkpiece searched the system IO portmap for a role-
// labeled "machine clamp" / "fixture clamp" row and returned [] when
// none was labeled, so a program whose cell had vices configured in
// the External Fixture wizard still shipped with no clamp emission.
// The machine would have cycled on an unheld part. Multi-vice jobs
// (load N fixtures before the cycle starts) were not supported.
//
// Pins:
//   * lib/machineFixtures.js exports resolveMachineFixtures,
//     fixtureClampSignal, fixtureClampConfirmSignal,
//     missingClampSignalFixtures, missingClampSignalRefusal,
//     clampFixtureSteps, unclampFixtureSteps.
//   * ProgramWizard declares a machine_fixtures step with
//     render: MachineFixturesBody; skips for ops != machine_tend.
//   * The step reads cell.fixtures (shared External Fixture store —
//     no fork) and writes answers.machine_fixture_ids as an ordered
//     array of fixture.id values.
//   * clampFixtureSteps emits plain operator-facing labels: "Clamp
//     the vice (<name>)" + optional "Confirm vice clamped (<name>)";
//     unclampFixtureSteps emits "Release the vice (<name>)". No raw
//     DO/DI jargon in step labels.
//   * clamp signal resolves bind-by-id from fixture.valve || fixture.out;
//     confirm from fixture.in_done. Missing clamp signal → [] emit +
//     plain-copy refusal surfaced by missingClampSignalRefusal.
//   * buildSteps machine_tend branch loops per-fixture before cycle-
//     start: safe → approach → place → release → clamp → confirm →
//     retreat → safe (×N) → cycle-start → cycle-wait → safe →
//     approach → grip finished → unclamp → retreat → safe (×N) →
//     approach-unload → unload.
//   * Save-time refusal fires when any selected fixture lacks a
//     clamp signal.
//   * Pre-directive legacy flow (0 selected fixtures) stays byte-
//     identical — the clampWorkpiece/unclampWorkpiece calls remain.
//
// Failure format: DOCTRINE MACHINE_TEND_FIXTURES VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  resolveMachineFixtures,
  fixtureClampSignal, fixtureClampConfirmSignal,
  missingClampSignalFixtures, missingClampSignalRefusal,
  clampFixtureSteps, unclampFixtureSteps,
} from '../../src/lib/machineFixtures.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc  = readSrc('components/ProgramWizard.jsx')
const fixturesSrc = readSrc('lib/machineFixtures.js')

function v(msg) { return `DOCTRINE MACHINE_TEND_FIXTURES VIOLATED: ${msg}` }


// ── (1) Shared lib exports + resolution ─────────────────────────────

test('lib/machineFixtures exports the full fixture API', () => {
  for (const [name, fn] of [
    ['resolveMachineFixtures',       resolveMachineFixtures],
    ['fixtureClampSignal',           fixtureClampSignal],
    ['fixtureClampConfirmSignal',    fixtureClampConfirmSignal],
    ['missingClampSignalFixtures',   missingClampSignalFixtures],
    ['missingClampSignalRefusal',    missingClampSignalRefusal],
    ['clampFixtureSteps',            clampFixtureSteps],
    ['unclampFixtureSteps',          unclampFixtureSteps],
  ]) {
    assert.equal(typeof fn, 'function',
      v(`${name} must be exported from lib/machineFixtures as a function.`))
  }
})

test('resolveMachineFixtures resolves fixture ids in operator order', () => {
  const cell = { fixtures: [
    { id: 'fx-a', name: 'Vice A', type: 'vice', valve: 'V05' },
    { id: 'fx-b', name: 'Vice B', type: 'vice', valve: 'V06' },
    { id: 'fx-c', name: 'Vice C', type: 'vice', valve: 'V07' },
  ]}
  const ans = { machine_fixture_ids: ['fx-c', 'fx-a'] }
  const out = resolveMachineFixtures(cell, ans)
  assert.deepEqual(out.map((f) => f.id), ['fx-c', 'fx-a'],
    v('resolveMachineFixtures must return fixtures in the operator-'
      + 'declared order (first-tapped loads first) so the generated '
      + 'program follows the operator\'s intent.'))
})

test('resolveMachineFixtures filters out ids that no longer exist in the cell', () => {
  const cell = { fixtures: [{ id: 'fx-a', name: 'Vice A', valve: 'V05' }] }
  const out = resolveMachineFixtures(cell, { machine_fixture_ids: ['fx-missing', 'fx-a'] })
  assert.deepEqual(out.map((f) => f.id), ['fx-a'],
    v('A fixture deleted from the cell after save must not crash '
      + 'codegen — the save-time validator surfaces the missing id '
      + 'elsewhere.'))
})

test('resolveMachineFixtures returns [] when answers has no selection', () => {
  const cell = { fixtures: [{ id: 'fx-a' }] }
  assert.deepEqual(resolveMachineFixtures(cell, {}), [])
  assert.deepEqual(resolveMachineFixtures(cell, { machine_fixture_ids: [] }), [])
  assert.deepEqual(resolveMachineFixtures(null, { machine_fixture_ids: ['fx-a'] }), [])
})


// ── (2) Signal resolution (bind-by-id, non-empty) ───────────────────

test('fixtureClampSignal reads valve first, falls back to out', () => {
  assert.equal(fixtureClampSignal({ valve: 'V05' }), 'V05')
  assert.equal(fixtureClampSignal({ out: 'OUT03' }), 'OUT03')
  assert.equal(fixtureClampSignal({ valve: 'V05', out: 'OUT03' }), 'V05',
    v('When both are set, air-valve (fixture.valve) wins — the '
      + 'External Fixture wizard writes `out` only on the own-'
      + 'controller path and `valve` only on the air path, so '
      + 'collision is a soft defense.'))
  assert.equal(fixtureClampSignal({}), null)
  assert.equal(fixtureClampSignal(null), null)
})

test('fixtureClampConfirmSignal reads in_done', () => {
  assert.equal(fixtureClampConfirmSignal({ in_done: 'IN04' }), 'IN04')
  assert.equal(fixtureClampConfirmSignal({}), null,
    v('No confirm sensor → null → codegen skips the verify_input '
      + 'step for that fixture (safe default — some vices do not '
      + 'report engaged state).'))
})


// ── (3) Clamp / unclamp emitters, plain copy ────────────────────────

test('clampFixtureSteps emits plain "Clamp the vice (<name>)" label', () => {
  const fx = { id: 'fx-a', name: 'Vice A', valve: 'V05', in_done: 'IN04' }
  const out = clampFixtureSteps(fx)
  assert.equal(out.length, 2,
    v('With confirm input assigned, clampFixtureSteps emits BOTH the '
      + 'set_io (clamp) and the verify_input (confirm).'))
  assert.equal(out[0].action, 'set_io')
  assert.equal(out[0].label,  'Clamp the vice (Vice A)',
    v('Clamp step label must be plain operator copy "Clamp the vice '
      + '(<name>)" — no DO jargon.'))
  assert.equal(out[0].io_id,  'V05')
  assert.equal(out[0].value,  1)
  assert.equal(out[0].io_role, 'fixture_clamp')
  assert.equal(out[0].fixture_id, 'fx-a',
    v('Each emission must tag fixture_id for audit / round-trip.'))
  assert.equal(out[1].action, 'verify_input')
  assert.equal(out[1].label,  'Confirm vice clamped (Vice A)')
  assert.equal(out[1].io_id,  'IN04')
  assert.equal(out[1].expect, 1)
  assert.equal(out[1].on_fail, 'abort')
  assert.equal(out[1].reason, 'Vice A did not confirm clamped',
    v('Timeout reason must name the specific fixture so the Run '
      + 'modal / Monitor pill surface which vice failed to clamp.'))
})

test('clampFixtureSteps skips verify_input when no confirm sensor', () => {
  const fx = { id: 'fx-b', name: 'Vice B', valve: 'V06' }
  const out = clampFixtureSteps(fx)
  assert.equal(out.length, 1,
    v('Fixture without in_done → emit only the clamp set_io, no '
      + 'verify_input. Safe default: some vices do not report engaged.'))
  assert.equal(out[0].action, 'set_io')
})

test('clampFixtureSteps returns [] when fixture has no clamp signal', () => {
  // Missing clamp signal → emit [] (passthrough) and let the save
  // validator surface the refusal with missingClampSignalRefusal.
  assert.deepEqual(clampFixtureSteps({ id: 'fx-c', name: 'Vice C' }), [])
})

test('unclampFixtureSteps emits plain "Release the vice (<name>)" label', () => {
  const fx = { id: 'fx-a', name: 'Vice A', valve: 'V05' }
  const out = unclampFixtureSteps(fx)
  assert.equal(out.length, 1)
  assert.equal(out[0].action, 'set_io')
  assert.equal(out[0].label,  'Release the vice (Vice A)',
    v('Unclamp step label must be plain "Release the vice (<name>)".'))
  assert.equal(out[0].io_id,  'V05')
  assert.equal(out[0].value,  0)
  assert.equal(out[0].io_role, 'fixture_clamp')
  assert.equal(out[0].fixture_id, 'fx-a')
})


// ── (4) Save-time refusal (plain copy) ──────────────────────────────

test('missingClampSignalRefusal returns plain copy for incomplete fixtures', () => {
  const fx1 = { id: 'fx-a', name: 'Vice A', valve: 'V05' }
  const fx2 = { id: 'fx-b', name: 'Vice B' }  // no clamp signal
  assert.equal(missingClampSignalRefusal([fx1]), null,
    v('All fixtures signal-complete → no refusal.'))
  const msg = missingClampSignalRefusal([fx1, fx2])
  assert.equal(msg, 'Vice B has no clamp signal — finish its setup.',
    v('Refusal copy must be the exact operator-authored phrasing '
      + 'from the 2026-10-15 directive.'))
})


// ── (5) Wizard step wiring ──────────────────────────────────────────

test('ProgramWizard declares a machine_fixtures step for machine_tend', () => {
  assert.ok(/id:\s*['"]machine_fixtures['"]/.test(progWizSrc),
    v('ProgramWizard must declare id:"machine_fixtures" — the step '
      + 'that asks which clamping fixture(s) the machine uses.'))
  // The skip predicate must gate on operation === 'machine_tend' so
  // non-machine-tending flows never see the question.
  const idx = progWizSrc.indexOf("id: 'machine_fixtures'")
  const chunk = progWizSrc.slice(idx, idx + 400)
  assert.ok(/skip:\s*\(answers\)\s*=>\s*answers\.operation\s*!==\s*['"]machine_tend['"]/.test(chunk),
    v('machine_fixtures skip predicate must be '
      + '`skip: (answers) => answers.operation !== "machine_tend"`.'))
  assert.ok(/render:\s*MachineFixturesBody/.test(chunk),
    v('machine_fixtures must render the MachineFixturesBody component.'))
})

test('MachineFixturesBody reads cell.fixtures via the shared cell ref', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  assert.ok(idx > 0,
    v('MachineFixturesBody component must exist.'))
  const chunk = progWizSrc.slice(idx, idx + 4000)
  // Reads the shared cell ref (same seam the multi-pick skip predicate
  // uses) — no bespoke fetch, no fork from the shared External Fixture
  // store.
  assert.ok(/_wizardCellRegistryRef/.test(chunk),
    v('MachineFixturesBody must read _wizardCellRegistryRef — the '
      + 'shared cell snapshot. No fetch / no second source.'))
  assert.ok(/cell && Array\.isArray\(cell\.fixtures\)/.test(chunk),
    v('MachineFixturesBody must iterate cell.fixtures — the SAME '
      + 'array the External Fixture wizard writes. No fork.'))
})

test('MachineFixturesBody writes answers.machine_fixture_ids as an array', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  assert.ok(/setAnswer\(['"]machine_fixture_ids['"],/.test(chunk),
    v('MachineFixturesBody must call setAnswer("machine_fixture_ids", '
      + '…) with the operator\'s selection — the ordered id list '
      + 'resolveMachineFixtures consumes at codegen time.'))
  assert.ok(/data-testid="machine-vice-slot"/.test(chunk),
    v('Each vice slot row must stamp data-testid="machine-vice-slot" '
      + 'with data-slot-index + data-fixture-id for operator-facing '
      + 'e2e. (The pre-addendum "machine-fixture-choice" checkbox '
      + 'rows were retired with the yes/no gate 2026-10-15.)'))
})


// ── (5a) 2026-10-15 addendum: how-many-vices count replaces the yes/no gate ──

test('MachineFixturesBody asks the broader "workholding fixtures" count question', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  // The headline question must be the direct count copy — plain,
  // operator-written, no yes/no gate. 2026-10-16 operator addendum
  // broadened the wording from "vices" to "vices or workholding
  // fixtures" so the question covers clamps / chucks / any
  // workholding without an edge-case feel.
  assert.ok(/How many vices or workholding fixtures will be in the machine\?/.test(chunk),
    v('MachineFixturesBody must ask "How many vices or workholding '
      + 'fixtures will be in the machine?" verbatim per the 2026-10-16 '
      + 'operator addendum.'))
  assert.ok(/data-testid="machine-vice-count"/.test(chunk),
    v('MachineFixturesBody must render data-testid="machine-vice-count" '
      + '— the stepper wrapper that carries the current count value '
      + 'as a data-attr for operator-facing e2e.'))
  for (const tid of ['machine-vice-count-dec',
                     'machine-vice-count-input',
                     'machine-vice-count-inc']) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(chunk),
      v(`Count stepper must render data-testid="${tid}".`))
  }
})

test('MachineFixturesBody persists answers.machine_vice_count', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  assert.ok(/setAnswer\(['"]machine_vice_count['"],/.test(chunk),
    v('MachineFixturesBody must call setAnswer("machine_vice_count", '
      + '…) so the count persists on the saved program and codegen can '
      + 'read it back for the per-vice loop.'))
  // Default: machine tending almost always uses one vice. The directive
  // calls out "default 1". Grep that the component defaults to 1 when
  // answers.machine_vice_count is undefined.
  assert.ok(/const DEFAULT\s*=\s*1\b/.test(chunk),
    v('Default count must be 1 — machine tending almost always uses '
      + 'one vice; the stepper defaults to it so a tap-through '
      + 'workflow lands on a working program.'))
  // Bounds 0..6 per the directive's "sane max e.g. 6".
  assert.ok(/const MIN\s*=\s*0\b/.test(chunk) && /const MAX\s*=\s*6\b/.test(chunk),
    v('Count must clamp to [0, 6] — 0 is the self-clamping escape '
      + 'hatch, 6 is the sane upper bound from the directive.'))
})

test('Yes/No clamp-gate copy has been RETIRED from MachineFixturesBody', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const end = progWizSrc.indexOf('\n}\n', idx)
  const chunk = progWizSrc.slice(idx, end > idx ? end : idx + 8000)
  // The pre-addendum copy ("Does the machine hold the part with a
  // clamp or vice?" / "Yes — pick fixture(s)" / "No fixture") must
  // not appear. The addendum is explicit: the yes/no gate goes away.
  assert.equal(/Does the machine hold the part with a clamp or vice\?/.test(chunk),
    false,
    v('The retired yes/no gate copy "Does the machine hold the part '
      + 'with a clamp or vice?" must NOT appear in MachineFixturesBody '
      + '— the 2026-10-15 addendum replaced it with a direct count.'))
  assert.equal(/Yes — pick fixture\(s\)/.test(chunk), false,
    v('The retired "Yes — pick fixture(s)" ChoiceButton copy must NOT '
      + 'appear — no yes/no gate.'))
  assert.equal(/>No fixture</.test(chunk), false,
    v('The retired "No fixture" ChoiceButton copy must NOT appear.'))
})

test('Count == 0 renders a self-clamp info block', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  assert.ok(/data-testid="machine-vice-selfclamp"/.test(chunk),
    v('When count == 0 the body must render '
      + 'data-testid="machine-vice-selfclamp" — the plain self-clamping '
      + 'callout that replaces the retired "No fixture" ChoiceButton.'))
  assert.ok(/The program[\s\S]{0,60}will not emit any clamp I\/O/.test(chunk),
    v('Count-0 copy must plainly state the program will not emit '
      + 'any clamp I/O (same effect as the retired "No fixture" '
      + 'branch, now reached via count=0 instead of a yes/no gate).'))
})


// ── (5a-ii) 2026-10-16 count-stepper: no native spinner + centered ──

test('Count-stepper number box is a read-only display (no native spinner)', () => {
  // Scope strictly to MachineFixturesBody — stop at the next
  // function declaration so other wizard bodies' legitimate
  // <input type="number"> fields (manual-TCP entry, machine-IO
  // config, …) don't trip this pin.
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const stop = progWizSrc.indexOf('\nfunction ', idx + 1)
  // Strip JSX {/* … */} comment blocks + // line comments so docstring
  // snippets that mention <input type="number"> for context don't trip
  // the negation. (The regen docstring in the actual component
  // explains WHY the input was retired; this pin cares about live
  // JSX only.)
  const chunk = progWizSrc.slice(idx, stop > idx ? stop : idx + 12000)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\n]*$/gm, '')
  // Operator order 2026-10-16: the pre-fix <input type="number"> inside
  // the stepper rendered native up/down arrows (redundant with the
  // flanking +/− buttons) and pushed the number off-center. Replaced
  // with a read-only <div> whose value is driven by the +/− buttons.
  // The read-only path is operator-preferred over CSS -webkit-
  // appearance:none because it eliminates the spinner surface area
  // entirely — no cross-browser render drift.
  const inputBlockMatch = chunk.match(
    /data-testid="machine-vice-count-input"[\s\S]{0,1500}/)
  assert.ok(inputBlockMatch,
    v('The machine-vice-count-input element must exist in '
      + 'MachineFixturesBody.'))
  const inputBlock = inputBlockMatch[0].slice(0, 1500)
  // The element must NOT be an <input type="number"> — that is the
  // regression surface this pin seals.
  assert.equal(
    /<input\b[\s\S]{0,400}type=["']number["'][\s\S]{0,400}data-testid="machine-vice-count-input"/
      .test(chunk),
    false,
    v('machine-vice-count-input must NOT be an <input type="number"> '
      + '— that renders the native spinner arrows the 2026-10-16 '
      + 'operator order asked us to retire.'))
  assert.ok(
    /role="spinbutton"[\s\S]{0,200}aria-valuenow=\{count\}/.test(inputBlock)
      || /aria-valuenow=\{count\}[\s\S]{0,200}role="spinbutton"/.test(inputBlock),
    v('The read-only display must carry role="spinbutton" + '
      + 'aria-valuenow={count} so assistive tech still sees it as a '
      + 'numeric control even though it has no native chrome.'))
  // aria-valuemin + aria-valuemax round out the a11y surface.
  assert.ok(
    /aria-valuemin=\{MIN\}/.test(inputBlock)
      && /aria-valuemax=\{MAX\}/.test(inputBlock),
    v('The read-only display must carry aria-valuemin={MIN} + '
      + 'aria-valuemax={MAX} for a11y.'))
})

test('Count-stepper number is centered horizontally AND vertically', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  const inputBlockMatch = chunk.match(
    /data-testid="machine-vice-count-input"[\s\S]{0,1500}/)
  assert.ok(inputBlockMatch, v('machine-vice-count-input must exist.'))
  const inputBlock = inputBlockMatch[0].slice(0, 1500)
  // Horizontal: textAlign center is required; vertical: flex + alignItems:center
  // + justifyContent:center on the box itself (there is no native
  // vertical center in a <div> otherwise).
  assert.ok(/textAlign:\s*['"]center['"]/.test(inputBlock),
    v('machine-vice-count-input must set textAlign: "center" — '
      + 'horizontal centering.'))
  assert.ok(
    /display:\s*['"]flex['"][\s\S]{0,200}alignItems:\s*['"]center['"][\s\S]{0,200}justifyContent:\s*['"]center['"]/
      .test(inputBlock),
    v('machine-vice-count-input must be display:flex + '
      + 'alignItems:"center" + justifyContent:"center" so the number '
      + 'sits dead-center vertically AND horizontally in the box.'))
})

test('Broader "workholding fixture" wording is consistent across the picker', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  // The picker sub-label reads "Which workholding fixture is each one?"
  // (updated from "Which vice is each one?") so the picker's heading
  // matches the broadened headline.
  assert.ok(/Which workholding fixture is each one\?/.test(chunk),
    v('Picker sub-label must read "Which workholding fixture is each '
      + 'one?" verbatim — consistent with the broader "vices or '
      + 'workholding fixtures" headline.'))
  // Per-slot label broadened to "Fixture N" (was "Vice N").
  assert.ok(/Fixture \{idx \+ 1\}/.test(chunk),
    v('Per-slot label must read "Fixture {idx + 1}" (broadened from '
      + '"Vice {idx + 1}" to match the workholding-fixtures wording).'))
  // Self-clamp callout + capacity banner + trailing N-count line all
  // use the broader term too.
  assert.ok(/No workholding fixtures — the machine holds the part itself/.test(chunk),
    v('Self-clamp callout must read "No workholding fixtures — the '
      + 'machine holds the part itself." (broadened from "No vices").'))
  assert.ok(/You have \{fixtures\.length\} workholding fixture/.test(chunk),
    v('Capacity banner must say "You have N workholding fixture(s)" '
      + '(broadened from "N vice(s)").'))
  assert.ok(/\{count\} workholding fixtures will be loaded/.test(chunk),
    v('Trailing count line must say "N workholding fixtures will be '
      + 'loaded…" (broadened from "N vices").'))
})


// ── (5b) 2026-10-15 duplicate-prevention + capacity check ──────────

test('Duplicate detection + canAdvance gating uses a Set of non-empty ids', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 10000)
  // Derivation: hasDuplicate flips true when slotIds.filter(id→!!id)
  // has a shorter size than the Set of the same. The pin greps for
  // the invariant check — a refactor that drops this gate would let
  // the field bug ("three vices all mapped to Vice 1") ship again.
  assert.ok(
    /const nonEmpty\s*=\s*slotIds\.filter\(\(id\)\s*=>\s*!!id\)/.test(chunk),
    v('MachineFixturesBody must derive nonEmpty = slotIds.filter(id => '
      + '!!id) — the base for duplicate detection.'))
  assert.ok(
    /const hasDuplicate\s*=\s*nonEmpty\.length !== new Set\(nonEmpty\)\.size/
      .test(chunk),
    v('MachineFixturesBody must derive hasDuplicate = '
      + 'nonEmpty.length !== new Set(nonEmpty).size — the canonical '
      + 'test for "the operator picked the same fixture twice."'))
  assert.ok(/!hasDuplicate/.test(chunk),
    v('canAdvance derivation must gate on !hasDuplicate so Next '
      + 'stays disabled while two vices share one fixture.'))
})

test('Capacity check: count > fixtures.length blocks Next', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 10000)
  assert.ok(
    /const notEnoughFixtures\s*=\s*count\s*>\s*fixtures\.length/.test(chunk),
    v('MachineFixturesBody must derive notEnoughFixtures = count > '
      + 'fixtures.length — the capacity invariant.'))
  assert.ok(/!notEnoughFixtures/.test(chunk),
    v('canAdvance derivation must gate on !notEnoughFixtures so Next '
      + 'stays disabled when the operator asked for more vices than '
      + 'the cell has distinct External Fixtures.'))
})

test('Capacity banner surfaces the plain "set up more fixtures" copy', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  assert.ok(/data-testid="machine-vice-not-enough-fixtures"/.test(chunk),
    v('MachineFixturesBody must render '
      + 'data-testid="machine-vice-not-enough-fixtures" when the '
      + 'operator asks for more vices than the cell has — the '
      + 'operator-facing banner.'))
  // Operator-authored phrasing per the 2026-10-15 directive:
  //   "You have X vice(s) set up but asked for Y. Set up more in
  //    External Fixtures, or reduce the count."
  assert.ok(/set up but asked for \{count\}/.test(chunk),
    v('Capacity banner must say "You have N vices set up but asked '
      + 'for M." verbatim per the operator directive.'))
  assert.ok(
    /Set up more in External[\s\S]{0,20}Fixtures, or reduce the count/.test(chunk),
    v('Capacity banner must say "Set up more in External Fixtures, '
      + 'or reduce the count." verbatim (JSX whitespace between '
      + 'External and Fixtures is tolerated).'))
})

test('Each vice slot disables fixtures already picked by other slots', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  // Primary UX: grey out already-chosen fixtures in other dropdowns.
  // The derivation must build a Set of "taken by other slots" ids and
  // mark the matching <option> rows as disabled.
  assert.ok(
    /const takenByOthers\s*=\s*new Set\([\s\S]{0,200}slotIds\.filter\(\(other, i\)\s*=>\s*i !== idx[\s\S]{0,80}&&\s*!!other\)\)/
      .test(chunk),
    v('Each slot must derive takenByOthers = new Set(slotIds.filter((o, '
      + 'i) => i !== idx && !!o)) — the ids the OTHER slots already '
      + 'claim.'))
  assert.ok(
    /disabled=\{takenElsewhere\}/.test(chunk),
    v('<option> rows for fixtures claimed by other slots must set '
      + 'disabled={takenElsewhere} — grey-out prevents the duplicate '
      + 'from ever being picked in the UI.'))
  // The grey-out options also carry an "already assigned" tail so
  // the operator sees WHY the choice is unavailable.
  assert.ok(/already assigned/.test(chunk),
    v('Grey-out options must include an "already assigned" tail so '
      + 'the operator knows why the option is disabled, not just '
      + 'that it is.'))
})

test('Duplicate-slot defensive error row (for hand-edited saved programs)', () => {
  const idx = progWizSrc.indexOf('function MachineFixturesBody(')
  const chunk = progWizSrc.slice(idx, idx + 12000)
  // Defensive backstop: if a saved program carried a duplicate
  // (hand-edited answers blob OR a schema that bypassed the picker),
  // the slot must render a red error row AND canAdvance stays false.
  assert.ok(
    /const isDuplicate\s*=\s*!!id\s*&&\s*slotIds\.filter\(\(x\)\s*=>\s*x\s*===\s*id\)\.length\s*>\s*1/
      .test(chunk),
    v('Each slot must derive isDuplicate = !!id && slotIds.filter(x => '
      + 'x === id).length > 1 — the per-slot duplicate flag.'))
  assert.ok(/data-testid="machine-vice-slot-duplicate-error"/.test(chunk),
    v('A duplicated slot must render '
      + 'data-testid="machine-vice-slot-duplicate-error" so e2e tests '
      + 'can observe the error path.'))
  assert.ok(
    /Can[\s\S]{0,10}t use the same fixture twice[\s\S]{0,80}each[\s\S]{0,30}fixture is separate hardware/
      .test(chunk),
    v('Duplicate error copy must explain in plain operator language '
      + 'that each fixture is separate hardware (broadened from the '
      + '"vice" wording per the 2026-10-16 workholding-fixtures '
      + 'addendum).'))
  // The slot container must carry data-duplicate so operator-facing
  // tests can filter.
  assert.ok(/data-duplicate=\{String\(isDuplicate\)\}/.test(chunk),
    v('Each slot container must stamp data-duplicate={String(isDuplicate)} '
      + 'so e2e tests can filter duplicate rows.'))
})


// ── (6) buildSteps machine_tend per-fixture emission ────────────────

test('buildSteps machine_tend branches on resolveMachineFixtures', () => {
  const sIdx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(sIdx, sIdx + 28000)
  assert.ok(/const fixtures\s*=\s*resolveMachineFixtures\(cellRegistry, answers\)/.test(chunk),
    v('buildSteps machine_tend branch must call resolveMachineFixtures('
      + 'cellRegistry, answers) — the single resolver that produces '
      + 'the per-fixture emission list.'))
  assert.ok(/const hasFixtures\s*=\s*fixtures\.length\s*>\s*0/.test(chunk),
    v('buildSteps must declare hasFixtures as the gate between the '
      + 'per-fixture flow and the legacy no-fixture flow.'))
})

test('Per-fixture flow emits clamp AFTER release (safety-critical)', () => {
  // Safety invariant: the gripper releases BEFORE the vice clamps so
  // the robot does not pull against a closing jaw. Verify by anchor
  // ordering inside the per-fixture loop body.
  const sIdx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(sIdx, sIdx + 28000)
  assert.ok(
    /fixtures\.forEach\(\(fx, idx\)\s*=>\s*\{[\s\S]{0,3000}position_role:\s*loadRole[\s\S]{0,900}effectorDisengage\([\s\S]{0,900}clampFixtureSteps\(fx\)/
      .test(chunk),
    v('Per-fixture load loop must emit, in order: approach / contact '
      + '(position_role: loadRole) / effectorDisengage / '
      + 'clampFixtureSteps. Release-FIRST then clamp — the operator '
      + 'order "clamp AFTER release" is safety-critical and this '
      + 'pin enforces it.'))
})

test('Unload side emits unclamp AFTER grip (safety-critical)', () => {
  // Robot grips finished part BEFORE the vice unclamps so the part
  // cannot fall if the vice spring-returns.
  const sIdx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(sIdx, sIdx + 28000)
  assert.ok(
    /effectorEngage\([\s\S]{0,500}labelOverride:[\s\S]{0,500}unclampFixtureSteps\(fx\)/
      .test(chunk),
    v('Per-fixture unload loop must emit effectorEngage BEFORE '
      + 'unclampFixtureSteps — grip finished part first, then unclamp. '
      + 'Prevents the part from falling if the vice spring-returns.'))
})

test('Multi-fixture: all load loops run BEFORE cycle-start', () => {
  // Load phase (fixtures.forEach for the load side) must finish
  // before startMachineCycle is pushed. Walk anchors in order.
  const sIdx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(sIdx, sIdx + 28000)
  // The order of appearance in source must be:
  //   fixtures.forEach(...load body...) → ... → startMachineCycle(...
  //   → waitMachineCycle(... → fixtures.forEach(...unload body...)
  const loadLoop   = chunk.indexOf('fixtures.forEach')
  const startCycle = chunk.indexOf('startMachineCycle(', loadLoop)
  const waitCycle  = chunk.indexOf('waitMachineCycle(',  startCycle)
  const unloadLoop = chunk.indexOf('fixtures.forEach', waitCycle)
  assert.ok(loadLoop > 0 && startCycle > loadLoop && waitCycle > startCycle && unloadLoop > waitCycle,
    v('buildSteps machine_tend branch must emit, in source order: '
      + 'fixtures.forEach (load phase) → startMachineCycle(...) → '
      + 'waitMachineCycle(...) → fixtures.forEach (unload phase). '
      + 'All N vices must be clamped BEFORE the machine runs; the '
      + 'cycle-complete wait must precede the unload loop so the '
      + 'robot never reaches into a running machine.'))
})

test('Legacy no-fixture path still calls clampWorkpiece/unclampWorkpiece', () => {
  // Byte-identity for programs with no fixtures selected (operator
  // declared "No fixture" OR saved before the directive).
  const sIdx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(sIdx, sIdx + 28000)
  assert.ok(/clampWorkpiece\(portmap\)/.test(chunk),
    v('The legacy no-fixture branch must still call '
      + 'clampWorkpiece(portmap) so byte-identity holds for programs '
      + 'saved before the directive.'))
  assert.ok(/unclampWorkpiece\(portmap\)/.test(chunk),
    v('The legacy no-fixture branch must still call '
      + 'unclampWorkpiece(portmap).'))
})


// ── (7) Save-time refusal in handleSave ─────────────────────────────

test('handleSave refuses on missing clamp signal with plain copy', () => {
  // The refusal lands as a toast via useStore.getState().addToast and
  // returns BEFORE the fetch is issued. Grep the handleSave body.
  const idx = progWizSrc.indexOf('const handleSave = async () => {')
  const chunk = progWizSrc.slice(idx, idx + 2000)
  assert.ok(/missingClampSignalRefusal\(_mFixtures\)/.test(chunk),
    v('handleSave must call missingClampSignalRefusal(_mFixtures) to '
      + 'build the plain-copy refusal message.'))
  assert.ok(/useStore\.getState\(\)\.addToast\?\.\(_refusal,\s*['"]error['"]\)/.test(chunk),
    v('handleSave must surface the refusal via '
      + 'useStore.getState().addToast(_refusal, "error") — the shared '
      + 'toast seam.'))
  assert.ok(/setSaving\(false\)[\s\S]{0,80}return/.test(chunk),
    v('On refusal, handleSave must setSaving(false) + return BEFORE '
      + 'the fetch — otherwise a half-configured program would ship.'))
})
