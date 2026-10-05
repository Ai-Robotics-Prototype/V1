// DOCTRINE — EOAT CAPABILITIES drive program steps (2026-10-05
// operator order).
//
// Principle: tool capabilities → program steps. The EOAT record
// (actuators[] from EOAT Setup) is the source of truth; the program
// wizard asks about the PROCESS, the tool contributes its ACTIONS
// at the correct sequence anchors. First concrete application:
// blow-off.
//
// Before this diff, the wizard carried `answers.blow_off_enabled`
// as a defaulted bool (never actually asked, but plumbed through
// effectorVocab's `withBlowOff` opt — default true). The directive
// deletes the question outright and routes blow-off emission via
// the picked EOAT's actuators[]:
//
//     cellEoat.actuators.some(a => a.type === 'blow_off' && a.valve)
//
// Only tools built with the "blows air" capability (via
// actuatorsFromCapabilities) carry such an actuator. Standard
// finger + standard vacuum carry none → no blow-off step.
//
// ANCHOR MAP for the pick-and-place / palletize template:
//
//     home
//     ready            (effectorReady)
//     pick-approach    (move_linear, derived_from='pick', +appH)
//     pick-contact     [TAUGHT] (move_linear, position_role='pick')
//     engage           (effectorEngage) — grip / vacuum ON
//     retreat-pick     (move_linear, derived_from='pick', +appH)
//     place-approach   (move_linear, derived_from='place', +appH)
//     place-contact    [TAUGHT] (move_linear, position_role='place')
//     release + clear  (effectorDisengage) — vacuum OFF + optional
//                       blow-off triplet (ON → short WAIT → OFF)
//     retreat-place    (move_linear, derived_from='place', +appH)
//     home
//
// INSERTION RULE: blow-off is emitted INSIDE effectorDisengage as
// the second half of the (release, clear) tuple. The wizard places
// that whole tuple between `place-contact` and `retreat-place`.
// Because the tuple is atomic, no fixed index can be hardcoded —
// the anchor is "immediately after release, immediately before
// retreat-place", enforced structurally by effectorDisengage's own
// emission order (vacuum OFF → blow-off ON → wait → blow-off OFF)
// AND by the wizard's unchanging call-site location.
//
// RATIONALE: blow-off clears the part off the cup after vacuum
// release, before the arm lifts. It MUST NOT fire before release
// (would eject the part prematurely during the pick), during
// transit (would pulse air mid-air), or at pick (would blow the
// part away before capture).
//
// Pins:
//   1. ProgramWizard source carries no `blow_off_enabled` field
//      and no page/branch that only served it (grep).
//   2. _cellVocabOpts returns withBlowOff:true + a blowOffValve
//      ONLY when the cell EOAT has a {type:'blow_off', valve:...}
//      actuator; returns withBlowOff:false otherwise (incl. no
//      cell binding).
//   3. Determinism: generating the same wizard output twice yields
//      byte-identical step records (pure function + stable inputs).
//   4. Blow-off absent when the picked tool has no blow_off
//      actuator (finger + standard vacuum).
//   5. Blow-off present when the picked tool HAS a blow_off
//      actuator; anchor-verified position (strictly between the
//      vacuum-off release step and the next retreat-place move).
//   6. Blow-off emission ORDER inside the triplet: set_io(blow,1)
//      → wait → set_io(blow,0). Enforced by effectorVocab.
//
// Failure format:
//   DOCTRINE CAPABILITY_DRIVEN_BLOW_OFF VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE CAPABILITY_DRIVEN_BLOW_OFF VIOLATED: ${msg}` }

const wizSrc = readSrc('components/ProgramWizard.jsx')
const seed = {
  version: 1,
  rows: Array.from({ length: 10 }, (_, i) => ({
    synapse: `V${String(i + 1).padStart(2, '0')}`,
    kind: 'valve', raw: `DO${i + 1}`, verified: false,
  })),
}


// ── (1) No blow-off question in the wizard ─────────────────────────

test('ProgramWizard carries no blow_off_enabled field + no setter', () => {
  // Strip comments so breadcrumb mentions don't trip the pin.
  const stripped = wizSrc.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('//')) return false
    if (t.startsWith('*')) return false
    return true
  }).join('\n')
  assert.equal(/blow_off_enabled/.test(stripped), false,
    v('ProgramWizard.jsx must not reference answers.blow_off_enabled '
      + '— the question is retired; blow-off flows from the cell '
      + "EOAT's actuators[]."))
  // Every `withBlowOff:` KEY in the wizard must either (a) live in
  // _cellVocabOpts (capability-driven return) or (b) be the explicit
  // machine_tend `withBlowOff: false` override (release-into-fixture
  // always suppresses blow-off regardless of tool capability). A
  // 'withBlowOff: answers.…' site would be a regression.
  assert.equal(/withBlowOff:\s*answers\./.test(stripped), false,
    v('No withBlowOff may read from answers.* — that would be the '
      + 'retired question-driven path.'))
})


