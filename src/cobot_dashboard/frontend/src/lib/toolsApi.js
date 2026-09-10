// Custom End-of-Arm Tool library client (2026-09-08).
//
// Thin wrappers over the /api/tools/* endpoints landed in Phase 1
// (dashboard_server.py). Every method returns the parsed JSON or
// throws a NAMED refusal — the message is the operator copy the
// backend emits (REFUSE_UNPARSEABLE, REFUSE_MISSING_TCP, etc.);
// never leak HTTP detail past this layer.
//
// Retro-edit guard (item 7): call listProgramsUsingTool(tool_id)
// BEFORE putTcp to name the affected programs in the confirm modal.
// If you skip the guard and just call putTcp, the endpoint returns
// 409 with {kind:'retro_edit_confirm_required', programs:[…]} which
// this client surfaces as a { retroEditRequired: true, programs }
// return value (NOT a throw) so the caller can react cleanly.

async function _json(res) {
  const txt = await res.text()
  try { return txt ? JSON.parse(txt) : null }
  catch { return { _raw: txt } }
}

async function _refuseByName(res) {
  const body = await _json(res)
  const detail = body && (body.detail || body.message)
  if (typeof detail === 'string' && detail.length) throw new Error(detail)
  throw new Error(`request failed (${res.status})`)
}

export async function listTools() {
  const res = await fetch('/api/tools')
  if (!res.ok) return _refuseByName(res)
  const body = await _json(res)
  return body.tools || []
}

export async function getTool(toolId) {
  const res = await fetch(`/api/tools/${encodeURIComponent(toolId)}`)
  if (!res.ok) return _refuseByName(res)
  return _json(res)
}

// Multipart upload — matches the FastAPI Form/File signature on
// POST /api/tools/upload. Returns the tool.json doc with
// conversion.state='pending' or 'converting'; poll pollUntilConverted.
export async function uploadTool(name, stepFile) {
  const form = new FormData()
  form.append('name', name)
  form.append('step_file', stepFile)
  const res = await fetch('/api/tools/upload', {
    method: 'POST', body: form,
  })
  if (!res.ok) return _refuseByName(res)
  return _json(res)
}

// Poll /api/tools/{id} until conversion.state is terminal. Returns
// the final doc. Throws with the operator-visible copy on 'failed'.
export async function pollUntilConverted(toolId, {
  timeoutMs = 30_000, intervalMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const doc = await getTool(toolId)
    const state = doc.conversion?.state
    if (state === 'converted') return doc
    if (state === 'failed') {
      throw new Error(doc.conversion?.error
        || "couldn't read this STEP file")
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('conversion is taking longer than expected')
}

export async function putMountTransform(toolId, mountTransform) {
  const res = await fetch(
    `/api/tools/${encodeURIComponent(toolId)}/mount_transform`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mount_transform: mountTransform }),
    })
  if (!res.ok) return _refuseByName(res)
  return _json(res)
}

export async function listProgramsUsingTool(toolId) {
  const res = await fetch(
    `/api/tools/${encodeURIComponent(toolId)}/programs`)
  if (!res.ok) return _refuseByName(res)
  const body = await _json(res)
  return body.programs || []
}

// Motion-affecting write. Returns:
//   { retroEditRequired: true, programs: [...] } — the caller MUST
//     display the confirm modal and call again with confirmed:true.
//   the updated tool doc — write succeeded.
export async function putTcp(toolId, tcpOffset, { confirmed = false } = {}) {
  const res = await fetch(
    `/api/tools/${encodeURIComponent(toolId)}/tcp`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tcp_offset: tcpOffset, confirmed }),
    })
  if (res.status === 409) {
    const body = await _json(res)
    const detail = body?.detail || {}
    return {
      retroEditRequired: true,
      programs: detail.programs || [],
      message: detail.message || 'This tool is used by existing programs.',
    }
  }
  if (!res.ok) return _refuseByName(res)
  return _json(res)
}

export async function putPayload(toolId, payloadKg) {
  const res = await fetch(
    `/api/tools/${encodeURIComponent(toolId)}/payload`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload_kg: payloadKg }),
    })
  if (!res.ok) return _refuseByName(res)
  return _json(res)
}

// Wizard step (e): flip confirmed:true. Refuses (422) if TCP or
// payload_kg is still unset — surface those refusals inline so the
// wizard can highlight the missing field.
export async function confirmTool(toolId) {
  const res = await fetch(
    `/api/tools/${encodeURIComponent(toolId)}/confirm`,
    { method: 'PUT' })
  if (!res.ok) return _refuseByName(res)
  return _json(res)
}

export async function deleteTool(toolId) {
  const res = await fetch(
    `/api/tools/${encodeURIComponent(toolId)}`,
    { method: 'DELETE' })
  if (!res.ok) return _refuseByName(res)
  return _json(res)
}

// URL for the served .glb mesh (used by three.js GLTFLoader).
export function toolMeshUrl(toolId) {
  return `/api/tools/${encodeURIComponent(toolId)}/mesh`
}

// ── Tool-hookup confirmation (per-tool, not per-program) ────────
// The Program Wizard used to walk hookup inline. It's now a
// standalone Hardware Setup wizard; the record persists per-tool
// keyed by "vacuum" / "finger" / "custom:<tool_id>".
//
// Wire shape (server side):
//   GET  /api/tool_hookup            → {ok, records: {[key]: rec}}
//   GET  /api/tool_hookup/<key>      → {ok, tool_key, record|null}
//   POST /api/tool_hookup/<key>      → body {no_sensor, optional}

export function toolHookupKey(gripperType, toolId = null) {
  if (gripperType === 'custom' && toolId) return `custom:${toolId}`
  return gripperType || 'finger'
}

export async function listToolHookups() {
  const res = await fetch('/api/tool_hookup')
  if (!res.ok) return _refuseByName(res)
  const body = await _json(res)
  return (body && body.records) || {}
}

export async function getToolHookup(toolKey) {
  const res = await fetch(
    `/api/tool_hookup/${encodeURIComponent(toolKey)}`)
  if (!res.ok) return _refuseByName(res)
  const body = await _json(res)
  return (body && body.record) || null
}

export async function confirmToolHookup(toolKey, { noSensor, optional } = {}) {
  const res = await fetch(
    `/api/tool_hookup/${encodeURIComponent(toolKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        no_sensor: noSensor || {},
        optional:  optional  || {},
      }),
    })
  if (!res.ok) return _refuseByName(res)
  const body = await _json(res)
  return (body && body.record) || null
}
