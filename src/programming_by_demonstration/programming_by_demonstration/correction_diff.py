"""Compute a structured diff between the AI's program draft and the
operator-corrected program.

This is the highest-value training signal for the future on-Jetson
model: not just the gold answer, but the *delta* — exactly which fields
the operator changed, by how much, and in which direction. Used by:

  • learning_store.save_correction_diff (per-demo correction_diff.json)
  • /api/pbd/dataset/stats (aggregate metrics — where the AI is weakest)

Pure-python, no third-party deps. Robust to schema drift: degrades to a
coarse diff and sets summary.degraded=True rather than crashing.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple


# Field-category buckets — used so the aggregate stats can answer
# "what does the AI most often get wrong?" without re-parsing every diff.
POSE_FIELDS = {
    'pose', 'taught', 'taught_joints', 'taught_tcp',
    'location_hint', 'position_role',
}
OFFSET_FIELDS = {'offset_z_mm'}
SPEED_FIELDS  = {'speed_pct'}
GRIPPER_FIELDS = {
    'width_mm', 'force_pct',
    'io_open', 'io_close', 'io_open_confirm', 'io_close_confirm',
    'io_id', 'value',
}
PART_FIELDS = {
    'target', 'mode', 'derived_from', 'pallet_phase',
    'gripper_type', 'sort_bin_hint',
}
ACTION_FIELDS = {'action'}
LABEL_FIELDS  = {'label'}


def _categorize(field_name: str) -> str:
    if field_name in POSE_FIELDS:    return 'pose'
    if field_name in OFFSET_FIELDS:  return 'offset'
    if field_name in SPEED_FIELDS:   return 'speed'
    if field_name in GRIPPER_FIELDS: return 'gripper'
    if field_name in PART_FIELDS:    return 'part'
    if field_name in ACTION_FIELDS:  return 'action'
    if field_name in LABEL_FIELDS:   return 'label'
    return 'other'


# ── Step matching ──────────────────────────────────────────────────

def _step_id(step: Dict[str, Any], fallback_index: int) -> Any:
    """Stable identity for a step. Prefer an explicit id field; else
    use the wizard's 1-based 'step' number; else fall back to position.
    Position-based ids are tagged so we can tell them apart later."""
    for k in ('id', 'step_id'):
        v = step.get(k)
        if v not in (None, '', 0):
            return ('id', v)
    n = step.get('step')
    if isinstance(n, int) and n > 0:
        return ('step', n)
    return ('pos', fallback_index)


def _match_steps(draft: List[Dict[str, Any]],
                 corrected: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Pair up steps. Strategy:
      1. Exact match on stable id (id / step number).
      2. Among the leftovers on both sides, walk in order pairing where
         the action type matches — handles inserted/deleted steps
         without misaligning everything after them.
    Returns matched/added/removed lists carrying both positions and
    detected reorders among the matched set."""
    draft_idx = [(i, _step_id(s, i), s) for i, s in enumerate(draft)]
    corr_idx  = [(i, _step_id(s, i), s) for i, s in enumerate(corrected)]

    matched: List[Tuple[int, int, Dict[str, Any], Dict[str, Any]]] = []
    used_draft: set = set()
    used_corr:  set = set()

    # Pass 1: match by stable id (skip pos-fallback so we don't pair
    # arbitrarily on length mismatch).
    by_id_corr = {sid: i for i, sid, _ in corr_idx if sid[0] != 'pos'}
    for di, sid, ds in draft_idx:
        if sid[0] == 'pos':
            continue
        ci = by_id_corr.get(sid)
        if ci is None or ci in used_corr:
            continue
        matched.append((di, ci, ds, corrected[ci]))
        used_draft.add(di)
        used_corr.add(ci)

    # Pass 2: align remaining steps in order, matching same action types.
    leftover_d = [(di, ds) for di, _, ds in draft_idx if di not in used_draft]
    leftover_c = [(ci, cs) for ci, _, cs in corr_idx  if ci not in used_corr]
    pi = pj = 0
    while pi < len(leftover_d) and pj < len(leftover_c):
        di, ds = leftover_d[pi]
        ci, cs = leftover_c[pj]
        if str(ds.get('action')) == str(cs.get('action')):
            matched.append((di, ci, ds, cs))
            used_draft.add(di)
            used_corr.add(ci)
            pi += 1
            pj += 1
        else:
            # Greedy: peek one ahead in corrected to detect an insertion;
            # otherwise advance draft (a deletion).
            inserted_in_corr = False
            for look in range(pj + 1, min(pj + 3, len(leftover_c))):
                if str(ds.get('action')) == str(leftover_c[look][1].get('action')):
                    pj = look
                    inserted_in_corr = True
                    break
            if not inserted_in_corr:
                pi += 1

    added   = [(ci, cs) for ci, _, cs in corr_idx  if ci not in used_corr]
    removed = [(di, ds) for di, _, ds in draft_idx if di not in used_draft]

    # Reorder detection on matched set: walk matched in draft-position
    # order; any matched whose corrected-position breaks monotonicity
    # is flagged as reordered.
    matched_sorted = sorted(matched, key=lambda m: m[0])
    reordered: List[Dict[str, Any]] = []
    expected_c_max = -1
    for di, ci, ds, cs in matched_sorted:
        if ci < expected_c_max:
            reordered.append({
                'action':         str(ds.get('action') or ''),
                'from_index':     di,
                'to_index':       ci,
                'step_id_kind':   _step_id(ds, di)[0],
            })
        expected_c_max = max(expected_c_max, ci)

    return {
        'matched':   matched_sorted,
        'added':     added,
        'removed':   removed,
        'reordered': reordered,
    }


