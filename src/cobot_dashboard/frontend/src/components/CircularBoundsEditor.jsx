import { useEffect, useMemo, useRef, useState } from 'react'

// Estun S10-140: 1400mm horizontal reach (SR 1400 in the manual). The
// working radius is hard-clamped to this — the operator can't define a
// workspace larger than the robot can physically reach.
const REACH_RADIUS_M = 1.4

// Same SVG mapping as BoundsTopDownEditor so the wizard's two views read
// at the same scale — 480 px square mapping ±2 m of world space.
const SVG_SIZE_PX   = 480
const VIEW_EXTENT_M = 2.0
const PX_PER_M      = (SVG_SIZE_PX / 2) / VIEW_EXTENT_M
const CENTER_PX     = SVG_SIZE_PX / 2

function worldToSvg(wx, wy) {
  return [CENTER_PX - wy * PX_PER_M, CENTER_PX - wx * PX_PER_M]
}
function svgToWorld(sx, sy) {
  return [(CENTER_PX - sy) / PX_PER_M, (CENTER_PX - sx) / PX_PER_M]
}

function heightColor(z) {
  if (z < 0.1) return '#264ec9'
  if (z < 0.5) return '#24b27d'
  if (z < 1.0) return '#d8b919'
  return         '#d44025'
}

// ─────────────────────────────────────────────────────────────────────────
// Bounds shape (circle) — backward compat
// ─────────────────────────────────────────────────────────────────────────
// New canonical shape:
//   { shape: "circle", radius, center: {x:0,y:0}, z_min, z_max }
// Legacy shapes still understood on load:
//   { center, size, yaw_deg, z_min, z_max }      → radius = min(sx/2, sy/2)
//   { x_min, x_max, y_min, y_max, z_min, z_max } → radius = min half-extent
// In every case the center is forced to the origin (the robot base / LiDAR
// frame is the world origin in this rigid-mount build).

export function normalizeCircleBounds(b) {
  if (b && b.shape === 'circle' && b.radius != null) {
    return {
      shape:  'circle',
      center: { x: 0, y: 0 },
      radius: clampRadius(Number(b.radius)),
      z_min:  numOr(b.z_min, 0),
      z_max:  numOr(b.z_max, 0.8),
    }
  }
  if (b && b.size) {
    const r = Math.min(Number(b.size.x) || 0, Number(b.size.y) || 0) / 2
    return {
      shape:  'circle',
      center: { x: 0, y: 0 },
      radius: clampRadius(r > 0 ? r : REACH_RADIUS_M),
      z_min:  numOr(b.z_min, 0),
      z_max:  numOr(b.z_max, 0.8),
    }
  }
  if (b && (b.x_min != null || b.x_max != null)) {
    const sx = Math.max(0, (Number(b.x_max) || 0) - (Number(b.x_min) || 0))
    const sy = Math.max(0, (Number(b.y_max) || 0) - (Number(b.y_min) || 0))
    const r  = Math.min(sx, sy) / 2
    return {
      shape:  'circle',
      center: { x: 0, y: 0 },
      radius: clampRadius(r > 0 ? r : REACH_RADIUS_M),
      z_min:  numOr(b.z_min, 0),
      z_max:  numOr(b.z_max, 0.8),
    }
  }
  return {
    shape:  'circle',
    center: { x: 0, y: 0 },
    radius: REACH_RADIUS_M,
    z_min:  0,
    z_max:  0.8,
  }
}

// Save in BOTH new circular form AND rect-compatible AABB form so the
// existing cell-detail Edit page renders something sensible without
// being touched. The square AABB = the bounding square of the circle.
export function serializeCircleBounds(b) {
  const norm = normalizeCircleBounds(b)
  const r = norm.radius
  return {
    shape:   'circle',
    radius:  r,
    center:  { x: 0, y: 0 },
    z_min:   norm.z_min,
    z_max:   norm.z_max,
    // ── legacy / Edit-page compat ──
    size:    { x: 2 * r, y: 2 * r },
    yaw_deg: 0,
    x_min:   -r, x_max: r,
    y_min:   -r, y_max: r,
  }
}

function clampRadius(r) {
  if (!Number.isFinite(r) || r < 0) return 0
  return Math.min(r, REACH_RADIUS_M)
}

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

const HANDLE_R = 8

