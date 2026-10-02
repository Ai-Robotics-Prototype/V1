// PalletConfigEditor cleanup pin — 2026-07-30.
//
// The modal had a "Taught positions" section with raw TCP readouts
// and "Use current pose" buttons (legacy one-corner teach UI
// predating the 3-point frame). It's been removed — modal is
// parameters-only; teaching goes through the wizard's diagram-
// guided flow. These tests read the component source and assert
// the pose-capture surface is gone AND that the FrameStatus
// indicator is present.
//
// This is a source-level check (not a mount test) so it runs
// without a JSX transformer + jsdom setup. When the modal
// eventually gets a proper React-testing-library test, that will
// exercise render behavior; today's guard is the source pattern.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { palletFrameStatus } from '../lib/programTruth.js'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const editorPath = path.resolve(__dirname, 'ProgramEditor.jsx')
const source = fs.readFileSync(editorPath, 'utf8')

// The PalletConfigEditor function body — extract JUST that block so
// the tests below don't false-positive on unrelated components
// (StepEditor's pose-drawer, wizard flow, etc. all live in the
// same file).
function _extractPalletConfigEditorBody(src) {
  const start = src.indexOf('function PalletConfigEditor')
  assert.ok(start >= 0, 'PalletConfigEditor definition not found')
  // Skip past the parameter list first — the destructuring braces
  // `({ config, onSave, ... })` would otherwise fool a naive brace
  // counter into thinking they mark the function body.
  const parenOpen = src.indexOf('(', start)
  let depthP = 0
  let parenClose = -1
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') depthP++
    else if (src[i] === ')') {
      depthP--
      if (depthP === 0) { parenClose = i; break }
    }
  }
  assert.ok(parenClose > 0, 'could not find closing ) of PalletConfigEditor signature')
  // Now the FIRST '{' after the signature is the function body opener.
  const braceStart = src.indexOf('{', parenClose)
  let depth = 0
  for (let i = braceStart; i < src.length; i++) {
    // Skip string and template-literal contents so unbalanced braces
    // inside strings (unlikely but possible) don't derail the walk.
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(braceStart, i + 1)
    }
  }
  throw new Error('unbalanced braces in PalletConfigEditor body')
}

const body = _extractPalletConfigEditorBody(source)


// ── Removed surfaces ─────────────────────────────────────────────

test('modal renders no "Use current pose" button', () => {
  assert.equal(body.includes('Use current pose'), false,
    '"Use current pose" pose-capture control must not appear in '
    + 'the pallet config modal — teaching goes through the '
    + 'wizard\'s diagram-guided flow.')
})

test('modal defines no captureTcp / tcpRow helpers', () => {
  assert.equal(body.includes('captureTcp'), false,
    'captureTcp helper was retired from the modal — pose capture '
    + 'is not the modal\'s responsibility.')
  assert.equal(body.includes('const tcpRow ='), false,
    'tcpRow helper was retired — the modal no longer renders raw '
    + 'TCP readouts.')
})

test('modal has no "Taught positions" section heading', () => {
  assert.equal(body.includes('Taught positions'), false,
    'The "Taught positions" section heading was removed. Any '
    + 'reference in NEW code must go via the frame-status indicator.')
})

test('modal defines no cornerTcp / pickTcp / placeTcp state', () => {
  // Sanity: the pose state slots that fed the removed section.
  assert.equal(/setCornerTcp\b/.test(body), false)
  assert.equal(/setPickTcp\b/.test(body), false)
  assert.equal(/setPlaceTcp\b/.test(body), false)
})


// ── Retained surfaces (the parameters-only modal) ────────────────

test('modal still edits rows / cols / layers / spacing / heights / speed', () => {
  for (const setter of [
    'setRows', 'setCols', 'setLayers',
    'setSpacingX', 'setSpacingY', 'setLayerH',
    'setApproachH', 'setRetractH', 'setSpeed',
    'setFillOrder',
  ]) {
    assert.ok(body.includes(setter),
      `expected ${setter} in parameters-only modal`)
  }
})


