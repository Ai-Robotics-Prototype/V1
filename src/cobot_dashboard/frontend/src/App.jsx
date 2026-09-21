import { useEffect, useMemo, useRef, useState, Component } from 'react'
import { useStore } from './store/useStore'
import { isFeatureEnabled, TAB_TO_FEATURE } from './lib/edition'
import DevicePairingWizard from './components/DevicePairingWizard'
import PairRequestModal from './components/PairRequestModal'
import LoginModal from './components/LoginModal'
import TopBar from './components/TopBar'
import StatusBar from './components/StatusBar'
import StaleCodegenBanner from './components/StaleCodegenBanner'
import ControllerOfflineBanner from './components/ControllerOfflineBanner'
import ToastContainer from './components/ToastContainer'
import EStopOverlay from './components/EStopOverlay'
import AlarmRecoveryModal from './components/AlarmRecoveryModal'
import JointRecoveryModal from './components/JointRecoveryModal'
import ObstacleEscapeModal from './components/ObstacleEscapeModal'
import SelfCollisionWarnBanner from './components/SelfCollisionWarnBanner'
import HardStopToast from './components/HardStopToast'
import DeployStatusBanner from './components/DeployStatusBanner'
import StaleGuard from './components/StaleGuard'
import StaleOverrideIndicator from './components/StaleOverrideIndicator'
import CartSofteningToast from './components/CartSofteningToast'
import WristWindIndicator from './components/WristWindIndicator'
import PausedPresenter from './components/PausedPresenter'
import ViewportDebug from './components/ViewportDebug'
import JogDebugPanel from './components/JogDebugPanel'
import MonitorDashboard from './pages/MonitorDashboard'
import ProgramLayout from './layouts/ProgramLayout'
import View3DLayout from './layouts/View3DLayout'
import SensorsLayout from './layouts/SensorsLayout'
import ConfigureLayout from './layouts/ConfigureLayout'
import AdaptivePicking from './pages/AdaptivePicking'
import ProgramLibrary from './pages/ProgramLibrary'
import SafetyPage from './pages/SafetyPage'
import EventLog from './pages/EventLog'
import SynapsePage from './pages/SynapsePage'
import FleetHome from './pages/FleetHome'
import { pickLandingView } from './lib/fleet'

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

// Double-gate wrapper (2026-09-21 regression sweep). The wizard's
// Screen wrapper is a full-viewport #0C0C0E overlay — even one
// frame is visible as a black flash. This wrapper acts as the
// SECOND gate: it mounts the wizard ONLY after confirming the
// backend actually requires pairing (probe /api/paired_devices ==
// 401). The first gate (App's event listener) already covers the
// stale-token race; this one is belt-and-suspenders against any
// path that flips needsPair=true directly.
function DevicePairingWizardOverlay({ needsPair, onDismiss, onPaired }) {
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => {
    if (!needsPair) { setConfirmed(false); return }
    let alive = true
    ;(async () => {
      try {
        const res = await fetch('/api/paired_devices', {
          credentials: 'omit',
          cache:       'no-store',
        })
        if (!alive) return
        if (res.ok) {
          // Backend does not require pairing — swallow the mount
          // request. Never let the black Screen wrapper flash.
          // eslint-disable-next-line no-console
          console.warn('[wizard-overlay] skipped mount — backend unenforced')
          onDismiss()
          return
        }
        setConfirmed(true)   // 401 → legitimately mount
      } catch (_) {
        if (!alive) return
        setConfirmed(true)   // network error → mount so operator can retry
      }
    })()
    return () => { alive = false }
  }, [needsPair, onDismiss])
  if (!needsPair || !confirmed) return null
  return (
    <DevicePairingWizard onComplete={onPaired} onSkip={onDismiss} />
  )
}