# ── Field-level diff ───────────────────────────────────────────────

def _is_pose_list(v: Any) -> bool:
    if not isinstance(v, (list, tuple)):
        return False
    if not (3 <= len(v) <= 7):
        return False
    return all(isinstance(x, (int, float)) for x in v)


def _pose_delta(old: Any, new: Any) -> Optional[List[float]]:
    if not (_is_pose_list(old) and _is_pose_list(new) and len(old) == len(new)):
        return None
    return [float(new[i]) - float(old[i]) for i in range(len(old))]


def _scalar_delta(old: Any, new: Any) -> Optional[float]:
    if isinstance(old, (int, float)) and isinstance(new, (int, float)):
        return float(new) - float(old)
    return None


def _diff_step(draft_step: Dict[str, Any],
               corr_step:  Dict[str, Any]) -> Dict[str, Any]:
    """Return per-field changes for one matched pair. We don't include
    purely cosmetic mutations (taught flag flipping null↔null etc.)."""
    keys = set(draft_step.keys()) | set(corr_step.keys())
    field_changes: Dict[str, Dict[str, Any]] = {}
    by_category: Dict[str, int] = {}

    for k in keys:
        ov = draft_step.get(k)
        nv = corr_step.get(k)
        if ov == nv:
            continue
        cat = _categorize(k)
        entry: Dict[str, Any] = {'old': ov, 'new': nv, 'category': cat}
        if k == 'pose':
            delta = _pose_delta(ov, nv)
            if delta is not None:
                entry['delta'] = delta
        else:
            d = _scalar_delta(ov, nv)
            if d is not None:
                entry['delta'] = d
        field_changes[k] = entry
        by_category[cat] = by_category.get(cat, 0) + 1

    return {
        'field_changes':       field_changes,
        'category_counts':     by_category,
        'changed_field_count': len(field_changes),
    }


# ── Top-level diff ─────────────────────────────────────────────────

