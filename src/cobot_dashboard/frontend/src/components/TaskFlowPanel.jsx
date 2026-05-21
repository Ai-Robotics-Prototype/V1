import { useStore } from '../store/useStore'

const TASK_STATES = [
  { key: 'IDLE',          label: 'Idle',       color: '#6B7280' },
  { key: 'SELECT_TARGET', label: 'Select',     color: '#8B5CF6' },
  { key: 'APPROACH',      label: 'Approach',   color: '#2563EB' },
  { key: 'PREGRASP',      label: 'Pre-Grasp',  color: '#0284C7' },
  { key: 'GRASP',         label: 'Grasp',      color: '#16A34A' },
  { key: 'LIFT',          label: 'Lift',       color: '#65A30D' },
  { key: 'PLACE',         label: 'Place',      color: '#D97706' },
  { key: 'RETREAT',       label: 'Retreat',    color: '#EA580C' },
  { key: 'HOME',          label: 'Home',       color: '#6B7280' },
]

export default function TaskFlowPanel() {
  const taskState = useStore((s) => s.task.state)
  const activeIdx = TASK_STATES.findIndex((s) => s.key === taskState)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '5px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          Task Flow
        </span>
        {activeIdx >= 0 && (
          <span style={{
            fontSize: 9, padding: '1px 5px', borderRadius: 6,
            background: TASK_STATES[activeIdx].color + '20',
            color: TASK_STATES[activeIdx].color,
          }}>
            {TASK_STATES[activeIdx].label}
          </span>
        )}
      </div>
      <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {TASK_STATES.map((s, i) => {
          const isActive = i === activeIdx
          const isDone   = activeIdx > 0 && i < activeIdx
          return (
            <div key={s.key} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '3px 6px', borderRadius: 5,
              background: isActive ? s.color + '18' : 'transparent',
              border:     `1px solid ${isActive ? s.color : 'transparent'}`,
            }}>
              <div style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: isActive ? s.color : isDone ? '#10B981' : 'var(--border)',
              }} />
              <span style={{
                fontSize: 10,
                fontWeight: isActive ? 700 : 400,
                color: isActive ? s.color : isDone ? '#10B981' : 'var(--text-muted)',
                flex: 1,
              }}>
                {s.label}
              </span>
              {isDone && (
                <span style={{ fontSize: 9, color: '#10B981' }}>✓</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
