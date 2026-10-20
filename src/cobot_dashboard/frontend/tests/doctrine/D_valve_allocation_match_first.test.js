// DOCTRINE — Valve allocator matches TYPE first, spare LAST; typed-
// requirement that falls back to a spare WARNS the operator
// (2026-10-16 operator field report).
//
// Pre-fix: operator set up a hold-on-loss vice (double-acting + hold
// → 5/2 DS) and the allocator picked SPARE 1 (V05) instead of the
// panel's declared 5/2 DS slot (V09). This pin suite documents the
// root-cause analysis AND locks the allocation priority.
//
// Root cause: NOT (a) spares-sorted-first — allocateValveForType
// has preferred the direct type-match since 2274c13 (2026-10-05).
// NOT (b) type-match logic skipped on the fixture path — fixturesData.
// allocateFixturePorts threads valveType end-to-end.
// Actually (c-adj): V09 was ALREADY CLAIMED by another tool / fixture
// in the cell, so the allocator correctly fell back to SPARE 1 (the
// only remaining free slot — V09 is the ONE DS slot the panel ships
// with). The GAP was that no warning surfaced to tell the operator
// "this spare must be physically fitted with a 5/2 DS valve" — so
// a vice that NEEDS to hold on power loss could silently end up on
// an SS-wired spare that lets go.
//
// Fix: wasAllocatedAsSpare(slotId, requiredType) helper + amber
// warning rows in both the Fixture SummaryStep's WiringChecklist
// and the EOAT custom-tool summary. Allocator priority itself is
// unchanged (direct-type-match first, spare LAST — pinned here to
// prevent a future regression).
//
// Pins:
//   * allocateValveForType prefers the direct type-matching slot
//     over any spare — pinned via unit tests that confirm a free DS
//     requirement lands on V09, not V05/V10.
//   * The panel registry has exactly ONE 5/2 DS slot (V09), ONE
//     HI/LO 3/2 N/C slot usable for vacuum/blow-off is at V03, and
//     the SPARE slots are V05 + V10 — the ground truth the pin
//     locks against hardware drift.
//   * A typed requirement allocated to a spare triggers
//     wasAllocatedAsSpare → true; a null-requirement allocation
//     that happens to land on a spare does NOT trigger it (operator
//     deliberately picked a spare for a flexible slot).
//   * Fixture WiringChecklist renders a data-testid="fixture-wiring-
//     spare-warning" row when the valve lands on a spare for a
//     typed requirement, naming the required valve type.
//   * EOAT custom-tool summary renders a data-testid="custom-eoat-
//     summary-spare-warning" row with the same semantics.
//   * The warnings are shared through wasAllocatedAsSpare (ONE
//     resolver — no fork between fixture + EOAT UIs).
//
// Failure format: DOCTRINE VALVE_ALLOC VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  VALVE_SLOTS, isSpareSlot, allocateValveForType, typeForSlot,
  slotAcceptsType, wasAllocatedAsSpare, valveTypeForActuation,
} from '../../src/lib/valveMapping.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const fixtureWizSrc = readSrc('components/ExternalFixtureWizard.jsx')
const eoatWizSrc    = readSrc('components/EOATSetupWizard.jsx')
const valveMapSrc   = readSrc('lib/valveMapping.js')

function v(msg) { return `DOCTRINE VALVE_ALLOC VIOLATED: ${msg}` }


// ── (1) Panel registry ground truth ─────────────────────────────────

test('Panel registry has exactly ONE 5/2 DS slot (V09)', () => {
  const dsSlots = VALVE_SLOTS.filter((s) => s.type === '5/2 DS')
  assert.equal(dsSlots.length, 1,
    v(`Panel registry must declare EXACTLY ONE 5/2 DS slot. Found: `
      + `${dsSlots.map((s) => s.id).join(', ') || '(none)'}.`))
  assert.equal(dsSlots[0].id, 'V09',
    v('The sole 5/2 DS slot must be V09 — the hardware ground truth '
      + 'the operator order calls out.'))
})

test('Panel registry has SPARE slots at V05 (SPARE 1) + V10 (SPARE 2)', () => {
  const spares = VALVE_SLOTS.filter((s) => isSpareSlot(s))
  const ids = spares.map((s) => s.id).sort()
  assert.deepEqual(ids, ['V05', 'V10'],
    v(`Panel registry's SPARE slots must be V05 + V10. Found: `
      + `${ids.join(', ') || '(none)'}.`))
})


// ── (2) Allocator: TYPE-matching slot wins over any spare ───────────

