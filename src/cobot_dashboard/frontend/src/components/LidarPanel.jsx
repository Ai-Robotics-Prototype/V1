import { useEffect, useRef, useState } from 'react'

const CANVAS_PX = 400

export default function LidarPanel() {
  const canvasRef = useRef(null)
  const ptsRef    = useRef([])
  const [live,    setLive]   = useState(false)
  const [ptCount, setPtCnt]  = useState(0)
  const [range,   setRange]  = useState(6)

  useEffect(() => {
    let ws, rafId, dead = false

    function connect() {
      if (dead) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws/lidar`)
      ws.onopen  = () => setLive(true)
      ws.onclose = () => { setLive(false); if (!dead) setTimeout(connect, 2000) }
      ws.onerror = () => ws.close()
      ws.onmessage = ({ data }) => {
        try {
          const d = JSON.parse(data)
          ptsRef.current = d.points || []
          setPtCnt(ptsRef.current.length)
        } catch (_) {}
      }
    }

    function draw() {
      const canvas = canvasRef.current
      if (!canvas) { rafId = requestAnimationFrame(draw); return }
      const ctx   = canvas.getContext('2d')
      const W = canvas.width, H = canvas.height
      const cx = W / 2, cy = H / 2
      const scale = W / (range * 2)

      // White background
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, W, H)

      // Grid lines every 1m — light grey
      ctx.strokeStyle = '#E5E7EB'
      ctx.lineWidth   = 1
      for (let m = 1; m <= range; m++) {
        const gx = m * scale
        ctx.beginPath()
        ctx.moveTo(cx + gx, 0); ctx.lineTo(cx + gx, H)
        ctx.moveTo(cx - gx, 0); ctx.lineTo(cx - gx, H)
        ctx.moveTo(0, cy + gx); ctx.lineTo(W, cy + gx)
        ctx.moveTo(0, cy - gx); ctx.lineTo(W, cy - gx)
        ctx.stroke()
      }
      // Crosshair
      ctx.strokeStyle = '#D1D5DB'
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
      ctx.moveTo(0, cy); ctx.lineTo(W, cy)
      ctx.stroke()

      // Safety rings
      const rings = [
        { r: 1.2, color: 'rgba(22,163,74,0.25)',   lineColor: '#16A34A' },
        { r: 0.6, color: 'rgba(217,119,6,0.30)',   lineColor: '#D97706' },
        { r: 0.3, color: 'rgba(220,38,38,0.35)',   lineColor: '#DC2626' },
      ]
      for (const ring of rings) {
        const rr = ring.r * scale
        if (rr < 2) continue
        ctx.beginPath()
        ctx.arc(cx, cy, rr, 0, Math.PI * 2)
        ctx.fillStyle   = ring.color
        ctx.fill()
        ctx.strokeStyle = ring.lineColor
        ctx.lineWidth   = 1
        ctx.stroke()
      }

      // Points — colour by height (p.y = vertical in sensor frame)
      const pts = ptsRef.current
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k]
        const px = cx + p.x * scale
        const py = cy - p.z * scale     // top-down: forward=up on screen
        if (px < 0 || px > W || py < 0 || py > H) continue

        let r, g, b
        const h = p.y ?? 0
        if (h < 0.1)      { r = 180; g = 200; b = 240 }   // light blue  — floor
        else if (h < 0.5) { r = 100; g = 200; b = 150 }   // green       — low objects
        else if (h < 1.0) { r = 240; g = 180; b = 60  }   // yellow      — tall objects
        else               { r = 220; g = 80;  b = 80  }   // red         — very tall

        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(px - 1, py - 1, 2, 2)
      }

      // Robot origin
      ctx.fillStyle = '#2563EB'
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.fill()

      rafId = requestAnimationFrame(draw)
    }

    connect()
    draw()
    return () => { dead = true; cancelAnimationFrame(rafId); if (ws) ws.close() }
  }, [range])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden', height: '100%',
    }}>
      {/* Header */}
      <div style={{
        padding: '5px 10px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          LiDAR
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          {ptCount.toLocaleString()} pts
        </span>

        {/* Range selector */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
          {[3, 6, 12].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 5,
                border: range === r ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: range === r ? 'var(--accent-dim)' : 'transparent',
                color: range === r ? 'var(--accent)' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {r}m
            </button>
          ))}
        </div>

        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
          background: live ? 'var(--green-dim)' : 'var(--bg-surface)',
          color:      live ? 'var(--green)'     : 'var(--text-muted)',
        }}>
          {live ? 'LIVE' : 'SIM'}
        </span>
      </div>

      {/* Canvas */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 4, background: 'var(--bg-app)',
      }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_PX}
          height={CANVAS_PX}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      </div>
    </div>
  )
}
