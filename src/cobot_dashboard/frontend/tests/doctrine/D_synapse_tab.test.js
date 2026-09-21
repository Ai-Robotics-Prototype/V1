// DOCTRINE — Synapse tab (2026-09-21 operator directive).
//
// Static wiring reference for the Synapse controller. VIEW-tier
// only — no control verbs, no fetch, no dispatch. Data-driven so
// hardware changes edit the arrays, not the JSX; every connector
// glyph carries a `data-io` attribute so a later pass can bind
// live state without touching this file.
//
// This suite pins the invariants named in the operator directive:
//
//   1. Tab renders in nav + routes.
//   2. Three sections with exact counts (10 valves / 10 IN / 10 OUT / 4 SAFETY).
//   3. Labels match the data structure (single source per section).
//   4. `data-io` on every connector glyph.
//   5. Mount-once per navigation (page is NOT in kept3D; no
//      internal setInterval / repeated fetch would cause remount).
//   6. VIEW-tier grep — no control verbs, no fetch/dispatch.
//   7. Both editions (basic + full) render the tab.
//
// Failure format:
//   DOCTRINE SYNAPSE_TAB VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

function v(msg) { return `DOCTRINE SYNAPSE_TAB VIOLATED: ${msg}` }

const pageSrc    = readSrc('pages/SynapsePage.jsx')
const appSrc     = readSrc('App.jsx')
const topbarSrc  = readSrc('components/TopBar.jsx')
const editionSrc = readSrc('lib/edition.js')


// ── (1) Tab renders in nav + routes ─────────────────────────────────

