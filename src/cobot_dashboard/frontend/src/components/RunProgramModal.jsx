import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import { readPayload, PAYLOAD_UNSET_WARNING, PAYLOAD_INFO_ONLY }
  from '../lib/payload'
import { runnableStepCount } from '../lib/programTruth'
import { namedLoadError } from '../lib/loadOutcome'
import { namedModeError } from '../lib/modeOutcome'

// Confirm modal for the Monitor "Run Program" button. Reads the same
// currentProgram + robot.allow_move + robot.operator_speed_limit that
// the ladder pipeline gates on — so the modal shows the OPERATOR
// EXACTLY what will happen (which program, how many steps, what speed
// after the cap, whether the gate is even open).
//
// Behavior:
//   - Opens when store.runModalOpen === true (set by MonitorDashboard's
//     Run button handler).
//   - Confirm → POST /api/estun/program/run — the ladder-proven pipeline
//     kicks off (codegen → HTTP save → run) end-to-end. The response
//     surfaces:
//       ok=true  → run published, modal closes and Monitor's live line
//                  indicator takes over.
//       ok=false → gate closed or save failed. Modal stays open,
//                  showing the driver's OWN rejection reason (from
//                  STATE.robot.rejected's newest entry). Never a
//                  generic "something went wrong".
//   - Cancel or backdrop click → close, no wire traffic.
//
// The modal does NOT pre-check the gate. Per the operator's requirement
// (Lesson 97 follow-up), pressing Run with the gate closed must still
// attempt and surface the DRIVER'S rejection — proves the pipeline is
// wired end-to-end even when nothing moves.

