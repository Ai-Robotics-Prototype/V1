import { useState, useEffect } from 'react'

const OPERATION_TYPES = [
  {
    id: 'pick_and_place',
    name: 'Pick and Place',
    description: 'Pick an object from one location and place it at another',
    steps: ['Choose pick method', 'Set pick location', 'Set place location', 'Configure gripper', 'Review'],
  },
  {
    id: 'sort',
    name: 'Sort Parts',
    description: 'Identify parts by type and sort them into different locations',
    steps: ['Choose parts to sort', 'Set sort locations', 'Configure detection', 'Review'],
  },
  {
    id: 'palletize',
    name: 'Palletize',
    description: 'Pick parts and arrange them in a grid pattern on a pallet',
    steps: ['Set pick location', 'Define pallet grid', 'Set pallet origin', 'Configure pattern', 'Review'],
  },
  {
    id: 'inspect',
    name: 'Pick and Inspect',
    description: 'Pick a part, move it in front of the camera for inspection, then place it',
    steps: ['Set pick location', 'Set inspection pose', 'Set pass location', 'Set fail location', 'Review'],
  },
  {
    id: 'machine_tend',
    name: 'Machine Tending',
    description: 'Load parts into a machine, wait for cycle complete, then unload',
    steps: ['Set pick location', 'Set machine load position', 'Configure I/O signals', 'Set unload position', 'Review'],
  },
  {
    id: 'custom',
    name: 'Custom Program',
    description: 'Build a program step by step with full control',
    steps: ['Add steps manually'],
  },
]

function WizardHeader({ operation, stage, totalStages, onCancel }) {
  return (
    <div style={{
      padding: '14px 24px', borderBottom: '1px solid #e5e7eb',
      display: 'flex', alignItems: 'center', gap: 16, background: '#fff',
    }}>
      <button onClick={onCancel} style={{
        background: 'none', border: 'none', cursor: 'pointer',
        fontSize: 16, color: '#6b7280', padding: '4px 8px',
      }}>X</button>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>
          New Program: {operation?.name || 'Choose Operation'}
        </div>
        <div style={{ fontSize: 11, color: '#6b7280' }}>
          Step {stage + 1} of {totalStages}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {Array.from({ length: totalStages }).map((_, i) => (
          <div key={i} style={{
            width: i === stage ? 28 : 8, height: 8, borderRadius: 4,
            background: i < stage ? '#16A34A' : i === stage ? '#2563EB' : '#d1d5db',
            transition: 'all 200ms',
          }} />
        ))}
      </div>
    </div>
  )
}

