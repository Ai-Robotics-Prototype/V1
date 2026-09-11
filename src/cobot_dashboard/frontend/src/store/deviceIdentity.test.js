// 2026-08-05 (identity root-cause fix, Directive item 7).
//
// Frontend gauntlet — the exact incident, in test form:
//   * New store instance (fresh Zustand closure) — models a
//     newly-opened tab.
//   * SAME localStorage as the previous instance.
//   * The two instances MUST resolve the SAME device_id.
//
// Pre-fix, both instances would have read sessionStorage (which
// is per-tab), each generating a distinct UUID. The server saw
// tab #2 as a foreign device and locked it out for 60 s.
//
// The test mocks localStorage/sessionStorage with in-memory
// Maps, then re-declares the identity primitive verbatim (same
// as useStore.js) so the test is decoupled from the whole
// Zustand store closure.

import { test } from 'node:test'
import assert from 'node:assert/strict'


// Tiny in-memory Web Storage twin.
function makeStorage() {
  const m = new Map()
  return {
    getItem:    (k) => (m.has(k) ? m.get(k) : null),
    setItem:    (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    _dump:      () => Object.fromEntries(m),
  }
}


// Verbatim mirror of _getTeachDeviceId from useStore.js. Takes
// storage handles as arguments so we can wire up per-instance
// (sessionStorage) and shared (localStorage) mocks.
function makeStoreInstance({ localStorage: ls, sessionStorage: ss,
                              crypto: cryptoImpl } = {}) {
  let _teachDeviceId = null
  return {
    _getTeachDeviceId() {
      if (_teachDeviceId) return _teachDeviceId
      let id = null
      try { id = ls.getItem('roboai-device-id') } catch (_) {}
      if (!id) {
        try {
          const legacy = ss.getItem('roboai-teach-device-id')
          if (legacy) {
            id = legacy
            try {
              ls.setItem('roboai-device-id', id)
              ss.removeItem('roboai-teach-device-id')
            } catch (_) {}
          }
        } catch (_) {}
      }
      if (!id) {
        id = cryptoImpl.randomUUID()
        try { ls.setItem('roboai-device-id', id) } catch (_) {}
      }
      _teachDeviceId = id
      return id
    },
  }
}


test('new tab sees the SAME device id (localStorage is shared)', () => {
  const ls = makeStorage()
  const ss1 = makeStorage()
  const ss2 = makeStorage()   // different tab → different sessionStorage
  let uuid = 0
  const cryptoImpl = { randomUUID: () => `uuid-${++uuid}` }
  const tabA = makeStoreInstance({ localStorage: ls, sessionStorage: ss1, crypto: cryptoImpl })
  const idA  = tabA._getTeachDeviceId()
  // Fresh tab — new store instance, new sessionStorage, but SAME
  // localStorage (browser-wide origin).
  const tabB = makeStoreInstance({ localStorage: ls, sessionStorage: ss2, crypto: cryptoImpl })
  const idB  = tabB._getTeachDeviceId()
  assert.equal(idB, idA, 'a new tab must resolve the same device id')
  // Only ONE UUID was minted across both tabs.
  assert.equal(uuid, 1)
})


test('sessionStorage legacy id migrates into localStorage once', () => {
  const ls = makeStorage()
  const ss = makeStorage()
  ss.setItem('roboai-teach-device-id', 'legacy-uuid-xyz')
  const cryptoImpl = { randomUUID: () => { throw new Error('should not mint') } }
  const store = makeStoreInstance({ localStorage: ls, sessionStorage: ss, crypto: cryptoImpl })
  const id = store._getTeachDeviceId()
  assert.equal(id, 'legacy-uuid-xyz')
  // Migrated to localStorage.
  assert.equal(ls.getItem('roboai-device-id'), 'legacy-uuid-xyz')
  // sessionStorage entry cleared so a later refresh won't shadow.
  assert.equal(ss.getItem('roboai-teach-device-id'), null)
})


test('cached in-memory id is stable across repeated calls', () => {
  const ls = makeStorage()
  const ss = makeStorage()
  let uuid = 0
  const cryptoImpl = { randomUUID: () => `uuid-${++uuid}` }
  const store = makeStoreInstance({ localStorage: ls, sessionStorage: ss, crypto: cryptoImpl })
  const a = store._getTeachDeviceId()
  const b = store._getTeachDeviceId()
  const c = store._getTeachDeviceId()
  assert.equal(a, b)
  assert.equal(b, c)
  // Only one mint even after multiple calls.
  assert.equal(uuid, 1)
})


test('fresh browser (no stored id) mints ONE UUID and persists it', () => {
  const ls = makeStorage()
  const ss = makeStorage()
  let uuid = 0
  const cryptoImpl = { randomUUID: () => `uuid-${++uuid}` }
  const store = makeStoreInstance({ localStorage: ls, sessionStorage: ss, crypto: cryptoImpl })
  const id = store._getTeachDeviceId()
  assert.equal(id, 'uuid-1')
  assert.equal(ls.getItem('roboai-device-id'), 'uuid-1')
})


test('the ROOT-CAUSE incident: record then close-and-reopen', () => {
  // Model the exact operator report:
  //   Tab A opens teach on program P (identity X → localStorage).
  //   Tab A records a pose (server writes owner=X on draft).
  //   Tab A closes.
  //   Tab B opens the same URL (fresh store instance, same
  //   localStorage). Tab B calls _getTeachDeviceId → must be X.
  //   Server sees SAME owner → no lock, Record continues.
  const ls = makeStorage()
  const cryptoImpl = { randomUUID: () => 'device-XYZ' }
  const tabA = makeStoreInstance({
    localStorage: ls, sessionStorage: makeStorage(), crypto: cryptoImpl })
  const idA = tabA._getTeachDeviceId()
  // (Server drafts owner=idA; we just simulate that.)
  const serverDraftOwner = idA
  // "Tab A closes" — the Zustand store is torn down. localStorage
  // survives (per-origin, browser-managed).
  const tabB = makeStoreInstance({
    localStorage: ls, sessionStorage: makeStorage(), crypto: cryptoImpl })
  const idB = tabB._getTeachDeviceId()
  assert.equal(idB, serverDraftOwner,
    'tab B must claim the same identity that owns the on-disk draft')
})
