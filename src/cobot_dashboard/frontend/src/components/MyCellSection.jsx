import { useEffect, useState } from 'react'
import { GuidanceBlock } from './EOATSetupWizard'
import {
  getCell, saveCellEoat, deleteCellEoat,
} from '../lib/cellStore'
import {
  namedActionsForEoat, namedActionsForFixture,
  programsReferencingCellId,
} from '../lib/cellActions'
import { shouldReviewHold } from '../lib/cellReview'
import { entrySubtitle } from '../lib/cellEntryDisplay'
import { useIoHardwareProfile } from '../lib/ioHardwareProfile'
import { useSynapsePortmap } from '../lib/synapsePortmap'
import { useStore } from '../store/useStore'

// My Cell — read-only summary of the cell registry, with per-entry
// rename + delete affordances (2026-10-01 operator directive).
//
// 2026-09-22 operator directive (The Cell): natural home is a
// section on the Synapse page or adjacent — "the cell at a glance".
// Lists every EOAT + fixture with its port assignments; each entry
// exposes its named actions inline so operators can see what a
// program built on this cell can do.
//
// 2026-10-01 extension: entries get rename + delete so operators can
// correct a typo'd profile without wiping it (programs bind by id,
// so a rename flows through to every bound program automatically)
// and remove a profile that's no longer in use. Delete surfaces a
// programs-reference warning via programsReferencingCellId before
// the destructive step so operators don't orphan a running program's
// bindings by accident.
//
// VIEW-tier EXCEPT for the rename/delete writes which the directive
// explicitly moved here. The existing MyCellSection pin stays green
// — rename is a cell-store POST (same shape as the EOAT wizard uses)
// and delete is a cell-store DELETE; neither reaches /cmd/ or any
// runtime surface.

