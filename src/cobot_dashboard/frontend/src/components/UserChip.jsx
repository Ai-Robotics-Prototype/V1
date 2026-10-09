// UserChip.jsx — small nav-corner affordance showing signed-in
// user + Sign out. Absent (or "Sign in") when unauthenticated.
//
// Reads /api/whoami on mount + on `roboai-auth-changed` events.
// Sign-out POSTs /api/logout, clears the token in localStorage,
// and re-fetches whoami. Add-61 §690.

import { useCallback, useEffect, useState } from 'react'
import { clearPairing, getToken } from '../lib/pairedDevice'

const C = {
  bg:     'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.16)',
  text:   '#F4F4F6',
  muted:  '#8B8B93',
  accent: '#3B82F6',
}

export default function UserChip() {
  const [who, setWho]   = useState(null)   // {authenticated, username, role, auth_enforced}
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/whoami')
      if (res.ok) setWho(await res.json())
    } catch (_) { /* nop */ }
  }, [])

  useEffect(() => {
    refresh()
    const onChanged = () => refresh()
    window.addEventListener('roboai-auth-changed', onChanged)
    return () => window.removeEventListener('roboai-auth-changed', onChanged)
  }, [refresh])

  async function signOut() {
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/logout', { method: 'POST' })
    } catch (_) { /* nop */ }
    try { clearPairing() } catch (_) { /* nop */ }
    try { window.dispatchEvent(new CustomEvent('roboai-auth-changed')) }
    catch (_) { /* nop */ }
    setBusy(false)
    refresh()
  }

  function signIn() {
    try { window.dispatchEvent(new CustomEvent('roboai-login-required')) }
    catch (_) { /* nop */ }
  }

  // Under COBOT_AUTH_ENFORCED=0 the chip stays out of the way. Only
  // renders when authenticated (chip with sign-out) OR when auth is
  // enforced and unauth (subtle "Sign in" affordance).
  if (!who) return null
  if (who.authenticated) {
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: '4px 10px', border: `1px solid ${C.border}`,
        borderRadius: 999, background: C.bg, color: C.text,
        fontSize: 12, lineHeight: 1.2,
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: 999, background: C.accent,
        }} />
        <span style={{ fontWeight: 600 }}>{who.username}</span>
        <span style={{ color: C.muted, fontSize: 11 }}>({who.role})</span>
        <button onClick={signOut} disabled={busy}
          style={{
            background: 'transparent', border: 'none',
            color: C.muted, cursor: busy ? 'wait' : 'pointer',
            fontSize: 12, padding: '2px 6px', marginLeft: 4,
          }}>{busy ? '…' : 'Sign out'}</button>
      </div>
    )
  }
  if (who.auth_enforced) {
    return (
      <button onClick={signIn}
        style={{
          padding: '4px 12px', border: `1px solid ${C.border}`,
          borderRadius: 999, background: C.bg, color: C.text,
          fontSize: 12, cursor: 'pointer',
        }}>Sign in</button>
    )
  }
  return null
}
