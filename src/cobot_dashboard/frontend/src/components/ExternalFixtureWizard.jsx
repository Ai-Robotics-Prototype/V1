import { useEffect, useMemo, useState } from 'react'
import { GuidanceBlock } from './EOATSetupWizard'
import {
  FIXTURE_TYPES, FIXTURE_TYPE_KEYS,
  compileFixtureRecord, fixturePortMap,
} from '../lib/fixturesData'
import {
  listFixtures, saveFixture, removeFixture,
} from '../lib/fixturesStore'
import { listTools } from '../lib/toolsApi'
import {
  saveCellFixture, deleteCellFixture,
} from '../lib/cellStore'
import { useKeyboardInset, scrollFocusedIntoView } from '../lib/keyboardInset'

// External Fixture Wizard (2026-09-22 operator directive).
//
// Process-language interview. The operator answers questions about
// what the device DOES; the wizard compiles the answers to Synapse
// port assignments. The wizard NEVER emits IO writes — the summary
// is a wiring guide the operator confirms and wires.
//
// Screens (one question each; back-paths on every step):
//   0. Device type (cards, per-type defaults)
//   1. Power fork (air / own-controller / manual)
//   2. Actuation branch:
//      - air:            hold-on-loss (skipped for blow-off type)
//      - own-controller: "does it signal back when finished?"
//      - manual:         skipped
//   3. Completion feedback (sensor / wait / operator)
//   4. Name + Summary (glowing map + tick-off list + save)
//
// Records persist in localStorage via lib/fixturesStore. Backend
// persistence is a named follow-up.
//
// Program-editor exposure ("Close Vice 1", "Wait Vice 1 done",
// "Trigger Feeder") is DESIGNED into the record shape but WIRING
// the editor is a named follow-up — not this session.

const STEP_TITLES = [
  '1. What kind of fixture?',
  '2. How is it powered?',
  '3. Actuation',
  "4. How will the robot know it's done?",
  '5. Name + wire it up',
]

