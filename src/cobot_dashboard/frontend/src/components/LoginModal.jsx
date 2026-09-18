// LoginModal.jsx — the sign-in prompt for control actions.
//
// Auth model pivot (add-61 §690, 2026-09-18). Any control affordance
// (jog, run, enable, editors, IO writes) that tries to hit a
// gated endpoint gets a 401; the paired-transport interceptor
// dispatches `roboai-login-required` and this modal appears. After
// a successful login the modal closes — but the ORIGINAL action does
// NOT auto-fire; the user re-taps to actually do the thing (safety:
// no queued motion from a login).
//
// Fork-registry `device_pairing_auth` — the ONE surface that calls
// /api/login. Never call it from anywhere else.

import { useEffect, useRef, useState } from 'react'
import { storePairing } from '../lib/pairedDevice'

const C = {
  bg:      '#0C0C0E',
  panel:   '#141418',
  border:  '#242429',
  text:    '#F4F4F6',
  muted:   '#8B8B93',
  accent:  '#3B82F6',
  ok:      '#10B981',
  bad:     '#EF4444',
}

export default function LoginModal() {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr]   = useState('')
  const userRef = useRef(null)

  useEffect(() => {
    function onNeeded() {
      setErr('')
      setOpen(true)
      setTimeout(() => userRef.current && userRef.current.focus(), 60)
    }
    window.addEventListener('roboai-login-required', onNeeded)
    return () => window.removeEventListener('roboai-login-required', onNeeded)
  }, [])

  async function submit(e) {
    if (e && e.preventDefault) e.preventDefault()
    if (busy) return
    if (!username.trim() || !password) { setErr('Enter your username and password.'); return }
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          username: username.trim(), password }),
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        if (j.kind === 'locked_out') {
          setErr(`Too many wrong attempts. Try again in ${j.retry_after_s || 300}s.`)
          return
        }
        setErr('Sign-in failed. Check your username and password.')
        return
      }
      storePairing({
        token:       j.token,
        token_id:    j.token_id,
        robot:       null,           // login doesn't carry robot ident
        ca_cert_pem: '',
      })
      // Notify the app that auth state changed so UserChip re-reads.
      try { window.dispatchEvent(new CustomEvent('roboai-auth-changed',
        { detail: { username: j.username, role: j.role } })) } catch (_) {}
      setPassword('')
      setOpen(false)
      // DO NOT auto-fire the pending action — safety directive.
      // The user re-taps to actually do the thing.
    } catch (e2) {
      setErr(e2.message || 'Network error signing in.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      zIndex: 10500, display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 20,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      color: C.text,
    }}>
      <form onSubmit={submit} style={{
        background: C.panel, border: `1px solid ${C.border}`,
        borderRadius: 16, padding: 28, width: '100%', maxWidth: 420,
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>
          Sign in to control the robot
        </div>
        <div style={{ color: C.muted, marginBottom: 20, fontSize: 13 }}>
          Viewing does not require a sign-in. Movement and program
          changes do.
        </div>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12, marginBottom: 6, color: C.muted }}>
            Username
          </div>
          <input ref={userRef}
            value={username} onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            style={{
              width: '100%', padding: '10px 12px',
              background: C.bg, color: C.text,
              border: `1px solid ${C.border}`, borderRadius: 10,
              fontSize: 15, boxSizing: 'border-box',
            }} />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12, marginBottom: 6, color: C.muted }}>
            Password
          </div>
          <input type="password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            style={{
              width: '100%', padding: '10px 12px',
              background: C.bg, color: C.text,
              border: `1px solid ${C.border}`, borderRadius: 10,
              fontSize: 15, boxSizing: 'border-box',
            }} />
        </label>
        {err && <div style={{ color: C.bad, fontSize: 13, marginBottom: 12 }}>
          {err}
        </div>}
        <div style={{
          display: 'flex', gap: 12, justifyContent: 'flex-end',
          marginTop: 8,
        }}>
          <button type="button"
            onClick={() => { setOpen(false); setErr(''); setPassword('') }}
            style={{
              padding: '10px 16px', borderRadius: 10,
              border: `1px solid ${C.border}`, background: 'transparent',
              color: C.text, cursor: 'pointer', fontSize: 14,
            }}>Cancel</button>
          <button type="submit" disabled={busy}
            style={{
              padding: '10px 20px', borderRadius: 10, border: 'none',
              background: C.accent, color: '#fff', fontSize: 14,
              fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
              opacity: busy ? 0.7 : 1,
            }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  )
}
