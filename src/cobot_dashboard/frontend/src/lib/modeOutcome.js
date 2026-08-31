// Named-outcome mapping for /api/estun/program/mode failures.
//
// The mode endpoint returns `outcome.kind` on refusal (self-healing
// ladder — add-51 §638-645). The mapping below produces
// operator-language content for each named kind + `reason_code`.
// Toast callers render:
//
//   title           — one operator-language sentence: what
//                     happened + what to do. No technical tokens
//                     ("mode_readback_timeout", "recoveryState",
//                     "publish/RobotStatus", HTTP codes).
//   detail          — one operator-language sentence with
//                     specifics (physical action to take, which
//                     pendant page, next step).
//   technicalDetail — the raw wire evidence: reason string,
//                     reason_code, and the §566 four-tuple
//                     verbatim. Rendered behind a "Details"
//                     toggle. Logged so devtools grep still
//                     surfaces the raw wire fields.
//
// Parity with loadOutcome.js so any registry / test that iterates
// operator-refusal helpers can treat both the same.

export const MODE_OUTCOME_KINDS = [
  // Pre-ladder shape guards
  'invalid_target',
  'arbiter_refused',
  // Self-healing diagnostic ladder (add-51 §638-645)
  'recovery_state_power_cycle_required',
  'errors_latched_uncleared',
  // Bottom-of-ladder terminal shapes
  'driver_ack_timeout',
  'mode_switch_failed',
]

// reason_codes carried inside outcome.mode_switch_failed. The
// server dispatches on these when the switch itself fails; each
// gets an operator-language branch so no path collapses to a
// generic "mode read-back timeout" toast.
export const MODE_FAILED_REASON_CODES = [
  'allow_mode_gate_closed',
  'transport_down',
  'controller_not_ready',
  'arm_enabled_interlock',
  'verb_publish_failed',
  'mode_readback_timeout',
  'publish_failed',
]

// Same banned-token list as loadOutcome — the operator toast is
// register-consistent across both mappers.
export const BANNED_OPERATOR_TOKENS = [
  'mm2mAndDeg2rad',
  'v.size()',
  'exitProcess',
  'firmware bug',
  'C2Control',
  'sha256',
  'HTTP 5',
]


function _fourTupleLine(four) {
  if (!four || typeof four !== 'object') return ''
  const parts = []
  if (four.mode != null) parts.push(`mode=${four.mode}`)
  if (four.state_code != null || four.state_name) {
    parts.push(
      `state=${four.state_code ?? '?'}` +
      (four.state_name ? `(${four.state_name})` : ''))
  }
  if (four.recoveryState != null) {
    parts.push(`recoveryState=${four.recoveryState}`)
  }
  if (Array.isArray(four.errors)) {
    parts.push(`errors=[${four.errors.join(', ')}]`)
  }
  return parts.join(' ')
}


function _technicalDetail(body) {
  const o = (body && body.outcome) || {}
  const bits = []
  const rc = o.reason_code || (o.subs && o.subs[o.subs.length - 1]
                                 && o.subs[o.subs.length - 1].reason_code)
  if (rc) bits.push(`reason_code=${rc}`)
  if (o.reason)  bits.push(`reason=${o.reason}`)
  const tuple = _fourTupleLine(o.four_tuple)
  if (tuple) bits.push(`four_tuple: ${tuple}`)
  if (Array.isArray(o.subs) && o.subs.length) {
    try {
      bits.push(`subs=${JSON.stringify(o.subs)}`)
    } catch (_) { /* nop */ }
  }
  return bits.join(' | ')
}


function _shape({ code, title, detail, technicalDetail = '', fourTuple }) {
  const headline = detail ? `${title} ${detail}` : title
  return { code, title, detail, technicalDetail, headline, fourTuple }
}


