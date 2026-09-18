// Pinned effector-vocabulary purity — 2026-07-30 audit instance #4.
//
// The wizard used to hardcode gripper-vocabulary labels ("Grip part",
// "Release part") on the pick-and-place body regardless of the
// answered effector. When effector=vacuum, the operator saw gripper
// wording all over a vacuum program. Fix routes wizard step
// generation through lib/effectorVocab — same source PBD composer
// uses on the backend.
//
// These tests exercise the shared emitters directly (independent of
// React), pinning the invariant: a vacuum program has ZERO
// gripper-vocabulary strings; a finger program has ZERO vacuum
// strings; every emit path (ready / engage / disengage) respects
// the effector.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectorOf, effectorReady, effectorEngage, effectorDisengage,
  paletteLabelForAction, CANONICAL_EFFECTORS, VOCAB_TOKENS,
} from './effectorVocab.js'


// ── effectorOf: canonicalisation ─────────────────────────────────

test('effectorOf: unknown / missing → finger', () => {
  assert.equal(effectorOf(null),                        'finger')
  assert.equal(effectorOf({}),                          'finger')
  assert.equal(effectorOf({ effector: '' }),            'finger')
  assert.equal(effectorOf({ effector: 'unknown' }),     'finger')
})

test('effectorOf: recognises finger / vacuum / magnetic / custom', () => {
  for (const e of CANONICAL_EFFECTORS) {
    assert.equal(effectorOf({ effector: e }),           e)
    assert.equal(effectorOf({ effector: e.toUpperCase() }), e)
  }
})

test('effectorOf: falls back to gripper_type legacy field', () => {
  assert.equal(effectorOf({ gripper_type: 'vacuum' }),  'vacuum')
})


// ── the bug: vacuum program has NO gripper-vocabulary strings ───

function _labels(steps) {
  return steps.map((s) => String(s.label || ''))
}

test('vacuum ready+engage+disengage — zero gripper-vocabulary strings', () => {
  const cfg = { effector: 'vacuum' }
  const all = [
    ...effectorReady(cfg),
    ...effectorEngage(cfg),
    ...effectorDisengage(cfg),
  ]
  const labels = _labels(all)
  // Zero finger-vocabulary strings anywhere.
  for (const finger of VOCAB_TOKENS.finger) {
    assert.equal(labels.some((l) => l.includes(finger)), false,
      `vacuum path must not emit finger string ${finger}: ${labels.join(',')}`)
  }
  // Positive proof: the expected vacuum strings ARE present.
  assert.ok(labels.some((l) => l.includes('Vacuum off (ready)')),
    `expected 'Vacuum off (ready)' in ${labels}`)
  assert.ok(labels.some((l) => l.includes('Engage vacuum')),
    `expected 'Engage vacuum' in ${labels}`)
  assert.ok(labels.some((l) => l.includes('Disengage vacuum')),
    `expected 'Disengage vacuum' in ${labels}`)
  assert.ok(labels.some((l) => l.includes('Blow off')),
    `expected 'Blow off' (blow-off triplet) in ${labels}`)
})

test('finger ready+engage+disengage — zero vacuum/magnet strings', () => {
  const cfg = { effector: 'finger' }
  const all = [
    ...effectorReady(cfg),
    ...effectorEngage(cfg),
    ...effectorDisengage(cfg),
  ]
  const labels = _labels(all)
  for (const t of [...VOCAB_TOKENS.vacuum, ...VOCAB_TOKENS.magnetic]) {
    assert.equal(labels.some((l) => l.includes(t)), false,
      `finger path must not emit ${t} — got ${labels}`)
  }
  assert.ok(labels.some((l) => l.includes('Grip part')),
    `expected 'Grip part' in finger path, got ${labels}`)
  assert.ok(labels.some((l) => l.includes('Open gripper')),
    `expected 'Open gripper' in finger path, got ${labels}`)
})

test('magnetic path — zero finger/vacuum strings', () => {
  const cfg = { effector: 'magnetic' }
  const all = [
    ...effectorReady(cfg),
    ...effectorEngage(cfg),
    ...effectorDisengage(cfg),
  ]
  const labels = _labels(all)
  for (const t of [...VOCAB_TOKENS.finger, ...VOCAB_TOKENS.vacuum]) {
    assert.equal(labels.some((l) => l.includes(t)), false,
      `magnetic path must not emit ${t} — got ${labels}`)
  }
  assert.ok(labels.some((l) => l.includes('Engage magnet')))
  assert.ok(labels.some((l) => l.includes('Disengage magnet')))
})


// ── io_role tag round-trips so IO remapping can find every step ──

test('vacuum steps carry io_role="vacuum" (or "blow_off" for blow triplet)', () => {
  const cfg = { effector: 'vacuum' }
  const all = [
    ...effectorReady(cfg),
    ...effectorEngage(cfg),
    ...effectorDisengage(cfg),
  ]
  const setIoSteps = all.filter((s) => s.action === 'set_io')
  const roles = setIoSteps.map((s) => s.io_role)
  // Every set_io step is tagged with vacuum or blow_off.
  for (const r of roles) {
    assert.ok(r === 'vacuum' || r === 'blow_off',
      `unexpected io_role ${r} in vacuum path`)
  }
})


// ── palette labels for the Add Step dropdown ─────────────────────

