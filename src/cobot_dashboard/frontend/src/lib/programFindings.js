// programFindings — program-level validation findings surfaced in
// the editor between the Tool & Payload section and the step list.
//
// Findings live on the program, not in a modal — this decouples the
// operator's "I need to know about X" from any particular editing
// surface. A finding clears when its underlying condition resolves
// (e.g. re-teaching ④ clears the pallet-migration finding).
//
// Severity levels:
//   * 'info'  — informational, blue chip; teach nudges, migration
//               notices. Doesn't block Run.
//   * 'warn'  — amber; something to fix before Run (e.g. payload).
//   * 'error' — red; must fix (e.g. untaught step).
//
// Shape: { id, severity, title, body, action? }.
//   * id     — stable slug; used as React key + testid suffix.
//   * action — optional { label, kind } — 'kind' names the operator
//              gesture that resolves it (e.g. 'teach-pallet-part'),
//              so hosts can wire a matching CTA button.

import { palletFrameStatus } from './programTruth.js'


// Legacy v1 → v2 migration nudge: the ④ (first-part) datum was
// seeded from corner A during migration, so it doesn't actually
// represent the operator-taught contact pose. Re-teach ④ with a
// real part in slot [1,1] to get correct tool-contact geometry.
function legacyPalletMigrationFinding(program) {
  const fs = palletFrameStatus(program)
  if (!fs || !fs.migratedFromV1) return null
  return {
    id: 'pallet-legacy-migration',
    severity: 'info',
    title: 'Pallet uses legacy 3-point (A/B/C) frame',
    body: 'The first-part position (④) was seeded from corner A during '
        + 'migration. Re-teach ④ with a real part in slot [1,1] so the '
        + 'tool contact geometry and orientation carry through to every '
        + 'derived slot.',
    action: { label: 'Re-teach ④', kind: 'teach-pallet-part' },
  }
}


// Compute all findings for a program. Add new rules here; each
// rule returns null (no finding) or a finding object. The list
// is filtered so hosts only see present findings.
export function computeProgramFindings(program) {
  const rules = [
    legacyPalletMigrationFinding,
  ]
  return rules.map((rule) => rule(program)).filter(Boolean)
}