test('allocateValveForType("5/2 DS", []) returns V09 (not a spare)', () => {
  const picked = allocateValveForType('5/2 DS', [])
  assert.equal(picked, 'V09',
    v('A free DS requirement with NO claims must land on V09 — the '
      + 'direct type-match. SPARE 1 (V05) was the pre-fix field bug.'))
})

test('allocateValveForType("5/2 SS", []) picks V01 (first free SS slot)', () => {
  const picked = allocateValveForType('5/2 SS', [])
  assert.equal(picked, 'V01',
    v('A free SS requirement must land on the first SS slot (V01), '
      + 'not a spare.'))
})

test('allocateValveForType("HI/LO 3/2 N/C", []) picks V03 (first free match)', () => {
  const picked = allocateValveForType('HI/LO 3/2 N/C', [])
  assert.equal(picked, 'V03',
    v('A free vacuum/blow-off requirement must land on the first '
      + 'HI/LO 3/2 N/C slot (V03), not a spare.'))
})

test('allocateValveForType falls back to SPARE only when every direct-match slot is claimed', () => {
  // Claim V09 (the sole DS slot). A DS requirement MUST fall back —
  // and the fallback must be a spare, not a mis-typed slot.
  const picked = allocateValveForType('5/2 DS', ['V09'])
  const slot = VALVE_SLOTS.find((s) => s.id === picked)
  assert.ok(isSpareSlot(slot),
    v(`When V09 is claimed, a DS requirement must fall back to a `
      + `SPARE slot (V05 then V10). Got: ${picked}, type=${slot && slot.type}.`))
  // Specifically V05 (SPARE 1) since it comes before V10 in the registry.
  assert.equal(picked, 'V05')
})

test('allocateValveForType NEVER lands on a mis-typed non-spare slot', () => {
  // Even when every direct-match slot AND every spare is taken, the
  // allocator must return null — NOT pick a wrong-type slot.
  const claimed = ['V09', 'V05', 'V10']  // DS slot + both spares
  const picked = allocateValveForType('5/2 DS', claimed)
  assert.equal(picked, null,
    v('With V09 + V05 + V10 all claimed, DS allocation must return null '
      + '(not an SS slot like V01). Allocating a DS requirement to an '
      + 'SS slot silently dumps clamped parts on power loss — the pre-'
      + '2274c13 field bug.'))
})


// ── (3) wasAllocatedAsSpare: typed-only, spare-slot-only ───────────

test('wasAllocatedAsSpare returns true for a typed requirement on a spare', () => {
  assert.equal(wasAllocatedAsSpare('V05', '5/2 DS'), true,
    v('V05 is a SPARE and requiredType is 5/2 DS → operator must '
      + 'physically fit a DS valve there.'))
  assert.equal(wasAllocatedAsSpare('V10', '5/2 SS'), true)
})

test('wasAllocatedAsSpare returns false for a direct-match slot', () => {
  assert.equal(wasAllocatedAsSpare('V09', '5/2 DS'), false,
    v('V09 IS a 5/2 DS slot — no warning needed; the panel already '
      + 'carries the right valve class there.'))
})

test('wasAllocatedAsSpare returns false when requiredType is null', () => {
  // A spare that lands a null-requirement allocation is NOT a risk —
  // the operator picked the spare on purpose for a flexible slot.
  assert.equal(wasAllocatedAsSpare('V05', null), false,
    v('Null requiredType → no warning (operator chose spare deliberately).'))
  assert.equal(wasAllocatedAsSpare('V05', undefined), false)
})

test('wasAllocatedAsSpare returns false for an unknown slot id', () => {
  assert.equal(wasAllocatedAsSpare('V99', '5/2 DS'), false,
    v('Unknown slot id → safe false (never warn on garbage input).'))
})


// ── (4) Hold-on-loss vice → DS → V09 end-to-end ─────────────────────

test('Hold-on-loss vice compiles to valve_type="5/2 DS" + lands on V09 (free)', () => {
  // Simulate what the fixture wizard writes when the operator picks
  // Vice + keeps the hold-on-loss default.
  const viceType = valveTypeForActuation({
    actuation: 'double', holdOnLoss: true,
  })
  assert.equal(viceType, '5/2 DS',
    v('A double-acting hold-on-loss vice must resolve to the 5/2 DS '
      + 'valve TYPE — the shared actuation→type resolver.'))
  // Allocator with nothing claimed must land on V09.
  assert.equal(allocateValveForType(viceType, []), 'V09',
    v('Hold-on-loss vice with free panel must land on V09, not a spare.'))
})


