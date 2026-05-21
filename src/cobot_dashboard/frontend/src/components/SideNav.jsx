const NAV_ITEMS = [
  { id: 'monitor',   icon: '◫',  label: 'Monitor'   },
  { id: 'scene',     icon: '⬡',  label: 'Scene'     },
  { id: 'sensors',   icon: '◉',  label: 'Sensors'   },
  { id: 'program',   icon: '≡',  label: 'Program'   },
  { id: 'configure', icon: '⚙',  label: 'Configure' },
]

export default function SideNav({ tab, onTabChange }) {
  return (
    <aside style={{
      width: 48, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      paddingTop: 8, paddingBottom: 8, gap: 4,
    }}>
      {NAV_ITEMS.map((item) => {
        const isActive = tab === item.id
        return (
          <button
            key={item.id}
            onClick={() => onTabChange(item.id)}
            title={item.label}
            style={{
              width: 36, height: 36, borderRadius: 'var(--radius-md)',
              border: 'none',
              background: isActive ? 'var(--accent-dim)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              fontSize: 17, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all .15s',
            }}
          >
            {item.icon}
          </button>
        )
      })}
    </aside>
  )
}
