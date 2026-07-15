import { useEffect, Component } from 'react'
import { useStore } from './store/useStore'
import TopBar from './components/TopBar'
import StatusBar from './components/StatusBar'
import ToastContainer from './components/ToastContainer'
import EStopOverlay from './components/EStopOverlay'
import AlarmRecoveryModal from './components/AlarmRecoveryModal'
import ObstacleEscapeModal from './components/ObstacleEscapeModal'
import ViewportDebug from './components/ViewportDebug'
import MonitorDashboard from './pages/MonitorDashboard'
import ProgramLayout from './layouts/ProgramLayout'
import View3DLayout from './layouts/View3DLayout'
import SensorsLayout from './layouts/SensorsLayout'
import ConfigureLayout from './layouts/ConfigureLayout'
import AdaptivePicking from './pages/AdaptivePicking'
import ProgramLibrary from './pages/ProgramLibrary'
import IOPage from './pages/IOPage'
import SafetyPage from './pages/SafetyPage'
import QualityInspectionLayout from './layouts/QualityInspectionLayout'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0, background: '#0C0C0E',
          color: '#EF4444', fontFamily: 'monospace',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: 40, gap: 16,
        }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>React Render Error</div>
          <div style={{
            background: '#1A0A0A', border: '1px solid #EF4444',
            borderRadius: 8, padding: '16px 24px',
            maxWidth: 800, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontSize: 13, color: '#FCA5A5',
          }}>
            {this.state.error.toString()}
            {this.state.error.stack ? '\n\n' + this.state.error.stack : ''}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              background: '#DC2626', border: 'none', color: '#fff',
              padding: '8px 20px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// App shell.
// - width/maxWidth: pin to viewport (sw=iw measurements confirm no overflow).
// - height inherits 100dvh from #root via tokens.css, so the bottom row
//   isn't clipped under Chrome's dynamic address bar.
// - Safe-area paddings keep edge elements (E-STOP top-right, Connected
//   status, StatusBar row at the bottom) off the physical screen edge
//   on the ONN 11" tablet. The +12px on the right is explicit
//   breathing room beyond the safe-area inset since the device reports
//   zero inset in landscape but the rightmost cluster still felt flush.
const gridStyle = {
  display: 'grid',
  gridTemplateAreas: '"topbar" "content" "statusbar"',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gridTemplateRows: '60px minmax(0, 1fr) 36px',
  width: '100%',
  maxWidth: '100vw',
  height: '100%',
  paddingLeft:   'env(safe-area-inset-left, 0px)',
  paddingRight:  'calc(env(safe-area-inset-right, 0px) + 12px)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  overflow: 'hidden',
  background: 'var(--bg-app)',
  boxSizing: 'border-box',
}

export default function App() {
  const connectWS       = useStore((s) => s.connectWS)
  const activeTab       = useStore((s) => s.activeTab)
  const hydrateCells    = useStore((s) => s.hydrateCells)
  const hydratePrograms = useStore((s) => s.hydratePrograms)

  useEffect(() => {
    connectWS()
    // Hydrate cells + programs from their respective endpoints at
    // app boot so any tab the operator lands on first — Configure,
    // 3D View, Program, Program Library — sees a populated state on
    // its first render. Also re-hydrate when the tab regains focus
    // so out-of-band changes (another session, a fresh deploy)
    // propagate without a page refresh. The store throttles
    // redundant calls.
    hydrateCells()
    hydratePrograms()
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        hydrateCells()
        hydratePrograms()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tab navigation re-hydrate. When the operator switches INTO the
  // Configure tab the cells section needs fresh data — without this,
  // Configure relied on its own mount-effect fetch which silently
  // swallowed any transient failure and left the list at "No cells
  // commissioned yet" until manual page refresh. Same idea for the
  // Programs library: a tab switch should never flash an empty list
  // before the data arrives.
  // The store throttles within a 500 ms window so this is cheap.
  useEffect(() => {
    if (['configure', '3dview', 'program', 'adaptive_picking'].includes(activeTab)) {
      hydrateCells()
    }
    if (['programs', 'program'].includes(activeTab)) {
      hydratePrograms()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  const layoutMap = {
    monitor:          <MonitorDashboard />,
    programs:         <ProgramLibrary />,
    sensors:          <SensorsLayout />,
    io:               <IOPage />,
    adaptive_picking: <AdaptivePicking />,
    quality_inspection: <QualityInspectionLayout />,
    configure:        <ConfigureLayout />,
    safety:           <SafetyPage />,
  }

  // Keep the two 3D-heavy tabs persistently mounted, toggled by CSS
  // display, so switching between them doesn't tear down the Canvas +
  // URDFLoader and re-parse all 7 GLBs. Other tabs unmount as before.
  const kept3D  = ['program', '3dview']
  const isKept  = kept3D.includes(activeTab)
  const other   = !isKept ? (layoutMap[activeTab] ?? <MonitorDashboard />) : null
  const keptStyle = (tab) => ({
    display: activeTab === tab ? 'flex' : 'none',
    flex: 1, minHeight: 0, flexDirection: 'column',
  })

  return (
    <ErrorBoundary>
      <div style={gridStyle}>
        <div style={{ gridArea: 'topbar', minWidth: 0, overflow: 'hidden' }}>
          <TopBar />
        </div>
        <div style={{ gridArea: 'content', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ErrorBoundary>
            <div style={keptStyle('program')}><ProgramLayout /></div>
            <div style={keptStyle('3dview')}><View3DLayout /></div>
            {other}
          </ErrorBoundary>
        </div>
        <div style={{ gridArea: 'statusbar', minWidth: 0, overflow: 'hidden' }}>
          <StatusBar />
        </div>

        <ToastContainer />
        <EStopOverlay />
        <AlarmRecoveryModal />
        <ObstacleEscapeModal />
        <ViewportDebug />
      </div>
    </ErrorBoundary>
  )
}
