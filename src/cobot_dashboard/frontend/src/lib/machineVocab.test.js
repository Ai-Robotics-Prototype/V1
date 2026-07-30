// Machine-tending vocabulary pin — 2026-07-30 work.
//
// Extends effectorVocab.js with clamp / cycle-start / cycle-done /
// clamp-confirmed emitters. Tests here cover:
//   * emitter shape per role (pulse triplet on cycle start, verify
//     attached to clamp when DI assigned, empty emit when role not
//     assigned)
//   * clamp/verify/release sequence guard (safety-critical)
//   * cross-effector correctness (vacuum + finger machine-tending
//     templates emit the SAME machine-side steps; only the
//     effector-linked steps differ)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampWorkpiece, unclampWorkpiece,
  startMachineCycle, waitMachineCycle,
  machinePortFor, MACHINE_ROLES, DEFAULT_CYCLE_PULSE_MS,
  validateMachineTendingOrdering,
  effectorReady, effectorEngage, effectorDisengage,
} from './effectorVocab.js'


// ── Portmap fixtures — mimic the shape /api/io/portmap returns ──

const PORTMAP_FULL = {
  ports: {
    DO2: { assignment: 'Vacuum On' },
    DO3: { assignment: 'Vacuum Blow Off' },
    DO8: { assignment: 'Machine Clamp' },
    DO9: { assignment: 'Cycle Start' },
    DI2: { assignment: 'Cycle Done' },
    DI9: { assignment: 'Clamp Confirmed' },
  },
}

const PORTMAP_MIN = {
  // Machine clamp assigned but no confirm DI — clampWorkpiece should
  // emit set_io alone (no verify).
  ports: { DO8: { assignment: 'Machine Clamp' } },
}

const PORTMAP_EMPTY = { ports: {} }


// ── machinePortFor: canonical role → port ────────────────────────

test('machinePortFor: canonical + case-insensitive substring match', () => {
  assert.equal(machinePortFor(PORTMAP_FULL, MACHINE_ROLES.CLAMP_DO_ALTS, 'DO'), 8)
  assert.equal(machinePortFor(PORTMAP_FULL, MACHINE_ROLES.CYCLE_START_ALTS, 'DO'), 9)
  assert.equal(machinePortFor(PORTMAP_FULL, MACHINE_ROLES.CYCLE_DONE_ALTS, 'DI'), 2)
  assert.equal(machinePortFor(PORTMAP_FULL, MACHINE_ROLES.CLAMP_CONF_ALTS, 'DI'), 9)
})

test('machinePortFor: kind filter refuses cross-direction mismatches', () => {
  // A DO ("Machine Clamp") must not be returned when we asked for a DI.
  assert.equal(machinePortFor(PORTMAP_FULL, MACHINE_ROLES.CLAMP_DO_ALTS, 'DI'), null)
})

test('machinePortFor: missing role → null', () => {
  assert.equal(machinePortFor(PORTMAP_EMPTY, MACHINE_ROLES.CLAMP_DO_ALTS, 'DO'), null)
})


// ── clampWorkpiece: emit shape + attached verify ─────────────────

test('clampWorkpiece: single set_io when Clamp confirmed NOT assigned', () => {
  const out = clampWorkpiece(PORTMAP_MIN)
  assert.equal(out.length, 1)
  assert.equal(out[0].action, 'set_io')
  assert.equal(out[0].label, 'Clamp workpiece')
  assert.equal(out[0].io_id, 'DO8')
  assert.equal(out[0].value, 1)
  assert.equal(out[0].io_role, 'machine_clamp')
})

test('clampWorkpiece: attaches verify_input when Clamp confirmed IS assigned', () => {
  const out = clampWorkpiece(PORTMAP_FULL)
  assert.equal(out.length, 2)
  // Ordering is CRITICAL: set_io first, verify_input immediately after.
  assert.equal(out[0].action, 'set_io')
  assert.equal(out[0].value, 1)
  assert.equal(out[1].action, 'verify_input')
  assert.equal(out[1].label, 'Verify clamp engaged')
  assert.equal(out[1].io_id, 'DI9')
  assert.equal(out[1].expect, 1)
  assert.equal(out[1].on_fail, 'abort')
  assert.equal(out[1].io_role, 'clamp_confirmed')
  // Timeout has a reasonable default the operator can override.
  assert.ok(out[1].timeout_ms >= 500 && out[1].timeout_ms <= 30000, out[1])
})

test('clampWorkpiece: no clamp DO assigned → empty emit (no-op)', () => {
  assert.deepEqual(clampWorkpiece(PORTMAP_EMPTY), [])
})


// ── unclampWorkpiece: mirror, optional verify-release ────────────

