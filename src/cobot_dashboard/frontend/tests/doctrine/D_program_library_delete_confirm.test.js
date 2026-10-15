// DOCTRINE — Program library delete-confirm uses the app-theme modal
// (2026-10-15 operator field report; screenshot).
//
// Pre-fix: deleteProgram and deleteFolder in pages/ProgramLibrary.jsx
// called the browser's native window.confirm with developer-jargon copy
// (".json from disk", ".deleted safeguard folder", "recoverable only
// by asking"). Operator saw an off-theme "192.168.2.246:8080 says / …"
// dialog. The audit flagged ~22 grandfathered native popups; this ship
// converts the program-library destructive confirms as the first wave.
//
// Pins:
//   * No native window.confirm / alert / prompt in the delete path.
//   * ProgramLibrary imports the shared ConfirmModal component (import-
//     identity, no fork) and mounts it in the page's return JSX.
//   * ConfirmModal mirrors the proven ArmEnableControl / Orient /
//     profile-switch pattern: Escape cancels, autofocus primary,
//     backdrop click-through NOT wired, danger-red primary when
//     `danger` is true, aria-dialog + aria-labelledby.
//   * Operator-facing copy is plain: title "Delete this program?" /
//     "Delete this folder?"; body names the item; NO ".json" /
//     ".deleted" / "disk" / "safeguard" / "recoverable only by asking"
//     jargon anywhere in the delete flow.
//   * Delete fires ONLY from the modal's onConfirm (doDeleteProgram /
//     doDeleteFolder helpers); the open-trigger (deleteProgram /
//     deleteFolder) only sets pendingDelete and never calls the DELETE
//     endpoint.
//
// Failure format: DOCTRINE DELETE_CONFIRM VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const libSrc   = readSrc('pages/ProgramLibrary.jsx')
const modalSrc = readSrc('components/ConfirmModal.jsx')

function v(msg) { return `DOCTRINE DELETE_CONFIRM VIOLATED: ${msg}` }


// ── (1) No native dialogs in the delete path ────────────────────────

test('ProgramLibrary has no live window.confirm / alert / prompt calls', () => {
  // Strip single-line and block comments so a dead comment that
  // happens to mention `confirm(` doesn't trip this gate.
  const stripped = libSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*$/gm, '')
  for (const api of ['window.confirm', 'window.alert', 'window.prompt']) {
    assert.ok(
      !stripped.includes(api),
      v(`${api} must not appear in pages/ProgramLibrary.jsx — the `
        + `operator-facing confirmation goes through the shared `
        + `ConfirmModal.`))
  }
  // A bare `confirm(` (without window.) is just as bad.
  assert.ok(
    !/[^A-Za-z_.]confirm\s*\(/.test(stripped),
    v('bare `confirm(` (without window.) must not appear in '
      + 'ProgramLibrary.jsx — delete flows route through ConfirmModal.'))
})


// ── (2) Shared component import + mount ────────────────────────────

