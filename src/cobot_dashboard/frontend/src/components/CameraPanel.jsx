import { useRef, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '../store'

// Simple pinhole projection
const FX = 615, FY = 615, CX = 320, CY = 240
function project(x, y, z) {
  if (z <= 0) return null
  return { u: FX * x / z + CX, v: FY * y / z + CY }
}

const CLASS_COLORS = {
  person: '#FF3B3B',
  bottle: '#2F7FFF',
  box:    '#00C47A',
}
function classColor(name) { return CLASS_COLORS[name] ?? '#A0A0A8' }

function DetectionOverlay({ detections }) {
  if (!detections?.length) return null
  return (
    <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }}
         viewBox="0 0 640 480">
      <AnimatePresence>
        {detections.map(det => {
          const c = project(det.x, det.y, det.z)
          if (!c) return null
          const pw = FX * det.w / det.z
          const ph = FY * det.h / det.z
          const x1 = c.u - pw / 2, y1 = c.v - ph / 2
          const col = classColor(det.class_name)
          return (
            <motion.g key={det.id}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ duration: 0.15 }}>
              <rect x={x1} y={y1} width={pw} height={ph}
                    fill="none" stroke={col} strokeWidth={2} />
              <rect x={x1} y={y1 - 18} width={pw} height={18}
                    fill={col} opacity={0.85} />
              <text x={x1 + 4} y={y1 - 5}
                    fill="#fff" fontSize={11} fontFamily="Inter,sans-serif">
                {det.class_name} {(det.score * 100).toFixed(0)}%
              </text>
            </motion.g>
          )
        })}
      </AnimatePresence>
    </svg>
  )
}

function SingleCamera({ camId }) {
  const { robotState } = useStore()
  const [online, setOnline] = useState(true)
  const detections = robotState?.detections ?? []
  const src = `/stream/cam${camId}`

  return (
    <div style={styles.camWrap}>
      {online ? (
        <>
          <img
            src={src}
            style={styles.img}
            onError={() => setOnline(false)}
            alt=""
          />
          <DetectionOverlay detections={detections} />
        </>
      ) : (
        <div style={styles.offline}>
          <span style={styles.offlineIcon}>⬜</span>
          <span style={styles.offlineText}>Camera offline</span>
        </div>
      )}
      <div style={styles.badge}>CAM {camId}</div>
    </div>
  )
}

export default function CameraPanel({ view }) {
  if (view === 'single-cam1') return <SingleCamera camId={1} />
  return <SingleCamera camId={0} />
}

const styles = {
  camWrap: {
    position: 'relative',
    width: '100%',
    height: '100%',
    background: '#0A0A0B',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  img: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  },
  offline: {
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: 8,
  },
  offlineIcon: { fontSize: 40, opacity: 0.2 },
  offlineText: { color: 'var(--text-muted)', fontSize: 13 },
  badge: {
    position: 'absolute', top: 10, left: 10,
    background: 'rgba(0,0,0,0.6)',
    color: 'var(--text-secondary)',
    fontSize: 11, letterSpacing: '0.08em',
    padding: '3px 8px', borderRadius: 4,
  },
}
