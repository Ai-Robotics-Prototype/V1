// DevicePairingWizard.jsx — customer-facing first-launch pairing.
//
// Three pages: Find → Pair → Done. Renders full-screen when the app
// has no saved token (App.jsx short-circuits before the dashboard
// mounts) or when the operator re-pairs after a 401. NeuRobots
// branding, plain English, both editions.
//
// Not to be confused with `SetupWizard.jsx` (cell/environment wizard)
// or `HardwareSetupWizard.jsx` (hookup guide). This is the DEVICE
// pairing wizard — auth handshake between tablet and robot.
//
// Fork-registry `device_pairing_auth` — the ONE frontend surface that
// calls /api/pair/start + /api/pair/confirm. Other code paths reach
// pairing state through `pairedDevice.js` (getToken, storePairing,
// clearPairing) — never via ad-hoc fetches.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  storePairing, clearPairing, probeRobotIdentity, getToken,
} from '../lib/pairedDevice'

const NEURO_COLORS = {
  bg:      '#0C0C0E',
  panel:   '#141418',
  border:  '#242429',
  text:    '#F4F4F6',
  muted:   '#8B8B93',
  accent:  '#3B82F6',   // NeuRobots blue
  accent2: '#60A5FA',
  ok:      '#10B981',
  bad:     '#EF4444',
}

function Screen({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: NEURO_COLORS.bg,
      color: NEURO_COLORS.text, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      zIndex: 9999,
    }}>{children}</div>
  )
}

function Panel({ children }) {
  return (
    <div style={{
      width: '100%', maxWidth: 520, background: NEURO_COLORS.panel,
      border: `1px solid ${NEURO_COLORS.border}`, borderRadius: 16,
      padding: 32, margin: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
    }}>{children}</div>
  )
}

function BrandBar() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24,
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 6,
        background: `linear-gradient(135deg, ${NEURO_COLORS.accent}, ${NEURO_COLORS.accent2})`,
      }} />
      <div style={{ fontWeight: 700, letterSpacing: 0.3 }}>NeuRobots</div>
      <div style={{ marginLeft: 'auto', color: NEURO_COLORS.muted, fontSize: 12 }}>
        Device pairing
      </div>
    </div>
  )
}

function Btn({ children, onClick, disabled, kind = 'primary', ...rest }) {
  const bg = disabled ? '#25252B'
    : kind === 'primary' ? NEURO_COLORS.accent
    : kind === 'danger'  ? NEURO_COLORS.bad
    : 'transparent'
  const fg = disabled ? NEURO_COLORS.muted : NEURO_COLORS.text
  const border = kind === 'ghost' ? `1px solid ${NEURO_COLORS.border}` : 'none'
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled}
      style={{
        padding: '12px 20px', borderRadius: 10, border,
        background: bg, color: fg, fontSize: 15, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }} {...rest}>{children}</button>
  )
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <div style={{ fontSize: 13, marginBottom: 6, color: NEURO_COLORS.muted }}>
        {label}
      </div>
      {children}
      {hint && (
        <div style={{ fontSize: 12, marginTop: 6, color: NEURO_COLORS.muted }}>
          {hint}
        </div>
      )}
    </label>
  )
}

// ── Page 1: Find your robot ────────────────────────────────────────
//
// Browsers don't do Bonjour; discovery here is a probe of `<host>.local`
// candidates on port 8080 via /api/identity. The address-entry fallback
// covers non-.local networks (managed WiFi, dhcp corp).