def _diff_top_level(draft: Dict[str, Any],
                    corrected: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k in ('name', 'description'):
        if draft.get(k) != corrected.get(k):
            out[k] = {'old': draft.get(k), 'new': corrected.get(k)}

    d_tags = list(draft.get('tags')     or [])
    c_tags = list(corrected.get('tags') or [])
    added_t   = [t for t in c_tags if t not in d_tags]
    removed_t = [t for t in d_tags if t not in c_tags]
    if added_t or removed_t:
        out['tags'] = {'added': added_t, 'removed': removed_t}

    d_cfg = dict(draft.get('config')     or {})
    c_cfg = dict(corrected.get('config') or {})
    cfg_added   = [k for k in c_cfg if k not in d_cfg]
    cfg_removed = [k for k in d_cfg if k not in c_cfg]
    cfg_changed: Dict[str, Dict[str, Any]] = {}
    for k in d_cfg:
        if k in c_cfg and d_cfg[k] != c_cfg[k]:
            cfg_changed[k] = {'old': d_cfg[k], 'new': c_cfg[k]}
    if cfg_added or cfg_removed or cfg_changed:
        out['config_keys'] = {
            'added':   cfg_added,
            'removed': cfg_removed,
            'changed': cfg_changed,
        }
    return out


# ── Public entrypoint ──────────────────────────────────────────────

def compute_correction_diff(ai_draft: Optional[Dict[str, Any]],
                            corrected: Optional[Dict[str, Any]]
                            ) -> Dict[str, Any]:
    """Build the structured diff. Best-effort: if either side is missing
    or malformed we return a coarse stub with summary.degraded=True so
    the caller can still persist *something* rather than nothing."""
    degraded = False
    notes: List[str] = []

    if not isinstance(ai_draft, dict):
        degraded = True
        notes.append('ai_draft missing or non-dict — coarse diff only')
        ai_draft = {}
    if not isinstance(corrected, dict):
        degraded = True
        notes.append('corrected missing or non-dict — coarse diff only')
        corrected = {}

    # The composer wraps under 'draft'/'program_draft' sometimes; unwrap.
    if 'steps' not in ai_draft and isinstance(ai_draft.get('draft'), dict):
        ai_draft = ai_draft['draft']
    if 'steps' not in ai_draft and isinstance(ai_draft.get('program'), dict):
        ai_draft = ai_draft['program']
    if 'steps' not in corrected and isinstance(corrected.get('program'), dict):
        corrected = corrected['program']

    draft_steps = list(ai_draft.get('steps') or [])
    corr_steps  = list(corrected.get('steps') or [])
    if not isinstance(draft_steps, list) or not isinstance(corr_steps, list):
        degraded = True
        notes.append('steps not a list — treating as empty')
        draft_steps, corr_steps = [], []

    top = _diff_top_level(ai_draft, corrected)
    match = _match_steps(draft_steps, corr_steps)

    matched_pairs: List[Dict[str, Any]] = []
    category_totals: Dict[str, int] = {}
    poses_adjusted = 0
    fields_changed_total = 0

    for di, ci, ds, cs in match['matched']:
        step_diff = _diff_step(ds, cs)
        if step_diff['changed_field_count'] == 0:
            continue
        # Tally categories.
        for cat, n in step_diff['category_counts'].items():
            category_totals[cat] = category_totals.get(cat, 0) + n
        fields_changed_total += step_diff['changed_field_count']
        if 'pose' in step_diff['category_counts'] or 'offset' in step_diff['category_counts']:
            poses_adjusted += 1

        entry: Dict[str, Any] = {
            'draft_index':       di,
            'corrected_index':   ci,
            'action':            str(ds.get('action') or ''),
            'label':             str(ds.get('label') or ''),
            'field_changes':     step_diff['field_changes'],
            'category_counts':   step_diff['category_counts'],
        }
        # Convenience shortcut for the most-common training signal: the
        # pose delta. Surfaces dx/dy/dz/etc directly on the step entry.
        pc = step_diff['field_changes'].get('pose')
        if pc and 'delta' in pc:
            entry['pose_delta'] = pc['delta']
        oz = step_diff['field_changes'].get('offset_z_mm')
        if oz and 'delta' in oz:
            entry['offset_z_delta_mm'] = oz['delta']
        matched_pairs.append(entry)

    added_summary = [{
        'corrected_index': ci,
        'action':          str(cs.get('action') or ''),
        'label':           str(cs.get('label') or ''),
    } for ci, cs in match['added']]
    removed_summary = [{
        'draft_index':     di,
        'action':          str(ds.get('action') or ''),
        'label':           str(ds.get('label') or ''),
    } for di, ds in match['removed']]

    top_level_changed_count = (
        (1 if 'name'        in top else 0)
      + (1 if 'description' in top else 0)
      + (1 if 'tags'        in top else 0)
      + (len((top.get('config_keys') or {}).get('changed')  or {}))
      + (len((top.get('config_keys') or {}).get('added')    or []))
      + (len((top.get('config_keys') or {}).get('removed')  or []))
    )

    no_change = (
        not top
        and not added_summary
        and not removed_summary
        and not match['reordered']
        and not matched_pairs
    )

    summary = {
        'no_change':        no_change,
        'verbatim_accept':  no_change,
        'fields_changed':   fields_changed_total + top_level_changed_count,
        'steps_added':      len(added_summary),
        'steps_removed':    len(removed_summary),
        'steps_reordered':  len(match['reordered']),
        'poses_adjusted':   poses_adjusted,
        'fields_by_category': category_totals,
        'degraded':         degraded,
        'notes':            notes,
    }

    return {
        'top_level':   top,
        'steps': {
            'added':       added_summary,
            'removed':     removed_summary,
            'reordered':   match['reordered'],
            'matched':     matched_pairs,
        },
        'summary':     summary,
    }
