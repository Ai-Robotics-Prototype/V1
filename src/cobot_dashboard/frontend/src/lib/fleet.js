// Fleet-home helpers. Consumed by pages/FleetHome.jsx and App.jsx.
//
// Design invariants (kept in this ONE module so the pins target it):
//   * VIEW-tier only — every function reads state; NONE emits a
//     control action. Fleet-level control (start/stop from grid) is
//     DEFERRED per the 2026-09-21 operator directive.
//   * Status strings come from the backend's derive_fleet_status
//     ladder (see cobot_dashboard/fleet.py). This module MUST NOT
//     re-derive the status from raw robot state — it would fork the
//     ladder and let a frontend refactor drift from the backend.
//   * Offline cards render honestly — no fabricated friendly_name,
//     no placeholder status. When the peer probe times out or the
//     TXT record is missing a serial, we render "Offline" + whatever
//     hostname we do know.

// The four status strings the backend ladder emits, plus 'Idle'
// (connected but not enabled) and 'Offline' (probe timed out).
// Anything else is coerced to 'Offline' on the way in.
export const FLEET_STATUSES = [
  'Ready', 'Running', 'Alarm', 'Idle', 'Offline',
]

export const FLEET_STATUS_PALETTE = {
  Ready:   { bg: '#DCFCE7', fg: '#166534', border: '#86EFAC' },  // green
  Running: { bg: '#DBEAFE', fg: '#1E40AF', border: '#93C5FD' },  // blue
  Alarm:   { bg: '#FEE2E2', fg: '#991B1B', border: '#FCA5A5' },  // red
  Idle:    { bg: '#F1F5F9', fg: '#334155', border: '#CBD5E1' },  // slate
  Offline: { bg: '#F5F5F4', fg: '#57534E', border: '#D6D3D1' },  // stone
}

export function statusPalette(status) {
  return FLEET_STATUS_PALETTE[status] || FLEET_STATUS_PALETTE.Offline
}

// Fleet-card display shape. Purpose-built for the FleetHome grid —
// consumers never introspect the raw /api/fleet/peers payload; they
// receive one of these per card. Keeps the pins simple.
export function normalizeCard(card) {
  const c = card || {}
  const ident = c.identity || {}
  const status = FLEET_STATUSES.includes(c.status) ? c.status : 'Offline'
  const isOffline = status === 'Offline' || c.online === false
  return {
    serial:        String(ident.serial || ''),
    model:         String(ident.model || ''),
    friendlyName:  String(ident.friendly_name || ''),
    status,
    isOffline,
    alarm:         (c.alarm && typeof c.alarm === 'object') ? c.alarm : null,
    currentProgram: (c.currentProgram || c.current_program) || null,
    url:           String(c.url || ''),
    host:          String(c.host || ''),
    port:          Number(c.port || 0),
    isSelf:        !!c.is_self,
    probeMs:       Number(c.probe_ms || 0),
    offlineReason: String(c.offline_reason || ''),
  }
}

// One-shot fleet-peers fetch. Returns {self, peers, total} — the
// same shape the backend returns. Errors resolve to an empty result
// so App.jsx can fall back to "single-robot" and land in the
// dashboard rather than block the whole app on a discovery failure.
export async function fetchFleetPeers() {
  try {
    const res = await fetch('/api/fleet/peers', {
      credentials: 'omit',
      cache:       'no-store',
    })
    if (!res.ok) return { self: null, peers: [], total: 0 }
    const body = await res.json()
    if (!body || typeof body !== 'object') {
      return { self: null, peers: [], total: 0 }
    }
    return {
      self:  body.self  || null,
      peers: Array.isArray(body.peers) ? body.peers : [],
      total: Number(body.total || 0),
    }
  } catch (_) {
    return { self: null, peers: [], total: 0 }
  }
}

// Landing view derivation. The URL param `view` is authoritative
// when present; otherwise the registry count decides. This is the
// grid-renders-per-registry / single-robot-skips-grid invariant.
export function pickLandingView({ totalRobots, urlSearch }) {
  const params = new URLSearchParams(urlSearch || '')
  const explicit = params.get('view')
  if (explicit === 'fleet')     return 'fleet'
  if (explicit === 'dashboard') return 'dashboard'
  return (totalRobots > 1) ? 'fleet' : 'dashboard'
}
