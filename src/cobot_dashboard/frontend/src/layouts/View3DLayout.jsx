import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import ArmViewer3D from '../components/ArmViewer3D'
import StandaloneRobot from '../components/StandaloneRobot'
import OrientFlangeDownControl from '../components/QuickOrientButtons'
import JogControls from '../components/JogControls'
import ArmEnableControl from '../components/ArmEnableControl'
import JogReadyBadge from '../components/JogReadyBadge'
// 2026-09-08 operator directive: MODE • MANUAL chip + its confirm
// dialog RETIRED. Mode switching from the UI is gone; operators
// route mode via the physical pendant selector. Backend endpoint
// (POST /api/estun/mode) stays live for CRI / driver internal use.
//
// 2026-09-14 operator directive: JointJogPanel (right-dock J1..J6
// sliders + PREVIEWING banner + Cartesian mode checkbox +
// Send-to-real-arm button) and IKGizmo (Cartesian-drag twin IK,
// only ever activated by that checkbox) RETIRED from the 3D View.
// Replaced by a single "Orient Flange Down" button in the top-right
// corner region — clicking it opens a confirm modal; Continue fires
// the SAME guarded /api/estun/orient/face_down endpoint.

// The 3D View tab now hosts two jog surfaces:
//   • OrientFlangeDownControl (top-right, TWIN + REAL) — modal-gated,
//                                                        one-tap orient.
//   • JogControls             (bottom dock, REAL ARM)  — hold-to-jog
//                                                        via /cmd/jog.
//
// The REAL ARM panel is the same component the Program tab renders —
// one source of truth. Its three-state visibility (MINIMIZED / NORMAL /
// EXPANDED) lives in the Zustand store so it survives tab-switches
// without persisting to localStorage.
//
// The retired IncrementalJogPanel used to live in LeftPanel; its API
// path (/cmd/jog with delta_deg) still works, but the pendant
// increments are superseded by hold-to-jog + step-size inching.

const REAL_ARM_RED = '#7F1D1D'
// 2026-09-16 default-framing (measured, superseding the fixed-0.60
// attempt). Operator field-fail: arm still sat partly under the
// jog buttons at default framing on the tablet because the fixed
// 0.60 assumed a desktop-height jog band. Correct approach: measure
// the ACTUAL rendered jog-surface top edge via
// getBoundingClientRect at runtime, fit the arm bbox into the
// region above it with a safety margin, and recompute on load,
// resize, orientationchange, visibilitychange (PWA standalone
// launch differs from the browser tab viewport), and every jog-
// panel-mode change.
const FRAMING_MARGIN_PX = 24  // safe air gap between arm bottom
                              // and surface top so the reach dome
                              // has breathing room
const FRAMING_MIN_TOP_FRAC = 0.30  // clamp so extreme aspect
                                    // ratios don't collapse framing
const FRAMING_MAX_TOP_FRAC = 0.98  // never fill entire viewport
                                    // — a tiny bottom gutter helps
                                    // the reach dome not clip

// 2026-09-08 operator directive: left sidebar (Camera preset tiles
// + Task readout) RETIRED. The single view-switcher lives in the
// top-left corner overlay of the 3D viewport itself (ArmViewer3D's
// existing preset pill row at L1632). The 3D canvas expands to
// use the reclaimed 130 px width.
//
// TASK/IDLE readout consumers: LeftPanel was the ONLY renderer;
// no other surface reads useStore.task from this layout. Dropped
// per directive item 3 ("otherwise drop it") — task state is
// already visible on the Monitor page's StatusBadge.

