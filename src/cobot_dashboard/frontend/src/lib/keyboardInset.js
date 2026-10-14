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

// scrollFocusedIntoView — call from a text field's onFocus.
//
// Three-shot schedule, with the LATE shots doing MANUAL centering
// against the actual visualViewport (2026-10-14 operator audit #8D,
// iPad tuning follow-up):
//
//   t=rAF (~16 ms)   — scrollIntoView({block:'center'}). The old
//                      shot. Fast path for keyboard-already-up
//                      (field→field tabbing).
//   t=350 ms         — MANUAL centre. iOS Safari's keyboard-open
//                      animation finishes around 300-350 ms; its
//                      own built-in "auto-scroll input into view"
//                      runs during that animation and tends to land
//                      the field near the TOP of the visible band
//                      (operator photo on C1_kSxD9: field pinned to
//                      the top edge instead of comfortably centred).
//                      This shot IGNORES scrollIntoView's hint and
//                      computes the exact scroll delta from
//                      container + visualViewport + field rect so
//                      the field sits in the middle of the band ABOVE
//                      the keyboard. It wins over Safari's hint
//                      because it ran last.
//   on vv.resize     — re-runs the MANUAL centre once the next
//                      visualViewport resize lands (standalone-PWA
//                      iOS quirk: the resize is the first reliable
//                      signal the inset actually updated). One-shot,
//                      detaches itself + 2 s safety-net cleanup for
//                      the hardware-keyboard case.
//
// Why manual > scrollIntoView({block:'center'}):
//   block:'center' centres the field in the SCROLL CONTAINER'S
//   visible area as the browser understands it. On iOS Safari in
//   standalone-PWA mode the browser's idea of "visible area" doesn't
//   subtract the on-screen keyboard, so the "centre" is the centre
//   of the whole modal — which, after the keyboard rises, puts the
//   field right under the modal header near the top of what the
//   OPERATOR actually sees. Computing from
//   visualViewport.height / offsetTop closes that gap.
export function scrollFocusedIntoView(el) {
  if (!el || typeof el.scrollIntoView !== 'function') return
  const _naiveScroll = () => {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) }
    catch {
      try { el.scrollIntoView() } catch { /* give up — never throw */ }
    }
  }
  const _manualCentre = () => {
    try {
      const container = _findScrollContainer(el)
      const vv = (typeof window !== 'undefined') ? window.visualViewport : null
      // Visible viewport bounds (in document-ish coords). On engines
      // without visualViewport we fall back to window.innerHeight —
      // which equals the layout viewport, so centring will match the
      // naive path (no worse than before).
      const vvTop    = vv ? (vv.offsetTop || 0) : 0
      const vvHeight = vv ? vv.height : (window.innerHeight || 0)
      if (!container || !vvHeight) { _naiveScroll(); return }
      const cRect = container.getBoundingClientRect()
      const eRect = el.getBoundingClientRect()
      // The "visible band" is the intersection of the scroll
      // container with the visual viewport. If the keyboard covers
      // the lower part of the modal, visibleBottom = top-of-keyboard,
      // not container.bottom.
      const visibleTop    = Math.max(cRect.top, vvTop)
      const visibleBottom = Math.min(cRect.bottom, vvTop + vvHeight)
      const bandHeight    = Math.max(0, visibleBottom - visibleTop)
      // 16 px breathing room above/below the field. If the band is
      // tight (<= field + margin), park the field with 16 px top
      // margin and let the operator scroll by hand — centring in a
      // tiny band would clip the field itself.
      const margin = 16
      let desiredFieldTop
      if (bandHeight <= eRect.height + margin * 2) {
        desiredFieldTop = visibleTop + margin
      } else {
        desiredFieldTop = visibleTop + (bandHeight - eRect.height) / 2
      }
      // Delta between where the field is NOW and where we want it.
      // Positive delta → scroll container DOWN (field was below).
      const delta = eRect.top - desiredFieldTop
      if (Math.abs(delta) < 2) return  // already centred within noise
      // Prefer smooth scroll — iPad honours it. Fall back to abrupt
      // assignment if the browser rejects the options bag.
      try {
        container.scrollBy({ top: delta, left: 0, behavior: 'smooth' })
      } catch {
        container.scrollTop = (container.scrollTop || 0) + delta
      }
    } catch {
      _naiveScroll()
    }
  }
  // Shot 1: next frame — fast path when keyboard is already up.
  try { requestAnimationFrame(_naiveScroll) } catch { _naiveScroll() }
  // Shot 2: post-keyboard-animation manual centre.
  try { setTimeout(_manualCentre, 350) } catch { /* nop */ }
  // Shot 3: next visualViewport resize (one-shot) — covers the
  // standalone-PWA case where the resize fires AFTER our 350 ms
  // timer. Idempotent with shot 2 (both do _manualCentre); if the
  // keyboard was already up during shot 2 the resize may never
  // fire and the safety-net detach cleans up.
  try {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (vv && typeof vv.addEventListener === 'function') {
      const once = () => {
        vv.removeEventListener('resize', once)
        _manualCentre()
      }
      vv.addEventListener('resize', once)
      setTimeout(() => { try { vv.removeEventListener('resize', once) } catch {} }, 2000)
    }
  } catch { /* nop */ }
}

