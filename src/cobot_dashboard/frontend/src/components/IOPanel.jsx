import { useState, useEffect, useRef } from 'react'

const IO_CONFIG = {
  digital_inputs: [
    { id: 'DI0',  label: 'Gripper Closed Sensor', pin: 'X0.0' },
    { id: 'DI1',  label: 'Gripper Open Sensor',   pin: 'X0.1' },
    { id: 'DI2',  label: 'Part Present Sensor',   pin: 'X0.2' },
    { id: 'DI3',  label: 'Conveyor Running',      pin: 'X0.3' },
    { id: 'DI4',  label: 'Safety Gate Closed',    pin: 'X0.4' },
    { id: 'DI5',  label: 'Light Curtain Clear',   pin: 'X0.5' },
    { id: 'DI6',  label: 'Air Pressure OK',       pin: 'X0.6' },
    { id: 'DI7',  label: 'Cycle Start Button',    pin: 'X0.7' },
    { id: 'DI8',  label: 'Emergency Stop Chain',  pin: 'X1.0' },
    { id: 'DI9',  label: 'Fixture Clamped',       pin: 'X1.1' },
    { id: 'DI10', label: 'Spare Input 10',        pin: 'X1.2' },
    { id: 'DI11', label: 'Spare Input 11',        pin: 'X1.3' },
    { id: 'DI12', label: 'Spare Input 12',        pin: 'X1.4' },
    { id: 'DI13', label: 'Spare Input 13',        pin: 'X1.5' },
    { id: 'DI14', label: 'Spare Input 14',        pin: 'X1.6' },
    { id: 'DI15', label: 'Spare Input 15',        pin: 'X1.7' },
  ],
  digital_outputs: [
    { id: 'DO0',  label: 'Gripper Close',     pin: 'Y0.0' },
    { id: 'DO1',  label: 'Gripper Open',      pin: 'Y0.1' },
    { id: 'DO2',  label: 'Vacuum On',         pin: 'Y0.2' },
    { id: 'DO3',  label: 'Vacuum Blow Off',   pin: 'Y0.3' },
    { id: 'DO4',  label: 'Conveyor Forward',  pin: 'Y0.4' },
    { id: 'DO5',  label: 'Conveyor Reverse',  pin: 'Y0.5' },
    { id: 'DO6',  label: 'Signal Light Green',pin: 'Y0.6' },
    { id: 'DO7',  label: 'Signal Light Red',  pin: 'Y0.7' },
    { id: 'DO8',  label: 'Fixture Clamp',     pin: 'Y1.0' },
    { id: 'DO9',  label: 'Fixture Unclamp',   pin: 'Y1.1' },
    { id: 'DO10', label: 'Spare Output 10',   pin: 'Y1.2' },
    { id: 'DO11', label: 'Spare Output 11',   pin: 'Y1.3' },
    { id: 'DO12', label: 'Spare Output 12',   pin: 'Y1.4' },
    { id: 'DO13', label: 'Spare Output 13',   pin: 'Y1.5' },
    { id: 'DO14', label: 'Spare Output 14',   pin: 'Y1.6' },
    { id: 'DO15', label: 'Spare Output 15',   pin: 'Y1.7' },
  ],
  analog_inputs: [
    { id: 'AI0', label: 'Force Sensor',    pin: 'A0', unit: 'N',   min: 0, max: 100 },
    { id: 'AI1', label: 'Pressure Sensor', pin: 'A1', unit: 'bar', min: 0, max: 10  },
    { id: 'AI2', label: 'Temperature',     pin: 'A2', unit: '°C',  min: 0, max: 80  },
    { id: 'AI3', label: 'Spare Analog 3',  pin: 'A3', unit: 'V',   min: 0, max: 10  },
  ],
  analog_outputs: [
    { id: 'AO0', label: 'Gripper Force',   pin: 'DA0', unit: '%', min: 0, max: 100 },
    { id: 'AO1', label: 'Conveyor Speed',  pin: 'DA1', unit: '%', min: 0, max: 100 },
  ],
}

const SECTIONS = ['digital_inputs', 'digital_outputs', 'analog_inputs', 'analog_outputs']