// ── (2) _cellVocabOpts: capability-driven withBlowOff ──────────────

test('_cellVocabOpts: blow-off actuator → withBlowOff:true + blowOffValve', () => {
  // Grep: the helper must read actuators[], find a type:'blow_off'
  // entry, and forward its valve. Also must default withBlowOff
  // to false when no cell is bound.
  assert.ok(
    /\.actuators\s*\|\|\s*\[\]\)\s*\.find\(\(a\)\s*=>\s*a\s*&&[\s\S]{0,200}?'blow_off'/
      .test(wizSrc),
    v('_cellVocabOpts must find({type:"blow_off"}) over '
      + 'cellEoat.actuators[] — capability is the sole driver.'))
  assert.ok(/opts\.withBlowOff\s*=\s*true/.test(wizSrc),
    v('_cellVocabOpts must set opts.withBlowOff=true when a '
      + 'blow_off actuator is present.'))
  assert.ok(/opts\.withBlowOff\s*=\s*false/.test(wizSrc),
    v('_cellVocabOpts must set opts.withBlowOff=false when no '
      + 'blow_off actuator is present — explicit, not relying on '
      + "effectorDisengage's historical default."))
  assert.ok(/opts\.blowOffValve\s*=\s*blowActuator\.valve/.test(wizSrc),
    v('_cellVocabOpts must forward blowActuator.valve as '
      + 'opts.blowOffValve so the emitter resolves the right raw '
      + 'channel for the blow-off step.'))
  // Cell-less wizard run must also carry withBlowOff:false
  // explicitly so the historical default can't ship.
  assert.ok(
    /if\s*\(!cellEoat\)\s*return\s*\{\s*withBlowOff:\s*false\s*\}/
      .test(wizSrc),
    v('_cellVocabOpts must return { withBlowOff:false } when no '
      + 'cell is bound — capability is the only path to blow-off.'))
})


// ── (3) Determinism + absence + presence end-to-end ────────────────

