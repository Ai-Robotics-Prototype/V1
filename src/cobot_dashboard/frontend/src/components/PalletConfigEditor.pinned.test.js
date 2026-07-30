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


// ── New surface: read-only FrameStatus ──────────────────────────

test('modal renders a FrameStatus block via the data-testid marker', () => {
  assert.ok(body.includes("data-testid=\"pallet-frame-status\""),
    'The frame-status readout is the modal\'s ONLY affordance for '
    + 'the taught frame — it must be present.')
})

test('modal renders a [Go to teaching] action', () => {
  assert.ok(body.includes("data-testid=\"pallet-frame-goto-teaching\""),
    'The Go-to-teaching button routes the operator to the diagram-'
    + 'guided teach flow (one teaching surface).')
})

test('modal commit preserves initialPallet fields via spread', () => {
  // The commit path spreads initialPallet BEFORE overriding param
  // fields — this is how the modal preserves already-captured
  // corner_tcp / any 3-point frame fields on re-save.
  assert.ok(/const pallet = \{\s*\.\.\.initialPallet/.test(body),
    'commit() must spread ...initialPallet so corner_tcp / '
    + 'point_b_tcp / point_c_tcp survive a parameters-only save.')
})
