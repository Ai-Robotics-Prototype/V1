import { useEffect, useState, useMemo } from 'react'
import { Html } from '@react-three/drei'

// Renders identified LiDAR objects inside the 3D Canvas. The component
// is meant to be dropped inside <Canvas>...</Canvas> in ArmViewer3D.
//
// Props:
//   showTentative      — render boxes with confidence 0.5-0.8
//   showUnknown        — render boxes with confidence 0.3-0.5
//   showLabels         — show floating label above each box
//   groupByPartType    — color all instances of same part the same
//   onPick(object)     — called when user clicks a box
export default function LidarObjectsOverlay({
  showTentative = true,
  showUnknown = false,
  showLabels = true,
  groupByPartType = false,
  onPick,
}) {
  const [objects, setObjects] = useState([])

  useEffect(() => {
    let alive = true
    let ws = null
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${window.location.host}/ws/lidar_objects`)
      ws.onmessage = (e) => {
        if (!alive) return
        try {
          const doc = JSON.parse(e.data)
          if (Array.isArray(doc.objects)) setObjects(doc.objects)
        } catch {}
      }
      ws.onerror = () => {
        // Fall back to polling if WS errors out
        ws?.close()
      }
    } catch {}
    const poll = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) return
      fetch('/api/lidar_objects/identified')
        .then((r) => r.json())
        .then((d) => alive && setObjects(d.objects || []))
        .catch(() => {})
    }, 500)
    return () => {
      alive = false
      try { ws?.close() } catch {}
      clearInterval(poll)
    }
  }, [])

  const partTypeColors = useMemo(() => {
    if (!groupByPartType) return null
    const palette = ['#3B82F6', '#22C55E', '#F59E0B', '#A78BFA',
                     '#EF4444', '#0EA5E9', '#FB7185', '#84CC16']
    const m = {}
    objects.forEach((o) => {
      if (!m[o.identified_as] && o.identified_as) {
        m[o.identified_as] = palette[Object.keys(m).length % palette.length]
      }
    })
    return m
  }, [groupByPartType, objects])

  function colorFor(o) {
    if (groupByPartType && partTypeColors && partTypeColors[o.identified_as]) {
      return partTypeColors[o.identified_as]
    }
    const c = o.confidence
    if (c >= 0.8) return '#22C55E'
    if (c >= 0.5) return '#F59E0B'
    return '#9CA3AF'
  }

  return (
    <group>
      {objects.map((o) => {
        if (o.confidence < 0.3) return null
        if (!showTentative && o.confidence < 0.8 && o.confidence >= 0.5) return null
        if (!showUnknown && o.confidence < 0.5) return null
        const dx = Math.max(0.005, o.dimensions.x)
        const dy = Math.max(0.005, o.dimensions.y)
        const dz = Math.max(0.005, o.dimensions.z)
        const color = colorFor(o)
        const qx = o.orientation.x, qy = o.orientation.y,
              qz = o.orientation.z, qw = o.orientation.w
        return (
          <group key={o.id}
                 position={[o.center.x, o.center.z, -o.center.y]}
                 quaternion={[qx, qz, -qy, qw]}>
            <mesh onClick={(e) => { e.stopPropagation(); onPick?.(o) }}>
              <boxGeometry args={[dx, dz, dy]} />
              <meshStandardMaterial color={color} opacity={0.22}
                                    transparent depthWrite={false} />
            </mesh>
            <mesh>
              <boxGeometry args={[dx, dz, dy]} />
              <meshBasicMaterial color={color} wireframe />
            </mesh>
            {showLabels && (
              <Html position={[0, dz * 0.65, 0]} center transform={false}>
                <div style={{
                  fontFamily: 'monospace',
                  fontSize: 10,
                  color: '#111',
                  background: 'rgba(255,255,255,0.92)',
                  border: `1px solid ${color}`,
                  borderRadius: 4,
                  padding: '2px 6px',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                }}>
                  <div style={{ fontWeight: 700 }}>{o.identified_name || 'unknown'}</div>
                  <div>{Math.round(o.confidence * 100)}% · {o.frames_observed}f
                    {o.identified_as && o.identified_as !== 'unknown' ? ' 📡' : ''}
                  </div>
                </div>
              </Html>
            )}
          </group>
        )
      })}
    </group>
  )
}
