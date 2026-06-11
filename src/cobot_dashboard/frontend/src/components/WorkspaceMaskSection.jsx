import { useEffect, useRef, useState } from 'react'

// Top-down 2D editor for the LiDAR workspace polygon. Coordinates are
// metres in the base_link XY plane. Range fixed at ±3 m to match the
// identifier's workspace crop defaults.
const SIZE = 360
const HALF_M = 3.0

function metresToPx(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2
  // Three.js style: x → right, y → up on the canvas.
  return [cx + (x / HALF_M) * (SIZE / 2 - 10),
          cy - (y / HALF_M) * (SIZE / 2 - 10)]
}

function pxToMetres(px, py) {
  const cx = SIZE / 2, cy = SIZE / 2
  return [(px - cx) / (SIZE / 2 - 10) * HALF_M,
          -(py - cy) / (SIZE / 2 - 10) * HALF_M]
}

export default function WorkspaceMaskSection() {
  const [polygon, setPolygon] = useState([])
  const [objects, setObjects] = useState([])
  const [drag, setDrag] = useState(null) // {index, startXY}
  const [toast, setToast] = useState(null)
  const svgRef = useRef(null)

  useEffect(() => { load() }, [])

  function flash(msg, ok = true) {
    setToast({ ok, msg })
    setTimeout(() => setToast(null), 2500)
  }

  async function load() {
    try {
      const j = await fetch('/api/lidar_workspace_mask').then((r) => r.json())
      setPolygon(j.polygon || [])
    } catch {
      setPolygon([])
    }
    try {
      const j = await fetch('/api/lidar_objects/identified').then((r) => r.json())
      setObjects(j.objects || [])
    } catch {}
  }

  function addVertexAt(e) {
    if (drag) return
    const rect = svgRef.current.getBoundingClientRect()
    const [mx, my] = pxToMetres(e.clientX - rect.left, e.clientY - rect.top)
    setPolygon([...polygon, [mx, my]])
  }

  function startDrag(i, e) {
    e.stopPropagation()
    setDrag({ index: i })
  }

  function onMouseMove(e) {
    if (!drag) return
    const rect = svgRef.current.getBoundingClientRect()
    const [mx, my] = pxToMetres(e.clientX - rect.left, e.clientY - rect.top)
    const next = polygon.slice()
    next[drag.index] = [mx, my]
    setPolygon(next)
  }

  function endDrag() {
    setDrag(null)
  }

  function removeVertex(i, e) {
    e.preventDefault()
    e.stopPropagation()
    setPolygon(polygon.filter((_, idx) => idx !== i))
  }

  async function save() {
    if (polygon.length < 3) {
      flash('Need at least 3 vertices to save a polygon', false)
      return
    }
    const r = await fetch('/api/lidar_workspace_mask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ polygon }),
    })
    const j = await r.json()
    flash(j.ok ? 'Workspace mask saved' : (j.error || 'save failed'), !!j.ok)
  }

  async function clearAll() {
    setPolygon([])
  }

  async function disableMask() {
    if (!confirm('Disable workspace mask? The identifier will analyze the entire workspace.')) return
    const r = await fetch('/api/lidar_workspace_mask/clear', { method: 'POST' })
    const j = await r.json()
    if (j.ok) {
      setPolygon([])
      flash('Workspace mask disabled (full workspace in use)')
    } else {
      flash(j.error || 'clear failed', false)
    }
  }

  const pathD = polygon.length
    ? polygon.map((v, i) => {
        const [px, py] = metresToPx(v[0], v[1])
        return `${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`
      }).join(' ') + (polygon.length >= 3 ? ' Z' : '')
    : ''

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        paddingBottom: 8, borderBottom: '1px solid var(--border)',
      }}>
        Workspace Mask
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Define the region where parts are expected on the LiDAR ground plane.
        Identifications outside the polygon are ignored — useful for excluding
        walls, equipment frames, and operator stations.
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <svg
          ref={svgRef}
          width={SIZE} height={SIZE}
          style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)',
                   borderRadius: 'var(--radius-sm)', cursor: 'crosshair' }}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onClick={addVertexAt}
        >
          <line x1={0} y1={SIZE / 2} x2={SIZE} y2={SIZE / 2}
                stroke="var(--text-muted)" strokeDasharray="3 3" opacity={0.3} />
          <line x1={SIZE / 2} y1={0} x2={SIZE / 2} y2={SIZE}
                stroke="var(--text-muted)" strokeDasharray="3 3" opacity={0.3} />
          {[1, 2].map((r) => (
            <circle key={r} cx={SIZE / 2} cy={SIZE / 2}
                    r={(r / HALF_M) * (SIZE / 2 - 10)}
                    fill="none" stroke="var(--text-muted)"
                    strokeDasharray="2 4" opacity={0.25} />
          ))}
          {pathD && (
            <path d={pathD} fill="#22C55E25" stroke="#22C55E" strokeWidth={2} />
          )}
          {polygon.map((v, i) => {
            const [px, py] = metresToPx(v[0], v[1])
            return (
              <g key={i}>
                <circle cx={px} cy={py} r={6}
                        fill="#22C55E"
                        onMouseDown={(e) => startDrag(i, e)}
                        onContextMenu={(e) => removeVertex(i, e)}
                        style={{ cursor: 'move' }} />
                <text x={px + 8} y={py - 8} fontSize={9}
                      fill="var(--text-secondary)" fontFamily="monospace">
                  {v[0].toFixed(2)}, {v[1].toFixed(2)}
                </text>
              </g>
            )
          })}
          {objects.map((o, i) => {
            const [px, py] = metresToPx(o.center.x, o.center.y)
            return (
              <g key={`o-${i}`} pointerEvents="none">
                <circle cx={px} cy={py} r={4}
                        fill={o.confidence >= 0.8 ? '#22C55E' :
                              o.confidence >= 0.5 ? '#F59E0B' : '#9CA3AF'}
                        opacity={0.85} />
              </g>
            )
          })}
        </svg>
        <div style={{
          fontSize: 11, color: 'var(--text-secondary)', maxWidth: 280,
          lineHeight: 1.5,
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.06em',
                        marginBottom: 4 }}>
            Controls
          </div>
          Left-click empty space to add a vertex.<br />
          Drag a vertex to move it.<br />
          Right-click a vertex to delete.<br />
          Coloured dots show current identified objects (green &gt;0.8, amber &gt;0.5).
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={save} style={{
          background: 'var(--accent)', border: 'none', color: '#fff',
          padding: '6px 14px', fontSize: 12, borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}>Save</button>
        <button onClick={clearAll} style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          color: 'var(--text-secondary)',
          padding: '6px 14px', fontSize: 12, borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}>Clear Vertices</button>
        <button onClick={disableMask} style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          color: 'var(--text-secondary)',
          padding: '6px 14px', fontSize: 12, borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}>Use Full Workspace</button>
        <button onClick={load} style={{
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          color: 'var(--text-secondary)',
          padding: '6px 14px', fontSize: 12, borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}>Reload</button>
      </div>
      {toast && (
        <div style={{
          background: toast.ok ? '#0E3D24' : '#3D1414',
          border: `1px solid ${toast.ok ? '#22C55E' : '#EF4444'}`,
          color: toast.ok ? '#86EFAC' : '#FCA5A5',
          padding: '6px 10px', borderRadius: 'var(--radius-sm)',
          fontSize: 11,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
