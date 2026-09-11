import { useEffect, useState } from 'react'
import {
  jogTelemetryEnabled, jogTelemetrySnapshot,
  jogTelemetrySubscribe, jogTelemetryDisable,
} from '../lib/jogTelemetry'

// Corner overlay that renders when jog telemetry is enabled
// (?jogdebug=1 in the URL or localStorage.JOG_DEBUG === '1'). Shows
// the last few lifecycle events + per-source interval distributions +
// WS state-channel gap p50/p95/p99. Turn off with the close button
// (clears localStorage.JOG_DEBUG).
//
// Deliberately NOT hooked into the app's normal state tree — this is
// a dev instrument and must not add renders to production paths when
// disabled.
export default function JogDebugPanel() {
  const [enabled, setEnabled] = useState(false)
  const [snap, setSnap] = useState(null)

  useEffect(() => {
    setEnabled(jogTelemetryEnabled())
    if (!jogTelemetryEnabled()) return undefined
    const bump = () => setSnap(jogTelemetrySnapshot())
    bump()
    const unsub = jogTelemetrySubscribe(bump)
    // Also refresh the wall-clock text once per second even without new
    // events so "recent event N ms ago" stays live.
    const id = setInterval(bump, 500)
    return () => { unsub(); clearInterval(id) }
  }, [])

  if (!enabled || !snap) return null

  const box = {
    position: 'fixed', bottom: 44, right: 12, zIndex: 9998,
    background: 'rgba(17,24,39,0.94)', color: '#F3F4F6',
    border: '1px solid #374151', borderRadius: 8,
    padding: '10px 12px', fontFamily: 'var(--font-mono, monospace)',
    fontSize: 11, lineHeight: 1.35,
    minWidth: 340, maxWidth: 400,
    boxShadow: '0 10px 25px rgba(0,0,0,0.4)',
  }
  const hdr = { color: '#93C5FD', fontWeight: 700, letterSpacing: '0.05em' }
  const dim = { color: '#9CA3AF' }
  const row = { display: 'flex', justifyContent: 'space-between', gap: 8 }

  const fmt = (v) => v == null ? '—' : Math.round(v) + 'ms'

  const now = performance.now()

  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={hdr}>JOG TELEMETRY</span>
        {snap.session && (
          <span style={{ color: '#FCD34D', fontSize: 10 }}>· {snap.session}</span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => jogTelemetryDisable()} style={{
          background: 'transparent', color: '#9CA3AF',
          border: '1px solid #4B5563', padding: '1px 8px',
          borderRadius: 4, fontSize: 10, cursor: 'pointer',
        }}>close</button>
      </div>

      <div style={{ color: '#60A5FA', marginTop: 4, marginBottom: 2 }}>ticker source (interval ms)</div>
      {['worker', 'raf', 'sent'].map((k) => {
        const s = snap.tickers[k] || {}
        return (
          <div key={k} style={row}>
            <span>{k.padEnd(6, ' ')}</span>
            <span style={dim}>
              n={s.n}&nbsp; p50={fmt(s.p50)}&nbsp; p95={fmt(s.p95)}&nbsp; max={fmt(s.max)}
            </span>
          </div>
        )
      })}

      <div style={{ color: '#60A5FA', marginTop: 8, marginBottom: 2 }}>ws /ws/state gap</div>
      <div style={row}>
        <span>gap&nbsp;&nbsp;</span>
        <span style={dim}>
          n={snap.ws.n}&nbsp;p50={fmt(snap.ws.p50)}&nbsp;p95={fmt(snap.ws.p95)}&nbsp;
          p99={fmt(snap.ws.p99)}&nbsp;max={fmt(snap.ws.max)}
        </span>
      </div>

      <div style={{ color: '#60A5FA', marginTop: 8, marginBottom: 2 }}>recent events</div>
      <div style={{
        maxHeight: 140, overflowY: 'auto',
        borderTop: '1px solid #374151', paddingTop: 4,
      }}>
        {snap.events.length === 0 && (
          <div style={dim}>— none yet (touch a jog button)</div>
        )}
        {snap.events.slice(-14).reverse().map((e, i) => (
          <div key={i} style={{
            display: 'flex', justifyContent: 'space-between', gap: 6,
            color: e.kind.startsWith('pointer') ? '#FBBF24'
                 : e.kind.startsWith('tick_skip') ? '#F87171'
                 : e.kind.startsWith('tick_') ? '#A7F3D0'
                 : e.kind.startsWith('release') ? '#FCA5A5'
                 : '#F3F4F6',
          }}>
            <span>{e.kind}</span>
            <span style={dim}>
              {Math.round(now - e.t)}ms ago
              {e.pointerType ? ` · ${e.pointerType}` : ''}
              {e.seq != null ? ` · seq ${e.seq}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
