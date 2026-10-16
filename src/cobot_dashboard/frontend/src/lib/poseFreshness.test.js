// Unit tests for the pose-display freshness helpers.
//
// Run: node --test src/lib/poseFreshness.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  POSE_FRESH_MS,
  POSE_WAIT_TIMEOUT_MS,
  computePoseAgeMs,
  isPoseFresh,
  formatPoseAge,
} from './poseFreshness.js'


// ── computePoseAgeMs ────────────────────────────────────────────────

test('computePoseAgeMs returns 0 when now == lastMessageTime', () => {
  assert.equal(computePoseAgeMs(1000, 1000), 0)
})

test('computePoseAgeMs subtracts wall clock', () => {
  assert.equal(computePoseAgeMs(1000, 1500), 500)
  assert.equal(computePoseAgeMs(1000, 3000), 2000)
})

test('computePoseAgeMs returns Infinity when no frame yet', () => {
  assert.equal(computePoseAgeMs(0, 1000), Infinity)
  assert.equal(computePoseAgeMs(undefined, 1000), Infinity)
  assert.equal(computePoseAgeMs(null, 1000), Infinity)
  assert.equal(computePoseAgeMs(NaN, 1000), Infinity)
})

test('computePoseAgeMs clamps negative ages to 0 (clock skew)', () => {
  // If the client's Date.now() somehow rewinds (e.g., NTP correction
  // between the WS receive and the press), we must not report a
  // negative age — the freshness check would silently mis-fire.
  assert.equal(computePoseAgeMs(2000, 1000), 0)
})


// ── isPoseFresh ──────────────────────────────────────────────────────

test('isPoseFresh is true when age <= POSE_FRESH_MS', () => {
  assert.equal(isPoseFresh(1000, 1000), true)               // age 0
  assert.equal(isPoseFresh(1000, 1000 + POSE_FRESH_MS), true) // exact boundary
})

test('isPoseFresh is false when age > POSE_FRESH_MS', () => {
  assert.equal(isPoseFresh(1000, 1000 + POSE_FRESH_MS + 1), false)
  assert.equal(isPoseFresh(1000, 5000), false)
})

test('isPoseFresh is false when no frame yet', () => {
  assert.equal(isPoseFresh(0, 5000), false)
})


// ── formatPoseAge ────────────────────────────────────────────────────

test('formatPoseAge renders ms below 1 s', () => {
  assert.equal(formatPoseAge(0),   '0 ms')
  assert.equal(formatPoseAge(340), '340 ms')
  assert.equal(formatPoseAge(999), '999 ms')
})

test('formatPoseAge renders one decimal from 1 s to 10 s', () => {
  assert.equal(formatPoseAge(1000), '1.0 s')
  assert.equal(formatPoseAge(3400), '3.4 s')
  assert.equal(formatPoseAge(9999), '10.0 s')
})

test('formatPoseAge rounds seconds at or above 10 s', () => {
  assert.equal(formatPoseAge(10000), '10 s')
  assert.equal(formatPoseAge(14200), '14 s')
})

test('formatPoseAge reports "no signal yet" for Infinity / invalid', () => {
  assert.equal(formatPoseAge(Infinity), 'no signal yet')
  assert.equal(formatPoseAge(NaN),      'no signal yet')
  assert.equal(formatPoseAge(-1),       'no signal yet')
})


// ── Constants sanity ─────────────────────────────────────────────────

test('POSE_FRESH_MS matches the operator directive (1000 ms)', () => {
  assert.equal(POSE_FRESH_MS, 1000)
})

test('POSE_WAIT_TIMEOUT_MS matches the operator directive (2000 ms)', () => {
  assert.equal(POSE_WAIT_TIMEOUT_MS, 2000)
})
