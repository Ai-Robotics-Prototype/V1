// Canonical wizard-step chrome.
//
// Every prompt-style page in ProgramWizard renders inside this
// container (padding/maxWidth/title/description treatment). Steps
// imported from their own files (e.g. ToolFromCellStep) must also
// render inside this component so the window chrome is identical
// across the wizard — the 2026-09-22 operator directive about the
// tool step rendering in a bespoke window traces back to this file
// having been inlined once and forked once.
//
// Pin: components/*.jsx and PAGES entries import this named export
// instead of defining their own prompt wrapper.

export function QuestionCard({ question, description, children }) {
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
