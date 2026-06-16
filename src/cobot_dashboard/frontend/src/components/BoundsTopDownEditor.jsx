import { useEffect, useMemo, useRef, useState, useCallback } from 'react'

// ─────────────────────────────────────────────────────────────────────────
// Robot-reach + shape constants
// ─────────────────────────────────────────────────────────────────────────

// Estun S10-140: 1400mm horizontal reach (SR 1400 in the manual).
const REACH_RADIUS_M = 1.4

// 480px square SVG that maps ±2 m of world space (240 px/m / 2 = 120 px/m).
// Keeps the 1.4 m reach circle visible AND lets the box clearly exceed it
// when the operator drags it out, so the red warning is obvious.
const SVG_SIZE_PX = 480
const VIEW_EXTENT_M = 2.0
const PX_PER_M = (SVG_SIZE_PX / 2) / VIEW_EXTENT_M   // = 120

// World → SVG. LiDAR frame: +X is forward, +Y is left. Screen: up = +X,
// left = +Y. So (svg_x, svg_y) = (cx − wy·s, cy − wx·s).
const CENTER_PX = SVG_SIZE_PX / 2
function worldToSvg(wx, wy) {
  return [CENTER_PX - wy * PX_PER_M, CENTER_PX - wx * PX_PER_M]
}
function svgToWorld(sx, sy) {
  return [(CENTER_PX - sy) / PX_PER_M, (CENTER_PX - sx) / PX_PER_M]
}

// Height ramp identical to the live LidarPanel preview so the operator's
// mental model stays consistent across views.
function heightColor(z) {
  if (z < 0.1) return '#264ec9'
  if (z < 0.5) return '#24b27d'
  if (z < 1.0) return '#d8b919'
  return         '#d44025'
}

// ─────────────────────────────────────────────────────────────────────────
// Bounds shape — backward compat
// ─────────────────────────────────────────────────────────────────────────
// New shape (canonical):
//   { center: {x,y}, size: {x,y}, z_min, z_max, yaw_deg }
// Old shape (still in older profiles):
//   { x_min, x_max, y_min, y_max, z_min, z_max }
// Saving emits BOTH shapes so legacy readers (3D wireframe boxes, dashboard
// renderers) still get a usable AABB.

export function normalizeBounds(b) {
  if (b && b.center && b.size) {
    return {
      center: { x: Number(b.center.x) || 0, y: Number(b.center.y) || 0 },
      size:   { x: Number(b.size.x)   || 0.8, y: Number(b.size.y)   || 0.8 },
      z_min:  Number(b.z_min) || 0,
      z_max:  (b.z_max == null) ? 0.8 : Number(b.z_max),
      yaw_deg: Number(b.yaw_deg) || 0,
    }
  }
  const xmin = (b && b.x_min != null) ? Number(b.x_min) : -0.6
  const xmax = (b && b.x_max != null) ? Number(b.x_max) :  0.6
  const ymin = (b && b.y_min != null) ? Number(b.y_min) : -0.6
  const ymax = (b && b.y_max != null) ? Number(b.y_max) :  0.6
  return {
    center: { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2 },
    size:   { x: xmax - xmin,       y: ymax - ymin       },
    z_min:  (b && b.z_min != null) ? Number(b.z_min) : 0,
    z_max:  (b && b.z_max != null) ? Number(b.z_max) : 0.8,
    yaw_deg: 0,
  }
}

// Compute the four world-space corners of the rotated box.
// Order: [NE, NW, SW, SE] in box-local frame (+x forward, +y left).
function boxCorners(b) {
  const { center, size, yaw_deg } = b
  const yaw = (yaw_deg || 0) * Math.PI / 180
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw)
  const hx = size.x / 2, hy = size.y / 2
  const local = [
    [+hx, +hy], [+hx, -hy], [-hx, -hy], [-hx, +hy],
  ]
  return local.map(([lx, ly]) => ({
    x: center.x + (lx * cosY - ly * sinY),
    y: center.y + (lx * sinY + ly * cosY),
  }))
}