export default function MyCellSection() {
  const [cell, setCell]   = useState(null)
  const [err, setErr]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameErr, setRenameErr]     = useState(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null)

  // Programs list — used ONLY to render the delete-time warning
  // listing programs that reference the entry about to be deleted.
  // Hydrates once on mount; the operator's delete flow is slow
  // enough that stale-by-seconds doesn't matter here.
  const programsList = useStore((s) => s.programsList)
  const hydratePrograms = useStore((s) => s.hydratePrograms)
  useEffect(() => { hydratePrograms?.() }, [hydratePrograms])

  async function _refresh() {
    try { setCell(await getCell()) }
    catch (e) { setErr(String(e && e.message || e)) }
  }
  useEffect(() => { _refresh().then(() => setLoading(false)) }, [])

  function startRename(entry) {
    setRenamingId(entry.id)
    setRenameDraft(entry.name || '')
    setRenameErr(null)
  }
  function cancelRename() {
    setRenamingId(null); setRenameDraft(''); setRenameErr(null)
  }
  async function commitRename(entry) {
    const next = String(renameDraft || '').trim()
    if (!next) {
      setRenameErr('Give the tool a name.')
      return
    }
    if (next === entry.name) { cancelRename(); return }
    const clash = (cell?.eoats || []).some((e) =>
      e.id !== entry.id
      && String(e.name || '').trim().toLowerCase()
         === next.toLowerCase())
    if (clash) {
      setRenameErr(`You already have a tool named "${next}" — pick another name.`)
      return
    }
    // Preserve EVERY field on the entry — rename is name-only. The
    // backend upsert key is `id`, so the entry re-saves in place and
    // every program binding by id follows the rename for free.
    const payload = { ...entry, name: next }
    try {
      await saveCellEoat(payload)
      cancelRename()
      await _refresh()
    } catch (e) {
      setRenameErr(String(e && e.message || e))
    }
  }

  async function commitDelete(entry) {
    try {
      await deleteCellEoat(entry.id)
      setConfirmingDeleteId(null)
      await _refresh()
    } catch (e) {
      setErr(String(e && e.message || e))
    }
  }

  if (loading) {
    return (
      <section data-testid="my-cell-section"
               style={_sectionStyle}>
        <_Header />
        <div style={{ padding: 12, color: '#6b7280', fontSize: 13 }}>
          Loading cell…
        </div>
      </section>
    )
  }
  if (err) {
    return (
      <section data-testid="my-cell-section"
               style={_sectionStyle}>
        <_Header />
        <div style={{
          padding: '10px 12px', background: '#FEE2E2',
          border: '1px solid #FCA5A5', borderRadius: 6,
          color: '#7F1D1D', fontSize: 12,
        }}>My Cell unavailable: {err}</div>
      </section>
    )
  }

  const eoats    = cell?.eoats || []
  const fixtures = cell?.fixtures || []
  const isEmpty  = eoats.length === 0 && fixtures.length === 0

  return (
    <section data-testid="my-cell-section" style={_sectionStyle}>
      <_Header />
      {isEmpty && (
        <div data-testid="my-cell-empty"
             style={{
               padding: 14, borderRadius: 8, background: '#F9FAFB',
               color: '#374151', fontSize: 13, lineHeight: 1.5,
             }}>
          Nothing set up yet. Open <b>EOAT Setup</b> to register the
          end-of-arm tool, and <b>External Fixtures</b> to register
          fixtures around the cell. They'll appear here.
        </div>
      )}

      {eoats.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <_GroupHeader label="End-of-arm tools" count={eoats.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {eoats.map((e) => (
              <_EntryRow
                key={e.id}
                data-kind="eoat"
                entry={e}
                actions={namedActionsForEoat(e)}
                reviewHold={_shouldReviewHold(e)}
                expanded={expandedId === e.id}
                onToggle={() => setExpandedId(
                  expandedId === e.id ? null : e.id)}
                ports={_eoatPortRecord(e)}
                renaming={renamingId === e.id}
                renameDraft={renameDraft}
                renameErr={renameErr}
                onRenameStart={() => startRename(e)}
                onRenameDraft={setRenameDraft}
                onRenameCancel={cancelRename}
                onRenameCommit={() => commitRename(e)}
                confirmingDelete={confirmingDeleteId === e.id}
                onDeleteStart={() => setConfirmingDeleteId(e.id)}
                onDeleteCancel={() => setConfirmingDeleteId(null)}
                onDeleteCommit={() => commitDelete(e)}
                programsReferencing={programsReferencingCellId(
                  programsList || [], e.id)}
              />
            ))}
          </div>
        </div>
      )}

      {fixtures.length > 0 && (
        <div>
          <_GroupHeader label="External fixtures" count={fixtures.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {fixtures.map((f) => (
              <_EntryRow
                key={f.id}
                data-kind="fixture"
                entry={f}
                actions={namedActionsForFixture(f)}
                reviewHold={_shouldReviewHold(f)}
                expanded={expandedId === f.id}
                onToggle={() => setExpandedId(
                  expandedId === f.id ? null : f.id)}
                ports={_fixturePortRecord(f)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function _Header() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      marginBottom: 12,
    }}>
      <div style={{
        display: 'inline-block', width: 4, height: 18,
        background: '#0891B2', borderRadius: 2,
      }} />
      <h3 style={{
        margin: 0, fontSize: 12, fontWeight: 700,
        letterSpacing: 0.6, textTransform: 'uppercase',
        color: '#111827',
      }}>
        My Cell
      </h3>
      <span style={{
        fontSize: 11, color: '#6b7280', letterSpacing: 0.3,
      }}>
        (the cell at a glance)
      </span>
    </div>
  )
}

function _GroupHeader({ label, count }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
      textTransform: 'uppercase', color: '#6B7280',
      marginBottom: 6,
    }}>
      {label} ({count})
    </div>
  )
}

function _EntryRow({
  entry, actions, expanded, onToggle, ports,
  reviewHold,
  renaming, renameDraft, renameErr,
  onRenameStart, onRenameDraft, onRenameCancel, onRenameCommit,
  confirmingDelete, onDeleteStart, onDeleteCancel, onDeleteCommit,
  programsReferencing,
  ...rest
}) {
  // Profile-aware subtitle. In Synapse mode (default), reads "Vacuum
  // tool · Valve 03 · IN 04". In OEM mode, the same record renders as
  // "Vacuum tool · DO3 · DI4" so the operator sees the controller-
  // native channels they wired.
  const profile = useIoHardwareProfile()
  const portmap = useSynapsePortmap()
  const subtitle = entrySubtitle(entry, { profile, portmap })
  return (
    <div data-testid="my-cell-entry"
         data-cell-id={entry.id}
         data-kind={rest['data-kind']}
         style={{
           border: '1px solid #E5E7EB', borderRadius: 8,
           background: '#fff', overflow: 'hidden',
         }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px',
      }}>
        <button
          data-testid="my-cell-entry-toggle"
          onClick={onToggle}
          style={{
            flex: 1, display: 'flex', alignItems: 'center',
            gap: 10, background: 'transparent', border: 'none',
            cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
            padding: 0,
          }}>
          <div style={{ flex: 1 }}>
            {reviewHold && !renaming && (
              <div data-testid="my-cell-entry-review-chip"
                   data-cell-id={entry.id}
                   style={{
                     display: 'inline-flex', alignItems: 'center',
                     padding: '2px 8px', marginBottom: 4,
                     background: '#FEF3C7', color: '#92400E',
                     border: '1px solid #FDE68A', borderRadius: 999,
                     fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
                   }}>
                Review recommended — set what happens on power loss
              </div>
            )}
            {renaming ? (
              <input
                type="text"
                value={renameDraft}
                autoFocus
                onChange={(e) => onRenameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') onRenameCommit()
                  if (e.key === 'Escape') onRenameCancel()
                }}
                data-testid="my-cell-entry-rename-input"
                style={{
                  padding: '4px 8px', fontSize: 14, fontWeight: 600,
                  color: '#111', border: '1px solid #2563EB',
                  borderRadius: 6, width: '100%', maxWidth: 320,
                  fontFamily: 'inherit',
                }} />
            ) : (
              <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
                {entry.name}
              </div>
            )}
            <div style={{ fontSize: 12, color: '#6B7280' }}
                 data-testid="my-cell-entry-subtitle">
              {subtitle}
            </div>
          </div>
          <span style={{
            fontSize: 11, fontWeight: 600, color: '#6B7280',
            textTransform: 'uppercase',
          }}>
            {expanded ? 'Hide' : 'Show'}
          </span>
        </button>
        {rest['data-kind'] === 'eoat' && !renaming && !confirmingDelete && (
          <>
            <button
              data-testid="my-cell-entry-rename"
              onClick={(e) => { e.stopPropagation(); onRenameStart() }}
              style={_rowBtnGhost}>
              Rename
            </button>
            <button
              data-testid="my-cell-entry-delete"
              onClick={(e) => { e.stopPropagation(); onDeleteStart() }}
              style={_rowBtnDanger}>
              Delete
            </button>
          </>
        )}
        {renaming && (
          <>
            <button
              data-testid="my-cell-entry-rename-save"
              onClick={(e) => { e.stopPropagation(); onRenameCommit() }}
              style={_rowBtnPrimary}>
              Save
            </button>
            <button
              data-testid="my-cell-entry-rename-cancel"
              onClick={(e) => { e.stopPropagation(); onRenameCancel() }}
              style={_rowBtnGhost}>
              Cancel
            </button>
          </>
        )}
      </div>
      {renameErr && (
        <div data-testid="my-cell-entry-rename-err"
             style={{
               padding: '6px 12px 10px', color: '#7F1D1D',
               fontSize: 12, background: '#FEE2E2',
               borderTop: '1px solid #FCA5A5',
             }}>
          {renameErr}
        </div>
      )}
      {confirmingDelete && (
        <div data-testid="my-cell-entry-delete-confirm"
             style={{
               padding: 12, borderTop: '1px solid #FCA5A5',
               background: '#FEF2F2', color: '#7F1D1D',
               fontSize: 13, lineHeight: 1.5,
             }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            Delete "{entry.name}"?
          </div>
          {(programsReferencing || []).length > 0 ? (
            <div data-testid="my-cell-entry-delete-refs"
                 style={{ marginBottom: 8 }}>
              <div>
                <b>{programsReferencing.length}</b> program
                {programsReferencing.length === 1 ? '' : 's'} still
                reference this tool — they will stop running until
                you bind them to a different tool:
              </div>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {programsReferencing.map((p) => (
                  <li key={p.id}
                      data-testid="my-cell-entry-delete-ref"
                      data-program-id={p.id}>
                    {p.name || p.id}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div style={{ marginBottom: 8 }}>
              No programs reference this tool.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              data-testid="my-cell-entry-delete-commit"
              onClick={(e) => { e.stopPropagation(); onDeleteCommit() }}
              style={_rowBtnDanger}>
              Delete anyway
            </button>
            <button
              data-testid="my-cell-entry-delete-cancel"
              onClick={(e) => { e.stopPropagation(); onDeleteCancel() }}
              style={_rowBtnGhost}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {expanded && (
        <div style={{
          borderTop: '1px solid #E5E7EB', padding: 12,
          background: '#F9FAFB',
        }} data-testid="my-cell-entry-body">
          {reviewHold && (
            <div data-testid="my-cell-entry-review-copy"
                 style={{
                   padding: '8px 12px', marginBottom: 10,
                   background: '#FFFBEB', color: '#92400E',
                   border: '1px solid #FDE68A', borderRadius: 6,
                   fontSize: 12, lineHeight: 1.5,
                 }}>
              This tool was saved before we started asking what
              should happen on power loss. Re-run EOAT Setup to
              confirm whether it should keep holding the part if
              the robot stops. Nothing has been changed for you.
            </div>
          )}
          {ports && <GuidanceBlock port={ports} />}
          {actions.length > 0 && (
            <div style={{ marginTop: 6 }} data-testid="my-cell-actions">
              <div style={{
                fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                textTransform: 'uppercase', color: '#6B7280',
                marginBottom: 6,
              }}>
                Program actions
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {actions.map((a) => (
                  <div key={a.key}
                       data-testid="my-cell-action"
                       data-action-key={a.key}
                       style={{
                         fontSize: 13, color: '#111',
                       }}>
                    <b>{a.label}</b>
                    <span style={{ color: '#6B7280', marginLeft: 6 }}>
                      — {a.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {actions.length === 0 && (
            <div style={{ fontSize: 12, color: '#6B7280' }}>
              No program actions yet — this entry is missing its
              port assignment.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Thin wrapper so legacy call sites can keep the underscore-prefix
// name; the predicate itself lives in lib/cellReview for testability.
function _shouldReviewHold(entry) { return shouldReviewHold(entry) }

// ── Port-record projections (feed the shared GuidanceBlock) ─────────

function _eoatPortRecord(e) {
  if (!e) return null
  const required_valves  = e.valve ? [e.valve] : []
  const required_inputs  = (e.inputs || []).filter(Boolean)
  const required_outputs = (e.outputs || []).filter(Boolean)
  if (!required_valves.length && !required_inputs.length
      && !required_outputs.length) return null
  const callouts = {}
  if (e.valve) callouts[e.valve] = `${e.name}: valve`
  for (const id of required_inputs) callouts[id] = `${e.name}: sensor`
  return {
    key: e.id, label: e.name,
    required_valves, required_inputs, required_outputs,
    notes: null, callouts,
    label_overrides: e.valve ? { [e.valve]: e.name } : {},
  }
}

function _fixturePortRecord(f) {
  if (!f) return null
  const required_valves  = f.valve ? [f.valve] : []
  const required_inputs  = f.in_done ? [f.in_done] : []
  const required_outputs = f.out ? [f.out] : []
  if (!required_valves.length && !required_inputs.length
      && !required_outputs.length) return null
  const callouts = {}
  if (f.valve)   callouts[f.valve]   = `${f.name}: valve`
  if (f.in_done) callouts[f.in_done] = `${f.name}: done sensor`
  if (f.out)     callouts[f.out]     = `${f.name}: start signal`
  return {
    key: f.id, label: f.name,
    required_valves, required_inputs, required_outputs,
    notes: null, callouts,
    label_overrides: f.valve ? { [f.valve]: f.name } : {},
  }
}

const _sectionStyle = {
  background: '#fff', border: '1px solid #E5E7EB',
  borderRadius: 12, padding: 16,
  marginBottom: 16,
}

const _rowBtnGhost = {
  padding: '6px 10px', fontSize: 12, fontWeight: 600,
  background: '#fff', color: '#374151',
  border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
  fontFamily: 'inherit',
}
const _rowBtnPrimary = {
  padding: '6px 10px', fontSize: 12, fontWeight: 700,
  background: '#2563EB', color: '#fff',
  border: '1px solid #1D4ED8', borderRadius: 6, cursor: 'pointer',
  fontFamily: 'inherit',
}
const _rowBtnDanger = {
  padding: '6px 10px', fontSize: 12, fontWeight: 700,
  background: '#DC2626', color: '#fff',
  border: '1px solid #B91C1C', borderRadius: 6, cursor: 'pointer',
  fontFamily: 'inherit',
}
