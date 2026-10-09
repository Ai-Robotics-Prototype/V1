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


// useGlobalKeyboardAutoScroll — mount ONCE at the App root.
//
// Two load-bearing pieces at the global level:
//   * seeds `--kb-inset` via useKeyboardInset so any CSS in the app
//     (including deep-mounted modals that don't call the hook
//     themselves) picks up the inset through the custom property;
//   * attaches a document-level `focusin` listener that scrolls the
//     focused text input / textarea / contenteditable into view with
//     block:'center'. One listener covers every prompt in the app;
//     individual modals no longer need per-input onFocus handlers.
//
// 2026-10-09 operator directive (tablet keyboard covering fields
// across prompts): previously only ExternalFixtureWizard applied
// scrollFocusedIntoView to its inputs. LoginModal, DevicePairingWizard,
// ProgramWizard name/number fields, and the misc confirm dialogs
// didn't — so the on-screen keyboard still covered them. One listener
// at the app root removes that whole class.
export function useGlobalKeyboardAutoScroll() {
  const inset = useKeyboardInset()
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onFocus = (ev) => {
      const el = ev.target
      if (!el || !(el instanceof HTMLElement)) return
      const tag = el.tagName
      const isText = (
        tag === 'TEXTAREA'
        || el.isContentEditable
        || (tag === 'INPUT' && (
            // Range / checkbox / radio / button / file / color inputs
            // never bring up a keyboard — don't trigger a scroll jump.
            {
              text: 1, search: 1, email: 1, url: 1, tel: 1,
              password: 1, number: 1, date: 1, time: 1,
              'datetime-local': 1, month: 1, week: 1,
              '': 1, undefined: 1,
            }[String(el.type || '').toLowerCase()] === 1
        ))
      )
      if (!isText) return
      scrollFocusedIntoView(el)
    }
    document.addEventListener('focusin', onFocus, true)
    return () => document.removeEventListener('focusin', onFocus, true)
  }, [])
  return inset
}


// kbSafeModalContentStyle — the ONE snippet every prompt / modal /
// dialog content container spreads to stay above the keyboard.
//
// Shape returned:
//   { maxHeight: 'calc(<vhCap>vh - var(--kb-inset, 0px))',
//     paddingBottom: 'calc(<padBottom>px + var(--kb-inset, 0px))',
//     overflowY: 'auto' }
//
// When the keyboard opens, --kb-inset is the keyboard height; the
// content shrinks by that amount AND reserves padding at the bottom
// so the focused field + the full prompt (including the primary
// action button row) stay visible above the keyboard. When the
// keyboard closes --kb-inset returns to 0 and the layout is byte-
// identical to the pre-change render. Inert on desktop.
//
// `vhCap` defaults to 92 (same as ExternalFixtureWizard pre-fix).
// `padBottom` defaults to 24 — matches the common modal footer.
export function kbSafeModalContentStyle(vhCap = 92, padBottom = 24) {
  return {
    maxHeight:     `calc(${vhCap}vh - var(--kb-inset, 0px))`,
    paddingBottom: `calc(${padBottom}px + var(--kb-inset, 0px))`,
    overflowY:     'auto',
    boxSizing:     'border-box',
  }
}
