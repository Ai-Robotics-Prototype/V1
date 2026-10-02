/**
 * Runtime state-transition smoke test for the guard/chip components
 * that hit React #300 (2026-07-16). Drives a synthetic store through
 * the four transitions the incident spanned:
 *   1. driver absent           — store.robot is empty {}
 *   2. driver up, no guard     — guard_* keys undefined
 *   3. warn band               — d ≤ warn, > stop
 *   4. stop band               — d ≤ stop
 *   5. cleared                 — d > warn again
 * Asserts that React does not throw at any transition. Uses JSDOM +
 * a minimal store mock so we don't have to pull the three-fiber /
 * urdf-loader graph into a test process.
 */
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
})
globalThis.window   = dom.window
globalThis.document = dom.window.document
globalThis.navigator = dom.window.navigator
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.getComputedStyle = dom.window.getComputedStyle

// Load React AFTER globals are in place (react-dom hangs off `window`).
const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act }        = await import('react-dom/test-utils')

// Minimal useStore shim: exposes a single mutable snapshot; components
// subscribe with a selector. rerender() is triggered by re-rendering
// the root — good enough to exercise hook order across state changes.
let SNAP = { robot: {}, safety: {}, jogHold: () => {}, jogRelease: () => {} }
function useStore(sel) {
  // Read on every render — behaviour matches zustand for our purposes.
  return sel(SNAP)
}

// ── MinClearanceReadout (verbatim, current state, patched) ────────
function MinClearanceReadout() {
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
  if (dist > 2 * warn) return null
  return React.createElement('div', {}, `chip: ${dist}mm`)
}

// ── ObstacleEscapeModal (trimmed, state-transition surface only) ──
const HYSTERESIS_MM = 20
function ObstacleEscapeModal() {
  const robot    = useStore((s) => s.robot) || {}
  const safety   = useStore((s) => s.safety) || {}
  const jogHold  = useStore((s) => s.jogHold)
  const jogRel   = useStore((s) => s.jogRelease)
  const {
    guard_active, guard_kind, guard_pair, guard_min_mm,
    guard_warn_mm, guard_stop_mm, guard_escapes,
    enabled, alarm, allow_jog,
  } = robot
  const env_min_mm = guard_min_mm
  const env_stop_mm = guard_stop_mm
  const [minimized, setMin] = React.useState(false)
  const [sessionActive, setSA] = React.useState(false)
  const [flashClearUntil, setFC] = React.useState(0)
  const prevInStop = React.useRef(false)
  const inStop = env_min_mm != null && env_stop_mm != null && env_min_mm <= env_stop_mm
  const isJogCapable = !!enabled && !alarm && !safety?.estop
  React.useEffect(() => {
    if (inStop && !prevInStop.current) { setSA(true); setMin(false) }
    if (!inStop && prevInStop.current && sessionActive) {
      if (env_min_mm != null && env_stop_mm != null && env_min_mm > env_stop_mm + HYSTERESIS_MM) {
        setFC(Date.now() + 1400)
      }
    }
    prevInStop.current = inStop
  }, [inStop, sessionActive, env_min_mm, env_stop_mm])
  React.useEffect(() => {
    if (flashClearUntil === 0) return
    const t = setTimeout(() => { setSA(false); setFC(0) }, 30)
    return () => clearTimeout(t)
  }, [flashClearUntil])
  if (!sessionActive) return null
  if (!isJogCapable) return null
  return React.createElement('div', {}, `stop popup ${env_min_mm}mm`)
}

// ── Drive the transitions ─────────────────────────────────────────
const root = createRoot(document.getElementById('root'))
function render() {
  act(() => {
    root.render(React.createElement('div', {},
      React.createElement(MinClearanceReadout, {}),
      React.createElement(ObstacleEscapeModal, {}),
    ))
  })
}
function setState(patch) {
  SNAP = { ...SNAP, robot: { ...SNAP.robot, ...patch } }
  render()
}

const TRANSITIONS = [
  { name: 'driver absent (empty robot state)',
    patch: {} },
  { name: 'driver up, no guard fields (nulls)',
    patch: { collision_enabled: true, allow_jog: true, enabled: true } },
  { name: 'warn band (guard active, d=48, stop=30, warn=60)',
    patch: { guard_active: true, guard_kind: 'self',
             guard_pair: ['link3_forearm', 'link5_wrist2'],
             guard_min_mm: 48, guard_warn_mm: 60, guard_stop_mm: 30,
             guard_escapes: [] } },
  { name: 'stop band (d=25)',
    patch: { guard_min_mm: 25, guard_escapes: [
      { joint: 5, direction: -1, projected_mm: 27, current_mm: 25 }] } },
  { name: 'cleared (d=200, guard inactive)',
    patch: { guard_active: false, guard_min_mm: 200, guard_escapes: [] } },
  { name: 'flip to legacy collision_* only',
    patch: { guard_active: undefined, guard_kind: null, guard_pair: null,
             guard_min_mm: null, guard_warn_mm: null, guard_stop_mm: null,
             guard_escapes: [],
             collision_pair: ['link2_upper_arm', 'link4_wrist1'],
             collision_min_mm: 55,
             collision_warn_mm: 80, collision_stop_mm: 30 } },
  { name: 'back to nothing (both guards cleared)',
    patch: { collision_pair: null, collision_min_mm: null } },
]

let ok = 0, fail = 0
for (const t of TRANSITIONS) {
  try {
    setState(t.patch)
    ok++
    console.log(`  PASS  ${t.name}`)
  } catch (e) {
    fail++
    console.log(`  FAIL  ${t.name}\n        ${e.message}`)
  }
}
console.log(`\nResult: ${ok} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
