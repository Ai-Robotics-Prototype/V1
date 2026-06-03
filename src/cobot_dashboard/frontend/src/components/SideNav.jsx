import { useStore } from '../store/useStore'

const TOP_ITEMS = [
  { icon: '📷', label: 'Camera', view: 'split' },
  { icon: '📡', label: 'LiDAR',  view: 'lidar' },
  { icon: '🦾', label: 'Arm',    view: 'arm' },
  { icon: '⊞',  label: 'Split',  view: 'split' },
  { icon: '🗂',  label: 'Scene',  view: 'scene' },
  { icon: '📦', label: 'Parts',  view: 'parts' },
]

export default function SideNav() {
  const activeTab  = useStore((s) => s.activeTab)
  const activeView = useStore((s) => s.activeView)
  const setView    = useStore((s) => s.setView)
  const setTab     = useStore((s) => s.setTab)

  // Every sidebar view lives inside MonitorLayout, so a sidebar click
  // must also switch the top tab back to 'monitor' — otherwise nothing
  // visible changes when the user is on e.g. Programs or Configure.
  function selectView(view) {
    setView(view)
    setTab('monitor')
  }

  function NavItem({ icon, label, onClick, isActive }) {
    return (
      <button
        onClick={onClick}
        title={label}
        style={{
          width: 64,
          height: 48,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          background: isActive ? 'rgba(255,255,255,0.09)' : 'transparent',
          border: 'none',
          cursor: 'pointer',
          transition: 'background 150ms',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.background = 'transparent'
        }}
      >
        <span style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span>
        <span style={{
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight: 500,
        }}>
          {label}
        </span>
      </button>
    )
  }

  return (
    <div style={{
      width: 64,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      paddingTop: 4,
    }}>
      {/* Top items */}
      {TOP_ITEMS.map((item) => (
        <NavItem
          key={item.label}
          icon={item.icon}
          label={item.label}
          isActive={activeTab === 'monitor' && activeView === item.view}
          onClick={() => selectView(item.view)}
        />
      ))}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Bottom: Config */}
      <NavItem
        icon="⚙"
        label="Config"
        isActive={false}
        onClick={() => setTab('configure')}
      />
    </div>
  )
}
