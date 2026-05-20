import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'

export default function CameraFeed() {
  const detections = useStore((s) => s.detections)
  const [camOk, setCamOk]   = useState(false)
  const [retries, setRetries] = useState(0)
  const imgRef  = useRef(null)
  const canvasRef = useRef(null)

  // Reload <img> on error with back-off
  useEffect(() => {
    if (retries === 0) return
    const t = setTimeout(() => {
      if (imgRef.current) {
        imgRef.current.src = `/stream/cam0?t=${Date.now()}`
      }
    }, Math.min(retries * 800, 5000))
    return () => clearTimeout(t)
  }, [retries])

  // Draw detection boxes on canvas overlay
  useEffect(() => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img || !camOk) return
    const ctx = canvas.getContext('2d')
    canvas.width  = img.clientWidth
    canvas.height = img.clientHeight
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!detections?.length) return
    detections.forEach((d) => {
      const [x1, y1, x2, y2] = d.bbox ?? [0, 0, 0, 0]
      const cx = x1 * canvas.width
      const cy = y1 * canvas.height
      const cw = (x2 - x1) * canvas.width
      const ch = (y2 - y1) * canvas.height
      ctx.strokeStyle = '#3B82F6'
      ctx.lineWidth   = 2
      ctx.strokeRect(cx, cy, cw, ch)
      ctx.fillStyle   = 'rgba(59,130,246,.7)'
      ctx.font        = '11px monospace'
      ctx.fillText(`${d.class ?? ''} ${((d.confidence ?? 0) * 100).toFixed(0)}%`, cx + 3, cy + 13)
    })
  }, [detections, camOk])

  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--bd)',
      borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        padding: '8px 13px', borderBottom: '1px solid var(--bd)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--tm)' }}>
          Camera Feed — cam0
        </span>
        <span style={{
          fontSize: 9, padding: '2px 7px', borderRadius: 10, fontWeight: 700,
          background: camOk ? 'rgba(0,196,122,.15)' : 'rgba(255,59,59,.15)',
          color:      camOk ? 'var(--g)' : 'var(--r)',
        }}>
          {camOk ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>

      <div style={{ flex: 1, position: 'relative', background: '#0a0a0c', minHeight: 200 }}>
        <img
          ref={imgRef}
          src="/stream/cam0"
          alt="camera feed"
          onLoad={() => { setCamOk(true); setRetries(0) }}
          onError={() => { setCamOk(false); setRetries((r) => r + 1) }}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        />
        {!camOk && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 8, color: 'var(--tm)',
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              border: '3px solid #333', borderTopColor: 'var(--acc)',
              animation: 'spin .8s linear infinite',
            }} />
            <span style={{ fontSize: 11 }}>Waiting for /cam0/color/image_raw…</span>
          </div>
        )}
      </div>

      {/* Detection summary */}
      {detections?.length > 0 && (
        <div style={{
          padding: '6px 13px', borderTop: '1px solid var(--bd)',
          display: 'flex', gap: 6, flexWrap: 'wrap',
        }}>
          {detections.slice(0, 6).map((d, i) => (
            <span key={i} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(59,130,246,.15)', color: 'var(--acc)',
            }}>
              {d.class ?? 'obj'} {((d.confidence ?? 0) * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
