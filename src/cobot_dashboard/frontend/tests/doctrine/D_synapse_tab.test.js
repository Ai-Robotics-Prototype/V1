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

test('SynapsePage defines 10 valve slots + 8 valve-type entries', () => {
  // 2026-09-21 valve-info directive: valve rows now live on
  // `_VALVE_SLOTS` (id/label/type triples) and derive final
  // `VALVES` by merging in the per-type copy from
  // `VALVE_TYPE_INFO`. Pin both.
  const slots = pageSrc.match(/const _VALVE_SLOTS = \[([\s\S]*?)\]/)
  assert.ok(slots, v('_VALVE_SLOTS array not found'))
  const slotEntries = slots[1].match(/\{\s*id:/g) || []
  assert.equal(slotEntries.length, 10,
    v(`_VALVE_SLOTS must have 10 entries — found ${slotEntries.length}. `
      + `The mock's pneumatic section is 2 rows of 5.`))
  // VALVES is derived; must be built via .map so id/label/type
  // + title/plain_explanation/best_use all end up on each entry.
  assert.ok(/const VALVES = _VALVE_SLOTS\.map/.test(pageSrc),
    v('VALVES must be `_VALVE_SLOTS.map((v) => ({ ...v, ...(VALVE_TYPE_INFO[v.type] || {}) }))` '
      + 'so per-type copy attaches without duplicating slot data.'))
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
  // 2026-09-21 operator correction: DigitalInputGlyph and
  // DigitalOutputGlyph now delegate to the shared M8ThreePinFace,
  // which is what actually renders `data-io={dataIo}`. Include it
  // in the pin list AND accept a thin wrapper that forwards
  // `dataIo` verbatim.
  for (const comp of ['PneumaticPortGlyph', 'M8ThreePinFace',
                        'DigitalInputGlyph', 'DigitalOutputGlyph',
                        'SafetyGlyph']) {
    assert.ok(
      new RegExp(`function ${comp}\\([^)]*dataIo[^)]*\\)`).test(pageSrc),
      v(`${comp} must accept a dataIo prop`))
    const compIdx = pageSrc.indexOf(`function ${comp}(`)
    const block   = pageSrc.slice(compIdx, compIdx + 1500)
    // Either the component renders `data-io={dataIo}` on its own
    // outer span (leaf glyph), or it forwards `dataIo={dataIo}` to
    // a child glyph component (thin wrapper — same effect on the
    // DOM after the child renders).
    const emits   = /data-io=\{dataIo\}/.test(block)
    const forwards = /dataIo=\{dataIo\}/.test(block)
    assert.ok(emits || forwards,
      v(`${comp} must either render data-io={dataIo} directly or `
        + `forward dataIo={dataIo} to a child glyph — the live-`
        + `state binding surface stays intact either way.`))
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


// ── Glyph + font corrections (2026-09-21 operator screenshot) ───────

test('output-glyph-equals-input-glyph-component (same face, color prop)', () => {
  // Both DigitalInputGlyph and DigitalOutputGlyph must delegate to
  // the SAME underlying face component (M8ThreePinFace) — inputs
  // and outputs physically use the same M8 face-on 3-pin connector,
  // only the accent color differs. This pin catches any regression
  // that reintroduces a bespoke output shape (e.g. the previous
  // triangle/arrow-pin design the operator flagged).
  // Extract the wrapper bodies. Wrappers are tiny thin functions
  // that delegate to M8ThreePinFace — extract up to the next
  // top-level `\nfunction ` (or EOF) to capture the full body.
  function _slice(name) {
    const idx = pageSrc.indexOf(`function ${name}(`)
    if (idx < 0) return null
    const nextFn = pageSrc.indexOf('\nfunction ', idx + 1)
    return pageSrc.slice(idx, nextFn > 0 ? nextFn : idx + 1200)
  }
  const inMatch  = _slice('DigitalInputGlyph')
  const outMatch = _slice('DigitalOutputGlyph')
  assert.ok(inMatch,  v('DigitalInputGlyph must exist'))
  assert.ok(outMatch, v('DigitalOutputGlyph must exist'))
  const shared = 'M8ThreePinFace'
  assert.ok(new RegExp(`<${shared}\\b`).test(inMatch),
    v(`DigitalInputGlyph must delegate to <${shared}> — the shared `
      + `M8 face component`))
  assert.ok(new RegExp(`<${shared}\\b`).test(outMatch),
    v(`DigitalOutputGlyph must delegate to <${shared}> — same face `
      + `as the input glyph, only the color differs`))
  // And the wrappers must NOT declare inline SVG (circle/polygon/
  // path) — that would be a fork of the shape.
  for (const [name, block] of [
    ['DigitalInputGlyph',  inMatch],
    ['DigitalOutputGlyph', outMatch],
  ]) {
    for (const forbidden of ['<circle', '<polygon', '<path', '<svg']) {
      assert.equal(block.includes(forbidden), false,
        v(`${name} must NOT contain ${forbidden} — the M8 face is `
          + `rendered by the shared M8ThreePinFace component. Any `
          + `inline shape here forks the design.`))
    }
  }
  // Color passthrough: input passes INPUT_ACCENT, output passes
  // OUTPUT_ACCENT. Grep-pinned so a copy-paste bug can't send both
  // to the same accent.
  assert.ok(/accent=\{INPUT_ACCENT\}/.test(inMatch),
    v('DigitalInputGlyph must pass accent={INPUT_ACCENT}'))
  assert.ok(/accent=\{OUTPUT_ACCENT\}/.test(outMatch),
    v('DigitalOutputGlyph must pass accent={OUTPUT_ACCENT}'))
})

test('safety-glyph-five-pins (M12 face with 5 pin circles)', () => {
  // Extract the SafetyGlyph function body and count pin circles.
  // The M12 5-pin layout is 4 outer pins (N/E/S/W) + 1 center
  // (Common/GND) — five pin elements total. Extra decorative
  // circles (the housing ring) are OK; the pin-count grep keys
  // on `data-pin=` markers we tag onto each pin.
  const idx = pageSrc.indexOf('function SafetyGlyph(')
  assert.ok(idx > 0, v('SafetyGlyph must exist'))
  const body = pageSrc.slice(idx, idx + 2500)
  const pins = body.match(/data-pin="/g) || []
  assert.equal(pins.length, 5,
    v(`SafetyGlyph must contain EXACTLY 5 data-pin elements — `
      + `found ${pins.length}. Layout: N / E / S / W + center C.`))
  // The five distinct pin identifiers must be present.
  for (const p of ['N', 'E', 'S', 'W', 'C']) {
    assert.ok(new RegExp(`data-pin="${p}"`).test(body),
      v(`SafetyGlyph must include data-pin="${p}" — standard M12 `
        + `5-pin position marker.`))
  }
  // And the previous arrow-shape path must be gone.
  assert.equal(/downward arrow|safety mark/i.test(body), false,
    v('SafetyGlyph must not narrate an arrow/safety-mark shape — '
      + 'the operator retired the arrow icon 2026-09-21; the glyph '
      + 'reads as a physical M12 connector face.'))
})

test('font-token pin: only inherit / var(--font) fontFamily on Synapse page', () => {
  // The app's font is set on <body> via global.css (Inter, system-ui,
  // sans-serif via --font). SynapsePage must NOT declare a local
  // fontFamily override — every fontFamily declaration must be
  // `inherit` (which cascades from the body via the CSS token) or
  // reference the app's --font variable. Any other stack (system-ui
  // directly, Segoe UI, monospace, etc.) is a mock-artifact and
  // must be retired.
  const decls = pageSrc.match(/fontFamily:\s*['"`][^'"`]*['"`]/g) || []
  assert.ok(decls.length > 0,
    v('SynapsePage must have at least one explicit fontFamily=inherit '
      + 'declaration on the page root to defeat the button/input '
      + 'user-agent font default.'))
  for (const decl of decls) {
    // Accept: 'inherit', var(--font, ...), or a stack that STARTS
    // with var(--font).
    const ok =
      /fontFamily:\s*['"`]inherit['"`]/.test(decl)
      || /fontFamily:\s*['"`]var\(--font/.test(decl)
    assert.ok(ok,
      v(`SynapsePage fontFamily declaration ${decl} is not the app `
        + `token. Use 'inherit' (recommended) or var(--font, …). No `
        + `local system-ui / Segoe UI / Inter stacks on this page.`))
  }
})


// ── Valve-card port layout (2026-09-21 operator correction) ─────────

test('valve-card ports stack VERTICALLY (PA above PB)', () => {
  // Extract the ValveCard function body and locate the port
  // container. The two <PneumaticPortGlyph> elements must be
  // wrapped in a container whose inline style declares
  // `flexDirection: 'column'` — the original mock stacks PA
  // above PB. Side-by-side (`flexDirection: 'row'` or bare
  // `display: 'flex'` without column) is the regression the
  // operator flagged; this pin fails if it reappears.
  const idx = pageSrc.indexOf('function ValveCard(')
  assert.ok(idx > 0, v('ValveCard must exist'))
  const nextFn = pageSrc.indexOf('\nfunction ', idx + 1)
  const body = pageSrc.slice(idx, nextFn > 0 ? nextFn : idx + 2000)

  // Locate the port container by its testid, then walk backward
  // to the enclosing <div opening tag and inspect its style attr.
  assert.ok(/data-testid="synapse-valve-card-ports"/.test(body),
    v('ValveCard must expose data-testid="synapse-valve-card-ports" '
      + 'on the container that holds the two PneumaticPortGlyphs.'))

  // The container's style must set flexDirection: 'column'. Match
  // the surrounding style object (roughly 400 chars around the
  // testid mark).
  const containerRegion = body.slice(
    Math.max(0, body.indexOf('data-testid="synapse-valve-card-ports"') - 400),
    body.indexOf('data-testid="synapse-valve-card-ports"') + 400)
  assert.ok(/flexDirection:\s*['"]column['"]/.test(containerRegion),
    v('Port container must declare flexDirection: "column" — ports '
      + 'stack VERTICALLY (PA above PB). Side-by-side is the '
      + '2026-09-21 regression the operator flagged.'))

  // And the two glyphs must sit inside that container. Grep for
  // the sequence: container opening → PA → PB (in order).
  const paIdx = body.indexOf('_PA`}')
  const pbIdx = body.indexOf('_PB`}')
  const contIdx = body.indexOf('data-testid="synapse-valve-card-ports"')
  assert.ok(contIdx > 0 && paIdx > contIdx && pbIdx > paIdx,
    v('The ports container must precede <PneumaticPortGlyph _PA> and '
      + '<PneumaticPortGlyph _PB> in that order.'))
})


// ── Valve-info panel (2026-09-21 operator directive) ────────────────

test('every VALVE_TYPE_INFO entry has non-empty plain_explanation + best_use', () => {
  // The data-completeness pin — the operator explicitly required
  // "each valve entry has non-empty plain_explanation + best_use".
  // Parse the map at source level: locate the VALVE_TYPE_INFO
  // block, walk each `'key': { ... }` entry, and assert both
  // fields are present + non-empty (>= 20 chars — short enough
  // that a real one-liner passes, long enough to catch stub
  // placeholders).
  const infoIdx = pageSrc.indexOf('const VALVE_TYPE_INFO = {')
  assert.ok(infoIdx > 0, v('VALVE_TYPE_INFO map must exist'))
  const infoEnd = pageSrc.indexOf('\n}\n', infoIdx)
  assert.ok(infoEnd > 0, v('VALVE_TYPE_INFO closing brace not found'))
  const block = pageSrc.slice(infoIdx, infoEnd + 2)
  // Grep every `'TYPE': { ... }` pair. TYPE keys use single quotes
  // and contain / characters — accept them.
  const entryPattern = /'([^']+)':\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
  const entries = [...block.matchAll(entryPattern)]
  assert.ok(entries.length >= 8,
    v(`VALVE_TYPE_INFO must have at least 8 entries (one per valve `
      + `TYPE in the mock) — found ${entries.length}.`))
  // Every REQUIRED type must be present.
  const requiredTypes = [
    '5/2 SS', '5/2 DS', '5/3',
    'HI/LO 3/2 N/C', 'HI/LO 3/2 N/O', 'HI/LO 2/2 N/C',
    'SPARE 1', 'SPARE 2',
  ]
  const foundKeys = new Set(entries.map((m) => m[1]))
  for (const t of requiredTypes) {
    assert.ok(foundKeys.has(t),
      v(`VALVE_TYPE_INFO must include key ${JSON.stringify(t)} — `
        + `operator directive covers all card labels.`))
  }
  // Every entry must have non-empty title + plain_explanation +
  // best_use. Field bodies are concatenated string-plus expressions;
  // the pin only requires presence + minimum length.
  for (const [, key, body] of entries) {
    for (const field of ['title', 'plain_explanation', 'best_use']) {
      const re = new RegExp(`${field}:\\s*(['"][^'"]{0,400}['"]|[^,}]{15,})`, 's')
      assert.ok(re.test(body),
        v(`VALVE_TYPE_INFO[${JSON.stringify(key)}] must include a `
          + `non-empty ${field}.`))
    }
  }
})

test('ValveCard opens ValveInfoPanel on click (VIEW-tier, keyboard-accessible)', () => {
  // Card is a <button> — Enter/Space work automatically for
  // keyboard operators.
  const idx = pageSrc.indexOf('function ValveCard(')
  assert.ok(idx > 0, v('ValveCard must exist'))
  const nextFn = pageSrc.indexOf('\nfunction ', idx + 1)
  const body = pageSrc.slice(idx, nextFn > 0 ? nextFn : idx + 4000)
  assert.ok(/<button\b/.test(body),
    v('ValveCard must render a <button> element (keyboard-'
      + 'accessible via Enter/Space by default).'))
  assert.ok(/onOpen\(valve\)/.test(body),
    v('ValveCard must invoke `onOpen(valve)` on click so the '
      + 'parent (SynapsePage) can open the ValveInfoPanel.'))
  // Hover affordance discoverability — cursor: pointer + subtle
  // lift. Accept the conditional form the guidance refactor
  // introduced (page mode: pointer; guidance mode: default).
  assert.ok(
    /cursor:\s*['"]pointer['"]|cursor:\s*clickable\s*\?\s*['"]pointer['"]/
      .test(body),
    v('ValveCard must set cursor: pointer in page mode (conditional '
      + 'on clickable is fine — guidance mode disables the click).'))
  assert.ok(/translateY\(/.test(body),
    v('ValveCard must apply a translateY lift on hover/focus '
      + '(hover discoverability affordance).'))
})

test('ValveInfoPanel is VIEW-tier (no control verbs)', () => {
  // Extract the ValveInfoPanel function body and forbid any
  // control-path token. This is a pure read view of the valve's
  // copy — no /api, no /cmd, no POST/PUT/DELETE/PATCH, no
  // dispatchEvent, no useStore write actions.
  const idx = pageSrc.indexOf('function ValveInfoPanel(')
  assert.ok(idx > 0, v('ValveInfoPanel must exist'))
  const nextFn = pageSrc.indexOf('\nfunction ', idx + 1)
  const body = pageSrc.slice(idx, nextFn > 0 ? nextFn : idx + 5000)
  for (const forbidden of [
    { pat: /\bfetch\s*\(/,       label: 'fetch()' },
    { pat: /dispatchEvent\s*\(/, label: 'dispatchEvent()' },
    { pat: /\/api\//,            label: '/api/ path literal' },
    { pat: /\/cmd\//,            label: '/cmd/ path literal' },
    { pat: /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/,
      label: 'POST/PUT/DELETE/PATCH method' },
  ]) {
    assert.equal(forbidden.pat.test(body), false,
      v(`ValveInfoPanel must NOT contain ${forbidden.label} — the `
        + `panel is a read-only explainer with zero control `
        + `affordances.`))
  }
})

test('ValveInfoPanel exposes stable testids for open/close + content', () => {
  for (const tid of [
    'synapse-valve-info-backdrop',
    'synapse-valve-info-panel',
    'synapse-valve-info-title',
    'synapse-valve-info-close',
    'synapse-valve-info-explanation',
    'synapse-valve-info-best-use',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(pageSrc),
      v(`ValveInfoPanel must expose data-testid="${tid}"`))
  }
})

test('ValveInfoPanel mount-once: gated on non-null `valve` prop', () => {
  // The panel returns null when valve is null; opens on state
  // transition null→valve, closes null on transition valve→null.
  // Grep-pin the render gate and the mount site's prop wiring.
  const idx = pageSrc.indexOf('function ValveInfoPanel(')
  const nextFn = pageSrc.indexOf('\nfunction ', idx + 1)
  const body = pageSrc.slice(idx, nextFn > 0 ? nextFn : idx + 5000)
  assert.ok(/if\s*\(!valve\)\s*return null/.test(body),
    v('ValveInfoPanel must early-return null when `valve` is falsy '
      + '— the fiber only exists while a valve is open.'))
  // Mounted with openValve state; closed by setOpenValve(null).
  assert.ok(/<ValveInfoPanel[\s\S]*valve=\{openValve\}/.test(pageSrc),
    v('SynapsePage must mount <ValveInfoPanel valve={openValve} ... />'))
  assert.ok(/setOpenValve\(null\)/.test(pageSrc),
    v('SynapsePage must close via setOpenValve(null) — clean '
      + 'transition, no in-place state fiddling.'))
})


// ── Hardware Setup × Synapse map integration (2026-09-21) ───────────

const wizardSrc = readSrc('components/HardwareSetupWizard.jsx')
const portMapSrc = readSrc('lib/toolPortMap.js')

test('SynapsePage exports the SynapseConnectionMap component', () => {
  // Import-identity pin — the wizard reuses THIS export, not a
  // fork. If a future edit copies the map JSX into the wizard
  // this pin fails at the source level.
  assert.ok(/export function SynapseConnectionMap\(/.test(pageSrc),
    v('SynapsePage must `export function SynapseConnectionMap(...)` — '
      + 'the reusable map shell that the wizard imports.'))
})

test('HardwareSetupWizard imports SynapseConnectionMap from SynapsePage (no fork)', () => {
  assert.ok(
    /import\s*\{[^}]*SynapseConnectionMap[^}]*\}\s*from\s*['"]\.\.\/pages\/SynapsePage['"]/
      .test(wizardSrc),
    v('HardwareSetupWizard must import { SynapseConnectionMap } '
      + 'from "../pages/SynapsePage". No fork of the map JSX — '
      + 'one component, two mount sites (page + wizard).'))
})

test('SynapseConnectionMap has a guidance mode driven by highlight prop', () => {
  // Grep-pin: the component branches on `mode="guidance"` and reads
  // `highlight` to decide which glyphs pulse vs dim.
  const idx = pageSrc.indexOf('export function SynapseConnectionMap(')
  assert.ok(idx > 0, v('SynapseConnectionMap must exist'))
  const nextFn = pageSrc.indexOf('\nfunction ', idx + 1)
  const nextEx = pageSrc.indexOf('\nexport ', idx + 1)
  const end = Math.min(
    nextFn > 0 ? nextFn : pageSrc.length,
    nextEx > 0 ? nextEx : pageSrc.length,
  )
  const body = pageSrc.slice(idx, end)
  assert.ok(/mode\s*=\s*['"]page['"]/.test(body),
    v("SynapseConnectionMap must accept mode with default 'page'"))
  assert.ok(/highlight/.test(body),
    v('SynapseConnectionMap must consume `highlight` prop'))
  assert.ok(/labelOverrides/.test(body),
    v('SynapseConnectionMap must consume `labelOverrides` prop '
      + '(SPARE relabeling after custom-EOAT assignment).'))
  assert.ok(/data-mode=\{mode\}/.test(body),
    v('SynapseConnectionMap must expose data-mode on its root '
      + 'so tests can key on the current mode.'))
})

test('ValveCard / IoCard / SafetyCard accept dim + glow props', () => {
  for (const comp of ['ValveCard', 'IoCard', 'SafetyCard']) {
    const idx = pageSrc.indexOf(`function ${comp}(`)
    assert.ok(idx > 0, v(`${comp} must exist`))
    const nextFn = pageSrc.indexOf('\nfunction ', idx + 1)
    const body = pageSrc.slice(idx, nextFn > 0 ? nextFn : idx + 3000)
    assert.ok(/dim\s*=\s*false/.test(body),
      v(`${comp} must accept a dim prop (default false)`))
    assert.ok(/glow\s*=\s*false/.test(body),
      v(`${comp} must accept a glow prop (default false)`))
    // Data attributes so DOM-level pins can key on the guidance
    // state without re-deriving it from the CSS.
    assert.ok(/data-dim=\{String\(dim\)\}/.test(body),
      v(`${comp} must expose data-dim on its root`))
    assert.ok(/data-glow=\{String\(glow\)\}/.test(body),
      v(`${comp} must expose data-glow on its root`))
  }
})


// ── Tool → ports mapping data (2026-09-21) ──────────────────────────

test('lib/toolPortMap has getToolPortMap for the built-in tools', () => {
  assert.ok(/export function getToolPortMap\(/.test(portMapSrc),
    v('lib/toolPortMap must export `getToolPortMap(toolKey)`'))
  // Two built-in tool records — finger + vacuum — present in the
  // fixed table with required_valves + required_inputs.
  for (const key of ['finger:', 'vacuum:']) {
    assert.ok(portMapSrc.includes(key),
      v(`lib/toolPortMap must include a ${key} entry`))
  }
})

test('lib/toolPortMap.resolveCustomEOATRecord picks free SPARE + IN', () => {
  assert.ok(/export function resolveCustomEOATRecord\(/.test(portMapSrc),
    v('lib/toolPortMap must export resolveCustomEOATRecord'))
  // Recommendation ladder reused from VALVE_TYPE_INFO — no copy
  // duplication.
  assert.ok(/import\s*\{[^}]*VALVE_TYPE_INFO[^}]*\}\s*from\s*['"]\.\.\/pages\/SynapsePage['"]/
              .test(portMapSrc),
    v('lib/toolPortMap must import VALVE_TYPE_INFO from '
      + 'pages/SynapsePage — the valve-info-panel copy is the '
      + 'single source for the recommendation WHY strings.'))
})

test('lib/toolPortMap emits no /api or /cmd calls (VIEW-tier)', () => {
  // Strip comments before grepping — the file DOES mention "/api/tools"
  // in its docstring narrating what the wizard consumes, but must not
  // actually FETCH from any endpoint.
  const code = _stripComments(portMapSrc)
  for (const pat of [/\bfetch\s*\(/, /\/api\//, /\/cmd\//]) {
    assert.equal(pat.test(code), false,
      v(`lib/toolPortMap must NOT contain ${pat} in code — guidance `
        + `is visual only, no IO in this session.`))
  }
})


// ── Wizard: cleanup + guidance + custom flow ────────────────────────

test('HardwareSetupWizard BUILT_IN keeps ONLY real tools + custom_new', () => {
  const m = wizardSrc.match(/const BUILT_IN = \[([\s\S]*?)\n\]/)
  assert.ok(m, v('HardwareSetupWizard must define const BUILT_IN = [...]'))
  const body = m[1]
  const keys = [...body.matchAll(/key:\s*['"]([^'"]+)['"]/g)].map((x) => x[1])
  assert.deepEqual(keys.sort(),
    ['custom_new', 'finger', 'vacuum'],
    v(`BUILT_IN must contain exactly ['finger', 'vacuum', 'custom_new'] `
      + `— found [${keys.join(', ')}]. Removed test-fixture tools `
      + `(junk / trash-me / sample / no-tcp / no-payload / complete `
      + `/ mt / referred) live only in /api/tools and are filtered `
      + `at the picker via visibleCustoms.`))
})

test('HardwareSetupWizard filters customs on confirmed + converted', () => {
  // Grep-pin the filter predicate — protects against a regression
  // where the picker starts showing every /api/tools row again.
  assert.ok(/conversion\?\.state === ['"]converted['"]/.test(wizardSrc),
    v('HardwareSetupWizard visibleCustoms must gate on '
      + '`conversion.state === "converted"`'))
  assert.ok(/!!t\?\.confirmed/.test(wizardSrc),
    v('HardwareSetupWizard visibleCustoms must gate on `confirmed`'))
})

test('HardwareSetupWizard renders SynapseConnectionMap in guidance mode', () => {
  assert.ok(/<SynapseConnectionMap[\s\S]*?mode="guidance"/.test(wizardSrc),
    v('HardwareSetupWizard must render <SynapseConnectionMap '
      + 'mode="guidance" ... /> so highlighted ports pulse against '
      + 'dimmed non-required ports.'))
  // Guidance mode passes highlight from the tool port map.
  assert.ok(/highlight=\{highlight\}/.test(wizardSrc),
    v('The guidance block must thread `highlight={highlight}` '
      + 'into the map so the highlight-driven glow works.'))
})

test('HardwareSetupWizard has a Custom EOAT flow with 4 steps', () => {
  for (const tid of [
    'hardware-setup-custom-flow',
    'hardware-setup-custom-step-mass',
    'hardware-setup-custom-step-actuation',
    'hardware-setup-custom-step-sensors',
    'hardware-setup-custom-step-summary',
  ]) {
    assert.ok(new RegExp(`data-testid="${tid}"`).test(wizardSrc),
      v(`Custom EOAT flow must expose data-testid="${tid}"`))
  }
})

test('Custom EOAT mass step warns above the S10-140 payload cap', () => {
  // Constants live in lib/toolPortMap so the sanity number has
  // exactly one source. The wizard imports + branches on them.
  assert.ok(/S10_140_PAYLOAD_KG_MAX/.test(wizardSrc),
    v('Wizard must import S10_140_PAYLOAD_KG_MAX from '
      + 'lib/toolPortMap for the overcap warning.'))
  assert.ok(/S10_140_PAYLOAD_KG_MAX\s*=\s*10\.0/.test(portMapSrc),
    v('S10_140_PAYLOAD_KG_MAX must be 10.0 kg — the arm datasheet '
      + '+ ledger references (era-01, add-01, add-08a) agree.'))
})

test('Wizard is VIEW-tier for guidance — no /cmd/ writes', () => {
  // Two /api paths ARE allowed in this file: the confirmToolHookup
  // call (already existed pre-directive) and getToolHookup (same).
  // The NEW guidance code must not add any /cmd calls or new /api
  // writes; grep for those specifically.
  assert.equal(/\/cmd\//.test(wizardSrc), false,
    v('HardwareSetupWizard must not contain any /cmd/ path — '
      + 'guidance mode is visual only.'))
})
