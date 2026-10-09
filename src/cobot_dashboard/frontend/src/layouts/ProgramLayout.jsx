import ProgramEditor from '../components/ProgramEditor'

// Program tab — full-width program editor, nothing else. The previous
// 3-panel arrangement (steps + 3D viewer + jog pendant, resizable
// dividers, expand-to-fullscreen chrome) was retired 2026-07-23:
//
//   * 3D viewer lives in the 3D View tab (View3DLayout).
//   * Jogging from the Program tab now flows exclusively through the
//     per-step TeachOverlay that ProgramEditor already renders — the
//     overlay uses the same WS jog transport, safety gates, state
//     banners, alarm modals, and Home/E-STOP wiring as the persistent
//     pendant did. No new verbs; monitor_only / allow_io posture is
//     unchanged.
//   * Global Run/Pause/Stop live in ControlStrip (bottom of the app
//     shell); E-STOP lives in TopBar. Both are always visible while
//     the Program tab is active — the pendant's copies of those
//     buttons were duplicates.
//
// The old ProgramLayout carried three panel components + resize state
// + expand chrome + a fully unused `JogPanel` fallback (`JogControls`
// was rendered instead). All of that was dead weight now that the
// teach-in-modal flow covers every jog use case the Program tab has.
export default function ProgramLayout() {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      padding: 8, boxSizing: 'border-box',
      gap: 8,
    }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <ProgramEditor />
      </div>
    </div>
  )
}
