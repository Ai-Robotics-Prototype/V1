// Named-outcome mapping for /api/estun/program/run failures.
//
// The push endpoint returns a JSON body with `outcome.kind` on refusal.
// Historically the load handler surfaced a single generic warning
// "Loaded but push to controller failed: <server text>" — which turned
// every distinct failure (transport down, empty program, lint,
// byte-verify, codegen) into the same yellow toast the operator learned
// to ignore. That's what let the false resident-mismatch banner slip
// past on 2026-08-04 with :9000 down for 29 minutes.
//
// This helper maps each named outcome to operator-language: a headline
// plus a detail line. The driver's raw reason (when present) is
// propagated verbatim into `detail` so nothing gets swallowed. The
// dashboard uses these as error-severity toasts, not warnings — because
// the resident program did NOT change and the operator needs to act.

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

function _wireReason(body) {
  // Driver-reject strings live in outcome.reason. Codegen/lint infra
  // errors surface as top-level body.error. Best-effort — never throws.
  return (body && body.outcome && body.outcome.reason)
      || (body && body.error)
      || ''
}

export function namedLoadError(body, httpStatus) {
  const kind = (body && body.outcome && body.outcome.kind) || null
  const detail = _wireReason(body)

  if (kind === 'transport_down' || /ws not connected/i.test(detail)) {
    return {
      code:    'transport_down',
      headline: 'Controller link down — program NOT loaded. The '
              + 'controller kept the previous resident.',
      detail,
    }
  }
  if (kind === 'empty_program') {
    // The backend attaches motion_counts for the operator.
    const mc = body?.outcome?.motion_counts || {}
    const total = Number(mc.total || 0)
    const suffix = total > 0
      ? ` (${total} step${total === 1 ? '' : 's'} checked, none produce robot motion)`
      : ''
    return {
      code:    'empty_program',
      headline: 'Cannot load — this program has no valid motion. '
              + 'Teach positions first' + suffix + '.',
      detail,
    }
  }
  if (kind === 'pending_poses') {
    // Firmware bug #3 quarantine (2026-08-04). The controller
    // asserts v.size()>=6 at mm2mAndDeg2rad and exits process on
    // failure, so we refuse the push server-side. Named as
    // "regenerate required" because the fix is authoring-time —
    // the operator teaches the missing positions in the Program
    // Editor and the next push passes the gate.
    const count = Number(body?.outcome?.count || 0)
    const findings = body?.outcome?.findings || []
    const preview = findings
      .slice(0, 3)
      .map((f) => `step ${Number(f.step_idx || 0) + 1} ${f.action || '?'}`)
      .join(', ')
    const more = findings.length > 3 ? '…' : ''
    return {
      code:    'pending_poses',
      headline: 'Cannot load — known controller-crashing codegen. '
              + `Regenerate required: ${count} motion step`
              + `${count === 1 ? '' : 's'} have untaught positions`
              + (preview ? ` (${preview}${more})` : '')
              + '. Teach the missing positions in the Program '
              + 'Editor before running.',
      detail,
    }
  }
  if (kind === 'arity_assertion_failed') {
    return {
      code:    'arity_assertion_failed',
      headline: 'Cannot load — codegen produced a mov* line whose '
              + 'pose vector is not exactly 6 elements. Refusing '
              + 'to push (firmware v2.3 asserts v.size()>=6 at '
              + 'mm2mAndDeg2rad and exits process on failure).',
      detail,
    }
  }
  if (kind === 'lint_failed') {
    const count = Number(body?.outcome?.count || 0)
    const first = body?.outcome?.findings?.[0] || {}
    const at = first.line ? ` at line ${first.line}` : ''
    const verb = first.verb ? ` (verb ${first.verb})` : ''
    return {
      code:    'lint_failed',
      headline: `Cannot load — codegen produced ${count} invalid line`
              + `${count === 1 ? '' : 's'}${at}${verb}.`,
      detail,
    }
  }
  if (kind === 'byte_verify_mismatch') {
    const sent   = body?.outcome?.sent_sha   || '?'
    const stored = body?.outcome?.stored_sha || '?'
    return {
      code:    'byte_verify_mismatch',
      headline: 'Cannot load — controller stored a program that '
              + `differs from what codegen produced (sent ${sent}, `
              + `stored ${stored}). Refusing to run stale bytes.`,
      detail,
    }
  }
  if (kind === 'byte_verify_get_failed') {
    return {
      code:    'byte_verify_get_failed',
      headline: 'Cannot load — could not fetch stored program back '
              + 'from controller to verify the push. Try again.',
      detail,
    }
  }
  if (kind === 'save_rejected') {
    return {
      code:    'save_rejected',
      headline: 'Controller refused the save. Program NOT loaded.',
      detail,
    }
  }
  if (kind === 'save_failed') {
    return {
      code:    'save_failed',
      headline: 'Save to controller did not complete cleanly. '
              + 'Program NOT loaded.',
      detail,
    }
  }
  if (kind === 'id_not_controller_safe') {
    return {
      code:    'id_not_controller_safe',
      headline: 'Cannot load — this program id contains characters '
              + 'the controller cannot round-trip. Rename first '
              + '(letters + digits only).',
      detail,
    }
  }
  if (kind === 'lint_infrastructure_error') {
    return {
      code:    'lint_infrastructure_error',
      headline: 'Cannot load — the pre-push lint could not run. '
              + 'This is a dashboard bug; report it.',
      detail,
    }
  }
  // codegen: raw 500 with error body.
  if (httpStatus === 500 || /^codegen:/.test(detail)) {
    return {
      code:    'codegen',
      headline: 'Cannot load — codegen failed. Program NOT loaded.',
      detail,
    }
  }
  // Unknown shape. Preserve as much as possible so nothing is
  // silently eaten.
  return {
    code:    'unknown',
    headline: `Push refused (HTTP ${httpStatus || '?'}). Program NOT `
            + 'loaded.',
    detail:  detail || `HTTP ${httpStatus || '?'}`,
  }
}