export default function RunProgramModal() {
  const open           = useStore((s) => s.runModalOpen)
  const close          = useStore((s) => s.closeRunModal)
  const currentProgram = useStore((s) => s.currentProgram)
  const robot          = useStore((s) => s.robot) || {}
  const runSpeedPct    = useStore((s) => s.runSpeedPct)

  const [phase, setPhase]   = useState('confirm')  // 'confirm' | 'running' | 'error' | 'ok'
  const [result, setResult] = useState(null)
  // 2026-08-05 (operator_refusal_copy fork registry): the refusal
  // renders as a structured {title, detail, technicalDetail} triple
  // sourced from namedLoadError, matching the ToastContainer copy
  // register. The pre-fix `errorText` string dumped raw wire text
  // into a monospace box — operator saw "codegen:", HTTP codes,
  // driver reject strings without operator language.
  const [errorCopy, setErrorCopy] = useState(null)
  const [showTechnical, setShowTechnical] = useState(false)

  // Codegen staleness — polled once when the modal opens. If the
  // in-memory sha differs from the disk sha, the run WILL use the
  // OLD codegen and the manifest will stamp codegen_stale=true. We
  // never block; we just surface it prominently so the operator
  // sees it BEFORE the run (2026-07-30 4th-staleness episode).
  const [codegen, setCodegen] = useState(null)

  // Reset local state each time the modal is opened.
  useEffect(() => {
    if (open) {
      setPhase('confirm')
      setResult(null)
      setErrorCopy(null)
      setShowTechnical(false)
      setCodegen(null)
      // Fetch fresh state on every open — the operator may have
      // restarted the service between button presses.
      fetch('/api/codegen/status')
        .then((r) => r.ok ? r.json() : null)
        .then((body) => { if (body) setCodegen(body) })
        .catch(() => {})
    }
  }, [open])

  // 2026-08-28 addendum-52 cutover: read the run-backend flag +
  // target mode from provenance so the modal can auto-target
  // Remote (ros2_executor) vs Auto (legacy_lua). Hooks must
  // live above the `if (!open)` guard (rules-of-hooks).
  const [runBackend,    setRunBackend]    = useState('legacy_lua')
  const [targetModeStr, setTargetModeStr] = useState('auto')
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/provenance', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (cancelled || !d) return
        setRunBackend(String(d.run_backend || 'legacy_lua'))
        setTargetModeStr(String(d.run_backend_target_mode || 'auto'))
      })
      .catch(() => { /* nop */ })
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  const stepCount = Array.isArray(currentProgram?.steps) ? currentProgram.steps.length : 0
  // Shared programTruth.runnableStepCount — the SAME resolver Editor's
  // untaughtCount and Monitor's runnableStepCount use.  Mirrors
  // dashboard_server._has_taught_poses, including derived_from
  // implicit teaching and non-motion actions (2026-07-30 audit
  // #P1-2 — see docs/ui_truth_audit.md for the fork history).
  const taughtCount = runnableStepCount(currentProgram)
  // Controller-id round-trip safety: only [a-z0-9] ids can be
  // resolved by the controller's URL parser (underscore/dash get
  // treated as path separators and break project/run lookup).
  const idSafe = /^[a-z0-9]+$/.test(currentProgram?.id || '')
  // The Monitor speed input feeds runSpeedPct in the store; this
  // modal reads from THAT (not program.config.speed_pct) so what
  // the operator saw next to Run is exactly what confirm ships.
  const requestedPct = Number(
    runSpeedPct ?? currentProgram?.config?.speed_pct ?? currentProgram?.speed_pct ?? 10
  )
  const operatorCapFrac = Number(robot?.operator_speed_limit ?? 0.25)
  const operatorCapPct  = Math.max(1, Math.min(100, Math.round(operatorCapFrac * 100)))
  const effectivePct    = Math.max(1, Math.min(operatorCapPct, requestedPct))
  const isCapped        = requestedPct > operatorCapPct

  const allowMove   = !!robot.allow_move
  const monitorOnly = !!robot.monitor_only
  const connected   = !!robot.connected
  // 2026-08-28 mode-switch workflow sugar + addendum-52 cutover.
  // Legacy Lua-push runs in AUTO (code 0). ROS2 executor runs in
  // REMOTE (code 2, per HARDWARE.md > Robot-mode code table). The
  // target mode is read from /api/provenance.run_backend_target_mode
  // — see the fetch below.
  const robotModeCode = Number.isFinite(robot.robot_mode_code)
                          ? robot.robot_mode_code : -1
  const allowMode     = !!robot.allow_mode
  const targetModeCode = targetModeStr === 'remote' ? 2 : 0
  const inTarget       = robotModeCode === targetModeCode
  const willSwitchMode = !inTarget && allowMode
  const targetModeLabel = targetModeStr === 'remote' ? 'Remote' : 'Auto'
  // Kept for message compatibility with the pre-cutover copy.
  const willSwitchToAuto = willSwitchMode

  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const panel = {
    background: '#fff', borderRadius: 12,
    padding: 24, minWidth: 480, maxWidth: 560,
    boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
  }
  const titleStyle = { fontSize: 20, fontWeight: 700, marginBottom: 12, color: '#111827' }
  const rowStyle = { padding: '8px 0', borderBottom: '1px solid #f3f4f6',
                     display: 'flex', justifyContent: 'space-between', fontSize: 14 }
  const btnRow = { marginTop: 20, display: 'flex', gap: 12, justifyContent: 'flex-end' }
  const btnPrimary = (color, disabled) => ({
    padding: '12px 22px', fontSize: 15, fontWeight: 600,
    background: disabled ? '#9CA3AF' : color, color: '#fff',
    border: 'none', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const btnGhost = {
    padding: '12px 22px', fontSize: 15, fontWeight: 600,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
  }

  const gateOK = allowMove && !monitorOnly && connected

  async function confirmRun() {
    if (!currentProgram?.id) {
      setPhase('error')
      setErrorCopy({
        code: 'no_program',
        title: 'No program loaded — pick one from Program Library first.',
        detail: '',
        technicalDetail: '',
      })
      return
    }
    setPhase('running'); setResult(null); setErrorCopy(null); setShowTechnical(false)
    try {
      // Mode-switch pre-flight (2026-08-28): if we're not in AUTO
      // and the mode gate is open, transparently switch to AUTO
      // first. The endpoint blocks until read-back verify so we
      // KNOW the controller reached AUTO before we publish the
      // run op. A refusal here (arbiter, timeout, gate closed)
      // becomes the Run's structured error — the operator sees a
      // NAMED reason instead of a downstream "mode refused" from
      // the run itself.
      if (willSwitchMode) {
        const mres = await fetch('/api/estun/mode', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ target: targetModeStr }),
        })
        const mbody = await mres.json().catch(() => ({}))
        if (!mres.ok || !mbody.ok) {
          setPhase('error')
          // 2026-08-31: route every mode-refusal through the shared
          // named-copy mapper (parallel to namedLoadError). Prior
          // code flattened outcome.reason || outcome.detail into a
          // generic "Can't start — controller is not in Auto..."
          // title, which was wrong for Rung 0 (DI16 modeSwitch=0,
          // hardware selector in MANUAL) and Rung 2 (latched
          // errors[]). The ladder emits per-rung outcome.kind +
          // reason_code + four_tuple; the mapper produces the
          // operator-language title + detail per case and preserves
          // the wire fields in technicalDetail. Add-53 reframe:
          // Rung 1 (rs != 0) is retired; rs is session-persistent.
          setErrorCopy(namedModeError(mbody || {}, mres.status))
          return
        }
      }
      const res = await fetch('/api/estun/program/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          program_id: currentProgram.id,
          // Send the operator's Monitor-entered speed. Backend clamps
          // 1..100 then compares to operator_speed_limit for the hard
          // cap. We already display the cap outcome in the modal so
          // Confirm is a no-surprise action.
          run_speed_pct: requestedPct,
        }),
      })
      const body = await res.json()
      setResult(body)
      if (body?.ok) {
        // Run has been published; the driver's ProjectState will drive
        // the Monitor's live line indicator from here. Close the modal
        // after a brief pause so the operator sees the confirmation.
        setPhase('ok')
        setTimeout(close, 900)
      } else {
        setPhase('error')
        // 2026-08-05 (operator_refusal_copy): route through the
        // shared copy module — {title, detail, technicalDetail}.
        // Raw wire text (codegen tags, HTTP codes, driver reject
        // strings) is DEMOTED to technicalDetail, hidden behind
        // the Details toggle. Fork registry: operator_refusal_copy.
        setErrorCopy(namedLoadError(body || {}, res.status))
      }
    } catch (e) {
      setPhase('error')
      setErrorCopy({
        code:            'network',
        title:           "Couldn't reach the dashboard — network hiccup.",
        detail:          'Try again in a moment.',
        technicalDetail: String(e && e.message || e),
      })
    }
  }

  return (
    <div style={backdrop} onClick={phase === 'running' ? null : close}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={titleStyle}>
          {phase === 'ok' ? '✓ Run started' :
           phase === 'error' ? '⚠ Run refused' :
           phase === 'running' ? 'Starting…' :
           'Run this program on the REAL ARM?'}
        </div>

        {phase === 'confirm' && (
          <>
            <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 12 }}>
              This will overwrite the controller's stored copy of the
              program (fresh codegen every press — no stale points),
              then run it autonomously.
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Program</span>
              <span style={{ fontWeight: 600 }}>
                {currentProgram?.name || currentProgram?.id || '(none)'}
              </span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Steps</span>
              <span>
                {taughtCount} taught / {stepCount} total
              </span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Requested speed</span>
              <span>{requestedPct}%{isCapped ? ' (from Monitor input)' : ''}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>Operator cap</span>
              <span>{operatorCapPct}%</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280', fontWeight: 600 }}>
                Effective speed
              </span>
              <span style={{ fontWeight: 700, color: isCapped ? '#B45309' : '#059669' }}>
                {isCapped
                  ? `${effectivePct}% (capped from ${requestedPct}%)`
                  : `${effectivePct}%`}
                {' — runs on REAL ARM'}
              </span>
            </div>
            {/* Payload row — always shown so the operator sees whether
                a program was authored with a payload value. When unset
                a prominent warning appears below; when set an info
                line clarifies that this is metadata only (we do NOT
                emit setPayload — the verb isn't wire-proven; the
                controller selects payload via PayloadId preset). */}
            {(() => {
              const p = readPayload(currentProgram)
              return (
                <div style={rowStyle}>
                  <span style={{ color: '#6b7280' }}>Payload</span>
                  <span style={{
                    fontWeight: 700,
                    color: p.isSet ? '#065F46' : '#B45309',
                  }}>
                    {p.isSet
                      ? `${p.kg} kg${p.tool_name ? ` · ${p.tool_name}` : ''} (info only)`
                      : 'not set — see warning below'}
                  </span>
                </div>
              )
            })()}
            {(() => {
              const p = readPayload(currentProgram)
              if (p.isSet) {
                return (
                  <div style={{
                    marginTop: 12, padding: 10, background: '#EFF6FF',
                    border: '1px solid #93C5FD', borderRadius: 6,
                    color: '#1E3A8A', fontSize: 12, lineHeight: 1.5,
                  }}>
                    <b>Payload {p.kg} kg</b>{p.tool_name ? ` · ${p.tool_name}` : ''}.
                    {' '}{PAYLOAD_INFO_ONLY}
                  </div>
                )
              }
              return (
                <div style={{
                  marginTop: 12, padding: 10, background: '#FEF3C7',
                  border: '1px solid #F59E0B', borderRadius: 6,
                  color: '#92400E', fontSize: 13,
                }}>
                  <b>⚠ {PAYLOAD_UNSET_WARNING}</b>
                  {' '}Run is allowed — but every run without a payload
                  will keep showing this warning.
                </div>
              )
            })()}
            {!gateOK && (
              <div style={{
                marginTop: 12, padding: 10, background: '#FEF3C7',
                border: '1px solid #F59E0B', borderRadius: 6,
                color: '#92400E', fontSize: 13,
              }}>
                <b>Move gate closed.</b>{' '}
                {monitorOnly ? 'Driver is in MONITOR-ONLY mode. ' : ''}
                {!allowMove ? 'allow_move is FALSE. ' : ''}
                {!connected ? 'Driver not connected to controller. ' : ''}
                Pressing Confirm below WILL still send the request — the
                driver will refuse it, and the refusal reason appears here.
              </div>
            )}
            {codegen && codegen.stale && (
              <div style={{
                marginTop: 12, padding: 10, background: '#FEF3C7',
                border: '1px solid #F59E0B', borderRadius: 6,
                color: '#92400E', fontSize: 13, lineHeight: 1.5,
              }}
                data-testid="run-confirm-stale-warning">
                <b>⚠ Code updated on disk — restart required to apply.</b>
                {' '}The dashboard is still running the codegen it loaded
                at boot ({codegen.boot_sha}); disk is {codegen.disk_sha}.
                Confirming below WILL still send the request, but the
                controller will receive Lua from the OLD codegen and the
                run manifest will stamp <code>codegen_stale=true</code>.
                {' '}Restart <code>roboai-dashboard</code> +
                {' '}<code>roboai-estun</code> (or run
                {' '}<code>scripts/deploy.sh</code>) to apply the fix
                before pressing Run.
              </div>
            )}
            {taughtCount === 0 && (
              <div style={{
                marginTop: 12, padding: 10, background: '#FEE2E2',
                border: '1px solid #DC2626', borderRadius: 6,
                color: '#7F1D1D', fontSize: 13,
              }}>
                <b>Program has no taught poses.</b> Teach at least one
                point (Program tab → Teach current pose) or add
                taught steps before running.
              </div>
            )}
            {!idSafe && (
              <div style={{
                marginTop: 12, padding: 10, background: '#FEE2E2',
                border: '1px solid #DC2626', borderRadius: 6,
                color: '#7F1D1D', fontSize: 13,
              }}>
                <b>Program id <code>{currentProgram?.id}</code> can't round-trip on the controller.</b>{' '}
                Underscores and dashes are treated as path separators.
                Save this program under a new name (letters + digits only).
              </div>
            )}
            {willSwitchToAuto && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: 'rgba(5, 150, 105, 0.08)',
                border: '1px solid #059669', borderRadius: 6,
                fontSize: 13, color: '#065F46',
              }}>
                Robot is currently in <b>{
                  robotModeCode === 0 ? 'Auto' :
                  robotModeCode === 1 ? 'Manual' :
                  robotModeCode === 2 ? 'Remote' : 'an unknown mode'
                }</b>. Confirm will first switch to <b>{targetModeLabel}</b>, then start
                the program.
                {robot.enabled && (
                  <div style={{
                    marginTop: 6, fontSize: 12, color: '#7C2D12',
                  }}>
                    Arm is ENABLED — the controller refuses mode switches
                    while enabled. The endpoint will briefly disable the
                    arm, switch to {targetModeLabel}, then re-enable before starting.
                  </div>
                )}
              </div>
            )}
            {runBackend === 'legacy_lua' && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: 'rgba(148,163,184,0.08)',
                border: '1px dashed #94A3B8', borderRadius: 6,
                fontSize: 12, color: '#475569',
              }}>
                Executor: <b>legacy Lua-push</b>. F2.7 cutover pending
                — see ledger addendum-52. Once RUN_BACKEND=ros2_executor
                is set, this modal will target Remote instead of Auto
                and dispatch to the s10_140_executor package.
              </div>
            )}
            {runBackend === 'ros2_executor' && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: 'rgba(124, 58, 237, 0.08)',
                border: '1px solid #7C3AED', borderRadius: 6,
                fontSize: 12, color: '#5B21B6',
              }}>
                Executor: <b>ROS2 (s10_140_executor, Pilz PTP/LIN)</b>.
                The legacy Lua-push palletize codegen defect (§644
                IK-refuse + partial expansion) cannot exist on this
                path — L222 pre-submit validation refuses composites
                before dispatch.
              </div>
            )}
            <div style={btnRow}>
              <button style={btnGhost} onClick={close}>Cancel</button>
              <button
                style={btnPrimary('#16A34A', taughtCount === 0 || !idSafe)}
                onClick={confirmRun}
                disabled={taughtCount === 0 || !idSafe}>
                {willSwitchMode
                  ? `Switch to ${targetModeLabel} and run at ${effectivePct}%`
                  : `Confirm — Run at ${effectivePct}%`}
              </button>
            </div>
          </>
        )}

        {phase === 'running' && (
          <div style={{ fontSize: 14, color: '#374151', padding: '20px 0' }}>
            Publishing save + run to the driver…
          </div>
        )}

        {phase === 'ok' && result && (
          <>
            <div style={{ fontSize: 14, color: '#065F46', marginBottom: 12 }}>
              Run published. Watch the live line indicator on the Monitor
              for step-by-step progress.
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>program_id</span>
              <span style={{ fontFamily: 'monospace' }}>{result.program_id}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>source_hash</span>
              <span style={{ fontFamily: 'monospace' }}>{result.source_hash}</span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>effective_pct</span>
              <span>{result.effective_pct}%
                {result?.speed_note && (
                  <span style={{ color: '#B45309', marginLeft: 6 }}>
                    ({result.speed_note})
                  </span>
                )}
              </span>
            </div>
            <div style={rowStyle}>
              <span style={{ color: '#6b7280' }}>points</span>
              <span>{(result.points || []).join(', ') || '(none)'}</span>
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            {/* 2026-08-05 (operator_refusal_copy fork registry): the
                refusal renders as an operator-language title +
                detail. Raw wire text lives in `technicalDetail`
                behind a Details toggle — same register as the
                ToastContainer (267108a). Pre-fix, this box dumped
                `outcome.reason` verbatim, so operators saw phrases
                like "codegen:", "HTTP 5xx", and driver reject
                fragments with no explanation. */}
            <div data-testid="run-refused-copy" style={{
              padding: 12, background: '#FEE2E2',
              border: '1px solid #DC2626', borderRadius: 6,
              color: '#7F1D1D', fontSize: 14, marginBottom: 12,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {errorCopy?.title || 'Run refused.'}
              </div>
              {errorCopy?.detail && (
                <div style={{ fontWeight: 400, marginBottom: 4 }}>
                  {errorCopy.detail}
                </div>
              )}
              {errorCopy?.technicalDetail && (
                <>
                  <button
                    data-testid="run-refused-details-toggle"
                    onClick={(e) => { e.stopPropagation()
                                      setShowTechnical((v) => !v) }}
                    style={{
                      background: 'none', border: 'none',
                      color: '#7F1D1D', fontSize: 11,
                      textDecoration: 'underline', padding: 0,
                      marginTop: 6, cursor: 'pointer',
                    }}>
                    {showTechnical ? 'Hide details' : 'Details'}
                  </button>
                  {showTechnical && (
                    <pre
                      data-testid="run-refused-technical"
                      style={{
                        marginTop: 6, padding: 8,
                        background: '#FFFFFF',
                        border: '1px solid #FCA5A5',
                        borderRadius: 4,
                        fontSize: 11, fontFamily: 'monospace',
                        whiteSpace: 'pre-wrap',
                        color: '#7F1D1D',
                      }}>{errorCopy.technicalDetail}</pre>
                  )}
                </>
              )}
            </div>
            {result?.outcome?.payload_head && (
              <div style={{ fontSize: 12, color: '#6b7280',
                            fontFamily: 'monospace', marginBottom: 12 }}>
                driver payload: {result.outcome.payload_head}
              </div>
            )}
            <div style={btnRow}>
              <button style={btnGhost} onClick={close}>Close</button>
              <button style={btnPrimary('#16A34A', false)} onClick={confirmRun}>
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
