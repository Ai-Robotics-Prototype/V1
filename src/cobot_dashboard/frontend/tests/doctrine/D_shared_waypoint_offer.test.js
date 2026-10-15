// DOCTRINE — Waypoint-offer data model is a SHARED lib + palletize
// has exactly ONE junction (2026-10-15 operator directive).
//
// Pre-fix: 045432f shipped the waypoint-offer feature as inline
// helpers inside ProgramWizard.jsx — waypointJunctionsForAnswers,
// readWaypointsForJunction, waypointStepsForJunction. The only
// wizard surface at the time was ProgramWizard, so "no fork" was
// trivially satisfied. But if a future surface (editor teach drawer,
// a second wizard) wanted the same offer, it would be tempted to
// copy-paste the junction map — and then a fix in one place wouldn't
// land everywhere.
//
// This ship extracts the data model to lib/waypointJunctions.js so
// every surface imports from the SAME source. ProgramWizard imports
// waypointJunctionsForOperation, readWaypointsForJunction,
// waypointStepsForJunction, offerInstrFor; the inline helpers are
// retired.
//
// Separately: palletize's junction list is reduced from 3 →
// exactly 1 (pick → pallet-approach). The other junctions
// (home_to_pick, place_to_home) are retired for palletize per the
// operator order "ONLY a single optional waypoint on the PICK→PALLET
// approach". Depalletize keeps its three junctions (the operator
// scoped the single-offer reduction to palletize alone).
//
// Pins:
//   * lib/waypointJunctions.js exports waypointJunctionsForOperation,
//     readWaypointsForJunction, waypointStepsForJunction, offerInstrFor,
//     HONEST_SCOPE_DISCLAIMER.
//   * ProgramWizard IMPORTS these from the shared lib and does NOT
//     redeclare any of the retired inline functions.
//   * No source file under src/ (excluding the shared lib itself)
//     redeclares the retired names — grep-pin seals the anti-fork
//     invariant against copy-paste regressions.
//   * palletize mode has exactly ONE junction: id="pick_to_place" at
//     afterKey="taught_pick" (fromLabel "Pick" → toLabel "Pallet
//     place"). Nothing anchors on a pallet-corner key — grid cells
//     are computed, not taught, no junction between them.
//   * depalletize mode keeps its three junctions (home_to_pick,
//     pick_to_place, place_to_home) — unchanged from 045432f.
//   * The honest-scope disclaimer lives in the shared lib and is
//     consumed by ProgramWizard via offerInstrFor (no cross-copy of
//     the "steer the path around" phrasing).
//
// Failure format: DOCTRINE SHARED_WAYPOINT_OFFER VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  waypointJunctionsForOperation,
  readWaypointsForJunction,
  waypointStepsForJunction,
  offerInstrFor,
  HONEST_SCOPE_DISCLAIMER,
} from '../../src/lib/waypointJunctions.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')
const SRC_ROOT = join(FRONT_ROOT, 'src')

const progWizSrc = readSrc('components/ProgramWizard.jsx')
const sharedSrc  = readSrc('lib/waypointJunctions.js')

function v(msg) { return `DOCTRINE SHARED_WAYPOINT_OFFER VIOLATED: ${msg}` }


// ── (1) Shared lib surface area ─────────────────────────────────────

test('lib/waypointJunctions exports the shared offer API', () => {
  assert.ok(typeof waypointJunctionsForOperation === 'function',
    v('waypointJunctionsForOperation must be exported from the shared lib.'))
  assert.ok(typeof readWaypointsForJunction === 'function',
    v('readWaypointsForJunction must be exported.'))
  assert.ok(typeof waypointStepsForJunction === 'function',
    v('waypointStepsForJunction must be exported.'))
  assert.ok(typeof offerInstrFor === 'function',
    v('offerInstrFor must be exported — the honest-scope copy builder.'))
  assert.equal(typeof HONEST_SCOPE_DISCLAIMER, 'string',
    v('HONEST_SCOPE_DISCLAIMER must be exported as a string constant '
      + 'so every surface renders the same operator-facing disclaimer.'))
  assert.ok(/does not auto-detect obstacles/.test(HONEST_SCOPE_DISCLAIMER),
    v('HONEST_SCOPE_DISCLAIMER must carry the "does not auto-detect '
      + 'obstacles" phrasing — the honest-scope invariant.'))
})


