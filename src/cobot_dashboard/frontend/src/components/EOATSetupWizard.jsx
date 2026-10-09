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
import { useKeyboardInset } from '../lib/keyboardInset'
import { useStore } from '../store/useStore'
import { portDisplayName, portListDisplay } from '../lib/cellEntryDisplay'
import {
  useIoHardwareProfile, isOemProfile, shouldShowSynapseMap,
  formatPortName, wiringTargetCopy, profileInterfaceNoun,
} from '../lib/ioHardwareProfile'
import { useSynapsePortmap } from '../lib/synapsePortmap'
import WhyExpander from './WhyExpander'
import {
  CAPABILITY_CATALOG as _CAPABILITY_CATALOG,
  capabilityDef, actuatorsFromCapabilities,
} from '../lib/eoatCapabilities'

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
    desc: 'Two-jaw gripper that opens and closes on parts with flat sides.' },
  { key: 'vacuum',
    gripper_type: 'vacuum',
    label: 'Vacuum Suction',
    desc: 'A cup that picks parts from the top using suction. Best for flat, smooth surfaces.' },
  { key: 'custom_new',
    gripper_type: 'custom',
    label: 'Custom tool',
    desc: 'Set up a tool that is not in this list — tell us what it does and we will do the rest.' },
]

// Sensible defaults for the built-in paths (operator can lower
// toward 0 or raise toward the max). Keeps the pre-directive glow
// set unchanged for operators who tap through without editing.
const _STANDARD_SENSOR_DEFAULTS = { finger: 2, vacuum: 1 }
const _STANDARD_SENSOR_MAX      = { finger: 3, vacuum: 3 }

// Default profile names for the standard paths. The operator can
// edit before confirming — the directive requires the NAME be the
// operator's word, since program-wizard cards render it verbatim.
const _STANDARD_NAME_DEFAULTS = {
  finger: 'Finger Gripper',
  vacuum: 'Vacuum Tool',
}

// Fresh actuator record for the custom flow. Hold / check-valve
// preselects are applied on actuator-TYPE pick (ActuatorCard's
// onChange handler) — a brand-new actuator with no type has both
// fields cleared so the picker starts from zero.
function _defaultActuator() {
  return { type: '', holdOnLoss: null, hasCheckValve: null }
}

