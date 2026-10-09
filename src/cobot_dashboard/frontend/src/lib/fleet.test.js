// Unit tests for lib/fleet.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FLEET_STATUSES,
  FLEET_STATUS_PALETTE,
  statusPalette,
  normalizeCard,
  pickLandingView,
} from './fleet.js'


// ── FLEET_STATUSES ───────────────────────────────────────────────────

test('FLEET_STATUSES matches the backend ladder outputs plus Offline', () => {
  assert.deepEqual(FLEET_STATUSES.sort(),
    ['Alarm', 'Idle', 'Offline', 'Ready', 'Running'])
})

test('every status has a palette entry', () => {
  for (const s of FLEET_STATUSES) {
    const p = FLEET_STATUS_PALETTE[s]
    assert.ok(p && p.bg && p.fg && p.border,
      `palette missing entries for status "${s}"`)
  }
})

test('statusPalette falls back to Offline for unknown', () => {
  const off = statusPalette('Offline')
  assert.deepEqual(statusPalette('WhoKnows'), off)
})


// ── normalizeCard ────────────────────────────────────────────────────

test('normalizeCard coerces a self card from the backend payload', () => {
  const card = normalizeCard({
    url: '', host: '', port: 0,
    identity: { serial: 'NR-1', model: 'S10-140', friendly_name: 'A' },
    status: 'Ready', connected: true, alarm: null,
    current_program: null, online: true, probe_ms: 0, is_self: true,
  })
  assert.equal(card.serial, 'NR-1')
  assert.equal(card.model,  'S10-140')
  assert.equal(card.friendlyName, 'A')
  assert.equal(card.status, 'Ready')
  assert.equal(card.isSelf, true)
  assert.equal(card.isOffline, false)
})

test('normalizeCard renders offline honestly when probe fails', () => {
  const card = normalizeCard({
    url: 'https://x:8080', host: 'x', port: 8080,
    identity: { serial: '', model: '', friendly_name: '' },
    status: 'Offline', connected: false, alarm: null,
    current_program: null, online: false,
    offline_reason: 'exc_ConnectTimeout',
  })
  assert.equal(card.isOffline, true)
  assert.equal(card.status, 'Offline')
  assert.equal(card.friendlyName, '')  // never fabricates a name
  assert.equal(card.offlineReason, 'exc_ConnectTimeout')
})

test('normalizeCard coerces an unknown status to Offline', () => {
  const card = normalizeCard({ status: 'Whatever', online: true })
  assert.equal(card.status, 'Offline')
})

test('normalizeCard treats online=false as offline even if status looks fine', () => {
  const card = normalizeCard({ status: 'Ready', online: false })
  // We keep the reported status label (Ready) but flag isOffline true
  // so downstream renders the honest offline note.
  assert.equal(card.isOffline, true)
})


// ── pickLandingView (grid-renders-per-registry) ──────────────────────

test('pickLandingView returns "fleet" when totalRobots > 1', () => {
  assert.equal(pickLandingView({ totalRobots: 2, urlSearch: '' }),
    'fleet')
  assert.equal(pickLandingView({ totalRobots: 5, urlSearch: '' }),
    'fleet')
})

test('pickLandingView returns "dashboard" when totalRobots <= 1 (single-robot-skips-grid)', () => {
  assert.equal(pickLandingView({ totalRobots: 1, urlSearch: '' }),
    'dashboard')
  assert.equal(pickLandingView({ totalRobots: 0, urlSearch: '' }),
    'dashboard')
})

test('pickLandingView URL param overrides the count-based default', () => {
  // Even in a fleet, ?view=dashboard opens the connected dashboard.
  assert.equal(
    pickLandingView({ totalRobots: 5, urlSearch: '?view=dashboard' }),
    'dashboard')
  // Even in a single-robot install, ?view=fleet forces the grid.
  assert.equal(
    pickLandingView({ totalRobots: 1, urlSearch: '?view=fleet' }),
    'fleet')
})

test('pickLandingView ignores unknown view values', () => {
  assert.equal(
    pickLandingView({ totalRobots: 3, urlSearch: '?view=whatever' }),
    'fleet')  // falls back to count-based default
  assert.equal(
    pickLandingView({ totalRobots: 1, urlSearch: '?view=whatever' }),
    'dashboard')
})
