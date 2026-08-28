// Named-outcome mapping for /api/estun/program/run failures.
//
// The push endpoint returns a JSON body with `outcome.kind` on
// refusal. The mapping below produces operator-language content
// for each named outcome. Toast callers render:
//
//   title           — one operator-language sentence: what
//                     happened + what to do. Never contains
//                     technical tokens (no "codegen", no
//                     "mm2mAndDeg2rad", no firmware bug numbers).
//   detail          — one operator-language sentence with
//                     specifics (step numbers, ids, next action).
//                     Also technical-token-free.
//   technicalDetail — the raw wire reason from the server
//                     (firmware bug citations, sha hashes,
//                     driver reject strings). Shown behind a
//                     "Details" toggle and logged to console —
//                     never in the default operator view.
//
// Rationale (2026-08-04): the prior mapping put full technical
// content in the headline AND in detail. Callers concatenated
// them into a single toast string, so identical phrases —
// "known controller-crashing codegen", "Regenerate required",
// "firmware bug #3" — appeared twice in the same toast. The
// structured shape here plus the ToastContainer's
// title/detail/details layout guarantees each string renders
// exactly once, and the technical tokens stay demoted.
//
// `headline` and `code` are kept for backwards compat with any
// call site that still reads them; new callers should prefer
// `title` + `detail` + `technicalDetail`.

export const LOAD_OUTCOME_KINDS = [
  'transport_down',
  'save_rejected',
  'save_failed',
  'empty_program',
  'lint_failed',
  'byte_verify_mismatch',
  'byte_verify_get_failed',
  'id_not_controller_safe',
  'lint_infrastructure_error',
  'codegen',
  'pending_poses',
  'arity_assertion_failed',
]

// Tokens that must never appear in operator-facing strings
// (title or detail). Enforced by the pinned tests. If you're
// tempted to add one, put it in technicalDetail instead.
export const BANNED_OPERATOR_TOKENS = [
  'codegen',
  'mm2mAndDeg2rad',
  'v.size()',
  'exitProcess',
  'firmware bug',
  'C2Control',
  'sha256',
  'HTTP 5', // vague transport codes are for technicalDetail
]


function _wireReason(body) {
  return (body && body.outcome && body.outcome.reason)
      || (body && body.error)
      || ''
}


// Short-name map: ProgramEditor labels these actions with
// user-friendly words. In error copy the action verb goes in
// parentheses after the step number so the operator can eyeball
// which step to open.
const _ACTION_LABEL = {
  move_home:        'home',
  move_linear:      'linear',
  move_joint:       'joint',
  move_to_position: 'position',
  move_to_pallet:   'pallet',
  pick:             'pick',
  place:            'place',
  detect:           'detect',
  set_io:           'I/O',
  wait:             'wait',
  loop:             'loop',
  open_gripper:     'open gripper',
  close_gripper:    'close gripper',
}


function _formatStepList(findings, max = 5) {
  const parts = (findings || []).slice(0, max).map((f) => {
    const n = Number(f.step_idx ?? 0) + 1
    const label = _ACTION_LABEL[f.action] || f.action || '?'
    return `step ${n} (${label})`
  })
  const more = (findings || []).length - max
  return parts.join(', ') + (more > 0 ? `, +${more} more` : '')
}


// Legacy adapter — pre-2026-08-04 callers destructured
// { code, headline, detail } and joined them with " — ". Keep
// `headline` populated (a concatenation of title + detail sans
// duplication) so any un-migrated caller still shows the
// operator-language copy without the technical tail.
function _shape({ code, title, detail, technicalDetail = '' }) {
  const headline = detail ? `${title} ${detail}` : title
  return { code, title, detail, technicalDetail, headline }
}


