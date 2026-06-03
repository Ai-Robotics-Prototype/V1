import { useEffect, Component } from 'react'
import { useStore } from './store/useStore'
import TopBar from './components/TopBar'
import StatusBar from './components/StatusBar'
import ToastContainer from './components/ToastContainer'
import EStopOverlay from './components/EStopOverlay'
import MonitorDashboard from './pages/MonitorDashboard'
import ProgramLayout from './layouts/ProgramLayout'
import View3DLayout from './layouts/View3DLayout'
import SensorsLayout from './layouts/SensorsLayout'
import ConfigureLayout from './layouts/ConfigureLayout'
import AdaptivePicking from './pages/AdaptivePicking'
import ProgramLibrary from './pages/ProgramLibrary'
import IOPage from './pages/IOPage'
import SafetyPage from './pages/SafetyPage'

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

const gridStyle = {
  display: 'grid',
  gridTemplateAreas: '"topbar" "content" "statusbar"',
  gridTemplateColumns: '1fr',
  gridTemplateRows: '48px 1fr 36px',
  height: '100vh',
  overflow: 'hidden',
  background: 'var(--bg-app)',
}

export default function App() {
  const connectWS = useStore((s) => s.connectWS)
  const activeTab = useStore((s) => s.activeTab)

  useEffect(() => {
    connectWS()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const layoutMap = {
    monitor:          <MonitorDashboard />,
    programs:         <ProgramLibrary />,
    program:          <ProgramLayout />,
    '3dview':         <View3DLayout />,
    sensors:          <SensorsLayout />,
    io:               <IOPage />,
    adaptive_picking: <AdaptivePicking />,
    configure:        <ConfigureLayout />,
    safety:           <SafetyPage />,
  }

  return (
    <ErrorBoundary>
      <div style={gridStyle}>
        <div style={{ gridArea: 'topbar' }}>
          <TopBar />
        </div>
        <div style={{ gridArea: 'content', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ErrorBoundary>
            {layoutMap[activeTab] ?? <MonitorDashboard />}
          </ErrorBoundary>
        </div>
        <div style={{ gridArea: 'statusbar' }}>
          <StatusBar />
        </div>

        <ToastContainer />
        <EStopOverlay />
      </div>
    </ErrorBoundary>
  )
}
