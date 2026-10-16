// payloadTruth — resolves "what does the operator need to know about
// the tool weight on this program vs the robot's own setting?"
//
// 2026-07-31 (initial): the ToolAndPayloadSection surfaced a LIVE
// comparison line against a controller-side payload read.
// 2026-10-09 operator directive: the controller-side read was never
// wired (this controller has no readable PayloadId register and no
// callable setPayload wire verb — the backend codegen comments at
// program_ops.py:5387-5407 document the gap). The permanent
// 'unreadable' state was a yellow alarm on every program. Reframe:
//
//   * 'unreadable' is the DEFAULT when there's no wire path to the
//     robot's payload setting — an FYI, not an alarm. Styled info
//     (blue), not warning (amber). Copy drops "preset" / "on the
//     wire" / "Factory UI" / "Set the default load" jargon in
//     favour of "tool weight" + "robot's pendant" + "payload
//     compensation" in plain terms.
//
//   * 'match' / 'mismatch' remain in the contract because a future
//     controller firmware might expose the read; the copy drops
//     the Factory UI / ParamID jargon so a future wire path keeps
//     the plain operator vocabulary.
//
//   * 'unset' stays amber — the program itself lacks a tool mass,
//     which collision detection genuinely cares about.
//
//   * The ToolAndPayloadSection consumes `truth.severity` to pick
//     between info/warning styling. Pre-fix every non-match state
//     rendered amber; now 'unreadable' renders info-blue.
//
// Contract: computePayloadTruth({ programKg, controllerKg })
//   → { state, severity: 'ok'|'info'|'warning',
//       message, detail, programKg, controllerKg }
//
// `message` is the plain one-liner the operator reads. `detail` is
// the technical explanation surfaced in the tooltip / expander for
// anyone who wants to understand WHY the dashboard can't verify.
// programKg / controllerKg are the numeric values; both may be null.

const MATCH_TOLERANCE_KG = 0.05

function normKg(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : (n === 0 ? 0 : null)
}

function fmtKg(v) {
  return v.toFixed(v < 10 ? 1 : 0)
}

export function computePayloadTruth({ programKg, controllerKg }) {
  const p = normKg(programKg)
  const c = normKg(controllerKg)
  // Unset — the program has no tool weight; the amber chip in the
  // section header already flags this. Keep amber here so the body
  // + the chip agree on severity.
  if (p === null) {
    return {
      state: 'unset',
      severity: 'warning',
      message: 'No tool weight set yet. Enter it below so collision '
             + 'detection sizes correctly.',
      detail: 'The program carries the tool mass; without it the '
            + 'dashboard can\'t tell the robot how heavy the end-of-arm '
            + 'tool is for collision thresholds.',
      programKg: null,
      controllerKg: c,
    }
  }
  // Unreadable — the dashboard has no wire path to read what weight
  // is currently set on the robot. Informational, not an alarm.
  if (c === null) {
    return {
      state: 'unreadable',
      severity: 'info',
      message: `This program will run normally with ${fmtKg(p)} kg. `
             + 'The robot\'s own tool-weight setting can\'t be read '
             + 'back here — if you haven\'t already, set the matching '
             + 'weight on the robot\'s pendant so payload compensation '
             + 'is correct.',
      detail: 'The program sends the tool mass as metadata in every '
            + 'generated program, but this controller doesn\'t expose '
            + 'its live payload setting over the dashboard\'s read '
            + 'channel. One-time pendant check per tool is enough.',
      programKg: p,
      controllerKg: null,
    }
  }
  // Match — within tolerance.
  if (Math.abs(p - c) <= MATCH_TOLERANCE_KG) {
    return {
      state: 'match',
      severity: 'ok',
      message: `Tool weight ${fmtKg(p)} kg · confirmed on the robot ✓`,
      detail:  'The weight set on the robot matches this program\'s '
             + 'tool mass — payload compensation is sized correctly.',
      programKg: p,
      controllerKg: c,
    }
  }
  // Mismatch — the program and the pendant disagree. Still a real
  // warning (collision thresholds will be sized off the wrong mass),
  // but plain-language.
  return {
    state: 'mismatch',
    severity: 'warning',
    message: `This program expects ${fmtKg(p)} kg, but the robot is `
           + `set to ${fmtKg(c)} kg. Update the robot\'s tool weight `
           + `on its pendant to ${fmtKg(p)} kg so collision detection `
           + 'sizes correctly.',
    detail: 'Collision detection and drag thresholds are sized from '
          + 'the robot\'s own tool-weight setting; if that disagrees '
          + 'with the program\'s tool mass, the thresholds will be '
          + 'off.',
    programKg: p,
    controllerKg: c,
  }
}