function DiscoverPage({ onFound }) {
  const [address, setAddress] = useState('')
  const [probing, setProbing] = useState(false)
  const [err, setErr]         = useState('')
  const [candidates, setCandidates] = useState([])
  const platformNote = useMemo(() => {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    if (/iPhone|iPad|iPod|Android/.test(ua))
      return 'On mobile browsers, discovery scans a short list of names. If your robot is not shown, type its address below.'
    return 'Automatic discovery scans a short list of names on this network. Type an address below if your robot is on a different network.'
  }, [])

  useEffect(() => {
    let alive = true
    async function scan() {
      // Probe a small curated set — the robot advertises `<friendly_name>.local`
      // and the raw hostname. This is a UX helper, not the security surface.
      const guesses = [
        `${window.location.hostname}`,
        'neurobots.local:8080',
        'cobot.local:8080',
        'teddy-desktop.local:8080',
      ].filter(Boolean)
      const results = []
      for (const g of guesses) {
        if (!alive) return
        const id = await probeRobotIdentity(g)
        if (id && id.serial) results.push({ host: g, id })
      }
      if (alive) setCandidates(results)
    }
    scan()
    return () => { alive = false }
  }, [])

  async function tryAddress() {
    const host = address.trim().replace(/^https?:\/\//i, '')
    if (!host) { setErr('Enter an address'); return }
    setErr(''); setProbing(true)
    try {
      const id = await probeRobotIdentity(host)
      if (!id || !id.serial) throw new Error('That address does not answer as a NeuRobots robot.')
      onFound({ host, id })
    } catch (e) {
      setErr(e.message || 'Could not reach that address.')
    } finally {
      setProbing(false)
    }
  }

  return (
    <Panel>
      <BrandBar />
      <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        Find your robot
      </div>
      <div style={{ color: NEURO_COLORS.muted, marginBottom: 16, fontSize: 14 }}>
        {platformNote}
      </div>
      {candidates.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, color: NEURO_COLORS.muted, marginBottom: 8 }}>
            Discovered
          </div>
          {candidates.map((c) => (
            <div key={c.host}
              onClick={() => onFound(c)}
              style={{
                padding: '12px 14px', border: `1px solid ${NEURO_COLORS.border}`,
                borderRadius: 10, marginBottom: 8, cursor: 'pointer',
              }}>
              <div style={{ fontWeight: 600 }}>{c.id.friendly_name || 'NeuRobots robot'}</div>
              <div style={{ fontSize: 12, color: NEURO_COLORS.muted, marginTop: 2 }}>
                {c.id.serial} · {c.id.model} · {c.host}
              </div>
            </div>
          ))}
        </div>
      )}
      <Field label="Or enter the robot's address"
        hint="Example: 192.168.2.246:8080 or my-robot.local:8080">
        <input value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder="host:port"
          style={{
            width: '100%', padding: '12px 14px',
            background: NEURO_COLORS.bg, color: NEURO_COLORS.text,
            border: `1px solid ${NEURO_COLORS.border}`, borderRadius: 10,
            fontSize: 15, boxSizing: 'border-box',
          }} />
      </Field>
      {err && <div style={{ color: NEURO_COLORS.bad, marginBottom: 12, fontSize: 13 }}>
        {err}
      </div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn onClick={tryAddress} disabled={probing}>
          {probing ? 'Checking…' : 'Next'}
        </Btn>
      </div>
    </Panel>
  )
}

// ── Page 2: Pair ───────────────────────────────────────────────────
//
// The tablet asks the robot to start a pairing session; the robot's
// display shows a 6-digit code; the operator reads it aloud and the
// person on the tablet types it in.

