// DOCTRINE — Machine-tending cycle handshake + safe-outside waypoint
// (2026-10-15 operator field report).
//
// Pre-fix (shipped bug): the machine-tending program's cycle-START
// output (tell the machine to run) and cycle-COMPLETE wait (wait for
// the machine to finish) were SILENTLY OMITTED from the generated
// program. The wizard's "Which I/O signals control the machine?" page
// collected answers.io_cycle_start + answers.io_cycle_done, but the
// codegen path (buildSteps machine_tend branch) called into
// effectorVocab.startMachineCycle / waitMachineCycle which looked up
// the Cycle Start / Cycle Done ports from the system IO portmap by
// ROLE LABEL ("cycle start" / "cycle done" in the port's assignment
// string). If the operator picked "DO4" + "DI3" in the wizard but
// hadn't ALSO labeled a portmap row with those exact strings,
// machinePortFor returned null → emitter returned [] → generated
// program had moves + gripper verify but NO machine handshake.
//
// Safety consequence: the robot loaded the fixture, retreated to safe,
// then reached BACK IN for the finished part WITHOUT ever telling the
// machine to run and WITHOUT waiting for cycle complete. If the machine
// was running when the operator saved + ran, the robot could enter a
// running machine. This is why the sequencing (handshake AFTER
// retreat-to-safe + BEFORE re-approach) is the load-bearing safety pin.
//
// Separate: the wizard emitted a step with position_role 'machine_safe'
// (the safe-outside-machine waypoint) but the teach sequence never
// offered it. Operators were left with step 10 flagged red/Teach after
// saving — a hidden to-do.
//
// Pins (regression):
//   * The vocab emitters accept override_do / override_di so the wizard
//     can pass the operator's explicit DO/DI without round-tripping
//     through a role-labeled portmap row.
//   * buildSteps machine_tend passes answers.io_cycle_start +
//     answers.io_cycle_done as overrides AND reads the timeout from
//     answers.cycle_timeout (the wizard key — not cycle_timeout_s,
//     which was the old mis-aligned default).
//   * The generated program contains, in order:
//        set_io cycle_start (value 1) → wait → set_io cycle_start (value 0)
//        verify_input cycle_done (expect 1, on_fail abort,
//                                 reason "machine did not signal complete")
//     AND those steps sit AFTER the retreat-to-safe step
//     ("Return to safe-outside-machine") that follows "Release part
//     into fixture", AND BEFORE the "Approach fixture (finished part)"
//     step. Safety-critical sequencing.
//   * The teach sequence (teachPositionsForAnswers for 'machine_tend')
//     includes a taught_machine_safe entry labeled "SAFE-OUTSIDE-
//     MACHINE WAYPOINT" so the operator teaches it in the wizard
//     flow — no silent red/Teach-flagged step after save.
//   * applyToRole binds taught_machine_safe → position_role
//     'machine_safe' so taught data flows onto the generated step.
//
// Failure format: DOCTRINE MACHINE_TEND_HANDSHAKE VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { startMachineCycle, waitMachineCycle }
  from '../../src/lib/effectorVocab.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc = readSrc('components/ProgramWizard.jsx')
const vocabSrc   = readSrc('lib/effectorVocab.js')

function v(msg) { return `DOCTRINE MACHINE_TEND_HANDSHAKE VIOLATED: ${msg}` }


// ── (1) Vocab emitters honor the wizard overrides ───────────────────

test('startMachineCycle emits the cycle-start triplet when override_do is given', () => {
  // Empty portmap → old emitter returned [] silently; new one honors
  // the operator-picked DO from the wizard.
  const emitted = startMachineCycle(null, { override_do: 'DO4', pulse_ms: 500 })
  assert.ok(emitted.length === 3,
    v(`startMachineCycle must emit the three-step pulse triplet when `
      + `override_do is given; got ${emitted.length} step(s).`))
  assert.equal(emitted[0].action, 'set_io')
  assert.equal(emitted[0].io_id,  'DO4')
  assert.equal(emitted[0].value,  1)
  assert.equal(emitted[0].io_role, 'cycle_start',
    v('First emit must carry io_role: "cycle_start" so the executor '
      + 'can bind it to the shared machine-handshake dispatch.'))
  assert.equal(emitted[1].action, 'wait',
    v('Second emit must be the pulse-hold wait.'))
  assert.equal(emitted[2].action, 'set_io')
  assert.equal(emitted[2].io_id,  'DO4')
  assert.equal(emitted[2].value,  0,
    v('Third emit must drop the DO back to 0 — PLCs latch on the '
      + 'rising edge; a hold-high would keep triggering new cycles.'))
})

