// payloadTruth — the single "does the program's payload match the
// controller's active preset?" resolver.
//
// 2026-07-31: the ToolAndPayloadSection used to show a fine-print
// "info only" banner explaining that the controller's PayloadId
// preset is selected in the Factory UI. That copy was retired for
// something the operator can actually act on: a LIVE comparison
// line that tells them whether the program and the controller
// agree.
//
// Contract: computePayloadTruth({ programKg, controllerKg })
//   → { state, message, programKg, controllerKg }
//
// Four states:
//
//   * 'match'      — both values present and within 0.05 kg. Green.
//                    Program: X kg · Controller preset: X kg ✓
//   * 'mismatch'   — both values present but differ (incl. controller
//                    = 0 which is common on a factory-reset arm). Amber.
//                    Directs the operator to Factory UI or ParamID.
//   * 'unreadable' — the wire read didn't return a value (controllerKg
//                    is null/undefined). Amber. NEVER pretends a sync
//                    exists — the copy names the actual limitation.
//   * 'unset'      — the program itself has no payload set. Amber.
//                    (The Payload-not-set chip already flags it; this
//                    state exists so callers don't have to special-case.)
//
// programKg / controllerKg on the returned object are the numeric
// values the UI needs to render; both may be null.

const MATCH_TOLERANCE_KG = 0.05

function normKg(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : (n === 0 ? 0 : null)
}

export function computePayloadTruth({ programKg, controllerKg }) {
  const p = normKg(programKg)
  const c = normKg(controllerKg)
  // Unset — the program has no payload; the chip already flags this.
  if (p === null) {
    return {
      state: 'unset',
      message: 'No payload set on the program — collision detection '
             + 'thresholds fall back to the controller preset only. '
             + 'Set the tool mass below.',
      programKg: null,
      controllerKg: c,
    }
  }
  // Unreadable — controller side unknown. Never claim sync.
  if (c === null) {
    return {
      state: 'unreadable',
      message: 'Controller preset not readable on the wire — verify at '
             + 'Factory UI → Set the default load. This program will '
             + 'run, but the dashboard can\'t confirm the preset matches.',
      programKg: p,
      controllerKg: null,
    }
  }
  // Match — within tolerance.
  if (Math.abs(p - c) <= MATCH_TOLERANCE_KG) {
    return {
      state: 'match',
      message: `Program: ${p.toFixed(p < 10 ? 1 : 0)} kg · `
             + `Controller preset: ${c.toFixed(c < 10 ? 1 : 0)} kg ✓`,
      programKg: p,
      controllerKg: c,
    }
  }
  // Mismatch — values disagree.
  return {
    state: 'mismatch',
    message: `Program: ${p.toFixed(p < 10 ? 1 : 0)} kg · `
           + `Controller preset: ${c.toFixed(c < 10 ? 1 : 0)} kg — `
           + 'collision detection and drag degraded. Set at Factory UI → '
           + 'Tool, or run Parameter Identification.',
    programKg: p,
    controllerKg: c,
  }
}