// Emit both new and AABB-flat forms for saving.
export function serializeBounds(b) {
  const corners = boxCorners(b)
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  return {
    center:  { x: b.center.x, y: b.center.y },
    size:    { x: b.size.x, y: b.size.y },
    z_min:   b.z_min,
    z_max:   b.z_max,
    yaw_deg: b.yaw_deg,
    // axis-aligned bbox of the rotated box — for legacy consumers
    x_min:   Math.min(...xs), x_max: Math.max(...xs),
    y_min:   Math.min(...ys), y_max: Math.max(...ys),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

const HANDLE_R = 7
const ROT_HANDLE_OFFSET_M = 0.18

function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by
  return Math.sqrt(dx * dx + dy * dy)
}

export default function BoundsTopDownEditor({ cellId, value, onChange, height = 480 }) {
  const bounds = useMemo(() => normalizeBounds(value), [value])
  const [cloud, setCloud]       = useState(null)
  const [cloudErr, setCloudErr] = useState(null)
  const svgRef = useRef(null)
  const [dragging, setDragging] = useState(null)

  // ── Fetch baseline cloud once per cell ─────────────────────────────
  useEffect(() => {
    if (!cellId) { setCloud(null); return }
    let alive = true
    setCloud(null); setCloudErr(null)
    fetch(`/api/cells/${cellId}/baseline/cloud?max_points=30000`)
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error || `HTTP ${r.status}`)
        }
        const j = await r.json()
        if (alive) setCloud(j)
      })
      .catch((e) => { if (alive) setCloudErr(String(e.message || e)) })
    return () => { alive = false }
  }, [cellId])

  // ── Derived ────────────────────────────────────────────────────────
  const corners = useMemo(() => boxCorners(bounds), [bounds])
  const reachExceeded = useMemo(() =>
    corners.map((c) => dist(c.x, c.y, 0, 0) > REACH_RADIUS_M + 0.005),
    [corners],
  )
  const anyExceed = reachExceeded.some((x) => x)

  // ── Drag handlers ──────────────────────────────────────────────────
  const mouseWorld = (ev) => {
    const rect = svgRef.current.getBoundingClientRect()
    const sx = (ev.clientX - rect.left) * (SVG_SIZE_PX / rect.width)
    const sy = (ev.clientY - rect.top)  * (SVG_SIZE_PX / rect.height)
    const [wx, wy] = svgToWorld(sx, sy)
    return { wx, wy, sx, sy }
  }

  const beginDrag = (mode, ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    const start = mouseWorld(ev)
    setDragging({ mode, startBounds: bounds, start })
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (ev) => {
      const rect = svgRef.current.getBoundingClientRect()
      const sx = (ev.clientX - rect.left) * (SVG_SIZE_PX / rect.width)
      const sy = (ev.clientY - rect.top)  * (SVG_SIZE_PX / rect.height)
      const [wx, wy] = svgToWorld(sx, sy)
      const next = applyDrag(dragging, wx, wy)
      if (next) onChange?.(next)
    }
    const onUp = () => setDragging(null)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, onChange])

  // ── Numeric input handlers ─────────────────────────────────────────
  const setField = (k, v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return
    const b = { ...bounds }
    if (k === 'cx') b.center = { ...b.center, x: n }
    else if (k === 'cy') b.center = { ...b.center, y: n }
    else if (k === 'sx') b.size  = { ...b.size,   x: Math.max(0.05, n) }
    else if (k === 'sy') b.size  = { ...b.size,   y: Math.max(0.05, n) }
    else if (k === 'z_min') b.z_min = n
    else if (k === 'z_max') b.z_max = n
    else if (k === 'yaw_deg') b.yaw_deg = n
    onChange?.(b)
  }

  // ── Render geometry ────────────────────────────────────────────────
  const reachR_px = REACH_RADIUS_M * PX_PER_M
  const cornerScreens = corners.map((c) => worldToSvg(c.x, c.y))
  const centerScreen  = worldToSvg(bounds.center.x, bounds.center.y)
  const yawRad = bounds.yaw_deg * Math.PI / 180
  // Rotation handle: world position is center + (sx/2 + ROT_HANDLE_OFFSET_M,
  // 0) rotated by yaw. That's "north" (+local x) of the box.
  const rotW = {
    x: bounds.center.x + (bounds.size.x / 2 + ROT_HANDLE_OFFSET_M) * Math.cos(yawRad),
    y: bounds.center.y + (bounds.size.x / 2 + ROT_HANDLE_OFFSET_M) * Math.sin(yawRad),
  }
  const rotScreen = worldToSvg(rotW.x, rotW.y)

  // Edge midpoints (for edge resize handles) in screen coords.
  // Order: [N (between NE,NW), W (NW,SW), S (SW,SE), E (SE,NE)]
  const edgeMid = (i, j) => [
    (cornerScreens[i][0] + cornerScreens[j][0]) / 2,
    (cornerScreens[i][1] + cornerScreens[j][1]) / 2,
  ]
  const edges = [edgeMid(0, 1), edgeMid(1, 2), edgeMid(2, 3), edgeMid(3, 0)]
  const edgeKeys = ['n', 'w', 's', 'e']

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{
        position: 'relative',
        width: height, height,
        background: '#0b1220',
        border: '1px solid var(--border)',
        borderRadius: 8, overflow: 'hidden',
        flexShrink: 0,
      }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SVG_SIZE_PX} ${SVG_SIZE_PX}`}
          width="100%" height="100%"
          style={{ display: 'block', touchAction: 'none' }}
        >
          {/* gridlines every 0.25 m, heavy line every 1 m */}
          {Array.from({ length: 17 }, (_, i) => {
            const v = -2 + i * 0.25
            const heavy = Math.abs(v - Math.round(v)) < 1e-6
            const [, sy0] = worldToSvg(v, 0)
            const [sx0]   = worldToSvg(0, v)
            const stroke = heavy ? '#1f2a44' : '#142036'
            return (
              <g key={i}>
                <line x1={0} y1={sy0} x2={SVG_SIZE_PX} y2={sy0} stroke={stroke} strokeWidth={heavy ? 0.8 : 0.4} />
                <line x1={sx0} y1={0} x2={sx0} y2={SVG_SIZE_PX} stroke={stroke} strokeWidth={heavy ? 0.8 : 0.4} />
              </g>
            )
          })}

          {/* baseline cloud points — top-down projection, colored by height */}
          {cloud && cloud.p && (
            <g pointerEvents="none">
              {(() => {
                const out = []
                const n = Math.min(cloud.n || 0, cloud.p.length / 3)
                for (let i = 0; i < n; i++) {
                  const wx = cloud.p[i * 3]
                  const wy = cloud.p[i * 3 + 1]
                  const wz = cloud.p[i * 3 + 2]
                  if (Math.abs(wx) > VIEW_EXTENT_M || Math.abs(wy) > VIEW_EXTENT_M) continue
                  const [sx, sy] = worldToSvg(wx, wy)
                  out.push(<circle key={i} cx={sx} cy={sy} r={0.9} fill={heightColor(wz)} fillOpacity={0.85} />)
                }
                return out
              })()}
            </g>
          )}

          {/* axes */}
          <line x1={CENTER_PX} y1={0} x2={CENTER_PX} y2={SVG_SIZE_PX} stroke="#334155" strokeWidth={0.6} />
          <line x1={0} y1={CENTER_PX} x2={SVG_SIZE_PX} y2={CENTER_PX} stroke="#334155" strokeWidth={0.6} />
          <text x={CENTER_PX + 4} y={12} fontSize={10} fill="#64748b">+X (forward)</text>
          <text x={4} y={CENTER_PX - 4} fontSize={10} fill="#64748b">+Y (left)</text>

          {/* 1.4 m reach circle */}
          <circle cx={CENTER_PX} cy={CENTER_PX} r={reachR_px}
            fill="none" stroke="#22c55e" strokeWidth={1.5} strokeDasharray="6 4" opacity={0.9} />
          <text x={CENTER_PX + reachR_px * 0.71 + 4} y={CENTER_PX - reachR_px * 0.71 - 4}
            fontSize={10} fill="#22c55e">S10-140 reach 1.4 m</text>

          {/* robot+LiDAR marker at origin */}
          <g>
            <circle cx={CENTER_PX} cy={CENTER_PX} r={6} fill="#3b82f6" stroke="#1d4ed8" strokeWidth={1.5} />
            <text x={CENTER_PX + 10} y={CENTER_PX + 4} fontSize={10} fill="#bfdbfe">Robot + LiDAR</text>
          </g>

          {/* the work bounding box */}
          <polygon
            points={cornerScreens.map(([x, y]) => `${x},${y}`).join(' ')}
            fill="#2563EB22" stroke={anyExceed ? '#ef4444' : '#2563EB'} strokeWidth={2}
            onPointerDown={(e) => beginDrag('move', e)}
            style={{ cursor: 'move' }}
          />

          {/* line from center to rotation handle */}
          <line
            x1={centerScreen[0]} y1={centerScreen[1]}
            x2={rotScreen[0]} y2={rotScreen[1]}
            stroke="#2563EB" strokeWidth={1.5} strokeDasharray="2 3"
            pointerEvents="none"
          />

          {/* edge handles */}
          {edges.map(([sx, sy], i) => (
            <rect
              key={'edge-' + edgeKeys[i]}
              x={sx - HANDLE_R} y={sy - HANDLE_R}
              width={HANDLE_R * 2} height={HANDLE_R * 2}
              fill="#0ea5e9" stroke="#082f49" strokeWidth={1}
              onPointerDown={(e) => beginDrag('edge-' + edgeKeys[i], e)}
              style={{ cursor: 'pointer' }}
            />
          ))}

          {/* corner handles (resize) — red if outside reach */}
          {cornerScreens.map(([sx, sy], i) => (
            <circle
              key={'corner-' + i}
              cx={sx} cy={sy} r={HANDLE_R}
              fill={reachExceeded[i] ? '#ef4444' : '#fbbf24'}
              stroke="#78350f" strokeWidth={1.5}
              onPointerDown={(e) => beginDrag('corner-' + i, e)}
              style={{ cursor: 'nwse-resize' }}
            />
          ))}

          {/* rotation handle */}
          <circle
            cx={rotScreen[0]} cy={rotScreen[1]} r={HANDLE_R + 1}
            fill="#a855f7" stroke="#581c87" strokeWidth={1.5}
            onPointerDown={(e) => beginDrag('rotate', e)}
            style={{ cursor: 'grab' }}
          />
          <text x={rotScreen[0] + 10} y={rotScreen[1] - 2} fontSize={10} fill="#d8b4fe">rotate</text>

          {/* warning banner */}
          {anyExceed && (
            <g>
              <rect x={8} y={SVG_SIZE_PX - 30} rx={4} ry={4}
                width={230} height={22} fill="#7f1d1d" stroke="#ef4444" />
              <text x={16} y={SVG_SIZE_PX - 14} fontSize={11} fill="#fecaca">
                ⚠ Box extends beyond robot reach (1.4 m)
              </text>
            </g>
          )}

          {/* baseline status overlay */}
          {!cloud && !cloudErr && (
            <text x={SVG_SIZE_PX - 8} y={SVG_SIZE_PX - 8}
              textAnchor="end" fontSize={10} fill="#64748b">
              Loading baseline…
            </text>
          )}
          {cloudErr && (
            <text x={SVG_SIZE_PX - 8} y={SVG_SIZE_PX - 8}
              textAnchor="end" fontSize={10} fill="#f87171">
              No baseline yet — capture it first
            </text>
          )}
          {cloud && (
            <text x={SVG_SIZE_PX - 8} y={SVG_SIZE_PX - 8}
              textAnchor="end" fontSize={10} fill="#64748b">
              Baseline: {(cloud.n || 0).toLocaleString()} pts
              {cloud.total_in_file && cloud.n < cloud.total_in_file
                ? ` (downsampled from ${cloud.total_in_file.toLocaleString()})`
                : ''}
            </text>
          )}
        </svg>
      </div>

      {/* Numeric two-way binding */}
      <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <NumField label="Center X (m)"  v={bounds.center.x} step={0.05} onChange={(v) => setField('cx', v)} />
        <NumField label="Center Y (m)"  v={bounds.center.y} step={0.05} onChange={(v) => setField('cy', v)} />
        <NumField label="Size X (m)"    v={bounds.size.x}   step={0.05} onChange={(v) => setField('sx', v)} min={0.05} />
        <NumField label="Size Y (m)"    v={bounds.size.y}   step={0.05} onChange={(v) => setField('sy', v)} min={0.05} />
        <NumField label="Z min (m)"     v={bounds.z_min}    step={0.05} onChange={(v) => setField('z_min', v)} />
        <NumField label="Z max (m)"     v={bounds.z_max}    step={0.05} onChange={(v) => setField('z_max', v)} />
        <NumField label="Yaw (°)"       v={bounds.yaw_deg}  step={1}    onChange={(v) => setField('yaw_deg', v)} />
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 6 }}>
          <div>Drag <span style={{ color: '#2563EB', fontWeight: 700 }}>blue</span> body to move.</div>
          <div>Drag <span style={{ color: '#fbbf24', fontWeight: 700 }}>yellow</span> corners to resize.</div>
          <div>Drag <span style={{ color: '#0ea5e9', fontWeight: 700 }}>cyan</span> edges to scale one axis.</div>
          <div>Drag <span style={{ color: '#a855f7', fontWeight: 700 }}>purple</span> handle to rotate.</div>
          <div style={{ marginTop: 6 }}>
            Reach circle: <span style={{ color: '#22c55e' }}>green dashed</span> = 1.4 m (S10-140).
            {anyExceed && (
              <span style={{ color: '#ef4444', fontWeight: 700 }}> Box extends beyond reach.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Drag math (pure)
// ─────────────────────────────────────────────────────────────────────────

function applyDrag(dragging, wx, wy) {
  const { mode, startBounds, start } = dragging
  if (mode === 'move') {
    const dx = wx - start.wx
    const dy = wy - start.wy
    return {
      ...startBounds,
      center: { x: startBounds.center.x + dx, y: startBounds.center.y + dy },
    }
  }
  if (mode === 'rotate') {
    // Snap yaw to the angle from box center to the cursor.
    const ang = Math.atan2(wy - startBounds.center.y, wx - startBounds.center.x)
    const deg = ang * 180 / Math.PI
    return { ...startBounds, yaw_deg: snap(deg, 1) }
  }
  if (mode.startsWith('corner-')) {
    const idx = Number(mode.split('-')[1])
    // anchor = corner OPPOSITE to the dragged corner
    const anchorIdx = (idx + 2) % 4
    const startCorners = boxCorners(startBounds)
    const anchor = startCorners[anchorIdx]
    return resizeFromAnchor(startBounds, anchor, { x: wx, y: wy })
  }
  if (mode.startsWith('edge-')) {
    const which = mode.split('-')[1] // n,w,s,e
    return resizeEdge(startBounds, which, wx, wy)
  }
  return null
}

function snap(v, step) {
  return Math.round(v / step) * step
}

// Resize while keeping the opposite corner fixed AND the rotation unchanged.
// Approach: rotate the mouse-anchor delta into box-local axes, derive the
// new size and center from there.
function resizeFromAnchor(startBounds, anchor, mouseW) {
  const yaw = (startBounds.yaw_deg || 0) * Math.PI / 180
  const cos = Math.cos(yaw), sin = Math.sin(yaw)
  // Vector from anchor to mouse in world.
  const dxw = mouseW.x - anchor.x
  const dyw = mouseW.y - anchor.y
  // Project into box-local frame (un-rotate).
  const dxL =  cos * dxw + sin * dyw
  const dyL = -sin * dxw + cos * dyw
  const sx = Math.max(0.05, Math.abs(dxL))
  const sy = Math.max(0.05, Math.abs(dyL))
  // New center = anchor + (sign(dxL)*sx/2, sign(dyL)*sy/2) rotated back
  const cxL = Math.sign(dxL || 1) * sx / 2
  const cyL = Math.sign(dyL || 1) * sy / 2
  const cxW = anchor.x + (cos * cxL - sin * cyL)
  const cyW = anchor.y + (sin * cxL + cos * cyL)
  return {
    ...startBounds,
    center: { x: cxW, y: cyW },
    size:   { x: sx,  y: sy  },
  }
}

// Resize one axis (n/s acts on size.x, w/e acts on size.y). The anchor is
// the OPPOSITE edge midpoint, and we hold the perpendicular extent fixed.
function resizeEdge(startBounds, which, wx, wy) {
  const yaw = (startBounds.yaw_deg || 0) * Math.PI / 180
  const cos = Math.cos(yaw), sin = Math.sin(yaw)
  const c = startBounds.center
  // Convert mouse offset from center into box-local frame.
  const dxw = wx - c.x, dyw = wy - c.y
  const dxL =  cos * dxw + sin * dyw
  const dyL = -sin * dxw + cos * dyw
  const next = {
    ...startBounds,
    center: { ...c },
    size:   { ...startBounds.size },
  }
  if (which === 'n') {
    // Edge along +x in local; opposite (south) midpoint anchors at local (-sx_old/2,0)
    const sxOld = startBounds.size.x
    // Want new edge at local x = dxL; opposite stays at local x = -sxOld/2.
    const newSx = Math.max(0.05, dxL + sxOld / 2)
    const cxLnew = (dxL - sxOld / 2) / 2
    next.size.x = newSx
    next.center.x = c.x + (cos * cxLnew - sin * 0)
    next.center.y = c.y + (sin * cxLnew + cos * 0)
  } else if (which === 's') {
    const sxOld = startBounds.size.x
    const newSx = Math.max(0.05, -dxL + sxOld / 2)
    const cxLnew = (dxL + sxOld / 2) / 2
    next.size.x = newSx
    next.center.x = c.x + (cos * cxLnew - sin * 0)
    next.center.y = c.y + (sin * cxLnew + cos * 0)
  } else if (which === 'w') {
    const syOld = startBounds.size.y
    const newSy = Math.max(0.05, dyL + syOld / 2)
    const cyLnew = (dyL - syOld / 2) / 2
    next.size.y = newSy
    next.center.x = c.x + (cos * 0 - sin * cyLnew)
    next.center.y = c.y + (sin * 0 + cos * cyLnew)
  } else if (which === 'e') {
    const syOld = startBounds.size.y
    const newSy = Math.max(0.05, -dyL + syOld / 2)
    const cyLnew = (dyL + syOld / 2) / 2
    next.size.y = newSy
    next.center.x = c.x + (cos * 0 - sin * cyLnew)
    next.center.y = c.y + (sin * 0 + cos * cyLnew)
  }
  return next
}

// ─────────────────────────────────────────────────────────────────────────
// Small input
// ─────────────────────────────────────────────────────────────────────────

function NumField({ label, v, step, min, onChange }) {
  const [str, setStr] = useState(format(v))
  useEffect(() => { setStr(format(v)) }, [v])
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <label style={{ width: 110, fontSize: 11, color: 'var(--text-muted)' }}>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        value={str}
        onChange={(e) => {
          setStr(e.target.value)
          if (e.target.value !== '' && e.target.value !== '-') onChange(e.target.value)
        }}
        onBlur={() => { if (str === '' || str === '-') setStr(format(v)) }}
        style={{
          flex: 1, padding: '6px 10px', fontSize: 13,
          background: 'var(--bg-app)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 4, outline: 'none',
        }}
      />
    </div>
  )
}

function format(v) {
  if (!Number.isFinite(v)) return '0'
  return Number(v).toFixed(Math.abs(v) < 10 ? 2 : 1)
}
