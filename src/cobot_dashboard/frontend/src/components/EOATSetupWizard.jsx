import { useEffect, useMemo, useState } from 'react'
import {
  listTools, getToolHookup, confirmToolHookup,
} from '../lib/toolsApi'
import {
  SynapseConnectionMap,
} from '../pages/SynapsePage'
import {
  getToolPortMap,
  resolveCustomEOATRecord,
  resolvePersistedCustomToolPortMap,
} from '../lib/toolPortMap'
import {
  getCell, saveCellEoat,
} from '../lib/cellStore'

// Standalone EOAT Setup wizard.
//
// 2026-09-22 operator directive (hardware-setup cleanup): the OLD
// per-panel hookup checklist (HookupGuide with its pre-Synapse port
// map graphics) is RETIRED. The Synapse glowing map is the ONLY
// wiring guide in this step, and its per-port callout list carries
// the tick-offs — no doubled affordances.
//
// Three tool paths, each with its own glow set:
//   * Finger gripper → getToolPortMap('finger') (5/2 valve + 2 IN)
//   * Vacuum suction → getToolPortMap('vacuum') (3/2 N/C + 1 IN)
//   * Custom EOAT   → resolvePersistedCustomToolPortMap() from the
//                     saved tool.config.assigned_valve / _inputs.
//                     When the custom flow hasn't finished those
//                     assignments the step renders a "finish your
//                     tool definition" notice with a link back to
//                     the picker rather than a blank map.
//
// Import-identity pin: the wizard reuses the SynapseConnectionMap
// export from pages/SynapsePage — no fork. D_synapse_tab.test.js
// pins it at the source level.
//
// Tool list cleanup:
//   * BUILT_IN keeps only Finger Gripper + Vacuum Suction (real
//     wireable hardware the S10-140 ships to support) + a NEW
//     "Custom EOAT" tile that opens the 4-step custom flow.
//   * Legacy /api/tools rows show ONLY when they are `confirmed`
//     AND have completed conversion (`conversion.state === 'converted'`).
//
// Custom EOAT flow: mass → actuation → sensors → summary.
// Recommendations reuse the valve-info-panel copy (VALVE_TYPE_INFO
// from SynapsePage) so a single edit to the valve explainers
// updates the wizard, the panel, and the summary at the same time.

const BUILT_IN = [
  { key: 'finger',
    gripper_type: 'finger',
    label: 'Finger Gripper',
    desc: 'Two-jaw parallel gripper. Best for rigid parts with flat gripping surfaces.' },
  { key: 'vacuum',
    gripper_type: 'vacuum',
    label: 'Vacuum Suction',
    desc: 'Vacuum cup picks from the top. Best for flat, smooth, sealed surfaces.' },
  { key: 'custom_new',
    gripper_type: 'custom',
    label: 'Custom EOAT',
    desc: 'Walk through the setup for a tool that is not in this list — mass, actuation type, sensors.' },
]

// Sensible defaults for the built-in paths (operator can lower
// toward 0 or raise toward the max). Keeps the pre-directive glow
// set unchanged for operators who tap through without editing.
const _STANDARD_SENSOR_DEFAULTS = { finger: 2, vacuum: 1 }
const _STANDARD_SENSOR_MAX      = { finger: 3, vacuum: 3 }