function PairPage({ target, deviceName, onDeviceName, onDone, onBack }) {
  const [sessionId, setSessionId] = useState('')
  const [code, setCode]           = useState('')
  const [remaining, setRemaining] = useState(0)
  const [status, setStatus]       = useState('idle')  // idle|starting|waiting|confirming|error|lockout
  const [err, setErr]             = useState('')

  const codeInputs = [useRef(null), useRef(null), useRef(null), useRef(null), useRef(null), useRef(null)]
  const [digits, setDigits] = useState(['', '', '', '', '', ''])

  async function start() {
    if (!deviceName.trim()) { setErr('Give this device a name first'); return }
    setStatus('starting'); setErr('')
    try {
      const res = await fetch(`https://${target.host}/api/pair/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_name: deviceName.trim() }),
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        if (j.kind === 'locked_out') {
          setStatus('lockout')
          setErr(`Too many wrong codes. Try again in ${j.retry_after_s || 300}s.`)
          return
        }
        throw new Error(j.reason || j.kind || 'Could not start pairing')
      }
      setSessionId(j.session_id)
      setRemaining(j.expires_in_s || 90)
      setStatus('waiting')
      // focus first digit
      setTimeout(() => codeInputs[0].current && codeInputs[0].current.focus(), 100)
    } catch (e) {
      setStatus('error'); setErr(e.message || String(e))
    }
  }

  useEffect(() => {
    if (status !== 'waiting' || remaining <= 0) return
    const id = setTimeout(() => setRemaining((r) => Math.max(0, r - 1)), 1000)
    return () => clearTimeout(id)
  }, [status, remaining])

  function setDigit(i, v) {
    v = (v || '').replace(/\D/g, '').slice(0, 1)
    const next = digits.slice(); next[i] = v; setDigits(next)
    setCode(next.join(''))
    if (v && i < 5) codeInputs[i + 1].current && codeInputs[i + 1].current.focus()
  }

  function onKeyDown(i, ev) {
    if (ev.key === 'Backspace' && !digits[i] && i > 0) {
      codeInputs[i - 1].current && codeInputs[i - 1].current.focus()
    }
  }

  function onPaste(ev) {
    const txt = (ev.clipboardData || window.clipboardData).getData('text') || ''
    const clean = txt.replace(/\D/g, '').slice(0, 6)
    if (clean.length === 0) return
    ev.preventDefault()
    const next = clean.padEnd(6, '').split('').slice(0, 6)
    setDigits(next); setCode(next.join(''))
  }

  async function submitCode() {
    if (code.length !== 6) { setErr('Enter all 6 digits'); return }
    setStatus('confirming'); setErr('')
    try {
      const res = await fetch(`https://${target.host}/api/pair/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, code }),
      })
      const j = await res.json()
      if (!res.ok || !j.ok) {
        if (j.kind === 'locked_out') {
          setStatus('lockout')
          setErr(`Too many wrong codes. Try again in ${j.retry_after_s || 300}s.`)
          return
        }
        if (j.kind === 'bad_code' || j.kind === 'no_session') {
          setErr('That code did not match. Ask the robot to show a new one.')
          setStatus('waiting'); setDigits(['', '', '', '', '', '']); setCode('')
          setTimeout(() => codeInputs[0].current && codeInputs[0].current.focus(), 50)
          return
        }
        if (j.kind === 'expired') {
          setErr('That code expired. Starting a new one.')
          setStatus('idle'); setSessionId(''); setDigits(['', '', '', '', '', ''])
          setCode(''); return
        }
        throw new Error(j.reason || j.kind || 'Could not confirm')
      }
      storePairing({
        token:       j.token,
        token_id:    j.token_id,
        robot:       j.robot,
        ca_cert_pem: j.ca_cert_pem || '',
      })
      onDone(j)
    } catch (e) {
      setStatus('error'); setErr(e.message || String(e))
    }
  }

  return (
    <Panel>
      <BrandBar />
      <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        Pair with {target.id.friendly_name || 'the robot'}
      </div>
      <div style={{ color: NEURO_COLORS.muted, marginBottom: 20, fontSize: 13 }}>
        {target.id.serial} · {target.id.model}
      </div>
      <Field label="Name this device"
        hint="Shown in the robot's device list so you can revoke it later.">
        <input value={deviceName} onChange={(e) => onDeviceName(e.target.value)}
          placeholder="e.g. Tim's tablet"
          disabled={status === 'waiting' || status === 'confirming'}
          style={{
            width: '100%', padding: '12px 14px',
            background: NEURO_COLORS.bg, color: NEURO_COLORS.text,
            border: `1px solid ${NEURO_COLORS.border}`, borderRadius: 10,
            fontSize: 15, boxSizing: 'border-box',
          }} />
      </Field>

      {status !== 'waiting' && status !== 'confirming' && (
        <>
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <Btn kind="ghost" onClick={onBack}>Back</Btn>
            <div style={{ flex: 1 }} />
            <Btn onClick={start} disabled={status === 'starting'}>
              {status === 'starting' ? 'Starting…' : 'Start pairing'}
            </Btn>
          </div>
          {err && <div style={{ color: NEURO_COLORS.bad, marginTop: 12, fontSize: 13 }}>{err}</div>}
        </>
      )}

      {(status === 'waiting' || status === 'confirming') && (
        <>
          <div style={{
            padding: 14, background: NEURO_COLORS.bg,
            border: `1px solid ${NEURO_COLORS.border}`, borderRadius: 10,
            marginBottom: 12,
          }}>
            <div style={{ fontSize: 14, marginBottom: 6 }}>
              Enter the code shown on the robot's screen
            </div>
            <div style={{ fontSize: 12, color: NEURO_COLORS.muted }}>
              Expires in {remaining}s. If it disappears, click Start pairing again.
            </div>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', gap: 6,
            marginBottom: 12,
          }} onPaste={onPaste}>
            {digits.map((d, i) => (
              <input key={i} ref={codeInputs[i]}
                value={d}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                inputMode="numeric" maxLength={1}
                style={{
                  width: 52, height: 60,
                  textAlign: 'center', fontSize: 26, fontWeight: 700,
                  background: NEURO_COLORS.bg, color: NEURO_COLORS.text,
                  border: `1px solid ${NEURO_COLORS.border}`, borderRadius: 10,
                }} />
            ))}
          </div>
          {err && <div style={{ color: NEURO_COLORS.bad, marginBottom: 12, fontSize: 13 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 12 }}>
            <Btn kind="ghost" onClick={() => { setStatus('idle'); setSessionId(''); setDigits(['','','','','','']); setCode('') }}>
              Cancel
            </Btn>
            <div style={{ flex: 1 }} />
            <Btn onClick={submitCode} disabled={status === 'confirming' || code.length !== 6}>
              {status === 'confirming' ? 'Checking…' : 'Confirm'}
            </Btn>
          </div>
        </>
      )}
      {status === 'lockout' && (
        <div style={{ color: NEURO_COLORS.bad, marginTop: 16, fontSize: 13 }}>
          {err}
        </div>
      )}
    </Panel>
  )
}

