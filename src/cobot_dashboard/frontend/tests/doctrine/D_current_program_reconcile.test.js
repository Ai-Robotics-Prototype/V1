// DOCTRINE — Monitor's current/loaded program reconciles against the
// library (2026-10-15 operator field report).
//
// Pre-fix: deleting all programs from the Program Library left a stale
// program showing on Monitor. The delete path in ProgramLibrary cleared
// currentProgram ONLY when the deleted id exactly matched
// currentProgram.id — so a program deleted in another tab / session,
// or the "delete all" sweep that didn't match the live tab's loaded
// id (e.g. the last-loaded id drifted or wasn't the one deleted
// first), left Monitor pointing at a program the library no longer
// knew about. Monitor's `programName = currentProgram?.name ||
// 'No program loaded'` fallback was never reached because
// currentProgram.id/name were still populated with the ghost record.
//
// The reconcile fix is in the store: hydratePrograms (and its
// refreshPrograms wrapper) now walks the fresh programs list and, if
// currentProgram.id is non-null AND NOT present in the list, routes
// through clearCurrentProgram() to the canonical _EMPTY_PROGRAM shape.
// That makes "no program loaded" the inevitable outcome of a deleted-
// elsewhere program; Monitor's existing empty-state fallback then
// renders without any UI change.
//
// Separately, the ProgramLibrary delete flow now de-dupes its inline
// empty-shape literal — doDeleteProgram calls the same
// clearCurrentProgram() action — so the two paths cannot drift.
//
// Pins:
//   * useStore defines _EMPTY_PROGRAM as a frozen canonical shape AND
//     exports a clearCurrentProgram() action that writes a FRESH copy
//     into currentProgram.
//   * currentProgram slot's initial value spreads _EMPTY_PROGRAM (no
//     inline literal that could drift).
//   * hydratePrograms, after it writes programsList, checks whether
//     currentProgram.id still exists; if not, calls
//     clearCurrentProgram(). The reconcile only fires for non-null
//     ids (brand-new unsaved programs with id=null are untouched).
//   * ProgramLibrary's doDeleteProgram calls clearCurrentProgram()
//     (no inline empty-shape literal).
//
// Behavior preserved:
//   * MonitorDashboard still renders `programName =
//     currentProgram?.name || 'No program loaded'` — the empty state
//     is the fallback copy and is unchanged.
//   * runnableStepCount(currentProgram) returns 0 for the empty
//     program → runDisabled / restartDisabled / emptyProgram all
//     gate the Run / Restart / Home controls when the loaded
//     program is cleared.
//
// Failure format: DOCTRINE CURRENT_PROGRAM_RECONCILE VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const storeSrc    = readSrc('store/useStore.js')
const libSrc      = readSrc('pages/ProgramLibrary.jsx')
const monitorSrc  = readSrc('pages/MonitorDashboard.jsx')

function v(msg) { return `DOCTRINE CURRENT_PROGRAM_RECONCILE VIOLATED: ${msg}` }


// ── (1) Canonical empty-program shape + action ──────────────────────

