// DOCTRINE — Program-wizard pick + place counts replace the retired
// "Where should the robot place the part?" Fixed/Relative step
// (2026-10-15 operator directive).
//
// Pre-fix: ProgramWizard.jsx carried a step at ~2560-2588 that asked
// "Where should the robot place the part?" with options "Fixed
// Position" and "Relative Offset". The 'relative' branch wrote
// answers.place_method = 'relative' but was NEVER read by codegen
// (buildSteps / buildPalletizeSteps always honored the taught place
// pose; a grep for answers.place_method / place_offset / 'relative' at
// any read site returned nothing). The option was dead code and
// redundant with Palletize's grid flow.
//
// Replaced with explicit per-position counts: "How many pick
// positions?" (1-10, default 1) + "How many place positions?" (1-10,
// default 1). The teach sequence emits one jog/record per pose; the
// paired-loop codegen pairs pick_i → place_i for K = min(nPicks, nPlaces)
// pairs. For 1/1 the output is byte-identical to today (keys
// taught_pick / taught_place, position_role 'pick'/'place'), so old
// programs load unchanged and never silently break.
//
// Pins:
//   * No place_method step id, no "Where should the robot place" copy,
//     no "Relative Offset" / 'relative' value anywhere in ProgramWizard.
//   * pick_count + place_count steps exist, both default 1, skip for
//     machine_tend + palletize + sort (which have their own flows).
//   * Shared PickPlaceCountInput helper exists (import-identity — the
//     two count steps mount the same component, no fork).
//   * teachPositionsForAnswers emits taught_pick / taught_place for 1/1
//     (byte-identical equivalence) and taught_pick_i / taught_place_j
//     for any count ≥ 2.
//   * buildSteps emits a paired loop with position_role 'pick_i' /
//     'place_i' for count ≥ 2, flagged by an `isMultiPair` branch; the
//     single-pair path is preserved unchanged.
//   * applyToRole wiring exists for the indexed roles so taught poses
//     flow into the right generated step.
//   * No live consumer of answers.place_method anywhere in the frontend
//     (the retired write-only key is gone from everything).
//
// Failure format: DOCTRINE WIZARD_COUNTS VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc = readSrc('components/ProgramWizard.jsx')

function v(msg) { return `DOCTRINE WIZARD_COUNTS VIOLATED: ${msg}` }


// ── (1) The retired place_method step is gone ───────────────────────

test('ProgramWizard no longer declares the place_method step', () => {
  // Strip comments so the standing "retirement" docstring explaining
  // what was removed doesn't trip the gate. The pin fires on live
  // code only.
  const stripped = progWizSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*$/gm, '')
  assert.equal(/id:\s*['"]place_method['"]/.test(stripped), false,
    v('ProgramWizard must NOT declare a step with id "place_method" — '
      + 'the Fixed/Relative Offset page was retired 2026-10-15.'))
  assert.equal(/Where should the robot place the part/.test(stripped), false,
    v('ProgramWizard must NOT contain the "Where should the robot '
      + 'place the part?" question copy — the step is gone.'))
  assert.equal(/Relative Offset/.test(stripped), false,
    v('ProgramWizard must NOT contain the "Relative Offset" label — '
      + 'the option was removed (grids live in Palletize).'))
})

test('No live consumer of answers.place_method anywhere in the frontend', () => {
  // Sweep the entire frontend src/ tree for any read-site. The retired
  // key is write-only and nothing else should reference it. If a stray
  // reader exists, this ship must not land.
  const errors = []
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      if (!/\.(jsx?|mjs|cjs)$/.test(name)) continue
      if (name.endsWith('.test.js') || name.endsWith('.test.jsx')) continue
      const src = readFileSync(p, 'utf8')
      // Reader shape: answers.place_method / cfg.place_method / s.place_method
      // on the right side of comparison or as object access. Writer-only
      // forms (setAnswer('place_method', …)) were deleted with the step.
      if (/\b(?:answers|cfg|config|s|p|row|rec|prog)\.place_method\b/.test(src)) {
        errors.push(p)
      }
    }
  }
  walk(join(FRONT_ROOT, 'src'))
  assert.deepEqual(errors, [],
    v('No file under src/ may read .place_method — the key is retired. '
      + `Found reads in: ${errors.join(', ')}`))
})


// ── (2) New pick_count + place_count steps + helper ─────────────────

