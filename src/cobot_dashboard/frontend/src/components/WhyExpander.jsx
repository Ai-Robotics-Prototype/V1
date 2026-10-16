import { useState } from 'react'

// WhyExpander — operator-facing "Why?" disclosure (2026-10-02 plain-
// language register directive).
//
// Questions in the wizards are rewritten to WHAT THE TOOL DOES, not
// what hardware does it. Technical terms (5/2 DS, N/C, hold-on-loss,
// solenoid, etc.) are banned from question copy and only legal inside
// this component. The banned-word grep pin uses the data attribute
// below to carve the expander subtree out before scanning.
//
// Usage:
//   <WhyExpander label="Why?">
//     Technical explanation lives here — pin ignores this subtree.
//   </WhyExpander>
//
// Rules:
//   * data-why-expander="1" MUST be rendered on the outer div — the
//     grep pin matches on this attribute to find the subtree.
//   * The toggle button is operator-facing — its label must stay in
//     plain register (the default "Why?" string is safe).
//   * The subtree content is NOT exempt from React escaping; it is
//     only exempt from the register pin. A /cmd/ or dispatchEvent
//     call inside a WhyExpander still fails the VIEW-tier pin.

export default function WhyExpander({
  label = 'Why?',
  children,
  testId,
}) {
  const [open, setOpen] = useState(false)
  return (
    <div data-why-expander="1"
         data-testid={testId}
         style={{
           marginTop: 6,
           fontSize: 12,
           color: '#4B5563',
         }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-why-expander-toggle="1"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: '#2563EB',
          cursor: 'pointer',
          fontWeight: 600,
          fontFamily: 'inherit',
          fontSize: 12,
        }}>
        {open ? label.replace(/\?$/, '') + ' — hide' : label}
      </button>
      {open && (
        <div data-why-expander-body="1"
             style={{
               marginTop: 6,
               padding: '8px 10px',
               background: '#F9FAFB',
               border: '1px solid #E5E7EB',
               borderRadius: 6,
               color: '#374151',
               lineHeight: 1.5,
             }}>
          {children}
        </div>
      )}
    </div>
  )
}
