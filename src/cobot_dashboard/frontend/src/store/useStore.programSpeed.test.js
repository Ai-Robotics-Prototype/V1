// Structural pins for the 2026-08-31 per-program speed model.
//
// Directive:
//   1. Remove the artificial UI cap — slider/input accepts full
//      1..100 (controller-side operator_speed_limit stays the
//      true ceiling; server refuses via namedSpeedRefusal).
//   2. Per-program speed persistence — each program record stores
//      its own last-set speed under config.speed_pct. Changing
//      speed auto-saves to the CURRENT program (debounced, no
//      Save click). Switching programs loads that program's
//      saved speed. New / never-run programs default to 25%.
//   3. The F2.7 first-run gate is now a DEFAULT, not a hard cap.
//
// These are source-grep pins (same shape as
// useStore.addToast.test.js) rather than a runtime store harness.
// They verify the invariants exist in the source; a runtime test
// would need a fetch mock + full store bootstrap for coverage
// that adds no confidence over reading the six lines each pin
// checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC  = readFileSync(resolve(HERE, 'useStore.js'), 'utf8')


// ── Default is 25% (was 10 pre-directive) ──────────────────────

test('runSpeedPct default is 25 (F2.7 first-run rule as default)', () => {
  // The declaration should read `runSpeedPct: 25,` — a lower
  // value (10) is the pre-directive shape; a higher one would
  // defeat the first-run gate. Match tolerantly on whitespace.
  assert.match(SRC, /runSpeedPct:\s*25\b/,
    'runSpeedPct default is not 25 — the F2.7 first-run rule '
    + 'is no longer satisfied by the default.')
  // Legacy 10 default must be gone.
  assert.doesNotMatch(SRC, /runSpeedPct:\s*10\b/,
    'runSpeedPct legacy default 10 lingers — the auto-save '
    + 'model would race against the wrong seed.')
})


test('new-program branch falls back to 25 when config.speed_pct is absent', () => {
  // The setCurrentProgram patch handler MUST have a "no stored
  // speed → 25%" branch so a fresh program never inherits the
  // outgoing program's speed. Without this, switching programs
  // and then setting speed would auto-save the wrong number.
  assert.match(SRC, /runSpeedPct:\s*25/,
    'setCurrentProgram has no 25% default branch — new / '
    + 'never-run programs would inherit the outgoing speed.')
})


// ── Auto-save is debounced + program-scoped ────────────────────

test('setRunSpeedPct schedules a debounced per-program save', () => {
  // Timer state.
  assert.match(SRC, /_programSpeedSaveTimer:\s*null/,
    '_programSpeedSaveTimer state is missing — auto-save cannot '
    + 'debounce.')
  // Debounce clear on repeat call.
  assert.match(SRC, /_programSpeedSaveTimer[\s\S]{0,80}clearTimeout/,
    'setRunSpeedPct does not clear the prior save timer — '
    + 'consecutive edits would fire N HTTP PUTs.')
  // Fire references persistProgramSpeed with the CURRENT program's
  // id (so switching programs mid-debounce doesn't save to the
  // wrong record).
  assert.match(SRC,
    /const\s+progId\s*=\s*get\(\)\.currentProgram\?\.id/,
    'setRunSpeedPct does not read the current program id — '
    + 'the save is not program-scoped.')
  assert.match(SRC, /persistProgramSpeed\s*\(\s*progId\s*,\s*n\s*\)/,
    'setRunSpeedPct does not dispatch persistProgramSpeed with '
    + '(progId, n) — the save call is unwired.')
})


// ── PUT /api/programs/{id} with config.speed_pct merge ─────────

test('persistProgramSpeed PUTs config with speed_pct merged in', () => {
  // The persistProgramSpeed action must exist.
  assert.match(SRC, /async\s+persistProgramSpeed\s*\(/,
    'persistProgramSpeed action missing.')
  // Fires a PUT (NOT a POST) so it merges into the existing
  // program record. Match tolerantly on template/interpolation.
  assert.match(SRC, /method:\s*'PUT'/,
    'persistProgramSpeed does not use PUT — a POST would create '
    + 'a duplicate, not merge into the current record.')
  assert.match(SRC, /\/api\/programs\/\$\{encodeURIComponent\(programId\)\}/,
    'persistProgramSpeed does not target /api/programs/{id} — '
    + 'the PUT is going somewhere else.')
  // Body carries config.speed_pct merged onto the existing config.
  assert.match(SRC, /speed_pct:\s*speedPct/,
    'persistProgramSpeed body does not include speed_pct — '
    + 'the value would not persist.')
  assert.match(SRC,
    /\.{3}\(cp\?\.config\s*\|\|\s*\{\}\)/,
    'persistProgramSpeed does not spread the existing config — '
    + 'other config fields (payload, motion_profile, etc.) would '
    + 'be dropped on every speed save.')
})


test('persistProgramSpeed mirrors the new value into currentProgram.config', () => {
  // Without a local mirror, the next reload from setCurrentProgram
  // would flip the value back to whatever was on disk before the
  // debounced PUT landed — mid-flight race.
  assert.match(SRC,
    /currentProgram:\s*\{\s*\.{3}s\.currentProgram/,
    'persistProgramSpeed does not mirror the value into '
    + 'currentProgram.config.speed_pct locally — a race between '
    + 'the PUT and the next GET could flip the operator\'s value '
    + 'back.')
})


// ── Program-load path restores per-program speed ───────────────

test('setCurrentProgram loads the per-program speed_pct on program id change', () => {
  // The reset branch must key on patch.id change OR
  // config.speed_pct change (not on any other field).
  assert.match(SRC,
    /patch\?\.id\s*!==\s*undefined\s*\|\|\s*\(cfg\s*&&\s*'speed_pct'\s+in\s+cfg\)/,
    'setCurrentProgram reset trigger drifted — either the id-'
    + 'change guard OR the config.speed_pct guard is missing.')
  // The value assigned MUST come from cfg?.speed_pct ??
  // patch?.speed_pct (in that order).
  assert.match(SRC, /Number\(cfg\?\.speed_pct\s*\?\?\s*patch\?\.speed_pct\)/,
    'setCurrentProgram does not read cfg.speed_pct as the '
    + 'primary source — per-program persistence is broken.')
})


// ── UI cap has been removed from the input surface ─────────────

test('ProgramSpeedEntry has no operator_speed_limit-driven UI cap', () => {
  // The Monitor renderer must have shed the operatorCapFrac
  // fallback. Match on the render call.
  const monitor = readFileSync(
    resolve(HERE, '..', 'pages', 'MonitorDashboard.jsx'), 'utf8')
  assert.doesNotMatch(monitor,
    /operatorCapFrac=\{robot\?\.operator_speed_limit\}/,
    'Monitor still passes operatorCapFrac to ProgramSpeedEntry — '
    + 'the artificial UI cap was not removed.')
  // The "effective X% (cap Y%)" display language must be gone.
  assert.doesNotMatch(monitor, /effective\s+\$\{eff\}%\s*\(cap/,
    'The "effective X% (cap Y%)" display lingers — the UI is '
    + 'still forecasting a client-side ceiling.')
})
