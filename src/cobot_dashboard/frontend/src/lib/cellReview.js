// Legacy hold-on-loss review predicate (2026-10-02 operator directive:
// hold-on-loss default + safety).
//
// Saved profiles are NEVER silently migrated — changing a saved tool's
// valve class behind the operator's back changes physical behavior.
// This helper marks entries whose air-driven actuators are NOT
// recording a true hold_on_loss so My Cell can render a subtle
// "review recommended" chip + plain copy and the operator can
// re-confirm per tool.
//
// Predicate scope:
//   * EOAT entries: inspect `actuators[]` (post-2026-10-01 shape;
//     backfilled by cell_actuators_v1). Any `double_acting` or
//     `vacuum` actuator with hold_on_loss !== true triggers the
//     chip. `single_acting` / `electric_none` cannot physically
//     hold on loss, so they NEVER trigger it.
//   * Fixture entries: hold-on-loss lives on the top-level record;
//     only `power_mode === 'air'` fixtures carry a hold answer.
//     `blow_off` actuation has no hold state, so it never triggers.
//
// Vacuum entries with holds_via='check_valve' (standard NeuRobots
// vacuum tools, or custom-vacuum operators who answered YES to the
// check-valve question) record hold_on_loss=true and therefore do
// NOT trigger the chip — the hardware does the holding.

export function shouldReviewHold(entry) {
  if (!entry) return false
  const acts = Array.isArray(entry.actuators) ? entry.actuators : null
  if (acts !== null && acts.length > 0) {
    for (const a of acts) {
      if (!a) continue
      const t = String(a.type || '')
      if (t === 'single_acting' || t === 'electric_none') continue
      if (t !== 'double_acting' && t !== 'vacuum') continue
      if (a.hold_on_loss !== true) return true
    }
    return false
  }
  if (entry.power_mode === 'air' && entry.hold_on_loss !== true) {
    const actuation = String(entry.actuation || '')
    if (actuation !== 'blow_off') return true
  }
  return false
}
