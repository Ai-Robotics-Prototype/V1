import { useState } from 'react'

const NAV_ITEMS = [
  { id: 'cameras', icon: '📷', label: 'Cameras'  },
  { id: 'lidar',   icon: '🔵', label: 'LiDAR'    },
  { id: 'scene',   icon: '🗂',  label: 'Scene'    },
  { id: 'safety',  icon: '🛡',  label: 'Safety'   },
]

export default function SideNav() {
  const [active, setActive] = useState('cameras')

  return (
    <aside style={{
      width: 48, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      paddingTop: 8, paddingBottom: 8, gap: 4,
    }}>
      {NAV_ITEMS.map((item) => {
        const isActive = active === item.id
        return (
          <button
            key={item.id}
            onClick={() => setActive(item.id)}
            title={item.label}
            style={{
              width: 36, height: 36, borderRadius: 'var(--radius-md)',
              border: 'none',
              background: isActive ? 'var(--accent-dim)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              fontSize: 16, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all .15s',
            }}
          >
            {item.icon}
          </button>
        )
      })}

      <div style={{ flex: 1 }} />

      {/* Settings */}
      <button
        title="Settings"
        style={{
          width: 36, height: 36, borderRadius: 'var(--radius-md)',
          border: 'none', background: 'transparent',
          color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        ⚙
      </button>
    </aside>
  )
}
