// PairRequestModal.jsx — the paired-dashboard side of pairing.
//
// When any tablet on the LAN calls /api/pair/start, the backend
// broadcasts the pending session into STATE.pairing.pending. This
// modal renders that list — large code, big Deny button. The
// tablet operator reads the code aloud so the person on the tablet
// can enter it.
//
// The code is visible ONLY here — /api/pair/start no longer returns
// it in its HTTP response body. If both surfaces ever showed the
// code, the security boundary would leak: pin
// `test_pair_start_omits_code`.
//
// Fork-registry `device_pairing_auth` — this is the ONE place that
// renders a pending pairing code.

import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

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

function BigCode({ code }) {
  const digits = String(code || '').padStart(6, ' ').split('')
  return (
    <div style={{
      display: 'flex', gap: 10, marginTop: 16, marginBottom: 16,
      justifyContent: 'center',
    }}>
      {digits.map((d, i) => (
        <div key={i} style={{
          width: 68, height: 88, borderRadius: 14,
          background: C.bg, border: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 44, fontWeight: 700, letterSpacing: 0.5,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
          color: d === ' ' ? C.muted : C.text,
        }}>{d}</div>
      ))}
    </div>
  )
}

export default function PairRequestModal() {
  const pending = useStore((s) =>
    (s.robotState && s.robotState.pairing && s.robotState.pairing.pending) || [])
  const [busy, setBusy] = useState('')  // session_id being denied

  // The wizard runs on unpaired tablets — this modal must NEVER render
  // there. Guard: only mount when the local device already has a
  // pairing token. Prevents the wizard flow from double-rendering the
  // code on the tablet that just requested it (defence-in-depth with
  // the store's isPaired flag).
  const paired = typeof window !== 'undefined'
    && window.localStorage
    && !!window.localStorage.getItem('roboai-pair-token')
  if (!paired) return null
  if (!pending || pending.length === 0) return null

  const p = pending[0]  // one at a time

  async function deny() {
    if (busy) return
    setBusy(p.session_id)
    try {
      await fetch('/api/pair/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: p.session_id }),
      })
    } catch (_) { /* nop — next state frame will refresh */ }
    finally { setBusy('') }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      zIndex: 10000, display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 20,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      color: C.text,
    }}>
      <div style={{
        background: C.panel, border: `1px solid ${C.border}`,
        borderRadius: 16, padding: 28, width: '100%', maxWidth: 560,
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 6 }}>
          Pairing request from
        </div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>
          {p.device_name || 'a new device'}
        </div>
        <BigCode code={p.code} />
        <div style={{ color: C.muted, fontSize: 13, textAlign: 'center' }}>
          Read this code aloud so the person on the tablet can enter it.
          <br />
          Expires in {p.remaining_s}s.
        </div>
        <div style={{
          display: 'flex', gap: 12, marginTop: 20,
          justifyContent: 'flex-end',
        }}>
          <button onClick={deny} disabled={!!busy}
            style={{
              padding: '10px 18px', borderRadius: 10, border: 'none',
              background: C.bad, color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
            }}>
            {busy ? 'Denying…' : "Not me — Deny"}
          </button>
        </div>
      </div>
    </div>
  )
}