// Sub-dispatcher for outcome.kind='mode_switch_failed'. The server
// wraps the driver's failure envelope; each reason_code corresponds
// to a specific wire condition with its own operator remedy.
function _namedModeSwitchFailed(body) {
  const o    = (body && body.outcome) || {}
  const rc   = o.reason_code || ''
  const four = o.four_tuple || null
  const td   = _technicalDetail(body)

  if (rc === 'allow_mode_gate_closed') {
    return _shape({
      code:    'allow_mode_gate_closed',
      title:   "Mode gate is closed on the driver — nothing was switched.",
      detail:  "Set ESTUN_ALLOW_MODE=1 in the driver's environment "
             + 'and restart the roboai-estun service.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (rc === 'transport_down') {
    return _shape({
      code:    'transport_down',
      title:   "Controller link is down — mode was not switched.",
      detail:  'Wait for the driver to reconnect, then try the '
             + 'switch again.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (rc === 'controller_not_ready') {
    return _shape({
      code:    'controller_not_ready',
      title:   "Controller is not ready — mode was not switched.",
      detail:  'Wait for the controller to finish its own startup, '
             + 'then try again.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (rc === 'arm_enabled_interlock') {
    return _shape({
      code:    'arm_enabled_interlock',
      title:   "Can't switch mode while the arm is enabled.",
      detail:  'Disable the arm first (Power → Disable), then try '
             + 'the switch again — the endpoint will re-enable after.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (rc === 'verb_publish_failed' || rc === 'publish_failed') {
    return _shape({
      code:    'verb_publish_failed',
      title:   "Mode command didn't reach the controller.",
      detail:  'The dashboard could not publish the switch verb. '
             + 'Check the driver link and try again; report if it '
             + 'persists.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (rc === 'mode_readback_timeout') {
    // Ladder-honest copy for the specific case that used to be the
    // generic bottom of every refusal. The ladder has already
    // proven recoveryState is 0 and errors[] is empty; a read-back
    // timeout at this point means the controller ACKed the verb
    // but didn't observably change mode — pendant key-switch
    // position or a controller-side precondition the wire can't see.
    return _shape({
      code:    'mode_readback_timeout',
      title:   "Controller did not report a mode change — mode is unchanged.",
      detail:  'Check the pendant key-switch position and any '
             + 'controller-side interlocks, then try again.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  // Unknown reason_code inside mode_switch_failed — surface enough
  // that nothing gets silently eaten.
  return _shape({
    code:    'mode_switch_failed',
    title:   "Mode switch was refused — mode is unchanged.",
    detail:  (o.reason && !/mm2m|firmware|HTTP 5/i.test(o.reason))
      ? `Controller reason: ${o.reason}. Try again; report if it persists.`
      : 'Try again. If it repeats, report this.',
    technicalDetail: td,
    fourTuple: four,
  })
}


export function namedModeError(body, httpStatus) {
  const kind = (body && body.outcome && body.outcome.kind) || null
  const o    = (body && body.outcome) || {}
  const four = o.four_tuple || null
  const td   = _technicalDetail(body)

  if (kind === 'invalid_target') {
    return _shape({
      code:    'invalid_target',
      title:   "Invalid mode target — nothing was switched.",
      detail:  'This is a dashboard bug; report it.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (kind === 'arbiter_refused') {
    // Server-side reason is already operator-language
    // ("jog hold active" / "program running"). Detail field on
    // the server already prescribes the remedy.
    return _shape({
      code:    'arbiter_refused',
      title:   "Mode switch refused — "
             + (o.reason || 'another motion op is active') + '.',
      detail:  o.detail
             || 'Release the jog or stop the program first.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (kind === 'recovery_state_power_cycle_required') {
    // Rung 1. Physical cabinet cycle is the ONLY remedy per
    // addendum-40 §566. Title names the physical action; detail
    // spells out the tuple the operator must see after the cycle.
    return _shape({
      code:    'recovery_state_power_cycle_required',
      title:   "Controller needs a physical power-cycle before mode can switch.",
      detail:  'Cycle CC10-A at the cabinet. After the cycle the '
             + "four-tuple must read {state:2 Enabled, "
             + 'recoveryState:0, errors:[]} before mode switching '
             + 'or program runs will work.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (kind === 'errors_latched_uncleared') {
    // Rung 2. ClearError was published, controller did not drain
    // the errors[] list within 2 s. Latched fault the wire cannot
    // dismiss — pendant :9198 is the next step.
    return _shape({
      code:    'errors_latched_uncleared',
      title:   "Controller has a latched fault the wire can't clear.",
      detail:  'Open the pendant alarm log at :9198 and follow the '
             + 'listed recovery gesture; if nothing is visible, '
             + 'cycle the cabinet.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (kind === 'driver_ack_timeout') {
    return _shape({
      code:    'driver_ack_timeout',
      title:   "Driver did not respond to the mode command.",
      detail:  'The roboai-estun service may be down or the mode '
             + 'command topic may not be subscribed yet. Check '
             + '`systemctl status roboai-estun` and try again.',
      technicalDetail: td,
      fourTuple: four,
    })
  }

  if (kind === 'mode_switch_failed') {
    return _namedModeSwitchFailed(body)
  }

  // Unknown kind. Surface enough that nothing gets silently eaten,
  // but stay in operator language.
  return _shape({
    code:    'unknown',
    title:   'Mode switch was refused — mode is unchanged.',
    detail:  'Try again. If it repeats, report this.',
    technicalDetail: td || `HTTP ${httpStatus || '?'}`,
    fourTuple: four,
  })
}