test('ProgramWizard declares pick_count + place_count steps', () => {
  for (const id of ['pick_count', 'place_count']) {
    assert.ok(new RegExp(`id:\\s*['"]${id}['"]`).test(progWizSrc),
      v(`ProgramWizard must declare a step with id "${id}" — the two `
        + `count questions that replace the retired place_method page.`))
  }
})

test('Both count steps skip for machine_tend + palletize + sort', () => {
  // Each count step must only fire for the pick_and_place / default
  // flow — machine_tend has its own load/unload teach, palletize has
  // pallet pages, and sort has taught_sort_1/2 (unchanged this ship).
  for (const id of ['pick_count', 'place_count']) {
    const re = new RegExp(
      `id:\\s*['"]${id}['"][\\s\\S]{0,400}skip:[\\s\\S]{0,300}machine_tend[\\s\\S]{0,80}palletize[\\s\\S]{0,80}sort`)
    assert.ok(re.test(progWizSrc),
      v(`"${id}" step must skip for machine_tend + palletize + sort — `
        + `the three ops that own their own place teach flows.`))
  }
})

test('Count copy is plain operator language', () => {
  assert.ok(/How many pick positions\?/.test(progWizSrc),
    v('pick_count step must ask "How many pick positions?" verbatim '
      + '— the operator-authored copy from the 2026-10-15 directive.'))
  assert.ok(/How many place positions\?/.test(progWizSrc),
    v('place_count step must ask "How many place positions?" verbatim.'))
  // Pointer back to Palletize for grid use cases (per the directive's
  // optional pointer — do not duplicate the grid flow in pick/place).
  assert.ok(/Palletize/.test(progWizSrc),
    v('A plain pointer to Palletize should remain somewhere in the '
      + 'pick/place count copy so operators with grid intent land on '
      + 'the right op without searching.'))
})

test('PickPlaceCountInput helper exists and is import-identical between its mount sites', () => {
  assert.ok(/function PickPlaceCountInput\(\{\s*value,\s*onChange,\s*testId\s*\}\)/.test(progWizSrc),
    v('ProgramWizard must define PickPlaceCountInput as a shared helper '
      + '— no fork between the count steps.'))
  // Each count step mounts <PickPlaceCountInput ... /> — same component
  // import-identity, no bespoke stepper per step. 2026-10-15 added a
  // third mount for the multi-pick count (gated on tool capacity > 1):
  //   1. pick_count         → testId="pick-count-input"
  //   2. place_count        → testId="place-count-input"
  //   3. multi_pick_count   → testId="multi-pick-count-input"
  const mounts = (progWizSrc.match(/<PickPlaceCountInput\b/g) || []).length
  assert.equal(mounts, 3,
    v(`Exactly three <PickPlaceCountInput /> mount sites are expected `
      + `(pick_count + place_count + multi_pick_count); found ${mounts}.`))
  for (const id of ['pick-count-input', 'place-count-input', 'multi-pick-count-input']) {
    assert.ok(new RegExp(`testId="${id}"`).test(progWizSrc),
      v(`Count step must pass testId="${id}" to the shared helper.`))
  }
})


// ── (3) Teach sequence emits indexed poses for count ≥ 2 ────────────