test('ProgramLibrary imports the shared ConfirmModal component', () => {
  assert.ok(
    /import\s+ConfirmModal\s+from\s+['"]\.\.\/components\/ConfirmModal['"]/
      .test(libSrc),
    v('ProgramLibrary must import ConfirmModal from the shared '
      + '../components/ConfirmModal module — import-identity, no fork. '
      + 'The audit flagged ~22 grandfathered native popups; this '
      + 'component is where the next conversions land.'))
})

test('ProgramLibrary mounts ConfirmModal with pendingDelete-gated open', () => {
  assert.ok(
    /<ConfirmModal\s+open=\{!!pendingDelete\}/.test(libSrc),
    v('ConfirmModal must be mounted with open={!!pendingDelete} — a '
      + 'single state slot controls visibility for both program + '
      + 'folder deletes.'))
  assert.ok(
    /danger\b/.test(libSrc)
      && /testIdPrefix=\{pendingDelete\?\.kind\s*===\s*['"]folder['"][\s\S]{0,120}program-delete-confirm/.test(libSrc),
    v('The mount must set `danger` (destructive styling) and switch '
      + 'testIdPrefix on pendingDelete.kind so program vs folder deletes '
      + 'have distinct operator-targetable testids.'))
})

test('ConfirmModal props cover title, body, confirmLabel, cancelLabel, onCancel, onConfirm', () => {
  for (const prop of ['title=', 'body=', 'confirmLabel=', 'cancelLabel=', 'onCancel=', 'onConfirm=']) {
    assert.ok(
      libSrc.includes(prop),
      v(`ConfirmModal mount must pass ${prop} prop — operator copy and `
        + `dismissal handlers all come from the mount site, no modal `
        + `has implicit copy.`))
  }
})


// ── (3) Operator-facing copy — plain, no dev jargon ────────────────

test('Delete-program title is plain operator copy', () => {
  assert.ok(
    /title=\{pendingDelete\?\.kind\s*===\s*['"]folder['"][\s\S]{0,100}['"]Delete this folder\?['"][\s\S]{0,100}['"]Delete this program\?['"]/
      .test(libSrc),
    v('Mount must set title "Delete this program?" (programs) or '
      + '"Delete this folder?" (folders) — plain copy per the 2026-10-15 '
      + 'operator directive.'))
})

test('Delete-program body names the program and omits file-system jargon', () => {
  // Body must mention the item name via template literal.
  assert.ok(
    /\$\{pendingDelete\?\.name\}/.test(libSrc),
    v('Body copy must interpolate pendingDelete.name — operators who '
      + 'tap the wrong row need the dialog to call out which item they '
      + 'are about to lose.'))
  // Body must say "removed from your library" per the plain-copy spec.
  assert.ok(
    /removed from your library/.test(libSrc),
    v('Non-resident delete body must say "removed from your library" '
      + '— no filesystem language, no "removed from disk" wording.'))
})

test('No .json / .deleted / disk / safeguard / recoverable-only-by-asking jargon in dialog copy', () => {
  // Scope the sweep to the ConfirmModal mount region — bodies, titles,
  // and labels all live between `<ConfirmModal` and its closing `/>`.
  // (The rest of the file legitimately uses `.json()` on fetch
  // responses + `application/json` headers — unrelated to operator
  // copy.)
  const mountStart = libSrc.indexOf('<ConfirmModal')
  assert.ok(mountStart > 0, v('ConfirmModal mount site must exist in ProgramLibrary.'))
  const mountEnd = libSrc.indexOf('/>', mountStart)
  assert.ok(mountEnd > mountStart,
    v('ConfirmModal mount must be a self-closing JSX element.'))
  const mountChunk = libSrc.slice(mountStart, mountEnd + 2)
  const banned = [
    { re: /\.json\b/, name: '".json"' },
    { re: /\.deleted\b/, name: '".deleted"' },
    { re: /\bdisk\b/i, name: '"disk"' },
    { re: /\bsafeguard\b/i, name: '"safeguard"' },
    { re: /recoverable only by asking/i, name: '"recoverable only by asking"' },
  ]
  for (const b of banned) {
    assert.ok(
      !b.re.test(mountChunk),
      v(`${b.name} must not appear inside the ConfirmModal mount copy — `
        + `the retired confirm() carried that jargon; the ConfirmModal `
        + `says only what the operator needs to decide.`))
  }
})

test('Resident-case body is plain language too (no controller/safeguard jargon)', () => {
  // The resident branch must say the robot KEEPS its copy in plain
  // English and the dashboard REFUSES to fire — no "controller" /
  // ".deleted" / "disk" language.
  assert.ok(
    /currently loaded on the robot/.test(libSrc)
      && /the robot keeps its copy until you load a different program/.test(libSrc),
    v('Resident-case body must say "currently loaded on the robot" + '
      + '"the robot keeps its copy until you load a different program" '
      + '— plain operator-facing phrasing per the 2026-10-15 directive.'))
  assert.ok(
    /Run will refuse to fire against it/.test(libSrc),
    v('Resident-case body must warn "Run will refuse to fire against '
      + 'it" so the operator understands why hitting Run after delete '
      + 'produces a refusal toast.'))
})


// ── (4) Delete fires only from the modal's onConfirm ────────────────

test('deleteProgram opens the modal and does not call the DELETE endpoint', () => {
  const idx = libSrc.indexOf('function deleteProgram(progId)')
  assert.ok(idx > 0, v('deleteProgram function must exist in ProgramLibrary.'))
  // Capture ONLY deleteProgram's body — stops at the next function
  // declaration (doDeleteProgram), so the `fetch` in that helper
  // doesn't leak into this check.
  const stop = libSrc.indexOf('async function doDeleteProgram', idx)
  assert.ok(stop > idx, v('doDeleteProgram helper must follow deleteProgram.'))
  const after = libSrc.slice(idx, stop)
  assert.ok(
    /setPendingDelete\(\{\s*kind:\s*['"]program['"]/.test(after),
    v('deleteProgram must only setPendingDelete({ kind: "program", ... }) '
      + '— the DELETE fetch lives in doDeleteProgram, called from the '
      + 'modal\'s onConfirm. Splitting is deliberate: ONLY the Delete '
      + 'button fires the API.'))
  assert.ok(
    !/fetch\(['"]\/api\/programs\//.test(after),
    v('deleteProgram must NOT fetch /api/programs/... directly — that '
      + 'belongs in doDeleteProgram so the Delete button is the sole '
      + 'firing surface.'))
})

test('doDeleteProgram is the sole DELETE firing surface', () => {
  assert.ok(
    /async function doDeleteProgram\(progId\)/.test(libSrc),
    v('doDeleteProgram helper must exist as the sole DELETE firing '
      + 'surface for the program delete path.'))
})

test('deleteFolder opens the modal; doDeleteFolder fires the API', () => {
  const idx = libSrc.indexOf('function deleteFolder(folderId)')
  assert.ok(idx > 0, v('deleteFolder function must exist.'))
  const stop = libSrc.indexOf('async function doDeleteFolder', idx)
  assert.ok(stop > idx, v('doDeleteFolder helper must follow deleteFolder.'))
  const after = libSrc.slice(idx, stop)
  assert.ok(
    /setPendingDelete\(\{\s*kind:\s*['"]folder['"]/.test(after),
    v('deleteFolder must only setPendingDelete({ kind: "folder", ... }) '
      + '— the DELETE fetch lives in doDeleteFolder.'))
  assert.ok(
    !/fetch\(['"]\/api\/folders\//.test(after),
    v('deleteFolder must NOT fetch /api/folders/... directly.'))
  assert.ok(
    /async function doDeleteFolder\(folderId\)/.test(libSrc),
    v('doDeleteFolder helper must exist.'))
})

test('ConfirmModal.onConfirm dispatches to the matching doDelete* helper', () => {
  assert.ok(
    /onConfirm=\{\(\)\s*=>\s*\{[\s\S]{0,500}doDeleteFolder\(target\.folderId\)[\s\S]{0,200}doDeleteProgram\(target\.progId\)/
      .test(libSrc),
    v('The ConfirmModal onConfirm handler must dispatch to '
      + 'doDeleteFolder / doDeleteProgram based on pendingDelete.kind. '
      + 'ONLY the Delete button fires the API — same guarantee as the '
      + 'retired confirm() path.'))
})


// ── (5) ConfirmModal keyboard + styling contract ───────────────────

test('ConfirmModal mirrors the ArmEnable keyboard contract', () => {
  // Escape → onCancel; autofocus primary; keydown listener gated on open.
  assert.ok(
    /if \(e\.key\s*===\s*['"]Escape['"]\)\s*onCancel\?\.\(\)/.test(modalSrc),
    v('ConfirmModal must call onCancel on Escape — matches the Enable / '
      + 'Orient / profile-switch keyboard contract.'))
  assert.ok(
    /confirmBtnRef\.current\?\.focus\(\)/.test(modalSrc),
    v('ConfirmModal must autofocus the primary (confirm) button so '
      + 'Enter fires the primary action, matching Enable / Orient.'))
  assert.ok(
    /if \(!open\)\s*return/.test(modalSrc),
    v('ConfirmModal must early-return null when `open` is false so '
      + 'the keyboard listener does not stay mounted + intercept keys '
      + 'from unrelated pages when no confirm is pending.'))
})

test('ConfirmModal backdrop does NOT trigger onCancel on click', () => {
  // The audit doctrine: destructive confirms must not dismiss on an
  // accidental tap outside the card. This matches Enable / Orient.
  const stripped = modalSrc.replace(/\/\/[^\n]*$/gm, '')
  const idx = stripped.indexOf('data-testid={`${testIdPrefix}-backdrop`}')
  assert.ok(idx > 0, v('backdrop node must exist in ConfirmModal.'))
  // Look for an onClick within the backdrop div's props until the modal
  // card div opens — if onClick lands there, it would dismiss. We allow
  // onClick nowhere on the backdrop element itself.
  const backdropOpenToCardOpen = stripped.slice(idx, stripped.indexOf('data-testid={`${testIdPrefix}-modal`}', idx))
  assert.ok(
    !/onClick=/.test(backdropOpenToCardOpen),
    v('ConfirmModal backdrop must NOT carry onClick — destructive '
      + 'confirms dismiss via Cancel + Escape only (app doctrine).'))
})

test('ConfirmModal applies danger-red primary when `danger` is true', () => {
  assert.ok(
    /const DANGER_BG\s*=\s*['"]#7F1D1D['"]/.test(modalSrc)
      && /const DANGER_BORDER\s*=\s*['"]#5B1414['"]/.test(modalSrc),
    v('ConfirmModal must define DANGER_BG + DANGER_BORDER tokens '
      + 'matching the ArmEnableControl DISABLED_RED palette — one '
      + 'destructive red across the app.'))
  assert.ok(
    /ctaBg\s*=\s*danger\s*\?\s*DANGER_BG\s*:\s*ENABLE_BG/.test(modalSrc),
    v('Primary button bg must switch on `danger`: red for destructive, '
      + 'green for affirmative. Matches Enable (green) / Disable (red) '
      + 'semantics the operator already learned.'))
})
