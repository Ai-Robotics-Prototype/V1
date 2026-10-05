import { useEffect, useMemo, useState } from 'react'
import { getCell } from '../lib/cellStore'
import { typeLabel, portDisplayName } from '../lib/cellEntryDisplay'
import { QuestionCard } from './WizardStepCard'
import EOATSetupWizard from './EOATSetupWizard'

// ToolFromCellStep — the program wizard's "Which tool will this
// program use?" step (2026-09-22 operator directive).
//
// Cards render from cell.eoats ONLY. No tool-type / gripper-type /
// actuation questions live in this component — every choice is a
// pre-registered cell entry. Three states:
//
//   * 2+ eoats  → cards; single-tap picks + advances.
//   * 1  eoat   → preselected + one-tap Confirm.
//   * 0  eoats  → "You haven't set up a tool yet" + [Set up a tool]
//                 only. The operator cannot advance from this state.
//
// A "+ Set up a new tool" card is always present (when there is at
// least one existing eoat) and opens EOATSetupWizard as a nested
// modal. On close, the cell refetches; if a new eoat appeared, it
// is preselected. Wizard state around this step is preserved
// (ProgramWizard's answers state doesn't unmount).
//
// Shared component: this file is the ONE tool step both the new-
// program wizard AND the palletizing sub-flow render. Import-
// identity pin in D_cell.test.js locks in the no-fork invariant.
//
// Chrome: this step renders inside the canonical <QuestionCard>
// imported from ./WizardStepCard — same header/padding/width as
// every other PAGES entry so the window chrome is identical across
// the wizard (2026-10-01 operator field report — the tool step was
// previously forking its own prompt header + no outer card).

