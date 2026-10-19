// DOCTRINE — Palletize wizard asks BOX size + optional gap, and derives
// slot spacing + layer offset from the box dimensions (2026-10-19
// operator directive).
//
// Pre-directive: the wizard asked for raw slot pitch (Spacing X,
// Spacing Y, Layer height Z) with three DistanceSliders — three
// numbers the operator had to compute off-robot.
//
// Post-directive: the wizard asks for the box the operator is
// stacking (Box length / Box width / Box height) + an optional Gap
// between boxes, and the derivation is:
//
//   spacing_x_mm    = box_length_mm + box_gap_mm   (between columns)
//   spacing_y_mm    = box_width_mm  + box_gap_mm   (between rows)
//   layer_height_mm = box_height_mm + box_gap_mm   (per layer)
//
// Aligned stacking only (same orientation on every box, every layer).
// Interlocked / brick stacking is a future advanced option — NOT
// built this session.
//
// Pins:
//   * ProgramWizard pallet_layout page mounts a DistanceSlider for
//     EACH of the four box inputs (Box length, Box width, Box height,
//     Gap between boxes).
//   * The three retired "Spacing X / Spacing Y / Layer height Z"
//     slider labels no longer appear in the pallet_layout live code.
//   * The pallet_layout page carries an "Aligned stacking" note
//     explaining interlocked is a future option.
//   * buildPalletConfig derives spacing_x_mm = box_length_mm +
//     box_gap_mm, etc., and persists box_length_mm / box_width_mm /
//     box_height_mm / box_gap_mm / stacking_pattern:'aligned' on the
//     saved pallet config so the inputs round-trip to the config.
//   * Default box dims + gap are stable (regression pin on operator-
//     facing defaults).
//
// Failure format: DOCTRINE PALLET_BOX VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')

const progWizSrc = readSrc('components/ProgramWizard.jsx')

function v(msg) { return `DOCTRINE PALLET_BOX VIOLATED: ${msg}` }

// Strip JS comments so standing retirement-doc narration doesn't
// trip the gate — pins fire on live code only.
function _liveCode(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*$/gm, '')
}
const live = _liveCode(progWizSrc)


// ── (1) Box inputs mounted on the pallet_layout page ────────────────

test('pallet_layout page mounts the four box-size DistanceSliders', () => {
  for (const label of [
    'Box length',
    'Box width',
    'Box height',
    'Gap between boxes',
  ]) {
    assert.ok(live.includes(`label="${label}"`),
      v(`pallet_layout page must mount a DistanceSlider labelled "${label}" `
        + `— the four box-size inputs that replace manual spacing entry.`))
  }
})

test('pallet_layout page writes box_* answer keys through onCommitMm', () => {
  for (const key of [
    'pallet_box_length_mm',
    'pallet_box_width_mm',
    'pallet_box_height_mm',
    'pallet_box_gap_mm',
  ]) {
    assert.ok(new RegExp(`setAnswer\\(['"]${key}['"]`).test(live),
      v(`pallet_layout slider for ${key} must call setAnswer('${key}', v) `
        + `so the box dim persists through buildPalletConfig.`))
  }
})


// ── (2) Retired spacing / layer-height sliders are gone ─────────────

test('pallet_layout page no longer mounts raw-spacing sliders', () => {
  // The retired entries had labels "Spacing X (centre-to-centre)",
  // "Spacing Y (centre-to-centre)", and "Layer height Z". Match
  // label= to avoid false-positives from the "Row pitch" labels
  // that still appear in the PalletConfigEditor modal (a different
  // surface, not touched by this directive).
  for (const label of [
    'Spacing X (centre-to-centre)',
    'Spacing Y (centre-to-centre)',
    'Layer height Z',
  ]) {
    assert.equal(live.includes(`label="${label}"`), false,
      v(`pallet_layout page must NOT mount a DistanceSlider labelled `
        + `"${label}" — raw spacing entry is replaced by box size + gap.`))
  }
})


// ── (3) Aligned-stacking note + interlocked-future callout ──────────

test('pallet_layout carries an aligned-stacking note (interlocked is future)', () => {
  assert.ok(/data-testid=['"]pallet-aligned-note['"]/.test(live),
    v(`pallet_layout page must render a pallet-aligned-note surface so the `
      + `operator sees "aligned stacking, interlocked is future".`))
  assert.ok(/[Aa]ligned stacking/.test(live),
    v(`pallet_layout page must carry the phrase "Aligned stacking" so the `
      + `operator understands the directive scope.`))
  assert.ok(/[Ii]nterlocked/.test(live),
    v(`pallet_layout page must name "interlocked" (brick / rotated) as a `
      + `future option so the operator knows it is NOT this session.`))
})


// ── (4) buildPalletConfig derives spacing from box dims + gap ───────

function _extractBuildPalletConfigBody(src) {
  const start = src.indexOf('function buildPalletConfig(')
  assert.ok(start >= 0, v('buildPalletConfig function not found in ProgramWizard'))
  const brace = src.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(brace, i + 1)
    }
  }
  throw new Error(v('unbalanced braces in buildPalletConfig body'))
}