// ── Page 3: Done ───────────────────────────────────────────────────

function DonePage({ result, onEnter }) {
  const r = result && result.robot || {}
  return (
    <Panel>
      <BrandBar />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 16, color: NEURO_COLORS.ok,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 22,
          background: 'rgba(16,185,129,0.14)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `1px solid ${NEURO_COLORS.ok}`,
        }}>
          <svg viewBox="0 0 24 24" width={24} height={24} fill="none"
            stroke={NEURO_COLORS.ok} strokeWidth={3}>
            <path d="M5 12l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: NEURO_COLORS.text }}>
          Paired with {r.friendly_name || 'your robot'}
        </div>
      </div>
      <div style={{ color: NEURO_COLORS.muted, marginBottom: 20, fontSize: 13 }}>
        {r.serial ? `Serial ${r.serial} · ${r.model || ''}` : ''}
      </div>
      <div style={{
        padding: 14, background: NEURO_COLORS.bg,
        border: `1px solid ${NEURO_COLORS.border}`, borderRadius: 10,
        marginBottom: 20, fontSize: 13, color: NEURO_COLORS.muted, lineHeight: 1.5,
      }}>
        The robot's certificate is stored on this device. Your browser
        may still show <b style={{ color: NEURO_COLORS.text }}>Not
        secure</b> the first time — that goes away permanently once you
        install the certificate through your browser settings. The
        NeuRobots mobile app installs it automatically.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn onClick={onEnter}>Open dashboard</Btn>
      </div>
    </Panel>
  )
}

// ── Wizard orchestrator ────────────────────────────────────────────

export default function DevicePairingWizard({ onComplete, initialPage }) {
  const [page, setPage]           = useState(initialPage || 'find')  // find|pair|done
  const [target, setTarget]       = useState(null)                   // {host, id}
  const [deviceName, setDeviceName] = useState('')
  const [result, setResult]       = useState(null)

  // Auto-suggest a device name from the UA (short, friendly).
  useEffect(() => {
    if (deviceName) return
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    const platform = /iPad/.test(ua) ? 'iPad'
      : /iPhone/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
      : /Macintosh/.test(ua) ? 'Mac'
      : /Windows/.test(ua) ? 'Windows'
      : /Linux/.test(ua) ? 'Linux' : 'Device'
    setDeviceName(`${platform} — ${new Date().toLocaleDateString()}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (page === 'find')
    return (
      <Screen>
        <DiscoverPage onFound={(t) => { setTarget(t); setPage('pair') }} />
      </Screen>
    )
  if (page === 'pair' && target)
    return (
      <Screen>
        <PairPage
          target={target}
          deviceName={deviceName}
          onDeviceName={setDeviceName}
          onBack={() => setPage('find')}
          onDone={(res) => { setResult(res); setPage('done') }}
        />
      </Screen>
    )
  if (page === 'done')
    return (
      <Screen>
        <DonePage result={result} onEnter={() => onComplete && onComplete(result)} />
      </Screen>
    )
  return (
    <Screen>
      <DiscoverPage onFound={(t) => { setTarget(t); setPage('pair') }} />
    </Screen>
  )
}

// Helper for App.jsx: is the current URL likely local (Jetson display /
// deploy tool)? Wizard should not force-pair on the operator's own
// display since localhost grandfathers through the backend anyway.
export function isLocalOrigin() {
  try {
    const h = window.location.hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch (_) { return false }
}
