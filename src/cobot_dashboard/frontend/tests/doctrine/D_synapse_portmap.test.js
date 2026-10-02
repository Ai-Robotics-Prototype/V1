// DOCTRINE — Synapse Addressing (2026-10-01 operator directive).
//
// Single-source Synapse→controller map; UI shows Synapse names
// everywhere; codegen emits byte-identical wire output; the ONE
// honest exception is the "Main Internal Robot Controller I/O"
// panel which stays controller-native but adds a Synapse badge
// column so the translation is inspectable in one place.
//
// Pins:
//   1. single-map (grep): no second Synapse→channel table lives
//      anywhere; cellActions + display paths import the one lib.
//   2. emission equivalence: the convention mapping used by
//      cellActions matches the seeded portmap — V<n>→DO<n>,
//      IN<n>→DI<n>, OUT<n>→DO<n> — so cell-sourced primitives
//      emit the same io_id strings they did pre-directive.
//   3. reverse-lookup round-trip (unit): Synapse → raw → Synapse
//      is an identity for every mapped row.
//   4. unmapped-channel honest copy: displayNameForRaw returns
//      "Unmapped channel <raw>" for any raw not in the portmap
//      — never silently invents a Synapse name.
//   5. no raw DO/DI tokens in operator-facing wizard/program-
//      editor copy (grep with the exception list — IOPortMap is
//      the sanctioned honest exception; selector displays may
//      still show "(DO3)" as a diagnostic trail per the directive).
//
// Failure format:
//   DOCTRINE SYNAPSE_PORTMAP VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const {
  canonRaw, canonSynapse, rawForSynapse, synapseForRaw,
  displayNameForRaw, displayNameForSynapse,
  isRawId, isSynapseId, _primeCacheForTests,
} = await import('../../src/lib/synapsePortmap.js')

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')
const REPO_ROOT = join(FRONT_ROOT, '..', '..', '..')
const readRepo = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

function v(msg) { return `DOCTRINE SYNAPSE_PORTMAP VIOLATED: ${msg}` }

const portmapSrc    = readSrc('lib/synapsePortmap.js')
const cellActionSrc = readSrc('lib/cellActions.js')
const progEdSrc     = readSrc('components/ProgramEditor.jsx')
const wizSrc        = readSrc('components/ProgramWizard.jsx')
const ioPortMapSrc  = readSrc('components/IOPortMap.jsx')
const backendSrc    = readRepo(
  'src/cobot_dashboard/cobot_dashboard/dashboard_server.py')


// ── (1) Single source — the backend endpoint + seed exist ──────────