function ChooseOperation({ onSelect }) {
  return (
    <div style={{ padding: 32, maxWidth: 700, margin: '0 auto' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 8, textAlign: 'center' }}>
        What kind of operation do you want to program?
      </div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 32, textAlign: 'center' }}>
        Choose an operation type and the wizard will guide you through setup
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {OPERATION_TYPES.map((op) => (
          <button key={op.id} onClick={() => onSelect(op)}
            style={{
              padding: '20px 18px', textAlign: 'left', cursor: 'pointer',
              background: '#fff', border: '2px solid #e5e7eb', borderRadius: 10,
              transition: 'border-color 150ms, box-shadow 150ms',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#2563EB'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(37,99,235,0.15)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.boxShadow = 'none' }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 6 }}>{op.name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>{op.description}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function PickMethodStep({ config, setConfig, onNext }) {
  return (
    <div style={{ padding: 32, maxWidth: 500, margin: '0 auto' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>
        How should the robot find the part to pick?
      </div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
        Choose how the robot identifies what to pick up
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[
          { id: 'camera_auto', label: 'Camera Detection', desc: 'Robot uses the camera to find and pick parts automatically. Best for parts that move around.' },
          { id: 'fixed_point', label: 'Fixed Position',   desc: 'Robot always picks from the same taught position. Best for parts fed by a conveyor or fixture.' },
          { id: 'library_part', label: 'Library Part',    desc: 'Robot looks for a specific part from the parts library. Only picks the correct part type.' },
        ].map((opt) => (
          <button key={opt.id}
            onClick={() => { setConfig((prev) => ({ ...prev, pick_method: opt.id })); onNext() }}
            style={{
              padding: '16px 18px', textAlign: 'left', cursor: 'pointer',
              background: config.pick_method === opt.id ? '#eff6ff' : '#fff',
              border: config.pick_method === opt.id ? '2px solid #2563EB' : '2px solid #e5e7eb',
              borderRadius: 8,
            }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 4 }}>{opt.label}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{opt.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function TeachPositionStep({ title, description, pointName, config, setConfig, onNext }) {
  const [taught, setTaught]     = useState(Boolean(config[pointName]))
  const [position, setPosition] = useState(config[pointName] || null)

  async function teachCurrentPosition() {
    let pos
    try {
      const res  = await fetch('/api/state')
      const data = await res.json()
      // STATE.joints is { names, positions (rad), velocities }; convert
      // to degrees for the wizard's downstream move_joint steps.
      const positions = data?.joints?.positions
      if (Array.isArray(positions) && positions.length >= 6) {
        pos = {
          joints: positions.slice(0, 6).map((rad) => Number((rad * 180 / Math.PI).toFixed(2))),
          tcp:    data?.tcp_pose || [0, 0, 0, 0, 0, 0],
          name:   pointName,
        }
      }
    } catch { /* fall through to defaults */ }
    if (!pos) {
      pos = { joints: [0, -90, 0, -90, 0, 0], tcp: [0.3, 0, 0.4, 0, 180, 0], name: pointName }
    }
    setPosition(pos)
    setConfig((prev) => ({ ...prev, [pointName]: pos }))
    setTaught(true)
  }

  return (
    <div style={{ padding: 32, maxWidth: 500, margin: '0 auto' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>{description}</div>

      <div style={{
        padding: 20, background: '#f8fafc', borderRadius: 8,
        border: '1px solid #e5e7eb', marginBottom: 16,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>Instructions:</div>
        <ol style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
          <li>Use the jog controls to move the robot to the desired position</li>
          <li>Make sure the position is safe and reachable</li>
          <li>Click "Teach This Position" to save it</li>
        </ol>
      </div>

      {position && (
        <div style={{
          padding: 12, background: '#f0fdf4', borderRadius: 8,
          border: '1px solid #bbf7d0', marginBottom: 16,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#16A34A', marginBottom: 6 }}>Position saved</div>
          <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
            Joints: [{position.joints.map((j) => j.toFixed(1)).join(', ')}] deg
          </div>
          <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>
            TCP: [{(position.tcp || []).map((t) => Number(t).toFixed(2)).join(', ')}]
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={teachCurrentPosition} style={primaryBtn}>
          {taught ? 'Re-teach Position' : 'Teach This Position'}
        </button>
        {taught && (
          <button onClick={onNext} style={{
            padding: '12px 24px', fontSize: 14, fontWeight: 600,
            background: '#16A34A', color: '#fff', border: 'none',
            borderRadius: 8, cursor: 'pointer',
          }}>Next</button>
        )}
      </div>

      {!taught && (
        <button onClick={onNext} style={{
          width: '100%', marginTop: 8, padding: '8px', fontSize: 12,
          background: 'transparent', color: '#6b7280', border: '1px solid #d1d5db',
          borderRadius: 6, cursor: 'pointer',
        }}>
          Skip (use auto-detection instead)
        </button>
      )}
    </div>
  )
}

function GripperConfigStep({ config, setConfig, onNext }) {
  return (
    <div style={{ padding: 32, maxWidth: 500, margin: '0 auto' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>Configure the gripper</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>Set how the robot grips and releases parts</div>

      <div style={{ marginBottom: 16 }}>
        <div style={labelStyle}>Gripper Type</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['finger', 'vacuum'].map((type) => (
            <button key={type} onClick={() => setConfig((prev) => ({ ...prev, gripper_type: type }))}
              style={{
                flex: 1, padding: '12px', fontSize: 13, fontWeight: 600,
                background: config.gripper_type === type ? '#eff6ff' : '#fff',
                color:      config.gripper_type === type ? '#2563EB' : '#374151',
                border:     config.gripper_type === type ? '2px solid #2563EB' : '2px solid #e5e7eb',
                borderRadius: 8, cursor: 'pointer',
              }}>
              {type === 'finger' ? 'Finger Gripper' : 'Vacuum Gripper'}
            </button>
          ))}
        </div>
      </div>

      {config.gripper_type === 'finger' && (
        <>
          <Slider label={'Gripper Opening: ' + (config.gripper_width || 85) + ' mm'}
            min={10} max={150} value={config.gripper_width || 85}
            onChange={(v) => setConfig((prev) => ({ ...prev, gripper_width: v }))} />
          <Slider label={'Grip Force: ' + (config.grip_force || 50) + '%'}
            min={10} max={100} value={config.grip_force || 50}
            onChange={(v) => setConfig((prev) => ({ ...prev, grip_force: v }))} />
        </>
      )}
      {config.gripper_type === 'vacuum' && (
        <Slider label={'Vacuum Threshold: ' + (config.vacuum_threshold || 70) + '%'}
          min={30} max={95} value={config.vacuum_threshold || 70}
          onChange={(v) => setConfig((prev) => ({ ...prev, vacuum_threshold: v }))} />
      )}

      <Slider label={'Robot Speed: ' + (config.speed_pct || 50) + '%'}
        min={5} max={100} value={config.speed_pct || 50}
        onChange={(v) => setConfig((prev) => ({ ...prev, speed_pct: v }))}
        bookendsLeft="Slow (safe)" bookendsRight="Fast" />

      <Slider label={'Approach Height: ' + (config.approach_height || 150) + ' mm above part'}
        min={20} max={300} step={10} value={config.approach_height || 150}
        onChange={(v) => setConfig((prev) => ({ ...prev, approach_height: v }))} />

      <button onClick={onNext} style={primaryBtn}>Next</button>
    </div>
  )
}

function Slider({ label, min, max, step, value, onChange, bookendsLeft, bookendsRight }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={labelStyle}>{label}</div>
      <input type="range" min={min} max={max} step={step || 1} value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        style={{ width: '100%' }} />
      {(bookendsLeft || bookendsRight) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af' }}>
          <span>{bookendsLeft}</span><span>{bookendsRight}</span>
        </div>
      )}
    </div>
  )
}

function SelectPartsStep({ config, setConfig, onNext }) {
  const [parts, setParts] = useState([])
  useEffect(() => {
    fetch('/api/parts').then((r) => r.json()).then((d) => setParts(d.parts || [])).catch(() => {})
  }, [])

  function togglePart(partId) {
    setConfig((prev) => {
      const selected = prev.selected_parts || []
      if (selected.includes(partId)) return { ...prev, selected_parts: selected.filter((id) => id !== partId) }
      return { ...prev, selected_parts: [...selected, partId] }
    })
  }

  const count = (config.selected_parts || []).length

  return (
    <div style={{ padding: 32, maxWidth: 500, margin: '0 auto' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>Which parts will be sorted?</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
        Select the parts from your library that this program will handle
      </div>

      {parts.length === 0 ? (
        <div style={{
          padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13,
          border: '2px dashed #d1d5db', borderRadius: 8,
        }}>
          No parts in library. Upload STEP files in Adaptive Picking first.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {parts.map((part) => {
            const selected = (config.selected_parts || []).includes(part.id)
            return (
              <button key={part.id} onClick={() => togglePart(part.id)}
                style={{
                  padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10,
                  textAlign: 'left', cursor: 'pointer',
                  background: selected ? '#eff6ff' : '#fff',
                  border: selected ? '2px solid #2563EB' : '2px solid #e5e7eb',
                  borderRadius: 8,
                }}>
                <div style={{
                  width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                  border: selected ? '2px solid #2563EB' : '2px solid #d1d5db',
                  background: selected ? '#2563EB' : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 12, fontWeight: 700,
                }}>{selected ? 'v' : ''}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{part.name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    {(part.extents_cm || []).map((e) => Number(e).toFixed(1)).join(' x ')} cm
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      <button onClick={onNext} disabled={count === 0}
        style={{
          width: '100%', marginTop: 16, padding: '12px', fontSize: 14, fontWeight: 600,
          background: count > 0 ? '#2563EB' : '#d1d5db',
          color: '#fff', border: 'none', borderRadius: 8,
          cursor: count > 0 ? 'pointer' : 'default',
        }}>
        Next ({count} selected)
      </button>
    </div>
  )
}

function IOConfigStep({ config, setConfig, onNext }) {
  return (
    <div style={{ padding: 32, maxWidth: 500, margin: '0 auto' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>Configure I/O Signals</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
        Set which signals to use for machine communication
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={labelStyle}>Machine Cycle Start (output to machine)</div>
        <select value={config.io_cycle_start || 'DO4'}
          onChange={(e) => setConfig((prev) => ({ ...prev, io_cycle_start: e.target.value }))}
          style={selectStyle}>
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i} value={'DO' + i}>DO{i} (Y{Math.floor(i / 8)}.{i % 8})</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={labelStyle}>Machine Cycle Complete (input from machine)</div>
        <select value={config.io_cycle_done || 'DI3'}
          onChange={(e) => setConfig((prev) => ({ ...prev, io_cycle_done: e.target.value }))}
          style={selectStyle}>
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i} value={'DI' + i}>DI{i} (X{Math.floor(i / 8)}.{i % 8})</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={labelStyle}>Wait timeout (seconds)</div>
        <input type="number" value={config.cycle_timeout || 30} min={5} max={600}
          onChange={(e) => setConfig((prev) => ({ ...prev, cycle_timeout: parseInt(e.target.value, 10) }))}
          style={selectStyle} />
      </div>

      <button onClick={onNext} style={primaryBtn}>Next</button>
    </div>
  )
}

function ReviewStep({ operation, config, onSave, programName, setProgramName, saving }) {
  const builtSteps = buildProgramSteps(operation, config)
  const canSave = !!programName.trim() && !saving

  return (
    <div style={{ padding: 32, maxWidth: 600, margin: '0 auto' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 8 }}>Review Your Program</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
        Check the steps below and give your program a name
      </div>

      <div style={{ marginBottom: 20 }}>
        <div style={labelStyle}>Program Name</div>
        <input value={programName} onChange={(e) => setProgramName(e.target.value)}
          placeholder="e.g. Pick bolts from bin A"
          style={{
            width: '100%', padding: '10px 12px', fontSize: 14,
            border: '2px solid #2563EB', borderRadius: 6, outline: 'none',
          }} />
      </div>

      <div style={{
        background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb',
        padding: 12, marginBottom: 20,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
          Program Steps ({builtSteps.length})
        </div>
        {builtSteps.map((step, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 8px', borderBottom: i < builtSteps.length - 1 ? '1px solid #e5e7eb' : 'none',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%',
              background: '#e5e7eb', color: '#374151',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10, fontWeight: 700, flexShrink: 0,
            }}>{i + 1}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{step.label}</div>
              <div style={{ fontSize: 10, color: '#6b7280' }}>{step.action}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{
        padding: 12, background: '#f8fafc', borderRadius: 8,
        border: '1px solid #e5e7eb', marginBottom: 20, fontSize: 12, color: '#6b7280',
      }}>
        <div style={{ fontWeight: 600, color: '#374151', marginBottom: 6 }}>Settings</div>
        {config.gripper_type    && <div>Gripper: {config.gripper_type}</div>}
        {config.speed_pct       && <div>Speed: {config.speed_pct}%</div>}
        {config.approach_height && <div>Approach height: {config.approach_height} mm</div>}
        {config.pick_method     && <div>Pick method: {config.pick_method}</div>}
      </div>

      <button onClick={() => onSave(builtSteps)} disabled={!canSave}
        style={{
          width: '100%', padding: '14px', fontSize: 15, fontWeight: 700,
          background: canSave ? '#16A34A' : '#d1d5db',
          color: '#fff', border: 'none', borderRadius: 8,
          cursor: canSave ? 'pointer' : 'default',
        }}>
        {saving ? 'Saving…' : 'Save Program'}
      </button>
    </div>
  )
}

function buildProgramSteps(operation, config) {
  const steps     = []
  const spd       = config.speed_pct || 50
  const appHeight = config.approach_height || 150
  const gripWidth = config.gripper_width   || 85
  const gripForce = config.grip_force      || 50
  // Speed caps for the safety moves — descents and the first lift are
  // intentionally slower than the cruise speed so a misjudged pick
  // doesn't crash the gripper or fling the part.
  const slow   = Math.min(spd, 30)
  const medium = Math.min(spd, 40)
  // Placeholder TCP for explicit place moves. The operator edits the
  // real coordinates in the editor after the wizard runs.
  const tcpAbove = [0.3, -0.2, 0.4 + appHeight / 1000]

  if (operation.id === 'pick_and_place') {
    steps.push({ action: 'move_home',    label: 'Move to home position' })
    steps.push({ action: 'open_gripper', label: 'Open gripper', width_mm: gripWidth, speed_pct: spd })

    if (config.pick_method === 'camera_auto') {
      steps.push({ action: 'detect', label: 'Detect objects', mode: 'all' })
    } else if (config.pick_method === 'library_part') {
      steps.push({ action: 'detect', label: 'Find library part', mode: 'library' })
    }

    steps.push({ action: 'approach',      label: 'Move above pick position', target: config.pick_method === 'fixed_point' ? 'fixed' : 'auto', offset_z_mm: appHeight })
    steps.push({ action: 'move_linear',   label: 'Descend to pick',    offset_z_mm: 0,         speed_pct: slow   })
    steps.push({ action: 'close_gripper', label: 'Close gripper on part', force_pct: gripForce })
    steps.push({ action: 'move_linear',   label: 'Lift from pick',     offset_z_mm: appHeight, speed_pct: medium })

    if (config.place_point) {
      steps.push({ action: 'move_joint',  label: 'Move above place position', joints: config.place_point.joints })
    } else {
      steps.push({ action: 'move_linear', label: 'Move above place position', position: tcpAbove, speed_pct: spd })
    }
    steps.push({ action: 'move_linear',   label: 'Descend to place',   offset_z_mm: 0,         speed_pct: slow   })
    steps.push({ action: 'open_gripper',  label: 'Release part',       width_mm: gripWidth })
    steps.push({ action: 'move_linear',   label: 'Lift from place',    offset_z_mm: appHeight, speed_pct: medium })
    steps.push({ action: 'move_home',     label: 'Return home' })
  }
  else if (operation.id === 'sort') {
    steps.push({ action: 'move_home',     label: 'Move to home position' })
    steps.push({ action: 'detect',        label: 'Scan for library parts', mode: 'library' })
    steps.push({ action: 'open_gripper',  label: 'Open gripper', width_mm: gripWidth })
    steps.push({ action: 'approach',      label: 'Move above identified part', target: 'auto', offset_z_mm: appHeight })
    steps.push({ action: 'move_linear',   label: 'Descend to pick',     offset_z_mm: 0,         speed_pct: slow   })
    steps.push({ action: 'close_gripper', label: 'Grasp part',          force_pct: gripForce })
    steps.push({ action: 'move_linear',   label: 'Lift from pick',      offset_z_mm: appHeight, speed_pct: medium })
    steps.push({ action: 'move_linear',   label: 'Move above sort bin', position: tcpAbove,     speed_pct: spd    })
    steps.push({ action: 'move_linear',   label: 'Descend into bin',    offset_z_mm: 0,         speed_pct: slow   })
    steps.push({ action: 'open_gripper',  label: 'Release part',        width_mm: gripWidth })
    steps.push({ action: 'move_linear',   label: 'Lift from bin',       offset_z_mm: appHeight, speed_pct: medium })
    steps.push({ action: 'loop',          label: 'Repeat until no parts remain', goto: 2, count: 0 })
  }
  else if (operation.id === 'machine_tend') {
    steps.push({ action: 'move_home',     label: 'Move to home position' })
    steps.push({ action: 'open_gripper',  label: 'Open gripper', width_mm: gripWidth })
    steps.push({ action: 'approach',      label: 'Move above raw part', target: 'auto', offset_z_mm: appHeight })
    steps.push({ action: 'move_linear',   label: 'Descend to pick raw part', offset_z_mm: 0, speed_pct: slow })
    steps.push({ action: 'close_gripper', label: 'Grasp raw part', force_pct: gripForce })
    steps.push({ action: 'move_linear',   label: 'Lift raw part',  offset_z_mm: appHeight, speed_pct: medium })
    if (config.machine_load_point) {
      steps.push({ action: 'move_joint',  label: 'Move to machine load position', joints: config.machine_load_point.joints })
    }
    steps.push({ action: 'move_linear',   label: 'Descend to load position', offset_z_mm: 0,         speed_pct: 20 })
    steps.push({ action: 'open_gripper',  label: 'Release into machine',     width_mm: gripWidth })
    steps.push({ action: 'move_linear',   label: 'Retreat from machine',     offset_z_mm: appHeight, speed_pct: slow })
    steps.push({ action: 'set_io',        label: 'Start machine cycle',      io_id: config.io_cycle_start || 'DO4', value: 1 })
    steps.push({ action: 'wait',          label: 'Wait for cycle complete signal', duration_s: config.cycle_timeout || 30 })
    steps.push({ action: 'set_io',        label: 'Clear cycle start',        io_id: config.io_cycle_start || 'DO4', value: 0 })
    steps.push({ action: 'move_linear',   label: 'Approach finished part',   offset_z_mm: appHeight, speed_pct: slow })
    steps.push({ action: 'move_linear',   label: 'Descend to finished part', offset_z_mm: 0,         speed_pct: 20 })
    steps.push({ action: 'close_gripper', label: 'Grasp finished part',      force_pct: gripForce })
    steps.push({ action: 'move_linear',   label: 'Lift finished part',       offset_z_mm: appHeight, speed_pct: slow })
    if (config.unload_point) {
      steps.push({ action: 'move_joint',  label: 'Move to unload position', joints: config.unload_point.joints })
    }
    steps.push({ action: 'move_linear',   label: 'Descend to unload',       offset_z_mm: 0,         speed_pct: slow })
    steps.push({ action: 'open_gripper',  label: 'Release finished part',   width_mm: gripWidth })
    steps.push({ action: 'move_linear',   label: 'Lift from unload',        offset_z_mm: appHeight, speed_pct: slow })
    steps.push({ action: 'move_home',     label: 'Return home' })
    steps.push({ action: 'loop',          label: 'Repeat cycle', goto: 1, count: 0 })
  }
  else if (operation.id === 'palletize') {
    // Pallet origin: prefer the taught TCP, otherwise use the same
    // placeholder as the editor — the operator can override later.
    const palletTcp = config.pallet_origin?.tcp || [0.3, -0.2, 0.4]
    const palletAbove = [palletTcp[0], palletTcp[1], palletTcp[2] + appHeight / 1000]

    steps.push({ action: 'move_home',     label: 'Move to home position' })
    steps.push({ action: 'detect',        label: 'Find part to palletize', mode: 'all' })
    steps.push({ action: 'open_gripper',  label: 'Open gripper', width_mm: gripWidth })
    steps.push({ action: 'approach',      label: 'Move above part', target: 'auto', offset_z_mm: appHeight })
    steps.push({ action: 'move_linear',   label: 'Descend to pick', offset_z_mm: 0,         speed_pct: slow   })
    steps.push({ action: 'close_gripper', label: 'Grasp part',      force_pct: gripForce })
    steps.push({ action: 'move_linear',   label: 'Lift from pick',  offset_z_mm: appHeight, speed_pct: medium })
    steps.push({ action: 'move_linear',   label: 'Move above pallet slot (auto-increment)', position: palletAbove, speed_pct: spd })
    steps.push({ action: 'move_linear',   label: 'Descend onto pallet', offset_z_mm: 0,     speed_pct: slow   })
    steps.push({ action: 'open_gripper',  label: 'Release part',    width_mm: gripWidth })
    steps.push({ action: 'move_linear',   label: 'Lift from pallet', offset_z_mm: appHeight, speed_pct: medium })
    steps.push({ action: 'loop',          label: 'Repeat until pallet full', goto: 2, count: config.pallet_count || 12 })
    steps.push({ action: 'move_home',     label: 'Return home — pallet complete' })
  }
  else if (operation.id === 'inspect') {
    const passTcp = config.pass_point?.tcp || [0.3, -0.2, 0.4]
    const passAbove = [passTcp[0], passTcp[1], passTcp[2] + appHeight / 1000]

    steps.push({ action: 'move_home',     label: 'Move to home position' })
    steps.push({ action: 'open_gripper',  label: 'Open gripper', width_mm: gripWidth })
    steps.push({ action: 'approach',      label: 'Move above part', target: 'auto', offset_z_mm: appHeight })
    steps.push({ action: 'move_linear',   label: 'Descend to pick',   offset_z_mm: 0,         speed_pct: slow   })
    steps.push({ action: 'close_gripper', label: 'Grasp part',        force_pct: gripForce })
    steps.push({ action: 'move_linear',   label: 'Lift from pick',    offset_z_mm: appHeight, speed_pct: medium })
    steps.push({ action: 'move_joint',    label: 'Move to inspection pose', joints: config.inspect_point?.joints || [0, -45, 90, -45, -90, 0] })
    steps.push({ action: 'detect',        label: 'Inspect part with camera', mode: 'library' })
    steps.push({ action: 'move_linear',   label: 'Move above pass bin', position: passAbove, speed_pct: spd })
    steps.push({ action: 'move_linear',   label: 'Descend to pass bin', offset_z_mm: 0,         speed_pct: slow   })
    steps.push({ action: 'open_gripper',  label: 'Release part',        width_mm: gripWidth })
    steps.push({ action: 'move_linear',   label: 'Lift from pass bin',  offset_z_mm: appHeight, speed_pct: medium })
    steps.push({ action: 'move_home',     label: 'Return home' })
    steps.push({ action: 'loop',          label: 'Repeat', goto: 2, count: 0 })
  }

  // Inject default I/O port assignments for gripper steps. Matches the
  // factory defaults baked into the IOPanel: DO0 / DI0 control + verify
  // close, DO1 / DI1 control + verify open. Operator can rewire these
  // in the step editor without touching the wizard.
  return steps.map((s, i) => {
    const out = { ...s, step: i + 1 }
    if (s.action === 'open_gripper') {
      if (out.io_open === undefined)         out.io_open         = 'DO1'
      if (out.io_open_confirm === undefined) out.io_open_confirm = 'DI1'
    } else if (s.action === 'close_gripper') {
      if (out.io_close === undefined)         out.io_close         = 'DO0'
      if (out.io_close_confirm === undefined) out.io_close_confirm = 'DI0'
    }
    return out
  })
}

const labelStyle  = { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }
const selectStyle = { width: '100%', padding: '8px', fontSize: 12, borderRadius: 4, border: '1px solid #d1d5db' }
const primaryBtn  = {
  flex: 1, width: '100%',
  padding: '12px 16px', fontSize: 14, fontWeight: 600,
  background: '#2563EB', color: '#fff', border: 'none',
  borderRadius: 8, cursor: 'pointer',
}

export default function ProgramWizard({ onClose, onSaved }) {
  const [operation, setOperation] = useState(null)
  const [stage, setStage]         = useState(0)
  const [config, setConfig]       = useState({ gripper_type: 'finger', gripper_width: 85, speed_pct: 50, approach_height: 150 })
  const [programName, setProgramName] = useState('')
  const [saving, setSaving]       = useState(false)

  const totalStages = operation ? operation.steps.length + 2 : 1

  async function handleSave(builtSteps) {
    setSaving(true)
    try {
      const res = await fetch('/api/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:        programName,
          description: operation.description,
          steps:       builtSteps,
          tags:        [operation.id],
          config:      config,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        onSaved?.(data.program)
        onClose()
      }
    } catch { /* leave the modal open so the user can retry */ }
    setSaving(false)
  }

  function renderStage() {
    if (!operation) {
      return <ChooseOperation onSelect={(op) => { setOperation(op); setStage(1); setProgramName(op.name) }} />
    }

    const next = () => setStage((s) => s + 1)
    const review = () => (
      <ReviewStep operation={operation} config={config} onSave={handleSave}
        programName={programName} setProgramName={setProgramName} saving={saving} />
    )

    const stageMap = {
      pick_and_place: [
        () => <PickMethodStep config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Pick Location" description="Move the robot to where it will pick parts from"
                pointName="pick_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Place Location" description="Move the robot to where it will place parts"
                pointName="place_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <GripperConfigStep config={config} setConfig={setConfig} onNext={next} />,
        review,
      ],
      sort: [
        () => <SelectPartsStep config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Sort Location 1" description="Where should the first part type go?"
                pointName="sort_location_1" config={config} setConfig={setConfig} onNext={next} />,
        () => <GripperConfigStep config={config} setConfig={setConfig} onNext={next} />,
        review,
      ],
      machine_tend: [
        () => <TeachPositionStep title="Set Pick Location" description="Where does the robot pick raw parts from?"
                pointName="pick_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Machine Load Position" description="Where does the robot load the part into the machine?"
                pointName="machine_load_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <IOConfigStep config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Unload Position" description="Where does the robot place the finished part?"
                pointName="unload_point" config={config} setConfig={setConfig} onNext={next} />,
        review,
      ],
      palletize: [
        () => <TeachPositionStep title="Set Pick Location" description="Where does the robot pick parts from?"
                pointName="pick_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Pallet Origin" description="Where is the first position on the pallet?"
                pointName="pallet_origin" config={config} setConfig={setConfig} onNext={next} />,
        () => <GripperConfigStep config={config} setConfig={setConfig} onNext={next} />,
        review,
      ],
      inspect: [
        () => <TeachPositionStep title="Set Pick Location" description="Where does the robot pick parts from?"
                pointName="pick_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Inspection Pose" description="Where does the robot hold the part for camera inspection?"
                pointName="inspect_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Pass Location" description="Where do good parts go?"
                pointName="pass_point" config={config} setConfig={setConfig} onNext={next} />,
        () => <TeachPositionStep title="Set Fail Location" description="Where do rejected parts go?"
                pointName="fail_point" config={config} setConfig={setConfig} onNext={next} />,
        review,
      ],
      custom: [review],
    }

    const stages   = stageMap[operation.id] || stageMap.custom
    const stageIdx = Math.min(Math.max(stage - 1, 0), stages.length - 1)
    return stages[stageIdx]()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.3)', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '90%', maxWidth: 750, maxHeight: '90vh',
        background: '#fff', borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        display: 'flex', flexDirection: 'column',
      }}>
        <WizardHeader operation={operation} stage={stage} totalStages={totalStages} onCancel={onClose} />
        <div style={{ flex: 1, overflowY: 'auto' }}>{renderStage()}</div>
        {stage > 0 && (
          <div style={{ padding: '10px 24px', borderTop: '1px solid #e5e7eb', display: 'flex' }}>
            <button onClick={() => {
              if (stage === 1) { setOperation(null); setStage(0) }
              else setStage((s) => Math.max(0, s - 1))
            }} style={{
              padding: '8px 16px', fontSize: 12, background: '#f3f4f6', color: '#374151',
              border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer',
            }}>Back</button>
          </div>
        )}
      </div>
    </div>
  )
}