test('unclampWorkpiece: set_io value=0, no verify by default', () => {
  const out = unclampWorkpiece(PORTMAP_FULL)
  assert.equal(out.length, 1)
  assert.equal(out[0].value, 0)
  assert.equal(out[0].io_role, 'machine_clamp')
})

test('unclampWorkpiece: verifyRelease:true attaches verify when DI assigned', () => {
  const out = unclampWorkpiece(PORTMAP_FULL, { verifyRelease: true })
  assert.equal(out.length, 2)
  assert.equal(out[1].action, 'verify_input')
  assert.equal(out[1].label, 'Verify clamp released')
  assert.equal(out[1].expect, 0)
})


// ── startMachineCycle: pulse triplet ─────────────────────────────

test('startMachineCycle: emits set 1 → wait pulse_ms → set 0', () => {
  const out = startMachineCycle(PORTMAP_FULL)
  assert.equal(out.length, 3)
  assert.equal(out[0].action, 'set_io')
  assert.equal(out[0].value, 1)
  assert.equal(out[0].io_role, 'cycle_start')
  assert.equal(out[1].action, 'wait')
  assert.equal(out[1].duration_s, DEFAULT_CYCLE_PULSE_MS / 1000.0)
  assert.equal(out[2].action, 'set_io')
  assert.equal(out[2].value, 0)
  assert.equal(out[2].io_role, 'cycle_start')
})

test('startMachineCycle: pulse_ms override respects a 50ms floor', () => {
  const outMin  = startMachineCycle(PORTMAP_FULL, { pulse_ms: 10 })
  assert.equal(outMin[1].duration_s, 0.05)  // floored to 50ms
  const outLong = startMachineCycle(PORTMAP_FULL, { pulse_ms: 1500 })
  assert.equal(outLong[1].duration_s, 1.5)
})

test('startMachineCycle: no cycle_start DO assigned → empty emit', () => {
  assert.deepEqual(startMachineCycle(PORTMAP_MIN), [])
})


// ── waitMachineCycle: blocking verify_input ──────────────────────

test('waitMachineCycle: verify_input on Cycle done DI, abort on fail', () => {
  const out = waitMachineCycle(PORTMAP_FULL, { timeout_ms: 45000 })
  assert.equal(out.length, 1)
  assert.equal(out[0].action, 'verify_input')
  assert.equal(out[0].label, 'Wait for machine cycle')
  assert.equal(out[0].io_id, 'DI2')
  assert.equal(out[0].expect, 1)
  assert.equal(out[0].on_fail, 'abort')
  assert.equal(out[0].timeout_ms, 45000)
})

test('waitMachineCycle: no cycle_done DI assigned → empty emit', () => {
  assert.deepEqual(waitMachineCycle(PORTMAP_EMPTY), [])
})


// ── SEQUENCE GUARD — the safety rule ─────────────────────────────

test('sequence guard: clamp → verify → release is SAFE', () => {
  const steps = [
    { action: 'move_linear', label: 'Place in fixture — contact', position_role: 'machine_load' },
    { action: 'set_io', label: 'Clamp workpiece', io_id: 'DO8', value: 1, io_role: 'machine_clamp' },
    { action: 'verify_input', label: 'Verify clamp engaged', io_id: 'DI9', expect: 1, io_role: 'clamp_confirmed' },
    { action: 'set_io', label: 'Disengage vacuum', io_id: 'DO2', value: 0, io_role: 'vacuum' },
  ]
  assert.deepEqual(validateMachineTendingOrdering(steps), [])
})

