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
// 2026-09-17 SINGLE-WINDOW RESTRUCTURE — RealArmChrome retired.
// The chrome was a full-width transparent band (`jog-floating-panel`
// at width:100% + pointerEvents:auto) that formed the second window
// the operator flagged: even with an empty header + transparent
// background, the wrapper's bounding box covered ~50% of the
// viewport with pointer-events:auto, blocking orbit input across
// the whole panel region. Its job is now split across three page-
// level overlays owned directly by View3DLayout:
//   * jog-pad-cluster-overlay — content-sized, bottom-center
//   * jog-left-column-slot    — content-sized page-level column
//   * jog-right-column-slot   — content-sized page-level column
// See test_no_full_width_container_over_canvas + the pointer-events
// walk pin for the structural contract.

const chromeBtn = {
  width: 26, height: 26, padding: 0,
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)', borderRadius: 4,
  cursor: 'pointer', fontSize: 14, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

// 2026-09-17 tablet-field-report — RealArmMinimizedPill RETIRED.
// The pill was a distinct green-bg 12px-padded chip with different
// shape/size/color from the in-panel Collapse control, breaking
// the "style parity between collapse states" operator directive.
// Replaced by the SINGLE collapse/expand chip inside JogControls
// collapseSlot (bottom-right RIGHT column). Only the LABEL flips
// on MINIMIZED. See test_collapsed_expanded_style_parity +
// test_collapse_scope_leaves_left_and_right_mounted.

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

  // 2026-09-17 UNIFIED FIT — normal AND expand modes use the SAME
  // measurement rule (operator directive #3, tablet field report):
  //
  //   scale = max(MIN_FIT_SCALE,
  //               min(cap, availW/naturalW, availH/naturalH))
  //
  // Cap is 1 in BOTH modes as of 2026-09-17 expand-rollback: the
  // prior EXPAND_MAX=1.6 attempt clipped in the desktop screenshot
  // (X-, Y+, Rz+ rendered as slivers) because scale>1 pushes the
  // visual past the overlay's LAYOUT box, and the ancestor tree
  // (view3d-immersive-root at overflow:hidden; jog-surface-row at
  // overflowX:hidden) clips the overflow. Operator directive: roll
  // BACK the scale, do NOT patch the wrapper. So cap = 1 always;
  // expand toggle now only controls canvas-dim + collapse label.
  //
  // Asymmetric width: the overlay is centered on viewport-center
  // (left:50% translateX(-50%)), so the natural cluster centers on
  // viewportW/2, NOT on the midpoint of available inter-column
  // space. Independent left/right permissible scales, min wins:
  //   halfLeft  = viewportW/2 − leftSlot.right  − margin
  //   halfRight = rightSlot.left − viewportW/2  − margin
  //   sWidth    = min(2·halfLeft/naturalW, 2·halfRight/naturalW)
  // Height: naturalH bounded by (viewport − top headroom − bottom margin):
  //   sHeight   = availableH / naturalH
  const CAP = 1   // 2026-09-17 expand-rollback: EXPAND_MAX (1.6) retired
  const [fitScale, setFitScale] = useState(1)
  const [dbg, setDbg] = useState(null)   // debug chip payload
  const debugCluster = (typeof window !== 'undefined'
      && window.location && window.location.search
      && window.location.search.indexOf('debug=1') >= 0)
  useEffect(() => {
    const FIT_MARGIN_PX = 8
    const TOP_HEADROOM  = 80   // below view-preset row + MinClearanceReadout
    const MIN_FIT_SCALE = 0.3  // floor so buttons stay usable
    let raf1 = null
    let raf2 = null
    const measure = () => {
      if (typeof document === 'undefined' || typeof window === 'undefined') return
      const leftSlot  = document.querySelector('[data-testid="jog-left-column-slot"]')
      const rightSlot = document.querySelector('[data-testid="jog-right-column-slot"]')
      const scaler    = document.querySelector('[data-testid="jog-center-cluster-scaler"]')
      if (!leftSlot || !rightSlot || !scaler) return
      const lr = leftSlot.getBoundingClientRect()
      const rr = rightSlot.getBoundingClientRect()
      const naturalW = scaler.offsetWidth    // LAYOUT — unaffected by transform
      const naturalH = scaler.offsetHeight
      const viewportW = window.innerWidth  || 1280
      const viewportH = window.innerHeight || 800
      const vc = viewportW / 2
      if (naturalW <= 0 || naturalH <= 0) return
      const halfLeft  = vc - lr.right - FIT_MARGIN_PX
      const halfRight = rr.left - FIT_MARGIN_PX - vc
      const availableH = viewportH - TOP_HEADROOM - FIT_MARGIN_PX * 2
      const sLeft  = (halfLeft  * 2) / naturalW
      const sRight = (halfRight * 2) / naturalW
      const sHeight = availableH / naturalH
      // 2026-09-17 expand-rollback: cap is 1 in both modes. isExpanded
      // no longer affects the pad-cluster scale — only the canvas dim
      // wash + the Collapse chip label swap.
      const cap = CAP
      const next = Math.max(MIN_FIT_SCALE,
        Math.min(cap, sLeft, sRight, sHeight))
      setFitScale((prev) => (Math.abs(prev - next) > 0.005 ? next : prev))
      if (debugCluster) {
        setDbg({
          innerW: viewportW, innerH: viewportH,
          leftSlotRight: Math.round(lr.right),
          rightSlotLeft: Math.round(rr.left),
          availableW: Math.round(rr.left - lr.right - 2 * FIT_MARGIN_PX),
          availableH: Math.round(availableH),
          naturalW: Math.round(naturalW),
          naturalH: Math.round(naturalH),
          cap, scale: next.toFixed(3),
        })
      }
    }
    // Double-RAF so the browser has committed layout AND painted
    // before we measure — otherwise the initial pass returns
    // zero-width rects for the just-mounted slots.
    const schedule = () => {
      if (raf1) cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(measure)
      })
    }
    schedule()
    // PWA standalone launch fires visibilitychange when the page
    // reveals; recompute so the launch-time viewport is measured
    // (not the pre-launch cached numbers).
    const onVis = () => { if (!document.hidden) schedule() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      if (raf1) cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
    }
  }, [debugCluster])   // 2026-09-17 expand-rollback: cap no longer depends on isExpanded

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
      // 2026-09-16 pad-anchoring directive #2: the CENTER pad cluster
      // is now bottom-aligned inside the CENTER container so the
      // container's top edge no longer reflects where the pads
      // actually sit. Prefer the scaler element (which wraps the
      // ACTUAL pad cluster and bottom-aligns with it) — its top edge
      // is where the arm region must clear to, giving us a LARGER
      // arm region above (framing gains the vacated vertical space
      // between container-top and pads-top). Falls back to the
      // container (jog-center-pads) if the scaler is not in the DOM
      // yet, then to the panel wrapper for MINIMIZED / mount race.
      const scalerEl = (typeof document !== 'undefined')
        ? document.querySelector('[data-testid="jog-center-cluster-scaler"]')
        : null
      const padsEl = (typeof document !== 'undefined')
        ? document.querySelector('[data-testid="jog-center-pads"]')
        : null
      const el = scalerEl || padsEl || panelRef.current
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

      {/* 2026-09-17 UNIFIED FIT DEBUG chip — enable with `?debug=1`
          in the URL. Top-center overlay reports the numbers the
          fit-formula reads from the device (innerW/H, slot rects,
          available W/H, natural W/H, cap, applied scale). Retire
          once operator confirms tablet portrait+landscape AND
          desktop normal+expand. Flag renamed cluster → 1 per
          2026-09-17 UNIFIED FIT directive (session convention:
          `?debug=1` for the ONE debug surface). */}
      {debugCluster && dbg && (
        <div
          data-testid="cluster-fit-debug"
          style={{
            position: 'absolute', top: 8, left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            padding: '6px 10px',
            background: 'rgba(15,23,42,0.85)', color: '#fff',
            fontSize: 11, fontFamily: 'var(--font-mono, monospace)',
            borderRadius: 4, pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}>
          inner={dbg.innerW}×{dbg.innerH}  L.r={dbg.leftSlotRight}  R.l={dbg.rightSlotLeft}
          {' '}availW={dbg.availableW}  availH={dbg.availableH}
          {' '}nat={dbg.naturalW}×{dbg.naturalH}  cap={dbg.cap}  scale={dbg.scale}
        </div>
      )}

      {/* 2026-09-17 tablet-field-report — MinimizedPill retired.
          MINIMIZED now hides ONLY the CENTER pad cluster; the
          LEFT column (DISABLE/READY + jog mode + step + speed),
          the RIGHT column (Orient Flange Down + Collapse/expand
          button), and every other control stay mounted. The
          Collapse chip in the RIGHT column flips its label to
          "Expand Jog Buttons" when MINIMIZED (style parity —
          same chromeBtn tokens both states). */}

      {/* 2026-09-16 EXPAND MODE canvas dim — optional per operator
          directive: "In expand mode the 3D canvas may be hidden/
          dimmed." A translucent slate wash sits ABOVE the canvas
          (zIndex 5) and BELOW the jog panel + side-column slots
          (zIndex 10+12), softening the twin so the pad cluster reads
          as the focus without unmounting the canvas (unmounting
          would drop the URDF pose + framing state on toggle). Exit
          expand → the wash unmounts and the canvas restores exactly.
          pointerEvents:none so orbit is unaffected on the peripheral
          edges the panel doesn't cover. */}
      {isExpanded && !isMinimized && (
        <div
          data-testid="view3d-expand-canvas-dim"
          style={{
            position: 'absolute', inset: 0, zIndex: 5,
            background: 'rgba(15, 23, 42, 0.75)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* 2026-09-17 COLLAPSE SCOPE FIX — page-level overlays are
          ALWAYS MOUNTED. The prior `!isMinimized &&` gate around
          the LEFT + RIGHT slots + the pad-cluster overlay was the
          collapse-scope regression: it unmounted the JogControls
          tree entirely on MINIMIZED, which killed the portal
          targets for the LEFT column (ENABLE/DISABLE + jog mode +
          step + speed) and the RIGHT column (Orient Flange Down
          + Collapse button). The operator's directive is that
          Collapse hides ONLY the CENTER pad cluster; everything
          else stays reachable.

          The fix routes MINIMIZED through JogControls' new
          `hidePads` prop, which nulls the CENTER container
          without touching the LEFT/RIGHT portal render — so the
          slot divs and their portaled content stay in the DOM. */}
      <>
        {/* LEFT column slot — page-level, moved UP under the view
            presets (top:72 clears the top-left MinClearanceReadout
            + preset row), thinned to 150 px per operator directive
            (thin chips, distributed down). Contents portal in
            from JogControls immersive mode. */}
        <div
          id="jog-left-column-slot"
          data-testid="jog-left-column-slot"
          style={{
            position: 'absolute',
            left: 16, top: 72, bottom: 16,
            width: 150,
            zIndex: 12,
            pointerEvents: 'none',
            display: 'flex',
            boxSizing: 'border-box',
          }}
        />
        {/* RIGHT column slot — page-level, mirrors the LEFT slot
            vertically. Hosts Orient at top + Collapse/fullscreen
            at bottom (space-between distribution inside
            JogControls). */}
        <div
          id="jog-right-column-slot"
          data-testid="jog-right-column-slot"
          style={{
            position: 'absolute',
            right: 16, top: 72, bottom: 16,
            width: 200,
            zIndex: 12,
            pointerEvents: 'none',
            display: 'flex',
            justifyContent: 'flex-end',
            boxSizing: 'border-box',
          }}
        />
      </>

      {/* PAD CLUSTER overlay — content-sized floating anchor.
          ALWAYS MOUNTED so JogControls (which owns the LEFT +
          RIGHT portals) stays in the tree. When MINIMIZED,
          `hidePads` tells JogControls to render null for the
          CENTER container — the overlay collapses to a 0-size
          box and the LEFT + RIGHT slots stay populated. */}
      <div
        ref={panelRef}
        data-testid="jog-pad-cluster-overlay"
        style={{
          position: 'absolute',
          // Bottom-center, content-sized. left:50% + translate
          // centers a variable-width cluster (Cartesian +
          // Rotation is wider than Joint tiles).
          left: '50%',
          bottom: 16,
          transform: 'translateX(-50%)',
          zIndex: 11,
          pointerEvents: 'none',
          display: 'flex',
          boxSizing: 'border-box',
        }}>
        <JogControls
          maximized={isExpanded}
          // 2026-09-16 SIDE-COLUMN OWNERSHIP + EXPAND MODE:
          //   * `immersive` portals the LEFT + RIGHT columns
          //     into the page-level slot divs above; this
          //     pad-cluster overlay hosts only the CENTER pads.
          //   * `expanded` scales the CENTER cluster 1.6× via
          //     CSS transform (arrangement unchanged).
          //   * `hidePads` (2026-09-17) nulls the CENTER
          //     container so MINIMIZED collapses ONLY the pad
          //     cluster while LEFT/RIGHT stay mounted.
          immersive
          expanded={isExpanded}
          hidePads={isMinimized}
          fitScale={fitScale}
          leftTopSlot={
            <>
              <ArmEnableControl />
              <JogReadyBadge />
            </>
          }
          rightSlot={jogApi
            ? <OrientFlangeDownControl jogApi={jogApi} />
            : null}
          collapseSlot={
            <>
              {/* 2026-09-17 style-parity operator directive: the
                  Collapse/Expand chip uses the SAME chromeBtn
                  token set in BOTH states — only the label +
                  onClick target flip. Testid `collapse-jog-buttons`
                  is preserved (label change is not a rename). */}
              <button
                // 2026-09-17 dual testid: this ONE chip serves
                // BOTH collapse (when expanded/normal) and expand
                // (when minimized) roles. `collapse-jog-buttons`
                // + `expand-jog-buttons` testids are preserved so
                // existing pins (test_collapse_jog_button_is_
                // coherent_pair, test_expand_pill_testid_still_
                // present) keep working through the label flip.
                data-testid={isMinimized ? 'expand-jog-buttons' : 'collapse-jog-buttons'}
                data-collapse-role={isMinimized ? 'expand' : 'collapse'}
                onClick={() => setView3dJogPanel(
                  isMinimized ? 'NORMAL' : 'MINIMIZED')}
                title={isMinimized ? 'Expand Jog Buttons' : 'Collapse Jog Buttons'}
                style={{
                  ...chromeBtn,
                  width: 'auto', padding: '0 12px',
                  fontSize: 11, fontWeight: 600,
                  letterSpacing: '0.02em',
                  pointerEvents: 'auto',
                }}>
                {isMinimized ? 'Expand Jog Buttons' : 'Collapse Jog Buttons'}
              </button>
              <button
                data-testid="expand-jog-buttons-fullscreen"
                onClick={() => setView3dJogPanel(
                  isExpanded ? 'NORMAL' : 'EXPANDED')}
                title={isExpanded ? 'Restore split layout' : 'Expand panel'}
                style={{ ...chromeBtn, pointerEvents: 'auto' }}>
                {isExpanded ? '✕' : '⛶'}
              </button>
            </>
          }
        />
      </div>
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
