import { useEffect, useState } from 'react'

/**
 * Tiny diagnostic readout for diagnosing the tablet-right-edge-clip
 * issue. Renders only when the URL has `?debug=1` (also accepts
 * `?debug=viewport` or `?debug` so anything truthy works). Once the
 * tablet renders correctly the operator can remove the flag and the
 * component never mounts — there's no production overhead.
 *
 * Reads:
 *   - innerWidth   — the CSS viewport (Chrome reports this scaled by
 *                    devicePixelRatio on Android, so ~1200 on a
 *                    1920×1200 physical screen at DPR 1.5).
 *   - scrollWidth  — the actual rendered width. If this is > innerWidth
 *                    something inside is pushing the page past the
 *                    viewport — the symptom we just fixed at the
 *                    foundation.
 *   - devicePixelRatio.
 */
function debugEnabled() {
  if (typeof window === 'undefined') return false
  try {
    const sp = new URLSearchParams(window.location.search)
    return sp.has('debug')
  } catch {
    return false
  }
}

export default function ViewportDebug() {
  // Hooks must be unconditional — read enabled() inside the effect /
  // render and gate the JSX, not the hook calls themselves.
  const enabled = debugEnabled()
  const [m, setM] = useState(() => measure())

  useEffect(() => {
    if (!enabled) return undefined
    const onResize = () => setM(measure())
    onResize()
    window.addEventListener('resize', onResize)
    // Re-measure shortly after mount and after first render frames so
    // scrollWidth reflects the laid-out tree, not the empty root.
    const t1 = setTimeout(onResize, 250)
    const t2 = setTimeout(onResize, 1000)
    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [enabled])

  if (!enabled) return null

  const overflows = m.scrollW > m.innerW
  const screenGap = m.screenW - m.innerW
  const offscreen = m.topbarRight != null && m.topbarRight > m.innerW
  const flagged = overflows || screenGap > 0 || offscreen
  return (
    <div style={{
      position: 'fixed', top: 4, left: 4, zIndex: 9999,
      padding: '4px 8px',
      background: flagged ? 'rgba(220,38,38,0.92)' : 'rgba(15,23,42,0.85)',
      color: '#fff',
      fontFamily: 'ui-monospace, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      borderRadius: 4,
      pointerEvents: 'none',
      maxWidth: 320,
    }}>
      <div>iw {m.innerW} · sw {m.scrollW}{overflows ? ' ⚠' : ' ✓'}</div>
      <div>dpr {m.dpr} · ih {m.innerH} · sh {m.scrollH}</div>
      <div>screenW {m.screenW} · gap {screenGap}{screenGap > 0 ? ' ⚠' : ''}</div>
      <div>vvW {m.vvW} · scale {m.vvScale}</div>
      <div>topbarRight {m.topbarRight ?? '—'}{offscreen ? ' ⚠' : ''}</div>
    </div>
  )
}

function measure() {
  if (typeof window === 'undefined') {
    return {
      innerW: 0, innerH: 0, scrollW: 0, scrollH: 0, dpr: 1,
      screenW: 0, vvW: 0, vvScale: 1, topbarRight: null,
    }
  }
  const vv = window.visualViewport
  let topbarRight = null
  try {
    const nav = document.querySelector('nav')
    const topbar = nav?.parentElement
    if (topbar) topbarRight = Math.round(topbar.getBoundingClientRect().right)
  } catch { /* swallow */ }
  return {
    innerW:  window.innerWidth,
    innerH:  window.innerHeight,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    dpr:     Math.round((window.devicePixelRatio || 1) * 100) / 100,
    screenW: (window.screen && window.screen.width) || 0,
    vvW:     vv ? Math.round(vv.width) : 0,
    vvScale: vv ? Math.round(vv.scale * 100) / 100 : 1,
    topbarRight,
  }
}
