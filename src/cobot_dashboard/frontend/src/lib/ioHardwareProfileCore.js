// I/O Hardware Profile — pure (React-free) core. Split out from
// lib/ioHardwareProfile.js so node-side doctrine tests can import
// the formatters without pulling in Zustand + the whole store
// dependency graph (which chains through jogTelemetry etc. that
// node's module loader can't resolve without extension hints).
//
// The React hooks live in lib/ioHardwareProfile.js and re-export
// everything below so frontend callers keep a single import point.

import {
  canonRaw, canonSynapse, isRawId, isSynapseId,
  displayNameForRaw, displayNameForSynapse,
  rawForSynapse,
} from './synapsePortmap.js'

export const PROFILE_SYNAPSE = 'synapse'
export const PROFILE_OEM     = 'oem'
export const PROFILE_DEFAULT = PROFILE_SYNAPSE
export const PROFILE_CHOICES = Object.freeze([PROFILE_SYNAPSE, PROFILE_OEM])

export function normalizeProfile(p) {
  const v = typeof p === 'string' ? p.trim().toLowerCase() : ''
  return PROFILE_CHOICES.includes(v) ? v : PROFILE_DEFAULT
}

export function isSynapseProfile(p) { return normalizeProfile(p) === PROFILE_SYNAPSE }
export function isOemProfile(p)     { return normalizeProfile(p) === PROFILE_OEM     }

export function profileLabel(p) {
  return isOemProfile(p) ? 'OEM Controller I/O' : 'Synapse Panel'
}

export function profileInterfaceNoun(p) {
  return isOemProfile(p) ? 'the controller' : 'the Synapse panel'
}

export function shouldShowSynapseMap(p) { return isSynapseProfile(p) }
export function shouldShowSynapseTab(p) { return isSynapseProfile(p) }

// Profile-aware port-name formatter.
//   SYNAPSE: Synapse id → "Valve 03"; raw id → reverse-lookup → "Valve 03".
//   OEM:     Synapse id → forward-lookup → "DO3"; raw id → "DO3".
export function formatPortName(id, portmap, profile) {
  if (!id) return ''
  const prof = normalizeProfile(profile)
  if (isOemProfile(prof)) {
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

export function wiringTargetCopy(id, portmap, profile) {
  const name = formatPortName(id, portmap, profile)
  if (!name) return ''
  if (isOemProfile(profile)) {
    const r = canonRaw(name) || canonRaw(id)
    if (r && r.startsWith('DO')) return `output ${name}`
    if (r && r.startsWith('DI')) return `input ${name}`
    return name
  }
  return name
}
