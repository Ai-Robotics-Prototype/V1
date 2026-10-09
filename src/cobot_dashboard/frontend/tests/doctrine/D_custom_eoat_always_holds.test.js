// DOCTRINE — Custom EOAT finger + suction ALWAYS hold on loss
// (2026-10-05 operator order).
//
// Order: on the Custom tool "Confirm each choice" step, neither the
// finger-gripper nor the suction hold-on-loss question should be an
// option. Both default to always-held. Record a physically-truthful
// result without asking:
//
//   * Finger gripper (double_acting) → holds_on_loss=true →
//     resolveCustomEOATRecord recommends 5/2 DS → type-aware
//     allocator (2274c13) lands the valve on V09 (panel's DS slot).
//   * Suction (vacuum) → holds_on_loss=true + holds_via='check_valve'
//     (NeuRobots standard) → valve recommendation stays HI/LO 3/2 N/C
//     (actuator CLASS is unchanged; the hold path is the inline
//     check valve, not the solenoid class).
//
// Pins:
//   1. HoldQuestion + SuctionHoldQuestion components deleted; the
//      confirm step surfaces an AlwaysHoldsNote read-only line.
//   2. Capability catalog preselects stay as the ONLY source for the
//      actuator defaults — operator no longer toggles them.
//   3. resolveCustomEOATRecord(grips_fingers) → recommended_valve_type
//      '5/2 DS' AND the allocated valve is V09 (type-aware allocator
//      prefers the direct-type slot).
//   4. resolveCustomEOATRecord(holds_suction) → holds_via='check_valve'
//      AND the actuator carries hold_on_loss=true AND recommended
//      valve type is HI/LO 3/2 N/C.
//   5. Allocation under contention: when V09 is already claimed by
//      a prior finger tool, a new finger tool falls back to a SPARE
//      slot (never to an SS slot — the DS-safety invariant from
//      D_fixture_hold_valve_type stays green).
//
// Failure format:
//   DOCTRINE CUSTOM_EOAT_ALWAYS_HOLDS VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE CUSTOM_EOAT_ALWAYS_HOLDS VIOLATED: ${msg}` }

const eoatWizSrc = readSrc('components/EOATSetupWizard.jsx')


// ── (1) UI: components deleted + AlwaysHoldsNote rendered ──────────

test('HoldQuestion + SuctionHoldQuestion components retired', () => {
  // Strip comments so a breadcrumb comment that mentions the retired
  // names doesn't trip the pin.
  const stripped = eoatWizSrc.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('//')) return false
    if (t.startsWith('*')) return false
    return true
  }).join('\n')
  assert.equal(/function\s+HoldQuestion\s*\(/.test(stripped), false,
    v('HoldQuestion function must be removed — the finger hold '
      + 'question is retired.'))
  assert.equal(/function\s+SuctionHoldQuestion\s*\(/.test(stripped),
    false,
    v('SuctionHoldQuestion function must be removed — the suction '
      + 'hold question is retired.'))
  // The replacement component exists and is rendered on both branches.
  assert.ok(/function\s+AlwaysHoldsNote\s*\(/.test(stripped),
    v('AlwaysHoldsNote component must exist as the read-only '
      + 'replacement for the retired hold questions.'))
  assert.ok(/<AlwaysHoldsNote\s+tool="finger"\s*\/>/.test(stripped),
    v('ActuatorCard must render <AlwaysHoldsNote tool="finger" /> '
      + 'on the grips_fingers branch.'))
  assert.ok(/<AlwaysHoldsNote\s+tool="suction"\s*\/>/.test(stripped),
    v('ActuatorCard must render <AlwaysHoldsNote tool="suction" /> '
      + 'on the holds_suction branch.'))
})


// ── (2) Capability catalog preselects are the record truth ─────────

test('eoatCapabilities preselects carry the always-hold defaults', () => {
  const src = readSrc('lib/eoatCapabilities.js')
  assert.ok(
    /key:\s*'grips_fingers'[\s\S]{0,400}preselect:\s*\{\s*holdOnLoss:\s*true\s*\}/
      .test(src),
    v('grips_fingers capability must preselect holdOnLoss:true — the '
      + "only source for the record now that the UI toggle is gone."))
  assert.ok(
    /key:\s*'holds_suction'[\s\S]{0,400}preselect:\s*\{\s*hasCheckValve:\s*true\s*\}/
      .test(src),
    v('holds_suction capability must preselect hasCheckValve:true — '
      + 'the NeuRobots standard, which is now the ONLY source.'))
})


// ── (3) Finger end-to-end — via shared resolver + type-aware alloc ─
//
// toolPortMap.resolveCustomEOATRecord cannot be dynamic-imported
// under `node --test` (it pulls VALVE_TYPE_INFO from pages/
// SynapsePage.jsx, which requires a JSX loader). Pin the behavior
// via (a) the shared valveMapping helpers (pure .js) that
// resolveCustomEOATRecord routes through AND (b) source grep that
// resolveCustomEOATRecord DOES route through them.

test('finger always-hold → 5/2 DS via shared resolver + V09 via allocator', async () => {
  const { actuatorsFromCapabilities } = await import(
    '../../src/lib/eoatCapabilities.js')
  const { valveTypeForActuation, allocateValveForType }
    = await import('../../src/lib/valveMapping.js')
  // One capability → one actuator carrying holdOnLoss=true from the
  // catalog preselect (which is now the ONLY source).
  const acts = actuatorsFromCapabilities(new Set(['grips_fingers']))
  assert.equal(acts.length, 1)
  assert.equal(acts[0].type, 'double_acting',
    v('grips_fingers → actuator type double_acting.'))
  assert.equal(acts[0].holdOnLoss, true,
    v('Finger always-hold default must flow from the capability '
      + 'preselect — holdOnLoss=true.'))
  // Shared resolver must agree.
  const type = valveTypeForActuation({
    actuation: acts[0].type, holdOnLoss: acts[0].holdOnLoss,
  })
  assert.equal(type, '5/2 DS',
    v(`double_acting + hold=true must resolve to 5/2 DS — got `
      + `'${type}'.`))
  // Type-aware allocator picks V09 for 5/2 DS when nothing's claimed.
  assert.equal(allocateValveForType('5/2 DS', new Set()), 'V09',
    v('Allocator must land the DS requirement on V09 — the panel\'s '
      + 'declared 5/2 DS slot.'))
})

test('resolveCustomEOATRecord routes through the shared helpers', () => {
  const src = readSrc('lib/toolPortMap.js')
  assert.ok(
    /import\s*\{[^}]*valveTypeForActuation[^}]*\}\s*from\s*['"]\.\/valveMapping(?:\.js)?['"]/
      .test(src),
    v('toolPortMap.js must import valveTypeForActuation from '
      + "'./valveMapping' — the EOAT wizard shares the DS/SS rule."))
  assert.ok(
    /import\s*\{[^}]*allocateValveForType[^}]*\}\s*from\s*['"]\.\/valveMapping(?:\.js)?['"]/
      .test(src),
    v('toolPortMap.js must import allocateValveForType — custom '
      + 'EOAT allocation must be type-aware.'))
  // resolveCustomEOATRecord's per-actuator loop calls the type-aware
  // allocator with a runningClaimed set so two actuators in the same
  // tool can't collide.
  assert.ok(/allocateValveForType\(rec\.type,\s*runningClaimed\)/.test(src),
    v('resolveCustomEOATRecord must call allocateValveForType('
      + 'rec.type, runningClaimed) per actuator — the type-aware '
      + 'allocator entry point.'))
})


