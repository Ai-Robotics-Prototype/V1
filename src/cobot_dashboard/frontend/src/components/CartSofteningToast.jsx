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


// 2026-08-28 guard-demotion: cart_softening now carries a `mode`
// field. mode='observe' means the driver saw the condition but let
// the firmware handle it (verb-era trust — parity with the factory
// pendant). mode='scale' means the driver applied a scale via
// _apply_cart_speed_scale_locked (retained under
// WSJOG_TRUST_FIRMWARE_CLAMPS=0 for regression testing).
const OBSERVE_COPY = {
  joint_overspeed: (j) =>
    `J${j} near its speed limit — firmware is clamping.`
    + ` Consider unwinding J${j} or switching to Joint mode.`,
  joint_limit_soft: (j) =>
    `J${j} near its axis limit — firmware is clamping.`,
  cart_limit_at_wall: (j) =>
    `J${j} at its axis wall — firmware refuses further travel in this direction.`,
  cart_limit_deepening: (j) =>
    `J${j} past its safe edge and deepening — firmware is clamping.`,
  singularity_guard: () =>
    'Near a singular pose — firmware is clamping the wrist geometry.',
  sigma_soft: () =>
    'Approaching a singular pose — firmware IK is slowing the arm.',
}

const SCALE_COPY = {
  joint_overspeed: (j) =>
    `Slowed — J${j} near its speed limit. Consider unwinding J${j} `
    + 'or switching to Joint mode.',
  joint_limit_soft: (j) =>
    `Slowed — J${j} near its axis limit. Ease off or reverse direction.`,
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
    const mode  = String(soft.mode  || 'scale')
    const j     = Number(soft.limiting_joint_1based || 0) || null
    // Dedup by mode + cause + joint so a mode transition (observe →
    // scale under an env override, say) doesn't suppress the new
    // language.
    const key   = `${mode}:${cause}:${j || '?'}`
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key
    const table = mode === 'observe' ? OBSERVE_COPY : SCALE_COPY
    const builder = table[cause]
    const msg = builder
      ? builder(j)
      : (mode === 'observe'
          ? (j
              ? `J${j} — firmware is clamping.`
              : 'Firmware is clamping the cart motion.')
          : (j
              ? `Slowed — J${j} governor scaling.`
              : 'Slowed — cartesian governor scaling.'))
    // Info severity for the observe (informational — the arm is
    // still moving). Warning for scale (we changed the wire).
    const severity = mode === 'observe' ? 'info' : 'warning'
    try {
      addToast?.(msg, severity, 4000)
    } catch { /* nop */ }
  }, [soft, addToast])

  return null
}
