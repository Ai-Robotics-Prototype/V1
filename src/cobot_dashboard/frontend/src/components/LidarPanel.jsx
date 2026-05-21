import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'

export default function LidarPanel() {
  const canvasRef = useRef(null)
  const ptsRef    = useRef([])
  const detsRef   = useRef([])
  const [live,    setLive]  = useState(false)
  const [ptCount, setPtCnt] = useState(0)
  const [hz,      setHz]    = useState(0)
  const [range,   setRange] = useState(6)

  // Keep detsRef in sync with store without re-running effect
  useEffect(() => {
    return useStore.subscribe(
      (state) => state.detections,
      (dets) => { detsRef.current = dets || [] }
    )
  }, [])

  // ResizeObserver: keep canvas pixel dims matched to container
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      canvas.width  = Math.max(1, Math.floor(width))
      canvas.height = Math.max(1, Math.floor(height))
    })
    ro.observe(parent)
    canvas.width  = parent.offsetWidth  || 400
    canvas.height = parent.offsetHeight || 400
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let ws, rafId, dead = false
    let lastFlush  = performance.now()
    let flushCount = 0

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
          flushCount++
          if (flushCount >= 10) {
            const now = performance.now()
            setHz(Math.round(10000 / Math.max(1, now - lastFlush)))
            lastFlush  = now
            flushCount = 0
          }
        } catch (_) {}
      }
    }

    function draw() {
      const canvas = canvasRef.current
      if (!canvas) { rafId = requestAnimationFrame(draw); return }
      const ctx   = canvas.getContext('2d')
      const W = canvas.width, H = canvas.height
      if (!W || !H) { rafId = requestAnimationFrame(draw); return }
      const cx = W / 2, cy = H / 2
      const scale = Math.min(W, H) / (range * 2)

      // Background
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, W, H)

      // Grid
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
      ctx.beginPath()
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
      ctx.moveTo(0, cy); ctx.lineTo(W, cy)
      ctx.stroke()

      // Safety rings (dashed)
      const rings = [
        { r: 1.2, fill: 'rgba(22,163,74,0.15)',  line: '#16A34A' },
        { r: 0.6, fill: 'rgba(217,119,6,0.25)',  line: '#D97706' },
        { r: 0.3, fill: 'rgba(220,38,38,0.30)',  line: '#DC2626' },
      ]
      for (const ring of rings) {
        const rr = ring.r * scale
        if (rr < 2) continue
        ctx.save()
        ctx.setLineDash([4, 3])
        ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2)
        ctx.fillStyle   = ring.fill; ctx.fill()
        ctx.strokeStyle = ring.line; ctx.lineWidth = 1; ctx.stroke()
        ctx.restore()
      }

      // Points — support both array [x,y,z,i] and object {x,y,z}
      const pts = ptsRef.current
      for (let k = 0; k < pts.length; k++) {
        const p  = pts[k]
        const px = Array.isArray(p) ? p[0] : p.x
        const pz = Array.isArray(p) ? p[1] : p.z   // forward axis
        const py = Array.isArray(p) ? p[2] : p.y   // height
        const sx = cx + px * scale
        const sy = cy - pz * scale                  // top-down: forward=up
        if (sx < 0 || sx > W || sy < 0 || sy > H) continue

        let r, g, b
        const h = py ?? 0
        if      (h < 0.1) { r = 180; g = 200; b = 240 }
        else if (h < 0.5) { r = 100; g = 200; b = 150 }
        else if (h < 1.0) { r = 240; g = 180; b =  60 }
        else               { r = 220; g =  80; b =  80 }

        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(sx - 1, sy - 1, 2, 2)
      }

      // Detection object overlays
      const dets = detsRef.current
      for (const det of dets) {
        const pos = det.pos_3d || det.position
        if (!pos || pos.length < 3) continue
        const [dx, , dz] = pos   // top-down: x=lateral, z=forward
        const ox = cx + dx * scale
        const oy = cy - dz * scale
        if (ox < 0 || ox > W || oy < 0 || oy > H) continue
        const cls   = det.class_name || 'object'
        const color = cls === 'person' ? '#DC2626' : '#2563EB'
        ctx.save()
        ctx.beginPath(); ctx.arc(ox, oy, 5, 0, Math.PI * 2)
        ctx.fillStyle = color + '33'; ctx.fill()
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
        ctx.fillStyle = color
        ctx.font = `${Math.max(8, Math.floor(W * 0.022))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(cls[0].toUpperCase(), ox, oy + 3)
        ctx.restore()
      }

      // Robot origin
      ctx.fillStyle = '#2563EB'
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill()

      // North label
      ctx.fillStyle   = '#6B7280'
      ctx.font        = `${Math.max(9, Math.floor(W * 0.025))}px sans-serif`
      ctx.textAlign   = 'center'
      ctx.fillText('N', cx, 10)

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
        }}>LiDAR</span>

        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          {ptCount.toLocaleString()} pts
        </span>

        {hz > 0 && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
            {hz} Hz
          </span>
        )}

        {/* Range selector */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
          {[6, 12, 25].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 5,
                border:     range === r ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: range === r ? 'var(--accent-dim)'       : 'transparent',
                color:      range === r ? 'var(--accent)'           : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {r}m
            </button>
          ))}
        </div>

        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
          background: live ? 'var(--green-dim)'   : 'var(--bg-surface)',
          color:      live ? 'var(--green)'       : 'var(--text-muted)',
        }}>
          {live ? 'LIVE' : 'SIM'}
        </span>
      </div>

      {/* Canvas */}
      <div style={{
        flex: 1, minHeight: 0, position: 'relative',
        background: 'var(--bg-app)',
      }}>
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        />
        {!live && (
          <div style={{
            position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
            fontSize: 9, color: 'var(--text-muted)',
            background: 'rgba(255,255,255,0.85)', padding: '2px 8px', borderRadius: 6,
            pointerEvents: 'none',
          }}>
            simulation
          </div>
        )}
      </div>
    </div>
  )
}
