import { useEffect, useRef, useState } from 'react'
import { formatValue, parseAndClamp, FLASH_MS } from './NumericField.helpers.js'

// NumericField — one editable numeric input, no fighting.
//
// The bug this replaces (2026-07-30 pallet wizard): every numeric
// input in the app parsed on every keystroke and committed
// synchronously. That means:
//
//   * clearing the field (select-all + delete) got `parseInt('')` →
//     NaN → `NaN || 1` → snap back to 1;
//   * typing a minus sign alone (`-`) got NaN → snap;
//   * typing "0.5" through the empty state was blocked (each
//     intermediate state re-committed the previous rounded number);
//   * mobile / tablet double-tap select+type couldn't replace a
//     value in one motion because the first keystroke fought the
//     current committed value.
//
// The fix: while FOCUSED, local raw-string state is authoritative.
// Empty, `-`, `1.`, `0.05e` all coexist during typing without
// committing. On BLUR (or Enter), parse + clamp + commit. Empty /
// invalid blur reverts to the last committed value with a brief red
// flash — the operator sees the revert instead of a silent snap.
//
// This is the ONE numeric input the whole app uses. See the sweep
// in this commit for the 17 sites that got converted; no-fork rule
// applied at the input level.
//
// Props:
//   value       (number)        current committed value
//   onCommit    (newValue) => void   called on blur/Enter with the
//                                    clamped, parsed number. NOT
//                                    called on every keystroke.
//   min, max    (number)        clamp bounds; defaults ±Infinity
//   integer     (bool)          parseInt vs parseFloat
//   step        (number|str)    passed to native <input step=>
//   disabled    (bool)
//   style       (obj)
//   className   (str)
//   ...rest — placeholder, id, name, aria-label, onKeyDown, etc.

export default function NumericField({
  value,
  onCommit,
  min = -Infinity,
  max = Infinity,
  integer = false,
  step,
  disabled,
  style,
  className,
  onKeyDown: userOnKeyDown,
  ...rest
}) {
  const [raw, setRaw]         = useState(() => formatValue(value, integer))
  const [focused, setFocused] = useState(false)
  const [flashing, setFlash]  = useState(false)
  const flashTimer = useRef(null)

  // Resync from the value prop ONLY when we're not focused. While
  // focused, local raw is authoritative — otherwise a parent
  // re-render mid-typing would snap the field.
  useEffect(() => {
    if (!focused) setRaw(formatValue(value, integer))
  }, [value, integer, focused])

  // Clean up any pending flash timer when the component unmounts.
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
  }, [])

  function flashRed() {
    setFlash(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(false), FLASH_MS)
  }

  function commit() {
    const parsed = parseAndClamp(raw, { integer, min, max })
    if (parsed == null) {
      // Invalid or empty → revert to last committed value with a
      // visible flash so the operator sees the rollback.
      setRaw(formatValue(value, integer))
      flashRed()
      return
    }
    // Re-format the committed value so display matches the number
    // that will actually round-trip (e.g., "1.50" → "1.5",
    // "12.5" with integer=true → "12").
    setRaw(formatValue(parsed, integer))
    if (parsed !== value && typeof onCommit === 'function') {
      onCommit(parsed)
    }
  }

  const combinedStyle = {
    ...style,
    ...(flashing ? {
      background:  '#FEF2F2',
      borderColor: '#DC2626',
      color:       '#7F1D1D',
      transition:  'background 120ms, border-color 120ms, color 120ms',
    } : {}),
  }

  return (
    <input
      type="text"
      // Numeric-only keypad on mobile — same UX as <input type=
      // "number"> would have provided, without the number-input's
      // step-arrow-driven eager commit + browser rounding.
      inputMode={integer ? 'numeric' : 'decimal'}
      pattern={integer ? '-?[0-9]*' : '-?[0-9]*\\.?[0-9]*'}
      step={step}
      disabled={disabled}
      className={className}
      style={combinedStyle}
      value={raw}
      onFocus={(e) => {
        setFocused(true)
        // Tap-and-type replaces the value in one motion (tablet-
        // friendly). Native focus event may not select on all
        // browsers, so call select() explicitly.
        try { e.target.select() } catch (_) { /* nop */ }
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur()   // triggers onBlur → commit()
        } else if (e.key === 'Escape') {
          setRaw(formatValue(value, integer))
          e.currentTarget.blur()
        }
        if (typeof userOnKeyDown === 'function') userOnKeyDown(e)
      }}
      {...rest}
    />
  )
}

// Re-export the pure helpers alongside the component so consumers
// have a single import surface. Behavior lives in ./NumericField.
// helpers.js (plain JS) so node --test can consume the helpers
// without a JSX transformer — see NumericField.test.js.
export { formatValue, parseAndClamp, FLASH_MS }
