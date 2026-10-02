// HardStopToast — 2026-08-05 (operator directive: clearance
// warnings OFF).
//
// Replaces the ObstacleEscapeModal for self-collision and
// ground-plane hard stops. Emits ONE global toast the moment
// the driver publishes a fresh stop_cause with tag=
// 'collision_guard' AND guard_kind ∈ {'self','ground'}, using
// the operator language the dashboard's canonical translator
// already composed. No screen-blocking dialog, no per-page
// dependency — the operator sees the signal regardless of
// which tab is open.
//
// Fork registry: jog_stop_cause_propagation. This component is
// a SURFACE (toast) on the canonical copy — NOT a second
// translator. It reads robot.stop_cause_copy verbatim; the
// title/detail strings come from _jog_stop_cause_operator_copy
// (dashboard_server.py). Adding a regex on last_stop_reason
// here would be a fork.
//
// Trigger rule: fire when stop_cause_copy.ts advances past the
// last-seen ts AND the tag is collision_guard AND cause.
// guard_kind is self or ground. Duplicate stops within
// addToast's coalesce window get merged by the store, so a
// stuttering guard doesn't spam.

import { useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'

export default function HardStopToast() {
  const stopCauseCopy = useStore((s) => s.robot?.stop_cause_copy)
  const lastStopCause = useStore((s) => s.robot?.last_stop_cause)
  const collEnabled   = useStore((s) => s.robot?.collision_enabled)
  const addToast      = useStore((s) => s.addToast)
  const seenTsRef     = useRef(0)

  useEffect(() => {
    if (!stopCauseCopy || !addToast) return
    const ts = Number(stopCauseCopy.ts || 0)
    if (!ts || ts <= seenTsRef.current) return
    seenTsRef.current = ts

    // 2026-08-06 (operator directive: guards OFF). When the runtime
    // kill switch is off, no clearance-related toast should surface
    // even if a stale cause is still in the wire. Belt-and-braces:
    // the driver won't emit collision_guard stops when
    // _coll_guard_active is False, but if a race puts one on the
    // wire the moment after the toggle, this gate ensures the
    // operator doesn't see it.
    if (collEnabled === false) return

    // Only interested in the collision_guard tag, and only for
    // self/ground kinds (env keeps its ObstacleEscapeModal).
    if (String(stopCauseCopy.tag || '') !== 'collision_guard') return
    const guardKind = lastStopCause && lastStopCause.guard_kind
    if (guardKind !== 'self' && guardKind !== 'ground') return

    addToast({
      title:           stopCauseCopy.title,
      detail:          stopCauseCopy.detail,
      technicalDetail: stopCauseCopy.technical,
    }, 'error', 6000)
  }, [stopCauseCopy, lastStopCause, collEnabled, addToast])

  return null
}