// Walk up from `el` and return the nearest ancestor that scrolls
// (overflow-y of auto/scroll). Falls back to the document scrolling
// element so a caller is never left with null.
function _findScrollContainer(el) {
  let cur = el && el.parentElement
  while (cur) {
    try {
      const style = getComputedStyle(cur)
      const oy = style && style.overflowY
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return cur
    } catch { /* detached node — skip */ }
    cur = cur.parentElement
  }
  if (typeof document !== 'undefined') {
    return document.scrollingElement || document.documentElement
  }
  return null
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
  // 2026-10-14 operator audit #8C (tablet payload-step blank-with-
  // keyboard class): dvh is the dynamic viewport height — the
  // browser SHRINKS it when the on-screen keyboard opens,
  // independent of our --kb-inset JS tracking. Safari iOS 15.4+
  // and Chrome Android 108+ support it. Combining dvh with
  // --kb-inset makes the modal reliably stay above the keyboard
  // even if visualViewport.resize never fires (standalone-PWA iOS
  // quirk the operator hit). `min()` picks whichever is shorter;
  // on an engine that doesn't parse dvh the whole min() expression
  // is dropped and the browser falls back to the preceding
  // `maxHeight` property (added via a dvh-feature-detect CSS
  // helper, since React inline-style can't carry a CSS fallback
  // on the same key — see styles/tokens.css .kb-safe-modal-shell).
  const vhCapInt = Math.round(vhCap)
  return {
    maxHeight:     `min(calc(${vhCapInt}dvh - var(--kb-inset, 0px)), `
                   + `calc(${vhCapInt}vh - var(--kb-inset, 0px)))`,
    paddingBottom: `calc(${padBottom}px + var(--kb-inset, 0px))`,
    overflowY:     'auto',
    boxSizing:     'border-box',
  }
}


// kbSafeFlexShellStyle + kbSafeScrollChildStyle — the TWO-PART pair
// for a MODAL BUILT AS A FLEX COLUMN (ProgramWizard, future multi-
// page prompts).
//
// Why a split helper exists at all:
//
// `kbSafeModalContentStyle()` is designed for the common case of a
// simple modal whose outer container IS the scroll surface — a
// LoginModal <form>, a RecordConfirmModal <div>. One element holds
// every input, the paddingBottom gives the last field breathing room
// above the keyboard, and overflowY:auto scrolls the whole thing.
// That shape works directly on the element and is why Login / EOAT
// naming / rename / fixtures all behave on the iPad.
//
// A FLEX-COLUMN WIZARD breaks that shape: the shell has a HEADER
// (title + close), a PROGRESS BAR, and a SCROLL CHILD, and
// box-sizing:border-box makes the shell's own padding steal from
// every flex sibling simultaneously. When the keyboard opens and
// --kb-inset grows to ~300 px, the shell's paddingBottom grows to
// ~324 px, and the content area left for the three flex children
// collapses — the scroll child (last sibling) is squeezed into a
// strip of 60-120 px tall on iPad landscape. From the operator's
// seat that reads as "the field is barely visible": the field
// renders, the manual-centre scroll runs, but the scrollable band
// IS the squeezed strip. Operator audit #8E (2026-10-14 iPad
// confirmed: other modals fine, wizard not).
//
// The split:
//   * kbSafeFlexShellStyle(vhCap) → maxHeight + boxSizing. NO
//     paddingBottom; the shell stays the full dynamic-viewport
//     height, so header / progress / scroll child all keep their
//     intrinsic space.
//   * kbSafeScrollChildStyle(padBottom) → overflowY:auto +
//     paddingBottom:calc(padBottom + inset). Applied to the
//     scroll child (the flex:1 one) so the last field in the
//     scrollable area gets breathing room — same semantic the
//     simple-form variant had, now scoped to the sibling where
//     the inputs actually live.
//
// Simple-form modals should keep using kbSafeModalContentStyle; this
// pair is specifically for shells that are a flex column with more
// than one child (header + content, or header + content + footer).

export function kbSafeFlexShellStyle(vhCap = 92) {
  const vhCapInt = Math.round(vhCap)
  return {
    maxHeight:   `min(calc(${vhCapInt}dvh - var(--kb-inset, 0px)), `
                 + `calc(${vhCapInt}vh - var(--kb-inset, 0px)))`,
    boxSizing:   'border-box',
  }
}

export function kbSafeScrollChildStyle(padBottom = 24) {
  return {
    overflowY:     'auto',
    paddingBottom: `calc(${padBottom}px + var(--kb-inset, 0px))`,
  }
}


// kbSafeOverlayStyle — the OTHER half of the keyboard-safe pair.
// Spread on the OUTER `position: fixed; inset: 0; display: flex;
// alignItems: center` overlay of every modal / dialog / wizard.
//
// 2026-10-12 operator directive (recurring tablet keyboard-cover):
// kbSafeModalContentStyle alone was not enough. The inner panel's
// maxHeight shrinks by --kb-inset, but flex `alignItems: center` on
// a `position: fixed; inset: 0` overlay centers the panel in the
// LAYOUT viewport — which is NOT shrunk by the on-screen keyboard
// (virtualKeyboard.overlaysContent=true, visualViewport only).
// Result: the shrunk panel still sits centered at layoutH/2, so its
// bottom half (including the primary action buttons) ends up behind
// the keyboard. The field + buttons are "visible" only in the panel
// sense, not the viewport sense.
//
// paddingBottom: var(--kb-inset) on the OVERLAY reduces the flex
// container's content box by the keyboard height, so `alignItems:
// center` naturally centers the panel in the VISIBLE area above the
// keyboard. The 0px fallback keeps desktop byte-identical.
//
// This is the shared-container piece: once the overlay has this
// style, ANY input mounted inside the panel lifts above the keyboard
// on focus (combined with useGlobalKeyboardAutoScroll's focusin
// listener). Per-field onFocus wiring is no longer needed.
export function kbSafeOverlayStyle() {
  return {
    paddingBottom: 'var(--kb-inset, 0px)',
    boxSizing:     'border-box',
  }
}