// ── (2) ProgramWizard imports (and does not redeclare) ──────────────

test('ProgramWizard imports the shared waypoint API', () => {
  assert.ok(
    /import\s*\{[\s\S]{0,200}waypointJunctionsForOperation[\s\S]{0,200}readWaypointsForJunction[\s\S]{0,200}waypointStepsForJunction[\s\S]{0,200}offerInstrFor[\s\S]{0,200}\}\s*from\s*['"]\.\.\/lib\/waypointJunctions['"]/
      .test(progWizSrc),
    v('ProgramWizard must import waypointJunctionsForOperation + '
      + 'readWaypointsForJunction + waypointStepsForJunction + '
      + 'offerInstrFor from ../lib/waypointJunctions in a single import '
      + 'statement — import-identity, no inline redeclaration.'))
})

test('ProgramWizard does NOT redeclare the retired inline helpers', () => {
  for (const retired of [
    'function waypointJunctionsForAnswers(',
    'function readWaypointsForJunction(',
    'function waypointStepsForJunction(',
  ]) {
    assert.equal(progWizSrc.includes(retired), false,
      v(`ProgramWizard must NOT redeclare "${retired}" — the shared lib `
        + `is the single source of truth. A copy-paste here would make `
        + `a shared-lib fix invisible to the wizard.`))
  }
})


// ── (3) Anti-fork sweep across src/ ─────────────────────────────────

test('No other file under src/ redeclares the retired inline helpers', () => {
  // Walk the whole src/ tree. The shared lib is the only legitimate
  // definer; any other file that redeclares any of the retired names
  // (function declaration or `const name = (…) =>`) regresses the
  // anti-fork invariant.
  const offenders = []
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      if (!/\.(jsx?|mjs|cjs)$/.test(name)) continue
      if (name.endsWith('.test.js') || name.endsWith('.test.jsx')) continue
      if (p.endsWith(join('lib', 'waypointJunctions.js'))) continue  // the shared lib
      const src = readFileSync(p, 'utf8')
      for (const retired of [
        'waypointJunctionsForAnswers',
        'waypointJunctionsForOperation',
        'readWaypointsForJunction',
        'waypointStepsForJunction',
      ]) {
        // Function declaration OR const-assignment at the file top
        // level. Imports / destructuring / call sites are fine.
        const declRe = new RegExp(
          `(?:^|\\n)\\s*(?:function|const|let|var)\\s+${retired}\\s*[(=]`,
          'm')
        if (declRe.test(src)) offenders.push(`${p} redeclares ${retired}`)
      }
    }
  }
  walk(SRC_ROOT)
  assert.deepEqual(offenders, [],
    v('No file under src/ (besides lib/waypointJunctions.js) may '
      + 'redeclare the shared waypoint-offer helpers. Offenders: '
      + offenders.join('; ')))
})


// ── (4) Palletize has exactly ONE junction ──────────────────────────

test('palletize mode offers exactly ONE junction — pick → pallet place', () => {
  const list = waypointJunctionsForOperation({
    operation: 'palletize', pallet_mode: 'palletize',
  })
  assert.equal(list.length, 1,
    v(`palletize must offer exactly ONE waypoint junction per the `
      + `2026-10-15 operator directive ("single optional waypoint on `
      + `the pick → pallet approach"); got ${list.length}.`))
  const only = list[0]
  assert.equal(only.id,       'pick_to_place',
    v('palletize junction id must be "pick_to_place".'))
  assert.equal(only.afterKey, 'taught_pick',
    v('palletize junction must anchor on the pick teach step '
      + '(afterKey:"taught_pick") — the pick → pallet-approach seam.'))
  assert.equal(only.fromLabel, 'Pick')
  assert.equal(only.toLabel,   'Pallet place')
})

