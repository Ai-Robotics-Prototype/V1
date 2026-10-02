// useLineMap — fetch the D9 line_map sidecar for a program, cached
// per (programId, rev) so a save invalidates. Consumed by
// StepPreviewPanel + ProgramEditor for the live step highlight; the
// caller applies the honesty guard against the resident program's
// codegen sha before using the map.
//
// Returned shape:
//   { lineMap: [{step_idx, step_id, action,
//                lua_line_start, lua_line_end}, ...],
//     codegenSha: '3592d988c04c' | '',
//     programId:  'whitebowlpickplace',
//     loading:    false,
//     error:      null | string }
//
// Endpoint contract: `/api/programs/{id}/line_map` returns the
// sidecar written on save (POST/PUT /api/programs). Regenerates
// on demand if missing.

import { useEffect, useState } from 'react'

const _cache = new Map()   // key: `${id}#${rev}` → sidecar object

export function useLineMap(programId, rev) {
  const [state, setState] = useState(() => ({
    lineMap: null, codegenSha: '', programId: null,
    loading: !!programId, error: null,
  }))
  useEffect(() => {
    if (!programId) {
      setState({ lineMap: null, codegenSha: '', programId: null,
                 loading: false, error: null })
      return
    }
    const key = `${programId}#${rev ?? ''}`
    const cached = _cache.get(key)
    if (cached) {
      setState({
        lineMap:    cached.line_map || [],
        codegenSha: cached.codegen_sha || '',
        programId:  cached.program_id || programId,
        loading:    false,
        error:      cached.error || null,
      })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    fetch(`/api/programs/${encodeURIComponent(programId)}/line_map`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((body) => {
        if (cancelled) return
        _cache.set(key, body)
        setState({
          lineMap:    body.line_map || [],
          codegenSha: body.codegen_sha || '',
          programId:  body.program_id || programId,
          loading:    false,
          error:      body.error || null,
        })
      })
      .catch((e) => {
        if (cancelled) return
        setState({
          lineMap: [], codegenSha: '', programId,
          loading: false, error: String(e && e.message || e),
        })
      })
    return () => { cancelled = true }
  }, [programId, rev])
  return state
}

// Invalidate cache for a program (e.g. on save success — the caller
// bumps `rev` which achieves the same via the key, but this helper
// is available for a hard flush).
export function invalidateLineMap(programId) {
  for (const k of Array.from(_cache.keys())) {
    if (k.startsWith(programId + '#')) _cache.delete(k)
  }
}
