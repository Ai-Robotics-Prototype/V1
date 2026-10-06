// DOCTRINE — I/O Hardware Profile (2026-10-06 Configure-tab directive).
//
// The operator declares which interface is wired to the robot:
//   SYNAPSE — NeuRobots Synapse panel attached (Valve/IN/OUT/SAFETY).
//   OEM     — customer wires directly to the CC10-A controller's
//             native DO/DI block. No Synapse panel.
//
// The choice reshapes:
//   * TopBar: Synapse tab is hidden in OEM mode.
//   * Wizards: hookup copy switches between "Connect ... Valve 03"
//     and "Wire ... DO3 on the controller"; the pulse-glow Synapse
//     connection-map diagram is hidden in OEM mode.
//   * Port-name formatters: cellEntryDisplay routes port ids through
//     the profile-aware helper so MyCell subtitles / wizard summaries
//     flip from "Valve 03 · IN 04" to "DO3 · DI4".
//   * Nav default: Configure tab moves to the trailing edge; it is
//     the installation-setup home.
//
// Codegen is UNCHANGED in both profiles — the same physical DO/DI
// channel fires regardless of which profile the operator picked.
//
// Failure format:
//   DOCTRINE IO_HARDWARE_PROFILE VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')
const REPO_ROOT = join(FRONT_ROOT, '..', '..', '..')
const readRepo = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

function v(msg) { return `DOCTRINE IO_HARDWARE_PROFILE VIOLATED: ${msg}` }

const profileSrc    = readSrc('lib/ioHardwareProfile.js')
const profileCoreSrc = readSrc('lib/ioHardwareProfileCore.js')
const cellDispSrc   = readSrc('lib/cellEntryDisplay.js')
const topbarSrc     = readSrc('components/TopBar.jsx')
const configureSrc  = readSrc('layouts/ConfigureLayout.jsx')
const appSrc        = readSrc('App.jsx')
const storeSrc      = readSrc('store/useStore.js')
const eoatWizSrc    = readSrc('components/EOATSetupWizard.jsx')
const myCellSrc     = readSrc('components/MyCellSection.jsx')
const backendSrc    = readRepo(
  'src/cobot_dashboard/cobot_dashboard/dashboard_server.py')


// ── (1) Shared library exposes the profile API ────────────────────

