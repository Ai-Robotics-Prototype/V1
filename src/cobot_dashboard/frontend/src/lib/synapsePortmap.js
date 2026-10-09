// Synapse port map — single-source translation layer (2026-10-01
// operator directive: Synapse Addressing Doctrine).
//
// The Synapse cabinet exposes operator-facing port names
// (Valve 01-10, IN 01-10, OUT 01-10, SAFETY 01-04). The robot
// controller speaks raw channels (DO0-15, DI0-15). Programs on
// disk carry the raw channel in `io_id` because the codegen emits
// `setDO(<n>, <v>)` directly off that field. The directive mandates:
//
//   * UI shows Synapse names everywhere ("Open Valve 03", "Wait for
//     IN 06"). Raw channel strings in operator-facing surfaces are
//     a bug — the ONE honest exception is the "Main Internal Robot
//     Controller I/O" expandable, which stays controller-native
//     because it IS the diagnostic view (with a mapping column
//     added by that panel).
//   * Codegen emission is unchanged — program step io_id strings
//     stay raw. Byte-identical wire output.
//   * Existing programs with raw io_id render through reverse
//     lookup (raw → Synapse). Unmapped raw channels render
//     explicitly as "Unmapped channel <raw>" so no silent
//     invention of a Synapse name.
//
// This module is the ONE place that owns the translation. Both
// cellActions.js (named-action → primitive compilation) and every
// operator-facing display call through here, so the map lives in
// exactly one spot (grep pin in D_synapse_portmap.test.js).

import { useEffect, useState } from 'react'

// Last-good cache so helpers used outside React (named-action
// compile paths, test-side utilities) can resolve without
// re-fetching. The hook refreshes this cache on every mount.
let _CACHE = null

export function cachedPortmap() { return _CACHE }
export function _primeCacheForTests(pm) { _CACHE = pm }

// React hook — fetches /api/synapse/portmap once per mount, caches
// in module scope + component state. Returns `null` while loading
// so callers can render a loading / fallback state honestly.
export function useSynapsePortmap() {
  const [pm, setPm] = useState(_CACHE)
  useEffect(() => {
    let alive = true
    fetch('/api/synapse/portmap')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return
        const body = d && d.portmap ? d.portmap : null
        if (body && Array.isArray(body.rows)) {
          _CACHE = body
          setPm(body)
        }
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return pm
}

// Normalize a raw channel string. Accepts 'DO2', 'do 02', 'DO02',
// 'di3' — returns 'DO2' / 'DI3' / etc. (canonical: short form,
// no zero-pad, uppercase kind).
export function canonRaw(id) {
  if (typeof id !== 'string') return null
  const m = id.trim().match(/^(DO|DI|AO|AI)\s*0*(\d+)$/i)
  if (!m) return null
  return `${m[1].toUpperCase()}${Number(m[2])}`
}

// Normalize a Synapse port id. Accepts 'V3', 'V03', 'IN 01',
// 'out10', 'SAFETY1' — returns 'V03' / 'IN01' / 'OUT10' /
// 'SAFETY01'. Reserved aliases (DI16/17/18) are returned as the
// raw form the portmap keys them by.
export function canonSynapse(id) {
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  const r = trimmed.match(/^(V|IN|OUT|SAFETY)\s*0*(\d+)$/i)
  if (r) {
    const kind = r[1].toUpperCase()
    const pad = (kind === 'V' || kind === 'IN' || kind === 'OUT'
                 || kind === 'SAFETY')
      ? String(Number(r[2])).padStart(2, '0')
      : String(Number(r[2]))
    return `${kind}${pad}`
  }
  // Reserved raw aliases flow through canonRaw.
  return canonRaw(trimmed)
}

// Forward lookup: Synapse port id (V03) → raw channel (DO3).
// Returns null when the id has no mapping (operator must verify).
export function rawForSynapse(portmap, synapseId) {
  const key = canonSynapse(synapseId)
  if (!key) return null
  const row = (portmap?.rows || []).find((r) => r.synapse === key)
  return row ? row.raw : null
}

// Reverse lookup: raw channel (DO3) → Synapse port id (V03).
// When a raw channel maps to multiple Synapse ports (the current
// seed's valve/output collision at DO<n>), the valve wins because
// valve wiring is the primary allocation surface on the real
// cabinet (ejectors + grippers live there; general OUTs are the
// exception). Operators who override the map get whichever row
// they marked verified first.
export function synapseForRaw(portmap, rawId) {
  const key = canonRaw(rawId)
  if (!key) return null
  const rows = (portmap?.rows || []).filter((r) => r.raw === key)
  if (rows.length === 0) return null
  // Prefer verified rows, then valve kind, then whatever came
  // first (stable).
  rows.sort((a, b) => {
    if (!!b.verified - !!a.verified) return !!b.verified - !!a.verified
    const score = (k) => (k === 'valve' ? 0
                          : k === 'input' ? 1
                          : k === 'output' ? 2
                          : k === 'safety' ? 3
                          : k === 'reserved' ? 4 : 5)
    return score(a.kind) - score(b.kind)
  })
  return rows[0].synapse
}

// Operator-facing display name for a raw controller channel.
// Returns "Valve 03" / "IN 06" / "OUT 02" / "SAFETY 01" / the
// reserved alias copy ("DI16 (reserved: mode switch)") / or the
// honest unmapped copy "Unmapped channel DOx". Never silently
// invents a Synapse name.
export function displayNameForRaw(portmap, rawId) {
  const raw = canonRaw(rawId)
  if (!raw) return rawId
  const syn = synapseForRaw(portmap, raw)
  if (!syn) return `Unmapped channel ${raw}`
  if (syn === raw) {
    // Reserved alias row (DI16/17/18) — return a human-copy string
    // so operator surfaces don't just repeat the raw id.
    const row = (portmap?.rows || []).find((r) => r.synapse === raw)
    const note = row?.note || 'reserved'
    return `${raw} — ${note}`
  }
  return displayNameForSynapse(syn)
}

// Operator-facing display name for a Synapse id. Pure string
// formatter — "V03" → "Valve 03", "IN06" → "IN 06", etc.
export function displayNameForSynapse(synapseId) {
  const key = canonSynapse(synapseId)
  if (!key) return synapseId
  const m = key.match(/^(V|IN|OUT|SAFETY)(\d+)$/)
  if (!m) return key
  const kind = m[1]
  const n = String(Number(m[2])).padStart(2, '0')
  if (kind === 'V') return `Valve ${n}`
  if (kind === 'IN') return `IN ${n}`
  if (kind === 'OUT') return `OUT ${n}`
  if (kind === 'SAFETY') return `SAFETY ${n}`
  return key
}

// True if the string parses as a raw controller channel.
export function isRawId(id) { return canonRaw(id) != null }

// True if the string parses as a Synapse port id (V/IN/OUT/SAFETY).
export function isSynapseId(id) {
  if (typeof id !== 'string') return false
  return /^(V|IN|OUT|SAFETY)\s*0*\d+$/i.test(id.trim())
}
