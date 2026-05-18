import { useEffect } from 'react'
import { useStore } from './store/useStore'
import TopBar from './components/TopBar'
import SideNav from './components/SideNav'
import StatusBar from './components/StatusBar'
import ToastContainer from './components/ToastContainer'
import EStopOverlay from './components/EStopOverlay'
import MonitorLayout from './layouts/MonitorLayout'
import ProgramLayout from './layouts/ProgramLayout'
import View3DLayout from './layouts/View3DLayout'
import SensorsLayout from './layouts/SensorsLayout'
import ConfigureLayout from './layouts/ConfigureLayout'

const gridStyle = {
  display: 'grid',
  gridTemplateAreas: '"topbar topbar" "sidenav content" "sidenav statusbar"',
  gridTemplateColumns: '64px 1fr',
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
    monitor:   <MonitorLayout />,
    program:   <ProgramLayout />,
    '3dview':  <View3DLayout />,
    sensors:   <SensorsLayout />,
    configure: <ConfigureLayout />,
  }

  return (
    <div style={gridStyle}>
      <div style={{ gridArea: 'topbar' }}>
        <TopBar />
      </div>
      <div style={{ gridArea: 'sidenav', borderRight: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
        <SideNav />
      </div>
      <div style={{ gridArea: 'content', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {layoutMap[activeTab] ?? <MonitorLayout />}
      </div>
      <div style={{ gridArea: 'statusbar' }}>
        <StatusBar />
      </div>

      <ToastContainer />
      <EStopOverlay />
    </div>
  )
}
