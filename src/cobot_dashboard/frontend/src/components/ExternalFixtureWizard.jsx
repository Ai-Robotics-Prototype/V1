import { useEffect, useMemo, useState } from 'react'
import { GuidanceBlock } from './EOATSetupWizard'
import WhyExpander from './WhyExpander'
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
import {
  portDisplayName, portListDisplay, entrySubtitle, typeLabel,
} from '../lib/cellEntryDisplay'
import { useIoHardwareProfile } from '../lib/ioHardwareProfile'
import { useSynapsePortmap } from '../lib/synapsePortmap'
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
  '1. What kind of device is this?',
  '2. How does this device work?',
  '3. Confirm its behavior',
  "4. How will the robot know it's finished?",
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
  // Profile-aware subtitles: in OEM mode the picker row renders raw
  // controller channels (DO3 / DI4) instead of Synapse port names.
  const profile = useIoHardwareProfile()
  const portmap = useSynapsePortmap()
  return (
    <div data-testid="external-fixture-picker">
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
        External fixtures are things around your robot — clamps,
        turntables, part feeders, air blasts — that the program
        works with during a cycle.
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
                <div style={{ fontSize: 12, color: '#6B7280' }}
                     data-testid="external-fixture-picker-row-subtitle"
                     data-io-profile={profile}>
                  {entrySubtitle(f, { profile, portmap })}
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
      label: 'The robot controls its air',
      desc: 'The robot sends air to the device to open or close it.' },
    { key: 'own_controller',
      label: 'It has its own controls — the robot just tells it to go',
      desc: 'The device runs itself. The robot sends a start signal '
        + 'and waits for the device to finish.' },
    { key: 'manual',
      label: 'A person operates it',
      desc: 'A human handles the device. The robot pauses and asks '
        + 'the operator to press continue.' },
  ]
  return (
    <div data-testid="fixture-step-power"
         style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 13, color: '#374151' }}>
        {typeDef
          ? <>How does the <b>{typeDef.label.toLowerCase()}</b> work?</>
          : 'How does this device work?'}
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
      title: 'Yes — keep holding',
      desc: 'The device holds whatever it is holding when power or '
        + 'air is lost. Pick this if letting go would drop a part '
        + 'or damage something.' },
    { key: false,
      title: 'No — let go',
      desc: 'The device opens on its own when power or air is lost. '
        + 'Pick this for guards or doors that should open for a '
        + 'person to walk through.' },
  ]
  return (
    <div data-testid="fixture-step-air"
         data-preselected-hold="true"
         style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
        If the robot suddenly stops, should this keep holding the
        part?
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
          Recommended — the part won't drop.
        </div>
      )}
      <WhyExpander
        label="Why does this matter?"
        testId="fixture-hold-why">
        "Yes" installs a 5/2 DS (double-solenoid) valve so the device
        remembers its last commanded position when power drops. "No"
        installs a 5/2 SS (single-solenoid) valve with a spring that
        returns the device to its home position.
      </WhyExpander>
    </div>
  )
}

function OwnControllerStep({ answers, onWantsDoneChange }) {
  const wants = answers.wants_done !== false
  return (
    <div data-testid="fixture-step-own-controller"
         style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>
        Does the device tell the robot when it's finished?
      </div>
      <div style={{ fontSize: 12, color: '#6b7280' }}>
        The robot always sends the start signal. The device telling
        the robot "I'm done" is a separate wire. If it doesn't, the
        robot will wait a fixed amount of time instead.
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
              {v ? 'Yes — it sends a done signal'
                 : 'No — the robot will wait a set time'}
            </button>
          )
        })}
      </div>
      <WhyExpander
        label="Which is safer?"
        testId="fixture-wants-done-why">
        A done signal is safer than a timer — the robot never guesses
        whether the device finished. Pick "No" only when the device
        has no spare output to wire back.
      </WhyExpander>
    </div>
  )
}

function CompletionStep({ answers, onCompletion, onWaitS }) {
  const kind = answers.completion
  return (
    <div data-testid="fixture-step-completion"
         style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, color: '#374151' }}>
        How will the robot know it's finished?
      </div>
      {[
        { key: 'sensor', label: 'A sensor tells it',
          desc: 'A sensor on the device sends a signal when it is '
            + 'done. The robot waits for the signal before moving on.' },
        { key: 'wait', label: 'It always takes about the same time',
          desc: 'The robot waits a set number of seconds. Pick this '
            + 'only when the device has no signal — a timer cannot '
            + 'tell if the device actually finished.' },
        { key: 'operator', label: 'A person will press continue',
          desc: 'The program pauses and asks the operator to confirm '
            + 'before moving on.' },
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
          A sensor is safest — the robot never guesses whether the
          device finished.
        </div>
      )}
    </div>
  )
}

function SummaryStep({ answers, setAnswers, record, saved, busy, error, onSave }) {
  const port = fixturePortMap(record)
  // Profile-aware receipt: in OEM mode the "Wire ... to" rows show
  // controller channels (DO3, DI4) instead of Synapse port names,
  // matching what the operator actually lands on the cabinet block.
  const profile = useIoHardwareProfile()
  const portmap = useSynapsePortmap()
  const _port = (id) => portDisplayName(id, { profile, portmap })
  return (
    <div data-testid="fixture-step-summary"
         data-io-profile={profile}
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
        <div><b>Kind:</b> {typeLabel(record)}</div>
        <div><b>How it works:</b> {_powerLabel(record.power_mode)}</div>
        {record.hold_on_loss !== null && (
          <div>
            <b>If the robot stops:</b>{' '}
            {record.hold_on_loss ? 'Keeps holding' : 'Lets go'}
          </div>
        )}
        {record.valve && (
          <div><b>Wire air line to:</b> {_port(record.valve)}</div>
        )}
        {record.out && (
          <div><b>Wire start signal to:</b> {_port(record.out)}</div>
        )}
        {record.in_done && (
          <div><b>Wire done sensor to:</b> {_port(record.in_done)}</div>
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
          glowing points on the map.
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
          No spare air slots left on the controller. Remove an
          unused tool or fixture to free one up, then come back.
        </div>
      )}
    </div>
  )
}

function _powerLabel(pm) {
  if (pm === 'air') return 'The robot controls its air'
  if (pm === 'own_controller') return 'It has its own controls — the robot tells it to go'
  if (pm === 'manual') return 'A person operates it'
  return '—'
}

function _completionLabel(kind, waitS) {
  if (kind === 'sensor') return 'A sensor tells it'
  if (kind === 'wait') return `Waiting ${waitS ?? '?'} s`
  if (kind === 'operator') return 'A person will press continue'
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
