import { useState, useEffect } from 'react'

/*
 * Conversational Program Wizard
 *
 * Each "page" asks ONE question. The answer determines the next page.
 * The program steps are built incrementally as the operator answers.
 * At any point the operator can go back and change a previous answer.
 */

// ────────────────────────────────────────────────────────
// Question definitions
// ────────────────────────────────────────────────────────

function QuestionCard({ question, description, children }) {
  return (
    <div style={{ padding: 32, maxWidth: 600, margin: '0 auto' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111', marginBottom: 8, lineHeight: 1.3 }}>
        {question}
      </div>
      {description && (
        <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 28, lineHeight: 1.5 }}>
          {description}
        </div>
      )}
      {children}
    </div>
  )
}

function ChoiceButton({ label, description, selected, onClick, icon }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', padding: '16px 18px', textAlign: 'left', cursor: 'pointer',
      background: selected ? '#eff6ff' : '#fff',
      border: selected ? '2px solid #2563EB' : '2px solid #e5e7eb',
      borderRadius: 10, marginBottom: 8,
      transition: 'all 100ms',
    }}
      onMouseEnter={e => { if (!selected) { e.currentTarget.style.borderColor = '#93c5fd'; e.currentTarget.style.background = '#f8fafc' }}}
      onMouseLeave={e => { if (!selected) { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff' }}}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {icon && <span style={{ fontSize: 24 }}>{icon}</span>}
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: selected ? '#2563EB' : '#111' }}>{label}</div>
          {description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{description}</div>}
        </div>
      </div>
    </button>
  )
}

function SliderQuestion({ label, value, onChange, min, max, step, unit, description }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#2563EB' }}>{value}{unit}</span>
      </div>
      {description && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{description}</div>}
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', height: 8 }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  )
}

function NextButton({ onClick, disabled, label }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: '100%', padding: '14px', fontSize: 16, fontWeight: 700, marginTop: 16,
      background: disabled ? '#d1d5db' : '#2563EB', color: '#fff',
      border: 'none', borderRadius: 10, cursor: disabled ? 'default' : 'pointer',
    }}>
      {label || 'Next'}
    </button>
  )
}

// ────────────────────────────────────────────────────────
// Wizard pages
// ────────────────────────────────────────────────────────

