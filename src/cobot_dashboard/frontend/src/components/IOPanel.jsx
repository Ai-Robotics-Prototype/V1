import { useState, useEffect, useRef } from 'react'

const DEFAULT_IO = {
  digital_inputs: [
    { id: 'DI0', label: 'Gripper Closed Sensor', pin: 'X0.0' },
    { id: 'DI1', label: 'Gripper Open Sensor', pin: 'X0.1' },
    { id: 'DI2', label: 'Part Present Sensor', pin: 'X0.2' },
    { id: 'DI3', label: 'Conveyor Running', pin: 'X0.3' },
    { id: 'DI4', label: 'Safety Gate Closed', pin: 'X0.4' },
    { id: 'DI5', label: 'Light Curtain Clear', pin: 'X0.5' },
    { id: 'DI6', label: 'Air Pressure OK', pin: 'X0.6' },
    { id: 'DI7', label: 'Cycle Start Button', pin: 'X0.7' },
    { id: 'DI8', label: 'Emergency Stop Chain', pin: 'X1.0' },
    { id: 'DI9', label: 'Fixture Clamped', pin: 'X1.1' },
    { id: 'DI10', label: 'Spare Input 10', pin: 'X1.2' },
    { id: 'DI11', label: 'Spare Input 11', pin: 'X1.3' },
    { id: 'DI12', label: 'Spare Input 12', pin: 'X1.4' },
    { id: 'DI13', label: 'Spare Input 13', pin: 'X1.5' },
    { id: 'DI14', label: 'Spare Input 14', pin: 'X1.6' },
    { id: 'DI15', label: 'Spare Input 15', pin: 'X1.7' },
  ],
  digital_outputs: [
    { id: 'DO0', label: 'Gripper Close', pin: 'Y0.0' },
    { id: 'DO1', label: 'Gripper Open', pin: 'Y0.1' },
    { id: 'DO2', label: 'Vacuum On', pin: 'Y0.2' },
    { id: 'DO3', label: 'Vacuum Blow Off', pin: 'Y0.3' },
    { id: 'DO4', label: 'Conveyor Forward', pin: 'Y0.4' },
    { id: 'DO5', label: 'Conveyor Reverse', pin: 'Y0.5' },
    { id: 'DO6', label: 'Signal Light Green', pin: 'Y0.6' },
    { id: 'DO7', label: 'Signal Light Red', pin: 'Y0.7' },
    { id: 'DO8', label: 'Fixture Clamp', pin: 'Y1.0' },
    { id: 'DO9', label: 'Fixture Unclamp', pin: 'Y1.1' },
    { id: 'DO10', label: 'Spare Output 10', pin: 'Y1.2' },
    { id: 'DO11', label: 'Spare Output 11', pin: 'Y1.3' },
    { id: 'DO12', label: 'Spare Output 12', pin: 'Y1.4' },
    { id: 'DO13', label: 'Spare Output 13', pin: 'Y1.5' },
    { id: 'DO14', label: 'Spare Output 14', pin: 'Y1.6' },
    { id: 'DO15', label: 'Spare Output 15', pin: 'Y1.7' },
  ],
  analog_inputs: [
    { id: 'AI0', label: 'Force Sensor', pin: 'A0', unit: 'N', min: 0, max: 100 },
    { id: 'AI1', label: 'Pressure Sensor', pin: 'A1', unit: 'bar', min: 0, max: 10 },
    { id: 'AI2', label: 'Temperature', pin: 'A2', unit: '°C', min: 0, max: 80 },
    { id: 'AI3', label: 'Spare Analog 3', pin: 'A3', unit: 'V', min: 0, max: 10 },
  ],
  analog_outputs: [
    { id: 'AO0', label: 'Gripper Force', pin: 'DA0', unit: '%', min: 0, max: 100 },
    { id: 'AO1', label: 'Conveyor Speed', pin: 'DA1', unit: '%', min: 0, max: 100 },
  ],
}

function EditableLabel({ value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.select() } }, [editing])

  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim())
    else setDraft(value)
  }

  if (editing) {
    return (
      <input ref={ref} value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false) } }}
        style={{
          flex: 1, minWidth: 0, padding: '1px 4px', fontSize: 12,
          background: '#fff', color: '#111', border: '1px solid #2563EB',
          borderRadius: 3, outline: 'none',
        }}
      />
    )
  }

  return (
    <span onClick={() => setEditing(true)} title="Click to rename"
      style={{
        flex: 1, minWidth: 0, fontSize: 12, color: '#1a1a1a',
        cursor: 'text', padding: '1px 4px', borderRadius: 3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = '#f0f0f0' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {value}
    </span>
  )
}

function DigitalRow({ signal, active, isOutput, onToggle, onRename }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px', marginBottom: 2, borderRadius: 4,
      background: active ? 'rgba(22,163,74,0.06)' : '#fafafa',
      border: active ? '1px solid rgba(22,163,74,0.25)' : '1px solid #e5e7eb',
    }}>
      <div style={{
        width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
        background: active ? '#16A34A' : '#9ca3af',
        boxShadow: active ? '0 0 5px rgba(22,163,74,0.4)' : 'none',
      }} />
      <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#6b7280', minWidth: 30, flexShrink: 0 }}>
        {signal.pin}
      </span>
      <EditableLabel value={signal.label} onSave={newLabel => onRename(signal.id, newLabel)} />
      <span style={{
        fontSize: 10, fontWeight: 700, minWidth: 24, textAlign: 'right', flexShrink: 0,
        color: active ? '#16A34A' : '#9ca3af',
      }}>
        {active ? 'ON' : 'OFF'}
      </span>
      {isOutput && (
        <button onClick={() => onToggle(signal.id, !active)}
          style={{
            width: 34, height: 18, borderRadius: 9, border: 'none', padding: 0,
            background: active ? '#16A34A' : '#d1d5db', cursor: 'pointer',
            position: 'relative', flexShrink: 0, transition: 'background 150ms',
          }}>
          <div style={{
            width: 14, height: 14, borderRadius: '50%', background: '#fff',
            position: 'absolute', top: 2, left: active ? 18 : 2,
            transition: 'left 150ms', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          }} />
        </button>
      )}
    </div>
  )
}

