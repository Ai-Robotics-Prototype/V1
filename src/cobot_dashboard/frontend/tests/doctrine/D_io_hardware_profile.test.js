// DOCTRINE — I/O Hardware Profile (2026-10-06 Configure-tab directive).
//
// The operator declares which interface is wired to the robot:
//   SYNAPSE — NeuRobots Synapse panel attached (Valve/IN/OUT/SAFETY).
//   OEM     — customer wires directly to the CC10-A controller's
//             native DO/DI block. No Synapse panel.
//
// The choice reshapes:
//   * TopBar: Synapse tab is RENDERED DISABLED (greyed, non-navigable,
//     tooltip + click-hint modal) in Basic Robot Controller I/O mode —
//     NOT filtered out. Discoverable disappearance (2026-10-07 directive).
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
const extFixSrc     = readSrc('components/ExternalFixtureWizard.jsx')
const progEdSrc     = readSrc('components/ProgramEditor.jsx')
const progWizSrc    = readSrc('components/ProgramWizard.jsx')
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


// ── (3) TopBar: Synapse tab disabled (not hidden) in Basic mode ────

test('TopBar imports shouldShowSynapseTab + computes a synapseAllowed gate', () => {
  assert.ok(/shouldShowSynapseTab/.test(topbarSrc),
    v('TopBar must import shouldShowSynapseTab from '
      + "'../lib/ioHardwareProfile' so it can derive the disabled "
      + 'state on the Synapse tab in Basic Robot Controller I/O mode.'))
  // 2026-10-07 directive: the Synapse tab stays in the nav; the gate
  // now drives a disabled-tab affordance, not a filter removal. Pin
  // the `synapseAllowed = shouldShowSynapseTab(...)` shape.
  assert.ok(
    /synapseAllowed\s*=\s*shouldShowSynapseTab\(/.test(topbarSrc),
    v('TopBar must compute `const synapseAllowed = shouldShowSynapseTab(ioProfile)` '
      + '— the disabled-tab affordance derives from it. The old '
      + '`tab.id === "synapse" && !shouldShowSynapseTab(...)` filter '
      + 'is retired: hiding the tab was the silent-disappearance bug.'))
})

test('TopBar does NOT filter the Synapse tab out of visibleTabs in Basic mode', () => {
  // Negative pin: catch any regression that re-introduces a filter-
  // return-false path on the synapse tab. The whole point of the
  // 2026-10-07 directive is that the tab's slot is never empty — it
  // renders greyed with a tooltip. If a future edit re-adds the
  // filter, the tab disappears silently again.
  const filter = topbarSrc.match(/const visibleTabs = TABS\.filter\(\([^]*?\n\s*\}\)/)
  assert.ok(filter, v('TopBar must declare const visibleTabs = TABS.filter(...)'))
  assert.equal(
    /tab\.id\s*===\s*['"]synapse['"][\s\S]{0,120}return\s+false/.test(filter[0]),
    false,
    v('visibleTabs filter must NOT short-circuit `return false` for '
      + 'the synapse tab — the Synapse tab now stays in nav and is '
      + 'rendered disabled instead. Re-adding the filter would '
      + 'reintroduce the silent-disappearance bug.'))
})

test('TopBar renders the Synapse tab DISABLED (not hidden) in Basic mode', () => {
  // Pin the disabled-tab plumbing: the render loop computes a per-
  // tab `disabled` flag, carries data-testid="topbar-synapse-tab-disabled",
  // sets aria-disabled, uses cursor: 'help' / reduced opacity, opens
  // the hint modal on click instead of calling setTab.
  assert.ok(
    /const disabled\s*=\s*tab\.id === ['"]synapse['"]\s*&&\s*!synapseAllowed/
      .test(topbarSrc),
    v('TopBar button loop must compute `const disabled = tab.id === '
      + '"synapse" && !synapseAllowed` so the Synapse tab in Basic '
      + 'mode receives the disabled affordance.'))
  assert.ok(
    /data-testid=\{disabled \? ['"]topbar-synapse-tab-disabled['"] : undefined\}/
      .test(topbarSrc),
    v('Disabled Synapse tab must expose '
      + 'data-testid="topbar-synapse-tab-disabled" so acceptance '
      + 'tests can target it.'))
  assert.ok(
    /aria-disabled=\{disabled \|\| undefined\}/.test(topbarSrc),
    v('Disabled Synapse tab must set aria-disabled for a11y + '
      + 'automation parity.'))
  assert.ok(
    /Available in Synapse Panel mode\s+—\s+switch under Configure\./
      .test(topbarSrc),
    v('Disabled Synapse tab tooltip must read exactly '
      + '"Available in Synapse Panel mode — switch under Configure." '
      + '(byte-pinned per 2026-10-07 directive).'))
  assert.ok(
    /if\s*\(disabled\)\s*\{\s*setShowSynapseHint\(true\);\s*return\s*\}/
      .test(topbarSrc),
    v('Disabled Synapse tab click must open the hint modal '
      + '(setShowSynapseHint(true)) and NOT invoke setTab — the tab '
      + 'must stay non-navigable while discoverable.'))
})

test('TopBar renders the Synapse-hint modal with the operator copy + Configure shortcut', () => {
  // Modal shell + copy pins. Click-through to Configure is the main
  // affordance: the operator should be ONE tap away from the switch.
  assert.ok(/data-testid="topbar-synapse-hint-backdrop"/.test(topbarSrc),
    v('Synapse-hint modal must expose '
      + 'data-testid="topbar-synapse-hint-backdrop" on its backdrop.'))
  assert.ok(/data-testid="topbar-synapse-hint-panel"/.test(topbarSrc),
    v('Synapse-hint modal must expose '
      + 'data-testid="topbar-synapse-hint-panel" on its dialog panel.'))
  assert.ok(/role="dialog"/.test(topbarSrc),
    v('Synapse-hint modal panel must declare role="dialog".'))
  assert.ok(
    /The Synapse connection map is only available in Synapse Panel mode\. Go to Configure to switch\./
      .test(topbarSrc),
    v('Synapse-hint modal copy must read exactly '
      + '"The Synapse connection map is only available in Synapse '
      + 'Panel mode. Go to Configure to switch." (byte-pinned).'))
  assert.ok(
    /data-testid="topbar-synapse-hint-goto-configure"/.test(topbarSrc),
    v('Synapse-hint modal must expose the Configure shortcut button '
      + 'with data-testid="topbar-synapse-hint-goto-configure".'))
  assert.ok(
    /setShowSynapseHint\(false\);\s*setTab\(['"]configure['"]\)/
      .test(topbarSrc),
    v('Configure shortcut must dismiss the hint and call '
      + 'setTab("configure") — one tap from hint to profile switch.'))
  assert.ok(/data-testid="topbar-synapse-hint-dismiss"/.test(topbarSrc),
    v('Synapse-hint modal must expose a dismiss button with '
      + 'data-testid="topbar-synapse-hint-dismiss".'))
})

test('Configure tab actually survives the TopBar filter at the DEFAULT edition', async () => {
  // Earlier version of this pin only grep-checked that `configure`
  // appears in the TABS literal. That is a FALSE ECHO: TopBar.jsx
  // then filters every tab through `isFeatureEnabled(feature, edition)`
  // against the live `edition` value, which defaults to 'basic'. If
  // FEATURE_MAP.configure is EDITION_FULL (as it was on 2026-09-04),
  // Configure is dropped on every basic device — the live app renders
  // the nav ending at Event Log, exactly the operator-reported bug.
  //
  // This test SIMULATES the real TopBar filter: parses TABS from the
  // source, imports FEATURE_MAP + TAB_TO_FEATURE + isFeatureEnabled
  // from lib/edition.js, applies the exact same predicate TopBar
  // applies, and asserts Configure survives. Catches: tab removed
  // from TABS, tab re-gated to Full, feature mapping broken.
  const { FEATURE_MAP, TAB_TO_FEATURE, isFeatureEnabled, EDITION_BASIC }
    = await import('../../src/lib/edition.js')
  // Parse the TABS array from TopBar source — same shape as the file.
  const tabsSrc = topbarSrc.match(/const TABS = \[([\s\S]*?)\]/)[1]
  const ids = Array.from(tabsSrc.matchAll(/id:\s*['"]([a-z_0-9]+)['"]/g))
    .map((m) => m[1])
  assert.ok(ids.includes('configure'),
    v('TABS literal must declare id:"configure" — the Configure tab.'))
  // Apply TopBar's exact filter at the default edition. The live app
  // ships with edition='basic' (the useStore slice default, matched
  // by the /api/edition response's `default:"basic"` field). Configure
  // MUST pass the filter — otherwise the operator sees no Configure
  // tab, as reported 2026-10-06.
  const edition = EDITION_BASIC
  const visible = ids.filter((id) => {
    const feat = TAB_TO_FEATURE[id] || id
    return isFeatureEnabled(feat, edition)
  })
  assert.ok(visible.includes('configure'),
    v(`Configure tab must survive the TopBar filter at the default `
      + `edition='${edition}'. Current FEATURE_MAP.configure = `
      + `${JSON.stringify(FEATURE_MAP.configure)}. The 2026-10-06 `
      + `Configure-tab doctrine ungates Configure for both editions `
      + `— it is a core setting surface, not a Full-tier affordance.`))
  // And Configure must be the LAST visible tab — doctrine from the
  // same directive. If this fails, something else slipped to the end.
  assert.equal(visible[visible.length - 1], 'configure',
    v(`Configure must be the LAST visible tab at edition='${edition}'. `
      + `Got order: ${JSON.stringify(visible)}.`))
})

test('Configure tab also survives the TopBar filter at edition=full', async () => {
  const { FEATURE_MAP, TAB_TO_FEATURE, isFeatureEnabled }
    = await import('../../src/lib/edition.js')
  const tabsSrc = topbarSrc.match(/const TABS = \[([\s\S]*?)\]/)[1]
  const ids = Array.from(tabsSrc.matchAll(/id:\s*['"]([a-z_0-9]+)['"]/g))
    .map((m) => m[1])
  const visible = ids.filter((id) => {
    const feat = TAB_TO_FEATURE[id] || id
    return isFeatureEnabled(feat, 'full')
  })
  assert.ok(visible.includes('configure'),
    v(`Configure tab must be visible on edition='full' too. `
      + `FEATURE_MAP.configure=${JSON.stringify(FEATURE_MAP.configure)}.`))
  assert.equal(visible[visible.length - 1], 'configure',
    v(`Configure must be the LAST visible tab on full too — ordering `
      + `is set by TABS and is edition-independent.`))
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


// ── (4b) 2026-10-06 Configure-tab polish ──────────────────────────
//
// Polish directive pins:
//   * OEM profile renamed to "Basic Robot Controller I/O" at every
//     operator-facing surface. Internal profile value "oem" unchanged.
//   * Switch confirm is a STANDARD MODAL (ArmEnableControl / Orient
//     family): fixed backdrop at zIndex 1000, role="dialog", Escape
//     handler, no backdrop click-through, Confirm + Cancel buttons.
//   * Configure tab renders ONLY the I/O Interface section. Cells
//     wizard + self-collision guard are intentionally NOT mounted
//     here this session.

test('OEM profile label renamed to "Basic Robot Controller I/O"', async () => {
  const { profileLabel, PROFILE_OEM, PROFILE_SYNAPSE }
    = await import('../../src/lib/ioHardwareProfileCore.js')
  assert.equal(profileLabel(PROFILE_OEM), 'Basic Robot Controller I/O',
    v('profileLabel("oem") must return the operator-facing label '
      + '"Basic Robot Controller I/O" per the 2026-10-06 rename. '
      + 'Internal storage key stays "oem".'))
  assert.equal(profileLabel(PROFILE_SYNAPSE), 'Synapse Panel',
    v('Synapse profile label unchanged.'))
})

test('no operator-facing "OEM Controller I/O" string remains anywhere', () => {
  // Grep every operator-visible surface. The rename directive says
  // the internal "oem" slug can stay but the LABEL must flip. If a
  // caller hard-coded the old label as a string literal (bypassing
  // profileLabel), this pin catches it.
  const checks = [
    ['layouts/ConfigureLayout.jsx',  configureSrc],
    ['lib/ioHardwareProfile.js',     profileSrc],
    ['lib/ioHardwareProfileCore.js', profileCoreSrc],
    ['components/TopBar.jsx',        topbarSrc],
    ['App.jsx',                      appSrc],
    ['components/MyCellSection.jsx', myCellSrc],
    ['components/EOATSetupWizard.jsx', eoatWizSrc],
    ['components/ExternalFixtureWizard.jsx', extFixSrc],
    ['components/ProgramEditor.jsx',  progEdSrc],
    ['components/ProgramWizard.jsx',  progWizSrc],
  ]
  for (const [path, src] of checks) {
    // Pure prose grep — no code comments either (operators don't
    // see them, but it's a drift signal). Case-insensitive.
    const re = /OEM\s+Controller\s+I\/O/i
    const hit = src.match(re)
    assert.equal(hit, null,
      v(`${path} must not contain the retired label `
        + `"OEM Controller I/O" (case-insensitive). The 2026-10-06 `
        + `operator order renamed it to "Basic Robot Controller I/O". `
        + `Found: ${hit && hit[0]}.`))
  }
})

test('switch confirm is a standard app-theme MODAL, not an inline card', () => {
  // The dark inline card is retired. The confirm is now a modal that
  // matches the Orient/Enable family — centered on a fixed-backdrop
  // overlay, role="dialog", aria-modal, Escape handler, Confirm +
  // Cancel buttons. Grep each required attribute.
  for (const need of [
    { re: /_IoProfileSwitchModal/,
      msg: 'ConfigureLayout must declare a _IoProfileSwitchModal '
         + 'component — the standard confirm modal.' },
    { re: /role="dialog"/,
      msg: 'Switch confirm must declare role="dialog" (ARIA pattern '
         + 'shared with ArmEnableControl + OrientFlangeDownControl).' },
    { re: /aria-modal="true"/,
      msg: 'Switch confirm must declare aria-modal="true".' },
    { re: /aria-labelledby="io-profile-switch-title"/,
      msg: 'Switch confirm must label itself via aria-labelledby '
         + 'pointing at the dialog title id.' },
    { re: /position: 'fixed',\s*inset: 0,\s*zIndex: 1000/,
      msg: 'Switch confirm must render a full-viewport backdrop at '
         + 'zIndex 1000 (matches ArmEnableControl pattern).' },
    { re: /e\.key === 'Escape'/,
      msg: 'Switch confirm must handle Escape to cancel.' },
    { re: /confirmRef\.current\?\.focus\(\)/,
      msg: 'Switch confirm must auto-focus the Confirm button on '
         + 'mount (consistency with the Orient/Enable modals).' },
  ]) {
    assert.ok(need.re.test(configureSrc),
      v(need.msg + ` [pattern: ${need.re}]`))
  }
  // And the retired inline-card shape MUST be gone — a background:
  // '#111827' panel inside the Configure body is the exact style
  // the operator asked us to drop. Grep that no HardwareProfileSection
  // sibling div uses that dark background inline (the modal uses
  // white).
  assert.equal(/data-testid="io-profile-switch-confirm"[^}]*background:\s*'#111827'/
                 .test(configureSrc), false,
    v('The retired inline-dark switch-confirm card must be gone — '
      + 'the confirm is now an app-theme modal.'))
})

test('Configure tab renders ONLY the I/O Interface section', () => {
  // Walk the default export's return JSX. It must mount
  // <HardwareProfileSection /> and nothing else from the removed
  // sections. The two retired components stay defined in the file
  // (behind eslint-disable-no-unused-vars) so a follow-up directive
  // can re-mount either without re-writing them.
  const defaultExport = configureSrc.match(
    /export default function ConfigureLayout\(\)[\s\S]*?^}/m)
  assert.ok(defaultExport,
    v('ConfigureLayout must declare an export default function.'))
  const body = defaultExport[0]
  assert.ok(/<HardwareProfileSection\s*\/>/.test(body),
    v('ConfigureLayout default export must mount '
      + '<HardwareProfileSection />.'))
  assert.equal(/<CellSetupSection\s*\/>/.test(body), false,
    v('ConfigureLayout default export must NOT mount '
      + '<CellSetupSection /> — the 2026-10-06 polish directive '
      + 'removes the Setup Wizard — Cells section from the Configure '
      + 'tab. Function definition stays in-file for a future re-mount.'))
  assert.equal(/<SelfCollisionGuardSection\s*\/>/.test(body), false,
    v('ConfigureLayout default export must NOT mount '
      + '<SelfCollisionGuardSection /> — the self-collision guard '
      + 'is removed from the Configure tab this session (natural '
      + 'home is SafetyPage per the directive).'))
})

test('profile-choice diagrams are SVG, not ASCII monospace', () => {
  // The ASCII-art diagrams were visually rough — the polish directive
  // asks for app-style (SVG or styled boxes).
  assert.ok(/function _ProfileDiagram/.test(configureSrc),
    v('ConfigureLayout must declare a _ProfileDiagram SVG component '
      + '— replaces the retired ASCII blocks.'))
  assert.ok(/<svg [^>]*viewBox="0 0 220 120"/.test(configureSrc),
    v('_ProfileDiagram must render an SVG with a stable viewBox so '
      + 'the two profile cards align.'))
  // Grep that no monospace box-drawing character leaks into the
  // Configure JSX — the retired ASCII art used ┌─┐│└┘▼.
  assert.equal(/[┌┐│└┘─▼▲]/.test(configureSrc), false,
    v('Configure tab must not contain ASCII box-drawing characters '
      + '— the diagrams are now SVG per the polish directive.'))
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


// ── (6b) Every remaining operator-facing surface threads the profile ─
//
// Grep-pin surfaces named in the Configure-tab directive. Each must:
//   (a) Pull the profile via useIoHardwareProfile() (or receive it
//       as a prop from a parent that did).
//   (b) Pass `{ profile, portmap }` into cellEntryDisplay helpers,
//       or (for dropdowns rendering their own id-first display)
//       branch on profile explicitly.
//
// Together these pins catch regressions where someone adds a new
// subtitle / summary / step-row surface without wiring the profile
// — the operator would see leftover "Valve 03" copy in OEM mode.

test('ExternalFixtureWizard threads {profile, portmap} through its displays', () => {
  assert.ok(/useIoHardwareProfile/.test(extFixSrc),
    v('ExternalFixtureWizard must import + call useIoHardwareProfile '
      + 'in the picker + summary surfaces.'))
  assert.ok(/useSynapsePortmap/.test(extFixSrc),
    v('ExternalFixtureWizard must call useSynapsePortmap for '
      + 'translation inputs.'))
  assert.ok(
    /entrySubtitle\(f,\s*\{\s*profile,\s*portmap\s*\}\)/.test(extFixSrc),
    v('FixturePicker row subtitle must call entrySubtitle(f, '
      + '{profile, portmap}) — the profile-aware path.'))
  assert.ok(
    /portDisplayName\(id,\s*\{\s*profile,\s*portmap\s*\}\)/.test(extFixSrc),
    v('SummaryStep "wire ... to" rows must route through '
      + 'portDisplayName(id, {profile, portmap}).'))
})

test('EOATSetupWizard custom summary + SavedScreen are profile-aware', () => {
  // CustomEOATFlow builds a _portOpts bag + feeds it to every port
  // renderer; grep the shape so a regression that drops the bag at
  // one site is caught.
  assert.ok(/const _portOpts = \{ profile, portmap: synPortmap \}/
              .test(eoatWizSrc),
    v('CustomEOATFlow must declare _portOpts = { profile, portmap } '
      + 'and feed it into every port renderer below.'))
  for (const call of [
    'portListDisplay(resolved.required_inputs, \', \', _portOpts)',
    'portDisplayName(a.valve, _portOpts)',
  ]) {
    assert.ok(eoatWizSrc.includes(call),
      v(`EOATSetupWizard CustomEOATFlow must call "${call}" — the `
        + 'profile-aware path for the custom summary.'))
  }
  // SavedScreen flips the "on the Synapse tab" copy off in OEM mode
  // and routes "Ports claimed" through the profile-aware helper.
  assert.ok(/const _portOpts = \{ profile, portmap \}/.test(eoatWizSrc),
    v('SavedScreen must declare its own _portOpts bag.'))
  assert.ok(/portListDisplay\(valves, ', ', _portOpts\)/.test(eoatWizSrc),
    v('SavedScreen Ports-claimed line must use the profile-aware '
      + 'portListDisplay call.'))
  assert.ok(/isOem/.test(eoatWizSrc),
    v('SavedScreen must branch on isOem so the "Synapse tab" copy '
      + 'is suppressed in OEM mode (the tab is hidden there).'))
})

test('ProgramEditor detailLine + IOPortSelector + Pallet preview accept profile', () => {
  assert.ok(/function detailLine\(step, ioLabels, synapsePortmap, program, cell, profile\)/
              .test(progEdSrc),
    v('detailLine signature must take `profile` as its 6th arg so '
      + 'step rows render raw channels in OEM mode.'))
  assert.ok(
    /detailLine\(step, ioLabels, synapsePortmap,\s*\n?\s*currentProgram, cellRegistry,\s*\n?\s*ioHardwareProfile\)/
      .test(progEdSrc),
    v('ProgramEditor step row must pass ioHardwareProfile into '
      + 'detailLine when rendering the detail line.'))
  assert.ok(/formatPortName\(id, synapsePortmap, 'oem'\)/.test(progEdSrc),
    v('detailLine OEM branch must call formatPortName with the '
      + '"oem" profile so no Synapse breadcrumb leaks into step rows.'))
  assert.ok(
    /function IOPortSelector[\s\S]{0,500}useIoHardwareProfile\(\)/
      .test(progEdSrc),
    v('IOPortSelector must call useIoHardwareProfile() to branch its '
      + 'dropdown display per profile.'))
  assert.ok(
    /function PalletExpansionPreview\(\{[^)]*profile[^)]*\}\)/.test(progEdSrc),
    v('PalletExpansionPreview must accept `profile` as a prop so '
      + 'pallet substep IO details render raw channels in OEM mode.'))
  assert.ok(
    /PalletExpansionPreview[\s\S]{0,1200}profile === ['"]oem['"]/.test(progEdSrc),
    v('PalletExpansionPreview _ioName must short-circuit to the raw '
      + 'channel when profile === "oem".'))
  assert.ok(/profile={ioHardwareProfile}/.test(progEdSrc),
    v('<PalletExpansionPreview /> call site must pass profile prop.'))
})

test('ProgramWizard MachineIOBody dropdown branches on profile', () => {
  assert.ok(/useIoHardwareProfile/.test(progWizSrc),
    v('ProgramWizard must import useIoHardwareProfile and call it '
      + 'inside MachineIOBody.'))
  assert.ok(/isOem/.test(progWizSrc),
    v('MachineIOBody synDisplay must branch on isOem — the Synapse-'
      + 'name breadcrumb has no meaning on an OEM install.'))
})


// ── (6c) Unit: profile-aware entrySubtitle on every entry shape ────
//
// Direct exercise of entrySubtitle under both profiles on the exact
// records the field surfaces render (vacuum EOAT, finger EOAT, vice
// fixture). Catches a regression where a helper drops the profile
// branch for one entry type.

test('entrySubtitle in OEM mode: vacuum / finger / vice all render raw channels', async () => {
  const { entrySubtitle } = await import(
    '../../src/lib/cellEntryDisplay.js')
  const pm = { version: 1, rows: Array.from({ length: 10 }, (_, i) => [
    { synapse: `V${String(i + 1).padStart(2, '0')}`, kind: 'valve',
      raw: `DO${i + 1}`, verified: false },
    { synapse: `IN${String(i + 1).padStart(2, '0')}`, kind: 'input',
      raw: `DI${i + 1}`, verified: false },
    { synapse: `OUT${String(i + 1).padStart(2, '0')}`, kind: 'output',
      raw: `DO${i + 1}`, verified: false },
  ]).flat() }
  const opts = { profile: 'oem', portmap: pm }
  const vac = { id: 'standard:vacuum', name: 'Vacuum A',
                type: 'vacuum', valve: 'V03', inputs: ['IN04'] }
  assert.equal(entrySubtitle(vac, opts), 'Vacuum tool · DO3 · DI4',
    v('OEM vacuum subtitle must render DO3 + DI4 — no Valve/IN leaks.'))
  const fin = { id: 'standard:finger', name: 'Finger A',
                type: 'finger', valve: 'V01', inputs: ['IN01', 'IN02'] }
  assert.equal(entrySubtitle(fin, opts),
    'Finger gripper · DO1 · DI1 · DI2',
    v('OEM finger subtitle must render DO/DI channels, no Valve copy.'))
  const vice = { id: 'vice:1', name: 'Vice 1',
                 type: 'vice', valve: 'V05', out: 'OUT02', in_done: 'IN07' }
  // OUT05 collides with V05 on DO5 but the vice's valve beats its OUT
  // field — the OEM renderer resolves both to raw channel ids.
  assert.equal(entrySubtitle(vice, opts),
    'Vice / Clamp · DO5 · DO2 · DI7',
    v('OEM vice subtitle must render raw DO/DI channels for '
      + 'valve + out + in_done fields.'))
})

test('OEM-mode port grep sweep: zero Valve/IN/OUT prose in surfaces that opted in', () => {
  // Smoke pin on the TOUCHED surfaces: once a surface has threaded
  // the profile, no new hard-coded "Valve 0x" / "IN 0x" / "OUT 0x"
  // JSX text may appear. The sweep ignores WhyExpanders + comments
  // + attribute strings.
  const sweep = (src) => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    // Find text that would render in JSX between `>` and `<`.
    const jsxText = []
    const re = />([^<]+)</g
    let m
    while ((m = re.exec(noComments))) jsxText.push(m[1])
    // Hits only count if they are literal prose — not inside
    // template placeholders. Strip ${...} first.
    return jsxText
      .map((t) => t.replace(/\$\{[^}]+\}/g, ''))
      .filter((t) => /\b(Valve|IN|OUT)\s*0\d\b/.test(t))
  }
  for (const [name, src] of [
    ['MyCellSection.jsx', myCellSrc],
    ['ExternalFixtureWizard.jsx', extFixSrc],
    ['EOATSetupWizard.jsx', eoatWizSrc],
  ]) {
    const hits = sweep(src)
    assert.deepEqual(hits, [],
      v(`${name} must not contain hard-coded "Valve 0x"/"IN 0x"/"OUT 0x" `
        + `prose — route through portDisplayName/entrySubtitle/`
        + `portListDisplay with {profile, portmap}. Found: `
        + JSON.stringify(hits)))
  }
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