export default function EOATSetupWizard({
  onClose, initialToolKey = null, readOnly = false,
}) {
  const [customs, setCustoms]     = useState([])
  const [customsErr, setCE]       = useState(null)
  const [toolKey, setToolKey]     = useState(initialToolKey || null)
  const [record, setRecord]       = useState(null)
  const [recordLoaded, setRL]     = useState(false)
  const [busy, setBusy]           = useState(false)
  const [error, setError]         = useState(null)
  const [savedAt, setSavedAt]     = useState(null)
  // Standard-path sensor count — editable 0..max per tool key; the
  // directive asks the standard gripper/vacuum paths to let the
  // operator change the sensor count instead of hard-coding it.
  // Keyed by toolKey so flipping between finger and vacuum retains
  // their own answer.
  const [standardSensors, setStandardSensors] = useState({})

  useEffect(() => {
    let alive = true
    listTools()
      .then((rows) => { if (alive) setCustoms(rows || []) })
      .catch((e) => { if (alive) setCE(String(e && e.message || e)) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    setRecord(null); setRL(false); setError(null); setSavedAt(null)
    if (!toolKey || toolKey === 'custom_new') return
    let alive = true
    getToolHookup(toolKey)
      .then((rec) => { if (alive) { setRecord(rec); setRL(true) } })
      .catch((e) => { if (alive) { setError(String(e && e.message || e)); setRL(true) } })
    return () => { alive = false }
  }, [toolKey])

  // 2026-09-21 tool-list cleanup: filter customs. Show only tools
  // that survived STEP conversion AND have been confirmed. The
  // 16 test-fixture rows on the operator's box (names: junk,
  // trash-me, no-tcp, no-payload, sample, complete, mt, referred)
  // all fail one or both gates and stay hidden.
  const visibleCustoms = useMemo(() => {
    return (customs || []).filter((t) => {
      const converted = t?.conversion?.state === 'converted'
      const confirmed = !!t?.confirmed
      return converted && confirmed
    })
  }, [customs])

  const activeTool = useMemo(() => {
    if (!toolKey) return null
    if (toolKey === 'vacuum' || toolKey === 'finger') {
      return BUILT_IN.find((b) => b.key === toolKey) || null
    }
    if (toolKey === 'custom_new') {
      return BUILT_IN.find((b) => b.key === 'custom_new') || null
    }
    if (toolKey.startsWith('custom:')) {
      const tid = toolKey.slice('custom:'.length)
      const t = customs.find((c) => c.id === tid)
      return {
        key: toolKey, gripper_type: 'custom', tool_id: tid,
        label: (t && t.name) || `Custom tool ${tid.slice(0, 6)}`,
        desc: 'Custom EOAT with operator-assigned I/O.',
      }
    }
    return null
  }, [toolKey, customs])

  // Guidance highlight per tool path:
  //   finger / vacuum → fixed built-in port map
  //   custom:<id>     → derived from the saved tool's assigned_valve
  //                     + assigned_inputs (persisted by the Custom
  //                     EOAT flow at completion). When those are
  //                     missing/empty the block renders an incomplete
  //                     notice instead of a blank map.
  //   custom_new      → handled by CustomEOATFlow (its own render)
  const activeStandardSensorCount = useMemo(() => {
    if (!activeTool) return null
    const key = activeTool.key
    if (key !== 'finger' && key !== 'vacuum') return null
    const override = standardSensors[key]
    if (typeof override === 'number' && override >= 0) return override
    return _STANDARD_SENSOR_DEFAULTS[key] ?? 0
  }, [activeTool, standardSensors])

  const guidancePortMap = useMemo(() => {
    if (!activeTool) return null
    if (activeTool.key === 'custom_new') return null
    if (activeTool.key === 'finger' || activeTool.key === 'vacuum') {
      return _buildStandardPortMap(activeTool.key,
        activeStandardSensorCount)
    }
    if (activeTool.key.startsWith('custom:')) {
      const tool = customs.find((c) => c.id === activeTool.tool_id)
      return resolvePersistedCustomToolPortMap(tool)
    }
    return null
  }, [activeTool, customs, activeStandardSensorCount])

  // Empty confirm — the tick-offs live on the map's callout list,
  // no per-input no-sensor/optional detail collected here anymore
  // (the retired HookupGuide owned those maps).
  //
  // Standard-path confirmation now ALSO writes a cell entry so the
  // program wizard's tool picker shows this tool as a card. Custom-
  // persisted paths (toolKey = 'custom:<id>') keep writing the
  // legacy /api/tools confirmToolHookup record; the Custom EOAT
  // flow writes its own cell entry at finish().
  async function handleGuidanceConfirm() {
    if (!toolKey || toolKey === 'custom_new') return
    setBusy(true); setError(null)
    try {
      const rec = await confirmToolHookup(toolKey,
        { noSensor: {}, optional: {} })
      setRecord(rec)
      setSavedAt(rec && rec.confirmed_at)
      // Mirror the confirmation into the cell for finger/vacuum
      // so the Program Wizard's tool-step shows this tool as a
      // card immediately after confirmation.
      if (toolKey === 'finger' || toolKey === 'vacuum') {
        try {
          const sensors = activeStandardSensorCount ?? 0
          const port = _buildStandardPortMap(toolKey, sensors)
          const entry = _standardCellEntry({
            toolKey, port, sensorCount: sensors,
          })
          await saveCellEoat(entry)
        } catch (ce) {
          // Soft failure — the legacy confirm already succeeded.
          setError(`Saved tool, but cell mirror failed: ${
            String(ce && ce.message || ce)}`)
        }
      }
    } catch (e) {
      setError(String(e && e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    zIndex: 9998, display: 'flex', alignItems: 'center',
    justifyContent: 'center',
  }
  const panel = {
    background: '#fff', borderRadius: 12,
    padding: 24, width: 'min(960px, 96vw)',
    maxHeight: '92vh', overflow: 'auto',
    boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
    fontFamily: 'inherit',
  }
  const titleStyle = {
    fontSize: 20, fontWeight: 700, marginBottom: 12, color: '#111827',
  }
  const btnGhost = {
    padding: '10px 16px', fontSize: 14, fontWeight: 600,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
    fontFamily: 'inherit',
  }

  return (
    <div style={backdrop} onClick={busy ? null : onClose}
         data-testid="hardware-setup-wizard">
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={titleStyle}>
            {toolKey ? 'EOAT Setup' : 'EOAT Setup — pick a tool'}
          </div>
          <button style={btnGhost} onClick={onClose}
                  data-testid="hardware-setup-close">
            Close
          </button>
        </div>

        {!toolKey && (
          <div data-testid="hardware-setup-picker">
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
              Pick the end-of-arm tool you want to wire up. Each tool
              keeps its OWN hookup confirmation — programs read it
              via the tool they were authored against.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {BUILT_IN.map((b) => (
                <ToolChoice key={b.key} tool={b}
                            onPick={() => setToolKey(b.key)} />
              ))}
              {visibleCustoms.map((t) => (
                <ToolChoice
                  key={t.id}
                  tool={{
                    key: `custom:${t.id}`,
                    gripper_type: 'custom',
                    tool_id: t.id,
                    label: t.name || `Custom tool ${t.id.slice(0, 6)}`,
                    desc: 'EOAT-library tool.',
                  }}
                  onPick={() => setToolKey(`custom:${t.id}`)}
                />
              ))}
              {customsErr && (
                <div style={{ fontSize: 12, color: '#B45309' }}>
                  Custom tool list unavailable: {customsErr}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Custom EOAT flow — its own wizard branch */}
        {toolKey === 'custom_new' && activeTool && (
          <CustomEOATFlow
            customs={customs}
            onBack={() => setToolKey(null)}
            onClose={onClose}
          />
        )}

        {/* Existing (built-in or already-configured custom) tool
            path — Synapse glowing map is the sole wiring guide. */}
        {toolKey && toolKey !== 'custom_new' && activeTool && (
          <div data-testid="hardware-setup-body">
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 12,
            }}>
              {!initialToolKey && (
                <button style={btnGhost} onClick={() => setToolKey(null)}
                        data-testid="hardware-setup-back">
                  ← Change tool
                </button>
              )}
              <div style={{ fontSize: 14, color: '#374151' }}>
                Tool: <b>{activeTool.label}</b>
              </div>
              {recordLoaded && (
                <div data-testid="hardware-setup-status"
                     data-confirmed-at={record?.confirmed_at || ''}
                     style={{
                       marginLeft: 'auto',
                       fontSize: 12,
                       color: record?.confirmed_at ? '#065F46' : '#92400E',
                     }}>
                  {record?.confirmed_at
                    ? `Confirmed ${_formatDate(record.confirmed_at)}`
                    : 'Not yet confirmed'}
                </div>
              )}
            </div>

            {guidancePortMap && (
              <>
                {(activeTool.key === 'finger'
                    || activeTool.key === 'vacuum') && (
                  <StandardSensorCount
                    toolKey={activeTool.key}
                    value={activeStandardSensorCount ?? 0}
                    max={_STANDARD_SENSOR_MAX[activeTool.key] || 3}
                    disabled={readOnly}
                    onChange={(n) => setStandardSensors((prev) => ({
                      ...prev, [activeTool.key]: n,
                    }))}
                  />
                )}
                <GuidanceBlock port={guidancePortMap} />
                {!readOnly && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button style={btnGhost} onClick={onClose}
                            data-testid="hardware-setup-skip">
                      Skip — already connected
                    </button>
                    <button
                      data-testid="hardware-setup-confirm"
                      onClick={handleGuidanceConfirm}
                      disabled={busy}
                      style={{
                        padding: '10px 16px', fontSize: 14, fontWeight: 700,
                        background: '#16A34A', color: '#fff',
                        border: '1px solid #15803d', borderRadius: 8,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        opacity: busy ? 0.55 : 1,
                        fontFamily: 'inherit',
                      }}>
                      {busy ? 'Saving…' : 'All connected — Confirm'}
                    </button>
                  </div>
                )}
              </>
            )}
            {!guidancePortMap && activeTool.key.startsWith('custom:') && (
              <div data-testid="hardware-setup-custom-incomplete"
                   style={{
                     padding: 14, borderRadius: 8,
                     background: '#FEF3C7', color: '#92400E',
                     border: '1px solid #FDE68A',
                     fontSize: 13, lineHeight: 1.5,
                   }}>
                <b>Finish this tool's definition before wiring it up.</b>
                {' '}The Custom EOAT flow didn't record which valve or
                sensor inputs this tool uses, so there's nothing to
                glow on the map yet.
                {!initialToolKey && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      data-testid="hardware-setup-custom-incomplete-back"
                      onClick={() => setToolKey('custom_new')}
                      style={{
                        padding: '8px 14px', fontSize: 13, fontWeight: 700,
                        background: '#fff', color: '#92400E',
                        border: '1px solid #F59E0B', borderRadius: 6,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}>
                      Open the Custom EOAT flow →
                    </button>
                  </div>
                )}
              </div>
            )}
            {savedAt && (
              <div data-testid="hardware-setup-saved"
                   style={{
                     marginTop: 10, padding: '8px 12px',
                     background: '#ECFDF5',
                     border: '1px solid #6EE7B7', borderRadius: 6,
                     color: '#065F46', fontSize: 12,
                   }}>
                Saved — this tool's hookup is now confirmed as of{' '}
                <b>{_formatDate(savedAt)}</b>.
              </div>
            )}
            {error && (
              <div style={{
                marginTop: 10, padding: '8px 12px',
                background: '#FEE2E2', border: '1px solid #FCA5A5',
                borderRadius: 6, color: '#7F1D1D', fontSize: 12,
              }}>
                {error}
              </div>
            )}
          </div>
        )}

        {toolKey && toolKey !== 'custom_new' && !activeTool && recordLoaded && (
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            No such tool. It may have been deleted from the EOAT
            library. Close and pick another.
          </div>
        )}
      </div>
    </div>
  )
}

function ToolChoice({ tool, onPick }) {
  return (
    <button
      onClick={onPick}
      data-testid="hardware-setup-tool-choice"
      data-tool-key={tool.key}
      style={{
        textAlign: 'left', padding: '12px 14px',
        background: '#fff', border: '1px solid #d1d5db',
        borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
      }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
        {tool.label}
      </div>
      {tool.desc && (
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
          {tool.desc}
        </div>
      )}
    </button>
  )
}

// ── Guidance block — map + notes ────────────────────────────────────
//
// 2026-10-01 operator directive: the duplicate "Hookup checklist"
// (checkbox items[] list that used to render below the map) is
// RETIRED. The glowing map carries the per-connection callouts via
// labelOverrides + the type pill — one surface, one confirmation
// button in the parent. See old-checklist-absent pin in
// D_synapse_tab.test.js for the no-regression grep.

export function GuidanceBlock({ port }) {
  const highlight = {
    valves:  port.required_valves  || [],
    inputs:  port.required_inputs  || [],
    outputs: port.required_outputs || [],
  }
  return (
    <div data-testid="hardware-setup-guidance"
         style={{ marginBottom: 16 }}>
      {port.notes && (
        <div style={{
          padding: '10px 12px', marginBottom: 12,
          background: '#EFF6FF', border: '1px solid #BFDBFE',
          borderRadius: 6, color: '#1E3A8A',
          fontSize: 13, lineHeight: 1.5,
        }}>
          {port.notes}
        </div>
      )}
      <SynapseConnectionMap
        mode="guidance"
        highlight={highlight}
        labelOverrides={port.label_overrides || {}}
        typeOverrides={port.type_overrides || {}}
      />
    </div>
  )
}

// Standard-path sensor-count chooser (2026-10-01 directive). The
// built-in finger + vacuum paths now let the operator pick a sensor
// count instead of hard-coding one. Defaults are preselected
// (finger: 2 limit switches, vacuum: 1 vacuum switch) so a tap-
// through workflow lands on the same glow set as before.
function StandardSensorCount({ toolKey, value, max, disabled, onChange }) {
  const choices = []
  for (let n = 0; n <= Math.min(max, 3); n++) choices.push(n)
  return (
    <div data-testid="hardware-setup-standard-sensors"
         data-tool-key={toolKey}
         data-count={String(value)}
         style={{
           padding: '10px 12px', marginBottom: 12,
           background: '#F9FAFB', border: '1px solid #E5E7EB',
           borderRadius: 6, color: '#374151',
         }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        How many feedback sensors does this tool have?{' '}
        <span style={{ color: '#6B7280' }}>
          (default {_STANDARD_SENSOR_DEFAULTS[toolKey] ?? 0} —
          typical for this tool)
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {choices.map((n) => (
          <button
            key={n}
            data-testid="hardware-setup-standard-sensor-count"
            data-count={String(n)}
            disabled={disabled}
            onClick={() => onChange(n)}
            style={{
              padding: '6px 12px', fontSize: 13, fontWeight: 700,
              background: value === n ? '#DBEAFE' : '#fff',
              color:      value === n ? '#1E40AF' : '#374151',
              border: `1px solid ${value === n ? '#2563EB' : '#d1d5db'}`,
              borderRadius: 6,
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', opacity: disabled ? 0.55 : 1,
            }}>
            {n}
          </button>
        ))}
      </div>
    </div>
  )
}


// ── Custom EOAT flow — name → actuation → sensors → summary ────────
//
// 2026-09-22: the Weight step is retired. Mass was local wizard
// state (never persisted — finish() intentionally never POSTed to
// /api/tools); its overcap/advisory warnings went with it. If a
// per-tool payload correction is needed later, it lives on the
// tool record (tools_library.update_payload), not in a setup step.

// Flow steps (2026-10-01 operator directive — actuator count +
// per-actuator walkthrough):
//   0 — Tool name
//   1 — Actuator count ("How many air-driven actions does this
//                        tool have?", 1-4; more → contact us copy)
//   2 — Per-actuator loop (type + hold-on-loss where relevant);
//        rendered as a single step with N inline sub-cards so the
//        operator sees every actuator at once instead of a
//        setStep flicker.
//   3 — Sensors
//   4 — Review (summary + save to cell)
const _ACTUATOR_MAX = 4

function CustomEOATFlow({ customs, onBack, onClose }) {
  const [step, setStep]  = useState(0)
  const [name, setName]  = useState('')
  const [actuatorCount, setActuatorCount] = useState(1)
  // actuators[i] = { type, holdOnLoss | null }. Length always
  // matches actuatorCount — we resize on count change so index
  // stability is preserved.
  const [actuators, setActuators] = useState([{ type: '', holdOnLoss: null }])
  const [sensorCount, setSensorCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)
  const [savedName, setSavedName] = useState(null)

  function _setActuatorCount(n) {
    const bounded = Math.max(1, Math.min(_ACTUATOR_MAX, n))
    setActuatorCount(bounded)
    setActuators((prev) => {
      const next = [...prev]
      while (next.length < bounded) next.push({ type: '', holdOnLoss: null })
      next.length = bounded
      return next
    })
  }
  function _patchActuator(i, patch) {
    setActuators((prev) => prev.map((a, j) =>
      (i === j ? { ...a, ...patch } : a)))
  }

  const resolved = useMemo(() => resolveCustomEOATRecord({
    toolName: name || 'Custom EOAT',
    actuators,
    sensorCount,
    customs,
  }), [name, actuators, sensorCount, customs])

  const perActuatorReady = actuators.every((a) =>
    a.type && (a.type !== 'double_acting' || a.holdOnLoss !== null))

  const canAdvance = (
    step === 0 ? name.trim().length > 0
    : step === 1 ? actuatorCount >= 1 && actuatorCount <= _ACTUATOR_MAX
    : step === 2 ? perActuatorReady
    : step === 3 ? true
    : true
  )

  async function finish() {
    setSaving(true); setSaveErr(null)
    try {
      const entry = {
        name: name.trim(),
        type: 'custom',
        valve: resolved.required_valves[0] || null,
        inputs: resolved.required_inputs || [],
        outputs: [],
        actuators: (resolved.actuators || []).map((a) => ({
          type: a.type,
          hold_on_loss: a.hold_on_loss,
          valve: a.valve,
          label: a.label,
        })),
        sensor_count: sensorCount,
      }
      await saveCellEoat(entry)
      setSavedName(name)
    } catch (e) {
      setSaveErr(String(e && e.message || e))
    } finally {
      setSaving(false)
    }
  }

  const stepTitle = [
    '1. Tool name',
    '2. How many actuators?',
    '3. Set up each actuator',
    '4. Sensors',
    '5. Review',
  ][step]

  const wrap = { display: 'flex', flexDirection: 'column', gap: 14 }
  const label = { fontSize: 12, color: '#6B7280', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: 0.4 }
  const btnPrim = {
    padding: '10px 18px', fontSize: 14, fontWeight: 700,
    background: '#0284c7', color: '#fff', border: '1px solid #0369a1',
    borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
  }
  const btnGhost = {
    padding: '10px 16px', fontSize: 14, fontWeight: 600,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
    fontFamily: 'inherit',
  }

  return (
    <div data-testid="hardware-setup-custom-flow"
         data-step={String(step)}
         style={wrap}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <button style={btnGhost}
                data-testid="hardware-setup-custom-back"
                onClick={() => (step === 0 ? onBack() : setStep(step - 1))}>
          ← Back
        </button>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
          Custom EOAT — {stepTitle}
        </div>
      </div>

      {step === 0 && (
        <div data-testid="hardware-setup-custom-step-name"
             style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={label}>Tool name</div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Custom Vacuum Head"
              data-testid="custom-eoat-name"
              style={{
                marginTop: 4, padding: '8px 10px', fontSize: 14,
                width: '100%', maxWidth: 320,
                border: '1px solid #d1d5db', borderRadius: 6,
                fontFamily: 'inherit',
              }} />
          </div>
          <div style={{ fontSize: 12, color: '#6B7280' }}>
            Pick a short, distinctive name — you'll see it in the
            tool picker and in program references.
          </div>
        </div>
      )}

      {step === 1 && (
        <div data-testid="hardware-setup-custom-step-actuator-count"
             style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#374151' }}>
            How many air-driven actions does this tool have?{' '}
            <span style={{ color: '#6B7280' }}>
              (A gripper that also has a blow-off = 2.
              A gripper with no extras = 1.)
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                data-testid="custom-eoat-actuator-count"
                data-count={String(n)}
                onClick={() => _setActuatorCount(n)}
                style={{
                  padding: '10px 16px', fontSize: 14, fontWeight: 700,
                  background: actuatorCount === n ? '#DBEAFE' : '#fff',
                  color: actuatorCount === n ? '#1E40AF' : '#374151',
                  border: `1px solid ${actuatorCount === n ? '#2563EB' : '#d1d5db'}`,
                  borderRadius: 8, cursor: 'pointer',
                  fontFamily: 'inherit',
                }}>
                {n}
              </button>
            ))}
          </div>
          <div data-testid="custom-eoat-actuator-count-contact"
               style={{ fontSize: 12, color: '#6B7280' }}>
            Need more than {_ACTUATOR_MAX}? Contact us — we'll
            help route the extra valves off a bigger manifold.
          </div>
        </div>
      )}

      {step === 2 && (
        <div data-testid="hardware-setup-custom-step-actuators"
             style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#374151' }}>
            Walk through each air-driven action — pick its type
            (and, if it's double-acting, whether it should hold on
            power loss). We'll assign each one its own valve from
            the free SPARE slots on your Synapse map.
          </div>
          {actuators.map((a, i) => (
            <ActuatorCard
              key={i}
              index={i}
              total={actuators.length}
              value={a}
              resolved={resolved.actuators?.[i] || null}
              onChange={(patch) => _patchActuator(i, patch)}
              btnGhost={btnGhost}
            />
          ))}
        </div>
      )}

      {step === 3 && (
        <div data-testid="hardware-setup-custom-step-sensors"
             style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#374151' }}>
            How many feedback sensors does this tool have?
            <span style={{ color: '#6B7280' }}>
              {' '}(0 to 3; PNP proximity switches, 24 VDC per the panel spec)
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[0, 1, 2, 3].map((n) => (
              <button
                key={n}
                data-testid="custom-eoat-sensor-count"
                data-count={String(n)}
                onClick={() => setSensorCount(n)}
                style={{
                  padding: '10px 16px', fontSize: 14, fontWeight: 700,
                  background: sensorCount === n ? '#DBEAFE' : '#fff',
                  color: sensorCount === n ? '#1E40AF' : '#374151',
                  border: `1px solid ${sensorCount === n ? '#2563EB' : '#d1d5db'}`,
                  borderRadius: 8, cursor: 'pointer',
                  fontFamily: 'inherit',
                }}>
                {n}
              </button>
            ))}
          </div>
          {sensorCount > 0 && resolved.required_inputs.length > 0 && (
            <div data-testid="custom-eoat-sensor-assignments"
                 style={{
                   padding: '10px 12px', background: '#F0FDF4',
                   border: '1px solid #86EFAC', borderRadius: 6,
                   color: '#166534', fontSize: 13, lineHeight: 1.5,
                 }}>
              Assigned to: <b>
                {resolved.required_inputs.join(', ')}
              </b>.
              These are the next free IN ports on your Synapse map.
            </div>
          )}
        </div>
      )}

      {step === 4 && (
        <div data-testid="hardware-setup-custom-step-summary"
             style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            padding: 14, background: '#F9FAFB',
            border: '1px solid #E5E7EB', borderRadius: 8,
            fontSize: 13, color: '#111827', lineHeight: 1.6,
          }}>
            <div><b>Tool:</b> {name || '(unnamed)'}</div>
            <div><b>Actuators:</b> {actuators.length}</div>
            {(resolved.actuators || []).map((a, i) => (
              <div key={i} data-testid="custom-eoat-summary-actuator"
                   style={{ marginLeft: 12 }}>
                • {a.label}: {a.recommended_valve_type || 'no valve'}
                {a.valve ? ` on ${a.valve}` : ''}
                {a.type === 'double_acting'
                  && ` (hold-on-loss: ${a.hold_on_loss ? 'yes' : 'no'})`}
              </div>
            ))}
            <div><b>Sensors:</b> {sensorCount}
              {resolved.required_inputs.length > 0
                && ` on ${resolved.required_inputs.join(', ')}`}
            </div>
          </div>
          <GuidanceBlock port={resolved} />
          {savedName && (
            <div data-testid="hardware-setup-custom-saved"
                 style={{
                   padding: '10px 12px', background: '#ECFDF5',
                   border: '1px solid #6EE7B7', borderRadius: 6,
                   color: '#065F46', fontSize: 12,
                 }}>
              Custom EOAT "{savedName}" saved to the cell. It will
              appear in the Program Wizard's tool picker on the
              next step.
            </div>
          )}
          {saveErr && (
            <div style={{
              padding: '10px 12px', background: '#FEE2E2',
              border: '1px solid #FCA5A5', borderRadius: 6,
              color: '#7F1D1D', fontSize: 12,
            }}>
              {saveErr}
            </div>
          )}
        </div>
      )}

      <div style={{
        display: 'flex', gap: 8, justifyContent: 'flex-end',
        marginTop: 10,
      }}>
        {step < 4 && (
          <button
            data-testid="hardware-setup-custom-next"
            style={{
              ...btnPrim,
              opacity: canAdvance ? 1 : 0.4,
              cursor: canAdvance ? 'pointer' : 'not-allowed',
            }}
            disabled={!canAdvance}
            onClick={() => setStep(step + 1)}>
            Next →
          </button>
        )}
        {step === 4 && !savedName && (
          <button
            data-testid="hardware-setup-custom-finish"
            style={btnPrim}
            disabled={saving}
            onClick={finish}>
            {saving ? 'Saving…' : 'Finish'}
          </button>
        )}
        {step === 4 && savedName && (
          <button style={btnPrim} onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </div>
  )
}

function ActuatorCard({
  index, total, value, resolved, onChange, btnGhost,
}) {
  const options = [
    { key: 'single_acting',
      label: 'Pneumatic — single-acting (spring return)',
      desc: 'One coil + spring; snaps to home on power loss.' },
    { key: 'double_acting',
      label: 'Pneumatic — double-acting (two coils)',
      desc: 'Two coils; holds last position or snaps home '
            + 'depending on which valve you pick.' },
    { key: 'vacuum',
      label: 'Vacuum',
      desc: 'Uses a 3/2 Normally Closed valve; default off, '
            + 'pulse to draw vacuum.' },
    { key: 'electric_none',
      label: 'Electric / no actuation',
      desc: 'No pneumatic valve required (motor-driven, '
            + 'sensor-only, or passive tool).' },
  ]
  return (
    <div data-testid="custom-eoat-actuator-card"
         data-actuator-index={String(index)}
         style={{
           padding: 12, background: '#fff',
           border: '1px solid #E5E7EB', borderRadius: 8,
         }}>
      <div style={{
        fontSize: 12, fontWeight: 700, letterSpacing: 0.4,
        textTransform: 'uppercase', color: '#6B7280',
        marginBottom: 8,
      }}>
        Actuator {index + 1} of {total}
      </div>
      <ActuationChoice
        value={value.type}
        onChange={(t) => onChange({ type: t,
          holdOnLoss: t === 'double_acting' ? value.holdOnLoss : null })}
        options={options}
      />
      {value.type === 'double_acting' && (
        <div data-testid="custom-eoat-hold-question"
             data-actuator-index={String(index)}
             style={{
               marginTop: 10, padding: 12,
               background: '#F9FAFB',
               border: '1px solid #E5E7EB', borderRadius: 8,
             }}>
          <div style={{ fontSize: 13, fontWeight: 600,
                        color: '#111827', marginBottom: 6 }}>
            Should this actuator HOLD its position if power or air
            is lost?
          </div>
          <div style={{ fontSize: 12, color: '#6B7280',
                        marginBottom: 10 }}>
            Choose "Yes" if letting go would drop a part or damage
            something. Choose "No" if you want it to release
            automatically when power drops.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              data-testid="custom-eoat-hold-yes"
              data-actuator-index={String(index)}
              onClick={() => onChange({ holdOnLoss: true })}
              style={{
                ...btnGhost,
                background: value.holdOnLoss === true ? '#DCFCE7' : '#fff',
                borderColor: value.holdOnLoss === true ? '#22C55E' : '#d1d5db',
              }}>
              Yes — hold last position (5/2 DS)
            </button>
            <button
              data-testid="custom-eoat-hold-no"
              data-actuator-index={String(index)}
              onClick={() => onChange({ holdOnLoss: false })}
              style={{
                ...btnGhost,
                background: value.holdOnLoss === false ? '#DBEAFE' : '#fff',
                borderColor: value.holdOnLoss === false ? '#2563EB' : '#d1d5db',
              }}>
              No — snap home on loss (5/2 SS)
            </button>
          </div>
        </div>
      )}
      {resolved && resolved.recommended_valve_type && (
        <div data-testid="custom-eoat-actuation-rec"
             data-actuator-index={String(index)}
             style={{
               marginTop: 10,
               padding: '10px 12px', background: '#EFF6FF',
               border: '1px solid #BFDBFE', borderRadius: 6,
               color: '#1E3A8A', fontSize: 13, lineHeight: 1.5,
             }}>
          <b>Recommended valve:</b> {resolved.recommended_valve_type}.
          <br />
          <span style={{ color: '#374151' }}>
            Why: {resolved.recommended_valve_why}
          </span>
          {resolved.valve && (
            <div style={{ marginTop: 6 }}>
              Free SPARE slot on your map: <b>{resolved.valve}</b>.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ActuationChoice({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map((o) => (
        <button
          key={o.key}
          data-testid="custom-eoat-actuation"
          data-value={o.key}
          data-selected={String(value === o.key)}
          onClick={() => onChange(o.key)}
          style={{
            textAlign: 'left', padding: '10px 12px',
            background: value === o.key ? '#DBEAFE' : '#fff',
            border: `1px solid ${value === o.key ? '#2563EB' : '#d1d5db'}`,
            borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
          }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
            {o.label}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {o.desc}
          </div>
        </button>
      ))}
    </div>
  )
}

function _formatDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric' })
  } catch { return iso }
}

// Build the standard-path glow set with an editable sensor count.
// Trims / extends the fixed table's required_inputs list to match
// the operator's chosen count, keeping call-outs for the inputs
// that remain. The valve + its callout are unchanged.
function _buildStandardPortMap(toolKey, sensorCount) {
  const base = getToolPortMap(toolKey)
  if (!base) return null
  const n = Math.max(0, Math.min(sensorCount || 0,
    _STANDARD_SENSOR_MAX[toolKey] || 3))
  const baseInputs = base.required_inputs || []
  let inputs
  if (n <= baseInputs.length) {
    inputs = baseInputs.slice(0, n)
  } else {
    // Extend from the first free IN not already in the list.
    inputs = [...baseInputs]
    for (let i = 1; i <= 10 && inputs.length < n; i++) {
      const id = `IN${String(i).padStart(2, '0')}`
      if (!inputs.includes(id)) inputs.push(id)
    }
  }
  const callouts = {}
  // Preserve the valve callout from the fixed table.
  for (const [k, v] of Object.entries(base.callouts || {})) {
    if (inputs.includes(k) || (base.required_valves || []).includes(k)) {
      callouts[k] = v
    }
  }
  // Any extended inputs get a generic callout so the map still
  // reads cleanly below the fixed-table rows.
  for (const id of inputs) {
    if (!callouts[id]) callouts[id] = `Wire sensor on ${id}`
  }
  return {
    ...base,
    required_inputs: inputs,
    callouts,
  }
}

// Project a standard-path confirmation into a cell.eoats entry. The
// stable id lets re-confirmation update in place instead of adding
// a duplicate card. Legacy single-valve shape preserved alongside
// the new actuators[] array so cellStore and the program wizard
// can read either.
function _standardCellEntry({ toolKey, port, sensorCount }) {
  const name = toolKey === 'finger'
    ? 'Finger Gripper'
    : toolKey === 'vacuum'
      ? 'Vacuum Suction'
      : 'EOAT'
  const valve = (port.required_valves || [])[0] || null
  const inputs = Array.from(port.required_inputs || [])
  const actuators = valve
    ? [{
        type: toolKey === 'vacuum' ? 'vacuum' : 'single_acting',
        hold_on_loss: false,
        valve,
        label: toolKey === 'vacuum' ? 'vacuum' : 'actuator',
      }]
    : []
  return {
    id:       `standard:${toolKey}`,
    name,
    type:     toolKey,
    valve,
    inputs,
    outputs:  [],
    actuators,
    sensor_count: sensorCount,
    tool_ref: null,
  }
}