export default function CircularBoundsEditor({ cellId, value, onChange, height = 480, cloudOverride }) {
  const bounds = useMemo(() => normalizeCircleBounds(value), [value])
  const [fetchedCloud, setFetchedCloud] = useState(null)
  const [cloudErr, setCloudErr]         = useState(null)
  const svgRef = useRef(null)
  const draggingRef = useRef(false)

  // Two ways to get the baseline cloud, in priority order:
  // 1. cloudOverride — caller already fetched the cloud and is passing it
  //    in (the wizard stashes the cloud immediately after capture so we
  //    don't depend on the PCD file being on disk by the time the user
  //    advances to this step). Only honored when the cellId matches so a
  //    stale carry-over from a different cell can never leak in.
  // 2. fetched — fall back to /api/cells/{id}/baseline/cloud for the
  //    saved PCD. Used by the Edit page and by the wizard when the user
  //    re-enters the bounds step for a cell whose baseline was captured
  //    in a previous session.
  const overrideOk = !!cloudOverride && cloudOverride.cellId === cellId && cloudOverride.p
  const cloud = overrideOk ? cloudOverride : fetchedCloud

  useEffect(() => {
    if (!cellId) { setFetchedCloud(null); return }
    if (overrideOk) { setCloudErr(null); return }
    let alive = true
    setFetchedCloud(null); setCloudErr(null)
    fetch(`/api/cells/${cellId}/baseline/cloud?max_points=5000`)
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error || `HTTP ${r.status}`)
        }
        const j = await r.json()
        if (alive) setFetchedCloud(j)
      })
      .catch((e) => { if (alive) setCloudErr(String(e.message || e)) })
    return () => { alive = false }
  }, [cellId, overrideOk])

  const cloudMissing = !cloud

  // Drag math: mouse position → distance from origin → new radius.
  const mouseRadius = (ev) => {
    const rect = svgRef.current.getBoundingClientRect()
    const sx = (ev.clientX - rect.left) * (SVG_SIZE_PX / rect.width)
    const sy = (ev.clientY - rect.top)  * (SVG_SIZE_PX / rect.height)
    const [wx, wy] = svgToWorld(sx, sy)
    return Math.hypot(wx, wy)
  }

  useEffect(() => {
    const onMove = (ev) => {
      if (!draggingRef.current) return
      const r = clampRadius(mouseRadius(ev))
      onChange?.({ ...bounds, radius: r })
    }
    const onUp = () => { draggingRef.current = false }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [bounds, onChange])

  const beginRadiusDrag = (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    draggingRef.current = true
  }

  const setRadius = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return
    onChange?.({ ...bounds, radius: clampRadius(n) })
  }
  const setZ = (k, v) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return
    onChange?.({ ...bounds, [k]: n })
  }

  // Derived geometry
  const reachR_px   = REACH_RADIUS_M * PX_PER_M
  const workingR_px = bounds.radius * PX_PER_M
  // Place the radius handle on the +X (forward) direction → "top" of screen.
  const handleScreen = worldToSvg(bounds.radius, 0)
  const atMax = bounds.radius >= REACH_RADIUS_M - 1e-4

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

          {/* baseline cloud — top-down, height-colored */}
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

          {/* max-reach dashed circle */}
          <circle cx={CENTER_PX} cy={CENTER_PX} r={reachR_px}
            fill="none" stroke="#22c55e" strokeWidth={1.5}
            strokeDasharray="6 4" opacity={0.9} pointerEvents="none" />
          <text x={CENTER_PX + reachR_px * 0.71 + 4} y={CENTER_PX - reachR_px * 0.71 - 4}
            fontSize={10} fill="#22c55e">Max reach 1.40 m</text>

          {/* operator's working-radius circle */}
          <circle cx={CENTER_PX} cy={CENTER_PX} r={workingR_px}
            fill="#2563EB22" stroke={atMax ? '#fbbf24' : '#2563EB'} strokeWidth={2}
            pointerEvents="none" />

          {/* origin marker (robot + LiDAR, rigidly co-located) */}
          <g pointerEvents="none">
            <circle cx={CENTER_PX} cy={CENTER_PX} r={6} fill="#3b82f6" stroke="#1d4ed8" strokeWidth={1.5} />
            <text x={CENTER_PX + 10} y={CENTER_PX + 4} fontSize={10} fill="#bfdbfe">Robot + LiDAR</text>
          </g>

          {/* radius drag handle on the +X (forward) edge of the working circle */}
          <line
            x1={CENTER_PX} y1={CENTER_PX}
            x2={handleScreen[0]} y2={handleScreen[1]}
            stroke="#2563EB" strokeWidth={1.2} strokeDasharray="2 3" pointerEvents="none"
          />
          <circle cx={handleScreen[0]} cy={handleScreen[1]} r={HANDLE_R}
            fill="#fbbf24" stroke="#78350f" strokeWidth={1.5}
            onPointerDown={beginRadiusDrag}
            style={{ cursor: 'ns-resize' }}
          />
          <text
            x={handleScreen[0] + 12} y={handleScreen[1] + 4}
            fontSize={10} fill="#fcd34d" pointerEvents="none">
            drag · {bounds.radius.toFixed(2)} m
          </text>

          {/* clamp / status banner */}
          {atMax && (
            <g pointerEvents="none">
              <rect x={8} y={SVG_SIZE_PX - 30} rx={4} ry={4}
                width={260} height={22} fill="#78350f" stroke="#fbbf24" />
              <text x={16} y={SVG_SIZE_PX - 14} fontSize={11} fill="#fef3c7">
                At maximum reach (1.40 m) — cannot enlarge further
              </text>
            </g>
          )}

          {/* baseline footer: present cloud → corner stat line */}
          {cloud && (
            <text x={SVG_SIZE_PX - 8} y={SVG_SIZE_PX - 8}
              textAnchor="end" fontSize={10} fill="#64748b" pointerEvents="none">
              Baseline scene: {(cloud.n || 0).toLocaleString()} pts
              {cloud.total_in_file && cloud.n < cloud.total_in_file
                ? ` (downsampled from ${cloud.total_in_file.toLocaleString()})`
                : ''}
              {overrideOk ? ' · from capture' : ' · from saved PCD'}
            </text>
          )}

          {/* baseline missing → loud centered banner */}
          {cloudMissing && (
            <g pointerEvents="none">
              <rect x={SVG_SIZE_PX / 2 - 175} y={SVG_SIZE_PX / 2 - 32}
                width={350} height={64} rx={8} ry={8}
                fill="#1e293b" stroke={cloudErr ? '#f87171' : '#fbbf24'} strokeWidth={1.5} />
              <text x={SVG_SIZE_PX / 2} y={SVG_SIZE_PX / 2 - 8}
                textAnchor="middle" fontSize={13} fontWeight="700"
                fill={cloudErr ? '#fecaca' : '#fef3c7'}>
                {cloudErr ? 'Baseline scene not loaded' : 'Loading baseline scene…'}
              </text>
              <text x={SVG_SIZE_PX / 2} y={SVG_SIZE_PX / 2 + 14}
                textAnchor="middle" fontSize={11}
                fill={cloudErr ? '#fca5a5' : '#fde68a'}>
                {cloudErr
                  ? 'Recapture in the previous step, then return here.'
                  : 'fetching from /api/cells/{id}/baseline/cloud…'}
              </text>
            </g>
          )}
        </svg>
      </div>

      <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <NumField
          label="Working Radius (m)"
          v={bounds.radius}
          step={0.05}
          min={0}
          max={REACH_RADIUS_M}
          onChange={setRadius}
          hint={`Max reach: ${REACH_RADIUS_M.toFixed(2)} m`}
        />
        <NumField
          label="Z min (m)"
          v={bounds.z_min}
          step={0.05}
          onChange={(v) => setZ('z_min', v)}
        />
        <NumField
          label="Z max (m)"
          v={bounds.z_max}
          step={0.05}
          onChange={(v) => setZ('z_max', v)}
        />
        <div style={{
          fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55,
          marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--border)',
        }}>
          <div>Workspace shape: <strong style={{ color: 'var(--text-primary)' }}>cylinder</strong></div>
          <div>Centered on the robot base (LiDAR + arm share the origin) — center is not movable.</div>
          <div style={{ marginTop: 6 }}>
            Drag the <span style={{ color: '#fbbf24', fontWeight: 700 }}>yellow handle</span> on the
            forward (+X) edge to resize, or type a value.
            Outer <span style={{ color: '#22c55e' }}>dashed green</span> ring = the robot's 1.40 m maximum reach (you can't exceed it).
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Small input
// ─────────────────────────────────────────────────────────────────────────

function NumField({ label, v, step, min, max, onChange, hint }) {
  const [str, setStr] = useState(format(v))
  useEffect(() => { setStr(format(v)) }, [v])
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ width: 140, fontSize: 12, color: 'var(--text-muted)' }}>{label}</label>
        <input
          type="number"
          step={step}
          min={min}
          max={max}
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
      {hint && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, marginLeft: 148 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

function format(v) {
  if (!Number.isFinite(v)) return '0'
  return Number(v).toFixed(Math.abs(v) < 10 ? 2 : 1)
}
