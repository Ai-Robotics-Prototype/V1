"""Filesystem-backed library of parts uploaded as STEP files.

Layout under /opt/cobot/parts:
    step/<source>.step      uploaded STEP files
    stl/<source>.stl        rendered STL companions (for dashboard preview)
    metadata/<id>.json      full part dict from step_parser
    index.json              compact list used by /api/parts
"""
import json
import os
import shutil
from typing import Optional, Tuple

LIBRARY_DIR   = '/opt/cobot/parts'
LIBRARY_INDEX = os.path.join(LIBRARY_DIR, 'index.json')

_INDEX_KEYS = ('id', 'name', 'extents_cm', 'grasp', 'source_file', 'stl_file')


def init_library() -> None:
    os.makedirs(os.path.join(LIBRARY_DIR, 'step'),     exist_ok=True)
    os.makedirs(os.path.join(LIBRARY_DIR, 'stl'),      exist_ok=True)
    os.makedirs(os.path.join(LIBRARY_DIR, 'metadata'), exist_ok=True)
    if not os.path.isfile(LIBRARY_INDEX):
        with open(LIBRARY_INDEX, 'w') as f:
            json.dump({'parts': []}, f)


def _index_entry(part_data: dict) -> dict:
    return {k: part_data.get(k) for k in _INDEX_KEYS}


def add_part(step_path: str, part_data: dict) -> str:
    """Persist the source STEP, its rendered STL, and the full metadata,
    then update the index. Returns the part id."""
    init_library()
    part_id = part_data['id']

    # Copy STEP into the library
    dest_step = os.path.join(LIBRARY_DIR, 'step', part_data['source_file'])
    shutil.copy2(step_path, dest_step)

    # Move the STL the parser wrote next to the source step into the library
    stl_source = os.path.splitext(step_path)[0] + '.stl'
    if os.path.exists(stl_source):
        dest_stl = os.path.join(LIBRARY_DIR, 'stl', part_data['stl_file'])
        shutil.copy2(stl_source, dest_stl)

    meta_path = os.path.join(LIBRARY_DIR, 'metadata', f'{part_id}.json')
    with open(meta_path, 'w') as f:
        json.dump(part_data, f, indent=2)

    # Update compact index, replacing any prior entry with the same id
    with open(LIBRARY_INDEX) as f:
        index = json.load(f) or {'parts': []}
    index['parts'] = [p for p in index['parts'] if p.get('id') != part_id]
    index['parts'].append(_index_entry(part_data))
    with open(LIBRARY_INDEX, 'w') as f:
        json.dump(index, f, indent=2)

    return part_id


def get_all_parts() -> list:
    init_library()
    with open(LIBRARY_INDEX) as f:
        data = json.load(f) or {}
    return data.get('parts') or []


def get_part(part_id: str) -> Optional[dict]:
    meta_path = os.path.join(LIBRARY_DIR, 'metadata', f'{part_id}.json')
    if not os.path.isfile(meta_path):
        return None
    with open(meta_path) as f:
        return json.load(f)


def delete_part(part_id: str) -> bool:
    meta = get_part(part_id)
    if meta is None:
        return False
    for subdir, key in [('step', 'source_file'), ('stl', 'stl_file')]:
        path = os.path.join(LIBRARY_DIR, subdir, meta.get(key, ''))
        if path and os.path.exists(path):
            os.remove(path)
    meta_path = os.path.join(LIBRARY_DIR, 'metadata', f'{part_id}.json')
    if os.path.exists(meta_path):
        os.remove(meta_path)
    with open(LIBRARY_INDEX) as f:
        index = json.load(f) or {'parts': []}
    index['parts'] = [p for p in index['parts'] if p.get('id') != part_id]
    with open(LIBRARY_INDEX, 'w') as f:
        json.dump(index, f, indent=2)
    return True


def match_detection_to_part(
    detection_size_m: list, tolerance: float = 0.3
) -> Tuple[Optional[dict], Optional[float]]:
    """Match a live detection's OBB extents to known parts. Compares
    sorted dimensions (so rotation in the camera frame doesn't matter)
    and returns (best_part_index_entry, normalised_score) or (None, None).

    score = sum of |dim_a - dim_b| (cm), normalised by the largest
    dimension. Lower is better; passing requires < tolerance.
    """
    if not detection_size_m or len(detection_size_m) < 3:
        return None, None
    parts = get_all_parts()
    if not parts:
        return None, None

    det_cm = sorted((float(d) * 100 for d in detection_size_m[:3]), reverse=True)

    best_part = None
    best_score = float('inf')

    for part in parts:
        ext = part.get('extents_cm') or []
        if len(ext) < 3:
            continue
        part_cm = sorted((float(e) for e in ext[:3]), reverse=True)
        raw = sum(abs(a - b) for a, b in zip(det_cm, part_cm))
        max_dim = max(det_cm[0], part_cm[0], 0.1)
        rel = raw / max_dim
        if rel < tolerance and rel < best_score:
            best_score = rel
            best_part = part

    if best_part is None:
        return None, None
    return best_part, round(best_score, 4)
