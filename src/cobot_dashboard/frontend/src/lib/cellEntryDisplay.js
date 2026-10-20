// Cell-entry display formatter — 2026-10-05 operator directive
// (Synapse Addressing Doctrine: subtitle leak sweep).
//
// Operator-facing surfaces that render cell entries (EOATs, fixtures,
// tool cards, port chips, hookup receipts, dropdowns) MUST route
// through this module. The two things this module owns:
//
//   * typeLabel(entry) — operator-plain name of the record's kind,
//     title-cased. "vacuum" → "Vacuum tool"; "finger" → "Finger
//     gripper"; "vice" → "Vice / Clamp" (via FIXTURE_TYPES label).
//     Never leaks the raw slug.
//
//   * portsLine(entry, portmap) — the subtitle's port tail, with
//     every id routed through displayNameForSynapse (shared with
//     the single-source portmap library). "V03 · IN04" renders as
//     "Valve 03 · IN 04".
//
//   * entrySubtitle(entry, portmap) — joins the two above with
//     " · " and renders the complete subtitle string for a row.
//     This is what MyCellSection + the tool-select cards call.
//
// Rules:
//   * No per-surface string-building anywhere else. Grep pins the
//     shared-import identity across every cell-rendering file.
//   * Honest fallback: an unknown type slug renders as a title-cased
//     version of the slug (never silently dropped). The grep pin
//     catches new slugs by failing the sweep on operator-facing JSX.

import {
  displayNameForSynapse, isSynapseId, canonSynapse,
  canonRaw, isRawId, displayNameForRaw, rawForSynapse,
} from './synapsePortmap.js'
import { FIXTURE_TYPES } from './fixturesData.js'

// Local profile-aware formatter — kept inline so cellEntryDisplay can
// be imported by both the frontend (via Vite) and the node test
// runner without pulling the Zustand store into the dep graph. The
// shared library at lib/ioHardwareProfile.js re-exports the same
// logic in formatPortName() for callers that want it directly.
const _SYN = 'synapse'
const _OEM = 'oem'
function _formatForProfile(id, portmap, profile) {
  if (!id) return ''
  const prof = profile === _OEM ? _OEM : _SYN
  if (prof === _OEM) {
    if (isSynapseId(id)) {
      const raw = rawForSynapse(portmap, id)
      if (raw) return raw
      return `Unmapped Synapse port ${canonSynapse(id) || String(id)}`
    }
    const r = canonRaw(id)
    return r || String(id)
  }
  if (isSynapseId(id)) return displayNameForSynapse(id)
  if (isRawId(id))     return displayNameForRaw(portmap, id)
  return String(id)
}

// EOAT kind → operator-plain label. Mirrors effectorOf() canonical
// tokens from lib/effectorVocab.js, but the display mapping is a UI
// concern that belongs here (effectorVocab owns step emission).
const _EOAT_TYPE_LABELS = Object.freeze({
  finger:   'Finger gripper',
  vacuum:   'Vacuum tool',
  magnet:   'Magnetic tool',
  magnetic: 'Magnetic tool',
  custom:   'Custom tool',
})

// Title-case fallback for an unknown slug — "double_acting" →
// "Double acting". Operator sees something readable while the grep
// pin keeps new slug classes out of operator-facing JSX.
function _titleCase(slug) {
  if (!slug) return ''
  const s = String(slug).replace(/[_-]+/g, ' ').trim().toLowerCase()
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Operator-plain kind label. Fixtures route through FIXTURE_TYPES
// (the wizard's single source for fixture copy); EOATs route through
// _EOAT_TYPE_LABELS; anything else gets the title-case fallback.
export function typeLabel(entry) {
  if (!entry || typeof entry !== 'object') return ''
  const t = String(entry.type || '').toLowerCase()
  if (!t) return ''
  if (_EOAT_TYPE_LABELS[t]) return _EOAT_TYPE_LABELS[t]
  const fix = FIXTURE_TYPES[t]
  if (fix && fix.label) return fix.label
  return _titleCase(t)
}

// Collect every port id a cell entry claims (valves + inputs +
// outputs + done sensor). Order: valve(s) first, then outputs, then
// inputs — matches the pre-doctrine subtitle ordering so operators
// read the same shape with better words.
function _collectPortIds(entry) {
  if (!entry || typeof entry !== 'object') return []
  const ids = []
  if (entry.valve) ids.push(entry.valve)
  if (Array.isArray(entry.actuators)) {
    for (const a of entry.actuators) {
      if (a && a.valve && !ids.includes(a.valve)) ids.push(a.valve)
    }
  }
  if (entry.out) ids.push(entry.out)
  for (const o of entry.outputs || []) if (o) ids.push(o)
  if (entry.in_done) ids.push(entry.in_done)
  for (const i of entry.inputs || []) if (i) ids.push(i)
  return ids
}

// Render a single id through the portmap, profile-aware.
//
//   portDisplayName('V03')
//     → "Valve 03" (SYNAPSE, default — unchanged behaviour)
//     → "DO3"      (OEM)
//
// `opts` is optional: { profile, portmap }. Omit to get Synapse
// behaviour (back-compat with every caller that predates the
// profile system — doctrine tests pin this exact default).
export function portDisplayName(id, opts) {
  if (!id) return ''
  const prof = (opts && opts.profile) || _SYN
  const pm   = opts && opts.portmap   // may be null — OK for Synapse ids
  if (prof === _SYN) {
    if (isSynapseId(id)) return displayNameForSynapse(id)
    return String(id)
  }
  return _formatForProfile(id, pm, prof)
}

// Subtitle port tail — "Valve 03 · IN 04 · IN 06". Profile-aware;
// defaults to Synapse display when no opts passed.
export function portsLine(entry, opts) {
  const ids = _collectPortIds(entry)
  return ids
    .map((id) => portDisplayName(id, opts))
    .filter(Boolean).join(' · ')
}

// Full subtitle — "Vacuum tool · Valve 03 · IN 04". The one function
// every cell-rendering surface calls. Profile-aware.
export function entrySubtitle(entry, opts) {
  const t = typeLabel(entry)
  const p = portsLine(entry, opts)
  if (t && p) return `${t} · ${p}`
  return t || p
}

// Render a list of raw port ids (strings) as display names joined
// by a separator. Used by SavedScreen "Ports claimed" + wizard
// summary bullets where the source is an array, not an entry.
export function portListDisplay(ids, sep = ', ', opts) {
  if (!Array.isArray(ids)) return ''
  const prof = (opts && opts.profile) || _SYN
  const pm   = opts && opts.portmap
  return ids
    .filter(Boolean)
    .map((id) => {
      if (prof === _SYN) {
        return canonSynapse(id) ? displayNameForSynapse(id) : String(id)
      }
      return _formatForProfile(id, pm, prof)
    })
    .join(sep)
}
