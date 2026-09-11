import { useEffect, useMemo, useState } from 'react'
import HookupGuide from './HookupGuide'
import {
  listTools, toolHookupKey, getToolHookup, confirmToolHookup,
} from '../lib/toolsApi'

// Standalone Hardware Setup wizard — the operator directive moved
// hookup guidance OUT of the Program Wizard into a per-tool flow
// launched from the Program Library header. Each tool type
// (vacuum / finger / custom-from-EOAT-library) walks the shared
// HookupGuide; Confirm POSTs /api/tool_hookup/<key> with the
// no-sensor map + optional-toggle answers + a confirmed_at
// timestamp. The Program Wizard reads this record for its inline
// "Hardware for this tool was confirmed <date>" thread line and
// snapshots the recorded no_sensor / optional answers into
// program.config at save time so codegen consumers (effectorVocab
// withBlowOff, hookup_no_sensor invariant) stay unchanged.
//
// Props:
//   onClose()
//   initialToolKey     : optional — jump straight to a specific
//                        tool ('vacuum'|'finger'|'custom:<id>')
//                        skipping the picker step. Used by the
//                        editor's "View hookup" button.
//   readOnly           : force reference mode when initialToolKey
//                        is supplied (View hookup opens read-only).

const BUILT_IN = [
  { key: 'finger',
    gripper_type: 'finger',
    label: 'Finger Gripper',
    desc: 'Two-jaw parallel gripper. Best for rigid parts with flat gripping surfaces.' },
  { key: 'vacuum',
    gripper_type: 'vacuum',
    label: 'Vacuum Suction',
    desc: 'Vacuum cup picks from the top. Best for flat, smooth, sealed surfaces.' },
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
    if (!toolKey) return
    let alive = true
    getToolHookup(toolKey)
      .then((rec) => { if (alive) { setRecord(rec); setRL(true) } })
      .catch((e) => { if (alive) { setError(String(e && e.message || e)); setRL(true) } })
    return () => { alive = false }
  }, [toolKey])

  const activeTool = useMemo(() => {
    if (!toolKey) return null
    if (toolKey === 'vacuum' || toolKey === 'finger') {
      return BUILT_IN.find((b) => b.key === toolKey) || null
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
    if (!toolKey) return
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

  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    zIndex: 9998, display: 'flex', alignItems: 'center',
    justifyContent: 'center',
  }
  const panel = {
    background: '#fff', borderRadius: 12,
    padding: 24, width: 'min(760px, 92vw)',
    maxHeight: '90vh', overflow: 'auto',
    boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
  }
  const titleStyle = {
    fontSize: 20, fontWeight: 700, marginBottom: 12, color: '#111827',
  }
  const btnGhost = {
    padding: '10px 16px', fontSize: 14, fontWeight: 600,
    background: '#fff', color: '#374151',
    border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
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
              {customs.map((t) => (
                <ToolChoice
                  key={t.id}
                  tool={{
                    key: `custom:${t.id}`,
                    gripper_type: 'custom',
                    tool_id: t.id,
                    label: t.name || `Custom tool ${t.id.slice(0, 6)}`,
                    desc: t.confirmed
                      ? 'EOAT-library tool.'
                      : 'EOAT-library tool (not yet fully configured).',
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

        {toolKey && activeTool && (
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

        {toolKey && !activeTool && recordLoaded && (
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
        borderRadius: 8, cursor: 'pointer',
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

function _formatDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric' })
  } catch { return iso }
}
