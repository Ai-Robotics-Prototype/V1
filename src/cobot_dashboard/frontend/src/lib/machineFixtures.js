// lib/machineFixtures.js — shared machine-fixture (vice/clamp) model.
//
// 2026-10-15 operator field report: a machine-tending program placed
// the part in the fixture and released the gripper but NEVER CLAMPED
// THE VICE — no IO emitted to engage the fixture. The clamp vocab
// (effectorVocab.clampWorkpiece) only resolved its clamp DO by
// searching the system IO portmap for a role string "machine clamp" /
// "fixture clamp"; if the operator never labeled a portmap row that
// way, the emitter returned [] silently. And multi-vice jobs
// (load N fixtures before the cycle) were not supported at all.
//
// This module is the shared data model + codegen emitter for machine
// fixtures. Fixture records live in the cell under cellRegistry.fixtures
// (same source the External Fixture wizard writes — no fork). Each
// record carries the clamp output signal (fixture.valve for air-driven
// vices, fixture.out for own-controller vices) and an optional
// clamp-confirm input (fixture.in_done). Codegen emits one clamp +
// optional confirm per selected fixture, in the operator's declared
// order, as part of the machine-tending load sequence.
//
// Signals land as the raw Synapse / IO identifiers the fixture record
// stores (e.g. "V05", "OUT03", "IN04"). The executor already resolves
// those at run time via the shared synapse portmap — same contract as
// the tool emissions (effectorEngage, effectorDisengage) that
// consume cellEoat.valve / cellEoat.inputs.

// Resolve the selected cell-fixture records in the operator's chosen
// order. answers.machine_fixture_ids is an array of fixture.id values;
// cellRegistry.fixtures is the source list. Missing / unknown ids are
// filtered out (so a fixture deleted from the cell after save does not
// crash codegen — the save-time validator surfaces that elsewhere).
export function resolveMachineFixtures(cellRegistry, answers) {
  const ids = (answers && Array.isArray(answers.machine_fixture_ids))
    ? answers.machine_fixture_ids
    : []
  if (!ids.length) return []
  const pool = (cellRegistry && Array.isArray(cellRegistry.fixtures))
    ? cellRegistry.fixtures
    : []
  const byId = new Map(pool.map((f) => [f && f.id, f]))
  const out = []
  for (const id of ids) {
    const f = byId.get(id)
    if (f) out.push(f)
  }
  return out
}

// Resolve the clamp output signal for a fixture record. Air-powered
// vices carry it on fixture.valve ("V05"); own-controller vices carry
// it on fixture.out ("OUT03"). Returns null when neither is set —
// callers either emit [] (passthrough) or refuse at save time.
export function fixtureClampSignal(fixtureRecord) {
  if (!fixtureRecord) return null
  if (typeof fixtureRecord.valve === 'string' && fixtureRecord.valve) {
    return fixtureRecord.valve
  }
  if (typeof fixtureRecord.out === 'string' && fixtureRecord.out) {
    return fixtureRecord.out
  }
  return null
}

// Resolve the clamp-confirm input for a fixture record. Returns null
// when the fixture has no confirm sensor; codegen then skips the
// verify_input step entirely for that fixture (safe default — some
// vices do not report engaged state).
export function fixtureClampConfirmSignal(fixtureRecord) {
  if (!fixtureRecord) return null
  if (typeof fixtureRecord.in_done === 'string' && fixtureRecord.in_done) {
    return fixtureRecord.in_done
  }
  return null
}

// Return the list of selected fixtures that lack a clamp signal. The
// save validator surfaces these with a plain-copy refusal:
//   "Vice <name> has no clamp signal — finish its setup."
// so a half-configured fixture cannot ship a program that would set
// the part down and never clamp it.
export function missingClampSignalFixtures(fixtures) {
  if (!Array.isArray(fixtures)) return []
  return fixtures.filter((f) => f && !fixtureClampSignal(f))
}

// 2026-10-15 operator order on plain step names:
//   "Clamp the vice" / "Confirm vice clamped" / "Release the vice"
// Fixture name follows in parentheses so a multi-vice program is
// readable in the editor + Monitor pill without IO jargon.
export function clampFixtureSteps(fixtureRecord, opts = {}) {
  if (!fixtureRecord) return []
  const signal = fixtureClampSignal(fixtureRecord)
  if (!signal) return []
  const name = fixtureRecord.name || 'vice'
  const steps = [{
    action: 'set_io',
    label:  `Clamp the vice (${name})`,
    io_id:  signal,
    value:  1,
    io_role: 'fixture_clamp',
    fixture_id: fixtureRecord.id || null,
    fixture_name: name,
  }]
  const confirm = fixtureClampConfirmSignal(fixtureRecord)
  if (confirm) {
    steps.push({
      action: 'verify_input',
      label:  `Confirm vice clamped (${name})`,
      io_id:  confirm,
      expect: 1,
      timeout_ms: Number.isFinite(opts.confirm_timeout_ms)
        ? opts.confirm_timeout_ms : 3000,
      on_fail: 'abort',
      reason: `${name} did not confirm clamped`,
      io_role: 'fixture_clamp_confirmed',
      fixture_id: fixtureRecord.id || null,
      fixture_name: name,
    })
  }
  return steps
}

export function unclampFixtureSteps(fixtureRecord) {
  if (!fixtureRecord) return []
  const signal = fixtureClampSignal(fixtureRecord)
  if (!signal) return []
  const name = fixtureRecord.name || 'vice'
  return [{
    action: 'set_io',
    label:  `Release the vice (${name})`,
    io_id:  signal,
    value:  0,
    io_role: 'fixture_clamp',
    fixture_id: fixtureRecord.id || null,
    fixture_name: name,
  }]
}

// Operator-facing refusal message for a save with incomplete fixture
// setup. Routed through the same copy module all save refusals use.
export function missingClampSignalRefusal(fixtures) {
  const bad = missingClampSignalFixtures(fixtures)
  if (!bad.length) return null
  const names = bad.map((f) => f.name || 'Vice').join(', ')
  return `${names} has no clamp signal — finish its setup.`
}
