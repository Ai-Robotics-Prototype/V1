import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/useStore'

// Compact Monitor-tab card summarizing live LiDAR identifications. Click
// to switch to the 3D View tab (where the overlay lives).
export default function IdentifiedObjectsCard() {
  const [objects, setObjects] = useState([])
  const [updated, setUpdated] = useState(null)
  const setTab = useStore((s) => s.setTab)

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
          if (doc.updated_at) setUpdated(doc.updated_at)
        } catch {}
      }
    } catch {}
    const poll = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) return
      fetch('/api/lidar_objects/identified')
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return
          setObjects(d.objects || [])
          setUpdated(d.updated_at)
        })
        .catch(() => {})
    }, 1000)
    return () => {
      alive = false
      try { ws?.close() } catch {}
      clearInterval(poll)
    }
  }, [])

  const grouped = useMemo(() => {
    const m = new Map()
    for (const o of objects) {
      if (o.confidence < 0.3) continue
      const key = o.identified_as || 'unknown'
      if (!m.has(key)) {
        m.set(key, { name: o.identified_name || 'unknown',
                     part_id: key, count: 0, confSum: 0 })
      }
      const e = m.get(key)
      e.count += 1
      e.confSum += o.confidence
    }
    return Array.from(m.values()).map((e) => ({
      ...e, avg: e.confSum / Math.max(e.count, 1),
    })).sort((a, b) => b.count - a.count)
  }, [objects])

  const confidentCount = useMemo(
    () => objects.filter((o) => o.confidence >= 0.8).length,
    [objects])

  const sinceMs = useMemo(() => {
    if (!updated) return null
    try {
      const t = new Date(updated).getTime()
      return Math.max(0, Date.now() - t)
    } catch { return null }
  }, [updated])

  return (
    <div
      onClick={() => setTab && setTab('3dview')}
      style={{
        background: '#fff', border: '1px solid #E5E7EB',
        borderRadius: 12, padding: '14px 16px',
        flex: '1 1 320px', minWidth: 280,
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700,
                      textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Identified Objects
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
          background: '#DCFCE7', color: '#16A34A',
        }}>
          {objects.length} total · {confidentCount} confident
        </span>
      </div>
      {grouped.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9CA3AF' }}>
          No objects identified — LiDAR identifier may not be running yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {grouped.slice(0, 5).map((g) => (
            <div key={g.part_id} style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 12, color: '#374151', fontFamily: 'monospace',
            }}>
              <span style={{ fontWeight: 600 }}>
                {g.name} × {g.count}
              </span>
              <span style={{ color: g.avg >= 0.8 ? '#16A34A' :
                                     g.avg >= 0.5 ? '#CA8A04' : '#6B7280' }}>
                {Math.round(g.avg * 100)}% avg
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: '#9CA3AF', marginTop: 'auto' }}>
        {sinceMs != null
          ? `Last identification: ${(sinceMs / 1000).toFixed(1)}s ago`
          : 'Waiting for first identification…'}
      </div>
    </div>
  )
}
