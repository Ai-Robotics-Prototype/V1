import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

// Program-execution error modal.
//
// Reads STATE.robot.program.error, which the driver populates ONLY on
// transitions (see program_ops.ErrorDedup — the ~3 Hz publish/Error
// reflood collapses to one event per unique (code, unix_ts) tuple,
// and stale cleared-key reflows never re-fire; see Part I).
//
// Presentation redesigned 2026-07-22: prior version showed a raw
// monospace text block, a unix_ts float, and a paragraph about the
// dedupe mechanics — technical noise for the most-seen dialog in
// the app. The new layout leads with:
//   - alarm-triangle icon + "Alarm <code>" as a styled title
//   - severity badge (1 Info / 2 Warning / 3 Error / 4 Fault)
//   - humanized timestamp ("just now" / "2m ago")
//   - human-readable headline in prose, not monospace
//   - plain-language operator guidance per known code
//   - protocol details (raw text, dedupe explanation, unix_ts) live
//     inside an expandable "Details" section
// Dedupe behavior is unchanged — this component only re-renders when
// the driver hands it a new (code, ts) tuple.


// ── Alarm-code → operator guidance ──────────────────────────────
//
// Codes observed on the wire (see estun_driver_node.py _on_error
// comment for the full table). "guidance" is a short imperative
// instruction the operator can act on WITHOUT reading the raw text.
// "hint" is a follow-up cause-and-effect line. Both live in prose,
// not code.

function normalizeText(text) {
  if (typeof text !== 'string') return ''
  // Collapse the "Joint<N> ..." → "Joint N ..." for readable prose.
  return text.replace(/^Joint(\d)/, 'Joint $1')
             .replace(/\.$/, '')
             .trim()
}

// Try to pull a joint number out of the raw text (used to swap
// "Joint 1" into our guidance line so the operator sees WHICH joint
// tripped without decoding the raw text).
function jointNumberFromText(text) {
  if (typeof text !== 'string') return null
  const m = text.match(/Joint\s*(\d)/i)
  return m ? m[1] : null
}

function alarmMeta(code, text) {
  const j = jointNumberFromText(text) || 'X'
  switch (code) {
    case 2000:
      return {
        title: `Servo error on Joint ${j}`,
        guidance: 'The controller reports a servo-drive fault on this joint.',
        hint: 'Check the drive cable and inspect controller logs before clearing.',
      }
    case 2002:
      return {
        title: `Joint ${j} exceeded its travel limit`,
        guidance: 'The joint moved past its configured software limit.',
        hint: 'On the factory pendant, jog the joint back inside its ±180°/±166° range, then clear the alarm.',
      }
    case 2006:
    case 13046:
      return {
        title: 'Emergency stop pressed',
        guidance: 'The E-STOP button is engaged.',
        hint: 'Twist the E-STOP knob to release, verify the workspace is clear, then clear the alarm.',
      }
    case 2009:
      return {
        title: `Collision detected on Joint ${j}`,
        guidance: 'The robot detected unexpected resistance on Joint ' + j + '.',
        hint: 'Check the workspace for contact or obstructions before clearing.',
      }
    case 2015:
    case 2023:
      return {
        title: 'Singular position',
        guidance: 'The commanded pose is at or near a kinematic singularity — IK could not resolve joint velocities.',
        hint: 'Retreat to a well-conditioned pose (away from wrist alignment / full-arm extension) and retry.',
      }
    case 9012:
      return {
        title: 'Power disconnection detected',
        guidance: 'The controller lost servo power to one or more joints.',
        hint: 'Verify the 48V bus, contactor, and E-STOP loop before re-enabling.',
      }
    case 10001:
      return {
        title: 'Program not found on controller',
        guidance: 'The controller could not resolve the program id it was asked to run.',
        hint: 'Confirm the program id matches [a-z0-9]+ (underscores and dashes get split by the URL parser) and try again.',
      }
    case 10006: {
      // Lua runtime: "bad argument #-2 to '<verb>' (number has no
      // integer representation)". Extract the offending verb + any
      // line info the runtime carries.
      const verbM = /to '([^']+)'/.exec(text || '')
      const lineM = /line[:\s]+(\d+)/i.exec(text || '')
      const verb = verbM ? verbM[1] : null
      const line = lineM ? lineM[1] : null
      return {
        title: 'Program aborted (Lua runtime error)',
        guidance: (
          verb
            ? `The Lua interpreter refused a call to \`${verb}\` — the argument type did not match what the verb expected.`
            : 'The Lua interpreter refused an argument the program passed to one of its verbs.'
        ),
        hint: (
          line
            ? `Error surfaced at line ${line}. Check the program's codegen output; wait() takes an INTEGER ms, not a float seconds.`
            : `wait() takes an INTEGER ms; movJ/movL point args must exist in varspoint. If you edited codegen recently, re-run save.`
        ),
      }
    }
    default:
      return {
        title: `Alarm ${code}`,
        guidance: normalizeText(text) || 'The controller reported a fault with no accompanying description.',
        hint: null,
      }
  }
}

