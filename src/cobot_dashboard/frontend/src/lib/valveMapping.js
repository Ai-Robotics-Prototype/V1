// Valve mapping — ONE source of truth for:
//   * actuation + hold-on-loss → required valve TYPE
//   * the Synapse panel's valve-slot registry (which slot carries
//     which valve type)
//   * type-aware allocation that picks a free slot whose declared
//     type matches the requirement
//
// 2026-10-05 operator directive (fixture wizard): "stay clamped on
// power/E-stop loss" must compile to a 5/2 DS valve (holds last
// state through power/air loss), reflected in the pneumatic port
// selection — not just stored on the record. The decoupling the
// field report caught was that fixturesData.allocateFixturePorts was
// type-blind: it picked the next free SPARE slot regardless of
// whether that slot's declared valve class matched the fixture's
// required valve TYPE. A fixture requiring 5/2 DS could land on a
// SPARE 1/2 slot — operator-wiring-dependent at best, silently
// WRONG if the operator wires an SS valve there.
//
// Shared rule this module encodes (safety-relevant — same for the
// fixture wizard AND the EOAT wizard; both must derive the valve
// TYPE through valveTypeForActuation so neither can drift):
//
//     single_acting         → 5/2 SS
//     double_acting + hold  → 5/2 DS   (holds last state on loss)
//     double_acting + !hold → 5/2 SS   (spring returns on loss)
//     double_acting + null  → 5/2 DS   (hold-on-loss default per
//                                       the 2026-10-02 directive)
//     vacuum                → HI/LO 3/2 N/C
//     blow_off              → HI/LO 3/2 N/C

// Accepted actuation tokens — the fixture wizard uses the short form
// ('single'/'double'); the EOAT wizard uses the long form
// ('single_acting'/'double_acting'). Normalize both so the one
// resolver below is identical for both callers.
const _ACTUATION_ALIASES = Object.freeze({
  single:          'single_acting',
  single_acting:   'single_acting',
  double:          'double_acting',
  double_acting:   'double_acting',
  vacuum:          'vacuum',
  blow_off:        'blow_off',
})

export function canonActuation(a) {
  if (typeof a !== 'string') return null
  return _ACTUATION_ALIASES[a] || null
}

// Pure actuation→type resolver. Returns one of
// '5/2 SS' | '5/2 DS' | 'HI/LO 3/2 N/C' | null.
export function valveTypeForActuation({ actuation, holdOnLoss }) {
  const canon = canonActuation(actuation)
  if (!canon) return null
  if (canon === 'single_acting') return '5/2 SS'
  if (canon === 'double_acting') {
    if (holdOnLoss === false) return '5/2 SS'
    // true OR null OR undefined → hold-on-loss default (DS).
    return '5/2 DS'
  }
  if (canon === 'vacuum' || canon === 'blow_off') {
    return 'HI/LO 3/2 N/C'
  }
  return null
}

// ── Synapse panel valve-slot registry ────────────────────────────────
//
// Each slot is a PHYSICAL position on the Synapse pneumatic plate.
// `type` is the valve wired at that slot today. SPARE 1 / SPARE 2
// are empty positions the operator may wire for new tools / fixtures
// — they accept any valve type (the operator wires what the
// recommendation says).
//
// Owned here (not in SynapsePage) so lib-level allocation can read
// the registry without a JSX import. SynapsePage re-exports.

export const VALVE_SLOTS = Object.freeze([
  Object.freeze({ id: 'V01', label: 'Valve 01', type: '5/2 SS' }),
  Object.freeze({ id: 'V02', label: 'Valve 02', type: '5/2 SS' }),
  Object.freeze({ id: 'V03', label: 'Valve 03', type: 'HI/LO 3/2 N/C' }),
  Object.freeze({ id: 'V04', label: 'Valve 04', type: 'HI/LO 2/2 N/C' }),
  Object.freeze({ id: 'V05', label: 'Valve 05', type: 'SPARE 1' }),
  Object.freeze({ id: 'V06', label: 'Valve 06', type: '5/3' }),
  Object.freeze({ id: 'V07', label: 'Valve 07', type: 'HI/LO 3/2 N/O' }),
  Object.freeze({ id: 'V08', label: 'Valve 08', type: 'HI/LO 3/2 N/C' }),
  Object.freeze({ id: 'V09', label: 'Valve 09', type: '5/2 DS' }),
  Object.freeze({ id: 'V10', label: 'Valve 10', type: 'SPARE 2' }),
])

// Spare slots are universally allocatable — the operator wires
// whatever valve class the recommendation names.
export function isSpareSlot(slot) {
  return typeof slot?.type === 'string' && /^SPARE/.test(slot.type)
}

// Type-aware allocation. Rules:
//   1. Prefer a free slot whose declared type EQUALS requiredType
//      (operator doesn't have to wire anything — the panel already
//      carries the right valve class at that slot).
//   2. Fall back to a free SPARE slot (operator wires a matching
//      valve class there — guided by the record's valve_type).
//   3. If neither exists, return null — caller surfaces the
//      "no free slot" refusal.
//
// NEVER returns a slot whose declared type is non-SPARE AND does
// not match requiredType — that's the correctness-safety the field
// bug surfaced (a DS requirement must not land on an SS slot).
export function allocateValveForType(requiredType, claimedValves) {
  const claimed = claimedValves instanceof Set
    ? claimedValves
    : new Set(Array.isArray(claimedValves) ? claimedValves : [])
  if (requiredType) {
    const direct = VALVE_SLOTS.find(
      (s) => !claimed.has(s.id) && s.type === requiredType)
    if (direct) return direct.id
  }
  const spare = VALVE_SLOTS.find(
    (s) => !claimed.has(s.id) && isSpareSlot(s))
  if (spare) return spare.id
  return null
}

// Reverse: look up the declared type for a slot id.
export function typeForSlot(slotId) {
  const row = VALVE_SLOTS.find((s) => s.id === slotId)
  return row ? row.type : null
}

// True when the slot CAN carry the required type — either direct
// match or SPARE (operator-wired). Used by the record+allocation
// agreement pin so a saved record never claims DS at an SS slot.
export function slotAcceptsType(slotId, requiredType) {
  const t = typeForSlot(slotId)
  if (t == null) return false
  if (requiredType == null) return true
  if (t === requiredType) return true
  return /^SPARE/.test(t)
}
