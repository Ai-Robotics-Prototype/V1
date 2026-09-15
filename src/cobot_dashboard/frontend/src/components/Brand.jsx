import { useStore } from '../store/useStore'

export const BRAND_NAME = 'NeuRobots'

// 2026-09-08 operator directive (footer removal, revised): the
// edition chip is relocated from the StatusBar to a click affordance
// on the NeuRobots wordmark in the TopBar. Basic devices (no
// Configure tab) can still reach the unlock path here.
//
// Minimal window.confirm/prompt flow is preserved from the prior
// StatusBar block — the gate is separation, not security. When
// edition === 'full', click asks confirm before relocking. When
// edition === 'basic', click asks for the passphrase (env var
// COBOT_EDITION_UNLOCK_PASS, default 'full-please').
export default function Brand({ style }) {
  const edition       = useStore((s) => s.edition)
  const unlockEdition = useStore((s) => s.unlockEdition)
  const lockEdition   = useStore((s) => s.lockEdition)

  async function onClick() {
    if (edition === 'full') {
      if (typeof window !== 'undefined'
          && !window.confirm('Return this device to Basic edition?')) return
      await lockEdition()
      return
    }
    const pw = (typeof window !== 'undefined')
      ? window.prompt('Unlock Full edition — passphrase:')
      : null
    if (pw == null) return
    const res = await unlockEdition(pw)
    if (!res.ok && typeof window !== 'undefined') {
      window.alert(`Unlock refused: ${res.error || 'bad passphrase'}`)
    }
  }

  const isFull = edition === 'full'
  const title = isFull
    ? 'Full edition — click to relock this device to Basic'
    : 'Basic edition — click to unlock Full on this device'

  return (
    <span
      data-testid="brand-edition-hotspot"
      data-edition={edition}
      onClick={onClick}
      title={title}
      style={{
        fontWeight: 700, letterSpacing: '0.01em',
        cursor: 'pointer', userSelect: 'none',
        // Subtle edition hint: FULL adds a small colored dot glyph
        // next to the wordmark so operators looking for the
        // affordance find it without random-click hunting.
        display: 'inline-flex', alignItems: 'center', gap: 6,
        ...style,
      }}>
      {BRAND_NAME}
      <span aria-hidden="true"
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: isFull ? 'var(--accent)' : 'var(--text-muted)',
              display: 'inline-block',
              boxShadow: isFull ? '0 0 4px var(--accent)' : 'none',
            }} />
    </span>
  )
}
