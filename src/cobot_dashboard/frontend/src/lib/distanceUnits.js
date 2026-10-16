// 2026-10-13 operator directive: operator surfaces display/input
// distances in INCHES; storage + wire + codegen stay MM. All UI
// conversion goes through this one file so the mm↔in boundary is
// grep-able and audit-able.
//
// Boundary contract:
//   * Reads  : mm value from the program record / answers → inches
//              rendered to the operator.
//   * Writes : inches picked by the operator → mm written back into
//              the program record / answers.
//   * Nothing on the wire changes. If the operator doesn't touch a
//              distance field, the stored mm value is identical to
//              before (`fromMm(mm) === mm`). Verified in
//              distanceUnits.test.js.

export const MM_PER_IN = 25.4

// Round a number to `digits` fractional digits WITHOUT producing
// FP tails like 1.9000000000002. Returns a Number, not a string.
function _round(n, digits = 1) {
  if (!Number.isFinite(n)) return 0
  const p = Math.pow(10, digits)
  return Math.round(n * p) / p
}

// mm → inches (number). Default rounds to 0.1″ for operator-facing
// slider values; pass digits=2 for e.g. step rows like "z+3.94″".
export function mmToIn(mm, digits = 1) {
  const n = Number(mm)
  if (!Number.isFinite(n)) return 0
  return _round(n / MM_PER_IN, digits)
}

// inches → mm (number). We round to an integer mm because every
// stored field in the program record is an integer-millimetre
// quantity (approach_height_mm, descend_mm, pallet_spacing_x_mm,
// …). Preserves wire-byte-equivalence: the controller still gets
// integer mm, same as before.
export function inToMm(inches) {
  const n = Number(inches)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * MM_PER_IN)
}

// Format mm value for inline display inside a sentence or step row,
// e.g. `z+3.9″`. Keeps the sign on signed offsets. Default digits=1
// is fine for operator-glanceable copy; pass digits=2 if the
// surface wants a tighter number.
export function formatInLabel(mm, { digits = 1, showSign = false,
                                    suffix = '″' } = {}) {
  if (mm === null || mm === undefined || mm === '') return ''
  const n = Number(mm)
  if (!Number.isFinite(n)) return ''
  const inches = _round(n / MM_PER_IN, digits)
  const prefix = showSign && inches > 0 ? '+' : ''
  return `${prefix}${inches}${suffix}`
}
