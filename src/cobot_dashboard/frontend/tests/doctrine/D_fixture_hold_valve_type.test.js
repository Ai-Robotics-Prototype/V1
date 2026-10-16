// DOCTRINE — Hold-on-loss ↔ valve TYPE ↔ allocated port
// (2026-10-05 operator directive).
//
// Field bug: created an air-operated VICE fixture, answered "stay
// clamped on power/E-stop loss" — but the wizard's pneumatic
// valve-port assignment did NOT reflect a holding valve. The
// hold-on-loss answer was decoupled from the valve-type selection,
// and the allocator was type-blind (handed out the next free SPARE
// slot regardless of whether that slot's declared valve class
// matched the required valve TYPE).
//
// Engineering truth encoded (SAME rule for EOAT + fixtures — the
// two wizards must share ONE resolver so neither can drift):
//     double_acting + hold=true     → 5/2 DS   (holds last state)
//     double_acting + hold=false    → 5/2 SS   (spring returns)
//     double_acting + null (default) → 5/2 DS  (safe default)
//     single_acting                 → 5/2 SS
//     vacuum / blow_off             → HI/LO 3/2 N/C
//
// Allocation rule:
//     * Prefer a free slot whose declared type EQUALS the required
//       type (e.g. V09 for 5/2 DS — the only DS slot on the panel).
//     * Fall back to a free SPARE slot (operator wires a matching
//       valve class there).
//     * NEVER land a DS requirement on an SS-only slot (or vice
//       versa). Record + glow + displayed valve must agree.
//
// Pins:
//   1. Shared valveTypeForActuation covers both actuation
//      vocabularies (short + _acting) and holds the DS/SS mapping.
//   2. Both wizards' recommendValveType import from valveMapping
//      (import-identity grep).
//   3. Type-aware allocateValveForType prefers direct-type match,
//      falls back to SPARE, refuses when neither is free, and
//      never returns an incompatible non-SPARE slot.
//   4. VICE default (FIXTURE_TYPES.vice.defaults.hold_on_loss=true)
//      compiles to a record whose valve_type is 5/2 DS AND whose
//      allocated valve is V09 (the panel's 5/2 DS slot).
//   5. Record ↔ port agreement: slotAcceptsType is true for every
//      compiled fixture record's (valve, valve_type) pair.
//
// Failure format:
//   DOCTRINE FIXTURE_HOLD_VALVE VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE FIXTURE_HOLD_VALVE VIOLATED: ${msg}` }

const mappingSrc   = readSrc('lib/valveMapping.js')
const fixturesSrc  = readSrc('lib/fixturesData.js')
const toolPortSrc  = readSrc('lib/toolPortMap.js')
const fixWizSrc    = readSrc('components/ExternalFixtureWizard.jsx')
const eoatWizSrc   = readSrc('components/EOATSetupWizard.jsx')


// ── (1) Shared resolver covers both actuation vocabularies ──────────

test('valveTypeForActuation: hold-on-loss → DS, release → SS', async () => {
  const { valveTypeForActuation } = await import(
    '../../src/lib/valveMapping.js')
  // Fixture wizard's short-form vocabulary.
  assert.equal(valveTypeForActuation(
    { actuation: 'double', holdOnLoss: true }), '5/2 DS',
    v('fixture short-form: double + hold → 5/2 DS'))
  assert.equal(valveTypeForActuation(
    { actuation: 'double', holdOnLoss: false }), '5/2 SS',
    v('fixture short-form: double + !hold → 5/2 SS'))
  assert.equal(valveTypeForActuation(
    { actuation: 'single', holdOnLoss: null }), '5/2 SS',
    v('fixture short-form: single → 5/2 SS'))
  // EOAT wizard's long-form vocabulary.
  assert.equal(valveTypeForActuation(
    { actuation: 'double_acting', holdOnLoss: true }), '5/2 DS',
    v('EOAT long-form: double_acting + hold → 5/2 DS'))
  assert.equal(valveTypeForActuation(
    { actuation: 'double_acting', holdOnLoss: false }), '5/2 SS',
    v('EOAT long-form: double_acting + !hold → 5/2 SS'))
  assert.equal(valveTypeForActuation(
    { actuation: 'single_acting' }), '5/2 SS',
    v('EOAT long-form: single_acting → 5/2 SS'))
  // Shared actuator classes.
  assert.equal(valveTypeForActuation(
    { actuation: 'vacuum' }), 'HI/LO 3/2 N/C',
    v('vacuum → HI/LO 3/2 N/C'))
  assert.equal(valveTypeForActuation(
    { actuation: 'blow_off' }), 'HI/LO 3/2 N/C',
    v('blow_off → HI/LO 3/2 N/C'))
  // No actuation → null (unknown, caller must handle).
  assert.equal(valveTypeForActuation(
    { actuation: 'bogus' }), null,
    v('unknown actuation → null (never silently invent a type)'))
})