// ── (5) Fixture WiringChecklist surfaces the spare warning ─────────

test('ExternalFixtureWizard imports wasAllocatedAsSpare', () => {
  assert.ok(
    /import\s*\{\s*wasAllocatedAsSpare\s*\}\s*from\s*['"]\.\.\/lib\/valveMapping['"]/
      .test(fixtureWizSrc),
    v('ExternalFixtureWizard must import wasAllocatedAsSpare from '
      + 'lib/valveMapping — the single resolver both wizards consult.'))
})

test('WiringChecklist renders a spare-warning row when valve lands on a spare for a typed requirement', () => {
  const idx = fixtureWizSrc.indexOf('function WiringChecklist(')
  const stop = fixtureWizSrc.indexOf('\nfunction ', idx + 1)
  const chunk = fixtureWizSrc.slice(idx, stop > idx ? stop : idx + 4000)
  // The valve row's spareWarning field is computed from
  // wasAllocatedAsSpare(record.valve, record.valve_type); when truthy
  // the UI renders a data-testid="fixture-wiring-spare-warning" row.
  assert.ok(
    /spareWarning:\s*wasAllocatedAsSpare\(record\.valve,\s*record\.valve_type\)/
      .test(chunk),
    v('WiringChecklist valve row must derive spareWarning from '
      + 'wasAllocatedAsSpare(record.valve, record.valve_type) — the '
      + 'shared helper.'))
  assert.ok(/data-testid="fixture-wiring-spare-warning"/.test(chunk),
    v('WiringChecklist must render data-testid="fixture-wiring-spare-'
      + 'warning" when the valve row carries a non-null spareWarning.'))
  assert.ok(/data-required-valve-type=\{row\.spareWarning\}/.test(chunk),
    v('The warning row must stamp data-required-valve-type with the '
      + 'required valve class so operator-facing tests can filter.'))
  // Copy pin: must say "SPARE" + name the required valve type + name
  // the fixture.
  assert.ok(/This is a SPARE slot — fit a \{row\.spareWarning\} valve/.test(chunk),
    v('Warning copy must read "This is a SPARE slot — fit a '
      + '{row.spareWarning} valve …" — the operator-authored imperative.'))
})


// ── (6) EOAT custom summary surfaces the spare warning ─────────────

test('EOATSetupWizard imports wasAllocatedAsSpare (same resolver)', () => {
  assert.ok(
    /import\s*\{\s*wasAllocatedAsSpare\s*\}\s*from\s*['"]\.\.\/lib\/valveMapping['"]/
      .test(eoatWizSrc),
    v('EOATSetupWizard must import wasAllocatedAsSpare from '
      + 'lib/valveMapping — single source, no fork between the '
      + 'fixture wizard and the EOAT wizard.'))
})

test('EOAT custom-tool summary renders a spare-warning row per actuator', () => {
  // The per-actuator loop in custom-step-summary must compute spareReq
  // via wasAllocatedAsSpare + render the amber warning.
  assert.ok(
    /wasAllocatedAsSpare\(a\.valve,\s*a\.recommended_valve_type\)/
      .test(eoatWizSrc),
    v('EOAT custom summary must call wasAllocatedAsSpare(a.valve, '
      + 'a.recommended_valve_type) per actuator — the warning gate.'))
  assert.ok(
    /data-testid="custom-eoat-summary-spare-warning"/.test(eoatWizSrc),
    v('EOAT custom summary must render data-testid="custom-eoat-'
      + 'summary-spare-warning" when an actuator\'s valve lands on a '
      + 'spare for a typed requirement.'))
})


// ── (7) Allocator shape is unchanged (regression lock) ─────────────

test('allocateValveForType body still searches direct-match BEFORE spare', () => {
  // Grep the function body to lock the ordering. If someone swaps the
  // two find() calls, this pin fires BEFORE the field bug ships.
  const idx = valveMapSrc.indexOf('export function allocateValveForType(')
  const stop = valveMapSrc.indexOf('\nexport function ', idx + 1)
  const body = valveMapSrc.slice(idx, stop > idx ? stop : idx + 1500)
  const directIdx = body.search(/s\.type\s*===\s*requiredType/)
  const spareIdx  = body.search(/isSpareSlot\(s\)/)
  assert.ok(directIdx > 0 && spareIdx > directIdx,
    v('allocateValveForType must search the direct type-match '
      + '(s.type === requiredType) BEFORE the spare search '
      + '(isSpareSlot(s)) — if the ordering flips, a DS requirement '
      + 'could land on a spare while V09 is still free. The field bug.'))
})
