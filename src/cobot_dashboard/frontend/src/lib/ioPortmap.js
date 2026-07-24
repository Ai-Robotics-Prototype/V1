// Shared I/O portmap helpers — one fetch of /api/io/portmap, then
// derive dropdown options and label lookups client-side.
//
// The step editor (ProgramEditor / ProgramWizard) needs the same
// hardware-exact view the main I/O page renders: DO0-15, DI0-15,
// AI/AO, flange DIs/DOs, with the operator-assigned label suffix
// ("DO2 — Vacuum On"). System-reserved DIs (modeSwitch,
// enableButton, flangeButton0-3) and safety terminals are excluded
// from the selectable set — they aren't operator-actuatable.
//
// The portmap endpoint returns a rich shape (plate[], flange{},
// ports{}, blocks[], specs, verbs). We walk plate + flange terminals
// once and expose two consumer surfaces:
//   * portmapToOptions(pm, direction, {analog}) → sorted dropdown rows
//   * portmapLabels(pm) → { "DO2": "Vacuum On", ... } for detail lines

import { useState, useEffect } from 'react'

// One-shot fetch, cached in state per hook instance. Consumers call
// this near the top of a component; downstream helpers accept the raw
// portmap so callers can memoize the derived option list themselves.
export function useIOPortmap() {
  const [portmap, setPortmap] = useState(null)
  useEffect(() => {
    let alive = true
    fetch('/api/io/portmap')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d && typeof d === 'object') setPortmap(d) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return portmap
}

// Walk every signal terminal across plate + flange, handling all
// three block layouts (flat `terminals`, `pair_rows`, `sections`).
// Yields { term, block, flange, sysReserved }. sysReserved is true
// for controller-owned inputs the operator MUST NOT set from a
// program step (modeSwitch@16, enableButton@17, flangeButton0-3
// @18-21) — matches the read-only treatment on the main I/O page.
function collectSignalTerminals(portmap) {
  const out = []
  if (!portmap) return out
  const gather = (block, flange) => {
    const seen = []
    if (Array.isArray(block.terminals)) seen.push(...block.terminals)
    for (const row of (block.pair_rows || [])) {
      for (const c of row) if (c && typeof c === 'object') seen.push(c)
    }
    for (const sec of (block.sections || [])) {
      for (const row of (sec.rows || [])) {
        for (const c of row) if (c && typeof c === 'object') seen.push(c)
      }
      for (const c of (sec.terminals || [])) {
        if (c && typeof c === 'object') seen.push(c)
      }
    }
    for (const t of seen) {
      if (!t || t.role !== 'signal') continue
      // System-reserved: (a) explicit sw_group='system' tag on
      // modeSwitch@16 / enableButton@17; (b) function-bound terminals
      // like flangeButton0's ['robotDrag',0,null]; (c) the remaining
      // flangeButton1-3 which carry no explicit tag but are
      // controller-owned buttons per the task spec — matched by name
      // pattern.
      const sysReserved = t.sw_group === 'system'
                       || Array.isArray(t.function)
                       || /^flangeButton\d+$/.test(t.name || '')
      out.push({ term: t, block, flange, sysReserved })
    }
  }
  for (const block of (portmap.plate || [])) gather(block, false)
  if (portmap.flange) gather(portmap.flange, true)
  return out
}

// Read the operator-assigned label for a channel. Empty / missing /
// the "Unassigned" placeholder all return null so callers can fall
// back to the raw port id. Also collapse the flange default names
// (assignment defaults to the terminal name for flange/system ports)
// so we don't render redundant "flangeDO0 — flangeDO0" strings.
function readAssignment(portmap, name) {
  const row = portmap?.ports?.[name]
  const s = row && typeof row.assignment === 'string' ? row.assignment.trim() : ''
  if (!s || s === 'Unassigned' || s === name) return null
  return s
}

// Build a { "DO2": "Vacuum On", ... } map for detail-line rendering.
// Channels without a user label are omitted (detail lines fall back
// to the raw id — "DO2" rather than "DO2 — DO2").
export function portmapLabels(portmap) {
  const out = {}
  for (const { term } of collectSignalTerminals(portmap)) {
    const lab = readAssignment(portmap, term.name)
    if (lab) out[term.name] = lab
  }
  return out
}

// Render "DO2 — Vacuum On" when a label is set, else just "DO2".
// Callers pass the portmapLabels map; a missing entry is fine.
export function formatIOName(id, labelsMap) {
  if (!id) return id
  const lab = labelsMap && labelsMap[id]
  return lab ? `${id} — ${lab}` : id
}

// Build dropdown options for a step field.
//   direction: 'output' (DO, +AO if analog) | 'input' (DI, +AI if analog)
//   opts.analog: include AO / AI as well
// Returns [{ id, display, label, flange, kind, port }], sorted with
// general DO/DI first (by port), then flange ports tagged "(flange)".
// Excludes system-reserved DIs and every SAFETY-block terminal.
export function portmapToOptions(portmap, direction, opts = {}) {
  const analog = Boolean(opts?.analog)
  const wantKinds = direction === 'output'
    ? (analog ? new Set(['DO', 'AO']) : new Set(['DO']))
    : (analog ? new Set(['DI', 'AI']) : new Set(['DI']))
  const rows = []
  for (const { term, block, flange, sysReserved } of collectSignalTerminals(portmap)) {
    if (sysReserved) continue
    if (block?.group === 'safety') continue
    const kind = term.kind || block?.kind
    if (!wantKinds.has(kind)) continue
    const port = Number.isInteger(term.port) ? term.port : 0
    const label = readAssignment(portmap, term.name)
    const idBase = term.name
    // Flange DOs live on port 16-17 which collide with the (non-existent
    // for this controller) plate DO16/17 — but the terminal name is
    // "flangeDO0/1" and that's what codegen expects for the flange
    // channel. Keep the raw name as the id.
    const display = flange
      ? (label ? `${idBase} — ${label} (flange)` : `${idBase} (flange)`)
      : (label ? `${idBase} — ${label}` : idBase)
    rows.push({ id: idBase, display, label, flange, kind, port })
  }
  rows.sort((a, b) => {
    if (a.flange !== b.flange) return a.flange ? 1 : -1
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
    return a.port - b.port
  })
  return rows
}