test('lib/ioHardwareProfile.js + Core expose the public API', () => {
  // Pure helpers live in Core so node-side tests can import them
  // without pulling the Zustand store transitively.
  for (const sym of [
    'export const PROFILE_SYNAPSE',
    'export const PROFILE_OEM',
    'export const PROFILE_DEFAULT',
    'export function normalizeProfile',
    'export function isSynapseProfile',
    'export function isOemProfile',
    'export function profileLabel',
    'export function shouldShowSynapseMap',
    'export function shouldShowSynapseTab',
    'export function formatPortName',
  ]) {
    assert.ok(profileCoreSrc.includes(sym),
      v(`lib/ioHardwareProfileCore.js must declare "${sym}".`))
  }
  // The React-hook barrel re-exports Core + adds useIoHardwareProfile.
  assert.ok(/export \* from ['"]\.\/ioHardwareProfileCore(?:\.js)?['"]/
              .test(profileSrc),
    v('lib/ioHardwareProfile.js must re-export the Core module so '
      + 'callers keep a single import point.'))
  assert.ok(/export function useIoHardwareProfile/.test(profileSrc),
    v('lib/ioHardwareProfile.js must declare the React hook '
      + 'useIoHardwareProfile.'))
})

test('PROFILE_DEFAULT is "synapse" (back-compat on upgrade)', async () => {
  const { PROFILE_DEFAULT, PROFILE_SYNAPSE } = await import(
    '../../src/lib/ioHardwareProfileCore.js')
  assert.equal(PROFILE_DEFAULT, PROFILE_SYNAPSE,
    v('Default profile must be "synapse" — every already-deployed '
      + 'install keeps its current behaviour on upgrade.'))
})


// ── (2) Formatter: Synapse vs OEM rendering ───────────────────────

test('formatPortName: Synapse profile renders Synapse display names', async () => {
  const { formatPortName, PROFILE_SYNAPSE } = await import(
    '../../src/lib/ioHardwareProfileCore.js')
  const pm = { version: 1, rows: Array.from({ length: 10 }, (_, i) => ({
    synapse: `V${String(i + 1).padStart(2, '0')}`,
    kind: 'valve', raw: `DO${i + 1}`, verified: false,
  })) }
  assert.equal(formatPortName('V03', pm, PROFILE_SYNAPSE), 'Valve 03',
    v('Synapse-profile formatter must render "V03" as "Valve 03".'))
  assert.equal(formatPortName('DO3', pm, PROFILE_SYNAPSE), 'Valve 03',
    v('Synapse-profile formatter must reverse-resolve DO3 → "Valve 03".'))
})

test('formatPortName: OEM profile renders raw controller channels', async () => {
  const { formatPortName, PROFILE_OEM } = await import(
    '../../src/lib/ioHardwareProfileCore.js')
  const pm = { version: 1, rows: [
    { synapse: 'V03', kind: 'valve', raw: 'DO3', verified: false },
    { synapse: 'IN04', kind: 'input', raw: 'DI4', verified: false },
  ] }
  assert.equal(formatPortName('V03', pm, PROFILE_OEM), 'DO3',
    v('OEM-profile formatter must forward-resolve "V03" to "DO3".'))
  assert.equal(formatPortName('IN04', pm, PROFILE_OEM), 'DI4',
    v('OEM-profile formatter must forward-resolve "IN04" to "DI4".'))
  assert.equal(formatPortName('DO7', pm, PROFILE_OEM), 'DO7',
    v('OEM-profile formatter must pass raw channels through verbatim.'))
})

test('cellEntryDisplay.entrySubtitle: default stays Synapse (back-compat)', async () => {
  const { entrySubtitle } = await import(
    '../../src/lib/cellEntryDisplay.js')
  const vac = { id: 'standard:vacuum', name: 'Vacuum A',
                type: 'vacuum', valve: 'V03', inputs: ['IN04'] }
  assert.equal(entrySubtitle(vac), 'Vacuum tool · Valve 03 · IN 04',
    v('entrySubtitle(entry) with no opts must render Synapse display '
      + 'names — back-compat pin for every call site that predates '
      + 'the profile system.'))
})

test('cellEntryDisplay.entrySubtitle: OEM profile flips to raw channels', async () => {
  const { entrySubtitle } = await import(
    '../../src/lib/cellEntryDisplay.js')
  const pm = { version: 1, rows: [
    { synapse: 'V03', kind: 'valve', raw: 'DO3', verified: false },
    { synapse: 'IN04', kind: 'input', raw: 'DI4', verified: false },
  ] }
  const vac = { id: 'standard:vacuum', name: 'Vacuum A',
                type: 'vacuum', valve: 'V03', inputs: ['IN04'] }
  assert.equal(
    entrySubtitle(vac, { profile: 'oem', portmap: pm }),
    'Vacuum tool · DO3 · DI4',
    v('entrySubtitle with profile:"oem" must render raw controller '
      + 'channels — operator sees the names they wired.'))
})


// ── (3) TopBar: Synapse tab hidden in OEM mode, Configure trailing ─

test('TopBar imports shouldShowSynapseTab + gates the Synapse tab on it', () => {
  assert.ok(/shouldShowSynapseTab/.test(topbarSrc),
    v('TopBar must import shouldShowSynapseTab from '
      + "'../lib/ioHardwareProfile' and gate the synapse tab on it."))
  assert.ok(
    /tab\.id === ['"]synapse['"].*shouldShowSynapseTab/.test(topbarSrc),
    v('TopBar visibleTabs filter must call shouldShowSynapseTab for '
      + 'the synapse tab — otherwise OEM operators see a dead tab.'))
})

test('TopBar reads ioHardwareProfile from the store', () => {
  assert.ok(/ioHardwareProfile/.test(topbarSrc),
    v('TopBar must read `ioHardwareProfile` from useStore so the '
      + 'tab filter re-evaluates when the operator flips profiles.'))
})


// ── (4) Configure tab hosts the hardware-profile section ──────────

test('ConfigureLayout renders the HardwareProfileSection', () => {
  assert.ok(/function HardwareProfileSection/.test(configureSrc),
    v('ConfigureLayout must declare a HardwareProfileSection function '
      + '— the operator-facing I/O interface control.'))
  assert.ok(/<HardwareProfileSection/.test(configureSrc),
    v('ConfigureLayout\'s default export must mount '
      + '<HardwareProfileSection /> inside the Configure page.'))
  // The section carries a testid for e2e targeting + the profile
  // choices expose discoverable test hooks.
  assert.ok(/data-testid="io-hardware-profile-section"/.test(configureSrc),
    v('HardwareProfileSection must expose '
      + 'data-testid="io-hardware-profile-section".'))
  assert.ok(/data-testid="io-profile-choice"/.test(configureSrc),
    v('Each profile choice must expose '
      + 'data-testid="io-profile-choice" so tests can click them.'))
})

test('ConfigureLayout profile-switch confirm names the flagged counts', () => {
  // The switch confirm must show the warning the operator asked for —
  // existing Synapse assignments are flagged, not silently re-mapped.
  assert.ok(/data-testid="io-profile-switch-confirm"/.test(configureSrc),
    v('ConfigureLayout must render a switch-confirm UI with testid '
      + '"io-profile-switch-confirm" so tests can target the dialog.'))
  assert.ok(/data-testid="io-profile-switch-flagged"/.test(configureSrc),
    v('When any existing assignment uses Synapse port names, the '
      + 'switch confirm must render a flagged-count block with '
      + 'testid "io-profile-switch-flagged" — operators must see '
      + 'the count before confirming.'))
})


// ── (5) Store slice + App.jsx hydrate ─────────────────────────────

test('useStore declares ioHardwareProfile slice + hydrate action', () => {
  assert.ok(/ioHardwareProfile:\s*['"]synapse['"]/.test(storeSrc),
    v('useStore must initialize ioHardwareProfile to "synapse" so the '
      + 'first paint matches today\'s deployed behaviour.'))
  for (const sym of [
    'hydrateIoHardwareProfile', 'setIoHardwareProfile',
  ]) {
    assert.ok(storeSrc.includes(sym),
      v(`useStore must declare the "${sym}" action.`))
  }
})

test('App.jsx hydrates the I/O hardware profile on mount', () => {
  assert.ok(/hydrateIoHardwareProfile\(\)/.test(appSrc),
    v('App.jsx must call hydrateIoHardwareProfile() in its mount '
      + 'effect — wizards + TopBar read the profile before the first '
      + 'navigation.'))
})

test('App.jsx falls back off the Synapse tab when profile flips to OEM', () => {
  assert.ok(
    /ioHardwareProfile === ['"]oem['"][^}]*activeTab === ['"]synapse['"]/
      .test(appSrc.replace(/\s+/g, ' ')),
    v('App.jsx must redirect activeTab away from "synapse" when the '
      + 'profile is "oem" — the Synapse page models a panel that '
      + 'isn\'t attached in OEM installs.'))
})


// ── (6) EOATSetupWizard shows the Synapse map OR an OEM equivalent ─

test('EOATSetupWizard.GuidanceBlock conditionally renders the map vs OEM list', () => {
  assert.ok(/shouldShowSynapseMap\(profile\)/.test(eoatWizSrc),
    v('EOATSetupWizard GuidanceBlock must gate the SynapseConnectionMap '
      + 'render on shouldShowSynapseMap(profile).'))
  assert.ok(/function OemWiringGuidance/.test(eoatWizSrc),
    v('EOATSetupWizard must declare an OemWiringGuidance component '
      + 'to render in OEM mode in place of the Synapse pulse-glow map.'))
  assert.ok(/data-testid="oem-wiring-guidance"/.test(eoatWizSrc),
    v('OemWiringGuidance must expose '
      + 'data-testid="oem-wiring-guidance" so operator-facing acceptance '
      + 'tests can target it.'))
})

test('MyCellSection renders subtitles through the profile-aware helper', () => {
  assert.ok(/useIoHardwareProfile/.test(myCellSrc),
    v('MyCellSection must call useIoHardwareProfile() so subtitles '
      + 'flip to raw channels in OEM mode.'))
  assert.ok(/entrySubtitle\(entry,\s*\{\s*profile,\s*portmap\s*\}\)/
              .test(myCellSrc),
    v('MyCellSection must call entrySubtitle with {profile, portmap} '
      + '— the single-source profile-aware subtitle path.'))
})


// ── (7) Backend endpoints exist + default is persisted ────────────

test('backend declares GET + PUT /api/config/io_hardware_profile', () => {
  assert.ok(
    /@app\.get\("\/api\/config\/io_hardware_profile"\)/.test(backendSrc),
    v('Backend must declare @app.get("/api/config/io_hardware_profile") '
      + '— the Configure tab reads the current profile here.'))
  assert.ok(
    /@app\.put\("\/api\/config\/io_hardware_profile"\)/.test(backendSrc),
    v('Backend must declare @app.put("/api/config/io_hardware_profile") '
      + '— the Configure tab writes the chosen profile here.'))
})

test('backend default profile is "synapse" + stored in cell.json meta', () => {
  assert.ok(
    /_IO_HARDWARE_PROFILE_DEFAULT\s*=\s*['"]synapse['"]/.test(backendSrc),
    v('Backend _IO_HARDWARE_PROFILE_DEFAULT must be "synapse" — the '
      + 'operator directive mandates this default so existing installs '
      + 'are unchanged on upgrade.'))
  assert.ok(
    /io_hardware_profile.*_IO_HARDWARE_PROFILE_DEFAULT/.test(
      backendSrc.replace(/\s+/g, ' ')),
    v('Backend _empty_cell() meta must initialize io_hardware_profile '
      + 'to the default so a fresh cell.json carries the field.'))
})

test('backend returns switch-warning counts on GET + PUT', () => {
  assert.ok(/_cell_profile_assignment_counts/.test(backendSrc),
    v('Backend must declare _cell_profile_assignment_counts(cell) — '
      + 'the Configure UI surfaces these numbers before the operator '
      + 'confirms a switch so no assignment is silently re-mapped.'))
  assert.ok(/eoats_with_synapse_ports/.test(backendSrc),
    v('Counts response must include eoats_with_synapse_ports.'))
  assert.ok(/fixtures_with_synapse_ports/.test(backendSrc),
    v('Counts response must include fixtures_with_synapse_ports.'))
})