// Shared duplicate-name predicate. Case-insensitive, trimmed. When
// `excludeId` is set, allows the operator to rename back to the same
// name on the same entry.
function _nameClashes(cell, candidate, excludeId = null) {
  const want = String(candidate || '').trim().toLowerCase()
  if (!want) return false
  for (const e of (cell && cell.eoats) || []) {
    if (excludeId && e.id === excludeId) continue
    if (String(e.name || '').trim().toLowerCase() === want) return true
  }
  return false
}

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
  // Standard-path operator-editable name — 2026-10-01 directive: the
  // profile name is what the program-wizard tool card displays, so
  // the operator writes it in their own words. Prefilled from
  // _STANDARD_NAME_DEFAULTS; kept per-tool so switching paths
  // preserves answers.
  const [standardNames, setStandardNames] = useState({})
  // Cell snapshot for duplicate-name guards + "saved" screen render.
  const [cell, setCell]           = useState(null)
  // After a successful save (standard OR custom), the wizard
  // switches to a dedicated "saved" screen with [View in My Cell]
  // + [Set up another tool] + [Done]. Never silently ends.
  const [savedEntry, setSavedEntry] = useState(null)

  // On-screen keyboard inset — the standard-path name input + custom
  // name input both benefit, so apply once at the wizard level.
  useKeyboardInset()

  // Load the cell on mount (for duplicate-name checks + the saved
  // confirmation screen's cross-link). Refetched after any save so
  // the duplicate-guard sees the fresh cell during a multi-tool
  // session.
  async function _refetchCell() {
    try { setCell(await getCell()) } catch { /* keep prior cell */ }
  }
  useEffect(() => { _refetchCell() }, [])

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

  const activeStandardName = useMemo(() => {
    if (!activeTool) return ''
    const key = activeTool.key
    if (key !== 'finger' && key !== 'vacuum') return ''
    const override = standardNames[key]
    if (typeof override === 'string') return override
    return _STANDARD_NAME_DEFAULTS[key] || ''
  }, [activeTool, standardNames])

  // Duplicate-name check for the standard confirm path. The entry
  // id is deterministic ("standard:finger" / "standard:vacuum"), so
  // a rename of the SAME standard tool back to its default name is
  // not a collision — excludeId lets through that case.
  const standardNameClash = useMemo(() => {
    if (!activeTool) return false
    const key = activeTool.key
    if (key !== 'finger' && key !== 'vacuum') return false
    return _nameClashes(cell, activeStandardName,
      `standard:${key}`)
  }, [cell, activeTool, activeStandardName])

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
    // Standard path: enforce duplicate-name guard BEFORE touching
    // any network — the operator's name is a precondition, not an
    // override, and the custom path has the same guarantee.
    if (toolKey === 'finger' || toolKey === 'vacuum') {
      const nameTrim = activeStandardName.trim()
      if (!nameTrim) {
        setError('Give this tool a name before saving.')
        return
      }
      if (standardNameClash) {
        setError(`You already have a tool named "${nameTrim}" — pick another name.`)
        return
      }
    }
    setBusy(true); setError(null)
    try {
      const rec = await confirmToolHookup(toolKey,
        { noSensor: {}, optional: {} })
      setRecord(rec)
      setSavedAt(rec && rec.confirmed_at)
      // Mirror the confirmation into the cell for finger/vacuum so
      // the Program Wizard's tool-step shows this tool as a card
      // immediately after confirmation. The cell entry carries the
      // operator's name (not the type label) because the directive
      // makes the operator's word the single source for the card.
      if (toolKey === 'finger' || toolKey === 'vacuum') {
        try {
          const sensors = activeStandardSensorCount ?? 0
          const port = _buildStandardPortMap(toolKey, sensors)
          const entry = _standardCellEntry({
            toolKey,
            name: activeStandardName.trim(),
            port,
            sensorCount: sensors,
          })
          const saved = await saveCellEoat(entry)
          // Refresh the cell AND switch to the saved screen — the
          // operator never sees a silent-end wizard.
          await _refetchCell()
          setSavedEntry(saved || entry)
        } catch (ce) {
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

  // Operator-facing nav helper — "View in My Cell" jumps to the
  // Synapse tab where MyCellSection is mounted, then closes the
  // wizard. Called from the saved-confirmation screens on all three
  // paths.
  function viewInMyCell() {
    try { useStore.getState().setTab('synapse') } catch { /* ignore */ }
    onClose()
  }

  // "Set up another tool" — stay in the wizard, reset back to the
  // picker. Preserves the saved tool in the cell; the picker now
  // shows it as an entry on the next pass.
  function setupAnother() {
    setSavedEntry(null)
    setSavedAt(null)
    setToolKey(null)
    setError(null)
    _refetchCell()
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
              Pick the tool at the end of the robot arm. Each one
              remembers how it is wired, so programs that use it
              know what to send and what to listen for.
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
                    desc: 'A tool you set up earlier.',
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
            cell={cell}
            onCellChanged={_refetchCell}
            onBack={() => setToolKey(null)}
            onClose={onClose}
            onViewInMyCell={viewInMyCell}
            onSetupAnother={setupAnother}
          />
        )}

        {/* Existing (built-in or already-configured custom) tool
            path — Synapse glowing map is the sole wiring guide. */}
        {toolKey && toolKey !== 'custom_new' && activeTool
            && !savedEntry && (
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
                  <StandardNameInput
                    toolKey={activeTool.key}
                    value={activeStandardName}
                    disabled={readOnly}
                    clash={standardNameClash}
                    onChange={(s) => setStandardNames((prev) => ({
                      ...prev, [activeTool.key]: s,
                    }))}
                  />
                )}
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
                {/* 2026-10-05 operator order: the suction check-valve
                    explainer box (data-testid=hardware-setup-vacuum-
                    check-valve-note) is retired from the hookup /
                    guidance screen — it was noise on the wiring view.
                    The always-holds behavior stays recorded on the
                    tool (holds_on_loss=true + holds_via='check_valve'
                    in _standardCellEntry, 247cda8) and the confirm-
                    step read-only line is unchanged. */}
                {activeTool.key === 'finger' && (
                  <div data-testid="hardware-setup-finger-hold-note"
                       style={{
                         padding: '8px 12px', marginBottom: 10,
                         background: '#ECFDF5', border: '1px solid #6EE7B7',
                         borderRadius: 6, color: '#065F46',
                         fontSize: 12, lineHeight: 1.5,
                       }}>
                    Recommended — the fingers keep holding the part
                    if the robot suddenly stops.
                    <WhyExpander
                      label="How?"
                      testId="hardware-setup-finger-why">
                      The default valve is a 5/2 DS (double-solenoid)
                      so the gripper remembers its last commanded
                      position when power or air drops.
                    </WhyExpander>
                  </div>
                )}
                {!readOnly && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button style={btnGhost} onClick={onClose}
                            data-testid="hardware-setup-skip">
                      Skip — already connected
                    </button>
                    <button
                      data-testid="hardware-setup-confirm"
                      onClick={handleGuidanceConfirm}
                      disabled={busy
                        || ((activeTool.key === 'finger'
                              || activeTool.key === 'vacuum')
                            && (!activeStandardName.trim()
                                || standardNameClash))}
                      style={{
                        padding: '10px 16px', fontSize: 14, fontWeight: 700,
                        background: '#16A34A', color: '#fff',
                        border: '1px solid #15803d', borderRadius: 8,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        opacity: busy ? 0.55 : 1,
                        fontFamily: 'inherit',
                      }}>
                      {busy ? 'Saving…' : 'Add Tool'}
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
                <b>Tell us about this tool before wiring it up.</b>
                {' '}The custom tool flow didn't finish — we don't
                know which air lines or sensors this tool uses, so
                there's nothing to point at on the map yet.
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
                      Open the custom tool flow →
                    </button>
                  </div>
                )}
              </div>
            )}
            {error && (
              <div data-testid="hardware-setup-error"
                   style={{
                     marginTop: 10, padding: '8px 12px',
                     background: '#FEE2E2', border: '1px solid #FCA5A5',
                     borderRadius: 6, color: '#7F1D1D', fontSize: 12,
                   }}>
                {error}
              </div>
            )}
          </div>
        )}

        {/* Saved-confirmation screen — standard-path exit surface
            (2026-10-01 directive). Custom path has its OWN saved
            screen embedded in CustomEOATFlow because that flow has
            richer summary content already assembled. */}
        {savedEntry && toolKey !== 'custom_new' && (
          <SavedScreen
            entry={savedEntry}
            onViewInMyCell={viewInMyCell}
            onSetupAnother={setupAnother}
            onDone={onClose}
          />
        )}

        {toolKey && toolKey !== 'custom_new' && !activeTool && recordLoaded && (
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            No such tool. It may have been removed from your tool
            list. Close and pick another.
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
  const profile = useIoHardwareProfile()
  const portmap = useSynapsePortmap()
  return (
    <div data-testid="hardware-setup-guidance"
         data-io-profile={profile}
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
      {shouldShowSynapseMap(profile) ? (
        <SynapseConnectionMap
          mode="guidance"
          highlight={highlight}
          labelOverrides={port.label_overrides || {}}
          typeOverrides={port.type_overrides || {}}
        />
      ) : (
        <OemWiringGuidance
          highlight={highlight}
          labelOverrides={port.label_overrides || {}}
          portmap={portmap}
        />
      )}
    </div>
  )
}

// OEM wiring guidance — replaces the Synapse connection-map diagram
// when the operator has declared the OEM profile. Lists each port the
// tool requires, resolved to its CC10-A native channel (DO<n>/DI<n>),
// with the operator-friendly label from the Synapse-side callouts
// repurposed as the per-row description. Instructions read "Wire the
// gripper's valve to output DO3 on the controller" rather than
// "Connect to Valve 03" + a glowing panel diagram.
function OemWiringGuidance({ highlight, labelOverrides, portmap }) {
  const rows = []
  for (const v of (highlight.valves || [])) {
    rows.push({
      kind: 'valve', synapseId: v,
      role: labelOverrides[v] || 'Valve',
    })
  }
  for (const i of (highlight.inputs || [])) {
    rows.push({
      kind: 'input', synapseId: i,
      role: labelOverrides[i] || 'Sensor input',
    })
  }
  for (const o of (highlight.outputs || [])) {
    rows.push({
      kind: 'output', synapseId: o,
      role: labelOverrides[o] || 'Output',
    })
  }
  return (
    <div
      data-testid="oem-wiring-guidance"
      style={{
        padding: 12,
        background: '#F9FAFB', border: '1px solid #E5E7EB',
        borderRadius: 8, color: '#111827',
      }}>
      <div style={{
        fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: 0.6, color: '#374151', marginBottom: 8,
      }}>
        Wire these channels on the controller
      </div>
      <div style={{ fontSize: 12, color: '#4B5563', marginBottom: 10,
                    lineHeight: 1.5 }}>
        Open the CC10-A cabinet and land each wire on the native
        inputs-and-outputs block, using the channel label shown on
        each row below. Safety wiring continues to use the safety
        relay block, same as the Synapse configuration.
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          This tool needs no I/O wiring.
        </div>
      ) : (
        <ul data-testid="oem-wiring-list"
            style={{ listStyle: 'none', padding: 0, margin: 0,
                     display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, i) => {
            const target = formatPortName(r.synapseId, portmap, 'oem')
            return (
              <li
                key={i}
                data-testid="oem-wiring-row"
                data-kind={r.kind}
                data-channel={target}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', background: '#fff',
                  border: '1px solid #E5E7EB', borderRadius: 6,
                }}>
                <span style={{
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 12, fontWeight: 700,
                  padding: '2px 8px', borderRadius: 4,
                  background: r.kind === 'input' ? '#E0F2FE' : '#FEF3C7',
                  color:      r.kind === 'input' ? '#075985' : '#92400E',
                  minWidth: 56, textAlign: 'center',
                }}>
                  {target}
                </span>
                <span style={{ fontSize: 12, color: '#1F2937' }}>
                  {r.role}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// Short wiring-sentence helper for custom-EOAT + external-fixture
// steps where a single-line prompt reads better than a list. Shared
// so wizard surfaces don't fork their copy.
// eslint-disable-next-line no-unused-vars
export function wiringPromptCopy({ synapseId, role, portmap, profile }) {
  const target = wiringTargetCopy(synapseId, portmap, profile)
  if (!target) return role || ''
  if (isOemProfile(profile)) {
    return `Wire the ${role || 'device'} to ${target} on ${profileInterfaceNoun(profile)}.`
  }
  return `Connect the ${role || 'device'} to ${target} on ${profileInterfaceNoun(profile)}.`
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
        Does this tool have any sensors that tell the robot
        what it's doing?{' '}
        <span style={{ color: '#6B7280' }}>
          (like "gripper closed" or "part detected" — default{' '}
          {_STANDARD_SENSOR_DEFAULTS[toolKey] ?? 0} for this tool)
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

// Flow steps (2026-10-02 plain-register directive):
//   0 — Tool name
//   1 — "What does this tool do?" (multi-select picture cards —
//        every selection becomes ONE actuator in the compiled record)
//   2 — Per-selection confirmations (hold / suction / blow /
//        something-else — rendered inline so the operator sees
//        every capability at once)
//   3 — Sensors ("Does this tool have any sensors..." with examples)
//   4 — Review (summary + save to cell)
//
// The record shape is UNCHANGED (actuators[] with the same fields);
// the questions are just plain-register. Pinned by compilation-
// equivalence tests in D_cell.test.js so a future rewrite cannot
// drift the saved record out from under existing programs.
const _CAPABILITY_MAX = 4

function CustomEOATFlow({
  customs, cell, onCellChanged,
  onBack, onClose, onViewInMyCell, onSetupAnother,
}) {
  // Profile-aware "wire to ..." lines in the custom summary + sensor
  // assignment hint. In OEM mode the operator sees "wire to DO3"
  // instead of "wire to Valve 03".
  const profile = useIoHardwareProfile()
  const synPortmap = useSynapsePortmap()
  const _portOpts = { profile, portmap: synPortmap }
  const [step, setStep]  = useState(0)
  const [name, setName]  = useState('')
  // Set of selected capability keys. Order follows _CAPABILITY_CATALOG
  // so the compiled actuators[] array is deterministic across runs.
  const [capabilities, setCapabilities] = useState(() => new Set())
  // actuators[i] = { type, holdOnLoss | null, hasCheckValve | null,
  // capability }. Derived from the capability set — one per selection,
  // preselect per capability. Operator confirmations ride on top via
  // _patchActuator (keyed by capability so capability-set edits don't
  // scramble indices).
  const [actuators, setActuators] = useState([])
  const [sensorCount, setSensorCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState(null)
  // savedEntry holds the full persisted cell entry so the closing
  // screen can show port details + act on them. Null until finish()
  // succeeds.
  const [savedEntry, setSavedEntry] = useState(null)

  // Live duplicate-name check — the custom flow saves under a fresh
  // id each time, so no excludeId. The name is required already
  // (canAdvance checks trim().length > 0); this adds the "same name
  // as an existing tool" guard with the plain-copy refusal.
  const nameTrim    = name.trim()
  const nameClash   = useMemo(
    () => _nameClashes(cell, nameTrim),
    [cell, nameTrim])
  const nameOk      = nameTrim.length > 0 && !nameClash

  // Toggle a capability selection — add/remove in place without
  // perturbing other selections. Capped at _CAPABILITY_MAX so the
  // free-slot allocator never runs out mid-flow.
  function _toggleCapability(key) {
    setCapabilities((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else if (next.size < _CAPABILITY_MAX) {
        next.add(key)
      }
      return next
    })
  }
  // Re-derive the actuators list whenever the capability set changes.
  // Operator confirmations ride on top via _patchActuator (keyed by
  // capability key, not index, so adding/removing a selection does
  // NOT scramble answers for the surviving selections).
  useEffect(() => {
    setActuators((prev) => {
      const byCap = new Map()
      for (const a of prev) {
        if (a && a.capability) byCap.set(a.capability, a)
      }
      const fresh = actuatorsFromCapabilities(capabilities)
      return fresh.map((seed) => {
        const prior = byCap.get(seed.capability)
        if (!prior) return seed
        // Preserve operator answers that still apply; fall back to
        // the preselect for any field cleared by a type change.
        return {
          ...seed,
          holdOnLoss:    prior.holdOnLoss    ?? seed.holdOnLoss,
          hasCheckValve: prior.hasCheckValve ?? seed.hasCheckValve,
          type:          prior.type || seed.type,
        }
      })
    })
  }, [capabilities])

  function _patchActuatorByCapability(capKey, patch) {
    setActuators((prev) => prev.map((a) =>
      (a.capability === capKey ? { ...a, ...patch } : a)))
  }

  const resolved = useMemo(() => resolveCustomEOATRecord({
    toolName: name || 'Custom Tool',
    actuators,
    sensorCount,
    customs,
  }), [name, actuators, sensorCount, customs])

  // Per-selection confirmations required to leave step 2:
  //   * grips_fingers  (double_acting) → holdOnLoss must be set
  //   * holds_suction  (vacuum)        → hasCheckValve must be set
  //   * blows_air      (blow_off)      → nothing to ask
  //   * something_else                 → operator must have picked a
  //                                       type on the fallback picker
  const perActuatorReady = actuators.every((a) => {
    if (!a.type) return false
    if (a.type === 'double_acting') return a.holdOnLoss !== null
    if (a.type === 'vacuum')        return a.hasCheckValve !== null
    return true
  })

  const canAdvance = (
    step === 0 ? nameOk
    : step === 1 ? capabilities.size >= 1
                     && capabilities.size <= _CAPABILITY_MAX
    : step === 2 ? perActuatorReady
    : step === 3 ? true
    : true
  )

  async function finish() {
    if (nameClash) {
      setSaveErr(`You already have a tool named "${nameTrim}" — pick another name.`)
      return
    }
    setSaving(true); setSaveErr(null)
    try {
      const entry = {
        name: nameTrim,
        type: 'custom',
        valve: resolved.required_valves[0] || null,
        inputs: resolved.required_inputs || [],
        outputs: [],
        actuators: (resolved.actuators || []).map((a, i) => ({
          type: a.type,
          hold_on_loss: a.hold_on_loss,
          holds_via: a.holds_via || null,
          valve: a.valve,
          label: a.label,
          capability: (actuators[i] && actuators[i].capability) || null,
        })),
        sensor_count: sensorCount,
      }
      const saved = await saveCellEoat(entry)
      setSavedEntry(saved || entry)
      // Refresh the parent's cell so [View in My Cell] + the picker
      // see the fresh entry on the next pass.
      try { onCellChanged?.() } catch { /* ignore */ }
    } catch (e) {
      setSaveErr(String(e && e.message || e))
    } finally {
      setSaving(false)
    }
  }

  const stepTitle = [
    '1. Tool name',
    '2. What does this tool do?',
    '3. Confirm each choice',
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
          Custom tool — {stepTitle}
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
              placeholder="e.g. Suction Head, Pinch Gripper"
              data-testid="custom-eoat-name"
              aria-invalid={nameClash ? 'true' : 'false'}
              style={{
                marginTop: 4, padding: '8px 10px', fontSize: 14,
                width: '100%', maxWidth: 320,
                border: `1px solid ${nameClash ? '#DC2626' : '#d1d5db'}`,
                borderRadius: 6,
                fontFamily: 'inherit',
              }} />
          </div>
          {nameClash && (
            <div data-testid="custom-eoat-name-clash"
                 style={{
                   padding: '8px 10px', background: '#FEE2E2',
                   border: '1px solid #FCA5A5', borderRadius: 6,
                   color: '#7F1D1D', fontSize: 12, lineHeight: 1.5,
                 }}>
              You already have a tool named "{nameTrim}" — pick
              another name.
            </div>
          )}
          <div style={{ fontSize: 12, color: '#6B7280' }}>
            Pick a short, distinctive name — you'll see it in the
            tool picker and in program references.
          </div>
        </div>
      )}

      {step === 1 && (
        <div data-testid="hardware-setup-custom-step-capabilities"
             style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#374151' }}>
            What does this tool do? Pick everything that applies.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {_CAPABILITY_CATALOG.map((cap) => {
              const on = capabilities.has(cap.key)
              const atCap = capabilities.size >= _CAPABILITY_MAX && !on
              return (
                <button
                  key={cap.key}
                  data-testid="custom-eoat-capability"
                  data-capability-key={cap.key}
                  data-selected={String(on)}
                  disabled={atCap}
                  onClick={() => _toggleCapability(cap.key)}
                  style={{
                    textAlign: 'left', padding: '12px 14px',
                    background: on ? '#DBEAFE' : '#fff',
                    border: `1px solid ${on ? '#2563EB' : '#d1d5db'}`,
                    borderRadius: 8,
                    cursor: atCap ? 'not-allowed' : 'pointer',
                    opacity: atCap ? 0.5 : 1,
                    fontFamily: 'inherit',
                  }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>
                    {on ? '✓ ' : ''}{cap.label}
                  </div>
                  <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
                    {cap.hint}
                  </div>
                </button>
              )
            })}
          </div>
          <div data-testid="custom-eoat-capability-contact"
               style={{ fontSize: 12, color: '#6B7280' }}>
            Need to pick more than {_CAPABILITY_MAX}? Contact us —
            we'll help wire up a bigger tool.
          </div>
        </div>
      )}

      {step === 2 && (
        <div data-testid="hardware-setup-custom-step-actuators"
             style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#374151' }}>
            Confirm each thing this tool does. We'll pick the right
            parts and the spare slot on your controller for each one.
          </div>
          {actuators.map((a, i) => (
            <ActuatorCard
              key={a.capability || i}
              index={i}
              total={actuators.length}
              value={a}
              resolved={resolved.actuators?.[i] || null}
              onChange={(patch) =>
                _patchActuatorByCapability(a.capability, patch)}
              btnGhost={btnGhost}
            />
          ))}
        </div>
      )}

      {step === 3 && (
        <div data-testid="hardware-setup-custom-step-sensors"
             style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#374151' }}>
            Does this tool have any sensors that tell the robot what
            it's doing?{' '}
            <span style={{ color: '#6B7280' }}>
              (like "gripper closed" or "part detected")
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { n: 0, label: 'None' },
              { n: 1, label: '1' },
              { n: 2, label: '2' },
              { n: 3, label: '3' },
            ].map(({ n, label: lab }) => (
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
                {lab}
              </button>
            ))}
          </div>
          <WhyExpander
            label="What counts as a sensor?"
            testId="custom-eoat-sensor-why">
            A sensor is anything on your tool that sends an electrical
            signal to the robot when something happens — a limit
            switch, a part-present detector, a vacuum confirmation.
            PNP proximity (24 VDC) is the standard your controller
            expects; other kinds can be wired through a signal
            converter.
          </WhyExpander>
          {sensorCount > 0 && resolved.required_inputs.length > 0 && (
            <div data-testid="custom-eoat-sensor-assignments"
                 style={{
                   padding: '10px 12px', background: '#F0FDF4',
                   border: '1px solid #86EFAC', borderRadius: 6,
                   color: '#166534', fontSize: 13, lineHeight: 1.5,
                 }}>
              Wire your sensors to: <b>
                {portListDisplay(resolved.required_inputs, ', ', _portOpts)}
              </b>.
              These are the next free input ports on your controller.
            </div>
          )}
        </div>
      )}

      {step === 4 && !savedEntry && (
        <div data-testid="hardware-setup-custom-step-summary"
             style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{
            padding: 14, background: '#F9FAFB',
            border: '1px solid #E5E7EB', borderRadius: 8,
            fontSize: 13, color: '#111827', lineHeight: 1.6,
          }}>
            <div><b>Tool:</b> {nameTrim || '(unnamed)'}</div>
            <div><b>Does:</b> {actuators.length}{' '}
              thing{actuators.length === 1 ? '' : 's'}
            </div>
            {(resolved.actuators || []).map((a, i) => (
              <div key={i} data-testid="custom-eoat-summary-actuator"
                   style={{ marginLeft: 12 }}>
                • {a.label}{a.valve ? ` → wire to ${portDisplayName(a.valve, _portOpts)}` : ''}
                {a.type === 'double_acting'
                  && (a.hold_on_loss
                       ? ' (keeps holding on power loss)'
                       : ' (lets go on power loss)')}
                {a.type === 'vacuum' && a.holds_via === 'check_valve'
                  && ' (keeps holding on air loss)'}
                {a.type === 'vacuum' && a.holds_via !== 'check_valve'
                  && ' (lets go on air loss)'}
              </div>
            ))}
            <div><b>Sensors:</b> {sensorCount}
              {resolved.required_inputs.length > 0
                && ` → wire to ${portListDisplay(resolved.required_inputs, ', ', _portOpts)}`}
            </div>
          </div>
          <GuidanceBlock port={resolved} />
          {saveErr && (
            <div data-testid="hardware-setup-custom-save-err"
                 style={{
                   padding: '10px 12px', background: '#FEE2E2',
                   border: '1px solid #FCA5A5', borderRadius: 6,
                   color: '#7F1D1D', fontSize: 12,
                 }}>
              {saveErr}
            </div>
          )}
        </div>
      )}

      {step === 4 && savedEntry && (
        <SavedScreen
          entry={savedEntry}
          onViewInMyCell={onViewInMyCell}
          onSetupAnother={() => {
            // Reset local flow state back to the start before
            // handing control back to the parent picker.
            setSavedEntry(null); setSaveErr(null)
            setStep(0); setName('')
            setCapabilities(new Set())
            setActuators([])
            setSensorCount(0)
            onSetupAnother?.()
          }}
          onDone={onClose}
        />
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
        {step === 4 && !savedEntry && (
          <button
            data-testid="hardware-setup-custom-finish"
            style={btnPrim}
            disabled={saving || nameClash}
            onClick={finish}>
            {saving ? 'Saving…' : 'Finish'}
          </button>
        )}
      </div>
    </div>
  )
}

// Per-selection confirmation card (2026-10-02 plain-register directive).
//
// Each capability picked on the multi-select step renders ONE card
// here with only the question(s) relevant to that capability. No
// four-way type picker, no cross-reference to internal vocab — the
// capability field carries the mapping to the actuator type (set
// at capability-select time in actuatorsFromCapabilities).
//
// Capability → question map:
//   grips_fingers  → "If the robot suddenly stops, should this keep
//                     holding the part?" (Yes/No; Yes preselected)
//   holds_suction  → "If the air supply is lost, does your suction
//                     tool keep holding?" (Yes / No / I'm not sure)
//   blows_air      → no question (one-line explanatory note)
//   something_else → the four-way fallback picker (uses plain-
//                     language labels, technical terms in why-expanders)
function ActuatorCard({
  index, total, value, resolved, onChange, btnGhost,
}) {
  const cap = capabilityDef(value.capability)
  return (
    <div data-testid="custom-eoat-actuator-card"
         data-actuator-index={String(index)}
         data-capability-key={value.capability || ''}
         style={{
           padding: 12, background: '#fff',
           border: '1px solid #E5E7EB', borderRadius: 8,
         }}>
      <div style={{
        fontSize: 12, fontWeight: 700, letterSpacing: 0.4,
        textTransform: 'uppercase', color: '#6B7280',
        marginBottom: 8,
      }}>
        {cap ? cap.label : `Choice ${index + 1} of ${total}`}
      </div>
      {value.capability === 'grips_fingers' && (
        <AlwaysHoldsNote tool="finger" />
      )}
      {value.capability === 'holds_suction' && (
        <AlwaysHoldsNote tool="suction" />
      )}
      {value.capability === 'blows_air' && (
        <BlowOffNote />
      )}
      {value.capability === 'something_else' && (
        <SomethingElsePicker value={value} onChange={onChange}
                             btnGhost={btnGhost} />
      )}
      {/* 2026-10-05 operator order: the "Which part did we pick?"
          why-expander is retired alongside the hold questions. The
          saved hookup receipt still names the recommended valve
          type + the allocated slot, so the detail still lands in
          front of the operator where it belongs. */}
    </div>
  )
}

// 2026-10-05 operator order: finger + suction custom tools ALWAYS
// hold the part on power / air loss. The hold-on-loss question is
// retired on the confirm step; this read-only line surfaces the
// decision so the operator can see what the record says without
// having to interact. The behavior-truth copy differs per tool
// (finger holds via DS valve; suction holds via inline check valve)
// so the operator reads the honest reason, not a canned sentence.
function AlwaysHoldsNote({ tool }) {
  const copy = tool === 'suction'
    ? 'This suction tool keeps holding the part if the air supply '
      + 'is lost.'
    : 'This gripper keeps holding the part if power is lost.'
  return (
    <div data-testid="custom-eoat-always-holds-note"
         data-tool={tool}
         style={{
           marginTop: 4, padding: 12,
           background: '#F0FDF4',
           border: '1px solid #86EFAC', borderRadius: 8,
           color: '#166534', fontSize: 13, lineHeight: 1.5,
         }}>
      {copy}
    </div>
  )
}

// HoldQuestion + SuctionHoldQuestion deleted 2026-10-05 (operator
// order: neither should be an option — both tools always hold).
// Their behavior is now the record default from eoatCapabilities
// preselects (grips_fingers → holdOnLoss:true; holds_suction →
// hasCheckValve:true). The AlwaysHoldsNote component (above)
// surfaces the decision as read-only copy.

function BlowOffNote() {
  return (
    <div data-testid="custom-eoat-blow-note"
         style={{
           marginTop: 4, padding: 10,
           background: '#F0F9FF',
           border: '1px solid #BAE6FD', borderRadius: 8,
           color: '#0C4A6E', fontSize: 13, lineHeight: 1.5,
         }}>
      The air pulses on when the program says so, and stops
      the moment the program stops. Nothing to hold here.
    </div>
  )
}

// Fallback picker for the "Something else" capability — the operator
// still picks a type, but every label is plain-register. Technical
// terms live only in the why-expander below.
function SomethingElsePicker({ value, onChange, btnGhost }) {
  const options = [
    { key: 'single_acting',
      label: 'Pushes one way, springs back',
      desc: 'Opens on command, snaps shut on its own when power drops.' },
    { key: 'double_acting',
      label: 'Pushes both ways',
      desc: 'Opens and closes on command. Keeps holding if power '
            + 'drops.' },
    { key: 'vacuum',
      label: 'Draws a vacuum',
      desc: 'Suction cup or ejector. Keeps holding if the air '
            + 'supply drops.' },
    { key: 'electric_none',
      label: 'Runs on electricity (no air)',
      desc: 'Motor-driven, battery, or passive — no air line needed.' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
         data-testid="custom-eoat-something-else-picker">
      <div style={{ fontSize: 13, color: '#374151' }}>
        Which best describes what this tool does?
      </div>
      {options.map((o) => (
        <button
          key={o.key}
          data-testid="custom-eoat-actuation"
          data-value={o.key}
          data-selected={String(value.type === o.key)}
          onClick={() => onChange({
            type: o.key,
            holdOnLoss:    o.key === 'double_acting' ? true : null,
            hasCheckValve: o.key === 'vacuum'        ? true : null,
          })}
          style={{
            textAlign: 'left', padding: '10px 12px',
            background: value.type === o.key ? '#DBEAFE' : '#fff',
            border: `1px solid ${value.type === o.key ? '#2563EB' : '#d1d5db'}`,
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
      {/* 2026-10-05 operator order: the double_acting / vacuum
          follow-up hold questions are retired. The type-select
          click handler above already seeds holdOnLoss=true for
          double_acting and hasCheckValve=true for vacuum, so the
          actuator is complete the moment the operator picks a
          type. The AlwaysHoldsNote surfaces the always-hold
          decision on the primary (non-"something else") paths;
          here, picking the type IS the commitment, no second
          question needed. */}
      {(value.type === 'double_acting' || value.type === 'vacuum') && (
        <AlwaysHoldsNote
          tool={value.type === 'vacuum' ? 'suction' : 'finger'} />
      )}
    </div>
  )
}

// Standard-path name input (2026-10-01 directive). Prefilled from
// _STANDARD_NAME_DEFAULTS; shows a plain-copy refusal when the
// operator picks a name that already exists in the cell.
function StandardNameInput({
  toolKey, value, disabled, clash, onChange,
}) {
  const trim = String(value || '').trim()
  return (
    <div data-testid="hardware-setup-standard-name"
         data-tool-key={toolKey}
         data-clash={String(!!clash)}
         style={{
           padding: '10px 12px', marginBottom: 12,
           background: '#F9FAFB', border: '1px solid #E5E7EB',
           borderRadius: 6, color: '#374151',
         }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        What do you want to call this tool?{' '}
        <span style={{ color: '#6B7280' }}>
          (This is what the Program Wizard will show.)
        </span>
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={_STANDARD_NAME_DEFAULTS[toolKey] || 'Tool'}
        data-testid="hardware-setup-standard-name-input"
        aria-invalid={clash ? 'true' : 'false'}
        style={{
          padding: '8px 10px', fontSize: 14,
          width: '100%', maxWidth: 320,
          border: `1px solid ${clash ? '#DC2626' : '#d1d5db'}`,
          borderRadius: 6, fontFamily: 'inherit',
          opacity: disabled ? 0.55 : 1,
        }} />
      {clash && (
        <div data-testid="hardware-setup-standard-name-clash"
             style={{
               marginTop: 8, padding: '6px 10px', background: '#FEE2E2',
               border: '1px solid #FCA5A5', borderRadius: 6,
               color: '#7F1D1D', fontSize: 12, lineHeight: 1.5,
             }}>
          You already have a tool named "{trim}" — pick another name.
        </div>
      )}
    </div>
  )
}

// Saved-confirmation screen (2026-10-01 directive). Rendered on all
// three paths after a successful cell save; the operator sees that
// the save happened + has three next-step affordances. Never a
// silent-end wizard.
function SavedScreen({ entry, onViewInMyCell, onSetupAnother, onDone }) {
  // Profile-aware "Ports claimed" + copy that doesn't invoke the
  // Synapse tab name in Basic installs (the Synapse tab is rendered
  // disabled/greyed in nav there — not clickable).
  const profile = useIoHardwareProfile()
  const portmap = useSynapsePortmap()
  const _portOpts = { profile, portmap }
  const isOem = profile === 'oem'
  const name = entry?.name || 'Tool'
  const valves = []
  if (entry?.valve) valves.push(entry.valve)
  if (Array.isArray(entry?.actuators)) {
    for (const a of entry.actuators) {
      if (a?.valve && !valves.includes(a.valve)) valves.push(a.valve)
    }
  }
  const inputs = Array.isArray(entry?.inputs)
    ? entry.inputs.filter(Boolean) : []
  const btnPrim = {
    padding: '10px 16px', fontSize: 14, fontWeight: 700,
    background: '#0284c7', color: '#fff',
    border: '1px solid #0369a1', borderRadius: 8,
    cursor: 'pointer', fontFamily: 'inherit',
  }
  const btnGhost = {
    padding: '10px 16px', fontSize: 14, fontWeight: 600,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 8,
    cursor: 'pointer', fontFamily: 'inherit',
  }
  return (
    <div data-testid="hardware-setup-saved-screen"
         data-cell-id={entry?.id || ''}
         style={{
           padding: 18, borderRadius: 10, background: '#ECFDF5',
           border: '1px solid #6EE7B7', color: '#065F46',
           fontSize: 14, lineHeight: 1.6,
         }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                    marginBottom: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: '#16A34A', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, fontWeight: 800,
        }}>✓</div>
        <div data-testid="hardware-setup-saved-headline"
             style={{ fontSize: 18, fontWeight: 700, color: '#064E3B' }}>
          "{name}" saved to Tools.
        </div>
      </div>
      <div style={{ color: '#065F46', marginBottom: 14 }}>
        It will appear as a card in the Program Wizard's tool step
        {isOem
          ? <> and in <b>All Tools and Fixtures</b>.</>
          : <> and in <b>All Tools and Fixtures</b> on the Synapse tab.</>}
        {(valves.length > 0 || inputs.length > 0) && (
          <div style={{ marginTop: 6, fontSize: 13, color: '#047857' }}
               data-testid="hardware-setup-saved-ports"
               data-io-profile={profile}>
            Ports claimed:{' '}
            {valves.length > 0 && <b>{portListDisplay(valves, ', ', _portOpts)}</b>}
            {valves.length > 0 && inputs.length > 0 && ' · '}
            {inputs.length > 0 && <b>{portListDisplay(inputs, ', ', _portOpts)}</b>}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          data-testid="hardware-setup-saved-view"
          style={btnPrim}
          onClick={onViewInMyCell}>
          View Tools and Fixtures →
        </button>
        <button
          data-testid="hardware-setup-saved-another"
          style={btnGhost}
          onClick={onSetupAnother}>
          Set up another tool
        </button>
        <button
          data-testid="hardware-setup-saved-done"
          style={btnGhost}
          onClick={onDone}>
          Done
        </button>
      </div>
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
// a duplicate card. The operator-supplied name is the single source
// for program-wizard card display — the type-label default is only
// a prefill.
//
// 2026-10-02 operator directive (hold-on-loss default + vacuum
// check-valve standard):
//
//   * Finger standard path records type='double_acting' with
//     hold_on_loss=true. Previous default was 'single_acting'
//     (spring-return, 5/2 SS → part drops on power loss).
//   * Vacuum standard path records holds_on_loss=true + holds_via=
//     'check_valve' — NeuRobots vacuum tools ship with an inline
//     vacuum check valve. The valve class (HI/LO 3/2 N/C) stays
//     the same; holds_via distinguishes check-valve holding from
//     valve-class holding so the record stays physically truthful.
function _standardCellEntry({ toolKey, name, port, sensorCount }) {
  const nameTrim = String(name || '').trim()
    || _STANDARD_NAME_DEFAULTS[toolKey]
    || 'EOAT'
  const valve = (port.required_valves || [])[0] || null
  const inputs = Array.from(port.required_inputs || [])
  let actuators = []
  if (valve) {
    if (toolKey === 'vacuum') {
      actuators = [{
        type:         'vacuum',
        hold_on_loss: true,
        holds_via:    'check_valve',
        valve,
        label:        'vacuum',
      }]
    } else {
      // finger (and any future paired-coil standard path)
      actuators = [{
        type:         'double_acting',
        hold_on_loss: true,
        holds_via:    null,
        valve,
        label:        'gripper',
      }]
    }
  }
  return {
    id:       `standard:${toolKey}`,
    name:     nameTrim,
    type:     toolKey,
    valve,
    inputs,
    outputs:  [],
    actuators,
    sensor_count: sensorCount,
    tool_ref: null,
  }
}