export function namedLoadError(body, httpStatus) {
  const kind = (body && body.outcome && body.outcome.kind) || null
  const rawReason = _wireReason(body)

  if (kind === 'transport_down' || /ws not connected/i.test(rawReason)) {
    return _shape({
      code:    'transport_down',
      title:   'Controller link is down — program not loaded.',
      detail:  'The controller kept the previous program. '
             + 'Wait for the driver to reconnect, then try again.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'pending_poses') {
    const findings = body?.outcome?.findings || []
    const count = Number(body?.outcome?.count || findings.length || 0)
    const list = _formatStepList(findings)
    return _shape({
      code:    'pending_poses',
      title:   'Teach positions first — this program has untaught positions.',
      detail:  count > 0
        ? `Untaught: ${list}. Open it in the Program Editor to teach them.`
        : 'Open it in the Program Editor to teach the missing positions.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'arity_assertion_failed') {
    return _shape({
      code:    'arity_assertion_failed',
      title:   "Program can't run — internal generation error. Report this.",
      detail:  'The controller was not asked to run anything.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'empty_program') {
    return _shape({
      code:    'empty_program',
      title:   'Nothing to run — this program has no motion.',
      detail:  'Add a move step (or teach positions on the existing '
             + 'steps) in the Program Editor.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'lint_failed') {
    const count = Number(body?.outcome?.count || 0)
    const first = body?.outcome?.findings?.[0] || {}
    const at = first.line ? ` at line ${first.line}` : ''
    return _shape({
      code:    'lint_failed',
      title:   `Program can't run — ${count} invalid line`
             + `${count === 1 ? '' : 's'}${at}.`,
      detail:  'Open it in the Program Editor and re-save. '
             + 'If the problem persists, report this.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'byte_verify_mismatch') {
    return _shape({
      code:    'byte_verify_mismatch',
      title:   'Controller stored a different program than we sent.',
      detail:  'Try loading again. If it repeats, report this.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'byte_verify_get_failed') {
    return _shape({
      code:    'byte_verify_get_failed',
      title:   "Couldn't read the program back from the controller.",
      detail:  rawReason
        ? `Controller reason: ${rawReason}. Try again; report if it persists.`
        : 'The controller did not respond to the byte-verify GET. '
          + 'Try again; report if it persists.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'save_rejected') {
    return _shape({
      code:    'save_rejected',
      title:   'Controller refused the save — program not loaded.',
      detail:  'The controller kept the previous program. '
             + 'Try again; if the refusal persists, report this.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'save_failed') {
    // 2026-08-28: retired the "transient network hiccup" default.
    // save_failed only fires when the backend's classifier exhausted
    // every drain (in-loop reject, post-loop reject, save_event step
    // reason) and STILL has no named reason. Lying about a network
    // hiccup taught the operator to click through what was actually
    // a gate-closed refusal for weeks. Surface the raw reason when
    // there IS one; otherwise say plainly that we don't know and
    // ask for a report.
    return _shape({
      code:    'save_failed',
      title:   "Save didn't complete — program not loaded.",
      detail:  rawReason
        ? `Controller reason: ${rawReason}. Try again; report if it persists.`
        : 'The controller did not return a reason for the failure. '
          + 'Try again; if it persists, report this — the wire may '
          + 'have dropped a status message.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'id_not_controller_safe') {
    return _shape({
      code:    'id_not_controller_safe',
      title:   "This program's name has characters the "
             + "controller can't handle.",
      detail:  'Rename the program using only letters and digits, '
             + 'then try again.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'lint_infrastructure_error') {
    return _shape({
      code:    'lint_infrastructure_error',
      title:   "Program couldn't be checked before push. Report this.",
      detail:  'The controller was not asked to run anything.',
      technicalDetail: rawReason,
    })
  }

  if (kind === 'codegen'
      || httpStatus === 500
      || /^codegen:/.test(rawReason)) {
    return _shape({
      code:    'codegen',
      title:   "Program can't be generated. Report this.",
      detail:  'The controller was not asked to run anything.',
      technicalDetail: rawReason,
    })
  }

  // Unknown kind: surface enough that nothing gets silently eaten,
  // but keep the operator-language register — no HTTP codes leak
  // into the toast; those live in technicalDetail so devtools can
  // still see them.
  return _shape({
    code:    'unknown',
    title:   'Program not loaded.',
    detail:  'Try again. If it repeats, report this.',
    technicalDetail: rawReason || `HTTP ${httpStatus || '?'}`,
  })
}


// 2026-08-05 registry rule (operator_refusal_copy): every operator-
// facing refusal renders ONLY through this module. The Run-refused
// modal, the Monitor restart-refused toast, and the mid-run speed-
// change refusal all use these named-outcome helpers.
//
// `namedSpeedRefusal` handles the /api/estun/program/speed body
// shape, which differs from the load/run outcome shape:
//   * top-level `reason` (not nested under `outcome`)
//   * `needs_confirm` flag for the high-speed-confirm gate
//   * `effective_pct` / `operator_cap_pct` / `threshold_pct` context

export function namedSpeedRefusal(body, httpStatus) {
  const rawReason = (body && (body.reason || body.error)) || ''
  // 409 needs_confirm — a real refusal that's actually a "please
  // confirm" prompt. Callers that render the confirm UI shouldn't
  // hit this path; if they do, this copy makes it clear.
  if (httpStatus === 409 && body?.needs_confirm) {
    return _shape({
      code:    'speed_needs_confirm',
      title:   'High-speed change needs confirmation.',
      detail:  `Requested speed exceeds the high-speed threshold `
             + `(${body.threshold_pct}%). Re-submit with the confirm `
             + `dialog.`,
      technicalDetail: rawReason,
    })
  }
  return _shape({
    code:    'speed_refused',
    title:   "Speed change refused — program speed stayed the same.",
    detail:  'Try again in a moment. If it persists, check the driver '
           + 'link and operator cap in Monitor.',
    technicalDetail: rawReason || `HTTP ${httpStatus || '?'}`,
  })
}
