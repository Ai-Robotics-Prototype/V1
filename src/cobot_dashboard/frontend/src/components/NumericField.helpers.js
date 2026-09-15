// Pure numeric helpers for NumericField — kept in a plain .js so
// node --test can consume them without a JSX transformer.
//
// See NumericField.jsx for the React component that mounts these.

export const FLASH_MS = 350

export function formatValue(value, integer) {
  if (value == null || Number.isNaN(value)) return ''
  if (integer) return String(Math.trunc(value))
  // Number.toString handles typical floats cleanly (no trailing
  // zeros, no locale surprises). If the operator authored 1.5 we
  // don't want to re-render as "1.500000".
  return String(value)
}

export function parseAndClamp(raw, { integer, min = -Infinity, max = Infinity } = {}) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (s === '' || s === '-' || s === '.' || s === '-.') return null
  const n = integer ? parseInt(s, 10) : parseFloat(s)
  if (!Number.isFinite(n)) return null
  let clamped = n
  if (Number.isFinite(min) && clamped < min) clamped = min
  if (Number.isFinite(max) && clamped > max) clamped = max
  if (integer) clamped = Math.trunc(clamped)
  return clamped
}
