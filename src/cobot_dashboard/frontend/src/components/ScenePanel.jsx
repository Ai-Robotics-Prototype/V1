import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'

const MAX_PTS   = 60000   // larger buffer for full scene view
const OBJ_COLORS = {
  bottle:'#2563EB', box:'#16A34A', person:'#DC2626',
  cup:'#D97706', chair:'#7C3AED', default:'#0EA5E9',
}

export default function ScenePanel() {
  const canvasRef  = useRef(null)
  const accumRef   = useRef([])
  const objsRef    = useRef([])
  const meshRef    = useRef({ tris: [], dirty: false, clear: false })
  const [live,     setLive]   = useState(false)
  const [ptCount,  setPtCnt]  = useState(0)
  const [hz,       setHz]     = useState(0)
  const [range,    setRange]  = useState(12)
  const [stats,    setStats]  = useState({ min_h: 0, max_h: 0, spread: 0 })
  const [meshInfo, setMeshInfo] = useState({ verts: 0, tris: 0, active: false })

  const sceneObjects = useStore((s) => s.sceneGraph?.objects ?? [])
  const perception   = useStore((s) => s.perception)
  const detections   = useStore((s) => s.detections ?? [])

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
    canvas.width  = parent.offsetWidth  || 800
    canvas.height = parent.offsetHeight || 600
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

          // ── nvblox mesh update ─────────────────────────────────────────────
          if (d.type === 'mesh') {
            const m = meshRef.current
            if (d.clear) m.tris = []
            for (const block of (d.blocks || [])) {
              const verts = block.v   // [[x,y,z],...]
              const faces = block.f   // [[i,j,k],...]
              const colors = block.c  // [[r,g,b],...] or []
              for (let fi = 0; fi < faces.length; fi++) {
                const [i, j, k] = faces[fi]
                if (i >= verts.length || j >= verts.length || k >= verts.length) continue
                const c = colors && colors[i] ? colors[i] : null
                m.tris.push({
                  ax: verts[i][0], az: verts[i][2],
                  bx: verts[j][0], bz: verts[j][2],
                  cx: verts[k][0], cz: verts[k][2],
                  h:  (verts[i][1] + verts[j][1] + verts[k][1]) / 3,
                  r: c ? Math.round(c[0] * 255) : null,
                  g: c ? Math.round(c[1] * 255) : null,
                  b: c ? Math.round(c[2] * 255) : null,
                })
              }
            }
            // Cap mesh buffer to avoid memory explosion
            if (m.tris.length > 80000) m.tris = m.tris.slice(-80000)
            m.dirty = true
            setMeshInfo({ verts: d.total_verts, tris: d.total_tris, active: true })
            return
          }

          // ── point cloud update ─────────────────────────────────────────────
          const incoming = d.points || []
          const acc = accumRef.current
          for (const p of incoming) acc.push(p)
          if (acc.length > MAX_PTS) acc.splice(0, acc.length - MAX_PTS)
          accumRef.current = acc
          setPtCnt(acc.length)

          if (incoming.length > 10) {
            let minH = Infinity, maxH = -Infinity
            for (const p of incoming) {
              const h = Array.isArray(p) ? p[2] : (p.y ?? 0)
              if (h < minH) minH = h
              if (h > maxH) maxH = h
            }
            setStats({
              min_h: Math.round(minH * 100) / 100,
              max_h: Math.round(maxH * 100) / 100,
              spread: Math.round((maxH - minH) * 100) / 100,
            })
          }

          flushCount++
          if (flushCount >= 10) {
            const now = performance.now()
            setHz(Math.round(10000 / Math.max(1, now - lastFlush)))
            lastFlush = now; flushCount = 0
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

      ctx.fillStyle = '#F9FAFB'
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
      // Meter labels
      ctx.fillStyle = '#9CA3AF'
      ctx.font      = '10px sans-serif'
      ctx.textAlign = 'center'
      for (let m = 1; m <= range; m++) {
        const gx = m * scale
        ctx.fillText(`${m}m`, cx + gx, cy + 12)
      }
      // Crosshair
      ctx.strokeStyle = '#D1D5DB'
      ctx.beginPath()
      ctx.moveTo(cx, 0); ctx.lineTo(cx, H)
      ctx.moveTo(0, cy); ctx.lineTo(W, cy)
      ctx.stroke()

      // Safety rings
      const rings = [
        { r: 1.2, fill: 'rgba(22,163,74,0.08)',  line: '#16A34A', label: '1.2m' },
        { r: 0.6, fill: 'rgba(217,119,6,0.15)',  line: '#D97706', label: '0.6m' },
        { r: 0.3, fill: 'rgba(220,38,38,0.20)',  line: '#DC2626', label: '0.3m' },
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
        if (rr > 16) {
          ctx.fillStyle = ring.line
          ctx.font = '9px sans-serif'
          ctx.textAlign = 'left'
          ctx.fillText(ring.label, cx + rr + 3, cy - 3)
        }
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
        if      (h < 0.1) { r = 148; g = 173; b = 220 }
        else if (h < 0.5) { r =  60; g = 175; b = 120 }
        else if (h < 1.0) { r = 220; g = 155; b =  35 }
        else               { r = 205; g =  60; b =  60 }

        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(sx - 1, sy - 1, 2, 2)
      }

      // ── nvblox mesh triangles (top-down projection, x-z plane) ─────────────
      const mesh = meshRef.current
      if (mesh.tris.length > 0) {
        ctx.save()
        ctx.globalAlpha = 0.45
        for (const t of mesh.tris) {
          // Height → color (same palette as point cloud)
          let r, g, b
          const h = t.h
          if (t.r !== null) { r = t.r; g = t.g; b = t.b }
          else if (h < 0.1) { r = 148; g = 173; b = 220 }
          else if (h < 0.5) { r =  60; g = 175; b = 120 }
          else if (h < 1.0) { r = 220; g = 155; b =  35 }
          else               { r = 205; g =  60; b =  60 }
          ctx.fillStyle   = `rgb(${r},${g},${b})`
          ctx.strokeStyle = `rgba(${r},${g},${b},0.3)`
          ctx.lineWidth   = 0.5
          ctx.beginPath()
          ctx.moveTo(cx + t.ax * scale, cy - t.az * scale)
          ctx.lineTo(cx + t.bx * scale, cy - t.bz * scale)
          ctx.lineTo(cx + t.cx * scale, cy - t.cz * scale)
          ctx.closePath()
          ctx.fill()
          ctx.stroke()
        }
        ctx.restore()
      }

      // Detection overlays
      for (const det of detections) {
        const pos = det.pos_3d || det.position
        if (!pos || pos.length < 3) continue
        const [dx, , dz] = pos
        const ox = cx + dx * scale, oy = cy - dz * scale
        if (ox < 0 || ox > W || oy < 0 || oy > H) continue
        const cls   = det.class_name || 'object'
        const color = cls === 'person' ? '#DC2626' : '#2563EB'
        ctx.save()
        ctx.beginPath(); ctx.arc(ox, oy, 6, 0, Math.PI * 2)
        ctx.fillStyle = color + '44'; ctx.fill()
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke()
        ctx.restore()
      }

      // Robot origin
      ctx.fillStyle = '#2563EB'
      ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#2563EB'
      ctx.font = 'bold 9px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText('ROBOT', cx, cy - 10)

      // Scene graph objects — larger labels in scene view
      for (const obj of objsRef.current || []) {
        const pos = obj.position
        if (!Array.isArray(pos) || pos.length < 3) continue
        const [ox_m, , oz_m] = pos
        const sx = cx + ox_m * scale, sy = cy - oz_m * scale
        if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) continue
        const cls   = obj.class_name || 'object'
        const color = OBJ_COLORS[cls] || OBJ_COLORS.default
        const conf  = obj.score != null ? Math.round(obj.score * 100) : null

        ctx.save()
        if (cls === 'person') {
          const pulse = 0.75 + 0.25 * Math.sin(Date.now() * 0.004)
          ctx.globalAlpha = pulse
          ctx.fillStyle = color
          ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()
        } else {
          const sz = 12
          ctx.fillStyle = color
          ctx.fillRect(sx - sz/2, sy - sz/2, sz, sz)
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
          ctx.strokeRect(sx - sz/2, sy - sz/2, sz, sz)
        }

        const labelText = conf ? `${cls} ${conf}%` : cls
        ctx.font = 'bold 10px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        const tw = ctx.measureText(labelText).width
        ctx.fillStyle = 'rgba(0,0,0,0.72)'
        ctx.fillRect(sx - tw/2 - 3, sy - 24, tw + 6, 14)
        ctx.fillStyle = color
        ctx.fillText(labelText, sx, sy - 11)

        // Position text
        ctx.font = '8px sans-serif'
        ctx.fillStyle = 'rgba(0,0,0,0.5)'
        ctx.fillText(
          `(${ox_m.toFixed(2)}, ${oz_m.toFixed(2)})`,
          sx, sy + 20
        )
        ctx.restore()
      }

      // North label
      ctx.fillStyle = '#6B7280'
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText('N', cx, 14)

      // Offline watermark
      if (!live || pts.length < 10) {
        ctx.save()
        ctx.font = `bold ${Math.floor(W * 0.04)}px sans-serif`
        ctx.fillStyle = 'rgba(160,160,160,0.35)'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('AWAITING LIDAR DATA', W / 2, H / 2 + 50)
        ctx.restore()
      }

      rafId = requestAnimationFrame(draw)
    }

    connect()
    draw()
    return () => { dead = true; cancelAnimationFrame(rafId); if (ws) ws.close() }
  }, [range])

  const clearMap = () => {
    accumRef.current = []
    meshRef.current = { tris: [], dirty: false, clear: false }
    setPtCnt(0)
    setMeshInfo({ verts: 0, tris: 0, active: false })
  }

  return (
    <div style={{
      display: 'flex', height: '100%', gap: 8, padding: 8, overflow: 'hidden',
    }}>
      {/* Main canvas */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        background: 'var(--bg-panel)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', overflow: 'hidden',
      }}>
        {/* Canvas header */}
        <div style={{
          padding: '5px 10px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
            textTransform: 'uppercase', color: 'var(--text-muted)',
          }}>Reconstructed Scene</span>

          <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {ptCount.toLocaleString()} pts accumulated
          </span>
          {hz > 0 && (
            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{hz} Hz</span>
          )}
          {sceneObjects.length > 0 && (
            <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 600 }}>
              · {sceneObjects.length} tracked
            </span>
          )}
          {meshInfo.active && (
            <span style={{ fontSize: 9, color: '#7C3AED', fontWeight: 600 }}>
              · mesh {(meshInfo.verts / 1000).toFixed(1)}k v / {(meshInfo.tris / 1000).toFixed(1)}k t
            </span>
          )}

          <button onClick={clearMap} style={{
            fontSize: 9, padding: '2px 7px', borderRadius: 4,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}>
            Clear
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
            {[6, 12, 25, 50].map((r) => (
              <button key={r} onClick={() => setRange(r)} style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 5,
                border:     range === r ? '1px solid var(--accent)' : '1px solid var(--border)',
                background: range === r ? 'var(--accent-dim)'       : 'transparent',
                color:      range === r ? 'var(--accent)'           : 'var(--text-muted)',
                cursor: 'pointer',
              }}>{r}m</button>
            ))}
          </div>

          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
            background: live ? 'var(--green-dim)' : 'var(--bg-surface)',
            color:      live ? 'var(--green)'     : 'var(--text-muted)',
          }}>
            {live ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>

        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <canvas ref={canvasRef} style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block',
          }} />
        </div>
      </div>

      {/* Right sidebar: scene graph + height legend */}
      <div style={{
        width: 220, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0,
      }}>
        {/* Height legend */}
        <div style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '8px 10px',
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
            textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8,
          }}>Height Colormap</div>
          {[
            { color: 'rgb(148,173,220)', label: '< 10 cm — floor' },
            { color: 'rgb(60,175,120)',  label: '10–50 cm — low' },
            { color: 'rgb(220,155,35)',  label: '50–100 cm — mid' },
            { color: 'rgb(205,60,60)',   label: '> 100 cm — high' },
          ].map((row) => (
            <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{ width: 12, height: 12, borderRadius: 2, background: row.color, flexShrink: 0 }} />
              <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{row.label}</span>
            </div>
          ))}
          {stats.spread > 0 && (
            <div style={{ marginTop: 6, fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              h: {stats.min_h}m – {stats.max_h}m
            </div>
          )}
        </div>

        {/* Scene graph objects */}
        <div style={{
          flex: 1, background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '5px 10px', borderBottom: '1px solid var(--border)',
            fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
            textTransform: 'uppercase', color: 'var(--text-muted)', flexShrink: 0,
          }}>
            Tracked Objects
            <span style={{
              marginLeft: 6, fontWeight: 400, color: 'var(--accent)',
            }}>{sceneObjects.length}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
            {sceneObjects.length === 0 ? (
              <div style={{ padding: 12, textAlign: 'center', fontSize: 10, color: 'var(--text-muted)' }}>
                No tracked objects
              </div>
            ) : sceneObjects.map((obj, i) => {
              const pos   = obj.position || [0, 0, 0]
              const cls   = obj.class_name || 'object'
              const conf  = obj.score != null ? Math.round(obj.score * 100) : null
              const color = OBJ_COLORS[cls] || OBJ_COLORS.default
              const dist  = Math.sqrt(pos[0] ** 2 + pos[2] ** 2)
              return (
                <div key={obj.id ?? i} style={{
                  padding: '5px 7px', marginBottom: 4,
                  background: 'var(--bg-surface)', borderRadius: 5,
                  borderLeft: `3px solid ${color}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color, flex: 1 }}>{cls}</span>
                    {conf !== null && (
                      <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>{conf}%</span>
                    )}
                    <span style={{
                      fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
                    }}>{dist.toFixed(2)}m</span>
                  </div>
                  <div style={{ fontSize: 8, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginTop: 2 }}>
                    x={pos[0]?.toFixed(2)} y={pos[1]?.toFixed(2)} z={pos[2]?.toFixed(2)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Perception stats */}
        <div style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '8px 10px',
        }}>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
            textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6,
          }}>Detector</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[
              { label: 'FPS',     value: (perception?.fps ?? 0).toFixed(1)   },
              { label: 'INF',     value: `${(perception?.inference_ms ?? 0).toFixed(0)}ms` },
              { label: 'DETS',    value: perception?.det_count ?? 0           },
              { label: 'TRACKS',  value: perception?.tracker_count ?? 0      },
            ].map((s) => (
              <div key={s.label} style={{
                flex: 1, minWidth: 45,
                background: 'var(--bg-surface)', borderRadius: 5, padding: '4px 6px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 8, color: 'var(--text-muted)' }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