test('TopBar lists a "Synapse" tab', () => {
  assert.ok(/id:\s*['"]synapse['"],\s*label:\s*['"]Synapse['"]/.test(topbarSrc),
    v('TopBar TABS must include `{ id: "synapse", label: "Synapse" }` '
      + 'so the tab renders in the nav strip.'))
})

// (Prior "Synapse AFTER Event Log" pin retired 2026-09-21 nav
// restructure — the operator inverted the order so Event Log is
// the LAST tab. The replacement pin lives under "Nav restructure"
// below: `TopBar nav order: Synapse immediately LEFT of Event Log,
// Event Log LAST`.)

test('App.jsx routes activeTab="synapse" to <SynapsePage />', () => {
  assert.ok(/import\s+SynapsePage\s+from\s+['"]\.\/pages\/SynapsePage['"]/
              .test(appSrc),
    v('App.jsx must import SynapsePage from ./pages/SynapsePage'))
  assert.ok(/synapse:\s*<SynapsePage\s*\/>/.test(appSrc),
    v('App.jsx layoutMap must map `synapse: <SynapsePage />` — '
      + 'without the entry the tab click would fall through to '
      + 'MonitorDashboard.'))
})


// ── (2) Section counts + (3) labels match the data ──────────────────

test('SynapsePage defines VALVES with exactly 10 entries', () => {
  const m = pageSrc.match(/const VALVES = \[([\s\S]*?)\]/)
  assert.ok(m, v('VALVES array not found'))
  const entries = m[1].match(/\{\s*id:/g) || []
  assert.equal(entries.length, 10,
    v(`VALVES must have 10 entries — found ${entries.length}. `
      + `The mock's pneumatic section is 2 rows of 5.`))
})

test('VALVES types match the mock exactly', () => {
  // Byte-pinned type strings — mock's exact table.
  for (const expected of [
    '5/2 SS', 'HI/LO 3/2 N/C', 'HI/LO 2/2 N/C', 'SPARE 1',
    '5/3', 'HI/LO 3/2 N/O', '5/2 DS', 'SPARE 2',
  ]) {
    // Escape / for regex.
    const esc = expected.replace(/[/]/g, '\\/')
    assert.ok(new RegExp(`type:\\s*['"]${esc}['"]`).test(pageSrc),
      v(`VALVES must include type="${expected}" — mock exact match.`))
  }
})

test('DIGITAL_INPUTS + DIGITAL_OUTPUTS are 10 each; SAFETY is 4', () => {
  // Data-driven with Array.from({length: 10}), so grep-pin the
  // literal lengths.
  assert.ok(
    /const DIGITAL_INPUTS =\s*Array\.from\(\s*\{\s*length:\s*10\s*\}/
      .test(pageSrc),
    v('DIGITAL_INPUTS must be Array.from({length: 10, ...})'))
  assert.ok(
    /const DIGITAL_OUTPUTS =\s*Array\.from\(\s*\{\s*length:\s*10\s*\}/
      .test(pageSrc),
    v('DIGITAL_OUTPUTS must be Array.from({length: 10, ...})'))
  assert.ok(
    /const SAFETY_DEVICES =\s*Array\.from\(\s*\{\s*length:\s*4\s*\}/
      .test(pageSrc),
    v('SAFETY_DEVICES must be Array.from({length: 4, ...})'))
})


// ── (4) `data-io` on every connector glyph ──────────────────────────

test('every connector-glyph component receives dataIo', () => {
  // Grep-pin: each glyph component reads a `dataIo` prop and renders
  // it as a `data-io` DOM attribute. Any glyph that drops the prop
  // would prevent the future live-state binding from finding it.
  for (const comp of ['PneumaticPortGlyph', 'DigitalInputGlyph',
                        'DigitalOutputGlyph', 'SafetyGlyph']) {
    assert.ok(
      new RegExp(`function ${comp}\\([^)]*dataIo[^)]*\\)`).test(pageSrc),
      v(`${comp} must accept a dataIo prop`))
    // And render it via a data-io attribute.
    const compIdx = pageSrc.indexOf(`function ${comp}(`)
    const block   = pageSrc.slice(compIdx, compIdx + 900)
    assert.ok(/data-io=\{dataIo\}/.test(block),
      v(`${comp} must render data-io={dataIo} on its outer span — `
        + `it is the future live-state binding surface.`))
  }
})

test('every card renders a glyph with a data-io that carries its id', () => {
  // Valves each render two pneumatic glyphs (PA/PB).
  assert.ok(/PneumaticPortGlyph dataIo=\{`\$\{valve\.id\}_PA`\}/.test(pageSrc),
    v('Valve card must render <PneumaticPortGlyph dataIo=`{id}_PA` />'))
  assert.ok(/PneumaticPortGlyph dataIo=\{`\$\{valve\.id\}_PB`\}/.test(pageSrc),
    v('Valve card must render <PneumaticPortGlyph dataIo=`{id}_PB` />'))
  // IO + safety glyphs consume the item id directly.
  assert.ok(/<Glyph dataIo=\{item\.id\}/.test(pageSrc),
    v('IoCard must render <Glyph dataIo={item.id} />'))
  assert.ok(/<SafetyGlyph dataIo=\{item\.id\}/.test(pageSrc),
    v('SafetyCard must render <SafetyGlyph dataIo={item.id} />'))
})


// ── (5) Mount-once per navigation ───────────────────────────────────

test('synapse tab is NOT in the kept3D list (normal mount/unmount)', () => {
  // The kept3D list keeps program + 3dview mounted with display:none
  // to preserve the 3D twin. Synapse is a static page — it must NOT
  // be added to that list (would leak DOM + hooks across nav).
  const kept3DMatch = appSrc.match(/const kept3D\s*=\s*\[([^\]]*)\]/)
  assert.ok(kept3DMatch, v('App.jsx must define const kept3D = [...]'))
  const kept3DEntries = kept3DMatch[1]
  assert.equal(/['"]synapse['"]/.test(kept3DEntries), false,
    v('kept3D must NOT contain "synapse" — the page is a normal '
      + 'mount/unmount tab; keeping it mounted would prevent the '
      + 'operator directive\'s "mount-once per navigation" invariant '
      + 'from being verifiable at the source level.'))
})

test('SynapsePage has no setInterval / setTimeout / poll — pure static render', () => {
  // Any recurring timer inside the page would cause React re-renders
  // that risk transient re-mounts of children (which then reset any
  // local state a future live-state binding would rely on). This
  // page is STATIC; it stays that way.
  for (const forbidden of ['setInterval', 'setTimeout']) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`).test(pageSrc), false,
      v(`SynapsePage must not use ${forbidden} — the page is a `
        + `static wiring reference. A later live-state pass MUST `
        + `receive state through props, not by polling here.`))
  }
})


// ── (6) VIEW-tier — no control verbs, no fetch/dispatch ─────────────

test('SynapsePage has no fetch / dispatch / control paths', () => {
  // 2026-09-21 update: the IO section relaxed the "no useStore"
  // rule (SynapsePage now reads `synapseIOSectionOpen` to auto-
  // expand after an old-route redirect). Store READS stay
  // allowed; the CONTROL-tier signals below remain forbidden.
  // Note: IOPortMap does emit fetches — that lives in ITS OWN
  // source (components/IOPortMap.jsx), not this file. The grep
  // is scoped to SynapsePage.jsx and to CODE only (comments
  // narrating the design allow /api/io/live prose without
  // tripping the pin — code path literals still do).
  const codeOnly = _stripComments(pageSrc)
  for (const forbidden of [
    { pat: /\bfetch\s*\(/,           label: 'fetch()' },
    { pat: /dispatchEvent\s*\(/,     label: 'dispatchEvent()' },
    { pat: /\/api\//,                label: '/api/ path literal' },
    { pat: /\/cmd\//,                label: '/cmd/ path literal' },
    { pat: /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
      label: 'POST/PUT/DELETE/PATCH' },
  ]) {
    assert.equal(forbidden.pat.test(codeOnly), false,
      v(`SynapsePage must NOT contain ${forbidden.label} in code — `
        + `VIEW-tier only. Store reads are OK; write paths and `
        + `network calls belong in the components imported here `
        + `(IOPortMap owns its own /api/io fetches).`))
  }
})

// Cheap JSX/JS comment stripper — good enough for grep pins. Strips
// // line comments and /* block */ comments; does NOT try to parse
// string literals. If a future edit puts "/api/" inside a string
// literal in code, that IS a code-path reference and should trip.
function _stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/^\s*\/\/.*$/gm, '')       // full-line // comments
    .replace(/([^:'"`])\/\/.*$/gm, '$1') // trailing // comments
}


// ── (7) Both editions render the tab ────────────────────────────────

test('edition.js declares synapse EDITION_BASIC (both editions render)', () => {
  assert.ok(/synapse:\s*EDITION_BASIC/.test(editionSrc),
    v('edition.js FEATURE_MAP must include synapse: EDITION_BASIC so '
      + 'the tab renders in both editions.'))
  assert.ok(/synapse:\s*['"]synapse['"]/.test(editionSrc),
    v('edition.js TAB_TO_FEATURE must include synapse: "synapse" '
      + 'so the TopBar edition filter resolves the tab.'))
})


// ── Test-surface pins (used by the operator gate script) ────────────

test('SynapsePage has stable testids on page + each section', () => {
  // The section wrappers pass their testid through a `testid` prop
  // (see `function Section({ children, testid })`); direct testids
  // appear on the DOM at runtime but only the string literal is in
  // the source. Grep for the string in either form.
  for (const tid of [
    'synapse-page',
    'synapse-section-pneumatic',
    'synapse-section-io',
    'synapse-section-safety',
    'synapse-valve-card',
    'synapse-io-card-input',
    'synapse-io-card-output',
    'synapse-safety-card',
    'synapse-chip',
  ]) {
    const patterns = [
      new RegExp(`data-testid="${tid}"`),
      new RegExp(`testid="${tid}"`),
      new RegExp(`testid=\\{[^}]*['"]${tid}['"]`),
    ]
    let matched = patterns.some((re) => re.test(pageSrc))
    // Template-literal testids: `synapse-io-card-${kind}` produces
    // `synapse-io-card-input` and `-output` at runtime. Accept the
    // prefix as evidence the DOM will emit the full string.
    if (!matched && tid.startsWith('synapse-io-card-')) {
      matched = /data-testid=\{`synapse-io-card-\$\{kind\}`\}/.test(pageSrc)
    }
    assert.ok(matched,
      v(`SynapsePage must expose testid "${tid}" (as `
        + `data-testid= directly or via a testid prop to a wrapper)`))
  }
})


// ── Nav restructure (2026-09-21): I/O retired, folded into Synapse ──

test('TopBar TABS does NOT contain the retired `io` tab', () => {
  assert.equal(/\{\s*id:\s*['"]io['"]/.test(topbarSrc), false,
    v('TopBar TABS must NOT declare `{ id: "io" ...}` — the I/O tab '
      + 'is retired 2026-09-21; its content lives in the Synapse '
      + 'page\'s expandable section.'))
})

test('TopBar nav order: Synapse immediately LEFT of Event Log, Event Log LAST', () => {
  // Grep the TABS array only (not the whole file — Event Log
  // appears in comments too).
  const arrMatch = topbarSrc.match(/const TABS = \[([\s\S]*?)\]/)
  assert.ok(arrMatch, v('TopBar must declare const TABS = [...]'))
  const arr = arrMatch[1]
  const synIdx = arr.indexOf("id: 'synapse'")
  const evIdx  = arr.indexOf("id: 'event_log'")
  assert.ok(synIdx > 0, v('synapse tab id must be present in TABS'))
  assert.ok(evIdx  > 0, v('event_log tab id must be present in TABS'))
  assert.ok(synIdx < evIdx,
    v(`Synapse must be declared BEFORE Event Log in TABS. `
      + `Found synapse@${synIdx}, event_log@${evIdx}.`))
  // Event Log must be LAST: no other id: '...' entry appears
  // AFTER it in the array body.
  const afterEv = arr.slice(evIdx)
  assert.equal(/id:\s*['"][^'"]+['"]/.test(afterEv.replace(/id:\s*['"]event_log['"]/, '')),
    false,
    v('Event Log must be the LAST tab in TABS — no tab declaration '
      + 'may appear after it.'))
})

test('lib/edition.js TAB_TO_FEATURE has no `io:` entry', () => {
  // The `io_panel` feature key stays in FEATURE_MAP (gates the
  // IOPortMap component itself) — but the io TAB mapping is gone.
  const mapMatch = editionSrc.match(
    /export const TAB_TO_FEATURE = Object\.freeze\(\{([\s\S]*?)\}\)/)
  assert.ok(mapMatch,
    v('lib/edition.js must declare TAB_TO_FEATURE = Object.freeze({...})'))
  const body = mapMatch[1]
  assert.equal(/\bio:\s*['"]io_panel['"]/.test(body), false,
    v('TAB_TO_FEATURE must not include `io: "io_panel"` — the tab '
      + 'is retired. IOPortMap lives inside the Synapse page.'))
})


// ── App-level redirect for stale activeTab === 'io' ────────────────

test('App.jsx redirects activeTab==="io" to synapse + auto-expands', () => {
  assert.ok(/activeTab === ['"]io['"]/.test(appSrc),
    v('App.jsx must contain an `activeTab === "io"` guard. Stale '
      + 'persisted activeTab (localStorage roboai-ui) OR any old '
      + 'link targeting the retired I/O route must land on Synapse.'))
  assert.ok(/setTab\(['"]synapse['"]\)/.test(appSrc),
    v('App.jsx redirect must call setTab("synapse")'))
  assert.ok(/setSynapseIOSectionOpen\(true\)/.test(appSrc),
    v('App.jsx redirect must call setSynapseIOSectionOpen(true) so '
      + 'the section auto-expands after the redirect.'))
})

test('App.jsx layoutMap has no `io:` entry (routing retired)', () => {
  const mapMatch = appSrc.match(/const layoutMap = \{([\s\S]*?)\}\n/)
  assert.ok(mapMatch, v('App.jsx must declare const layoutMap = {...}'))
  assert.equal(/^\s*io:\s*</m.test(mapMatch[1]), false,
    v('App.jsx layoutMap must not declare `io: <IOPage />` — the '
      + 'redirect effect above handles any residual activeTab=io.'))
})


// ── Expandable IO section on the Synapse page ───────────────────────

test('SynapsePage renders the expandable IO section shell', () => {
  for (const tid of [
    'synapse-section-internal-io',
    'synapse-internal-io-toggle',
    'synapse-internal-io-body',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(pageSrc),
      v(`SynapsePage must expose data-testid="${tid}"`))
  }
})

test('Expandable-section title is byte-pinned to the operator directive', () => {
  assert.ok(/Main Internal Robot Controller I\/O/.test(pageSrc),
    v('SynapsePage must render the exact section title '
      + '"Main Internal Robot Controller I/O" — operator directive '
      + 'byte-match.'))
})

test('IO section starts collapsed by default (useState(false))', () => {
  // Grep-pin the initial state literal so nobody flips the default
  // by mutating the useState arg. Auto-open on redirect is handled
  // by a separate effect that reads synapseIOSectionOpen from store
  // then clears it — the DEFAULT for a fresh visit stays false.
  assert.ok(/useState\(false\)/.test(pageSrc),
    v('IO section must start collapsed: useState(false) is required. '
      + 'Auto-expand for the old-route redirect goes through the '
      + 'synapseIOSectionOpen store flag, which the effect clears '
      + 'immediately so subsequent visits stay collapsed.'))
})

test('IOPortMap mounts ONLY when the IO section is expanded', () => {
  // Grep-pin the {ioExpanded && ...IOPortMap} shape. This proves
  // the poll doesn't run while collapsed (IOPortMap owns the 1 Hz
  // /api/io/live poll internally) — mount-once on expand, unmount
  // on collapse.
  assert.ok(/\{ioExpanded && \([\s\S]*?<IOPortMap\s*\/>/s.test(pageSrc),
    v('IOPortMap must render inside `{ioExpanded && (...)}` so it '
      + 'mounts only while the section is open — no fetch traffic '
      + 'while collapsed. Never render it unconditionally here.'))
})

test('IOPortMap is imported once (single source of the IO component)', () => {
  const matches = pageSrc.match(/from ['"]\.\.\/components\/IOPortMap['"]/g) || []
  assert.equal(matches.length, 1,
    v(`SynapsePage must import IOPortMap from ../components/IOPortMap `
      + `exactly once — found ${matches.length}. The IO surface is a `
      + `single component reused verbatim from the retired IOPage.`))
})


// ── I/O-page child inventory pin (every child accounted-for) ────────

test('inventory: IOPage had exactly ONE child, now hosted inside Synapse', () => {
  // The pre-retire IOPage.jsx renders <IOPortMap /> as its only
  // child. This pin proves nothing else was silently dropped when
  // the tab was folded into Synapse. If IOPage evolves to render
  // additional children, this pin will fail and force the mover
  // to explicitly account for every one.
  const ioPagePath = join(FRONT_ROOT, 'src', 'pages', 'IOPage.jsx')
  const ioPageSrc  = readFileSync(ioPagePath, 'utf8')
  // The JSX contents live between the outer <div ...> and </div>.
  // Grep for other component tags — IOPortMap is the only expected
  // component reference in the rendered tree.
  const jsxTagPattern = /<([A-Z][A-Za-z0-9_]*)\b/g
  const rendered = new Set()
  let m
  while ((m = jsxTagPattern.exec(ioPageSrc)) !== null) {
    rendered.add(m[1])
  }
  const componentTags = Array.from(rendered).sort()
  assert.deepEqual(componentTags, ['IOPortMap'],
    v(`IOPage must render exactly [IOPortMap]. Found `
      + `[${componentTags.join(', ')}]. If a new child appears here `
      + `it must be relocated with a reason during the nav-restructure `
      + `session — nothing silent.`))
  // And IOPortMap MUST be the one mounted inside SynapsePage.
  assert.ok(/from ['"]\.\.\/components\/IOPortMap['"]/.test(pageSrc),
    v('SynapsePage must import IOPortMap — the ONLY child of the '
      + 'retired IOPage — so functional parity is preserved.'))
})