// The chrome that wraps JogControls when it's docked (NORMAL) or
// expanded (EXPANDED). The 2026-08-06 operator directive retires the
// full-width red REAL ARM band in favor of the shared
// <ArmEnableControl /> chip (fork registry: arm_enable_control) —
// the ONE canonical arm-enable surface, rendered here AND on the
// Monitor page so toggling in either reflects live in the other via
// the shared useStore state.
function RealArmChrome({ mode, setMode, children, panelHeight }) {
  const isExpanded = mode === 'EXPANDED'
  return (
    <div
      data-testid="jog-floating-panel"
      style={{
        // 2026-09-16 immersive: transparent container, 3D scene
        // shows through. Only buttons/controls carry chip backgrounds.
        background: 'transparent',
        display: 'flex', flexDirection: 'column',
        overflow: 'visible',
        // 2026-09-16 side-column directive: NORMAL height is now
        // viewport-aware (View3DLayout computes it from
        // window.innerHeight) so the LEFT/RIGHT columns have room
        // to spread vertically along the edges. Floor stays at 440
        // (doctrine flow(a) contract) so short tablet aspects still
        // don't clip the CENTER pads. Legacy Program-tab consumer
        // passes no panelHeight and lands on 440.
        height: isExpanded ? '100%' : (panelHeight || 440),
        width: '100%',
        pointerEvents: 'auto',
        flexShrink: 0,
      }}>
      <div style={{
        padding: '5px 8px',
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexShrink: 0,
        // Header owns 44px minimum so it can never collapse below its
        // control heights even if a parent under-allocates space at a
        // narrow tablet width — the DISABLE/READY row is the anchor
        // controls below flow from.
        minHeight: 44,
        background: 'transparent',
      }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <ArmEnableControl />
          {/* Compact READY / NOT-READY badge next to the enable
              button — pre-jog cue at a glance. */}
          <JogReadyBadge />
        </div>
        {/* 2026-09-16 side-column directive: Collapse Jog Buttons +
            fullscreen icon MOVED OUT of this header. They now sit at
            the bottom of the RIGHT column inside JogControls, adjacent
            to Orient Flange Down (see JogControls.collapseSlot). The
            header keeps its 44 px minHeight so DISABLE/READY have
            room; the right slot of the header stays empty. */}
      </div>
      {/* 2026-09-16 correction: no internal scrollbar. Children lay
          out at their natural size over the canvas — the 3D scene
          shows THROUGH every gap between controls. */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'visible' }}>
        {children}
      </div>
    </div>
  )
}

const chromeBtn = {
  width: 26, height: 26, padding: 0,
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4,
  cursor: 'pointer', fontSize: 14, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

// The docked minimized pill — GREEN button labeled "Expand Jog
// Buttons" (matches the Monitor Run button's #16A34A green, per
// 2026-09-08 operator directive). When the jog surface is open,
// the chrome header's collapse control reads "Collapse Jog
// Buttons" — the pair stays coherent.
//
// If a jog hold is live, the button surfaces the joint + direction
// as a subtitle so a stray tab-switch operator sees the arm is
// under load; button copy stays "Expand Jog Buttons" so activation
// language is consistent.
function RealArmMinimizedPill({ setMode }) {
  const robot = useStore((s) => s.robot) || {}
  const active = !!robot.jog_active
  const holdLabel = active
    ? `J${robot.jog_index} ${robot.jog_direction > 0 ? '+' : robot.jog_direction < 0 ? '−' : ''}`
    : ''
  return (
    <button
      data-testid="expand-jog-buttons"
      onClick={() => setMode('NORMAL')}
      title="Open the jog pad"
      style={{
        position: 'absolute',
        bottom: 12, right: 12, zIndex: 15,
        padding: '12px 22px',
        background: '#16A34A', color: '#fff',
        border: 'none', borderRadius: 10,
        fontSize: 15, fontWeight: 700,
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(22,163,74,0.35)',
        display: 'flex', alignItems: 'center', gap: 10,
        minHeight: 44,
      }}
    >
      {active && (
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#FEE2E2',
          boxShadow: '0 0 6px #FCA5A5',
        }} />
      )}
      <span>Expand Jog Buttons</span>
      {holdLabel && (
        <span style={{
          fontSize: 11, opacity: 0.85, fontWeight: 600,
          fontFamily: 'var(--font-mono, monospace)',
        }}>{holdLabel}</span>
      )}
    </button>
  )
}

