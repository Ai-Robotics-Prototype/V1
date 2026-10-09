// External-fixtures frontend-only persistence store.
//
// 2026-09-22 operator directive: the External Fixture Wizard ships
// frontend-only. Records persist in localStorage so the operator's
// setup work survives page reloads without a backend endpoint.
// Backend persistence is a named follow-up.
//
// Storage key: 'roboai:fixtures.v1'. Value: JSON array of records
// (schema documented in lib/fixturesData.js → compileFixtureRecord).
//
// The store is deliberately tiny: list / get / save (upsert) /
// remove. No cross-tab sync; no schema migration. A future backend
// wire replaces this module wholesale with a fetch-based client
// with the SAME shape (`await` at every call, records with `id`).

const KEY = 'roboai:fixtures.v1'

function _read() {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function _write(records) {
  if (typeof window === 'undefined' || !window.localStorage) return
  try { window.localStorage.setItem(KEY, JSON.stringify(records)) }
  catch { /* quota / disabled storage — silent no-op */ }
}

function _randomId() {
  // Not cryptographically strong; enough to distinguish fixture rows
  // in a single operator's session. Backend swap-in will replace with
  // a server-assigned UUID.
  return 'fx_' + Math.random().toString(36).slice(2, 10)
    + Date.now().toString(36).slice(-4)
}

export async function listFixtures() {
  return _read()
}

export async function getFixture(id) {
  return _read().find((f) => f.id === id) || null
}

export async function saveFixture(record) {
  const rows = _read()
  const rec = { ...record }
  if (!rec.id) rec.id = _randomId()
  rec.updated_at = new Date().toISOString()
  const idx = rows.findIndex((f) => f.id === rec.id)
  if (idx >= 0) rows[idx] = rec
  else rows.push(rec)
  _write(rows)
  return rec
}

export async function removeFixture(id) {
  const rows = _read().filter((f) => f.id !== id)
  _write(rows)
  return true
}