test('useStore defines a frozen _EMPTY_PROGRAM template', () => {
  assert.ok(
    /const _EMPTY_PROGRAM\s*=\s*Object\.freeze\(\{/.test(storeSrc),
    v('useStore must declare _EMPTY_PROGRAM as a frozen object literal '
      + '— the canonical "no program loaded" shape both the delete '
      + 'flow and the reconcile write.'))
  // Required fields that Monitor + the editor read from currentProgram.
  for (const field of [
    'id:', 'name:', 'steps:', 'unsaved:', 'config:',
    'description:', 'tags:', 'cell_id:', 'points:', 'source:',
    'has_taught_poses:',
  ]) {
    assert.ok(storeSrc.includes(field),
      v(`_EMPTY_PROGRAM must carry field ${field.replace(':', '')} — `
        + `every reader of currentProgram relies on its shape.`))
  }
  // Specifically id: null so Monitor's programName fallback fires
  // and runnableStepCount gates Run / Restart.
  assert.ok(/id:\s+null/.test(storeSrc),
    v('_EMPTY_PROGRAM must set id: null — Monitor\'s runDisabled + '
      + 'restartDisabled read currentProgram.id and gate the controls.'))
})

test('useStore exposes a clearCurrentProgram() action', () => {
  assert.ok(/clearCurrentProgram\(\)\s*\{\s*\n/.test(storeSrc),
    v('useStore must define clearCurrentProgram() as a store action.'))
  assert.ok(
    /clearCurrentProgram\(\)\s*\{[\s\S]{0,200}set\(\{\s*currentProgram:\s*\{\s*\.\.\._EMPTY_PROGRAM\s*\}\s*\}\)/
      .test(storeSrc),
    v('clearCurrentProgram() must write set({ currentProgram: '
      + '{ ..._EMPTY_PROGRAM } }) — a FRESH spread so a later mutation '
      + 'of currentProgram cannot leak into the frozen template.'))
})

test('currentProgram slot spreads _EMPTY_PROGRAM in its initial value', () => {
  assert.ok(
    /currentProgram:\s*\{\s*\.\.\._EMPTY_PROGRAM\s*\}/.test(storeSrc),
    v('currentProgram slot\'s initial value must spread '
      + '_EMPTY_PROGRAM — single source of truth, no inline literal '
      + 'that could drift from the empty shape used elsewhere.'))
})


// ── (2) hydratePrograms reconcile against the library ───────────────

test('hydratePrograms clears currentProgram when its id is deleted library-side', () => {
  const idx = storeSrc.indexOf('async hydratePrograms(')
  assert.ok(idx > 0, v('hydratePrograms action must exist.'))
  const chunk = storeSrc.slice(idx, idx + 2000)
  // The reconcile has three parts, all pinned:
  //   1. Read the current loaded id AFTER programsList is written.
  //   2. Check the loaded id is non-null AND not in the fresh list.
  //   3. Call clearCurrentProgram() through the store.
  assert.ok(
    /const _loadedId\s*=\s*get\(\)\.currentProgram\?\.id/.test(chunk),
    v('hydratePrograms must read _loadedId = get().currentProgram?.id '
      + 'after the fresh programsList is written — the reconcile\'s '
      + 'read-side.'))
  assert.ok(
    /if \(_loadedId[\s\S]{0,80}!programs\.some\(\(p\)\s*=>\s*p\s*&&\s*p\.id\s*===\s*_loadedId\)\)/
      .test(chunk),
    v('hydratePrograms must gate on `_loadedId && !programs.some(...)` '
      + '— the stale-reference test. Non-null loaded id that is not '
      + 'in the fresh list → clear.'))
  assert.ok(
    /get\(\)\.clearCurrentProgram\(\)/.test(chunk),
    v('hydratePrograms must call get().clearCurrentProgram() for the '
      + 'reconcile — same seam the Library delete flow uses, no '
      + 'inline empty literal.'))
})

test('refreshPrograms delegates to hydratePrograms (reconcile fires every refresh)', () => {
  assert.ok(
    /async refreshPrograms\(\)\s*\{[\s\S]{0,100}return get\(\)\.hydratePrograms\(\{\s*force:\s*true\s*\}\)/
      .test(storeSrc),
    v('refreshPrograms must delegate to hydratePrograms({ force: true }) '
      + '— so every Library refresh (including after delete) triggers '
      + 'the reconcile.'))
})


// ── (3) ProgramLibrary delete flow uses clearCurrentProgram ────────

test('ProgramLibrary binds clearCurrentProgram from the store', () => {
  assert.ok(
    /const clearCurrentProgram\s*=\s*useStore\(\(s\)\s*=>\s*s\.clearCurrentProgram\)/
      .test(libSrc),
    v('ProgramLibrary must bind clearCurrentProgram from the store so '
      + 'doDeleteProgram can route through the shared action.'))
})

test('doDeleteProgram calls clearCurrentProgram (no inline empty literal)', () => {
  const idx = libSrc.indexOf('async function doDeleteProgram(progId)')
  assert.ok(idx > 0, v('doDeleteProgram must exist.'))
  const next = libSrc.indexOf('async function doDeleteFolder', idx)
  const chunk = libSrc.slice(idx, next > idx ? next : idx + 1500)
  assert.ok(
    /if \(currentProgramId && currentProgramId === progId\)\s*\{\s*\n\s*clearCurrentProgram\(\)/
      .test(chunk),
    v('doDeleteProgram must call clearCurrentProgram() when the '
      + 'deleted id matches the loaded one — not an inline '
      + 'setCurrentProgram({ id: null, ... }) literal.'))
  // Confirm the retired inline literal is GONE so the two paths
  // cannot drift.
  assert.equal(
    /setCurrentProgram\(\{\s*id:\s*null,\s*name:\s*['"]Untitled Program['"]/
      .test(chunk),
    false,
    v('The pre-fix inline setCurrentProgram({ id: null, name: '
      + '"Untitled Program", ... }) literal must NOT appear in '
      + 'doDeleteProgram — the empty-shape literal lives ONCE as '
      + '_EMPTY_PROGRAM in useStore.'))
})


// ── (4) Monitor empty-state behavior unchanged ──────────────────────

test('MonitorDashboard still falls back to "No program loaded" copy', () => {
  assert.ok(
    /programName\s*=\s*currentProgram\?\.name\s*\|\|\s*['"]No program loaded['"]/
      .test(monitorSrc),
    v('MonitorDashboard must keep the `programName = '
      + 'currentProgram?.name || "No program loaded"` fallback — the '
      + 'empty-state copy that renders once clearCurrentProgram() '
      + 'reconciles the slot.'))
})

test('MonitorDashboard disables Run / Restart when currentProgram.id is null', () => {
  // runnableStepCount(currentProgram) returns 0 for the empty program
  // (steps: []) → emptyProgram = true → runDisabled picks it up via
  // its gates. We pin the explicit !(currentProgram?.id) check in
  // restartDisabled since it is the clearest "no loaded program →
  // disable" wiring.
  assert.ok(
    /restartDisabled\s*=\s*!!safety\?\.estop[\s\S]{0,100}\|\|\s*!\(currentProgram\?\.id\)/
      .test(monitorSrc),
    v('MonitorDashboard restartDisabled must OR in '
      + '!(currentProgram?.id) — when the reconcile clears the slot, '
      + 'Restart (and transitively Run) are unavailable.'))
})
