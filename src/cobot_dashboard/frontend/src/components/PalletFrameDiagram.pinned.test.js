// PalletFrameDiagram — shared component pinned tests. Directive
// (2026-07-31): the diagram must render prominently on the teach
// screen for every pallet-frame teach step, with the correct target
// highlighted; taught / untaught points visually distinguished; ROW /
// COL axis labels; caption per point; SAME component in wizard +
// editor (no fork).
//
// Source-level pins — the file's textual structure is the contract
// the wizard host and the editor host both rely on. Real JSX render
// tests would need a jsdom + babel/register setup we don't have wired
// up yet (see NumericField.test.js note).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { teachLayoutMetrics, TEACH_FIXED_HEIGHT } from '../lib/teachLayout.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const diagramPath = path.resolve(__dirname, 'PalletFrameDiagram.jsx')
const source      = fs.readFileSync(diagramPath, 'utf8')

const editorPath  = path.resolve(__dirname, 'ProgramEditor.jsx')
const editorSrc   = fs.readFileSync(editorPath, 'utf8')

const wizardPath  = path.resolve(__dirname, 'ProgramWizard.jsx')
const wizardSrc   = fs.readFileSync(wizardPath, 'utf8')


// ── No-fork guarantee ────────────────────────────────────────────

test('diagram lives in a shared component file (not inlined per host)', () => {
  // The definition is exported so both hosts can import it.
  assert.ok(/export default function PalletFrameDiagram\s*\(/.test(source),
    'PalletFrameDiagram must be the file\'s default export — one '
    + 'component, all hosts.')
})

test('wizard host imports the shared diagram (not a private copy)', () => {
  assert.ok(
    /import\s+PalletFrameDiagram\s+from\s+['"]\.\/PalletFrameDiagram['"]/.test(wizardSrc),
    'ProgramWizard must import PalletFrameDiagram from the shared '
    + 'module — no local re-definition.')
  // Guard against silent forks: the wizard file no longer defines
  // its own PalletFrameDiagram function.
  assert.equal(
    /function PalletFrameDiagram\s*\(/.test(wizardSrc), false,
    'ProgramWizard must NOT define its own PalletFrameDiagram — that '
    + 'is a fork of the shared component.')
})

test('editor host imports the shared diagram', () => {
  assert.ok(
    /import\s+PalletFrameDiagram\s+from\s+['"]\.\/PalletFrameDiagram['"]/.test(editorSrc),
    'ProgramEditor must import PalletFrameDiagram from the shared '
    + 'module so its teach overlay renders the same UI as the wizard.')
})


// ── Target-cell highlighting per role ────────────────────────────
// The diagram's contract: for a given role, exactly one grid cell
// gets highlighted, and a specific corner marker becomes the active
// target dot.

test('diagram maps each of the 4 roles to a target cell', () => {
  const block = source.match(/ROLE_TARGET_CELL\s*=\s*\{[\s\S]*?\}/)
  assert.ok(block, 'ROLE_TARGET_CELL map must exist for role→cell lookup')
  const body = block[0]
  assert.ok(/pallet_c1:\s*\(R,\s*C\)\s*=>\s*\[0,\s*0\]/.test(body),
    '① must target cell [0,0]')
  assert.ok(/pallet_c2:\s*\(R,\s*C\)\s*=>\s*\[0,\s*C\s*-\s*1\]/.test(body),
    '② must target cell [0, C-1] — end of the first row')
  assert.ok(/pallet_c3:\s*\(R,\s*C\)\s*=>\s*\[R\s*-\s*1,\s*0\]/.test(body),
    '③ must target cell [R-1, 0] — end of the first column')
  assert.ok(/pallet_part:\s*\(R,\s*C\)\s*=>\s*\[0,\s*0\]/.test(body),
    '④ (first part) must center in cell [0,0]')
})

test('diagram emits data-testid for the ACTIVE target per role', () => {
  // Corner dots + part group both carry role-scoped testids so the
  // pinned tests can assert exactly one target is highlighted.
  for (const role of ['pallet_c1', 'pallet_c2', 'pallet_c3', 'pallet_part']) {
    assert.ok(
      source.includes(`pallet-diagram-target-${role}`)
        || source.includes(`\${key}`),   // template literal path
      `diagram must expose a data-testid for the active target on ${role}`)
  }
})

test('diagram emits data-testid for taught vs untaught corners', () => {
  assert.ok(source.includes('pallet-diagram-taught-'),
    'taught points must be tagged distinctly so the pinned tests '
    + 'can assert green vs hollow dots')
  assert.ok(source.includes('pallet-diagram-untaught-'),
    'upcoming untaught points must also carry a stable testid so '
    + 'the operator-facing visual contract is testable')
})


// ── Frame status wiring (green vs hollow dots) ───────────────────

test('diagram consumes palletFrameStatus() booleans via `frameStatus` prop', () => {
  // The wire-through: taughtMapFor(frameStatus) → corner-key booleans.
  assert.ok(/function taughtMapFor\(frameStatus\)/.test(source),
    'taughtMapFor helper must exist to map frameStatus → per-role taught flags')
  assert.ok(/frameStatus\.corner1/.test(source),
    'diagram must consume frameStatus.corner1 (the shared resolver key)')
  assert.ok(/frameStatus\.corner2/.test(source))
  assert.ok(/frameStatus\.corner3/.test(source))
  assert.ok(/frameStatus\.part/.test(source),
    'diagram must consume frameStatus.part for the ④ dot')
})


// ── Axis labels + captions ───────────────────────────────────────

test('diagram renders ROW → and COL ↓ axis labels in large size', () => {
  // Only visible in size='large' (the teach overlay). Keeps the
  // small wizard-inline variant tidy.
  assert.ok(/ROW\s*→/.test(source),
    'diagram must render "ROW →" axis label so the operator sees '
    + 'the row direction match the configured fill order')
  assert.ok(/COL\s*↓/.test(source),
    'diagram must render "COL ↓" axis label')
})

test('diagram renders a plain-language caption per role', () => {
  const block = source.match(/ROLE_CAPTION\s*=\s*\{[\s\S]*?\}/)
  assert.ok(block, 'ROLE_CAPTION map must define one caption per role')
  const body = block[0]
  for (const role of ['pallet_c1', 'pallet_c2', 'pallet_c3', 'pallet_part']) {
    assert.ok(new RegExp(`${role}:\\s*['\"\`]`).test(body),
      `caption missing for role ${role}`)
  }
  // Directive: "Touch the pallet corner at the far end of the first row"
  assert.ok(/far end of the first row/.test(body),
    'the ② caption must reference the "far end of the first row" '
    + '(matches the directive\'s example wording)')
})


// ── Editor overlay mounts the diagram in a visible band ──────────

test('editor overlay renders the diagram as a SIDE PANEL (not a band)', () => {
  // The 2026-07-31 layout invariant: diagram docks BESIDE the jog
  // pads, never above them — every jog button + Record Position
  // must stay visible without scrolling. See:
  //   * data-testid="teach-body-row"     → the flex-row wrapper.
  //   * data-testid="pallet-diagram-side" → the fixed-width panel.
  // The old band testid (pallet-diagram-band) MUST NOT reappear;
  // a full-width band above the jog pads is what broke the layout.
  assert.ok(editorSrc.includes('data-testid="teach-body-row"'),
    'TeachOverlay must wrap jog + diagram in a flex-row body so '
    + 'they render side-by-side, not stacked.')
  assert.ok(editorSrc.includes('data-testid="pallet-diagram-side"'),
    'Diagram must mount inside a data-testid="pallet-diagram-side" '
    + 'panel — the docked side column.')
  assert.equal(editorSrc.includes('data-testid="pallet-diagram-band"'), false,
    'The old full-width band was retired for the side-panel layout. '
    + 'Reintroducing it would push jog controls below the fold — '
    + 'the exact regression this pin exists to prevent.')
})

test('editor overlay passes size="large" to the diagram', () => {
  // Large size is what makes the diagram legible at arm's length
  // in the teach flow. The wizard-inline default stays 'small'.
  assert.ok(/size=['"`]large['"`]/.test(editorSrc),
    'TeachOverlay must render the diagram at size="large" so the '
    + 'operator can read it at arm\'s length on the tablet.')
})

test('editor overlay passes rows/cols/fillOrder + frameStatus to the diagram', () => {
  // Rows/cols/fillOrder come from currentProgram.config; frameStatus
  // is the SHARED resolver output — the same one the row badge reads.
  for (const prop of ['rows=', 'cols=', 'fillOrder=', 'frameStatus=']) {
    assert.ok(editorSrc.includes(prop),
      `TeachOverlay must pass ${prop.slice(0, -1)} to <PalletFrameDiagram>`)
  }
  assert.ok(/frameStatus=\{[^}]*palletFrameStatus\(currentProgram\)/.test(editorSrc)
    || /const frameStatus = palletFrameStatus\(currentProgram\)/.test(editorSrc),
    'frameStatus must be derived from palletFrameStatus(currentProgram) '
    + '— the SAME resolver the pallet row badge uses.')
})

test('editor overlay accepts a diagram prop that renders when non-null', () => {
  // Signature pin: the overlay function accepts `diagram` and gates
  // the band on it. If someone removes the prop, both tests below fail
  // AND the operator-facing behavior regresses in lock-step.
  assert.ok(/function TeachOverlay\(\{[^}]*\bdiagram\b/.test(editorSrc),
    'TeachOverlay must accept a `diagram` prop')
  assert.ok(/\{diagram && \(/.test(editorSrc),
    'TeachOverlay must render the band conditionally on `diagram` — '
    + 'non-pallet steps keep the current no-diagram layout')
})


// ── Legibility — 2×2 and 4×4 grids render without collapsing ─────
// The cell-size math is size-dependent (CELL_SM=28, CELL_LG=40) —
// large size drives the teach overlay so a 4×4 pallet fits inside
// the 240 px tablet side-panel (SVG width + COL ↓ label + inner
// pad = ~232 px), and the wizard side-card layout is undisturbed.

test('diagram cell + pad sizes support 2×2 through 4×4 grids legibly', () => {
  assert.ok(/CELL_LG\s*=\s*40\b/.test(source),
    'CELL_LG must be 40px so a 4×4 grid renders ~208px wide at '
    + 'size="large" — fits the 240px tablet side-panel with room '
    + 'for the COL ↓ axis label and inner pad.')
  assert.ok(/CELL_SM\s*=\s*28/.test(source),
    'CELL_SM (wizard side-card) must stay at 28px so the wizard '
    + 'layout isn\'t disrupted by the extract')
  // Signature: R and C get clamped to [1, 20] so an arbitrary
  // config never causes a huge SVG that overruns the tablet.
  assert.ok(/Math\.max\(1,\s*Math\.min\(20,\s*rows/.test(source))
  assert.ok(/Math\.max\(1,\s*Math\.min\(20,\s*cols/.test(source))
})


// ── No-vertical-scroll invariant ─────────────────────────────────
// Operator rule (2026-07-31, absolute): every jog button + Record
// Position + the diagram MUST be visible simultaneously at every
// supported breakpoint, with zero vertical scroll.
//
// The math is owned by lib/teachLayout.js and consumed by
// TeachOverlay via teachLayoutMetrics(). Evaluate here at three
// breakpoints — desktop wide (1920×1080), standard desktop
// (1366×768), and the ONN tablet's landscape resolution (1280×800).

const BREAKPOINTS = [
  { name: 'desktop wide',     vw: 1920, vh: 1080 },
  { name: 'standard desktop', vw: 1366, vh:  768 },
  { name: 'tablet landscape', vw: 1280, vh:  800 },
]

// The three inter-region gaps inside the jog area — mode-toggle
// row, step/speed row, and D-pad row all live inside the same
// column-flex container with `gap: isTabletW ? 12 : 16`. Two gaps
// between three rows. Values come from the render code:
//   padding: isTabletW ? 12 : 20  (top + bottom)
//   gap:     isTabletW ? 12 : 16
function jogContainerNonGridPixels(m) {
  const outerPad  = m.isTabletW ? 12 : 20
  const containerGap = m.isTabletW ? 12 : 16
  const modeRowH  = m.modeBtnH
  const speedRowH = 60
  // Container = 2 × outerPad + modeRow + speedRow + Dpad rows + 2 × containerGap
  const nonDpad = 2 * outerPad + modeRowH + speedRowH + 2 * containerGap
  return nonDpad
}

function dpadHeight(m) {
  // 3 button rows + 2 inter-row gaps (padGap between D-pad rows).
  return 3 * m.padBtn + 2 * m.padGap
}

test('layout budget: fixed regions sum to TEACH_FIXED_HEIGHT (300 px)', () => {
  // Header 60 + instruction 48 + mode 56 + speed 60 + footer 76.
  assert.equal(TEACH_FIXED_HEIGHT, 60 + 48 + 56 + 60 + 76)
})

for (const bp of BREAKPOINTS) {
  test(`no vertical scroll at ${bp.name} (${bp.vw}×${bp.vh})`, () => {
    const m = teachLayoutMetrics({ vw: bp.vw, vh: bp.vh })

    // 1. Touch-target floor — 44 px is the tablet-touch minimum
    //    (per the directive). Buttons NEVER shrink below this.
    assert.ok(m.padBtn >= 44,
      `padBtn must ≥ 44 at ${bp.name} (got ${m.padBtn})`)

    // 2. Vertical fit: fixed regions + D-pad rows + gaps ≤ vh.
    //    Reuse the innerH/clientH-style budget from the earlier
    //    clipping saga — everything on the teach screen must
    //    account for its own height in this sum.
    const dpad = dpadHeight(m)
    const totalV = TEACH_FIXED_HEIGHT + dpad
    assert.ok(totalV <= bp.vh,
      `layout overflows vh at ${bp.name}: `
      + `fixed=${TEACH_FIXED_HEIGHT} + dpad=${dpad} = ${totalV} > vh=${bp.vh}`)

    // 3. Horizontal fit with pallet diagram docked: jog area gets
    //    the remaining width, must accommodate the horizontal D-pad
    //    row (Position + Height + Rotation groups + inter-group
    //    gutters). Groups span ~7 button-widths + 2 groupGaps.
    const jogWidth = bp.vw - m.diagramPanelWidth
    const horizontalMinNeed = 7 * m.padBtn + 2 * m.groupGap
    assert.ok(jogWidth >= horizontalMinNeed,
      `jog area too narrow at ${bp.name}: `
      + `jogWidth=${jogWidth} < needed=${horizontalMinNeed}`)

    // 4. Diagram panel width — directive requires 200-300 px on
    //    tablet landscape and 260-300 px on desktop. Codify that
    //    range so a future tweak doesn't sneak below the tablet
    //    minimum.
    if (bp.name === 'tablet landscape') {
      assert.ok(m.diagramPanelWidth >= 200 && m.diagramPanelWidth <= 240,
        `tablet diagram panel must be 200-240 px (got ${m.diagramPanelWidth})`)
    } else {
      assert.ok(m.diagramPanelWidth >= 260 && m.diagramPanelWidth <= 300,
        `desktop diagram panel must be 260-300 px (got ${m.diagramPanelWidth})`)
    }
  })
}

test('no-scroll invariant: TeachOverlay reads layout via teachLayoutMetrics', () => {
  // Guards the inline-vs-shared drift the pin is designed to
  // prevent. If someone reintroduces a private budget calc in
  // TeachOverlay, they'll bypass this test's coverage.
  assert.ok(/teachLayoutMetrics\(\{[^}]*vw[^}]*vh[^}]*\}\)/.test(editorSrc),
    'TeachOverlay must derive padBtn / diagramPanelWidth from '
    + 'teachLayoutMetrics — no inline copy of the formula.')
  assert.ok(editorSrc.includes("from '../lib/teachLayout'"),
    'TeachOverlay must import teachLayoutMetrics from the shared '
    + 'lib/teachLayout module.')
})


// ── Tap-navigation + re-teach visual state ───────────────────────
// Directive: point markers are tappable — tap taught-green → jump
// to that role in re-teach mode; tap the current point = no-op
// (handled by jumpTo(); see palletTeachSequence.test.js); tap a
// future hollow point → jump forward. Re-teach current renders as
// a green core inside a pulsing blue ring (distinct from a fresh
// teach's solid pulsing blue dot).

test('diagram accepts an onRoleTap prop and mode prop', () => {
  assert.ok(/onRoleTap/.test(source),
    'diagram must accept an onRoleTap prop so hosts can wire '
    + 'tap-navigation to their sequence state machine')
  assert.ok(/\bmode\b/.test(source),
    'diagram must accept a mode prop to render the "re-teach" '
    + 'visual state distinctly from a fresh teach')
})

test('diagram wraps markers with a tap group carrying pallet-diagram-tap-<key> testid', () => {
  assert.ok(source.includes('pallet-diagram-tap-'),
    'each marker must live inside a stable-testid tap wrapper — '
    + 'pallet-diagram-tap-<role> — so tests + telemetry can find them')
  // Cursor pointer signals affordance visually.
  assert.ok(/cursor:\s*['"]pointer['"]/.test(source),
    'tappable markers must carry cursor: pointer')
})

test('diagram distinguishes re-teach current point (green + blue ring)', () => {
  // Look for the re-teach visual branch — green core, blue stroke
  // ring, opacity animation on the ring.
  assert.ok(/isActive && isReTeach && isTaught/.test(source),
    'diagram must render a distinct visual when the active point '
    + 'is already taught (re-teach): green core + pulsing blue ring')
  assert.ok(/data-mode="re-teach"/.test(source),
    'the active-re-teach group must carry data-mode="re-teach" so '
    + 'tests can assert the correct visual mode is on the DOM')
})


// ── Editor host wires the new sequence UX ────────────────────────

test('editor wires diagram onRoleTap to jumpToPalletRole', () => {
  assert.ok(/onRoleTap=\{jumpToPalletRole\}/.test(editorSrc),
    'ProgramEditor must pass jumpToPalletRole as onRoleTap so a tap '
    + 'on a diagram marker navigates the sequence')
  assert.ok(/function jumpToPalletRole/.test(editorSrc),
    'jumpToPalletRole must be a named function for source-level '
    + 'discoverability + pinning')
})

test('editor passes mode={palletTeachMode} to the diagram', () => {
  assert.ok(/mode=\{palletTeachMode\}/.test(editorSrc),
    'ProgramEditor must pass palletTeachMode to the diagram so '
    + 're-teach state renders correctly')
})

test('editor header counter reflects "N taught" reality', () => {
  assert.ok(/counterSuffix/.test(editorSrc),
    'ProgramEditor must send a counterSuffix to the TeachOverlay '
    + 'header (per directive: "Step 2 of 4 · 3 taught")')
  // The suffix content: " · <n> taught"
  assert.ok(/`\s*·\s*\$\{nTaught\}\s*taught`/.test(editorSrc),
    'counterSuffix content must be " · N taught" — this is the '
    + 'exact directive-mandated string')
})

test('editor uses shared sequence module (no inline PALLET_ROLE_TO_FIELD copy)', () => {
  assert.ok(editorSrc.includes("from '../lib/palletTeachSequence'"),
    'ProgramEditor must import from lib/palletTeachSequence — the '
    + 'shared sequence module')
  // The inline PALLET_ROLE_TO_FIELD table was RETIRED — its removal
  // is the anti-fork guarantee for the write-field mapping.
  const localTable = /const PALLET_ROLE_TO_FIELD\s*=\s*\{/.exec(editorSrc)
  assert.equal(localTable, null,
    'ProgramEditor must NOT redefine PALLET_ROLE_TO_FIELD — the '
    + 'shared sequence module owns the mapping')
})

test('editor cancel-confirm modal states the number of preserved teaches', () => {
  assert.ok(editorSrc.includes('data-testid="pallet-cancel-confirm"'),
    'Cancel-confirm modal must carry a stable testid')
  // Body copy pin — the "N of 4 pallet frame points have been
  // recorded" phrasing is the operator-facing contract.
  assert.ok(/of 4 pallet frame points/.test(editorSrc),
    'confirm copy must show "N of 4 pallet frame points" so the '
    + 'operator sees exactly what is being preserved')
  assert.ok(/Recorded teaches will be kept/.test(editorSrc),
    'confirm copy must state that recorded teaches are kept — '
    + 'the directive\'s explicit assurance')
})

test('editor frame validation goes through the shared backend endpoint (§465 fork-1 kill, 2026-08-04)', () => {
  // The passive frame-warning banner is retired: it fired against
  // mid-re-teach state (half-updated) and used its own local math
  // that skipped the v1→v2 migration. Findings now surface as
  // toasts at (a) Record and (b) teach-complete, sourced from the
  // shared POST /api/pallet/validate_frame endpoint.
  assert.ok(!editorSrc.includes('data-testid="pallet-frame-warning"'),
    'passive pallet-frame-warning banner must be retired — '
    + 'findings only surface as toasts at Record and at '
    + 'teach-complete, never as a passive banner')
  assert.ok(!/validatePalletFrame\(nextPlace\)/.test(editorSrc),
    'palletTeachRecord must NOT call the retired local '
    + 'validatePalletFrame(nextPlace) — geometry runs on the '
    + 'backend now')
  // Positive assertion: the record path uses the async validator.
  assert.ok(/validatePalletFrameServer\(nextPlace/.test(editorSrc),
    'palletTeachRecord must call validatePalletFrameServer with '
    + 'the would-be place so the shared endpoint validates the '
    + 'geometry before the record commits')
})