export default function ExternalFixtureWizard({ onClose, initialId = null }) {
  const [step, setStep] = useState(0)
  const [tools, setTools] = useState([])
  const [fixtures, setFixtures] = useState([])
  const [answers, setAnswers] = useState(() => ({}))
  const [saved, setSaved] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [picker, setPicker] = useState(initialId == null)
  const [editingId, setEditingId] = useState(initialId)

  useKeyboardInset()

  useEffect(() => {
    let alive = true
    Promise.all([
      listTools().catch(() => []),
      listFixtures().catch(() => []),
    ]).then(([t, f]) => {
      if (!alive) return
      setTools(t || [])
      setFixtures(f || [])
      if (editingId) {
        const existing = (f || []).find((row) => row.id === editingId)
        if (existing) {
          setAnswers(_recordToAnswers(existing))
          setPicker(false)
        }
      }
    })
    return () => { alive = false }
  }, [editingId])

  const typeDef = FIXTURE_TYPES[answers.type] || null

  // Answers → record preview (also used for summary render).
  const record = useMemo(() => {
    if (!answers.type) return null
    return compileFixtureRecord(answers, {
      tools,
      fixtures: fixtures.filter((f) => f.id !== editingId),
    })
  }, [answers, tools, fixtures, editingId])

  const powerMode = record ? record.power_mode : null
  const isAirBlowOff = record && record.actuation === 'blow_off'
  const skipsActuation = (
    powerMode === 'manual'
    || (powerMode === 'air' && isAirBlowOff)
  )

  // canAdvance: which fields must be answered to leave the current step.
  const canAdvance = (
    step === 0 ? !!answers.type
    : step === 1 ? !!powerMode
    : step === 2 ? _actuationStepReady(powerMode, answers, skipsActuation)
    : step === 3 ? _completionStepReady(answers)
    : true
  )

  // Skip step 2 entirely for manual + air-blow-off (they have no
  // actuation question to answer).
  function nextStep() {
    if (step === 1 && skipsActuation) {
      setStep(3)
      return
    }
    setStep(Math.min(4, step + 1))
  }
  function prevStep() {
    if (step === 3 && skipsActuation) {
      setStep(1)
      return
    }
    setStep(Math.max(0, step - 1))
  }

  async function commitSave() {
    if (!record) return
    setBusy(true); setError(null)
    try {
      const withEditing = { ...record, id: editingId || null }
      const persisted = await saveFixture(withEditing)
      // Also write to the cell (single-source allocation truth).
      // Backend failure here doesn't undo the local save — the cell
      // will pick up the fixture on next reconcile.
      try { await saveCellFixture(persisted) } catch { /* soft-fail */ }
      setSaved(persisted)
      setEditingId(persisted.id)
      const refreshed = await listFixtures()
      setFixtures(refreshed)
    } catch (e) {
      setError(String(e && e.message || e))
    } finally {
      setBusy(false)
    }
  }

  async function commitDelete(id) {
    if (!id) return
    setBusy(true); setError(null)
    try {
      await removeFixture(id)
      try { await deleteCellFixture(id) } catch { /* soft-fail */ }
      const refreshed = await listFixtures()
      setFixtures(refreshed)
      setPicker(true)
      setEditingId(null)
      setAnswers({})
      setStep(0)
      setSaved(null)
    } catch (e) {
      setError(String(e && e.message || e))
    } finally {
      setBusy(false)
    }
  }

  function startFresh() {
    setPicker(false)
    setEditingId(null)
    setAnswers({})
    setStep(0)
    setSaved(null)
  }

  function editExisting(row) {
    setEditingId(row.id)
    setAnswers(_recordToAnswers(row))
    setPicker(false)
    setStep(4)     // jump straight to summary for edits
    setSaved(row)
  }

  return (
    <div style={_backdrop} onClick={busy ? null : onClose}
         data-testid="external-fixture-wizard">
      <div style={_panel} onClick={(e) => e.stopPropagation()}>
        <div style={_headerRow}>
          <div style={_title}>External Fixtures</div>
          <button style={_btnGhost} onClick={onClose}
                  data-testid="external-fixture-close">
            Close
          </button>
        </div>

        {picker && (
          <FixturePicker
            fixtures={fixtures}
            onNew={startFresh}
            onEdit={editExisting}
            onDelete={commitDelete}
          />
        )}

        {!picker && (
          <div data-testid="external-fixture-body">
            <div style={_topRow}>
              <button style={_btnGhost}
                      data-testid="external-fixture-back-to-picker"
                      onClick={() => { setPicker(true); setSaved(null) }}>
                ← Fixtures list
              </button>
              <div style={{ fontSize: 14, color: '#374151' }}>
                {STEP_TITLES[step]}
              </div>
            </div>

            {step === 0 && (
              <DeviceTypeStep
                selected={answers.type}
                onPick={(k) => setAnswers({
                  ...answers, type: k,
                  power_mode: FIXTURE_TYPES[k].defaults.power_mode || null,
                  actuation: FIXTURE_TYPES[k].defaults.air_actuation || null,
                  hold_on_loss:
                    typeof FIXTURE_TYPES[k].defaults.hold_on_loss === 'boolean'
                      ? FIXTURE_TYPES[k].defaults.hold_on_loss : null,
                })}
              />
            )}

            {step === 1 && (
              <PowerForkStep
                typeDef={typeDef}
                selected={powerMode}
                onPick={(pm) => setAnswers({
                  ...answers,
                  power_mode: pm,
                  // Reset per-branch answers when power mode flips.
                  hold_on_loss: pm === 'air'
                    ? (typeof answers.hold_on_loss === 'boolean'
                        ? answers.hold_on_loss
                        : (typeDef?.defaults.hold_on_loss ?? null))
                    : null,
                  wants_done: pm === 'own_controller'
                    ? (answers.wants_done ?? true) : false,
                })}
              />
            )}

            {step === 2 && !skipsActuation && powerMode === 'air' && (
              <AirActuationStep
                answers={answers}
                onHoldChange={(v) => setAnswers({ ...answers, hold_on_loss: v })}
              />
            )}
            {step === 2 && !skipsActuation && powerMode === 'own_controller' && (
              <OwnControllerStep
                answers={answers}
                onWantsDoneChange={(v) => setAnswers({
                  ...answers, wants_done: v,
                })}
              />
            )}

            {step === 3 && (
              <CompletionStep
                answers={answers}
                onCompletion={(v) => setAnswers({ ...answers, completion: v })}
                onWaitS={(v) => setAnswers({ ...answers, wait_s: v })}
              />
            )}

            {step === 4 && record && (
              <SummaryStep
                answers={answers}
                setAnswers={setAnswers}
                record={record}
                saved={saved}
                busy={busy}
                error={error}
                onSave={commitSave}
              />
            )}

            <div style={_footerRow}>
              {step > 0 && (
                <button style={_btnGhost}
                        data-testid="external-fixture-back"
                        onClick={prevStep}>
                  ← Back
                </button>
              )}
              <div style={{ flex: 1 }} />
              {step < 4 && (
                <button
                  data-testid="external-fixture-next"
                  disabled={!canAdvance}
                  onClick={nextStep}
                  style={{
                    ..._btnPrim,
                    opacity: canAdvance ? 1 : 0.4,
                    cursor: canAdvance ? 'pointer' : 'not-allowed',
                  }}>
                  Next →
                </button>
              )}
              {step === 4 && !saved && (
                <button
                  data-testid="external-fixture-save"
                  disabled={busy}
                  onClick={commitSave}
                  style={_btnPrim}>
                  {busy ? 'Saving…' : 'Save fixture'}
                </button>
              )}
              {step === 4 && saved && (
                <button
                  data-testid="external-fixture-done"
                  onClick={() => { setPicker(true); setSaved(null) }}
                  style={_btnPrim}>
                  Done
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function _actuationStepReady(powerMode, answers, skipsActuation) {
  if (skipsActuation) return true
  if (powerMode === 'air') return typeof answers.hold_on_loss === 'boolean'
  if (powerMode === 'own_controller') return typeof answers.wants_done === 'boolean'
  return true
}

function _completionStepReady(answers) {
  if (!answers.completion) return false
  if (answers.completion === 'wait') {
    const n = Number(answers.wait_s)
    return Number.isFinite(n) && n > 0
  }
  return true
}

function _recordToAnswers(rec) {
  return {
    id: rec.id,
    type: rec.type,
    power_mode: rec.power_mode,
    actuation: rec.actuation,
    hold_on_loss: rec.hold_on_loss,
    completion: rec.completion,
    wait_s: rec.wait_s,
    wants_done: !!rec.in_done,
    name: rec.name,
    created_at: rec.created_at,
  }
}

// ── Steps ───────────────────────────────────────────────────────────

function FixturePicker({ fixtures, onNew, onEdit, onDelete }) {
  return (
    <div data-testid="external-fixture-picker">
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
        External fixtures are things around your robot — vices,
        indexers, feeders, blow-offs — that the program interacts
        with during a cycle.
      </div>
      <button
        data-testid="external-fixture-new"
        onClick={onNew}
        style={{
          ..._btnPrim, marginBottom: 12, minWidth: 200,
        }}>
        + Add a new fixture
      </button>
      {fixtures.length === 0 && (
        <div style={{
          padding: 14, borderRadius: 8, background: '#F9FAFB',
          color: '#374151', fontSize: 13,
        }}>
          No fixtures yet. Add one to get started.
        </div>
      )}
      {fixtures.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {fixtures.map((f) => (
            <div key={f.id}
                 data-testid="external-fixture-picker-row"
                 data-fixture-id={f.id}
                 style={{
                   display: 'flex', gap: 10, alignItems: 'center',
                   padding: '10px 12px', border: '1px solid #E5E7EB',
                   borderRadius: 8, background: '#fff',
                 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
                  {f.name}
                </div>
                <div style={{ fontSize: 12, color: '#6B7280' }}>
                  {FIXTURE_TYPES[f.type]?.label || f.type}
                  {f.valve && ` · ${f.valve}`}
                  {f.out && ` · ${f.out}`}
                  {f.in_done && ` · ${f.in_done}`}
                </div>
              </div>
              <button
                data-testid="external-fixture-edit"
                data-fixture-id={f.id}
                onClick={() => onEdit(f)}
                style={_btnGhost}>Edit</button>
              <button
                data-testid="external-fixture-delete"
                data-fixture-id={f.id}
                onClick={() => onDelete(f.id)}
                style={{ ..._btnGhost, color: '#B91C1C',
                          borderColor: '#FCA5A5' }}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DeviceTypeStep({ selected, onPick }) {
  return (
    <div data-testid="fixture-step-type"
         style={{ display: 'grid', gap: 10,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {FIXTURE_TYPE_KEYS.map((k) => {
        const t = FIXTURE_TYPES[k]
        const on = selected === k
        return (
          <button key={k}
                  data-testid="fixture-type-card"
                  data-type-key={k}
                  data-selected={String(on)}
                  onClick={() => onPick(k)}
                  style={{
                    textAlign: 'left', padding: '12px 14px',
                    background: on ? '#EFF6FF' : '#fff',
                    border: `1px solid ${on ? '#2563EB' : '#d1d5db'}`,
                    borderRadius: 8, cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
              {t.label}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
              {t.desc}
            </div>
            <div style={{ fontSize: 11, color: '#4B5563', marginTop: 6,
                          fontStyle: 'italic' }}>
              {t.why}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function PowerForkStep({ typeDef, selected, onPick }) {
  const options = [
    { key: 'air',
      label: 'Air (the robot controls its air)',
      desc: 'The robot pushes air to a valve on the panel. Use this '
        + 'for anything opened and closed by a pneumatic cylinder.' },
    { key: 'own_controller',
      label: 'Has its own controller (robot sends a go signal)',
      desc: 'The device runs itself. The robot dry-triggers it to '
        + 'start and reads back a done signal.' },
    { key: 'manual',
      label: 'Manual (a person operates it)',
      desc: 'A human handles the device. The robot only waits for '
        + 'the operator to say "continue".' },
  ]
  return (
    <div data-testid="fixture-step-power"
         style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, color: '#374151' }}>
        {typeDef
          ? <>How is the <b>{typeDef.label.toLowerCase()}</b> powered?</>
          : 'How is this fixture powered?'}
      </div>
      {options.map((o) => {
        const on = selected === o.key
        return (
          <button key={o.key}
                  data-testid="fixture-power-choice"
                  data-value={o.key}
                  data-selected={String(on)}
                  onClick={() => onPick(o.key)}
                  style={{
                    textAlign: 'left', padding: '10px 12px',
                    background: on ? '#DBEAFE' : '#fff',
                    border: `1px solid ${on ? '#2563EB' : '#d1d5db'}`,
                    borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
              {o.label}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {o.desc}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function AirActuationStep({ answers, onHoldChange }) {
  const hold = answers.hold_on_loss
  const cards = [
    { key: true,
      title: 'Stay clamped',
      desc: 'Keep gripping when power or air is lost. Recommended '
        + 'for anything holding a part the robot cannot afford to '
        + 'drop mid-cycle.' },
    { key: false,
      title: 'Release',
      desc: 'Let go when power or air is lost. Recommended for '
        + 'anything grabbing a person or a fragile item, and for '
        + 'guards / doors that should open on power loss.' },
  ]
  return (
    <div data-testid="fixture-step-air"
         data-preselected-hold="true"
         style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
        If the robot stops or air is lost, should it STAY CLAMPED
        or RELEASE?
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        {cards.map((c) => {
          const on = hold === c.key
          return (
            <button key={String(c.key)}
                    data-testid="fixture-hold-choice"
                    data-value={String(c.key)}
                    data-selected={String(on)}
                    onClick={() => onHoldChange(c.key)}
                    style={{
                      flex: 1, textAlign: 'left', padding: '12px 14px',
                      background: on
                        ? (c.key ? '#DCFCE7' : '#DBEAFE')
                        : '#fff',
                      border: `1px solid ${on
                        ? (c.key ? '#22C55E' : '#2563EB') : '#d1d5db'}`,
                      borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                    }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>
                {c.title}
              </div>
              <div style={{ fontSize: 12, color: '#374151', marginTop: 4 }}>
                {c.desc}
              </div>
            </button>
          )
        })}
      </div>
      {hold === true && (
        <div data-testid="fixture-hold-recommended-copy"
             style={{
               padding: '8px 12px', background: '#ECFDF5',
               border: '1px solid #6EE7B7', borderRadius: 6,
               fontSize: 12, color: '#065F46', lineHeight: 1.5,
             }}>
          Recommended — the part won't drop if power or air is lost.
        </div>
      )}
      <div style={{
        padding: '8px 12px', background: '#F9FAFB',
        border: '1px solid #E5E7EB', borderRadius: 6,
        fontSize: 12, color: '#6B7280', lineHeight: 1.5,
      }}>
        Why this matters — the answer picks the physical valve type
        (spring-return vs. memory) so the panel behaves the way you
        chose without any additional configuration.
      </div>
    </div>
  )
}

function OwnControllerStep({ answers, onWantsDoneChange }) {
  const wants = answers.wants_done !== false
  return (
    <div data-testid="fixture-step-own-controller"
         style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
        Does it signal back when finished?
      </div>
      <div style={{ fontSize: 12, color: '#6b7280' }}>
        The robot always sends a start signal on a spare output.
        Reading a done signal back is optional — pick "No" and the
        program will wait a fixed number of seconds instead.
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        {[true, false].map((v) => {
          const on = wants === v
          return (
            <button key={String(v)}
                    data-testid="fixture-wants-done"
                    data-value={String(v)}
                    data-selected={String(on)}
                    onClick={() => onWantsDoneChange(v)}
                    style={{
                      flex: 1, padding: '10px 12px',
                      background: on ? '#DBEAFE' : '#fff',
                      border: `1px solid ${on ? '#2563EB' : '#d1d5db'}`,
                      borderRadius: 8, cursor: 'pointer', fontWeight: 700,
                      fontFamily: 'inherit',
                    }}>
              {v ? 'Yes — read a done signal' : 'No — wait a set time'}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CompletionStep({ answers, onCompletion, onWaitS }) {
  const kind = answers.completion
  return (
    <div data-testid="fixture-step-completion"
         style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, color: '#374151' }}>
        Choose how the program moves past this fixture.
      </div>
      {[
        { key: 'sensor', label: 'Read a sensor',
          desc: 'The robot waits until an input on the panel confirms '
            + 'the fixture is done. Best answer for clamps, doors, '
            + 'and anything where "done" has a physical signal.' },
        { key: 'wait', label: 'Wait a fixed time',
          desc: 'The robot waits a set number of seconds. Use only '
            + 'when a signal is not available — a timer cannot tell '
            + 'if the fixture actually finished.' },
        { key: 'operator', label: 'Wait for operator',
          desc: 'The program pauses and prompts the operator to '
            + 'press Continue.' },
      ].map((c) => {
        const on = kind === c.key
        return (
          <button key={c.key}
                  data-testid="fixture-completion-choice"
                  data-value={c.key}
                  data-selected={String(on)}
                  onClick={() => onCompletion(c.key)}
                  style={{
                    textAlign: 'left', padding: '10px 12px',
                    background: on ? '#DBEAFE' : '#fff',
                    border: `1px solid ${on ? '#2563EB' : '#d1d5db'}`,
                    borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                  }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
              {c.label}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {c.desc}
            </div>
          </button>
        )
      })}
      {kind === 'wait' && (
        <div data-testid="fixture-wait-field"
             style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 13, color: '#374151' }}>
            Wait time (seconds):
          </label>
          <input
            type="number" step="0.1" min="0"
            data-testid="fixture-wait-s"
            value={answers.wait_s ?? ''}
            onChange={(e) => onWaitS(e.target.value)}
            onFocus={(e) => scrollFocusedIntoView(e.currentTarget)}
            style={{
              padding: '6px 10px', fontSize: 14, width: 100,
              border: '1px solid #d1d5db', borderRadius: 6,
              fontFamily: 'inherit',
            }} />
          <span style={{ fontSize: 12, color: '#6B7280' }}>seconds</span>
        </div>
      )}
      {kind === 'sensor' && (
        <div style={{
          padding: '8px 12px', background: '#FFFBEB',
          border: '1px solid #FDE68A', borderRadius: 6,
          fontSize: 12, color: '#92400E', lineHeight: 1.5,
        }}>
          A sensor is safer than a timer on anything that holds a
          part — a timer only measures how long you waited, not
          whether the fixture actually reached its state.
        </div>
      )}
    </div>
  )
}

function SummaryStep({ answers, setAnswers, record, saved, busy, error, onSave }) {
  const port = fixturePortMap(record)
  return (
    <div data-testid="fixture-step-summary"
         style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 12, color: '#6B7280', fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Name
        </div>
        <input
          type="text"
          value={answers.name ?? record.name}
          onChange={(e) => setAnswers({ ...answers, name: e.target.value })}
          onFocus={(e) => scrollFocusedIntoView(e.currentTarget)}
          data-testid="fixture-name-input"
          placeholder={record.name}
          style={{
            marginTop: 4, padding: '8px 10px', fontSize: 14,
            width: '100%', maxWidth: 320,
            border: '1px solid #d1d5db', borderRadius: 6,
            fontFamily: 'inherit',
          }} />
      </div>

      <div style={{
        padding: 12, background: '#F9FAFB',
        border: '1px solid #E5E7EB', borderRadius: 8,
        fontSize: 13, color: '#111827', lineHeight: 1.6,
      }} data-testid="fixture-summary-record">
        <div><b>Type:</b> {FIXTURE_TYPES[record.type]?.label || record.type}</div>
        <div><b>Powered by:</b> {_powerLabel(record.power_mode)}</div>
        {record.hold_on_loss !== null && (
          <div>
            <b>On power/air loss:</b>{' '}
            {record.hold_on_loss ? 'Stay clamped' : 'Release'}
          </div>
        )}
        {record.valve && (
          <div><b>Valve slot:</b> {record.valve}</div>
        )}
        {record.out && (
          <div><b>Start-signal output:</b> {record.out}</div>
        )}
        {record.in_done && (
          <div><b>Done sensor:</b> {record.in_done}</div>
        )}
        <div>
          <b>Robot waits by:</b>{' '}
          {_completionLabel(record.completion, record.wait_s)}
        </div>
      </div>

      <GuidanceBlock port={port} />

      {saved && (
        <div data-testid="fixture-saved"
             style={{
               padding: '10px 12px', background: '#ECFDF5',
               border: '1px solid #6EE7B7', borderRadius: 6,
               color: '#065F46', fontSize: 12,
             }}>
          Saved — "{saved.name}" is in your fixtures list. Wire the
          ports the map is glowing.
        </div>
      )}
      {error && (
        <div style={{
          padding: '10px 12px', background: '#FEE2E2',
          border: '1px solid #FCA5A5', borderRadius: 6,
          color: '#7F1D1D', fontSize: 12,
        }}>
          {error}
        </div>
      )}
      {busy && (
        <div style={{ fontSize: 12, color: '#6B7280' }}>Working…</div>
      )}
      {!record.valve && record.power_mode === 'air' && (
        <div data-testid="fixture-no-spare-valve"
             style={{
               padding: '10px 12px', background: '#FEF3C7',
               border: '1px solid #FDE68A', borderRadius: 6,
               color: '#92400E', fontSize: 12,
             }}>
          No spare valve slots left on the panel. Free one up by
          deleting an unused tool or fixture, then come back.
        </div>
      )}
    </div>
  )
}

function _powerLabel(pm) {
  if (pm === 'air') return 'Air (robot-controlled)'
  if (pm === 'own_controller') return 'Its own controller (dry-signal from robot)'
  if (pm === 'manual') return 'Manual (operator)'
  return '—'
}

function _completionLabel(kind, waitS) {
  if (kind === 'sensor') return 'Reading a sensor'
  if (kind === 'wait') return `Waiting ${waitS ?? '?'} s`
  if (kind === 'operator') return 'Waiting for the operator'
  return '—'
}

// ── Styles (local module tokens; no page-level styling) ─────────────

const _backdrop = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  zIndex: 9998, display: 'flex', alignItems: 'center',
  justifyContent: 'center',
}
const _panel = {
  background: '#fff', borderRadius: 12,
  padding: 24, width: 'min(960px, 96vw)',
  // Consume the keyboard inset so the modal shrinks around the
  // on-screen keyboard on tablet. Falls back cleanly when --kb-inset
  // is 0 (desktop / no keyboard).
  maxHeight: 'calc(92vh - var(--kb-inset, 0px))',
  paddingBottom: 'calc(24px + var(--kb-inset, 0px))',
  overflow: 'auto',
  boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
  fontFamily: 'inherit',
}
const _title = {
  fontSize: 20, fontWeight: 700, marginBottom: 12, color: '#111827',
}
const _headerRow = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
}
const _topRow = {
  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
}
const _footerRow = {
  display: 'flex', gap: 8, alignItems: 'center', marginTop: 14,
}
const _btnPrim = {
  padding: '10px 18px', fontSize: 14, fontWeight: 700,
  background: '#0284c7', color: '#fff', border: '1px solid #0369a1',
  borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
}
const _btnGhost = {
  padding: '10px 16px', fontSize: 14, fontWeight: 600,
  background: '#fff', color: '#374151',
  border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer',
  fontFamily: 'inherit',
}
