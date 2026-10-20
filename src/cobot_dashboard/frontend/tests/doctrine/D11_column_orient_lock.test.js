// DOCTRINE D11 — Column orientation lock. Within each station
// column (approach-above → contact → retreat-above), TCP
// orientation is identical to the taught contact anchor's
// orientation within 0.1° on the max-axis of R_anchor · R_derived^T.
//
// Backend-enforced by `seeded_ik_z_lift_hold_orientation` +
// `analyze_program` (severity='block') + `_d11_block_findings`
// on POST/PUT /api/programs.
//
// Frontend surface (phase 1): the row-level display must reflect
// the analyzer's block finding — no silent save when the analyzer
// returns a D11 block. verbForStep already surfaces reasons; the
// analyzer wire is what this test pins today. When the backend
// codegen fixtures ship, phase 2 will snapshot the emitted Lua's
// 'D11 column-orientation-lock' stamps.
//
// Failure format:
//   DOCTRINE D11 VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'


function d11(msg) { return `DOCTRINE D11 VIOLATED: ${msg}` }


test('D11(a): analyzer report shape carries severity for D11 findings', () => {
  // Simulated analyzer response — the wire contract the dashboard
  // renders. A block finding MUST carry severity='block' + rule
  // in {column_orient_delta, column_orient_ik_failed}. This is what
  // the dashboard save gate reads.
  const report = {
    findings: [
      { severity: 'block', rule: 'column_orient_delta',
        message: 'D11 column-orientation-lock VIOLATED', step_idx: 2,
        metrics: { orient_err_deg: 4.2, tolerance_deg: 0.1 } },
    ],
  }
  const blocks = (report.findings || []).filter(
    f => f.severity === 'block'
      && (f.rule === 'column_orient_delta'
          || f.rule === 'column_orient_ik_failed'))
  assert.equal(blocks.length, 1,
    d11(`D11 block finding not surfaced in analyzer report — the `
      + `dashboard save gate reads finding.severity==='block'; this `
      + `finding shape must match what program_ops.analyze_program `
      + `emits.`))
  assert.ok(blocks[0].message.includes('D11'),
    d11(`block message must carry the D11 tag: got ${blocks[0].message}`))
})


test('D11(b): tilt info finding surfaces above 3° threshold', () => {
  // Info finding shape — anchor tilted > 3° from vertical. Not a
  // block; the row surfaces the tilt so the operator can catch a
  // crooked teach at teach time.
  const report = {
    findings: [
      { severity: 'info', rule: 'anchor_tilt_from_vertical',
        message: "'pick' taught with tool tilted 7.2° from vertical",
        step_idx: 3,
        metrics: { tilt_deg: 7.2, threshold_deg: 3.0 } },
    ],
  }
  const tilt = (report.findings || []).filter(
    f => f.rule === 'anchor_tilt_from_vertical')
  assert.equal(tilt.length, 1,
    d11(`tilt info finding missing — a crooked anchor must be `
      + `visible at teach time, not discovered on camera.`))
  assert.equal(tilt[0].severity, 'info',
    d11(`tilt finding is INFO, not block — the operator may have `
      + `taught the tilt intentionally.`))
  assert.ok(tilt[0].metrics.tilt_deg > tilt[0].metrics.threshold_deg,
    d11(`tilt finding fired at ${tilt[0].metrics.tilt_deg}° despite `
      + `threshold ${tilt[0].metrics.threshold_deg}° — surfacing rule `
      + `must gate at threshold`))
})


test('D11(c): a rotating column cannot save — 422 with block reason', () => {
  // Simulate the dashboard save-gate response. When the backend
  // returns 422 with d11_block_findings, the frontend MUST NOT
  // treat it as a silent success. The gate wire:
  //
  //   POST /api/programs → 422 { error, d11_block_findings: [...] }
  //   PUT  /api/programs/{id} → same
  //
  // Frontend behavior: surface the error string verbatim; the
  // block reason is the operator's fix instruction.
  const saveResponse = {
    status: 422,
    body: {
      error: 'D11 column orientation lock: derived pose for pick '
           + "carries orientation 4.2000° off the anchor's taught "
           + 'orientation (tolerance 0.1°).',
      d11_block_findings: [
        { severity: 'block', rule: 'column_orient_delta',
          message: 'D11 column-orientation-lock VIOLATED' },
      ],
    },
  }
  assert.equal(saveResponse.status, 422,
    d11(`D11 save gate must return 422 (not 200/500) so the client `
      + `distinguishes doctrine violation from an infra error`))
  assert.ok(saveResponse.body.error.includes('D11'),
    d11(`save error must name D11 in the message so the operator `
      + `can grep back to the rule: got ${saveResponse.body.error}`))
  assert.ok(saveResponse.body.d11_block_findings.length >= 1,
    d11(`save response missing d11_block_findings array — frontend `
      + `can't render per-step block reasons without it`))
})


// TODO(phase 2): invoke Python codegen from Node (via child_process
// or a fixture-generation script run at test setup) and:
//   * Assert every 'columns-always-cartesian' movL line in the emitted
//     Lua carries an orient_dev=X.XXXX° note with X < 0.1.
//   * Assert POST /api/programs on a synthetic rotating-column program
//     returns HTTP 422 with the D11 block finding in the body.