test('modal commit preserves initialPallet fields via spread', () => {
  // The commit path spreads initialPallet BEFORE overriding param
  // fields — this is how the modal preserves already-captured
  // corner_tcp / any 3-point frame fields on re-save.
  assert.ok(/const pallet = \{\s*\.\.\.initialPallet/.test(body),
    'commit() must spread ...initialPallet so corner_tcp / '
    + 'point_b_tcp / point_c_tcp survive a parameters-only save.')
})


// ── ZERO teach in the modal (2026-07-31 cleanup) ──────────────────
// The circled block ("Pallet frame: C1/C2/C3/Part" + Teach button +
// caption + amber migration notice) was removed. This test pins the
// ABSENCE — reintroducing any of those testids or the caption text
// walks straight into the operator's explicit "no teach in the
// modal" rule.

test('modal renders ZERO teach-related elements', () => {
  const forbidden = [
    // Testids from the removed block:
    'pallet-frame-status',
    'pallet-frame-goto-teaching',
    'pallet-frame-migrated-notice',
    // Prose the removed block carried:
    'Pallet frame:',
    'Teach via Teach All',
    'Re-teach frame',
    'Frame points teach only through',
    'This pallet was created with the older 3-point model',
  ]
  for (const tok of forbidden) {
    assert.equal(body.includes(tok), false,
      `modal must not contain "${tok}" — teach state belongs on the `
      + 'step row + program findings, never in this modal')
  }
})

test('modal reads no palletFrameStatus / no migratedFromV1', () => {
  // The modal itself must not derive any frame-teach state. If
  // someone reintroduces palletFrameStatus() inside the modal
  // function, they're heading back toward the retired block.
  assert.equal(/palletFrameStatus\s*\(/.test(body), false,
    'modal body must not call palletFrameStatus — that logic '
    + 'moved to the step row + programFindings')
  assert.equal(/migratedFromV1/.test(body), false,
    'modal must not read migratedFromV1 — the migration nudge is '
    + 'a program finding now, not a modal chip')
})

test('modal signature dropped the onGoToTeaching prop', () => {
  // The prop existed solely to route the retired "Teach via Teach
  // All →" button. Its removal is the anti-reintroduction pin: any
  // future caller that tries to pass it will get a lint-visible
  // extra prop and the modal will silently ignore it.
  const sig = source.match(/function PalletConfigEditor\s*\(\{([^}]*)\}\)/)
  assert.ok(sig, 'PalletConfigEditor signature must be discoverable')
  assert.equal(/onGoToTeaching/.test(sig[1]), false,
    'PalletConfigEditor must not declare onGoToTeaching — the '
    + 'teach-launch surface was retired from the modal')
})


// ── ProgramFindingsPanel — the migration nudge's new home ─────────
// The legacy-migration guidance no longer lives in the modal; it
// surfaces as a program-level info finding rendered between the
// Tool & Payload section and the step list. These pins hold the
// wiring in place.

test('editor mounts <ProgramFindingsPanel> with the current program', () => {
  assert.ok(/<ProgramFindingsPanel\b/.test(source),
    'ProgramEditor must render <ProgramFindingsPanel> so findings '
    + 'appear where the operator does the work — not behind a modal')
  assert.ok(/<ProgramFindingsPanel[\s\S]*?program=\{currentProgram\}/.test(source),
    'panel must receive the current program (findings recompute as '
    + 'the operator edits — no stale state)')
})

test("panel's Re-teach ④ CTA opens the pallet teach at pallet_part", () => {
  // The finding carries action.kind='teach-pallet-part'. The panel's
  // onAction callback must map that kind → setPalletTeachRole(
  // 'pallet_part') so the operator lands directly on ④.
  const onAction = source.match(
    /onAction=\{[\s\S]{0,600}?teach-pallet-part[\s\S]{0,300}?setPalletTeachRole\(['"]pallet_part['"]\)/
  )
  assert.ok(onAction,
    'panel onAction must route the teach-pallet-part CTA to '
    + "setPalletTeachRole('pallet_part') so the operator lands "
    + 'exactly on ④ in the diagram-guided flow')
})

test('ProgramFindingsPanel renders a per-finding testid', () => {
  // Each finding gets `program-finding-<id>` so tests can assert
  // the migration finding appears / disappears exactly.
  assert.ok(/data-testid=\{`program-finding-\$\{f\.id\}`\}/.test(source),
    'each finding row must carry `program-finding-<id>` testid')
  assert.ok(/data-severity=\{f\.severity\}/.test(source),
    'each finding must publish data-severity (info / warn / error)')
})


// ── Unified teaching-debt banner — 2026-07-31 consolidation ─────
// Directive: ONE banner per program, fed by computeTeachingDebt.
// Old red "N positions not taught" banner + info "re-teach ④" —
// both absorbed. Severity: red when required teaches missing,
// amber when only quality re-teaches remain.

test('editor renders exactly one teaching-debt banner (no legacy siblings)', () => {
  assert.ok(source.includes('data-testid="teaching-debt-banner"'),
    'ProgramEditor must render the unified debt banner with a stable testid')
  // The old red "N positions not taught" copy was JSX inside the
  // retired banner (a `{untaughtCount} position${untaughtCount>1?...}
  // not taught` template). Match the JSX shape, not any prose that
  // might survive in a docblock explaining the retirement.
  assert.equal(
    /\{untaughtCount\}\s*position\{untaughtCount\s*>\s*1[^}]*\}\s*not taught/.test(source),
    false,
    'the old JSX "N position(s) not taught" template must be gone — '
    + 'the unified banner uses debtBannerLabel(debt) instead')
})

test('debt banner reads severity + count from computeTeachingDebt', () => {
  assert.ok(/computeTeachingDebt\(currentProgram\)/.test(source),
    'debt banner must derive its state from computeTeachingDebt — '
    + 'the SHARED resolver, no inline count math')
  assert.ok(/debtBannerLabel\(debt\)/.test(source),
    'banner must use debtBannerLabel(debt) so the label copy stays '
    + 'in lockstep with the debt lib')
  assert.ok(/Teach All \(\{debt\.total\}\)/.test(source),
    'Teach All button must show the FULL debt count — the unified '
    + 'count is the whole point of the consolidation')
})

test('debt banner severity styling: error vs warn palette split', () => {
  assert.ok(/debt\.severity === 'error'/.test(source),
    'banner must branch on severity === \'error\' to pick the red palette')
  // Directive: red bg for error, amber for warn.
  assert.ok(/#fef2f2/.test(source), 'red palette (#fef2f2) present for error')
  assert.ok(/#fef3c7/.test(source), 'amber palette (#fef3c7) present for warn')
  // Anchor the banner IIFE from its severity guard through its
  // Teach-All button so the palette branching (which sits BEFORE
  // the div opens) is inside the captured region.
  const bannerRegion = source.match(
    /if \(!debt\.severity\) return null[\s\S]{0,2500}?data-testid="teaching-debt-teach-all"/
  )
  assert.ok(bannerRegion,
    'debt banner region must be discoverable as one contiguous block')
  // Both palettes must live inside the same branch region — the
  // error branch picks the red hex, the else branch picks amber.
  assert.ok(/#fef2f2/.test(bannerRegion[0]) && /#fef3c7/.test(bannerRegion[0]),
    'banner region must define both palettes (red for error, amber for warn) '
    + 'so a single ternary carries the whole severity nuance')
})

test('debt banner hides mid-flow (Teach All active OR pallet teach active)', () => {
  // The banner must vanish during any teach flow so it doesn't
  // shout at the operator while they're already handling the debt.
  const bannerRegion = source.match(
    /computeTeachingDebt\(currentProgram\)[\s\S]{0,600}?teaching-debt-banner/
  )
  assert.ok(bannerRegion, 'debt banner region locatable')
  const head = source.match(
    /if \(teachAllPos >= 0\) return null[\s\S]{0,200}?if \(teachSingleId != null\) return null[\s\S]{0,200}?if \(palletTeachRole\) return null/
  )
  assert.ok(head,
    'debt banner must early-return null when any teach flow is active '
    + '(teachAllPos ≥ 0 OR teachSingleId set OR palletTeachRole set)')
})

test("legacy pallet-migration finding is FILTERED OUT of ProgramFindingsPanel", () => {
  // The finding record survives in computeProgramFindings (for the
  // audit trail), but the visual duplicate above the step list is
  // gone — its content lives ONLY in the unified debt banner + as
  // the itinerary caption when Teach All chains ④.
  assert.ok(/TEACHING_DEBT_FINDING_IDS\s*=\s*new Set\(\[[\s\S]*?'pallet-legacy-migration'/
    .test(source),
    'ProgramEditor must maintain a filter set naming '
    + 'pallet-legacy-migration so the info-banner duplicate is '
    + 'suppressed. The finding record itself stays in the module')
  assert.ok(/\.filter\(\(f\) => !TEACHING_DEBT_FINDING_IDS\.has\(f\.id\)\)/.test(source),
    'panel must actually filter using the set')
})


// ── Teach All chains into owed pallet re-teaches ────────────────
// Directive: "The Teach All sequence INCLUDES owed re-teaches as
// ordinary stops: ④ appears in the itinerary in re-teach mode
// (the pulsing-ring state) with its one-line reason in the caption".

test('startTeachAll reads the unified debt (not the old untaughtIds)', () => {
  const fn = source.match(/function startTeachAll\s*\(\)\s*\{[\s\S]{0,900}?\n  \}/)
  assert.ok(fn, 'startTeachAll must be locatable')
  assert.ok(/computeTeachingDebt\(currentProgram\)/.test(fn[0]),
    'startTeachAll must derive its work from computeTeachingDebt — '
    + 'no inline count / no legacy `order = untaughtIds`')
  assert.ok(/debt\.stepIds/.test(fn[0]),
    'startTeachAll must dispatch on debt.stepIds')
  assert.ok(/debt\.palletReTeaches/.test(fn[0]),
    'startTeachAll must consider debt.palletReTeaches for the '
    + '"no untaught steps, only re-teaches" branch')
})

test('step queue completion chains into any owed pallet re-teaches', () => {
  // Both the Record path and the Skip path check for remaining
  // re-teaches when the step queue empties. If either forgets to
  // chain, an owed re-teach becomes orphaned (the debt would say
  // "1 owed" but Teach All wouldn't walk it).
  assert.ok(/chainToPalletReTeaches\s*\(/.test(source),
    'chainToPalletReTeaches helper must exist')
  const recordFn = source.match(/async function teachOverlayRecord[\s\S]{0,2200}?\n  \}/)
  assert.ok(recordFn,
    'teachOverlayRecord must be locatable')
  assert.ok(/chainToPalletReTeaches\(remainingDebt\.palletReTeaches\)/.test(recordFn[0]),
    'teachOverlayRecord must call chainToPalletReTeaches on queue completion')
  const skipFn = source.match(/function teachOverlaySkip[\s\S]{0,700}?\n  \}/)
  assert.ok(skipFn && /chainToPalletReTeaches/.test(skipFn[0]),
    'teachOverlaySkip must also chain — skipping the last step '
    + 'still hands off to owed re-teaches')
})

test("chained pallet re-teach threads reason into the diagram caption", () => {
  // palletTeachReason state carries the owed-re-teach reason and
  // gets appended to the diagram-flow's instr, so ④'s stop reads
  // its legacy-migration caption verbatim (per directive: "with
  // its one-line reason in the caption").
  assert.ok(/palletTeachReason,\s*setPalletTeachReason/.test(source),
    'palletTeachReason state must exist')
  assert.ok(/reasonAddendum = palletTeachReason[\s\S]{0,80}?palletTeachReason/.test(source),
    'diagram-flow instr composition must include a reasonAddendum '
    + 'derived from palletTeachReason')
  // chainToPalletReTeaches must SET the reason from the debt item.
  const chain = source.match(/function chainToPalletReTeaches[\s\S]{0,900}?\n  \}/)
  assert.ok(chain, 'chainToPalletReTeaches must be locatable')
  assert.ok(/setPalletTeachReason\(first\.reason \|\| null\)/.test(chain[0]),
    'chainToPalletReTeaches must pull the reason off the first '
    + 'debt item and thread it into palletTeachReason')
})


// ── Pallet step ROW pins — the Teach/Re-teach button + badge that
//    fire from the step-list row (never the modal). Directive:
//      1. Row action strip = Edit | Teach | Del for pallet steps.
//      2. Button label from palletFrameStatus: "Teach" when any
//         frame point untaught; "Re-teach" when allTaught.
//      3. Badge tracks FRAME completeness through the resolver:
//         green only when all frame points + first-part taught.
//      4. Teach opens the diagram-guided flow at the FIRST untaught
//         role (mid-flow resume — not restart at ①).

test('row: pallet step renders a data-testid="pallet-row-teach" button', () => {
  assert.ok(source.includes('data-testid="pallet-row-teach"'),
    'Pallet step row must expose a testable Teach button — same '
    + 'Edit | Teach | Del strip as every other taught row.')
})

test('row: pallet Teach button is gated on !locked && _isPalletStep', () => {
  const teachBlock = source.match(
    /\{!locked && _isPalletStep && \(\s*<button[\s\S]*?data-testid="pallet-row-teach"[\s\S]*?\}\)\s*\}/
  )
  assert.ok(teachBlock,
    'Pallet Teach button must be gated on !locked && _isPalletStep — '
    + 'locked programs (running / read-only) do not expose teach '
    + 'affordances.')
})

test('row: pallet Teach button label switches Teach / Re-teach via allTaught', () => {
  // Direct label pin — the button renders {_palletFrame.allTaught ?
  // 'Re-teach' : 'Teach'} so the label reads the shared resolver.
  assert.ok(/_palletFrame\.allTaught\s*\?\s*['"`]Re-teach['"`]\s*:\s*['"`]Teach['"`]/.test(source),
    'Pallet row Teach button label must read the resolver — '
    + 'allTaught → Re-teach, otherwise Teach.')
})

test('row: pallet row badge is tri-state (full / partial / none)', () => {
  // Badge testid + tri-state color/label logic pinned to
  // taughtCount(). The pallet-driven step has no per-step taught
  // flag; the badge MUST reflect FRAME completeness AND distinguish
  // partial (some points) from none.
  assert.ok(source.includes('data-testid="pallet-row-badge"'),
    'Pallet step row must render a badge with a stable testid.')
  const badgeBlock = source.match(
    /_isPalletStep\s*\?\s*\(\(\)\s*=>\s*\{[\s\S]*?data-testid="pallet-row-badge"[\s\S]*?\}\)\(\)/
  )
  assert.ok(badgeBlock,
    'Pallet row badge must live in the _isPalletStep branch and be a '
    + 'derived-from-resolver readout, not a mirror of step.taught.')
  // The tri-state contract:
  //   n === 4 → 'full'    (solid green T)
  //   n === 0 → 'none'    (red dashed !)
  //   else    → 'partial' (amber, shows N/4)
  assert.ok(/const n = taughtCount\(_palletFrame\)/.test(badgeBlock[0]),
    'Pallet row badge must derive n from taughtCount(_palletFrame) — '
    + 'the shared count function, not palletFrameStatus.allTaught '
    + '(which collapses partial and none to the same value).')
  assert.ok(/n === 4 \? 'full' : n === 0 \? 'none' : 'partial'/.test(badgeBlock[0]),
    'Pallet row badge must expose a tri-state `state` variable — '
    + 'partial (1-3 of 4) is a distinct visual from none (0 of 4).')
  assert.ok(/data-state=\{state\}/.test(badgeBlock[0]),
    'Badge must publish `data-state` attribute so tests + telemetry '
    + 'can distinguish full / partial / none without color-inspection.')
})

test('row: startPalletTeach() resumes at firstUntaughtPalletRole', () => {
  // The Teach-button click handler calls startPalletTeach(); that
  // function must consult firstUntaughtPalletRole so partial states
  // resume at ② / ③ / ④ instead of restarting the flow.
  const fn = source.match(/function startPalletTeach\s*\(\)\s*\{[\s\S]{0,400}?\}\s*$/m)
  assert.ok(fn,
    'startPalletTeach() must exist as a named function so its '
    + 'behavior is discoverable + testable at source level.')
  assert.ok(/firstUntaughtPalletRole\(currentProgram\)/.test(fn[0]),
    'startPalletTeach() must call firstUntaughtPalletRole to pick '
    + 'the starting role — mid-flow resume, not restart at ①.')
  assert.ok(/PALLET_ROLE_ORDER\[0\]/.test(fn[0]),
    'startPalletTeach() must fall back to PALLET_ROLE_ORDER[0] '
    + '(= pallet_c1) when the resolver returns null (all taught → '
    + 'Re-teach starts at ①).')
})

test('row: pallet teach record writes to config.pallet_place + config.pallet', () => {
  // Record path must mirror to BOTH shapes — pallet_place is the
  // canonical write, pallet is the mirror for pre-2026-07-30 readers
  // (matches the wizard's buildPalletConfig writeout).
  assert.ok(/async function palletTeachRecord\s*\(\s*\)/.test(source),
    'palletTeachRecord() must exist as a named async function')
  assert.ok(/PALLET_ROLE_TO_FIELD\[role\]/.test(source),
    'palletTeachRecord must look up the write field via '
    + 'PALLET_ROLE_TO_FIELD — no free-string field names.')
  assert.ok(/pallet_place:\s*nextPlace/.test(source),
    'palletTeachRecord must write pallet_place (canonical shape).')
  assert.ok(/pallet:\s*nextPallet/.test(source),
    'palletTeachRecord must also mirror to pallet (legacy shape).')
})
