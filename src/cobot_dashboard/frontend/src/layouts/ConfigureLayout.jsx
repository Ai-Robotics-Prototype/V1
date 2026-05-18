import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'

const LS_KEY = 'roboai-config'

const BRANDS = ['xarm', 'jaka', 'dobot', 'generic']

function Section({ title, children }) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-primary)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        paddingBottom: 8,
        borderBottom: '1px solid var(--border)',
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Field({ label, children, note }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <label style={{ fontSize: 12, color: 'var(--text-secondary)', width: 140, flexShrink: 0 }}>
        {label}
      </label>
      <div style={{ flex: 1 }}>
        {children}
        {note && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{note}</div>
        )}
      </div>
    </div>
  )
}

const inputStyle = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  padding: '5px 9px',
  fontSize: 12,
  width: '100%',
  outline: 'none',
  transition: 'border-color 150ms',
}

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
}

// SVG concentric rings for zone visualisation
function ZoneRingSVG({ green, yellow, red }) {
  const size = 180
  const cx   = size / 2
  const cy   = size / 2
  const maxR = 2.5
  const SCALE = (size / 2 - 10) / maxR

  const rings = [
    { r: parseFloat(green)  || 2.0, color: '#22C55E', label: 'Green' },
    { r: parseFloat(yellow) || 1.2, color: '#EAB308', label: 'Yellow' },
    { r: parseFloat(red)    || 0.6, color: '#EF4444', label: 'Red' },
  ]

  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      {rings.map(({ r, color, label }) => {
        const pxR = Math.min(r * SCALE, size / 2 - 4)
        return (
          <g key={label}>
            <circle cx={cx} cy={cy} r={pxR} fill={`${color}10`} stroke={color} strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={cx + pxR + 3} y={cy + 4} fontSize={8} fill={color} opacity={0.8}>
              {r}m
            </text>
          </g>
        )
      })}
      {/* Robot */}
      <rect x={cx - 6} y={cy - 8} width={12} height={16} rx={3} fill="#3B82F6" opacity={0.9} />
    </svg>
  )
}

