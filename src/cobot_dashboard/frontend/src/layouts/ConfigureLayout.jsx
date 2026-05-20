import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'

const TABS = [
  { id: 'status', label: 'Status' },
  { id: 'safety', label: 'Safety' },
  { id: 'log',    label: 'Audit Log' },
]

const TYPE_COLORS = {
  ESTOP:          'var(--zone-red)',    JOG:            'var(--accent)',
  TASK:           'var(--green)',       PICK:           '#A855F7',
  GRIPPER:        '#A855F7',            VOICE:          'var(--yellow)',
  SPEED_OVERRIDE: 'var(--text-muted)', TEACH_POINT:    'var(--accent)',
  GO_TO_POINT:    'var(--accent)',      CLEAR_ERROR:    'var(--green)',
  PROGRAM_SAVE:   'var(--green)',       PROGRAM_LOAD:   'var(--accent)',
  JOINTS:         'var(--accent)',      PROGRAM_RUN:    'var(--green)',
}

// ── Status tab ─────────────────────────────────────────────────────────────────
function StatusTab() {
  const system  = useStore((s) => s.system)
  const robot   = useStore((s) => s.robot)
  const safety  = useStore((s) => s.safety)
  const joints  = useStore((s) => s.joints)

  const rows = [
    ['Mode',       system?.mock ? 'Simulation' : 'ROS2 Live'],
    ['ROS2',       system?.ros2 ? 'Connected' : 'Not available'],
    ['Uptime',     `${(system?.uptime_s ?? 0).toFixed(0)} s`],
    ['Robot IP',   robot?.ip ?? '—'],
    ['Robot mode', robot?.mode ?? '—'],
    ['Error code', `${robot?.error_code ?? 0}`],
    ['Zone',       safety?.zone ?? '—'],
    ['Speed scale',`${Math.round((safety?.speed_scale ?? 0) * 100)}%`],
    ['E-Stop',     safety?.estop ? 'ACTIVE' : 'Clear'],
    ['Proximity',  `${(safety?.human_proximity ?? 99).toFixed(2)} m`],
  ]

  return (
    <div style={{ padding: 16 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '6px 8px', color: 'var(--text-muted)', width: '45%' }}>{k}</td>
              <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)', fontWeight: 600 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Safety tab ─────────────────────────────────────────────────────────────────
function SafetyTab() {
  const safety    = useStore((s) => s.safety)
  const releaseEstop = useStore((s) => s.releaseEstop)
  const triggerEstop = useStore((s) => s.triggerEstop)

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>E-Stop Control</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={triggerEstop}
            style={{
              flex: 1, height: 36, fontSize: 12, fontWeight: 700,
              background: 'rgba(255,59,59,.15)', color: 'var(--red)',
              border: '1px solid var(--red)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}>
            Trigger E-Stop
          </button>
          <button
            onClick={releaseEstop}
            style={{
              flex: 1, height: 36, fontSize: 12, fontWeight: 700,
              background: 'var(--green-dim)', color: 'var(--green)',
              border: '1px solid var(--green)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}>
            Release E-Stop
          </button>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Zone Distances</div>
        {[
          ['GREEN',  '> 1.2 m',    '#00C47A'],
          ['YELLOW', '0.6 – 1.2 m','#F5A623'],
          ['RED',    '< 0.6 m',    '#FF3B3B'],
        ].map(([z, d, c]) => (
          <div key={z} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '5px 8px', borderRadius: 'var(--radius-sm)',
            background: safety?.zone === z ? c + '15' : 'transparent',
            marginBottom: 2,
          }}>
            <span style={{ fontSize: 12, color: safety?.zone === z ? c : 'var(--text-secondary)' }}>{z}</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{d}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Audit Log tab ──────────────────────────────────────────────────────────────
function LogPanel() {
  const [logs,    setLogs]    = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res  = await fetch('/api/log')
        const data = await res.json()
        setLogs(Array.isArray(data) ? data : [])
        setLoading(false)
      } catch (_) { setLoading(false) }
    }
    fetchLogs()
    const id = setInterval(fetchLogs, 2000)
    return () => clearInterval(id)
  }, [])

  function exportCSV() {
    const header = 'Time,Type,Detail,User\n'
    const rows   = logs.map((l) => `${l.time},${l.type},"${l.detail}",${l.user}`).join('\n')
    const blob   = new Blob([header + rows], { type: 'text/csv' })
    const url    = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'roboai_audit_log.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
          Operator Audit Log
        </div>
        <button
          onClick={exportCSV}
          style={{
            fontSize: 11, padding: '4px 12px',
            background: 'var(--bg-surface)', color: 'var(--text-secondary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}>
          Export CSV
        </button>
      </div>
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Time', 'Type', 'Detail', 'User'].map((h) => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '4px 8px',
                    color: 'var(--text-muted)', fontSize: 9,
                    textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '5px 8px', fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)' }}>{l.time}</td>
                  <td style={{ padding: '5px 8px' }}>
                    <span style={{
                      fontSize: 9, padding: '1px 6px', borderRadius: 10, fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.06em',
                      background: `${TYPE_COLORS[l.type] || 'var(--text-muted)'}20`,
                      color: TYPE_COLORS[l.type] || 'var(--text-muted)',
                      border: `1px solid ${TYPE_COLORS[l.type] || 'var(--text-muted)'}40`,
                    }}>{l.type}</span>
                  </td>
                  <td style={{ padding: '5px 8px', color: 'var(--text-secondary)' }}>{l.detail}</td>
                  <td style={{ padding: '5px 8px', color: 'var(--text-muted)' }}>{l.user}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {logs.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              No events logged yet
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── ConfigureLayout ────────────────────────────────────────────────────────────
export default function ConfigureLayout({ onClose }) {
  const [activeTab, setActiveTab] = useState('status')

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: 'var(--panel)', border: '1px solid var(--bd)',
        borderRadius: 12, width: 560, maxHeight: '80vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(0,0,0,.6)',
      }}>
        {/* Modal header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--bd)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Configure</span>
          <button onClick={onClose} style={{
            width: 24, height: 24, borderRadius: 4, border: 'none',
            background: 'var(--surf)', color: 'var(--tm)', cursor: 'pointer', fontSize: 14,
          }}>×</button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', borderBottom: '1px solid var(--bd)',
          padding: '0 16px', gap: 2, flexShrink: 0,
        }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: '8px 14px', border: 'none', fontSize: 12,
                background: 'transparent', cursor: 'pointer',
                color: activeTab === t.id ? 'var(--t1)' : 'var(--tm)',
                borderBottom: activeTab === t.id ? '2px solid var(--acc)' : '2px solid transparent',
                fontWeight: activeTab === t.id ? 600 : 400,
                transition: 'all .15s',
              }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {activeTab === 'status' && <StatusTab />}
          {activeTab === 'safety' && <SafetyTab />}
          {activeTab === 'log'    && <LogPanel />}
        </div>
      </div>
    </div>
  )
}
