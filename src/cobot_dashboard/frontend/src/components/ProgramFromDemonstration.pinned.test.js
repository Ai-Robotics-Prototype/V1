// ProgramFromDemonstration review-panel pin — 2026-08-01.
//
// The 2026-08-01 position-identity feature makes three review-side
// promises that must not silently regress:
//
//   1. Anchor steps that share a location_ref with N-1 later repeats
//      render a 🔗N badge (teach-once cue).
//   2. Steps carrying `derived_from_step_id` render a "🔗 → step X"
//      chip AND strip the composer's "(link → step X)" label suffix
//      so the row reads cleanly.
//   3. Low-confidence positions surface a passive "linked — verify"
//      chip on the anchor + every repeat.
//
// The stronger guarantee is negative: NO sameness Clarification is
// ever shown to the operator. The prompt forbids emitting one
// (rule 6c), fusion never adds one, but a legacy backend reply
// COULD carry a hand-authored `field:"location"` question — the
// review filter must drop it silently.
//
// Source-level checks (no JSX renderer + jsdom needed).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const compPath = path.resolve(__dirname, 'ProgramFromDemonstration.jsx')
const source = fs.readFileSync(compPath, 'utf8')


test('review renders 🔗N anchor badge when linkedCount>0', () => {
  // The badge is emitted by the anchor branch that reads shareCount
  // = linkedCount + 1 and prints "🔗{shareCount}".  A regression that
  // silently removes the badge (e.g. by dropping the isAnchor
  // conditional) drops this substring — this test fires.
  assert.ok(/isAnchor\s*&&\s*\(/.test(source),
    'anchor-badge conditional (isAnchor) not found in review render')
  assert.ok(/🔗\{shareCount\}/.test(source),
    'anchor 🔗{shareCount} badge missing from review render')
})

test('review renders "🔗 → step X" chip on derived_from_step_id repeats', () => {
  // The chip is emitted by the isRepeatLink branch — text pattern
  // "🔗 → step {s.derived_from_step_id}". Regression: chip removed
  // OR displayLabel not stripping the composer's "(link → step N)"
  // suffix (double-labelling).
  assert.ok(/isRepeatLink\s*&&\s*\(/.test(source),
    'repeat-link chip conditional (isRepeatLink) missing')
  assert.ok(/🔗\s*→\s*step\s*\{s\.derived_from_step_id\}/.test(source),
    'repeat-link chip text "🔗 → step {s.derived_from_step_id}" missing')
  assert.ok(/displayLabel/.test(source),
    'displayLabel (label-suffix strip) missing — repeat rows will double-label')
  assert.ok(/replace\(\s*\/\\s\*\\\(link → step \\d\+\\\)\\s\*\$\//.test(source),
    'label-suffix strip regex missing — "(link → step N)" will leak into displayed row')
})

test('review renders "linked — verify" low-confidence chip', () => {
  // Chip only surfaces when the LocationRef has low_confidence=true
  // AND the current step is an anchor or a repeat — silent otherwise.
  assert.ok(/lowConf\s*&&\s*\(isAnchor\s*\|\|\s*isRepeatLink\)/.test(source),
    'low-confidence chip condition (lowConf && (isAnchor||isRepeatLink)) missing')
  assert.ok(/linked\s*—\s*verify/.test(source),
    '"linked — verify" chip text missing')
})

test('review NEVER asks a sameness Clarification (rule 6c belt-and-suspenders)', () => {
  // Any legacy `field:"location"` ambiguity whose question mentions
  // "same"/"different" + a location noun must be filtered out
  // before it reaches ClarificationsPanel. Regression: the filter
  // removed OR the pattern relaxed to a point where an obvious
  // sameness question sneaks through.
  assert.ok(/isSamenessAsk/.test(source),
    'sameness-filter helper (isSamenessAsk) missing from review')
  assert.ok(/spot\|place\|location\|position\|point/.test(source),
    'sameness-filter noun pattern missing')
  assert.ok(/filter\(\(c\)\s*=>\s*!isSamenessAsk\(c\)\)/.test(source),
    'sameness-filter is not applied to intent.ambiguities before ClarificationsPanel')
  // And critically: ClarificationsPanel receives the FILTERED list,
  // not the raw intent.ambiguities.
  assert.ok(!/clarifications=\{intent\.ambiguities\}/.test(source),
    'ClarificationsPanel must not receive raw intent.ambiguities — must go through the sameness filter')
})

test('review uses intent.positions (not local guessing) for the LocationRef lookup', () => {
  // The chips draw their label + confidence + low_confidence from
  // the intent-side LocationRef, not from re-computing on the FE.
  // Regression: someone re-derives instead of reading the intent —
  // the two can drift.
  assert.ok(/intent\?\.positions/.test(source),
    'review must read intent.positions[] for the LocationRef metadata')
  assert.ok(/positions\.find\(\(p\)\s*=>\s*p\s*&&\s*p\.ref\s*===\s*s\.location_ref\)/.test(source),
    'LocationRef lookup by ref === s.location_ref missing')
})


// ── §430 routine condensation ─────────────────────────────────────

test('review folds routine iteration > 0 rows when routine is collapsed', () => {
  // The row map returns null for rows whose stepRoutineInfo has
  // iteration>0 unless the routine is in `expandedRoutines`.
  // Regression: someone removes the fold and 63 unrolled rows
  // reappear.
  assert.ok(/_rinfo\.iteration\s*>\s*0\s*&&\s*!isExpanded\(_rinfo\.routineId\)/.test(source),
    'fold check (iteration>0 AND !isExpanded) missing')
  assert.ok(/return null/.test(source),
    'the fold branch must return null so the row disappears from the render')
})

test('review renders the "×N" chip + fold/expand toggle on first row of a routine', () => {
  // The chip lives on the FIRST row of each routine (info.firstOfRoutine).
  // The label alternates between "▸ expand" and "▾ fold" based on
  // whether the routine is currently expanded.
  assert.ok(/_rinfo\s*&&\s*_rinfo\.firstOfRoutine\s*&&\s*\(/.test(source),
    'firstOfRoutine gating for the ×N chip missing')
  assert.ok(/×\{_rinfo\.iterations\}/.test(source),
    '×{iterations} chip text missing')
  assert.ok(/isExpanded\(_rinfo\.routineId\)\s*\?\s*['"`]▾ fold['"`]\s*:\s*['"`]▸ expand['"`]/.test(source),
    'fold/expand label toggle missing')
  assert.ok(/toggleRoutine\(_rinfo\.routineId\)/.test(source),
    'toggleRoutine wired to the ×N chip')
})

test('review header count folds along with the row count', () => {
  // When any routine is collapsed, the header must say "X shown / Y unrolled"
  // instead of just "(Y)" — otherwise the header disagrees with what's shown.
  assert.ok(/shown\s*\/\s*\$\{total\}\s*unrolled/.test(source)
              || /`\$\{shown\}\s+shown\s+\/\s+\$\{total\}\s+unrolled`/.test(source),
    'header must show "X shown / Y unrolled" when a routine is folded')
})

test('review reads draft.routines[] (not local recomputation) for iteration ranges', () => {
  // The step-idx → routine map is built from draft.routines[]. If a
  // future refactor tries to recompute grouping FE-side, it will
  // drift from the backend detector (§1 of the routine-detector
  // module doc). Guard: routines source is draft.routines.
  assert.ok(/draft\?\.routines/.test(source),
    'review must read draft.routines[] for iteration ranges')
  assert.ok(/step_indices_per_iter/.test(source),
    'step_indices_per_iter is the backend-provided range field — must be consumed here')
})
