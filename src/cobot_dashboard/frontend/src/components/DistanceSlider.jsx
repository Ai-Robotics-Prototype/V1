// 2026-10-13 operator directive: distances are picked in INCHES
// on operator surfaces; the stored and emitted value stays MM.
// This slider is the sole UI control for mm-stored distance fields
// in the wizard and the program editor — the mm↔in conversion
// happens here, nowhere else, so the boundary is grep-able.
//
// Props:
//   mmValue      — current mm value from the program record / answers.
//   onCommitMm   — callback invoked with the new mm value (integer).
//   minMm,maxMm  — mm bounds (kept so a future revert to mm display
//                  is trivial — just change the input scale back).
//   stepMm       — mm granularity. The inch step is derived to be
//                  close to this (snapped to the next sensible
//                  inch tick: 0.1″ / 0.25″ / 0.5″).
//   label, description — pass-through for the operator-facing copy.
//   recommendedCopy    — optional helper rendered below the slider
//                  (e.g. "Recommended: 4–6″ for most operations.").

import { mmToIn, inToMm, formatInLabel } from '../lib/distanceUnits'

function _inStepForMm(stepMm) {
  // Inch steps the operator will encounter are 0.1″ / 0.25″ / 0.5″.
  // Pick the one that is >= the mm step so the slider doesn't feel
  // finer than the mm step was (which would create non-mm-grid
  // values on the wire).
  const stepIn = stepMm / 25.4
  if (stepIn <= 0.1) return 0.1
  if (stepIn <= 0.25) return 0.25
  if (stepIn <= 0.5) return 0.5
  return 1
}

export default function DistanceSlider({
  label, mmValue, onCommitMm,
  minMm, maxMm, stepMm = 5,
  description, recommendedCopy,
}) {
  const minIn  = mmToIn(minMm, 1)
  const maxIn  = mmToIn(maxMm, 1)
  const stepIn = _inStepForMm(stepMm)
  const curIn  = mmToIn(mmValue ?? 0, 2)

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#2563EB' }}
              data-testid="distance-slider-value">
          {formatInLabel(mmValue ?? 0)}
        </span>
      </div>
      {description && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          {description}
        </div>
      )}
      <input type="range" min={minIn} max={maxIn} step={stepIn} value={curIn}
        onChange={e => onCommitMm(inToMm(parseFloat(e.target.value)))}
        style={{ width: '100%', height: 8 }}
        aria-label={label}
        data-testid="distance-slider-input"
      />
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
        <span>{minIn}″</span>
        <span>{maxIn}″</span>
      </div>
      {recommendedCopy && (
        <div style={{
          marginTop: 10,
          padding: 12, background: '#f0f9ff', borderRadius: 8,
          border: '1px solid #bfdbfe', fontSize: 12, color: '#2563EB',
        }}>
          {recommendedCopy}
        </div>
      )}
    </div>
  )
}