export default function View3DLayout() {
  const armRef = useRef(null)
  const [jogApi, setJogApi] = useState(null)
  // 2026-09-16 zoom-capture — root element ref for non-passive wheel
  // and Safari gesture listeners. Handlers attach only to THIS root,
  // never to window/document, so Monitor / Program / I/O keep their
  // native browser zoom behavior on the same session.
  const rootRef = useRef(null)

  const view3dJogPanel   = useStore((s) => s.view3dJogPanel)
  const setView3dJogPanel = useStore((s) => s.setView3dJogPanel)
  const jogPanelMode = view3dJogPanel || 'NORMAL'

  const isExpanded = jogPanelMode === 'EXPANDED'
  const isMinimized = jogPanelMode === 'MINIMIZED'

  // 2026-09-16 side-column directive — RealArmChrome height is now
  // viewport-aware so the LEFT/RIGHT columns have room to spread
  // along the edges. Value = 70 % of window height, floored at the
  // 440 doctrine minimum (flow(a) guarantees the CENTER pads
  // never clip on short tablet viewports) and ceilinged at 780 px
  // (keeps a comfortable top gutter for the view-preset pills +
  // MinClearanceReadout). Recomputes on window resize +
  // orientation change so tablet rotate lands cleanly.
  const [panelHeight, setPanelHeight] = useState(
    () => Math.min(780, Math.max(440,
      Math.round(((typeof window !== 'undefined'
                    && window.innerHeight) || 900) * 0.70))))
  useEffect(() => {
    const recomputePanelH = () => setPanelHeight(
      Math.min(780, Math.max(440,
        Math.round((window.innerHeight || 900) * 0.70))))
    window.addEventListener('resize', recomputePanelH)
    window.addEventListener('orientationchange', recomputePanelH)
    return () => {
      window.removeEventListener('resize', recomputePanelH)
      window.removeEventListener('orientationchange', recomputePanelH)
    }
  }, [])

  // 2026-09-16 default-framing (measured) — visibleTopFrac derived
  // from the REAL jog-surface bounds at runtime. `panelRef` points
  // at the jog-floating-panel <div> (or the expand pill when
  // MINIMIZED); a ResizeObserver + orientationchange +
  // visibilitychange listener keep the fraction current across
  // load, resize, tablet rotate, and PWA standalone launch.
  const panelRef = useRef(null)
  const [visibleTopFrac, setVisibleTopFrac] = useState(
    () => FRAMING_MAX_TOP_FRAC)
  useEffect(() => {
    // Recompute visibleTopFrac from the panel's top edge minus a
    // safety margin. When the panel is absent (EXPANDED hides the
    // viewer entirely, or brief mount race) we fall back to full
    // viewport so the arm still renders.
    const recompute = () => {
      const viewportH = (typeof window !== 'undefined'
                          && window.innerHeight) || 900
      let topFrac = FRAMING_MAX_TOP_FRAC
      // 2026-09-16 side-column directive: the LEFT/RIGHT columns
      // now spread up the edges taller than the CENTER pads. If we
      // measured the whole panel (which extends to the tall column
      // tops), the arm region would shrink unnecessarily. Instead
      // measure the CENTER pads specifically (via the
      // jog-center-pads testid on the pad container inside
      // JogControls) — the arm bottom only needs to clear the
      // pads, not the side columns. Falls back to the panel
      // wrapper if the pads aren't in the DOM yet (mount race /
      // MINIMIZED).
      const padsEl = (typeof document !== 'undefined')
        ? document.querySelector('[data-testid="jog-center-pads"]')
        : null
      const el = padsEl || panelRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        if (r && Number.isFinite(r.top) && r.top > 0) {
          topFrac = (r.top - FRAMING_MARGIN_PX) / viewportH
        }
      }
      topFrac = Math.max(FRAMING_MIN_TOP_FRAC,
                          Math.min(FRAMING_MAX_TOP_FRAC, topFrac))
      setVisibleTopFrac((prev) =>
        Math.abs(prev - topFrac) > 0.005 ? topFrac : prev)
    }
    // 2026-09-16 refresh-timing fix — double-RAF so React has
    // committed AND the browser has painted before we call
    // getBoundingClientRect. Refresh-time hydration + web-font load
    // could leave the panel with a stale zero-top on the first RAF,
    // which anchored visibleTopFrac at the MAX clamp and framed the
    // arm too big → clip into buttons. Two frames land after all
    // layout work.
    let rafInner = null
    let raf = requestAnimationFrame(() => {
      rafInner = requestAnimationFrame(recompute)
    })
    // ResizeObserver on the panel catches: panel-mode change
    // (NORMAL <-> MINIMIZED <-> EXPANDED), any inner-layout resize.
    let ro = null
    if (typeof ResizeObserver !== 'undefined' && panelRef.current) {
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(recompute)
      })
      ro.observe(panelRef.current)
    }
    // Window resize covers viewport-height changes (tablet rotate,
    // browser window drag, desktop DPR toggle).
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(recompute)
    }
    window.addEventListener('resize', onResize)
    // Orientationchange — some tablets fire this INSTEAD of resize
    // on rotate; belt-and-braces.
    window.addEventListener('orientationchange', onResize)
    // Visibility change — PWA standalone launch fires this when the
    // app becomes visible; the viewport may differ from the tab
    // that computed the initial framing.
    const onVisible = () => {
      if (!document.hidden) onResize()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelAnimationFrame(raf)
      if (rafInner) cancelAnimationFrame(rafInner)
      if (ro) ro.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [jogPanelMode])   // panel-mode change swaps panelRef target
  const framing = { visibleTopFrac }

  // 2026-09-16 default-framing — reframe whenever visibleTopFrac
  // changes (mount, resize, orientationchange, visibilitychange,
  // jog-panel-mode change all funnel through the state update
  // above). Deps are ONLY visibleTopFrac (a layout signal), NEVER
  // joint / robot / task, so live motion never yanks the camera.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      armRef.current?.reframe?.()
    })
    return () => cancelAnimationFrame(raf)
  }, [visibleTopFrac])

  // 2026-09-16 zoom-capture — suppress browser page-zoom on the 3D
  // View screen only. Three input classes leak page-zoom without
  // this: (a) touch pinch on the tablet (browsers escalate to page-
  // zoom when no touch-action opt-out is set); (b) ctrl+wheel or
  // trackpad pinch on desktop (fires wheel with ctrlKey=true, which
  // browsers translate to zoom unless preventDefault'd); (c) Safari
  // pinch (gesture* events, iOS/iPadOS specific). Element-scoped:
  // handlers live on THIS root element, so Monitor / Program / I/O
  // pages keep their default browser zoom.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    // Ctrl+wheel = browser zoom trigger on desktop (and trackpad
    // pinch). OrbitControls captures wheel over the canvas and
    // preventDefaults there; here we cover the overlay / button
    // regions above the canvas so ctrl+wheel over them doesn't
    // page-zoom. Non-passive so preventDefault is honored.
    const onWheel = (e) => {
      if (e.ctrlKey) e.preventDefault()
    }
    // Safari-specific pinch API. touch-action:none covers most
    // browsers, but iOS Safari still fires gesture* — preventDefault
    // is the only way to block page-zoom in that engine.
    const onGesture = (e) => e.preventDefault()
    el.addEventListener('wheel',        onWheel,   { passive: false })
    el.addEventListener('gesturestart', onGesture, { passive: false })
    el.addEventListener('gesturechange', onGesture, { passive: false })
    el.addEventListener('gestureend',   onGesture, { passive: false })
    return () => {
      el.removeEventListener('wheel',        onWheel)
      el.removeEventListener('gesturestart', onGesture)
      el.removeEventListener('gesturechange', onGesture)
      el.removeEventListener('gestureend',   onGesture)
    }
  }, [])

  return (
    // 2026-09-16 IMMERSIVE LAYOUT — the 3D canvas is the full-page
    // background. All controls float over it as overlay panels. Left
    // sidebar retired 2026-09-08; view-switcher lives inside the
    // ArmViewer3D top-left overlay (L1632).
    <div
      ref={rootRef}
      data-testid="view3d-immersive-root"
      style={{
        position: 'relative', height: '100%', overflow: 'hidden',
        // 2026-09-16 zoom-capture — root-scoped touch-action:none
        // blocks browser pinch-zoom and double-tap-zoom on THIS
        // page only. Buttons still receive pointer events (this
        // only suppresses default BROWSER gestures). Other pages
        // don't share this root, so their zoom stays default.
        touchAction: 'none',
      }}>
      {/* Full-bleed 3D canvas — lowest layer. Absolute-positioned so
          the robot viewer fills the entire content region under the
          top nav, edge to edge. touch-action:none reinforces the
          root-scoped zoom capture on the canvas layer itself so
          OrbitControls receives touchmove without the browser
          intercepting for page pan/zoom (tablet gesture fix). */}
      <div
        data-testid="view3d-canvas-fill"
        style={{
          position: 'absolute', inset: 0, zIndex: 0, minWidth: 0,
          touchAction: 'none',
        }}>
        <ArmViewer3D ref={armRef} noRobot framing={framing}
                     getLiveBbox={jogApi?.getBBox}>
          <StandaloneRobot onRobotReady={setJogApi} />
          {/* 2026-09-14 operator directive: IKGizmo (Cartesian-drag
              twin IK) retired along with the JointJogPanel that
              hosted its checkbox. No twin-only motion path remains
              on this page. */}
        </ArmViewer3D>
      </div>

      {/* MIN-CLEARANCE readout — top-center overlay chip, kept above
          the canvas so it can render CONTACT / CLEARANCE without
          being obscured by the robot mesh. Its own pointerEvents:
          none keeps orbit unaffected. */}
      <MinClearanceReadout />

      {/* MINIMIZED — floating "Expand Jog Buttons" pill only; 3D
          canvas fully unobstructed. */}
      {isMinimized && <RealArmMinimizedPill setMode={setView3dJogPanel} />}

      {/* NORMAL / EXPANDED — floating jog-panel overlay pinned to
          bottom-center. Wrapper is pointerEvents:none so the empty
          margin around the panel passes clicks through to the 3D
          canvas for orbit/zoom; the panel itself (jog-floating-panel)
          re-enables pointer events for its own controls. */}
      {!isMinimized && (
        <div
          ref={panelRef}
          data-testid="jog-overlay-wrapper"
          style={{
            position: 'absolute',
            // 2026-09-16 correction — the jog surface sits at its
            // ORIGINAL bottom position, full width. No floating card,
            // no centered narrow panel. NORMAL: 440 px band at the
            // bottom (panel height owns this). EXPANDED: full-height
            // (panel takes 100% via the RealArmChrome height rule).
            left: 0, right: 0,
            top:    isExpanded ? 0 : 'auto',
            bottom: 0,
            display: 'flex',
            justifyContent: 'stretch',
            zIndex: 10,
            // Wrapper passes clicks to the 3D canvas — panel children
            // re-enable pointer events on their own controls only.
            pointerEvents: 'none',
          }}>
          <RealArmChrome mode={jogPanelMode} setMode={setView3dJogPanel}
                          panelHeight={panelHeight}>
            {/* 2026-09-14: rightSlot for the modal-gated Orient Flange
                Down control (moved out of the twin-viewer overlay per
                screenshot review). */}
            <JogControls
              maximized={isExpanded}
              rightSlot={jogApi
                ? <OrientFlangeDownControl jogApi={jogApi} />
                : null}
              collapseSlot={
                <>
                  <button
                    data-testid="collapse-jog-buttons"
                    onClick={() => setView3dJogPanel('MINIMIZED')}
                    title="Collapse Jog Buttons"
                    style={{
                      ...chromeBtn,
                      width: 'auto', padding: '0 12px',
                      fontSize: 11, fontWeight: 600,
                      letterSpacing: '0.02em',
                    }}>Collapse Jog Buttons</button>
                  <button
                    onClick={() => setView3dJogPanel(
                      isExpanded ? 'NORMAL' : 'EXPANDED')}
                    title={isExpanded ? 'Restore split layout' : 'Expand panel'}
                    style={chromeBtn}>
                    {isExpanded ? '✕' : '⛶'}
                  </button>
                </>
              }
            />
          </RealArmChrome>
        </div>
      )}
    </div>
  )
}

