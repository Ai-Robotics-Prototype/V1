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
// See lib/payloadTruth for the live program-vs-controller comparison
// line that replaced the old "info only" banner. The controller's
// PayloadId preset is selected in the factory UI; whether we can
// read that value on the wire lives on payloadTruth's state machine.
//
// FUTURE — per-cycle payload emission: setPayload() at grip/release
// remains gated on the argument-format stop-condition (setPayload
// takes a string arg whose format is not yet reverse-engineered;
// see the factory-UI shopping list in luaenginelib.json). When
// resolved, "declare carried mass at grip" becomes a codegen
// emission and THIS module becomes its authoritative mass source.

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

// Deprecated: retained as a re-export so any lingering RunModal
// import keeps compiling. The editor's payload panel no longer
// renders this — payloadTruth's live message replaced it.
export const PAYLOAD_INFO_ONLY =
  'The controller\'s PayloadId preset is selected in the Factory UI. ' +
  'The dashboard\'s panel shows the program value; live sync with the ' +
  'controller lives on the payloadTruth truth line.'
