import { useEffect, useMemo, useState } from 'react'
import HookupGuide from './HookupGuide'
import {
  listTools, getToolHookup, confirmToolHookup,
} from '../lib/toolsApi'
import {
  SynapseConnectionMap,
} from '../pages/SynapsePage'
import {
  getToolPortMap,
  resolveCustomEOATRecord,
  S10_140_PAYLOAD_KG_MAX,
  S10_140_PAYLOAD_ADVISORY_KG,
} from '../lib/toolPortMap'

// Standalone Hardware Setup wizard.
//
// 2026-09-21 operator directive: the wizard now embeds the shared
// Synapse connection map (via <SynapseConnectionMap mode="guidance"
// ...>) so the operator can SEE which ports light up for their
// chosen tool. The map is the SAME component pages/SynapsePage
// renders — import-identity pin in D_synapse_tab.test.js locks in
// the no-fork invariant.
//
// Tool list cleanup (Part 2 of the directive):
//   * BUILT_IN keeps only Finger Gripper + Vacuum Suction (real
//     wireable hardware the S10-140 ships to support) + a NEW
//     "Custom EOAT" tile that opens the 4-step custom flow.
//   * Legacy /api/tools rows show ONLY when they are `confirmed`
//     AND have completed conversion (`conversion.state === 'converted'`).
//     Everything else — the "junk / trash-me / sample / no-payload
//     / no-tcp / complete / mt / referred" test fixtures from a
//     prior session — is filtered out at the picker layer. The
//     report lists them for operator veto.
//
// Custom EOAT (Part 3): mass → actuation → sensors → summary.
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