test('palletize junction does NOT anchor on any pallet-corner key', () => {
  // Grid cells + pallet frame corners are computed / frame-defining,
  // not motion endpoints. No junction may anchor on a corner key.
  const list = waypointJunctionsForOperation({
    operation: 'palletize', pallet_mode: 'palletize',
  })
  const corners = new Set([
    'taught_pallet_corner1', 'taught_pallet_corner2',
    'taught_pallet_corner3', 'taught_pallet_part',
  ])
  for (const j of list) {
    assert.equal(corners.has(j.afterKey), false,
      v(`palletize junction must NOT anchor on pallet-corner key `
        + `"${j.afterKey}" — grid cells are computed, not taught; `
        + `no between-cell junction.`))
  }
})

test('depalletize keeps its three junctions (unchanged from 045432f)', () => {
  const list = waypointJunctionsForOperation({
    operation: 'palletize', pallet_mode: 'depalletize',
  })
  const ids = list.map((j) => j.id)
  assert.deepEqual(ids, ['home_to_pick', 'pick_to_place', 'place_to_home'],
    v('depalletize must retain the three-junction set from 045432f — '
      + 'the single-offer reduction is palletize-only per the 2026-10-15 '
      + 'directive.'))
})


// ── (5) Non-palletize ops keep their full junction sets ─────────────

test('pick_and_place keeps its three junctions', () => {
  const ids = waypointJunctionsForOperation({ operation: 'pick_and_place' })
    .map((j) => j.id)
  assert.deepEqual(ids, ['home_to_pick', 'pick_to_place', 'place_to_home'],
    v('pick_and_place must retain the three motion-endpoint junctions.'))
})

test('machine_tend keeps its four junctions', () => {
  const ids = waypointJunctionsForOperation({ operation: 'machine_tend' })
    .map((j) => j.id)
  assert.deepEqual(ids,
    ['home_to_pick', 'pick_to_machine_load',
     'machine_load_to_unload', 'unload_to_home'],
    v('machine_tend must offer waypoint-teaching at every motion '
      + 'endpoint transition (home / pick / machine_load / unload / '
      + 'return) — inherits the shared offer automatically.'))
})

test('sort keeps its three junctions', () => {
  const ids = waypointJunctionsForOperation({ operation: 'sort' })
    .map((j) => j.id)
  assert.deepEqual(ids, ['home_to_pick', 'pick_to_place', 'place_to_home'],
    v('sort folds its two place poses onto one codegen place segment '
      + '— junctions mirror that shape with place_to_home anchored on '
      + 'taught_sort_2.'))
})


// ── (6) Honest-scope copy is single-source ──────────────────────────

test('offerInstrFor produces a sentence that includes the disclaimer', () => {
  const sample = offerInstrFor({ fromLabel: 'Home', toLabel: 'Pick' })
  assert.ok(sample.includes('steer the path around a fixture or obstacle'),
    v('offerInstrFor copy must include the "steer the path around" '
      + 'phrasing — the operator-written honest-routing language.'))
  assert.ok(sample.includes(HONEST_SCOPE_DISCLAIMER),
    v('offerInstrFor copy must include the HONEST_SCOPE_DISCLAIMER '
      + 'verbatim — single-source invariant.'))
})

test('No surface claims automatic obstacle avoidance', () => {
  for (const src of [progWizSrc, sharedSrc]) {
    assert.equal(/automatic(ally)?\s+avoid/i.test(src), false,
      v('No wizard or shared surface may claim automatic obstacle '
        + 'avoidance — the arm does not sense; the operator teaches '
        + 'via-points.'))
    assert.equal(/auto-avoid/i.test(src), false,
      v('Same honest-scope rule: no "auto-avoid" copy anywhere.'))
  }
})


// ── (7) Existing programs unaffected: empty storage still → [] ──────

test('waypointStepsForJunction returns [] for empty storage (equivalence)', () => {
  // The 1/1 pick/place equivalence invariant reduces to this: a program
  // with no answers.waypoints produces zero waypoint-step emissions,
  // byte-identical to the pre-feature output.
  assert.deepEqual(waypointStepsForJunction({}, 'home_to_pick', 40), [])
  assert.deepEqual(waypointStepsForJunction({ waypoints: {} }, 'home_to_pick', 40), [])
  assert.deepEqual(waypointStepsForJunction({ waypoints: { home_to_pick: [] } }, 'home_to_pick', 40), [])
})
