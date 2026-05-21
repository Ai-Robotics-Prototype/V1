import { useState } from 'react'
import { useStore } from '../store/useStore'

export default function VoiceCommandBar() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [resp, setResp] = useState('')
  const sendCommand = useStore((s) => s.sendCommand)
  const language    = useStore((s) => s.language)

  async function submit() {
    if (!text.trim() || busy) return
    setBusy(true)
    // Try ROS language node first, fall back to local NLP handler
    const result = await sendCommand('voice_ros', { text: text.trim() })
    if (!result?.ok) {
      await sendCommand('voice', { text: text.trim() })
    }
    setResp(language?.last_response || 'Command sent')
    setText('')
    setBusy(false)
  }

  function onKey(e) {
    if (e.key === 'Enter') submit()
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
      padding: '8px 10px', gap: 5,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '.1em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          Voice / NLP
        </span>
        {language?.model_name && (
          <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>
            {language.model_name}
          </span>
        )}
        {language?.listening && (
          <span style={{ fontSize: 9, color: 'var(--accent)', marginLeft: 'auto' }}>
            ● listening…
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="pick bottle / go home / estop…"
          style={{
            flex: 1, fontSize: 10, padding: '4px 8px',
            border: '1px solid var(--border)', borderRadius: 5,
            background: 'var(--bg-surface)', color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          style={{
            fontSize: 9, padding: '4px 10px', borderRadius: 5,
            border: '1px solid var(--accent)', background: 'var(--accent-dim)',
            color: 'var(--accent)', cursor: busy ? 'wait' : 'pointer',
            opacity: (!text.trim() || busy) ? 0.5 : 1,
          }}
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
      {resp && (
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          ↳ {resp}
        </span>
      )}
    </div>
  )
}
