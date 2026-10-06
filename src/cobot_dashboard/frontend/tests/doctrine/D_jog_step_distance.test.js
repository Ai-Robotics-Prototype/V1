// DOCTRINE — Jog step-size correctness + teach-drawer Step/Continuous
// (2026-10-06 operator field report).
//
// Pre-fix bugs:
//   (1) Teach drawer only exposed Step jog — the Step/Continuous toggle
//       the main pendant has was missing, so the drawer was stuck in
//       whichever mode happened to be persisted in the shared store.
//   (2) Cartesian step chips (0.1 / 0.5 / 1 / 5 / 10 mm) all commanded
//       the SAME motion — the step chip was dropped at the UI→driver
//       seam and the driver ran a fixed 150 ms pulse at the slider
//       speed. "0.1 mm" actually moved several mm (slider-dependent).
//
// Pins:
//   * Main pendant + teach drawer both call jogPulseCartesian with the
//     operator-selected step as the 4th arg — the chip is on the wire.
//   * The store action forwards `step_mm` through to /cmd/jog_cartesian.
//   * Backend accepts + relays `step_mm` on the pulse path.
//   * Driver _start_cart_pulse reads step_mm and derives duration from
//     it; the hardcoded `duration_s = 0.150` is NOT the final value
//     when step_mm > 0 (back-compat fallback remains for legacy callers).
//   * A min-duration floor exists for cart + joint small-step cases so
//     accel-ramp swallowing is handled honestly (slow down to deliver
//     the labelled distance rather than over-shoot).
//   * Teach drawer imports + uses the SHARED setJogStyle setter so a
//     flip in the drawer propagates to the pendant and vice-versa
//     (import-identity — no local-state fork).
//
// Failure format: DOCTRINE JOG_STEP VIOLATED: <detail>

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FRONT_ROOT = join(__dirname, '..', '..')
const readSrc = (rel) => readFileSync(join(FRONT_ROOT, 'src', rel), 'utf8')
const REPO_ROOT = join(FRONT_ROOT, '..', '..', '..')
const readRepo = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

function v(msg) { return `DOCTRINE JOG_STEP VIOLATED: ${msg}` }

const jogControlsSrc = readSrc('components/JogControls.jsx')
const progEdSrc      = readSrc('components/ProgramEditor.jsx')
const storeSrc       = readSrc('store/useStore.js')
const backendSrc     = readRepo(
  'src/cobot_dashboard/cobot_dashboard/dashboard_server.py')
const driverSrc      = readRepo(
  'src/estun_driver/estun_driver/estun_driver_node.py')


// ── (1) UI call sites pass the step chip into jogPulseCartesian ───

test('JogControls.tap passes stepRef.current to jogPulseCartesian', () => {
  assert.ok(
    /jogPulseCartesian\(axis,\s*direction,\s*speedRef\.current,\s*stepRef\.current\)/
      .test(jogControlsSrc),
    v('JogControls.jsx tap() must call jogPulseCartesian(axis, direction, '
      + 'speedRef.current, stepRef.current) — before the 2026-10-06 fix '
      + 'the step chip was dropped here and the driver ran a fixed '
      + '150 ms pulse at the slider speed regardless of label.'))
})

test('TeachDrawer tap passes stepRef.current to jogPulseCartesian', () => {
  assert.ok(
    /jogPulseCartesian\(axis,\s*direction,\s*speedRef\.current,\s*stepRef\.current\)/
      .test(progEdSrc),
    v('ProgramEditor TeachDrawer tap() must call jogPulseCartesian '
      + 'with stepRef.current — the drawer and pendant share the '
      + 'STEP dispatch per the 2026-08-05 unify directive.'))
})


// ── (2) Store action forwards step_mm ─────────────────────────────

test('useStore.jogPulseCartesian signature + payload include step_mm', () => {
  assert.ok(
    /jogPulseCartesian\(axisLetter,\s*direction,\s*speedPct,\s*stepMm\)/
      .test(storeSrc),
    v('useStore.jogPulseCartesian must take `stepMm` as its 4th arg so '
      + 'the chip label survives through the store seam.'))
  assert.ok(
    /payload\.step_mm = stepMm/.test(storeSrc),
    v('useStore.jogPulseCartesian must set payload.step_mm when stepMm '
      + 'is a positive finite number — this is what reaches the backend '
      + '/cmd/jog_cartesian handler.'))
})


// ── (3) Backend relays step_mm on the pulse path ──────────────────