test('teachPositionsForAnswers emits taught_pick / taught_place for 1/1 default', () => {
  // 1/1 path: the two literal push calls with the historical keys +
  // labels. Byte-identical equivalence pin — rename either key and
  // old programs lose their taught state on load.
  assert.ok(
    /if \(nPicks === 1 && nPlaces === 1\)[\s\S]{0,400}key:\s*['"]taught_pick['"][\s\S]{0,500}key:\s*['"]taught_place['"]/
      .test(progWizSrc),
    v('For nPicks==1 && nPlaces==1 (default), teachPositionsForAnswers '
      + 'must emit taught_pick + taught_place verbatim — same keys as '
      + 'the pre-directive single-pair flow so byte-identical '
      + 'equivalence holds and old programs load unchanged.'))
})

test('teachPositionsForAnswers emits taught_pick_i / taught_place_j for count ≥ 2', () => {
  assert.ok(
    /for \(let i = 1; i <= nPicks; i\+\+\)[\s\S]{0,400}key:\s*`taught_pick_\$\{i\}`/
      .test(progWizSrc),
    v('For count ≥ 2 the teach sequence must emit N indexed pick '
      + 'entries with keys taught_pick_${i}.'))
  assert.ok(
    /for \(let j = 1; j <= nPlaces; j\+\+\)[\s\S]{0,400}key:\s*`taught_place_\$\{j\}`/
      .test(progWizSrc),
    v('For count ≥ 2 the teach sequence must emit M indexed place '
      + 'entries with keys taught_place_${j}.'))
})

test('Count clamping is 1..10', () => {
  // Both the wizard-step derivation and the helper enforce the same
  // bounds — a defensive invariant so a saved-program hand-edit of
  // pick_count: 42 does not emit 42 teach steps.
  assert.ok(
    /const nPicks\s*=\s*Math\.max\(1,\s*Math\.min\(10,\s*Number\(answers\.pick_count\)\s*\|\|\s*1\)\)/
      .test(progWizSrc),
    v('nPicks must clamp to [1, 10] — same bound in the teach '
      + 'sequence derivation and buildSteps.'))
  assert.ok(
    /const nPlaces\s*=\s*Math\.max\(1,\s*Math\.min\(10,\s*Number\(answers\.place_count\)\s*\|\|\s*1\)\)/
      .test(progWizSrc),
    v('nPlaces must clamp to [1, 10].'))
})


// ── (4) buildSteps paired loop ──────────────────────────────────────

test('buildSteps declares an isMultiPair branch for count ≥ 2', () => {
  assert.ok(
    /const isMultiPair\s*=\s*\(op === 'pick_and_place'\)\s*&&\s*\(nPicks !== 1 \|\| nPlaces !== 1\)/
      .test(progWizSrc),
    v('buildSteps must declare isMultiPair = (op === "pick_and_place") '
      + '&& (nPicks !== 1 || nPlaces !== 1) — the sole gate that flips '
      + 'between byte-identical single-pair and the paired loop.'))
  assert.ok(
    /const K\s*=\s*Math\.min\(nPicks, nPlaces\)/.test(progWizSrc),
    v('buildSteps must set K = min(nPicks, nPlaces) — the pairing '
      + 'count. Extras (|nPicks - nPlaces| taught poses) stay in '
      + 'answers but never fire motion; a future Review-page warning '
      + 'surfaces them for the operator.'))
})

test('buildSteps paired loop emits pick_i → place_i pairs', () => {
  const idx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(idx, idx + 18000)
  // The paired loop body must emit position_role: 'pick_${i}' + 'place_${i}'
  // for i in 1..K, flanked by effectorEngage + waypoints + effectorDisengage.
  assert.ok(
    /for \(let i = 1; i <= K; i\+\+\)[\s\S]{0,2000}position_role:\s*`pick_\$\{i\}`[\s\S]{0,500}effectorEngage[\s\S]{0,800}waypointStepsForJunction\(answers, 'pick_to_place'[\s\S]{0,500}position_role:\s*`place_\$\{i\}`[\s\S]{0,500}effectorDisengage/
      .test(chunk),
    v('The paired loop body must emit, in order per iteration: '
      + 'approach pick_i / contact pick_i / engage / verification? / '
      + 'retreat pick_i / waypoints pick_to_place / approach place_i / '
      + 'contact place_i / disengage. Same semantics as the single-pair '
      + 'flow, repeated K times (the engage→waypoints span widened to '
      + 'accommodate the 2026-10-15 verificationStepsForEoat emission).'))
})

test('Trailing effectorDisengage is suppressed for multi-pair', () => {
  // In single-pair the final disengage + retreat live BELOW the else-
  // branch; the paired loop already emits per-pair disengage + retreat,
  // so the trailing emit must gate on !isMultiPair.
  const idx = progWizSrc.indexOf('function buildSteps(answers, portmap = null')
  const chunk = progWizSrc.slice(idx, idx + 18000)
  assert.ok(
    /if \(!isMultiPair\)\s*\{\s*\n\s*steps\.push\(\.\.\.effectorDisengage\(cfgEffector, _vocabOpts\)\)/
      .test(chunk),
    v('The trailing effectorDisengage(cfgEffector, _vocabOpts) must '
      + 'gate on if (!isMultiPair) — multi-pair already emitted a '
      + 'per-pair disengage inside the loop.'))
})

test('applyTaught resolves indexed pick_i / place_i roles for multi-pair', () => {
  assert.ok(
    /if \(isMultiPair\)\s*\{[\s\S]{0,500}readTaught\(cfg,\s*`taught_pick_\$\{i\}`\)[\s\S]{0,200}readTaught\(cfg,\s*`taught_place_\$\{i\}`\)[\s\S]{0,200}applyToRole\(`pick_\$\{i\}`[\s\S]{0,200}applyToRole\(`place_\$\{i\}`/
      .test(progWizSrc),
    v('For multi-pair, applyToRole must resolve taught_pick_i → '
      + 'position_role "pick_i" and taught_place_i → position_role '
      + '"place_i" so the paired loop\'s contact steps get their taught '
      + 'poses filled in on save.'))
})


// ── (5) 1/1 equivalence — the pre-directive emit shape is intact ───

function _slimReadTaught(cfg, key) {
  const v = cfg && cfg[key]
  if (!v) return null
  if (v.skipped) return null
  if (!Array.isArray(v.tcp) && !Array.isArray(v.joints)) return null
  return v
}
function _slimEffector(_cfg, _opts) { return [] }
function _slimClamp()   { return [] }
function _slimUnclamp() { return [] }
function _slimStart()   { return [] }
function _slimWait()    { return [] }

function evalBuildStepsCore() {
  // Pull the complete buildSteps function body — the pin trusts the
  // regex-extracted source and runs it in a sandbox against stubbed
  // vocab emitters. Only the step action / label / position_role /
  // derived_from fields are shape-checked; the stubs return [] so
  // effector emissions don't noise the equivalence diff. 2026-10-15:
  // verificationStepsForEoat + the eoatVerification helpers are added
  // to the extract so the per_pick / per_part codegen path can be
  // sandboxed too.
  const m = progWizSrc.match(/function buildSteps\(answers, portmap[\s\S]*?\n\}\n/m)
  if (!m) throw new Error('buildSteps not found')
  const readTaughtM = progWizSrc.match(/function readTaught\(answers, key\)\s*\{[\s\S]*?\n\}/)
  const verifyM     = progWizSrc.match(/function verificationStepsForEoat\(cellEoat[\s\S]*?\n\}/)
  const waypointM = progWizSrc.match(/function waypointStepsForJunction\(answers, junctionId, defaultSpeed\)\s*\{[\s\S]*?\n\}/)
  const waypointHelperM = progWizSrc.match(/function readWaypointsForJunction\(answers, junctionId\)\s*\{[\s\S]*?\n\}/)
  const cellVocabM = progWizSrc.match(/function _cellVocabOpts\(cellEoat, synapsePortmap\)\s*\{[\s\S]*?\n\}/)
  const palletM = progWizSrc.match(/function buildPalletizeSteps\(answers, cellEoat = null, synapsePortmap = null\)\s*\{[\s\S]*?\n\}/)
  if (!readTaughtM || !waypointM || !waypointHelperM || !cellVocabM || !palletM || !verifyM) {
    throw new Error('could not extract helper functions')
  }
  // Stub the effector + machine_tend emitters so we only measure the
  // motion / taught-step shape. verificationStepsForEoat is sandboxed
  // with stubbed eoatVerification helpers so a cellEoat === null (the
  // 1/1 equivalence test) resolves to [] regardless.
  const body = [
    `const effectorReady     = ${_slimEffector.toString()}`,
    `const effectorEngage    = ${_slimEffector.toString()}`,
    `const effectorDisengage = ${_slimEffector.toString()}`,
    `const effectorOf        = () => 'finger'`,
    `const clampWorkpiece    = ${_slimClamp.toString()}`,
    `const unclampWorkpiece  = ${_slimUnclamp.toString()}`,
    `const startMachineCycle = ${_slimStart.toString()}`,
    `const waitMachineCycle  = ${_slimWait.toString()}`,
    // Stubs for the eoatVerification helpers verificationStepsForEoat
    // consults. The 1/1 equivalence + 2/2 + unequal-count pins all pass
    // cellEoat === null (buildSteps default), so these fall through to
    // the no-verification path and emit [] — byte-identical for the
    // motion-shape diff this suite measures.
    `function emitsVerificationStep() { return false }`,
    `function resolveConfirmSignals() { return [] }`,
    `function resolveVerification()   { return 'none' }`,
    `const VERIFICATION_PER_PART = 'per_part'`,
    verifyM[0],
    waypointHelperM[0],
    waypointM[0],
    readTaughtM[0],
    cellVocabM[0],
    palletM[0],
    m[0],
    'return buildSteps',
  ].join('\n')
  return new Function(body)()
}

test('1/1 pick/place is byte-identical to the pre-directive output', () => {
  const buildSteps = evalBuildStepsCore()
  const answers = {
    operation: 'pick_and_place',
    speed: 40, approach_height: 100,
    gripper_width: 85, grip_force: 50,
    gripper_type: 'finger',
    // Explicit 1/1.
    pick_count: 1, place_count: 1,
    taught_pick:  { tcp: [0.3, -0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
    taught_place: { tcp: [0.3,  0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
  }
  const legacy = { ...answers }
  delete legacy.pick_count
  delete legacy.place_count
  const outExplicit = buildSteps(answers)
  const outLegacy   = buildSteps(legacy)
  // Byte-equivalence of motion skeleton: every step's action +
  // position_role + derived_from + label must match. (taught_at is
  // time-stamped on the step; stripped before compare.)
  const normalize = (s) => ({
    action: s.action, label: s.label,
    position_role: s.position_role || null,
    derived_from:  s.derived_from  || null,
  })
  assert.deepEqual(
    outExplicit.map(normalize),
    outLegacy.map(normalize),
    v('Explicit {pick_count:1, place_count:1} must produce the SAME '
      + 'step shape (action/label/role/derived_from) as a legacy '
      + 'program without the count fields — the equivalence pin.'))
  // Also confirm the 1/1 output carries the historical position_role
  // "pick" / "place" (NOT "pick_1" / "place_1").
  const roles = outExplicit.map((s) => s.position_role).filter(Boolean)
  assert.ok(roles.includes('pick') && roles.includes('place'),
    v('1/1 output must carry position_role "pick" + "place" (not '
      + '"pick_1" / "place_1") — byte-identical to today.'))
  assert.ok(!roles.some((r) => /_\d+$/.test(r)),
    v('1/1 output must NOT contain any indexed role (pick_1, place_1); '
      + 'indexed roles are reserved for count ≥ 2.'))
})

test('2/2 pick/place emits two paired blocks with indexed roles', () => {
  const buildSteps = evalBuildStepsCore()
  const answers = {
    operation: 'pick_and_place',
    speed: 40, approach_height: 100,
    gripper_width: 85, grip_force: 50,
    gripper_type: 'finger',
    pick_count: 2, place_count: 2,
    taught_pick_1:  { tcp: [0.3, -0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
    taught_pick_2:  { tcp: [0.4, -0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
    taught_place_1: { tcp: [0.3,  0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
    taught_place_2: { tcp: [0.4,  0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
  }
  const out = buildSteps(answers)
  const roles = out.map((s) => s.position_role).filter(Boolean)
  for (const r of ['pick_1', 'place_1', 'pick_2', 'place_2']) {
    assert.ok(roles.includes(r),
      v(`2/2 output must contain position_role "${r}" — the paired loop `
        + `emits one contact step per pair, per side.`))
  }
  assert.ok(!roles.includes('pick') && !roles.includes('place'),
    v('2/2 output must NOT contain the un-indexed "pick" / "place" '
      + 'roles — those are reserved for the 1/1 byte-identical path.'))
  // Taught poses must have flowed into the pick_1 / place_1 / pick_2 / place_2
  // contact steps via applyTaught.
  const pickContacts = out.filter((s) => /^pick_\d+$/.test(s.position_role || ''))
  for (const c of pickContacts) {
    assert.ok(c.taught === true,
      v(`Paired pick_${c.position_role.slice(5)} contact must carry `
        + `taught === true (operator-supplied pose landed via applyToRole).`))
  }
})

test('Unequal counts (3 picks, 1 place) emit K = 1 pair', () => {
  const buildSteps = evalBuildStepsCore()
  const answers = {
    operation: 'pick_and_place',
    speed: 40, approach_height: 100,
    gripper_width: 85, grip_force: 50,
    gripper_type: 'finger',
    pick_count: 3, place_count: 1,
    taught_pick_1:  { tcp: [0.3, -0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
    taught_pick_2:  { tcp: [0.4, -0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
    taught_pick_3:  { tcp: [0.5, -0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
    taught_place_1: { tcp: [0.3,  0.2, 0.4, 0, 0, 0], joints: [0,0,0,0,0,0], taught_at: 't' },
  }
  const out = buildSteps(answers)
  const roles = out.map((s) => s.position_role).filter(Boolean)
  // K = min(3, 1) = 1 pair → only pick_1 + place_1 contacts.
  assert.ok(roles.includes('pick_1') && roles.includes('place_1'),
    v('3-pick/1-place must emit the K=1 pair (pick_1 + place_1).'))
  for (const r of ['pick_2', 'pick_3', 'place_2', 'place_3']) {
    assert.ok(!roles.includes(r),
      v(`Unused taught pose role "${r}" must NOT appear in the step `
        + `list — K = min(nPicks, nPlaces) caps the pairing. Extras `
        + `stay in answers for round-trip but do not fire motion.`))
  }
})