export default function ConfigureLayout() {
  const setMode = useStore((s) => s.setMode)
  const mode    = useStore((s) => s.mode)

  const [cfg, setCfg] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    } catch {
      return {}
    }
  })
  const [apiConfig, setApiConfig]   = useState(null)
  const [connResult, setConnResult] = useState(null)
  const [connTesting, setConnTesting] = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setApiConfig)
      .catch(() => {})
  }, [])

  function update(key, value) {
    const next = { ...cfg, [key]: value }
    setCfg(next)
    localStorage.setItem(LS_KEY, JSON.stringify(next))
  }

  async function testConnection() {
    setConnTesting(true)
    setConnResult(null)
    try {
      const r = await fetch('/health')
      const d = await r.json()
      setConnResult({ ok: d.status === 'ok', msg: `Status: ${d.status} | Uptime: ${d.uptime_s}s | Mock: ${d.mock}` })
    } catch (e) {
      setConnResult({ ok: false, msg: `Connection failed: ${e.message}` })
    } finally {
      setConnTesting(false)
    }
  }

  const zoneGreen  = cfg.zone_green  ?? apiConfig?.safety?.zone_green_m  ?? '2.0'
  const zoneYellow = cfg.zone_yellow ?? apiConfig?.safety?.zone_yellow_m ?? '1.2'
  const zoneRed    = cfg.zone_red    ?? apiConfig?.safety?.zone_red_m    ?? '0.6'

  return (
    <div style={{
      height: '100%',
      overflowY: 'auto',
      padding: '20px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      background: 'var(--bg-app)',
    }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Configure
      </div>

      {/* Robot Connection */}
      <Section title="Robot Connection">
        <Field label="Brand">
          <select
            style={selectStyle}
            value={cfg.brand ?? apiConfig?.robot?.brand ?? 'generic'}
            onChange={(e) => update('brand', e.target.value)}
          >
            {BRANDS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </Field>
        <Field label="IP Address">
          <input
            style={inputStyle}
            type="text"
            value={cfg.ip ?? apiConfig?.robot?.ip ?? '192.168.1.246'}
            onChange={(e) => update('ip', e.target.value)}
            placeholder="192.168.1.246"
          />
        </Field>
        <Field label="Port">
          <input
            style={inputStyle}
            type="number"
            value={cfg.port ?? apiConfig?.robot?.port ?? 502}
            onChange={(e) => update('port', parseInt(e.target.value, 10))}
            placeholder="502"
          />
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={testConnection}
            disabled={connTesting}
            style={{
              background: 'var(--accent)',
              border: 'none',
              color: '#fff',
              padding: '6px 14px',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {connTesting ? 'Testing…' : 'Test Connection'}
          </button>
          {connResult && (
            <span style={{
              fontSize: 11,
              color: connResult.ok ? 'var(--green)' : 'var(--red)',
              fontFamily: 'var(--font-mono)',
            }}>
              {connResult.ok ? '✓' : '✗'} {connResult.msg}
            </span>
          )}
        </div>
      </Section>

      {/* Safety Zones */}
      <Section title="Safety Zones">
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Field label="Green zone (m)" note="Max speed — > this radius">
              <input
                style={inputStyle}
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={zoneGreen}
                onChange={(e) => update('zone_green', e.target.value)}
              />
            </Field>
            <Field label="Yellow zone (m)" note="Slow speed — between yellow and green">
              <input
                style={inputStyle}
                type="number"
                step="0.1"
                min="0.1"
                max="5"
                value={zoneYellow}
                onChange={(e) => update('zone_yellow', e.target.value)}
              />
            </Field>
            <Field label="Red zone (m)" note="Stop — within this radius">
              <input
                style={inputStyle}
                type="number"
                step="0.05"
                min="0.1"
                max="5"
                value={zoneRed}
                onChange={(e) => update('zone_red', e.target.value)}
              />
            </Field>
          </div>
          <ZoneRingSVG green={zoneGreen} yellow={zoneYellow} red={zoneRed} />
        </div>
      </Section>

      {/* Camera Settings */}
      <Section title="Camera Settings">
        {(apiConfig?.cameras ?? []).map((cam) => (
          <Field key={cam.id} label={`Camera ${cam.id} Topic`} note={`Stream FPS: ${cam.fps} (read-only)`}>
            <input
              style={{ ...inputStyle, color: 'var(--text-muted)' }}
              value={cam.topic}
              readOnly
            />
          </Field>
        ))}
        {!apiConfig?.cameras?.length && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading camera config…</div>
        )}
      </Section>

      {/* Interface */}
      <Section title="Interface">
        <Field label="Operator Mode">
          <div style={{ display: 'flex', gap: 3 }}>
            {['operator', 'engineer'].map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); update('mode', m) }}
                style={{
                  background: mode === m ? 'var(--accent-dim)' : 'var(--bg-panel)',
                  border: `1px solid ${mode === m ? 'var(--accent-border)' : 'var(--border)'}`,
                  color: mode === m ? 'var(--accent)' : 'var(--text-secondary)',
                  padding: '4px 14px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 12,
                  fontWeight: mode === m ? 500 : 400,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Theme" note="Only dark theme supported">
          <button
            style={{
              background: 'var(--accent-dim)',
              border: '1px solid var(--accent-border)',
              color: 'var(--accent)',
              padding: '4px 14px',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'default',
            }}
          >
            Dark
          </button>
        </Field>
      </Section>

      {/* Version info */}
      <div style={{
        fontSize: 10,
        color: 'var(--text-muted)',
        textAlign: 'center',
        padding: '8px 0 16px',
      }}>
        RoboAi Controller v1.0.0-mock — Settings saved to localStorage
      </div>
    </div>
  )
}
