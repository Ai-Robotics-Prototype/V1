// CartSofteningToast — surfaces the driver's cartesian speed
// governor as an operator-visible toast the moment scaling engages
// (2026-08-28 wrist-friendly hold directive).
//
// Reads robot.cart_softening (mirrored from the driver's status
// blob). Fires a toast on:
//   * null → active           — first entry into the scaled zone
//   * cause change (e.g. joint_limit_soft → joint_overspeed)
//
// Silent on the reverse transition (active → null) — the operator
// hearing "slowed" then silence means "back at full speed", which
// is what the reduced-then-restored magnitude already proves.
//
// Deduped by cause + limiting_joint so a spamming governor doesn't
// carpet the operator's screen.

import { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'


const CAUSE_COPY = {
  joint_overspeed: (j) =>
    `Slowed — J${j} near its speed limit. Consider unwinding J${j} `
    + 'or switching to Joint mode.',
  joint_limit_soft: (j) =>
    `Slowed — J${j} near its axis limit. Ease off or reverse direction.`,
  // 'governor' is the singularity σ_min path — no explicit `cause`
  // field on that entry, but the fallback matches its raw shape.
}


export default function CartSofteningToast() {
  const soft = useStore((s) => s.robot?.cart_softening) || null
  const addToast = useStore((s) => s.addToast)
  const lastKeyRef = useRef(null)

  useEffect(() => {
    if (!soft || !soft.active) {
      lastKeyRef.current = null
      return
    }
    const cause = String(soft.cause || 'governor')
    const j     = Number(soft.limiting_joint_1based || 0) || null
    const key   = `${cause}:${j || '?'}`
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key
    const builder = CAUSE_COPY[cause]
    const msg = builder && j
      ? builder(j)
      : (j
          ? `Slowed — J${j} governor scaling.`
          : 'Slowed — cartesian governor scaling.')
    try {
      addToast?.(msg, 'warning', 4000)
    } catch { /* nop */ }
  }, [soft, addToast])

  return null
}
