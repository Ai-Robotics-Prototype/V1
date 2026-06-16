import { useStore } from '../store/useStore'

// NanoOWL detections are rendered as an absolutely-positioned SVG OVER
// the cam0 MJPEG stream. Bbox coords are in the camera's natural pixel
// space (e.g. 640×480) but the <img> is rendered at object-fit:contain
// inside the panel — so we scale the SVG to match the displayed image
// rect, not the natural one.
//
// Distinct color from the Isaac/COCO boxes that the server burns into
// the MJPEG: we use fuchsia/magenta so they're not confused.

const COLOR_DYNAMIC = '#e11d48'   // rose-600 — high-saturation pink/red
const COLOR_STATIC  = '#f97316'   // orange-500 — kept distinct from collision

export default function NanoOWLOverlay() {
  const ov = useStore((s) => s.openvocab)
  if (!ov || !ov.enabled) return null
  const dets = ov.detections || []
  const w = ov.image_w || 640
  const h = ov.image_h || 480

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 4,
      }}
    >
      {dets.map((d, i) => {
        const b = d.bbox_px || {}
        const x1 = b.x1, y1 = b.y1, x2 = b.x2, y2 = b.y2
        if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return null
        const bw = Math.max(1, x2 - x1)
        const bh = Math.max(1, y2 - y1)
        const conf = Math.round((d.confidence || 0) * 100)
        const z = d.approx_xyz_cam?.z
        const label = `${d.prompt}  ${conf}%${Number.isFinite(z) ? `  · ${(z * 1000).toFixed(0)}mm` : ''}`
        return (
          <g key={i}>
            <rect x={x1} y={y1} width={bw} height={bh}
              fill="rgba(225,29,72,0.10)"
              stroke={COLOR_DYNAMIC}
              strokeWidth={Math.max(1.5, w / 320)} />
            {/* label backdrop sized to the natural pixel scale */}
            <rect
              x={x1} y={Math.max(0, y1 - 18)} width={Math.min(w - x1, 260)} height={18}
              fill="rgba(0,0,0,0.78)"
            />
            <text
              x={x1 + 6} y={Math.max(0, y1 - 5)}
              fontSize={13}
              fill={COLOR_DYNAMIC}
              fontFamily="ui-monospace, monospace"
              fontWeight={700}
            >{label}</text>
          </g>
        )
      })}
    </svg>
  )
}
