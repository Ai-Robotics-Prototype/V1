// EOAT capability catalog (2026-10-02 plain-register directive).
//
// The custom EOAT wizard asks "What does this tool do?" with multi-
// select picture cards. Each selection becomes ONE actuator in the
// compiled record with the type + preselect already answered.
//
// Compilation-equivalence pin: the mapping from capability →
// actuator type + preselect MUST produce an actuators[] array
// identical in shape to what the old per-actuator picker produced
// for the equivalent manual answers. Pinned in D_cell.test.js.
//
// Shape of each catalog entry:
//   {
//     key: string,            // stable id used on data attributes
//                             // + the compiled actuator.capability field
//     label: string,          // plain-register card title (operator-facing)
//     hint: string,           // one-line example in parentheses
//     actuatorType: string
//                | null,      // 'double_acting' | 'vacuum' | 'blow_off'
//                             // | null (something_else — operator picks)
//     preselect: object,      // defaults for the operator's answer:
//                             //   grips_fingers  → { holdOnLoss: true }
//                             //   holds_suction  → { hasCheckValve: true }
//                             //   blows_air      → {}
//                             //   something_else → {}
//   }

const _CAPABILITY_CATALOG = [
  { key: 'grips_fingers',
    label: 'Grips with fingers',
    hint: '(two-jaw parallel gripper, pinch clamp, etc.)',
    actuatorType: 'double_acting',
    preselect: { holdOnLoss: true } },
  { key: 'holds_suction',
    label: 'Holds with suction',
    hint: '(vacuum cup, suction head)',
    actuatorType: 'vacuum',
    preselect: { hasCheckValve: true } },
  { key: 'blows_air',
    label: 'Blows air',
    hint: '(blow-off nozzle, chip clearing)',
    actuatorType: 'blow_off',
    preselect: {} },
  { key: 'something_else',
    label: 'Something else',
    hint: '(a custom tool we have not listed above)',
    actuatorType: null,
    preselect: {} },
]

export const CAPABILITY_CATALOG = Object.freeze(_CAPABILITY_CATALOG)
export const CAPABILITY_KEYS = Object.freeze(
  _CAPABILITY_CATALOG.map((c) => c.key))

export function capabilityDef(key) {
  return _CAPABILITY_CATALOG.find((c) => c.key === key) || null
}

// Build the ordered actuators[] array from a Set (or iterable) of
// selected capability keys. Catalog order wins over insertion order
// so the compiled record stays deterministic across runs.
export function actuatorsFromCapabilities(selected) {
  const sel = selected instanceof Set
    ? selected
    : new Set(selected || [])
  const arr = []
  for (const cap of _CAPABILITY_CATALOG) {
    if (!sel.has(cap.key)) continue
    arr.push({
      type: cap.actuatorType || '',
      holdOnLoss: null,
      hasCheckValve: null,
      capability: cap.key,
      ...cap.preselect,
    })
  }
  return arr
}
