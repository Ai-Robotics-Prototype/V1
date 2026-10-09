// Payload helpers — a program's payload lives at
// `program.config.payload_kg` (nullable), plus optional
// `payload_cog_mm` {x,y,z}. Every surface that renders the value
// goes through these helpers so the "unset" copy stays consistent.
//
// 2026-07-31 cleanup: `tool_name` was retired from the payload
// surface — the field survives on saved configs (backward-compat)
// but the editor no longer reads or writes it. The panel is now
// mass + CoG only.
//
// See lib/payloadTruth for the operator-facing program-vs-robot
// tool-weight comparison line that replaced the old "info only"
// banner. The dashboard embeds the mass into every generated
// program as metadata; the controller's live payload setting
// isn't readable here on this hardware, so the dashboard tells
// the operator to confirm it on the pendant (payloadTruth's
// 'unreadable' state, 2026-10-09 operator directive).
//
// FUTURE — per-cycle payload emission: a controller firmware
// that both exposes its live payload register AND accepts a
// setPayload wire verb would let the dashboard emit "declare
// carried mass at grip" into every program. Until then the
// pendant setting is authoritative for payload compensation.

export function readPayload(program) {
  const cfg = (program && program.config) || {}
  const raw = cfg.payload_kg
  const kg = (raw === null || raw === undefined || raw === '') ? null : Number(raw)
  const cog = cfg.payload_cog_mm || null
  return {
    kg:       Number.isFinite(kg) && kg > 0 ? kg : null,
    cog_mm:   cog && typeof cog === 'object' ? cog : null,
    isSet:    Number.isFinite(kg) && kg > 0,
  }
}

// Short label for a chip: "1.2 kg" or "Payload not set".
export function payloadChipLabel(payload) {
  if (!payload.isSet) return 'Payload not set'
  return `${payload.kg.toFixed(payload.kg < 10 ? 1 : 0)} kg`
}

// Single sentence explaining the warning — used by the run modal
// and monitor chip title. The editor's payload section now uses
// the live payloadTruth line instead of this static blurb.
export const PAYLOAD_UNSET_WARNING =
  'No payload set — collision detection accuracy is reduced. ' +
  'Set the tool’s mass in the program editor before running.'

// PAYLOAD_INFO_ONLY (retired 2026-10-09 operator directive): the
// deprecated re-export used to carry Factory UI / PayloadId jargon
// but no component imports it. Pinned absent so the string can't
// resurface in a search; the pre-fix pinned tests at
// RunProgramModal.pinned.test.js + PayloadSection.pinned.test.js
// stay green because they assert its NON-use.