function EditableLabel({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value)
  const inputRef = useRef(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  function commit() {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onChange(trimmed)
    else setDraft(value)
  }

  function cancel() {
    setEditing(false)
    setDraft(value)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') cancel()
        }}
        style={{
          flex: 1, minWidth: 0,
          padding: '2px 6px',
          fontSize: 12,
          background: 'var(--bg-panel)',
          color: 'var(--text-primary)',
          border: '1px solid var(--accent)',
          borderRadius: 'var(--radius-sm, 4px)',
          outline: 'none',
        }}
      />
    )
  }

  return (
    <span
      onClick={() => { setDraft(value); setEditing(true) }}
      title="Click to rename"
      style={{
        fontSize: 12,
        color: 'var(--text-primary)',
        flex: 1, minWidth: 0,
        cursor: 'text',
        padding: '2px 4px',
        borderRadius: 'var(--radius-sm, 4px)',
        borderBottom: '1px dashed transparent',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderBottomColor = 'var(--border)' }}
      onMouseLeave={(e) => { e.currentTarget.style.borderBottomColor = 'transparent' }}
    >
      {value}
    </span>
  )
}

function DigitalSignal({ signal, value, isOutput, onToggle, onRename }) {
  const active = Boolean(value)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 12px',
      background: active ? 'rgba(22,163,74,0.08)' : 'var(--bg-surface)',
      borderRadius: 'var(--radius-sm, 4px)',
      border: `1px solid ${active ? 'rgba(22,163,74,0.3)' : 'var(--border)'}`,
      marginBottom: 3,
    }}>
      <div style={{
        width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
        background: active ? '#16A34A' : '#374151',
        boxShadow: active ? '0 0 6px rgba(22,163,74,0.5)' : 'none',
        transition: 'all 200ms',
      }} />
      <span style={{
        fontSize: 10, fontFamily: 'var(--font-mono, monospace)',
        color: 'var(--text-muted)', minWidth: 32, flexShrink: 0,
      }}>
        {signal.pin}
      </span>
      <EditableLabel value={signal.label} onChange={(v) => onRename(signal.id, v)} />
      <span style={{
        fontSize: 11, fontWeight: 600, minWidth: 30, textAlign: 'right',
        color: active ? '#16A34A' : 'var(--text-muted)', flexShrink: 0,
      }}>
        {active ? 'ON' : 'OFF'}
      </span>
      {isOutput && (
        <button
          onClick={() => onToggle(signal.id, !active)}
          aria-label={`Toggle ${signal.label}`}
          style={{
            width: 36, height: 20, borderRadius: 10, border: 'none',
            background: active ? '#16A34A' : '#374151',
            position: 'relative', cursor: 'pointer', flexShrink: 0,
            transition: 'background 200ms', padding: 0,
          }}
        >
          <div style={{
            width: 16, height: 16, borderRadius: '50%',
            background: '#fff', position: 'absolute', top: 2,
            left: active ? 18 : 2,
            transition: 'left 200ms',
          }} />
        </button>
      )}
    </div>
  )
}

function AnalogSignal({ signal, value, isOutput, onChange, onRename }) {
  const range = signal.max - signal.min || 1
  const pct   = ((value - signal.min) / range) * 100
  return (
    <div style={{
      padding: '8px 12px',
      background: 'var(--bg-surface)',
      borderRadius: 'var(--radius-sm, 4px)',
      border: '1px solid var(--border)',
      marginBottom: 3,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 10, fontFamily: 'var(--font-mono, monospace)',
          color: 'var(--text-muted)', minWidth: 32, flexShrink: 0,
        }}>
          {signal.pin}
        </span>
        <EditableLabel value={signal.label} onChange={(v) => onRename(signal.id, v)} />
        <span style={{
          fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
          color: 'var(--accent)', minWidth: 70, textAlign: 'right', flexShrink: 0,
        }}>
          {Number(value).toFixed(1)} {signal.unit}
        </span>
      </div>
      <div style={{
        height: 6, borderRadius: 3,
        background: 'var(--bg-active, rgba(255,255,255,0.06))',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', borderRadius: 3,
          width: `${Math.min(100, Math.max(0, pct))}%`,
          background: pct > 80 ? '#DC2626' : pct > 50 ? '#CA8A04' : 'var(--accent)',
          transition: 'width 300ms',
        }} />
      </div>
      {isOutput && (
        <input
          type="range"
          min={signal.min} max={signal.max} step={0.1}
          value={value}
          onChange={(e) => onChange(signal.id, parseFloat(e.target.value))}
          style={{ width: '100%', marginTop: 6 }}
        />
      )}
    </div>
  )
}

