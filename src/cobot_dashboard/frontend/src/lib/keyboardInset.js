import { useEffect, useState } from 'react'

// useKeyboardInset — single source of truth for on-screen keyboard
// height across the app.
//
// 2026-09-22 operator directive (tablet keyboard covering fields):
//   * Prefer the VirtualKeyboard API when the browser supports it
//     (Chrome/Android with the flag). navigator.virtualKeyboard.
//     overlaysContent = true tells the browser NOT to shrink the
//     visual viewport; the caller reads the boundingRect.height on
//     `geometrychange` and treats it as the inset.
//   * Fall back to visualViewport resize/scroll everywhere else
//     (Android Chrome without the flag still moves the visual
//     viewport when the keyboard opens). Inset = layoutH - visualH.
//   * Inert on desktop (no virtualKeyboard, visualViewport unchanged
//     on keyboard non-events → inset stays 0).
//
// The hook also writes `--kb-inset` on the document root so pure-CSS
// consumers can read the same source. Callers who need to reflow on
// each change consume the returned integer.

export function useKeyboardInset() {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const root = document.documentElement

    // Path A — VirtualKeyboard API.
    const vk = typeof navigator !== 'undefined'
      ? navigator.virtualKeyboard : null
    if (vk && typeof vk.addEventListener === 'function') {
      try { vk.overlaysContent = true } catch { /* older impls: no setter */ }
      const measure = () => {
        const h = Math.round(vk.boundingRect?.height || 0)
        setInset(h)
        root.style.setProperty('--kb-inset', `${h}px`)
      }
      measure()
      vk.addEventListener('geometrychange', measure)
      return () => {
        vk.removeEventListener('geometrychange', measure)
        root.style.setProperty('--kb-inset', '0px')
      }
    }

    // Path B — visualViewport fallback.
    const vv = window.visualViewport
    if (!vv) {
      root.style.setProperty('--kb-inset', '0px')
      return
    }
    const measure = () => {
      const layoutH = window.innerHeight
      const visualH = vv.height
      const h = Math.max(0, Math.round(layoutH - visualH - (vv.offsetTop || 0)))
      setInset(h)
      root.style.setProperty('--kb-inset', `${h}px`)
    }
    measure()
    vv.addEventListener('resize', measure)
    vv.addEventListener('scroll', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      vv.removeEventListener('resize', measure)
      vv.removeEventListener('scroll', measure)
      window.removeEventListener('orientationchange', measure)
      root.style.setProperty('--kb-inset', '0px')
    }
  }, [])

  return inset
}

// scrollFocusedIntoView — call from a text field's onFocus. Uses
// requestAnimationFrame so the browser has painted the keyboard
// before we measure; block:'center' keeps the field in the middle
// of the visible viewport regardless of layout height.
export function scrollFocusedIntoView(el) {
  if (!el || typeof el.scrollIntoView !== 'function') return
  requestAnimationFrame(() => {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) }
    catch { el.scrollIntoView() }
  })
}
