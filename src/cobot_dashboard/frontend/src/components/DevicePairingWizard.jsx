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

// UNREACHABLE_COPY (2026-09-18 add-59 §688 field-directive): the
// exact operator-facing copy for "you typed an address that didn't
// answer from your device". Duplicating this string ANYWHERE else
// is a fork of `mode_refusal_copy`-adjacent doctrine — the wizard
// is the one voice for pairing errors.
export const UNREACHABLE_COPY =
  "This address didn't respond from your device — it may be on a different network than this tablet."

function DiscoverPage({ onFound }) {
  const [address, setAddress] = useState('')
  const [probing, setProbing] = useState(false)
  const [err, setErr]         = useState('')
  // Reachable candidates rendered as clickable rows.
  const [reachable, setReachable] = useState([])
  // Addresses the robot claims to listen on that DID NOT answer from
  // this device — surfaced as informational text so the operator sees
  // the wired/WiFi split honestly.
  const [unreachable, setUnreachable] = useState([])
  const [scanned, setScanned] = useState(false)

  const platformNote = useMemo(() => {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    if (/iPhone|iPad|iPod|Android/.test(ua))
      return "We're checking every network address your robot advertises. Only the ones this tablet can reach appear below."
    return "We're checking every network address your robot advertises. Only the ones your device can reach appear below."
  }, [])

  useEffect(() => {
    let alive = true
    async function scan() {
      // Step 1: ask the robot at the CURRENT origin (which loaded
      // this wizard so we know it's reachable) for its own list of
      // advertised addresses. /api/identity returns
      //   {serial, model, friendly_name,
      //    network: {mdns_host, addresses, port}}.
      //
      // Step 2: build one host:port per address + mdns_host, probe
      // each from the client's own side, split reachable /
      // unreachable. This is the client-side reachability check that
      // add-59 §688 requires — the server doesn't decide, the client
      // does.
      let own = null
      try {
        const res = await fetch('/api/identity', { credentials: 'omit' })
        if (res.ok) own = await res.json()
      } catch (_) { /* nop */ }
      if (!alive) return

      const currentHost = window.location.host          // host:port
      const net         = (own && own.network) || {}
      const port        = net.port || Number(window.location.port) || 8080
      const raw         = new Set()
      raw.add(currentHost)
      if (net.mdns_host)  raw.add(`${net.mdns_host}:${port}`)
      for (const a of net.addresses || []) raw.add(`${a}:${port}`)

      const candidates = Array.from(raw)
      const probes = candidates.map(async (host) => {
        const id = await probeRobotIdentity(host)
        return { host, id, ok: !!(id && id.serial),
                 current: host === currentHost }
      })
      const settled = await Promise.all(probes)
      if (!alive) return
      const ok   = settled.filter((r) => r.ok)
      const bad  = settled.filter((r) => !r.ok)
      // Put the current-origin row first so the operator has a
      // guaranteed-working path even if a race made one probe fail.
      ok.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
      setReachable(ok)
      setUnreachable(bad)
      setScanned(true)
    }
    scan()
    return () => { alive = false }
  }, [])

  async function tryAddress() {
    const host = address.trim().replace(/^https?:\/\//i, '')
    if (!host) { setErr('Enter an address'); return }
    setErr(''); setProbing(true)
    const id = await probeRobotIdentity(host)
    if (id && id.serial) {
      onFound({ host, id })
    } else {
      setErr(UNREACHABLE_COPY)
    }
    setProbing(false)
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
      {!scanned && (
        <div style={{ color: NEURO_COLORS.muted, fontSize: 13, marginBottom: 16 }}>
          Checking network addresses…
        </div>
      )}
      {scanned && reachable.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: NEURO_COLORS.muted, marginBottom: 8 }}>
            Reachable from this device
          </div>
          {reachable.map((c) => (
            <div key={c.host}
              onClick={() => onFound(c)}
              style={{
                padding: '12px 14px', border: `1px solid ${NEURO_COLORS.border}`,
                borderRadius: 10, marginBottom: 8, cursor: 'pointer',
              }}>
              <div style={{ fontWeight: 600 }}>
                {c.id.friendly_name || 'NeuRobots robot'}
                {c.current && (
                  <span style={{ fontSize: 11, marginLeft: 8, color: NEURO_COLORS.ok,
                                 padding: '2px 6px', borderRadius: 4,
                                 border: `1px solid ${NEURO_COLORS.ok}` }}>
                    connected here
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: NEURO_COLORS.muted, marginTop: 2 }}>
                {c.id.serial} · {c.id.model} · {c.host}
              </div>
            </div>
          ))}
        </div>
      )}
      {scanned && unreachable.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: NEURO_COLORS.muted, marginBottom: 6 }}>
            Advertised but not reachable from this device
          </div>
          <div style={{ fontSize: 12, color: NEURO_COLORS.muted, marginBottom: 6,
                        lineHeight: 1.5 }}>
            {UNREACHABLE_COPY}
          </div>
          <div style={{
            fontSize: 12, color: NEURO_COLORS.muted,
            fontFamily: 'ui-monospace, Menlo, monospace',
            padding: '8px 10px', border: `1px dashed ${NEURO_COLORS.border}`,
            borderRadius: 8,
          }}>
            {unreachable.map((r) => r.host).join('  ·  ')}
          </div>
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