// TEMPORARY 2026-09-21 lag diagnostic. Fixed overlay top-right that
// shows: App render count since mount, elapsed since last render,
// long-task count from the Performance API, active setInterval
// timers count (approx). Visible when URL has ?perf=1 OR when the
// build was made with VITE_PERF_OVERLAY=1. Never enabled in
// production — this block is deleted before shipping the fix.
function PerfOverlay() {
  const appRenderCount = useRef(0)
  appRenderCount.current += 1
  const lastRenderAtRef = useRef(performance.now())
  const now = performance.now()
  const sinceLast = Math.round(now - lastRenderAtRef.current)
  lastRenderAtRef.current = now
  const [longTasks, setLongTasks] = useState(0)
  const [displayedRenders, setDisplayedRenders] = useState(0)
  const [displayedSinceLast, setDisplayedSinceLast] = useState(0)
  useEffect(() => {
    // Redraw the overlay every 500 ms with the latest numbers
    // WITHOUT causing extra App renders (we only re-render this
    // component, not the parent).
    const iv = setInterval(() => {
      setDisplayedRenders(appRenderCount.current)
      setDisplayedSinceLast(Math.round(performance.now()
                                         - lastRenderAtRef.current))
    }, 500)
    return () => clearInterval(iv)
  }, [])
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return undefined
    let count = 0
    try {
      const obs = new PerformanceObserver((list) => {
        count += list.getEntries().length
        setLongTasks(count)
      })
      obs.observe({ entryTypes: ['longtask'] })
      return () => { try { obs.disconnect() } catch (_) { /* nop */ } }
    } catch (_) {
      return undefined
    }
  }, [])
  const enabled = (typeof window !== 'undefined'
                    && /[?&]perf=1(&|$)/.test(window.location.search))
  if (!enabled) return null
  return (
    <div
      data-testid="perf-overlay"
      style={{
        position: 'fixed', top: 6, right: 6, zIndex: 999999,
        padding: '6px 10px', borderRadius: 6,
        background: 'rgba(0,0,0,0.85)', color: '#F0F0F2',
        fontFamily: 'ui-monospace, monospace', fontSize: 11,
        pointerEvents: 'none', lineHeight: 1.35,
        border: '1px solid #444',
      }}
    >
      <div>App renders: <b>{displayedRenders}</b></div>
      <div>Since last: <b>{displayedSinceLast} ms</b></div>
      <div>Long tasks (&gt;50ms): <b>{longTasks}</b></div>
    </div>
  )
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
  // Auth model pivot (add-61 §690, 2026-09-18). The dashboard NO
  // LONGER blocks on the pairing wizard for unauthenticated
  // clients — everyone sees the dashboard in view-only mode, and
  // control actions trigger the LoginModal when unauth+enforced.
  // The wizard is still reachable via `roboai-pair-required`
  // (device-trust legacy path) but doesn't gate the app.
  const [needsPair, setNeedsPair] = useState(false)
  useEffect(() => {
    // Confirmation gate (2026-09-21 regression sweep). A spurious
    // `roboai-pair-required` event during nav caused the entire
    // dashboard to unmount and render the black wizard for one
    // frame. Before honouring the event, probe /api/paired_devices
    // WITHOUT credentials — if the backend answers 200 the pairing
    // middleware is inert (dev posture, PAIRING_ENFORCED=0) and
    // the event is stale (e.g., a race, a transient WS close from
    // a mid-nav browser hiccup). Only a real 401 should mount the
    // wizard. The old behaviour (mount on any dispatch) is a
    // permanent hazard because the wizard's Screen bg is a full
    // viewport #0C0C0E — even a one-frame flash is loud.
    const onReq = async (ev) => {
      try {
        const res = await fetch('/api/paired_devices', {
          credentials: 'omit',
          cache:       'no-store',
        })
        if (res.ok) {
          // Backend does not require pairing. Ignore the event.
          // Log the ignore so a future regression is visible in
          // the console rather than silently swallowed.
          // eslint-disable-next-line no-console
          console.warn(
            '[pair-required] ignored — backend is unenforced',
            (ev && ev.detail) || {})
          return
        }
      } catch (_) {
        // Network error during probe: fall through and mount the
        // wizard — a hard failure is exactly when the operator
        // needs a way to re-pair.
      }
      setNeedsPair(true)
    }
    window.addEventListener('roboai-pair-required', onReq)
    return () => window.removeEventListener('roboai-pair-required', onReq)
  }, [])

  // Fleet-home landing decision (2026-09-21 operator directive,
  // 2026-09-21 regression sweep). `fleetTotal` is self + Avahi-
  // discovered peers. When >1 the app lands in the fleet grid; when
  // ≤1 the grid is skipped entirely and the dashboard renders as
  // today (single-robot-skips-grid). The URL param `view` is
  // authoritative when present so the "Back to fleet" chip in TopBar
  // can override the count-based default.
  //
  // Bug B (regression sweep 2026-09-21): the landing decision must
  // NEVER re-evaluate mid-navigation with an intermediate registry
  // value. `showFleetHome` is memoized on the SETTLED signals
  // (fleetHydrated + fleetTotal) and window.location.search — none
  // of which change on `setTab(...)`. A tab click therefore CANNOT
  // flip showFleetHome, which pins that FleetHome does not mount
  // for one frame during in-app navigation.
  const fleetTotal    = useStore((s) => s.fleetTotal)
  const fleetHydrated = useStore((s) => s.fleetHydrated)
  const hydrateFleet  = useStore((s) => s.hydrateFleet)
  useEffect(() => { hydrateFleet() }, [hydrateFleet])
  const showFleetHome = useMemo(() => {
    if (!fleetHydrated) return false
    if (fleetTotal <= 1) return false           // single-robot-skips-grid
    const urlSearch = (typeof window !== 'undefined'
                        ? window.location.search : '')
    return pickLandingView({ totalRobots: fleetTotal, urlSearch }) === 'fleet'
  }, [fleetHydrated, fleetTotal])
  const connectWS       = useStore((s) => s.connectWS)
  const activeTab       = useStore((s) => s.activeTab)
  const hydrateCells    = useStore((s) => s.hydrateCells)
  const hydratePrograms = useStore((s) => s.hydratePrograms)
  const hydrateEdition  = useStore((s) => s.hydrateEdition)
  const edition         = useStore((s) => s.edition)
  const setTab          = useStore((s) => s.setTab)
  const setSynapseIOSectionOpen = useStore(
    (s) => s.setSynapseIOSectionOpen)
  const restoreOpenProgramOnMount = useStore(
    (s) => s.restoreOpenProgramOnMount)

  // 2026-09-21 operator directive: the standalone `io` tab is
  // retired. A stale persisted activeTab='io' (localStorage
  // roboai-ui) OR a bookmark to the old I/O route must land on
  // the Synapse page with the "Main Internal Robot Controller I/O"
  // section auto-expanded. Old-route redirect is a MOUNT-ONCE
  // effect that fires whenever activeTab flips to 'io' — the flag
  // is cleared inside SynapsePage on mount so the next visit
  // keeps the section collapsed-by-default.
  useEffect(() => {
    if (activeTab === 'io') {
      setSynapseIOSectionOpen(true)
      setTab('synapse')
    }
  }, [activeTab, setTab, setSynapseIOSectionOpen])

  useEffect(() => {
    connectWS()
    // Edition hydrate on boot — the TopBar tab filter, the App
    // layoutMap gate below, and every FeatureGate inside pages read
    // useStore.edition, which starts at 'basic' (tablet-safe
    // default). Hydrating first keeps a Full-only tab from
    // flash-rendering on a Full PC during the initial paint.
    hydrateEdition()
    // 2026-08-05 (refresh persistence, fork registry:
    // page_context_persistence): rehydrate the last-open program
    // for THIS device from the server. If a draft with a
    // staged_program exists, that (unsaved edits) wins over the
    // disk-saved copy — same doctrine as record-through for
    // poses. Blank state only when the device has never opened
    // a program.
    restoreOpenProgramOnMount()
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

  // 2026-09-21 operator directive: `io` tab retired. IOPage is no
  // longer routed by the layoutMap; a stale persisted activeTab='io'
  // is handled by the redirect effect below (setTab('synapse') +
  // synapseIOSectionOpen=true). IOPortMap now mounts inside
  // pages/SynapsePage's expandable section.
  const layoutMap = {
    monitor:          <MonitorDashboard />,
    programs:         <ProgramLibrary />,
    sensors:          <SensorsLayout />,
    adaptive_picking: <AdaptivePicking />,
    configure:        <ConfigureLayout />,
    safety:           <SafetyPage />,
    event_log:        <EventLog />,
    synapse:          <SynapsePage />,
  }

  // Edition gate for the layout switch (2026-09-04, extended
  // 2026-09-08). If activeTab resolves to a Full-only page but this
  // device is on basic, fall back to Monitor so a stale persisted
  // tab id (from a session where the device was Full and got
  // re-locked) doesn't render a dead surface. TopBar already
  // hides the tab; this is defence-in-depth for the persisted-
  // activeTab class.
  //
  // 2026-09-08 tab-persistence race: `edition` starts at its
  // initial default ('basic') and hydrates async via /api/edition.
  // If we snap to Monitor on first render (before hydration
  // completes), a Full device with a persisted full-only tab
  // would get bounced to Monitor for one tick. Gate the snap on
  // `editionHydrated` so the guard only fires after the server
  // has answered.
  const editionHydrated = useStore((s) => s.editionHydrated)
  const _tabFeature = TAB_TO_FEATURE[activeTab] || activeTab
  const _tabAllowed = isFeatureEnabled(_tabFeature, edition)
  useEffect(() => {
    if (!editionHydrated) return
    if (!_tabAllowed && activeTab !== 'monitor') setTab('monitor')
  }, [editionHydrated, _tabAllowed, activeTab, setTab])

  // Keep the two 3D-heavy tabs persistently mounted, toggled by CSS
  // display, so switching between them doesn't tear down the Canvas +
  // URDFLoader and re-parse all 7 GLBs. Other tabs unmount as before.
  const kept3D  = ['program', '3dview']
  const isKept  = kept3D.includes(activeTab)
  // Only apply the "not-allowed → Monitor" fallback AFTER edition
  // hydrates. Before that, the initial default 'basic' would make a
  // real Full device flash Monitor for one paint before hydrateEdition
  // corrects the edition and re-renders the intended tab.
  const _tabPassesGate = _tabAllowed || !editionHydrated
  const other   = !isKept
    ? (_tabPassesGate ? (layoutMap[activeTab] ?? <MonitorDashboard />) : <MonitorDashboard />)
    : null
  const keptStyle = (tab) => ({
    display: activeTab === tab ? 'flex' : 'none',
    flex: 1, minHeight: 0, flexDirection: 'column',
  })

  // Fleet-home landing (2026-09-21). Before pair wizard because the
  // grid is VIEW-tier — no auth required — and lets the operator
  // pick a robot before that robot's own control-auth kicks in.
  // Gated on the memoized `showFleetHome` — the settled decision;
  // never re-evaluates on in-app navigation (see bug B fix above).
  if (showFleetHome) {
    return <FleetHome />
  }

  // 2026-09-21 regression sweep: DevicePairingWizard is now an
  // OVERLAY (rendered inside the dashboard tree, last), NOT a top-
  // level return branch. Field bug B root cause: any spurious
  // `roboai-pair-required` event (WS transient close, stale-token
  // 401) would flip `needsPair=true` and the dashboard tree
  // UNMOUNTED — every mounted page (IOPage, MonitorDashboard, the
  // 3D twin) was destroyed and remounted on the next flip. The
  // operator saw a black flash on I/O navigation because the
  // wizard's Screen (full-viewport `#0C0C0E` bg, zIndex 9999)
  // renders in front of the dashboard tree. Fix: keep the tree
  // ALIVE and layer the wizard on top when needed. Its own
  // fixed-position styling already covers the dashboard when
  // mounted; on unmount, the dashboard is right where it was.
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

        <StaleCodegenBanner />
        <ControllerOfflineBanner />
        {/* 2026-09-08 (revised, later same day): SystemBanners retired
            per operator directive. Guard-state visibility moves into
            the StatusBar footer as compact full-only text; disconnect
            no longer surfaces its own banner. StaleCodegenBanner +
            DeployStatusBanner still handle their own targeted cases. */}
        <ToastContainer />
        <EStopOverlay />
        <AlarmRecoveryModal />
        {/* 2026-08-05 (guided recovery, Lesson 165 extension) — offers
            the press-and-hold escape move when a joint is past the
            escape-only zone. Rendered above the surface-specific
            layouts so it appears on the teach overlay + Monitor +
            jog page from a single mount. */}
        <JointRecoveryModal />
        <SelfCollisionWarnBanner />
        <ObstacleEscapeModal />
        {/* 2026-08-05 (operator directive: clearance warnings OFF).
            Global toast-emitter for self/ground hard-stop events.
            Reads canonical robot.stop_cause_copy (translator lives
            in dashboard_server _jog_stop_cause_operator_copy) —
            no re-parsing of driver text, fork-registry-safe. */}
        <HardStopToast />
        {/* PausedPresenter renders the caution-styled paused overlay
            and its persistent banner. Distinct pipeline from
            AlarmRecoveryModal above (which owns the red alarm
            treatment); alarms outrank paused via deriveRunState's
            precedence, so a real alarm during pause hides the amber
            and shows the red. */}
        <PausedPresenter />
        <DeployStatusBanner />
        {/* StaleGuard is a BLOCKING modal — mounted last so it
            paints above every other panel/toast/banner. Rendering
            an empty tree when no mismatch → cost of the mount is
            a single subscription to useStore.staleProvenance. */}
        <StaleGuard />
        {/* Persistent pill visible whenever the operator has used
            the escape hatch. Surfaces the fact that the tab is
            running without the guard's guarantee — clear by
            clicking the pill. */}
        <StaleOverrideIndicator />
        {/* 2026-08-28 wrist-friendly hold: toast the moment
            cartesian scaling engages so the operator hears
            "slowed — J6 near its speed limit" without needing
            the Event Log. */}
        <CartSofteningToast />
        {/* Persistent wrist-wind indicator when J4/J6 exceed
            ±150°. Silent otherwise. */}
        <WristWindIndicator />
        <ViewportDebug />
        <JogDebugPanel />
        <PairRequestModal />
        <LoginModal />
        <PerfOverlay />
        {/* Device-pairing wizard as an OVERLAY (not a top-level
            return). Its own Screen wrapper positions fixed at
            zIndex 9999 and covers the viewport when mounted; when
            needsPair goes back to false, the wizard unmounts and
            the dashboard behind it is exactly where the operator
            left it. Fixes the 2026-09-21 IO-tab black-flash bug
            (see the operator's field report + commit body).
            Wizard is skipped entirely under !needsPair — cheap.
            The event listener already probes /api/paired_devices
            before setting needsPair=true; the wizard renders only
            after that gate has said "yes, we do need this". */}
        <DevicePairingWizardOverlay
          needsPair={needsPair}
          onDismiss={() => setNeedsPair(false)}
          onPaired={() => {
            setNeedsPair(false)
            try { connectWS() } catch (_) { /* nop */ }
            try { hydrateEdition() } catch (_) { /* nop */ }
          }}
        />
      </div>
    </ErrorBoundary>
  )
}
