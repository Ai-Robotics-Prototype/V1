import { useStore } from '../store/useStore'
import { useEffect, useState } from 'react'

export default function ConnectionOverlay() {
  const wsStatus  = useStore((s) => s.wsStatus)
  const wsLatency = useStore((s) => s.wsLatency)
  const [dots, setDots]       = useState('')
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (wsStatus === 'connected') return
    const id = setInterval(() => {
      setDots((d) => d.length >= 3 ? '' : d + '.')
      setElapsed((e) => e + 1)
    }, 500)
    return () => clearInterval(id)
  }, [wsStatus])

  if (wsStatus === 'connected') return null

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(10,10,14,0.96)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 16,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%',
        border: '3px solid rgba(59,130,246,0.2)',
        borderTop: '3px solid #3B82F6',
        animation: 'spin 1s linear infinite',
      }} />

      <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--t1)' }}>
        {wsStatus === 'connecting'
          ? `Connecting${dots}`
          : `Reconnecting${dots}`}
      </div>

      <div style={{
        fontSize: 12, color: 'var(--tm)',
        textAlign: 'center', maxWidth: 320, lineHeight: 1.6,
      }}>
        Connecting to RoboAi server at<br/>
        <span style={{ fontFamily: 'monospace', color: 'var(--acc)' }}>
          {window.location.host}
        </span>
      </div>

      {elapsed > 6 && (
        <div style={{
          marginTop: 8,
          padding: '10px 16px',
          background: 'rgba(234,179,8,0.1)',
          border: '1px solid rgba(234,179,8,0.3)',
          borderRadius: 8,
          fontSize: 11,
          color: '#EAB308',
          textAlign: 'center',
          maxWidth: 320,
          lineHeight: 1.6,
        }}>
          Taking longer than expected.<br/>
          Make sure the dashboard server is running:<br/>
          <span style={{ fontFamily: 'monospace', fontSize: 10 }}>
            python3 src/cobot_dashboard/cobot_dashboard/dashboard_server.py
          </span>
        </div>
      )}

      {elapsed > 15 && (
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8,
            padding: '8px 20px',
            background: 'var(--acc)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
