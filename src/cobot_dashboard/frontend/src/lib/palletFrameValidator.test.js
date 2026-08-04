// palletFrameValidator client contract (§465 fork-1 kill, 2026-08-04).
//
// The client owns exactly two responsibilities:
//   1. POST the in-progress place + re-teaching role to
//      /api/pallet/validate_frame and normalize the response.
//   2. Filter findings by "does this involve the corner we just
//      recorded?" so the caller can refuse the record when the
//      operator's own new pose is the problem.
// No frame math. Everything geometric goes over the wire.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validatePalletFrameServer,
  findingsBlockingThisRecord,
  PALLET_ROLE_TO_INVOLVES_CORNER,
} from './palletFrameValidator.js'


// ── PALLET_ROLE_TO_INVOLVES_CORNER map ─────────────────────────

test('role→corner map: pallet_c{1,2,3} → c{1,2,3}; pallet_part → c4', () => {
  assert.equal(PALLET_ROLE_TO_INVOLVES_CORNER.pallet_c1,   'c1')
  assert.equal(PALLET_ROLE_TO_INVOLVES_CORNER.pallet_c2,   'c2')
  assert.equal(PALLET_ROLE_TO_INVOLVES_CORNER.pallet_c3,   'c3')
  assert.equal(PALLET_ROLE_TO_INVOLVES_CORNER.pallet_part, 'c4')
})


// ── findingsBlockingThisRecord ─────────────────────────────────

test('blocks when an error finding names the recorded corner', () => {
  const findings = [
    { severity: 'error', code: 'corner_coincident',
      involves_corners: ['c1', 'c2'],
      distance_mm: 0.5,
      operator: { title: 'Corners 1 and 2 are too close.',
                  detail: 'Measured 0.50 mm apart — …',
                  technicalDetail: '...' } },
  ]
  const blockers = findingsBlockingThisRecord(findings, 'pallet_c2')
  assert.equal(blockers.length, 1)
  assert.equal(blockers[0].code, 'corner_coincident')
})


test('does NOT block when the finding names OTHER corners', () => {
  // The operator just recorded c1; a finding about c2/c3 being
  // parallel is real but is not caused by this Record — surface
  // it as advisory, don't block the commit.
  const findings = [
    { severity: 'error', code: 'row_col_near_parallel',
      involves_corners: ['c2', 'c3'],
      operator: { title: '...' } },
  ]
  const blockers = findingsBlockingThisRecord(findings, 'pallet_c1')
  assert.deepEqual(blockers, [])
})


test('warnings never block, even when they name the recorded corner', () => {
  const findings = [
    { severity: 'warning', code: 'pallet_tilted',
      involves_corners: ['c1', 'c2', 'c3'],
      operator: { title: '...' } },
  ]
  const blockers = findingsBlockingThisRecord(findings, 'pallet_c1')
  assert.deepEqual(blockers, [], 'warnings surface but do not block')
})


test('empty inputs return an empty list without throwing', () => {
  assert.deepEqual(findingsBlockingThisRecord(null,  'pallet_c1'), [])
  assert.deepEqual(findingsBlockingThisRecord([],    'pallet_c1'), [])
  assert.deepEqual(findingsBlockingThisRecord([{}],  null),        [],
    'null role → no involvedCorner → empty blocker list')
})


// ── validatePalletFrameServer wire contract (fetch is mocked) ─

async function _withMockFetch(response, body, fn) {
  const original = globalThis.fetch
  let seenBody = null
  globalThis.fetch = async (url, init) => {
    seenBody = init && init.body ? JSON.parse(init.body) : null
    return {
      ok: response.ok !== false,
      status: response.status || 200,
      async json() { return body },
    }
  }
  try {
    return { result: await fn(), seenBody }
  } finally {
    globalThis.fetch = original
  }
}


test('validatePalletFrameServer POSTs the place + role + spec_dict verbatim', async () => {
  const { result, seenBody } = await _withMockFetch(
    { ok: true },
    { findings: [], blocking: false, measured: {}, spec: {} },
    () => validatePalletFrameServer(
      { corner1_tcp: [1, 2, 3, 0, 0, 0] },
      { reTeachingRole: 'pallet_c2',
        specOverride: { rows: 3, cols: 3 } }),
  )
  assert.ok(result.ok)
  assert.deepEqual(seenBody.place,
    { corner1_tcp: [1, 2, 3, 0, 0, 0] },
    'place body must round-trip verbatim')
  assert.equal(seenBody.re_teaching_role, 'pallet_c2')
  assert.deepEqual(seenBody.spec_dict, { rows: 3, cols: 3 })
})


test('validatePalletFrameServer returns findings + blocking flags', async () => {
  const { result } = await _withMockFetch(
    { ok: true },
    { findings: [{ severity: 'error', code: 'corner_coincident',
                   involves_corners: ['c1', 'c2'], distance_mm: 0.5,
                   message: 'Corners 1 and 2 appear coincident (0.50 mm apart) …',
                   operator: {
                     title: 'Corners 1 and 2 are too close.',
                     detail: 'Measured 0.50 mm apart — jog to the pallet corner and record again.',
                     technicalDetail: 'raw' } }],
      blocking: true,
      measured: { row_len_mm: 0.5, col_len_mm: 300 },
      spec: {} },
    () => validatePalletFrameServer({}, { reTeachingRole: null }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.blocking, true)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].code, 'corner_coincident')
  assert.equal(result.measured.row_len_mm, 0.5)
})


test('validatePalletFrameServer surfaces HTTP failure without throwing', async () => {
  const { result } = await _withMockFetch(
    { ok: false, status: 500 },
    { error: 'boom' },
    () => validatePalletFrameServer({}),
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'boom')
  assert.deepEqual(result.findings, [])
  assert.equal(result.blocking, false)
})


// ── Operator-directive copy: title / detail contract ─────────

test('the client shape carries operator {title, detail, technicalDetail} on each finding', async () => {
  // The endpoint returns operator copy pre-shaped; the client
  // must pass it through so the ToastContainer can render the
  // structured triple (no concatenation).
  const { result } = await _withMockFetch(
    { ok: true },
    { findings: [{ severity: 'error', code: 'corner_coincident',
                   involves_corners: ['c1', 'c2'],
                   distance_mm: 0.6,
                   message: 'raw',
                   operator: {
                     title:  'Corners 1 and 2 are too close.',
                     detail: 'Measured 0.60 mm apart — jog to the pallet corner and record again.',
                     technicalDetail: 'raw' } }],
      blocking: true, measured: {}, spec: {} },
    () => validatePalletFrameServer({}),
  )
  const f = result.findings[0]
  assert.equal(typeof f.operator.title,  'string')
  assert.equal(typeof f.operator.detail, 'string')
  assert.match(f.operator.detail, /0\.60 mm/,
    'operator detail must name the measured distance')
  assert.match(f.operator.detail, /jog to the pallet corner/,
    'operator detail must instruct the fix (jog to the corner)')
})