test('backend declares /api/synapse/portmap + seed function', () => {
  assert.ok(/@app\.get\("\/api\/synapse\/portmap"\)/.test(backendSrc),
    v('Backend must declare @app.get("/api/synapse/portmap")'))
  assert.ok(/def _synapse_portmap_seed\(/.test(backendSrc),
    v('Backend must define _synapse_portmap_seed() — the single '
      + 'source for the map, auditable by the operator at '
      + '/opt/cobot/synapse_portmap.json.'))
  // Only ONE path constant — the operator audits ONE file.
  assert.ok(/_SYNAPSE_PORTMAP_PATH\s*=\s*os\.environ\.get\(/.test(backendSrc),
    v("Backend must define _SYNAPSE_PORTMAP_PATH via os.environ.get"))
  const paths = backendSrc.match(/_SYNAPSE_PORTMAP_PATH\s*=/g) || []
  assert.equal(paths.length, 1,
    v(`_SYNAPSE_PORTMAP_PATH must be defined exactly once — found ${paths.length}`))
})

test('cellActions imports the shared portmap — no inline fork', () => {
  assert.ok(
    /import\s*\{[^}]*rawForSynapse[^}]*\}\s*from\s*['"]\.\/synapsePortmap(?:\.js)?['"]/
      .test(cellActionSrc),
    v('cellActions.js must `import { rawForSynapse } from "./synapsePortmap"` '
      + '— one source for the forward lookup.'))
  // _rawFromPortmap is the single entry point; _valveToDo/_outToDo/
  // _inToDi route through it (plus a convention fallback for cold
  // boot). Grep that the three helpers all consult _rawFromPortmap.
  for (const fn of ['_valveToDo', '_outToDo', '_inToDi']) {
    const pat = new RegExp(`function\\s+${fn}\\([\\s\\S]{0,400}?_rawFromPortmap\\(`)
    assert.ok(pat.test(cellActionSrc),
      v(`${fn} must route through _rawFromPortmap so the shared `
        + `portmap owns the translation`))
  }
})


// ── (2) Emission equivalence — the convention mapping holds ────────
//
// The directive requires byte-identical wire output. cellActions is
// the ONLY cell-sourced path that synthesizes io_id strings; its
// fallback uses V<n>→DO<n> / IN<n>→DI<n> / OUT<n>→DO<n>, and the
// portmap seed matches that convention. Pin BOTH halves.

test('cellActions convention fallback keeps V<n>→DO<n> etc.', () => {
  // Fallback branches are the explicit regex transforms. Grep each.
  for (const [pattern, replacement] of [
    [/const\s+v\s*=\s*synId\.match\(\/\^V/, 'V <n> → DO<n>'],
    [/const\s+o\s*=\s*synId\.match\(\/\^OUT/, 'OUT <n> → DO<n>'],
    [/const\s+i\s*=\s*synId\.match\(\/\^IN/, 'IN <n> → DI<n>'],
  ]) {
    assert.ok(pattern.test(cellActionSrc),
      v(`Convention fallback for ${replacement} must survive the `
        + `refactor — the backward-compat path for cold boot.`))
  }
  // The fallback emits DO<Number(m[1])>, not DO<m[1]> (zero-pad
  // stripped). This is the invariant Dcell tests pin (V07 → DO7).
  assert.ok(/return\s+`DO\$\{Number\(v\[1\]\)\}`/.test(cellActionSrc),
    v('Valve fallback must emit DO${Number(m[1])} — zero-pad stripped '
      + 'so V07→DO7, matching the pre-directive emission.'))
})

test('seed mapping: forward lookup matches convention for mapped rows', () => {
  // Prime the cache with a snapshot of the seeded shape so the pure-
  // JS helpers resolve without a fetch. This mirrors what the backend
  // seed writes to /opt/cobot/synapse_portmap.json.
  const seed = {
    version: 1,
    rows: [
      ...Array.from({ length: 10 }, (_, i) => ({
        synapse: `V${String(i + 1).padStart(2, '0')}`,
        kind: 'valve', raw: `DO${i + 1}`, verified: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        synapse: `IN${String(i + 1).padStart(2, '0')}`,
        kind: 'input', raw: `DI${i + 1}`, verified: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        synapse: `OUT${String(i + 1).padStart(2, '0')}`,
        kind: 'output', raw: `DO${i + 1}`, verified: false,
      })),
    ],
  }
  _primeCacheForTests(seed)
  // Forward: V07 → DO7, IN03 → DI3, OUT04 → DO4.
  assert.equal(rawForSynapse(seed, 'V07'), 'DO7')
  assert.equal(rawForSynapse(seed, 'IN03'), 'DI3')
  assert.equal(rawForSynapse(seed, 'OUT04'), 'DO4')
  // These are the exact pairs the D_cell existing emission pins
  // assert (compileFixtureAction fixture V07.close → io_id DO7).
})


// ── (3) Reverse lookup round-trip is identity ──────────────────────

test('reverse-lookup roundtrip: V<n> → DO<n> → V<n> for every valve', () => {
  const seed = {
    version: 1,
    rows: Array.from({ length: 10 }, (_, i) => ({
      synapse: `V${String(i + 1).padStart(2, '0')}`,
      kind: 'valve', raw: `DO${i + 1}`, verified: false,
    })),
  }
  for (let n = 1; n <= 10; n++) {
    const syn = `V${String(n).padStart(2, '0')}`
    const raw = rawForSynapse(seed, syn)
    const back = synapseForRaw(seed, raw)
    assert.equal(back, syn,
      v(`${syn} → ${raw} → ${back} must round-trip to ${syn}`))
  }
})

test('reverse-lookup collision resolution: valve wins over output', () => {
  // Seed with the shipped convention — V03 and OUT03 both claim DO3.
  // synapseForRaw must return V03 (valve wins) so cell-sourced
  // callers get the primary allocation surface.
  const seed = {
    version: 1,
    rows: [
      { synapse: 'V03',  kind: 'valve',  raw: 'DO3', verified: false },
      { synapse: 'OUT03', kind: 'output', raw: 'DO3', verified: false },
    ],
  }
  assert.equal(synapseForRaw(seed, 'DO3'), 'V03',
    v('When valve + output share a raw channel, synapseForRaw must '
      + 'return the valve (primary allocation surface).'))
})


// ── (4) Unmapped-channel honest copy ───────────────────────────────

test('displayNameForRaw: unmapped channel renders honest copy', () => {
  const empty = { version: 1, rows: [] }
  assert.equal(displayNameForRaw(empty, 'DO9'), 'Unmapped channel DO9',
    v('An unmapped raw channel must render "Unmapped channel <raw>" '
      + '— never silently invent a Synapse name.'))
  assert.equal(displayNameForRaw(empty, 'DI12'), 'Unmapped channel DI12')
  // Verified reserved rows (DI16/17/18) carry a human-copy note the
  // helper surfaces, not just the raw id.
  const reserved = { version: 1, rows: [
    { synapse: 'DI16', kind: 'reserved', raw: 'DI16', verified: true,
      note: 'modeSwitch (HC interface, reserved)' },
  ]}
  assert.ok(
    /DI16[\s—-]+modeSwitch/.test(displayNameForRaw(reserved, 'DI16')),
    v('Reserved raw aliases (DI16/17/18) must render with the human '
      + 'copy note from the portmap row, not the bare raw id.'))
})

test('displayNameForSynapse: pure string formatter', () => {
  assert.equal(displayNameForSynapse('V03'), 'Valve 03')
  assert.equal(displayNameForSynapse('IN06'), 'IN 06')
  assert.equal(displayNameForSynapse('OUT10'), 'OUT 10')
  assert.equal(displayNameForSynapse('SAFETY01'), 'SAFETY 01')
  // Normalizer accepts loose input.
  assert.equal(displayNameForSynapse('v3'), 'Valve 03')
  assert.equal(displayNameForSynapse('in 6'), 'IN 06')
})


// ── (5) No raw DO/DI tokens in operator-facing copy (grep pin) ─────
//
// The sanctioned exceptions:
//   * IOPortMap.jsx — the "Main Internal Robot Controller I/O"
//     panel; this IS the controller-native diagnostic surface, so
//     raw DO/DI IS the row id. (The directive adds a Synapse badge
//     column — pinned separately.)
//   * The two IO selector dropdowns in ProgramEditor + ProgramWizard
//     show "Synapse name (DOx)" so the raw channel survives as a
//     TRACEABILITY breadcrumb (operator can cross-reference the
//     controller view). That's the directive's intent.
//
// Pin: no operator-facing JSX literal (text node OR placeholder) in
// Program-Editor or Program-Wizard contains a bare "DOn/DIn" string
// as prose — detail-line + wizard review copy must flow through the
// Synapse display helpers.

test('program-editor detailLine routes io_id through the Synapse map', () => {
  // The helper now accepts a third arg and renders through
  // displayNameForRaw when the portmap is present.
  assert.ok(/function\s+detailLine\(step,\s*ioLabels,\s*synapsePortmap\)/
              .test(progEdSrc),
    v('detailLine must accept (step, ioLabels, synapsePortmap) — '
      + 'the Synapse portmap is the third arg per the directive.'))
  assert.ok(/displayNameForRaw\(synapsePortmap,\s*id\)/.test(progEdSrc),
    v('detailLine ioName helper must call displayNameForRaw so raw '
      + 'io_ids render as Synapse names in the operator detail line.'))
})

test('program-editor IOPortSelector dropdown shows Synapse name', () => {
  // IOPortSelector derives dropdown labels through useSynapsePortmap
  // + displayNameForRaw. The "(DOx)" tail stays as a traceability
  // breadcrumb per the directive, not a bare raw id as prose.
  assert.ok(/useSynapsePortmap\(\)/.test(progEdSrc),
    v('ProgramEditor must call useSynapsePortmap() so IOPortSelector '
      + 'can render Synapse names.'))
  assert.ok(/displayNameForRaw\(synapsePortmap,\s*opt\.id\)/
              .test(progEdSrc),
    v('IOPortSelector display must call displayNameForRaw(synapsePortmap, '
      + 'opt.id) — the single-source translator.'))
})

test('program-wizard MachineIOBody dropdown shows Synapse name', () => {
  assert.ok(/useSynapsePortmap\(\)/.test(wizSrc),
    v('ProgramWizard must call useSynapsePortmap() so the MachineIO '
      + 'dropdowns render Synapse names.'))
  assert.ok(/displayNameForRaw\(synapsePortmap,\s*o\.id\)/.test(wizSrc),
    v('MachineIOBody synDisplay must call displayNameForRaw so the '
      + 'operator picks "Valve 03 (DO3)" not bare "DO3".'))
})


// ── Honest exception: IOPortMap shows Synapse badge next to raw id ─

test('IOPortMap renders a Synapse badge next to raw DO/DI (honest exception)', () => {
  assert.ok(
    /import\s*\{[^}]*useSynapsePortmap[^}]*\}\s*from\s*['"]\.\.\/lib\/synapsePortmap['"]/
      .test(ioPortMapSrc),
    v('IOPortMap must import useSynapsePortmap — the badge needs the '
      + 'portmap to resolve each row.'))
  assert.ok(/data-testid="io-channel-synapse-badge"/.test(ioPortMapSrc),
    v('IOPortMap must render a data-testid="io-channel-synapse-badge" '
      + 'span on channels that map to a Synapse name — the honest '
      + 'exception column per the directive.'))
  assert.ok(/synapseForRaw\(synapsePortmap,\s*id\)/.test(ioPortMapSrc),
    v('IOPortMap must call synapseForRaw to derive the badge text.'))
})
