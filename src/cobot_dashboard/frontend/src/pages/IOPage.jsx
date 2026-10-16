import IOPortMap from '../components/IOPortMap'

// I/O tab — routes to the v2 Port Map ONLY. The legacy IOPanel
// (a flat list mirror of digital / analog port states) used to
// mount inline below the map on the same page; both surfaces were
// showing at once, and depending on scroll position the OLD panel
// was what the operator saw first on tab activation. Removed
// 2026-07-22 after IOPortMap v2 landed with live values + manual
// actuation. IOPanel.jsx is now dead code and has been deleted.
//
// 2026-09-21 operator directive: DeviceManagementPanel RETIRED
// from this page. The paired-devices list added at add-58 §687
// was a settings surface parked on I/O for discoverability; the
// operator does not want it flashing here on tab nav. If the list
// is needed again it belongs on a dedicated Settings tab, not
// alongside operational I/O.
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
    </div>
  )
}