test('backend /cmd/jog_cartesian relays step_mm on the pulse path', () => {
  assert.ok(/step_mm = float\(body\.get\("step_mm", 0\.0\)/
              .test(backendSrc),
    v('dashboard_server /cmd/jog_cartesian must read step_mm from the '
      + 'request body (float, default 0.0).'))
  // The relayed payload adds step_mm when positive (not when zero).
  assert.ok(/payload\["step_mm"\] = step_mm/.test(backendSrc),
    v('dashboard_server must relay step_mm into the published jog '
      + 'frame when positive — the driver reads it from there.'))
})


// ── (4) Driver derives duration from step_mm ──────────────────────

test('driver _start_cart_pulse reads step_mm + derives duration', () => {
  assert.ok(/step_mm = float\(d\.get\('step_mm',\s*0\.0\)/
              .test(driverSrc),
    v('_start_cart_pulse must read step_mm from the published jog '
      + 'frame.'))
  assert.ok(/duration_s = step_mm \/ effective_mms/.test(driverSrc),
    v('_start_cart_pulse must derive duration from step_mm / '
      + 'effective_mms — the labelled distance is the source of truth.'))
  assert.ok(/_CART_MANUAL_MAX_MMPS\s*=\s*250\.0/.test(driverSrc),
    v('Driver must declare _CART_MANUAL_MAX_MMPS = 250.0 — the '
      + 'controller\'s Manual-mode cart cap, sourced from HARDWARE.md '
      + '> "Robot-limit config" (manualCartOverSpeed).'))
})

test('driver cart + joint small-step floors are present + sourced', () => {
  assert.ok(/_CART_PULSE_MIN_DUR_S\s*=\s*0\.0[46]0/.test(driverSrc),
    v('Driver must declare _CART_PULSE_MIN_DUR_S ~= 60 ms — pulses '
      + 'below this are swallowed by the drive accel-ramp window, so '
      + 'the labelled distance over-shoots at short durations.'))
  assert.ok(/_JOINT_INC_MIN_DUR_S\s*=\s*0\.0[46]0/.test(driverSrc),
    v('Driver must declare _JOINT_INC_MIN_DUR_S ~= 60 ms — same '
      + 'rationale as cart floor for small joint-step deg values.'))
  // Both paths must slow down (scale frac down) when the floor binds
  // rather than over-shoot at the short pulse. Grep that both call
  // sites compute scaled_frac.
  const nScaled = (driverSrc.match(/scaled_frac = min\(/g) || []).length
  assert.ok(nScaled >= 2,
    v(`driver must slow down commanded speed when min-duration floor `
      + `binds in BOTH cart + joint small-step paths — found `
      + `${nScaled} scaled_frac derivation(s), expected >= 2.`))
})

test('driver cart pulse keeps the legacy 150 ms fallback (back-compat)', () => {
  // Callers that haven't been updated to pass step_mm must still get
  // the pre-fix behaviour instead of 0-duration + divide-by-zero.
  assert.ok(/duration_s = 0\.150\s*#\s*legacy fallback/.test(driverSrc),
    v('Driver must keep the duration_s = 0.150 legacy fallback branch '
      + 'with an explicit "legacy fallback" comment so a caller that '
      + "doesn't pass step_mm still gets the pre-fix behaviour."))
})


// ── (5) Teach drawer exposes the Step/Continuous toggle ───────────

test('TeachDrawer renders a Step/Continuous toggle using the shared setter', () => {
  // Shared setter — SAME action useStore exposes for the main pendant.
  assert.ok(/setJogStyleShared = useStore\(\(s\) => s\.setJogStyle\)/
              .test(progEdSrc),
    v('TeachDrawer must pull setJogStyle from the shared store (NOT '
      + 'local state) so a flip in the drawer propagates to the '
      + 'pendant and vice-versa.'))
  // Toggle buttons with discoverable testids.
  assert.ok(/data-testid="teach-drawer-jog-style-toggle"/.test(progEdSrc),
    v('TeachDrawer must render data-testid="teach-drawer-jog-style-toggle" '
      + '— the operator-visible mode row.'))
  assert.ok(/data-testid="teach-drawer-jog-style-button"/.test(progEdSrc),
    v('TeachDrawer must render data-testid="teach-drawer-jog-style-button" '
      + 'per Step/Continuous choice so e2e tests can click them.'))
  // The two choices are literally STEP and CONTINUOUS.
  assert.ok(/\['STEP',\s*'CONTINUOUS'\]/.test(progEdSrc),
    v('TeachDrawer toggle must offer exactly STEP + CONTINUOUS — the '
      + 'same two modes the main pendant exposes.'))
  // Step chips below the toggle MUST dim when CONTINUOUS is active —
  // same affordance as the pendant.
  assert.ok(/opacity:\s*jogStyleShared === 'STEP' \? 1 : 0\.4/
              .test(progEdSrc),
    v('TeachDrawer step chips must dim (opacity 0.4) when the shared '
      + 'jogStyle is not STEP — mirrors JogControls.jsx:1253.'))
})
