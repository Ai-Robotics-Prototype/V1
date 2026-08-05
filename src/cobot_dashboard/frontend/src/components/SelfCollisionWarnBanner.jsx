// SelfCollisionWarnBanner — DISABLED by 2026-08-05 operator
// directive ("Clearance warnings: OFF"). The soft warn tier
// (40 mm banner + per-pair mute) is turned OFF end to end; the
// only self/ground collision signal that remains is the
// hard-stop toast keyed off robot.stop_cause_copy (canonical
// translator: _jog_stop_cause_operator_copy).
//
// This module is kept as an unconditional-null render so the
// App.jsx mount site does not churn — flipping the directive
// back on later means restoring the pre-08-05 body (see git
// history for the presentation-logic version). Do NOT add ANY
// visible surface here without a matching directive change.
//
// Fork registry: page_context_persistence peer — this file's
// invariant is "renders null unconditionally"; pinned by
// test_clearance_warnings_off (frontend).

export default function SelfCollisionWarnBanner() {
  return null
}
