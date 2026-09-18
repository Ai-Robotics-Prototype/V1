import IOPortMap from '../components/IOPortMap'
import DeviceManagementPanel from '../components/DeviceManagementPanel'

// I/O tab — routes to the v2 Port Map ONLY. The legacy IOPanel
// (a flat list mirror of digital / analog port states) used to
// mount inline below the map on the same page; both surfaces were
// showing at once, and depending on scroll position the OLD panel
// was what the operator saw first on tab activation. Removed
// 2026-07-22 after IOPortMap v2 landed with live values + manual
// actuation. IOPanel.jsx is now dead code and has been deleted.
//
// 2026-09-18 add-58 §687: DeviceManagementPanel lives below the
// port map. Same page keeps the "operator settings" surfaces
// discoverable in one place; a separate Settings tab would be a
// second navigation site to reason about.
export default function IOPage() {
  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'auto',
      background: '#fff',
      display: 'flex', flexDirection: 'column',
      padding: '14px 14px 0',
      boxSizing: 'border-box',
    }}>
      <IOPortMap />
      <DeviceManagementPanel />
    </div>
  )
}