// Severity → badge. Estun's publish/Error `level` field appears to
// follow the standard 1/2/3/4 = Info/Warning/Error/Fault convention.
function severityBadge(level) {
  const num = Number(level)
  if (num >= 4) {
    return { label: 'Fault',   bg: '#7F1D1D', text: '#fff' }
  }
  if (num === 3) {
    return { label: 'Error',   bg: '#DC2626', text: '#fff' }
  }
  if (num === 2) {
    return { label: 'Warning', bg: '#CA8A04', text: '#fff' }
  }
  return { label: 'Info', bg: '#4B5063', text: '#fff' }
}

// Humanized "N ago" from a unix seconds timestamp. Anything under 5s
// is "just now"; > 24h falls back to the local wall-clock time.
function humanTs(unix_s) {
  const t = Number(unix_s)
  if (!Number.isFinite(t) || t <= 0) return ''
  const now = Date.now() / 1000
  const dt = now - t
  if (dt < 0) return 'in the future'   // clock skew — rare
  if (dt < 5) return 'just now'
  if (dt < 60) return `${Math.round(dt)}s ago`
  if (dt < 3600) return `${Math.round(dt / 60)}m ago`
  if (dt < 86400) return `${Math.round(dt / 3600)}h ago`
  return new Date(t * 1000).toLocaleString()
}


