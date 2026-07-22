// Payload helpers — a program's payload lives at
// `program.config.payload_kg` (nullable), plus optional
// `payload_cog_mm` {x,y,z} and `tool_name`. The controller's
// PayloadId is selected in the factory UI; our program-level
// payload is INFORMATIONAL (see the protocol check in the
// commit body for `PAYLOAD as a per-program property`). Every
// surface that renders the value goes through these helpers so
// the "unset" copy stays consistent.

export function readPayload(program) {
  const cfg = (program && program.config) || {}
  const raw = cfg.payload_kg
  const kg = (raw === null || raw === undefined || raw === '') ? null : Number(raw)
  const cog = cfg.payload_cog_mm || null
  const toolName = (cfg.tool_name && String(cfg.tool_name).trim()) || ''
  return {
    kg:       Number.isFinite(kg) && kg > 0 ? kg : null,
    cog_mm:   cog && typeof cog === 'object' ? cog : null,
    tool_name: toolName,
    isSet:    Number.isFinite(kg) && kg > 0,
  }
}

// Short label for a chip: "1.2 kg · vacuum tool" or "Payload not set".
export function payloadChipLabel(payload) {
  if (!payload.isSet) return 'Payload not set'
  const parts = [`${payload.kg.toFixed(payload.kg < 10 ? 1 : 0)} kg`]
  if (payload.tool_name) parts.push(payload.tool_name)
  return parts.join(' · ')
}

// Single sentence explaining the warning — used by the editor banner,
// run modal, and monitor chip title.
export const PAYLOAD_UNSET_WARNING =
  'No payload set — collision detection accuracy is reduced. ' +
  'Set the tool’s mass in the program editor before running.'

// One-sentence info line for the set-payload path — makes it clear the
// value is a program annotation, not something we push to the wire.
export const PAYLOAD_INFO_ONLY =
  'This is program-level metadata. The controller uses its own PayloadId ' +
  'preset (Factory UI → Set the default load) for collision detection.'
