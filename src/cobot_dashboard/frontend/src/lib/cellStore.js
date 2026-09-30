// Cell registry client (2026-09-22 operator directive: The Cell).
//
// One backend endpoint family: /api/cell.
//
// The cell is the SINGLE SOURCE OF TRUTH for allocated ports across
// EOATs and fixtures. Wizards read the cell before allocating, and
// writes go back to the cell so a subsequent read can never see a
// collision.
//
// Program records bind to cell entries by ID (not by port number),
// so if a fixture's port changes in the cell, every program that
// references it follows automatically.

async function _json(res) {
  const txt = await res.text()
  try { return txt ? JSON.parse(txt) : null }
  catch { return { _raw: txt } }
}

async function _refuse(res) {
  const body = await _json(res)
  const detail = body && (body.detail || body.message
    || body.reason_code)
  throw new Error(detail || `request failed (${res.status})`)
}

export async function getCell() {
  const res = await fetch('/api/cell')
  if (!res.ok) return _refuse(res)
  const body = await _json(res)
  return body && body.cell ? body.cell : { eoats: [], fixtures: [], meta: {} }
}

export async function saveCellEoat(entry) {
  const res = await fetch('/api/cell/eoat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
  if (!res.ok) return _refuse(res)
  const body = await _json(res)
  return body && body.entry
}

export async function saveCellFixture(entry) {
  const res = await fetch('/api/cell/fixture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
  if (!res.ok) return _refuse(res)
  const body = await _json(res)
  return body && body.entry
}

export async function deleteCellEoat(id) {
  const res = await fetch(
    `/api/cell/eoat/${encodeURIComponent(id)}`,
    { method: 'DELETE' })
  if (!res.ok) return _refuse(res)
  return _json(res)
}

export async function deleteCellFixture(id) {
  const res = await fetch(
    `/api/cell/fixture/${encodeURIComponent(id)}`,
    { method: 'DELETE' })
  if (!res.ok) return _refuse(res)
  return _json(res)
}

// ── Allocation single-source ────────────────────────────────────────
//
// One entry point: cellClaimedPorts(cell) → { valves, inputs, outputs }
// (Sets of string ids). Callers use these to skip claimed ports when
// picking a free slot. The allocator in lib/fixturesData reads the
// same helper via allocateFixturePorts's tools+fixtures arguments —
// this module produces the tools + fixtures arrays from the cell so
// there IS no other source.

export function cellClaimedPorts(cell) {
  const c = cell || {}
  const valves = new Set()
  const inputs = new Set()
  const outputs = new Set()
  for (const e of c.eoats || []) {
    if (e.valve) valves.add(e.valve)
    for (const i of e.inputs || []) inputs.add(i)
    for (const o of e.outputs || []) outputs.add(o)
  }
  for (const f of c.fixtures || []) {
    if (f.valve) valves.add(f.valve)
    if (f.in_done) inputs.add(f.in_done)
    if (f.out) outputs.add(f.out)
  }
  return { valves, inputs, outputs }
}

// Convert cell.eoats → tool-shaped rows the fixtures allocator
// already understands (config.assigned_valve / assigned_inputs).
export function cellEoatsAsToolRows(cell) {
  const rows = []
  for (const e of (cell && cell.eoats) || []) {
    rows.push({
      id: e.id,
      name: e.name,
      config: {
        assigned_valve: e.valve || null,
        assigned_inputs: e.inputs || [],
        assigned_outputs: e.outputs || [],
      },
    })
  }
  return rows
}

// Look up a bound cell entry by id (used by the program editor to
// materialize the named-action list).
export function findCellEoat(cell, id) {
  if (!id || !cell) return null
  return (cell.eoats || []).find((e) => e.id === id) || null
}
export function findCellFixture(cell, id) {
  if (!id || !cell) return null
  return (cell.fixtures || []).find((f) => f.id === id) || null
}