// ── (4) Suction: holds_via='check_valve' + HI/LO 3/2 N/C ───────────

test('suction always-hold → check_valve metadata + HI/LO 3/2 N/C', async () => {
  const { actuatorsFromCapabilities } = await import(
    '../../src/lib/eoatCapabilities.js')
  const { valveTypeForActuation } = await import(
    '../../src/lib/valveMapping.js')
  const acts = actuatorsFromCapabilities(new Set(['holds_suction']))
  assert.equal(acts.length, 1)
  assert.equal(acts[0].type, 'vacuum',
    v('holds_suction → actuator type vacuum.'))
  assert.equal(acts[0].hasCheckValve, true,
    v('Suction always-hold default must flow from the capability '
      + 'preselect — hasCheckValve=true.'))
  // Shared resolver: vacuum → HI/LO 3/2 N/C regardless of hold.
  assert.equal(valveTypeForActuation({ actuation: 'vacuum' }),
    'HI/LO 3/2 N/C',
    v('vacuum actuator must recommend HI/LO 3/2 N/C — the valve '
      + 'class is unchanged; the hold path is the inline check '
      + 'valve, not the solenoid class.'))
  // vacuumHoldMetadata (toolPortMap) must map hasCheckValve=true →
  // holds_on_loss=true + holds_via='check_valve'. Pin via source
  // grep since the function pulls VALVE_TYPE_INFO through a JSX
  // import (node --test can't dynamic-import it).
  const toolSrc = readSrc('lib/toolPortMap.js')
  assert.ok(
    /vacuumHoldMetadata[\s\S]{0,300}holds_via:\s*['"]check_valve['"]/
      .test(toolSrc),
    v("vacuumHoldMetadata must map a check-valve-equipped suction "
      + "head to holds_via='check_valve' — physically-truthful "
      + "record for the NeuRobots standard."))
})


// ── (5) Contention: safety invariant via shared allocator ─────────

test('type-aware allocation: DS requirement never lands on an SS slot', async () => {
  const { allocateValveForType, slotAcceptsType, VALVE_SLOTS }
    = await import('../../src/lib/valveMapping.js')
  // With V09 claimed by a prior finger tool, a new finger must fall
  // back to a SPARE slot — never to an SS slot.
  const claimedDS = new Set(['V09'])
  const slot = allocateValveForType('5/2 DS', claimedDS)
  assert.ok(slot === 'V05' || slot === 'V10',
    v(`Contended DS requirement must land on SPARE (V05/V10) — got `
      + `'${slot}'. V01/V02 (SS) are NOT acceptable fallbacks for a `
      + 'DS requirement.'))
  assert.ok(slotAcceptsType(slot, '5/2 DS'),
    v(`Fallback slot '${slot}' must accept the required DS type.`))
  // Every slot the allocator CAN return for a DS requirement must
  // accept DS (direct match or SPARE). Enumerate the invariant.
  for (const s of VALVE_SLOTS) {
    const claimed = new Set(VALVE_SLOTS.map((x) => x.id)
      .filter((x) => x !== s.id))
    const only = allocateValveForType('5/2 DS', claimed)
    if (only == null) continue   // all claimed except an incompatible slot
    assert.ok(slotAcceptsType(only, '5/2 DS'),
      v(`With only slot '${s.id}' free, allocator returned `
        + `'${only}' which does not accept DS. Safety invariant `
        + 'must hold for every single-slot scenario.'))
  }
})