test('startMachineCycle accepts both bare integers and prefixed ids', () => {
  const a = startMachineCycle(null, { override_do: 4 })
  const b = startMachineCycle(null, { override_do: '4' })
  const c = startMachineCycle(null, { override_do: 'DO4' })
  for (const [name, emits] of [['int 4', a], ['string "4"', b], ['prefixed DO4', c]]) {
    assert.equal(emits.length, 3,
      v(`override_do ${name} must resolve to DO4 and emit the triplet.`))
    assert.equal(emits[0].io_id, 'DO4',
      v(`override_do ${name} must land as io_id "DO4".`))
  }
})

test('startMachineCycle refuses mismatched-kind overrides (DI passed as DO)', () => {
  // "DI7" is a digital INPUT id; it must NOT be accepted for the
  // cycle-start DO. Mismatched kind falls back to portmap lookup
  // which, with null portmap, returns [] — safer than silently
  // firing on the wrong wire.
  const out = startMachineCycle(null, { override_do: 'DI7' })
  assert.deepEqual(out, [],
    v('override_do "DI7" (wrong kind) must NOT emit — falls back to '
      + 'portmap lookup which returns null with no portmap. Prevents '
      + 'the wizard from accidentally wiring a cycle-start pulse to a '
      + 'DI port.'))
})

test('waitMachineCycle emits verify_input with override_di + plain-copy reason', () => {
  const emitted = waitMachineCycle(null, {
    override_di: 'DI3',
    timeout_ms: 30000,
  })
  assert.equal(emitted.length, 1,
    v('waitMachineCycle must emit exactly one verify_input step.'))
  const step = emitted[0]
  assert.equal(step.action,     'verify_input')
  assert.equal(step.io_id,      'DI3')
  assert.equal(step.expect,     1)
  assert.equal(step.timeout_ms, 30000)
  assert.equal(step.on_fail,    'abort',
    v('on_fail must be "abort" — the executor contract for stopping '
      + 'the program on a verify_input timeout.'))
  assert.equal(step.io_role,    'cycle_done')
  assert.equal(step.reason,     'machine did not signal complete',
    v('reason MUST be the operator-facing plain-copy "machine did not '
      + 'signal complete" per the 2026-10-15 operator directive — the '
      + 'Run modal / Monitor pill render this verbatim on timeout.'))
})

test('Emitter helper _coerceIoId exists + is private to effectorVocab', () => {
  // The parser is pinned so an unrelated refactor can't rename it
  // without updating this suite + the two emitter sites. Private
  // function (no `export`) so it stays an implementation detail.
  assert.ok(/function _coerceIoId\(v, kind\)/.test(vocabSrc),
    v('effectorVocab must declare function _coerceIoId(v, kind) — the '
      + 'shared parser for override_do / override_di args.'))
  assert.ok(!/export\s+function\s+_coerceIoId/.test(vocabSrc),
    v('_coerceIoId must NOT be exported — kept private so the '
      + 'override_do / override_di API is the stable surface.'))
})


// ── (2) buildSteps threads the wizard answers through ───────────────

