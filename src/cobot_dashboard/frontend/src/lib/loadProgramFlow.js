// loadProgramFlow — SHARED load-to-Monitor flow, used by both
// MonitorDashboard's "Change Program → select" overlay and the
// Program Library's "Load to Monitor →" button. One loader, not a
// second parallel implementation.
//
// 184ada3 behavior (2026-09-04): a refused controller push must NOT
// erase the loaded program from the editor. The prior policy held
// currentProgram back until push succeeded, so a real on-disk program
// that push-refused (semantic_roundtrip / pallet_ik_refused / etc.)
// snapped the editor to "Untitled Program / no taught poses" and the
// operator concluded the program was lost. New policy: commit the
// local currentProgram from the fetched JSON REGARDLESS of push
// outcome. The refusal toast explains WHY the controller doesn't have
// it yet.
//
// Contract: never publish `run` or motion verbs — this is a LOAD, not
// a RUN. The only wire call is push_only:true which stops before
// to_auto/run publishing (see api_estun_program_run's push-only
// shortcut, sha 4e8bda3 amended 2026-08-31).

import { namedLoadError } from './loadOutcome'

/**
 * @param {object} opts
 * @param {string} opts.programId          Program slug to load.
 * @param {string} [opts.programLabel]     Display name for toasts.
 * @param {function} opts.setCurrentProgram Store action.
 * @param {function} opts.addToast         Store action.
 * @param {function} [opts.setPushingProgramName]  Optional Monitor
 *   local state setter for the "Pushing…" pill during the push. Not
 *   required — Library-triggered loads pass undefined and skip it.
 * @returns {Promise<{ok: boolean, program?: object, named?: object,
 *                    status?: number, body?: object, err?: any}>}
 */
export async function loadProgramFlow({
  programId,
  programLabel,
  setCurrentProgram,
  addToast,
  setPushingProgramName,
}) {
  if (!programId) return { ok: false, err: new Error('programId required') }

  // 1. Fetch the program JSON. A failure here is a HARD stop — no
  //    partial commit into currentProgram.
  let full
  try {
    const res = await fetch('/api/programs/' + encodeURIComponent(programId))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    full = await res.json()
  } catch (e) {
    addToast?.('Load failed: ' + (e?.message || e), 'error')
    return { ok: false, err: e }
  }
  if (!(full && Array.isArray(full.steps))) {
    addToast?.('Load failed: program has no steps', 'error')
    return { ok: false, err: new Error('no steps') }
  }

  // 2. Kick off the push_only. `pushingProgramName` (Monitor's
  //    optional local state) shows the "Pushing…" pill during the
  //    call; if the caller doesn't pass it we just skip that
  //    affordance.
  setPushingProgramName?.(programLabel || programId)
  let pushRes, body
  try {
    pushRes = await fetch('/api/estun/program/run', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        program_id: full.id,
        push_only:  true,
      }),
    })
    body = await pushRes.json().catch(() => ({}))
  } catch (e) {
    setPushingProgramName?.(null)
    // Network-level failure. Still commit currentProgram (184ada3).
    setCurrentProgram({
      id:          full.id,
      name:        full.name,
      description: full.description || '',
      steps:       full.steps,
      config:      full.config || {},
    })
    const named = {
      code:   'network',
      title:  'Push failed — network error. Program loaded locally only.',
      detail: String(e && e.message || e),
    }
    addToast?.({ title: named.title, detail: named.detail }, 'error', 10000)
    return { ok: false, program: full, named, err: e }
  }
  setPushingProgramName?.(null)

  // 3. Commit local state FIRST, always. Program is loaded into the
  //    editor; the push outcome only decides whether the controller
  //    also has it.
  setCurrentProgram({
    id:          full.id,
    name:        full.name,
    description: full.description || '',
    steps:       full.steps,
    config:      full.config || {},
  })

  if (!pushRes.ok) {
    const named = namedLoadError(body, pushRes.status)
    addToast?.(
      { title: named.title, detail: named.detail,
        technicalDetail: named.technicalDetail },
      'error', 10000)
    if (named.technicalDetail) {
      // eslint-disable-next-line no-console
      console.warn('[load] refused', {
        code: named.code, technicalDetail: named.technicalDetail,
        status: pushRes.status, body,
      })
    }
    return { ok: false, program: full, named,
             status: pushRes.status, body }
  }
  addToast?.('Loaded "' + (full.name || full.id) + '"', 'success')
  return { ok: true, program: full, body }
}