// ── (2) Import-identity: both wizards use valveMapping ──────────────

test('fixturesData.recommendValveType routes through valveMapping', () => {
  assert.ok(
    /import\s*\{[^}]*valveTypeForActuation[^}]*\}\s*from\s*['"]\.\/valveMapping(?:\.js)?['"]/
      .test(fixturesSrc),
    v('lib/fixturesData.js must import valveTypeForActuation from '
      + "'./valveMapping' — single-source for the DS/SS rule."))
  // recommendValveType must call the shared resolver (not re-derive
  // the mapping with its own if-chain).
  assert.ok(
    /function\s+recommendValveType\([\s\S]{0,200}?valveTypeForActuation\(/
      .test(fixturesSrc),
    v('fixturesData.recommendValveType must call valveTypeForActuation '
      + '— removing the local if-chain is the safety guarantee.'))
})

test('toolPortMap.recommendValveType routes through valveMapping', () => {
  assert.ok(
    /import\s*\{[^}]*valveTypeForActuation[^}]*\}\s*from\s*['"]\.\/valveMapping(?:\.js)?['"]/
      .test(toolPortSrc),
    v('lib/toolPortMap.js must import valveTypeForActuation from '
      + "'./valveMapping' — EOAT wizard shares the DS/SS rule."))
  assert.ok(
    /function\s+recommendValveType\([\s\S]{0,1200}?valveTypeForActuation\(/
      .test(toolPortSrc),
    v('toolPortMap.recommendValveType must call valveTypeForActuation '
      + '— the EOAT wizard cannot drift from the fixture wizard on '
      + 'the hold-on-loss → DS/SS mapping.'))
})


// ── (3) Type-aware allocation ──────────────────────────────────────

test('allocateValveForType prefers direct-type slot, falls back to SPARE', async () => {
  const { allocateValveForType, VALVE_SLOTS, slotAcceptsType }
    = await import('../../src/lib/valveMapping.js')
  // Empty claim set — DS requirement must pick V09 (the only
  // declared 5/2 DS slot).
  assert.equal(allocateValveForType('5/2 DS', new Set()), 'V09',
    v('With no claims, a 5/2 DS requirement must land on V09 — '
      + 'the panel\'s declared DS slot.'))
  // SS requirement — V01 is the first SS slot.
  assert.equal(allocateValveForType('5/2 SS', new Set()), 'V01',
    v('With no claims, a 5/2 SS requirement must land on V01 — '
      + 'the first declared SS slot.'))
  // 3/2 N/C requirement — V03 is first.
  assert.equal(allocateValveForType('HI/LO 3/2 N/C', new Set()),
    'V03', v('HI/LO 3/2 N/C must land on V03 first.'))
  // When direct-type slot is claimed, fall back to a SPARE.
  const claimedDS = new Set(['V09'])
  const fallback = allocateValveForType('5/2 DS', claimedDS)
  assert.ok(fallback === 'V05' || fallback === 'V10',
    v(`DS fallback must be a SPARE slot — got ${fallback}.`))
  // When ALL direct + spare slots are claimed, return null.
  const allClaimed = new Set(VALVE_SLOTS.map((s) => s.id))
  assert.equal(allocateValveForType('5/2 DS', allClaimed), null,
    v('With no free slot, allocateValveForType must return null '
      + '— the caller surfaces the "no slots left" refusal.'))
  // CRITICAL safety invariant: the returned slot must accept the
  // required type (direct or SPARE). Never an SS slot for a DS req.
  for (const requiredType of ['5/2 DS', '5/2 SS', 'HI/LO 3/2 N/C']) {
    const slot = allocateValveForType(requiredType, new Set())
    assert.ok(slotAcceptsType(slot, requiredType),
      v(`allocateValveForType('${requiredType}') returned ${slot} `
        + 'but that slot does not accept the required type. A DS '
        + 'requirement landing on an SS slot is the field-reported '
        + 'bug — this invariant MUST hold.'))
  }
})


// ── (4) VICE default: stay-clamped → DS → V09 ──────────────────────

test('vice default compiles stay-clamped → 5/2 DS → V09', async () => {
  const { FIXTURE_TYPES, compileFixtureRecord }
    = await import('../../src/lib/fixturesData.js')
  // Precondition: vice carries the stay-clamped default.
  assert.equal(FIXTURE_TYPES.vice.defaults.hold_on_loss, true,
    v('FIXTURE_TYPES.vice.defaults.hold_on_loss must be true — the '
      + 'operator never has to opt-in to "part stays clamped on loss".'))
  assert.equal(FIXTURE_TYPES.vice.defaults.air_actuation, 'double',
    v('FIXTURE_TYPES.vice.defaults.air_actuation must be "double" — '
      + 'a vice is a double-acting cylinder.'))
  // End-to-end: compile with ONLY the type picked (operator leaves
  // the stay-clamped default alone). Expect record.valve_type='5/2 DS'
  // AND record.valve='V09'.
  const rec = compileFixtureRecord({ type: 'vice' },
    { tools: [], fixtures: [] })
  assert.equal(rec.valve_type, '5/2 DS',
    v(`vice stay-clamped must compile to valve_type='5/2 DS' — got `
      + `'${rec.valve_type}'. This is the field bug: operator chose `
      + 'stay-clamped, record carried the wrong valve class.'))
  assert.equal(rec.valve, 'V09',
    v(`vice stay-clamped must allocate V09 (panel's declared 5/2 DS `
      + `slot) — got '${rec.valve}'. Allocation was type-blind pre-fix.`))
  assert.equal(rec.hold_on_loss, true,
    v('vice compiled record must carry hold_on_loss=true.'))
})

test('vice let-go compiles release-on-loss → 5/2 SS → V01', async () => {
  const { compileFixtureRecord } = await import(
    '../../src/lib/fixturesData.js')
  const rec = compileFixtureRecord(
    { type: 'vice', hold_on_loss: false },
    { tools: [], fixtures: [] })
  assert.equal(rec.valve_type, '5/2 SS',
    v('vice release-on-loss must compile to valve_type=5/2 SS.'))
  assert.equal(rec.valve, 'V01',
    v('vice release-on-loss must allocate V01 (first declared SS '
      + 'slot).'))
  assert.equal(rec.hold_on_loss, false)
})


// ── (5) Record ↔ port agreement under contention ────────────────────

test('allocation under contention never violates record ↔ port agreement', async () => {
  const { compileFixtureRecord } = await import(
    '../../src/lib/fixturesData.js')
  const { slotAcceptsType } = await import(
    '../../src/lib/valveMapping.js')
  // Simulate: another fixture already claimed V09. A new vice
  // stay-clamped must fall back to a SPARE, not land on V01 (SS).
  const existingDsFixture = {
    id: 'other-vice', type: 'vice',
    valve: 'V09', valve_type: '5/2 DS', hold_on_loss: true,
  }
  const rec = compileFixtureRecord({ type: 'vice' },
    { tools: [], fixtures: [existingDsFixture] })
  assert.equal(rec.valve_type, '5/2 DS',
    v('contended vice stay-clamped still compiles to 5/2 DS.'))
  assert.notEqual(rec.valve, 'V09',
    v('contended vice must NOT re-claim V09 (already held by '
      + 'existingDsFixture).'))
  assert.ok(slotAcceptsType(rec.valve, rec.valve_type),
    v(`contended vice assigned ${rec.valve} but that slot does not `
      + `accept ${rec.valve_type} — the record ↔ port invariant is `
      + 'the safety the sweep is pinning. V01/V02 (SS) are NOT '
      + 'acceptable fallbacks for a DS requirement.'))
})


// ── (6) FixturesData allocateFixturePorts threads valveType ─────────

test('allocateFixturePorts accepts valveType and threads it to allocator', () => {
  // The function signature must now accept valveType, and
  // compileFixtureRecord must pass it in.
  assert.ok(/function\s+allocateFixturePorts\(\{[\s\S]*?valveType\s*=/
              .test(fixturesSrc),
    v('allocateFixturePorts({ ..., valveType }) must be the current '
      + 'signature — type-aware allocation is the correctness fix.'))
  assert.ok(/allocateValveForType\(valveType,\s*cValve\)/
              .test(fixturesSrc),
    v('allocateFixturePorts must call allocateValveForType('
      + 'valveType, cValve) — the shared type-aware allocator.'))
  assert.ok(/valveType:\s*rec\s*\?\s*rec\.type\s*:\s*null/
              .test(fixturesSrc),
    v('compileFixtureRecord must pass valveType: rec?.type into '
      + 'allocateFixturePorts so the recommended type reaches '
      + 'allocation.'))
})
