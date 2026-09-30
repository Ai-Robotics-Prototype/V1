import { useEffect, useState } from 'react'
import { GuidanceBlock } from './EOATSetupWizard'
import { getCell } from '../lib/cellStore'
import {
  namedActionsForEoat, namedActionsForFixture,
} from '../lib/cellActions'

// My Cell — read-only summary of the cell registry.
//
// 2026-09-22 operator directive (The Cell): natural home is a
// section on the Synapse page or adjacent — "the cell at a glance".
// Lists every EOAT + fixture with its port assignments; each entry
// exposes its named actions inline so operators can see what a
// program built on this cell can do.
//
// VIEW-tier ONLY — no writes, no /cmd/, no IO. The wizards write to
// the cell; this view reads it.

export default function MyCellSection() {
  const [cell, setCell]   = useState(null)
  const [err, setErr]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)

  useEffect(() => {
    let alive = true
    getCell()
      .then((c) => { if (alive) { setCell(c); setLoading(false) } })
      .catch((e) => { if (alive) {
        setErr(String(e && e.message || e)); setLoading(false)
      } })
    return () => { alive = false }
  }, [])

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
                expanded={expandedId === e.id}
                onToggle={() => setExpandedId(
                  expandedId === e.id ? null : e.id)}
                ports={_eoatPortRecord(e)}
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

function _EntryRow({ entry, actions, expanded, onToggle, ports, ...rest }) {
  const portsLine = [entry.valve, entry.out, entry.in_done,
                     ...(entry.inputs || [])]
    .filter(Boolean).join(' · ')
  return (
    <div data-testid="my-cell-entry"
         data-cell-id={entry.id}
         data-kind={rest['data-kind']}
         style={{
           border: '1px solid #E5E7EB', borderRadius: 8,
           background: '#fff', overflow: 'hidden',
         }}>
      <button
        data-testid="my-cell-entry-toggle"
        onClick={onToggle}
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          gap: 10, padding: '10px 12px',
          background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
        }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
            {entry.name}
          </div>
          <div style={{ fontSize: 12, color: '#6B7280' }}>
            {entry.type}{portsLine ? ` · ${portsLine}` : ''}
          </div>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600, color: '#6B7280',
          textTransform: 'uppercase',
        }}>
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>
      {expanded && (
        <div style={{
          borderTop: '1px solid #E5E7EB', padding: 12,
          background: '#F9FAFB',
        }} data-testid="my-cell-entry-body">
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