test('capability-driven anchor: finger EOAT → NO blow-off; vacuum+blow-off EOAT → blow-off at anchor', async () => {
  const { effectorReady, effectorEngage, effectorDisengage,
          VOCAB_TOKENS } = await import('../../src/lib/effectorVocab.js')
  const { _primeCacheForTests }
    = await import('../../src/lib/synapsePortmap.js')
  _primeCacheForTests(seed)

  // Build the pick-place sequence inline using the same vocab calls
  // + anchor placement the wizard uses. Pure function → deterministic.
  const buildPickPlace = (cellEoat) => {
    const cfg = { effector: 'vacuum' }
    // Replicates _cellVocabOpts shape.
    const opts = (() => {
      if (!cellEoat) return { withBlowOff: false, portmap: seed }
      const o = { portmap: seed, cellBinding: { eoat_id: cellEoat.id } }
      if (cellEoat.valve) {
        o.vacuumValve = cellEoat.valve
        o.magnetValve = cellEoat.valve
      }
      const blow = (cellEoat.actuators || [])
        .find((a) => a && String(a.type).toLowerCase() === 'blow_off'
                     && a.valve)
      if (blow) { o.withBlowOff = true; o.blowOffValve = blow.valve }
      else      { o.withBlowOff = false }
      return o
    })()
    const steps = []
    steps.push({ action: 'move_home', label: 'Home' })
    steps.push(...effectorReady(cfg, opts))
    steps.push({ action: 'move_linear', label: 'Approach pick',
                 derived_from: 'pick' })
    steps.push({ action: 'move_linear', label: 'Pick contact',
                 position_role: 'pick' })
    steps.push(...effectorEngage(cfg, opts))
    steps.push({ action: 'move_linear', label: 'Retreat pick',
                 derived_from: 'pick' })
    steps.push({ action: 'move_linear', label: 'Approach place',
                 derived_from: 'place' })
    steps.push({ action: 'move_linear', label: 'Place contact',
                 position_role: 'place' })
    steps.push(...effectorDisengage(cfg, opts))
    steps.push({ action: 'move_linear', label: 'Retreat place',
                 derived_from: 'place' })
    return steps
  }

  // (a) Finger EOAT: no blow-off actuator → NO blow-off step.
  const fingerTool = {
    id: 'standard:finger', type: 'finger', valve: 'V01',
    actuators: [{ type: 'double_acting', hold_on_loss: true, valve: 'V01' }],
  }
  const fingerSteps = buildPickPlace(fingerTool)
  const fingerBlow = fingerSteps.filter(
    (s) => s.io_role === 'blow_off')
  assert.equal(fingerBlow.length, 0,
    v(`Finger tool must produce zero blow-off steps — got `
      + `${fingerBlow.length}.`))
  // Vocab-token sanity: no "Blow off" string in the finger output.
  const fingerLabels = fingerSteps.map((s) => s.label).join(' ')
  for (const t of VOCAB_TOKENS.vacuum) {
    if (!t.toLowerCase().includes('blow')) continue
    assert.equal(fingerLabels.includes(t), false,
      v(`Finger tool must not emit vacuum-blow token "${t}".`))
  }

  // (b) Standard vacuum (no blow-off actuator) → NO blow-off step.
  const stdVacuum = {
    id: 'standard:vacuum', type: 'vacuum', valve: 'V03',
    actuators: [{ type: 'vacuum', hold_on_loss: true,
                  holds_via: 'check_valve', valve: 'V03' }],
  }
  const stdSteps = buildPickPlace(stdVacuum)
  const stdBlow = stdSteps.filter((s) => s.io_role === 'blow_off')
  assert.equal(stdBlow.length, 0,
    v(`Standard vacuum (no blow-off actuator) must produce zero `
      + `blow-off steps — got ${stdBlow.length}.`))

  // (c) Vacuum + blow-off (custom EOAT built via actuatorsFromCapabilities)
  //     → blow-off triplet at the CLEAR anchor.
  const vacPlusBlow = {
    id: 'custom:vac+blow', type: 'custom', valve: 'V03',
    actuators: [
      { type: 'vacuum',   hold_on_loss: true,
        holds_via: 'check_valve', valve: 'V03' },
      { type: 'blow_off', hold_on_loss: false, valve: 'V05' },
    ],
  }
  const blowSteps = buildPickPlace(vacPlusBlow)
  const blowIdx = blowSteps.map((s, i) => ({ s, i }))
    .filter((p) => p.s.io_role === 'blow_off')
    .map((p) => p.i)
  assert.equal(blowIdx.length, 2,
    v(`Vacuum+blow-off tool must emit the blow-off triplet's two `
      + `set_io steps (ON + OFF); got ${blowIdx.length}.`))
  // Anchor check: both blow-off steps sit AFTER the vacuum release
  // (last io_role==='vacuum' step with value===0) AND BEFORE the
  // retreat-place move (derived_from==='place' AND label contains
  // 'Retreat').
  const releaseIdx = blowSteps.findIndex(
    (s) => s.io_role === 'vacuum' && s.value === 0
           && s.label && s.label.toLowerCase().includes('disengage'))
  const retreatPlaceIdx = blowSteps.findIndex(
    (s) => s.derived_from === 'place'
           && String(s.label || '').toLowerCase().includes('retreat'))
  assert.ok(releaseIdx > -1,
    v('Expected a release step (vacuum io_role, value=0, label '
      + 'contains "disengage") in the sequence.'))
  assert.ok(retreatPlaceIdx > -1,
    v('Expected a retreat-place step after the disengage.'))
  for (const b of blowIdx) {
    assert.ok(b > releaseIdx,
      v(`Blow-off step at index ${b} must come AFTER the release `
        + `step at ${releaseIdx} — never before, otherwise the part `
        + 'ejects during the pick.'))
    assert.ok(b < retreatPlaceIdx,
      v(`Blow-off step at index ${b} must come BEFORE the retreat-`
        + `place step at ${retreatPlaceIdx} — blow-off clears the `
        + 'part off the cup before the arm lifts away.'))
  }
  // Determinism: generate TWICE on the same tool → identical shape.
  const twice = buildPickPlace(vacPlusBlow)
  assert.deepEqual(blowSteps, twice,
    v('Capability-driven generation must be deterministic — same '
      + 'tool + same template yields byte-identical step records.'))
})


// ── (4) Blow-off ORDER within the triplet ──────────────────────────

test('blow-off emission order: set_io(1) → wait → set_io(0)', async () => {
  const { effectorDisengage } = await import(
    '../../src/lib/effectorVocab.js')
  const { _primeCacheForTests }
    = await import('../../src/lib/synapsePortmap.js')
  _primeCacheForTests(seed)
  const steps = effectorDisengage({ effector: 'vacuum' }, {
    vacuumValve: 'V03', blowOffValve: 'V05', withBlowOff: true,
    portmap: seed,
  })
  // Expect: release (vacuum=0), blow ON (blow_off=1), wait, blow OFF (blow_off=0).
  assert.ok(steps.length >= 4,
    v(`Expected at least 4 steps in the release+clear tuple; got `
      + `${steps.length}.`))
  const release = steps[0]
  assert.equal(release.io_role, 'vacuum')
  assert.equal(release.value, 0)
  const blowOn = steps[1]
  assert.equal(blowOn.io_role, 'blow_off')
  assert.equal(blowOn.value, 1)
  assert.equal(steps[2].action, 'wait',
    v('Blow-off ON must be followed by a wait (short dwell) before OFF.'))
  const blowOff = steps[3]
  assert.equal(blowOff.io_role, 'blow_off')
  assert.equal(blowOff.value, 0)
})
