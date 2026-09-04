// DOCTRINE D8 — Taught wrists within a program should agree;
// disagreement is flagged at TEACH time (Match), not discovered
// at runtime.
//
// Failure format:
//   DOCTRINE D8 VIOLATED: <detail>
//
// Phase-1 coverage:
//  (a) The Match feature exists in the teach overlay (Match:
//      selector for Joint-mode target overlays).
//  (b) Source-level: teach overlay renders per-joint target values
//      with a green tint when matched — the WIRE for the promise.
//
// Phase-2 (TODO): full wrist-comparison analyzer — walk every
// program's taught poses, compare wrists at semantically equivalent
// stations (pick↔pick, place↔place, home↔home), flag disagreement
// beyond ε in the debt banner.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d8(msg) { return `DOCTRINE D8 VIOLATED: ${msg}` }


const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = path.resolve(__dirname, '..', '..')
const editorSrc = fs.readFileSync(
  path.join(FRONTEND_ROOT, 'src', 'components', 'ProgramEditor.jsx'),
  'utf8')


test('D8(a): teach overlay carries a Match: target selector', () => {
  assert.ok(/matchName/.test(editorSrc),
    d8('teach overlay must expose the Match: target selector — the '
     + 'operator-facing promise that wrist agreement is checked at '
     + 'teach time, not runtime'))
  assert.ok(/showMatchSelector/.test(editorSrc),
    d8('showMatchSelector gate must exist so the Match: control '
     + 'appears in Joint mode when taught points are available'))
})


test('D8(b): teach overlay renders per-joint target values with green tint', () => {
  // The overlay computes `matched = hasTarget && angleDeg != null
  //                       && Math.abs(angleDeg - targetDeg) <= 0.5`
  // and tints the live angle green when matched. This is the "dial
  // to green" affordance — the concrete UI wire for D8's promise.
  assert.ok(/matched\s*=/.test(editorSrc),
    d8('teach overlay must compute a `matched` flag per joint — '
     + 'dial-to-green is the D8 mechanic'))
  assert.ok(/0\.5/.test(editorSrc),
    d8('teach overlay must use a 0.5° tolerance for the match check '
     + '(pinned so a future refactor to a wider tolerance surfaces here)'))
})


test('D8: phase-2 stub — wrist-comparison analyzer not yet implemented', () => {
  // TODO(phase 2): add lib/wristAgreement.js with
  //   compareWristsAtStations(program) → [{ role, pair, delta }]
  // and surface violations in the teaching debt banner. Doctrine
  // fails when the analyzer exists but has NO test coverage.
  const analyzer = path.join(FRONTEND_ROOT, 'src', 'lib', 'wristAgreement.js')
  if (fs.existsSync(analyzer)) {
    const test = path.join(FRONTEND_ROOT, 'src', 'lib', 'wristAgreement.test.js')
    assert.ok(fs.existsSync(test),
      d8('wristAgreement.js exists but has no test file. When you '
       + 'wire the phase-2 analyzer, land tests in the same commit.'))
  }
  // Phase-1: only the teach-time affordances are pinned above.
})
