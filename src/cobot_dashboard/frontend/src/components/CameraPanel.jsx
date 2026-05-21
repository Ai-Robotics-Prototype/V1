import { useState, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'

const IMG_W = 640, IMG_H = 480

const CLASS_COLORS = {
  bottle: '#2563EB', box: '#16A34A', person: '#DC2626',
  cup: '#D97706', default: '#7C3AED',
}

function DetectionOverlay({ detections }) {
  if (!detections || !detections.length) return null
  return (
    <svg
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      viewBox="0 0 1 1" preserveAspectRatio="none"
    >
      {detections.map((det, i) => {
        if (!det.bbox_px || det.bbox_px.length < 4) return null
        const [x1, y1, x2, y2] = det.bbox_px
        const x = x1 / IMG_W, y = y1 / IMG_H
        const w = (x2 - x1) / IMG_W, h = (y2 - y1) / IMG_H
        const cls   = det.class_name || 'object'
        const color = CLASS_COLORS[cls] || CLASS_COLORS.default
        const conf  = det.score != null ? Math.round(det.score * 100) : null
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h}
              fill="none" stroke={color} strokeWidth={0.003}
              vectorEffect="non-scaling-stroke" />
            <rect x={x} y={Math.max(0, y - 0.035)} width={Math.min(w, 0.18)} height={0.032}
              fill={color} opacity={0.85} />
            <text x={x + 0.005} y={Math.max(0, y - 0.006)}
              fontSize={0.025} fill="#fff" fontFamily="Inter, sans-serif"
              dominantBaseline="middle">
              {cls}{conf !== null ? ` ${conf}%` : ''}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export default function CameraPanel({ cam }) {
  const detections = useStore((s) => s.detections)
  const perception = useStore((s) => s.perception)
  const [live,  setLive]  = useState(false)
  const [fps,   setFps]   = useState(0)
  const [retry, setRetry] = useState(0)
  const lastLoadRef = useRef(0)
  const fpsCountRef = useRef(0)
  const fpsTimerRef = useRef(null)
  const imgRef      = useRef(null)

  const useAnnotated = cam === 0 && perception?.annotated_active
  const src          = useAnnotated ? '/stream/annotated' : `/stream/cam${cam}`
  const label        = `CAM ${cam}`

  const onLoad = useCallback(() => {
    setLive(true); setRetry(0)
    const now = Date.now()
    if (lastLoadRef.current) {
      fpsCountRef.current++
      const elapsed = (now - lastLoadRef.current) / 1000
      if (elapsed >= 1) {
        setFps(Math.round(fpsCountRef.current / elapsed))
        fpsCountRef.current = 0
        lastLoadRef.current = now
      }
    } else {
      lastLoadRef.current = now
    }
  }, [])

  const onError = useCallback(() => {
    setLive(false); setRetry((r) => r + 1)
    const delay = Math.min(retry * 800, 5000)
    if (fpsTimerRef.current) clearTimeout(fpsTimerRef.current)
    fpsTimerRef.current = setTimeout(() => {
      if (imgRef.current) imgRef.current.src = `${src}?t=${Date.now()}`
    }, delay)
  }, [src, retry])

  const classes      = cam === 0 ? (perception?.classes || {}) : {}
  const classEntries = Object.entries(classes)

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden', minWidth: 0,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          {label}{useAnnotated ? ' · AI' : ''}
        </span>

        {cam === 0 && (perception?.fps ?? 0) > 0 && (
          <span style={{
            fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--accent)',
            padding: '1px 5px', borderRadius: 4, background: 'var(--accent-dim)',
          }}>
            {perception.fps.toFixed(1)}fps · {perception.inference_ms?.toFixed(0)}ms
          </span>
        )}
        {cam === 0 && (perception?.det_count ?? 0) > 0 && (
          <span style={{ fontSize: 9, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
            {perception.det_count} det
          </span>
        )}

        <span style={{ flex: 1 }} />
        {live && fps > 0 && (
          <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            {fps} fps
          </span>
        )}
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
          background: live ? 'var(--green-dim)' : 'var(--red-dim)',
          color:      live ? 'var(--green)'     : 'var(--red)',
        }}>
          {live ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>

      {/* Image area */}
      <div style={{ flex: 1, position: 'relative', background: '#1a1a1c', minHeight: 0 }}>
        <img
          ref={imgRef}
          src={src}
          alt={label}
          onLoad={onLoad}
          onError={onError}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        {!useAnnotated && cam === 0 && <DetectionOverlay detections={detections} />}

        {/* Class count pills — bottom-left when detections active */}
        {classEntries.length > 0 && (
          <div style={{
            position: 'absolute', bottom: 6, left: 6,
            display: 'flex', flexWrap: 'wrap', gap: 3, pointerEvents: 'none',
          }}>
            {classEntries.slice(0, 5).map(([cls, cnt]) => {
              const color = CLASS_COLORS[cls] || CLASS_COLORS.default
              return (
                <span key={cls} style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 8,
                  background: 'rgba(0,0,0,0.70)',
                  color, border: `1px solid ${color}55`, fontWeight: 700,
                }}>
                  {cls} ×{cnt}
                </span>
              )
            })}
          </div>
        )}

        {!live && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              border: '3px solid rgba(255,255,255,.12)',
              borderTopColor: 'var(--accent)',
              animation: 'spin .8s linear infinite',
            }} />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,.4)' }}>
              Waiting for {label}…
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