function GroupHeader({ color, label, count }) {
  return (
    <div style={{
      fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
      padding: '6px 12px', background: 'var(--bg-panel)',
      borderRadius: 'var(--radius-sm, 4px)', marginBottom: 6,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <span style={{ color }}>●</span> {label} ({count})
    </div>
  )
}

// Apply a saved {id -> label} map onto a fresh copy of IO_CONFIG.
function applyLabelsToConfig(labels) {
  const out = {}
  for (const section of SECTIONS) {
    out[section] = IO_CONFIG[section].map((sig) => ({
      ...sig,
      label: (labels && labels[sig.id]) ? labels[sig.id] : sig.label,
    }))
  }
  return out
}

// Build a full {id -> label} map from the current config plus a single
// in-flight override — used as the PUT payload so a save preserves
// every previously-renamed label (and tolerates rapid renames).
function buildLabelsPayload(config, overrideId, overrideLabel) {
  const labels = {}
  for (const section of SECTIONS) {
    for (const sig of config[section]) {
      labels[sig.id] = (sig.id === overrideId) ? overrideLabel : sig.label
    }
  }
  return labels
}

export default function IOPanel() {
  const [ioState, setIoState] = useState({})
  const [config, setConfig]   = useState(IO_CONFIG)

  // Load saved labels on mount (defaults stay if none saved).
  useEffect(() => {
    let alive = true
    fetch('/api/io/config')
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return
        if (data && data.labels && Object.keys(data.labels).length > 0) {
          setConfig(applyLabelsToConfig(data.labels))
        }
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // Poll I/O values at 4 Hz.
  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const res = await fetch('/api/io/state')
        if (!res.ok) return
        const data = await res.json()
        if (alive && data && data.io) setIoState(data.io)
      } catch { /* swallow — next tick retries */ }
    }
    poll()
    const interval = setInterval(poll, 250)
    return () => { alive = false; clearInterval(interval) }
  }, [])

  async function toggleDigital(id, on) {
    const value = on ? 1 : 0
    setIoState((prev) => ({ ...prev, [id]: value }))
    try {
      await fetch('/api/io/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, value }),
      })
    } catch {}
  }

  async function setAnalog(id, value) {
    setIoState((prev) => ({ ...prev, [id]: value }))
    try {
      await fetch('/api/io/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, value }),
      })
    } catch {}
  }

  async function handleRename(signalId, newLabel) {
    const labels = buildLabelsPayload(config, signalId, newLabel)
    setConfig(applyLabelsToConfig(labels))
    try {
      await fetch('/api/io/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels }),
      })
    } catch {}
  }

  async function handleResetLabels() {
    if (!confirm('Reset all I/O labels to defaults?')) return
    setConfig(IO_CONFIG)
    try {
      await fetch('/api/io/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: {} }),
      })
    } catch {}
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 16, background: '#08090c' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
          I/O Configuration
        </div>
        <button
          onClick={handleResetLabels}
          title="Reset all labels to factory defaults"
          style={{
            padding: '4px 12px',
            fontSize: 11,
            background: 'var(--bg-surface)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm, 4px)',
            cursor: 'pointer',
          }}
        >
          Reset Labels
        </button>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Estun S10-140 Controller
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <GroupHeader color="#3B82F6" label="Digital Inputs" count={config.digital_inputs.length} />
          {config.digital_inputs.map((sig) => (
            <DigitalSignal
              key={sig.id}
              signal={sig}
              value={ioState[sig.id] || 0}
              isOutput={false}
              onRename={handleRename}
            />
          ))}
        </div>

        <div>
          <GroupHeader color="#16A34A" label="Digital Outputs" count={config.digital_outputs.length} />
          {config.digital_outputs.map((sig) => (
            <DigitalSignal
              key={sig.id}
              signal={sig}
              value={ioState[sig.id] || 0}
              isOutput={true}
              onToggle={toggleDigital}
              onRename={handleRename}
            />
          ))}
        </div>

        <div>
          <GroupHeader color="#CA8A04" label="Analog Inputs" count={config.analog_inputs.length} />
          {config.analog_inputs.map((sig) => (
            <AnalogSignal
              key={sig.id}
              signal={sig}
              value={Number(ioState[sig.id]) || 0}
              isOutput={false}
              onRename={handleRename}
            />
          ))}
        </div>

        <div>
          <GroupHeader color="#9333EA" label="Analog Outputs" count={config.analog_outputs.length} />
          {config.analog_outputs.map((sig) => (
            <AnalogSignal
              key={sig.id}
              signal={sig}
              value={Number(ioState[sig.id]) || 0}
              isOutput={true}
              onChange={setAnalog}
              onRename={handleRename}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
