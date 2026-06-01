import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../store/useStore'

// Pinhole camera intrinsics (matches server)
const FX = 615, FY = 615, CX = 320, CY = 240

function project(x, y, z) {
  if (z <= 0) return null
  return {
    u: (FX * x) / z + CX,
    v: (-FY * y) / z + CY,
  }
}

const CLASS_COLORS = {
  bottle: '#3B82F6',
  box:    '#22C55E',
  person: '#EF4444',
}

function classColor(name) {
  return CLASS_COLORS[name] ?? '#9A9A9E'
}

function DetectionOverlay({ detections }) {
  if (!detections || detections.length === 0) return null

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
      viewBox="0 0 640 480"
      preserveAspectRatio="xMidYMid meet"
    >
      {detections.map((det) => {
        let x0, y0, bw, bh
        if (det.bbox_px && det.bbox_px.length === 4) {
          // Pixel coordinates (image space) — render directly into the viewBox
          const [x1, y1, x2, y2] = det.bbox_px
          x0 = x1; y0 = y1; bw = x2 - x1; bh = y2 - y1
        } else if (det.z > 0) {
          // Metric 3D coordinates — project through the pinhole model
          const c = project(det.x, det.y, det.z)
          if (!c) return null
          bw = Math.max((FX * det.w) / det.z, 8)
          bh = Math.max((FY * det.h) / det.z, 8)
          x0 = c.u - bw / 2
          y0 = c.v - bh / 2
        } else {
          return null
        }
        // Matched parts (depth_segment_node found a CAD library hit)
        // get the blue accent; everything else falls back to the
        // class-colour palette. Label shows the part name + match %.
        const matched = !!det.part_name
        const col = matched ? '#3B82F6' : classColor(det.class_name)
        const pct = matched
          ? Math.round((det.match_score ?? det.score) * 100)
          : Math.round((det.score ?? 0) * 100)
        const label = matched
          ? `${det.part_name} (${pct}%)`
          : `${det.class_name} ${pct}%`

        return (
          <g key={det.id} style={{ transition: 'opacity 150ms' }}>
            <rect
              x={x0}
              y={y0}
              width={bw}
              height={bh}
              fill="none"
              stroke={col}
              strokeWidth={2}
              rx={2}
            />
            <rect
              x={x0}
              y={y0 - 16}
              width={bw}
              height={16}
              fill={col}
              opacity={0.85}
            />
            <text
              x={x0 + 3}
              y={y0 - 4}
              fill="#fff"
              fontSize={10}
              fontFamily="Inter,sans-serif"
              fontWeight={500}
            >
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export default function CameraPanel({ cam = 0 }) {
  const detections = useStore((s) => s.detections)
  const setView    = useStore((s) => s.setView)

  const [online, setOnline]     = useState(true)
  const [fps, setFps]           = useState(null)
  const frameTimesRef           = useRef([])

  const handleLoad = useCallback(() => {
    const now = Date.now()
    frameTimesRef.current.push(now)
    // Keep last 10 frames
    if (frameTimesRef.current.length > 10) {
      frameTimesRef.current.shift()
    }
    const times = frameTimesRef.current
    if (times.length >= 2) {
      const elapsed = (times[times.length - 1] - times[0]) / 1000
      const rate    = (times.length - 1) / elapsed
      setFps(Math.round(rate))
    }
    setOnline(true)
  }, [])

  const handleError = useCallback(() => {
    setOnline(false)
  }, [])

  // Re-trigger load tracking on the img element which auto-loops for MJPEG
  const imgRef = useRef(null)

  return (
    <div
      onClick={() => setView(`cam${cam}`)}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#070a0e',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
      }}
    >
      {online ? (
        <>
          <img
            ref={imgRef}
            src={`/stream/cam${cam}`}
            alt={`Camera ${cam}`}
            onLoad={handleLoad}
            onError={handleError}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
          {/* Boxes + distance labels are drawn server-side into the annotated
              MJPEG stream (consistent green, both cameras). The old client-side
              SVG overlay was removed — it rendered cam0 detections (grey, no
              distance) on both panels, causing inconsistent boxes. */}

          {/* FPS badge */}
          <div style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(0,0,0,0.6)',
            color: '#22C55E',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            padding: '2px 6px',
            borderRadius: 3,
            letterSpacing: '0.04em',
          }}>
            ● {fps !== null ? `${fps} fps` : '? fps'}
          </div>
        </>
      ) : (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ fontSize: 36 }}>📷</span>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Camera offline</span>
          <button
            onClick={(e) => { e.stopPropagation(); setOnline(true) }}
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              fontSize: 11,
              padding: '4px 10px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Camera label badge */}
      <div style={{
        position: 'absolute',
        top: 8,
        left: 8,
        background: 'rgba(0,0,0,0.6)',
        color: 'var(--text-secondary)',
        fontSize: 10,
        letterSpacing: '0.08em',
        padding: '2px 7px',
        borderRadius: 3,
        fontWeight: 500,
        pointerEvents: 'none',
      }}>
        CAM {cam}
      </div>
    </div>
  )
}