export default function ProgramErrorModal() {
  const err               = useStore((s) => s.robot?.program?.error) || null
  const clearProgramError = useStore((s) => s.clearProgramError)

  // Local dismiss latch — separate from the underlying error tuple so
  // dismissing this instance doesn't hide a fresh error with a
  // different ts. Storing the (code, ts) key means a new tuple
  // re-opens the modal automatically.
  const [dismissedKey, setDismissedKey] = useState(null)
  const [showDetails,  setShowDetails]  = useState(false)
  const [nowTick,      setNowTick]      = useState(0)

  const key = err ? `${err[1]}|${err[2]}` : null
  useEffect(() => {
    if (key === null) {
      setDismissedKey(null)
      setShowDetails(false)
    }
  }, [key])
  // Nudge the "N ago" label forward while the modal is open. 15 s tick
  // is enough to walk seconds → minutes without wasting renders.
  useEffect(() => {
    if (!err || dismissedKey === key) return undefined
    const id = setInterval(() => setNowTick((v) => v + 1), 15000)
    return () => clearInterval(id)
  }, [err, key, dismissedKey])

  if (!err || dismissedKey === key) return null

  const [severity, code, unixTs, text] = err
  const meta   = alarmMeta(code, text)
  const badge  = severityBadge(severity)
  const when   = humanTs(unixTs)
  // suppress `nowTick`-unused-var lint — the tick's only purpose is
  // to force a rerender so `when` recomputes.
  void nowTick

  // ── Styles ────────────────────────────────────────────────────
  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(10, 10, 12, 0.55)',
    zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  const panel = {
    background: 'var(--bg-panel)',
    borderRadius: 'var(--radius-lg)',
    padding: '22px 24px 20px',
    minWidth: 480, maxWidth: 560,
    boxShadow: 'var(--shadow-md)',
    borderTop: '4px solid var(--red)',
    fontFamily: 'var(--font)',
  }
  const titleRow = {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4,
  }
  const iconWrap = {
    width: 40, height: 40, borderRadius: '50%',
    background: 'var(--red-dim)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  }
  const alarmLabel = {
    fontSize: 12, fontWeight: 600,
    color: 'var(--red)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  }
  const alarmCode = {
    fontSize: 22, fontWeight: 700,
    color: 'var(--text-primary)',
    lineHeight: 1.15,
  }
  const badgeStyle = {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: 999,
    fontSize: 11, fontWeight: 700,
    letterSpacing: '0.04em',
    background: badge.bg, color: badge.text,
    textTransform: 'uppercase',
  }
  const whenStyle = {
    fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto',
  }
  const headline = {
    fontSize: 17, fontWeight: 600,
    color: 'var(--text-primary)',
    marginTop: 16, lineHeight: 1.4,
  }
  const bodyText = {
    fontSize: 14, color: 'var(--text-secondary)',
    marginTop: 8, lineHeight: 1.55,
  }
  const hintBlock = {
    marginTop: 12, padding: '10px 12px',
    background: 'var(--accent-dim)',
    border: '1px solid var(--accent-border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 13, color: 'var(--text-primary)',
    lineHeight: 1.5,
  }
  const detailsToggle = {
    marginTop: 14, fontSize: 12, fontWeight: 500,
    color: 'var(--text-muted)',
    background: 'none', border: 'none',
    padding: 0, cursor: 'pointer',
  }
  const detailsBox = {
    marginTop: 8, padding: '10px 12px',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    fontSize: 12, color: 'var(--text-secondary)',
    lineHeight: 1.55,
  }
  const rawLine = {
    marginTop: 6,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-primary)',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '6px 8px',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  }
  const btnRow = {
    marginTop: 20, display: 'flex', gap: 10, alignItems: 'center',
    justifyContent: 'flex-end', flexWrap: 'wrap',
  }
  const btnPrimary = {
    padding: '10px 18px', fontSize: 14, fontWeight: 600,
    background: 'var(--red)', color: '#fff',
    border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  }
  const btnGhost = {
    padding: '10px 18px', fontSize: 14, fontWeight: 500,
    background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border-bright)',
    borderRadius: 'var(--radius-md)', cursor: 'pointer',
  }
  const primaryNote = {
    fontSize: 11, color: 'var(--text-muted)',
    marginRight: 'auto',
  }

  return (
    <div style={backdrop}>
      <div style={panel} role="alertdialog" aria-labelledby="pgm-alarm-title">
        <div style={titleRow}>
          <div style={iconWrap} aria-hidden="true">
            {/* triangle-with-exclamation, sized to fit the 40px puck */}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 3.2L22 20H2L12 3.2z"
                    fill="var(--red)" />
              <path d="M12 10v5" stroke="#fff"
                    strokeWidth="1.8" strokeLinecap="round" />
              <circle cx="12" cy="17.2" r="1.1" fill="#fff" />
            </svg>
          </div>
          <div>
            <div style={alarmLabel}>Alarm</div>
            <div id="pgm-alarm-title" style={alarmCode}>
              Alarm {code}
            </div>
          </div>
          <span style={badgeStyle}>{badge.label}</span>
          {when && <span style={whenStyle}>{when}</span>}
        </div>

        <div style={headline}>{meta.title}</div>
        {meta.guidance && (
          <div style={bodyText}>{meta.guidance}</div>
        )}
        {meta.hint && (
          <div style={hintBlock}>{meta.hint}</div>
        )}

        <button style={detailsToggle}
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}>
          {showDetails ? '▾ Hide details' : '▸ Show details'}
        </button>
        {showDetails && (
          <div style={detailsBox}>
            <div>
              severity <b>{severity}</b>{' '}·{' '}
              code <b>{code}</b>{' '}·{' '}
              unix_ts <b>{Number(unixTs).toFixed(3)}</b>
            </div>
            <div style={{ marginTop: 6 }}>
              The controller re-emits this alarm at ~3&nbsp;Hz until it
              is cleared. The driver dedupes by (code, unix_ts), so this
              modal opens once per fault event, not once per reflood
              frame. A subsequent clear + re-emit of the SAME (code,
              unix_ts) is also suppressed (Part&nbsp;I stale-error fix).
            </div>
            {text && (
              <div style={rawLine}>{text}</div>
            )}
          </div>
        )}

        <div style={btnRow}>
          <span style={primaryNote}>
            Clearing sends <code style={{ fontFamily: 'var(--font-mono)' }}>System/ClearError</code> to the controller.
          </span>
          <button style={btnGhost} onClick={() => setDismissedKey(key)}>
            Dismiss
          </button>
          <button style={btnPrimary} onClick={() => clearProgramError()}>
            Clear error
          </button>
        </div>
      </div>
    </div>
  )
}