test('paletteLabelForAction: effector-aware per action', () => {
  assert.equal(paletteLabelForAction('close_gripper', { effector: 'vacuum' }),
    'Engage vacuum')
  assert.equal(paletteLabelForAction('close_gripper', { effector: 'finger' }),
    'Grip part')
  assert.equal(paletteLabelForAction('close_gripper', { effector: 'magnetic' }),
    'Engage magnet')
  assert.equal(paletteLabelForAction('open_gripper', { effector: 'vacuum' }),
    'Disengage vacuum')
  assert.equal(paletteLabelForAction('open_gripper', { effector: 'finger' }),
    'Open gripper')
  // Actions without a mapped effector variant → null (caller falls
  // back to the generic ACTION_TYPES.label).
  assert.equal(paletteLabelForAction('move_home',  { effector: 'vacuum' }), null)
  assert.equal(paletteLabelForAction('wait',       { effector: 'finger' }), null)
})


// ── labelOverride preserves engage/disengage vocabulary ─────────

test('labelOverride: machine-tending "into machine" keeps vacuum vocabulary', () => {
  // The wizard's machine-tending flow uses labelOverride='Release
  // part into machine' — for finger this should render verbatim,
  // for vacuum the label should show up but the io/action stays
  // effector-driven.
  const finger = effectorDisengage(
    { effector: 'finger' },
    { labelOverride: 'Release part into machine', withBlowOff: false })
  assert.equal(finger[0].action, 'open_gripper')
  assert.equal(finger[0].label,  'Release part into machine')

  const vacuum = effectorDisengage(
    { effector: 'vacuum' },
    { labelOverride: 'Release part into machine', withBlowOff: false })
  assert.equal(vacuum[0].action, 'set_io')
  assert.equal(vacuum[0].label,  'Release part into machine')
  assert.equal(vacuum[0].io_role, 'vacuum')
})


// ── the exact operator-caught #4 (wizard label bypass) ──────────

test('the operator-caught bug is fixed: engage on vacuum program is NOT "Grip part"', () => {
  const cfg = { effector: 'vacuum' }
  const engage = effectorEngage(cfg)
  // The first emitted step is the set_io that turns vacuum ON. Its
  // label is "Engage vacuum" — NEVER "Grip part". This test is the
  // structural inverse of the operator-observed bug.
  assert.equal(engage[0].action, 'set_io')
  assert.equal(engage[0].label,  'Engage vacuum')
  assert.notEqual(engage[0].label, 'Grip part')
  // And the wait for seal follows — same shape the PBD composer
  // emits for vacuum picks.
  assert.equal(engage[1].label, 'Wait for vacuum seal')
})


// ── whole-program purity — the shape the wizard now emits ────────

function _wizardShape(effector) {
  // Reconstruct the wizard's pick+place body using ONLY the shared
  // emitters, then check vocabulary purity across every label. Any
  // future wizard drift that bypasses the shared module will be
  // caught by the no-fork-truth guard; this test locks the shared
  // module's own invariant.
  const cfg = { effector }
  return [
    { action: 'move_home', label: 'Move to home position' },
    ...effectorReady(cfg),
    { action: 'move_linear', label: 'Approach above pick', derived_from: 'pick' },
    { action: 'move_linear', label: 'Pick position — contact', position_role: 'pick' },
    ...effectorEngage(cfg),
    { action: 'move_linear', label: 'Retreat above pick', derived_from: 'pick' },
    { action: 'move_linear', label: 'Approach above place', derived_from: 'place' },
    { action: 'move_linear', label: 'Place position — contact', position_role: 'place' },
    ...effectorDisengage(cfg),
    { action: 'move_linear', label: 'Retreat above place', derived_from: 'place' },
    { action: 'move_home', label: 'Return to home' },
  ]
}

test('whole-program purity: vacuum wizard emits zero gripper vocabulary', () => {
  const steps = _wizardShape('vacuum')
  const labels = _labels(steps)
  for (const finger of VOCAB_TOKENS.finger) {
    assert.equal(labels.some((l) => l.includes(finger)), false,
      `vacuum wizard-shape must not emit finger string "${finger}"; got ${labels.join(', ')}`)
  }
  // And the vacuum-vocabulary IS present.
  assert.ok(labels.some((l) => l === 'Engage vacuum'))
  assert.ok(labels.some((l) => l === 'Disengage vacuum'))
  assert.ok(labels.some((l) => l === 'Vacuum off (ready)'))
})

test('whole-program purity: finger wizard emits zero vacuum vocabulary', () => {
  const steps = _wizardShape('finger')
  const labels = _labels(steps)
  for (const t of [...VOCAB_TOKENS.vacuum, ...VOCAB_TOKENS.magnetic]) {
    assert.equal(labels.some((l) => l.includes(t)), false,
      `finger wizard-shape must not emit ${t}; got ${labels.join(', ')}`)
  }
  assert.ok(labels.some((l) => l === 'Open gripper'))
  assert.ok(labels.some((l) => l === 'Grip part'))
  assert.ok(labels.some((l) => l === 'Release part'))
})

test('whole-program purity: magnetic wizard emits zero finger/vacuum vocabulary', () => {
  const steps = _wizardShape('magnetic')
  const labels = _labels(steps)
  for (const t of [...VOCAB_TOKENS.finger, ...VOCAB_TOKENS.vacuum]) {
    assert.equal(labels.some((l) => l.includes(t)), false,
      `magnetic wizard-shape must not emit ${t}; got ${labels.join(', ')}`)
  }
  assert.ok(labels.some((l) => l === 'Magnet off (ready)'))
  assert.ok(labels.some((l) => l === 'Engage magnet'))
  assert.ok(labels.some((l) => l === 'Disengage magnet'))
})