test('buildSteps machine_tend passes answers.io_cycle_start as override_do', () => {
  assert.ok(
    /startMachineCycle\(portmap,\s*\{[\s\S]{0,300}override_do:\s*answers\.io_cycle_start/
      .test(progWizSrc),
    v('buildSteps machine_tend branch must call startMachineCycle with '
      + 'override_do: answers.io_cycle_start — the wizard page writes '
      + 'the operator\'s explicit DO pick there, and the emitter uses '
      + 'the override before falling back to the portmap role lookup.'))
})

test('buildSteps machine_tend passes answers.io_cycle_done as override_di', () => {
  assert.ok(
    /waitMachineCycle\(portmap,\s*\{[\s\S]{0,300}override_di:\s*answers\.io_cycle_done/
      .test(progWizSrc),
    v('buildSteps machine_tend branch must call waitMachineCycle with '
      + 'override_di: answers.io_cycle_done — same contract as the '
      + 'cycle-start override.'))
})

test('buildSteps reads the timeout from answers.cycle_timeout (wizard key)', () => {
  // Pre-fix read answers.cycle_timeout_s (the slider\'s unit label
  // was mistaken for a key suffix); operator\'s saved programs
  // carried answers.cycle_timeout but the code never read it.
  assert.ok(
    /_cycleTimeoutS\s*=\s*Number\(answers\.cycle_timeout\)[\s\S]{0,120}\|\|\s*Number\(answers\.cycle_timeout_s\)/
      .test(progWizSrc),
    v('buildSteps must read Number(answers.cycle_timeout) first, falling '
      + 'back to answers.cycle_timeout_s only for programs saved under '
      + 'the historical key — otherwise operator-set timeouts were '
      + 'silently overridden by the 60s default.'))
})


// ── (3) Safety sequencing: handshake AFTER retreat-to-safe, BEFORE re-approach ──

test('Machine handshake sits AFTER return-to-safe and BEFORE re-approach', () => {
  // Grep the machine_tend branch of buildSteps and assert the five
  // anchors appear in this exact source order:
  //   Release part into fixture
  //   Retreat from fixture
  //   Return to safe-outside-machine (first occurrence — load-side)
  //   startMachineCycle(...
  //   waitMachineCycle(...
  //   Approach fixture (finished part)
  // That order is the load-bearing safety invariant — the robot must
  // be clear of the machine BEFORE the cycle fires, and must have
  // received cycle-complete BEFORE reaching back in. Any reorder
  // violates the operator directive and this pin forces re-review.
  const bodyStart = progWizSrc.indexOf('if (!isMultiPair && op === \'machine_tend\') {')
  assert.ok(bodyStart > 0,
    v('machine_tend branch must still exist in buildSteps.'))
  const bodyEnd = progWizSrc.indexOf('} else if (!isMultiPair) {', bodyStart)
  assert.ok(bodyEnd > bodyStart,
    v('machine_tend branch must have a sibling else branch (default place).'))
  const body = progWizSrc.slice(bodyStart, bodyEnd)
  const order = [
    'Release part into fixture',
    'Retreat from fixture',
    'Return to safe-outside-machine',
    'startMachineCycle(',
    'waitMachineCycle(',
    'Approach fixture (finished part)',
  ]
  let cursor = 0
  for (const anchor of order) {
    const idx = body.indexOf(anchor, cursor)
    assert.ok(idx >= 0,
      v(`machine_tend branch must contain anchor "${anchor}" after `
        + `position ${cursor} — safety sequencing invariant.`))
    cursor = idx + anchor.length
  }
})


// ── (4) Teach sequence offers the safe-outside waypoint ─────────────

test('teachPositionsForAnswers includes taught_machine_safe for machine_tend', () => {
  // Grep the machine_tend branch of teachPositionsForAnswers.
  const branchStart = progWizSrc.indexOf("} else if (op === 'machine_tend') {")
  assert.ok(branchStart > 0,
    v('machine_tend teach-sequence branch must exist.'))
  const branchEnd = progWizSrc.indexOf("} else if (op === 'sort') {", branchStart)
  assert.ok(branchEnd > branchStart,
    v('machine_tend teach-sequence branch must be followed by sort branch.'))
  const branch = progWizSrc.slice(branchStart, branchEnd)
  assert.ok(
    /key:\s*['"]taught_machine_safe['"][\s\S]{0,200}label:\s*['"]SAFE-OUTSIDE-MACHINE WAYPOINT['"]/
      .test(branch),
    v('machine_tend teach sequence must push an entry with key '
      + '"taught_machine_safe" + label "SAFE-OUTSIDE-MACHINE WAYPOINT" '
      + 'so the operator teaches that pose in the wizard flow instead '
      + 'of being left with step 10 flagged red/Teach after save.'))
})

test('applyToRole binds taught_machine_safe → position_role "machine_safe"', () => {
  assert.ok(
    /readTaught\(cfg,\s*['"]taught_machine_safe['"]\)/.test(progWizSrc),
    v('buildSteps must read taught_machine_safe via readTaught — the '
      + 'taught-pose resolver\'s single entrypoint.'))
  assert.ok(
    /applyToRole\(['"]machine_safe['"],\s*machineSafeP\)/.test(progWizSrc),
    v('buildSteps must call applyToRole("machine_safe", machineSafeP) '
      + 'so the taught pose lands on the generated '
      + 'position_role:"machine_safe" step.'))
})