// Live min-clearance chip — appears in the 3D View top-left whenever
// the unified guard reports any pair closer than 2× warn distance. This
// is the NON-BLOCKING presentation for the warn band; the popup only
// takes over at stop. Amber in warn, red in stop. Renders under the
// AT-LIMIT chip so both stay visible when they co-occur.
function MinClearanceReadout() {
  // Prefer the unified guard state (self / ground / env aggregated by
  // the driver) so a self-collision fold surfaces the same way as an
  // env obstacle. Fall back to the legacy self-collision keys for
  // driver builds pre-guard-unification. ALL useStore hooks are called
  // unconditionally at the top of the component — the fallback merge
  // happens in plain JS below (previously used `||`/`??` between hook
  // calls, which broke hook-order on any state transition where the
  // primary key flipped truthiness → React #300).
  const guardPair    = useStore((s) => s.robot?.guard_pair)
  const collisionPair = useStore((s) => s.robot?.collision_pair)
  const guardMin     = useStore((s) => s.robot?.guard_min_mm)
  const collisionMin = useStore((s) => s.robot?.collision_min_mm)
  const guardWarn    = useStore((s) => s.robot?.guard_warn_mm)
  const collisionWarn = useStore((s) => s.robot?.collision_warn_mm)
  const guardStop    = useStore((s) => s.robot?.guard_stop_mm)
  const collisionStop = useStore((s) => s.robot?.collision_stop_mm)
  const enabled      = useStore((s) => s.robot?.collision_enabled)

  const pair = guardPair || collisionPair
  const dist = guardMin != null ? guardMin : collisionMin
  const warn = (guardWarn || collisionWarn || 80)
  const stop = (guardStop || collisionStop || 30)
  if (!enabled || dist == null || !pair) return null
  if (dist > 2 * warn) return null   // only show when actually close
  const level = dist <= stop ? 'stop' : (dist <= warn ? 'warn' : 'near')
  const bg = level === 'stop' ? '#B91C1C'
           : level === 'warn' ? '#D97706'
           :                    '#0f172a'
  const label = level === 'stop' ? 'CONTACT'
              : level === 'warn' ? 'CLEARANCE'
              :                    'clearance'
  const shorten = (n) => n
    .replace('_shoulder', '').replace('_upper_arm', '')
    .replace('_forearm',  '').replace('_wrist1',    '')
    .replace('_wrist2',   '').replace('_flange',    '')
    .replace('__ground__', 'ground')
    .replace(/^zone#/, 'zone:')
  return (
    <div style={{
      // ArmViewer3D owns the top-left corner (view-switcher pills +
      // reach-dome toggle) — drop the clearance chip below that row so
      // the two never overlap when the guard band trips. Row is ~28px
      // tall (padding + font), so top:44 keeps a small gap.
      position: 'absolute', top: 44, left: 8, zIndex: 20,
      padding: '4px 10px', borderRadius: 4,
      background: bg, color: '#fff',
      fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
      fontWeight: 700, letterSpacing: 0.5,
      boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      pointerEvents: 'none',
    }}>
      {label}: {dist.toFixed(0)} mm  {shorten(pair[0])}↔{shorten(pair[1])}
    </div>
  )
}