export default function ToolFromCellStep({
  answers, setAnswer, goNext,
}) {
  const [cell, setCell]     = useState(null)
  const [err, setErr]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [showSetup, setShowSetup] = useState(false)
  const [selectedId, setSelectedId] = useState(
    answers?.cell_eoat_id || null)
  const [preSetupEoatIds, setPreSetupEoatIds] = useState(null)

  // Load the cell.
  useEffect(() => {
    let alive = true
    getCell()
      .then((c) => {
        if (!alive) return
        setCell(c); setLoading(false)
        // Auto-preselect: exactly one eoat + nothing chosen yet.
        const eoats = (c && c.eoats) || []
        if (eoats.length === 1 && !answers?.cell_eoat_id) {
          setSelectedId(eoats[0].id)
        }
      })
      .catch((e) => { if (alive) {
        setErr(String(e && e.message || e)); setLoading(false)
      } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const eoats = cell?.eoats || []
  const selected = useMemo(
    () => eoats.find((e) => e.id === selectedId) || null,
    [eoats, selectedId])

  function openSetup() {
    // Capture the current cell.eoats ids so we can detect a new
    // entry after the setup modal closes.
    setPreSetupEoatIds(new Set(eoats.map((e) => e.id)))
    setShowSetup(true)
  }

  async function closeSetupAndRefresh() {
    setShowSetup(false)
    try {
      const fresh = await getCell()
      setCell(fresh)
      // Detect a newly-added eoat and preselect it.
      const prior = preSetupEoatIds || new Set()
      const added = (fresh.eoats || []).find((e) => !prior.has(e.id))
      if (added) setSelectedId(added.id)
    } catch { /* leave prior cell state */ }
    setPreSetupEoatIds(null)
  }

  function commit(entry) {
    if (!entry) return
    setSelectedId(entry.id)
    // Bind by id + populate the legacy fields codegen still reads
    // (gripper_type, custom_tool_id). Cell entry type maps 1:1 to
    // the historical gripper_type vocabulary.
    setAnswer('cell_eoat_id', entry.id)
    setAnswer('gripper_type', _gripperTypeFor(entry))
    setAnswer('custom_tool_id',
      entry.tool_ref || (_isCustomEntry(entry) ? entry.id : null))
    // Advance the wizard with the fresh values so a downstream
    // page's skip predicate sees them.
    goNext({
      cell_eoat_id:   entry.id,
      gripper_type:   _gripperTypeFor(entry),
      custom_tool_id: entry.tool_ref
        || (_isCustomEntry(entry) ? entry.id : null),
    })
  }

  const QUESTION = 'Which tool will this program use?'
  const DESCRIPTION = (
    "Pick from the end-of-arm tools set up in your cell. "
    + "The program remembers the choice by id, so if the tool's "
    + 'ports change later, the program follows automatically.'
  )

  if (loading) {
    return (
      <div data-testid="tool-from-cell-step" data-state="loading">
        <QuestionCard question={QUESTION} description={DESCRIPTION}>
          <div style={{ padding: 12, color: '#6b7280', fontSize: 13 }}>
            Loading tools…
          </div>
        </QuestionCard>
      </div>
    )
  }

  if (err) {
    return (
      <div data-testid="tool-from-cell-step" data-state="error">
        <QuestionCard question={QUESTION} description={DESCRIPTION}>
          <div style={_errStyle}>Tool library unavailable: {err}</div>
        </QuestionCard>
      </div>
    )
  }

  return (
    <div data-testid="tool-from-cell-step"
         data-state={eoats.length === 0 ? 'empty'
                    : eoats.length === 1 ? 'single' : 'multi'}>
      <QuestionCard question={QUESTION} description={DESCRIPTION}>

        {eoats.length === 0 && (
          <div data-testid="tool-from-cell-empty"
               style={{
                 padding: 14, borderRadius: 8, background: '#FEF3C7',
                 border: '1px solid #FDE68A', color: '#92400E',
                 fontSize: 13, lineHeight: 1.5,
               }}>
            <b>You haven't set up a tool yet.</b> Open EOAT Setup to
            register the end-of-arm tool your robot will use, then
            come back to this step.
            <div style={{ marginTop: 10 }}>
              <button
                data-testid="tool-from-cell-empty-setup"
                onClick={openSetup}
                style={_btnPrim}>
                Set up a tool
              </button>
            </div>
          </div>
        )}

        {eoats.length > 0 && (
          <div style={{
            display: 'grid', gap: 10,
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          }}>
            {eoats.map((e) => {
              const on = selectedId === e.id
              return (
                <button
                  key={e.id}
                  data-testid="tool-from-cell-card"
                  data-cell-id={e.id}
                  data-selected={String(on)}
                  onClick={() => commit(e)}
                  style={{
                    textAlign: 'left', padding: '12px 14px',
                    background: on ? '#EFF6FF' : '#fff',
                    border: `1px solid ${on ? '#2563EB' : '#d1d5db'}`,
                    borderRadius: 8, cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}>
                  <div style={{
                    display: 'flex', gap: 8, alignItems: 'baseline',
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 700,
                                  color: '#111', flex: 1 }}>
                      {e.name}
                    </div>
                    <span data-testid="tool-from-cell-card-type-badge"
                          style={_typeBadge}>
                      {typeLabel(e)}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 6,
                                flexWrap: 'wrap' }}>
                    {e.valve && (
                      <span data-testid="tool-from-cell-card-port"
                            style={_portChip}>{portDisplayName(e.valve)}</span>
                    )}
                    {(e.inputs || []).map((i) => (
                      <span key={i}
                            data-testid="tool-from-cell-card-port"
                            style={_portChip}>{portDisplayName(i)}</span>
                    ))}
                  </div>
                </button>
              )
            })}
            <button
              data-testid="tool-from-cell-setup-new"
              onClick={openSetup}
              style={{
                textAlign: 'left', padding: '12px 14px',
                background: '#F9FAFB',
                border: '1px dashed #9CA3AF',
                borderRadius: 8, cursor: 'pointer',
                color: '#374151', fontFamily: 'inherit',
              }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                + Set up a new tool
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Open EOAT Setup. You'll come back here when you finish.
              </div>
            </button>
          </div>
        )}

        {eoats.length === 1 && selected && (
          <div style={{
            marginTop: 12, display: 'flex', gap: 8,
          }}>
            <button
              data-testid="tool-from-cell-confirm"
              onClick={() => commit(selected)}
              style={_btnPrim}>
              Use {selected.name} — Next →
            </button>
          </div>
        )}

      </QuestionCard>

      {showSetup && (
        <EOATSetupWizard onClose={closeSetupAndRefresh} />
      )}
    </div>
  )
}

function _gripperTypeFor(entry) {
  if (!entry) return 'finger'
  if (entry.type === 'vacuum') return 'vacuum'
  if (entry.type === 'finger') return 'finger'
  return 'custom'
}
function _isCustomEntry(entry) {
  return entry && entry.type !== 'finger' && entry.type !== 'vacuum'
}

const _btnPrim = {
  padding: '10px 18px', fontSize: 14, fontWeight: 700,
  background: '#0284c7', color: '#fff', border: '1px solid #0369a1',
  borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
}
const _errStyle = {
  padding: '10px 12px', background: '#FEE2E2',
  border: '1px solid #FCA5A5', borderRadius: 6,
  color: '#7F1D1D', fontSize: 13,
}
const _typeBadge = {
  fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: '#3730A3',
  background: '#EEF2FF', padding: '2px 8px', borderRadius: 999,
}
const _portChip = {
  fontFamily: 'var(--font-mono, monospace)',
  fontSize: 11, color: '#065F46',
  background: '#D1FAE5', padding: '2px 6px', borderRadius: 4,
}
