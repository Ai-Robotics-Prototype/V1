import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'

const MAX_ACCUMULATED = 15000

export default function LidarPanel() {
  const canvasRef  = useRef(null)
  const accumRef   = useRef([])   // accumulated ring-buffer of all received points
  const detsRef    = useRef([])
  const objsRef    = useRef([])
  const sparseRef  = useRef(false) // true when last batch was < 50 pts (motor offline)
  const [live,     setLive]  = useState(false)
  const [ptCount,  setPtCnt] = useState(0)
  const [hz,       setHz]    = useState(0)
  const [range,    setRange] = useState(6)

  const sceneObjects = useStore((s) => s.sceneGraph?.objects ?? [])

  useEffect(() => {
    return useStore.subscribe(
      (state) => state.detections,
      (dets) => { detsRef.current = dets || [] }
    )
  }, [])

  useEffect(() => { objsRef.current = sceneObjects }, [sceneObjects])

  // ResizeObserver
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
          const incoming = JSON.parse(data).points || []
          sparseRef.current = incoming.length < 50

          // Accumulate into ring buffer — skip near-duplicate positions
          const acc = accumRef.current
          for (const p of incoming) {
            acc.push(p)
          }
          // Trim oldest when buffer exceeds max
          if (acc.length > MAX_ACCUMULATED) {
            acc.splice(0, acc.length - MAX_ACCUMULATED)
          }
          accumRef.current = acc
          setPtCnt(acc.length)

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
      const ctx = canvas.getContext('2d')
      const W = canvas.width, H = canvas.height
      if (!W || !H) { rafId = requestAnimationFrame(draw); return }
      const cx = W / 2, cy = H / 2
      const scale = Math.min(W, H) / (range * 2)

      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, W, H)

      // Grid lines
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
      ctx.strokeStyle = '#D1D5DB'
      ctx.beginPath()
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
      ctx.moveTo(0, cy); ctx.lineTo(W, cy)
      ctx.stroke()

      // Safety rings
      const rings = [
        { r: 1.2, fill: 'rgba(22,163,74,0.12)',  line: '#16A34A' },
        { r: 0.6, fill: 'rgba(217,119,6,0.20)',  line: '#D97706' },
        { r: 0.3, fill: 'rgba(220,38,38,0.25)',  line: '#DC2626' },
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

      // Accumulated point cloud
      const pts = accumRef.current
      for (let k = 0; k < pts.length; k++) {
        const p  = pts[k]
        const px = Array.isArray(p) ? p[0] : p.x
        const pz = Array.isArray(p) ? p[1] : p.z
        const py = Array.isArray(p) ? p[2] : p.y
        const sx = cx + px * scale
        const sy = cy - pz * scale
        if (sx < 0 || sx > W || sy < 0 || sy > H) continue

        let r, g, b
        const h = py ?? 0
        if      (h < 0.1) { r = 160; g = 185; b = 230 }
        else if (h < 0.5) { r =  80; g = 185; b = 135 }
        else if (h < 1.0) { r = 230; g = 165; b =  45 }
        else               { r = 210; g =  70; b =  70 }

        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(sx - 1, sy - 1, 2, 2)
      }

      // Detection overlays
      const dets = detsRef.current
      for (const det of dets) {
        const pos = det.pos_3d || det.position
        if (!pos || pos.length < 3) continue
        const [dx, , dz] = pos
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

      // Scene graph objects
      const OBJ_COLORS = {
        bottle:'#2563EB', box:'#16A34A', person:'#DC2626',
        cup:'#D97706', chair:'#7C3AED', default:'#0EA5E9',
      }
      for (const obj of objsRef.current || []) {
        const pos = obj.position
        if (!Array.isArray(pos) || pos.length < 3) continue
        const [ox_m, , oz_m] = pos
        const sx = cx + ox_m * scale
        const sy = cy - oz_m * scale
        if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue
        const cls   = obj.class_name || 'object'
        const color = OBJ_COLORS[cls] || OBJ_COLORS.default
        const conf  = obj.score != null ? Math.round(obj.score * 100) : null
        ctx.save()
        if (cls === 'person') {
          const pulse = 0.7 + 0.3 * Math.sin(Date.now() * 0.004)
          ctx.globalAlpha = pulse
          ctx.fillStyle = color
          ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
        } else {
          const sz = 9
          ctx.fillStyle = color
          ctx.fillRect(sx - sz/2, sy - sz/2, sz, sz)
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1
          ctx.strokeRect(sx - sz/2, sy - sz/2, sz, sz)
        }
        const labelText = conf ? `${cls} ${conf}%` : cls
        ctx.font = 'bold 9px sans-serif'
        ctx.textAlign = 'center'
        const tw = ctx.measureText(labelText).width
        ctx.fillStyle = 'rgba(0,0,0,0.65)'
        ctx.fillRect(sx - tw/2 - 2, sy - 20, tw + 4, 13)
        ctx.fillStyle = color
        ctx.textBaseline = 'bottom'
        ctx.fillText(labelText, sx, sy - 8)
        ctx.restore()
      }

      // North label
      ctx.fillStyle   = '#6B7280'
      ctx.font        = `${Math.max(9, Math.floor(W * 0.025))}px sans-serif`
      ctx.textAlign   = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText('N', cx, 10)

      // Motor-offline watermark
      if (sparseRef.current && accumRef.current.length < 200) {
        ctx.save()
        ctx.font = `bold ${Math.floor(W * 0.05)}px sans-serif`
        ctx.fillStyle = 'rgba(180,180,180,0.5)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('LiDAR OFFLINE', W / 2, H / 2 + 40)
        ctx.restore()
      }

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
        {sceneObjects.length > 0 && (
          <span style={{ fontSize: 9, color: 'var(--accent)' }}>
            · {sceneObjects.length} obj{sceneObjects.length !== 1 ? 's' : ''}
          </span>
        )}
        {hz > 0 && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
            {hz} Hz
          </span>
        )}

        <button
          onClick={() => { accumRef.current = []; setPtCnt(0) }}
          style={{
            fontSize: 9, padding: '2px 6px', borderRadius: 4,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}
          title="Clear accumulated map"
        >
          CLR
        </button>

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
          {live ? 'LIVE' : 'OFFLINE'}
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
            connecting…
          </div>
        )}
      </div>
    </div>
  )
}
