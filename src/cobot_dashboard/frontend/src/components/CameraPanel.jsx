import { useState, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'

// Pinhole projection using D435i defaults
const FX = 615, FY = 615, CX = 320, CY = 240
const IMG_W = 640, IMG_H = 480

const CLASS_COLORS = {
  bottle: '#2563EB', box: '#16A34A', person: '#DC2626',
  cup: '#D97706', default: '#7C3AED',
}

function project3D(x, y, z) {
  if (!z || z <= 0) return null
  return {
    u: (FX * x / z + CX) / IMG_W,
    v: (FY * y / z + CY) / IMG_H,
  }
}

function DetectionOverlay({ detections, camId }) {
  if (!detections || !detections.length) return null

  return (
    <svg
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      viewBox="0 0 1 1" preserveAspectRatio="none"
    >
      {detections.map((det, i) => {
        // Support both bbox[x,y,w,h] and position[x,y,z]
        let x, y, w, h
        if (det.bbox && det.bbox.length >= 4) {
          [x, y, w, h] = det.bbox.map((v, i2) => i2 < 2 ? v / IMG_W : v / IMG_H)
          if (i2 >= 2) { w = det.bbox[2] / IMG_W; h = det.bbox[3] / IMG_H }
          // recalc properly
          x = det.bbox[0] / IMG_W
          y = det.bbox[1] / IMG_H
          w = det.bbox[2] / IMG_W
          h = det.bbox[3] / IMG_H
        } else if (det.position && det.position.length >= 3) {
          const p = project3D(...det.position)
          if (!p) return null
          w = 0.08; h = 0.1
          x = p.u - w / 2; y = p.v - h / 2
        } else {
          return null
        }
        const cls   = det.class_name || det.class || 'object'
        const color = CLASS_COLORS[cls] || CLASS_COLORS.default
        const conf  = det.confidence ? Math.round(det.confidence * 100) : null

        return (
          <g key={i}>
            <rect
              x={x} y={y} width={w} height={h}
              fill="none" stroke={color} strokeWidth={0.003}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              x={x} y={Math.max(0, y - 0.035)} width={Math.min(w, 0.18)} height={0.032}
              fill={color} opacity={0.85}
            />
            <text
              x={x + 0.005} y={Math.max(0, y - 0.006)}
              fontSize={0.025} fill="#fff" fontFamily="Inter, sans-serif"
              style={{ dominantBaseline: 'middle' }}
            >
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
  const [live,    setLive]    = useState(false)
  const [fps,     setFps]     = useState(0)
  const [retry,   setRetry]   = useState(0)
  const lastLoadRef = useRef(0)
  const fpsCountRef = useRef(0)
  const fpsTimerRef = useRef(null)
  const imgRef      = useRef(null)

  const src   = `/stream/cam${cam}`
  const label = `CAM ${cam}`

  const onLoad = useCallback(() => {
    setLive(true)
    setRetry(0)
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
    setLive(false)
    setRetry((r) => r + 1)
    const delay = Math.min(retry * 800, 5000)
    if (fpsTimerRef.current) clearTimeout(fpsTimerRef.current)
    fpsTimerRef.current = setTimeout(() => {
      if (imgRef.current) imgRef.current.src = `${src}?t=${Date.now()}`
    }, delay)
  }, [src, retry])

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
          {label}
        </span>
        <span style={{ flex: 1 }} />
        {live && fps > 0 && (
          <span style={{
            fontSize: 9, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
          }}>
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
          style={{
            width: '100%', height: '100%',
            objectFit: 'cover', display: 'block',
          }}
        />
        <DetectionOverlay detections={detections} camId={cam} />
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