function AnalogRow({ signal, value, isOutput, onChange, onRename }) {
  const pct = ((value - signal.min) / (signal.max - signal.min)) * 100
  return (
    <div style={{
      padding: '6px 10px', marginBottom: 2, borderRadius: 4,
      background: '#fafafa', border: '1px solid #e5e7eb',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#6b7280', minWidth: 30, flexShrink: 0 }}>
          {signal.pin}
        </span>
        <EditableLabel value={signal.label} onSave={newLabel => onRename(signal.id, newLabel)} />
        <span style={{
          fontSize: 12, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
          color: '#2563EB', minWidth: 55, textAlign: 'right', flexShrink: 0,
        }}>
          {value.toFixed(1)} {signal.unit}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: '#e5e7eb', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 3,
          width: Math.min(100, Math.max(0, pct)) + '%',
          background: pct > 80 ? '#DC2626' : pct > 50 ? '#CA8A04' : '#2563EB',
          transition: 'width 200ms',
        }} />
      </div>
      {isOutput && (
        <input type="range" min={signal.min} max={signal.max} step={0.1} value={value}
          onChange={e => onChange(signal.id, parseFloat(e.target.value))}
          style={{ width: '100%', marginTop: 3 }}
        />
      )}
    </div>
  )
}

function SectionHeader({ color, label }) {
  return (
    <div style={{
      fontSize: 12, fontWeight: 600, color: '#374151',
      padding: '5px 10px', background: '#f3f4f6',
      borderRadius: 4, marginBottom: 4,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span style={{ color }}>{'●'}</span> {label}
    </div>
  )
}

export default function IOPanel() {
  const [ioState, setIoState] = useState({})
  const [config, setConfig] = useState(JSON.parse(JSON.stringify(DEFAULT_IO)))

  useEffect(() => {
    fetch('/api/io/config').then(r => r.json()).then(data => {
      if (data && data.labels) {
        setConfig(prev => {
          const next = JSON.parse(JSON.stringify(prev))
          for (const sec of ['digital_inputs','digital_outputs','analog_inputs','analog_outputs']) {
            next[sec] = next[sec].map(s => ({ ...s, label: data.labels[s.id] || s.label }))
          }
          return next
        })
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const poll = () => fetch('/api/io/state').then(r => r.json()).then(d => { if (d.io) setIoState(d.io) }).catch(() => {})
    poll()
    const iv = setInterval(poll, 300)
    return () => clearInterval(iv)
  }, [])

  const rename = (id, newLabel) => {
    setConfig(prev => {
      const next = JSON.parse(JSON.stringify(prev))
      for (const sec of ['digital_inputs','digital_outputs','analog_inputs','analog_outputs']) {
        next[sec] = next[sec].map(s => s.id === id ? { ...s, label: newLabel } : s)
      }
      const labels = {}
      for (const sec of ['digital_inputs','digital_outputs','analog_inputs','analog_outputs']) {
        for (const s of next[sec]) labels[s.id] = s.label
      }
      fetch('/api/io/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels }),
      }).catch(() => {})
      return next
    })
  }

  const toggleDO = (id, val) => {
    setIoState(prev => ({ ...prev, [id]: val ? 1 : 0 }))
    fetch('/api/io/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, value: val ? 1 : 0 }),
    }).catch(() => {})
  }

  const setAO = (id, val) => {
    setIoState(prev => ({ ...prev, [id]: val }))
    fetch('/api/io/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, value: val }),
    }).catch(() => {})
  }

  const resetLabels = () => {
    if (!confirm('Reset all I/O labels to defaults?')) return
    setConfig(JSON.parse(JSON.stringify(DEFAULT_IO)))
    fetch('/api/io/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: {} }),
    }).catch(() => {})
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#111', flex: 1 }}>I/O Configuration</span>
        <span style={{ fontSize: 11, color: '#6b7280', marginRight: 10 }}>Estun S10-140</span>
        <button onClick={resetLabels} style={{
          padding: '3px 10px', fontSize: 10, background: '#f3f4f6', color: '#6b7280',
          border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer',
        }}>Reset Labels</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <SectionHeader color="#3B82F6" label="Digital Inputs (16)" />
          {config.digital_inputs.map(s => (
            <DigitalRow key={s.id} signal={s} active={!!ioState[s.id]} isOutput={false} onToggle={() => {}} onRename={rename} />
          ))}
        </div>
        <div>
          <SectionHeader color="#16A34A" label="Digital Outputs (16)" />
          {config.digital_outputs.map(s => (
            <DigitalRow key={s.id} signal={s} active={!!ioState[s.id]} isOutput={true} onToggle={toggleDO} onRename={rename} />
          ))}
        </div>
        <div>
          <SectionHeader color="#CA8A04" label="Analog Inputs (4)" />
          {config.analog_inputs.map(s => (
            <AnalogRow key={s.id} signal={s} value={ioState[s.id] || 0} isOutput={false} onChange={() => {}} onRename={rename} />
          ))}
        </div>
        <div>
          <SectionHeader color="#9333EA" label="Analog Outputs (2)" />
          {config.analog_outputs.map(s => (
            <AnalogRow key={s.id} signal={s} value={ioState[s.id] || 0} isOutput={true} onChange={setAO} onRename={rename} />
          ))}
        </div>
      </div>
    </div>
  )
}