test('sequence guard: clamp → release → verify is UNSAFE (vacuum release)', () => {
  const steps = [
    { action: 'set_io', label: 'Clamp workpiece', io_id: 'DO8', value: 1, io_role: 'machine_clamp' },
    { action: 'set_io', label: 'Disengage vacuum', io_id: 'DO2', value: 0, io_role: 'vacuum' },
    { action: 'verify_input', label: 'Verify clamp engaged', io_id: 'DI9', expect: 1, io_role: 'clamp_confirmed' },
  ]
  const v = validateMachineTendingOrdering(steps)
  assert.equal(v.length, 1)
  assert.equal(v[0].step_index, 1)
  assert.equal(v[0].clamp_step_index, 0)
  assert.match(v[0].reason, /releases the robot's grip/)
})

test('sequence guard: clamp → open_gripper → verify is UNSAFE (finger release)', () => {
  const steps = [
    { action: 'set_io', label: 'Clamp workpiece', io_id: 'DO8', value: 1, io_role: 'machine_clamp' },
    { action: 'open_gripper', label: 'Release part into fixture', width_mm: 85, io_open: 'DO1' },
    { action: 'verify_input', label: 'Verify clamp engaged', io_id: 'DI9', expect: 1, io_role: 'clamp_confirmed' },
  ]
  const v = validateMachineTendingOrdering(steps)
  assert.equal(v.length, 1)
  assert.equal(v[0].step_index, 1)
})

test('sequence guard: clamp WITHOUT verify (no clamp_confirmed DI) is NOT flagged', () => {
  // If the operator didn't assign Clamp confirmed, we don't emit a
  // verify, and the guard has nothing to enforce. Grip-release
  // right after clamp is the operator's own risk in that case —
  // the guard doesn't require a verify to exist.
  const steps = [
    { action: 'set_io', label: 'Clamp workpiece', io_id: 'DO8', value: 1, io_role: 'machine_clamp' },
    { action: 'set_io', label: 'Disengage vacuum', io_id: 'DO2', value: 0, io_role: 'vacuum' },
  ]
  assert.deepEqual(validateMachineTendingOrdering(steps), [])
})

test('sequence guard: magnet release between clamp and verify is UNSAFE', () => {
  const steps = [
    { action: 'set_io', label: 'Clamp workpiece', io_id: 'DO8', value: 1, io_role: 'machine_clamp' },
    { action: 'set_io', label: 'Disengage magnet', io_id: 'DO3', value: 0, io_role: 'magnet' },
    { action: 'verify_input', label: 'Verify clamp engaged', io_id: 'DI9', expect: 1, io_role: 'clamp_confirmed' },
  ]
  const v = validateMachineTendingOrdering(steps)
  assert.equal(v.length, 1)
})


// ── Cross-effector: template shape is the same on both sides ────

function _machinTemplateShape(effector, portmap) {
  // Mirrors the wizard's machine_tend section. All effector-linked
  // steps route through effectorReady/Engage/Disengage; all machine-
  // side steps through clampWorkpiece/startMachineCycle/etc. The two
  // vocabularies share this module — the guard confirms they stay
  // consistent on both effectors.
  const cfg = { effector }
  return [
    { action: 'move_home', label: 'Move to home position' },
    ...effectorReady(cfg),
    { action: 'move_linear', label: 'Move to safe-outside-machine waypoint', position_role: 'machine_safe' },
    { action: 'move_linear', label: 'Approach machine fixture', derived_from: 'machine_load' },
    { action: 'move_linear', label: 'Place in fixture — contact', position_role: 'machine_load' },
    ...clampWorkpiece(portmap),
    ...effectorDisengage(cfg, { withBlowOff: false, labelOverride: 'Release part into fixture' }),
    { action: 'move_linear', label: 'Retreat from fixture', derived_from: 'machine_load' },
    ...startMachineCycle(portmap),
    ...waitMachineCycle(portmap),
    { action: 'move_linear', label: 'Approach fixture (finished part)', derived_from: 'machine_load' },
    ...effectorEngage(cfg, { labelOverride: effector === 'finger' ? 'Grip finished part' : 'Pick finished part' }),
    ...unclampWorkpiece(portmap),
    { action: 'move_linear', label: 'Retreat with finished part', derived_from: 'machine_load' },
    { action: 'move_home', label: 'Return to home' },
  ]
}

test('cross-effector: vacuum machine-tending template passes the safety guard', () => {
  const steps = _machinTemplateShape('vacuum', PORTMAP_FULL)
  assert.deepEqual(validateMachineTendingOrdering(steps), [])
})

test('cross-effector: finger machine-tending template passes the safety guard', () => {
  const steps = _machinTemplateShape('finger', PORTMAP_FULL)
  assert.deepEqual(validateMachineTendingOrdering(steps), [])
})

test('cross-effector: machine-side steps are IDENTICAL across effectors', () => {
  const v = _machinTemplateShape('vacuum', PORTMAP_FULL)
  const f = _machinTemplateShape('finger', PORTMAP_FULL)
  // Filter to just the machine-side steps (identified by io_role
  // that starts with machine_ / clamp_ / cycle_).
  const machineOnly = (steps) => steps.filter((s) => {
    const r = s.io_role || ''
    return r.startsWith('machine_') || r.startsWith('clamp_') || r.startsWith('cycle_')
  })
  assert.deepEqual(machineOnly(v), machineOnly(f),
    'the machine-side vocabulary must not vary by effector')
})


// ── Regression: portmap unset (early-mount before /api/io/portmap
//                              resolves) — no exceptions, no emit ─

test('emitters tolerate null portmap without throwing', () => {
  assert.deepEqual(clampWorkpiece(null),        [])
  assert.deepEqual(unclampWorkpiece(null),      [])
  assert.deepEqual(startMachineCycle(null),     [])
  assert.deepEqual(waitMachineCycle(null),      [])
})