const bpcBody = _extractBuildPalletConfigBody(progWizSrc)

test('buildPalletConfig derives spacing_x_mm = box_length + gap', () => {
  assert.ok(/pallet_box_length_mm/.test(bpcBody),
    v('buildPalletConfig must read answers.pallet_box_length_mm.'))
  assert.ok(/pallet_box_width_mm/.test(bpcBody),
    v('buildPalletConfig must read answers.pallet_box_width_mm.'))
  assert.ok(/pallet_box_height_mm/.test(bpcBody),
    v('buildPalletConfig must read answers.pallet_box_height_mm.'))
  assert.ok(/pallet_box_gap_mm/.test(bpcBody),
    v('buildPalletConfig must read answers.pallet_box_gap_mm.'))
  // The derivation lines: spacingX = boxL + gap, spacingY = boxW + gap,
  // layerH = boxH + gap. Match the sum form.
  assert.ok(/spacingX\s*=\s*boxL\s*\+\s*gap/.test(bpcBody),
    v('buildPalletConfig must derive spacingX = boxL + gap.'))
  assert.ok(/spacingY\s*=\s*boxW\s*\+\s*gap/.test(bpcBody),
    v('buildPalletConfig must derive spacingY = boxW + gap.'))
  assert.ok(/layerH\s*=\s*boxH\s*\+\s*gap/.test(bpcBody),
    v('buildPalletConfig must derive layerH = boxH + gap.'))
})

test('buildPalletConfig persists box dims + gap + aligned stacking pattern', () => {
  for (const key of ['box_length_mm', 'box_width_mm', 'box_height_mm',
                     'box_gap_mm']) {
    assert.ok(new RegExp(`${key}\\s*:`).test(bpcBody),
      v(`buildPalletConfig must emit "${key}" on the saved pallet config so `
        + `re-opening the program round-trips the box inputs.`))
  }
  assert.ok(/stacking_pattern\s*:\s*['"]aligned['"]/.test(bpcBody),
    v('buildPalletConfig must emit stacking_pattern:"aligned" — the only '
      + 'pattern built this session; interlocked is future.'))
})

test('buildPalletConfig emits spacing / layer-height derived from box inputs', () => {
  // We don't execute the function (JSX file; node --test cannot
  // import it without a transformer), but the body must assign
  // spacing_x_mm from the derived variable spacingX, not from a
  // raw answers.pallet_spacing_x_mm read, so the derivation is
  // the single source of truth.
  assert.ok(/spacing_x_mm:\s*spacingX/.test(bpcBody),
    v('buildPalletConfig must set spacing_x_mm from the derived spacingX '
      + '(box_length + gap), not from answers.pallet_spacing_x_mm directly.'))
  assert.ok(/spacing_y_mm:\s*spacingY/.test(bpcBody),
    v('buildPalletConfig must set spacing_y_mm from the derived spacingY '
      + '(box_width + gap).'))
  assert.ok(/layer_height_mm:\s*layerH/.test(bpcBody),
    v('buildPalletConfig must set layer_height_mm from the derived layerH '
      + '(box_height + gap).'))
  assert.ok(/pitch_row_mm:\s*spacingX/.test(bpcBody),
    v('buildPalletConfig must set pallet_place.pitch_row_mm from spacingX '
      + 'so the taught-frame math uses the same derived value.'))
  assert.ok(/pitch_col_mm:\s*spacingY/.test(bpcBody),
    v('buildPalletConfig must set pallet_place.pitch_col_mm from spacingY.'))
})


// ── (5) Defaults are stable (regression pin) ────────────────────────

test('Box defaults: 150mm × 100mm × 100mm, gap 0mm', () => {
  // Operator-facing defaults double as a regression pin. If these
  // change we want it to be a conscious call, with the test updated
  // in the same commit.
  assert.ok(/pallet_box_length_mm\s*\?\?\s*150/.test(live),
    v('Default pallet_box_length_mm must be 150 (≈6″).'))
  assert.ok(/pallet_box_width_mm\s*\?\?\s*100/.test(live),
    v('Default pallet_box_width_mm must be 100 (≈4″).'))
  assert.ok(/pallet_box_height_mm\s*\?\?\s*100/.test(live),
    v('Default pallet_box_height_mm must be 100 (≈4″).'))
  assert.ok(/pallet_box_gap_mm\s*\?\?\s*0/.test(live),
    v('Default pallet_box_gap_mm must be 0 (boxes touching).'))
})
