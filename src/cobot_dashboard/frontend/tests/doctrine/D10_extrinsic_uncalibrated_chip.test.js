// D10-adjacent (2026-08-03) — the Extrinsic Uncalibrated chip on
// the Camera panel surfaces the provisional cam0→base_link
// transform's state to the operator. Doctrine anchor: "controller-
// speak never renders as protocol strings, but calibration state IS
// visible truth — the operator must know 3D positions carry a
// bias until the AprilTag calibration lands."
//
// Failure format: DOCTRINE D10 VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


function d10(msg) { return `DOCTRINE D10 VIOLATED: ${msg}` }


test('D10: Camera panel reads detections_calibrated from the store', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const panelPath = path.resolve(here,
    '../../src/components/CameraPanel.jsx')
  const src = fs.readFileSync(panelPath, 'utf8')
  assert.ok(
    src.includes('detections_calibrated'),
    d10('CameraPanel does not read `detections_calibrated` from the '
      + 'store — the operator has no visible cue that 3D positions '
      + 'are unrefined. Add the selector + chip.'))
  assert.ok(
    src.includes('Extrinsic uncalibrated'),
    d10('CameraPanel does not render the "Extrinsic uncalibrated" '
      + 'chip. Add it near the DetectionModeToggle so the caveat '
      + 'lives alongside the detection UI.'))
})


test('D10: chip renders only on cam0 AND only when uncalibrated', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const panelPath = path.resolve(here,
    '../../src/components/CameraPanel.jsx')
  const src = fs.readFileSync(panelPath, 'utf8')
  // Find the block that renders the chip (data-testid anchor).
  const anchor = 'data-testid="extrinsic-uncalibrated-chip"'
  const anchorIdx = src.indexOf(anchor)
  assert.notEqual(anchorIdx, -1,
    d10('extrinsic-uncalibrated-chip data-testid missing — the test '
      + 'anchor is what pins the render block; without it the guard '
      + 'checks below can drift silently.'))
  // Preceding 400 chars must carry BOTH guards on the render.
  const guardWindow = src.slice(Math.max(0, anchorIdx - 400), anchorIdx)
  assert.ok(
    guardWindow.includes('cam === 0'),
    d10('Uncalibrated chip missing the `cam === 0` guard — would '
      + 'stack on both camera panels like the pre-fix mode toggle bug.'))
  assert.ok(
    /!\s*detectionsCalibrated/.test(guardWindow),
    d10('Chip render guard is not negated — a calibrated system '
      + 'would still display the warning. Use `!detectionsCalibrated`.'))
})
