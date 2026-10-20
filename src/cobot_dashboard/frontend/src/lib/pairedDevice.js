// pairedDevice.js — per-device pairing token storage + transport wrappers.
//
// Backend security boundary lives in cobot_dashboard/pairing.py; this
// module is the frontend half. Fork-registry capability
// `device_pairing_auth` — anything that mints, stores, or attaches a
// pairing token OUTSIDE this module is a fork.
//
// PWA STORAGE CHOICE — 2026-09-18.
// Token + CA + robot identity live in localStorage. This is the
// PWA-tier compromise: XSS-reachable but persistent across reloads and
// tabs. When the Capacitor native shell lands the storage moves to
// Capacitor Preferences (encrypted at rest, sandboxed per app id) via
// the same three keys below — this module is the seam and the ONLY
// place that will change. Do NOT read these keys directly elsewhere.

const KEY_TOKEN    = 'roboai-pair-token'
const KEY_TOKEN_ID = 'roboai-pair-token-id'
const KEY_ROBOT    = 'roboai-pair-robot'    // JSON: {serial, model, friendly_name}
const KEY_CA_PEM   = 'roboai-pair-ca-pem'

// ── Storage seam (localStorage today; Capacitor Preferences tomorrow)
function ls() {
  try { return window.localStorage } catch (_) { return null }
}

export function getToken() {
  const s = ls(); return s ? (s.getItem(KEY_TOKEN) || '') : ''
}

export function getTokenId() {
  const s = ls(); return s ? (s.getItem(KEY_TOKEN_ID) || '') : ''
}

export function getRobot() {
  const s = ls(); if (!s) return null
  try { const v = s.getItem(KEY_ROBOT); return v ? JSON.parse(v) : null }
  catch (_) { return null }
}

export function getCaPem() {
  const s = ls(); return s ? (s.getItem(KEY_CA_PEM) || '') : ''
}

export function storePairing({ token, token_id, robot, ca_cert_pem }) {
  const s = ls(); if (!s) return
  if (token)    s.setItem(KEY_TOKEN, token)
  if (token_id) s.setItem(KEY_TOKEN_ID, token_id)
  if (robot)    s.setItem(KEY_ROBOT, JSON.stringify(robot))
  // Only write the CA when it's non-empty. Login responses (add-61
  // §690) don't carry a CA — preserving whatever pairing landed.
  if (typeof ca_cert_pem === 'string' && ca_cert_pem.length > 0)
    s.setItem(KEY_CA_PEM, ca_cert_pem)
}

export function clearPairing() {
  const s = ls(); if (!s) return
  s.removeItem(KEY_TOKEN)
  s.removeItem(KEY_TOKEN_ID)
  s.removeItem(KEY_ROBOT)
  s.removeItem(KEY_CA_PEM)
}

export function isPaired() {
  return !!getToken()
}

// ── Transport interceptors (installed once at boot from main.jsx)
//
// The dashboard has ~40 fetch call sites and ~13 WS constructor sites
// across the app. Rather than rewriting each call site, we install two
// interceptors at module load that attach the token to every outgoing
// request. When PAIRING_ENFORCED=0 on the backend the token is silently
// ignored (middleware short-circuits). When enforced, the token is what
// gets past the middleware.

let _installed = false

export function installAuthInterceptors() {
  if (_installed) return
  _installed = true
  const origFetch = window.fetch.bind(window)
  window.fetch = function pairedFetch(input, init) {
    const t = getToken()
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const isPairEndpoint =
      url.includes('/api/pair/start') ||
      url.includes('/api/pair/confirm') ||
      url.includes('/api/identity')
    if (t && !isPairEndpoint) {
      init = init || {}
      const h = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {})
      if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + t)
      init.headers = h
    }
    const p = origFetch(input, init)
    p.then(async (res) => {
      if (!res || res.status !== 401) return
      if (isPairEndpoint) return
      // Auth model pivot (add-61 §690): read the JSON reason kind
      // and dispatch accordingly. `login_required` = LoginModal
      // opens; `pairing_required` (legacy) = wizard re-pair path.
      // Never surface a raw 401 to the operator.
      let kind = 'login_required'
      try {
        // Clone so consumer .json()/.text() still works.
        const j = await res.clone().json()
        if (j && j.kind) kind = j.kind
      } catch (_) { /* nop */ }
      try {
        if (kind === 'pairing_required') {
          clearPairing()
          window.dispatchEvent(new CustomEvent('roboai-pair-required',
            { detail: { url } }))
        } else {
          // Clear the token — it's either missing, revoked, or a
          // stale pairing token that the CONTROL middleware
          // refuses. The user re-signs-in via the modal.
          clearPairing()
          window.dispatchEvent(new CustomEvent('roboai-login-required',
            { detail: { url } }))
        }
      } catch (_) { /* nop */ }
    }).catch(() => {})
    return p
  }

  const OrigWS = window.WebSocket
  function AuthWS(url, protocols) {
    let u = url
    const t = getToken()
    if (t && typeof u === 'string' && u.indexOf('/ws/') !== -1) {
      const sep = u.indexOf('?') === -1 ? '?' : '&'
      u = u + sep + 'token=' + encodeURIComponent(t)
    }
    const ws = protocols !== undefined ? new OrigWS(u, protocols) : new OrigWS(u)
    // Same-origin 4401 close from the backend means unauth-under-enforced.
    // Wire it to the same re-pair-required signal as HTTP 401.
    ws.addEventListener('close', (ev) => {
      if (ev && ev.code === 4401) {
        try {
          clearPairing()
          window.dispatchEvent(new CustomEvent('roboai-pair-required',
            { detail: { url: u, ws: true } }))
        } catch (_) { /* nop */ }
      }
    })
    return ws
  }
  AuthWS.prototype = OrigWS.prototype
  AuthWS.CONNECTING = OrigWS.CONNECTING
  AuthWS.OPEN       = OrigWS.OPEN
  AuthWS.CLOSING    = OrigWS.CLOSING
  AuthWS.CLOSED     = OrigWS.CLOSED
  window.WebSocket = AuthWS
}

// ── Discovery helpers (mDNS-style)
//
// The browser cannot do Bonjour queries — the Web hasn't shipped mDNS
// APIs. The wizard's "Find your robot" list is populated from a small
// backend probe: /api/identity on `<host>.local:8080` for a curated
// hostname list. This module is the one that owns that probe so future
// paths (Capacitor CFNetService, dashboard side-channel) live here.

export async function probeRobotIdentity(host) {
  const url = `https://${host}/api/identity`
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
    if (!res.ok) return null
    return await res.json()
  } catch (_) {
    return null
  }
}