const PAGES = [
  // 0: What operation?
  {
    id: 'operation',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What do you want the robot to do?"
        description="Choose the type of operation. The wizard will guide you through the setup."
      >
        {[
          { value: 'pick_and_place', label: 'Pick and Place', desc: 'Pick an object and move it to another location', icon: 'P' },
          { value: 'sort', label: 'Sort Parts', desc: 'Identify parts and place them in different locations by type', icon: 'S' },
          { value: 'machine_tend', label: 'Machine Tending', desc: 'Load parts into a machine, wait, then unload', icon: 'M' },
          { value: 'palletize', label: 'Palletize', desc: 'Arrange parts in a grid pattern on a pallet', icon: 'G' },
          { value: 'inspect', label: 'Pick and Inspect', desc: 'Pick a part, inspect it with the camera, then sort pass/fail', icon: 'I' },
        ].map(op => (
          <ChoiceButton key={op.value} label={op.label} description={op.desc} icon={op.icon}
            selected={answers.operation === op.value}
            onClick={() => { setAnswer('operation', op.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 1: How does the robot find objects?
  {
    id: 'pick_method',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How should the robot find the parts?"
        description="Choose how the robot identifies what to pick up."
      >
        {[
          { value: 'camera_auto', label: 'Use Camera', desc: 'The camera detects objects automatically. Best when parts move around.' },
          { value: 'library_part', label: 'Look for Specific Part', desc: 'The camera looks for a specific part from the parts library. Only picks the right type.' },
          { value: 'fixed', label: 'Always Same Position', desc: 'The part is always in the same spot (e.g. from a feeder or conveyor).' },
        ].map(m => (
          <ChoiceButton key={m.value} label={m.label} description={m.desc}
            selected={answers.pick_method === m.value}
            onClick={() => { setAnswer('pick_method', m.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 2: Which part? (only if library_part selected)
  {
    id: 'which_part',
    skip: (answers) => answers.pick_method !== 'library_part',
    render: ({ answers, setAnswer, goNext }) => {
      const [parts, setParts] = useState([])
      useEffect(() => {
        fetch('/api/parts').then(r => r.json()).then(d => setParts(d.parts || [])).catch(() => {})
      }, [])
      return (
        <QuestionCard
          question="Which part should the robot look for?"
          description="Select a part from the library. The robot will only pick this type."
        >
          {parts.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#6b7280', border: '2px dashed #d1d5db', borderRadius: 8 }}>
              No parts in the library. Upload STEP files in Part Recognition first.
            </div>
          ) : parts.map(p => (
            <ChoiceButton key={p.id} label={p.name}
              description={`${p.extents_cm?.[0]} x ${p.extents_cm?.[1]} x ${p.extents_cm?.[2]} cm`}
              selected={answers.target_part === p.id}
              onClick={() => { setAnswer('target_part', p.id); setAnswer('target_part_name', p.name); goNext() }}
            />
          ))}
        </QuestionCard>
      )
    },
  },

  // 3: What gripper type?
  {
    id: 'gripper_type',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="What type of gripper will you use?"
        description="Choose the end-of-arm tool for this operation."
      >
        {[
          { value: 'finger', label: 'Finger Gripper', desc: 'Two parallel jaw fingers. Best for rigid parts with flat gripping surfaces.' },
          { value: 'vacuum', label: 'Vacuum Suction', desc: 'Vacuum cup picks from the top. Best for flat, smooth, sealed surfaces.' },
          { value: 'magnetic', label: 'Magnetic', desc: 'Electromagnetic gripper. For ferrous metal parts only.' },
        ].map(g => (
          <ChoiceButton key={g.value} label={g.label} description={g.desc}
            selected={answers.gripper_type === g.value}
            onClick={() => { setAnswer('gripper_type', g.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 4: Gripper settings
  {
    id: 'gripper_settings',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question={answers.gripper_type === 'finger' ? 'Set the gripper opening width' : answers.gripper_type === 'vacuum' ? 'Set the vacuum settings' : 'Configure the gripper'}
        description="These settings control how the gripper picks up parts."
      >
        {answers.gripper_type === 'finger' && (
          <>
            <SliderQuestion label="Opening width" value={answers.gripper_width || 85}
              onChange={v => setAnswer('gripper_width', v)} min={10} max={150} step={5} unit="mm"
              description="How wide the gripper opens before picking" />
            <SliderQuestion label="Grip force" value={answers.grip_force || 50}
              onChange={v => setAnswer('grip_force', v)} min={10} max={100} step={5} unit="%"
              description="How hard the gripper squeezes. Higher = more secure, but may damage soft parts" />
          </>
        )}
        {answers.gripper_type === 'vacuum' && (
          <SliderQuestion label="Vacuum threshold" value={answers.vacuum_threshold || 70}
            onChange={v => setAnswer('vacuum_threshold', v)} min={30} max={95} step={5} unit="%"
            description="Minimum vacuum level needed to confirm a successful pick" />
        )}
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 5: How fast?
  {
    id: 'speed',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How fast should the robot move?"
        description="Lower speed is safer, especially during initial testing. You can increase it later."
      >
        {[
          { value: 15, label: 'Slow', desc: 'Safe for first test runs. Good for heavy or fragile parts.' },
          { value: 40, label: 'Medium', desc: 'Normal production speed. Good balance of speed and safety.' },
          { value: 75, label: 'Fast', desc: 'Maximum production throughput. Use only after testing is complete.' },
        ].map(s => (
          <ChoiceButton key={s.value} label={s.label} description={s.desc}
            selected={answers.speed === s.value}
            onClick={() => { setAnswer('speed', s.value); goNext() }}
          />
        ))}
        <div style={{ marginTop: 16 }}>
          <SliderQuestion label="Custom speed" value={answers.speed || 40}
            onChange={v => setAnswer('speed', v)} min={5} max={100} step={5} unit="%"
            description="Or set an exact speed percentage" />
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 6: Approach height
  {
    id: 'approach',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="How high above the part should the robot approach?"
        description="The robot moves to this height above the part before descending to pick it up. Higher is safer but slower."
      >
        <SliderQuestion label="Approach height" value={answers.approach_height || 100}
          onChange={v => setAnswer('approach_height', v)} min={20} max={300} step={10} unit="mm"
          description="Distance above the part surface before the final descent" />
        <div style={{
          padding: 12, background: '#f0f9ff', borderRadius: 8,
          border: '1px solid #bfdbfe', fontSize: 12, color: '#2563EB', marginBottom: 16,
        }}>
          Recommended: 100-150mm for most operations. Use 50-80mm for tight spaces.
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 7: Where to place? (for pick_and_place)
  {
    id: 'place_method',
    skip: (answers) => answers.operation === 'machine_tend',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Where should the robot place the part?"
        description="Choose how the place location is determined."
      >
        {[
          { value: 'fixed', label: 'Fixed Position', desc: 'Always place at the same taught position.' },
          { value: 'relative', label: 'Relative Offset', desc: 'Place at a fixed offset from the pick position.' },
          ...(answers.operation === 'palletize' ? [
            { value: 'pallet', label: 'Pallet Grid', desc: 'Arrange parts in rows and columns on a pallet.' },
          ] : []),
          ...(answers.operation === 'sort' ? [
            { value: 'by_type', label: 'Sort by Part Type', desc: 'Different location for each part type.' },
          ] : []),
        ].map(p => (
          <ChoiceButton key={p.value} label={p.label} description={p.desc}
            selected={answers.place_method === p.value}
            onClick={() => { setAnswer('place_method', p.value); goNext() }}
          />
        ))}
      </QuestionCard>
    ),
  },

  // 8: Pallet configuration (only for palletize)
  {
    id: 'pallet_config',
    skip: (answers) => answers.place_method !== 'pallet',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Set up the pallet grid"
        description="How many rows and columns of parts on the pallet?"
      >
        <SliderQuestion label="Rows" value={answers.pallet_rows || 3}
          onChange={v => setAnswer('pallet_rows', v)} min={1} max={10} step={1} unit="" />
        <SliderQuestion label="Columns" value={answers.pallet_cols || 4}
          onChange={v => setAnswer('pallet_cols', v)} min={1} max={10} step={1} unit="" />
        <div style={{ fontSize: 14, color: '#374151', padding: '8px 0', fontWeight: 600 }}>
          Total positions: {(answers.pallet_rows || 3) * (answers.pallet_cols || 4)}
        </div>
        <NextButton onClick={goNext} label="Next" />
      </QuestionCard>
    ),
  },

  // 9: Machine I/O (only for machine_tend)
  {
    id: 'machine_io',
    skip: (answers) => answers.operation !== 'machine_tend',
    render: ({ answers, setAnswer, goNext }) => {
      const [ioLabels, setIoLabels] = useState({})
      useEffect(() => {
        fetch('/api/io/config').then(r => r.json()).then(d => setIoLabels(d.labels || {})).catch(() => {})
      }, [])
      const doOptions = Array.from({ length: 16 }, (_, i) => ({
        id: 'DO' + i, label: ioLabels['DO' + i] || 'DO' + i,
        pin: 'Y' + Math.floor(i/8) + '.' + (i%8),
      }))
      const diOptions = Array.from({ length: 16 }, (_, i) => ({
        id: 'DI' + i, label: ioLabels['DI' + i] || 'DI' + i,
        pin: 'X' + Math.floor(i/8) + '.' + (i%8),
      }))
      return (
        <QuestionCard
          question="Which I/O signals control the machine?"
          description="Select the digital outputs and inputs that communicate with the machine."
        >
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Cycle Start Signal (output to machine)
            </div>
            <select value={answers.io_cycle_start || 'DO4'}
              onChange={e => setAnswer('io_cycle_start', e.target.value)}
              style={{ width: '100%', padding: 10, fontSize: 14, borderRadius: 6, border: '1px solid #d1d5db' }}>
              {doOptions.map(o => <option key={o.id} value={o.id}>{o.pin} - {o.label}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Cycle Complete Signal (input from machine)
            </div>
            <select value={answers.io_cycle_done || 'DI3'}
              onChange={e => setAnswer('io_cycle_done', e.target.value)}
              style={{ width: '100%', padding: 10, fontSize: 14, borderRadius: 6, border: '1px solid #d1d5db' }}>
              {diOptions.map(o => <option key={o.id} value={o.id}>{o.pin} - {o.label}</option>)}
            </select>
          </div>
          <SliderQuestion label="Cycle timeout" value={answers.cycle_timeout || 30}
            onChange={v => setAnswer('cycle_timeout', v)} min={5} max={300} step={5} unit="s"
            description="Maximum time to wait for the machine to finish before flagging an error" />
          <NextButton onClick={goNext} label="Next" />
        </QuestionCard>
      )
    },
  },

  // 10: Should it repeat?
  {
    id: 'repeat',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Should the program repeat?"
        description="After completing all steps, should the robot start again?"
      >
        {[
          { value: 'once', label: 'Run Once', desc: 'Complete the operation one time and stop.' },
          { value: 'continuous', label: 'Run Continuously', desc: 'Repeat the cycle until stopped by the operator.' },
          { value: 'count', label: 'Run a Set Number of Times', desc: 'Repeat a specific number of cycles.' },
        ].map(r => (
          <ChoiceButton key={r.value} label={r.label} description={r.desc}
            selected={answers.repeat === r.value}
            onClick={() => { setAnswer('repeat', r.value); if (r.value !== 'count') goNext() }}
          />
        ))}
        {answers.repeat === 'count' && (
          <div style={{ marginTop: 12 }}>
            <SliderQuestion label="Number of cycles" value={answers.repeat_count || 10}
              onChange={v => setAnswer('repeat_count', v)} min={2} max={500} step={1} unit="" />
            <NextButton onClick={goNext} label="Next" />
          </div>
        )}
      </QuestionCard>
    ),
  },

  // 11: Name the program
  {
    id: 'name',
    render: ({ answers, setAnswer, goNext }) => (
      <QuestionCard
        question="Give your program a name"
        description="Choose a descriptive name so you can find it later in the program library."
      >
        <input value={answers.program_name || ''}
          onChange={e => setAnswer('program_name', e.target.value)}
          placeholder="e.g. Pick bolts from bin A"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && answers.program_name?.trim()) goNext() }}
          style={{
            width: '100%', padding: '14px 16px', fontSize: 18, fontWeight: 600,
            border: '2px solid #2563EB', borderRadius: 10, outline: 'none',
            marginBottom: 16,
          }}
        />
        <NextButton onClick={goNext} disabled={!answers.program_name?.trim()} label="Review Program" />
      </QuestionCard>
    ),
  },

  // 12: Review and save
  {
    id: 'review',
    render: ({ answers, steps, saving, onSave }) => (
      <QuestionCard
        question="Review your program"
        description={`"${answers.program_name}" — ${steps.length} steps`}
      >
        <div style={{
          background: '#f8fafc', borderRadius: 10, border: '1px solid #e5e7eb',
          padding: 14, marginBottom: 16, maxHeight: 350, overflowY: 'auto',
        }}>
          {steps.map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px',
              borderBottom: i < steps.length - 1 ? '1px solid #e5e7eb' : 'none',
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%',
                background: '#e5e7eb', color: '#374151',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}>{i + 1}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{s.label}</div>
                <div style={{ fontSize: 10, color: '#6b7280' }}>{s.action}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{
          padding: 14, background: '#f8fafc', borderRadius: 10,
          border: '1px solid #e5e7eb', marginBottom: 16, fontSize: 13,
        }}>
          <div style={{ fontWeight: 600, color: '#374151', marginBottom: 8 }}>Settings</div>
          <div style={{ color: '#6b7280' }}>Gripper: {answers.gripper_type}</div>
          <div style={{ color: '#6b7280' }}>Speed: {answers.speed}%</div>
          <div style={{ color: '#6b7280' }}>Approach height: {answers.approach_height}mm</div>
          <div style={{ color: '#6b7280' }}>Repeat: {answers.repeat === 'continuous' ? 'Continuously' : answers.repeat === 'count' ? answers.repeat_count + ' times' : 'Once'}</div>
        </div>

        <button onClick={onSave} disabled={saving} style={{
          width: '100%', padding: 16, fontSize: 17, fontWeight: 700,
          background: saving ? '#9ca3af' : '#16A34A', color: '#fff',
          border: 'none', borderRadius: 10, cursor: saving ? 'wait' : 'pointer',
        }}>
          {saving ? 'Saving...' : 'Save Program'}
        </button>
      </QuestionCard>
    ),
  },
]

// ────────────────────────────────────────────────────────
// Build steps from answers
// ────────────────────────────────────────────────────────

function buildSteps(answers) {
  const steps = []
  const spd = answers.speed || 40
  const slow = Math.min(spd, 30)
  const medium = Math.min(spd, 40)
  const appH = answers.approach_height || 100
  const gripW = answers.gripper_width || 85
  const gripF = answers.grip_force || 50
  const op = answers.operation

  steps.push({ action: 'move_home', label: 'Move to home position' })

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'open_gripper', label: 'Open gripper', width_mm: gripW, speed_pct: spd, io_open: 'DO1', io_open_confirm: 'DI1' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum off', io_id: 'DO2', value: 0 })
  }

  if (answers.pick_method === 'camera_auto') {
    steps.push({ action: 'detect', label: 'Detect objects with camera', mode: 'all' })
  } else if (answers.pick_method === 'library_part') {
    steps.push({ action: 'detect', label: 'Find ' + (answers.target_part_name || 'library part'), mode: 'library' })
  }

  steps.push({ action: 'approach', label: 'Move above pick position', target: answers.pick_method === 'fixed' ? 'fixed' : 'auto', offset_z_mm: appH, speed_pct: spd })
  steps.push({ action: 'move_linear', label: 'Descend to part', offset_z_mm: 0, speed_pct: slow })

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'close_gripper', label: 'Grip part', force_pct: gripF, io_close: 'DO0', io_close_confirm: 'DI0' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum on', io_id: 'DO2', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for vacuum seal', duration_s: 0.5 })
  } else {
    steps.push({ action: 'set_io', label: 'Magnet on', io_id: 'DO3', value: 1 })
  }

  steps.push({ action: 'move_linear', label: 'Lift part', offset_z_mm: appH, speed_pct: medium })

  if (op === 'machine_tend') {
    steps.push({ action: 'move_joint', label: 'Move to machine load position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to load position', offset_z_mm: 0, speed_pct: Math.min(spd, 20) })
    if (answers.gripper_type === 'finger') {
      steps.push({ action: 'open_gripper', label: 'Release part into machine', width_mm: gripW, io_open: 'DO1' })
    } else {
      steps.push({ action: 'set_io', label: 'Release part into machine', io_id: 'DO2', value: 0 })
    }
    steps.push({ action: 'move_linear', label: 'Retreat from machine', offset_z_mm: appH, speed_pct: slow })
    steps.push({ action: 'set_io', label: 'Start machine cycle', io_id: answers.io_cycle_start || 'DO4', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for machine to finish', duration_s: answers.cycle_timeout || 30 })
    steps.push({ action: 'set_io', label: 'Clear cycle start', io_id: answers.io_cycle_start || 'DO4', value: 0 })
    steps.push({ action: 'move_linear', label: 'Approach finished part', offset_z_mm: appH, speed_pct: slow })
    steps.push({ action: 'move_linear', label: 'Descend to finished part', offset_z_mm: 0, speed_pct: Math.min(spd, 20) })
    if (answers.gripper_type === 'finger') {
      steps.push({ action: 'close_gripper', label: 'Grip finished part', force_pct: gripF, io_close: 'DO0' })
    } else {
      steps.push({ action: 'set_io', label: 'Pick finished part', io_id: 'DO2', value: 1 })
    }
    steps.push({ action: 'move_linear', label: 'Lift finished part', offset_z_mm: appH, speed_pct: medium })
    steps.push({ action: 'move_joint', label: 'Move to unload position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to unload', offset_z_mm: 0, speed_pct: slow })
  } else if (op === 'inspect') {
    steps.push({ action: 'move_joint', label: 'Move to inspection pose', speed_pct: spd })
    steps.push({ action: 'detect', label: 'Inspect part with camera', mode: 'library' })
    steps.push({ action: 'move_joint', label: 'Move above place position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to place', offset_z_mm: 0, speed_pct: slow })
  } else {
    steps.push({ action: 'move_joint', label: 'Move above place position', speed_pct: spd })
    steps.push({ action: 'move_linear', label: 'Descend to place', offset_z_mm: 0, speed_pct: slow })
  }

  if (answers.gripper_type === 'finger') {
    steps.push({ action: 'open_gripper', label: 'Release part', width_mm: gripW, io_open: 'DO1' })
  } else if (answers.gripper_type === 'vacuum') {
    steps.push({ action: 'set_io', label: 'Vacuum off — release part', io_id: 'DO2', value: 0 })
    steps.push({ action: 'set_io', label: 'Blow off', io_id: 'DO3', value: 1 })
    steps.push({ action: 'wait', label: 'Wait for blow off', duration_s: 0.3 })
    steps.push({ action: 'set_io', label: 'Blow off stop', io_id: 'DO3', value: 0 })
  } else {
    steps.push({ action: 'set_io', label: 'Magnet off — release part', io_id: 'DO3', value: 0 })
  }

  steps.push({ action: 'move_linear', label: 'Lift from place', offset_z_mm: appH, speed_pct: medium })
  steps.push({ action: 'move_home', label: 'Return to home' })

  if (answers.repeat === 'continuous') {
    steps.push({ action: 'loop', label: 'Repeat continuously', goto: 1, count: 0 })
  } else if (answers.repeat === 'count') {
    steps.push({ action: 'loop', label: 'Repeat ' + (answers.repeat_count || 10) + ' times', goto: 1, count: answers.repeat_count || 10 })
  }

  return steps.map((s, i) => ({ ...s, step: i + 1 }))
}

// ────────────────────────────────────────────────────────
// Main wizard component
// ────────────────────────────────────────────────────────

export default function ProgramWizard({ onClose, onSaved }) {
  const [pageIdx, setPageIdx] = useState(0)
  const [answers, setAnswers] = useState({
    speed: 40,
    approach_height: 100,
    gripper_width: 85,
    grip_force: 50,
    vacuum_threshold: 70,
    repeat: 'once',
    repeat_count: 10,
    program_name: '',
  })
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState([0])

  const setAnswer = (key, value) => setAnswers(prev => ({ ...prev, [key]: value }))

  const goNext = () => {
    let next = pageIdx + 1
    while (next < PAGES.length && PAGES[next].skip?.(answers)) next++
    if (next < PAGES.length) {
      setPageIdx(next)
      setHistory(prev => [...prev, next])
    }
  }

  const goBack = () => {
    if (history.length > 1) {
      const newHistory = history.slice(0, -1)
      setHistory(newHistory)
      setPageIdx(newHistory[newHistory.length - 1])
    }
  }

  const builtSteps = buildSteps(answers)

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: answers.program_name,
          description: PAGES[0] && answers.operation ? answers.operation.replace(/_/g, ' ') : '',
          steps: builtSteps,
          tags: [answers.operation],
          config: answers,
        }),
      })
      const data = await res.json()
      if (data.ok) { onSaved?.(data.program); onClose() }
    } catch {}
    setSaving(false)
  }

  const page = PAGES[pageIdx]
  const progressPct = ((history.length - 1) / (PAGES.length - 1)) * 100

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '90%', maxWidth: 650, maxHeight: '90vh',
        background: '#fff', borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px', borderBottom: '1px solid #e5e7eb',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          {history.length > 1 && (
            <button onClick={goBack} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, color: '#6b7280', padding: '2px 6px',
            }}>{'<'}</button>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              New Program Wizard
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 18, color: '#9ca3af', padding: '2px 8px',
          }}>X</button>
        </div>

        {/* Progress bar */}
        <div style={{ height: 3, background: '#e5e7eb' }}>
          <div style={{
            height: '100%', background: '#2563EB',
            width: progressPct + '%',
            transition: 'width 300ms',
          }} />
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {page.render({
            answers,
            setAnswer,
            goNext,
            steps: builtSteps,
            saving,
            onSave: handleSave,
          })}
        </div>
      </div>
    </div>
  )
}