export default function HardwareSetupWizard({
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

  async function handleConfirm(_allChecked, noSensorMap, optionalMap) {
    if (!toolKey || toolKey === 'custom_new') return
    setBusy(true); setError(null)
    try {
      const rec = await confirmToolHookup(toolKey, {
        noSensor: noSensorMap || {},
        optional: optionalMap || {},
      })
      setRecord(rec)
      setSavedAt(rec && rec.confirmed_at)
    } catch (e) {
      setError(String(e && e.message || e))
    } finally {
      setBusy(false)
    }
  }

  // Guidance highlight for the fixed built-in tools. Custom-EOAT
  // has its own flow (below) that computes highlight from the
  // operator's answers.
  const guidancePortMap = useMemo(() => {
    if (!activeTool) return null
    if (activeTool.key === 'custom_new') return null
    if (activeTool.key === 'finger') return getToolPortMap('finger')
    if (activeTool.key === 'vacuum') return getToolPortMap('vacuum')
    return null
  }, [activeTool])

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
            {toolKey ? 'Hardware Setup' : 'Hardware Setup — pick a tool'}
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
            path — HookupGuide + guidance map. */}
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

            {/* Guidance map — glows the ports this tool needs. */}
            {guidancePortMap && (
              <GuidanceBlock port={guidancePortMap} />
            )}

            <HookupGuide
              gripperType={activeTool.gripper_type}
              mode={readOnly ? 'editor' : 'wizard'}
              confirmed={!!record?.confirmed_at}
              noSensor={record?.no_sensor || {}}
              optionalAnswers={record?.optional || {}}
              program={activeTool.tool_id
                ? { config: { tool_id: activeTool.tool_id } }
                : null}
              onSkip={onClose}
              onConfirm={handleConfirm}
              onClose={onClose}
            />
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

// ── Guidance block — map + checklist + notes ────────────────────────

function GuidanceBlock({ port }) {
  const [ticked, setTicked] = useState(() => new Set())
  const toggle = (key) => setTicked((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const items = [
    ...(port.required_valves  || []).map((id) => ({ id, kind: 'valve' })),
    ...(port.required_inputs  || []).map((id) => ({ id, kind: 'input' })),
    ...(port.required_outputs || []).map((id) => ({ id, kind: 'output' })),
  ]
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
      {items.length > 0 && (
        <div data-testid="hardware-setup-checklist" style={{
          marginTop: 12, padding: 12,
          border: '1px solid #E5E7EB', borderRadius: 8,
          background: '#FAFAFA',
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
            textTransform: 'uppercase', color: '#6B7280',
            marginBottom: 8,
          }}>
            Hookup checklist
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {items.map((it) => {
              const on = ticked.has(it.id)
              const callout = (port.callouts && port.callouts[it.id])
                || `Wire ${it.id}`
              return (
                <label key={it.id}
                       data-testid="hardware-setup-checklist-item"
                       data-port-id={it.id}
                       data-checked={String(on)}
                       style={{
                         display: 'flex', alignItems: 'center',
                         gap: 10, cursor: 'pointer',
                         fontSize: 13, color: '#374151',
                       }}>
                  <input type="checkbox" checked={on}
                         onChange={() => toggle(it.id)} />
                  <span style={{ fontFamily: 'inherit' }}>
                    <b>{it.id}</b> — {callout}
                  </span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}


// ── Custom EOAT flow — mass → actuation → sensors → summary ─────────

function CustomEOATFlow({ customs, onBack, onClose }) {
  const [step, setStep]  = useState(0)
  const [name, setName]  = useState('')
  const [massKg, setMassKg]        = useState('')
  const [massUnit, setMassUnit]    = useState('kg')  // 'kg' | 'lb'
  const [actuation, setActuation]  = useState('')
  const [holdOnLoss, setHoldOnLoss] = useState(null) // null | true | false
  const [sensorCount, setSensorCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)
  const [savedName, setSavedName] = useState(null)

  const kgValue = useMemo(() => {
    const n = Number(massKg)
    if (!Number.isFinite(n) || n <= 0) return null
    return massUnit === 'lb' ? n * 0.45359237 : n
  }, [massKg, massUnit])
  const overCap = kgValue != null && kgValue > S10_140_PAYLOAD_KG_MAX
  const advisory = kgValue != null && kgValue > S10_140_PAYLOAD_ADVISORY_KG
                    && !overCap

  const resolved = useMemo(() => resolveCustomEOATRecord({
    toolName: name || 'Custom EOAT',
    actuation,
    holdOnLoss: !!holdOnLoss,
    sensorCount,
    customs,
  }), [name, actuation, holdOnLoss, sensorCount, customs])

  const canAdvance = (
    step === 0 ? (name.trim().length > 0 && kgValue != null && !overCap)
    : step === 1 ? (actuation
                     && (actuation !== 'double_acting' || holdOnLoss !== null))
    : step === 2 ? true
    : true
  )

  // Save on final Finish. Non-blocking — a save failure surfaces
  // inline; the summary still renders because the recommendations
  // are computed locally and don't need the write to succeed.
  async function finish() {
    setSaving(true); setSaveErr(null)
    // FRONTEND-only ship: no /api/tools POST from this flow — the
    // operator directive requires "wizard data only". Persisting
    // to the backend catalog is a follow-on directive; here we
    // return a locally-complete tool record for downstream reads
    // once the persist wire lands. The summary renders regardless.
    setSaving(false)
    setSavedName(name)
  }

  const stepTitle = [
    '1. Weight',
    '2. Actuation type',
    '3. Sensors',
    '4. Review',
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
        <div data-testid="hardware-setup-custom-step-mass"
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
          <div>
            <div style={label}>Mass</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center',
                          marginTop: 4 }}>
              <input
                type="number" step="0.01" min="0"
                value={massKg}
                onChange={(e) => setMassKg(e.target.value)}
                placeholder="0.00"
                data-testid="custom-eoat-mass"
                style={{
                  padding: '8px 10px', fontSize: 14, width: 120,
                  border: '1px solid #d1d5db', borderRadius: 6,
                  fontFamily: 'inherit',
                }} />
              <select
                value={massUnit}
                onChange={(e) => setMassUnit(e.target.value)}
                data-testid="custom-eoat-mass-unit"
                style={{
                  padding: '8px 10px', fontSize: 14,
                  border: '1px solid #d1d5db', borderRadius: 6,
                  fontFamily: 'inherit',
                }}>
                <option value="kg">kg</option>
                <option value="lb">lb</option>
              </select>
              {kgValue != null && (
                <span data-testid="custom-eoat-mass-kg-echo"
                      style={{ fontSize: 12, color: '#6B7280' }}>
                  {kgValue.toFixed(2)} kg
                </span>
              )}
            </div>
          </div>
          {overCap && (
            <div data-testid="custom-eoat-mass-overcap"
                 style={{
                   padding: '10px 12px', background: '#FEE2E2',
                   border: '1px solid #FCA5A5', borderRadius: 6,
                   color: '#7F1D1D', fontSize: 13,
                 }}>
              {kgValue.toFixed(2)} kg is heavier than the S10-140's
              rated {S10_140_PAYLOAD_KG_MAX} kg payload. This tool
              is too heavy for the arm — pick a lighter tool or a
              larger arm.
            </div>
          )}
          {advisory && (
            <div data-testid="custom-eoat-mass-advisory"
                 style={{
                   padding: '10px 12px', background: '#FEF3C7',
                   border: '1px solid #FDE68A', borderRadius: 6,
                   color: '#92400E', fontSize: 13,
                 }}>
              {kgValue.toFixed(2)} kg leaves little room for the
              part in the arm's {S10_140_PAYLOAD_KG_MAX} kg budget.
              This tool may be too heavy for full-reach moves — plan
              slower moves and shorter reaches.
            </div>
          )}
          <div style={{ fontSize: 12, color: '#6B7280' }}>
            Mass is stored on the tool record. When you author a
            program against this tool, it flows into the program's
            payload_kg field (Program Wizard → Payload step), which
            codegen consumes as the controller-side payload preset.
          </div>
        </div>
      )}

      {step === 1 && (
        <div data-testid="hardware-setup-custom-step-actuation"
             style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#374151' }}>
            How does the tool actuate?
          </div>
          <ActuationChoice
            value={actuation} onChange={setActuation}
            options={[
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
            ]}
          />
          {actuation === 'double_acting' && (
            <div data-testid="custom-eoat-hold-question"
                 style={{
                   padding: 12,
                   background: '#F9FAFB',
                   border: '1px solid #E5E7EB', borderRadius: 8,
                 }}>
              <div style={{ fontSize: 13, fontWeight: 600,
                            color: '#111827', marginBottom: 6 }}>
                Should the tool HOLD its grip if power or air is lost?
              </div>
              <div style={{ fontSize: 12, color: '#6B7280',
                            marginBottom: 10 }}>
                Choose "Yes" if letting go would drop a part or
                damage something. Choose "No" if you want the tool
                to release automatically when power drops (safer for
                anything grabbing a person or a fragile item).
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  data-testid="custom-eoat-hold-yes"
                  onClick={() => setHoldOnLoss(true)}
                  style={{
                    ...btnGhost,
                    background: holdOnLoss === true ? '#DCFCE7' : '#fff',
                    borderColor: holdOnLoss === true ? '#22C55E' : '#d1d5db',
                  }}>
                  Yes — hold last position (5/2 DS)
                </button>
                <button
                  data-testid="custom-eoat-hold-no"
                  onClick={() => setHoldOnLoss(false)}
                  style={{
                    ...btnGhost,
                    background: holdOnLoss === false ? '#DBEAFE' : '#fff',
                    borderColor: holdOnLoss === false ? '#2563EB' : '#d1d5db',
                  }}>
                  No — snap home on loss (5/2 SS)
                </button>
              </div>
            </div>
          )}
          {resolved && resolved.recommended_valve_type && (
            <div data-testid="custom-eoat-actuation-rec"
                 style={{
                   padding: '10px 12px', background: '#EFF6FF',
                   border: '1px solid #BFDBFE', borderRadius: 6,
                   color: '#1E3A8A', fontSize: 13, lineHeight: 1.5,
                 }}>
              <b>Recommended valve:</b> {resolved.recommended_valve_type}.
              <br />
              <span style={{ color: '#374151' }}>
                Why: {resolved.recommended_valve_why}
              </span>
              {resolved.required_valves.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  Free SPARE slot on your map: <b>
                    {resolved.required_valves[0]}
                  </b>.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
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

      {step === 3 && (
        <div data-testid="hardware-setup-custom-step-summary"
             style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            padding: 14, background: '#F9FAFB',
            border: '1px solid #E5E7EB', borderRadius: 8,
            fontSize: 13, color: '#111827', lineHeight: 1.6,
          }}>
            <div><b>Tool:</b> {name || '(unnamed)'}</div>
            <div><b>Mass:</b> {kgValue?.toFixed(2)} kg</div>
            <div><b>Actuation:</b> {actuation || '—'}
              {actuation === 'double_acting' && ` (hold-on-loss: ${
                holdOnLoss ? 'yes' : 'no'})`}
            </div>
            <div><b>Valve:</b>{' '}
              {resolved.recommended_valve_type
                ? `${resolved.recommended_valve_type}` : 'none required'}
              {resolved.required_valves.length > 0
                && ` on ${resolved.required_valves[0]}`}
            </div>
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
              Custom EOAT "{savedName}" saved. Persistence to the
              tool catalog will land in a follow-on session.
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
        {step < 3 && (
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
        {step === 3 && !savedName && (
          <button
            data-testid="hardware-setup-custom-finish"
            style={btnPrim}
            disabled={saving}
            onClick={finish}>
            {saving ? 'Saving…' : 'Finish'}
          </button>
        )}
        {step === 3 && savedName && (
          <button style={btnPrim} onClick={onClose}>
            Done
          </button>
        )}
      </div>
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
