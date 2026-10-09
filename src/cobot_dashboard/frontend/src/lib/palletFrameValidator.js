// Async client for the shared pallet-frame validator
// (§465 fork-1 kill, 2026-08-04).
//
// Prior to this file, frontend/src/lib/palletTeachSequence.js
// carried a local `validatePalletFrame(place)` that computed row/
// col/tilt against RAW stored corner_*_tcp fields — a fork of
// pallet_geometry.compute_frame/validate_frame on the backend.
// The fork missed the v1→v2 migration, did no Gram-Schmidt
// projection, and fired as a passive banner mid-re-teach against
// half-updated state.
//
// This module is the single frame-validation entry point for the
// frontend. It posts the in-progress place to the shared
// endpoint and returns the {findings, blocking, measured, spec}
// response. No frame math runs here — the ONLY math this file
// does is on the response (grouping, filtering by corner) which
// keeps the fork-guard trivially checkable.

export const PALLET_ROLE_TO_INVOLVES_CORNER = {
  pallet_c1:   'c1',
  pallet_c2:   'c2',
  pallet_c3:   'c3',
  pallet_part: 'c4',
}

// Call the shared validator. `place` is the pallet_place dict
// (may carry v1 or v2 keys — the server migrates); `role` is the
// role currently being re-taught (null when not re-teaching);
// `specOverride` merges onto place server-side (e.g. rows/cols
// nudged in the editor without persisting).
//
// Returns { findings, blocking, measured, spec, ok, error? } —
// `ok: false` when the fetch itself failed (network / 5xx). A
// well-formed refusal response with findings still returns
// `ok: true` because the endpoint succeeded, just reported
// blocking geometry.
export async function validatePalletFrameServer(place, {
  reTeachingRole = null,
  specOverride   = null,
  signal         = undefined,
} = {}) {
  try {
    const res = await fetch('/api/pallet/validate_frame', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        place: place || {},
        spec_dict: specOverride || undefined,
        re_teaching_role: reTeachingRole,
      }),
      signal,
    })
    if (!res.ok) {
      let err = `HTTP ${res.status}`
      try {
        const body = await res.json()
        err = body?.error || err
      } catch (_) { /* keep the status */ }
      return { ok: false, error: err,
               findings: [], blocking: false,
               measured: {}, spec: null }
    }
    const body = await res.json()
    return {
      ok:       true,
      findings: Array.isArray(body?.findings) ? body.findings : [],
      blocking: !!body?.blocking,
      measured: body?.measured || {},
      spec:     body?.spec || null,
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e),
             findings: [], blocking: false,
             measured: {}, spec: null }
  }
}


// After a Record, decide whether the just-recorded pose is the
// PROXIMATE cause of any blocking finding. If so, that Record
// should be REFUSED (the operator jogged too close to another
// corner). If not, the finding surfaces as a normal toast and
// teaching proceeds — the operator can re-teach the offending
// corner later.
//
// `recordedRole` is the role we just recorded (pallet_c1/2/3);
// the check is "does at least one blocking finding involve THIS
// corner?". A `corner_coincident` finding whose involves_corners
// carries the just-recorded corner is the exact case the task
// says to refuse with the measured distance in the message.
export function findingsBlockingThisRecord(findings, recordedRole) {
  const involvedCorner =
    PALLET_ROLE_TO_INVOLVES_CORNER[recordedRole] || null
  if (!involvedCorner) return []
  return (findings || []).filter((f) => {
    if (f?.severity !== 'error') return false
    const cs = f?.involves_corners || []
    return cs.includes(involvedCorner)
  })
}
