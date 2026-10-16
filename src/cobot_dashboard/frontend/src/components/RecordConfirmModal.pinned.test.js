// RecordConfirmModal pin — 2026-10-09 operator directive.
//
// The record-position confirm must stay as a clean "Record position?"
// prompt with Record / Cancel buttons. All coordinate / TCP detail
// lives behind a Show-details expander that is COLLAPSED by default.
// The capture path (what actually gets written into the step) is NOT
// changed by this component — the modal only decides whether its
// `onConfirm` callback fires.
//
// Source-level checks (matches ProgramEditor.pinned.test.js pattern
// — no JSX renderer + jsdom required).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const source = fs.readFileSync(
  path.resolve(__dirname, 'RecordConfirmModal.jsx'), 'utf8')


test('title reads "Record position?" verbatim (no step label clutter)', () => {
  // Earlier copy ("Confirm capture" over "Record this position?" over
  // a two-line explanatory paragraph) is retired. The dialog opens
  // with ONE question so a tablet operator reading at distance can
  // confirm in one glance.
  assert.match(source, /Record position\?/,
    'title must be the exact "Record position?" prompt')
  assert.doesNotMatch(source, /Confirm capture/i,
    '"Confirm capture" preamble is retired')
  assert.doesNotMatch(source, /Record this position\?/i,
    'old "Record this position?" wording is retired')
  assert.doesNotMatch(source, /pose shown below is the arm/i,
    'two-line explanatory paragraph is retired — the prompt is '
    + 'self-explanatory')
})


test('Record (primary) + Cancel buttons are the only action controls', () => {
  assert.match(source, /data-testid=["']record-confirm-record-button["']/,
    'Record button must be test-targetable')
  assert.match(source, /data-testid=["']record-confirm-cancel-button["']/,
    'Cancel button must be test-targetable')
  // Record is the primary (green) action; Cancel is the muted
  // secondary. Visual-weight pin so a future refactor can't
  // accidentally swap them (operator reads shape at a glance).
  const recordButton = source.match(
    /data-testid=["']record-confirm-record-button["'][\s\S]{0,500}?<\/button>/)
  assert.ok(recordButton, 'could not locate record button block')
  assert.match(recordButton[0], /#16A34A/,
    'Record stays green (#16A34A) as the primary action')
  assert.match(recordButton[0], />\s*Record\s*</,
    'button text must read "Record"')
})


test('details expander is collapsed by default', () => {
  // The `showDetails` state must initialise to false so the clean
  // "Record position?" prompt is what the operator sees on open.
  // Any future edit that flips this to `true` or makes it toggle
  // via a persisted preference is caught here.
  assert.match(source, /useState\(\s*false\s*\)/,
    'showDetails state must initialise to false (expander collapsed)')
  assert.match(source,
    /data-testid=["']record-confirm-details-toggle["']/,
    'details toggle button must be test-targetable')
  assert.match(source,
    /data-testid=["']record-confirm-details-panel["']/,
    'details panel must be test-targetable (so the test suite can '
    + 'assert its absence from the default view)')
  // The details panel renders inside a `{showDetails && (...)}` branch
  // so it is NOT in the DOM until the operator opens it. Keeps
  // noise out of accessibility trees + search.
  assert.match(source,
    /showDetails\s*&&\s*\(\s*<div[\s\S]{0,200}?data-testid=["']record-confirm-details-panel["']/,
    'the details panel must be gated behind showDetails so the '
    + 'collapsed default view contains no coordinate dump')
})


test('details panel is the ONLY site that renders joint / tcp readout', () => {
  // The joints / tcp strings must appear exclusively inside the
  // conditionally-rendered details panel. If the readout escapes
  // the gate, the clean prompt reverts to clutter.
  const detailsPanel = source.match(
    /showDetails\s*&&\s*\(\s*<div[\s\S]*?<\/div>\s*\)/)
  assert.ok(detailsPanel, 'could not locate the conditional details panel')
  // Count joint-readout tokens in the WHOLE source vs inside the
  // panel — they must be equal.
  const total = (source.match(/joints: \{jointsLine\}/g) || []).length
  const inside = (detailsPanel[0].match(/joints: \{jointsLine\}/g) || []).length
  assert.equal(total, inside,
    'joints readout must only appear inside the collapsed-by-default '
    + 'details panel')
  const totalTcp = (source.match(/tcp:\s*\{tcpLine/g) || []).length
  const insideTcp = (detailsPanel[0].match(/tcp:\s*\{tcpLine/g) || []).length
  assert.equal(totalTcp, insideTcp,
    'tcp readout must only appear inside the collapsed-by-default '
    + 'details panel')
})


test('recorded-data capture path is untouched: modal fires onConfirm only', () => {
  // The modal does not touch program state directly — the only
  // writes it performs are the `showDetails` toggle and the live
  // tcp poll into local state. The actual pose capture lives in
  // the parent's `onConfirm` callback (editor's doRecord ->
  // teachOverlayRecord). Pin that the Record button simply calls
  // `onConfirm` with no transformation of the recorded data.
  const recordButton = source.match(
    /data-testid=["']record-confirm-record-button["'][\s\S]{0,500}?<\/button>/)
  assert.ok(recordButton, 'could not locate record button block')
  assert.match(recordButton[0], /onClick=\{onConfirm\}/,
    'Record must call the parent onConfirm callback directly — no '
    + 'local pose-transformation, no store writes')
  // Equivalent pin for Cancel.
  const cancelButton = source.match(
    /data-testid=["']record-confirm-cancel-button["'][\s\S]{0,500}?<\/button>/)
  assert.ok(cancelButton)
  assert.match(cancelButton[0], /onClick=\{onCancel\}/,
    'Cancel must call the parent onCancel callback directly')
})


test('live TCP poll only runs while the details panel is open', () => {
  // Operator who never opens the expander should pay no cost. The
  // 500 ms interval runs inside a `useEffect(..., [showDetails])`
  // guarded by `if (!showDetails) return`. Pin that structure so a
  // regression doesn't start polling on every mount.
  const effect = source.match(
    /useEffect\(\(\) => \{[\s\S]{0,600}?\}, \[showDetails\]\)/)
  assert.ok(effect, 'tcp useEffect must depend on [showDetails]')
  assert.match(effect[0], /if \(!showDetails\) return/,
    'tcp poll must early-return when details panel is closed')
})
